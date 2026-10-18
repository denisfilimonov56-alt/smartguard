#!/usr/bin/env python3
"""Выгрузка графа нормативных требований в идемпотентный Cypher-скрипт.

Источник истины — база, а не файл в репозитории. Скрипт снимает с живой
базы приказы, пункты, правила, атрибуты, примеры, подразделения и должностные
инструкции и превращает их в MERGE-скрипт — файл данных neo4j/init/data.cypher.
Схема (seed.cypher) лежит отдельно и выгрузкой не трогается. Сидер применяет
файл данных только к пустому каталогу или по явному SEED_DATA=1, поэтому
перезапуск стека не откатывает правки из интерфейса; git diff файла данных
показывает, что именно поменялось в нормативке.

Запуск (на хосте, файл пишется через перенаправление — у процесса в
контейнере может не быть прав на запись в примонтированный каталог):
    docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
        && mv neo4j/init/data.cypher.new neo4j/init/data.cypher
(сразу «> data.cypher» обнулил бы файл до выгрузки, и при её сбое данные пропали бы)
    docker compose exec api python export_graph.py --output /init/data.cypher
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
import sys
from pathlib import Path
from typing import Any

log = logging.getLogger("export")

# Метка -> свойство, по которому узел уникален (по нему строится MERGE).
NODE_KEYS: dict[str, str] = {
    "Order": "orderId",
    "Clause": "clauseId",
    "Rule": "ruleId",
    "CheckTarget": "name",
    "ViolationExample": "exampleId",
    "Department": "departmentId",
    "JobDescription": "jobDescriptionId",
}

# Порядок вывода: узлы раньше связей, приказы раньше пунктов.
LABEL_ORDER = ["Order", "Clause", "Rule", "CheckTarget", "ViolationExample", "Department",
               "JobDescription"]

# Маркер данных в seed.cypher прежних версий: всё после него сидер считает
# данными (применяет только к пустому каталогу), как и файл data.cypher.
DATA_MARKER = "// ---------- Данные ----------"

DATA_HEADER = """// ============================================================
//  Данные каталога нормативных требований.
//  Сгенерировано export_graph.py — не редактировать вручную.
//
//  Сидер применяет этот файл только к пустому каталогу (первый запуск)
//  или по явному флагу SEED_DATA=1 — тогда MERGE возвращает каталог к
//  состоянию этого файла, правки из интерфейса после выгрузки теряются.
//  Схема (ограничения и индексы) — в seed.cypher.
// ============================================================
"""

FETCH_NODES = "MATCH (n:{label}) RETURN properties(n) AS props"

# Выражение меток: обходятся только узлы каталога, а не история проверок.
CATALOG_LABELS = "|".join(NODE_KEYS)
FETCH_RELATIONSHIPS = f"""
MATCH (a:{CATALOG_LABELS})-[r]->(b:{CATALOG_LABELS})
RETURN [l IN labels(a) WHERE l IN $labels][0] AS a_label,
       properties(a) AS a_props,
       type(r)       AS rel_type,
       properties(r) AS rel_props,
       [l IN labels(b) WHERE l IN $labels][0] AS b_label,
       properties(b) AS b_props
"""


# --------------------------------------------------------------------------
#  Рендеринг (чистые функции, тестируются без базы)
# --------------------------------------------------------------------------


PLAIN_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def escape_name(name: str) -> str:
    """Имя свойства или типа связи в обратных кавычках — как идентификатор Cypher.

    Имена свойств задаёт редактор; без кавычек пробел или `;` в имени ломал бы
    скрипт или превращал его в произвольный Cypher.
    """
    name = str(name)
    if not name:
        # n.`` — синтаксическая ошибка: файл данных уронил бы сидер.
        raise ValueError("в графе есть свойство или связь с пустым именем — "
                         "удалите его в редакторе свойств и повторите выгрузку")
    if PLAIN_NAME.fullmatch(name):
        return name
    return "`" + name.replace("`", "``") + "`"


def cypher_literal(value: Any) -> str:
    """Преобразует значение свойства в литерал Cypher."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return repr(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"значение {value!r} не имеет литерала в Cypher")
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)

    # Временные типы neo4j определяем по имени класса, чтобы не тянуть
    # сюда зависимость от neo4j.time. Проверяются до списков: Duration — кортеж.
    type_name = type(value).__name__
    if type_name == "Duration" and hasattr(value, "iso_format"):
        return f'duration("{value.iso_format()}")'
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(cypher_literal(v) for v in value) + "]"
    temporal = {
        "Date": "date",
        "Time": "time",
        "DateTime": "datetime",
        "LocalTime": "localtime",
        "LocalDateTime": "localdatetime",
        "Duration": "duration",
        "date": "date",
        "datetime": "datetime",
    }
    if type_name in temporal:
        return f'{temporal[type_name]}("{value}")'

    log.warning("Неизвестный тип свойства %s, выгружен как строка", type_name)
    return json.dumps(str(value), ensure_ascii=False)


