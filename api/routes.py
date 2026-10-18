"""HTTP-маршруты каталога нормативных требований.

Узлы адресуются по nodeId (elementId Neo4j): он есть всегда, в отличие от
бизнес-ключей, которых может не быть у ранее заведённых данных.
"""

import logging
import os
import queue
import threading
import time
from contextvars import ContextVar
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from neo4j.exceptions import ConstraintError
from starlette.exceptions import HTTPException as StarletteHTTPException

import agent
import auth
import catalog
import diagnostics
import metrics
import schemas

log = logging.getLogger(__name__)

# Читать каталог может любой вошедший пользователь; менять — редактор;
# необратимое (физическое удаление, массовый ремонт) — только администратор.
# Отметка «запрос дошёл до операции каталога» (её ставит _handle). Без неё
# неверное тело (422) не отличить от успеха: FastAPI закрывает зависимость
# штатно, а ошибку проверки бросает уже после.
_write_reached: ContextVar[Optional[dict]] = ContextVar("catalog_write_reached", default=None)


async def _catalog_changed(request: Request):
    """После правки каталога готовые ответы проверок устаревают.

    Кэш сбрасывается, только если запрос дошёл до операции каталога и она
    либо удалась, либо упала непредвиденно (могла записать часть). Отказ в
    правах (403), неверное тело (422) и ошибки каталога (404/409 — проверка
    до записи или откат транзакции) кэш не трогают: иначе читатель циклом
    отклонённых POST опустошал бы кэш ответов для всех.

    Зависимость асинхронная: отметка в ContextVar, выставленная здесь, видна
    обработчику (он идёт в пуле потоков с копией этого контекста).
    """
    if request.method == "GET":
        yield
        return
    reached = {"reached": False}
    _write_reached.set(reached)
    try:
        yield
    except StarletteHTTPException:
        raise
    except Exception:
        if reached["reached"]:
            await run_in_threadpool(metrics.catalog_changed)
        raise
    if reached["reached"]:
        await run_in_threadpool(metrics.catalog_changed)


router = APIRouter(prefix="/catalog", tags=["catalog"],
                   dependencies=[Depends(auth.viewer), Depends(_catalog_changed)])
EDITOR = [Depends(auth.editor)]
ADMIN = [Depends(auth.admin)]


def _handle(func, *args, **kwargs):
    """Переводит ошибки каталога в осмысленные коды ответа."""
    reached = _write_reached.get()
    if reached is not None:
        reached["reached"] = True
    try:
        return func(*args, **kwargs)
    except catalog.NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except catalog.Conflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ConstraintError as exc:
        # Проверка «уже существует» и запись не атомарны: параллельный запрос
        # успел занять ключ, и сработало ограничение уникальности в базе.
        raise HTTPException(status_code=409, detail="Такой идентификатор уже занят. "
                                                    "Обновите страницу и повторите.") from exc


# ------------------------------- чтение -------------------------------------


@router.get("/tree")
def get_tree(include_archived: bool = Query(False, description="Показывать архив")):
    """Весь каталог: приказы → пункты → правила → атрибуты и примеры."""
    return _handle(catalog.build_tree, include_archived)


@router.get("/check-targets")
def get_check_targets(include_archived: bool = Query(False)):
    return {"targets": _handle(catalog.list_check_targets, include_archived)}


@router.get("/clauses")
def get_clauses_flat():
    """Плоский список пунктов — для выбора родителя и перекрёстных ссылок."""
    return {"clauses": _handle(catalog.list_clauses_flat)}


@router.get("/departments")
def get_departments(include_archived: bool = Query(False)):
    """Подразделения и правила, чью область действия они задают."""
    return {"departments": _handle(catalog.list_departments, include_archived)}


@router.get("/graph")
def get_graph():
    """Узлы и связи каталога — для визуального графа."""
    return _handle(catalog.graph_view)


@router.get("/diagnostics")
def get_diagnostics():
    """Развёрнутая диагностика графа с указанием конкретных узлов."""
    return _handle(diagnostics.collect)


# --------------------- операции над произвольным узлом ----------------------


@router.get("/nodes/{node_id}")
def get_node(node_id: str):
    """Все свойства узла — для редактора свойств."""
    return _handle(catalog.get_node, node_id)


@router.patch("/nodes/{node_id}/properties", dependencies=EDITOR)
def patch_node_properties(node_id: str, body: schemas.PropertiesRequest):
    """Правка произвольных свойств. null в значении удаляет свойство."""
    return _handle(catalog.update_properties, node_id, dict(body.properties))


