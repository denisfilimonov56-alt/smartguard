"""Вход в API под нагрузкой: журнал аудита (M8), часы Keycloak (M10), срок пакета (M11),
допуск ручных проверок (M26) и /metrics (M4). Neo4j, модель и Keycloak подменяются."""

import json
import logging
import re
import threading
import time

import anyio
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

import agent
import apikeys
import audit
import auth
import diagnostics
import graph
import main
import metrics
import monitoring
import users

XHR = {"X-Requested-With": "XMLHttpRequest"}
ISSUER = "https://sso.corp.local/realms/goal-checker"
CLIENT = "goal-checker-web"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
SERVICE_KEY = "gc_0123abcd_" + "s" * 30


def token(login="root", **overrides):
    now = int(time.time())
    claims = {"iss": ISSUER, "aud": "account", "azp": CLIENT, "typ": "Bearer", "sub": "uuid-" + login,
              "sid": "sid-" + login, "preferred_username": login, "iat": now, "exp": now + 300}
    claims.update(overrides)
    return jwt.encode(claims, KEY, algorithm="RS256", headers={"kid": "realm-key"})


def bearer(value):
    return {**XHR, "Authorization": "Bearer " + value}


def audit_events(caplog):
    return [json.loads(r.getMessage()) for r in caplog.records if r.name == "audit"]


@pytest.fixture(autouse=True)
def fresh_counters():
    audit.flush_anonymous()
    yield
    audit.flush_anonymous()


@pytest.fixture
def app(monkeypatch):
    """root — администратор из AUTH_ADMIN_LOGINS; ключ SERVICE_KEY — внешняя система «hr»."""
    monkeypatch.setenv("KEYCLOAK_URL", "https://sso.corp.local")
    monkeypatch.setenv("KEYCLOAK_REALM", "goal-checker")
    monkeypatch.setenv("KEYCLOAK_CLIENT_ID", CLIENT)
    monkeypatch.setenv("AUTH_ADMIN_LOGINS", "root")
    monkeypatch.setattr(auth, "signing_key", lambda t: KEY.public_key())
    monkeypatch.setattr(users, "_run", lambda query, **params: [])
    monkeypatch.setattr(apikeys, "resolve", lambda t: {"name": "hr"} if t == SERVICE_KEY else None)
    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    monkeypatch.setattr(diagnostics, "collect", lambda: {"ready": True, "problems": [], "check_targets": 1})
    monkeypatch.setattr(monitoring, "llm_alive", lambda timeout=2: True)
    monkeypatch.setattr(main, "check_goal", lambda goal, department_id=None, is_student=None:
                        {"goal": goal, "status": "ALLOWED", "allowed": True})
    monkeypatch.setattr(auth, "_skew", {})
    return main.app


# ------------------------------ M8: журнал аудита ------------------------------


def test_anonymous_flood_is_counted_not_written(app, monkeypatch, caplog):
    """Поток запросов без входа с одного адреса: строк не больше предела, остальное — счётчиком."""
    clock = {"now": 1000.0}
    monkeypatch.setattr(audit, "_now", lambda: clock["now"])
    client = TestClient(app, headers=XHR)
    with caplog.at_level(logging.INFO, logger="audit"):
        for _ in range(30):
            client.post("/catalog/orders?q=" + "x" * 500, json={})
        client.get("/auth/me", headers={"Authorization": "Bearer not-a-jwt"})  # 401, не 403: не пишется
        TestClient(app, headers=bearer("a.b.c")).post("/catalog/orders", json={})
        clock["now"] += audit.ANONYMOUS_WINDOW
        audit.event("login_ok", login="root")
    events = audit_events(caplog)
    written = [e for e in events if e["event"] in ("request", "token_rejected")]
    assert len(written) == audit.ANONYMOUS_PER_MINUTE
    assert all(len(e.get("query", "")) <= audit.ANONYMOUS_QUERY_MAX for e in written)
    summary = [e for e in events if e["event"] == "anonymous_suppressed"]
    assert len(summary) == 1 and summary[0]["ip"] == "testclient"
    assert sum(summary[0]["counts"].values()) == 31 + 2 - audit.ANONYMOUS_PER_MINUTE


