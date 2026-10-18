"""Тесты сидера и выгрузки: разбиение Cypher и согласованность запросов."""

import re
from pathlib import Path

import pytest

import graph
from export_graph import (
    DATA_MARKER,
    cypher_literal,
    render_data_block,
    render_node,
    render_relationship,
    splice_into,
)
from seed import SCHEMA_RE, split_statements

INIT_DIR = Path(__file__).resolve().parents[2] / "neo4j" / "init"
SEED_PATH = INIT_DIR / "seed.cypher"


# --------------------------- split_statements -------------------------------


def test_splits_simple_statements():
    assert split_statements("MATCH (n) RETURN n; MATCH (m) RETURN m;") == [
        "MATCH (n) RETURN n",
        "MATCH (m) RETURN m",
    ]


def test_semicolon_inside_string_does_not_split():
    statements = split_statements('CREATE (n:X {text: "первое; второе"});')
    assert len(statements) == 1
    assert "первое; второе" in statements[0]


def test_line_comments_are_stripped():
    assert split_statements("// комментарий с ; точкой\nMATCH (n) RETURN n;") == [
        "MATCH (n) RETURN n"
    ]


def test_block_comments_are_stripped():
    assert split_statements("/* блок ; комментария */ MATCH (n) RETURN n;") == [
        "MATCH (n) RETURN n"
    ]


def test_trailing_statement_without_semicolon_is_kept():
    assert split_statements("MATCH (n) RETURN n") == ["MATCH (n) RETURN n"]


def test_empty_script_gives_no_statements():
    assert split_statements("// только комментарий\n\n") == []


# --------------------------- файлы в neo4j/init -----------------------------


def _statements(path: Path) -> list[str]:
    if not path.exists():
        pytest.skip(f"{path} недоступен из каталога тестов")
    return split_statements(path.read_text(encoding="utf-8"))


def test_seed_contains_schema_only():
    """Демо-данные удалены; в seed.cypher остаётся схема и маркер данных."""
    statements = _statements(SEED_PATH)
    assert statements, "в seed.cypher нет операторов"
    assert all(SCHEMA_RE.match(s) for s in statements), "в seed.cypher появились данные"
    assert DATA_MARKER in SEED_PATH.read_text(encoding="utf-8")


def test_seed_has_no_demo_orders():
    text = SEED_PATH.read_text(encoding="utf-8") if SEED_PATH.exists() else ""
    for demo in ("PR-2024-15", "PR-2024-22"):
        assert f'orderId: "{demo}"' not in text


def test_seed_declares_constraints_for_all_export_keys():
    """MERGE в выгрузке опирается на уникальность ключей — она должна быть в схеме."""
    text = SEED_PATH.read_text(encoding="utf-8") if SEED_PATH.exists() else ""
    for label, key in [
        ("Order", "orderId"),
        ("Clause", "clauseId"),
        ("Rule", "ruleId"),
        ("CheckTarget", "name"),
        ("ViolationExample", "exampleId"),
        ("Department", "departmentId"),
    ]:
        assert f"({label[0].lower()}:{label})" in text or label in text
        assert key in text, f"нет ограничения по ключу {key}"


@pytest.mark.parametrize(
    "name", ["001_cleanup_demo_data.cypher", "002_check_target_descriptions.cypher"]
)
def test_migrations_parse(name):
    statements = _statements(INIT_DIR / "migrations" / name)
    assert statements, f"миграция {name} пуста"


def test_cleanup_migration_targets_only_demo_orders():
    statements = _statements(INIT_DIR / "migrations" / "001_cleanup_demo_data.cypher")
    script = "\n".join(statements)
    assert "PR-2024-15" in script and "PR-2024-22" in script
    assert "PR-01" not in script, "миграция не должна трогать рабочий приказ"


def test_descriptions_migration_uses_merge_not_create():
    statements = _statements(INIT_DIR / "migrations" / "002_check_target_descriptions.cypher")
    for stmt in statements:
        assert not re.search(r"\bCREATE\s*\(", stmt)


# ------------------------------ export_graph --------------------------------


def test_literal_escapes_quotes_and_keeps_unicode():
    assert cypher_literal('текст с "кавычками"') == '"текст с \\"кавычками\\""'


@pytest.mark.parametrize(
    "value,expected", [(True, "true"), (False, "false"), (None, "null"), (12, "12")]
)
def test_literal_scalars(value, expected):
    assert cypher_literal(value) == expected


def test_literal_list():
    assert cypher_literal(["a", 1]) == '["a", 1]'


def test_render_node_merges_on_key():
    cypher = render_node("Rule", {"ruleId": "R-1.1", "type": "REQUIREMENT"})
    assert cypher.startswith('MERGE (n:Rule {ruleId: "R-1.1"})')
    assert 'n.type = "REQUIREMENT"' in cypher
    assert "n.ruleId" not in cypher, "ключ не должен переприсваиваться в SET"


def test_render_node_without_extra_properties():
    assert render_node("CheckTarget", {"name": "проект"}) == 'MERGE (n:CheckTarget {name: "проект"});'


