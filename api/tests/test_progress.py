"""Ход проверки для интерфейса: шаги, токены и атрибуты (agent) и опрос по X-Check-Id (main).

Модель подменена клиентом, который отвечает потоком, как vLLM со stream=True:
куски текста, затем кусок с usage.
"""

import threading

import pytest
from fastapi.testclient import TestClient

import agent
import audit
import auth
import diagnostics
import graph
import main
import monitoring
import settings
from agent import STATUS_ALLOWED, STATUS_VIOLATIONS, BatchTrace, CheckTrace, check_goal, check_goals

TARGETS = [
    {"name": "срок_исполнения", "description": "указан конкретный срок"},
    {"name": "измеримость", "description": "есть числовой показатель"},
    {"name": "проект", "description": "назван проект"},
]
JOB_TARGET = {"name": "дублирование_обязанностей", "source": "job_descriptions",
              "description": "цель повторяет обязанность из должностной инструкции"}
JOB_DESCRIPTIONS = [
    {"id": "UCT/analyst", "title": "Аналитик", "text": "Готовит ежемесячный отчёт по заявкам."},
    {"id": "UCT/lead", "title": "Руководитель группы", "text": "Распределяет заявки."},
]
DEPARTMENTS = {"UCT": {"id": "UCT", "name": "УЦТ", "status": "active"}}
GOAL = "Подготовить отчёт по проекту Альфа до мая"
SMART_ANSWER = ('{' + ", ".join(f'"{key}": {{"score": 70, "comment": "ок"}}' for key in agent.SMART_KEYS) + '}')


def _chunk(text=None, usage=None):
    delta = type("Delta", (), {"content": text})
    choices = [type("Choice", (), {"delta": delta})] if text is not None else []
    return type("Chunk", (), {"choices": choices, "usage": usage})


def _usage(prompt, completion):
    return type("Usage", (), {"prompt_tokens": prompt, "completion_tokens": completion})


class _StreamingClient:
    """answer(kwargs) — куски ответа; с stream=True отдаёт их потоком и usage
    (100 токенов запроса, completion — по запросу), без потока — целиком.
    between(kwargs, номер) вызывается после каждого куска."""

    def __init__(self, answer, completion=9, between=None):
        self.calls = []
        lock = threading.Lock()

        def create(**kwargs):
            with lock:
                self.calls.append(kwargs)
            pieces = answer(kwargs)
            if not kwargs.get("stream"):
                message = type("Message", (), {"content": "".join(pieces)})
                return type("Response", (), {"choices": [type("Choice", (), {"message": message})]})

            def stream():
                for number, piece in enumerate(pieces):
                    yield _chunk(piece)
                    if between is not None:
                        between(kwargs, number)
                yield _chunk(usage=_usage(100, completion))
            return stream()

        self.chat = type("Chat", (), {"completions": type("C", (), {"create": staticmethod(create)})})


ATTRIBUTE_PIECES = ['{"attributes": [{"name": "проект", "quote": "проекту Альфа"}',
                    ', {"name": "срок_исполнения", "quote": "до мая"}', ']}']


@pytest.fixture
def text_check(monkeypatch):
    """Цель с атрибутами только по тексту: модель — потоком, SMART выключена, правило на «проект»."""
    monkeypatch.setattr(settings, "_read", lambda: {"smartCheck": False})
    monkeypatch.setattr(agent, "get_check_targets", lambda: TARGETS)
    monkeypatch.setattr(agent, "get_departments", lambda: DEPARTMENTS)
    monkeypatch.setattr(agent, "prompt_examples", lambda: {})
    monkeypatch.setattr(agent, "find_violations", lambda attrs, dept=None, student=None: [
        {"attribute": "проект", "violation_type": "FORBIDDEN", "rule_node_id": "r1"}] if "проект" in attrs else [])


# ------------------------------- разбор потока -------------------------------


def test_attributes_so_far_reads_unfinished_answer():
    assert agent.attributes_so_far('{"attributes": ["проект", "срок_исп') == ["проект"]
    assert agent.attributes_so_far('{"attributes": [{"name": "проект", "quote": "Аль{фа}"}, {"name": "ср') == [
        {"name": "проект", "quote": "Аль{фа}"}]
    assert agent.attributes_so_far('{"attrib') == []


# ------------------------------ ход одной цели ------------------------------


