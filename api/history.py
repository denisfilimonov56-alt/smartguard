"""История проверок: (:CheckRecord {at, ms, status, departmentId, login, mode, ...}).

Каждая проверка цели оставляет запись: когда, кто, сколько заняла, чем
закончилась. Записи копятся в очереди и пишутся в Neo4j фоновым потоком
пачками — массовая проверка не ждёт базу на каждой цели. К каталогу узлы
не относятся: в выгрузку seed.cypher не попадают, полный сброс каталога их
не трогает, /catalog/nodes их не видит.
"""

from __future__ import annotations

import logging
import queue
import re
import threading
import time
from collections import deque
from datetime import datetime
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import graph
import metrics
import settings

log = logging.getLogger(__name__)

FLUSH_SECONDS = 2.0
WRITE_BATCH = 2000
PRUNE_EVERY_SECONDS = 6 * 3600
# Записи, которые не удалось записать (Neo4j недоступен), ждут повтора здесь;
# сверх предела старые теряются. Повтор — с растущей паузой до RETRY_MAX_SECONDS.
RETRY_MAX_ROWS = 50_000
RETRY_MAX_SECONDS = 60.0

STEPS = ("minute", "hour", "day", "week", "month")
STATUSES = ("ALLOWED", "VIOLATIONS_FOUND", "NEEDS_MANUAL_REVIEW")
MODES = ("single", "bulk")
MAX_BUCKETS = 2000
_TIMEZONE = re.compile(r"^[A-Za-z_]+(/[A-Za-z0-9_+\-]+){0,2}$")
_OFFSET = re.compile(r"^[+-](0\d|1[0-4]):[0-5]\d$")

Q_WRITE = """
UNWIND $rows AS row
CREATE (r:CheckRecord)
SET r = row, r.at = datetime(row.at)
"""

Q_PRUNE = """
MATCH (r:CheckRecord)
WHERE r.at < datetime() - duration({days: $days})
WITH r LIMIT 50000
DELETE r
RETURN count(*) AS deleted
"""

FILTER = """r.at >= datetime($start) AND r.at < datetime($end)
  AND ($status IS NULL OR r.status = $status)
  AND ($mode IS NULL OR r.mode = $mode)"""

AGGREGATES = """count(r) AS total,
       round(avg(r.ms)) AS avg_ms,
       round(avg(CASE WHEN r.cached THEN null ELSE r.ms END)) AS avg_computed_ms,
       round(percentileCont(CASE WHEN r.cached THEN null ELSE r.ms END, 0.95)) AS p95_ms,
       max(r.ms) AS max_ms,
       round(avg(CASE WHEN r.cached THEN null ELSE r.queueMs END)) AS avg_queue_ms,
       round(avg(CASE WHEN r.cached THEN null ELSE r.llmMs END)) AS avg_llm_ms,
       sum(r.llmCalls) AS llm_calls,
       sum(CASE WHEN r.cached THEN 1 ELSE 0 END) AS cached,
       sum(CASE WHEN r.status = 'ALLOWED' THEN 1 ELSE 0 END) AS allowed,
       sum(CASE WHEN r.status = 'VIOLATIONS_FOUND' THEN 1 ELSE 0 END) AS violations,
       sum(CASE WHEN r.status = 'NEEDS_MANUAL_REVIEW' THEN 1 ELSE 0 END) AS manual_review"""

Q_TOTALS = f"""
MATCH (r:CheckRecord)
WHERE {FILTER}
RETURN {AGGREGATES}
"""

# Единица усечения подставляется в текст запроса: она из фиксированного списка STEPS.
Q_BUCKETS = """
MATCH (r:CheckRecord)
WHERE {filter}
WITH r, datetime.truncate('{step}', datetime({{datetime: r.at, timezone: $timezone}})) AS bucket
RETURN toString(bucket) AS bucket,
       {aggregates}
ORDER BY bucket
LIMIT {limit}
"""

