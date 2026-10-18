"""Журнал аудита: кто, когда и что сделал.

Каждое событие — одна JSON-строка в логгере `audit`. Строки идут в общий
лог API (`docker compose logs api | grep audit`) и в файл
`$AUDIT_LOG_DIR/audit.log` на томе: контейнер пересоздаётся при каждом
обновлении, и без файла история входов и изменений пропадала бы вместе с
ним. Файл сменяется в полночь или по достижении AUDIT_MAX_FILE_MB (100 МБ),
хранится AUDIT_RETENTION_DAYS последних файлов (включая сменённые по размеру).
Логгер пишет INFO всегда, независимо от LOG_LEVEL. Пароли и содержимое
запросов к /auth сюда не попадают никогда.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import os
from datetime import datetime, timezone
from typing import Any

from fastapi import Request

log = logging.getLogger("audit")
# Аудит не глушится общим LOG_LEVEL=WARNING; в stdout строки идут через
# корневой обработчик (propagate), в файл — через свой.
log.setLevel(logging.INFO)

DEFAULT_DIR = "/data/audit"
DEFAULT_RETENTION_DAYS = 365
# Файл сменяется и по размеру: поток запросов без входа не должен заполнить
# том за сутки. Предел на один файл, всего файлов — AUDIT_RETENTION_DAYS.
DEFAULT_MAX_FILE_MB = 100
# Что пишется о запросах без входа (main.guard).
ANONYMOUS_QUERY_MAX = 200
PATH_MAX = 300


class _DailyOrSizeHandler(logging.handlers.TimedRotatingFileHandler):
    """Смена файла в полночь или при превышении max_bytes — что наступит раньше."""

    def __init__(self, *args: Any, max_bytes: int, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.max_bytes = max_bytes

    def shouldRollover(self, record: logging.LogRecord) -> int:  # noqa: N802 — имя из logging
        if super().shouldRollover(record):
            return 1
        if self.max_bytes and self.stream is not None:
            self.stream.seek(0, os.SEEK_END)
            if self.stream.tell() + len(self.format(record)) + 1 >= self.max_bytes:
                return 1
        return 0

    def getFilesToDelete(self) -> list[str]:  # noqa: N802 — имя из logging
        """Старые файлы сверх backupCount, включая сменённые по размеру (с номером).

        Штатный разбор имён в logging признаёт только «.ГГГГ-ММ-ДД», и файлы
        с номером не удалялись бы никогда.
        """
        directory, base = os.path.split(self.baseFilename)
        old = [os.path.join(directory, n) for n in os.listdir(directory or ".") if n.startswith(base + ".")]
        if len(old) <= self.backupCount:
            return []
        old.sort(key=os.path.getmtime)
        return old[:len(old) - self.backupCount]

    def rotation_filename(self, default_name: str) -> str:
        # Несколько смен за сутки дали бы одно и то же имя с датой: добавляется номер.
        name, n = default_name, 1
        while os.path.exists(name):
            name, n = f"{default_name}.{n}", n + 1
        return name


def _max_file_bytes() -> int:
    raw = os.getenv("AUDIT_MAX_FILE_MB", "").strip()
    try:
        return max(int(raw or DEFAULT_MAX_FILE_MB), 1) * 1024 * 1024
    except ValueError:
        return DEFAULT_MAX_FILE_MB * 1024 * 1024


def _retention_days() -> int:
    raw = os.getenv("AUDIT_RETENTION_DAYS", "").strip()
    try:
        return max(int(raw or DEFAULT_RETENTION_DAYS), 1)
    except ValueError:
        logging.getLogger(__name__).warning(
            "AUDIT_RETENTION_DAYS должно быть числом, используется %d", DEFAULT_RETENTION_DAYS)
        return DEFAULT_RETENTION_DAYS


def setup() -> None:
    """Подключает файл журнала; повторный вызов ничего не меняет.

    Каталог недоступен на запись — предупреждение, и журнал остаётся только
    в stdout: из-за журнала API не должен не запускаться.
    """
    if any(getattr(h, "_audit_file", False) for h in log.handlers):
        return
    directory = os.getenv("AUDIT_LOG_DIR", "").strip() or DEFAULT_DIR
    path = os.path.join(directory, "audit.log")
    try:
        os.makedirs(directory, exist_ok=True)
        handler = _DailyOrSizeHandler(
            path, when="midnight", backupCount=_retention_days(), encoding="utf-8", utc=True,
            max_bytes=_max_file_bytes())
    except OSError as exc:
        logging.getLogger(__name__).warning(
            "Журнал аудита не пишется в %s (%s): только stdout, история пропадёт с контейнером", path, exc)
        return
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(message)s"))
    handler._audit_file = True  # type: ignore[attr-defined]
    log.addHandler(handler)


def client_ip(request: Request) -> str:
    """Адрес клиента. X-Real-IP ставит nginx интерфейса — единственный путь к API снаружи."""
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "-")


def event(name: str, **fields: Any) -> None:
    record = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "event": name}
    record.update({k: v for k, v in fields.items() if v is not None})
    log.info(json.dumps(record, ensure_ascii=False, default=str))


setup()
