"""Аутентификация и авторизация интерфейса администрирования.

Кто пользователь — решает Keycloak: интерфейс входит через него (OpenID
Connect, authorization code + PKCE) и с каждым запросом присылает выданный
им access-токен в заголовке Authorization: Bearer. API проверяет подпись
токена по ключам realm-а (JWKS), издателя, срок и клиента — к Keycloak
за каждым запросом не ходит. Что пользователю можно — решает реестр
users.py: роль назначает администратор в интерфейсе. Логины из
AUTH_ADMIN_LOGINS — администраторы всегда: без этого первого
администратора некому было бы назначить.

Внешние системы проверяют цели по ключу доступа (apikeys.py) в том же
заголовке — без Keycloak и только проверку целей.

Сессий и cookie у API нет: состояние входа живёт в токене. Перезапуск API
входа не рвёт; блокировка и смена роли действуют сразу, потому что роль
читается из реестра при каждом запросе.
"""

from __future__ import annotations

import logging
import os
import ssl
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Literal, Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

import apikeys
import audit
import settings
import users

log = logging.getLogger(__name__)

RANK = {role: rank for rank, role in enumerate(users.ROLES)}
# Внешняя система с ключом доступа (apikeys.py): ниже читателя — ей доступна
# только проверка целей (checker), ни каталог, ни интерфейс.
SERVICE_ROLE = "service"
RANK[SERVICE_ROLE] = -1

# Подписи, которыми Keycloak подписывает access-токены. HS* исключены
# намеренно: симметричный ключ API не известен, а принять «none» нельзя.
ALGORITHMS = ("RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512")
# Допуск на расхождение часов API и Keycloak при проверке exp/nbf/iat.
LEEWAY_SECONDS = 30
# Сколько секунд набор ключей realm-а считается свежим; удалённый из realm-а
# ключ перестаёт приниматься не позже чем через этот срок.
JWKS_LIFESPAN_SECONDS = 300
# Внеочередное перечитывание ключей (незнакомый kid, сбой Keycloak) — не чаще
# раза в столько секунд на процесс; остальные такие токены сразу получают 401.
JWKS_REFRESH_INTERVAL_SECONDS = 10
# kid у Keycloak — несколько десятков символов; длиннее — заведомо мусор.
KID_MAX = 128
# Сколько символов причины отказа попадает в журнал аудита.
REASON_MAX = 200

MAINTENANCE = "Идёт обслуживание сервиса: проверка целей и каталог временно недоступны. Попробуйте позже"
SETTINGS_UNAVAILABLE = "Настройки сервиса не прочитаны: граф недоступен. Попробуйте позже"
LOGIN_REQUIRED = "Требуется вход"
# Токен есть, но доступ не назначен или отозван. Текст один для «нет в
# реестре» и «заблокирован»: интерфейсу всё равно показывать одно и то же.
ACCESS_DENIED = "Доступ к интерфейсу не назначен. Обратитесь к администратору"
# Токен подлинный, но пустить по нему нельзя — 403, а не 401: повторный вход
# в Keycloak выдаст такой же токен, и интерфейс ушёл бы в цикл.
WRONG_CLIENT = "Токен выдан другому приложению. Войдите в Goal Checker заново"
BAD_LOGIN = ("Логин учётной записи не подходит для Goal Checker: допустимы латинские буквы, "
             "цифры, точка, дефис и подчёркивание. Обратитесь к администратору")
SUB_MISMATCH = ("Логин закреплён в реестре за другой учётной записью Keycloak. "
                "Обратитесь к администратору")

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
#  Keycloak: настройки и проверка токена
# --------------------------------------------------------------------------


class DirectoryUnavailable(RuntimeError):
    """Keycloak недоступен или настроен неверно: это не «неверный токен»."""


class TokenInvalid(RuntimeError):
    """Токен не прошёл проверку: подпись, издатель, срок, тип."""


class AccessRefused(RuntimeError):
    """Токен подлинный, но пустить по нему нельзя; текст — для пользователя (detail 403)."""

    def __init__(self, detail: str, reason: str) -> None:
        super().__init__(detail)
        self.detail, self.reason = detail, reason