def render_node(label: str, props: dict[str, Any]) -> str:
    """MERGE узла по ключевому свойству + SET остальных."""
    key = NODE_KEYS[label]
    if key not in props:
        raise ValueError(f"у узла :{label} нет ключевого свойства {key}: {props!r}")

    head = f"MERGE (n:{label} {{{key}: {cypher_literal(props[key])}}})"
    rest = {k: v for k, v in sorted(props.items()) if k != key and v is not None}
    if not rest:
        return head + ";"
    assignments = ",\n    ".join(f"n.{escape_name(k)} = {cypher_literal(v)}" for k, v in rest.items())
    return f"{head}\nSET {assignments};"


def render_relationship(rel: dict[str, Any]) -> str:
    """MATCH обоих концов по ключам + MERGE связи."""
    a_label, b_label = rel["a_label"], rel["b_label"]
    a_key, b_key = NODE_KEYS[a_label], NODE_KEYS[b_label]
    a_value = cypher_literal(rel["a_props"][a_key])
    b_value = cypher_literal(rel["b_props"][b_key])

    lines = [
        f"MATCH (a:{a_label} {{{a_key}: {a_value}}}),",
        f"      (b:{b_label} {{{b_key}: {b_value}}})",
    ]
    props = {k: v for k, v in sorted((rel.get("rel_props") or {}).items()) if v is not None}
    if props:
        assignments = ",\n    ".join(f"x.{escape_name(k)} = {cypher_literal(v)}" for k, v in props.items())
        lines.append(f"MERGE (a)-[x:{escape_name(rel['rel_type'])}]->(b)")
        lines.append(f"SET {assignments};")
    else:
        lines.append(f"MERGE (a)-[:{escape_name(rel['rel_type'])}]->(b);")
    return "\n".join(lines)


def _node_sort_key(label: str, props: dict[str, Any]) -> tuple[int, str]:
    return (LABEL_ORDER.index(label), str(props.get(NODE_KEYS[label], "")))


def _rel_sort_key(rel: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        rel["rel_type"],
        rel["a_label"],
        str(rel["a_props"].get(NODE_KEYS[rel["a_label"]], "")),
        str(rel["b_props"].get(NODE_KEYS[rel["b_label"]], "")),
    )


# Узлы этих меток без ключа пропускаются с предупреждением: departmentId задаёт
# кадровая система, а diagnostics.departments_without_id обещает, что такое
# подразделение просто не попадёт в выгрузку. Остальные ключи чинит
# POST /catalog/repair-identifiers.
SKIPPABLE_WITHOUT_KEY = {"Department"}


def _has_key(label: str, props: dict[str, Any]) -> bool:
    value = props.get(NODE_KEYS[label])
    return value is not None and str(value).strip() != ""


def render_data_block(
    nodes: list[tuple[str, dict[str, Any]]], relationships: list[dict[str, Any]]
) -> str:
    """Собирает блок данных: узлы по меткам, затем связи. Порядок стабилен."""
    chunks: list[str] = []

    by_label: dict[str, list[dict[str, Any]]] = {}
    missing: list[str] = []
    for label, props in nodes:
        if not _has_key(label, props):
            if label in SKIPPABLE_WITHOUT_KEY:
                log.warning("Узел :%s без %s не выгружен: %s", label, NODE_KEYS[label],
                            props.get("name") or props)
                continue
            missing.append(f":{label} {props.get('number') or props.get('code') or props.get('title') or ''}")
            continue
        by_label.setdefault(label, []).append(props)
    if missing:
        hint = ". Проставьте ключи: POST /catalog/repair-identifiers (раздел «Состояние»)"
        if any(m.startswith(":CheckTarget") for m in missing):
            # Имя атрибута смысловое — ремонт его не придумывает.
            hint += "; атрибуту без name задайте имя в редакторе свойств или удалите его"
        raise ValueError(
            "у узлов нет ключевого свойства, выгрузить их нельзя: " + "; ".join(missing) + hint
        )

    for label in LABEL_ORDER:
        items = by_label.get(label)
        if not items:
            continue
        items.sort(key=lambda p, lb=label: _node_sort_key(lb, p))
        chunks.append(f"// ---------- {label} ({len(items)}) ----------")
        chunks.extend(render_node(label, props) for props in items)
        chunks.append("")

    relationships = [r for r in relationships
                     if _has_key(r["a_label"], r["a_props"]) and _has_key(r["b_label"], r["b_props"])]
    if relationships:
        relationships = sorted(relationships, key=_rel_sort_key)
        chunks.append(f"// ---------- Связи ({len(relationships)}) ----------")
        chunks.extend(render_relationship(rel) for rel in relationships)
        chunks.append("")

    return "\n\n".join(chunks).rstrip() + "\n"


