"""Тесты диагностики: находит ли она то, что уже ломало проверки."""

import pytest

import diagnostics

TARGET_A = "4:db:7"
TARGET_B = "4:db:8"
RULE = "4:db:3"
ORDER = "4:db:1"


@pytest.fixture
def db(monkeypatch):
    rows: dict[str, list[dict]] = {}
    monkeypatch.setattr(diagnostics, "_run", lambda q, **p: rows.get(q, []))
    return type("DB", (), {"rows": rows})


def _healthy(db):
    db.rows[diagnostics.Q_TARGETS] = [
        {"nodeId": TARGET_A, "name": "проект", "description": "назван проект", "status": "active"}
    ]
    db.rows[diagnostics.Q_TARGET_USAGE] = [{"name": "проект", "rule_count": 1}]
    return db


def codes(report):
    return [issue["code"] for issue in report["issues"]]


def test_healthy_graph_is_ready(db):
    _healthy(db)
    report = diagnostics.collect()
    assert report["ready"] is True
    assert report["counts"]["error"] == 0
    assert report["problems"] == []


def test_empty_dictionary_is_an_error(db):
    report = diagnostics.collect()
    assert "no_check_targets" in codes(report)
    assert report["ready"] is False


def test_finds_targets_without_description(db):
    _healthy(db)
    db.rows[diagnostics.Q_TARGETS].append(
        {"nodeId": TARGET_B, "name": "измеримость", "description": "  ", "status": "active"}
    )
    report = diagnostics.collect()
    issue = next(i for i in report["issues"] if i["code"] == "targets_without_description")
    assert issue["severity"] == "error"
    assert issue["items"][0]["nodeId"] == TARGET_B, "нужен nodeId, чтобы перейти к объекту"


def test_finds_spelling_twins(db):
    """Ровно эта пара узлов приводила к ложным нарушениям."""
    db.rows[diagnostics.Q_TARGETS] = [
        {"nodeId": TARGET_A, "name": "срок исполнения", "description": "о", "status": "active"},
        {"nodeId": TARGET_B, "name": "срок_исполнения", "description": "о", "status": "active"},
    ]
    db.rows[diagnostics.Q_TARGET_USAGE] = [
        {"name": "срок исполнения", "rule_count": 1}, {"name": "срок_исполнения", "rule_count": 1}
    ]
    issue = next(i for i in diagnostics.collect()["issues"] if i["code"] == "duplicate_check_targets")
    assert issue["severity"] == "error"
    assert "срок исполнения" in issue["items"][0]["label"]
    assert "срок_исполнения" in issue["items"][0]["label"]


def test_finds_missing_identifiers_and_offers_a_fix(db):
    _healthy(db)
    db.rows[diagnostics.Q_MISSING_IDS] = [{"nodeId": ORDER, "kind": "Order", "label": "ПР-01"}]
    issue = next(i for i in diagnostics.collect()["issues"] if i["code"] == "missing_identifiers")
    assert issue["severity"] == "error"
    assert issue["fix"]["action"] == "repair_identifiers"
    assert "приказ" in issue["items"][0]["label"]


def test_finds_rules_without_target(db):
    _healthy(db)
    db.rows[diagnostics.Q_RULES_WITHOUT_TARGET] = [{"nodeId": RULE, "label": "R-1.1"}]
    issue = next(i for i in diagnostics.collect()["issues"] if i["code"] == "rules_without_target")
    assert issue["severity"] == "error"


def test_orphan_targets_are_only_a_warning(db):
    _healthy(db)
    db.rows[diagnostics.Q_TARGET_USAGE] = []
    report = diagnostics.collect()
    issue = next(i for i in report["issues"] if i["code"] == "orphan_check_targets")
    assert issue["severity"] == "warning"
    assert report["ready"] is True, "предупреждения не должны блокировать готовность"