def test_signed_in_query_is_truncated(app, caplog):
    client = TestClient(app, headers=bearer(token()))
    with caplog.at_level(logging.INFO, logger="audit"):
        client.post("/auth/users?q=" + "x" * 20_000, json={})  # 422: вход есть, тело неверное
    request = [e for e in audit_events(caplog) if e["event"] == "request"]
    assert request and request[0]["login"] == "root"
    assert len(request[0]["query"]) == audit.QUERY_MAX


def test_key_check_and_failure_are_audited(app, monkeypatch, caplog):
    """Проверка по ключу и отказ — в журнале с источником api и именем ключа (13.1)."""
    client = TestClient(app, headers=bearer(SERVICE_KEY))
    with caplog.at_level(logging.INFO, logger="audit"):
        assert client.post("/check-goal", json={"goal": "цель"}).status_code == 200
        assert client.post("/catalog/orders", json={}).status_code == 403
    events = [e for e in audit_events(caplog) if e["event"] == "request"]
    assert [(e["path"], e["status"], e["result"], e["blocked"]) for e in events] == [
        ("/check-goal", 200, "success", False), ("/catalog/orders", 403, "denied", True)]
    assert all((e["login"], e["role"], e["source"], e["session_id"]) == ("key:hr", "service", "api", None)
               for e in events)
    assert "body" not in events[0], "текст цели в журнал не попадает"


def test_every_line_has_the_fields_of_13_1(app, caplog):
    """Все поля требования ИБ 13.1 есть в каждой строке, даже в отказах без входа."""
    with caplog.at_level(logging.INFO, logger="audit"):
        TestClient(app, headers=bearer(token(sid="s-root"))).get("/auth/me")
        TestClient(app, headers=XHR).post("/catalog/orders", json={})
    events = audit_events(caplog)
    assert {e["event"] for e in events} == {"login_ok", "request"}
    for e in events:
        assert set(audit.CORE_FIELDS) | {"ts", "event"} <= e.keys(), e
    login = next(e for e in events if e["event"] == "login_ok")
    assert (login["login"], login["role"], login["source"], login["session_id"], login["object"]) == (
        "root", "admin", "ui", "s-root", "session")
    anonymous = next(e for e in events if e["event"] == "request" and e["login"] is None)
    assert (anonymous["result"], anonymous["blocked"], anonymous["object"]) == ("denied", True, "/catalog/orders")


def test_request_id_comes_from_nginx_or_is_made(app, caplog):
    """X-Request-ID от nginx — в журнале и в ответе; чужого вида — заменяется своим."""
    client = TestClient(app, headers=bearer(token()))
    from_nginx = "0123456789abcdef0123456789abcdef"
    with caplog.at_level(logging.INFO, logger="audit"):
        first = client.get("/auth/me", headers={"X-Request-ID": from_nginx})
        second = client.get("/auth/me", headers={"X-Request-ID": "x; rm -rf"})
    assert first.headers["X-Request-ID"] == from_nginx
    assert re.fullmatch(r"[0-9a-f]{32}", second.headers["X-Request-ID"])
    ids = [e["request_id"] for e in audit_events(caplog) if e["event"] == "request"]
    assert ids == [from_nginx, second.headers["X-Request-ID"]]


def test_polling_is_not_audited_unless_it_fails(app, caplog):
    """Опрос мониторинга раз в 5 с не вытесняет действия; отказ в нём — в журнале."""
    client = TestClient(app, headers=bearer(token()))
    with caplog.at_level(logging.INFO, logger="audit"):
        assert client.get("/monitoring/now").status_code == 200
        assert TestClient(app, headers=bearer(SERVICE_KEY)).get("/monitoring/now").status_code == 403
    assert [(e["path"], e["status"]) for e in audit_events(caplog) if e["event"] == "request"] == [
        ("/monitoring/now", 403)]


def test_event_outside_a_request_is_from_the_system(caplog):
    with caplog.at_level(logging.INFO, logger="audit"):
        audit.event("settings_changed", object="settings")
    [e] = audit_events(caplog)
    assert (e["source"], e["login"], e["request_id"], e["result"], e["blocked"]) == (
        "system", None, None, "success", False)


