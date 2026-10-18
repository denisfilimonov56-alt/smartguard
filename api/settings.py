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
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

from neo4j import Query

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
    # Оценка цели по SMART отдельным запросом к модели — справка автору,
    # на статус проверки не влияет.
    "smartCheck": True,
    # Оценка SMART и в пакетной проверке (/check-goals); выключено — пакет
    # идёт без отдельного запроса к модели на каждую цель.
    "smartCheckBulk": True,
    # Сколько примеров «есть» и «нет» на атрибут уходит в промпт.
    "promptExamplesPerKind": 2,
    # Готовый ответ на ту же цель того же подразделения и срок его жизни.
    "checkCache": True,
    "checkCacheTtlSeconds": 3600,
    # Сколько секунд проверка помнит должностные инструкции и правила на них
    # между целями одного подразделения; 0 — читать из графа на каждую цель.
    "jobDescriptionsCacheTtlSeconds": 60,
    # Пакетная проверка (/check-goals); ручные проверки идут в любом случае.
    "bulkChecks": True,
    # Целей в минуту на пользователя или ключ доступа; 0 — без ограничения.
    "checkRatePerMinute": 600,
    # Предел длины цели в символах — для проверки, пакета и советчика. Текст
    # цели целиком уходит в промпт: выше верхней границы (NUMBERS) цель вместе
    # с должностными инструкциями рискует не поместиться в окно модели.
    "goalMaxChars": 4000,
    # Запись проверок в историю и срок её хранения в днях; 0 — не удалять.
    "historyEnabled": True,
    "historyRetentionDays": 365,
    # Проверка по ключам доступа внешних систем.
    "apiKeysEnabled": True,
    # Обслуживание: всё, кроме входа, открыто только администратору.
    "maintenance": False,
    # Одновременных запросов к модели на весь сервис и сколько слотов из них
    # недоступно пакетной проверке. Правильные числа зависят от видеокарты
    # и подбираются по «Мониторингу», поэтому это настройки, а не константы;
    # действуют сразу, перезапуск api не нужен (metrics.gate).
    "llmMaxConcurrency": 32,
    "llmInteractiveReserve": 4,
}

# Числовые настройки: переменная окружения со значением по умолчанию и границы.
NUMBERS: dict[str, tuple[str, int, int]] = {
    "promptExamplesPerKind": ("PROMPT_EXAMPLES_PER_KIND", 1, 10),
    "checkCacheTtlSeconds": ("CHECK_CACHE_TTL_SECONDS", 0, 7 * 24 * 3600),
    "jobDescriptionsCacheTtlSeconds": ("JOB_DESCRIPTIONS_CACHE_TTL_SECONDS", 0, 24 * 3600),
    "checkRatePerMinute": ("CHECK_RATE_PER_MINUTE", 0, 100_000),
    "goalMaxChars": ("GOAL_MAX_CHARS", 100, 8000),
    "historyRetentionDays": ("HISTORY_RETENTION_DAYS", 0, 3650),
    "llmMaxConcurrency": ("LLM_MAX_CONCURRENCY", 1, 256),
    "llmInteractiveReserve": ("LLM_INTERACTIVE_RESERVE", 0, 255),
}
# Настройки очереди к модели: их правка будит ждущие в очереди потоки.
LLM_KEYS = {"llmMaxConcurrency", "llmInteractiveReserve"}
# Настройки, от которых зависит промпт, а значит, и готовые ответы проверок.
PROMPT_KEYS = {"promptExamples", "promptExamplesPerKind", "injectionGuard", "evidenceQuotes", "smartCheck",
               "smartCheckBulk"}
# Защитные переключатели: если настройки ни разу не прочитаны, они берутся
# в сторону запрета, а не значения по умолчанию.
FAIL_CLOSED: dict[str, bool] = {"apiKeysEnabled": False, "maintenance": True}
# После сбоя чтения граф не спрашивают столько секунд: иначе каждая проверка
# (а это до полутора десятков обращений к настройкам) ждала бы таймаута заново.
FAILURE_PAUSE_SECONDS = 5
# Предел ожидания ответа графа на запрос настроек, секунд.
QUERY_TIMEOUT_SECONDS = 5

