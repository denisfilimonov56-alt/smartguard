"""Реестр пользователей интерфейса: (:User {login, role, status, displayName}).

Пароли здесь не хранятся — их проверяет каталог (LDAP/AD), см. auth.py.
Реестр отвечает на другой вопрос: кому из прошедших проверку пароля можно
в интерфейс и с какой ролью. Узлы :User в выгрузку seed.cypher не попадают
(export_graph.py берёт только метки каталога) и через /catalog/nodes
недоступны (catalog._fetch_node видит только узлы каталога).
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

from graph import get_driver

log = logging.getLogger(__name__)

# По возрастанию прав: каждая следующая роль умеет всё, что предыдущая.
ROLES = ("viewer", "editor", "admin")
ACTIVE_STATUS = "active"
BLOCKED_STATUS = "blocked"
STATUSES = (ACTIVE_STATUS, BLOCKED_STATUS)

# Логин подставляется в шаблон имени для LDAP bind, поэтому набор символов
# жёсткий: ничего, что имело бы смысл в DN или в фильтре поиска.
LOGIN_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


class UserError(RuntimeError):
    """Базовая ошибка реестра."""


class NotFound(UserError):
    """Пользователя нет в реестре."""


class Conflict(UserError):
    """Операция противоречит состоянию реестра."""


def normalize_login(value: str) -> str:
    return (value or "").strip().lower()


def valid_login(login: str) -> bool:
    return bool(LOGIN_RE.match(login))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _run(query: str, **params) -> list[dict[str, Any]]:
    with get_driver().session() as session:
        return [dict(record) for record in session.run(query, **params)]


def _public(props: dict[str, Any]) -> dict[str, Any]:
    return {
        "login": props.get("login"),
        "role": props.get("role"),
        "status": props.get("status") or ACTIVE_STATUS,
        "displayName": props.get("displayName"),
        "createdAt": props.get("createdAt"),
        "createdBy": props.get("createdBy"),
        "lastLoginAt": props.get("lastLoginAt"),
    }


def get(login: str) -> Optional[dict[str, Any]]:
    rows = _run("MATCH (u:User {login: $login}) RETURN properties(u) AS props", login=login)
    return _public(rows[0]["props"]) if rows else None


def list_users() -> list[dict[str, Any]]:
    rows = _run("MATCH (u:User) RETURN properties(u) AS props, u.login AS login ORDER BY login")
    return [_public(row["props"]) for row in rows]


def create(login: str, role: str, display_name: Optional[str], created_by: str) -> dict[str, Any]:
    login = normalize_login(login)
    if not valid_login(login):
        raise Conflict("Логин — латинские буквы, цифры, точка, дефис и подчёркивание, до 64 символов")
    if role not in ROLES:
        raise Conflict(f"Недопустимая роль {role!r}, ожидалась одна из {ROLES}")
    if get(login):
        raise Conflict(f"Пользователь {login!r} уже есть в реестре")
    rows = _run(
        """
        CREATE (u:User {login: $login, role: $role, status: $status,
                        displayName: $display_name, createdAt: $now, createdBy: $created_by})
        RETURN properties(u) AS props
        """,
        login=login, role=role, status=ACTIVE_STATUS,
        display_name=(display_name or "").strip() or None, now=_now(), created_by=created_by,
    )
    return _public(rows[0]["props"])


def update(login: str, changes: dict[str, Any]) -> dict[str, Any]:
    """Меняет роль, статус или отображаемое имя. Ключи вне этого набора игнорируются."""
    if "role" in changes and changes["role"] not in ROLES:
        raise Conflict(f"Недопустимая роль {changes['role']!r}, ожидалась одна из {ROLES}")
    if "status" in changes and changes["status"] not in STATUSES:
        raise Conflict(f"Недопустимый статус {changes['status']!r}, ожидался один из {STATUSES}")
    props = {k: changes[k] for k in ("role", "status") if k in changes}
    if "displayName" in changes:
        props["displayName"] = (changes["displayName"] or "").strip() or None
    rows = _run(
        "MATCH (u:User {login: $login}) SET u += $props RETURN properties(u) AS props",
        login=login, props=props,
    )
    if not rows:
        raise NotFound(f"Пользователя {login!r} нет в реестре")
    return _public(rows[0]["props"])


def delete(login: str) -> None:
    rows = _run(
        "MATCH (u:User {login: $login}) WITH u, u.login AS login DETACH DELETE u RETURN login",
        login=login,
    )
    if not rows:
        raise NotFound(f"Пользователя {login!r} нет в реестре")


def touch_login(login: str) -> None:
    """Отметка времени последнего входа. Сбой здесь вход не отменяет."""
    try:
        _run("MATCH (u:User {login: $login}) SET u.lastLoginAt = $now", login=login, now=_now())
    except Exception as exc:  # noqa: BLE001
        log.warning("Не удалось записать время входа %s: %s", login, exc)
