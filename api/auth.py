"""Аутентификация и авторизация интерфейса администрирования.

Кто пользователь — решает каталог (LDAP/AD): API подключается к нему именем
и паролем самого пользователя (прямой bind), сервисной учётки нет. Что ему
можно — решает реестр users.py: роль назначает администратор в интерфейсе.
Логины из AUTH_ADMIN_LOGINS — администраторы всегда: без этого первого
администратора некому было бы назначить.

Внешние системы проверяют цели по ключу доступа (apikeys.py) в заголовке
Authorization: Bearer — без сессии и только проверку целей.

Сессия — случайный токен в cookie (HttpOnly, SameSite=Strict, Secure),
на сервере хранится только его SHA-256. Сессии и счётчики неудачных входов
лежат в памяти процесса: перезапуск API требует войти заново, а uvicorn
должен работать одним процессом (так и задано в Dockerfile).
"""

from __future__ import annotations

import getpass
import hashlib
import hmac
import logging
import os
import secrets
import ssl
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

import apikeys
import audit
import settings
import users

log = logging.getLogger(__name__)

SESSION_COOKIE = "gc_session"
RANK = {role: rank for rank, role in enumerate(users.ROLES)}
# Внешняя система с ключом доступа (apikeys.py): ниже читателя — ей доступна
# только проверка целей (checker), ни каталог, ни интерфейс.
SERVICE_ROLE = "service"
RANK[SERVICE_ROLE] = -1
PBKDF2_ITERATIONS = 600_000

# Один ответ на «нет такого пользователя», «роль не назначена» и «неверный
# пароль»: форма входа не должна подсказывать, какие логины существуют.
MAINTENANCE = "Идёт обслуживание сервиса: проверка целей и каталог временно недоступны. Попробуйте позже"
LOGIN_FAILED = "Неверный логин или пароль, либо доступ к интерфейсу не назначен"

_now: Callable[[], float] = time.monotonic


def _flag(name: str, default: bool = False) -> bool:
    return os.getenv(name, "1" if default else "0").strip().lower() in ("1", "true", "yes", "on")