def test_suppressed_summary_does_not_take_another_request(monkeypatch, caplog):
    """Итог по чужому адресу пишется во время другого запроса, но без его входа и идентификатора."""
    clock = [0.0]
    monkeypatch.setattr(audit, "_now", lambda: clock[0])
    with caplog.at_level(logging.INFO, logger="audit"):
        for _ in range(audit.ANONYMOUS_PER_MINUTE + 1):
            audit.anonymous("request", "10.0.0.9")
        clock[0] += audit.ANONYMOUS_WINDOW
        context = audit.begin(request_id="f" * 32, ip="10.0.0.1")
        audit.bind(login="ed", role="editor", source="ui")
        audit.event("logout", object="session")
        audit.end(context)
    summary = next(e for e in audit_events(caplog) if e["event"] == "anonymous_suppressed")
    assert (summary["ip"], summary["login"], summary["request_id"], summary["blocked"]) == (
        "10.0.0.9", None, None, True)


# ------------------------------ 13.1: отправка в SIEM ------------------------------


def _record(message, blocked=False):
    record = logging.LogRecord("audit", logging.INFO, __file__, 1, message, None, None)
    record.audit_blocked = blocked
    return record


def test_siem_gets_rfc5424_over_tcp_with_octet_counting():
    import socket as socketlib
    server = socketlib.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    sink = audit._SyslogSink(f"tcp://127.0.0.1:{server.getsockname()[1]}", hostname="ALB-PH-UCTLLM1")
    try:
        sink.emit(_record('{"event": "access_denied"}', blocked=True))
        conn, _ = server.accept()
        conn.settimeout(5)
        data = conn.recv(4096)
        conn.close()
    finally:
        sink.close()
        server.close()
    length, _, line = data.partition(b" ")
    assert int(length) == len(line)
    text = line.decode()
    # facility 13 (log audit) × 8 + severity 4 (warning) для заблокированного действия
    assert re.fullmatch(r'<108>1 \S+Z? ALB-PH-UCTLLM1 goal-checker - AUDIT - \{"event": "access_denied"\}',
                        text.replace("+00:00", "Z")), text


def test_siem_gets_plain_datagram_over_udp():
    import socket as socketlib
    server = socketlib.socket(socketlib.AF_INET, socketlib.SOCK_DGRAM)
    server.bind(("127.0.0.1", 0))
    server.settimeout(5)
    sink = audit._SyslogSink(f"udp://127.0.0.1:{server.getsockname()[1]}", hostname="h")
    try:
        sink.emit(_record('{"event": "login_ok"}'))
        data, _ = server.recvfrom(4096)
    finally:
        sink.close()
        server.close()
    assert data.startswith(b"<110>1 ") and data.endswith(b'AUDIT - {"event": "login_ok"}')


def test_unreachable_siem_drops_lines_with_an_error(caplog):
    import socket as socketlib
    probe = socketlib.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()   # порт свободен: соединение отвергается
    sink = audit._SyslogSink(f"tcp://127.0.0.1:{port}")
    with caplog.at_level(logging.ERROR, logger="audit_journal"):
        sink.emit(_record("{}"))
        sink.emit(_record("{}"))
    errors = [r.getMessage() for r in caplog.records if r.name == "audit_journal"]
    assert len(errors) == 1 and "не отправлено строк: 1" in errors[0], "ERROR не чаще раза в минуту"
    assert sink.lost == 1


def test_full_siem_queue_does_not_block_requests():
    sink = audit._SyslogSink("udp://127.0.0.1:9")
    handler = audit._SiemQueue(sink)
    for _ in range(audit.SIEM_QUEUE_SIZE + 3):
        handler.emit(_record("{}"))
    # Первая потеря ушла в ERROR (счётчик обнулён), две следующие ждут следующего ERROR.
    assert handler.queue.qsize() == audit.SIEM_QUEUE_SIZE and sink.lost == 2
    sink.close()


