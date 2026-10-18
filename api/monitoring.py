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


def vllm_state() -> Optional[dict[str, float]]:
    """Состояние vLLM или None, если он не ответил: мониторинг от него не зависит."""
    base = os.getenv("VLLM_URL", "http://vllm:8000/v1").rstrip("/")
    url = (base[:-3] if base.endswith("/v1") else base) + "/metrics"
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
    except Exception as exc:  # noqa: BLE001 — чаще всего неверная дата или недоступная база
        log.warning("Запрос истории проверок не выполнен: %s", exc)
        raise HTTPException(status_code=503, detail=f"Не удалось прочитать историю: {exc}") from exc


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
