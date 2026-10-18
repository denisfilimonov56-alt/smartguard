"""Тесты сидера и выгрузки: разбиение Cypher и согласованность запросов."""

import re
from pathlib import Path

import pytest

import graph
import export_graph
import seed
from export_graph import (
    DATA_MARKER,
    NODE_KEYS,
    cypher_literal,
    render_data_block,
    render_data_file,
    render_node,
    render_relationship,
)
from naming import normalize_name
from seed import SCHEMA_RE, split_statements

INIT_DIR = Path(__file__).resolve().parents[2] / "neo4j" / "init"
SEED_PATH = INIT_DIR / "seed.cypher"
DATA_PATH = INIT_DIR / "data.cypher"
MIGRATIONS = sorted((INIT_DIR / "migrations").glob("*.cypher"))


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
    """seed.cypher выполняется при каждом подъёме стека — данных в нём быть не должно."""
    statements = _statements(SEED_PATH)
    assert statements, "в seed.cypher нет операторов"
    assert all(SCHEMA_RE.match(s) for s in statements), "в seed.cypher появились данные"
    assert DATA_MARKER not in SEED_PATH.read_text(encoding="utf-8"), "данные — в data.cypher"


def test_data_file_has_no_schema():
    """Файл данных применяется условно; схема в нём потерялась бы на непустой базе."""
    assert DATA_PATH.exists(), "export_graph пишет в neo4j/init/data.cypher — файл должен быть в наборе"
    assert all(SCHEMA_RE.match(s) is None for s in split_statements(DATA_PATH.read_text(encoding="utf-8")))


def test_seed_has_no_demo_orders():
    text = SEED_PATH.read_text(encoding="utf-8") if SEED_PATH.exists() else ""
    for demo in ("PR-2024-15", "PR-2024-22"):
        assert f'orderId: "{demo}"' not in text


UNIQUE_RE = re.compile(
    r"CREATE\s+CONSTRAINT\s+\w+\s+IF\s+NOT\s+EXISTS\s+FOR\s+\((\w+):(\w+)\)\s+"
    r"REQUIRE\s+(\w+)\.(\w+)\s+IS\s+UNIQUE", re.IGNORECASE)


def _unique_constraints(path: Path) -> set[tuple[str, str]]:
    found = set()
    for statement in _statements(path):
        match = UNIQUE_RE.fullmatch(" ".join(statement.split()))
        if match and match.group(1) == match.group(3):
            found.add((match.group(2), match.group(4)))
    return found


@pytest.mark.parametrize("label,key", sorted(NODE_KEYS.items()) + [("CatalogVersion", "id")])
def test_seed_declares_constraints_for_all_export_keys(label, key):
    """MERGE в выгрузке опирается на уникальность ключей — она должна быть в схеме."""
    assert (label, key) in _unique_constraints(SEED_PATH), f"нет ограничения :{label}.{key}"


@pytest.mark.parametrize("path", MIGRATIONS, ids=lambda p: p.name)
def test_migrations_parse(path):
    statements = _statements(path)
    assert statements, f"миграция {path.name} пуста"


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


def test_data_file_is_header_and_block():
    content = render_data_file([("CheckTarget", {"name": "проект"})], [])
    assert content.startswith("// ====")
    assert split_statements(content) == ['MERGE (n:CheckTarget {name: "проект"})']


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


def test_one_normalization_for_agent_diagnostics_and_repair():
    """Двойники видят одинаково агент, диагностика и сведение (catalog.merge_duplicate_targets)."""
    import agent
    import catalog
    import diagnostics

    assert agent.normalize_name is normalize_name
    assert catalog.normalize_name is normalize_name and diagnostics.normalize_name is normalize_name
    twins = ["срок исполнения", "Срок-Исполнения", "СРОК_ИСПОЛНЕНИЯ", " срок  исполнения ",
             "срок\u00a0исполнения", "срок - исполнения"]
    assert len({normalize_name(t) for t in twins}) == 1
    assert normalize_name("ёмкость") == normalize_name("емкость")
    assert normalize_name("срок исполнения") != normalize_name("срок")


# ------------------------- безопасность выгрузки -----------------------------


@pytest.mark.parametrize("key", [
    "примечание автора",
    "x = 1; MATCH (n) DETACH DELETE n; MATCH (z) SET z.q",
    "a`b",
])
def test_render_node_escapes_property_names(key):
    """Имя свойства задаёт редактор: без кавычек оно ломало seed или внедряло Cypher."""
    cypher = render_node("Rule", {"ruleId": "R-1.1", key: "x"})
    statements = split_statements(cypher)
    assert len(statements) == 1, "имя свойства не должно разрывать оператор"
    escaped = "`" + key.replace("`", "``") + "`"
    assert f"n.{escaped} = " in cypher