def realm_url(internal: bool = False) -> str:
    """Адрес realm-а: публичный (он же издатель токенов) или внутренний для API.

    Браузер ходит в Keycloak по публичному адресу, и именно он записан в
    iss токена. API может быть ближе — например, http://keycloak:8080
    внутри docker — тогда ключи читаются по KEYCLOAK_INTERNAL_URL.
    """
    base = os.getenv("KEYCLOAK_URL", "").strip().rstrip("/")
    if internal:
        base = os.getenv("KEYCLOAK_INTERNAL_URL", "").strip().rstrip("/") or base
    realm = os.getenv("KEYCLOAK_REALM", "").strip().strip("/")
    if not base or not realm:
        raise DirectoryUnavailable("не заданы KEYCLOAK_URL и KEYCLOAK_REALM")
    return f"{base}/realms/{realm}"


def client_id() -> str:
    value = os.getenv("KEYCLOAK_CLIENT_ID", "").strip()
    if not value:
        raise DirectoryUnavailable("не задан KEYCLOAK_CLIENT_ID")
    return value


def public_config() -> dict[str, str]:
    """Что нужно интерфейсу, чтобы войти: издатель и клиент. Секретов здесь нет."""
    return {"issuer": realm_url(), "clientId": client_id()}


class _Jwks:
    """Ключи realm-а по kid: свой кэш вместо кэшей PyJWKClient.

    PyJWKClient на каждый незнакомый kid перечитывает JWKS, а найденные
    ключи держит в lru_cache до перезапуска — даже удалённые из realm-а.
    Здесь набор ключей целиком заменяется при каждом перечитывании, а
    перечитывание — не чаще раза в JWKS_REFRESH_INTERVAL_SECONDS на процесс:
    поток токенов с выдуманным kid не превращается в поток запросов к
    Keycloak. Если Keycloak не ответил, до следующей попытки служит прежний
    набор.
    """

    def __init__(self, url: str) -> None:
        self.url = url
        self._keys: Optional[dict[str, Any]] = None
        self._fetched = float("-inf")    # когда набор прочитан
        self._tried = float("-inf")      # когда его пробовали читать в последний раз
        self._lock = threading.Lock()
        self._fetch_lock = threading.Lock()   # за JWKS ходит один поток

    def key(self, kid: str):
        found = self._lookup(kid)
        if found is not None:
            return found
        with self._fetch_lock:
            # Пока ждали, набор мог перечитать другой поток — тогда второй раз не идём.
            found = self._lookup(kid)
            if found is not None:
                return found
            try:
                self._fetch()
            except DirectoryUnavailable:
                with self._lock:
                    stale = (self._keys or {}).get(kid)
                if stale is None:
                    raise
                log.warning("Ключи realm-а не перечитаны, служит прежний набор")
                return stale
        with self._lock:
            found = (self._keys or {}).get(kid)
        if found is None:
            raise TokenInvalid("ключа подписи с таким kid у realm-а нет")
        return found

    def _lookup(self, kid: str):
        """Ключ из памяти; None — набор пора перечитать.

        Перечитывать рано — сразу ответ: прежний ключ, TokenInvalid
        (такого kid нет) или DirectoryUnavailable (набор ни разу не прочитан).
        """
        now = _now()
        with self._lock:
            keys = self._keys
            fresh = now - self._fetched < JWKS_LIFESPAN_SECONDS
            may_fetch = now - self._tried >= JWKS_REFRESH_INTERVAL_SECONDS
        if keys is not None and kid in keys and (fresh or not may_fetch):
            return keys[kid]
        if may_fetch:
            return None
        if keys is None:
            raise DirectoryUnavailable("ключи realm-а не прочитаны, следующая попытка позже")
        # Незнакомый kid, а перечитывать набор ещё рано: это может быть только что
        # выпущенный ключ ротации. 503 (а не 401) не выбрасывает пользователя из
        # сессии — интерфейс повторит запрос, когда набор можно будет перечитать.
        raise DirectoryUnavailable("ключ подписи с таким kid ещё не прочитан, повторите позже")

    def _fetch(self) -> None:
        import http.client
        import json

        import jwt

        with self._lock:
            self._tried = _now()
        try:
            context = None
            if self.url.lower().startswith("https://"):
                context = ssl.create_default_context(cafile=os.getenv("KEYCLOAK_CA_FILE", "").strip() or None)
            client = jwt.PyJWKClient(self.url, cache_jwk_set=False, cache_keys=False,
                                     timeout=_number("KEYCLOAK_TIMEOUT_SECONDS", 5), ssl_context=context)
            jwk_set = client.get_jwk_set()
        except (jwt.exceptions.PyJWKClientError, jwt.exceptions.PyJWKSetError, json.JSONDecodeError,
                OSError, http.client.HTTPException) as exc:
            # Сбой сети, не JSON, нет годных ключей — это «сервис входа недоступен», а не «неверный токен».
            raise DirectoryUnavailable(f"ключи realm-а не прочитаны: {exc}") from exc
        keys = {k.key_id: k.key for k in jwk_set.keys if k.key_id and k.public_key_use in ("sig", None)}
        with self._lock:
            self._keys, self._fetched = keys, _now()


