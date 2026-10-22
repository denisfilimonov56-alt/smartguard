"""Тесты исправлений по разбору ошибок 22 октября (N1, N3–N5, N18–N22, N25, N26).

Neo4j и модель подменяются, живые сервисы не нужны.
"""

import json
import threading
import time

import anyio
import pytest
from fastapi.testclient import TestClient
from neo4j.exceptions import ConstraintError

import agent
import apikeys
import auth
import graph
import main
import metrics
import users
from agent import STATUS_ALLOWED, Extraction

TARGETS = [{"name": "срок_исполнения", "description": "указан конкретный срок"}]
DEPARTMENTS = {"UCT": {"id": "UCT", "name": "УЦТ", "status": "active"}}


@pytest.fixture
def checks(monkeypatch):
    """Проверка цели без графа, без SMART и без нарушений; extract задаёт сам тест."""
    monkeypatch.setattr(agent, "get_check_targets", lambda: TARGETS)
    monkeypatch.setattr(agent, "get_departments", lambda: DEPARTMENTS)
    monkeypatch.setattr(agent, "find_violations", lambda attrs, dept=None, student=None: [])
    monkeypatch.setattr(agent.settings, "_read", lambda: {"smartCheck": False})
    monkeypatch.setattr(agent, "FLIGHT_POLL_SECONDS", 0.02)


def _in_thread(func, out: list) -> threading.Thread:
    def run():
        try:
            out.append(func())
        except Exception as exc:  # noqa: BLE001 — тест смотрит, что вышло
            out.append(exc)
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


# ------------------------------- N1 ---------------------------------------


def _asgi_post(path: str, payload, disconnect_after: float) -> tuple[list[dict], float]:
    """POST в main.app по ASGI; через disconnect_after с receive приходит http.disconnect."""
    body = json.dumps(payload).encode()
    pending = [{"type": "http.request", "body": body, "more_body": False}]
    sent: list[dict] = []
    started = time.monotonic()

    async def receive():
        if pending:
            return pending.pop(0)
        if time.monotonic() - started >= disconnect_after:
            return {"type": "http.disconnect"}
        await anyio.sleep(disconnect_after)
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
        "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "",
        "headers": [(b"content-type", b"application/json"), (b"x-requested-with", b"XMLHttpRequest"),
                    (b"content-length", str(len(body)).encode())],
        "client": ("testclient", 50000), "server": ("testserver", 80),
    }

    async def call():
        with anyio.fail_after(10):
            await main.app(scope, receive, send)

    anyio.run(call)
    return sent, time.monotonic() - started


def test_client_disconnect_reaches_batch_through_middleware(monkeypatch):
    """Обрыв соединения доходит до обработчика через весь стек middleware приложения:
    пакет останавливается сразу, а не по сроку (N1)."""
    monkeypatch.setattr(main, "BULK_WATCH_SECONDS", 0.05)
    seen = {}

    def check_goals(items, cancel=None):
        seen["stopped"] = cancel.wait(6)
        return {"results": [main._unchecked(item) for item in items], "summary": {}}

    monkeypatch.setattr(main, "check_goals", check_goals)
    main.app.dependency_overrides[auth.checker] = lambda: auth.Principal("tester", "admin")
    try:
        sent, took = _asgi_post("/check-goals", [{"goal": "цель", "department_id": "UCT"}], 0.2)
    finally:
        main.app.dependency_overrides.clear()
    assert seen["stopped"] is True and took < 4, "пакет остановлен обрывом, а не сроком"
    start = next(m for m in sent if m["type"] == "http.response.start")
    headers = dict(start["headers"])
    assert headers[b"cache-control"] == b"no-store" and headers[b"x-content-type-options"] == b"nosniff"


