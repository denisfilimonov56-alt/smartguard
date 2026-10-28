"""Журнал аудита: кто, когда и что сделал.

Каждое событие — одна JSON-строка в логгере `audit`. Строки идут в общий
лог API (`docker compose logs api | grep audit`) и в файл
`$AUDIT_LOG_DIR/audit.log` на томе: контейнер пересоздаётся при каждом
обновлении, и без файла история входов и изменений пропадала бы вместе с
ним. Файл сменяется в полночь или по достижении AUDIT_MAX_FILE_MB (100 МБ);
сменённые файлы удаляются, когда им больше AUDIT_RETENTION_DAYS суток, —
по возрасту, а не по числу: поток запросов, сменяющий файл по размеру, не
стирает историю за год. Сверх AUDIT_MAX_TOTAL_MB на все файлы история не
удаляется: в файл перестают идти только анонимные отказы, а в общий лог —
ERROR. Анонимные отказы (запрос без входа, отвергнутый токен или ключ)
пишутся не больше ANONYMOUS_PER_MINUTE строк в минуту с одного адреса,
остальные — счётчиком в событии anonymous_suppressed.
Логгер пишет INFO всегда, независимо от LOG_LEVEL. Пароли и содержимое
запросов к /auth сюда не попадают никогда.

В каждой строке — поля требования ИБ 13.1, даже пустые (CORE_FIELDS):
кто (login, role), откуда (source, ip), когда (ts), в какой сессии и
каком запросе (session_id, request_id), что сделал (event), с чем
(object), чем кончилось (result) и было ли действие заблокировано
(blocked). Кто и откуда пришёл, берётся из контекста запроса (begin/bind):
вызывающему коду их передавать не нужно.

При заданном AUDIT_SYSLOG_URL строки дополнительно уходят в SIEM — syslog
RFC 5424 по UDP, TCP или TLS. Отправка идёт из своего потока через
очередь: недоступный SIEM не задерживает запросы, а строки сверх очереди
отбрасываются с ошибкой в общем логе (файл на томе их сохраняет).
"""

from __future__ import annotations

import atexit
import contextvars
import json
import logging
import logging.handlers
import os
import queue
import re
import socket
import ssl
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import Request

log = logging.getLogger("audit")
# Аудит не глушится общим LOG_LEVEL=WARNING; в stdout строки идут через
# корневой обработчик (propagate), в файл — через свой.
log.setLevel(logging.INFO)

DEFAULT_DIR = "/data/audit"
DEFAULT_RETENTION_DAYS = 365
# Файл сменяется и по размеру: поток запросов без входа не должен заполнить
# том за сутки. Предел на один файл; сколько файлов хранить — по их возрасту.
DEFAULT_MAX_FILE_MB = 100
# Предел на все файлы журнала: сверх него — ERROR и в файл не идут анонимные отказы.
DEFAULT_MAX_TOTAL_MB = 20 * 1024
# Объём каталога пересчитывается не чаще раза в столько секунд.
TOTAL_RECHECK_SECONDS = 60
# Что пишется о запросах (main.guard): строка запроса без входа и со входом.
ANONYMOUS_QUERY_MAX = 200
QUERY_MAX = 1000
PATH_MAX = 300
# Анонимные отказы с одного адреса: столько строк за ANONYMOUS_WINDOW секунд,
# остальное — счётчиком. Адресов в памяти не больше ANONYMOUS_MAX_IPS, прочие
# считаются вместе под адресом «*».
ANONYMOUS_PER_MINUTE = 10
ANONYMOUS_WINDOW = 60.0
ANONYMOUS_MAX_IPS = 10_000

_errors = logging.getLogger("audit_journal")
_now = time.monotonic

# Поля требования ИБ 13.1: есть в каждой строке, даже пустые, — разбор в SIEM
# не зависит от вида события.
CORE_FIELDS = ("login", "role", "source", "ip", "session_id", "request_id", "object", "result", "blocked")
# Источник: интерфейс сервиса (пользователь с токеном Keycloak), внешняя система
# по ключу доступа, сам сервис (событие вне запроса).
SOURCE_UI = "ui"
SOURCE_API = "api"
SOURCE_SYSTEM = "system"
# Результат действия и признак блокировки по виду события; не названные здесь — удачные.
OUTCOMES = {
    "access_denied": ("denied", True),
    "login_sub_mismatch": ("denied", True),
    "token_rejected": ("denied", True),
    "api_key_rejected": ("denied", True),
    "check_throttled": ("denied", True),
    "anonymous_suppressed": ("denied", True),
}
# Идентификатор запроса от nginx ($request_id); любой другой заменяется своим.
REQUEST_ID_RE = re.compile(r"^[0-9a-f]{32}$")