Q_LIST = f"""
MATCH (r:CheckRecord)
WHERE {FILTER}
WITH r ORDER BY r.at DESC SKIP $offset LIMIT $limit
RETURN toString(r.at) AS at, r.ms AS ms, r.status AS status, r.departmentId AS department_id,
       r.login AS login, r.mode AS mode, r.batchId AS batch_id, r.cached AS cached,
       r.llmCalls AS llm_calls, r.llmMs AS llm_ms, r.queueMs AS queue_ms,
       r.violations AS violations, r.goal AS goal
"""


Q_COUNT = f"""
MATCH (r:CheckRecord)
WHERE {FILTER}
RETURN count(r) AS total
"""

MAX_PAGE = 100


class BadRequest(ValueError):
    """Недопустимые параметры отбора."""


def _run(query: str, **params) -> list[dict[str, Any]]:
    with graph.get_driver().session() as session:
        return [dict(record) for record in session.run(query, **params)]


# --------------------------------------------------------------------------
#  Запись
# --------------------------------------------------------------------------

_pending: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=200_000)
_dropped = 0
_retry: "deque[dict[str, Any]]" = deque()
_retry_lock = threading.Lock()
_backoff = 0.0
_retry_at = 0.0
_stop = threading.Event()
_thread: Optional[threading.Thread] = None


def _enqueue(record: dict[str, Any]) -> None:
    """Проверка не должна ждать историю: при переполнении запись теряется, а не блокирует."""
    global _dropped
    if not settings.flag("historyEnabled"):
        return
    try:
        _pending.put_nowait(record)
    except queue.Full:
        _dropped += 1


def _take() -> list[dict[str, Any]]:
    """Следующая пачка: сначала то, что не записалось в прошлый раз."""
    rows: list[dict[str, Any]] = []
    with _retry_lock:
        while _retry and len(rows) < WRITE_BATCH:
            rows.append(_retry.popleft())
    while len(rows) < WRITE_BATCH:
        try:
            rows.append(_pending.get_nowait())
        except queue.Empty:
            break
    return rows


def _put_back(rows: list[dict[str, Any]]) -> None:
    """Возвращает пачку в начало буфера повтора; сверх RETRY_MAX_ROWS теряются самые старые."""
    global _dropped
    with _retry_lock:
        _retry.extendleft(reversed(rows))
        while len(_retry) > RETRY_MAX_ROWS:
            _retry.popleft()
            _dropped += 1


def flush(force: bool = False) -> int:
    """Пишет накопленное в Neo4j. Возвращает число записей.

    При сбое пачка возвращается в буфер повтора, а следующая попытка — после
    паузы, которая растёт вдвое до RETRY_MAX_SECONDS (force — не ждать паузы).
    """
    global _backoff, _retry_at
    if not force and time.monotonic() < _retry_at:
        return 0
    written = 0
    while True:
        rows = _take()
        if not rows:
            return written
        try:
            _run(Q_WRITE, rows=rows)
            written += len(rows)
            _backoff = _retry_at = 0.0
        except Exception as exc:  # noqa: BLE001 — история не должна ронять сервис
            _put_back(rows)
            _backoff = min(RETRY_MAX_SECONDS, max(FLUSH_SECONDS, _backoff * 2))
            _retry_at = time.monotonic() + _backoff
            log.warning("История проверок не записана (%d записей), повтор через %.0f с: %s",
                        len(rows), _backoff, exc)
            return written


def prune() -> None:
    days = settings.number("historyRetentionDays")
    if not days:
        return
    try:
        while _run(Q_PRUNE, days=days)[0]["deleted"]:
            pass
    except Exception as exc:  # noqa: BLE001
        log.warning("Очистка истории проверок не выполнена: %s", exc)


def _loop() -> None:
    next_prune = time.monotonic() + 60
    while not _stop.wait(FLUSH_SECONDS):
        flush()
        if time.monotonic() >= next_prune:
            next_prune = time.monotonic() + PRUNE_EVERY_SECONDS
            prune()
    flush(force=True)


