"""Настройки, ключи доступа внешних систем и ограничение частоты проверок."""

import time

import pytest
from fastapi.testclient import TestClient

import apikeys
import auth
import graph
import history
import main
import metrics
import settings
import settings_routes
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


@pytest.fixture(autouse=True)
def fresh_settings_state():
    """Последнее удачное чтение и пауза после сбоя не переходят из теста в тест."""
    settings.forget()
    yield
    settings.forget()


@pytest.fixture
def admin(db):
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("root", "admin")
    with TestClient(main.app, headers=XHR) as c:
        yield c
    main.app.dependency_overrides.clear()


@pytest.fixture
def outside(db, monkeypatch):
    """Клиент без сессии — внешняя система; модель и граф проверки подменены."""
    monkeypatch.setattr(main, "check_goal", lambda goal, department_id=None, is_student=None: {**ANSWER, "goal": goal})
    monkeypatch.setattr(main, "check_goals", lambda items: {"results": [ANSWER] * len(items)})
    with TestClient(main.app) as c:
        yield c


def bearer(key):
    return {"Authorization": f"Bearer {key}"}


# ------------------------------ настройки -----------------------------------


DEFAULTS = {
    "promptExamples": False, "injectionGuard": True, "evidenceQuotes": True, "smartCheck": True,
    "smartCheckBulk": True, "promptExamplesPerKind": 2,
    "checkCache": True, "checkCacheTtlSeconds": 3600, "jobDescriptionsCacheTtlSeconds": 60, "bulkChecks": True,
    "checkRatePerMinute": 600, "goalMaxChars": 4000, "historyEnabled": True, "historyRetentionDays": 365, "apiKeysEnabled": True,
    "maintenance": False, "llmMaxConcurrency": 32, "llmInteractiveReserve": 4,
}


def test_defaults_and_update(admin, db):
    assert admin.get("/settings").json() == DEFAULTS
    generation = metrics.results.generation
    response = admin.put("/settings", json={"promptExamples": True})
    assert response.json() == {**DEFAULTS, "promptExamples": True}
    assert db.settings == {"promptExamples": True}, "непереданная настройка не трогается"
    assert metrics.results.generation > generation, "готовые ответы посчитаны со старым промптом"
    assert settings.flag("promptExamples") is True


def broken():
    raise RuntimeError("Neo4j недоступен")


def test_flag_falls_back_to_default_when_graph_is_down(monkeypatch):
    monkeypatch.setattr(settings, "_read", broken)
    assert settings.flag("promptExamples") is False
    assert settings.flag("injectionGuard") is True
    # Защитные переключатели без единого удачного чтения — в сторону запрета.
    assert settings.flag("apiKeysEnabled") is False and settings.flag("maintenance") is True
    assert settings.known() is False


def test_last_good_settings_serve_while_graph_is_down(monkeypatch):
    """Сбой графа не возвращает обслуживание и ключи к умолчаниям в сторону разрешения."""
    monkeypatch.setattr(settings, "_read", lambda: {"maintenance": True, "apiKeysEnabled": False,
                                                    "promptExamples": True})
    assert settings.flag("maintenance") is True
    metrics.lookups.clear()
    monkeypatch.setattr(settings, "_read", broken)
    assert settings.flag("maintenance") is True and settings.flag("apiKeysEnabled") is False
    assert settings.flag("promptExamples") is True and settings.known() is True


def test_read_failure_is_remembered_for_a_few_seconds(monkeypatch):
    """Иначе каждая проверка (до 15 обращений к настройкам) ждала бы таймаута графа заново."""
    clock = {"now": 1000.0}
    monkeypatch.setattr(settings, "_now", lambda: clock["now"])
    calls = []
    monkeypatch.setattr(settings, "_read", lambda: calls.append(1) or broken())
    for _ in range(15):
        settings.flag("injectionGuard")
    assert len(calls) == 1
    clock["now"] += settings.FAILURE_PAUSE_SECONDS + 1
    settings.flag("injectionGuard")
    assert len(calls) == 2
    monkeypatch.setattr(settings, "_read", lambda: calls.append(1) or {})
    clock["now"] += settings.FAILURE_PAUSE_SECONDS + 1
    assert settings.flag("maintenance") is False and len(calls) == 3, "граф ожил — настройки снова из него"


