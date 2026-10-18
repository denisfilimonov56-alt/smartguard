"""Настройки, ключи доступа внешних систем и ограничение частоты проверок."""

import pytest
from fastapi.testclient import TestClient

import apikeys
import auth
import graph
import history
import main
import metrics
import settings
import users

XHR = {"X-Requested-With": "XMLHttpRequest"}
ANSWER = {"goal": "цель", "status": "ALLOWED", "allowed": True, "violations": []}


class FakeGraph:
    """Подмена _run у settings и apikeys: узлы в памяти, разбор по тексту запроса."""

    def __init__(self):
        self.settings: dict = {}
        self.keys: dict = {}

    def __call__(self, query, **params):
        key_id = params.get("key_id")
        if "MERGE (s:Setting" in query:
            self.settings[params["key"]] = params["value"]
            return []
        if "CREATE (k:ApiKey" in query:
            self.keys[key_id] = {"keyId": key_id, "name": params["name"], "hash": params["hash"],
                                 "createdAt": params["now"], "createdBy": params["created_by"]}
            return [{"props": self.keys[key_id]}]
        if "DETACH DELETE" in query:
            props = self.keys.pop(key_id, None)
            return [{"props": props}] if props else []
        if "lastUsedAt" in query:
            self.keys[key_id]["lastUsedAt"] = params["now"]
            return []
        if "{keyId: $key_id}" in query:
            return [{"props": self.keys[key_id]}] if key_id in self.keys else []
        return [{"props": k, "name": k["name"]} for k in sorted(self.keys.values(), key=lambda k: k["name"])]


@pytest.fixture
def db(monkeypatch):
    fake = FakeGraph()
    monkeypatch.setattr(apikeys, "_run", fake)
    monkeypatch.setattr(settings, "_run", fake)
    monkeypatch.setattr(settings, "_read", lambda: dict(fake.settings))
    monkeypatch.setattr(users, "_run", lambda query, **params: [])
    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    return fake


@pytest.fixture
def admin(db):
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("root", "admin")
    with TestClient(main.app, headers=XHR) as c:
        yield c
    main.app.dependency_overrides.clear()


@pytest.fixture
def outside(db, monkeypatch):
    """Клиент без сессии — внешняя система; модель и граф проверки подменены."""
    monkeypatch.setattr(main, "check_goal", lambda goal, department_id=None: {**ANSWER, "goal": goal})
    monkeypatch.setattr(main, "check_goals", lambda items: {"results": [ANSWER] * len(items)})
    with TestClient(main.app) as c:
        yield c


def bearer(key):
    return {"Authorization": f"Bearer {key}"}


# ------------------------------ настройки -----------------------------------


DEFAULTS = {
    "promptExamples": False, "injectionGuard": True, "evidenceQuotes": True, "promptExamplesPerKind": 2,
    "checkCache": True, "checkCacheTtlSeconds": 3600, "bulkChecks": True, "checkRatePerMinute": 600,
    "historyEnabled": True, "historyRetentionDays": 365, "apiKeysEnabled": True, "maintenance": False,
}


def test_defaults_and_update(admin, db):
    assert admin.get("/settings").json() == DEFAULTS
    generation = metrics.results.generation
    response = admin.put("/settings", json={"promptExamples": True})
    assert response.json() == {**DEFAULTS, "promptExamples": True}
    assert db.settings == {"promptExamples": True}, "непереданная настройка не трогается"
    assert metrics.results.generation > generation, "готовые ответы посчитаны со старым промптом"
    assert settings.flag("promptExamples") is True


def test_flag_falls_back_to_default_when_graph_is_down(monkeypatch):
    def broken():
        raise RuntimeError("Neo4j недоступен")

    monkeypatch.setattr(settings, "_read", broken)
    assert settings.flag("promptExamples") is False
    assert settings.flag("injectionGuard") is True


def test_number_defaults_come_from_environment(admin, db, monkeypatch):
    monkeypatch.setenv("CHECK_RATE_PER_MINUTE", "50")
    monkeypatch.setenv("HISTORY_RETENTION_DAYS", "не число")
    values = admin.get("/settings").json()
    assert values["checkRatePerMinute"] == 50 and values["historyRetentionDays"] == 365
    assert admin.put("/settings", json={"checkRatePerMinute": 70}).json()["checkRatePerMinute"] == 70, \
        "сохранённое в интерфейсе важнее окружения"


def test_numbers_are_validated(admin, db):
    for body in ({"promptExamplesPerKind": 0}, {"checkRatePerMinute": -1}, {"historyRetentionDays": 99999},
                 {"checkCacheTtlSeconds": "3600"}, {"checkRatePerMinute": True}):
        assert admin.put("/settings", json=body).status_code == 422, body
    assert db.settings == {}
    db.settings["promptExamplesPerKind"] = 500  # записано в обход API
    assert admin.get("/settings").json()["promptExamplesPerKind"] == 2


