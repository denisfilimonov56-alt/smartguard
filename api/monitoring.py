"""Мониторинг проверок: текущая нагрузка, история и средние показатели.

Только для администратора: в истории лежат формулировки целей и логины.
"""

from __future__ import annotations

import logging
import os
import urllib.request
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

import auth
import graph
import history
import metrics

log = logging.getLogger(__name__)

router = APIRouter(prefix="/monitoring", tags=["monitoring"], dependencies=[Depends(auth.admin)])

# Показатели самого vLLM (Prometheus): сколько запросов он считает и держит в очереди.
VLLM_GAUGES = {
    "vllm:num_requests_running": "running",
    "vllm:num_requests_waiting": "waiting",
    "vllm:gpu_cache_usage_perc": "kv_cache_usage",
    "vllm:kv_cache_usage_perc": "kv_cache_usage",
}


def parse_vllm_metrics(text: str) -> dict[str, float]:
    found: dict[str, float] = {}
    for line in text.splitlines():
        name = line.split("{", 1)[0].split(" ", 1)[0]
        if name in VLLM_GAUGES:
            try:
                found[VLLM_GAUGES[name]] = float(line.rsplit(" ", 1)[1])
            except (IndexError, ValueError):
                continue
    return found


def _vllm_url(path: str) -> str:
    """Служебный адрес vLLM (/metrics, /health): VLLM_URL без суффикса /v1."""
    base = os.getenv("VLLM_URL", "http://vllm:8000/v1").rstrip("/")
    return (base[:-3] if base.endswith("/v1") else base) + path


def vllm_alive(timeout: float = 2.0) -> bool:
    """Отвечает ли vLLM на GET /health (для /ready). Не бросает исключений."""
    try:
        with urllib.request.urlopen(_vllm_url("/health"), timeout=timeout) as response:  # noqa: S310
            return 200 <= response.status < 300
    except Exception as exc:  # noqa: BLE001
        log.warning("vLLM не отвечает: %s", exc)
        return False


def vllm_state() -> Optional[dict[str, float]]:
    """Состояние vLLM или None, если он не ответил: мониторинг от него не зависит."""
    url = _vllm_url("/metrics")
    try:
        with urllib.request.urlopen(url, timeout=2) as response:  # noqa: S310 — адрес из настроек
            return parse_vllm_metrics(response.read().decode("utf-8", "replace"))
    except Exception as exc:  # noqa: BLE001
        log.debug("Показатели vLLM недоступны: %s", exc)
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
    return {**metrics.snapshot(), "history": history.state(), "vllm": vllm_state(),
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