def test_unknown_settings_close_service_for_non_admins(admin, outside, monkeypatch):
    key = admin.post("/settings/api-keys", json={"name": "HR"}).json()["key"]
    settings.forget()
    metrics.lookups.clear()
    monkeypatch.setattr(settings, "_read", broken)
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("ed", "editor")
    response = outside.get("/catalog/tree", headers=XHR)
    assert response.status_code == 503 and response.json()["detail"] == auth.SETTINGS_UNAVAILABLE
    main.app.dependency_overrides.clear()
    by_key = outside.post("/check-goal", json={"goal": "цель"}, headers=bearer(key))
    assert by_key.status_code == 503 and by_key.json()["detail"] == auth.SETTINGS_UNAVAILABLE


def test_smart_check_bulk_switch(admin, db):
    """Оценка SMART в пакетах выключается отдельно от ручных проверок; готовые ответы сбрасываются."""
    assert settings.flag("smartCheckBulk") is True
    generation = metrics.results.generation
    response = admin.put("/settings", json={"smartCheckBulk": False})
    assert response.status_code == 200 and response.json()["smartCheckBulk"] is False
    assert response.json()["smartCheck"] is True, "ручные проверки по-прежнему с оценкой"
    assert db.settings == {"smartCheckBulk": False}
    assert settings.flag("smartCheckBulk") is False
    assert metrics.results.generation > generation, "ответы пакета с оценкой SMART больше не годятся"
    assert admin.put("/settings", json={"smartCheckBulk": "нет"}).status_code == 422


def test_goal_max_chars_setting(admin, outside, db):
    """Предел длины цели — настройка: действует сразу на проверку, пакет и /auth/me."""
    assert admin.get("/auth/me").json()["limits"]["goalMaxChars"] == 4000
    assert admin.post("/check-goal", json={"goal": "ц" * 4000}).status_code == 200

    response = admin.put("/settings", json={"goalMaxChars": 100})
    assert response.status_code == 200 and response.json()["goalMaxChars"] == 100
    assert db.settings == {"goalMaxChars": 100}
    assert admin.get("/auth/me").json()["limits"]["goalMaxChars"] == 100

    assert admin.post("/check-goal", json={"goal": "ц" * 100}).status_code == 200
    # Пробелы по краям в длину не входят — как и до настройки.
    assert admin.post("/check-goal", json={"goal": "  " + "ц" * 100 + "  "}).status_code == 200
    too_long = admin.post("/check-goal", json={"goal": "ц" * 101})
    assert too_long.status_code == 422
    error = too_long.json()["detail"][0]
    assert error["type"] == "string_too_long" and error["ctx"] == {"max_length": 100}
    batch = [{"goal": "цель", "department_id": "UCT"}, {"goal": "ц" * 101, "department_id": "UCT"}]
    assert admin.post("/check-goals", json=batch).status_code == 422, "одна длинная цель отклоняет пакет"


def test_goal_max_chars_bounds(admin, outside, db):
    """Границы настройки 100–8000; длиннее верхней границы цель не проходит при любой настройке."""
    for bad in (99, 8001, "4000", 4000.0):
        assert admin.put("/settings", json={"goalMaxChars": bad}).status_code == 422, bad
    assert admin.put("/settings", json={"goalMaxChars": 8000}).status_code == 200
    assert admin.post("/check-goal", json={"goal": "ц" * 8000}).status_code == 200
    assert admin.post("/check-goal", json={"goal": "ц" * 8001}).status_code == 422


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


# ------------------------- очередь к модели ---------------------------------


def test_llm_limits_are_bounded(admin, db):
    for body in ({"llmMaxConcurrency": 0}, {"llmMaxConcurrency": 257}, {"llmInteractiveReserve": -1},
                 {"llmInteractiveReserve": 256}, {"llmMaxConcurrency": "16"}):
        assert admin.put("/settings", json=body).status_code == 422, body
    assert db.settings == {}
    assert admin.put("/settings", json={"llmMaxConcurrency": 256, "llmInteractiveReserve": 255}).status_code == 200
    assert settings.llm_limits() == (256, 255)


