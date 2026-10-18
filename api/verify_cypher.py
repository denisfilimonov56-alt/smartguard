#!/usr/bin/env python3
"""Проверка всех Cypher-запросов проекта.

Зачем: юнит-тесты подменяют драйвер Neo4j, поэтому текст запроса в них
никогда не разбирается. Запрос с ошибкой области видимости («переменная
использована после WITH, который её не пронёс») проходит все тесты и падает
только у пользователя. Ровно так сломалось удаление узлов.

Два режима:

  offline — разбор без базы: находит переменные, использованные вне области
            видимости. Запускается в тестах, базы не требует.

  online  — EXPLAIN каждого запроса на живой Neo4j: полноценный разбор
            и планирование средствами самой СУБД, без выполнения.

    python verify_cypher.py            # offline
    python verify_cypher.py --explain  # offline + EXPLAIN на живой базе
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path
from typing import Any, Iterator

# Модули с запросами находятся сами: всё, что ходит в Neo4j. Ручной список
# отставал — новые модули (настройки, ключи, история) выпадали из проверки.
DB_MARKER = re.compile(r"get_driver\(|\b_run\(|session\.run\(|tx\.run\(")
SKIP_MODULES = {"verify_cypher"}

CYPHER_MARKER = re.compile(
    r"\b(MATCH|MERGE|CREATE\s+(CONSTRAINT|INDEX|FULLTEXT)|UNWIND)\b|\bCREATE\s*\(")

CLAUSE = re.compile(
    r"\b(OPTIONAL\s+MATCH|DETACH\s+DELETE|ORDER\s+BY|MATCH|MERGE|CREATE|WITH|RETURN|UNWIND"
    r"|WHERE|SET|DELETE|REMOVE|FOREACH|CALL|LIMIT|SKIP|UNION)\b",
    re.IGNORECASE,
)

# Переменные, объявленные в шаблоне: (v:Label), (v {...}), [r:TYPE], (v)
PATTERN_VAR = re.compile(r"[(\[]\s*([a-zA-Z_]\w*)\s*(?=[:)\]{*])")
# Локальные переменные списковых выражений и FOREACH: [x IN ...], FOREACH (x IN ...)
LOCAL_VAR = re.compile(r"\b([a-zA-Z_]\w*)\s+IN\b", re.IGNORECASE)
UNWIND_ALIAS = re.compile(r"\bAS\s+([a-zA-Z_]\w*)", re.IGNORECASE)
# Обращения, по которым переменная точно должна быть в области видимости
USAGE = re.compile(
    r"\b([a-zA-Z_]\w*)\s*\.\s*[a-zA-Z_]"                    # x.prop
    r"|\b(?:elementId|id|labels|properties|keys)\(\s*([a-zA-Z_]\w*)\s*\)"
    r"|\bcollect\(\s*(?:DISTINCT\s+)?([a-zA-Z_]\w*)\s*\)",
    re.IGNORECASE,
)

# Клаузы, где голое имя переменной — обращение к ней (а не новое объявление,
# как в шаблоне MATCH).
BARE_USAGE_CLAUSES = {"WITH", "RETURN", "DELETE", "DETACH DELETE", "SET", "REMOVE", "WHERE"}
STRINGS = re.compile(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|`[^`]*`")
# Имя переменной: не свойство (.x), не параметр ($x), не метка/тип (:X),
# не функция (x(...)), не ключ литерала-словаря ({x: ...}).
BARE_NAME = re.compile(r"(?<![.$:\w])([a-zA-Z_]\w*)\b(?!\s*\()(?!\s*:\s)(?!\s*:\$)")

KEYWORDS = {
    "and", "or", "not", "in", "is", "null", "true", "false", "as", "distinct",
    "case", "when", "then", "else", "end", "count", "size", "coalesce", "collect",
    "date", "datetime", "trim", "tolower", "toupper", "replace", "head", "last",
    "exists", "all", "any", "none", "single", "asc", "desc", "on", "match", "with",
    "xor", "starts", "ends", "contains", "where", "return", "order", "by", "limit", "skip",
    "set", "delete", "detach", "remove", "merge", "create", "optional", "unwind", "call",
    "yield", "union", "foreach", "nan", "infinity",
}


def split_top_level(text: str) -> list[str]:
    """Делит по запятым верхнего уровня, не трогая скобки."""
    parts, depth, current = [], 0, []
    for ch in text:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    if current:
        parts.append("".join(current))
    return parts


def projected_names(text: str) -> set[str]:
    """Что WITH / RETURN выносит в следующую область видимости."""
    names: set[str] = set()
    for item in split_top_level(text):
        item = item.strip()
        if item == "*":
            return {"*"}
        item = re.sub(r"^DISTINCT\s+", "", item, flags=re.IGNORECASE)
        alias = re.search(r"\bAS\s+([a-zA-Z_]\w*)\s*$", item, re.IGNORECASE)
        if alias:
            names.add(alias.group(1))
        elif re.fullmatch(r"[a-zA-Z_]\w*", item):
            names.add(item)
    return names


def bare_names(body: str) -> set[str]:
    """Голые обращения к переменным: `RETURN n`, `DELETE rel`, `WHERE x:Label`."""
    text = STRINGS.sub(" ", body)
    # Псевдонимы после AS — новые имена, а не обращения.
    text = re.sub(r"\bAS\s+[a-zA-Z_]\w*", " ", text, flags=re.IGNORECASE)
    return {m for m in BARE_NAME.findall(text) if m.lower() not in KEYWORDS}


def _bracket_depth(query: str) -> list[int]:
    """Глубина круглых и квадратных скобок в каждой позиции (без строк)."""
    depths, depth, quote = [], 0, None
    for ch in query:
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
        elif ch in "([":
            depth += 1
        elif ch in ")]":
            depth = max(0, depth - 1)
        depths.append(depth)
    return depths


def clauses(query: str) -> Iterator[tuple[str, str]]:
    """Разбивает запрос на пары (ключевое слово, тело).

    WHERE внутри списковых выражений и вызовов функций ([x IN xs WHERE ...])
    клаузой не считается. Подзапросы в фигурных скобках (EXISTS { MATCH ... })
    по-прежнему разбираются как клаузы.
    """
    depths = _bracket_depth(query)
    matches = [m for m in CLAUSE.finditer(query) if depths[m.start()] == 0]
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(query)
        yield re.sub(r"\s+", " ", m.group(0).upper()), query[m.end():end]


def check_scopes(query: str) -> list[str]:
    """Ищет переменные, использованные вне области видимости.

    Флагуется только то, что было объявлено раньше в этом же запросе,
    а затем выпало из области видимости после WITH. Незнакомые имена
    (функции, метки, параметры) не трогаются — иначе будут ложные срабатывания.
    """
    problems: list[str] = []
    scope: set[str] = set()
    ever: set[str] = set()
    locals_seen: set[str] = set()
    wildcard = False

    for keyword, body in clauses(query):
        used = {g for match in USAGE.findall(body) for g in match if g}
        if keyword in BARE_USAGE_CLAUSES:
            used |= bare_names(body)
        for name in sorted(used):
            if name in KEYWORDS or name in locals_seen:
                continue
            if name in ever and not wildcard and name not in scope:
                problems.append(
                    f"переменная {name!r} использована в {keyword}, "
                    f"но её нет в области видимости после последнего WITH "
                    f"(доступны: {', '.join(sorted(scope)) or '—'})"
                )

        locals_seen |= set(LOCAL_VAR.findall(body))

        if keyword in ("WITH", "RETURN"):
            names = projected_names(body.split(" ORDER BY")[0])
            if "*" in names:
                wildcard = True
            else:
                wildcard = False
                scope = names
            ever |= scope
        else:
            declared = set(PATTERN_VAR.findall(body))
            if keyword == "UNWIND":
                declared |= set(UNWIND_ALIAS.findall(body))
            if keyword == "FOREACH":
                declared = set()
            scope |= declared
            ever |= declared

    return problems


# --------------------------------------------------------------------------
#  Сбор запросов из исходников
# --------------------------------------------------------------------------


def query_modules() -> list[str]:
    """Модули API, которые обращаются к Neo4j."""
    here = Path(__file__).resolve().parent
    return sorted(
        path.stem for path in here.glob("*.py")
        if path.stem not in SKIP_MODULES and DB_MARKER.search(path.read_text(encoding="utf-8"))
    )


def collect_queries() -> list[tuple[str, str]]:
    """Все Cypher-строки проекта: константы модулей + литералы внутри функций."""
    found: list[tuple[str, str]] = []
    seen: set[str] = set()
    here = Path(__file__).resolve().parent

    for name in query_modules():
        module = __import__(name)
        for attribute in dir(module):
            value = getattr(module, attribute)
            if isinstance(value, str) and CYPHER_MARKER.search(value):
                if value not in seen:
                    seen.add(value)
                    found.append((f"{name}.{attribute}", value))

        tree = ast.parse((here / f"{name}.py").read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if CYPHER_MARKER.search(node.value) and node.value not in seen:
                    seen.add(node.value)
                    found.append((f"{name}.py:{node.lineno}", node.value))
    return found


def run_offline() -> int:
    queries = collect_queries()
    failures = 0
    for label, query in queries:
        problems = check_scopes(query)
        if problems:
            failures += 1
            print(f"[ОШИБКА] {label}")
            for problem in problems:
                print(f"    {problem}")
            print("    " + " ".join(query.split())[:160])
    print(f"\nПроверено запросов: {len(queries)}; с ошибками области видимости: {failures}")
    return failures


def run_explain() -> int:
    """EXPLAIN каждого запроса на живой базе: разбор силами самой Neo4j."""
    import os

    from neo4j import GraphDatabase

    driver = GraphDatabase.driver(
        os.getenv("NEO4J_URI", "bolt://neo4j:7687"),
        auth=(os.getenv("NEO4J_USER", "neo4j"), os.getenv("NEO4J_PASSWORD", "password123")),
    )
    # Параметры-заглушки: EXPLAIN не выполняет запрос, но требует их наличия.
    params: dict[str, Any] = {
        "node_id": "0", "attributes": [], "limit": 1, "id": "x", "value": "x",
        "name": "x", "code": "x", "text": "x", "type": "REQUIREMENT", "status": "active",
        "description": "x", "instruction": "x", "number": "x", "title": "x", "date": None,
        "is_violation": True, "targets": [], "labels": [], "props": {},
        "order_id": "x", "order_node_id": "0", "clause_node_id": "0", "rule_node_id": "0",
        "clause_id": "x", "department_id": None, "is_student": None, "students_only": False,
        "values": [], "names": [], "ids": [], "keep": "0", "twins": [], "error": None,
        "duties": None, "changed": False, "department_node_id": "0", "reviewed": False,
    }
    failures = 0
    queries = collect_queries()
    try:
        with driver.session() as session:
            for label, query in queries:
                try:
                    session.run("EXPLAIN " + query, **params).consume()
                except Exception as exc:  # noqa: BLE001
                    failures += 1
                    print(f"[ОШИБКА] {label}: {str(exc).splitlines()[0]}")
                    print("    " + " ".join(query.split())[:160])
    finally:
        driver.close()
    print(f"\nEXPLAIN выполнен для {len(queries)} запросов; отклонено базой: {failures}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--explain", action="store_true",
                        help="дополнительно прогнать EXPLAIN на живой базе")
    args = parser.parse_args()

    failures = run_offline()
    if args.explain:
        failures += run_explain()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
