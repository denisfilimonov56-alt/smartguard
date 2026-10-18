"""Настройки сервиса, которые меняются из интерфейса: (:Setting {key, value}).

Здесь то, что администратор меняет без перезапуска: переключатели и
несколько чисел (срок жизни кэша, лимит проверок и т. п.). У чисел значение
по умолчанию берётся из переменной окружения и действует, пока настройку не
поменяли в интерфейсе. Адреса, таймауты и пределы модели остаются в
переменных окружения. Как и :User, узлы :Setting к каталогу не относятся:
в выгрузку seed.cypher не попадают, полный сброс каталога их не трогает.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

import metrics
from graph import get_driver

log = logging.getLogger(__name__)

# Значения по умолчанию — они же перечень известных настроек.
DEFAULTS: dict[str, bool | int] = {
    # Примеры правил из каталога в промпте извлечения атрибутов. Выключено,
    # пока эффект не измерен проверкой примеров (examples_check.py).
    "promptExamples": False,
    # Цель с текстом, похожим на указания модели, автоматически не разрешается.
    "injectionGuard": True,
    # К каждому найденному атрибуту модель приводит цитату из цели; цитата,
    # которой в тексте нет, отправляет цель на ручную проверку.
    "evidenceQuotes": True,
    # Сколько примеров «есть» и «нет» на атрибут уходит в промпт.
    "promptExamplesPerKind": 2,
    # Готовый ответ на ту же цель того же подразделения и срок его жизни.
    "checkCache": True,
    "checkCacheTtlSeconds": 3600,
    # Пакетная проверка (/check-goals); ручные проверки идут в любом случае.
    "bulkChecks": True,
    # Целей в минуту на пользователя или ключ доступа; 0 — без ограничения.
    "checkRatePerMinute": 600,
    # Запись проверок в историю и срок её хранения в днях; 0 — не удалять.
    "historyEnabled": True,
    "historyRetentionDays": 365,
    # Проверка по ключам доступа внешних систем.
    "apiKeysEnabled": True,
    # Обслуживание: всё, кроме входа, открыто только администратору.
    "maintenance": False,
}

# Числовые настройки: переменная окружения со значением по умолчанию и границы.
NUMBERS: dict[str, tuple[str, int, int]] = {
    "promptExamplesPerKind": ("PROMPT_EXAMPLES_PER_KIND", 1, 10),
    "checkCacheTtlSeconds": ("CHECK_CACHE_TTL_SECONDS", 0, 7 * 24 * 3600),
    "checkRatePerMinute": ("CHECK_RATE_PER_MINUTE", 0, 100_000),
    "historyRetentionDays": ("HISTORY_RETENTION_DAYS", 0, 3650),
}
# Настройки, от которых зависит промпт, а значит, и готовые ответы проверок.
PROMPT_KEYS = {"promptExamples", "promptExamplesPerKind", "injectionGuard", "evidenceQuotes"}


def default(key: str) -> bool | int:
    """Значение по умолчанию; у числа — из переменной окружения, если она задана."""
    if key not in NUMBERS:
        return DEFAULTS[key]
    env, low, high = NUMBERS[key]
    try:
        return min(max(int(os.getenv(env, "") or DEFAULTS[key]), low), high)
    except ValueError:
        log.warning("%s должно быть числом, используется %d", env, DEFAULTS[key])
        return DEFAULTS[key]


def _valid(key: str, value: Any) -> bool:
    if key not in NUMBERS:
        return isinstance(value, bool)
    _, low, high = NUMBERS[key]
    return type(value) is int and low <= value <= high


def _run(query: str, **params) -> list[dict[str, Any]]:
    with get_driver().session() as session:
        return [dict(record) for record in session.run(query, **params)]


def _read() -> dict[str, Any]:
    return {row["key"]: row["value"] for row in
            _run("MATCH (s:Setting) RETURN s.key AS key, s.value AS value")}


def read_all() -> dict[str, bool | int]:
    """Все настройки: сохранённые значения поверх значений по умолчанию."""
    stored = _read()
    return {key: stored[key] if _valid(key, stored.get(key)) else default(key) for key in DEFAULTS}


def flag(name: str) -> bool | int:
    """Значение настройки для проверки цели.

    Читается из графа не чаще раза в минуту; правка через API действует сразу.
    Если прочитать не удалось, берётся значение по умолчанию: настройка не
    должна ронять проверку.
    """
    try:
        return metrics.lookups.load(("settings",), read_all)[name]
    except Exception as exc:  # noqa: BLE001
        log.warning("Настройки не прочитаны, %s = %s по умолчанию: %s", name, default(name), exc)
        return default(name)


# Число читается так же, как переключатель; отдельное имя — для читаемости вызовов.
number = flag


def update(changes: dict[str, bool | int], login: str) -> dict[str, bool | int]:
    """Сохраняет настройки. Ключи вне DEFAULTS и значения вне границ игнорируются."""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    saved = set()
    for key, value in changes.items():
        if key in DEFAULTS and _valid(key, value):
            _run(
                """
                MERGE (s:Setting {key: $key})
                SET s.value = $value, s.updatedAt = $now, s.updatedBy = $login
                """,
                key=key, value=value, now=now, login=login,
            )
            saved.add(key)
    if saved & PROMPT_KEYS:
        # Промпт стал другим — готовые ответы проверок больше не годятся.
        metrics.catalog_changed()
    else:
        metrics.lookups.clear()
    return read_all()
