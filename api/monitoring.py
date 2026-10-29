"""Мониторинг проверок: текущая нагрузка, история и средние показатели.

Только для администратора: в истории лежат формулировки целей и логины.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

import agent
import auth
import graph
import history
import metrics

log = logging.getLogger(__name__)

router = APIRouter(prefix="/monitoring", tags=["monitoring"], dependencies=[Depends(auth.admin)])

# Показатели самой модели (Prometheus): Strata отдаёт их под именами vLLM.
ENGINE_GAUGES = {
    "vllm:num_requests_running": "running",
    "vllm:num_requests_waiting": "waiting",
    "vllm:kv_cache_usage_perc": "kv_cache_usage",
}


def parse_engine_metrics(text: str) -> dict[str, float]:
    found: dict[str, float] = {}
    for line in text.splitlines():
        name = line.split("{", 1)[0].split(" ", 1)[0]
        if name in ENGINE_GAUGES:
            try:
                found[ENGINE_GAUGES[name]] = float(line.rsplit(" ", 1)[1])
            except (IndexError, ValueError):
                continue
    return found


def _engine_url(path: str) -> str:
    """Служебный адрес модели (/metrics): LLM_URL без суффикса /v1."""
    base = agent.llm_url().rstrip("/")
    return (base[:-3] if base.endswith("/v1") else base) + path


def _auth() -> dict[str, str]:
    """Strata требует ключ и на служебных адресах (/v1/models, /metrics)."""
    return {"Authorization": f"Bearer {os.getenv('LLM_API_KEY', 'dummy')}"}


def _open(request: urllib.request.Request | str, timeout: float):
    """Запрос к модели так же, как её клиент (agent.get_client): с корневым
    сертификатом LLM_CA_FILE и без прокси из окружения для внутреннего адреса."""
    handlers: list[urllib.request.BaseHandler] = []
    if agent.internal_url(agent.llm_url()):
        handlers.append(urllib.request.ProxyHandler({}))
    context = agent.llm_ssl_context()
    if context is not None:
        handlers.append(urllib.request.HTTPSHandler(context=context))
    return urllib.request.build_opener(*handlers).open(request, timeout=timeout)  # noqa: S310


# Готовность модели для /ready: сколько секунд помнить удачный ответ /v1/models.
LLM_READY_CACHE_SECONDS = 45.0
_ready_lock = threading.Lock()
_ready_until = 0.0
_problem: Optional[str] = None


def llm_problem() -> Optional[str]:
    """Почему последняя проверка llm_alive не прошла; None — прошла."""
    return _problem


def _models_problem(timeout: float) -> Optional[str]:
    request = urllib.request.Request(agent.llm_url().rstrip("/") + "/models", headers=_auth())
    try:
        with _open(request, timeout) as response:
            data = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return f"модель отклонила ключ (HTTP {exc.code}): проверьте LLM_API_KEY"
        return f"GET /v1/models ответил HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        return f"не ответила на GET /v1/models: {exc}"
    models = data.get("data") if isinstance(data, dict) else None
    ids = [m.get("id") for m in models if isinstance(m, dict)] if isinstance(models, list) else []
    # Strata отвечает на любое имя модели, поэтому имя не сверяется; пока модель
    # не загружена, в списке она значится как unloaded.
    if not ids:
        return "в списке /v1/models нет ни одной модели"
    if any("unloaded" in (m.get("id"), m.get("status")) for m in models if isinstance(m, dict)):
        return "модель ещё не загружена"
    return None


def llm_alive(timeout: float = 2.0) -> bool:
    """Готова ли модель (для /ready): GET /v1/models с ключом LLM_API_KEY отвечает
    и модель в нём загружена. Так виден неверный ключ, а не только живой процесс.
    Удачный ответ помнится LLM_READY_CACHE_SECONDS, неудачный — нет. Причина
    отказа — llm_problem(). Не бросает исключений.
    """
    global _ready_until, _problem
    with _ready_lock:
        if time.monotonic() < _ready_until:
            return True
    problem = _models_problem(timeout)
    with _ready_lock:
        _problem = problem
        _ready_until = time.monotonic() + LLM_READY_CACHE_SECONDS if problem is None else 0.0
    if problem is not None:
        log.warning("Модель не готова: %s", problem)
    return problem is None


def reset_ready_cache() -> None:
    """Для тестов: забыть удачную проверку модели."""
    global _ready_until, _problem
    with _ready_lock:
        _ready_until, _problem = 0.0, None


def engine_state() -> Optional[dict[str, float]]:
    """Состояние модели или None, если она не ответила: мониторинг от неё не зависит."""
    request = urllib.request.Request(_engine_url("/metrics/prometheus"), headers=_auth())
    try:
        with _open(request, timeout=2) as response:
            return parse_engine_metrics(response.read().decode("utf-8", "replace"))
    except Exception as exc:  # noqa: BLE001
        log.debug("Показатели модели недоступны: %s", exc)
        return None


def _handle(func, *args, **kwargs) -> Any:
    try:
        return func(*args, **kwargs)
    except history.BadRequest as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — недоступная база; неверные даты отсеивает history
        # Текст исключения драйвера — в журнал, а не в ответ: в нём адреса и запросы.
        log.warning("Запрос истории проверок не выполнен: %s", exc)
        raise HTTPException(status_code=503, detail="Не удалось прочитать историю: база недоступна") from exc


@router.get("/now")
def get_now():
    """Очередь, загрузка и показатели за последние минуты."""
    return {**metrics.snapshot(), "history": history.state(), "engine": engine_state(),
            "neo4j": graph.verify_connectivity()}


PERIOD = {
    "start": Query(..., description="Начало периода, ISO 8601"),
    "end": Query(..., description="Конец периода (не включая), ISO 8601"),
    "status": Query(None, description="ALLOWED | VIOLATIONS_FOUND | NEEDS_MANUAL_REVIEW"),
    "mode": Query(None, description="single | bulk"),
}


@router.get("/stats")
def get_stats(
    start: str = PERIOD["start"], end: str = PERIOD["end"],
    step: str = Query("day", description="minute | hour | day | week | month"),
    timezone: str = Query("UTC", description="Часовой пояс границ интервалов, например Europe/Moscow"),
    status: Optional[str] = PERIOD["status"], mode: Optional[str] = PERIOD["mode"],
):
    """Средние показатели за период с заданной периодичностью."""
    return _handle(history.stats, start, end, step, timezone, status, mode)


@router.get("/history")
def get_history(
    start: str = PERIOD["start"], end: str = PERIOD["end"],
    limit: int = Query(10, ge=1, le=history.MAX_PAGE, description="Строк на странице"),
    offset: int = Query(0, ge=0, description="Сколько строк пропустить"),
    status: Optional[str] = PERIOD["status"], mode: Optional[str] = PERIOD["mode"],
):
    """Проверки за период постранично, новые сверху: {records, total}."""
    return _handle(history.records, start, end, limit, offset, status, mode)