def start() -> None:
    """Запускает фоновую запись. Вызывается на старте приложения."""
    global _thread
    if _thread is None:
        metrics.subscribe(_enqueue)
        _stop.clear()
        _thread = threading.Thread(target=_loop, name="history-writer", daemon=True)
        _thread.start()


def stop() -> None:
    """Останавливает запись: отписывается от проверок и дописывает накопленное."""
    global _thread
    metrics.unsubscribe(_enqueue)
    if _thread is not None:
        _stop.set()
        _thread.join(timeout=10)
        _thread = None


def state() -> dict[str, Any]:
    return {"pending": _pending.qsize() + len(_retry), "dropped": _dropped, "retention_days": settings.number("historyRetentionDays"),
            "enabled": settings.flag("historyEnabled")}


# --------------------------------------------------------------------------
#  Чтение
# --------------------------------------------------------------------------


def _moment(value: str, name: str) -> str:
    """Граница периода в ISO 8601; неверная — BadRequest, а не ошибка базы."""
    text = (value or "").strip()
    try:
        # «Z» Python до 3.11 не понимает.
        moment = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text)
    except ValueError:
        raise BadRequest(f"Недопустимая дата {name}={value!r}: ожидалась дата ISO 8601, "
                         "например 2026-10-01T00:00:00Z") from None
    return moment.isoformat()


def _check_timezone(timezone: str) -> None:
    if _OFFSET.match(timezone):
        return
    if _TIMEZONE.match(timezone):
        try:
            ZoneInfo(timezone)
            return
        except (ZoneInfoNotFoundError, ValueError):
            # В образе без базы часовых поясов — та же база из pytz (её тянет драйвер neo4j).
            try:
                import pytz

                pytz.timezone(timezone)
                return
            except Exception:  # noqa: BLE001 — неизвестный пояс или нет pytz
                pass
    raise BadRequest(f"Недопустимый часовой пояс {timezone!r}: ожидалось имя вроде "
                     "Europe/Moscow или смещение вроде +03:00")


def _filter(start: str, end: str, status: Optional[str], mode: Optional[str]) -> dict[str, Any]:
    start, end = _moment(start, "start"), _moment(end, "end")
    if status and status not in STATUSES:
        raise BadRequest(f"Недопустимый статус {status!r}, ожидался один из {STATUSES}")
    if mode and mode not in MODES:
        raise BadRequest(f"Недопустимый режим {mode!r}, ожидался один из {MODES}")
    return {"start": start, "end": end, "status": status or None, "mode": mode or None}


def stats(start: str, end: str, step: str = "day", timezone: str = "UTC",
          status: Optional[str] = None, mode: Optional[str] = None) -> dict[str, Any]:
    """Средние показатели за период с разбивкой по шагу step."""
    if step not in STEPS:
        raise BadRequest(f"Недопустимая периодичность {step!r}, ожидалась одна из {STEPS}")
    _check_timezone(timezone)
    params = _filter(start, end, status, mode)
    buckets = _run(
        Q_BUCKETS.format(filter=FILTER, step=step, aggregates=AGGREGATES, limit=MAX_BUCKETS + 1),
        timezone=timezone, **params,
    )
    if len(buckets) > MAX_BUCKETS:
        raise BadRequest("Слишком мелкая периодичность для такого периода: "
                         f"получается больше {MAX_BUCKETS} интервалов")
    totals = _run(Q_TOTALS, **params)
    return {"step": step, "timezone": timezone, "totals": totals[0] if totals else None,
            "buckets": buckets}


def records(start: str, end: str, limit: int = 10, offset: int = 0, status: Optional[str] = None,
            mode: Optional[str] = None) -> dict[str, Any]:
    """Страница проверок за период, новые сверху, и их общее число."""
    params = _filter(start, end, status, mode)
    rows = _run(Q_LIST, limit=max(1, min(limit, MAX_PAGE)), offset=max(0, offset), **params)
    total = _run(Q_COUNT, **params)
    return {"records": rows, "total": total[0]["total"] if total else 0}