def test_bad_siem_url_is_reported_and_not_used(monkeypatch, caplog):
    monkeypatch.setenv("AUDIT_SYSLOG_URL", "http://siem:514")
    before = list(audit.log.handlers)
    with caplog.at_level(logging.ERROR):
        audit._setup_siem()
    assert audit.log.handlers == before
    assert any("AUDIT_SYSLOG_URL" in r.getMessage() for r in caplog.records)


def test_audit_volume_limit_keeps_history_and_raises_error(tmp_path, caplog):
    handler = audit._DailyOrSizeHandler(str(tmp_path / "audit.log"), when="midnight", backupCount=365,
                                        encoding="utf-8", utc=True, max_bytes=0, max_total_bytes=1)
    handler.setFormatter(logging.Formatter("%(message)s"))
    (tmp_path / "audit.log.2026-01-01").write_text("x" * 100, encoding="utf-8")
    logger = logging.getLogger("audit-volume-test")
    logger.propagate = False
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    try:
        with caplog.at_level(logging.ERROR, logger="audit_journal"):
            logger.info("anonymous", extra={"audit_noise": True})
            logger.info("user_created")
        handler.flush()
    finally:
        logger.removeHandler(handler)
        handler.close()
    assert (tmp_path / "audit.log").read_text(encoding="utf-8") == "user_created\n"
    assert (tmp_path / "audit.log.2026-01-01").exists(), "история не удаляется"
    assert any("AUDIT_MAX_TOTAL_MB" in r.getMessage() for r in caplog.records)


def test_old_audit_files_are_deleted_by_age(tmp_path):
    import os
    handler = audit._DailyOrSizeHandler(str(tmp_path / "audit.log"), when="midnight", backupCount=30,
                                        encoding="utf-8", utc=True, max_bytes=0)
    try:
        fresh, rotated, old = (tmp_path / n for n in ("audit.log.2026-10-21", "audit.log.2026-10-21.3",
                                                      "audit.log.2026-08-01"))
        for path in (fresh, rotated, old):
            path.write_text("{}\n", encoding="utf-8")
        long_ago = time.time() - 40 * 86400
        os.utime(old, (long_ago, long_ago))
        assert handler.getFilesToDelete() == [str(old)]
    finally:
        handler.close()


# ------------------------------ M10: часы Keycloak ------------------------------


def test_token_from_the_future_within_tolerance_is_accepted_and_reported(app, caplog):
    """Часы API отстали на 2 минуты: вход работает, в журнале и /ready — расхождение."""
    now = int(time.time())
    with caplog.at_level(logging.WARNING, logger="auth"), TestClient(app) as client:
        assert client.get("/auth/me", headers=bearer(token(iat=now + 120, nbf=now + 120))).status_code == 200
        ready = client.get("/ready").json()
    assert any(re.search(r"расходятся на 1[12]\d с \(часы API отстают\)", r.getMessage()) for r in caplog.records)
    assert 115 <= ready["clock_skew_seconds"] <= 125


def test_token_far_in_the_future_is_rejected(app):
    now = int(time.time())
    client = TestClient(app, headers=bearer(token(iat=now + auth.CLOCK_SKEW_MAX_SECONDS + 60)))
    assert client.get("/auth/me").status_code == 401


def test_expiry_is_still_strict(app):
    now = int(time.time())
    client = TestClient(app, headers=bearer(token(iat=now - 400, exp=now - auth.LEEWAY_SECONDS - 5)))
    assert client.get("/auth/me").status_code == 401


def test_first_token_expired_at_once_points_to_clocks(app, caplog):
    """API спешит: первый токен после входа (iat = auth_time) приходит уже истёкшим."""
    now = int(time.time())
    expired = token(iat=now - 400, auth_time=now - 400, exp=now - 100)
    with caplog.at_level(logging.WARNING, logger="auth"):
        assert TestClient(app, headers=bearer(expired)).get("/auth/me").status_code == 401
    assert any("часы API спешат" in r.getMessage() for r in caplog.records)
    assert auth.clock_skew() <= -395


