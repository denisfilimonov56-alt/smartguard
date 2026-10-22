"""Разбор ошибок 22 октября, каталог и данные: N10, N11, N12, N23, N24, N27.

Neo4j не нужен: каталог проверяется на диспетчере запросов из test_catalog
(фикстура db), настройки — на подменённом _run, сидер — на заглушке транзакции.
"""

import threading
from pathlib import Path

import pytest

import catalog
import examples_check
import metrics
import seed
import settings
from catalog import Invalid, Stale
from test_catalog import RULE_NODE, _exists, api, db  # noqa: F401 — фикстуры
from test_seed import INIT_DIR

JOB_NODE = "4:db:20"
DEP_NODE = "4:db:9"
TARGET_NODE = "4:db:7"


def _writes(db):
    return [p["props"] for q, p in db.calls if "SET n += $props" in q]


# ------------------- N10: PATCH срезает пробелы, как создание ----------------


def test_patch_strips_department_id_and_name(db):
    """departmentId " 5 " иначе не совпадал с "5" из запроса проверки — ONLY_IN не применялись."""
    _exists(db, DEP_NODE, ["Department"], departmentId="4", name="Отдел")
    catalog.update_properties(DEP_NODE, {"departmentId": " 5 ", "name": "  Отдел кадров\n"})
    assert _writes(db) == [{"departmentId": "5", "name": "Отдел кадров"}]
    clash = next(p for q, p in db.calls if "{departmentId: $value}" in q)
    assert clash["value"] == "5", "занятость ключа проверяется по срезанному значению"


def test_patch_blank_text_after_strip_is_like_empty(db):
    _exists(db, DEP_NODE, ["Department"], departmentId="4", name="Отдел")
    with pytest.raises(Invalid):
        catalog.update_properties(DEP_NODE, {"name": "   "})
    db.rows[catalog.Q_FETCH_NODE] = []
    _exists(db, TARGET_NODE, ["CheckTarget"], name="проект")
    catalog.update_properties(TARGET_NODE, {"description": "  \t "})
    assert _writes(db) == [{"description": ""}], "необязательное — пустая строка, как при создании"


def test_patch_strips_business_key_outside_text_limits(db):
    _exists(db, RULE_NODE, ["Rule"], ruleId="R-1")
    catalog.update_properties(RULE_NODE, {"ruleId": " R-2 "})
    assert _writes(db) == [{"ruleId": "R-2"}]


# --------------- N11: настройки — одна транзакция, кэши сбрасываются ---------


def test_settings_are_written_in_one_query(monkeypatch):
    calls = []
    monkeypatch.setattr(settings, "_run", lambda query, **params: calls.append((query, params)) or [])
    monkeypatch.setattr(settings, "_read", lambda: {})
    settings.update({"promptExamples": True, "injectionGuard": False, "чужой": 1}, "root")
    writes = [p for q, p in calls if "MERGE (s:Setting" in q]
    assert len(writes) == 1, "все ключи — одним запросом, то есть одной транзакцией"
    assert writes[0]["rows"] == [{"key": "promptExamples", "value": True},
                                 {"key": "injectionGuard", "value": False}]


def test_failed_settings_write_still_drops_caches(monkeypatch):
    """Сбой записи: кэш ответов всё равно сбрасывается (запись могла зафиксироваться)."""
    dropped = []

    def boom(query, **params):
        raise RuntimeError("Neo4j недоступен")

    monkeypatch.setattr(settings, "_run", boom)
    monkeypatch.setattr(metrics, "catalog_changed", lambda: dropped.append("answers"))
    with pytest.raises(RuntimeError):
        settings.update({"promptExamples": True, "injectionGuard": False}, "root")
    assert dropped == ["answers"]


# --------------- N12: expected у инструкции и списка обязанностей ------------


def _job(db, **props):
    _exists(db, JOB_NODE, ["JobDescription"], jobDescriptionId="UCT/a",
            **{"title": "Аналитик", "text": "текст B", **props})


def _job_updates(db):
    return [p for q, p in db.calls if q == catalog.Q_UPDATE_JOB_DESCRIPTION]


def test_job_update_with_stale_expected_is_refused(db):
    """Сценарий: A сменил текст на «текст B», B шлёт форму со снимком «текст A»."""
    _job(db)
    with pytest.raises(Stale) as exc:
        catalog.update_job_description(JOB_NODE, "Аналитик", "текст A",
                                       expected={"title": "Аналитик", "text": "текст A"})
    assert str(exc.value).startswith(catalog.STALE_MESSAGE) and "text" in str(exc.value)
    assert _job_updates(db) == [], "текст не откатывается, чужая выписка не сбрасывается"


