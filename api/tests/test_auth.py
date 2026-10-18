"""Вход, сессии, роли и защита маршрутов. Neo4j и LDAP подменяются."""

import json
import logging
import sys
import types

import pytest
from fastapi.testclient import TestClient

import auth
import catalog
import diagnostics
import graph
import main
import users

XHR = {"X-Requested-With": "XMLHttpRequest"}
PASSWORD = "correct horse battery"
# Маршруты, открытые без входа: всё остальное обязано отвечать 401.
PUBLIC = {"/health", "/ready", "/auth/login", "/auth/logout"}


class FakeRegistry:
    """Подмена users._run: реестр в памяти, разбор по тексту запроса."""

    def __init__(self):
        self.nodes: dict = {}

    def __call__(self, query, **params):
        login = params.get("login")
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
            return [{"props": self.nodes[login]}]
        if "lastLoginAt" in query:
            if login in self.nodes:
                self.nodes[login]["lastLoginAt"] = params["now"]
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
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(auth, "_now", lambda: now[0])
    return now


@pytest.fixture
def app(monkeypatch, registry, clock):
    """Приложение со статическим бэкендом паролей и тремя учётками разных ролей."""
    record = auth.hash_password(PASSWORD, iterations=1000)
    monkeypatch.setenv("AUTH_BACKEND", "static")
    monkeypatch.setenv("AUTH_STATIC_USERS", ",".join(f"{u}:{record}" for u in ("root", "boss", "ed", "vi", "ghost")))
    monkeypatch.setenv("AUTH_ADMIN_LOGINS", "root")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "0")   # TestClient ходит по http
    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    monkeypatch.setattr(diagnostics, "collect", lambda: {"ready": True, "problems": [], "check_targets": 1})
    monkeypatch.setattr(catalog, "build_tree", lambda inc: {"orders": []})
    monkeypatch.setattr(catalog, "create_department", lambda i, n: {"nodeId": "4:db:9", "departmentId": i})
    monkeypatch.setattr(catalog, "delete_node", lambda node_id, cascade, force: {"deleted": node_id})
    monkeypatch.setattr(catalog, "repair_identifiers", lambda: {"orders": 0})
    monkeypatch.setattr(main, "check_goal", lambda goal, department_id=None: {"allowed": True})
    users.create("ed", "editor", "Редактор", "root")
    users.create("vi", "viewer", None, "root")
    auth.sessions.clear()
    auth.throttle.clear()
    yield main.app
    auth.sessions.clear()
    auth.throttle.clear()


def client_for(app, login=None, password=PASSWORD):
    client = TestClient(app, headers=XHR)
    if login:
        response = client.post("/auth/login", json={"login": login, "password": password})
        assert response.status_code == 200, response.text
    return client


# ------------------------------ без входа ----------------------------------


def test_every_route_requires_a_session(app):
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
            checked += 1
    assert checked > 25


def test_swagger_is_off_by_default(app):
    client = client_for(app)
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_health_stays_public(app):
    assert client_for(app).get("/health").json() == {"status": "ok"}


def test_unsafe_request_without_marker_header_is_rejected(app):
    """Чужая страница не может поставить свой заголовок — так отсекается CSRF."""
    client = client_for(app, "root")
    client.headers.pop("X-Requested-With")
    response = client.post("/catalog/departments", json={"departmentId": "UCT", "name": "УЦТ"})
    assert response.status_code == 403
    assert "X-Requested-With" in response.json()["detail"]
    assert client.get("/catalog/tree").status_code == 200, "чтение заголовка не требует"


# --------------------------------- вход ------------------------------------


def test_login_sets_hardened_cookie(app, monkeypatch):
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "1")
    response = TestClient(app, headers=XHR).post("/auth/login", json={"login": "Root ", "password": PASSWORD})
    assert response.status_code == 200
    assert response.json() == {"login": "root", "role": "admin", "displayName": None}
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(auth.SESSION_COOKIE + "=")
    for attribute in ("HttpOnly", "Secure", "SameSite=strict", "Path=/"):
        assert attribute in cookie
    assert response.headers["cache-control"] == "no-store"