@router.post("/nodes/{node_id}/status", dependencies=EDITOR)
def post_node_status(node_id: str, body: schemas.StatusRequest):
    return _handle(catalog.set_status, node_id, body.status)


@router.get("/nodes/{node_id}/descendants")
def get_descendants(node_id: str):
    """Что будет удалено вместе с узлом."""
    return _handle(catalog.count_descendants, node_id)


@router.delete("/nodes/{node_id}", dependencies=ADMIN)
def delete_node(
    node_id: str,
    force: bool = Query(False, description="Удалить без предварительного архивирования"),
):
    """Физическое удаление узла со всем, что без него теряет смысл.

    Без force удаляется только архивированный узел. Атрибут, на который
    ссылаются правила, не удаляется в любом случае — иначе правила повиснут.
    """
    return _handle(catalog.delete_node, node_id, True, force)


# ------------------------------- создание -----------------------------------


@router.post("/orders", status_code=201, dependencies=EDITOR)
def post_order(body: schemas.OrderCreate):
    return _handle(catalog.create_order, body.number, body.title, body.date, body.orderId)


@router.post("/clauses", status_code=201, dependencies=EDITOR)
def post_clause(body: schemas.ClauseCreate):
    return _handle(catalog.create_clause, body.orderNodeId, body.code, body.text, body.clauseId)


@router.post("/rules", status_code=201, dependencies=EDITOR)
def post_rule(body: schemas.RuleCreate):
    return _handle(
        catalog.create_rule, body.clauseNodeId, body.type, body.description,
        body.checkInstruction, body.targets, body.ruleId, body.studentsOnly, body.only,
    )


@router.post("/examples", status_code=201, dependencies=EDITOR)
def post_example(body: schemas.ExampleCreate):
    return _handle(catalog.create_example, body.ruleNodeId, body.text,
                   body.isViolation, body.exampleId)


@router.post("/check-targets", status_code=201, dependencies=EDITOR)
def post_check_target(body: schemas.CheckTargetCreate):
    return _handle(catalog.create_check_target, body.name, body.description, body.source)


@router.post("/departments", status_code=201, dependencies=EDITOR)
def post_department(body: schemas.DepartmentCreate):
    return _handle(catalog.create_department, body.departmentId, body.name)


# --------------------- выписка обязанностей в фоне ------------------------
#
# Выписка — до десятка последовательных вызовов модели, дольше таймаутов
# прокси. Поэтому узел создаётся сразу (202, dutiesStatus = pending), а
# обязанности выписывает ограниченный пул потоков; интерфейс опрашивает
# GET /catalog/job-descriptions/{id}, пока статус pending.

DUTIES_WORKERS = max(1, min(2, int(os.getenv("DUTIES_WORKERS", "1"))))
# Запись итога выписки повторяется при сбое Neo4j: попыток и пауза между ними (с).
FINISH_ATTEMPTS = 3
FINISH_RETRY_PAUSE = 2.0


