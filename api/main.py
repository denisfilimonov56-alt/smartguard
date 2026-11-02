"""HTTP-интерфейс агента проверки целей."""

import inspect
import json
import logging
import math
import os
import re
import threading
import time
from contextlib import asynccontextmanager
from typing import Annotated, Any, Optional

import anyio
import anyio.from_thread
import anyio.lowlevel
import anyio.to_thread
from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import AfterValidator, BaseModel, Field
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

import agent
import apikeys
import audit
import auth
import diagnostics
import graph
import history
import metrics
import monitoring
import routes
import schemas
import settings
from advisor import router as advisor_router
from agent import BULK_MAX_WORKERS, BULK_UNCHECKED_NOTE, check_goal, check_goals  # noqa: F401 — BULK_UNCHECKED_NOTE нужен тестам
from examples_check import router as examples_router
from monitoring import router as monitoring_router
from routes import router as catalog_router
from settings_routes import router as settings_router

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)


def _thread_limit() -> int:
    """Сколько потоков пула AnyIO отдать синхронным маршрутам.

    Ручная проверка держит поток всё время ожидания в очереди к модели и
    самого вызова, поэтому стандартных 40 мало: при занятой модели они
    кончаются, и встаёт всё синхронное — вход, каталог, «Настройки». Запас
    сверх 40 — на работающие и ждущие в очереди проверки (вдвое больше
    ёмкости модели), на потоки пакета и на одновременные пакетные запросы
    (каждый держит поток API до конца пакета, их не больше BULK_MAX_REQUESTS).
    API_THREADS задаёт число явно. Смена llmMaxConcurrency в «Настройках»
    пересчитывает предел на лету (_apply_thread_limit).
    """
    explicit = os.getenv("API_THREADS", "").strip()
    if explicit:
        try:
            return max(40, int(explicit))
        except ValueError:
            log.warning("API_THREADS должно быть числом, считается по ёмкости модели")
    return 40 + 2 * int(settings.number("llmMaxConcurrency")) + BULK_MAX_WORKERS + BULK_MAX_REQUESTS


# Сколько пакетных проверок (/check-goals) идёт одновременно на весь сервис.
# Пакет держит поток API, пока не проверит все цели, а его цели ждут очереди
# к модели без предела; без этого потолка сотня одновременных пакетов заняла
# бы все потоки, и встало бы всё синхронное. Сверх потолка — сразу 503 с Retry-After.
BULK_MAX_REQUESTS = max(1, int(os.getenv("BULK_MAX_REQUESTS", "4")))
_bulk_requests = threading.BoundedSemaphore(BULK_MAX_REQUESTS)

# Пакет должен ответить раньше, чем nginx перестанет ждать (proxy_read_timeout
# 600 с): посчитанное позже никто не прочтёт, а место пакета и модель заняты.
# По истечении срока или при обрыве соединения клиентом цели, до которых не
# дошли, возвращаются как NEEDS_MANUAL_REVIEW с пометкой BULK_UNCHECKED_NOTE
# и "unchecked": true. После остановки новые запросы к модели не уходят и не
# повторяются (agent._pause), но запрос, уже бывший в полёте, дожидается ответа
# или таймаута: срок по умолчанию оставляет на него LLM_TIMEOUT_SECONDS +
# LLM_CONNECT_TIMEOUT_SECONDS и ещё BULK_DEADLINE_MARGIN_SECONDS запаса
# (при умолчаниях 600 − 65 − 15 = 520 с).
PROXY_READ_TIMEOUT_SECONDS = 600
BULK_DEADLINE_MARGIN_SECONDS = 15
_BULK_DEADLINE_DEFAULT = max(10.0, PROXY_READ_TIMEOUT_SECONDS - (agent.LLM_TIMEOUT + agent.LLM_CONNECT_TIMEOUT)
                             - BULK_DEADLINE_MARGIN_SECONDS)
BULK_DEADLINE_SECONDS = max(10.0, float(os.getenv("BULK_DEADLINE_SECONDS") or _BULK_DEADLINE_DEFAULT))
if BULK_DEADLINE_SECONDS + agent.LLM_TIMEOUT + agent.LLM_CONNECT_TIMEOUT >= PROXY_READ_TIMEOUT_SECONDS:
    log.warning("BULK_DEADLINE_SECONDS (%d) + таймаут модели (%d) не меньше proxy_read_timeout nginx (%d с): "
                "пакет, остановленный по сроку, может ответить уже после того, как nginx отдаст 504",
                BULK_DEADLINE_SECONDS, agent.LLM_TIMEOUT + agent.LLM_CONNECT_TIMEOUT,
                PROXY_READ_TIMEOUT_SECONDS)
