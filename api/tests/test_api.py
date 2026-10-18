"""Тесты HTTP-слоя. Neo4j и LLM подменяются, живые сервисы не нужны."""

import pytest
from fastapi.testclient import TestClient

import auth
import catalog
import diagnostics
import graph
import main
import metrics
import monitoring

HEALTHY = {
    "issues": [], "counts": {"error": 0, "warning": 0, "info": 0},
    "check_targets": 3, "ready": True, "problems": [],
}
BROKEN = {
    "issues": [{"code": "targets_without_description", "severity": "error",
                "title": "Атрибуты без описания", "detail": "…",
                "items": [{"label": "проект", "nodeId": "4:db:8", "kind": "CheckTarget"}],
                "fix": None}],
    "counts": {"error": 1, "warning": 0, "info": 0},
    "check_targets": 3, "ready": False,
    "problems": ["Атрибуты без описания: проект"],
}


@pytest.fixture
def client(monkeypatch):
    """Клиент вошедшего администратора: здесь проверяются сами маршруты.

    Вход, роли и отказы без сессии — в test_auth.py.
    """
    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    monkeypatch.setattr(diagnostics, "collect", lambda: HEALTHY)
    monkeypatch.setattr(monitoring, "vllm_alive", lambda timeout=2: True)
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("tester", "admin")
    with TestClient(main.app, headers={"X-Requested-With": "XMLHttpRequest"}) as c:
        yield c
    main.app.dependency_overrides.clear()


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_health_and_ready_do_not_need_the_route_thread_pool():
    """Пока все потоки синхронных маршрутов ждут модель, /health и /ready отвечают (H3)."""
    import inspect
    assert inspect.iscoroutinefunction(main.health) and inspect.iscoroutinefunction(main.ready)


def test_ready_ok(client):
    body = client.get("/ready").json()
    assert body["status"] == "ready"
    assert body["problems"] == [] and body["llm"] is True


def test_ready_503_on_errors(monkeypatch):
    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    monkeypatch.setattr(diagnostics, "collect", lambda: BROKEN)
    monkeypatch.setattr(monitoring, "vllm_alive", lambda timeout=2: True)
    with TestClient(main.app) as c:
        response = c.get("/ready")
    assert response.status_code == 503
    assert "Атрибуты без описания" in response.json()["problems"][0]


def test_ready_503_when_neo4j_down(monkeypatch):
    monkeypatch.setattr(graph, "verify_connectivity", lambda: False)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    monkeypatch.setattr(monitoring, "vllm_alive", lambda timeout=2: True)
    with TestClient(main.app) as c:
        response = c.get("/ready")
    assert response.status_code == 503
    assert response.json()["neo4j"] is False