def test_example_kind_mismatch(db):
    """Запрету нужны примеры нарушений, требованию — образцы. Иначе examples пуст."""
    _healthy(db)
    db.rows[diagnostics.Q_EXAMPLE_COVERAGE] = [
        {"nodeId": RULE, "label": "R-1.1", "type": "REQUIREMENT",
         "total": 2, "violating": 2, "correct": 0},
    ]
    issue = next(i for i in diagnostics.collect()["issues"] if i["code"] == "example_kind_mismatch")
    assert issue["severity"] == "warning"


def test_rules_without_examples_is_info(db):
    _healthy(db)
    db.rows[diagnostics.Q_EXAMPLE_COVERAGE] = [
        {"nodeId": RULE, "label": "R-1.1", "type": "REQUIREMENT",
         "total": 0, "violating": 0, "correct": 0},
    ]
    issue = next(i for i in diagnostics.collect()["issues"] if i["code"] == "rules_without_examples")
    assert issue["severity"] == "info"


def test_archived_targets_are_not_diagnosed(db):
    """Архивные узлы не участвуют в проверках, ругаться на них незачем."""
    _healthy(db)
    db.rows[diagnostics.Q_TARGETS].append(
        {"nodeId": TARGET_B, "name": "старый", "description": "", "status": "archived"}
    )
    assert "targets_without_description" not in codes(diagnostics.collect())


def test_problems_are_flat_strings_for_ready(db):
    db.rows[diagnostics.Q_TARGETS] = [
        {"nodeId": TARGET_B, "name": "измеримость", "description": "", "status": "active"}
    ]
    db.rows[diagnostics.Q_TARGET_USAGE] = [{"name": "измеримость", "rule_count": 1}]
    report = diagnostics.collect()
    assert report["problems"] and all(isinstance(p, str) for p in report["problems"])


# ------------------------------ подразделения -------------------------------


def _scope(rule="R-1.1", kind="EXCEPT_IN", department="УЦТ", department_status="active", node=RULE):
    return {"nodeId": node, "rule": rule, "kind": kind,
            "department": department, "departmentStatus": department_status}


def test_leftover_exceptions_are_a_warning(db):
    """Связи EXCEPT_IN проверка больше не учитывает — об оставшихся нужно сказать."""
    _healthy(db)
    db.rows[diagnostics.Q_RULE_SCOPE] = [_scope(), _scope(rule="R-2.4", kind="ONLY_IN")]
    report = diagnostics.collect()
    issue = next(i for i in report["issues"] if i["code"] == "legacy_exceptions")
    assert issue["severity"] == "warning"
    assert issue["items"] == [{"label": "R-1.1 — УЦТ", "nodeId": RULE, "kind": "Rule"}]
    assert report["ready"] is True


def test_rule_limited_to_archived_departments(db):
    _healthy(db)
    db.rows[diagnostics.Q_RULE_SCOPE] = [
        _scope(kind="ONLY_IN", department_status="archived"),
        _scope(rule="R-2.4", node="4:db:5", kind="ONLY_IN", department_status="archived"),
        _scope(rule="R-2.4", node="4:db:5", kind="ONLY_IN", department="АГД"),
    ]
    issue = next(i for i in diagnostics.collect()["issues"]
                 if i["code"] == "rules_only_in_archived_departments")
    assert [i["label"] for i in issue["items"]] == ["R-1.1"], "R-2.4 действует в АГД"


def test_department_without_id(db):
    _healthy(db)
    db.rows[diagnostics.Q_DEPARTMENTS_WITHOUT_ID] = [{"nodeId": "4:db:9", "label": "УЦТ"}]
    issue = next(i for i in diagnostics.collect()["issues"] if i["code"] == "departments_without_id")
    assert issue["items"][0]["kind"] == "Department"
    assert issue["fix"] is None, "идентификатор задаёт кадровая система, автопочинки нет"


