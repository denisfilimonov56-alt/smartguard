"""Журнал аудита: кто, когда и что сделал.

Каждое событие — одна JSON-строка в логгере `audit` (идёт в общий лог API,
`docker compose logs api | grep audit`). Пароли и содержимое запросов
к /auth сюда не попадают никогда.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import Request

log = logging.getLogger("audit")


def client_ip(request: Request) -> str:
    """Адрес клиента. X-Real-IP ставит nginx интерфейса — единственный путь к API снаружи."""
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "-")


def event(name: str, **fields: Any) -> None:
    record = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "event": name}
    record.update({k: v for k, v in fields.items() if v is not None})
    log.info(json.dumps(record, ensure_ascii=False, default=str))
