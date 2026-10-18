"""CRUD над каталогом нормативных требований.

Узлы адресуются по elementId(), а не по бизнес-ключам (orderId, clauseId...):
эти свойства могут отсутствовать у данных, заведённых до появления схемы,
и тогда интерфейс не может ни раскрыть карточку, ни отредактировать узел.
elementId есть у любого узла всегда.

Модель редактирования — мягкое удаление: узел получает status='archived',
выпадает из проверок (см. фильтры в graph.py), но остаётся в графе.
Физическое удаление разрешено только для уже архивированного узла.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional

from graph import ACTIVE, JOB_SOURCE, get_driver
from naming import normalize_name

log = logging.getLogger(__name__)

ACTIVE_STATUS = "active"
ARCHIVED_STATUS = "archived"
STATUSES = (ACTIVE_STATUS, ARCHIVED_STATUS)
RULE_TYPES = ("PROHIBITION", "REQUIREMENT")

# Метка -> бизнес-ключ. Ключ нужен выгрузке (export_graph.py строит по нему MERGE),
# поэтому его отсутствие — чинимая проблема, а не повод ломаться.
BUSINESS_KEYS = {
    "Order": "orderId",
    "Clause": "clauseId",
    "Rule": "ruleId",
    "CheckTarget": "name",
    "ViolationExample": "exampleId",
    "Department": "departmentId",
    "JobDescription": "jobDescriptionId",
}
# Чем определяется атрибут: по умолчанию — текстом цели, JOB_SOURCE —
# сравнением цели с должностными инструкциями подразделения.
TARGET_SOURCES = (JOB_SOURCE,)

# Свойства, которые нельзя менять через редактор произвольных свойств:
# для них есть отдельные операции с проверками.
GUARDED_PROPERTIES = {"status"}
# Текст инструкции и список обязанностей связаны: меняются своими операциями,
# чтобы список не разошёлся с текстом.
GUARDED_BY_LABEL = {"JobDescription": {"text", "duties", "dutiesReviewed"}}
MAX_DUTIES = 300


class CatalogError(RuntimeError):
    """Базовая ошибка каталога."""


class NotFound(CatalogError):
    """Узел не найден."""


class Conflict(CatalogError):
    """Операция противоречит текущему состоянию графа."""


# --------------------------------------------------------------------------
#  Вспомогательное
# --------------------------------------------------------------------------


def _run(query: str, **params) -> list[dict[str, Any]]:
    with get_driver().session() as session:
        return [dict(record) for record in session.run(query, **params)]


def _one(query: str, **params) -> Optional[dict[str, Any]]:
    rows = _run(query, **params)
    return rows[0] if rows else None


def slugify_id(value: str) -> str:
    """Превращает произвольную строку в безопасный идентификатор."""
    text = normalize_name(value)
    text = re.sub(r"[^0-9a-zа-я_.\-/]+", "", text)
    return text.strip("_") or "id"


def _require_status(status: str) -> str:
    if status not in STATUSES:
        raise Conflict(f"Недопустимый статус {status!r}, ожидался один из {STATUSES}")
    return status


def _validate_rule_type(rule_type: str) -> str:
    if rule_type not in RULE_TYPES:
        raise Conflict(f"Недопустимый тип правила {rule_type!r}, ожидался один из {RULE_TYPES}")
    return rule_type


def _serialize(value: Any) -> Any:
    """Приводит значения свойств к JSON-совместимому виду (даты Neo4j — к строке)."""
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (list, tuple)):
        return [_serialize(v) for v in value]
    return str(value)


def _props(raw: dict[str, Any]) -> dict[str, Any]:
    return {k: _serialize(v) for k, v in (raw or {}).items()}


def _fetch_node(node_id: str, label: str | None = None) -> dict[str, Any]:
    """Находит узел по elementId, при необходимости проверяя метку."""
    row = _one(
        """
        MATCH (n) WHERE elementId(n) = $node_id
        RETURN labels(n) AS labels, properties(n) AS props, elementId(n) AS nodeId
        """,
        node_id=node_id,
    )
    # Операции над «произвольным узлом» — только над узлами каталога: в той же
    # базе лежат пользователи (:User), и правка их свойств по elementId
    # означала бы выдачу себе любой роли в обход /auth/users.
    if not row or not any(l in BUSINESS_KEYS for l in row["labels"]):
        raise NotFound("Узел не найден — возможно, его удалили. Обновите страницу.")
    if label and label not in row["labels"]:
        raise Conflict(f"Ожидался узел :{label}, а это :{'/'.join(row['labels'])}")
    return {"nodeId": row["nodeId"], "labels": row["labels"], **_props(row["props"])}


def _status_of(props: dict[str, Any]) -> str:
    return props.get("status") or ACTIVE_STATUS


def _keep(props: dict[str, Any], include_archived: bool) -> bool:
    return include_archived or _status_of(props) == ACTIVE_STATUS


# --------------------------------------------------------------------------
#  Чтение: дерево каталога
# --------------------------------------------------------------------------

Q_ORDERS = "MATCH (o:Order) RETURN elementId(o) AS nodeId, properties(o) AS props"
Q_CLAUSES = """
MATCH (o:Order)-[:CONTAINS]->(c:Clause)
RETURN elementId(o) AS parent, elementId(c) AS nodeId, properties(c) AS props
"""
Q_RULES = """
MATCH (c:Clause)-[:DEFINES]->(r:Rule)
RETURN elementId(c) AS parent, elementId(r) AS nodeId, properties(r) AS props
"""
Q_RULE_TARGETS = """
MATCH (r:Rule)-[:APPLIES_TO]->(t:CheckTarget)
RETURN elementId(r) AS parent, t.name AS name
ORDER BY name
"""
Q_EXAMPLES = """
MATCH (r:Rule)-[:HAS_EXAMPLE]->(e:ViolationExample)
RETURN elementId(r) AS parent, elementId(e) AS nodeId, properties(e) AS props
"""
Q_CLAUSE_REFS = """
MATCH (a:Clause)-[:REFERENCES]->(b:Clause)
RETURN elementId(a) AS parent, elementId(b) AS nodeId,
       coalesce(b.code, b.clauseId, '?') AS code