def test_plain_scope_raises_no_issues(db):
    _healthy(db)
    db.rows[diagnostics.Q_RULE_SCOPE] = [
        _scope(kind="ONLY_IN"), _scope(rule="R-2.4", kind="ONLY_IN", department="АГД")]
    assert diagnostics.collect()["issues"] == []


def test_warns_about_departments_without_job_descriptions(db):
    _healthy(db)
    db.rows[diagnostics.Q_DEPARTMENTS_WITHOUT_JOB_DESCRIPTIONS] = [{"nodeId": "4:db:9", "label": "УЦТ"}]
    db.rows[diagnostics.Q_JOB_RULES] = [{"rule": "R-3.5"}]
    report = diagnostics.collect()
    issue = next(i for i in report["issues"] if i["code"] == "departments_without_job_descriptions")
    assert issue["severity"] == "warning" and "R-3.5" in issue["detail"]
    assert issue["items"] == [{"label": "УЦТ", "nodeId": "4:db:9", "kind": "Department"}]
    assert report["ready"] is True


def test_reports_job_descriptions_without_or_with_unreviewed_duties(db):
    _healthy(db)
    db.rows[diagnostics.Q_JOB_DUTIES] = [
        {"nodeId": "4:db:9", "label": "УЦТ — Аналитик", "duties": 0},
        {"nodeId": "4:db:9", "label": "УЦТ — Руководитель", "duties": 12},
    ]
    report = diagnostics.collect()
    by_code = {i["code"]: i for i in report["issues"]}
    assert by_code["job_descriptions_without_duties"]["severity"] == "warning"
    assert by_code["job_descriptions_without_duties"]["items"][0]["label"] == "УЦТ — Аналитик"
    assert by_code["job_duties_unreviewed"]["severity"] == "info"
    assert report["ready"] is True


def test_finds_rules_whose_targets_are_all_archived(db):
    """Архивный атрибут выпадает из словаря модели — правило молча не срабатывает."""
    _healthy(db)
    db.rows[diagnostics.Q_RULES_ONLY_ARCHIVED_TARGETS] = [{"nodeId": RULE, "label": "R-1.1"}]
    report = diagnostics.collect()
    issue = next(i for i in report["issues"] if i["code"] == "rules_with_archived_targets")
    assert issue["severity"] == "warning" and issue["items"][0]["nodeId"] == RULE
    assert report["ready"] is True


def test_finds_clauses_whose_rules_are_all_archived(db):
    _healthy(db)
    db.rows[diagnostics.Q_CLAUSES_ONLY_ARCHIVED_RULES] = [{"nodeId": "4:db:2", "label": "ПР-01 1.1"}]
    issue = next(i for i in diagnostics.collect()["issues"] if i["code"] == "clauses_with_archived_rules")
    assert issue["items"][0]["label"] == "ПР-01 1.1"


def test_archived_target_queries_check_status():
    assert "NOT EXISTS" in diagnostics.Q_RULES_ONLY_ARCHIVED_TARGETS
    assert "coalesce(t.status, 'active') = 'active'" in diagnostics.Q_RULES_ONLY_ARCHIVED_TARGETS
    assert "coalesce(r.status, 'active') = 'active'" in diagnostics.Q_CLAUSES_ONLY_ARCHIVED_RULES


def test_spelling_twins_offer_a_merge(db):
    db.rows[diagnostics.Q_TARGETS] = [
        {"nodeId": TARGET_A, "name": "срок исполнения", "description": "о", "status": "active"},
        {"nodeId": TARGET_B, "name": "срок_исполнения", "description": "о", "status": "active"},
    ]
    issue = next(i for i in diagnostics.collect()["issues"] if i["code"] == "duplicate_check_targets")
    assert issue["fix"]["action"] == "merge_duplicate_targets"


def test_pending_duties_are_not_reported_as_missing():
    assert "dutiesStatus" in diagnostics.Q_JOB_DUTIES and "'pending'" in diagnostics.Q_JOB_DUTIES
