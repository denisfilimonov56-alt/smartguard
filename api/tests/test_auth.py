"""Токены Keycloak, роли и защита маршрутов. Neo4j и Keycloak подменяются."""

import json
import logging
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi.testclient import TestClient

import apikeys
import audit
import auth
import catalog
import diagnostics
import graph
import main
import users

XHR = {"X-Requested-With": "XMLHttpRequest"}
ISSUER = "https://sso.corp.local/realms/goal-checker"
CLIENT = "goal-checker-web"
# Маршруты, открытые без входа: всё остальное обязано отвечать 401.
PUBLIC = {"/health", "/ready", "/auth/config"}

REALM_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
STRANGER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
# Настоящая проверка ключа: фикстура keycloak её подменяет, тесты JWKS возвращают.
real_signing_key = auth.signing_key


def token_for(login, *, key=REALM_KEY, sid="sid-1", kid="realm-key", headers=None, **overrides):
    """Access-токен, каким его выдаёт Keycloak нашему клиенту; overrides правят утверждения."""
    now = int(time.time())
    claims = {
        "iss": ISSUER, "aud": "account", "azp": CLIENT, "typ": "Bearer",
        "sub": "uuid-" + login, "sid": sid, "preferred_username": login,
        "iat": now, "exp": now + 300,
    }
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, key, algorithm="RS256", headers=headers if headers is not None else {"kid": kid})


def bearer(token):
    return {**XHR, "Authorization": "Bearer " + token}


class FakeRegistry:
    """Подмена users._run: реестр в памяти, разбор по тексту запроса."""

    def __init__(self):
        self.nodes: dict = {}

    def __call__(self, query, **params):
        login = params.get("login")
        if "u.sub = coalesce" in query:
            if login not in self.nodes:
                if not query.lstrip().startswith("MERGE"):
                    return []
                self.nodes[login] = {"login": login}
            before = self.nodes[login].get("sub")
            self.nodes[login]["sub"] = before or params["sub"]
            return [{"before": before}]
        if "REMOVE u.sub" in query and "SET u += $props" not in query:
            if login not in self.nodes:
                return []
            self.nodes[login].pop("sub", None)
            return [{"props": self.nodes[login]}]
        if "CREATE (u:User" in query:
            self.nodes[login] = {
                "login": login, "role": params["role"], "status": params["status"],
                "displayName": params["display_name"], "createdAt": params["now"],
                "createdBy": params["created_by"],
            }
            return [{"props": self.nodes[login]}]
        if "DETACH DELETE" in query:
            return [{"login": login}] if self.nodes.pop(login, None) else []
        if "SET u += $props" in query:
            if login not in self.nodes:
                return []
            self.nodes[login].update(params["props"])
            if "REMOVE u.sub" in query:
                self.nodes[login].pop("sub", None)
            return [{"props": self.nodes[login]}]
        if "lastLoginAt" in query:
            if login in self.nodes:
                self.nodes[login]["lastLoginAt"] = params["now"]
            return []
        if "tourSeenAt" in query:
            self.nodes.setdefault(login, {"login": login})["tourSeenAt"] = params["now"]
            return []
        if "{login: $login}" in query:
            return [{"props": self.nodes[login]}] if login in self.nodes else []
        return [{"props": n, "login": n["login"]} for _, n in sorted(self.nodes.items())]


@pytest.fixture
def registry(monkeypatch):
    fake = FakeRegistry()
    monkeypatch.setattr(users, "_run", fake)
    return fake


@pytest.fixture
def keycloak(monkeypatch):
    """Keycloak подменён: ключ realm-а известен тесту, в сеть за JWKS никто не ходит."""
    monkeypatch.setenv("KEYCLOAK_URL", "https://sso.corp.local")
    monkeypatch.setenv("KEYCLOAK_REALM", "goal-checker")
    monkeypatch.setenv("KEYCLOAK_CLIENT_ID", CLIENT)
    monkeypatch.delenv("KEYCLOAK_INTERNAL_URL", raising=False)
    monkeypatch.setattr(auth, "signing_key", lambda token: REALM_KEY.public_key())