class DaemonPool:
    """Очередь фоновых задач на daemon-потоках.

    ThreadPoolExecutor не годится: его потоки не daemon, и интерпретатор при
    остановке API ждёт идущую выписку (до десятка вызовов модели). Оборванная
    выписка остаётся pending и при следующем старте переводится в error.
    """

    def __init__(self, workers: int, name: str):
        self._queue: queue.Queue = queue.Queue()
        self._workers, self._name = workers, name
        self._threads: list[threading.Thread] = []
        self._lock = threading.Lock()
        self._closed = False

    def submit(self, fn, *args) -> None:
        with self._lock:
            if self._closed:
                raise RuntimeError("Фоновые задачи остановлены")
            # Потоки заводятся при первой задаче: импорт модуля их не плодит.
            while len(self._threads) < self._workers:
                thread = threading.Thread(target=self._loop, daemon=True,
                                          name=f"{self._name}-{len(self._threads)}")
                thread.start()
                self._threads.append(thread)
        self._queue.put((fn, args))

    def _loop(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                return
            fn, args = item
            try:
                fn(*args)
            except Exception:  # noqa: BLE001 — поток пула не должен умирать
                log.exception("Фоновая задача %s упала", getattr(fn, "__name__", fn))

    def shutdown(self) -> list[tuple]:
        """Отменяет ещё не начатые задачи (возвращает их аргументы), идущую не ждёт."""
        with self._lock:
            self._closed = True
            threads = list(self._threads)
        dropped = []
        while True:
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                break
            if item is not None:
                dropped.append(item[1])
        for _ in threads:
            self._queue.put(None)
        return dropped


_duties_pool = DaemonPool(DUTIES_WORKERS, "duties")
# Инструкции, чью выписку ведёт этот процесс (в очереди или идёт). pending
# вне этого набора — оборванная выписка: результат уже никто не запишет.
_duties_running: set[str] = set()
# Сколько запросов сейчас переводят инструкцию в pending и ещё не поставили
# выписку в очередь: в это окно pending «без задачи» — норма, а не обрыв.
_duties_starting = 0
_duties_lock = threading.Lock()


def _finish_duties(node_id: str, text: str, duties: Optional[list[str]] = None,
                   error: Optional[str] = None) -> None:
    """Записывает итог выписки; сбой Neo4j повторяется с паузой.

    Если записать так и не удалось, инструкция остаётся pending, но задачи
    у неё больше нет — опрос (GET) или повторный запуск переведут её в error.
    """
    for attempt in range(1, FINISH_ATTEMPTS + 1):
        try:
            if catalog.finish_duties(node_id, text, duties, error):
                # Обязанности участвуют в проверке целей — готовые ответы устарели.
                metrics.catalog_changed()
            return
        except Exception:  # noqa: BLE001 — фоновый поток: исключение иначе потеряется
            if attempt == FINISH_ATTEMPTS:
                log.exception("Итог выписки обязанностей для %s не сохранён", node_id)
                return
            log.warning("Итог выписки для %s не записан (попытка %d/%d), повтор",
                        node_id, attempt, FINISH_ATTEMPTS)
            time.sleep(FINISH_RETRY_PAUSE * attempt)


def _extract_duties_job(node_id: str, text: str) -> None:
    """Фоновая выписка. Сбой модели инструкцию не теряет: она остаётся без
    списка, проверка идёт по полному тексту, а причина — в dutiesError."""
    try:
        try:
            duties = agent.extract_duties(text)
        except agent.ExtractionError as exc:
            log.warning("Обязанности из инструкции %s не извлечены: %s", node_id, exc)
            _finish_duties(node_id, text, error=str(exc))
            return
        except Exception as exc:  # noqa: BLE001
            log.exception("Выписка обязанностей для %s упала", node_id)
            _finish_duties(node_id, text, error=f"Внутренняя ошибка при выписке: {type(exc).__name__}")
            return
        _finish_duties(node_id, text, duties=duties)
    finally:
        with _duties_lock:
            _duties_running.discard(node_id)


class _Starting:
    """Окно «инструкция уже pending, а выписка ещё не в очереди»."""

    def __enter__(self):
        global _duties_starting
        with _duties_lock:
            _duties_starting += 1

    def __exit__(self, *exc):
        global _duties_starting
        with _duties_lock:
            _duties_starting -= 1


def _start_duties(node: dict) -> dict:
    with _duties_lock:
        _duties_running.add(node["nodeId"])
    try:
        _duties_pool.submit(_extract_duties_job, node["nodeId"], node.get("text") or "")
    except Exception:
        with _duties_lock:
            _duties_running.discard(node["nodeId"])
        raise
    return node


def _close_orphaned_duties(node_id: str) -> bool:
    """pending без задачи в этом процессе переводит в error. Возвращает, перевёл ли.

    Так выписка, чей итог не записался (сбой Neo4j), не висит в pending до
    перезапуска API, и её можно запустить заново. API — один процесс
    (uvicorn без --workers), поэтому «чужих» идущих выписок не бывает.
    Запись — под замком: запрос, который в это время переводит инструкцию
    в pending (_Starting), дождётся её и не потеряет свою выписку.
    """
    with _duties_lock:
        if node_id in _duties_running or _duties_starting:
            return False
        return catalog.fail_orphaned_duties(node_id)


def shutdown_duties_pool() -> None:
    """Остановка API: очередь выписок отменяется, идущая не дожидается.

    Пул заменяется новым: приложение может снова пройти lifespan (тесты).
    """
    global _duties_pool
    if not isinstance(_duties_pool, DaemonPool):
        return  # подменён в тестах
    old, _duties_pool = _duties_pool, DaemonPool(DUTIES_WORKERS, "duties")
    for args in old.shutdown():
        with _duties_lock:
            _duties_running.discard(args[0])


def recover_duties_jobs() -> int:
    """Выписки, оставшиеся в pending после перезапуска, переводит в error.

    Вызывается из lifespan при старте API: потоки прежнего процесса уже не
    допишут результат, а интерфейс иначе ждал бы его вечно.
    """
    try:
        count = catalog.fail_pending_duties()
    except Exception as exc:  # noqa: BLE001 — Neo4j на старте может быть недоступен
        log.warning("Не удалось закрыть прерванные выписки обязанностей: %s", exc)
        return 0
    if count:
        log.warning("Прерванных перезапуском выписок обязанностей: %d", count)
    return count


@router.post("/job-descriptions", status_code=202, dependencies=EDITOR)
def post_job_description(body: schemas.JobDescriptionCreate):
    """Должностная инструкция подразделения: с ней сравнивается цель.

    Узел создаётся сразу, обязанности модель выписывает в фоне (dutiesStatus).
    """
    with _Starting():
        return _start_duties(_handle(catalog.create_job_description, body.departmentNodeId,
                                     body.title, body.text, body.jobDescriptionId))


@router.get("/job-descriptions/{node_id}")
def get_job_description(node_id: str):
    """Инструкция с обязанностями и состоянием выписки — для опроса, пока pending.

    pending, которую этот процесс не выписывает (итог не записался), отдаётся
    как error: интерфейс перестаёт ждать, выписку можно запустить заново.
    """
    node = _handle(catalog.get_job_description, node_id)
    if node.get("dutiesStatus") == catalog.DUTIES_PENDING and _close_orphaned_duties(node_id):
        node = _handle(catalog.get_job_description, node_id)
    return node


@router.put("/job-descriptions/{node_id}", dependencies=EDITOR)
def put_job_description(node_id: str, body: schemas.JobDescriptionUpdate, response: Response):
    """Правка должности и текста; при новом тексте обязанности выписываются заново (202)."""
    with _Starting():
        node, changed = _handle(catalog.update_job_description, node_id, body.title, body.text)
        if not changed:
            return node
        response.status_code = 202
        return _start_duties(node)


@router.post("/job-descriptions/{node_id}/extract-duties", status_code=202, dependencies=EDITOR)
def post_extract_duties(node_id: str):
    """Выписать обязанности из текста заново (например, после сбоя модели).

    Если выписка уже идёт — 409, второй раз она не запускается. pending без
    идущей задачи (итог не записался) считается прерванной, и выписка
    запускается заново без перезапуска API.
    """
    _close_orphaned_duties(node_id)
    with _Starting():
        return _start_duties(_handle(catalog.start_duties_extraction, node_id))


@router.put("/job-descriptions/{node_id}/duties", dependencies=EDITOR)
def put_job_duties(node_id: str, body: schemas.JobDuties):
    """Список обязанностей, проверенный и поправленный редактором."""
    return _handle(catalog.set_job_duties, node_id, body.duties, True)


# -------------------------------- связи -------------------------------------


@router.put("/rules/{node_id}/targets", dependencies=EDITOR)
def put_rule_targets(node_id: str, body: schemas.RuleTargets):
    return {"targets": _handle(catalog.set_rule_targets, node_id, body.targets)}


@router.put("/rules/{node_id}/departments", dependencies=EDITOR)
def put_rule_departments(node_id: str, body: schemas.RuleScope):
    """Область действия правила: в каких подразделениях оно действует."""
    return _handle(catalog.set_rule_scope, node_id, body.only)


@router.put("/rules/{node_id}/audience", dependencies=EDITOR)
def put_rule_audience(node_id: str, body: schemas.RuleAudience):
    """Для кого действует правило: для всех или только для студентов."""
    return _handle(catalog.set_rule_audience, node_id, body.studentsOnly)


@router.put("/clauses/{node_id}/references", dependencies=EDITOR)
def put_clause_references(node_id: str, body: schemas.ClauseReferences):
    return {"references": _handle(catalog.set_clause_references, node_id, body.references)}


@router.post("/clauses/{node_id}/move", dependencies=EDITOR)
def post_move_clause(node_id: str, body: schemas.MoveRequest):
    return _handle(catalog.move_clause, node_id, body.parentNodeId)


@router.post("/rules/{node_id}/move", dependencies=EDITOR)
def post_move_rule(node_id: str, body: schemas.MoveRequest):
    return _handle(catalog.move_rule, node_id, body.parentNodeId)


# ------------------------------- ремонт -------------------------------------


@router.post("/repair-identifiers", dependencies=ADMIN)
def post_repair_identifiers():
    """Проставляет недостающие orderId / clauseId / ruleId / exampleId и статусы."""
    return _handle(catalog.repair_identifiers)


@router.post("/merge-duplicate-targets", dependencies=ADMIN)
def post_merge_duplicate_targets():
    """Сводит атрибуты-двойники по написанию (naming.normalize_name) к одному узлу."""
    return _handle(catalog.merge_duplicate_targets)
