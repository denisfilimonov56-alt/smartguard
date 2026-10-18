"""Живые показатели проверки: очередь к модели, пакеты в работе, кэш ответов.

Всё здесь — в памяти процесса (uvicorn работает одним процессом, см. auth.py)
и после перезапуска начинается с нуля. Долговременная история проверок
пишется в Neo4j — см. history.py.

Очередь к модели живёт в API, а не в vLLM: число одновременных запросов
ограничено LLM_MAX_CONCURRENCY, остальные ждут здесь. Ожидание в очереди
не расходует таймаут модели, поэтому под нагрузкой цели не превращаются
в «требуется ручная проверка». Часть слотов (LLM_INTERACTIVE_RESERVE)
пакетная проверка занять не может — они остаются ручным проверкам.
"""

from __future__ import annotations

import os
import threading
import time
from collections import OrderedDict, deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Hashable, Iterator, Optional

LLM_MAX_CONCURRENCY = max(1, int(os.getenv("LLM_MAX_CONCURRENCY", "32")))
LLM_INTERACTIVE_RESERVE = min(
    max(0, int(os.getenv("LLM_INTERACTIVE_RESERVE", "4"))), LLM_MAX_CONCURRENCY - 1
)
CHECK_CACHE_MAX = max(1, int(os.getenv("CHECK_CACHE_MAX_ENTRIES", "100000")))
# Справочные чтения графа внутри проверки (инструкции подразделения и т. п.).
LOOKUP_CACHE_TTL = 60
RECENT_WINDOW_SECONDS = 300

STARTED_AT = time.time()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# --------------------------------------------------------------------------
#  Очередь к модели
# --------------------------------------------------------------------------


class LlmGate:
    """Ограничитель одновременных запросов к модели с резервом для ручных проверок."""

    def __init__(self, capacity: int, reserve: int):
        self.capacity = capacity
        self.reserve = reserve
        self._all = threading.BoundedSemaphore(capacity)
        self._bulk = threading.BoundedSemaphore(capacity - reserve)
        self._lock = threading.Lock()
        self.running = 0
        self.waiting = 0

    @contextmanager
    def slot(self, bulk: bool) -> Iterator[float]:
        """Занимает слот; отдаёт время ожидания в очереди, сек."""
        started = time.monotonic()
        with self._lock:
            self.waiting += 1
        if bulk:
            self._bulk.acquire()
        self._all.acquire()
        with self._lock:
            self.waiting -= 1
            self.running += 1
        try:
            yield time.monotonic() - started
        finally:
            with self._lock:
                self.running -= 1
            self._all.release()
            if bulk:
                self._bulk.release()

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {"capacity": self.capacity, "reserve": self.reserve,
                    "running": self.running, "waiting": self.waiting}


gate = LlmGate(LLM_MAX_CONCURRENCY, LLM_INTERACTIVE_RESERVE)


# --------------------------------------------------------------------------
#  Кэш
# --------------------------------------------------------------------------