_jwks_lock = threading.Lock()
_jwks: dict[str, _Jwks] = {}


def _jwks_client(url: str) -> _Jwks:
    with _jwks_lock:
        client = _jwks.get(url)
        if client is None:
            client = _jwks[url] = _Jwks(url)
        return client


def forget_keys() -> None:
    """Сброс кэша ключей realm-а (тесты, смена настроек)."""
    with _jwks_lock:
        _jwks.clear()


def _token_kid(token: str) -> str:
    """kid из заголовка токена — после проверок, которые не стоят обращения к Keycloak.

    Подпись здесь ещё не проверена, поэтому всё, что в заголовке, — чужой
    ввод: без kid, с алгоритмом не из ALGORITHMS или с непомерным kid токен
    отвергается сразу. Сам kid в сообщения об ошибке не попадает — они идут
    в журнал аудита.
    """
    import jwt

    try:
        header = jwt.get_unverified_header(token)
    except jwt.exceptions.DecodeError as exc:
        raise TokenInvalid("заголовок токена не читается") from exc
    if header.get("alg") not in ALGORITHMS:
        raise TokenInvalid("алгоритм подписи не из разрешённых")
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        raise TokenInvalid("в заголовке токена нет kid")
    if len(kid) > KID_MAX:
        raise TokenInvalid("слишком длинный kid")
    return kid


def signing_key(token: str):
    """Открытый ключ, которым подписан токен: по kid из заголовка, из JWKS realm-а."""
    kid = _token_kid(token)
    url = realm_url(internal=True) + "/protocol/openid-connect/certs"
    return _jwks_client(url).key(kid)


def verify_token(token: str) -> dict[str, Any]:
    """Проверенные утверждения access-токена. Исключения: TokenInvalid, AccessRefused, DirectoryUnavailable.

    Audience у токена Keycloak по умолчанию — «account», а клиент, которому
    токен выдан, записан в azp; поэтому принимается токен, у которого наш
    клиент стоит либо в aud, либо в azp. Токен другого клиента того же
    realm-а (другого приложения) не подходит.
    """
    import jwt

    # Не JWT вовсе (три части через точку) — отказ до обращения к Keycloak.
    if token.count(".") != 2:
        raise TokenInvalid("это не JWT")
    issuer = realm_url()
    expected = client_id()
    key = signing_key(token)
    try:
        claims = jwt.decode(
            token, key, algorithms=list(ALGORITHMS), issuer=issuer, leeway=LEEWAY_SECONDS,
            options={"verify_aud": False, "require": ["exp", "iat", "sub", "iss"]},
        )
    except (jwt.exceptions.PyJWTError, TypeError, ValueError) as exc:
        # TypeError/ValueError/InvalidKeyError — alg заголовка не подходит к типу
        # ключа (например, ES256 с kid RSA-ключа): это подделка, а не сбой сервера.
        raise TokenInvalid(str(exc)) from exc
    audience = claims.get("aud")
    audience = audience if isinstance(audience, list) else [audience] if audience else []
    if claims.get("typ", "Bearer") != "Bearer":
        raise TokenInvalid(f"ожидался access-токен, а не {str(claims.get('typ'))[:40]!r}")
    if expected not in audience and claims.get("azp") != expected:
        raise AccessRefused(WRONG_CLIENT, f"wrong_client: {str(claims.get('azp'))[:64]!r}")
    return claims


def token_login(claims: dict[str, Any]) -> str:
    """Логин из токена: preferred_username в нижнем регистре, без домена.

    Для AD через федерацию Keycloak это sAMAccountName — тот же логин, что
    администратор заводит в реестре.
    """
    login = users.normalize_login(str(claims.get("preferred_username") or ""))
    if not users.valid_login(login):
        raise AccessRefused(BAD_LOGIN, f"bad_login: {login[:64]!r}")
    return login