@pytest.fixture
def app(monkeypatch, registry, keycloak):
    """Приложение с тремя учётками разных ролей: root из AUTH_ADMIN_LOGINS, ed и vi из реестра."""
    monkeypatch.setenv("AUTH_ADMIN_LOGINS", "root")
    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    monkeypatch.setattr(diagnostics, "collect", lambda: {"ready": True, "problems": [], "check_targets": 1})
    monkeypatch.setattr(catalog, "build_tree", lambda inc: {"orders": []})
    monkeypatch.setattr(catalog, "create_department", lambda i, n: {"nodeId": "4:db:9", "departmentId": i})
    monkeypatch.setattr(catalog, "delete_node", lambda node_id, cascade, force: {"deleted": node_id})
    monkeypatch.setattr(catalog, "repair_identifiers", lambda: {"orders": 0})
    monkeypatch.setattr(main, "check_goal", lambda goal, department_id=None, is_student=None: {"allowed": True})
    monkeypatch.setattr(apikeys, "resolve", lambda token: None)
    users.create("ed", "editor", "Редактор", "root")
    users.create("vi", "viewer", None, "root")
    return main.app


def client_for(app, login=None, **token_overrides):
    headers = bearer(token_for(login, **token_overrides)) if login else XHR
    return TestClient(app, headers=headers)


# ------------------------------ без входа ----------------------------------


def test_every_route_requires_a_token(app):
    """Новый маршрут, забытый без проверки прав, должен уронить этот тест."""
    client = client_for(app)
    checked = 0
    for route in app.routes:
        methods = getattr(route, "methods", None)
        if not methods or route.path in PUBLIC:
            continue
        path = route.path.replace("{node_id}", "4:db:1").replace("{login}", "someone")
        for method in methods - {"HEAD", "OPTIONS"}:
            response = client.request(method, path, json={})
            assert response.status_code == 401, f"{method} {route.path} открыт без входа"
            assert response.json()["detail"] == auth.LOGIN_REQUIRED
            checked += 1
    assert checked > 25


def test_swagger_is_off_by_default(app):
    client = client_for(app)
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_health_stays_public(app):
    assert client_for(app).get("/health").json() == {"status": "ok"}


def test_config_tells_the_ui_where_to_log_in(app):
    """Без входа — иначе интерфейсу неоткуда узнать адрес Keycloak. Секретов в ответе нет."""
    response = client_for(app).get("/auth/config")
    assert response.status_code == 200
    assert response.json() == {"issuer": ISSUER, "clientId": CLIENT}
    assert response.headers["cache-control"] == "no-store"


def test_config_is_503_when_keycloak_is_not_configured(app, monkeypatch):
    monkeypatch.delenv("KEYCLOAK_URL")
    assert client_for(app).get("/auth/config").status_code == 503


def test_unsafe_request_without_marker_header_is_rejected(app):
    """Чужая страница не может поставить свой заголовок — так отсекается CSRF."""
    client = client_for(app, "root")
    client.headers.pop("X-Requested-With")
    client.headers.pop("Authorization")
    response = client.post("/catalog/departments", json={"departmentId": "UCT", "name": "УЦТ"})
    assert response.status_code == 403
    assert "X-Requested-With" in response.json()["detail"]


# --------------------------------- токен -----------------------------------


def test_me_reports_role_from_registry(app):
    response = client_for(app, "ed").get("/auth/me")
    assert response.status_code == 200
    assert response.json() == {"login": "ed", "role": "editor", "displayName": "Редактор", "tourSeenAt": None,
                               "limits": {"maxGoalsPerRequest": 200, "goalMaxChars": 4000}}
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers, "сессий и cookie у API нет"


def test_me_reports_request_limits_from_environment(app, monkeypatch):
    """Интерфейс режет пакет по пределу API, а не по своему числу."""
    monkeypatch.setenv("MAX_GOALS_PER_REQUEST", "20")
    assert client_for(app, "ed").get("/auth/me").json()["limits"]["maxGoalsPerRequest"] == 20


def test_login_in_token_is_normalized(app):
    assert client_for(app, "Root ").get("/auth/me").json()["login"] == "root"


def test_token_of_our_client_in_aud_is_accepted(app):
    """Если в Keycloak настроен audience mapper, клиент стоит в aud, а azp может быть другим."""
    client = client_for(app, "ed", aud=[CLIENT, "account"], azp="other-app")
    assert client.get("/auth/me").status_code == 200


@pytest.mark.parametrize("overrides,why", [
    ({"key": STRANGER_KEY}, "подпись чужим ключом"),
    ({"iss": "https://sso.corp.local/realms/other"}, "другой realm"),
    ({"exp": int(time.time()) - 120}, "срок истёк"),
    ({"typ": "Refresh"}, "refresh-токен вместо access"),
    ({"exp": None}, "без срока"),
])
def test_bad_tokens_are_rejected(app, overrides, why):
    response = client_for(app, "root", **overrides).get("/auth/me")
    assert response.status_code == 401, why
    assert response.json()["detail"] == auth.LOGIN_REQUIRED