_context: contextvars.ContextVar[Optional[dict[str, Any]]] = contextvars.ContextVar("audit_context", default=None)


def request_id(incoming: Optional[str]) -> str:
    """Идентификатор запроса: пришедший от nginx или новый, если его нет или он чужого вида."""
    return incoming if incoming and REQUEST_ID_RE.match(incoming) else uuid.uuid4().hex


def begin(**fields: Any) -> contextvars.Token:
    """Начало запроса: его поля (ip, request_id, object) попадут в каждое событие до end."""
    return _context.set(dict(fields))


def bind(**fields: Any) -> None:
    """Дополняет контекст запроса тем, что выяснилось по ходу: кто вошёл, роль, сессия.

    Контекст — один словарь на запрос: дополнения из потока пула (синхронные
    зависимости FastAPI) видны и в самом запросе.
    """
    ctx = _context.get()
    if ctx is not None:
        ctx.update({k: v for k, v in fields.items() if v is not None})


def end(token: contextvars.Token) -> None:
    _context.reset(token)


def outcome(status: int) -> tuple[str, bool]:
    """Результат запроса по коду ответа: отказ в доступе и предел частоты — блокировка."""
    if status in (401, 403, 429):
        return "denied", True
    return ("failure", False) if status >= 400 else ("success", False)