# Как часто обработчик пакета смотрит на срок и на соединение клиента.
BULK_WATCH_SECONDS = 1.0
# Без отмены внутри agent.check_goals пакет идёт частями по столько целей,
# и срок проверяется между частями.
BULK_CHUNK = 4 * BULK_MAX_WORKERS


class _CheckAdmission:
    """Ручные проверки (/check-goal) в работе и ждущие — не больше предела.

    Ручная проверка держит поток всё время ожидания модели. Без предела
    поток проверок быстрее модели копился бы в очереди потоков без границы и
    без 503. Сверх предела (CHECK_MAX_PENDING, по умолчанию вдвое больше
    ёмкости модели) — сразу 503 с Retry-After, до того как запрос займёт
    поток. Ключам внешних систем — предел без интерактивного резерва (вдвое):
    места сверх него остаются людям. Пределы пересчитываются в потоке
    (refresh), здесь — только чтение запомненного: граф из цикла событий не читается.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.total = self.keys = 0
        self.rejected = 0
        self.limit, self.key_limit = self._compute(32, 4)

    @staticmethod
    def _compute(capacity: int, reserve: int) -> tuple[int, int]:
        explicit = os.getenv("CHECK_MAX_PENDING", "").strip()
        try:
            limit = max(1, int(explicit)) if explicit else 2 * capacity
        except ValueError:
            limit = 2 * capacity
        return limit, max(1, limit - 2 * reserve)

    def refresh(self) -> None:
        """Пределы по ёмкости и резерву модели; вызывать из потока, не из цикла событий."""
        try:
            capacity, reserve = metrics.gate.limits()
        except Exception as exc:  # noqa: BLE001 — предел остаётся прежним
            log.warning("Предел ручных проверок не пересчитан: %s", exc)
            return
        self.limit, self.key_limit = self._compute(capacity, reserve)

    def enter(self, key: bool) -> bool:
        with self._lock:
            if self.total >= self.limit or (key and self.keys >= self.key_limit):
                self.rejected += 1
                return False
            self.total += 1
            self.keys += key
            return True

    def leave(self, key: bool) -> None:
        with self._lock:
            self.total -= 1
            self.keys -= key


check_admission = _CheckAdmission()


def _apply_thread_limit(token: Any, check_limiter: Optional[anyio.CapacityLimiter] = None) -> None:
    """Пересчитывает предел потоков AnyIO (и потоков ручных проверок); вызывается
    из любого потока (gate.reconfigure после правки llmMaxConcurrency). Предел
    только растёт: уменьшение не отнимает потоки у идущих запросов, а лишние
    ничего не стоят."""
    wanted = _thread_limit()

    def apply() -> None:
        limiter = anyio.to_thread.current_default_thread_limiter()
        if wanted > limiter.total_tokens:
            limiter.total_tokens = wanted
            log.info("Потоков для синхронных маршрутов: %s", wanted)
        if check_limiter is not None and check_admission.limit > check_limiter.total_tokens:
            check_limiter.total_tokens = check_admission.limit

    anyio.from_thread.run_sync(apply, token=token)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Недоступность Neo4j на старте не должна ронять контейнер:
    # оркестратор перезапустит зависимости, а /ready покажет реальное состояние.
    if graph.verify_connectivity():
        log.info("Соединение с Neo4j установлено")
        # Выписки обязанностей, оборванные перезапуском, — в error: их поток уже не допишет.
        routes.recover_duties_jobs()
    else:
        log.warning("Neo4j недоступен на старте, повторим при первом запросе")
    auth.check_config()
    agent.check_config()
    limiter = anyio.to_thread.current_default_thread_limiter()
    limiter.total_tokens = max(limiter.total_tokens, _thread_limit())
    log.info("Потоков для синхронных маршрутов: %s", limiter.total_tokens)
    await anyio.to_thread.run_sync(check_admission.refresh)
    # Ручные проверки — в своих потоках: ожидание модели не занимает потоки
    # входа, каталога и настроек. Больше предела допуска их всё равно не будет.
    app.state.check_limiter = anyio.CapacityLimiter(max(check_admission.limit, 1))
    token = anyio.lowlevel.current_token()

    def on_limits_changed() -> None:
        check_admission.refresh()
        _apply_thread_limit(token, app.state.check_limiter)

    metrics.gate.on_reconfigure(on_limits_changed)
    # У /ready свой лимит: он отвечает, даже когда общий пул занят проверками.
    app.state.ready_limiter = anyio.CapacityLimiter(READY_THREADS)
    history.start()
    metrics.start_catalog_watch()
    yield
    # Незавершённые выписки обязанностей не ждём: при следующем старте
    # recover_duties_jobs переведёт их в error.
    metrics.gate.off_reconfigure(on_limits_changed)
    routes.shutdown_duties_pool()
    metrics.stop_catalog_watch()
    history.stop()
    graph.close_driver()


# Swagger описывает весь API, включая служебные маршруты, поэтому по умолчанию
# выключен; на стенде включается через ENABLE_DOCS=1.
DOCS = os.getenv("ENABLE_DOCS", "0").strip().lower() in ("1", "true", "yes", "on")

app = FastAPI(
    title="SmartGuard", version="1.0.0", lifespan=lifespan,
    docs_url="/docs" if DOCS else None, redoc_url=None,
    openapi_url="/openapi.json" if DOCS else None,
)

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
AUDIT_BODY_LIMIT = 2000
# Из тела запроса советчику в журнал идут только эти поля: цель и обоснование —
# тексты пользователей, им в журнале не место (как и целям проверок).
ADVICE_AUDIT_FIELDS = ("attribute", "expected", "department_id")


def _audit_body(path: str, raw: bytes) -> Optional[str]:
    if path.rstrip("/") == "/catalog/advice":
        try:
            data = json.loads(raw)
        except ValueError:
            return None
        if not isinstance(data, dict):
            return None
        kept = {key: data[key] for key in ADVICE_AUDIT_FIELDS if key in data}
        return json.dumps(kept, ensure_ascii=False)[:AUDIT_BODY_LIMIT] if kept else None
    return raw[:AUDIT_BODY_LIMIT].decode("utf-8", "replace") or None


class Guard:
    """Защита от CSRF, заголовки ответа и журнал аудита.

    CORS не настроен намеренно: интерфейс ходит в API через свой же nginx
    (/api), с того же origin. Cookie у API нет — вход подтверждает токен в
    заголовке Authorization, а его браузер сам ни к какому запросу не
    добавит. Для изменяющих запросов без этого заголовка (их быть не должно)
    остаётся второй слой: X-Requested-With, который чужая страница без CORS
    поставить не может.

    Чистый ASGI, а не @app.middleware("http"): BaseHTTPMiddleware не пропускает
    к обработчику http.disconnect, request.is_disconnected() под ним всегда
    False, и пакет с советчиком при обрыве клиента досчитывались до срока (N1).
    Прочитанное для журнала тело отдаётся обработчику заново, а дальше receive —
    настоящий: обрыв соединения доходит до маршрута.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        unsafe = request.method not in SAFE_METHODS
        path = request.url.path
        rid = audit.request_id(request.headers.get("x-request-id"))
        body = None
        if unsafe and path.startswith("/catalog"):
            # Что именно поменяли — в журнал; тела /auth туда не попадают никогда.
            receive, raw = await _buffer_body(receive)
            body = _audit_body(path, raw)

        started = time.monotonic()
        status = 500
        # Кто, откуда и в каком запросе — во все строки журнала до конца запроса.
        context = audit.begin(request_id=rid, ip=audit.client_ip(request), object=path[:audit.PATH_MAX])

        async def send_with_headers(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = MutableHeaders(scope=message)
                headers["Cache-Control"] = "no-store"
                headers["X-Content-Type-Options"] = "nosniff"
                # По нему строку журнала находит и пользователь, и внешняя система.
                headers["X-Request-ID"] = rid
            await send(message)

        try:
            # Заголовок Authorization (токен или ключ доступа) чужая страница без
            # CORS поставить не может — как и X-Requested-With.
            if (unsafe and request.headers.get("x-requested-with") != "XMLHttpRequest"
                    and not auth.bearer_token(request)):
                response = JSONResponse(status_code=403,
                                        content={"detail": "Запрос отклонён: нет заголовка X-Requested-With"})
                await response(scope, receive, send_with_headers)
            else:
                await self.app(scope, receive, send_with_headers)
        finally:
            try:
                _audit_request(request, path, status, started, body)
            finally:
                audit.end(context)


async def _buffer_body(receive: Receive) -> tuple[Receive, bytes]:
    """Читает тело запроса целиком и возвращает receive, который сначала отдаёт
    прочитанное, а затем передаёт вызовы настоящему receive (в том числе
    http.disconnect при обрыве)."""
    chunks: list[bytes] = []
    messages: list[Message] = []
    while True:
        message = await receive()
        messages.append(message)
        if message["type"] != "http.request":
            break
        chunks.append(message.get("body", b""))
        if not message.get("more_body", False):
            break

    async def replay() -> Message:
        if messages:
            return messages.pop(0)
        return await receive()

    return replay, b"".join(chunks)


app.add_middleware(Guard)


# Опрос, который интерфейс повторяет каждые несколько секунд, пока раздел открыт:
# удачные ответы не журналируются, иначе строки опроса вытеснили бы действия.
POLL_PATHS = {"/monitoring/now", "/catalog/examples-check"}
# Ход проверки интерфейс спрашивает несколько раз в секунду (номер — в пути).
POLL_PREFIXES = ("/check-progress/", "/batch-progress/")


def _audit_request(request: Request, path: str, status: int, started: float, body: Optional[str]) -> None:
    """Строка о запросе: у вошедших — каждый запрос, кроме удачного опроса; без входа — изменяющие и 403.

    Вход и отказ по токену или ключу журналируются в auth.py подробнее: с причиной.
    """
    user = getattr(request.state, "user", None)
    unsafe = request.method not in SAFE_METHODS
    query = request.url.query or None
    result, blocked = audit.outcome(status)
    fields = dict(method=request.method, path=path[:audit.PATH_MAX], status=status,
                  ms=round((time.monotonic() - started) * 1000), result=result, blocked=blocked)
    if not user:
        if not unsafe and status != 403:
            return
        # Без входа тело не пишется, строка запроса обрезается сильнее, а строк с
        # одного адреса — не больше audit.ANONYMOUS_PER_MINUTE в минуту: иначе
        # любой без учётной записи наполнял бы журнал килобайтами на запрос.
        audit.anonymous("request", audit.client_ip(request), **fields,
                        query=query[:audit.ANONYMOUS_QUERY_MAX] if query else None)
        return
    if not unsafe and status < 400 and (path.rstrip("/") in POLL_PATHS or path.startswith(POLL_PREFIXES)):
        return
    audit.event("request", login=user.login, role=user.role, ip=audit.client_ip(request), **fields,
                query=query[:audit.QUERY_MAX] if query else None, body=body)


@app.exception_handler(metrics.QueueTimeout)
async def queue_timeout(request: Request, exc: metrics.QueueTimeout):
    """Очередь к модели не подошла: сервис перегружен, повторить позже."""
    log.warning("%s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(status_code=503, headers={"Retry-After": "30"}, content={
        "detail": "Модель сейчас перегружена: очередь к ней не подошла за "
                  f"{round(exc.waited)} с. Повторите проверку позже."})