def test_plain_names_stay_unquoted():
    assert "n.checkInstruction = " in render_node("Rule", {"ruleId": "R", "checkInstruction": "x"})


def test_relationship_property_names_are_escaped():
    cypher = render_relationship({
        "a_label": "Rule", "a_props": {"ruleId": "R-1"}, "rel_type": "ONLY_IN",
        "rel_props": {"bad key; DROP": 1}, "b_label": "Department", "b_props": {"departmentId": "D"},
    })
    assert "x.`bad key; DROP` = 1" in cypher and len(split_statements(cypher)) == 1


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_literal_rejects_non_finite_floats(value):
    with pytest.raises(ValueError):
        cypher_literal(value)


def test_literal_duration_is_not_a_list():
    """neo4j.time.Duration — кортеж; раньше он выгружался списком чисел."""
    from neo4j.time import Duration
    assert cypher_literal(Duration(days=3, hours=2)) == 'duration("P3DT2H")'


def test_department_without_key_is_skipped_with_its_links(caplog):
    block = render_data_block(
        [("Department", {"name": "Без ключа"}), ("Rule", {"ruleId": "R-1"})],
        [{"a_label": "Rule", "a_props": {"ruleId": "R-1"}, "rel_type": "ONLY_IN",
          "rel_props": {}, "b_label": "Department", "b_props": {"name": "Без ключа"}}],
    )
    assert "Без ключа" not in block and "ONLY_IN" not in block
    assert "не выгружен" in caplog.text


def test_other_nodes_without_key_explain_the_fix():
    with pytest.raises(ValueError) as exc:
        render_data_block([("Order", {"number": "ПР-9"})], [])
    assert "repair-identifiers" in str(exc.value)


def test_export_reads_nodes_and_relationships_in_one_read_transaction():
    calls = []

    class Session:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute_read(self, fn):
            calls.append(fn)
            return [], []

    class Driver:
        def session(self):
            return Session()

    assert export_graph.fetch_graph(Driver()) == ([], [])
    assert calls == [export_graph._read_graph]


def test_relationships_query_walks_only_catalog_labels():
    assert "MATCH (a:Order|Clause|" in export_graph.FETCH_RELATIONSHIPS
    assert "MATCH (a)-[r]->(b)" not in export_graph.FETCH_RELATIONSHIPS


def _fake_neo4j(monkeypatch, nodes):
    import neo4j

    class Driver:
        def close(self):
            pass

    monkeypatch.setattr(neo4j.GraphDatabase, "driver", lambda *a, **k: Driver())
    monkeypatch.setattr(export_graph, "fetch_graph", lambda driver: (nodes, []))


def test_export_reports_unwritable_target(monkeypatch, tmp_path, caplog):
    """Нет прав на запись в примонтированный каталог — понятное сообщение, а не трассировка."""
    _fake_neo4j(monkeypatch, [("CheckTarget", {"name": "проект"})])
    monkeypatch.setattr("sys.argv", ["export_graph.py", "--output", str(tmp_path)])  # каталог — OSError
    assert export_graph.main() == 1
    assert "--stdout > neo4j/init/data.cypher" in caplog.text


def test_export_stdout_prints_whole_data_file(monkeypatch, capsys):
    _fake_neo4j(monkeypatch, [("CheckTarget", {"name": "проект"})])
    monkeypatch.setattr("sys.argv", ["export_graph.py", "--stdout"])
    assert export_graph.main() == 0
    out = capsys.readouterr().out
    assert out.startswith("// ====") and 'MERGE (n:CheckTarget {name: "проект"});' in out


# ------------------------------- сидер ---------------------------------------


class FakeSession:
    def __init__(self, log):
        self.log = log

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def run(self, statement, **params):
        self.log.append(("session", statement))
        return type("R", (), {"consume": lambda self: None,
                              "single": lambda self: {"version": 7, "empty": True}})()

    def execute_write(self, fn, *args):
        self.log.append(("tx-begin", None))
        session = self

        class Tx:
            def run(self, statement, **params):
                session.log.append(("tx", statement))
                return session.run.__func__(type("S", (), {"log": []})(), statement)

        return fn(Tx(), *args)


class FakeDriver:
    def __init__(self):
        self.log = []

    def session(self):
        return FakeSession(self.log)


def test_seeder_skips_data_on_filled_catalog():
    """Правки из интерфейса не откатываются: данные не применяются к непустому каталогу."""
    driver = FakeDriver()
    seed.run_statements(driver, ["CREATE CONSTRAINT x IF NOT EXISTS FOR (n:N) REQUIRE n.id IS UNIQUE"],
                        ['MERGE (n:CheckTarget {name: "проект"})'], load_data=False)
    assert not any("MERGE (n:CheckTarget" in s for _, s in driver.log)
    assert not any(kind == "tx-begin" for kind, _ in driver.log), "без данных версия не растёт"