def test_old_first_token_after_idle_is_not_clock_skew(app, caplog):
    """Вкладка простояла час: первый токен сессии давно просрочен — это не часы."""
    now = int(time.time())
    stale = token(iat=now - 4000, auth_time=now - 4000, exp=now - 3700)
    with caplog.at_level(logging.WARNING, logger="auth"):
        assert TestClient(app, headers=bearer(stale)).get("/auth/me").status_code == 401
    assert not any("часы API" in r.getMessage() for r in caplog.records)
    assert auth.clock_skew() is None


# ------------------------------ M11: срок пакета ------------------------------


def _items(n):
    return [{"goal": f"цель {i}", "department_id": "UCT", "id": str(i)} for i in range(n)]


def test_batch_without_cancel_hook_goes_in_chunks_and_stops(monkeypatch):
    stop = threading.Event()
    calls = []

    def fake(items):
        calls.append(len(items))
        stop.set()  # срок вышел, пока считалась первая часть
        return {"results": [{"id": i["id"], "goal": i["goal"], "status": "ALLOWED"} for i in items]}

    monkeypatch.setattr(main, "check_goals", fake)
    result = main._run_batch(_items(main.BULK_CHUNK + 3), stop)
    assert calls == [main.BULK_CHUNK]
    tail = result["results"][main.BULK_CHUNK:]
    assert [r["id"] for r in tail] == [str(i) for i in range(main.BULK_CHUNK, main.BULK_CHUNK + 3)]
    assert all(r["status"] == "NEEDS_MANUAL_REVIEW" and main.BULK_UNCHECKED_NOTE in r["notes"] for r in tail)
    assert result["summary"] == {"total": main.BULK_CHUNK + 3, "allowed": main.BULK_CHUNK,
                                 "violations": 0, "manual_review": 3}


def test_batch_deadline_answers_before_the_proxy_gives_up(app, monkeypatch):
    """Срок вышел: пакет получает отмену и отвечает, а место пакета освобождается."""
    seen = {}

    def fake(items, cancel=None):
        seen["stopped"] = cancel.wait(5)
        return {"results": [main._unchecked(i) for i in items], "summary": main._summary([])}

    monkeypatch.setattr(main, "check_goals", fake)
    monkeypatch.setattr(main, "BULK_DEADLINE_SECONDS", 0.2)
    monkeypatch.setattr(main, "BULK_WATCH_SECONDS", 0.05)
    client = TestClient(app, headers=bearer(token()))
    started = time.monotonic()
    response = client.post("/check-goals", json=_items(2))
    assert response.status_code == 200 and seen["stopped"] and time.monotonic() - started < 3
    assert main._bulk_requests.acquire(blocking=False)
    main._bulk_requests.release()


def test_default_deadline_leaves_room_for_request_in_flight():
    """Остановленный по сроку пакет дожидается одного запроса в полёте и всё равно
    отвечает раньше proxy_read_timeout nginx."""
    worst = main._BULK_DEADLINE_DEFAULT + agent.LLM_TIMEOUT + agent.LLM_CONNECT_TIMEOUT
    assert worst < main.PROXY_READ_TIMEOUT_SECONDS


def test_unchecked_goals_return_their_quota(app, monkeypatch):
    """Цели, которые пакет не проверил, клиент отправит снова: квота за них возвращается."""
    monkeypatch.setattr(main.settings, "number",
                        lambda name, real=main.settings.number: 3 if name == "checkRatePerMinute" else real(name))

    calls = []

    def fake(items, cancel=None):
        # Первый пакет остановлен после первой цели, дальше — проверено всё.
        done = 1 if not calls else len(items)
        calls.append(items)
        return {"results": [{"id": i["id"], "goal": i["goal"], "status": "ALLOWED"} for i in items[:done]]
                + [main._unchecked(i) for i in items[done:]], "summary": main._summary([])}

    monkeypatch.setattr(main, "check_goals", fake)
    client = TestClient(app, headers=bearer(token()))
    rows = client.post("/check-goals", json=_items(3)).json()["results"]
    assert [bool(r.get("unchecked")) for r in rows] == [False, True, True]
    # Списана одна цель из трёх: ещё две проходят, третья — уже сверх лимита.
    assert client.post("/check-goals", json=_items(2)).status_code == 200
    assert client.post("/check-goals", json=_items(1)).status_code == 429