def test_reserve_is_clipped_to_capacity_minus_one(admin, db):
    values = admin.put("/settings", json={"llmMaxConcurrency": 4, "llmInteractiveReserve": 10}).json()
    assert values["llmMaxConcurrency"] == 4 and values["llmInteractiveReserve"] == 3
    assert db.settings == {"llmMaxConcurrency": 4, "llmInteractiveReserve": 10}, "сохранено как есть, обрезано при чтении"
    assert settings.llm_limits() == (4, 3)
    assert metrics.gate.snapshot()["capacity"] == 4 and metrics.gate.snapshot()["reserve"] == 3
    assert admin.get("/monitoring/now").json()["llm"] == {"capacity": 4, "reserve": 3, "running": 0, "waiting": 0}

    # Предел подняли — сохранённый резерв снова действует целиком.
    values = admin.put("/settings", json={"llmMaxConcurrency": 64}).json()
    assert values["llmInteractiveReserve"] == 10
    # Предел 1 — пакету остаётся один слот, резерва нет.
    assert admin.put("/settings", json={"llmMaxConcurrency": 1}).json()["llmInteractiveReserve"] == 0


def test_llm_limit_defaults_come_from_environment_and_are_clipped(admin, monkeypatch):
    monkeypatch.setenv("LLM_MAX_CONCURRENCY", "2")
    monkeypatch.setenv("LLM_INTERACTIVE_RESERVE", "8")
    metrics.lookups.clear()
    values = admin.get("/settings").json()
    assert values["llmMaxConcurrency"] == 2 and values["llmInteractiveReserve"] == 1
    assert settings.llm_limits() == (2, 1)


def test_limits_fall_back_to_defaults_when_graph_is_down(monkeypatch):
    monkeypatch.setattr(settings, "_read", broken)
    assert settings.llm_limits() == (32, 4)


def test_raising_the_limit_wakes_a_waiting_request_without_restart(admin, db):
    """Ждущий в очереди поток впускается сразу после правки в «Настройках»."""
    import threading

    assert admin.put("/settings", json={"llmMaxConcurrency": 1, "llmInteractiveReserve": 0}).status_code == 200
    release = threading.Event()
    entered = threading.Event()

    def hold():
        with metrics.gate.slot(bulk=False):
            entered.set()
            release.wait(5)

    threads = [threading.Thread(target=hold) for _ in range(2)]
    try:
        threads[0].start()
        assert entered.wait(5)
        entered.clear()
        threads[1].start()
        for _ in range(200):
            if metrics.gate.snapshot()["waiting"] == 1:
                break
            threading.Event().wait(0.01)
        assert metrics.gate.snapshot() == {"capacity": 1, "reserve": 0, "running": 1, "waiting": 1}
        assert not entered.wait(0.3), "второй запрос ждёт: предел 1"

        assert admin.put("/settings", json={"llmMaxConcurrency": 2}).status_code == 200
        assert entered.wait(0.5), "после правки предела ждущий поток не проснулся"
        assert metrics.gate.snapshot() == {"capacity": 2, "reserve": 0, "running": 2, "waiting": 0}
    finally:
        release.set()
        for t in threads:
            t.join(5)


def test_only_prompt_settings_drop_ready_answers(admin):
    generation = metrics.results.generation
    admin.put("/settings", json={"checkRatePerMinute": 10, "historyEnabled": False})
    assert metrics.results.generation == generation
    assert settings.flag("historyEnabled") is False, "действует сразу, а не через минуту"
    admin.put("/settings", json={"promptExamplesPerKind": 3})
    assert metrics.results.generation > generation
    generation = metrics.results.generation
    admin.put("/settings", json={"smartCheck": False})
    assert metrics.results.generation > generation, "в готовых ответах лежит оценка SMART"