app.include_router(auth.router)
# CRUD над приказами, пунктами, правилами, атрибутами, примерами и подразделениями.
app.include_router(catalog_router)
# Проверка примеров правил на модели: каталог не меняет, поэтому отдельно от него.
app.include_router(examples_router)
# Советчик: как поправить граф, чтобы ответ по цели стал другим; каталог не меняет.
app.include_router(advisor_router)
# Очередь, нагрузка и история проверок — только администратору.
app.include_router(monitoring_router)
# Переключатели проверки и ключи доступа внешних систем — только администратору.
app.include_router(settings_router)

# Словарь атрибутов доступен любому вошедшему пользователю; проверка целей —
# ещё и внешним системам с ключом доступа (auth.checker).
VIEWER = [Depends(auth.viewer)]


def _department_given(value: str) -> str:
    """Подразделение из одних пробелов после обрезки — то же, что не переданное."""
    if not value:
        raise ValueError("подразделение обязательно")
    return value


class GoalRequest(BaseModel):
    goal: schemas.GoalText = Field(
        ..., description="Формулировка цели для проверки, не длиннее настройки goalMaxChars")
    # Обязательно, как и в пакете: без подразделения не понять, какие правила применять.
    department_id: Annotated[schemas.DepartmentId, AfterValidator(_department_given)] = Field(
        ...,
        description="Идентификатор подразделения (Department.departmentId), до 100 символов; "
                    "число принимается как строка. Пустая строка или пробелы — ошибка 422",
    )
    is_student: Optional[bool] = Field(
        None,
        description="Ставит ли цель студент. false — правила только для студентов "
                    "(Rule.studentsOnly) пропускаются; без поля применяются все правила, "
                    "а причина пишется в notes",
    )