@pytest.mark.parametrize("overrides,detail", [
    ({"azp": "other-app"}, auth.WRONG_CLIENT),
    ({"preferred_username": "ro*ot)(uid=*"}, auth.BAD_LOGIN),
    ({"preferred_username": None}, auth.BAD_LOGIN),
])
def test_genuine_token_that_cannot_enter_is_403_with_reason(app, overrides, detail, caplog):
    """Подлинный токен: повторный вход в Keycloak выдаст такой же, поэтому 403 с причиной, а не 401."""
    with caplog.at_level(logging.INFO, logger="audit"):
        response = client_for(app, "root", **overrides).get("/auth/me")
    assert response.status_code == 403
    assert response.json()["detail"] == detail
    assert [e["event"] for e in audit_events(caplog) if e["event"] != "request"] == ["access_denied"]


def test_garbage_bearer_is_401(app):
    assert TestClient(app, headers=bearer("not-a-token")).get("/auth/me").status_code == 401
    assert TestClient(app, headers=bearer("gc_0123abcd_" + "x" * 30)).get("/auth/me").status_code == 401


def test_clock_skew_is_tolerated(app):
    """Часы API могут отставать от Keycloak на секунды: только что выданный токен не отвергается."""
    now = int(time.time())
    client = client_for(app, "root", iat=now + 10, nbf=now + 10)
    assert client.get("/auth/me").status_code == 200


@pytest.mark.parametrize("login,why", [
    ("ghost", "токен верный, но роли в реестре нет"),
    ("blocked", "заблокирован администратором"),
])
def test_unregistered_user_is_403_not_401(app, login, why):
    """401 отправил бы интерфейс снова в Keycloak, где вход пройдёт — и так по кругу."""
    users.create("blocked", "viewer", None, "root")
    users.update("blocked", {"status": "blocked"})
    response = client_for(app, login).get("/auth/me")
    assert response.status_code == 403, why
    assert response.json()["detail"] == auth.ACCESS_DENIED


def test_keycloak_outage_is_503_not_401(app, monkeypatch):
    def down(token):
        raise auth.DirectoryUnavailable("timeout")

    monkeypatch.setattr(auth, "signing_key", down)
    assert client_for(app, "root").get("/auth/me").status_code == 503


def test_keycloak_must_be_configured(app, monkeypatch):
    monkeypatch.delenv("KEYCLOAK_CLIENT_ID")
    assert client_for(app, "root").get("/auth/me").status_code == 503


def test_jwks_is_read_from_internal_url(monkeypatch, keycloak):
    """Внутри docker API идёт за ключами по KEYCLOAK_INTERNAL_URL, а издателем остаётся публичный адрес."""
    monkeypatch.setenv("KEYCLOAK_INTERNAL_URL", "http://keycloak:8080/")
    assert auth.realm_url(internal=True) == "http://keycloak:8080/realms/goal-checker"
    assert auth.realm_url() == ISSUER


# ---------------------------------- JWKS -----------------------------------


def jwk(key, kid):
    return {**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key())), "kid": kid,
            "use": "sig", "alg": "RS256"}


@pytest.fixture
def jwks(monkeypatch, keycloak):
    """Настоящая signing_key и свой кэш ключей; JWKS realm-а отдаёт подмена, часы — тест.

    state["keys"] — что сейчас отдаёт Keycloak, state["error"] — чем он падает,
    state["fetches"] — сколько раз за ключами ходили.
    """
    state = {"keys": [jwk(REALM_KEY, "realm-key")], "error": None, "fetches": 0, "now": 1000.0}

    def get_jwk_set(self, refresh=False):
        state["fetches"] += 1
        if state["error"]:
            raise state["error"]
        return jwt.PyJWKSet.from_dict({"keys": state["keys"]})

    monkeypatch.setattr(auth, "signing_key", real_signing_key)
    monkeypatch.setattr(jwt.PyJWKClient, "get_jwk_set", get_jwk_set)
    monkeypatch.setattr(auth, "_now", lambda: state["now"])
    auth.forget_keys()
    yield state
    auth.forget_keys()


def test_known_kid_is_served_from_memory(jwks):
    for _ in range(5):
        assert auth.verify_token(token_for("root"))["preferred_username"] == "root"
    assert jwks["fetches"] == 1