def test_smart_scores_survive_everything_but_their_own_switch(admin):
    scores = {"specific": {"score": 80, "comment": "ок"}}
    metrics.smart_scores.put("цель", scores, metrics.smart_scores.generation)
    admin.put("/settings", json={"promptExamplesPerKind": 3, "checkCache": False})
    metrics.catalog_changed()
    assert metrics.smart_scores.get("цель") == scores, "оценка не зависит ни от каталога, ни от промпта проверки"
    admin.put("/settings", json={"smartCheck": False})
    assert metrics.smart_scores.get("цель") is None, "выключение smartCheck очищает кэш оценок"


def test_caches_are_cleared_one_by_one(admin, monkeypatch):
    metrics.results.put(("цель", "A", False), ANSWER, metrics.results.generation)
    metrics.results.put(("цель", "B", False), ANSWER, metrics.results.generation)
    metrics.job_lookups.put(("job_descriptions", "A"), [], metrics.job_lookups.generation)
    metrics.job_lookups.put(("job_rules", ("атрибут",), "B", False), [], metrics.job_lookups.generation)
    metrics.smart_scores.put("цель", {"specific": {"score": 1, "comment": ""}}, metrics.smart_scores.generation)
    monkeypatch.setattr(settings_routes, "delete_smart_scores", lambda: 7)

    listed = {c["id"]: c for c in admin.get("/settings/caches").json()["caches"]}
    assert (listed["results"]["entries"], listed["jobDescriptions"]["entries"], listed["smart"]["entries"]) == (2, 2, 1)
    assert listed["results"]["ttl_seconds"] == 3600 and listed["smart"]["ttl_seconds"] == (metrics.SMART_CACHE_TTL or None)

    r = admin.post("/settings/caches/results/clear", json={"departmentId": "A"})
    assert r.status_code == 200
    assert r.json() == {"cache": "results", "entries": 1, "stored": None, "departmentId": "A"}
    assert metrics.results.get(("цель", "A", False)) is None, "ответы подразделения A убраны"
    assert metrics.results.get(("цель", "B", False)) == ANSWER, "ответы подразделения B на месте"

    r = admin.post("/settings/caches/jobDescriptions/clear", json={"departmentId": "B"})
    assert r.json()["entries"] == 1 and metrics.job_lookups.get(("job_descriptions", "A")) == []

    r = admin.post("/settings/caches/smart/clear")
    assert r.json() == {"cache": "smart", "entries": 1, "stored": 7, "departmentId": None}
    assert metrics.smart_scores.get("цель") is None

    assert admin.post("/settings/caches/results/clear").json()["entries"] == 1, "без подразделения — целиком"
    assert admin.post("/settings/caches/nope/clear").status_code == 404
    assert admin.post("/settings/caches/smart/clear", json={"departmentId": "A"}).status_code == 422


def test_smart_cache_clear_reports_graph_failure(admin, monkeypatch):
    metrics.smart_scores.put("цель", {"specific": {"score": 1, "comment": ""}}, metrics.smart_scores.generation)

    def down():
        raise RuntimeError("нет связи")

    monkeypatch.setattr(settings_routes, "delete_smart_scores", down)
    r = admin.post("/settings/caches/smart/clear")
    assert r.status_code == 503 and "граф недоступен" in r.json()["detail"]
    assert metrics.smart_scores.get("цель") is None, "память всё равно очищена"