def test_me_reports_role_from_registry(app):
    assert client_for(app, "ed").get("/auth/me").json() == {
        "login": "ed", "role": "editor", "displayName": "Редактор"}


@pytest.mark.parametrize("login,password,why", [
    ("root", "wrong", "неверный пароль"),
    ("ghost", PASSWORD, "пароль верный, но роли в реестре нет"),
    ("nobody", PASSWORD, "нет ни в каталоге, ни в реестре"),
    ("ro*ot)(uid=*", PASSWORD, "недопустимые символы в логине"),
])
def test_login_failures_are_indistinguishable(app, login, password, why):
    response = TestClient(app, headers=XHR).post("/auth/login", json={"login": login, "password": password})
    assert response.status_code == 401, why
    assert response.json()["detail"] == auth.LOGIN_FAILED
    assert "set-cookie" not in response.headers


def test_unregistered_login_never_reaches_the_directory(app, monkeypatch):
    """Форма входа не должна годиться для перебора паролей всего домена."""
    seen = []
    monkeypatch.setattr(auth, "verify_password", lambda login, password: seen.append(login) or True)
    TestClient(app, headers=XHR).post("/auth/login", json={"login": "stranger", "password": "x"})
    TestClient(app, headers=XHR).post("/auth/login", json={"login": "a)(b", "password": "x"})
    assert seen == []


def test_empty_password_is_rejected(app):
    response = TestClient(app, headers=XHR).post("/auth/login", json={"login": "root", "password": ""})
    assert response.status_code == 422


def test_directory_outage_is_503_not_401(app, monkeypatch):
    def down(login, password):
        raise auth.DirectoryUnavailable("timeout")

    monkeypatch.setattr(auth, "verify_password", down)
    response = TestClient(app, headers=XHR).post("/auth/login", json={"login": "root", "password": "x"})
    assert response.status_code == 503


def test_repeated_failures_lock_the_login(app, clock):
    client = TestClient(app, headers=XHR)
    for _ in range(5):
        assert client.post("/auth/login", json={"login": "ed", "password": "bad"}).status_code == 401
    locked = client.post("/auth/login", json={"login": "ed", "password": PASSWORD})
    assert locked.status_code == 429, "даже верный пароль не проходит, пока действует блокировка"
    assert int(locked.headers["retry-after"]) > 0

    clock[0] += 15 * 60 + 1
    assert client.post("/auth/login", json={"login": "ed", "password": PASSWORD}).status_code == 200


def test_successful_login_resets_the_counter(app):
    client = TestClient(app, headers=XHR)
    for _ in range(4):
        client.post("/auth/login", json={"login": "ed", "password": "bad"})
    assert client.post("/auth/login", json={"login": "ed", "password": PASSWORD}).status_code == 200
    for _ in range(4):
        client.post("/auth/login", json={"login": "ed", "password": "bad"})
    assert client.post("/auth/login", json={"login": "ed", "password": PASSWORD}).status_code == 200


def test_failures_from_one_address_are_limited(app, monkeypatch):
    monkeypatch.setenv("LOGIN_MAX_ATTEMPTS_PER_IP", "3")
    client = TestClient(app, headers=XHR)
    for n in range(3):
        client.post("/auth/login", json={"login": f"user{n}", "password": "bad"})
    assert client.post("/auth/login", json={"login": "root", "password": PASSWORD}).status_code == 429


# -------------------------------- сессии -----------------------------------


def test_logout_invalidates_the_session(app):
    client = client_for(app, "root")
    token = client.cookies[auth.SESSION_COOKIE]
    assert client.post("/auth/logout").status_code == 204
    client.cookies.set(auth.SESSION_COOKIE, token)   # украденный до выхода токен
    assert client.get("/auth/me").status_code == 401


def test_session_expires_when_idle(app, clock):
    client = client_for(app, "root")
    clock[0] += 29 * 60
    assert client.get("/auth/me").status_code == 200, "активность продлевает сессию"
    clock[0] += 29 * 60
    assert client.get("/auth/me").status_code == 200
    clock[0] += 31 * 60
    assert client.get("/auth/me").status_code == 401