def test_unknown_kids_do_not_flood_keycloak(jwks):
    """Токены с выдуманным kid: за ключами — не чаще раза в JWKS_REFRESH_INTERVAL_SECONDS."""
    auth.signing_key(token_for("root"))
    for n in range(50):
        # Перечитывать рано: 503, а не 401 — это мог быть новый ключ ротации,
        # и пользователя с живой сессией выбрасывать нельзя.
        with pytest.raises(auth.DirectoryUnavailable):
            auth.signing_key(token_for("root", kid=f"bogus-{n}"))
    assert jwks["fetches"] == 1, "ключи только что прочитаны — внеочередное чтение рано"
    jwks["now"] += auth.JWKS_REFRESH_INTERVAL_SECONDS
    # Набор перечитан, а такого kid в нём нет — это уже 401.
    with pytest.raises(auth.TokenInvalid):
        auth.signing_key(token_for("root", kid="again-0"))
    for n in range(1, 50):
        with pytest.raises(auth.DirectoryUnavailable):
            auth.signing_key(token_for("root", kid=f"again-{n}"))
    assert jwks["fetches"] == 2, "одно внеочередное чтение на интервал"


def test_algorithm_not_matching_key_type_is_401_not_500(jwks):
    """ES256 с kid RSA-ключа realm-а: подделка — 401, а не TypeError и 500."""
    forged = jwt.encode({"sub": "x", "iss": ISSUER, "exp": int(time.time()) + 60, "iat": int(time.time())},
                        ec.generate_private_key(ec.SECP256R1()), algorithm="ES256",
                        headers={"kid": "realm-key"})
    with pytest.raises(auth.TokenInvalid):
        auth.verify_token(forged)


def test_rotated_key_is_accepted_after_refresh_interval(jwks):
    """Новый ключ ротации в окне запрета перечитывания — 503 (сессия не теряется), затем принимается."""
    auth.signing_key(token_for("root"))
    jwks["keys"] = [jwks["keys"][0], jwk(STRANGER_KEY, "new-key")]
    jwks["now"] += 3
    with pytest.raises(auth.DirectoryUnavailable):
        auth.signing_key(token_for("root", key=STRANGER_KEY, kid="new-key"))
    jwks["now"] += auth.JWKS_REFRESH_INTERVAL_SECONDS
    auth.signing_key(token_for("root", key=STRANGER_KEY, kid="new-key"))


@pytest.mark.parametrize("headers,why", [
    ({}, "без kid"),
    ({"kid": "k" * (auth.KID_MAX + 1)}, "kid длиннее предела"),
])
def test_bad_headers_are_rejected_before_keycloak(jwks, headers, why):
    with pytest.raises(auth.TokenInvalid):
        auth.signing_key(token_for("root", headers=headers))
    assert jwks["fetches"] == 0, why


def test_foreign_algorithm_is_rejected_before_keycloak(jwks):
    forged = jwt.encode({"sub": "x"}, "secret-of-length-32-bytes-at-least!", algorithm="HS256",
                        headers={"kid": "realm-key"})
    with pytest.raises(auth.TokenInvalid):
        auth.signing_key(forged)
    assert jwks["fetches"] == 0


def test_rotated_out_key_stops_working(jwks):
    """Ключ, удалённый из realm-а, не живёт до перезапуска API."""
    auth.signing_key(token_for("root"))
    jwks["keys"] = [jwk(STRANGER_KEY, "new-key")]
    jwks["now"] += auth.JWKS_LIFESPAN_SECONDS
    with pytest.raises(auth.TokenInvalid):
        auth.signing_key(token_for("root"))
    assert auth.signing_key(token_for("root", key=STRANGER_KEY, kid="new-key"))


@pytest.mark.parametrize("error", [
    jwt.exceptions.PyJWKClientConnectionError("refused"),
    json.JSONDecodeError("Expecting value", "<html>", 0),
    jwt.exceptions.PyJWKSetError("no usable keys"),
    ConnectionResetError("reset"),
])
def test_jwks_failures_are_unavailable_not_invalid_token(jwks, error):
    jwks["error"] = error
    with pytest.raises(auth.DirectoryUnavailable):
        auth.signing_key(token_for("root"))
    with pytest.raises(auth.DirectoryUnavailable):
        auth.signing_key(token_for("root"))
    assert jwks["fetches"] == 1, "после сбоя Keycloak не дёргают на каждый запрос"


def test_known_keys_serve_while_keycloak_is_down(jwks):
    auth.signing_key(token_for("root"))
    jwks["error"] = jwt.exceptions.PyJWKClientConnectionError("refused")
    jwks["now"] += auth.JWKS_LIFESPAN_SECONDS
    assert auth.signing_key(token_for("root"))
    assert auth.signing_key(token_for("root")) and jwks["fetches"] == 2