def test_render_node_requires_key():
    with pytest.raises(ValueError):
        render_node("Order", {"title": "без ключа"})


def test_render_relationship():
    cypher = render_relationship(
        {
            "a_label": "Rule",
            "a_props": {"ruleId": "R-1.1"},
            "rel_type": "APPLIES_TO",
            "rel_props": {},
            "b_label": "CheckTarget",
            "b_props": {"name": "проект"},
        }
    )
    assert 'MATCH (a:Rule {ruleId: "R-1.1"})' in cypher
    assert "MERGE (a)-[:APPLIES_TO]->(b);" in cypher


def test_render_exception_keeps_status_and_basis():
    """Статус и основание исключения живут на связи — выгрузка не должна их терять."""
    cypher = render_relationship(
        {
            "a_label": "Rule",
            "a_props": {"ruleId": "R-2.4"},
            "rel_type": "EXCEPT_IN",
            "rel_props": {"status": "active", "basis": "ПР-01 п. 2.5", "note": None},
            "b_label": "Department",
            "b_props": {"departmentId": "AGD", "name": "АГД"},
        }
    )
    assert '(b:Department {departmentId: "AGD"})' in cypher
    assert "MERGE (a)-[x:EXCEPT_IN]->(b)" in cypher
    assert 'x.basis = "ПР-01 п. 2.5"' in cypher and 'x.status = "active"' in cypher
    assert "x.note" not in cypher


def test_departments_are_exported_before_relationships():
    block = render_data_block(
        [("Department", {"departmentId": "UCT", "name": "УЦТ", "status": "active"}),
         ("Rule", {"ruleId": "R-1.1", "type": "REQUIREMENT"})],
        [{"a_label": "Rule", "a_props": {"ruleId": "R-1.1"}, "rel_type": "ONLY_IN",
          "rel_props": {}, "b_label": "Department", "b_props": {"departmentId": "UCT"}}],
    )
    assert block.index('MERGE (n:Department {departmentId: "UCT"})') < block.index("ONLY_IN")
    assert all(SCHEMA_RE.match(s) is None for s in split_statements(block))


def test_render_data_block_is_idempotent_cypher():
    """Выгрузка не должна содержать ни одного голого CREATE."""
    block = render_data_block(
        [("Order", {"orderId": "PR-01", "number": "ПР-01"}), ("CheckTarget", {"name": "проект"})],
        [
            {
                "a_label": "Order",
                "a_props": {"orderId": "PR-01"},
                "rel_type": "CONTAINS",
                "rel_props": {},
                "b_label": "CheckTarget",
                "b_props": {"name": "проект"},
            }
        ],
    )
    assert not re.search(r"\bCREATE\s*\(", block)
    for statement in split_statements(block):
        assert statement.startswith(("MERGE", "MATCH"))


def test_render_data_block_is_stable():
    """Порядок не должен зависеть от порядка чтения из базы — иначе шумный diff."""
    nodes_a = [("CheckTarget", {"name": "б"}), ("CheckTarget", {"name": "а"})]
    nodes_b = [("CheckTarget", {"name": "а"}), ("CheckTarget", {"name": "б"})]
    assert render_data_block(nodes_a, []) == render_data_block(nodes_b, [])


def test_splice_replaces_everything_after_marker():
    existing = f"CREATE CONSTRAINT x IF NOT EXISTS FOR (n:N) REQUIRE n.id IS UNIQUE;\n\n{DATA_MARKER}\nстарые данные\n"
    result = splice_into(existing, 'MERGE (n:CheckTarget {name: "новый"});\n')
    assert "старые данные" not in result
    assert "CREATE CONSTRAINT" in result
    assert "новый" in result


def test_splice_requires_marker():
    with pytest.raises(ValueError):
        splice_into("без маркера", "данные")


# ------------------ согласованность graph.py и выгрузки ---------------------


def test_graph_queries_do_not_use_legacy_labels():
    queries = graph.FIND_PROHIBITIONS + graph.FIND_MISSING_REQUIREMENTS + graph.ALL_CHECK_TARGETS
    for label in ("GoalAttribute", "Requirement", "Example)"):
        assert label not in queries, f"запрос ссылается на устаревшую метку {label}"


def test_both_queries_return_same_columns():
    def columns(query: str) -> set[str]:
        tail = query.split("RETURN", 1)[1].split("ORDER BY")[0]
        return set(re.findall(r"AS\s+(\w+)", tail))

    assert columns(graph.FIND_PROHIBITIONS) == columns(graph.FIND_MISSING_REQUIREMENTS)


def test_duplicate_query_normalizes_like_the_agent():
    """Диагностика в графе и сопоставление в агенте должны видеть дубли одинаково."""
    from agent import normalize_name

    assert normalize_name("Срок Исполнения") == normalize_name("срок исполнения")
    assert "replace" in graph.DUPLICATE_CHECK_TARGETS
    assert "toLower" in graph.DUPLICATE_CHECK_TARGETS
