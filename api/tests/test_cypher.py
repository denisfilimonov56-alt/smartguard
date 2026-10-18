"""Разбор Cypher-запросов без базы.

Юнит-тесты подменяют драйвер, поэтому текст запроса в них не разбирается:
запрос с ошибкой области видимости проходит все тесты и падает у пользователя.
Именно так сломалось удаление узлов — переменная использовалась в RETURN
после WITH, который её не пронёс.
"""

import pytest

from verify_cypher import (
    CYPHER_MARKER,
    check_scopes,
    collect_queries,
    projected_names,
    query_modules,
    split_top_level,
)


def test_every_query_in_the_project_is_scope_clean():
    queries = collect_queries()
    assert queries, "не найдено ни одного Cypher-запроса — проверка бесполезна"
    broken = {label: check_scopes(q) for label, q in queries}
    broken = {k: v for k, v in broken.items() if v}
    assert not broken, "запросы с ошибкой области видимости: " + repr(broken)


def test_checker_catches_the_regression():
    """Тот самый запрос, который ломал удаление."""
    problems = check_scopes("""
        MATCH (n) WHERE elementId(n) = $node_id
        OPTIONAL MATCH (n)-[:CONTAINS]->(c:Clause)
        WITH n, collect(DISTINCT c) AS cs
        RETURN size([x IN collect(DISTINCT c) WHERE x IS NOT NULL]) AS clauses
    """)
    assert problems and "'c'" in problems[0]


def test_checker_accepts_correct_query():
    assert check_scopes("""
        MATCH (n) WHERE elementId(n) = $node_id
        OPTIONAL MATCH (n)-[:CONTAINS|DEFINES|HAS_EXAMPLE*1..3]->(d)
        WITH collect(DISTINCT d) AS ds
        RETURN size([x IN ds WHERE x:Clause]) AS clauses
    """) == []


def test_checker_allows_wildcard_projection():
    assert check_scopes("""
        MATCH (o:Order)-[:CONTAINS]->(c:Clause)
        WITH *
        RETURN o.number AS number, c.code AS code
    """) == []


def test_checker_ignores_list_comprehension_variables():
    assert check_scopes("""
        MATCH (n) WHERE elementId(n) = $node_id
        WITH collect(n) AS ns
        RETURN [x IN ns WHERE x:Clause] AS clauses
    """) == []


@pytest.mark.parametrize("text,expected", [
    ("n, collect(d) AS ds", {"n", "ds"}),
    ("a.b AS x, y", {"x", "y"}),
    ("*", {"*"}),
    ("size([x IN ds WHERE x:Clause]) AS clauses, n", {"clauses", "n"}),
])
def test_projected_names(text, expected):
    assert projected_names(text) == expected


def test_split_top_level_respects_brackets():
    assert split_top_level("a, f(b, c), [d, e]") == ["a", " f(b, c)", " [d, e]"]


@pytest.mark.parametrize("query,name", [
    ("MATCH (n) OPTIONAL MATCH (n)-->(d) WITH n, collect(d) AS ds RETURN d", "d"),
    ("MATCH (n)-[rel:X]->(m) WITH n DELETE rel", "rel"),
    ("MATCH (n)-->(m) WITH n WHERE m:Clause RETURN n", "m"),
    ("MATCH (n)-->(m) WITH n SET m.x = 1", "m"),
])
def test_checker_catches_bare_variables(query, name):
    """Голое имя после WITH, который его не пронёс, — тоже ошибка области видимости."""
    problems = check_scopes(query)
    assert problems and f"'{name}'" in problems[0]


def test_checker_handles_distinct_and_comprehension_where():
    assert check_scopes("""
        MATCH (r:Rule) OPTIONAL MATCH (r)-[old:A]->() DELETE old
        WITH DISTINCT r UNWIND $values AS name MATCH (t {name: name})
        MERGE (r)-[:A]->(t) RETURN count(DISTINCT t) AS linked
    """) == []
    assert check_scopes("""
        MATCH (n) WITH collect(n) AS ns
        RETURN size([x IN ns WHERE x:Clause]) AS a, [l IN labels(head(ns)) WHERE l IN $labels] AS b
    """) == []


def test_bare_create_is_recognised_as_cypher():
    assert CYPHER_MARKER.search("CREATE (n:X {a: 1})")


def test_modules_are_found_automatically():
    modules = query_modules()
    for name in ("graph", "catalog", "diagnostics", "users", "history", "settings", "apikeys"):
        assert name in modules