def test_rejection_reason_is_short_and_has_no_kid(app, jwks, caplog):
    """Строку журнала без входа может написать кто угодно: kid в неё не попадает, длина ограничена."""
    with caplog.at_level(logging.INFO, logger="audit"):
        client_for(app, "root", kid="x" * 120 + "MARK").get("/auth/me")
        client_for(app, "root", kid="y" * 5000).get("/auth/me")
    events = audit_events(caplog)
    assert [e["event"] for e in events] == ["token_rejected", "token_rejected"]
    assert all(len(e["reason"]) <= auth.REASON_MAX and "MARK" not in e["reason"] for e in events)


def test_config_warns_about_plain_http_and_missing_ca(monkeypatch, caplog, tmp_path):
    monkeypatch.setenv("KEYCLOAK_URL", "https://sso.corp.local")
    monkeypatch.setenv("KEYCLOAK_REALM", "goal-checker")
    monkeypatch.setenv("KEYCLOAK_CLIENT_ID", CLIENT)
    monkeypatch.setenv("AUTH_ADMIN_LOGINS", "root")
    monkeypatch.setenv("KEYCLOAK_INTERNAL_URL", "http://keycloak:8080")
    monkeypatch.delenv("KEYCLOAK_CA_FILE", raising=False)
    with caplog.at_level(logging.WARNING, logger="auth"):
        auth.check_config()
    assert not caplog.records, "имя сервиса docker — трафик внутри сети compose"
    monkeypatch.setenv("KEYCLOAK_INTERNAL_URL", "http://sso.corp.local:8080")
    monkeypatch.setenv("KEYCLOAK_CA_FILE", str(tmp_path / "нет.pem"))
    with caplog.at_level(logging.WARNING, logger="auth"):
        auth.check_config()
    text = " ".join(r.getMessage() for r in caplog.records)
    assert "KEYCLOAK_INTERNAL_URL" in text and "KEYCLOAK_CA_FILE" in text


# --------------------------------- входы -----------------------------------


def audit_events(caplog):
    return [json.loads(r.getMessage()) for r in caplog.records if r.name == "audit"]


def test_first_request_of_a_keycloak_session_counts_as_login(app, registry, caplog):
    """Вход виден в журнале и в «последнем входе», но считается по сессии, а не по каждому токену."""
    with caplog.at_level(logging.INFO, logger="audit"):
        client = client_for(app, "ed", sid="s-1")
        assert client.get("/auth/me").status_code == 200
        assert client.get("/auth/me").status_code == 200
        assert client_for(app, "ed", sid="s-1").get("/auth/me").status_code == 200   # обновлённый токен
        assert client_for(app, "ed", sid="s-2").get("/auth/me").status_code == 200   # новый вход
    assert [(e["event"], e["login"]) for e in audit_events(caplog)] == [("login_ok", "ed"), ("login_ok", "ed")]
    assert registry.nodes["ed"]["lastLoginAt"]


def test_logout_is_only_an_audit_mark(app, caplog):
    with caplog.at_level(logging.INFO, logger="audit"):
        assert client_for(app, "root").post("/auth/logout").status_code == 204
    assert "logout" in [e["event"] for e in audit_events(caplog)]


def test_tour_is_marked_once_per_user(app, registry):
    """Обучение по интерфейсу показывается до первой отметки — на любом компьютере."""
    client = client_for(app, "ed")
    assert client.get("/auth/me").json()["tourSeenAt"] is None
    seen = client.post("/auth/me/tour").json()["tourSeenAt"]
    assert seen
    assert client.get("/auth/me").json()["tourSeenAt"] == seen
    assert client_for(app, "ed", sid="other").get("/auth/me").json()["tourSeenAt"] == seen
    assert registry.nodes["ed"]["role"] == "editor", "отметка не трогает роль"


def test_tour_mark_does_not_grant_builtin_admin_a_role(app, registry):
    """У администратора из AUTH_ADMIN_LOGINS узла в реестре нет: отметка создаёт его без роли."""
    client = client_for(app, "root")
    assert client.get("/auth/me").json()["tourSeenAt"] is None
    assert client.post("/auth/me/tour").status_code == 200
    assert client.get("/auth/me").json()["tourSeenAt"]
    assert "role" not in registry.nodes["root"]
    # В списке пользователей он по-прежнему администратор из настроек сервера, а не из реестра.
    listed = {u["login"]: u for u in client.get("/auth/users").json()["users"]}
    assert listed["root"]["builtin"] and listed["root"]["role"] == "admin"