def check_config() -> None:
    """Предупреждения о настройках, с которыми войти не получится."""
    try:
        realm_url()
        client_id()
    except DirectoryUnavailable as exc:
        log.error("Keycloak не настроен (%s) — войти в интерфейс не получится", exc)
    if not admin_logins():
        log.warning("AUTH_ADMIN_LOGINS пуст: если в реестре нет администратора, "
                    "назначать роли будет некому")
    if os.getenv("KEYCLOAK_URL", "").strip().lower().startswith("http://"):
        log.warning("KEYCLOAK_URL по http: токены ходят открытым текстом. Только для стенда")
    internal = os.getenv("KEYCLOAK_INTERNAL_URL", "").strip()
    if internal.lower().startswith("http://"):
        host = (urlsplit(internal).hostname or "").lower()
        # Имя сервиса docker (keycloak) — трафик внутри сети compose; иначе
        # ключи подписи идут по сети без TLS, и подменить их может кто угодно по пути.
        if "." in host or ":" in host or host in ("", "localhost"):
            log.warning("KEYCLOAK_INTERNAL_URL по http (%s): ключи подписи читаются без TLS и "
                        "проверки сертификата. Укажите https:// или имя сервиса docker", host or internal)
    ca_file = os.getenv("KEYCLOAK_CA_FILE", "").strip()
    if ca_file and not os.path.isfile(ca_file):
        log.error("KEYCLOAK_CA_FILE=%s не найден — ключи realm-а по https не прочитаются", ca_file)


# --------------------------------------------------------------------------
#  Учёт входов и ограничение проверок
# --------------------------------------------------------------------------


class SeenSessions:
    """Какие сессии Keycloak (claim sid) уже встречались: первый запрос с новой — это вход.

    Токены короткие и обновляются каждые несколько минут, а sid живёт всю
    сессию Keycloak, поэтому вход считается по нему. Память ограничена:
    самые старые забываются, и после очень долгого молчания вход может
    записаться ещё раз — на доступ это не влияет.
    """

    MAX_ITEMS = 10_000

    def __init__(self) -> None:
        self._items: set[str] = set()
        self._order: deque[str] = deque()
        self._lock = threading.Lock()

    def first_time(self, sid: str) -> bool:
        with self._lock:
            if sid in self._items:
                return False
            self._items.add(sid)
            self._order.append(sid)
            while len(self._order) > self.MAX_ITEMS:
                self._items.discard(self._order.popleft())
            return True

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            self._order.clear()


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


seen_sessions = SeenSessions()
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

    def account(self) -> dict[str, Any]:
        """Ответ /auth/me: плюс отметка обучения по интерфейсу и пределы проверки.

        У внешней системы с ключом обучения нет — и в реестр за ним не ходим.
        """
        seen = None if self.role == SERVICE_ROLE else users.tour_seen_at(self.login)
        return {**self.public(), "tourSeenAt": seen, "limits": limits()}


def limits() -> dict[str, int]:
    """Пределы запроса проверки: интерфейс режет пакет и текст цели по ним, а не по своим числам.

    MAX_GOALS_PER_REQUEST читается так же, как в main.py (там — проверка размера пакета);
    goalMaxChars — настройка, по ней же проверяет длину цели schemas.GoalText.
    """
    return {"maxGoalsPerRequest": _number("MAX_GOALS_PER_REQUEST", 200),
            "goalMaxChars": int(settings.number("goalMaxChars"))}