class TtlCache:
    """LRU-кэш со сроком жизни. Правка каталога сбрасывает его целиком.

    Значение, вычисленное до правки каталога, после неё не сохраняется:
    put принимает поколение, снятое до вычисления. Срок жизни может быть
    функцией: тогда его смена действует и на уже сохранённые значения.
    """

    def __init__(self, ttl: float | Callable[[], float], max_entries: int):
        self._ttl = ttl
        self.max_entries = max_entries
        self._items: OrderedDict[Hashable, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()
        self.generation = 0
        self.hits = 0
        self.misses = 0

    @property
    def ttl(self) -> float:
        return self._ttl() if callable(self._ttl) else self._ttl

    def get(self, key: Hashable) -> Any:
        ttl = self.ttl
        if not ttl:
            return None
        with self._lock:
            entry = self._items.get(key)
            if entry and entry[0] + ttl > time.monotonic():
                self._items.move_to_end(key)
                self.hits += 1
                return entry[1]
            if entry:
                del self._items[key]
            self.misses += 1
            return None

    def put(self, key: Hashable, value: Any, generation: int) -> None:
        if not self.ttl:
            return
        with self._lock:
            if generation != self.generation:
                return
            self._items[key] = (time.monotonic(), value)
            self._items.move_to_end(key)
            while len(self._items) > self.max_entries:
                self._items.popitem(last=False)

    def load(self, key: Hashable, loader: Callable[[], Any]) -> Any:
        """Значение из кэша либо результат loader (пустой результат тоже кэшируется)."""
        ttl = self.ttl
        with self._lock:
            entry = self._items.get(key) if ttl else None
            generation = self.generation
        if entry and entry[0] + ttl > time.monotonic():
            return entry[1]
        value = loader()
        self.put(key, value, generation)
        return value

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            self.generation += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {"entries": len(self._items), "max_entries": self.max_entries,
                    "ttl_seconds": self.ttl, "hits": self.hits, "misses": self.misses}


def _results_ttl() -> float:
    """Срок жизни готового ответа — из настроек; 0 — кэш выключен."""
    import settings  # settings сам опирается на этот модуль

    return settings.number("checkCacheTtlSeconds") if settings.flag("checkCache") else 0


results = TtlCache(_results_ttl, CHECK_CACHE_MAX)
lookups = TtlCache(LOOKUP_CACHE_TTL, 10_000)


def catalog_changed() -> None:
    """Каталог поменяли: ответы, посчитанные по старым правилам, больше не годятся."""
    results.clear()
    lookups.clear()


# --------------------------------------------------------------------------
#  Кто и что проверяет (контекст потока)
# --------------------------------------------------------------------------


@dataclass
class CheckStats:
    """Затраты одной проверки на модель."""

    llm_calls: int = 0
    llm_seconds: float = 0.0
    queue_seconds: float = 0.0


@dataclass
class Batch:
    id: str
    login: Optional[str]
    total: int
    started_at: str = field(default_factory=now_iso)
    done: int = 0


_local = threading.local()
_lock = threading.Lock()
_batches: dict[str, Batch] = {}
_running_checks = 0
_recent: deque[tuple[float, int, str, bool]] = deque(maxlen=20_000)
_listeners: list[Callable[[dict[str, Any]], None]] = []


def set_actor(login: Optional[str], batch: Optional[Batch] = None) -> None:
    """Кто проверяет в этом потоке; у пакетной проверки — ещё и пакет."""
    _local.login = login
    _local.batch = batch


def actor() -> Optional[str]:
    return getattr(_local, "login", None)


def current_batch() -> Optional[Batch]:
    return getattr(_local, "batch", None)


def note_llm(queue_seconds: float, llm_seconds: float) -> None:
    stats: Optional[CheckStats] = getattr(_local, "stats", None)
    if stats is not None:
        with _lock:  # запросы одной проверки идут из двух потоков
            stats.llm_calls += 1
            stats.queue_seconds += queue_seconds
            stats.llm_seconds += llm_seconds


def carry(func: Callable[..., Any]) -> Callable[..., Any]:
    """Оборачивает func для запуска в другом потоке с контекстом текущей проверки."""
    login, batch, stats = actor(), current_batch(), getattr(_local, "stats", None)

    def wrapper(*args: Any, **kwargs: Any) -> Any:
        _local.login, _local.batch, _local.stats = login, batch, stats
        try:
            return func(*args, **kwargs)
        finally:
            _local.login = _local.batch = _local.stats = None

    return wrapper


def start_batch(batch_id: str, total: int) -> Batch:
    batch = Batch(batch_id, actor(), total)
    with _lock:
        _batches[batch_id] = batch
    return batch


def batch_step(batch: Batch) -> None:
    """Шаг пакета, который идёт мимо check() (проверка примеров каталога)."""
    with _lock:
        batch.done += 1


def finish_batch(batch: Batch) -> None:
    with _lock:
        _batches.pop(batch.id, None)


def subscribe(listener: Callable[[dict[str, Any]], None]) -> None:
    """Получатель записей о завершённых проверках (history.py)."""
    _listeners.append(listener)


@contextmanager
def check() -> Iterator[Callable[[dict[str, Any], bool], None]]:
    """Обрамляет одну проверку; отданная функция фиксирует её результат."""
    global _running_checks
    stats = _local.stats = CheckStats()
    started = time.monotonic()
    with _lock:
        _running_checks += 1

    def done(result: dict[str, Any], cached: bool) -> None:
        ms = round((time.monotonic() - started) * 1000)
        batch = current_batch()
        record = {
            "at": now_iso(),
            "ms": ms,
            "status": result.get("status"),
            "departmentId": (result.get("department") or {}).get("id"),
            "login": actor(),
            "mode": "bulk" if batch else "single",
            "batchId": batch.id if batch else None,
            "cached": cached,
            "llmCalls": stats.llm_calls,
            "llmMs": round(stats.llm_seconds * 1000),
            "queueMs": round(stats.queue_seconds * 1000),
            "violations": [str(v.get("rule_id") or "?") for v in result.get("violations") or []],
            "goal": str(result.get("goal") or "")[:500],
        }
        with _lock:
            _recent.append((time.time(), ms, str(record["status"]), cached))
            if batch:
                batch.done += 1
        for listener in _listeners:
            listener(record)

    try:
        yield done
    finally:
        _local.stats = None
        with _lock:
            _running_checks -= 1


def snapshot() -> dict[str, Any]:
    """Что происходит прямо сейчас."""
    edge = time.time() - RECENT_WINDOW_SECONDS
    with _lock:
        recent = [r for r in _recent if r[0] >= edge]
        batches = [vars(b).copy() for b in _batches.values()]
        running = _running_checks
    computed = [r for r in recent if not r[3]]
    return {
        "llm": gate.snapshot(),
        "checks": {
            "running": running,
            "batches": batches,
            # Цели уже принятых пакетов, до которых очередь ещё не дошла.
            "queued": max(0, sum(b["total"] - b["done"] for b in batches) - running),
        },
        "recent": {
            "window_seconds": RECENT_WINDOW_SECONDS,
            "checks": len(recent),
            "per_minute": round(len(recent) / (RECENT_WINDOW_SECONDS / 60), 1),
            "avg_ms": round(sum(r[1] for r in computed) / len(computed)) if computed else None,
            "cached": len(recent) - len(computed),
            "manual_review": sum(1 for r in recent if r[2] == "NEEDS_MANUAL_REVIEW"),
        },
        "cache": results.snapshot(),
        "uptime_seconds": round(time.time() - STARTED_AT),
    }


def reset() -> None:
    """Для тестов: чистое состояние."""
    results.clear()
    lookups.clear()
    results.hits = results.misses = 0
    with _lock:
        _recent.clear()
        _batches.clear()
    set_actor(None)