def test_session_has_absolute_lifetime(app, clock):
    client = client_for(app, "root")
    for _ in range(12 * 60 // 20 + 1):
        clock[0] += 20 * 60
        last = client.get("/auth/me").status_code
    assert last == 401, "даже активная сессия не живёт дольше SESSION_MAX_HOURS"


def test_token_is_not_stored_in_plain_form(app):
    client = client_for(app, "root")
    assert client.cookies[auth.SESSION_COOKIE] not in auth.sessions._items


def test_login_rotates_the_token(app):
    client = client_for(app, "root")
    first = client.cookies[auth.SESSION_COOKIE]
    client.post("/auth/login", json={"login": "root", "password": PASSWORD})
    assert client.cookies[auth.SESSION_COOKIE] != first
    assert auth.sessions.resolve(first) is None


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


def test_role_change_applies_to_live_session(app):
    client = client_for(app, "vi")
    assert client.post("/catalog/departments", json=DEPARTMENT).status_code == 403
    users.update("vi", {"role": "editor"})
    assert client.post("/catalog/departments", json=DEPARTMENT).status_code == 201


def test_blocking_ends_live_sessions(app):
    victim = client_for(app, "ed")
    admin = client_for(app, "root")
    assert admin.patch("/auth/users/ed", json={"status": "blocked"}).status_code == 200
    assert victim.get("/auth/me").status_code == 401
    assert TestClient(app, headers=XHR).post(
        "/auth/login", json={"login": "ed", "password": PASSWORD}).status_code == 401


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
    monkeypatch.setattr(catalog, "_one", lambda query, **params: {
        "labels": ["User"], "props": {"login": "ed", "role": "editor"}, "nodeId": "4:db:77"})
    with pytest.raises(catalog.NotFound):
        catalog.update_properties("4:db:77", {"role": "admin"})
    with pytest.raises(catalog.NotFound):
        catalog.get_node("4:db:77")
    with pytest.raises(catalog.NotFound):
        catalog.delete_node("4:db:77", force=True)


# ---------------------------------- аудит ----------------------------------


def audit_events(caplog):
    return [json.loads(r.getMessage()) for r in caplog.records if r.name == "audit"]


def test_changes_are_logged_with_actor(app, caplog):
    client = client_for(app, "ed")
    with caplog.at_level(logging.INFO, logger="audit"):
        client.post("/catalog/departments", json=DEPARTMENT)
        client.request("DELETE", "/catalog/nodes/4:db:1")
        client.get("/catalog/tree")
    events = audit_events(caplog)
    assert [(e["method"], e["path"], e["status"], e["login"]) for e in events] == [
        ("POST", "/catalog/departments", 201, "ed"),
        ("DELETE", "/catalog/nodes/4:db:1", 403, "ed"),
    ], "чтение в журнал не пишется, отказ в правах — пишется"
    assert json.loads(events[0]["body"]) == DEPARTMENT


def test_password_never_reaches_the_log(app, caplog):
    with caplog.at_level(logging.DEBUG):
        client = TestClient(app, headers=XHR)
        client.post("/auth/login", json={"login": "root", "password": "wrong-secret"})
        client.post("/auth/login", json={"login": "root", "password": PASSWORD})
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "wrong-secret" not in text and PASSWORD not in text
    assert [(e["event"], e.get("reason")) for e in audit_events(caplog)] == [
        ("login_failed", "bad_credentials"), ("login_ok", None)]


# ---------------------------------- LDAP -----------------------------------


@pytest.fixture
def ldap(monkeypatch):
    """Подмена ldap3: запоминает, с чем пришли, и отвечает заданным результатом."""
    state = types.SimpleNamespace(binds=[], servers=[], result="success", error=None, tls=[])

    class LDAPException(Exception):
        pass

    class Connection:
        def __init__(self, server, user, password, **kwargs):
            self.user, self.password = user, password
            self.result = {}

        def open(self):
            pass

        def start_tls(self):
            state.tls.append("starttls")
            return True

        def bind(self):
            if state.error:
                raise LDAPException(state.error)
            state.binds.append((self.user, self.password))
            self.result = {"description": state.result}
            return state.result == "success"

        def unbind(self):
            pass

    def server(url, **kwargs):
        state.servers.append((url, kwargs))
        return url

    fake = types.ModuleType("ldap3")
    fake.Server, fake.Connection = server, Connection
    fake.Tls = lambda **kwargs: kwargs
    fake.SIMPLE, fake.NONE = "SIMPLE", "NONE"
    exceptions = types.ModuleType("ldap3.core.exceptions")
    exceptions.LDAPException = LDAPException
    monkeypatch.setitem(sys.modules, "ldap3", fake)
    monkeypatch.setitem(sys.modules, "ldap3.core", types.ModuleType("ldap3.core"))
    monkeypatch.setitem(sys.modules, "ldap3.core.exceptions", exceptions)
    monkeypatch.setenv("AUTH_BACKEND", "ldap")
    monkeypatch.setenv("LDAP_URL", "ldaps://dc.corp.local:636")
    monkeypatch.setenv("LDAP_USER_TEMPLATE", "{login}@corp.local")
    return state


def test_ldap_binds_as_the_user_over_tls(ldap):
    assert auth.verify_password("ivanov", "secret") is True
    assert ldap.binds == [("ivanov@corp.local", "secret")]
    url, options = ldap.servers[0]
    assert url == "ldaps://dc.corp.local:636" and options["use_ssl"] is True
    assert options["tls"]["validate"] == auth.ssl.CERT_REQUIRED, "сертификат сервера проверяется"


def test_ldap_wrong_password_is_false(ldap):
    ldap.result = "invalidCredentials"
    assert auth.verify_password("ivanov", "wrong") is False


def test_ldap_empty_password_is_never_sent(ldap):
    """Пустой пароль — анонимный bind, каталог ответил бы «успех»."""
    assert auth.verify_password("ivanov", "") is False
    assert ldap.binds == []


def test_ldap_other_refusal_is_not_treated_as_wrong_password(ldap):
    ldap.result = "strongerAuthRequired"
    with pytest.raises(auth.DirectoryUnavailable):
        auth.verify_password("ivanov", "secret")


def test_ldap_network_error_is_unavailable(ldap):
    ldap.error = "socket connection error"
    with pytest.raises(auth.DirectoryUnavailable):
        auth.verify_password("ivanov", "secret")


def test_ldap_plaintext_is_refused(ldap, monkeypatch):
    monkeypatch.setenv("LDAP_URL", "ldap://dc.corp.local")
    with pytest.raises(auth.DirectoryUnavailable, match="без шифрования"):
        auth.verify_password("ivanov", "secret")
    assert ldap.binds == [], "пароль не должен уйти по открытому каналу"

    monkeypatch.setenv("LDAP_STARTTLS", "1")
    assert auth.verify_password("ivanov", "secret") is True
    assert ldap.tls == ["starttls"]


def test_ldap_requires_configuration(ldap, monkeypatch):
    monkeypatch.setenv("LDAP_USER_TEMPLATE", "corp.local")   # без {login}
    with pytest.raises(auth.DirectoryUnavailable):
        auth.verify_password("ivanov", "secret")


def test_real_ldap3_is_importable():
    """Колесо ldap3 должно быть в офлайн-наборе: иначе вход сломается только на сервере."""
    import ldap3

    assert ldap3.Server and ldap3.Connection and ldap3.Tls


# --------------------------------- реестр ----------------------------------


def test_static_password_hash_roundtrip(monkeypatch):
    monkeypatch.setenv("AUTH_BACKEND", "static")
    monkeypatch.setenv("AUTH_STATIC_USERS", "dev:" + auth.hash_password("pw", iterations=1000))
    assert auth.verify_password("dev", "pw") is True
    assert auth.verify_password("dev", "pW") is False
    assert auth.verify_password("other", "pw") is False


@pytest.mark.parametrize("login,ok", [
    ("ivanov", True), ("i.ivanov-2", True), ("a" * 64, True),
    ("", False), ("a" * 65, False), ("ivanov@corp", False), ("corp\\ivanov", False),
    ("iva nov", False), ("иванов", False), ("*", False), (".hidden", False),
])
def test_login_format(login, ok):
    assert users.valid_login(login) is ok