def test_rate_limit_refund_takes_latest_spending():
    limit = auth.RateLimit()
    assert limit.take("u", 2, 5) == 0 and limit.take("u", 3, 5) == 0
    limit.refund("u", 4)
    assert limit.take("u", 4, 5) == 0 and limit.take("u", 1, 5) > 0


def test_batch_errors_still_reach_the_client(app, monkeypatch):
    monkeypatch.setattr(main, "_bulk_requests", threading.BoundedSemaphore(1))
    assert main._bulk_requests.acquire(blocking=False)
    try:
        response = TestClient(app, headers=bearer(token())).post("/check-goals", json=_items(1))
    finally:
        main._bulk_requests.release()
    assert response.status_code == 503 and response.headers["Retry-After"] == "30"


def test_client_disconnect_stops_the_batch(monkeypatch):
    monkeypatch.setattr(main, "BULK_WATCH_SECONDS", 0.01)
    stop = threading.Event()

    class Gone:
        async def is_disconnected(self):
            return True

    async def scenario():
        return await main._until_done(Gone(), lambda: stop.wait(5), stop)

    assert anyio.run(scenario) is True


# ------------------------------ M26: допуск ручных проверок ------------------------------


def test_single_checks_over_the_limit_get_503_before_a_thread(app, monkeypatch):
    monkeypatch.setattr(main.check_admission, "limit", 1)
    monkeypatch.setattr(main.check_admission, "key_limit", 1)
    client = TestClient(app, headers=bearer(token()))
    assert main.check_admission.enter(False)
    try:
        response = client.post("/check-goal", json={"goal": "цель"})
        assert response.status_code == 503 and response.headers["Retry-After"] == "10"
    finally:
        main.check_admission.leave(False)
    assert client.post("/check-goal", json={"goal": "цель"}).status_code == 200
    assert main.check_admission.total == 0, "место освобождается после ответа"


def test_keys_do_not_take_the_interactive_reserve(app, monkeypatch):
    monkeypatch.setattr(main.check_admission, "limit", 3)
    monkeypatch.setattr(main.check_admission, "key_limit", 1)
    assert main.check_admission.enter(True)
    try:
        assert TestClient(app, headers=bearer(SERVICE_KEY)).post(
            "/check-goal", json={"goal": "цель"}).status_code == 503
        assert TestClient(app, headers=bearer(token())).post(
            "/check-goal", json={"goal": "цель"}).status_code == 200
    finally:
        main.check_admission.leave(True)


def test_admission_limit_follows_model_capacity(monkeypatch):
    monkeypatch.delenv("CHECK_MAX_PENDING", raising=False)
    monkeypatch.setattr(metrics.gate, "limits", lambda fresh=False: (10, 2))
    main.check_admission.refresh()
    assert (main.check_admission.limit, main.check_admission.key_limit) == (20, 16)
    monkeypatch.setenv("CHECK_MAX_PENDING", "7")
    main.check_admission.refresh()
    assert main.check_admission.limit == 7


def test_single_check_runs_outside_the_shared_thread_pool(app):
    import inspect
    assert inspect.iscoroutinefunction(main.check) and inspect.iscoroutinefunction(main.check_many)
    with TestClient(app):
        assert main.app.state.check_limiter.total_tokens >= main.check_admission.limit


# ------------------------------ M4: /metrics ------------------------------


def test_metrics_in_prometheus_format(app, monkeypatch):
    monkeypatch.setattr(agent._breakers["bulk"], "until", time.monotonic() + 60)
    with metrics.check() as done:
        done({"status": "NEEDS_MANUAL_REVIEW"}, False)
    with metrics.check() as done:
        done({"status": "ALLOWED"}, False)
    response = TestClient(app).get("/metrics")
    assert response.status_code == 200 and response.headers["content-type"].startswith("text/plain")
    text = response.text
    assert "# TYPE goal_checker_llm_waiting gauge" in text
    assert "goal_checker_recent_manual_review_ratio 0.5" in text
    assert 'goal_checker_llm_breaker_open{kind="bulk"} 1' in text
    assert 'goal_checker_llm_breaker_open{kind="single"} 0' in text
    assert "goal_checker_history_pending 0" in text