# ------------------------- привязка к учётной записи -----------------------


def test_registry_entry_is_bound_to_keycloak_account(app, registry, caplog):
    """Логин в каталоге отдали другому человеку: роль прежнего владельца к нему не переходит."""
    assert client_for(app, "ed").get("/auth/me").status_code == 200
    assert registry.nodes["ed"]["sub"] == "uuid-ed"
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="audit"):
        response = client_for(app, "ed", sub="uuid-new-owner", sid="s-9").get("/auth/me")
    assert response.status_code == 403
    assert response.json()["detail"] == auth.SUB_MISMATCH
    assert [(e["event"], e["login"], e["sub"]) for e in audit_events(caplog) if e["event"] != "request"] == [
        ("login_sub_mismatch", "ed", "uuid-new-owner")]
    assert client_for(app, "ed").get("/auth/me").status_code == 200, "прежний владелец входит как раньше"


def test_unbinding_lets_the_next_login_bind_again(app, registry, caplog):
    client_for(app, "ed").get("/auth/me")
    admin = client_for(app, "root")
    with caplog.at_level(logging.INFO, logger="audit"):
        response = admin.delete("/auth/users/ed/binding")
    assert response.status_code == 200 and response.json()["bound"] is False
    assert "user_unbound" in [e["event"] for e in audit_events(caplog)]
    assert client_for(app, "ed", sub="uuid-recreated").get("/auth/me").status_code == 200
    assert registry.nodes["ed"]["sub"] == "uuid-recreated"
    assert admin.delete("/auth/users/nobody/binding").status_code == 404


def test_builtin_admin_is_bound_too(app, registry):
    assert client_for(app, "root").get("/auth/me").status_code == 200
    assert registry.nodes["root"]["sub"] == "uuid-root"
    assert "role" not in registry.nodes["root"], "узел без роли — только привязка и отметки"
    response = client_for(app, "root", sub="uuid-impostor").get("/auth/me")
    assert response.status_code == 403 and response.json()["detail"] == auth.SUB_MISMATCH
    listed = {u["login"]: u for u in client_for(app, "root").get("/auth/users").json()["users"]}
    assert listed["root"]["bound"] is True and "sub" not in listed["root"]


def test_former_builtin_admin_node_can_be_taken_over(app, registry, monkeypatch):
    """Логин убрали из AUTH_ADMIN_LOGINS: его узел — «доступ не назначен», и роль ему можно выдать."""
    users.create("boss", "admin", None, "root")
    client_for(app, "root").get("/auth/me")
    client_for(app, "root").post("/auth/me/tour")
    monkeypatch.setenv("AUTH_ADMIN_LOGINS", "boss")
    boss = client_for(app, "boss")
    listed = {u["login"]: u for u in boss.get("/auth/users").json()["users"]}
    assert listed["root"]["role"] is None and listed["root"]["status"] is None
    assert client_for(app, "root").get("/auth/me").status_code == 403
    created = boss.post("/auth/users", json={"login": "root", "role": "viewer"})
    assert created.status_code == 201 and created.json()["role"] == "viewer"
    # Отметки остаются, а привязку к учётной записи Keycloak роль не наследует:
    # запись привяжется заново к тому, кто войдёт первым.
    assert registry.nodes["root"]["tourSeenAt"] and "sub" not in registry.nodes["root"]
    assert client_for(app, "root").get("/auth/me").json()["role"] == "viewer"
    assert registry.nodes["root"]["sub"] == "uuid-root"


# --------------------------------- роли ------------------------------------

DEPARTMENT = {"departmentId": "UCT", "name": "УЦТ"}


@pytest.mark.parametrize("login,read,check,edit,delete,repair,manage", [
    ("vi", 200, 200, 403, 403, 403, 403),
    ("ed", 200, 200, 201, 403, 403, 403),
    ("root", 200, 200, 201, 200, 200, 200),
])
def test_role_matrix(app, login, read, check, edit, delete, repair, manage):
    client = client_for(app, login)
    assert client.get("/catalog/tree").status_code == read
    assert client.post("/check-goal", json={"goal": "цель"}).status_code == check
    assert client.post("/catalog/departments", json=DEPARTMENT).status_code == edit
    assert client.request("DELETE", "/catalog/nodes/4:db:1").status_code == delete
    assert client.post("/catalog/repair-identifiers").status_code == repair
    assert client.get("/auth/users").status_code == manage