def test_cache_switch_and_ttl(admin, monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr(metrics, "_now", lambda: clock["now"])
    metrics.results.put("цель", ANSWER, metrics.results.generation)
    assert metrics.results.get("цель") == ANSWER
    admin.put("/settings", json={"checkCacheTtlSeconds": 60})
    clock["now"] += 61
    assert metrics.results.get("цель") is None, "новый срок действует и на уже сохранённые ответы"
    metrics.results.put("цель", ANSWER, metrics.results.generation)
    admin.put("/settings", json={"checkCache": False})
    assert metrics.results.get("цель") is None and metrics.snapshot()["cache"]["ttl_seconds"] == 0


def test_cache_without_ttl_keeps_values_until_cleared(monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr(metrics, "_now", lambda: clock["now"])
    cache = metrics.TtlCache(None, 10)
    assert cache.load("цель", lambda: "оценка") == "оценка"
    clock["now"] += 10 * 365 * 86400
    assert cache.get("цель") == "оценка" and cache.load("цель", lambda: "другая") == "оценка"
    cache.clear()
    assert cache.get("цель") is None


def test_cache_loads_a_key_once_under_concurrency():
    import threading

    cache = metrics.TtlCache(None, 10)
    calls, started = [], threading.Barrier(4)

    def loader():
        calls.append(1)
        time.sleep(0.05)
        return "оценка"

    def worker(out):
        started.wait()
        out.append(cache.load("цель", loader))

    out: list = []
    threads = [threading.Thread(target=worker, args=(out,)) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert out == ["оценка"] * 4 and len(calls) == 1


def test_cache_does_not_keep_loader_failures():
    cache = metrics.TtlCache(None, 10)

    def broken():
        raise RuntimeError("модель недоступна")

    with pytest.raises(RuntimeError):
        cache.load("цель", broken)
    assert cache.get("цель") is None
    assert cache.load("цель", lambda: "оценка") == "оценка"


def test_job_descriptions_cache_ttl(admin, monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr(metrics, "_now", lambda: clock["now"])
    reads = []
    load = lambda: metrics.job_lookups.load(("job_descriptions", "UCT"), lambda: reads.append(1) or ["инструкция"])
    assert load() == ["инструкция"] and load() == ["инструкция"]
    assert len(reads) == 1, "по умолчанию инструкции подразделения читаются раз в минуту"
    clock["now"] += 61
    load()
    assert len(reads) == 2

    admin.put("/settings", json={"jobDescriptionsCacheTtlSeconds": 600})
    clock["now"] += 61
    load()
    assert len(reads) == 2, "новый срок действует и на уже прочитанные инструкции"
    admin.put("/settings", json={"jobDescriptionsCacheTtlSeconds": 0})
    load(); load()
    assert len(reads) == 4, "0 — читать из графа на каждую проверку"
    assert admin.put("/settings", json={"jobDescriptionsCacheTtlSeconds": 86401}).status_code == 422


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
    monkeypatch.setattr(main, "check_goal", lambda goal, department_id=None, is_student=None: ANSWER)
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
            assert c.get("/settings/caches").status_code == 403
            assert c.post("/settings/caches/results/clear").status_code == 403
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
    monkeypatch.setattr(main, "check_goal", lambda goal, department_id=None, is_student=None: seen.append(metrics.actor()) or ANSWER)
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


def test_unknown_key_ids_do_not_grow_memory_or_evict_real_keys(admin, outside, db, monkeypatch):
    """Поток выдуманных keyId: память ограничена, настоящий ключ остаётся в кэше."""
    key = admin.post("/settings/api-keys", json={"name": "HR"}).json()["key"]
    main.app.dependency_overrides.clear()
    assert outside.post("/check-goal", json={"goal": "цель"}, headers=bearer(key)).status_code == 200
    for n in range(apikeys.MISS_CACHE_MAX * 3):
        assert apikeys.resolve(f"gc_{n:08x}_" + "x" * 30) is None
    assert len(apikeys._misses) <= apikeys.MISS_CACHE_MAX
    reads = []
    monkeypatch.setattr(apikeys, "_run", lambda query, **params: reads.append(query) or db(query, **params))
    assert apikeys.resolve(key)["name"] == "HR"
    assert not [q for q in reads if "RETURN properties(k)" in q], "найденный ключ не вытеснен отказами"


def test_user_cannot_be_given_the_service_role(monkeypatch):
    """Роль ключа ниже читателя; в реестре пользователей она ничего не значит."""
    monkeypatch.setattr(users, "get", lambda login: {"login": login, "role": "service", "status": "active",
                                                     "displayName": None})
    assert auth.resolve_account("someone") is None


# --------------------------- ограничение частоты ----------------------------


def test_rate_limit_counts_goals_per_caller(admin, outside, monkeypatch):
    monkeypatch.setenv("CHECK_RATE_PER_MINUTE", "3")
    metrics.lookups.clear()   # настройки могли быть прочитаны при запуске приложения
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