async def _admit_check(request: Request):
    """Допуск ручной проверки — до входа и до потока (см. _CheckAdmission).

    Ключ это или токен, видно по виду заголовка: подлинность проверит
    auth.checker следом, а поддельный ключ получит 401 и место освободит.
    """
    token = auth.bearer_token(request)
    key = bool(token and apikeys.TOKEN_RE.match(token))
    if not check_admission.enter(key):
        raise HTTPException(status_code=503, headers={"Retry-After": "10"}, detail=(
            "Сейчас идёт слишком много проверок, модель не успевает. Повторите проверку позже"))
    try:
        yield
    finally:
        check_admission.leave(key)


# Ход проверки для интерфейса: X-Check-Id в POST /check-goal и /check-goals,
# опрос — GET /check-progress/{id} и /batch-progress/{id}. Только пользователю
# с сессией и только свой: внешней системе с ключом ход не пишется, ответы
# проверки для неё те же. Ход живёт в памяти процесса API (он один: uvicorn
# без --workers); законченный хранится PROGRESS_KEEP_SECONDS — интерфейс берёт
# последний снимок после ответа, — а записей не больше PROGRESS_MAX: сверх него
# проверка идёт без хода.
PROGRESS_KEEP_SECONDS = 60.0
PROGRESS_MAX = 1000
CHECK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_progress: dict[tuple[str, str], tuple[str, Any]] = {}
_progress_lock = threading.Lock()