def test_ready_503_when_llm_down(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(monitoring, "vllm_alive", lambda timeout=2: seen.setdefault("timeout", timeout) and False)
    response = client.get("/ready")
    assert response.status_code == 503
    body = response.json()
    assert body["llm"] is False and body["neo4j"] is True
    assert any("vLLM" in p for p in body["problems"])
    assert seen["timeout"] == 2


def test_vllm_alive_asks_health_with_timeout(monkeypatch):
    seen = {}

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def urlopen(url, timeout):
        seen.update(url=url, timeout=timeout)
        return Response()

    monkeypatch.setenv("VLLM_URL", "http://vllm:8000/v1")
    monkeypatch.setattr(monitoring.urllib.request, "urlopen", urlopen)
    assert monitoring.vllm_alive(2) is True
    assert seen == {"url": "http://vllm:8000/health", "timeout": 2}

    def down(url, timeout):
        raise OSError("connection refused")

    monkeypatch.setattr(monitoring.urllib.request, "urlopen", down)
    assert monitoring.vllm_alive(2) is False


def test_queue_timeout_is_503_with_retry_after(client, monkeypatch):
    """Очередь к модели не подошла — 503 с Retry-After через настоящую check_goal (E5)."""
    import agent
    monkeypatch.setattr(agent, "get_check_targets", lambda: [{"name": "срок", "description": "есть срок"}])
    monkeypatch.setattr(agent.settings, "_read", lambda: {"smartCheck": False})
    monkeypatch.setattr(metrics.gate, "acquire", lambda bulk, timeout=None: (_ for _ in ()).throw(
        metrics.QueueTimeout(120)))
    response = client.post("/check-goal", json={"goal": "цель"})
    assert response.status_code == 503 and response.headers["Retry-After"] == "30"
    assert "перегружена" in response.json()["detail"]


def test_concurrent_batches_are_limited(client, monkeypatch):
    """Сверх BULK_MAX_REQUESTS одновременных пакетов — сразу 503, поток API не занимается (E2)."""
    import threading
    monkeypatch.setattr(main, "_bulk_requests", threading.BoundedSemaphore(1))
    assert main._bulk_requests.acquire(blocking=False)  # один пакет уже идёт
    try:
        response = client.post("/check-goals", json=[{"goal": "цель", "department_id": "UCT"}])
        assert response.status_code == 503 and response.headers["Retry-After"] == "30"
    finally:
        main._bulk_requests.release()
    monkeypatch.setattr(main, "check_goals", lambda items: {"results": [], "summary": {}})
    assert client.post("/check-goals", json=[{"goal": "цель", "department_id": "UCT"}]).status_code == 200
    assert main._bulk_requests.acquire(blocking=False), "место освобождается и после ответа"
    main._bulk_requests.release()


def test_thread_limit_follows_model_capacity_setting(monkeypatch):
    """Правка llmMaxConcurrency в «Настройках» поднимает предел потоков без перезапуска (E2)."""
    import anyio.to_thread

    import settings
    monkeypatch.setattr(graph, "verify_connectivity", lambda: False)
    monkeypatch.delenv("API_THREADS", raising=False)
    capacity = {"value": 32}
    monkeypatch.setattr(settings, "_read", lambda: {"llmMaxConcurrency": capacity["value"]})

    async def tokens():
        return anyio.to_thread.current_default_thread_limiter().total_tokens

    with TestClient(main.app) as c:
        before = c.portal.call(tokens)
        capacity["value"] = 200
        settings.forget()
        metrics.lookups.clear()
        metrics.gate.reconfigure()  # так делает settings.update
        assert c.portal.call(tokens) == max(before, main._thread_limit()) > before


def test_check_resets_actor_after_request(client, monkeypatch):
    """Поток пула переиспользуется: логин прошлой проверки не достаётся следующему запросу (L29)."""
    seen = {}
    monkeypatch.setattr(main, "check_goal", lambda goal, department_id=None, is_student=None:
                        seen.setdefault("actor", metrics.actor()) and {"status": "ALLOWED"})
    client.post("/check-goal", json={"goal": "цель"})
    assert seen["actor"] == "tester"
    assert metrics.actor() is None


def test_thread_limit_counts_model_capacity(monkeypatch):
    monkeypatch.delenv("API_THREADS", raising=False)
    assert main._thread_limit() == 40 + 2 * 32 + main.BULK_MAX_WORKERS + main.BULK_MAX_REQUESTS
    monkeypatch.setenv("API_THREADS", "300")
    assert main._thread_limit() == 300
    monkeypatch.setenv("API_THREADS", "5")
    assert main._thread_limit() == 40, "меньше стандартного пула не опускаемся"


def test_lifespan_raises_thread_limit_and_recovers_pending_duties(monkeypatch):
    import anyio.to_thread

    import routes
    calls = []
    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    monkeypatch.setattr(routes, "recover_duties_jobs", lambda: calls.append("recover") or 0)
    monkeypatch.setattr(main, "_thread_limit", lambda: 123)

    async def tokens():
        return anyio.to_thread.current_default_thread_limiter().total_tokens

    with TestClient(main.app) as c:
        assert c.portal.call(tokens) == 123
    assert calls == ["recover"]


def test_advice_goal_and_reason_stay_out_of_audit(client, monkeypatch, caplog):
    """В журнал аудита из запроса советчику идут атрибут, ожидание и подразделение (L17)."""
    import advisor
    from fastapi import Request

    def signed_in(request: Request):
        # Как настоящий auth.current_user: тело пишется в журнал только у вошедших.
        request.state.user = auth.Principal("tester", "editor")
        return request.state.user

    monkeypatch.setattr(advisor, "advise", lambda *a, **k: {"ok": True})
    monkeypatch.setitem(main.app.dependency_overrides, auth.current_user, signed_in)
    with caplog.at_level("INFO", logger="audit"):
        client.post("/catalog/advice", json={
            "goal": "секретная цель", "attribute": "срок", "expected": True,
            "reason": "личное обоснование", "department_id": "UCT"})
    logged = " ".join(r.getMessage() for r in caplog.records if r.name == "audit")
    assert "/catalog/advice" in logged
    assert "секретная цель" not in logged and "личное обоснование" not in logged
    assert "срок" in logged and "UCT" in logged


def test_anonymous_request_body_stays_out_of_audit(client, caplog):
    """Без входа тело и длинная строка запроса в журнал не идут: его нельзя раздуть анонимно."""
    with caplog.at_level("INFO", logger="audit"):
        client.post("/catalog/orders?q=" + "x" * 6000, json={"number": "y" * 5000})
    logged = " ".join(r.getMessage() for r in caplog.records if r.name == "audit")
    assert "yyyy" not in logged
    assert len(logged) < 1000


def test_diagnostics_endpoint(client):
    assert client.get("/catalog/diagnostics").json() == HEALTHY


# ---------------------------- маршруты каталога -----------------------------


def test_tree_passes_archive_flag(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(catalog, "build_tree",
                        lambda inc: seen.setdefault("inc", inc) or {"orders": []})
    client.get("/catalog/tree?include_archived=true")
    assert seen["inc"] is True


def test_node_not_found_maps_to_404(client, monkeypatch):
    def boom(*a, **k):
        raise catalog.NotFound("Узел не найден")

    monkeypatch.setattr(catalog, "get_node", boom)
    response = client.get("/catalog/nodes/4:db:404")
    assert response.status_code == 404
    assert "не найден" in response.json()["detail"]


def test_conflict_maps_to_409(client, monkeypatch):
    def boom(*a, **k):
        raise catalog.Conflict("Удалять можно только архивированный приказ.")

    monkeypatch.setattr(catalog, "delete_node", boom)
    response = client.request("DELETE", "/catalog/nodes/4:db:1")
    assert response.status_code == 409
    assert "архивированный" in response.json()["detail"]


def test_properties_patch_passes_nulls(client, monkeypatch):
    """null должен доезжать до слоя данных: это удаление свойства."""
    seen = {}
    monkeypatch.setattr(catalog, "update_properties",
                        lambda node_id, props: seen.setdefault("props", props) or {"ok": True})
    client.patch("/catalog/nodes/4:db:1/properties",
                 json={"properties": {"подписал": None, "title": "новый"}})
    assert seen["props"] == {"подписал": None, "title": "новый"}


def test_rule_type_is_validated_by_schema(client):
    response = client.post("/catalog/rules", json={
        "clauseNodeId": "4:db:2", "type": "OBLIGATION", "description": "x"})
    assert response.status_code == 422


def test_create_rule_passes_students_only(client, monkeypatch):
    seen = {}

    def create(clause_node_id, rule_type, description, check_instruction="", targets=None,
               rule_id=None, students_only=False, only=None):
        seen["students_only"] = students_only
        return {"nodeId": "4:db:9"}

    monkeypatch.setattr(catalog, "create_rule", create)
    assert client.post("/catalog/rules", json={
        "clauseNodeId": "4:db:2", "type": "REQUIREMENT", "description": "x"}).status_code == 201
    assert seen["students_only"] is False, "по умолчанию правило для всех"
    client.post("/catalog/rules", json={
        "clauseNodeId": "4:db:2", "type": "REQUIREMENT", "description": "x", "studentsOnly": True})
    assert seen["students_only"] is True


def test_status_value_is_validated_by_schema(client):
    response = client.post("/catalog/nodes/4:db:1/status", json={"status": "deleted"})
    assert response.status_code == 422


def test_repair_identifiers(client, monkeypatch):
    monkeypatch.setattr(catalog, "repair_identifiers",
                        lambda: {"orders": 1, "clauses": 2, "rules": 0,
                                 "examples": 0, "statuses": 3})
    assert client.post("/catalog/repair-identifiers").json()["clauses"] == 2


def test_check_goal_passes_through(client, monkeypatch):
    monkeypatch.setattr(main, "check_goal", lambda goal, department_id=None, is_student=None: {
        "goal": goal, "status": "ALLOWED", "allowed": True, "seen_department": department_id})
    response = client.post("/check-goal", json={"goal": "цель"})
    assert response.status_code == 200
    assert response.json()["allowed"] is True
    assert response.json()["seen_department"] is None, "в одиночной проверке подразделение необязательно"


def test_check_goal_passes_department(client, monkeypatch):
    monkeypatch.setattr(main, "check_goal",
                        lambda goal, department_id=None, is_student=None: {"seen_department": department_id})
    response = client.post("/check-goal", json={"goal": "цель", "department_id": "UCT"})
    assert response.json()["seen_department"] == "UCT"


def test_check_goal_requires_goal_field(client):
    assert client.post("/check-goal", json={}).status_code == 422


@pytest.mark.parametrize("payload,expected", [
    ({"goal": "цель"}, None),
    ({"goal": "цель", "is_student": True}, True),
    ({"goal": "цель", "is_student": False}, False),
])
def test_check_goal_passes_student_flag(client, monkeypatch, payload, expected):
    monkeypatch.setattr(main, "check_goal",
                        lambda goal, department_id=None, is_student=None: {"seen_student": is_student})
    assert client.post("/check-goal", json=payload).json()["seen_student"] is expected


def test_check_goal_rejects_non_boolean_student_flag(client):
    assert client.post("/check-goal", json={"goal": "цель", "is_student": "студент"}).status_code == 422


# --------------------------- пакетная проверка ------------------------------


def test_check_goals_accepts_array(client, monkeypatch):
    monkeypatch.setattr(main, "check_goals", lambda items: {
        "results": [{"id": i["id"], "goal": i["goal"], "status": "ALLOWED", "allowed": True}
                    for i in items],
        "summary": {"total": len(items), "allowed": len(items),
                    "violations": 0, "manual_review": 0},
    })
    response = client.post("/check-goals", json=[
        {"goal": "первая", "id": "g-1", "department_id": "UCT"},
        {"goal": "вторая", "id": "g-2", "department_id": "AGD"}])
    assert response.status_code == 200
    assert [r["id"] for r in response.json()["results"]] == ["g-1", "g-2"]
    assert response.json()["summary"]["total"] == 2


def test_check_goals_accepts_numeric_ids_and_returns_them_as_strings(client, monkeypatch):
    """Кадровая система шлёт числовые id и department_id — пакет не отклоняется, id в ответе строкой (L90)."""
    seen = {}

    def check(items):
        seen["items"] = items
        return {"results": [{"id": i["id"], "goal": i["goal"], "status": "ALLOWED", "allowed": True}
                            for i in items],
                "summary": {"total": len(items), "allowed": len(items), "violations": 0, "manual_review": 0}}

    monkeypatch.setattr(main, "check_goals", check)
    response = client.post("/check-goals", json=[
        {"goal": "первая", "id": 101, "department_id": 7},
        {"goal": "вторая", "id": "g-2", "department_id": "AGD"}])
    assert response.status_code == 200
    assert [r["id"] for r in response.json()["results"]] == ["101", "g-2"]
    assert [i["department_id"] for i in seen["items"]] == ["7", "AGD"]


def test_check_goals_id_is_optional(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(main, "check_goals",
                        lambda items: seen.setdefault("items", items) or {"results": [], "summary": {}})
    client.post("/check-goals", json=[{"goal": "без id", "department_id": "UCT"}])
    assert seen["items"] == [{"goal": "без id", "department_id": "UCT", "is_student": None, "id": None}]


def test_check_goals_passes_student_flag(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(main, "check_goals",
                        lambda items: seen.setdefault("items", items) or {"results": [], "summary": {}})
    client.post("/check-goals", json=[{"goal": "студент", "department_id": "UCT", "is_student": True}])
    assert seen["items"][0]["is_student"] is True


@pytest.mark.parametrize("item", [{"goal": "цель"}, {"goal": "цель", "department_id": ""}])
def test_check_goals_requires_department(client, item):
    """В пакете подразделение обязательно: кадровая система его знает."""
    response = client.post("/check-goals", json=[item])
    assert response.status_code == 422
    assert "department_id" in response.text


def test_check_goals_rejects_empty_goal(client):
    response = client.post("/check-goals", json=[{"goal": "", "id": "x", "department_id": "UCT"}])
    assert response.status_code == 422


def test_check_goals_rejects_oversized_batch(client, monkeypatch):
    monkeypatch.setattr(main, "MAX_BATCH", 2)
    response = client.post("/check-goals", json=[{"goal": f"ц{i}", "department_id": "UCT"} for i in range(3)])
    assert response.status_code == 413
    assert "не более 2" in response.json()["detail"]


def test_delete_passes_force_flag(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(catalog, "delete_node",
                        lambda node_id, cascade, force: seen.setdefault("force", force) or {"deleted": node_id})
    client.request("DELETE", "/catalog/nodes/4:db:2?force=true")
    assert seen["force"] is True


def test_delete_without_force_defaults_to_false(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(catalog, "delete_node",
                        lambda node_id, cascade, force: seen.setdefault("force", force) or {"deleted": node_id})
    client.request("DELETE", "/catalog/nodes/4:db:2")
    assert seen["force"] is False


# ------------------------------ подразделения -------------------------------


def test_departments_list(client, monkeypatch):
    monkeypatch.setattr(catalog, "list_departments", lambda include_archived: [
        {"nodeId": "4:db:9", "departmentId": "UCT", "name": "УЦТ"}])
    assert client.get("/catalog/departments").json()["departments"][0]["departmentId"] == "UCT"


def test_create_department_conflict_is_409(client, monkeypatch):
    def clash(department_id, name):
        raise catalog.Conflict("уже существует")

    monkeypatch.setattr(catalog, "create_department", clash)
    response = client.post("/catalog/departments", json={"departmentId": "UCT", "name": "УЦТ"})
    assert response.status_code == 409


def test_create_department_requires_id_and_name(client):
    assert client.post("/catalog/departments", json={"name": "УЦТ"}).status_code == 422
    assert client.post("/catalog/departments", json={"departmentId": "UCT", "name": ""}).status_code == 422


def test_rule_scope_passes_through(client, monkeypatch):
    seen = {}

    def scope(node_id, only):
        seen.update(node_id=node_id, only=only)
        return {"only": only}

    monkeypatch.setattr(catalog, "set_rule_scope", scope)
    response = client.put("/catalog/rules/4:db:3/departments", json={"only": ["UCT"]})
    assert response.status_code == 200
    assert seen == {"node_id": "4:db:3", "only": ["UCT"]}


def test_rule_audience_endpoint(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(catalog, "set_rule_audience",
                        lambda node_id, students_only: seen.update(node_id=node_id, value=students_only)
                        or {"studentsOnly": students_only})
    response = client.put("/catalog/rules/4:db:3/audience", json={"studentsOnly": True})
    assert response.status_code == 200
    assert response.json() == {"studentsOnly": True}
    assert seen == {"node_id": "4:db:3", "value": True}
    assert client.put("/catalog/rules/4:db:3/audience", json={}).status_code == 422


# ------------------------------ мониторинг ----------------------------------


def test_monitoring_now(client, monkeypatch):
    import monitoring
    monkeypatch.setattr(monitoring, "vllm_state", lambda: {"running": 3.0, "waiting": 0.0})
    body = client.get("/monitoring/now").json()
    assert body["llm"]["running"] == 0 and body["llm"]["capacity"] >= 1
    assert body["vllm"] == {"running": 3.0, "waiting": 0.0}
    assert set(body) >= {"checks", "recent", "cache", "history", "neo4j"}


def test_monitoring_stats_passes_period_and_step(client, monkeypatch):
    import history
    seen = {}
    monkeypatch.setattr(history, "_run", lambda q, **p: seen.setdefault("calls", []).append((q, p)) or [])
    response = client.get("/monitoring/stats", params={
        "start": "2026-10-01T00:00:00Z", "end": "2026-10-02T00:00:00Z", "step": "hour",
        "timezone": "Europe/Moscow", "mode": "bulk"})
    assert response.status_code == 200 and response.json()["buckets"] == []
    query, params = seen["calls"][0]
    assert "datetime.truncate('hour'" in query
    assert params == {"start": "2026-10-01T00:00:00+00:00", "end": "2026-10-02T00:00:00+00:00",
                      "status": None, "mode": "bulk", "timezone": "Europe/Moscow"}
    assert "percentileCont(CASE WHEN r.cached THEN null ELSE r.ms END" in query, \
        "p95 считается без ответов из кэша (L38)"


@pytest.mark.parametrize("params", [
    {"step": "second"}, {"timezone": "x'}) DETACH DELETE n //"}, {"status": "OK"}, {"mode": "all"},
    {"timezone": "Mars/Olympus"}, {"timezone": "+25:00"}, {"start": "вчера"}, {"end": "2026-13-45"},
])
def test_monitoring_stats_rejects_bad_parameters(client, params):
    response = client.get("/monitoring/stats", params={
        "start": "2026-10-01T00:00:00Z", "end": "2026-10-02T00:00:00Z", **params})
    assert response.status_code == 422


def test_monitoring_accepts_offset_timezone(client, monkeypatch):
    import history
    monkeypatch.setattr(history, "_run", lambda q, **p: [])
    response = client.get("/monitoring/stats", params={
        "start": "2026-10-01", "end": "2026-10-02T00:00:00+03:00", "timezone": "+03:00"})
    assert response.status_code == 200


def test_monitoring_db_failure_does_not_leak_driver_text(client, monkeypatch):
    import history

    def down(query, **params):
        raise RuntimeError("bolt://10.0.0.5:7687 refused, secret details")

    monkeypatch.setattr(history, "_run", down)
    response = client.get("/monitoring/history", params={
        "start": "2026-10-01T00:00:00Z", "end": "2026-10-02T00:00:00Z"})
    assert response.status_code == 503
    assert "10.0.0.5" not in response.json()["detail"]


def test_monitoring_is_admin_only(client):
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("editor", "editor")
    for path in ("/monitoring/now", "/monitoring/history?start=a&end=b", "/monitoring/stats?start=a&end=b"):
        assert client.get(path).status_code == 403


def test_vllm_metrics_parser():
    import monitoring
    text = ('# HELP vllm:num_requests_running ...\n'
            'vllm:num_requests_running{model_name="Qwen"} 7.0\n'
            'vllm:num_requests_waiting{model_name="Qwen"} 2.0\n'
            'vllm:gpu_cache_usage_perc{model_name="Qwen"} 0.25\n')
    assert monitoring.parse_vllm_metrics(text) == {"running": 7.0, "waiting": 2.0, "kv_cache_usage": 0.25}


def test_graph_is_readable_by_viewer_and_catalog_change_drops_cache(client, monkeypatch):
    import metrics
    monkeypatch.setattr(catalog, "graph_view", lambda: {"nodes": [], "edges": []})
    monkeypatch.setattr(catalog, "create_department", lambda department_id, name: {"nodeId": "1"})
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("viewer", "viewer")
    assert client.get("/catalog/graph").json() == {"nodes": [], "edges": []}

    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("editor", "editor")
    generation = metrics.results.generation
    client.get("/catalog/graph")
    assert metrics.results.generation == generation, "чтение кэш не сбрасывает"
    client.post("/catalog/departments", json={"departmentId": "HR", "name": "Кадры"})
    assert metrics.results.generation == generation + 1


# ------------------------- обязанности из инструкции -------------------------

JOB_NODE = {"nodeId": "4:db:20", "labels": ["JobDescription"], "title": "Аналитик", "text": "текст",
            "dutiesStatus": "pending", "dutiesError": None}


@pytest.fixture
def duties_now(monkeypatch):
    """Фоновая выписка обязанностей выполняется сразу, в потоке запроса; итог — в finished."""
    import routes

    class Inline:
        def submit(self, fn, *args):
            fn(*args)

    finished = []
    monkeypatch.setattr(routes, "_duties_pool", Inline())
    monkeypatch.setattr(catalog, "finish_duties", lambda node_id, text, duties=None, error=None:
                        finished.append({"duties": duties, "error": error}) or True)
    return finished


def test_uploading_job_description_extracts_duties_in_background(client, monkeypatch, duties_now):
    import agent
    monkeypatch.setattr(catalog, "create_job_description", lambda *a: dict(JOB_NODE))
    monkeypatch.setattr(agent, "extract_duties", lambda text: ["Готовит отчёт"])
    response = client.post("/catalog/job-descriptions",
                           json={"departmentNodeId": "4:db:9", "title": "Аналитик", "text": "текст"})
    assert response.status_code == 202
    assert response.json()["dutiesStatus"] == "pending" and response.json()["dutiesError"] is None
    assert duties_now == [{"duties": ["Готовит отчёт"], "error": None}]


def test_model_failure_does_not_lose_uploaded_job_description(client, monkeypatch, duties_now):
    import agent

    def boom(text):
        raise agent.ExtractionError("модель недоступна: timeout")

    monkeypatch.setattr(catalog, "create_job_description", lambda *a: dict(JOB_NODE))
    monkeypatch.setattr(agent, "extract_duties", boom)
    response = client.post("/catalog/job-descriptions",
                           json={"departmentNodeId": "4:db:9", "title": "Аналитик", "text": "текст"})
    assert response.status_code == 202
    assert duties_now[0]["duties"] is None and "модель недоступна" in duties_now[0]["error"]


def test_job_description_edit_reextracts_only_when_text_changed(client, monkeypatch, duties_now):
    import agent
    calls = []
    monkeypatch.setattr(agent, "extract_duties", lambda text: calls.append(text) or [])
    monkeypatch.setattr(catalog, "update_job_description", lambda n, title, text: (dict(JOB_NODE), False))
    assert client.put("/catalog/job-descriptions/4:db:20",
                      json={"title": "Аналитик", "text": "текст"}).status_code == 200
    assert calls == []
    monkeypatch.setattr(catalog, "update_job_description", lambda n, title, text: (dict(JOB_NODE), True))
    assert client.put("/catalog/job-descriptions/4:db:20",
                      json={"title": "Аналитик", "text": "новый"}).status_code == 202
    assert calls == ["текст"]


def test_editor_saves_reviewed_duties(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(catalog, "set_job_duties",
                        lambda node_id, duties, reviewed: seen.update(d=duties, r=reviewed) or JOB_NODE)
    assert client.put("/catalog/job-descriptions/4:db:20/duties", json={"duties": ["А", "Б"]}).status_code == 200
    assert seen == {"d": ["А", "Б"], "r": True}


def test_monitoring_history_is_paged(client, monkeypatch):
    import history
    calls = []

    def run(query, **params):
        calls.append((query, params))
        return [{"total": 4200}] if query == history.Q_COUNT else [{"goal": "цель"}]

    monkeypatch.setattr(history, "_run", run)
    body = client.get("/monitoring/history", params={
        "start": "2026-10-01T00:00:00Z", "end": "2026-10-02T00:00:00Z", "limit": 50, "offset": 500}).json()
    assert body == {"records": [{"goal": "цель"}], "total": 4200}
    assert (calls[0][1]["limit"], calls[0][1]["offset"]) == (50, 500)


@pytest.mark.parametrize("params", [{"limit": 101}, {"limit": 0}, {"offset": -1}])
def test_monitoring_history_page_limits(client, params):
    response = client.get("/monitoring/history", params={
        "start": "2026-10-01T00:00:00Z", "end": "2026-10-02T00:00:00Z", **params})
    assert response.status_code == 422