class _DailyOrSizeHandler(logging.handlers.TimedRotatingFileHandler):
    """Смена файла в полночь или при превышении max_bytes — что наступит раньше."""

    def __init__(self, *args: Any, max_bytes: int, max_total_bytes: int = 0, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.max_bytes = max_bytes
        self.max_total_bytes = max_total_bytes
        self._total_checked = float("-inf")
        self._over_total = False
        self._alarmed = float("-inf")

    def _files(self) -> list[str]:
        directory, base = os.path.split(self.baseFilename)
        return [os.path.join(directory, n) for n in os.listdir(directory or ".") if n.startswith(base + ".")]

    def over_total(self) -> bool:
        """Превышен ли предел на все файлы; при превышении — ERROR не чаще раза в час."""
        if not self.max_total_bytes:
            return False
        now = time.monotonic()
        if now - self._total_checked < TOTAL_RECHECK_SECONDS:
            return self._over_total
        self._total_checked = now
        try:
            total = sum(os.path.getsize(p) for p in self._files() + [self.baseFilename] if os.path.exists(p))
        except OSError:
            return self._over_total
        was, self._over_total = self._over_total, total >= self.max_total_bytes
        if self._over_total and (not was or now - self._alarmed >= 3600):
            self._alarmed = now
            _errors.error("Журнал аудита занимает %d МБ — больше AUDIT_MAX_TOTAL_MB (%d МБ). История не "
                          "удаляется, анонимные отказы в файл больше не пишутся: освободите место "
                          "или перенесите старые файлы", total // 2**20, self.max_total_bytes // 2**20)
        return self._over_total

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(record, "audit_noise", False) and self.over_total():
            return
        super().emit(record)

    def shouldRollover(self, record: logging.LogRecord) -> int:  # noqa: N802 — имя из logging
        if super().shouldRollover(record):
            return 1
        if self.max_bytes and self.stream is not None:
            self.stream.seek(0, os.SEEK_END)
            if self.stream.tell() + len(self.format(record)) + 1 >= self.max_bytes:
                return 1
        return 0

    def getFilesToDelete(self) -> list[str]:  # noqa: N802 — имя из logging
        """Сменённые файлы старше backupCount суток (по последней записи), включая
        сменённые по размеру (с номером).

        Возраст, а не число файлов: иначе поток запросов, сменяющий файл по
        размеру каждые минуты, за сутки вытеснил бы историю за год. Штатный
        разбор имён в logging признаёт только «.ГГГГ-ММ-ДД», и файлы с
        номером не удалялись бы никогда.
        """
        edge = time.time() - self.backupCount * 86400
        return [path for path in self._files() if os.path.getmtime(path) < edge]

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


def _max_total_bytes() -> int:
    raw = os.getenv("AUDIT_MAX_TOTAL_MB", "").strip()
    try:
        return max(int(raw or DEFAULT_MAX_TOTAL_MB), 0) * 1024 * 1024
    except ValueError:
        return DEFAULT_MAX_TOTAL_MB * 1024 * 1024


def _retention_days() -> int:
    raw = os.getenv("AUDIT_RETENTION_DAYS", "").strip()
    try:
        return max(int(raw or DEFAULT_RETENTION_DAYS), 1)
    except ValueError:
        logging.getLogger(__name__).warning(
            "AUDIT_RETENTION_DAYS должно быть числом, используется %d", DEFAULT_RETENTION_DAYS)
        return DEFAULT_RETENTION_DAYS


# Syslog: facility 13 — «log audit» (RFC 5424); severity — 4 (warning) для
# заблокированных действий, 6 (informational) для остальных.
SYSLOG_FACILITY = 13
SYSLOG_PORTS = {"udp": 514, "tcp": 514, "tls": 6514}
SIEM_QUEUE_SIZE = 10_000
SIEM_TIMEOUT_SECONDS = 5.0
SIEM_ALARM_SECONDS = 60.0


class _SyslogSink(logging.Handler):
    """Строки журнала в SIEM: syslog RFC 5424 по UDP (RFC 5426), TCP (RFC 6587) или TLS (RFC 5425).

    По TCP и TLS сообщения разделяются подсчётом октетов. Соединение
    открывается при первой строке и после обрыва; не удалось отправить и со
    второй попытки — строка отбрасывается, а в общий лог идёт ERROR не чаще
    раза в минуту с числом потерянных строк.
    """

    def __init__(self, url: str, ca_file: Optional[str] = None, app_name: str = "goal-checker",
                 hostname: Optional[str] = None) -> None:
        super().__init__(logging.INFO)
        parts = urlsplit(url)
        if parts.scheme not in SYSLOG_PORTS or not parts.hostname:
            raise ValueError(f"ожидался udp://, tcp:// или tls://хост[:порт], а не {url!r}")
        self.scheme = parts.scheme
        self.address = (parts.hostname, parts.port or SYSLOG_PORTS[parts.scheme])
        self.app_name = app_name
        self.hostname = hostname or socket.gethostname()
        self.tls = ssl.create_default_context(cafile=ca_file or None) if self.scheme == "tls" else None
        self.sock: Optional[socket.socket] = None
        self.lost = 0
        self._alarmed = float("-inf")

    def line(self, record: logging.LogRecord) -> bytes:
        severity = 4 if getattr(record, "audit_blocked", False) else 6
        stamp = datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds")
        return (f"<{SYSLOG_FACILITY * 8 + severity}>1 {stamp} {self.hostname} {self.app_name} - AUDIT - "
                + record.getMessage()).encode("utf-8")

    def _connect(self) -> socket.socket:
        if self.scheme == "udp":
            return socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock = socket.create_connection(self.address, timeout=SIEM_TIMEOUT_SECONDS)
        if self.tls is not None:
            sock = self.tls.wrap_socket(sock, server_hostname=self.address[0])
        return sock

    def _send(self, data: bytes) -> None:
        if self.sock is None:
            self.sock = self._connect()
        if self.scheme == "udp":
            self.sock.sendto(data, self.address)
        else:
            self.sock.sendall(str(len(data)).encode() + b" " + data)

    def close_socket(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def emit(self, record: logging.LogRecord) -> None:
        data = self.line(record)
        for attempt in (1, 2):
            try:
                self._send(data)
                return
            except OSError as exc:
                self.close_socket()
                if attempt == 2:
                    self.drop(1, f"SIEM недоступен ({exc})")

    def drop(self, count: int, why: str) -> None:
        """Учёт потерянных строк; ERROR в общий лог не чаще раза в SIEM_ALARM_SECONDS."""
        self.lost += count
        now = time.monotonic()
        if now - self._alarmed >= SIEM_ALARM_SECONDS:
            self._alarmed = now
            _errors.error("Журнал аудита: %s, в SIEM не отправлено строк: %d (в файле на томе они есть)",
                          why, self.lost)
            self.lost = 0

    def close(self) -> None:
        self.close_socket()
        super().close()


class _SiemQueue(logging.handlers.QueueHandler):
    """Очередь перед отправкой в SIEM: запрос не ждёт сеть, переполнение — потеря строки, а не ожидание."""

    def __init__(self, sink: _SyslogSink) -> None:
        super().__init__(queue.Queue(SIEM_QUEUE_SIZE))
        self.sink = sink

    def enqueue(self, record: logging.LogRecord) -> None:
        try:
            self.queue.put_nowait(record)
        except queue.Full:
            self.sink.drop(1, "очередь отправки переполнена")


def _setup_siem() -> None:
    url = os.getenv("AUDIT_SYSLOG_URL", "").strip()
    if not url or any(getattr(h, "_audit_siem", False) for h in log.handlers):
        return
    try:
        sink = _SyslogSink(url, os.getenv("AUDIT_SYSLOG_CA_FILE", "").strip() or None,
                           os.getenv("AUDIT_SYSLOG_APP_NAME", "").strip() or "goal-checker",
                           os.getenv("AUDIT_SYSLOG_HOSTNAME", "").strip() or None)
    except (ValueError, OSError, ssl.SSLError) as exc:
        logging.getLogger(__name__).error("Журнал аудита в SIEM не отправляется: AUDIT_SYSLOG_URL — %s", exc)
        return
    handler = _SiemQueue(sink)
    handler.setLevel(logging.INFO)
    handler._audit_siem = True  # type: ignore[attr-defined]
    listener = logging.handlers.QueueListener(handler.queue, sink)
    listener.start()
    atexit.register(listener.stop)
    log.addHandler(handler)


def setup() -> None:
    """Подключает файл журнала и отправку в SIEM; повторный вызов ничего не меняет.

    Каталог недоступен на запись — предупреждение, и журнал остаётся только
    в stdout: из-за журнала API не должен не запускаться.
    """
    _setup_siem()
    if any(getattr(h, "_audit_file", False) for h in log.handlers):
        return
    directory = os.getenv("AUDIT_LOG_DIR", "").strip() or DEFAULT_DIR
    path = os.path.join(directory, "audit.log")
    try:
        os.makedirs(directory, exist_ok=True)
        handler = _DailyOrSizeHandler(
            path, when="midnight", backupCount=_retention_days(), encoding="utf-8", utc=True,
            max_bytes=_max_file_bytes(), max_total_bytes=_max_total_bytes())
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


def _write(name: str, fields: dict[str, Any], noise: bool = False, context: bool = True) -> None:
    """Строка журнала. context=False — событие не относится к текущему запросу (итоги по адресам)."""
    ctx = (_context.get() if context else None) or {}
    record: dict[str, Any] = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "event": name}
    record.update({key: ctx.get(key) for key in CORE_FIELDS})
    if not ctx and context:
        record["source"] = SOURCE_SYSTEM
    record["result"], record["blocked"] = OUTCOMES.get(name, ("success", False))
    record.update({k: v for k, v in fields.items() if v is not None})
    log.info(json.dumps(record, ensure_ascii=False, default=str),
             extra={"audit_noise": noise, "audit_blocked": bool(record["blocked"])})


def event(name: str, **fields: Any) -> None:
    _write(name, fields)
    _anonymous.sweep()


class _AnonymousCounter:
    """Анонимные отказы по адресу за минуту: первые ANONYMOUS_PER_MINUTE — строкой, остальные — счётчиком.

    Без этого любой без учётной записи писал бы в журнал строку на каждый
    запрос. Итог за окно (anonymous_suppressed) пишется, когда окно адреса
    закончилось и в журнал пришло любое следующее событие.
    """

    def __init__(self) -> None:
        self._ips: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._swept = float("-inf")

    def admit(self, ip: str, name: str) -> bool:
        now = _now()
        with self._lock:
            done = self._expired(now)
            if ip not in self._ips and len(self._ips) >= ANONYMOUS_MAX_IPS:
                ip = "*"
            entry = self._ips.get(ip)
            if entry is None:
                entry = self._ips[ip] = {"start": now, "since": datetime.now(timezone.utc), "written": 0,
                                         "suppressed": {}}
            admitted = entry["written"] < ANONYMOUS_PER_MINUTE
            if admitted:
                entry["written"] += 1
            else:
                entry["suppressed"][name] = entry["suppressed"].get(name, 0) + 1
        self._report(done)
        return admitted

    def sweep(self) -> None:
        now = _now()
        if now - self._swept < ANONYMOUS_WINDOW:
            return
        with self._lock:
            done = self._expired(now)
        self._report(done)

    def _expired(self, now: float) -> list[tuple[str, dict[str, Any]]]:
        """Закончившиеся окна: забываются, а с подавленными строками — к отчёту. Под _lock."""
        self._swept = now
        done = [(ip, e) for ip, e in self._ips.items() if now - e["start"] >= ANONYMOUS_WINDOW]
        for ip, _ in done:
            del self._ips[ip]
        return [(ip, e) for ip, e in done if e["suppressed"]]

    @staticmethod
    def _report(done: list[tuple[str, dict[str, Any]]]) -> None:
        for ip, entry in done:
            _write("anonymous_suppressed", {
                "ip": ip, "since": entry["since"].isoformat(timespec="seconds"),
                "counts": entry["suppressed"]}, noise=True, context=False)

    def flush(self) -> None:
        """Отчёт по всем окнам сразу и чистое состояние (остановка, тесты)."""
        with self._lock:
            done = [(ip, e) for ip, e in self._ips.items() if e["suppressed"]]
            self._ips.clear()
        self._report(done)


_anonymous = _AnonymousCounter()


def anonymous(name: str, ip: str, **fields: Any) -> None:
    """Событие без входа (отказ): не больше ANONYMOUS_PER_MINUTE строк в минуту с адреса."""
    if _anonymous.admit(ip, name):
        _write(name, {"ip": ip, **fields}, noise=True)


def flush_anonymous() -> None:
    _anonymous.flush()


setup()