def test_job_update_with_current_expected_writes_under_lock(db):
    _job(db)
    _, changed = catalog.update_job_description(JOB_NODE, "Ведущий аналитик", "текст C",
                                                expected={"title": "Аналитик", "text": "текст B"})
    assert changed is True
    assert _job_updates(db) == [{"node_id": JOB_NODE, "title": "Ведущий аналитик",
                                 "text": "текст C", "changed": True}]
    queries = [q for q, _ in db.calls]
    lock = next(i for i, q in enumerate(queries) if "SET n._lock" in q)
    assert lock < queries.index(catalog.Q_FETCH_NODE) < queries.index(catalog.Q_UPDATE_JOB_DESCRIPTION)
    assert db.writes, "сверка и запись — в одной транзакции"


def test_job_update_title_change_is_stale_too(db):
    _job(db, title="Старший аналитик")
    with pytest.raises(Stale):
        catalog.update_job_description(JOB_NODE, "Аналитик", "текст B",
                                       expected={"title": "Аналитик", "text": "текст B"})


@pytest.mark.parametrize("expected", [["б", "а"], ["а"], ["а", "б", "в"]])
def test_duties_with_stale_expected_are_refused(db, expected):
    _job(db, duties=["а", "б"])
    with pytest.raises(Stale):
        catalog.set_job_duties(JOB_NODE, ["в"], True, expected=expected)
    assert not any(q == catalog.Q_SET_JOB_DUTIES for q, _ in db.calls)


def test_duties_with_current_expected_write(db):
    _job(db)  # списка ещё нет — равен []
    catalog.set_job_duties(JOB_NODE, ["Готовит отчёт"], True, expected=[])
    written = [p for q, p in db.calls if q == catalog.Q_SET_JOB_DUTIES]
    assert written == [{"node_id": JOB_NODE, "duties": ["Готовит отчёт"], "reviewed": True}]
    assert any("SET n._lock" in q for q, _ in db.calls)


def test_job_routes_pass_expected_and_answer_409(api, monkeypatch):
    import routes
    monkeypatch.setattr(routes, "_duties_running", {})
    seen = {}

    def update(node_id, title, text, expected=None):
        seen["update"] = expected
        raise Stale(f"{catalog.STALE_MESSAGE}. Изменились: text")

    def duties(node_id, items, reviewed, expected=None):
        seen["duties"] = expected
        raise Stale(f"{catalog.STALE_MESSAGE}. Изменились: duties")

    monkeypatch.setattr(catalog, "update_job_description", update)
    monkeypatch.setattr(catalog, "set_job_duties", duties)
    response = api.put(f"/catalog/job-descriptions/{JOB_NODE}",
                       json={"title": "А", "text": "старый",
                             "expected": {"title": "А", "text": "старый"}})
    assert response.status_code == 409 and catalog.STALE_MESSAGE in response.json()["detail"]
    assert seen["update"] == {"title": "А", "text": "старый"}
    response = api.put(f"/catalog/job-descriptions/{JOB_NODE}/duties",
                       json={"duties": ["в"], "expected": ["а", "б"]})
    assert response.status_code == 409
    assert seen["duties"] == ["а", "б"]


def test_job_routes_without_expected_keep_old_call(api, monkeypatch):
    """Без expected слой данных вызывается как раньше — без лишнего аргумента."""
    import routes
    monkeypatch.setattr(routes, "_duties_running", {})
    node = {"nodeId": JOB_NODE, "labels": ["JobDescription"], "dutiesStatus": "ready"}
    monkeypatch.setattr(catalog, "update_job_description", lambda n, title, text: (node, False))
    monkeypatch.setattr(catalog, "set_job_duties", lambda n, items, reviewed: node)
    assert api.put(f"/catalog/job-descriptions/{JOB_NODE}",
                   json={"title": "А", "text": "т"}).status_code == 200
    assert api.put(f"/catalog/job-descriptions/{JOB_NODE}/duties",
                   json={"duties": ["в"]}).status_code == 200


# ------------- N23: запрос к Neo4j не под общим замком выписок --------------


def _in_thread(fn):
    thread = threading.Thread(target=fn, daemon=True)
    thread.start()
    thread.join(timeout=2)
    return not thread.is_alive()


