"""Очередь к модели, кэши, версия каталога и запись истории — без Neo4j и модели."""

import threading

import pytest

import history
import metrics


class Clock:
    """Часы metrics._now, которые двигает тест."""

    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(metrics, "_now", clock)
    return clock


# ------------------------------ очередь к модели ------------------------------


def test_interactive_wait_in_queue_is_limited():
    """Ручная проверка не ждёт места бесконечно: поток API освобождается (H3)."""
    gate = metrics.LlmGate(lambda: (1, 0))
    gate.acquire(bulk=False)
    try:
        with pytest.raises(metrics.QueueTimeout):
            gate.acquire(bulk=False, timeout=0.2)
        assert gate.snapshot()["waiting"] == 0, "ушедший по таймауту не числится в очереди"
    finally:
        gate.release(bulk=False)


def test_slot_applies_queue_timeout_to_interactive_checks_only(monkeypatch):
    gate = metrics.LlmGate(lambda: (1, 0))
    monkeypatch.setattr(metrics, "LLM_QUEUE_TIMEOUT", 0.2)
    seen = []
    monkeypatch.setattr(gate, "acquire", lambda bulk, timeout=None: seen.append((bulk, timeout)))
    monkeypatch.setattr(gate, "release", lambda bulk: None)
    with gate.slot(bulk=False):
        pass
    with gate.slot(bulk=True):
        pass
    assert seen == [(False, 0.2), (True, None)], "пакет ждёт без предела"


def test_gate_does_not_read_limits_on_every_recheck():
    """Ждущие потоки берут прочитанный предел, а не идут каждый раз в граф (L43)."""
    reads = []
    gate = metrics.LlmGate(lambda: reads.append(1) or (2, 0))
    for _ in range(50):
        assert gate.limits() == (2, 0)
    assert len(reads) == 1
    gate.reconfigure()
    gate.limits()
    assert len(reads) == 2, "reconfigure сбрасывает запомненное"


def test_gate_keeps_last_limits_when_reading_fails():
    state = {"fail": False}

    def limits():
        if state["fail"]:
            raise RuntimeError("Neo4j недоступен")
        return (3, 1)

    gate = metrics.LlmGate(limits)
    assert gate.limits() == (3, 1)
    state["fail"] = True
    gate.reconfigure()
    assert gate.limits() == (3, 1)


# ----------------------------------- кэши -----------------------------------


def test_cache_purges_expired_entries_on_put(clock):
    """Просроченные записи не лежат в памяти до вытеснения (L26)."""
    cache = metrics.TtlCache(ttl=10, max_entries=100)
    for key in "abc":
        cache.put(key, key, cache.generation)
    clock.now += cache.PURGE_SECONDS + 1
    cache.put("d", "d", cache.generation)
    assert cache.snapshot()["entries"] == 1


def test_cache_uses_metrics_clock(clock):
    cache = metrics.TtlCache(ttl=10, max_entries=10)
    cache.put("k", "v", cache.generation)
    clock.now += 9
    assert cache.get("k") == "v"
    clock.now += 2
    assert cache.get("k") is None


def test_smart_scores_expire():
    assert metrics.smart_scores.ttl == metrics.SMART_CACHE_TTL > 0
    assert metrics.CHECK_CACHE_MAX <= 20_000