def _number(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        log.warning("%s должно быть числом, используется %d", name, default)
        return default


def admin_logins() -> set[str]:
    raw = os.getenv("AUTH_ADMIN_LOGINS", "")
    return {users.normalize_login(item) for item in raw.split(",") if item.strip()}


# --------------------------------------------------------------------------
#  Проверка пароля
# --------------------------------------------------------------------------


class DirectoryUnavailable(RuntimeError):
    """Каталог недоступен или настроен неверно: это не «неверный пароль»."""


def _verify_ldap(login: str, password: str) -> bool:
    import ldap3
    from ldap3.core.exceptions import LDAPException

    url = os.getenv("LDAP_URL", "").strip()
    template = os.getenv("LDAP_USER_TEMPLATE", "").strip()
    if not url or "{login}" not in template:
        raise DirectoryUnavailable("не заданы LDAP_URL и LDAP_USER_TEMPLATE с подстановкой {login}")

    use_ssl = url.lower().startswith("ldaps://")
    starttls = _flag("LDAP_STARTTLS")
    if not use_ssl and not starttls and not _flag("LDAP_ALLOW_PLAINTEXT"):
        raise DirectoryUnavailable(
            "LDAP без шифрования запрещён: используйте ldaps:// или LDAP_STARTTLS=1"
        )

    timeout = _number("LDAP_TIMEOUT_SECONDS", 5)
    tls = None
    if use_ssl or starttls:
        tls = ldap3.Tls(validate=ssl.CERT_REQUIRED,
                        ca_certs_file=os.getenv("LDAP_CA_FILE", "").strip() or None)
    server = ldap3.Server(url, use_ssl=use_ssl, tls=tls, connect_timeout=timeout, get_info=ldap3.NONE)
    connection = ldap3.Connection(
        server, user=template.format(login=login), password=password,
        authentication=ldap3.SIMPLE, receive_timeout=timeout,
        raise_exceptions=False, auto_referrals=False,
    )
    try:
        if starttls:
            connection.open()
            if not connection.start_tls():
                raise DirectoryUnavailable("сервер отказал в STARTTLS")
        if connection.bind():
            return True
        description = (connection.result or {}).get("description")
        if description == "invalidCredentials":
            return False
        raise DirectoryUnavailable(f"каталог отклонил подключение: {description}")
    except LDAPException as exc:
        raise DirectoryUnavailable(str(exc) or type(exc).__name__) from exc
    finally:
        try:
            connection.unbind()
        except Exception:  # noqa: BLE001 — соединение могло и не открыться
            pass


def hash_password(password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    """Запись для AUTH_STATIC_USERS: pbkdf2:<итерации>:<соль>:<хеш>."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2:{iterations}:{salt.hex()}:{digest.hex()}"


def _static_users() -> dict[str, str]:
    result = {}
    for item in os.getenv("AUTH_STATIC_USERS", "").split(","):
        login, _, record = item.strip().partition(":")
        if login and record:
            result[users.normalize_login(login)] = record
    return result


def _verify_static(login: str, password: str) -> bool:
    """Учётки из AUTH_STATIC_USERS — для стенда без каталога, не для боевого сервера."""
    # Неизвестному логину считаем хеш от заведомо чужой записи: время ответа
    # не должно выдавать, какие логины заведены.
    record = _static_users().get(login) or f"pbkdf2:{PBKDF2_ITERATIONS}:{'00' * 16}:{'00' * 32}"
    try:
        scheme, iterations, salt, expected = record.split(":")
        if scheme != "pbkdf2":
            raise ValueError(scheme)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(digest, bytes.fromhex(expected))
    except ValueError:
        raise DirectoryUnavailable(f"запись {login!r} в AUTH_STATIC_USERS повреждена") from None


def verify_password(login: str, password: str) -> bool:
    # Пустой пароль в LDAP — это анонимный bind, и он «успешен». Отсекаем
    # до обращения к каталогу, каким бы ни был бэкенд.
    if not password:
        return False
    backend = os.getenv("AUTH_BACKEND", "ldap").strip().lower()
    if backend == "static":
        return _verify_static(login, password)
    if backend == "ldap":
        return _verify_ldap(login, password)
    raise DirectoryUnavailable(f"неизвестный AUTH_BACKEND={backend!r}, ожидался ldap или static")


def check_config() -> None:
    """Предупреждения о настройках, с которыми войти не получится или небезопасно."""
    backend = os.getenv("AUTH_BACKEND", "ldap").strip().lower()
    if backend == "static":
        log.warning("AUTH_BACKEND=static: пароли проверяются по AUTH_STATIC_USERS. "
                    "Только для стенда — на боевом сервере используйте ldap")
    elif not os.getenv("LDAP_URL") or not os.getenv("LDAP_USER_TEMPLATE"):
        log.error("Не заданы LDAP_URL / LDAP_USER_TEMPLATE — войти в интерфейс не получится")
    if not admin_logins():
        log.warning("AUTH_ADMIN_LOGINS пуст: если в реестре нет администратора, "
                    "назначать роли будет некому")
    if not _flag("SESSION_COOKIE_SECURE", True):
        log.warning("SESSION_COOKIE_SECURE=0: cookie сессии передаётся и по HTTP. Только для стенда")


# --------------------------------------------------------------------------
#  Сессии и ограничение перебора
# --------------------------------------------------------------------------


@dataclass
class _Session:
    login: str
    created: float
    seen: float


class SessionStore:
    def __init__(self) -> None:
        self._items: dict[str, _Session] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _key(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    @staticmethod
    def _expired(session: _Session, now: float) -> bool:
        return (now - session.seen > _number("SESSION_IDLE_MINUTES", 30) * 60
                or now - session.created > _number("SESSION_MAX_HOURS", 12) * 3600)

    def create(self, login: str) -> str:
        token = secrets.token_urlsafe(32)
        now = _now()
        with self._lock:
            for key in [k for k, s in self._items.items() if self._expired(s, now)]:
                del self._items[key]
            self._items[self._key(token)] = _Session(login, now, now)
        return token

    def resolve(self, token: str) -> Optional[str]:
        """Логин владельца живой сессии; заодно продлевает её по активности."""
        key = self._key(token)
        now = _now()
        with self._lock:
            session = self._items.get(key)
            if session is None:
                return None
            if self._expired(session, now):
                del self._items[key]
                return None
            session.seen = now
            return session.login

    def drop(self, token: str) -> None:
        with self._lock:
            self._items.pop(self._key(token), None)

    def drop_login(self, login: str) -> None:
        with self._lock:
            for key in [k for k, s in self._items.items() if s.login == login]:
                del self._items[key]

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


class Throttle:
    """Скользящее окно неудачных входов по ключу (логин или адрес)."""

    MAX_KEYS = 10_000

    def __init__(self) -> None:
        self._fails: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def wait(self, key: str, limit: int, window: float) -> int:
        """Сколько секунд ждать до следующей попытки; 0 — можно сейчас."""
        if limit <= 0:
            return 0
        now = _now()
        with self._lock:
            fails = self._fails.get(key)
            if not fails:
                return 0
            while fails and now - fails[0] > window:
                fails.popleft()
            if len(fails) < limit:
                return 0
            return int(fails[0] + window - now) + 1

    def fail(self, key: str, window: float) -> None:
        now = _now()
        with self._lock:
            if len(self._fails) >= self.MAX_KEYS:
                for stale in [k for k, f in self._fails.items() if not f or now - f[-1] > window]:
                    del self._fails[stale]
            self._fails.setdefault(key, deque()).append(now)

    def reset(self, key: str) -> None:
        with self._lock:
            self._fails.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._fails.clear()


class RateLimit:
    """Скользящее минутное окно: сколько целей проверил пользователь или ключ."""

    WINDOW = 60.0
    MAX_KEYS = 10_000

    def __init__(self) -> None:
        self._spent: dict[str, deque[tuple[float, int]]] = {}
        self._lock = threading.Lock()

    def take(self, key: str, amount: int, limit: int) -> int:
        """Списывает amount; возвращает, сколько секунд ждать, если лимит исчерпан (0 — принято).

        Запрос крупнее самого лимита проходит при пустом окне: иначе пакет
        больше лимита не прошёл бы никогда.
        """
        if limit <= 0:
            return 0
        now = _now()
        with self._lock:
            if len(self._spent) >= self.MAX_KEYS:
                for stale in [k for k, d in self._spent.items() if not d or now - d[-1][0] > self.WINDOW]:
                    del self._spent[stale]
            spent = self._spent.setdefault(key, deque())
            while spent and now - spent[0][0] > self.WINDOW:
                spent.popleft()
            used = sum(n for _, n in spent)
            if spent and used + amount > limit:
                return int(spent[0][0] + self.WINDOW - now) + 1
            spent.append((now, amount))
            return 0

    def reset(self) -> None:
        with self._lock:
            self._spent.clear()


sessions = SessionStore()
throttle = Throttle()
check_rate = RateLimit()


def spend_checks(user: "Principal", goals: int) -> None:
    """Учитывает goals проверок за пользователем или ключом; сверх лимита — 429.

    Лимит — настройка checkRatePerMinute: целей в минуту на каждого, 0 выключает.
    """
    wait = check_rate.take(user.login, goals, settings.number("checkRatePerMinute"))
    if wait:
        audit.event("check_throttled", login=user.login, goals=goals, retry_after=wait)
        raise HTTPException(
            status_code=429,
            detail=f"Слишком много проверок за минуту. Повторите через {wait} с.",
            headers={"Retry-After": str(wait)},
        )


# --------------------------------------------------------------------------
#  Кто делает запрос и что ему можно
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Principal:
    login: str
    role: str
    display_name: Optional[str] = None

    def public(self) -> dict[str, Optional[str]]:
        return {"login": self.login, "role": self.role, "displayName": self.display_name}


def resolve_account(login: str) -> Optional[Principal]:
    """Роль пользователя на текущий момент; None — доступа нет.

    Читается при каждом запросе, поэтому смена роли и блокировка действуют
    сразу, а не после истечения сессии.
    """
    if login in admin_logins():
        return Principal(login, "admin")
    try:
        row = users.get(login)
    except Exception as exc:  # noqa: BLE001
        log.error("Реестр пользователей недоступен: %s", exc)
        raise HTTPException(status_code=503, detail="Реестр пользователей недоступен, попробуйте позже") from exc
    if not row or row["status"] != users.ACTIVE_STATUS or row["role"] not in users.ROLES:
        return None
    return Principal(login, row["role"], row["displayName"])


def bearer_token(request: Request) -> Optional[str]:
    """Ключ доступа из заголовка Authorization: Bearer …; None — заголовка нет."""
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


def _key_user(request: Request, token: str) -> Principal:
    if not settings.flag("apiKeysEnabled"):
        audit.event("api_key_rejected", ip=audit.client_ip(request), reason="disabled")
        raise HTTPException(status_code=403, detail="Проверка по ключам доступа отключена администратором")
    try:
        key = apikeys.resolve(token)
    except Exception as exc:  # noqa: BLE001
        log.error("Реестр ключей доступа недоступен: %s", exc)
        raise HTTPException(status_code=503, detail="Реестр ключей доступа недоступен, попробуйте позже") from exc
    if key is None:
        audit.event("api_key_rejected", ip=audit.client_ip(request))
        raise HTTPException(status_code=401, detail="Ключ доступа недействителен или отозван")
    return Principal("key:" + key["name"], SERVICE_ROLE)


def current_user(request: Request) -> Principal:
    """Кто делает запрос: внешняя система с ключом либо пользователь с сессией."""
    key = bearer_token(request)
    if key:
        request.state.user = _key_user(request, key)
        return request.state.user
    token = request.cookies.get(SESSION_COOKIE)
    login = sessions.resolve(token) if token else None
    account = resolve_account(login) if login else None
    if account is None:
        if login:
            sessions.drop_login(login)
        raise HTTPException(status_code=401, detail="Требуется вход")
    request.state.user = account
    return account


def require(role: str) -> Callable[..., Principal]:
    """Зависимость маршрута: пользователь с ролью не ниже указанной."""

    def dependency(user: Principal = Depends(current_user)) -> Principal:
        # Обслуживание: работает только администратор; вход и /auth/me остаются.
        if user.role != "admin" and settings.flag("maintenance"):
            raise HTTPException(status_code=503, detail=MAINTENANCE, headers={"Retry-After": "300"})
        if RANK[user.role] < RANK[role]:
            raise HTTPException(status_code=403, detail=f"Недостаточно прав: нужна роль «{ROLE_NAMES[role]}»")
        return user

    return dependency


ROLE_NAMES = {"viewer": "читатель", "editor": "редактор", "admin": "администратор"}
# Проверка целей: любой вошедший пользователь или внешняя система с ключом.
checker = require(SERVICE_ROLE)
viewer = require("viewer")
editor = require("editor")
admin = require("admin")


# --------------------------------------------------------------------------
#  Маршруты
# --------------------------------------------------------------------------

router = APIRouter(prefix="/auth", tags=["auth"])

Role = Literal["viewer", "editor", "admin"]


class LoginRequest(BaseModel):
    login: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=1, max_length=256)


class UserCreate(BaseModel):
    login: str = Field(..., min_length=1, max_length=64)
    role: Role
    displayName: Optional[str] = Field(None, max_length=200)


class UserPatch(BaseModel):
    role: Optional[Role] = None
    status: Optional[Literal["active", "blocked"]] = None
    displayName: Optional[str] = Field(None, max_length=200)


@router.post("/login")
def post_login(body: LoginRequest, request: Request, response: Response):
    login = users.normalize_login(body.login)[:64]
    ip = audit.client_ip(request)
    window = _number("LOGIN_LOCK_MINUTES", 15) * 60
    keys = (("login:" + login, _number("LOGIN_MAX_ATTEMPTS", 5)),
            ("ip:" + ip, _number("LOGIN_MAX_ATTEMPTS_PER_IP", 30)))

    wait = max(throttle.wait(key, limit, window) for key, limit in keys)
    if wait:
        audit.event("login_throttled", login=login, ip=ip, retry_after=wait)
        raise HTTPException(
            status_code=429,
            detail=f"Слишком много неудачных попыток входа. Повторите через {wait // 60 + 1} мин.",
            headers={"Retry-After": str(wait)},
        )

    def deny(reason: str) -> HTTPException:
        for key, _ in keys:
            throttle.fail(key, window)
        audit.event("login_failed", login=login, ip=ip, reason=reason)
        return HTTPException(status_code=401, detail=LOGIN_FAILED)

    if not users.valid_login(login):
        raise deny("bad_login_format")
    # Сначала реестр, потом каталог: логин без назначенной роли до LDAP
    # не доходит, и форма входа не годится для перебора паролей всего домена.
    account = resolve_account(login)
    if account is None:
        raise deny("not_registered")
    try:
        if not verify_password(login, body.password):
            raise deny("bad_credentials")
    except DirectoryUnavailable as exc:
        log.error("Проверка пароля не выполнена: %s", exc)
        audit.event("login_failed", login=login, ip=ip, reason="directory_unavailable")
        raise HTTPException(status_code=503,
                            detail="Каталог пользователей недоступен, попробуйте позже") from exc

    throttle.reset("login:" + login)
    # Прежняя сессия этого браузера закрывается: токен после входа всегда новый.
    stale = request.cookies.get(SESSION_COOKIE)
    if stale:
        sessions.drop(stale)
    response.set_cookie(
        SESSION_COOKIE, sessions.create(login), httponly=True, samesite="strict",
        secure=_flag("SESSION_COOKIE_SECURE", True), path="/",
    )
    users.touch_login(login)
    audit.event("login_ok", login=login, role=account.role, ip=ip)
    return account.public()


@router.post("/logout", status_code=204)
def post_logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        login = sessions.resolve(token)
        sessions.drop(token)
        if login:
            audit.event("logout", login=login, ip=audit.client_ip(request))
    response.delete_cookie(SESSION_COOKIE, path="/")


@router.get("/me")
def get_me(user: Principal = Depends(current_user)):
    return user.public()


# ----------------------------- пользователи ---------------------------------


def _handle(func, *args, **kwargs):
    try:
        return func(*args, **kwargs)
    except users.NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except users.Conflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def _guard_builtin(login: str) -> None:
    if login in admin_logins():
        raise HTTPException(
            status_code=409,
            detail=f"{login} — администратор из AUTH_ADMIN_LOGINS: меняется в настройках сервера",
        )


@router.get("/users")
def get_users(_: Principal = Depends(admin)):
    builtin = admin_logins()
    listed = _handle(users.list_users)
    known = {u["login"] for u in listed}
    result = [{**u, "builtin": u["login"] in builtin,
               **({"role": "admin", "status": "active"} if u["login"] in builtin else {})}
              for u in listed]
    result += [{"login": login, "role": "admin", "status": "active", "displayName": None,
                "createdAt": None, "createdBy": None, "lastLoginAt": None, "builtin": True}
               for login in sorted(builtin - known)]
    return {"users": sorted(result, key=lambda u: u["login"])}


@router.post("/users", status_code=201)
def post_user(body: UserCreate, me: Principal = Depends(admin)):
    _guard_builtin(users.normalize_login(body.login))
    return {**_handle(users.create, body.login, body.role, body.displayName, me.login), "builtin": False}


@router.patch("/users/{login}")
def patch_user(login: str, body: UserPatch, me: Principal = Depends(admin)):
    login = users.normalize_login(login)
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items()
               if v is not None or k == "displayName"}
    if {"role", "status"} & changes.keys():
        _guard_builtin(login)
        # Иначе последний администратор может лишить доступа сам себя.
        if login == me.login:
            raise HTTPException(status_code=409,
                                detail="Свою роль и статус менять нельзя — попросите другого администратора")
    updated = _handle(users.update, login, changes)
    if updated["status"] != users.ACTIVE_STATUS:
        sessions.drop_login(login)
    return {**updated, "builtin": False}


@router.delete("/users/{login}")
def delete_user(login: str, me: Principal = Depends(admin)):
    login = users.normalize_login(login)
    _guard_builtin(login)
    if login == me.login:
        raise HTTPException(status_code=409, detail="Свою учётную запись удалить нельзя")
    _handle(users.delete, login)
    sessions.drop_login(login)
    return {"deleted": login}


if __name__ == "__main__":
    # python auth.py hash — запись для AUTH_STATIC_USERS (пароль спрашивается без эха).
    if sys.argv[1:] != ["hash"]:
        sys.exit("Использование: python auth.py hash")
    print(hash_password(getpass.getpass("Пароль: ")))
