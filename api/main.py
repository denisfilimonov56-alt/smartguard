"""HTTP-интерфейс агента проверки целей."""

import json
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

import anyio
import anyio.from_thread
import anyio.lowlevel
import anyio.to_thread
from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

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
from agent import BULK_MAX_WORKERS, check_goal, check_goals
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


def _apply_thread_limit(token: Any) -> None:
    """Пересчитывает предел потоков AnyIO; вызывается из любого потока
    (gate.reconfigure после правки llmMaxConcurrency). Предел только растёт:
    уменьшение не отнимает потоки у идущих запросов, а лишние ничего не стоят."""
    wanted = _thread_limit()

    def apply() -> None:
        limiter = anyio.to_thread.current_default_thread_limiter()
        if wanted > limiter.total_tokens:
            limiter.total_tokens = wanted
            log.info("Потоков для синхронных маршрутов: %s", wanted)

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
    limiter = anyio.to_thread.current_default_thread_limiter()
    limiter.total_tokens = max(limiter.total_tokens, _thread_limit())
    log.info("Потоков для синхронных маршрутов: %s", limiter.total_tokens)
    token = anyio.lowlevel.current_token()

    def on_limits_changed() -> None:
        _apply_thread_limit(token)

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
    title="Goal Checker Agent", version="1.0.0", lifespan=lifespan,
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


@app.middleware("http")
async def guard(request: Request, call_next):
    """Защита от CSRF, заголовки ответа и журнал аудита.

    CORS не настроен намеренно: интерфейс ходит в API через свой же nginx
    (/api), с того же origin. Cookie у API нет — вход подтверждает токен в
    заголовке Authorization, а его браузер сам ни к какому запросу не
    добавит. Для изменяющих запросов без этого заголовка (их быть не должно)
    остаётся второй слой: X-Requested-With, который чужая страница без CORS
    поставить не может.
    """
    unsafe = request.method not in SAFE_METHODS
    path = request.url.path
    body = None
    if unsafe and path.startswith("/catalog"):
        # Что именно поменяли — в журнал; тела /auth туда не попадают никогда.
        body = _audit_body(path, await request.body())

    started = time.monotonic()
    status = 500
    try:
        # Заголовок Authorization (токен или ключ доступа) чужая страница без
        # CORS поставить не может — как и X-Requested-With.
        if (unsafe and request.headers.get("x-requested-with") != "XMLHttpRequest"
                and not auth.bearer_token(request)):
            response = JSONResponse(status_code=403,
                                    content={"detail": "Запрос отклонён: нет заголовка X-Requested-With"})
        else:
            response = await call_next(request)
        status = response.status_code
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response
    finally:
        # Вход и отказ по токену журналируются в auth.py подробнее: с причиной.
        if unsafe or status == 403:
            user = getattr(request.state, "user", None)
            query = request.url.query or None
            if not user:
                # Без входа тело не пишется, а строка запроса обрезается: иначе
                # любой без учётной записи наполнял бы журнал килобайтами на запрос.
                body = None
                query = query[:audit.ANONYMOUS_QUERY_MAX] if query else None
            audit.event(
                "request", login=user.login if user else None, role=user.role if user else None,
                ip=audit.client_ip(request), method=request.method, path=path[:audit.PATH_MAX],
                query=query, status=status,
                ms=round((time.monotonic() - started) * 1000), body=body,
            )


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


class GoalRequest(BaseModel):
    goal: schemas.GoalText = Field(
        ..., description="Формулировка цели для проверки, не длиннее настройки goalMaxChars")
    department_id: Optional[str] = Field(
        None,
        description="Идентификатор подразделения (Department.departmentId). "
                    "Без него применяются все правила, а причина пишется в notes",
    )
    is_student: Optional[bool] = Field(
        None,
        description="Ставит ли цель студент. false — правила только для студентов "
                    "(Rule.studentsOnly) пропускаются; без поля применяются все правила, "
                    "а причина пишется в notes",
    )


@app.post("/check-goal")
def check(req: GoalRequest, user: auth.Principal = Depends(auth.checker)):
    """Проверка цели на соответствие действующим приказам."""
    auth.spend_checks(user, 1)
    metrics.set_actor(user.login)
    try:
        return check_goal(req.goal, department_id=req.department_id, is_student=req.is_student)
    finally:
        # Поток пула переиспользуется: следующий запрос в нём не должен считаться чужим.
        metrics.set_actor(None)


MAX_BATCH = int(os.getenv("MAX_GOALS_PER_REQUEST", "200"))


@app.post("/check-goals")
def check_many(items: list[schemas.GoalItem] = Body(..., description="Массив целей"),
               user: auth.Principal = Depends(auth.checker)):
    """Пакетная проверка целей.

    Вход — массив объектов вида {"goal": "...", "department_id": "...", "is_student": true, "id": "..."}.
    department_id обязателен: кадровая система его знает. is_student — ставит ли
    цель студент; без него применяются и правила только для студентов. Порядок ответов
    совпадает с порядком входа, id возвращается как передан (или null).
    Обращения к модели идут параллельно; словари атрибутов и подразделений
    читаются один раз.
    """
    if len(items) > MAX_BATCH:
        raise HTTPException(
            status_code=413,
            detail=f"За один раз можно проверить не более {MAX_BATCH} целей, передано {len(items)}",
        )
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
        auth.spend_checks(user, len(items))
        metrics.set_actor(user.login)
        try:
            return check_goals([item.model_dump() for item in items])
        finally:
            metrics.set_actor(None)
    finally:
        _bulk_requests.release()


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
    на GET /health за VLLM_READY_TIMEOUT с; без модели проверка целей не
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
        problems.append("Модель (vLLM) недоступна: не ответила на /health")
    ok = report["ready"] and llm
    payload = {
        "status": "ready" if ok else "not_ready",
        "neo4j": True,
        "llm": llm,
        "check_targets": report["check_targets"],
        "problems": problems,
        "diagnostics": report,
    }
    if ok:
        return payload
    log.warning("Сервис не готов к проверкам: %s", "; ".join(problems))
    return JSONResponse(status_code=503, content=payload)