def test_disabled_cache_loads_outside_the_lock():
    """При сроке 0 чтения идут параллельно, а не по одному под общим замком (L42)."""
    cache = metrics.TtlCache(ttl=0, max_entries=10)
    inside = threading.Barrier(2, timeout=2)

    def loader():
        inside.wait()  # оба потока должны оказаться в loader одновременно
        return "v"

    results = []
    threads = [threading.Thread(target=lambda: results.append(cache.load("k", loader))) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    assert results == ["v", "v"]


# ------------------------------ версия каталога ------------------------------


def test_catalog_change_outside_api_drops_answers(monkeypatch):
    """Seeder поднял версию каталога в графе — опрос сбрасывает кэш ответов (M20)."""
    graph_version = {"value": 5}
    monkeypatch.setattr(metrics, "_graph_version", None)
    monkeypatch.setattr(metrics, "_graph_query", lambda query: graph_version["value"])
    metrics.results.put("цель", "ответ", metrics.results.generation)

    assert metrics.sync_catalog_version() is False, "первое чтение только запоминает версию"
    assert metrics.results.get("цель") == "ответ"
    assert metrics.sync_catalog_version() is False

    graph_version["value"] = 6
    before = metrics.catalog_version()
    assert metrics.sync_catalog_version() is True
    assert metrics.results.get("цель") is None
    assert metrics.catalog_version() == before + 1


def test_own_catalog_change_bumps_graph_version_once(monkeypatch):
    graph_version = {"value": 5}

    def query(q):
        if q == metrics.Q_VERSION_BUMP:
            graph_version["value"] += 1
        return graph_version["value"]

    monkeypatch.setattr(metrics, "_graph_version", 5)
    monkeypatch.setattr(metrics, "_graph_query", query)
    before = metrics.catalog_version()
    metrics.catalog_changed()
    assert graph_version["value"] == 6 and metrics.catalog_version() == before + 1
    assert metrics.sync_catalog_version() is False, "своя правка второй раз кэш не сбрасывает"


def test_catalog_change_survives_graph_failure():
    """Граф недоступен (заглушка conftest) — кэш всё равно сброшен."""
    metrics.results.put("цель", "ответ", metrics.results.generation)
    metrics.catalog_changed()
    assert metrics.results.get("цель") is None
    assert metrics.sync_catalog_version() is False


def test_manual_cache_clear_does_not_change_catalog_version():
    before = metrics.catalog_version()
    metrics.clear_cache("results")
    assert metrics.catalog_version() == before


# --------------------------- пакеты и подписчики ---------------------------


def test_queued_is_counted_per_batch():
    """«Ждут в пакетах» — по самим пакетам: ручные проверки и цели в работе не вычитаются (L38)."""
    batch = metrics.start_batch("b1", 10, "hr")
    metrics.set_actor("hr", batch)
    try:
        with metrics.check():
            metrics.set_actor("someone")  # ручная проверка в другом потоке на очередь пакета не влияет
            with metrics.check():
                assert metrics.snapshot()["checks"]["queued"] == 9
    finally:
        metrics.finish_batch(batch)
        metrics.set_actor(None)


def test_batch_item_tracks_running_and_done():
    batch = metrics.start_batch("b2", 3, "editor")
    with metrics.batch_item(batch):
        assert metrics.snapshot()["checks"]["queued"] == 2
    assert batch.done == 1 and batch.running == 0
    metrics.finish_batch(batch)


def test_batch_login_is_explicit():
    metrics.set_actor("чужой")
    batch = metrics.start_batch("b3", 1, "editor")
    assert batch.login == "editor"
    assert metrics.start_batch("b4", 1).login == "чужой", "без login — кто проверяет в потоке"


def test_subscribe_is_idempotent_and_reset_drops_listeners():
    seen = []
    metrics.subscribe(seen.append)
    metrics.subscribe(seen.append)
    with metrics.check() as done:
        done({"status": "ALLOWED"}, False)
    assert len(seen) == 1
    metrics.unsubscribe(seen.append)
    with metrics.check() as done:
        done({"status": "ALLOWED"}, False)
    assert len(seen) == 1
    metrics.subscribe(seen.append)
    metrics.reset()
    assert metrics._listeners == []


def test_history_stop_unsubscribes(monkeypatch):
    """history.stop снимает подписку: подписчики не копятся от lifespan к lifespan (M33)."""
    from conftest import REAL_HISTORY_START, REAL_HISTORY_STOP
    monkeypatch.setattr(history, "_loop", lambda: None)
    REAL_HISTORY_START()
    REAL_HISTORY_START()
    assert metrics._listeners.count(history._enqueue) == 1
    REAL_HISTORY_STOP()
    assert history._enqueue not in metrics._listeners
    REAL_HISTORY_START()
    REAL_HISTORY_STOP()
    assert history._enqueue not in metrics._listeners


# ------------------------------ запись истории ------------------------------


@pytest.fixture
def history_queue(monkeypatch):
    import queue
    monkeypatch.setattr(history, "_pending", queue.Queue())
    monkeypatch.setattr(history, "_retry", __import__("collections").deque())
    monkeypatch.setattr(history, "_backoff", 0.0)
    monkeypatch.setattr(history, "_retry_at", 0.0)
    monkeypatch.setattr(history, "_dropped", 0)
    return history._pending


def test_history_keeps_rows_when_neo4j_is_briefly_down(monkeypatch, history_queue):
    """Краткий сбой Neo4j не теряет историю: пачка ждёт повтора с паузой (L37)."""
    state = {"down": True}
    written = []

    def run(query, **params):
        if state["down"]:
            raise RuntimeError("Neo4j недоступен")
        written.extend(params["rows"])
        return []

    monkeypatch.setattr(history, "_run", run)
    for i in range(3):
        history_queue.put({"at": str(i)})
    assert history.flush() == 0
    assert history.state()["pending"] == 3 and history._dropped == 0
    assert history.flush() == 0, "до конца паузы повтора не будет"

    state["down"] = False
    history_queue.put({"at": "3"})
    assert history.flush(force=True) == 4
    assert [r["at"] for r in written] == ["0", "1", "2", "3"], "порядок сохранён"
    assert history.state()["pending"] == 0


def test_history_retry_buffer_is_bounded(monkeypatch, history_queue):
    monkeypatch.setattr(history, "RETRY_MAX_ROWS", 2)

    def down(query, **params):
        raise RuntimeError("Neo4j недоступен")

    monkeypatch.setattr(history, "_run", down)
    for i in range(3):
        history_queue.put({"at": str(i)})
    history.flush()
    assert len(history._retry) == 2 and history._dropped == 1


def test_catalog_version_node_appearing_drops_answers(monkeypatch):
    """Узла версии не было (до первой миграции), потом он появился — кэш сбрасывается (E10)."""
    versions = iter([None, 1])
    monkeypatch.setattr(metrics, "_graph_version", None)
    monkeypatch.setattr(metrics, "_graph_query", lambda query: next(versions))
    assert metrics.sync_catalog_version() is False, "первое чтение: узла нет — версия 0"
    metrics.results.put("цель", "ответ", metrics.results.generation)
    assert metrics.sync_catalog_version() is True
    assert metrics.results.get("цель") is None


def test_sync_read_overlapping_own_change_is_discarded(monkeypatch):
    """Опрос прочитал версию до своей правки, а записал после — его результат отбрасывается (E9)."""
    graph_version = {"value": 5}

    def query(q):
        if q == metrics.Q_VERSION_BUMP:
            graph_version["value"] += 1
            return graph_version["value"]
        seen = graph_version["value"]
        metrics.catalog_changed()  # своя правка прошла, пока опрос ждал ответа графа
        return seen

    monkeypatch.setattr(metrics, "_graph_version", 5)
    monkeypatch.setattr(metrics, "_graph_query", query)
    assert metrics.sync_catalog_version() is False
    assert metrics._graph_version == 6, "запомненная версия не откатилась к прочитанной"
    metrics.results.put("цель", "ответ", metrics.results.generation)
    monkeypatch.setattr(metrics, "_graph_query", lambda q: graph_version["value"])
    assert metrics.sync_catalog_version() is False and metrics.results.get("цель") == "ответ"


def test_catalog_change_drops_answers_after_bumping_version(monkeypatch):
    """Ответ, посчитанный, пока своя правка поднимала версию (в том числе после правки
    seeder'а), сбрасывается: кэш чистится после увеличения версии (E10)."""
    def bump(q):
        metrics.results.put("цель", "ответ", metrics.results.generation)
        return 8  # seeder успел поднять версию с 5 до 7, наша правка — до 8

    monkeypatch.setattr(metrics, "_graph_version", 5)
    monkeypatch.setattr(metrics, "_graph_query", bump)
    metrics.catalog_changed()
    assert metrics.results.get("цель") is None and metrics._graph_version == 8


def test_gate_reconfigure_notifies_listeners():
    seen = []

    def listener():
        seen.append(1)

    def broken():
        raise RuntimeError("сбой подписчика")

    metrics.gate.on_reconfigure(broken)
    metrics.gate.on_reconfigure(listener)
    try:
        metrics.gate.reconfigure()
        assert seen == [1], "сбой одного подписчика не мешает остальным"
    finally:
        metrics.gate.off_reconfigure(broken)
        metrics.gate.off_reconfigure(listener)
