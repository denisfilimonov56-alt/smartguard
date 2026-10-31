"""Общее для всех тестов: показатели и кэш ответов не переходят из теста в тест.

Окружение разработчика (экспортированный .env проекта) на тесты не влияет:
переменные, которые модули читают при импорте, убираются до импорта. Neo4j
в тестах нет: драйвер подменён заглушкой, которая сразу падает, а фоновые
потоки (история проверок, опрос версии каталога) не запускаются.
"""

import os

# До импорта модулей проекта: они читают окружение при импорте (main.DOCS, auth, agent).
_ENV_PREFIXES = ("KEYCLOAK_", "AUTH_", "LLM_", "NEO4J_", "VLLM_", "ADVICE_", "AUDIT_", "DUTIES_")
_ENV_NAMES = {"ENABLE_DOCS", "MAX_GOALS_PER_REQUEST", "BULK_MAX_WORKERS", "BULK_MAX_REQUESTS", "API_THREADS",
              "CHECK_CACHE_MAX_ENTRIES", "CHECK_RATE_PER_MINUTE", "HISTORY_RETENTION_DAYS",
              "PROMPT_EXAMPLES_PER_KIND", "PROMPT_EXAMPLE_MAX_CHARS", "JOB_TEXT_MAX_CHARS"}
for _name in list(os.environ):
    if _name in _ENV_NAMES or _name.startswith(_ENV_PREFIXES) or "_TTL_" in _name:
        del os.environ[_name]

import tempfile  # noqa: E402

# Журнал аудита — во временный каталог, а не в /data/audit.
os.environ["AUDIT_LOG_DIR"] = tempfile.mkdtemp(prefix="audit-tests-")

import sys  # noqa: E402

import pytest  # noqa: E402

import agent  # noqa: E402
import apikeys  # noqa: E402
import auth  # noqa: E402
import graph  # noqa: E402
import history  # noqa: E402
import metrics  # noqa: E402
import settings  # noqa: E402

_REAL_GET_DRIVER = graph.get_driver
# Настоящие start/stop истории — для теста самой истории (test_metrics.py).
REAL_HISTORY_START, REAL_HISTORY_STOP = history.start, history.stop


def _no_neo4j():
    raise RuntimeError("Neo4j в тестах недоступен: подмените граф в самом тесте")


@pytest.fixture(autouse=True)
def no_graph_or_background(monkeypatch):
    """Ни один тест не ходит в настоящий Neo4j (даже при заданном NEO4J_URI) и не запускает
    фоновые потоки. Тест, которому нужен граф, подменяет его сам — поверх этой заглушки."""
    monkeypatch.setattr(history, "start", lambda: None)
    monkeypatch.setattr(history, "stop", lambda: None)
    monkeypatch.setattr(metrics, "start_catalog_watch", lambda: None)
    monkeypatch.setattr(metrics, "stop_catalog_watch", lambda: None)
    # get_driver импортирован в модули по имени (from graph import get_driver) — подменяем везде.
    for module in list(sys.modules.values()):
        if getattr(module, "get_driver", None) is _REAL_GET_DRIVER:
            monkeypatch.setattr(module, "get_driver", _no_neo4j)


@pytest.fixture(autouse=True)
def clean_metrics():
    metrics.reset()
    # Предохранитель модели (agent.py) из одного теста не открыт в следующем.
    reset_breaker = getattr(agent, "reset_breaker", None)
    if reset_breaker:
        reset_breaker()
    yield
    metrics.reset()
    if reset_breaker:
        reset_breaker()


@pytest.fixture(autouse=True)
def default_settings(monkeypatch):
    """Настройки по умолчанию без обращения к Neo4j; счётчики и память о ключах — с нуля."""
    monkeypatch.setattr(settings, "_read", lambda: {})
    # Последнее удачное чтение настроек и пауза после сбоя не переходят из теста в тест.
    forget = getattr(settings, "forget", None)
    if forget:
        forget()
    auth.check_rate.reset()
    auth.seen_sessions.clear()
    auth.forget_keys()
    apikeys.forget()


@pytest.fixture(autouse=True)
def smart_store(monkeypatch):
    """Хранилище оценок SMART в графе подменено памятью: Neo4j в тестах нет."""
    store: dict[str, dict] = {}
    monkeypatch.setattr(agent, "get_smart_score", lambda goal_hash: store.get(goal_hash))
    monkeypatch.setattr(agent, "save_smart_score", lambda goal_hash, scores: store.__setitem__(goal_hash, scores))
    return store