def _start_progress(kind: str, request: Request, user: auth.Principal, make) -> Optional[Any]:
    """Завести ход проверки (kind — check или batch), если интерфейс прислал X-Check-Id.

    None — ход не нужен (ключ внешней системы, нет или кривой заголовок) или
    этот номер уже занят: чужой ход им не подменить.
    """
    check_id = request.headers.get("x-check-id")
    if not check_id or user.role == auth.SERVICE_ROLE or not CHECK_ID_RE.match(check_id):
        return None
    now = time.monotonic()
    with _progress_lock:
        for key, (_, trace) in list(_progress.items()):
            if trace.finished is not None and now - trace.finished > PROGRESS_KEEP_SECONDS:
                del _progress[key]
        if (kind, check_id) in _progress or len(_progress) >= PROGRESS_MAX:
            return None
        trace = make()
        _progress[(kind, check_id)] = (user.login, trace)
    return trace


def _progress_view(kind: str, check_id: str, user: auth.Principal) -> dict[str, Any]:
    with _progress_lock:
        entry = _progress.get((kind, check_id))
    # Чужой ход — как несуществующий: по 404 не узнать, что номер занят.
    if entry is None or entry[0] != user.login:
        raise HTTPException(status_code=404, detail="Проверка не найдена" if kind == "check" else "Пакет не найден")
    return entry[1].view()


@app.get("/check-progress/{check_id}")
async def check_progress(check_id: str, user: auth.Principal = Depends(auth.viewer)):
    """Ход проверки цели, запущенной интерфейсом с X-Check-Id (тип CheckProgress)."""
    return _progress_view("check", check_id, user)


@app.get("/batch-progress/{check_id}")
async def batch_progress(check_id: str, user: auth.Principal = Depends(auth.viewer)):
    """Ход пакетного запроса, запущенного интерфейсом с X-Check-Id (тип BatchProgress)."""
    return _progress_view("batch", check_id, user)


@app.post("/check-goal", dependencies=[Depends(_admit_check)])
async def check(request: Request, req: GoalRequest, user: auth.Principal = Depends(auth.checker)):
    """Проверка цели на соответствие действующим приказам."""
    trace = _start_progress("check", request, user, agent.CheckTrace)

    def work() -> dict[str, Any]:
        result = None
        try:
            auth.spend_checks(user, 1)
            metrics.set_actor(user.login)
            with agent.tracing(trace):
                result = check_goal(req.goal, department_id=req.department_id, is_student=req.is_student)
            return result
        finally:
            # Поток пула переиспользуется: следующий запрос в нём не должен считаться чужим.
            metrics.set_actor(None)
            if trace is not None:
                trace.finish(result)

    limiter = getattr(request.app.state, "check_limiter", None)
    try:
        return await anyio.to_thread.run_sync(work, limiter=limiter)
    finally:
        if trace is not None:
            trace.finish()  # до потока не дошло (обрыв, отмена): ход не должен висеть «идущим»


class SuggestProblem(BaseModel):
    rule_text: Optional[str] = Field(None, max_length=2000)
    check_instruction: Optional[str] = Field(None, max_length=2000)


class SuggestRequest(BaseModel):
    goal: schemas.GoalText = Field(..., description="Формулировка цели, которую проверяли")
    violations: list[SuggestProblem] = Field(
        ..., min_length=1, max_length=20, description="Нарушения из ответа /check-goal: текст правила и как исправить")


@app.post("/suggest-goal", dependencies=[Depends(_admit_check)])
async def suggest(request: Request, req: SuggestRequest, user: auth.Principal = Depends(auth.checker)):
    """Рекомендованная формулировка цели, которая выполняет нарушенные правила.

    Отдельный запрос к модели после проверки: ответ /check-goal не меняется,
    а модель спрашивают, только когда нарушения есть и пользователь на экране."""
    if agent.looks_like_injection(req.goal):
        raise HTTPException(status_code=422, detail="Цель похожа на указания модели: переписать её автоматически нельзя")

    # Лимит проверок в минуту не тратится: это подсказка к уже посчитанной проверке,
    # а не новая цель; одновременных запросов к модели не больше, чем проверок (_admit_check).
    def work() -> dict[str, Any]:
        metrics.set_actor(user.login)
        try:
            return {"goal": agent.suggest_goal(req.goal, [v.model_dump() for v in req.violations])}
        except agent.ExtractionError as exc:
            raise HTTPException(status_code=502, detail=f"Модель не предложила формулировку: {exc}") from exc
        finally:
            metrics.set_actor(None)

    limiter = getattr(request.app.state, "check_limiter", None)
    return await anyio.to_thread.run_sync(work, limiter=limiter)