def test_check_reports_stages_tokens_and_attributes_while_streaming(monkeypatch, text_check):
    trace = CheckTrace()
    during = []
    client = _StreamingClient(lambda kwargs: ATTRIBUTE_PIECES,
                              between=lambda kwargs, number: number == 0 and during.append(trace.view()))
    monkeypatch.setattr(agent, "get_client", lambda: client)

    with agent.tracing(trace):
        result = check_goal(GOAL, department_id="UCT", is_student=False)
    trace.finish(result)

    assert client.calls[0]["stream"] is True
    assert client.calls[0]["stream_options"] == {"include_usage": True}
    mid = {s["key"]: s for s in during[0]["stages"]}
    assert during[0]["attributes"] == [{"name": "проект", "quote": "проекту Альфа"}]
    assert mid["cache"]["status"] == "done" and mid["cache"]["detail"] == "нет — проверяем заново"
    assert mid["queue"]["status"] == "done" and mid["queue"]["detail"] == "место получено"
    assert mid["attributes"]["status"] == "running" and mid["attributes"]["tokens"] == 1
    assert mid["jobs"] == {"key": "jobs", "status": "skipped", "seconds": None,
                           "detail": "в каталоге нет правил по инструкциям", "tokens": None}
    assert mid["smart"]["status"] == "skipped" and mid["smart"]["detail"] == "выключена в настройках"
    assert mid["rules"]["status"] == "waiting"

    view = trace.view()
    stages = {s["key"]: s for s in view["stages"]}
    assert [s["key"] for s in view["stages"]] == list(agent.CHECK_STAGES)
    assert stages["attributes"]["detail"] == "найдено 2 из 3" and stages["attributes"]["tokens"] == 9
    assert stages["rules"]["status"] == "done" and stages["rules"]["detail"] == "нарушений: 1"
    assert all(s["seconds"] is not None for s in view["stages"] if s["status"] == "done")
    assert view["tokens"] == {"prompt": 100, "completion": 9}
    assert view["attributes"] == [{"name": "проект", "quote": "проекту Альфа"},
                                  {"name": "срок_исполнения", "quote": "до мая"}]
    assert trace.verdict == STATUS_VIOLATIONS and not trace.cached


def test_check_without_trace_is_not_streamed(monkeypatch, text_check):
    """Внешней системе и пакету без X-Check-Id запрос к модели — прежний, без потока."""
    client = _StreamingClient(lambda kwargs: ATTRIBUTE_PIECES)
    monkeypatch.setattr(agent, "get_client", lambda: client)
    assert check_goal(GOAL, department_id="UCT", is_student=False)["status"] == STATUS_VIOLATIONS
    assert "stream" not in client.calls[0] and "stream_options" not in client.calls[0]


def test_cached_answer_skips_model_stages(monkeypatch, text_check):
    monkeypatch.setattr(agent, "get_client", lambda: _StreamingClient(lambda kwargs: ATTRIBUTE_PIECES))
    check_goal(GOAL, department_id="UCT", is_student=False)
    trace = CheckTrace()
    with agent.tracing(trace):
        result = check_goal(GOAL, department_id="UCT", is_student=False)
    trace.finish(result)
    stages = {s["key"]: s for s in trace.view()["stages"]}
    assert stages["cache"]["status"] == "done" and stages["cache"]["detail"] == "ответ из кэша"
    assert all(stages[k]["status"] == "skipped" and stages[k]["detail"] == "ответ из кэша"
               for k in agent.CHECK_STAGES[1:])
    assert trace.cached and trace.verdict == STATUS_VIOLATIONS
    assert trace.view()["tokens"] == {"prompt": 0, "completion": 0}