"""
# Область действия правила по подразделениям: ONLY_IN — действует только в.
Q_RULE_DEPARTMENTS = """
MATCH (r:Rule)-[:ONLY_IN]->(d:Department)
RETURN elementId(r) AS parent, d.departmentId AS departmentId, d.name AS name
ORDER BY departmentId
"""
Q_DEPARTMENTS = "MATCH (d:Department) RETURN elementId(d) AS nodeId, properties(d) AS props"
Q_DEPARTMENT_LINKS = """
MATCH (r:Rule)-[:ONLY_IN]->(d:Department)
RETURN elementId(d) AS parent, coalesce(r.ruleId, '(без ruleId)') AS ruleId
ORDER BY ruleId
"""
# Текст инструкции в список не отдаётся — только его длина: он большой,
# а редактор читает его отдельно по nodeId.
Q_JOB_DESCRIPTIONS = """
MATCH (d:Department)-[:HAS_JOB_DESCRIPTION]->(j:JobDescription)
RETURN elementId(d) AS parent, elementId(j) AS nodeId,
       j.jobDescriptionId AS jobDescriptionId, coalesce(j.title, '') AS title,
       coalesce(j.status, 'active') AS status, size(coalesce(j.text, '')) AS chars,
       size(coalesce(j.duties, [])) AS duties, coalesce(j.dutiesReviewed, false) AS dutiesReviewed