MAX_BATCH = int(os.getenv("MAX_GOALS_PER_REQUEST", "200"))


def _unchecked(item: dict[str, Any]) -> dict[str, Any]:
    """Цель пакета, до которой не дошли до срока или обрыва соединения."""
    return {"id": item.get("id"), **agent.unchecked_review(
        item["goal"], agent.resolve_student(item.get("is_student"))[0])}


def _summary(results: list[dict[str, Any]]) -> dict[str, int]:
    statuses = [r.get("status") for r in results]
    return {"total": len(results), "allowed": statuses.count(agent.STATUS_ALLOWED),
            "violations": statuses.count(agent.STATUS_VIOLATIONS),
            "manual_review": statuses.count(agent.STATUS_MANUAL_REVIEW)}


def _run_batch(items: list[dict[str, Any]], stop: threading.Event) -> dict[str, Any]:
    """Пакет с остановкой по stop: недосчитанные цели — ручная проверка с пометкой.

    Если agent.check_goals принимает cancel, останавливается сам пакет (и
    ожидание очереди к модели). Иначе пакет идёт частями по BULK_CHUNK целей,
    и stop проверяется между частями.
    """
    if "cancel" in inspect.signature(check_goals).parameters:
        return check_goals(items, cancel=stop)
    if len(items) <= BULK_CHUNK:
        return check_goals(items)
    results: list[dict[str, Any]] = []
    for start in range(0, len(items), BULK_CHUNK):
        chunk = items[start:start + BULK_CHUNK]
        if stop.is_set():
            results += [_unchecked(item) for item in chunk]
            continue
        results += check_goals(chunk)["results"]
    return {"results": results, "summary": _summary(results)}


async def _until_done(request: Request, work, stop: threading.Event) -> Any:
    """Запускает work в потоке; по истечении BULK_DEADLINE_SECONDS или при обрыве
    соединения клиентом ставит stop. Исключение work поднимается как есть."""
    outcome: dict[str, Any] = {}
    started = time.monotonic()

    async def run() -> None:
        try:
            outcome["value"] = await anyio.to_thread.run_sync(work)
        except Exception as exc:  # noqa: BLE001 — поднимется ниже, вне группы задач
            outcome["error"] = exc
        group.cancel_scope.cancel()

    async def watch() -> None:
        try:
            while True:
                await anyio.sleep(BULK_WATCH_SECONDS)
                if time.monotonic() - started >= BULK_DEADLINE_SECONDS:
                    log.warning("Пакет не уложился в %d с: оставшиеся цели — на ручную проверку",
                                BULK_DEADLINE_SECONDS)
                    break
                if await request.is_disconnected():
                    log.warning("Клиент закрыл соединение: пакет останавливается")
                    break
        finally:
            # И отмена самого обработчика (сервер остановился, соединение
            # закрыто) останавливает пакет: иначе он досчитывался бы впустую.
            stop.set()

    async with anyio.create_task_group() as group:
        group.start_soon(run)
        group.start_soon(watch)
    if "error" in outcome:
        raise outcome["error"]
    return outcome["value"]


