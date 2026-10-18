"""Реестр пользователей интерфейса: (:User {login, role, status, displayName, sub}).

Паролей здесь нет — кто пользователь, решает Keycloak, см. auth.py.
Реестр отвечает на другой вопрос: кому из прошедших проверку пароля можно
в интерфейс и с какой ролью. Узлы :User в выгрузку seed.cypher не попадают
(export_graph.py берёт только метки каталога) и через /catalog/nodes
недоступны (catalog._fetch_node видит только узлы каталога).

Запись привязана к учётной записи Keycloak (sub) при первом входе: логин
в каталоге может достаться другому человеку, и без привязки роль перешла
бы к нему вместе с логином (см. auth.resolve_account).
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

# Логин — preferred_username из токена Keycloak (для AD это sAMAccountName,
# без домена). Набор символов жёсткий: логин попадает в запросы к графу и
# в журнал, и ничего похожего на DN или фильтр каталога в нём быть не должно.
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
    # Узел без роли — только отметки (обучение, привязка) бывшего или
    # нынешнего администратора из AUTH_ADMIN_LOGINS: доступа он не даёт,
    # и «активным» его не показываем.
    role = props.get("role")
    return {
        "login": props.get("login"),
        "role": role,
        "status": props.get("status") or (ACTIVE_STATUS if role else None),
        "bound": bool(props.get("sub")),
        "displayName": props.get("displayName"),
        "createdAt": props.get("createdAt"),
        "createdBy": props.get("createdBy"),
        "lastLoginAt": props.get("lastLoginAt"),
        "tourSeenAt": props.get("tourSeenAt"),
    }


def get(login: str) -> Optional[dict[str, Any]]:
    """Запись реестра; плюс служебное поле sub — наружу из API оно не отдаётся."""
    rows = _run("MATCH (u:User {login: $login}) RETURN properties(u) AS props", login=login)
    return {**_public(rows[0]["props"]), "sub": rows[0]["props"].get("sub")} if rows else None


def list_users() -> list[dict[str, Any]]:
    rows = _run("MATCH (u:User) RETURN properties(u) AS props, u.login AS login ORDER BY login")
    return [_public(row["props"]) for row in rows]


def create(login: str, role: str, display_name: Optional[str], created_by: str) -> dict[str, Any]:
    login = normalize_login(login)
    if not valid_login(login):
        raise Conflict("Логин — латинские буквы, цифры, точка, дефис и подчёркивание, до 64 символов")
    if role not in ROLES:
        raise Conflict(f"Недопустимая роль {role!r}, ожидалась одна из {ROLES}")
    existing = get(login)
    if existing and existing["role"]:
        raise Conflict(f"Пользователь {login!r} уже есть в реестре")
    if existing:
        # Узел без роли (отметки бывшего администратора из AUTH_ADMIN_LOGINS)
        # занимается: отметки остаются, а привязка к учётной записи Keycloak
        # снимается — роль выдают заново, и привязана она будет, как у новой
        # записи, к тому, кто войдёт первым, а не к прежнему владельцу логина.
        rows = _run(
            "MATCH (u:User {login: $login}) WHERE u.role IS NULL SET u += $props REMOVE u.sub "
            "RETURN properties(u) AS props",
            login=login, props={"role": role, "status": ACTIVE_STATUS,
                                "displayName": (display_name or "").strip() or None,
                                "createdAt": _now(), "createdBy": created_by},
        )
        if not rows:
            raise Conflict(f"Пользователь {login!r} уже есть в реестре")
        return _public(rows[0]["props"])
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


def bind_sub(login: str, sub: str, create: bool = False) -> Optional[str]:
    """Привязывает запись к учётной записи Keycloak, если она ещё не привязана.

    Возвращает прежнюю привязку: None — запись привязана сейчас к sub.
    create — для администратора из AUTH_ADMIN_LOGINS, у которого записи
    может не быть: создаётся узел без роли, как для отметки обучения.
    """
    rows = _run(
        ("MERGE" if create else "MATCH") + """ (u:User {login: $login})
        // Сначала блокировка записи узла, потом чтение: два одновременных первых
        // входа разных учётных записей не должны оба увидеть «не привязан».
        SET u._lock = true REMOVE u._lock
        WITH u, u.sub AS before
        SET u.sub = coalesce(before, $sub)
        RETURN before
        """,
        login=login, sub=sub,
    )
    return rows[0]["before"] if rows else None


def unbind_sub(login: str) -> dict[str, Any]:
    """Снимает привязку: следующий вход с этим логином привяжет запись заново."""
    rows = _run("MATCH (u:User {login: $login}) REMOVE u.sub RETURN properties(u) AS props", login=login)
    if not rows:
        raise NotFound(f"Пользователя {login!r} нет в реестре")
    return _public(rows[0]["props"])


def tour_seen_at(login: str) -> Optional[str]:
    """Когда пользователь прошёл обучение по интерфейсу; None — ещё не проходил.

    Сбой реестра обучение не отменяет: оно просто покажется ещё раз.
    """
    try:
        row = get(login)
    except Exception as exc:  # noqa: BLE001
        log.warning("Не удалось прочитать отметку обучения %s: %s", login, exc)
        return None
    return row["tourSeenAt"] if row else None


def mark_tour_seen(login: str) -> str:
    """Отметка, что пользователь прошёл обучение по интерфейсу.

    У администратора из AUTH_ADMIN_LOGINS узла в реестре может не быть —
    тогда он создаётся только с логином и отметкой, без роли и статуса:
    доступ по-прежнему даёт лишь список в настройках сервера.
    """
    now = _now()
    _run("MERGE (u:User {login: $login}) SET u.tourSeenAt = $now", login=login, now=now)
    return now


def touch_login(login: str) -> None:
    """Отметка времени последнего входа. Сбой здесь вход не отменяет."""
    try:
        _run("MATCH (u:User {login: $login}) SET u.lastLoginAt = $now", login=login, now=_now())
    except Exception as exc:  # noqa: BLE001
        log.warning("Не удалось записать время входа %s: %s", login, exc)
