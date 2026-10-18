"""Живые показатели проверки: очередь к модели, пакеты в работе, кэш ответов.

Всё здесь — в памяти процесса (uvicorn работает одним процессом, см. auth.py)
и после перезапуска начинается с нуля. Долговременная история проверок
пишется в Neo4j — см. history.py.

Очередь к модели живёт в API, а не в vLLM: число одновременных запросов
ограничено настройкой llmMaxConcurrency (по умолчанию — LLM_MAX_CONCURRENCY),
остальные ждут здесь. Ожидание в очереди не расходует таймаут модели, поэтому
под нагрузкой цели не превращаются в «требуется ручная проверка». Часть
слотов (llmInteractiveReserve, по умолчанию LLM_INTERACTIVE_RESERVE)
пакетная проверка занять не может — они остаются ручным проверкам. Оба числа
администратор меняет в «Настройках» на лету: гейт помнит прочитанные значения
несколько секунд (в граф из очереди не ходит), а settings.update() будит ждущих
и сбрасывает запомненное (gate.reconfigure). Ручная проверка ждёт в очереди не
дольше LLM_QUEUE_TIMEOUT_SECONDS и получает 503, а не держит поток API без конца.

Версия каталога хранится в графе (:CatalogVersion {id: "catalog"}): её
увеличивают правки через API и seeder (миграции, полный сброс). Фоновый поток
сверяет её раз в CATALOG_VERSION_POLL_SECONDS и при смене сбрасывает кэши
ответов — так правка в обход API не оставляет в кэше старых вердиктов.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import OrderedDict, deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Hashable, Iterator, Optional

log = logging.getLogger(__name__)


def _env_int(name: str, default: int, low: int = 0) -> int:
    try:
        return max(low, int(os.getenv(name, "") or default))
    except ValueError:
        log.warning("%s должно быть числом, используется %d", name, default)
        return default


# Запись — ответ проверки без текста цели и оценки SMART (пункты, примеры
# правил), ключ — хэш цели (agent._cache_key), поэтому предел — десятки тысяч,
# а не сотни: это десятки мегабайт памяти.
CHECK_CACHE_MAX = _env_int("CHECK_CACHE_MAX_ENTRIES", 20_000, 1)
# Срок жизни оценки SMART в памяти; 0 — без срока (до очистки или вытеснения).
SMART_CACHE_TTL = _env_int("SMART_CACHE_TTL_SECONDS", 24 * 3600)
# Служебные чтения графа внутри проверки: настройки, примеры для промпта.
LOOKUP_CACHE_TTL = 60
RECENT_WINDOW_SECONDS = 300
# Как часто сверять версию каталога в графе (правки через seeder и миграции).
CATALOG_VERSION_POLL_SECONDS = 30
# Сколько ручная проверка ждёт места в очереди к модели; 0 — без предела.
LLM_QUEUE_TIMEOUT = _env_int("LLM_QUEUE_TIMEOUT_SECONDS", 120)

STARTED_AT = time.time()

# Часы кэшей и замеров. Тесты подменяют metrics._now, а не time.monotonic всего процесса.
_now = time.monotonic


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# --------------------------------------------------------------------------
#  Очередь к модели
# --------------------------------------------------------------------------


class QueueTimeout(RuntimeError):
    """Место в очереди к модели не освободилось за отведённое время."""

    def __init__(self, waited: float):
        super().__init__(f"очередь к модели не подошла за {round(waited)} с")
        self.waited = waited


class LlmGate:
    """Ограничитель одновременных запросов к модели с резервом для ручных проверок.

    Ёмкость и резерв берутся у поставщика limits() и запоминаются на
    LIMITS_REFRESH_SECONDS: ждущие потоки перепроверяют условие по
    запомненному значению и в граф не ходят. reconfigure() сбрасывает
    запомненное, поэтому правка настройки через API действует сразу.
    Уменьшение ёмкости ниже числа работающих запросов ничего не прерывает:
    новые запросы не впускаются, пока работающие не завершатся. Поставщик
    вызывается без блокировки гейта: его чтение (граф) не держит очередь.
    """

    # Ждущий поток перепроверяет условие не реже раза в секунду и без notify:
    # на случай правки настройки в обход settings.update().
    RECHECK_SECONDS = 1.0
    LIMITS_REFRESH_SECONDS = 5.0

    def __init__(self, limits: Callable[[], tuple[int, int]]):
        self._limits = limits
        self._cond = threading.Condition()
        self.running = 0
        self.running_bulk = 0
        self.waiting = 0
        # Растёт при reconfigure: ждущий поток видит, что предел мог измениться.
        self._generation = 0
        # Последние прочитанные (ёмкость, резерв), когда и при каком поколении.
        self._cached: Optional[tuple[int, int]] = None
        self._cached_at = 0.0
        self._cached_generation = -1
        self._refreshing = False
        # Кому сообщить о смене предела (main пересчитывает число потоков API).
        self._listeners: list[Callable[[], None]] = []

    @staticmethod
    def _fits(bulk: bool, running: int, running_bulk: int, capacity: int, reserve: int) -> bool:
        if running >= capacity:
            return False
        return not bulk or running_bulk < capacity - reserve

    def _read_limits(self) -> tuple[int, int]:
        capacity, reserve = self._limits()
        capacity = max(1, int(capacity))
        return capacity, min(max(0, int(reserve)), capacity - 1)

    def limits(self, fresh: bool = False) -> tuple[int, int]:
        """Ёмкость и резерв; резерв не больше ёмкости минус один.

        Без fresh — запомненное значение, пока оно не старше LIMITS_REFRESH_SECONDS
        и не было reconfigure. Перечитывает один поток, остальные берут прежнее;
        сбой чтения тоже оставляет прежнее значение.
        """
        with self._cond:
            cached, generation = self._cached, self._generation
            if not fresh and cached is not None and (
                    self._refreshing or (self._cached_generation == generation
                                         and time.monotonic() - self._cached_at < self.LIMITS_REFRESH_SECONDS)):
                return cached
            self._refreshing = True
        try:
            value = self._read_limits()
        except Exception as exc:  # noqa: BLE001 — очередь не должна вставать из-за чтения настроек
            if cached is None:
                raise
            log.warning("Предел очереди к модели не прочитан, действует прежний: %s", exc)
            value = cached
        finally:
            with self._cond:
                self._refreshing = False
        with self._cond:
            self._cached, self._cached_at, self._cached_generation = value, time.monotonic(), generation
        return value

    def acquire(self, bulk: bool, timeout: Optional[float] = None) -> None:
        """Ждёт места. timeout — сколько ждать, сек (None — без предела); вышел — QueueTimeout.

        Ожидание идёт по настоящим часам (time.monotonic), а не по metrics._now:
        его отмеряет Condition.wait.
        """
        started = time.monotonic()
        deadline = started + timeout if timeout else None
        with self._cond:
            self.waiting += 1
        try:
            while True:
                with self._cond:
                    generation = self._generation
                capacity, reserve = self.limits()
                with self._cond:
                    while True:
                        if self._fits(bulk, self.running, self.running_bulk, capacity, reserve):
                            self.running += 1
                            if bulk:
                                self.running_bulk += 1
                            return
                        if self._generation != generation:
                            break  # предел поменяли — перечитать его вне блокировки
                        wait = self.RECHECK_SECONDS
                        if deadline is not None:
                            left = deadline - time.monotonic()
                            if left <= 0:
                                raise QueueTimeout(time.monotonic() - started)
                            wait = min(wait, left)
                        if not self._cond.wait(wait):
                            break  # срок перепроверки вышел — перечитать предел
        finally:
            with self._cond:
                self.waiting -= 1

    def release(self, bulk: bool) -> None:
        with self._cond:
            self.running -= 1
            if bulk:
                self.running_bulk -= 1
            self._cond.notify_all()

    def reconfigure(self) -> None:
        """Предел поменяли: ждущие потоки перечитывают ёмкость и резерв,
        подписчики (on_reconfigure) узнают о смене."""
        with self._cond:
            self._generation += 1
            self._cond.notify_all()
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener()
            except Exception as exc:  # noqa: BLE001 — подписчик не мешает смене предела
                log.warning("Подписчик смены предела очереди к модели завершился ошибкой: %s", exc)

    def on_reconfigure(self, listener: Callable[[], None]) -> None:
        """Подписка на смену предела; повторная подписка ничего не меняет."""
        with self._cond:
            if listener not in self._listeners:
                self._listeners.append(listener)

    def off_reconfigure(self, listener: Callable[[], None]) -> None:
        with self._cond:
            while listener in self._listeners:
                self._listeners.remove(listener)

    @contextmanager
    def slot(self, bulk: bool) -> Iterator[float]:
        """Занимает слот; отдаёт время ожидания в очереди, сек.

        Ручная проверка ждёт не дольше LLM_QUEUE_TIMEOUT_SECONDS (QueueTimeout,
        в API — 503): пользователь ждёт ответа, а поток API занят всё ожидание.
        Пакет ждёт без предела — его цели уже приняты, и поток API на весь
        пакет один.
        """
        started = time.monotonic()
        self.acquire(bulk, None if bulk else (LLM_QUEUE_TIMEOUT or None))
        try:
            yield time.monotonic() - started
        finally:
            self.release(bulk)

    def snapshot(self) -> dict[str, int]:
        # Мониторинг показывает действующие настройки, а не запомненные гейтом.
        capacity, reserve = self.limits(fresh=True)
        with self._cond:
            return {"capacity": capacity, "reserve": reserve,
                    "running": self.running, "waiting": self.waiting}


def _llm_limits() -> tuple[int, int]:
    """Ёмкость очереди и резерв — из настроек интерфейса."""
    import settings  # settings сам опирается на этот модуль

    return settings.llm_limits()


gate = LlmGate(_llm_limits)


# --------------------------------------------------------------------------
#  Кэш
# --------------------------------------------------------------------------


class TtlCache:
    """LRU-кэш со сроком жизни. Правка каталога сбрасывает его целиком.

    Значение, вычисленное до правки каталога, после неё не сохраняется:
    put принимает поколение, снятое до вычисления. Срок жизни может быть
    функцией: тогда его смена действует и на уже сохранённые значения.
    Срок None — значения не устаревают (живут до clear или вытеснения),
    срок 0 — кэш выключен и ничего не хранит. Просроченные записи put
    вычищает не реже раза в PURGE_SECONDS: иначе они занимали бы память
    до вытеснения.
    """

    PURGE_SECONDS = 60.0

    def __init__(self, ttl: float | None | Callable[[], float | None], max_entries: int):
        self._ttl = ttl
        self.max_entries = max_entries
        self._items: OrderedDict[Hashable, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()
        self._purged_at = _now()
        # Ключи, значения которых сейчас вычисляются (load): одно вычисление
        # на ключ, остальные потоки ждут результата, а не идут к модели сами.
        self._loading: dict[Hashable, threading.Lock] = {}
        self.generation = 0
        self.hits = 0
        self.misses = 0

    @property
    def ttl(self) -> float | None:
        return self._ttl() if callable(self._ttl) else self._ttl

    @property
    def enabled(self) -> bool:
        ttl = self.ttl
        return ttl is None or ttl > 0

    @staticmethod
    def _fresh(entry: tuple[float, Any] | None, ttl: float | None) -> bool:
        return entry is not None and (ttl is None or entry[0] + ttl > _now())

    def get(self, key: Hashable) -> Any:
        ttl = self.ttl
        if not (ttl is None or ttl > 0):
            return None
        with self._lock:
            entry = self._items.get(key)
            if self._fresh(entry, ttl):
                self._items.move_to_end(key)
                self.hits += 1
                return entry[1]
            if entry:
                del self._items[key]
            self.misses += 1
            return None

    def put(self, key: Hashable, value: Any, generation: int) -> None:
        ttl = self.ttl
        if not (ttl is None or ttl > 0):
            return
        with self._lock:
            if generation != self.generation:
                return
            now = _now()
            if ttl is not None and now - self._purged_at >= self.PURGE_SECONDS:
                self._purged_at = now
                for stale in [k for k, (at, _) in self._items.items() if at + ttl <= now]:
                    del self._items[stale]
            self._items[key] = (now, value)
            self._items.move_to_end(key)
            while len(self._items) > self.max_entries:
                self._items.popitem(last=False)

    def load(self, key: Hashable, loader: Callable[[], Any]) -> Any:
        """Значение из кэша либо результат loader (пустой результат тоже кэшируется).

        Исключение loader наружу проходит как есть и в кэш не попадает.
        Один ключ вычисляется одним потоком: остальные ждут и берут готовое.
        """
        ttl = self.ttl
        if not (ttl is None or ttl > 0):
            # Кэш выключен: каждый читает сам и без общего замка — иначе все
            # чтения шли бы по одному.
            return loader()
        with self._lock:
            entry = self._items.get(key)
            if self._fresh(entry, ttl):
                return entry[1]
            guard = self._loading.get(key)
            if guard is None:
                guard = self._loading[key] = threading.Lock()
        with guard:
            with self._lock:
                entry = self._items.get(key)
                if self._fresh(entry, self.ttl):
                    return entry[1]
                generation = self.generation
            try:
                value = loader()
            finally:
                with self._lock:
                    if self._loading.get(key) is guard:
                        del self._loading[key]
            self.put(key, value, generation)
            return value

    def clear(self) -> int:
        """Убирает все записи; значения, которые сейчас вычисляются, в кэш уже не попадут.
        Возвращает, сколько записей было."""
        with self._lock:
            count = len(self._items)
            self._items.clear()
            self.generation += 1
            return count

    def drop(self, matches: Callable[[Hashable], bool]) -> int:
        """Убирает записи, чей ключ подходит под matches; остальные и поколение не трогает.
        Возвращает, сколько записей убрано."""
        with self._lock:
            keys = [key for key in self._items if matches(key)]
            for key in keys:
                del self._items[key]
            return len(keys)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {"entries": len(self._items), "max_entries": self.max_entries,
                    "ttl_seconds": self.ttl, "hits": self.hits, "misses": self.misses}


def _results_ttl() -> float:
    """Срок жизни готового ответа — из настроек; 0 — кэш выключен."""
    import settings  # settings сам опирается на этот модуль

    return settings.number("checkCacheTtlSeconds") if settings.flag("checkCache") else 0


def _job_lookups_ttl() -> float:
    """Срок кэша должностных инструкций и правил на них — настройка в интерфейсе."""
    import settings

    return settings.number("jobDescriptionsCacheTtlSeconds")


results = TtlCache(_results_ttl, CHECK_CACHE_MAX)
lookups = TtlCache(LOOKUP_CACHE_TTL, 10_000)
# Инструкции подразделения и правила на «должностных» атрибутах: цели одного
# подразделения в пакете идут подряд, и граф для них читается не на каждую цель.
job_lookups = TtlCache(_job_lookups_ttl, 10_000)
# Оценки по SMART: одна формулировка — одна оценка. От каталога и подразделения
# они не зависят, поэтому правка каталога их не трогает; живут SMART_CACHE_TTL_SECONDS
# (оценка сохранена и в графе), сбрасывает их и смена настройки smartCheck (settings.update).
smart_scores = TtlCache(SMART_CACHE_TTL or None, CHECK_CACHE_MAX)


def smart_key(goal: str) -> str:
    """Ключ оценки SMART: текст цели со схлопнутыми пробелами, регистр как есть."""
    return " ".join(goal.split())


# Кэши, которые администратор может очистить по отдельности в «Настройках».
CACHES: dict[str, TtlCache] = {
    "results": results, "jobDescriptions": job_lookups, "smart": smart_scores, "lookups": lookups,
}
# В ключах каких кэшей есть подразделение — их можно чистить по одному подразделению.
SCOPED_CACHES = ("results", "jobDescriptions")


def _key_department(name: str, key: Hashable) -> str | None:
    """Подразделение в ключе: ответы — (цель, подразделение, студент),
    инструкции — ("job_rules", атрибуты, подразделение, студент) и ("job_descriptions", подразделение)."""
    if not isinstance(key, tuple):
        return None
    if name == "results":
        return str(key[1]) if len(key) == 3 else None
    if name == "jobDescriptions" and len(key) >= 2:
        return key[2] if key[0] == "job_rules" and len(key) >= 3 else key[1]
    return None


def caches_snapshot() -> list[dict[str, Any]]:
    """Состояние каждого кэша для «Настроек»: записи, срок, попадания."""
    return [{"id": name, **cache.snapshot()} for name, cache in CACHES.items()]


def clear_cache(name: str, department_id: str | None = None) -> int:
    """Очищает кэш name целиком или, для SCOPED_CACHES, только записи подразделения.
    Возвращает, сколько записей убрано. Неизвестное имя — KeyError."""
    cache = CACHES[name]
    if department_id is None or name not in SCOPED_CACHES:
        return cache.clear()
    return cache.drop(lambda key: _key_department(name, key) == department_id)


# --------------------------------------------------------------------------
#  Версия каталога
# --------------------------------------------------------------------------

Q_VERSION_READ = "MATCH (v:CatalogVersion {id: 'catalog'}) RETURN v.version AS version"
Q_VERSION_BUMP = """
MERGE (v:CatalogVersion {id: 'catalog'})
SET v.version = coalesce(v.version, 0) + 1
RETURN v.version AS version
"""

_version_lock = threading.Lock()
# Сколько раз за жизнь процесса менялся каталог (или промпт): по нему проверка
# примеров узнаёт, что её результат устарел. Очистка кэша в «Настройках» его не трогает.
_catalog_version = 0
# Последняя известная версия каталога в графе; None — ещё не читали. Узла
# версии в графе может не быть (установка до первой миграции) — это версия 0.
_graph_version: Optional[int] = None
# Сколько раз своя правка записала версию в _graph_version. Опрос, чтение
# которого пересеклось со своей правкой, свой результат отбрасывает: иначе
# он вернул бы запомненную версию назад, и следующий опрос сбросил бы кэш зря.
_own_bumps = 0
_watch_stop = threading.Event()
_watch_thread: Optional[threading.Thread] = None


def catalog_version() -> int:
    """Счётчик правок каталога и промпта в этом процессе."""
    return _catalog_version


def _graph_query(query: str) -> Optional[int]:
    import graph  # граф от metrics не зависит, но импорт лёгкий держим ленивым

    with graph.get_driver().session() as session:
        record = session.run(query).single()
    value = record["version"] if record else None
    return int(value) if value is not None else None


def _drop_answers() -> None:
    global _catalog_version
    results.clear()
    lookups.clear()
    job_lookups.clear()
    with _version_lock:
        _catalog_version += 1


def catalog_changed() -> None:
    """Каталог поменяли: ответы, посчитанные по старым правилам, больше не годятся.

    Сначала увеличивается версия каталога в графе, потом сбрасываются кэши:
    если между правкой и увеличением версию поднял seeder, наш сброс идёт
    после его изменения и покрывает и его, а опрос (sync_catalog_version)
    второй раз кэши уже не сбросит. Сбой графа сброс не отменяет.
    """
    global _graph_version, _own_bumps
    try:
        version = _graph_query(Q_VERSION_BUMP)
    except Exception as exc:  # noqa: BLE001 — кэш сбросим всё равно, версия догонит при опросе
        log.warning("Версия каталога в графе не увеличена: %s", exc)
        version = None
    _drop_answers()
    if version is None:
        return
    with _version_lock:
        # Одновременные правки возвращают версии не по порядку: берём бóльшую.
        _graph_version = max(version, _graph_version or 0)
        _own_bumps += 1


def sync_catalog_version() -> bool:
    """Сверяет версию каталога в графе; изменилась (seeder, миграция) — сбрасывает кэши.

    Первое чтение только запоминает версию (отсутствие узла — версия 0), любое
    следующее изменение, в том числе появление узла, сбрасывает кэши. Чтение,
    во время которого прошла своя правка каталога, отбрасывается: оно могло
    вернуть версию до правки. Возвращает True, если кэши сброшены. Сбой
    чтения — False, без исключения.
    """
    global _graph_version
    with _version_lock:
        bumps = _own_bumps
    try:
        version = _graph_query(Q_VERSION_READ) or 0
    except Exception as exc:  # noqa: BLE001
        log.debug("Версия каталога не прочитана: %s", exc)
        return False
    with _version_lock:
        if _own_bumps != bumps:
            return False  # своя правка пересеклась с чтением — сверимся при следующем опросе
        known, _graph_version = _graph_version, version
    if known is None or version == known:
        # Первое чтение: кэши ещё пустые или посчитаны по этому же каталогу.
        return False
    log.info("Каталог изменён в обход API (версия %s → %s): кэш ответов сброшен", known, version)
    _drop_answers()
    return True


def _watch() -> None:
    sync_catalog_version()
    while not _watch_stop.wait(CATALOG_VERSION_POLL_SECONDS):
        sync_catalog_version()


def start_catalog_watch() -> None:
    """Запускает опрос версии каталога. Вызывается на старте приложения."""
    global _watch_thread
    if _watch_thread is None:
        _watch_stop.clear()
        _watch_thread = threading.Thread(target=_watch, name="catalog-version", daemon=True)
        _watch_thread.start()


def stop_catalog_watch() -> None:
    global _watch_thread
    if _watch_thread is not None:
        _watch_stop.set()
        _watch_thread.join(timeout=5)
        _watch_thread = None


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
    # Цели пакета, которые проверяются прямо сейчас (остальные ждут в пакете).
    running: int = 0


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


_ACTOR = object()


def start_batch(batch_id: str, total: int, login: Optional[str] | object = _ACTOR) -> Batch:
    """Пакет в мониторинге. login — чей он; без него — кто проверяет в этом потоке."""
    batch = Batch(batch_id, actor() if login is _ACTOR else login, total)  # type: ignore[arg-type]
    with _lock:
        _batches[batch_id] = batch
    return batch


def batch_step(batch: Batch) -> None:
    """Шаг пакета, который идёт мимо check()."""
    with _lock:
        batch.done += 1


@contextmanager
def batch_item(batch: Batch) -> Iterator[None]:
    """Одна цель пакета, который идёт мимо check() (проверка примеров, советчик):
    пока она считается, она не числится ждущей; по выходе — шаг пакета."""
    with _lock:
        batch.running += 1
    try:
        yield
    finally:
        with _lock:
            batch.running -= 1
            batch.done += 1


def finish_batch(batch: Batch) -> None:
    with _lock:
        _batches.pop(batch.id, None)


def subscribe(listener: Callable[[dict[str, Any]], None]) -> None:
    """Получатель записей о завершённых проверках (history.py). Повторная подписка ничего не меняет."""
    with _lock:
        if listener not in _listeners:
            _listeners.append(listener)


def unsubscribe(listener: Callable[[dict[str, Any]], None]) -> None:
    with _lock:
        while listener in _listeners:
            _listeners.remove(listener)


@contextmanager
def check() -> Iterator[Callable[[dict[str, Any], bool], None]]:
    """Обрамляет одну проверку; отданная функция фиксирует её результат."""
    global _running_checks
    stats = _local.stats = CheckStats()
    started = _now()
    batch = current_batch()
    with _lock:
        _running_checks += 1
        if batch:
            batch.running += 1

    def done(result: dict[str, Any], cached: bool) -> None:
        ms = round((_now() - started) * 1000)
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
            listeners = list(_listeners)
        for listener in listeners:
            listener(record)

    try:
        yield done
    finally:
        _local.stats = None
        with _lock:
            _running_checks -= 1
            if batch:
                batch.running -= 1


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
            # Цели уже принятых пакетов, до которых очередь ещё не дошла: считаются
            # по самим пакетам — ручные проверки и цели в работе сюда не входят.
            "queued": sum(max(0, b["total"] - b["done"] - b["running"]) for b in batches),
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
    job_lookups.clear()
    smart_scores.clear()
    results.hits = results.misses = 0
    smart_scores.hits = smart_scores.misses = 0
    with _lock:
        _recent.clear()
        _batches.clear()
        # Подписчики (история) из одного теста не получают проверок следующего.
        _listeners.clear()
    gate.reconfigure()
    set_actor(None)