def test_guard_replays_audited_body_and_keeps_403(monkeypatch):
    """Тело /catalog, прочитанное для журнала, доходит до обработчика; без
    X-Requested-With и токена — 403 с заголовками ответа (поведение guard сохранено)."""
    import advisor
    got = {}
    monkeypatch.setattr(advisor, "advise", lambda goal, attribute, *a, **k: got.update(goal=goal) or {"ok": True})
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("tester", "admin")
    try:
        with TestClient(main.app) as client:
            denied = client.post("/catalog/advice", json={"goal": "g", "attribute": "a", "expected": True})
            assert denied.status_code == 403 and denied.headers["Cache-Control"] == "no-store"
            ok = client.post("/catalog/advice", json={"goal": "цель", "attribute": "срок", "expected": True, "reason": "так"},
                             headers={"X-Requested-With": "XMLHttpRequest"})
    finally:
        main.app.dependency_overrides.clear()
    assert ok.status_code == 200 and got["goal"] == "цель"
    assert ok.headers["X-Content-Type-Options"] == "nosniff"


# ------------------------------- N3 ---------------------------------------


def test_refund_returns_only_the_batch_spending(monkeypatch):
    """Возврат квоты уменьшает списание самого пакета; вышло оно из окна — не возвращается ничего (N3)."""
    clock = {"now": 1000.0}
    monkeypatch.setattr(auth, "_now", lambda: clock["now"])
    limit = auth.RateLimit()
    wait, batch = limit.spend("u", 100, 100)
    assert wait == 0 and batch is not None
    clock["now"] += 200  # пакет шёл долго, его списание уже вне окна
    assert limit.take("u", 100, 100) == 0
    limit.refund("u", 100, batch)
    assert limit.take("u", 1, 100) > 0, "чужие списания не возвращаются"