def test_jobs_and_smart_report_from_their_own_threads(monkeypatch):
    """Сравнение с инструкциями и SMART идут в побочных потоках — ход и токены доходят и оттуда."""
    monkeypatch.setattr(agent, "get_check_targets", lambda: [JOB_TARGET])
    monkeypatch.setattr(agent, "get_departments", lambda: DEPARTMENTS)
    monkeypatch.setattr(agent, "get_job_rules", lambda names, dept=None, student=None: [
        {"attribute": JOB_TARGET["name"], "rule_id": "R-3.5"}])
    monkeypatch.setattr(agent, "get_job_descriptions", lambda dept: JOB_DESCRIPTIONS)
    monkeypatch.setattr(agent, "find_violations", lambda attrs, dept=None, student=None: [])

    def answer(kwargs):
        if "SMART" in kwargs["messages"][0]["content"]:
            return [SMART_ANSWER]
        return ['{"present": true, "matches": [{"instruction": 1, ', '"duty": "Готовит ежемесячный отчёт"}]}']

    monkeypatch.setattr(agent, "get_client", lambda: _StreamingClient(answer, completion=12))
    trace = CheckTrace()
    with agent.tracing(trace):
        result = check_goal("Готовить ежемесячный отчёт", department_id="UCT", is_student=False)
    trace.finish(result)

    view = trace.view()
    stages = {s["key"]: s for s in view["stages"]}
    assert stages["attributes"]["status"] == "skipped"
    assert stages["jobs"]["status"] == "done" and stages["jobs"]["detail"] == "есть совпадение с обязанностью"
    assert stages["jobs"]["tokens"] == 12
    assert stages["smart"]["status"] == "done" and stages["smart"]["detail"] == "готово"
    assert stages["smart"]["tokens"] == 12
    assert view["tokens"] == {"prompt": 200, "completion": 24}
    assert view["matchedDuties"] == ["Готовит ежемесячный отчёт"]
    assert view["attributes"] == [{"name": JOB_TARGET["name"], "quote": None}]


def test_jobs_stage_says_why_it_is_skipped(monkeypatch):
    monkeypatch.setattr(settings, "_read", lambda: {"smartCheck": False})
    monkeypatch.setattr(agent, "get_check_targets", lambda: [JOB_TARGET])
    monkeypatch.setattr(agent, "get_departments", lambda: DEPARTMENTS)
    monkeypatch.setattr(agent, "get_job_rules", lambda names, dept=None, student=None: [
        {"attribute": JOB_TARGET["name"], "rule_id": "R-3.5"}])
    monkeypatch.setattr(agent, "get_job_descriptions", lambda dept: [])
    monkeypatch.setattr(agent, "find_violations", lambda attrs, dept=None, student=None: [])
    trace = CheckTrace()
    with agent.tracing(trace):
        trace.finish(check_goal("цель", department_id="UCT", is_student=False))
    jobs = next(s for s in trace.view()["stages"] if s["key"] == "jobs")
    assert jobs["status"] == "skipped" and jobs["detail"] == "у подразделения нет инструкций"


def test_trace_finish_closes_stages_and_freezes():
    trace = CheckTrace()
    trace.begin("attributes", "модель ищет атрибутов: 3")
    trace.queue_wait()
    trace.queue_got(got=False)
    trace.finish()
    stages = {s["key"]: s for s in trace.view()["stages"]}
    assert stages["queue"]["status"] == "done" and stages["queue"]["detail"] == "место не получено"
    assert stages["attributes"]["status"] == "skipped" and stages["attributes"]["detail"] == agent.STAGE_DROPPED
    assert stages["rules"]["status"] == "skipped" and stages["rules"]["detail"] == agent.STAGE_UNUSED
    elapsed = trace.view()["elapsedSeconds"]
    trace.end("rules", "нарушений: 0")
    trace.found([("проект", None)])
    assert trace.view()["stages"] == list(stages.values()) and trace.view()["attributes"] == []
    assert trace.view()["elapsedSeconds"] == elapsed


def test_queue_waits_until_every_request_has_a_place():
    trace = CheckTrace()
    trace.queue_wait()
    trace.queue_wait()
    trace.queue_got()
    assert trace.view()["stages"][1]["status"] == "running"
    trace.queue_got()
    assert trace.view()["stages"][1]["status"] == "done"


# ---------------------------------- пакет -----------------------------------


@pytest.fixture
def bulk(monkeypatch):
    monkeypatch.setattr(settings, "_read", lambda: {"smartCheck": False})
    monkeypatch.setattr(agent, "get_check_targets", lambda: TARGETS)
    monkeypatch.setattr(agent, "get_departments", lambda: DEPARTMENTS)
    monkeypatch.setattr(agent, "extract_attributes",
                        lambda g, t, *a: agent.Extraction(["проект"] if "проект" in g else []))
    monkeypatch.setattr(agent, "find_violations",
                        lambda attrs, dept=None, student=None: [] if "проект" in attrs else [{"attribute": "проект"}])