def resolve_account(login: str, sub: Optional[str] = None) -> Optional[Principal]:
    """Роль пользователя на текущий момент; None — доступа нет.

    Читается при каждом запросе, поэтому смена роли и блокировка действуют
    сразу, а не после истечения токена. sub — учётная запись Keycloak из
    токена: при первом входе запись реестра привязывается к ней, а вход с
    тем же логином, но другим sub (логин в каталоге отдали другому
    человеку) отвергается — AccessRefused. Администратор из AUTH_ADMIN_LOGINS
    привязывается так же: его узел без роли создаётся при первом входе.
    """
    builtin = login in admin_logins()
    try:
        row = users.get(login)
    except Exception as exc:  # noqa: BLE001
        log.error("Реестр пользователей недоступен: %s", exc)
        if builtin:
            # Встроенный администратор нужен именно во время сбоя графа (мониторинг,
            # настройки): пускаем без сверки sub, но отмечаем это в журнале.
            audit.event("builtin_admin_unverified", login=login, reason="registry_unavailable")
            return Principal(login, "admin")
        raise HTTPException(status_code=503, detail="Реестр пользователей недоступен, попробуйте позже") from exc
    if builtin:
        account = Principal(login, "admin")
    elif not row or row["status"] != users.ACTIVE_STATUS or row["role"] not in users.ROLES:
        return None
    else:
        account = Principal(login, row["role"], row["displayName"])
    if sub:
        bound = row["sub"] if row else None
        if bound is None:
            try:
                bound = users.bind_sub(login, sub, create=builtin)
            except Exception as exc:  # noqa: BLE001 — привяжется при следующем запросе
                log.warning("Не удалось привязать %s к учётной записи Keycloak: %s", login, exc)
        if bound is not None and bound != sub:
            raise AccessRefused(SUB_MISMATCH, "sub_mismatch")
    return account


def bearer_token(request: Request) -> Optional[str]:
    """Токен или ключ доступа из заголовка Authorization: Bearer …; None — заголовка нет."""
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


def _key_user(request: Request, token: str) -> Principal:
    if not settings.flag("apiKeysEnabled"):
        if not settings.known():
            # Граф не отвечает, и включены ли ключи — неизвестно: отказ, но не «отключено».
            raise HTTPException(status_code=503, detail=SETTINGS_UNAVAILABLE, headers={"Retry-After": "30"})
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


def _token_user(request: Request, token: str) -> Principal:
    ip = audit.client_ip(request)
    login = None
    try:
        claims = verify_token(token)
        login = token_login(claims)
        account = resolve_account(login, str(claims.get("sub") or ""))
    except TokenInvalid as exc:
        # Причина — до REASON_MAX символов: без входа строку пишет кто угодно.
        audit.event("token_rejected", ip=ip, reason=str(exc)[:REASON_MAX])
        raise HTTPException(status_code=401, detail=LOGIN_REQUIRED) from exc
    except DirectoryUnavailable as exc:
        log.error("Токен не проверен: %s", exc)
        audit.event("token_rejected", ip=ip, reason="keycloak_unavailable")
        raise HTTPException(status_code=503, detail="Сервис входа недоступен, попробуйте позже") from exc
    except AccessRefused as exc:
        if exc.reason == "sub_mismatch":
            audit.event("login_sub_mismatch", login=login, ip=ip, sub=claims.get("sub"))
        else:
            audit.event("access_denied", login=login, ip=ip, reason=exc.reason[:REASON_MAX])
        raise HTTPException(status_code=403, detail=exc.detail) from exc

    if account is None:
        audit.event("access_denied", login=login, ip=ip, reason="not_registered")
        raise HTTPException(status_code=403, detail=ACCESS_DENIED)
    # Первый запрос с новой сессией Keycloak — это вход: в журнал и в «последний вход».
    sid = str(claims.get("sid") or claims.get("sub") or "")
    if sid and seen_sessions.first_time(sid):
        users.touch_login(login)
        audit.event("login_ok", login=login, role=account.role, ip=ip)
    return account


def current_user(request: Request) -> Principal:
    """Кто делает запрос: внешняя система с ключом либо пользователь с токеном Keycloak."""
    token = bearer_token(request)
    if not token:
        raise HTTPException(status_code=401, detail=LOGIN_REQUIRED)
    if apikeys.TOKEN_RE.match(token):
        request.state.user = _key_user(request, token)
    else:
        request.state.user = _token_user(request, token)
    return request.state.user


def require(role: str) -> Callable[..., Principal]:
    """Зависимость маршрута: пользователь с ролью не ниже указанной."""

    def dependency(user: Principal = Depends(current_user)) -> Principal:
        # Обслуживание: работает только администратор; вход и /auth/me остаются.
        if user.role != "admin" and settings.flag("maintenance"):
            # Без прочитанных настроек обслуживание считается включённым (settings.flag).
            detail = MAINTENANCE if settings.known() else SETTINGS_UNAVAILABLE
            raise HTTPException(status_code=503, detail=detail, headers={"Retry-After": "300"})
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