def test_refund_does_not_touch_later_spendings(monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr(auth, "_now", lambda: clock["now"])
    limit = auth.RateLimit()
    _, batch = limit.spend("u", 4, 10)
    clock["now"] += 1
    assert limit.take("u", 6, 10) == 0
    limit.refund("u", 50, batch)  # больше самого списания — возвращается только оно
    assert limit.take("u", 4, 10) == 0 and limit.take("u", 1, 10) > 0


# ---------------------------- N4, N5, N18 ---------------------------------


def test_person_does_not_follow_key_check_of_the_same_goal(monkeypatch, checks):
    """Человек не ждёт проверку той же цели по ключу внешней системы: у той нет резерва (N4)."""
    release, started = threading.Event(), threading.Event()

    def extract(goal, targets):
        if str(metrics.actor() or "").startswith("key:"):
            started.set()
            release.wait(5)
        return Extraction([])

    monkeypatch.setattr(agent, "extract_attributes", extract)

    def by_key():
        metrics.set_actor("key:HR")
        try:
            return agent.check_goal("общая цель", department_id="UCT")
        finally:
            metrics.set_actor(None)

    out: list = []
    thread = _in_thread(by_key, out)
    try:
        assert started.wait(5)
        began = time.monotonic()
        result = agent.check_goal("общая цель", department_id="UCT")
        assert result["status"] == STATUS_ALLOWED and time.monotonic() - began < 2
    finally:
        release.set()
        thread.join(5)


def test_waiting_for_flight_is_limited_for_manual_check(monkeypatch, checks):
    """Ожидание чужой ручной проверки ограничено сроком очереди: дальше — считать самому (N4)."""
    release, started = threading.Event(), threading.Event()
    calls = []

    def extract(goal, targets):
        calls.append(goal)
        if len(calls) == 1:
            started.set()
            release.wait(5)
        return Extraction([])

    monkeypatch.setattr(agent, "extract_attributes", extract)
    monkeypatch.setattr(metrics, "LLM_QUEUE_TIMEOUT", 0.3)
    out: list = []
    thread = _in_thread(lambda: agent.check_goal("цель", department_id="UCT"), out)
    try:
        assert started.wait(5)
        began = time.monotonic()
        assert agent.check_goal("цель", department_id="UCT")["status"] == STATUS_ALLOWED
        assert time.monotonic() - began < 2 and len(calls) == 2
    finally:
        release.set()
        thread.join(5)


def test_after_leader_failure_one_follower_leads(monkeypatch, checks):
    """Ведущий упал (очередь не подошла) — ждущие не идут к модели все сразу: один ведёт, остальные ждут его (N5)."""
    started, release = threading.Event(), threading.Event()
    calls = []

    def extract(goal, targets):
        calls.append(goal)
        if len(calls) == 1:
            started.set()
            release.wait(5)
            raise metrics.QueueTimeout(1)
        time.sleep(0.3)
        return Extraction([])

    monkeypatch.setattr(agent, "extract_attributes", extract)
    out: list = []
    leader = _in_thread(lambda: agent.check_goal("цель", department_id="UCT"), out)
    assert started.wait(5)
    followers = [_in_thread(lambda: agent.check_goal("цель", department_id="UCT"), out) for _ in range(3)]
    time.sleep(0.2)
    release.set()
    for thread in [leader, *followers]:
        thread.join(5)
    assert len(calls) == 2, "упавший ведущий и один новый, а не каждый ждущий"
    assert sum(isinstance(r, metrics.QueueTimeout) for r in out) == 1
    assert sum(isinstance(r, dict) and r["status"] == STATUS_ALLOWED for r in out) == 3
    assert not agent._flights


def test_follower_of_cancelled_batch_stops_waiting(monkeypatch, checks):
    """Пакет остановили — его цель, ждущая чужой проверки, не висит до её конца (N5)."""
    started, release = threading.Event(), threading.Event()

    def extract(goal, targets):
        started.set()
        release.wait(5)
        return Extraction([])

    monkeypatch.setattr(agent, "extract_attributes", extract)
    out_a: list = []
    batch_a = _in_thread(lambda: agent.check_goals([{"goal": "цель", "department_id": "UCT"}]), out_a)
    try:
        assert started.wait(5)
        cancel = threading.Event()
        out_b: list = []
        batch_b = _in_thread(lambda: agent.check_goals([{"goal": "цель", "department_id": "UCT"}],
                                                       cancel=cancel), out_b)
        time.sleep(0.2)
        began = time.monotonic()
        cancel.set()
        batch_b.join(3)
        assert not batch_b.is_alive() and time.monotonic() - began < 2
        assert out_b[0]["results"][0].get("unchecked") is True
    finally:
        release.set()
        batch_a.join(5)


def test_check_after_catalog_change_does_not_join_old_flight(monkeypatch, checks):
    """После правки каталога новый запрос не получает вердикт, посчитанный по старому (N18)."""
    started, release = threading.Event(), threading.Event()
    calls = []

    def extract(goal, targets):
        calls.append(goal)
        if len(calls) == 1:
            started.set()
            release.wait(5)
        return Extraction([])

    monkeypatch.setattr(agent, "extract_attributes", extract)
    out: list = []
    old = _in_thread(lambda: agent.check_goal("цель", department_id="UCT"), out)
    try:
        assert started.wait(5)
        metrics.results.clear()  # правка каталога
        began = time.monotonic()
        assert agent.check_goal("цель", department_id="UCT")["status"] == STATUS_ALLOWED
        assert time.monotonic() - began < 2 and len(calls) == 2
    finally:
        release.set()
        old.join(5)


def test_leader_rechecks_cache_after_joining_flight(monkeypatch, checks):
    """Прежний ведущий успел положить ответ в кэш и снять полёт между проверкой
    кэша и _join_flight: новый ведущий берёт кэш, а не идёт к модели второй раз."""
    calls = []
    monkeypatch.setattr(agent, "extract_attributes", lambda goal, targets: calls.append(goal) or Extraction([]))
    assert agent.check_goal("цель", department_id="UCT")["status"] == STATUS_ALLOWED
    assert calls == ["цель"]

    cached_get = metrics.results.get
    misses = iter([True])  # первая проверка кэша «промахивается» — как в гонке

    def racing_get(key, *args, **kwargs):
        if next(misses, False):
            return None
        return cached_get(key, *args, **kwargs)

    monkeypatch.setattr(metrics.results, "get", racing_get)
    result = agent.check_goal("цель", department_id="UCT")
    assert result["status"] == STATUS_ALLOWED and calls == ["цель"]
    assert not agent._flights  # полёт снят — следующие не ждут его вечно


# ------------------------------- N19 --------------------------------------


def test_prometheus_numbers_keep_precision(monkeypatch):
    monkeypatch.setattr(main.check_admission, "rejected", 1234567)
    text = main._prometheus()
    assert "goal_checker_single_checks_rejected_total 1234567\n" in text
    assert main._prometheus_number(0.123456789) == "0.123456789"
    assert main._prometheus_number(None) == "0" and main._prometheus_number(True) == "1"
    assert main._prometheus_number(float("inf")) == "+Inf"


# ------------------------------- N20 --------------------------------------


class _WatchedLock:
    """Замок, который после каждого отпускания вызывает проверку."""

    def __init__(self, check):
        self._lock = threading.Lock()
        self._check = check

    def __enter__(self):
        self._lock.acquire()
        return self

    def __exit__(self, *exc):
        self._lock.release()
        self._check()


def test_ttl_cache_load_never_leaves_key_unguarded():
    """Между снятием ключа из _loading и записью значения нет окна, когда
    ключа нет ни в кэше, ни среди вычисляемых: второй вызов модели невозможен (N20)."""
    cache = metrics.TtlCache(60, 10)
    state = {"loaded": False, "gaps": 0}

    def check():
        if state["loaded"] and "k" not in cache._items and "k" not in cache._loading:
            state["gaps"] += 1

    cache._lock = _WatchedLock(check)

    def loader():
        state["loaded"] = True
        return "значение"

    assert cache.load("k", loader) == "значение"
    assert state["gaps"] == 0 and cache.get("k") == "значение" and not cache._loading


def test_ttl_cache_load_failure_releases_key():
    cache = metrics.TtlCache(60, 10)
    with pytest.raises(RuntimeError):
        cache.load("k", lambda: (_ for _ in ()).throw(RuntimeError("сбой")))
    assert not cache._loading and cache.get("k") is None


# ------------------------------- N21 --------------------------------------


def test_duties_on_chunk_border_are_not_lost(monkeypatch):
    """Длинная инструкция делится по строкам и с перекрытием: обязанность на стыке
    приходит целиком, повторы из перекрытия убираются (N21)."""
    duties = [f"Обязанность номер {i}: готовит отчёт по участку {i} и согласует его" for i in range(900)]
    text = "\n".join(f"- {duty}" for duty in duties)
    assert len(text) > 2 * agent.DUTIES_CHUNK_CHARS
    prompts = []

    def ask(prompt, *args, **kwargs):
        prompts.append(prompt)
        found = [line[2:] for line in prompt.splitlines() if line.startswith("- Обязанность")]
        return json.dumps({"duties": found}, ensure_ascii=False)

    monkeypatch.setattr(agent, "ask_model", ask)
    assert agent.extract_duties(text) == duties
    assert len(prompts) >= 3


def test_duties_duplicates_differ_only_in_case_and_dot(monkeypatch):
    monkeypatch.setattr(agent, "ask_model", lambda *a, **k: json.dumps(
        {"duties": ["Готовит отчёт.", "готовит  отчёт", "Ведёт реестр"]}, ensure_ascii=False))
    assert agent.extract_duties("текст") == ["Готовит отчёт.", "Ведёт реестр"]


# ------------------------------- N22 --------------------------------------


def test_driver_is_created_once_under_concurrency(monkeypatch):
    from conftest import _REAL_GET_DRIVER
    created = []

    class FakeDriver:
        def close(self):
            pass

    def slow_driver(*args, **kwargs):
        time.sleep(0.05)
        created.append(FakeDriver())
        return created[-1]

    monkeypatch.setattr(graph.GraphDatabase, "driver", slow_driver)
    monkeypatch.setattr(graph, "_driver", None)
    out: list = []
    threads = [_in_thread(_REAL_GET_DRIVER, out) for _ in range(8)]
    for thread in threads:
        thread.join(5)
    assert len(created) == 1 and all(d is created[0] for d in out)


# ------------------------------- N25 --------------------------------------


def test_user_create_race_is_conflict(monkeypatch):
    """Запись с тем же логином успел завести параллельный запрос — 409, а не 500 (N25)."""
    def run(query, **params):
        if "CREATE (u:User" in query:
            raise ConstraintError("already exists with label `User` and property `login`")
        return []

    monkeypatch.setattr(users, "_run", run)
    with pytest.raises(users.Conflict):
        users.create("ivan", "viewer", None, "root")
    with pytest.raises(auth.HTTPException) as error:
        auth._handle(lambda: (_ for _ in ()).throw(ConstraintError("dup")))
    assert error.value.status_code == 409


class _KeyGraph:
    """Ключи в памяти; список читается медленно, CREATE с условием taken = 0 его соблюдает."""

    def __init__(self):
        self.keys: dict = {}

    def __call__(self, query, **params):
        if "CREATE (k:ApiKey" in query:
            if "taken = 0" in query and any(k["name"].lower() == params["name_key"]
                                            for k in self.keys.values()):
                return []
            self.keys[params["key_id"]] = {"keyId": params["key_id"], "name": params["name"]}
            return [{"props": self.keys[params["key_id"]]}]
        time.sleep(0.1)
        return [{"props": k, "name": k["name"]} for k in self.keys.values()]


def test_concurrent_api_keys_with_same_name(monkeypatch):
    """Два одновременных ключа с одним названием: создаётся один, второй — Conflict (N25)."""
    fake = _KeyGraph()
    monkeypatch.setattr(apikeys, "_run", fake)
    out: list = []
    threads = [_in_thread(lambda: apikeys.create("HR", "root"), out) for _ in range(2)]
    for thread in threads:
        thread.join(5)
    assert len(fake.keys) == 1
    assert sum(isinstance(r, apikeys.Conflict) for r in out) == 1


def test_api_key_created_elsewhere_meanwhile_is_conflict(monkeypatch):
    fake = _KeyGraph()
    monkeypatch.setattr(apikeys, "_run", lambda q, **p: [] if "CREATE" in q else fake(q, **p))
    with pytest.raises(apikeys.Conflict):
        apikeys.create("HR", "root")


# ------------------------------- N26 --------------------------------------


class _UserGraph:
    """Реестр в памяти с разбором запроса update: узел без роли, получивший роль, теряет sub."""

    def __init__(self):
        self.nodes = {"old": {"login": "old", "sub": "kc-old", "tourSeenAt": "2026-01-01"},
                      "ed": {"login": "ed", "role": "editor", "status": "active", "sub": "kc-ed"}}

    def __call__(self, query, **params):
        node = self.nodes.get(params.get("login"))
        if node is None:
            return []
        if "SET u += $props" in query:
            revived = node.get("role") is None and params["props"].get("role") is not None
            node.update(params["props"])
            if "REMOVE u.sub" in query and ("u.role IS NULL" not in query or revived):
                node.pop("sub", None)
            return [{"props": node}]
        return [{"props": node}]


def test_patch_role_of_roleless_node_drops_old_binding(monkeypatch):
    """Роль узлу без роли (бывший администратор) через PATCH снимает прежнюю привязку,
    как create; у обычной записи привязка остаётся (N26)."""
    fake = _UserGraph()
    monkeypatch.setattr(users, "_run", fake)
    assert users.update("old", {"role": "viewer"})["bound"] is False
    assert "sub" not in fake.nodes["old"]
    assert users.update("ed", {"displayName": "Редактор"})["bound"] is True
    assert users.update("ed", {"role": "viewer"})["bound"] is True