ORDER BY title
"""
Q_CREATE_JOB_DESCRIPTION = """
MATCH (d:Department) WHERE elementId(d) = $department_node_id
CREATE (j:JobDescription {jobDescriptionId: $id, title: $title, text: $text, status: $status})
CREATE (d)-[:HAS_JOB_DESCRIPTION]->(j)
RETURN elementId(j) AS nodeId, properties(j) AS props
"""
Q_TARGETS = """
MATCH (t:CheckTarget)
OPTIONAL MATCH (r:Rule)-[:APPLIES_TO]->(t)
RETURN elementId(t) AS nodeId, properties(t) AS props, collect(DISTINCT r.ruleId) AS rules
"""


def _group(rows: list[dict], key: str = "parent") -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row[key], []).append(row)
    return grouped


def build_tree(include_archived: bool = False) -> dict[str, Any]:
    """Весь каталог одним ответом: приказы → пункты → правила → атрибуты и примеры.

    Каждый узел несёт nodeId (elementId) — по нему интерфейс раскрывает
    карточки и отправляет правки, независимо от того, заполнены ли
    бизнес-ключи в данных.
    """
    orders = _run(Q_ORDERS)
    clauses = _group(_run(Q_CLAUSES))
    rules = _group(_run(Q_RULES))
    rule_targets = _group(_run(Q_RULE_TARGETS))
    examples = _group(_run(Q_EXAMPLES))
    refs = _group(_run(Q_CLAUSE_REFS))
    rule_departments = _group(_run(Q_RULE_DEPARTMENTS))

    def build_rule(row: dict) -> dict:
        props = _props(row["props"])
        scope = rule_departments.get(row["nodeId"], [])
        return {
            **props,
            "nodeId": row["nodeId"],
            "status": _status_of(props),
            "targets": sorted(t["name"] for t in rule_targets.get(row["nodeId"], [])),
            "onlyIn": [
                {"departmentId": d["departmentId"], "name": d["name"]}
                for d in scope
            ],
            "examples": [
                {**_props(e["props"]), "nodeId": e["nodeId"], "status": _status_of(_props(e["props"]))}
                for e in examples.get(row["nodeId"], [])
                if _keep(_props(e["props"]), include_archived)
            ],
        }

    def build_clause(row: dict) -> dict:
        props = _props(row["props"])
        node_rules = [
            build_rule(r) for r in rules.get(row["nodeId"], [])
            if _keep(_props(r["props"]), include_archived)
        ]
        node_rules.sort(key=lambda r: str(r.get("ruleId") or ""))
        return {
            **props,
            "nodeId": row["nodeId"],
            "status": _status_of(props),
            "rules": node_rules,
            "references": [
                {"nodeId": r["nodeId"], "code": r["code"]} for r in refs.get(row["nodeId"], [])
            ],
        }

    tree = []
    for row in orders:
        props = _props(row["props"])
        if not _keep(props, include_archived):
            continue
        node_clauses = [
            build_clause(c) for c in clauses.get(row["nodeId"], [])
            if _keep(_props(c["props"]), include_archived)
        ]
        node_clauses.sort(key=lambda c: str(c.get("code") or ""))
        tree.append({
            **props,
            "nodeId": row["nodeId"],
            "status": _status_of(props),
            "clauses": node_clauses,
        })

    tree.sort(key=lambda o: str(o.get("number") or o.get("orderId") or ""))
    return {"orders": tree}


def list_check_targets(include_archived: bool = False) -> list[dict[str, Any]]:
    """Атрибуты со списком правил, которые на них ссылаются."""
    result = []
    for row in _run(Q_TARGETS):
        props = _props(row["props"])
        if not _keep(props, include_archived):
            continue
        result.append({
            **props,
            "nodeId": row["nodeId"],
            "description": props.get("description") or "",
            "status": _status_of(props),
            "rules": sorted(r for r in row["rules"] if r),
        })
    result.sort(key=lambda t: str(t.get("name") or ""))
    return result


def list_departments(include_archived: bool = False) -> list[dict[str, Any]]:
    """Подразделения: правила, чью область действия они задают, и должностные инструкции."""
    links = _group(_run(Q_DEPARTMENT_LINKS))
    jobs = _group(_run(Q_JOB_DESCRIPTIONS))
    result = []
    for row in _run(Q_DEPARTMENTS):
        props = _props(row["props"])
        if not _keep(props, include_archived):
            continue
        own = links.get(row["nodeId"], [])
        result.append({
            **props,
            "nodeId": row["nodeId"],
            "name": props.get("name") or "",
            "status": _status_of(props),
            "onlyRules": [l["ruleId"] for l in own],
            "jobDescriptions": [
                {k: j.get(k) for k in ("nodeId", "jobDescriptionId", "title", "status", "chars",
                                       "duties", "dutiesReviewed")}
                for j in jobs.get(row["nodeId"], []) if _keep(j, include_archived)
            ],
        })
    result.sort(key=lambda d: str(d.get("departmentId") or ""))
    return result


Q_GRAPH_NODES = """
MATCH (n) WHERE any(l IN labels(n) WHERE l IN $labels)
RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props
"""
Q_GRAPH_EDGES = """
MATCH (a)-[r]->(b)
WHERE any(l IN labels(a) WHERE l IN $labels) AND any(l IN labels(b) WHERE l IN $labels)
  AND type(r) <> 'EXCEPT_IN'
