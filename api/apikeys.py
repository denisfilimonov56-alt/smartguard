"""Ключи доступа внешних систем: (:ApiKey {keyId, name, hash, createdAt, createdBy, lastUsedAt}).

Кадровая система проверяет цели без человека, которому можно было бы
войти через домен. Ей выдаётся ключ: он передаётся в заголовке
`Authorization: Bearer …` и открывает только проверку целей (auth.checker).

Ключ имеет вид gc_<keyId>_<секрет>. В графе хранится SHA-256 секрета — сам
ключ показывается один раз, при создании. Секрет случайный и длинный,
поэтому медленный хеш, как для паролей, здесь не нужен. Как и :User, узлы
:ApiKey к каталогу не относятся: в выгрузку не попадают, сброс каталога их
не трогает, через /catalog/nodes они недоступны.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

from graph import get_driver

log = logging.getLogger(__name__)

PREFIX = "gc"
TOKEN_RE = re.compile(rf"^{PREFIX}_([0-9a-f]{{8}})_([A-Za-z0-9_-]{{20,100}})$")
NAME_MAX = 60
# Найденный ключ помнится недолго: отзыв через API действует сразу (кэш
# сбрасывается), удаление узла в обход API — не позже чем через этот срок.
CACHE_SECONDS = 30
# Время последнего использования пишется не на каждый запрос.
TOUCH_SECONDS = 60


class KeyError_(RuntimeError):
    """Базовая ошибка реестра ключей."""


class NotFound(KeyError_):
    """Такого ключа нет."""


class Conflict(KeyError_):
    """Операция противоречит состоянию реестра."""


_lock = threading.Lock()
_cache: dict[str, tuple[float, Optional[dict[str, Any]]]] = {}
_touched: dict[str, float] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _run(query: str, **params) -> list[dict[str, Any]]:
    with get_driver().session() as session:
        return [dict(record) for record in session.run(query, **params)]


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _public(props: dict[str, Any]) -> dict[str, Any]:
    return {
        "keyId": props.get("keyId"),
        "name": props.get("name"),
        "createdAt": props.get("createdAt"),
        "createdBy": props.get("createdBy"),
        "lastUsedAt": props.get("lastUsedAt"),
    }


def forget() -> None:
    """Сбросить память о найденных ключах (после создания и отзыва; в тестах)."""
    with _lock:
        _cache.clear()
        _touched.clear()


def list_keys() -> list[dict[str, Any]]:
    rows = _run("MATCH (k:ApiKey) RETURN properties(k) AS props, k.name AS name ORDER BY name")
    return [_public(row["props"]) for row in rows]


def create(name: str, created_by: str) -> dict[str, Any]:
    """Заводит ключ. В ответе — поле key: сам ключ, больше его увидеть нельзя."""
    name = " ".join((name or "").split())
    if not name or len(name) > NAME_MAX:
        raise Conflict(f"Название ключа — от 1 до {NAME_MAX} символов")
    # Название попадает в историю проверок как «кто проверял» — оно должно различать системы.
    if any(k["name"].lower() == name.lower() for k in list_keys()):
        raise Conflict(f"Ключ с названием {name!r} уже есть")
    key_id, secret = secrets.token_hex(4), secrets.token_urlsafe(32)
    rows = _run(
        """
        CREATE (k:ApiKey {keyId: $key_id, name: $name, hash: $hash,
                          createdAt: $now, createdBy: $created_by})
        RETURN properties(k) AS props
        """,
        key_id=key_id, name=name, hash=_hash(secret), now=_now(), created_by=created_by,
    )
    forget()
    return {**_public(rows[0]["props"]), "key": f"{PREFIX}_{key_id}_{secret}"}


def delete(key_id: str) -> dict[str, Any]:
    """Отзывает ключ: следующий запрос с ним получит 401."""
    rows = _run(
        """
        MATCH (k:ApiKey {keyId: $key_id})
        WITH k, properties(k) AS props
        DETACH DELETE k
        RETURN props
        """,
        key_id=key_id,
    )
    forget()
    if not rows:
        raise NotFound("Ключ не найден — возможно, его уже отозвали")
    return _public(rows[0]["props"])


def resolve(token: str) -> Optional[dict[str, Any]]:
    """Ключ по предъявленной строке; None — такого ключа нет или секрет не тот."""
    match = TOKEN_RE.match(token or "")
    if not match:
        return None
    key_id, secret = match.groups()
    now = time.monotonic()
    with _lock:
        cached = _cache.get(key_id)
    if cached and cached[0] > now:
        props = cached[1]
    else:
        rows = _run("MATCH (k:ApiKey {keyId: $key_id}) RETURN properties(k) AS props", key_id=key_id)
        props = rows[0]["props"] if rows else None
        with _lock:
            _cache[key_id] = (now + CACHE_SECONDS, props)
    if not props or not hmac.compare_digest(str(props.get("hash") or ""), _hash(secret)):
        return None
    _touch(key_id, now)
    return _public(props)


def _touch(key_id: str, now: float) -> None:
    """Отметка времени последнего использования. Сбой здесь запрос не отменяет."""
    with _lock:
        if now - _touched.get(key_id, float("-inf")) < TOUCH_SECONDS:
            return
        _touched[key_id] = now
    try:
        _run("MATCH (k:ApiKey {keyId: $key_id}) SET k.lastUsedAt = $now", key_id=key_id, now=_now())
    except Exception as exc:  # noqa: BLE001
        log.warning("Не удалось записать время использования ключа %s: %s", key_id, exc)
