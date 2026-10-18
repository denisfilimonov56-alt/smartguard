"""Тесты проверки примеров на модели. Neo4j и LLM подменяются."""

import pytest
from fastapi.testclient import TestClient

import agent
import auth
import examples_check
import graph
import main
import metrics

TARGETS = [
    {"name": "проект", "description": "назван проект", "source": None},
    {"name": "срок_исполнения", "description": "указан срок", "source": None},
    {"name": "обучение", "description": "цель — обучение", "source": None},
    {"name": "должностные_обязанности", "description": "дублирует обязанность",
     "source": graph.JOB_SOURCE},
]


def example(text, is_violation, rule_type="REQUIREMENT", targets=("проект",), job_targets=(), n=1):
    return {
        "nodeId": f"4:db:{n}", "example_id": f"EX-{n}", "text": text, "is_violation": is_violation,
        "rule_node_id": "4:db:100", "rule_id": "R-1.1", "rule_type": rule_type,
        "rule_text": "Цель обязана содержать упоминание проекта",
        "order_number": "ПР-01", "clause_code": "1.1",
        "targets": list(targets), "job_targets": list(job_targets),
    }


@pytest.fixture
def run(monkeypatch):
    """Прогон на подменённых графе и модели: run(примеры, {текст: атрибуты | исключение})."""
    asked: list[str] = []

    def go(rows, answers):
        def extract(text, targets, examples=None, holdout=False):
            asked.append(text)
            assert holdout is True, "проверяемый пример не должен попадать в свой же промпт"
            assert all(t.get("source") != graph.JOB_SOURCE for t in targets), \
                "«инструкционные» атрибуты в промпт извлечения не попадают"
            answer = answers[text]
            if isinstance(answer, Exception):
                raise answer
            return agent.Extraction(list(answer))

        monkeypatch.setattr(examples_check, "_examples", lambda: rows)
        monkeypatch.setattr(examples_check, "get_check_targets", lambda: TARGETS)
        monkeypatch.setattr(agent, "extract_attributes", extract)
        assert examples_check.start("tester") is True
        examples_check.wait(5)
        return examples_check.status()

    go.asked = asked
    yield go
    examples_check.reset()


# ------------------------------ ожидание ------------------------------------


@pytest.mark.parametrize("rule_type, is_violation, detected, outcome", [
    # Требование срабатывает, когда атрибута нет.
    ("REQUIREMENT", False, ["проект"], "matched"),
    ("REQUIREMENT", False, [], "mismatched"),
    ("REQUIREMENT", True, [], "matched"),
    ("REQUIREMENT", True, ["проект"], "mismatched"),
    # Запрет — когда атрибут есть.
    ("PROHIBITION", True, ["проект"], "matched"),
    ("PROHIBITION", True, [], "mismatched"),
    ("PROHIBITION", False, [], "matched"),
    ("PROHIBITION", False, ["проект"], "mismatched"),
])
def test_judge(rule_type, is_violation, detected, outcome):
    assert examples_check.judge(rule_type, is_violation, ["проект"], detected)["outcome"] == outcome


def test_judge_rule_with_several_targets():
    """Требованию нужны все атрибуты, запрету хватает одного."""
    both = ["проект", "срок_исполнения"]
    verdict = examples_check.judge("REQUIREMENT", False, both, ["проект"])
    assert verdict == {"outcome": "mismatched", "found": ["проект"], "missing": ["срок_исполнения"]}
    assert examples_check.judge("REQUIREMENT", True, both, ["проект"])["outcome"] == "matched"
    assert examples_check.judge("PROHIBITION", True, both, ["проект"])["outcome"] == "matched"
    assert examples_check.judge("PROHIBITION", False, both, ["проект"])["outcome"] == "mismatched"


# -------------------------------- прогон ------------------------------------


def test_run_reports_only_what_needs_attention(run):
    report = run(
        [example("В рамках проекта «Альфа» разработать API", False, n=1),
         example("Реализовать требования в системе 1С:KPI", True, n=2)],
        {"В рамках проекта «Альфа» разработать API": ["проект"],
         "Реализовать требования в системе 1С:KPI": ["проект"]},
    )
    assert report["state"] == "done"
    assert (report["total"], report["done"]) == (2, 2)
    assert report["counts"] == {"matched": 1, "mismatched": 1, "failed": 0, "skipped": 0}
    [item] = report["items"]
    assert item["nodeId"] == "4:db:2" and item["ruleNodeId"] == "4:db:100", "нужны nodeId для перехода"
    assert item["outcome"] == "mismatched" and item["found"] == ["проект"]
    assert report["startedBy"] == "tester" and report["finishedAt"]