def test_batch_reports_each_goal(bulk):
    items = [{"goal": "в рамках проекта Альфа", "id": "1", "department_id": "UCT"},
             {"goal": "в рамках проекта Альфа", "id": "2", "department_id": "UCT"},
             {"goal": "просто сделать", "id": "3", "department_id": "UCT"}]
    trace = BatchTrace(len(items))
    before = trace.view()
    assert before["done"] == 0 and [i["status"] for i in before["items"]] == ["queued"] * 3

    with agent.tracing_batch(trace):
        check_goals(items)
    trace.finish()

    view = trace.view()
    assert view["total"] == 3 and view["done"] == 3
    by_index = {i["index"]: i for i in view["items"]}
    assert by_index[0]["verdict"] == STATUS_ALLOWED and not by_index[0]["cached"]
    assert by_index[1]["verdict"] == STATUS_ALLOWED and by_index[1]["cached"], "двойник — ответ ведущей цели"
    assert by_index[2]["verdict"] == STATUS_VIOLATIONS
    assert all(i["status"] == "done" and i["stage"] is None and i["seconds"] is not None for i in view["items"])
    assert view["stageSeconds"]["rules"]["count"] == 2, "время шагов — без ответов из кэша"
    assert set(view["stageSeconds"]) <= set(agent.CHECK_STAGES)


def test_stopped_batch_has_no_verdicts(bulk):
    stop = threading.Event()
    stop.set()
    trace = BatchTrace(2)
    with agent.tracing_batch(trace):
        check_goals([{"goal": "а", "department_id": "UCT"}, {"goal": "б", "department_id": "UCT"}], cancel=stop)
    view = trace.view()
    assert view["done"] == 2 and all(i["verdict"] is None and not i["cached"] for i in view["items"])


# ------------------------------------ API ------------------------------------

RESULT = {"goal": "цель", "status": STATUS_ALLOWED, "allowed": True, "detected_attributes": ["проект"],
          "attribute_quotes": {"проект": "проект"}, "violations": [], "notes": []}
CHECK_ID = "3f2b6c1e-9a4d-4e8b-b1f0-0c5d7a9e2f11"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    monkeypatch.setattr(diagnostics, "collect", lambda: {"issues": [], "ready": True, "problems": []})
    monkeypatch.setattr(monitoring, "vllm_alive", lambda timeout=2: True)
    monkeypatch.setattr(main, "_progress", {})
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("tester", "editor")
    with TestClient(main.app, headers={"X-Requested-With": "XMLHttpRequest"}) as c:
        yield c
    main.app.dependency_overrides.clear()


def _signed_in(login, role="viewer"):
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal(login, role)


def _fake_check(monkeypatch, started=None, release=None):
    def fake(goal, department_id=None, is_student=None):
        trace = agent._progress()
        trace.begin("cache", "ищем такую же цель среди недавних")
        trace.end("cache", "нет — проверяем заново")
        trace.begin("attributes", "модель ищет атрибутов: 3")
        if started is not None:
            started.set()
            assert release.wait(5)
        return dict(RESULT)

    monkeypatch.setattr(main, "check_goal", fake)


def test_check_progress_is_polled_while_check_runs(client, monkeypatch):
    started, release = threading.Event(), threading.Event()
    _fake_check(monkeypatch, started, release)
    answer = {}
    worker = threading.Thread(target=lambda: answer.setdefault("response", client.post(
        "/check-goal", json={"goal": "цель", "department_id": "UCT"}, headers={"X-Check-Id": CHECK_ID})))
    worker.start()
    try:
        assert started.wait(5)
        running = client.get(f"/check-progress/{CHECK_ID}")
        assert running.status_code == 200
        stages = {s["key"]: s for s in running.json()["stages"]}
        assert stages["cache"]["status"] == "done" and stages["attributes"]["status"] == "running"
    finally:
        release.set()
        worker.join(5)

    assert answer["response"].json() == RESULT, "ответ /check-goal тот же, что без хода"
    final = client.get(f"/check-progress/{CHECK_ID}").json()
    assert set(final) == {"elapsedSeconds", "stages", "tokens", "tokensPerSecond", "attributes", "matchedDuties"}
    assert final["attributes"] == [{"name": "проект", "quote": "проект"}]
    assert {s["key"]: s["status"] for s in final["stages"]}["attributes"] == "skipped"


def test_progress_of_another_user_is_not_found(client, monkeypatch):
    _fake_check(monkeypatch)
    client.post("/check-goal", json={"goal": "цель", "department_id": "UCT"}, headers={"X-Check-Id": CHECK_ID})
    assert client.get(f"/check-progress/{CHECK_ID}").status_code == 200
    _signed_in("other")
    response = client.get(f"/check-progress/{CHECK_ID}")
    assert response.status_code == 404 and response.json()["detail"] == "Проверка не найдена"
    # Тем же номером чужой ход не подменить: проверка идёт, но без хода.
    client.post("/check-goal", json={"goal": "цель", "department_id": "UCT"}, headers={"X-Check-Id": CHECK_ID})
    assert client.get(f"/check-progress/{CHECK_ID}").status_code == 404


