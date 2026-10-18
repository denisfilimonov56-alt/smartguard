"""HTTP-маршруты каталога нормативных требований.

Узлы адресуются по nodeId (elementId Neo4j): он есть всегда, в отличие от
бизнес-ключей, которых может не быть у ранее заведённых данных.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request

import agent
import auth
import catalog
import diagnostics
import metrics
import schemas

log = logging.getLogger(__name__)

# Читать каталог может любой вошедший пользователь; менять — редактор;
# необратимое (физическое удаление, массовый ремонт) — только администратор.
def _catalog_changed(request: Request):
    """После любой правки каталога готовые ответы проверок устаревают."""
    yield
    if request.method != "GET":
        metrics.catalog_changed()


router = APIRouter(prefix="/catalog", tags=["catalog"],
                   dependencies=[Depends(auth.viewer), Depends(_catalog_changed)])
EDITOR = [Depends(auth.editor)]
ADMIN = [Depends(auth.admin)]


def _handle(func, *args, **kwargs):
    """Переводит ошибки каталога в осмысленные коды ответа."""
    try:
        return func(*args, **kwargs)
    except catalog.NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except catalog.Conflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


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
        body.checkInstruction, body.targets, body.ruleId,
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


@router.post("/job-descriptions", status_code=201, dependencies=EDITOR)
def post_job_description(body: schemas.JobDescriptionCreate):
    """Должностная инструкция подразделения: с ней сравнивается цель.

    Сразу после загрузки модель выписывает из текста список обязанностей.
    """
    return _extract_duties(_handle(catalog.create_job_description, body.departmentNodeId,
                                   body.title, body.text, body.jobDescriptionId))


def _extract_duties(node: dict) -> dict:
    """Выписывает обязанности из текста инструкции и сохраняет их непроверенными.

    Сбой модели инструкцию не теряет: она остаётся без списка, проверка идёт
    по полному тексту, а причина возвращается в dutiesError.
    """
    try:
        duties = agent.extract_duties(node.get("text") or "")
    except agent.ExtractionError as exc:
        log.warning("Обязанности из инструкции %s не извлечены: %s", node["nodeId"], exc)
        return {**node, "dutiesError": str(exc)}
    return {**_handle(catalog.set_job_duties, node["nodeId"], duties, False), "dutiesError": None}


@router.put("/job-descriptions/{node_id}", dependencies=EDITOR)
def put_job_description(node_id: str, body: schemas.JobDescriptionUpdate):
    """Правка должности и текста; при новом тексте обязанности выписываются заново."""
    node, changed = _handle(catalog.update_job_description, node_id, body.title, body.text)
    return _extract_duties(node) if changed else {**node, "dutiesError": None}


@router.post("/job-descriptions/{node_id}/extract-duties", dependencies=EDITOR)
def post_extract_duties(node_id: str):
    """Выписать обязанности из текста заново (например, после сбоя модели)."""
    node = _handle(catalog.get_node, node_id)
    if "JobDescription" not in node["labels"]:
        raise HTTPException(status_code=409, detail="Это не должностная инструкция")
    return _extract_duties(node)


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