@app.post("/check-goals")
async def check_many(request: Request, items: list[schemas.GoalItem] = Body(..., description="Массив целей"),
                     user: auth.Principal = Depends(auth.checker)):
    """Пакетная проверка целей.

    Вход — массив объектов вида {"goal": "...", "department_id": "...", "is_student": true, "id": "..."}.
    department_id обязателен: кадровая система его знает. is_student — ставит ли
    цель студент; без него применяются и правила только для студентов. Порядок ответов
    совпадает с порядком входа, id возвращается как передан (или null).
    Обращения к модели идут параллельно; словари атрибутов и подразделений
    читаются один раз. Пакет отвечает не позже BULK_DEADLINE_SECONDS: цели,
    до которых не дошли (или клиент закрыл соединение), возвращаются как
    NEEDS_MANUAL_REVIEW с пометкой о повторной отправке.
    """
    if len(items) > MAX_BATCH:
        raise HTTPException(
            status_code=413,
            detail=f"За один раз можно проверить не более {MAX_BATCH} целей, передано {len(items)}",
        )
    stop = threading.Event()
    trace = _start_progress("batch", request, user, lambda: agent.BatchTrace(len(items)))

    def work() -> dict[str, Any]:
        if not settings.flag("bulkChecks"):
            raise HTTPException(
                status_code=503,
                detail="Пакетная проверка временно отключена администратором. Цели можно проверять по одной",
            )
        if not _bulk_requests.acquire(blocking=False):
            raise HTTPException(
                status_code=503, headers={"Retry-After": "30"},
                detail=f"Сейчас уже идут {BULK_MAX_REQUESTS} пакетных проверки — больше одновременно "
                       "сервис не принимает. Повторите запрос позже",
            )
        try:
            spent = auth.spend_checks(user, len(items))
            metrics.set_actor(user.login)
            try:
                with agent.tracing_batch(trace):
                    outcome = _run_batch([item.model_dump() for item in items], stop)
            finally:
                metrics.set_actor(None)
            # Непроверенные цели (пакет остановлен) клиент отправит снова:
            # квоту за них возвращаем, иначе повтор упёрся бы в лимит.
            unchecked = sum(1 for r in outcome["results"] if r.get("unchecked"))
            if unchecked:
                auth.refund_checks(user, unchecked, spent)
            return outcome
        finally:
            _bulk_requests.release()

    try:
        return await _until_done(request, work, stop)
    finally:
        if trace is not None:
            trace.finish()


@app.get("/check-targets", dependencies=VIEWER)
def check_targets():
    """Словарь проверяемых атрибутов из графа (полезно для отладки и UI)."""
    return {"targets": graph.get_check_targets()}


@app.get("/health")
async def health():
    """Liveness: процесс жив.

    async и без обращений к чему-либо: отвечает, даже когда все потоки для
    синхронных маршрутов заняты проверками (иначе HEALTHCHECK счёл бы
    контейнер мёртвым).
    """
    return {"status": "ok"}


# Сколько /ready ждёт ответов Neo4j и vLLM вместе; vLLM — не дольше VLLM_READY_TIMEOUT.
READY_TIMEOUT_SECONDS = 15
VLLM_READY_TIMEOUT = 2
READY_THREADS = 4


def _not_ready(problem: str, **fields: Any) -> JSONResponse:
    return JSONResponse(status_code=503, content={
        "status": "not_ready", "neo4j": False, "llm": None, "check_targets": 0,
        "problems": [problem], "diagnostics": {}, **fields,
    })


@app.get("/ready")
async def ready(request: Request):
    """Readiness: зависимости доступны, граф заполнен и внутренне непротиворечив.

    Neo4j и vLLM опрашиваются одновременно в своих потоках (отдельный лимит,
    не общий пул маршрутов) и не дольше READY_TIMEOUT_SECONDS вместе.

    Открыт без входа — для оркестратора и для проверки с самого сервера.
    Наружу не попадает: порт API слушает только localhost, а nginx интерфейса
    этот маршрут не проксирует.

    Дубликаты написаний, атрибуты без описания, правила без атрибутов и узлы
    без идентификаторов делают проверку целей молча неполной, поэтому это
    тоже «не готов», а не предупреждение. Развёрнутый разбор с указанием
    конкретных узлов — в /catalog/diagnostics. Поле llm — ответил ли vLLM
    на GET /v1/models с ключом за VLLM_READY_TIMEOUT с и есть ли в списке
    VLLM_MODEL (ответ кэшируется на 45 с); без модели проверка целей не
    работает, поэтому это тоже «не готов».
    """
    limiter = getattr(request.app.state, "ready_limiter", None) or anyio.CapacityLimiter(READY_THREADS)
    found: dict[str, Any] = {}

    async def run(name: str, func) -> None:
        found[name] = await anyio.to_thread.run_sync(func, abandon_on_cancel=True, limiter=limiter)

    def graph_state() -> Any:
        if not graph.verify_connectivity():
            return None
        try:
            return diagnostics.collect()
        except Exception as exc:  # noqa: BLE001
            log.warning("Диагностика не выполнилась: %s", exc)
            return exc

    with anyio.move_on_after(READY_TIMEOUT_SECONDS) as scope:
        async with anyio.create_task_group() as group:
            group.start_soon(run, "graph", graph_state)
            group.start_soon(run, "llm", lambda: monitoring.vllm_alive(VLLM_READY_TIMEOUT))
    llm = found.get("llm", False)
    if scope.cancelled_caught and "graph" not in found:
        return _not_ready(f"Neo4j не ответил за {READY_TIMEOUT_SECONDS} с", llm=llm)

    report = found["graph"]
    if report is None:
        return _not_ready("Neo4j недоступен", llm=llm)
    if isinstance(report, Exception):
        return _not_ready(f"Не удалось прочитать граф: {report}", neo4j=True, llm=llm)

    problems = list(report["problems"])
    if not llm:
        problems.append("Модель недоступна: " + (monitoring.vllm_problem() or "нет ответа"))
    ok = report["ready"] and llm
    payload = {
        "status": "ready" if ok else "not_ready",
        "neo4j": True,
        "llm": llm,
        "check_targets": report["check_targets"],
        "problems": problems,
        "diagnostics": report,
        # Расхождение часов API и Keycloak, замеченное по токенам за последний час (> 0 — API отстаёт).
        "clock_skew_seconds": auth.clock_skew(),
    }
    if ok:
        return payload
    log.warning("Сервис не готов к проверкам: %s", "; ".join(problems))
    return JSONResponse(status_code=503, content=payload)