def test_role_change_applies_to_live_token(app):
    client = client_for(app, "vi")
    assert client.post("/catalog/departments", json=DEPARTMENT).status_code == 403
    users.update("vi", {"role": "editor"})
    assert client.post("/catalog/departments", json=DEPARTMENT).status_code == 201


def test_blocking_applies_to_live_token(app):
    """Токен Keycloak ещё действует, но доступ закрыт со следующего же запроса."""
    victim = client_for(app, "ed")
    assert victim.get("/auth/me").status_code == 200
    admin = client_for(app, "root")
    assert admin.patch("/auth/users/ed", json={"status": "blocked"}).status_code == 200
    assert victim.get("/auth/me").status_code == 403
    assert admin.delete("/auth/users/ed").status_code == 200
    assert victim.get("/auth/me").status_code == 403


# ----------------------------- пользователи --------------------------------


def test_user_lifecycle(app):
    admin = client_for(app, "root")
    created = admin.post("/auth/users", json={"login": "New.User", "role": "viewer", "displayName": " Новый "})
    assert created.status_code == 201
    assert created.json()["login"] == "new.user"
    assert created.json()["displayName"] == "Новый"
    assert created.json()["createdBy"] == "root"

    listed = {u["login"]: u for u in admin.get("/auth/users").json()["users"]}
    assert listed["root"]["builtin"] is True and listed["root"]["role"] == "admin"
    assert listed["new.user"]["builtin"] is False

    assert admin.patch("/auth/users/new.user", json={"role": "editor"}).json()["role"] == "editor"
    assert admin.delete("/auth/users/new.user").status_code == 200
    assert admin.delete("/auth/users/new.user").status_code == 404


@pytest.mark.parametrize("body,status", [
    ({"login": "ed", "role": "viewer"}, 409),               # уже есть
    ({"login": "bad login", "role": "viewer"}, 409),        # пробел
    ({"login": "cn=x,dc=y", "role": "viewer"}, 409),        # символы DN
    ({"login": "ok", "role": "owner"}, 422),                # нет такой роли
    ({"login": "root", "role": "viewer"}, 409),             # встроенный администратор
])
def test_user_create_validation(app, body, status):
    assert client_for(app, "root").post("/auth/users", json=body).status_code == status


def test_admin_cannot_lock_himself_out(app):
    users.create("boss", "admin", None, "root")
    client = client_for(app, "boss")
    assert client.patch("/auth/users/boss", json={"role": "viewer"}).status_code == 409
    assert client.patch("/auth/users/boss", json={"status": "blocked"}).status_code == 409
    assert client.delete("/auth/users/boss").status_code == 409
    assert client.patch("/auth/users/boss", json={"displayName": "Босс"}).status_code == 200
    assert client.get("/auth/me").json()["role"] == "admin"


def test_builtin_admin_is_changed_only_in_settings(app):
    users.create("boss", "admin", None, "root")
    client = client_for(app, "boss")
    assert client.patch("/auth/users/root", json={"role": "viewer"}).status_code == 409
    assert client.delete("/auth/users/root").status_code == 409


def test_catalog_node_operations_do_not_see_users(monkeypatch):
    """Иначе редактор правкой свойств узла :User выдал бы себе роль администратора."""
    row = {"labels": ["User"], "props": {"login": "ed", "role": "editor"}, "nodeId": "4:db:77"}
    run = lambda query, **params: [row]
    monkeypatch.setattr(catalog, "_one", lambda query, **params: row)
    monkeypatch.setattr(catalog, "_run", run)
    monkeypatch.setattr(catalog, "_write", lambda work: work(run))
    with pytest.raises(catalog.NotFound):
        catalog.update_properties("4:db:77", {"role": "admin"})
    with pytest.raises(catalog.NotFound):
        catalog.get_node("4:db:77")
    with pytest.raises(catalog.NotFound):
        catalog.delete_node("4:db:77", force=True)


# ---------------------------------- аудит ----------------------------------


def test_user_management_is_audited(app, caplog):
    """Кому и какую роль выдали, кого заблокировали и удалили — с прежними значениями."""
    admin = client_for(app, "root")
    with caplog.at_level(logging.INFO, logger="audit"):
        admin.post("/auth/users", json={"login": "new", "role": "viewer"})
        admin.patch("/auth/users/new", json={"role": "editor", "status": "blocked"})
        admin.delete("/auth/users/new")
    events = [e for e in audit_events(caplog) if e["event"].startswith("user_")]
    assert [(e["event"], e["login"], e["target"]) for e in events] == [
        ("user_created", "root", "new"), ("user_changed", "root", "new"), ("user_deleted", "root", "new")]
    assert events[0]["role"] == "viewer"
    assert events[1]["changes"] == {"role": "editor", "status": "blocked"}
    assert events[1]["before"] == {"role": "viewer", "status": "active"}
    assert (events[2]["role"], events[2]["status"]) == ("editor", "blocked")