RETURN elementId(a) AS source, elementId(b) AS target, type(r) AS type, r.status AS status
"""
# Что показать на узле графа: (подпись, пояснение).
GRAPH_CAPTIONS = {
    "Order": ("number", "title"),
    "Clause": ("code", "text"),
    "Rule": ("ruleId", "description"),
    "CheckTarget": ("name", "description"),
    "ViolationExample": ("exampleId", "text"),
    "Department": ("name", "departmentId"),
    "JobDescription": ("title", "jobDescriptionId"),
}


def graph_view() -> dict[str, Any]:
    """Весь каталог как граф: узлы с подписью и связи между ними.

    Только метки каталога: пользователи и история проверок сюда не попадают.
    Тексты узлов обрезаются — полный текст открывается в соответствующем разделе.
    """
    labels = list(BUSINESS_KEYS)
    nodes = []
    for row in _run(Q_GRAPH_NODES, labels=labels):
        props = _props(row["props"])
        label = next(l for l in row["labels"] if l in BUSINESS_KEYS)
        title_key, detail_key = GRAPH_CAPTIONS[label]
        nodes.append({
            "id": row["id"], "label": label,
            "title": str(props.get(title_key) or props.get(BUSINESS_KEYS[label]) or "?"),
            "detail": str(props.get(detail_key) or "")[:300],
            "status": _status_of(props),
            **({"type": props["type"]} if label == "Rule" and props.get("type") else {}),
        })
    return {"nodes": nodes, "edges": _run(Q_GRAPH_EDGES, labels=labels)}


def list_clauses_flat() -> list[dict[str, Any]]:
    """Плоский список пунктов — для выбора цели перекрёстной ссылки."""
    rows = _run("""
        MATCH (o:Order)-[:CONTAINS]->(c:Clause)
        RETURN elementId(c) AS nodeId,
               coalesce(c.code, '?') AS code,
               coalesce(o.number, o.orderId, '?') AS order_number,
               coalesce(c.status, 'active') AS status
        ORDER BY order_number, code
    """)
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------
#  Универсальные операции над любым узлом
# --------------------------------------------------------------------------


def get_node(node_id: str) -> dict[str, Any]:
    return _fetch_node(node_id)


def set_status(node_id: str, status: str) -> dict[str, Any]:
    _require_status(status)
    node = _fetch_node(node_id)
    _run(
        "MATCH (n) WHERE elementId(n) = $node_id SET n.status = $status",
        node_id=node_id,
        status=status,
    )
    log.info("%s %s -> %s", node["labels"], node_id, status)
    return _fetch_node(node_id)


def update_properties(node_id: str, properties: dict[str, Any]) -> dict[str, Any]:
    """Пишет произвольные свойства узла. None удаляет свойство.

    Бизнес-ключ (orderId, ruleId...) проверяется на уникальность — иначе
    выгрузка в seed.cypher склеит два разных узла в один MERGE.
    """
    node = _fetch_node(node_id)
    label = next((l for l in node["labels"] if l in BUSINESS_KEYS), None)
    business_key = BUSINESS_KEYS.get(label or "")

    for name in properties:
        if name in GUARDED_PROPERTIES or name in GUARDED_BY_LABEL.get(label or "", ()):
            raise Conflict(
                f"Свойство {name!r} меняется отдельной операцией, а не редактором свойств"
            )

    if business_key and business_key in properties:
        value = properties[business_key]
        if value in (None, ""):
            raise Conflict(f"{business_key} — ключ узла, его нельзя очистить")
        clash = _one(
            f"MATCH (n:{label} {{{business_key}: $value}}) "
            "WHERE elementId(n) <> $node_id RETURN elementId(n) AS nodeId",
            value=value,
            node_id=node_id,
        )
        if clash:
            raise Conflict(f"{business_key} {value!r} уже занят другим узлом :{label}")

    # date хранится как временной тип, его нельзя передать через SET n += $map
    date_value = properties.pop("date", "__absent__") if label == "Order" else "__absent__"

    if properties:
        _run(
            "MATCH (n) WHERE elementId(n) = $node_id SET n += $props",
            node_id=node_id,
            props=properties,
        )
    if date_value != "__absent__":
        _run(
            """
            MATCH (n) WHERE elementId(n) = $node_id
            SET n.date = CASE WHEN $value IS NULL OR $value = '' THEN NULL ELSE date($value) END
            """,
            node_id=node_id,
            value=date_value,
        )
    return _fetch_node(node_id)


def _assert_archived(node: dict[str, Any], what: str) -> None:
    if _status_of(node) != ARCHIVED_STATUS:
        raise Conflict(f"Удалять можно только архивированный {what}. Сначала отправьте его в архив.")


def delete_node(node_id: str, cascade: bool = True, force: bool = False) -> dict[str, Any]:
    """Физическое удаление узла и того, что без него теряет смысл.

    По умолчанию требует, чтобы узел был архивирован: «удалить» не должно
    означать «потерять с первого клика». force=True снимает это требование —
    интерфейс использует его для явного пункта меню «Удалить навсегда»,
    который всегда подтверждается диалогом со списком того, что уйдёт.
    """
    node = _fetch_node(node_id)
    labels = node["labels"]

    if "ViolationExample" in labels:
        _run("MATCH (n) WHERE elementId(n) = $node_id DETACH DELETE n", node_id=node_id)
        return {"deleted": node_id, "examples": 1}

    if "CheckTarget" in labels:
        if not force:
            _assert_archived(node, "атрибут")
        used = _run(
            "MATCH (r:Rule)-[:APPLIES_TO]->(t) WHERE elementId(t) = $node_id "
            "RETURN r.ruleId AS rule_id",
            node_id=node_id,
        )
        rules = [r["rule_id"] for r in used if r["rule_id"]]
        if rules:
            raise Conflict(
                "Атрибут используется правилами: " + ", ".join(rules) + ". Сначала отвяжите его."
            )
        _run("MATCH (n) WHERE elementId(n) = $node_id DETACH DELETE n", node_id=node_id)
        return {"deleted": node_id}

    if "JobDescription" in labels:
        if not force:
            _assert_archived(node, "должностную инструкцию")
        _run("MATCH (n) WHERE elementId(n) = $node_id DETACH DELETE n", node_id=node_id)
        return {"deleted": node_id}

    if "Department" in labels:
        if not force:
            _assert_archived(node, "подразделение")
        # Без подразделения ограничение ONLY_IN исчезло бы вместе со связью,
        # и правило молча стало бы действовать для всех.
        used = _run(
            "MATCH (r:Rule)-[:ONLY_IN]->(d) WHERE elementId(d) = $node_id "
            "RETURN DISTINCT coalesce(r.ruleId, '(без ruleId)') AS rule_id",
            node_id=node_id,
        )
        if used:
            raise Conflict(
                "Подразделение задаёт область действия правил: "
                + ", ".join(r["rule_id"] for r in used)
                + ". Сначала уберите его из этих правил."
            )
        # Инструкции без подразделения сравнивать не с чем — уходят вместе с ним.
        _run(
            """
            MATCH (n) WHERE elementId(n) = $node_id
            OPTIONAL MATCH (n)-[:HAS_JOB_DESCRIPTION]->(j:JobDescription)
            DETACH DELETE j, n
            """,
            node_id=node_id,
        )
        return {"deleted": node_id}

    if not force:
        what = {"Order": "приказ", "Clause": "пункт", "Rule": "правило"}.get(labels[0], "узел")
        _assert_archived(node, what)

    if not cascade:
        _run("MATCH (n) WHERE elementId(n) = $node_id DETACH DELETE n", node_id=node_id)
        return {"deleted": node_id}

    stats = _one(
        """
        MATCH (n) WHERE elementId(n) = $node_id
        OPTIONAL MATCH (n)-[:CONTAINS|DEFINES|HAS_EXAMPLE*1..3]->(d)
        WITH n, collect(DISTINCT d) AS ds
        WITH n, ds,
             size([x IN ds WHERE x:Clause])           AS clauses,
             size([x IN ds WHERE x:Rule])             AS rules,
             size([x IN ds WHERE x:ViolationExample]) AS examples
        FOREACH (x IN ds | DETACH DELETE x)
        DETACH DELETE n
        RETURN clauses, rules, examples
        """,
        node_id=node_id,
    )
    log.warning("Удалён узел %s (%s): %s", node_id, labels, stats)
    return {"deleted": node_id, **(stats or {})}


def count_descendants(node_id: str) -> dict[str, int]:
    """Что уйдёт вместе с узлом — для честного диалога подтверждения.

    Один проход по нисходящим связям вместо набора OPTIONAL MATCH:
    так запрос остаётся в одной области видимости и его нечем сломать.
    """
    row = _one(
        """
        MATCH (n) WHERE elementId(n) = $node_id
        OPTIONAL MATCH (n)-[:CONTAINS|DEFINES|HAS_EXAMPLE*1..3]->(d)
        WITH collect(DISTINCT d) AS ds
        RETURN size([x IN ds WHERE x:Clause])           AS clauses,
               size([x IN ds WHERE x:Rule])             AS rules,
               size([x IN ds WHERE x:ViolationExample]) AS examples
        """,
        node_id=node_id,
    )
    return row or {"clauses": 0, "rules": 0, "examples": 0}


# --------------------------------------------------------------------------
#  Создание
# --------------------------------------------------------------------------


def create_order(number: str, title: str, date: str | None = None,
                 order_id: str | None = None) -> dict[str, Any]:
    order_id = order_id or slugify_id(number)
    if _one("MATCH (o:Order {orderId: $id}) RETURN o.orderId AS id", id=order_id):
        raise Conflict(f"Приказ с идентификатором {order_id!r} уже существует")

    row = _one(
        """
        CREATE (o:Order {orderId: $id, number: $number, title: $title, status: $status})
        SET o.date = CASE WHEN $date IS NULL OR $date = '' THEN NULL ELSE date($date) END
        RETURN elementId(o) AS nodeId, properties(o) AS props
        """,
        id=order_id, number=number, title=title, date=date, status=ACTIVE_STATUS,
    )
    log.info("Создан приказ %s (%s)", order_id, number)
    return {"nodeId": row["nodeId"], **_props(row["props"])}


def create_clause(order_node_id: str, code: str, text: str,
                  clause_id: str | None = None) -> dict[str, Any]:
    order = _fetch_node(order_node_id, "Order")
    clause_id = clause_id or f"{order.get('orderId') or slugify_id(order.get('number', 'order'))}/{slugify_id(code)}"
    if _one("MATCH (c:Clause {clauseId: $id}) RETURN c.clauseId AS id", id=clause_id):
        raise Conflict(f"Пункт с идентификатором {clause_id!r} уже существует")

    row = _one(
        """
        MATCH (o:Order) WHERE elementId(o) = $order_node_id
        CREATE (c:Clause {clauseId: $id, code: $code, text: $text, status: $status})
        CREATE (o)-[:CONTAINS]->(c)
        RETURN elementId(c) AS nodeId, properties(c) AS props
        """,
        order_node_id=order_node_id, id=clause_id, code=code, text=text, status=ACTIVE_STATUS,
    )
    log.info("Создан пункт %s", clause_id)
    return {"nodeId": row["nodeId"], **_props(row["props"])}


def create_rule(clause_node_id: str, rule_type: str, description: str,
                check_instruction: str = "", targets: list[str] | None = None,
                rule_id: str | None = None) -> dict[str, Any]:
    clause = _fetch_node(clause_node_id, "Clause")
    _validate_rule_type(rule_type)

    rule_id = rule_id or f"R-{slugify_id(clause.get('code') or 'rule')}"
    base, suffix = rule_id, 1
    while _one("MATCH (r:Rule {ruleId: $id}) RETURN r.ruleId AS id", id=rule_id):
        suffix += 1
        rule_id = f"{base}.{suffix}"

    row = _one(
        """
        MATCH (c:Clause) WHERE elementId(c) = $clause_node_id
        CREATE (r:Rule {ruleId: $id, type: $type, description: $description,
                        checkInstruction: $instruction, status: $status})
        CREATE (c)-[:DEFINES]->(r)
        RETURN elementId(r) AS nodeId, properties(r) AS props
        """,
        clause_node_id=clause_node_id, id=rule_id, type=rule_type,
        description=description, instruction=check_instruction, status=ACTIVE_STATUS,
    )
    if targets:
        set_rule_targets(row["nodeId"], targets)
    log.info("Создано правило %s (%s)", rule_id, rule_type)
    return {"nodeId": row["nodeId"], **_props(row["props"])}


def create_example(rule_node_id: str, text: str, is_violation: bool,
                   example_id: str | None = None) -> dict[str, Any]:
    rule = _fetch_node(rule_node_id, "Rule")
    if not example_id:
        used = _run(
            "MATCH (r)-[:HAS_EXAMPLE]->(e) WHERE elementId(r) = $id RETURN e.exampleId AS id",
            id=rule_node_id,
        )
        base = rule.get("ruleId") or "EX"
        example_id = f"{base}-EX{len(used) + 1}"
        while _one("MATCH (e:ViolationExample {exampleId: $id}) RETURN e.exampleId AS id",
                   id=example_id):
            example_id += "x"

    row = _one(
        """
        MATCH (r:Rule) WHERE elementId(r) = $rule_node_id
        CREATE (e:ViolationExample {exampleId: $id, text: $text,
                                    isViolation: $is_violation, status: $status})
        CREATE (r)-[:HAS_EXAMPLE]->(e)
        RETURN elementId(e) AS nodeId, properties(e) AS props
        """,
        rule_node_id=rule_node_id, id=example_id, text=text,
        is_violation=is_violation, status=ACTIVE_STATUS,
    )
    return {"nodeId": row["nodeId"], **_props(row["props"])}


def create_check_target(name: str, description: str = "",
                        source: str | None = None) -> dict[str, Any]:
    """Заводит атрибут, не давая создать двойника по написанию.

    source = JOB_SOURCE — атрибут определяется сравнением цели с должностными
    инструкциями подразделения, а description служит критерием сравнения.
    """
    if source and source not in TARGET_SOURCES:
        raise Conflict(f"Недопустимый источник атрибута {source!r}, ожидался один из {TARGET_SOURCES}")
    normalized = normalize_name(name)
    for existing in _run("MATCH (t:CheckTarget) RETURN t.name AS name"):
        if existing["name"] and normalize_name(existing["name"]) == normalized:
            raise Conflict(
                f'Атрибут с таким написанием уже есть: "{existing["name"]}". '
                "Двойники ломают проверку — используйте существующий."
            )
    row = _one(
        """
        CREATE (t:CheckTarget {name: $name, description: $description, status: $status})
        SET t.source = $source
        RETURN elementId(t) AS nodeId, properties(t) AS props
        """,
        name=name, description=description, status=ACTIVE_STATUS, source=source or None,
    )
    log.info("Создан атрибут %s", name)
    return {"nodeId": row["nodeId"], **_props(row["props"])}


def create_department(department_id: str, name: str) -> dict[str, Any]:
    """Заводит подразделение. Идентификатор — тот, что придёт в запросе проверки."""
    department_id = department_id.strip()
    if _one("MATCH (d:Department {departmentId: $id}) RETURN d.departmentId AS id",
            id=department_id):
        raise Conflict(f"Подразделение с идентификатором {department_id!r} уже существует")
    row = _one(
        """
        CREATE (d:Department {departmentId: $id, name: $name, status: $status})
        RETURN elementId(d) AS nodeId, properties(d) AS props
        """,
        id=department_id, name=name.strip(), status=ACTIVE_STATUS,
    )
    log.info("Создано подразделение %s", department_id)
    return {"nodeId": row["nodeId"], **_props(row["props"])}


def create_job_description(department_node_id: str, title: str, text: str,
                           job_description_id: str | None = None) -> dict[str, Any]:
    """Загружает должностную инструкцию в подразделение.

    С её текстом сравнивается цель, когда в подразделении действует правило
    на атрибуте с source = JOB_SOURCE.
    """
    department = _fetch_node(department_node_id, "Department")
    title, text = title.strip(), text.strip()
    taken = "MATCH (j:JobDescription {jobDescriptionId: $id}) RETURN j.jobDescriptionId AS id"
    if job_description_id:
        if _one(taken, id=job_description_id):
            raise Conflict(f"Должностная инструкция с идентификатором {job_description_id!r} уже существует")
    else:
        base = (f"{department.get('departmentId') or slugify_id(department.get('name') or 'dep')}"
                f"/{slugify_id(title)}")
        job_description_id, suffix = base, 1
        while _one(taken, id=job_description_id):
            suffix += 1
            job_description_id = f"{base}.{suffix}"

    row = _one(
        Q_CREATE_JOB_DESCRIPTION,
        department_node_id=department_node_id, id=job_description_id,
        title=title, text=text, status=ACTIVE_STATUS,
    )
    log.info("Загружена должностная инструкция %s (%d символов)", job_description_id, len(text))
    return {"nodeId": row["nodeId"], **_props(row["props"])}


def update_job_description(node_id: str, title: str, text: str) -> tuple[dict[str, Any], bool]:
    """Правит должность и текст инструкции. Возвращает (узел, изменился ли текст).

    С новым текстом прежний список обязанностей уже не сверен — он
    сбрасывается; вызывающий извлекает его заново.
    """
    node = _fetch_node(node_id, "JobDescription")
    title, text = title.strip(), text.strip()
    changed = text != (node.get("text") or "").strip()
    _run(
        """
        MATCH (j) WHERE elementId(j) = $node_id
        SET j.title = $title, j.text = $text,
            j.duties = CASE WHEN $changed THEN [] ELSE j.duties END,
            j.dutiesReviewed = CASE WHEN $changed THEN false ELSE j.dutiesReviewed END
        """,
        node_id=node_id, title=title, text=text, changed=changed,
    )
    return _fetch_node(node_id), changed


def set_job_duties(node_id: str, duties: list[str], reviewed: bool) -> dict[str, Any]:
    """Сохраняет список обязанностей — с ним сравнивается цель.

    reviewed = False — список выписала модель и редактор его ещё не смотрел.
    """
    _fetch_node(node_id, "JobDescription")
    cleaned: list[str] = []
    for item in duties:
        duty = " ".join(str(item).split())
        if duty and duty not in cleaned:
            cleaned.append(duty)
    if len(cleaned) > MAX_DUTIES:
        raise Conflict(f"Слишком длинный список обязанностей: {len(cleaned)}, допустимо {MAX_DUTIES}")
    _run(
        "MATCH (j) WHERE elementId(j) = $node_id SET j.duties = $duties, j.dutiesReviewed = $reviewed",
        node_id=node_id, duties=cleaned, reviewed=reviewed,
    )
    log.info("Инструкция %s: обязанностей %d, проверено редактором: %s", node_id, len(cleaned), reviewed)
    return _fetch_node(node_id)


# --------------------------------------------------------------------------
#  Связи
# --------------------------------------------------------------------------


def set_rule_targets(rule_node_id: str, targets: list[str]) -> list[str]:
    """Полностью заменяет набор атрибутов правила."""
    _fetch_node(rule_node_id, "Rule")
    known = {t["name"] for t in _run("MATCH (t:CheckTarget) RETURN t.name AS name")}
    unknown = [t for t in targets if t not in known]
    if unknown:
        raise NotFound("Нет таких атрибутов: " + ", ".join(unknown))

    _run("MATCH (r)-[rel:APPLIES_TO]->() WHERE elementId(r) = $id DELETE rel", id=rule_node_id)
    if targets:
        _run(
            """
            MATCH (r:Rule) WHERE elementId(r) = $id
            UNWIND $targets AS name
            MATCH (t:CheckTarget {name: name})
            MERGE (r)-[:APPLIES_TO]->(t)
            """,
            id=rule_node_id, targets=targets,
        )
    log.info("Правило %s теперь применяется к %s", rule_node_id, targets)
    return targets


def set_rule_scope(rule_node_id: str, only: list[str]) -> dict[str, Any]:
    """Полностью заменяет область действия правила по подразделениям.

    only — departmentId, в которых правило действует; пусто — для всех.
    """
    _fetch_node(rule_node_id, "Rule")
    known = {d["id"] for d in _run("MATCH (d:Department) RETURN d.departmentId AS id")}

    unknown = sorted({d for d in only if d not in known})
    if unknown:
        raise NotFound("Нет таких подразделений: " + ", ".join(unknown))
    repeated = sorted({d for d in only if only.count(d) > 1})
    if repeated:
        raise Conflict("Подразделение указано дважды: " + ", ".join(repeated))

    _run("MATCH (r)-[rel:ONLY_IN]->() WHERE elementId(r) = $id DELETE rel", id=rule_node_id)
    if only:
        _run(
            """
            MATCH (r:Rule) WHERE elementId(r) = $id
            UNWIND $only AS dep
            MATCH (d:Department {departmentId: dep})
            MERGE (r)-[:ONLY_IN]->(d)
            """,
            id=rule_node_id, only=only,
        )
    log.info("Правило %s: только в %s", rule_node_id, only)
    return {"only": only}


def set_clause_references(clause_node_id: str, target_node_ids: list[str]) -> list[str]:
    """Перекрёстные ссылки между пунктами: (:Clause)-[:REFERENCES]->(:Clause)."""
    _fetch_node(clause_node_id, "Clause")
    if clause_node_id in target_node_ids:
        raise Conflict("Пункт не может ссылаться сам на себя")
    for target in target_node_ids:
        _fetch_node(target, "Clause")

    _run("MATCH (c)-[rel:REFERENCES]->() WHERE elementId(c) = $id DELETE rel", id=clause_node_id)
    if target_node_ids:
        _run(
            """
            MATCH (a:Clause) WHERE elementId(a) = $id
            UNWIND $targets AS target
            MATCH (b:Clause) WHERE elementId(b) = target
            MERGE (a)-[:REFERENCES]->(b)
            """,
            id=clause_node_id, targets=target_node_ids,
        )
    return target_node_ids


def move_clause(clause_node_id: str, order_node_id: str) -> dict[str, Any]:
    """Переносит пункт в другой приказ."""
    _fetch_node(clause_node_id, "Clause")
    _fetch_node(order_node_id, "Order")
    _run("MATCH (:Order)-[rel:CONTAINS]->(c) WHERE elementId(c) = $id DELETE rel",
         id=clause_node_id)
    _run(
        """
        MATCH (o:Order) WHERE elementId(o) = $order_node_id
        MATCH (c:Clause) WHERE elementId(c) = $clause_node_id
        MERGE (o)-[:CONTAINS]->(c)
        """,
        order_node_id=order_node_id, clause_node_id=clause_node_id,
    )
    return _fetch_node(clause_node_id)


def move_rule(rule_node_id: str, clause_node_id: str) -> dict[str, Any]:
    """Переносит правило в другой пункт."""
    _fetch_node(rule_node_id, "Rule")
    _fetch_node(clause_node_id, "Clause")
    _run("MATCH (:Clause)-[rel:DEFINES]->(r) WHERE elementId(r) = $id DELETE rel",
         id=rule_node_id)
    _run(
        """
        MATCH (c:Clause) WHERE elementId(c) = $clause_node_id
        MATCH (r:Rule) WHERE elementId(r) = $rule_node_id
        MERGE (c)-[:DEFINES]->(r)
        """,
        clause_node_id=clause_node_id, rule_node_id=rule_node_id,
    )
    return _fetch_node(rule_node_id)


# --------------------------------------------------------------------------
#  Ремонт данных
# --------------------------------------------------------------------------


def repair_identifiers() -> dict[str, Any]:
    """Проставляет недостающие бизнес-ключи и статусы.

    Без orderId/clauseId выгрузка в seed.cypher невозможна: MERGE строится
    именно по этим ключам.
    """
    report: dict[str, int] = {}

    report["orders"] = len(_run("""
        MATCH (o:Order) WHERE o.orderId IS NULL OR trim(toString(o.orderId)) = ''
        WITH o, coalesce(o.number, o.title, 'order') AS base
        SET o.orderId = 'ORD-' + replace(toLower(trim(base)), ' ', '_') + '-' + elementId(o)
        RETURN elementId(o) AS id
    """))

    report["clauses"] = len(_run("""
        MATCH (o:Order)-[:CONTAINS]->(c:Clause)
        WHERE c.clauseId IS NULL OR trim(toString(c.clauseId)) = ''
        SET c.clauseId = coalesce(o.orderId, 'ORD') + '/' + coalesce(c.code, elementId(c))
        RETURN elementId(c) AS id
    """))

    report["rules"] = len(_run("""
        MATCH (r:Rule) WHERE r.ruleId IS NULL OR trim(toString(r.ruleId)) = ''
        SET r.ruleId = 'R-' + elementId(r)
        RETURN elementId(r) AS id
    """))

    report["examples"] = len(_run("""
        MATCH (e:ViolationExample) WHERE e.exampleId IS NULL OR trim(toString(e.exampleId)) = ''
        SET e.exampleId = 'EX-' + elementId(e)
        RETURN elementId(e) AS id
    """))

    report["statuses"] = len(_run("""
        MATCH (n) WHERE (n:Order OR n:Clause OR n:Rule OR n:CheckTarget OR n:ViolationExample
                         OR n:Department OR n:JobDescription)
          AND n.status IS NULL
        SET n.status = 'active'
        RETURN elementId(n) AS id
    """))

    log.warning("Ремонт идентификаторов: %s", report)
    return report