_now = time.monotonic
_state_lock = threading.Lock()
_last_good: Optional[dict[str, bool | int]] = None
_failed_until = float("-inf")


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
        return [dict(record) for record in session.run(Query(query, timeout=QUERY_TIMEOUT_SECONDS), **params)]


def _read() -> dict[str, Any]:
    return {row["key"]: row["value"] for row in
            _run("MATCH (s:Setting) RETURN s.key AS key, s.value AS value")}


def _clip_reserve(values: dict[str, bool | int]) -> dict[str, bool | int]:
    """Резерв ручных проверок не больше предела минус один: пакету нужен хотя бы один слот.

    Проверяется при чтении, а не при сохранении: _valid смотрит на каждый ключ
    отдельно, а здесь два ключа связаны, и порядок их правки не должен мешать.
    """
    values["llmInteractiveReserve"] = min(values["llmInteractiveReserve"], values["llmMaxConcurrency"] - 1)
    return values


def read_all() -> dict[str, bool | int]:
    """Все настройки: сохранённые значения поверх значений по умолчанию."""
    stored = _read()
    return _clip_reserve({key: stored[key] if _valid(key, stored.get(key)) else default(key) for key in DEFAULTS})


class _Paused(RuntimeError):
    """Граф недавно не ответил — повторять рано."""


def _load() -> dict[str, bool | int]:
    with _state_lock:
        paused = _now() < _failed_until
    if paused:
        # Потоки, ждавшие очереди к тому же ключу кэша, не идут в граф друг за другом.
        raise _Paused("граф недавно не ответил")
    return read_all()


def current() -> dict[str, bool | int]:
    """Все настройки для проверки цели: из кэша, графа или последнего удачного чтения.

    Читаются из графа не чаще раза в минуту; правка через API действует
    сразу. Если прочитать не удалось, служит последнее удачно прочитанное
    значение, а пока его нет — значения по умолчанию, у защитных
    переключателей (FAIL_CLOSED) — в сторону запрета. Неудача помнится
    FAILURE_PAUSE_SECONDS: настройка не должна ронять или тормозить проверку.
    """
    global _last_good, _failed_until
    try:
        values = metrics.lookups.load(("settings",), _load)
    except Exception as exc:  # noqa: BLE001
        with _state_lock:
            if not isinstance(exc, _Paused):
                _failed_until = _now() + FAILURE_PAUSE_SECONDS
                log.warning("Настройки не прочитаны, служат %s: %s",
                            "прежние" if _last_good is not None else "значения по умолчанию", exc)
            if _last_good is not None:
                return _last_good
        return {**{key: default(key) for key in DEFAULTS}, **FAIL_CLOSED}
    with _state_lock:
        _last_good = values
    return values


def known() -> bool:
    """Есть ли прочитанные из графа настройки (свежие или последние удачные)."""
    current()
    with _state_lock:
        return _last_good is not None


def forget() -> None:
    """Забыть последнее удачное чтение и паузу после сбоя (тесты)."""
    global _last_good, _failed_until
    with _state_lock:
        _last_good, _failed_until = None, float("-inf")


def flag(name: str) -> bool | int:
    """Значение одной настройки для проверки цели, см. current()."""
    return current()[name]


# Число читается так же, как переключатель; отдельное имя — для читаемости вызовов.
number = flag


def llm_limits() -> tuple[int, int]:
    """Ёмкость очереди к модели и резерв ручных проверок — поставщик для metrics.gate."""
    capacity = int(number("llmMaxConcurrency"))
    # read_all уже обрезал резерв; обрезка повторяется на случай значений по умолчанию при сбое графа.
    return capacity, min(int(number("llmInteractiveReserve")), capacity - 1)


def update(changes: dict[str, bool | int], login: str) -> dict[str, bool | int]:
    """Сохраняет настройки. Ключи вне DEFAULTS и значения вне границ игнорируются."""
    global _last_good, _failed_until
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
    if "smartCheck" in saved:
        # Оценки SMART переживают правки каталога, но не смену самой настройки.
        metrics.smart_scores.clear()
    if saved & LLM_KEYS:
        # Ждущие в очереди к модели перечитывают предел сразу, без перезапуска.
        metrics.gate.reconfigure()
    values = read_all()
    with _state_lock:
        _last_good, _failed_until = values, float("-inf")
    return values