def test_changes_are_logged_with_actor(app, caplog):
    client = client_for(app, "ed")
    with caplog.at_level(logging.INFO, logger="audit"):
        client.post("/catalog/departments", json=DEPARTMENT)
        client.request("DELETE", "/catalog/nodes/4:db:1")
        client.get("/catalog/tree")
    events = [e for e in audit_events(caplog) if e["event"] == "request"]
    assert [(e["method"], e["path"], e["status"], e["login"]) for e in events] == [
        ("POST", "/catalog/departments", 201, "ed"),
        ("DELETE", "/catalog/nodes/4:db:1", 403, "ed"),
    ], "чтение в журнал не пишется, отказ в правах — пишется"
    assert json.loads(events[0]["body"]) == DEPARTMENT


@pytest.fixture
def audit_handlers():
    """Обработчики логгера audit восстанавливаются после теста; файлы закрываются."""
    saved = list(audit.log.handlers)
    for handler in saved:
        audit.log.removeHandler(handler)
    yield
    for handler in list(audit.log.handlers):
        audit.log.removeHandler(handler)
        handler.close()
    for handler in saved:
        audit.log.addHandler(handler)


def test_audit_is_written_to_a_file_on_the_volume(monkeypatch, tmp_path, audit_handlers):
    """Контейнер пересоздаётся при обновлении — журнал должен его пережить."""
    monkeypatch.setenv("AUDIT_LOG_DIR", str(tmp_path))
    monkeypatch.setenv("AUDIT_RETENTION_DAYS", "30")
    audit.setup()
    audit.setup()
    files = [h for h in audit.log.handlers if getattr(h, "_audit_file", False)]
    assert len(files) == 1 and files[0].backupCount == 30 and files[0].when == "MIDNIGHT"
    assert audit.log.level == logging.INFO, "аудит не глушится общим LOG_LEVEL"
    audit.event("login_ok", login="ed")
    files[0].flush()
    assert json.loads((tmp_path / "audit.log").read_text(encoding="utf-8"))["login"] == "ed"


def test_audit_file_rotates_by_size_and_keeps_retention(monkeypatch, tmp_path, audit_handlers):
    """Поток запросов не заполняет том: файл сменяется по размеру, лишние старые удаляются."""
    monkeypatch.setenv("AUDIT_LOG_DIR", str(tmp_path))
    monkeypatch.setenv("AUDIT_RETENTION_DAYS", "3")
    monkeypatch.setenv("AUDIT_MAX_FILE_MB", "1")
    audit.setup()
    for _ in range(25_000):
        audit.event("request", pad="x" * 200)
    names = sorted(p.name for p in tmp_path.iterdir())
    assert "audit.log" in names and len(names) == 4, names
    assert all(p.stat().st_size <= 1024 * 1024 for p in tmp_path.iterdir())


def test_unwritable_audit_dir_leaves_stdout_only(monkeypatch, tmp_path, audit_handlers, caplog):
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("")
    monkeypatch.setenv("AUDIT_LOG_DIR", str(blocker))
    with caplog.at_level(logging.WARNING):
        audit.setup()
    assert not audit.log.handlers
    assert any("только stdout" in r.getMessage() for r in caplog.records)


def test_token_never_reaches_the_log(app, caplog):
    good, bad = token_for("root"), token_for("root", key=STRANGER_KEY)
    with caplog.at_level(logging.DEBUG):
        TestClient(app, headers=bearer(bad)).get("/auth/me")
        TestClient(app, headers=bearer(good)).get("/auth/me")
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert good not in text and bad not in text
    assert [(e["event"], e.get("login")) for e in audit_events(caplog)] == [
        ("token_rejected", None), ("login_ok", "root")]


# --------------------------------- реестр ----------------------------------


@pytest.mark.parametrize("login,ok", [
    ("ivanov", True), ("i.ivanov-2", True), ("a" * 64, True),
    ("", False), ("a" * 65, False), ("ivanov@corp", False), ("corp\\ivanov", False),
    ("iva nov", False), ("иванов", False), ("*", False), (".hidden", False),
])
def test_login_format(login, ok):
    assert users.valid_login(login) is ok