def test_same_text_is_asked_once(run):
    report = run(
        [example("До 01.06.2025 запустить проект", False, n=1),
         example("До 01.06.2025 запустить проект", False, targets=("срок_исполнения",), n=2)],
        {"До 01.06.2025 запустить проект": ["проект", "срок_исполнения"]},
    )
    assert run.asked == ["До 01.06.2025 запустить проект"]
    assert report["counts"]["matched"] == 2 and report["done"] == 2


def test_job_description_and_orphan_rules_are_skipped(run):
    report = run(
        [example("Вести реестр договоров", True, "PROHIBITION",
                 targets=("должностные_обязанности",), job_targets=("должностные_обязанности",), n=1),
         example("Правило без атрибутов", True, targets=(), n=2)],
        {},
    )
    assert run.asked == []
    assert report["counts"]["skipped"] == 2
    assert "должностным инструкциям" in report["items"][0]["reason"]
    assert "нет действующих атрибутов" in report["items"][1]["reason"]


def test_model_failure_is_not_a_mismatch(run):
    report = run([example("Цель", False)], {"Цель": agent.ExtractionError("модель недоступна: timeout")})
    assert report["counts"] == {"matched": 0, "mismatched": 0, "failed": 1, "skipped": 0}
    assert report["items"][0]["reason"] == "модель недоступна: timeout"


def test_gives_up_when_model_is_down(run, monkeypatch):
    monkeypatch.setattr(agent, "BULK_MAX_WORKERS", 1)
    texts = [f"Цель {n}" for n in range(12)]
    report = run([example(t, False, n=n) for n, t in enumerate(texts)],
                 {t: agent.ExtractionError("модель недоступна") for t in texts})
    assert len(run.asked) == examples_check.GIVE_UP_AFTER
    assert report["counts"]["failed"] == 12
    assert "прогон остановлен" in report["items"][-1]["reason"]


def test_graph_failure_ends_the_run(monkeypatch):
    def broken():
        raise RuntimeError("Neo4j недоступен")

    monkeypatch.setattr(examples_check, "_examples", broken)
    examples_check.start("tester")
    examples_check.wait(5)
    report = examples_check.status()
    examples_check.reset()
    assert report["state"] == "failed" and "Neo4j недоступен" in report["error"]


def test_run_leaves_no_trace_in_checks(run):
    """Прогон не попадает ни в историю, ни в кэш, а пакет из мониторинга уходит."""
    records = []
    metrics.subscribe(records.append)
    try:
        run([example("Цель", False)], {"Цель": ["проект"]})
    finally:
        metrics._listeners.remove(records.append)
    assert records == []
    snapshot = metrics.snapshot()
    assert snapshot["checks"]["batches"] == [] and snapshot["cache"]["entries"] == 0


def test_result_goes_stale_after_catalog_change(run):
    assert run([example("Цель", False)], {"Цель": ["проект"]})["stale"] is False
    metrics.catalog_changed()
    assert examples_check.status()["stale"] is True


# ------------------------------- маршруты -----------------------------------


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    role = {"value": "editor"}
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("tester", role["value"])
    with TestClient(main.app, headers={"X-Requested-With": "XMLHttpRequest"}) as c:
        c.role = role
        yield c
    main.app.dependency_overrides.clear()
    examples_check.reset()


def test_routes(client, monkeypatch):
    monkeypatch.setattr(examples_check, "_examples", lambda: [example("Цель", False)])
    monkeypatch.setattr(examples_check, "get_check_targets", lambda: TARGETS)
    monkeypatch.setattr(agent, "extract_attributes", lambda text, targets, examples, holdout: agent.Extraction([]))

    assert client.get("/catalog/examples-check").json()["state"] == "idle"
    generation = metrics.results.generation
    response = client.post("/catalog/examples-check")
    assert response.status_code == 202
    examples_check.wait(5)
    report = client.get("/catalog/examples-check").json()
    assert report["state"] == "done" and report["counts"]["mismatched"] == 1
    assert "generation" not in report
    assert metrics.results.generation == generation, "прогон не должен сбрасывать кэш проверок"
    assert report["stale"] is False


def test_viewer_cannot_start(client):
    client.role["value"] = "viewer"
    assert client.get("/catalog/examples-check").status_code == 200
    assert client.post("/catalog/examples-check").status_code == 403
