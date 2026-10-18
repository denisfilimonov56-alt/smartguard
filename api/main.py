"""HTTP-интерфейс агента проверки целей."""

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import audit
import auth
import diagnostics
import graph
import history
import metrics
import schemas
import settings
from advisor import router as advisor_router
from agent import check_goal, check_goals
from examples_check import router as examples_router
from monitoring import router as monitoring_router
from routes import router as catalog_router
from settings_routes import router as settings_router

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Недоступность Neo4j на старте не должна ронять контейнер:
    # оркестратор перезапустит зависимости, а /ready покажет реальное состояние.
    if graph.verify_connectivity():
        log.info("Соединение с Neo4j установлено")
    else:
        log.warning("Neo4j недоступен на старте, повторим при первом запросе")
    auth.check_config()
    history.start()
    yield
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


@app.middleware("http")
async def guard(request: Request, call_next):
    """Защита от CSRF, заголовки ответа и журнал аудита.

    CORS не настроен намеренно: интерфейс ходит в API через свой же nginx
    (/api), с того же origin. Изменяющий запрос обязан нести заголовок
    X-Requested-With — чужая страница не может поставить его без CORS,
    которого здесь нет; это второй слой после SameSite=Strict у cookie.
    """
    unsafe = request.method not in SAFE_METHODS
    path = request.url.path
    body = None
    if unsafe and path.startswith("/catalog"):
        # Что именно поменяли — в журнал; тела /auth туда не попадают никогда.
        body = (await request.body())[:AUDIT_BODY_LIMIT].decode("utf-8", "replace") or None

    started = time.monotonic()
    status = 500
    try:
        # Запрос с ключом доступа cookie не использует, а заголовок Authorization
        # чужая страница без CORS поставить не может — как и X-Requested-With.
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
        # Вход журналируется в auth.py подробнее: с причиной отказа.
        if (unsafe or status == 403) and path != "/auth/login":
            user = getattr(request.state, "user", None)
            audit.event(
                "request", login=user.login if user else None, role=user.role if user else None,
                ip=audit.client_ip(request), method=request.method, path=path,
                query=request.url.query or None, status=status,
                ms=round((time.monotonic() - started) * 1000), body=body,
            )


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
    goal: str = Field(..., description="Формулировка цели для проверки")
    department_id: Optional[str] = Field(
        None,
        description="Идентификатор подразделения (Department.departmentId). "
                    "Без него применяются все правила, а причина пишется в notes",
    )


@app.post("/check-goal")
def check(req: GoalRequest, user: auth.Principal = Depends(auth.checker)):
    """Проверка цели на соответствие действующим приказам."""
    auth.spend_checks(user, 1)
    metrics.set_actor(user.login)
    return check_goal(req.goal, department_id=req.department_id)


MAX_BATCH = int(os.getenv("MAX_GOALS_PER_REQUEST", "200"))


@app.post("/check-goals")
def check_many(items: list[schemas.GoalItem] = Body(..., description="Массив целей"),
               user: auth.Principal = Depends(auth.checker)):
    """Пакетная проверка целей.

    Вход — массив объектов вида {"goal": "...", "department_id": "...", "id": "..."}.
    department_id обязателен: кадровая система его знает. Порядок ответов
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
    auth.spend_checks(user, len(items))
    metrics.set_actor(user.login)
    return check_goals([item.model_dump() for item in items])


@app.get("/check-targets", dependencies=VIEWER)
def check_targets():
    """Словарь проверяемых атрибутов из графа (полезно для отладки и UI)."""
    return {"targets": graph.get_check_targets()}


@app.get("/health")
def health():
    """Liveness: процесс жив."""
    return {"status": "ok"}


@app.get("/ready")
def ready():
    """Readiness: зависимости доступны, граф заполнен и внутренне непротиворечив.

    Открыт без входа — для оркестратора и для проверки с самого сервера.
    Наружу не попадает: порт API слушает только localhost, а nginx интерфейса
    этот маршрут не проксирует.

    Дубликаты написаний, атрибуты без описания, правила без атрибутов и узлы
    без идентификаторов делают проверку целей молча неполной, поэтому это
    тоже «не готов», а не предупреждение. Развёрнутый разбор с указанием
    конкретных узлов — в /catalog/diagnostics.
    """
    if not graph.verify_connectivity():
        return JSONResponse(status_code=503, content={
            "status": "not_ready", "neo4j": False, "check_targets": 0,
            "problems": ["Neo4j недоступен"], "diagnostics": {},
        })

    try:
        report = diagnostics.collect()
    except Exception as exc:  # noqa: BLE001
        log.warning("Диагностика не выполнилась: %s", exc)
        return JSONResponse(status_code=503, content={
            "status": "not_ready", "neo4j": True, "check_targets": 0,
            "problems": [f"Не удалось прочитать граф: {exc}"], "diagnostics": {},
        })

    payload = {
        "status": "ready" if report["ready"] else "not_ready",
        "neo4j": True,
        "check_targets": report["check_targets"],
        "problems": report["problems"],
        "diagnostics": report,
    }
    if report["ready"]:
        return payload
    log.warning("Граф не готов к проверкам: %s", "; ".join(report["problems"]))
    return JSONResponse(status_code=503, content=payload)
