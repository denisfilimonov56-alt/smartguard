#!/usr/bin/env python3
"""Выгрузка графа нормативных требований в идемпотентный Cypher-скрипт.

Источник истины — база, а не файл в репозитории. Скрипт снимает с живой
базы приказы, пункты, правила, атрибуты, примеры, подразделения и должностные
инструкции и превращает их в
MERGE-скрипт, который дописывается в seed.cypher после маркера данных.
После этого `docker compose up` воспроизводит граф один в один, а git diff
показывает, что именно поменялось в нормативке.

Запуск:
    docker compose exec api python export_graph.py --output /init/seed.cypher
    docker compose exec api python export_graph.py --stdout
"""

from __future__ import annotations

import argparse
import json
import logging
import os
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

DATA_MARKER = "// ---------- Данные ----------"

FETCH_NODES = "MATCH (n:{label}) RETURN properties(n) AS props"

FETCH_RELATIONSHIPS = """
MATCH (a)-[r]->(b)
WHERE any(l IN labels(a) WHERE l IN $labels)
  AND any(l IN labels(b) WHERE l IN $labels)
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


def cypher_literal(value: Any) -> str:
    """Преобразует значение свойства в литерал Cypher."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(cypher_literal(v) for v in value) + "]"

    # Временные типы neo4j определяем по имени класса, чтобы не тянуть
    # сюда зависимость от neo4j.time.
    type_name = type(value).__name__
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
    assignments = ",\n    ".join(f"n.{k} = {cypher_literal(v)}" for k, v in rest.items())
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
        assignments = ",\n    ".join(f"x.{k} = {cypher_literal(v)}" for k, v in props.items())
        lines.append(f"MERGE (a)-[x:{rel['rel_type']}]->(b)")
        lines.append(f"SET {assignments};")
    else:
        lines.append(f"MERGE (a)-[:{rel['rel_type']}]->(b);")
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


def render_data_block(
    nodes: list[tuple[str, dict[str, Any]]], relationships: list[dict[str, Any]]
) -> str:
    """Собирает блок данных: узлы по меткам, затем связи. Порядок стабилен."""
    chunks: list[str] = []

    by_label: dict[str, list[dict[str, Any]]] = {}
    for label, props in nodes:
        by_label.setdefault(label, []).append(props)

    for label in LABEL_ORDER:
        items = by_label.get(label)
        if not items:
            continue
        items.sort(key=lambda p, lb=label: _node_sort_key(lb, p))
        chunks.append(f"// ---------- {label} ({len(items)}) ----------")
        chunks.extend(render_node(label, props) for props in items)
        chunks.append("")

    if relationships:
        relationships = sorted(relationships, key=_rel_sort_key)
        chunks.append(f"// ---------- Связи ({len(relationships)}) ----------")
        chunks.extend(render_relationship(rel) for rel in relationships)
        chunks.append("")

    return "\n\n".join(chunks).rstrip() + "\n"


def splice_into(existing: str, data_block: str) -> str:
    """Заменяет всё после маркера данных сгенерированным блоком."""
    index = existing.find(DATA_MARKER)
    if index == -1:
        raise ValueError(
            f"в целевом файле нет маркера {DATA_MARKER!r} — "
            "добавьте его в конец схемной части"
        )
    head = existing[: index + len(DATA_MARKER)]
    return f"{head}\n// Сгенерировано export_graph.py — не редактировать вручную.\n\n{data_block}"


# --------------------------------------------------------------------------
#  Чтение из базы
# --------------------------------------------------------------------------


def fetch_graph(driver) -> tuple[list[tuple[str, dict]], list[dict]]:
    labels = list(NODE_KEYS)
    nodes: list[tuple[str, dict]] = []
    with driver.session() as session:
        for label in labels:
            for record in session.run(FETCH_NODES.format(label=label)):
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
            for r in session.run(FETCH_RELATIONSHIPS, labels=labels)
        ]
    return nodes, relationships


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="/init/seed.cypher", help="куда писать результат")
    parser.add_argument("--stdout", action="store_true", help="печатать, а не писать в файл")
    args = parser.parse_args()

    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s export: %(message)s",
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

    data_block = render_data_block(nodes, relationships)
    log.info("Выгружено узлов: %d, связей: %d", len(nodes), len(relationships))

    if args.stdout:
        sys.stdout.write(data_block)
        return 0

    target = Path(args.output)
    if not target.exists():
        log.error("Файл %s не найден — нужен файл со схемой и маркером данных", target)
        return 1

    target.write_text(splice_into(target.read_text(encoding="utf-8"), data_block), encoding="utf-8")
    log.info("Записано в %s", target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