def test_closing_orphan_does_not_block_other_jobs(monkeypatch):
    import routes
    monkeypatch.setattr(routes, "_duties_running", {"4:db:99": 1})
    monkeypatch.setattr(routes, "_duties_starting", 0)
    monkeypatch.setattr(routes, "_duties_closing", set())
    entered, release = threading.Event(), threading.Event()

    def slow_close(node_id):
        entered.set()
        release.wait(5)
        return True

    monkeypatch.setattr(catalog, "fail_orphaned_duties", slow_close)
    closer = threading.Thread(target=routes._close_orphaned_duties, args=(JOB_NODE,), daemon=True)
    closer.start()
    try:
        assert entered.wait(2)
        # Завершение чужой выписки и старт другой инструкции не ждут медленную базу.
        assert _in_thread(lambda: routes._duties_done("4:db:99")), "завершение выписки заблокировано"

        def start_other():
            with routes._Starting("4:db:98"):
                pass

        assert _in_thread(start_other), "старт другой выписки заблокирован"
        # Старт той же инструкции ждёт конца закрытия — иначе error затёр бы его pending.
        same_started = threading.Event()

        def start_same():
            with routes._Starting(JOB_NODE):
                same_started.set()

        threading.Thread(target=start_same, daemon=True).start()
        assert not same_started.wait(0.3)
    finally:
        release.set()
    closer.join(2)
    assert same_started.wait(2)
    assert routes._duties_closing == set() and routes._duties_starting == 0


# ------------ N24: условная миграция не отмечается впустую -------------------


class _Tx:
    def __init__(self, done):
        self.done, self.statements = done, []

    def run(self, statement, **params):
        self.statements.append(statement)
        tx = self

        class Result:
            def consume(self):
                return None

            def single(self):
                return {"done": tx.done, "version": 3}

        return Result()


def test_job_migration_declares_mark_condition():
    script = (INIT_DIR / "migrations" / "003_job_descriptions.cypher").read_text(encoding="utf-8")
    condition = seed.mark_condition(script)
    assert condition and 'Clause {code: "3.5"}' in condition and "AS done" in condition
    assert all("@mark-if" not in s for s in seed.split_statements(script)), "условие — не оператор"


@pytest.mark.parametrize("done,marked", [(False, False), (True, True)])
def test_conditional_migration_is_marked_only_when_done(done, marked):
    tx = _Tx(done)
    version, was_marked = seed._write_all(tx, ["MERGE (t:CheckTarget {name: 'x'})"], "003_x",
                                          "RETURN false AS done")
    assert was_marked is marked and version == 3
    assert (seed.MARK_MIGRATION in tx.statements) is marked
    assert tx.statements[-1] == seed.BUMP_CATALOG_VERSION


def test_unconditional_migration_is_marked_as_before():
    tx = _Tx(False)
    _, marked = seed._write_all(tx, ["MATCH (n:X) SET n.y = 1"], "002_x")
    assert marked and seed.MARK_MIGRATION in tx.statements


def test_main_passes_mark_condition_of_migration(monkeypatch, tmp_path):
    from test_seed import _SeedRun
    (tmp_path / "migrations").mkdir()
    run = _SeedRun(monkeypatch, tmp_path, seed_name="migrations/003_x.cypher")
    run.seed_file.write_text("// @mark-if: MATCH (c:Clause) RETURN count(c) > 0 AS done\n"
                             "MERGE (t:CheckTarget {name: 'x'});", encoding="utf-8")
    assert seed.main() == 0
    assert run.options["mark_if"] == "MATCH (c:Clause) RETURN count(c) > 0 AS done"


# ---------------- N27: нестроковый text примера не роняет прогон -------------


def test_examples_check_reads_text_through_to_string():
    query = examples_check.Q_EXAMPLES
    assert "coalesce(e.text" not in query
    assert "trim(coalesce(toStringOrNull(e.text), ''))" in query
    assert "toStringOrNull(e.text)         AS text" in query


def test_examples_check_query_matches_rule_examples_filter():
    import graph
    assert "trim(coalesce(toStringOrNull(e.text), '')) <> ''" in graph.RULE_EXAMPLES
    assert "trim(coalesce(toStringOrNull(e.text), '')) <> ''" in examples_check.Q_EXAMPLES


def test_migration_files_still_parse():
    for path in sorted(Path(INIT_DIR / "migrations").glob("*.cypher")):
        assert seed.split_statements(path.read_text(encoding="utf-8"))