def _prometheus_number(value: Any) -> str:
    """Число для Prometheus без потери точности: целые — как есть, дробные — repr.

    Формат :g оставлял шесть значащих цифр: счётчик 1234567 уходил как
    1.23457e+06, и rate() по нему врал (N19).
    """
    if isinstance(value, bool):
        return str(int(value))
    if isinstance(value, int):
        return str(value)
    value = float(value or 0)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "+Inf" if value > 0 else "-Inf"
    if value.is_integer() and abs(value) < 2 ** 53:
        return str(int(value))
    return repr(value)


def _prometheus() -> str:
    """Показатели в текстовом формате Prometheus (то же, что «Мониторинг», без истории за период)."""
    now = metrics.snapshot()
    recent = now["recent"]
    history_state = history.state()
    lines: list[str] = []
    described: set[str] = set()

    def put(name: str, value: Any, help_text: str, kind: str = "gauge", labels: str = "") -> None:
        if name not in described:
            described.add(name)
            lines.append(f"# HELP goal_checker_{name} {help_text}")
            lines.append(f"# TYPE goal_checker_{name} {kind}")
        lines.append(f"goal_checker_{name}{labels} {_prometheus_number(value)}")

    llm = now["llm"]
    put("llm_capacity", llm["capacity"], "Одновременных запросов к модели (llmMaxConcurrency)")
    put("llm_running", llm["running"], "Запросов к модели в работе")
    put("llm_waiting", llm["waiting"], "Запросов, ждущих места в очереди к модели")
    put("checks_running", now["checks"]["running"], "Проверок целей в работе")
    put("bulk_batches", len(now["checks"]["batches"]), "Пакетов в работе")
    put("bulk_queued_goals", now["checks"]["queued"], "Целей принятых пакетов, до которых не дошла очередь")
    put("single_checks_admitted", check_admission.total, "Ручных проверок в работе и ждущих")
    put("single_checks_rejected_total", check_admission.rejected,
        "Ручных проверок, отклонённых 503 сверх предела", "counter")
    put("recent_checks", recent["checks"], f"Проверок за последние {recent['window_seconds']} с")
    put("recent_manual_review", recent["manual_review"],
        f"Ответов NEEDS_MANUAL_REVIEW за последние {recent['window_seconds']} с")
    put("recent_manual_review_ratio", recent["manual_review"] / recent["checks"] if recent["checks"] else 0,
        "Доля NEEDS_MANUAL_REVIEW среди недавних проверок")
    for kind, breaker in sorted(getattr(agent, "_breakers", {}).items()):
        put("llm_breaker_open", int(breaker.is_open()), "Разомкнут ли предохранитель модели",
            labels=f'{{kind="{kind}"}}')
    put("history_pending", history_state["pending"], "Записей истории проверок, ждущих записи в Neo4j")
    put("history_dropped_total", history_state["dropped"], "Записей истории, потерянных при переполнении",
        "counter")
    skew = auth.clock_skew()
    if skew is not None:
        put("clock_skew_seconds", skew, "Расхождение часов API и Keycloak за последний час, > 0 — API отстаёт")
    put("uptime_seconds", now["uptime_seconds"], "Сколько секунд работает процесс API")
    return "\n".join(lines) + "\n"


@app.get("/metrics", include_in_schema=False)
async def prometheus(request: Request):
    """Показатели для Prometheus: очередь к модели, доля ручных проверок, предохранители, история.

    Открыт без входа, как /ready, — для опроса с самого сервера: порт API
    слушает только localhost, а nginx интерфейса этот маршрут не проксирует.
    Считается в потоках /ready: отвечает, даже когда общий пул занят.
    """
    limiter = getattr(request.app.state, "ready_limiter", None) or anyio.CapacityLimiter(READY_THREADS)
    text = await anyio.to_thread.run_sync(_prometheus, limiter=limiter, abandon_on_cancel=True)
    return PlainTextResponse(text, media_type="text/plain; version=0.0.4; charset=utf-8")