def test_seeder_writes_data_in_one_transaction_and_bumps_version():
    driver = FakeDriver()
    seed.run_statements(driver, ["MATCH (n:Order) DETACH DELETE n"],
                        ['MERGE (n:CheckTarget {name: "проект"})'], load_data=True)
    tx = [s for kind, s in driver.log if kind == "tx"]
    assert tx[0].startswith("MATCH (n:Order)") and tx[1].startswith("MERGE (n:CheckTarget")
    assert tx[-1] == seed.BUMP_CATALOG_VERSION, "версия каталога — в той же транзакции"
    assert [k for k, _ in driver.log].count("tx-begin") == 1


def test_legacy_seed_with_data_after_marker_is_split():
    explicit, data = seed.split_data(f"CREATE INDEX i IF NOT EXISTS FOR (n:N) ON (n.x);\n{DATA_MARKER}\n"
                                     'MERGE (n:Order {orderId: "PR-01"});')
    assert split_statements(explicit) == ["CREATE INDEX i IF NOT EXISTS FOR (n:N) ON (n.x)"]
    assert split_statements(data) == ['MERGE (n:Order {orderId: "PR-01"})']
    assert seed.split_data("MATCH (n) RETURN n") == ("MATCH (n) RETURN n", "")


# ------------------- обратные кавычки в сплиттере (C4) -----------------------


def test_backslash_inside_backticks_is_not_an_escape():
    """В Cypher \\ в `...` не экранирует: ключ `x\\` не «съедает» закрывающую кавычку."""
    script = render_node("Order", {"orderId": "o1", "x\\": 1, "b": "x;y"}) + "\n" \
        + render_node("Order", {"orderId": "o2", "c": 2})
    assert "n.`x\\` = 1" in script
    assert len(split_statements(script)) == 2


def test_doubled_backtick_inside_name_keeps_one_statement():
    script = render_node("Order", {"orderId": "o1", "a`;b": 1, "x\\": "y;z"})
    assert "n.`a``;b` = 1" in script
    assert split_statements(script) == [script.rstrip().rstrip(";")]


def test_backslash_still_escapes_inside_strings():
    assert split_statements("RETURN 'a\\';b';RETURN 2") == ["RETURN 'a\\';b'", "RETURN 2"]


# -------------------------- пустое имя в выгрузке ----------------------------


def test_empty_property_name_is_a_clear_export_error():
    with pytest.raises(ValueError) as exc:
        export_graph.escape_name("")
    assert "пустым именем" in str(exc.value)
    with pytest.raises(ValueError):
        render_data_file([("Order", {"orderId": "o1", "": 1})], [])


def test_export_with_empty_name_fails_without_traceback(monkeypatch, tmp_path, caplog):
    _fake_neo4j(monkeypatch, [("Order", {"orderId": "o1", "": 1})])
    target = tmp_path / "data.cypher"
    target.write_text("прежние данные", encoding="utf-8")
    monkeypatch.setattr("sys.argv", ["export_graph.py", "--output", str(target)])
    assert export_graph.main() == 1
    assert target.read_text(encoding="utf-8") == "прежние данные"


# ----------------------- атомарная запись выгрузки ---------------------------


def test_export_output_is_written_atomically(monkeypatch, tmp_path):
    _fake_neo4j(monkeypatch, [("CheckTarget", {"name": "проект"})])
    target = tmp_path / "data.cypher"
    target.write_text("прежние данные", encoding="utf-8")
    replaced = []
    real_replace = export_graph.os.replace
    monkeypatch.setattr(export_graph.os, "replace",
                        lambda src, dst: replaced.append((Path(src).name, Path(dst).name)) or real_replace(src, dst))
    monkeypatch.setattr("sys.argv", ["export_graph.py", "--output", str(target)])
    assert export_graph.main() == 0
    assert replaced == [("data.cypher.new", "data.cypher")]
    assert 'MERGE (n:CheckTarget {name: "проект"});' in target.read_text(encoding="utf-8")
    assert not (tmp_path / "data.cypher.new").exists()


def test_failed_export_keeps_previous_file_and_suggests_safe_redirect(monkeypatch, tmp_path, caplog):
    _fake_neo4j(monkeypatch, [("CheckTarget", {"name": "проект"})])
    target = tmp_path / "data.cypher"
    target.write_text("прежние данные", encoding="utf-8")

    def broken(src, dst):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(export_graph.os, "replace", broken)
    monkeypatch.setattr(export_graph.os, "access", lambda path, mode: False)
    monkeypatch.setattr("sys.argv", ["export_graph.py", "--output", str(target)])
    assert export_graph.main() == 1
    assert target.read_text(encoding="utf-8") == "прежние данные"
    assert not (tmp_path / "data.cypher.new").exists()
    assert "> neo4j/init/data.cypher.new && mv neo4j/init/data.cypher.new neo4j/init/data.cypher" \
        in caplog.text