def test_progress_is_only_for_signed_in_users(client, monkeypatch):
    """Внешней системе с ключом ход не пишется и не отдаётся."""
    _fake_check(monkeypatch)
    _signed_in("key:erp", auth.SERVICE_ROLE)
    response = client.post("/check-goal", json={"goal": "цель", "department_id": "UCT"},
                           headers={"X-Check-Id": CHECK_ID})
    assert response.json() == RESULT and main._progress == {}
    assert client.get(f"/check-progress/{CHECK_ID}").status_code == 403


@pytest.mark.parametrize("check_id", ["short", "x" * 65, "id with spaces", "..%2F..%2Fetc"])
def test_malformed_check_id_is_ignored(client, monkeypatch, check_id):
    _fake_check(monkeypatch)
    assert client.post("/check-goal", json={"goal": "цель", "department_id": "UCT"},
                       headers={"X-Check-Id": check_id}).json() == RESULT
    assert main._progress == {}


def test_check_without_header_has_no_progress(client, monkeypatch):
    _fake_check(monkeypatch)
    client.post("/check-goal", json={"goal": "цель", "department_id": "UCT"})
    assert main._progress == {}
    assert client.get(f"/check-progress/{CHECK_ID}").status_code == 404


def test_finished_progress_is_forgotten_and_memory_is_bounded(client, monkeypatch):
    _fake_check(monkeypatch)

    def post(check_id):
        client.post("/check-goal", json={"goal": "цель", "department_id": "UCT"}, headers={"X-Check-Id": check_id})

    monkeypatch.setattr(main, "PROGRESS_KEEP_SECONDS", -1.0)
    post("first-check-id")
    post("second-check-id")
    assert set(main._progress) == {("check", "second-check-id")}, "законченный ход удалён после срока"

    monkeypatch.setattr(main, "PROGRESS_KEEP_SECONDS", 60.0)
    monkeypatch.setattr(main, "PROGRESS_MAX", 1)
    post("third-check-id")
    assert set(main._progress) == {("check", "second-check-id")}, "сверх предела — проверка без хода"


def test_failed_check_still_finishes_its_progress(client, monkeypatch):
    def boom(goal, department_id=None, is_student=None):
        agent._progress().begin("cache", "ищем")
        raise RuntimeError("сбой")

    monkeypatch.setattr(main, "check_goal", boom)
    with pytest.raises(RuntimeError):
        client.post("/check-goal", json={"goal": "цель", "department_id": "UCT"}, headers={"X-Check-Id": CHECK_ID})
    trace = main._progress[("check", CHECK_ID)][1]
    assert trace.finished is not None and trace.verdict is None


def test_batch_progress(client, monkeypatch, bulk):
    response = client.post("/check-goals", headers={"X-Check-Id": CHECK_ID}, json=[
        {"goal": "в рамках проекта Альфа", "id": "1", "department_id": "UCT"},
        {"goal": "просто сделать", "id": "2", "department_id": "UCT"}])
    assert set(response.json()) == {"results", "summary"}
    progress = client.get(f"/batch-progress/{CHECK_ID}").json()
    assert set(progress) == {"elapsedSeconds", "total", "done", "tokens", "tokensPerSecond", "stageSeconds", "items"}
    assert progress["total"] == progress["done"] == 2
    assert [i["verdict"] for i in progress["items"]] == [STATUS_ALLOWED, STATUS_VIOLATIONS]
    # Ход пакета и ход одной цели — разные номера: один по другому не найти.
    assert client.get(f"/check-progress/{CHECK_ID}").status_code == 404
    assert client.get("/batch-progress/unknown-check").json()["detail"] == "Пакет не найден"


def test_progress_polls_are_not_audited(client, monkeypatch):
    _fake_check(monkeypatch)
    client.post("/check-goal", json={"goal": "цель", "department_id": "UCT"}, headers={"X-Check-Id": CHECK_ID})
    events = []
    monkeypatch.setattr(audit, "event", lambda kind, **fields: events.append(fields.get("path")))
    assert client.get(f"/check-progress/{CHECK_ID}").status_code == 200
    assert events == []