def test_only_prompt_settings_drop_ready_answers(admin):
    generation = metrics.results.generation
    admin.put("/settings", json={"checkRatePerMinute": 10, "historyEnabled": False})
    assert metrics.results.generation == generation
    assert settings.flag("historyEnabled") is False, "действует сразу, а не через минуту"
    admin.put("/settings", json={"promptExamplesPerKind": 3})
    assert metrics.results.generation > generation


def test_cache_switch_and_ttl(admin, monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr(metrics.time, "monotonic", lambda: clock["now"])
    metrics.results.put("цель", ANSWER, metrics.results.generation)
    assert metrics.results.get("цель") == ANSWER
    admin.put("/settings", json={"checkCacheTtlSeconds": 60})
    clock["now"] += 61
    assert metrics.results.get("цель") is None, "новый срок действует и на уже сохранённые ответы"
    metrics.results.put("цель", ANSWER, metrics.results.generation)
    admin.put("/settings", json={"checkCache": False})
    assert metrics.results.get("цель") is None and metrics.snapshot()["cache"]["ttl_seconds"] == 0


def test_history_switch_and_retention(admin, monkeypatch):
    pruned = []
    monkeypatch.setattr(history, "_run", lambda query, **params: pruned.append(params) or [{"deleted": 0}])
    admin.put("/settings", json={"historyEnabled": False, "historyRetentionDays": 30})
    before = history._pending.qsize()
    history._enqueue({"at": "2026-01-01T00:00:00Z"})
    assert history._pending.qsize() == before
    history.prune()
    assert pruned == [{"days": 30}]
    admin.put("/settings", json={"historyRetentionDays": 0})
    history.prune()
    assert len(pruned) == 1, "0 — не удалять"


def test_bulk_checks_can_be_switched_off(admin, monkeypatch):
    monkeypatch.setattr(main, "check_goal", lambda goal, department_id=None: ANSWER)
    monkeypatch.setattr(main, "check_goals", lambda items: {"results": [ANSWER] * len(items)})
    admin.put("/settings", json={"bulkChecks": False})
    batch = [{"goal": "цель", "department_id": "UCT"}]
    assert admin.post("/check-goals", json=batch).status_code == 503
    assert admin.post("/check-goal", json={"goal": "цель"}).status_code == 200


def test_api_keys_can_be_switched_off(admin, outside):
    key = admin.post("/settings/api-keys", json={"name": "HR"}).json()["key"]
    admin.put("/settings", json={"apiKeysEnabled": False})
    main.app.dependency_overrides.clear()
    response = outside.post("/check-goal", json={"goal": "цель"}, headers=bearer(key))
    assert response.status_code == 403 and "отключена" in response.json()["detail"]


def test_maintenance_leaves_the_service_to_admins(admin, outside, monkeypatch):
    key = admin.post("/settings/api-keys", json={"name": "HR"}).json()["key"]
    admin.put("/settings", json={"maintenance": True})
    assert admin.post("/check-goal", json={"goal": "цель"}).status_code == 200
    assert admin.get("/settings").status_code == 200

    main.app.dependency_overrides.clear()
    by_key = outside.post("/check-goal", json={"goal": "цель"}, headers=bearer(key))
    assert by_key.status_code == 503 and by_key.headers["Retry-After"]
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("ed", "editor")
    assert outside.post("/check-goal", json={"goal": "цель"}, headers=XHR).status_code == 503
    assert outside.get("/catalog/tree", headers=XHR).status_code == 503
    assert outside.get("/auth/me", headers=XHR).status_code == 200, "интерфейс должен узнать, кто вошёл"
    main.app.dependency_overrides.clear()


def test_settings_are_admin_only(db):
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("ed", "editor")
    try:
        with TestClient(main.app, headers=XHR) as c:
            assert c.get("/settings").status_code == 403
            assert c.put("/settings", json={"promptExamples": True}).status_code == 403
            assert c.post("/settings/api-keys", json={"name": "HR"}).status_code == 403
    finally:
        main.app.dependency_overrides.clear()


# -------------------------------- ключи -------------------------------------


def test_key_is_shown_once_and_stored_hashed(admin, db):
    created = admin.post("/settings/api-keys", json={"name": "  Кадровая   система "})
    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "Кадровая система" and body["key"].startswith("gc_" + body["keyId"] + "_")
    stored = db.keys[body["keyId"]]
    assert body["key"] not in str(stored) and body["key"].split("_", 2)[2] not in str(stored)
    listed = admin.get("/settings/api-keys").json()["keys"]
    assert [k["name"] for k in listed] == ["Кадровая система"]
    assert "key" not in listed[0] and "hash" not in listed[0]


def test_key_names_are_unique(admin):
    assert admin.post("/settings/api-keys", json={"name": "HR"}).status_code == 201
    assert admin.post("/settings/api-keys", json={"name": "hr"}).status_code == 409


def test_key_checks_goals_without_session_or_csrf_header(admin, outside):
    key = admin.post("/settings/api-keys", json={"name": "HR"}).json()["key"]
    main.app.dependency_overrides.clear()

    single = outside.post("/check-goal", json={"goal": "цель"}, headers=bearer(key))
    assert single.status_code == 200 and single.json()["status"] == "ALLOWED"
    many = outside.post("/check-goals", json=[{"goal": "цель", "department_id": "UCT"}], headers=bearer(key))
    assert many.status_code == 200 and len(many.json()["results"]) == 1


def test_key_opens_nothing_but_checks(admin, outside):
    key = admin.post("/settings/api-keys", json={"name": "HR"}).json()["key"]
    main.app.dependency_overrides.clear()
    for method, path in [("GET", "/catalog/tree"), ("GET", "/check-targets"), ("GET", "/settings"),
                         ("GET", "/auth/users"), ("GET", "/monitoring/now"),
                         ("POST", "/catalog/examples-check"), ("POST", "/settings/api-keys")]:
        response = outside.request(method, path, json={"name": "x"}, headers=bearer(key))
        assert response.status_code == 403, f"{method} {path} открыт ключу"


def test_key_actor_reaches_history(admin, outside, monkeypatch):
    key = admin.post("/settings/api-keys", json={"name": "HR"}).json()["key"]
    main.app.dependency_overrides.clear()
    seen = []
    monkeypatch.setattr(main, "check_goal", lambda goal, department_id=None: seen.append(metrics.actor()) or ANSWER)
    outside.post("/check-goal", json={"goal": "цель"}, headers=bearer(key))
    assert seen == ["key:HR"]


@pytest.mark.parametrize("token", ["", "gc_deadbeef_" + "x" * 43, "not a key at all", "gc_zz"])
def test_wrong_key_is_rejected(outside, token):
    response = outside.post("/check-goal", json={"goal": "цель"}, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code in (401, 403)
    assert response.json().get("status") != "ALLOWED"


def test_tampered_secret_is_rejected(admin, outside):
    key = admin.post("/settings/api-keys", json={"name": "HR"}).json()["key"]
    main.app.dependency_overrides.clear()
    forged = key[:-1] + ("A" if key[-1] != "A" else "B")
    assert outside.post("/check-goal", json={"goal": "цель"}, headers=bearer(forged)).status_code == 401


def test_revoked_key_stops_working_at_once(admin, outside):
    created = admin.post("/settings/api-keys", json={"name": "HR"}).json()
    main.app.dependency_overrides.clear()
    assert outside.post("/check-goal", json={"goal": "цель"}, headers=bearer(created["key"])).status_code == 200

    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("root", "admin")
    assert admin.delete(f"/settings/api-keys/{created['keyId']}").json() == {"deleted": created["keyId"]}
    assert admin.delete(f"/settings/api-keys/{created['keyId']}").status_code == 404
    main.app.dependency_overrides.clear()
    assert outside.post("/check-goal", json={"goal": "цель"}, headers=bearer(created["key"])).status_code == 401


def test_last_use_is_recorded(admin, outside, db):
    created = admin.post("/settings/api-keys", json={"name": "HR"}).json()
    main.app.dependency_overrides.clear()
    outside.post("/check-goal", json={"goal": "цель"}, headers=bearer(created["key"]))
    assert db.keys[created["keyId"]].get("lastUsedAt")


def test_user_cannot_be_given_the_service_role(monkeypatch):
    """Роль ключа ниже читателя; в реестре пользователей она ничего не значит."""
    monkeypatch.setattr(users, "get", lambda login: {"login": login, "role": "service", "status": "active",
                                                     "displayName": None})
    assert auth.resolve_account("someone") is None


# --------------------------- ограничение частоты ----------------------------


def test_rate_limit_counts_goals_per_caller(admin, outside, monkeypatch):
    monkeypatch.setenv("CHECK_RATE_PER_MINUTE", "3")
    first = admin.post("/settings/api-keys", json={"name": "HR"}).json()["key"]
    second = admin.post("/settings/api-keys", json={"name": "CRM"}).json()["key"]
    main.app.dependency_overrides.clear()
    batch = [{"goal": "цель", "department_id": "UCT"}] * 2

    assert outside.post("/check-goals", json=batch, headers=bearer(first)).status_code == 200
    limited = outside.post("/check-goals", json=batch, headers=bearer(first))
    assert limited.status_code == 429 and int(limited.headers["Retry-After"]) > 0
    assert outside.post("/check-goal", json={"goal": "цель"}, headers=bearer(first)).status_code == 200
    assert outside.post("/check-goals", json=batch, headers=bearer(second)).status_code == 200, "у каждого свой счёт"


def test_rate_limit_window_slides(monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr(auth, "_now", lambda: clock["now"])
    limit = auth.RateLimit()
    assert limit.take("a", 2, 3) == 0
    assert limit.take("a", 2, 3) > 0
    clock["now"] += 61
    assert limit.take("a", 2, 3) == 0


def test_batch_larger_than_limit_passes_on_empty_window():
    limit = auth.RateLimit()
    assert limit.take("a", 200, 100) == 0
    assert limit.take("a", 1, 100) > 0


def test_zero_limit_disables_rate_limit():
    limit = auth.RateLimit()
    assert all(limit.take("a", 1000, 0) == 0 for _ in range(5))