def render_data_file(nodes: list[tuple[str, dict[str, Any]]], relationships: list[dict[str, Any]]) -> str:
    """Весь файл данных: шапка и блок данных."""
    return f"{DATA_HEADER}\n{render_data_block(nodes, relationships)}"


# --------------------------------------------------------------------------
#  Чтение из базы
# --------------------------------------------------------------------------


def _read_graph(tx) -> tuple[list[tuple[str, dict]], list[dict]]:
    labels = list(NODE_KEYS)
    nodes: list[tuple[str, dict]] = []
    for label in labels:
        for record in tx.run(FETCH_NODES.format(label=label)):
            nodes.append((label, dict(record["props"])))
    relationships = [
        {
            "a_label": r["a_label"],
            "a_props": dict(r["a_props"]),
            "rel_type": r["rel_type"],
            "rel_props": dict(r["rel_props"] or {}),
            "b_label": r["b_label"],
            "b_props": dict(r["b_props"]),
        }
        for r in tx.run(FETCH_RELATIONSHIPS, labels=labels)
    ]
    return nodes, relationships


def fetch_graph(driver) -> tuple[list[tuple[str, dict]], list[dict]]:
    """Узлы и связи одной транзакцией чтения — согласованный снимок графа."""
    with driver.session() as session:
        return session.execute_read(_read_graph)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="/init/data.cypher", help="куда писать файл данных")
    parser.add_argument("--stdout", action="store_true",
                        help="печатать файл данных в stdout (во временный файл, затем mv в neo4j/init/data.cypher)")
    args = parser.parse_args()

    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s export: %(message)s",
        # Журнал — в stderr: stdout в режиме --stdout занят файлом данных.
        stream=sys.stderr,
    )

    from neo4j import GraphDatabase  # импорт здесь, чтобы модуль тестировался без драйвера

    driver = GraphDatabase.driver(
        os.getenv("NEO4J_URI", "bolt://neo4j:7687"),
        auth=(
            os.getenv("NEO4J_USER", "neo4j"),
            os.getenv("NEO4J_PASSWORD", "password123"),
        ),
    )
    try:
        nodes, relationships = fetch_graph(driver)
    finally:
        driver.close()

    if not nodes:
        log.error("В графе нет узлов известных меток — выгружать нечего")
        return 1

    try:
        content = render_data_file(nodes, relationships)
    except ValueError as exc:
        log.error("Выгрузка невозможна: %s", exc)
        return 1
    log.info("Выгружено узлов: %d, связей: %d", len(nodes), len(relationships))

    if args.stdout:
        sys.stdout.write(content)
        return 0

    target = Path(args.output)
    # Пишем во временный файл рядом и переименовываем: сбой посреди записи
    # не оставляет обрезанный data.cypher, который сидер применил бы к пустой базе.
    temp = target.with_name(target.name + ".new")
    try:
        try:
            temp.write_text(content, encoding="utf-8")
            os.replace(temp, target)
        except PermissionError:
            # Каталог закрыт на запись, а сам файл — нет (uid 10001 выдано
            # право только на data.cypher): пишем на место. Выгрузка
            # уже собрана целиком, так что обрезанный файл возможен только при
            # сбое самой записи на диск.
            if not os.access(target, os.W_OK):
                raise
            temp.unlink(missing_ok=True)
            target.write_text(content, encoding="utf-8")
    except OSError as exc:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
        # Через временный файл и mv: «> data.cypher» обнулил бы файл ещё до
        # выгрузки, и при её сбое прежние данные пропали бы.
        log.error(
            "Не удалось записать %s: %s. Процесс в контейнере работает не от владельца "
            "примонтированного каталога. Выгрузите через stdout на хосте:\n"
            "    docker compose exec -T api python export_graph.py --stdout "
            "> neo4j/init/data.cypher.new && mv neo4j/init/data.cypher.new neo4j/init/data.cypher",
            target, exc.strerror or exc,
        )
        return 1
    log.info("Записано в %s", target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