def test_export_writes_in_place_when_only_the_file_is_writable(monkeypatch, tmp_path):
    """uid 10001 выдано право на data.cypher, но не на каталог: --output всё равно работает."""
    _fake_neo4j(monkeypatch, [("CheckTarget", {"name": "проект"})])
    target = tmp_path / "data.cypher"
    target.write_text("прежние данные", encoding="utf-8")

    def broken(src, dst):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(export_graph.os, "replace", broken)
    monkeypatch.setattr("sys.argv", ["export_graph.py", "--output", str(target)])
    assert export_graph.main() == 0
    assert "проект" in target.read_text(encoding="utf-8")
    assert not (tmp_path / "data.cypher.new").exists()


# -------------------- файл данных только со схемой (C8) ----------------------


def test_data_file_is_used_only_with_schema_seed(tmp_path):
    data = tmp_path / "data.cypher"
    data.write_text('MERGE (n:Order {orderId: "o"});', encoding="utf-8")
    assert seed.data_file_for(tmp_path / "seed.cypher", data) == data
    assert seed.data_file_for(tmp_path / "reset_and_load.cypher", data) is None
    assert seed.data_file_for(tmp_path / "001_cleanup_demo_data.cypher", data) is None
    assert seed.data_file_for(tmp_path / "seed.cypher", tmp_path / "нет.cypher") is None


class _SeedRun:
    """Запуск seed.main без Neo4j: что применилось и читался ли файл данных."""

    def __init__(self, monkeypatch, tmp_path, seed_name="seed.cypher", empty=True, force=False,
                 data_text='MERGE (n:Order {orderId: "o"});'):
        self.applied = None
        self.seed_file = tmp_path / seed_name
        self.seed_file.write_text("CREATE INDEX i IF NOT EXISTS FOR (n:N) ON (n.x);\n"
                                  "MATCH (n:Order) DETACH DELETE n;", encoding="utf-8")
        self.data_file = tmp_path / "data.cypher"
        self.data_file.write_text(data_text, encoding="utf-8")

        class Driver:
            def close(self):
                pass

        monkeypatch.setattr(seed, "SEED_FILE", self.seed_file)
        monkeypatch.setattr(seed, "SEED_DATA_FILE", self.data_file)
        monkeypatch.setattr(seed, "FORCE_DATA", force)
        monkeypatch.setattr(seed.GraphDatabase, "driver", lambda *a, **k: Driver())
        monkeypatch.setattr(seed, "wait_for_neo4j", lambda driver: None)
        monkeypatch.setattr(seed, "catalog_is_empty", lambda driver: empty)
        monkeypatch.setattr(seed, "report", lambda driver: None)
        monkeypatch.setattr(seed, "run_statements",
                            lambda driver, statements, data, load_data:
                            setattr(self, "applied", (statements, data, load_data)))


def test_reset_on_empty_db_does_not_apply_data_file(monkeypatch, tmp_path):
    """reset_and_load + непустой data.cypher: выгрузка не перекрывает сброс в той же транзакции."""
    run = _SeedRun(monkeypatch, tmp_path, seed_name="reset_and_load.cypher", empty=True, force=True)
    assert seed.main() == 0
    statements, data, load_data = run.applied
    assert data == [] and not load_data


def test_schema_seed_on_empty_db_applies_data_file(monkeypatch, tmp_path):
    run = _SeedRun(monkeypatch, tmp_path, empty=True)
    assert seed.main() == 0
    assert run.applied[1] == ['MERGE (n:Order {orderId: "o"})'] and run.applied[2]


def test_data_file_is_not_read_when_not_applied(monkeypatch, tmp_path):
    """Непустой каталог без SEED_DATA=1: data.cypher не читается — битый файл не роняет стек."""
    run = _SeedRun(monkeypatch, tmp_path, empty=False)
    run.data_file.write_bytes(b"\xff\xfe broken")
    real_read = Path.read_text

    def guarded(self, *a, **k):
        assert self != run.data_file, "файл данных не должен читаться"
        return real_read(self, *a, **k)

    monkeypatch.setattr(Path, "read_text", guarded)
    assert seed.main() == 0
    assert run.applied[1] == [] and not run.applied[2]


def test_unreadable_data_file_gives_clear_error(monkeypatch, tmp_path, caplog):
    run = _SeedRun(monkeypatch, tmp_path, empty=True)
    run.data_file.write_bytes(b"\xff\xfe broken")
    assert seed.main() == 1
    assert "Не удалось прочитать файл данных" in caplog.text
    assert run.applied is None


def test_seed_declares_catalog_lock_constraint():
    assert ("CatalogLock", "id") in _unique_constraints(SEED_PATH)