class UserCreate(BaseModel):
    login: str = Field(..., min_length=1, max_length=64)
    role: Role
    displayName: Optional[str] = Field(None, max_length=200)


class UserPatch(BaseModel):
    role: Optional[Role] = None
    status: Optional[Literal["active", "blocked"]] = None
    displayName: Optional[str] = Field(None, max_length=200)


@router.get("/config")
def get_config():
    """Куда интерфейсу идти за входом. Открыт без входа — иначе входить неоткуда."""
    try:
        return public_config()
    except DirectoryUnavailable as exc:
        raise HTTPException(status_code=503, detail="Сервис входа не настроен на сервере") from exc


@router.post("/logout", status_code=204)
def post_logout(request: Request, user: Principal = Depends(current_user)):
    """Отметка выхода в журнале. Саму сессию закрывает Keycloak: интерфейс идёт туда следом."""
    if user.role != SERVICE_ROLE:
        audit.event("logout", login=user.login, ip=audit.client_ip(request))


@router.get("/me")
def get_me(user: Principal = Depends(current_user)):
    return user.account()


@router.post("/me/tour")
def post_me_tour(user: Principal = Depends(current_user)):
    """Пользователь прошёл или пропустил обучение по интерфейсу: больше не показывать."""
    if user.role == SERVICE_ROLE:
        raise HTTPException(status_code=403, detail="Обучение по интерфейсу — только для пользователей")
    try:
        return {"tourSeenAt": users.mark_tour_seen(user.login)}
    except Exception as exc:  # noqa: BLE001
        log.error("Реестр пользователей недоступен: %s", exc)
        raise HTTPException(status_code=503, detail="Реестр пользователей недоступен, попробуйте позже") from exc


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
                "createdAt": None, "createdBy": None, "lastLoginAt": None, "bound": False,
                "builtin": True}
               for login in sorted(builtin - known)]
    return {"users": sorted(result, key=lambda u: u["login"])}


@router.post("/users", status_code=201)
def post_user(body: UserCreate, request: Request, me: Principal = Depends(admin)):
    _guard_builtin(users.normalize_login(body.login))
    created = _handle(users.create, body.login, body.role, body.displayName, me.login)
    audit.event("user_created", login=me.login, ip=audit.client_ip(request), target=created["login"],
                role=created["role"])
    return {**created, "builtin": False}


@router.patch("/users/{login}")
def patch_user(login: str, body: UserPatch, request: Request, me: Principal = Depends(admin)):
    login = users.normalize_login(login)
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items()
               if v is not None or k == "displayName"}
    if {"role", "status"} & changes.keys():
        _guard_builtin(login)
        # Иначе последний администратор может лишить доступа сам себя.
        if login == me.login:
            raise HTTPException(status_code=409,
                                detail="Свою роль и статус менять нельзя — попросите другого администратора")
    before = _handle(users.get, login) or {}
    # Блокировка действует со следующего запроса: роль читается из реестра каждый раз.
    updated = _handle(users.update, login, changes)
    audit.event("user_changed", login=me.login, ip=audit.client_ip(request), target=login, changes=changes,
                before={k: before.get(k) for k in changes})
    return {**updated, "builtin": False}


@router.delete("/users/{login}")
def delete_user(login: str, request: Request, me: Principal = Depends(admin)):
    login = users.normalize_login(login)
    _guard_builtin(login)
    if login == me.login:
        raise HTTPException(status_code=409, detail="Свою учётную запись удалить нельзя")
    before = _handle(users.get, login) or {}
    _handle(users.delete, login)
    audit.event("user_deleted", login=me.login, ip=audit.client_ip(request), target=login,
                role=before.get("role"), status=before.get("status"))
    return {"deleted": login}


@router.delete("/users/{login}/binding")
def delete_user_binding(login: str, request: Request, me: Principal = Depends(admin)):
    """Снимает привязку записи к учётной записи Keycloak: следующий вход с логином привяжет её заново.

    Нужна, когда учётную запись в Keycloak пересоздали (новый sub) у того же
    человека; администратору из AUTH_ADMIN_LOGINS — тоже.
    """
    login = users.normalize_login(login)
    unbound = _handle(users.unbind_sub, login)
    audit.event("user_unbound", login=me.login, ip=audit.client_ip(request), target=login)
    return {**unbound, "builtin": login in admin_logins()}
