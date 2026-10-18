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

import datetime
import logging
import math
import re
from typing import Any, Callable, Optional

from graph import ACTIVE, JOB_SOURCE, get_driver
from naming import normalize_name

log = logging.getLogger(__name__)

ACTIVE_STATUS = "active"
ARCHIVED_STATUS = "archived"
STATUSES = (ACTIVE_STATUS, ARCHIVED_STATUS)
RULE_TYPES = ("PROHIBITION", "REQUIREMENT")

# Состояние выписки обязанностей из должностной инструкции (идёт в фоне API).
DUTIES_PENDING, DUTIES_READY, DUTIES_ERROR = "pending", "ready", "error"
DUTIES_INTERRUPTED = "Выписка прервана перезапуском, запустите заново"

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
# чтобы список не разошёлся с текстом. Состояние выписки ведёт сам API.
GUARDED_BY_LABEL = {"JobDescription": {"text", "duties", "dutiesReviewed", "dutiesStatus", "dutiesError"}}
# Служебные поля ответа: свойство с таким именем затенило бы их в _fetch_node.
# _lock — служебная метка блокировки записи (_lock), её не пишут и не удаляют.
RESERVED_PROPERTIES = {"nodeId", "labels", "_lock"}
# Имя свойства попадает в текст Cypher выгрузки (export_graph.py), поэтому
# допускаются только буквы, цифры и подчёркивание, первой — не цифра.
# Имена с «_» в начале зарезервированы под служебные свойства.
PROPERTY_NAME = re.compile(r"[^\W\d_]\w{0,63}")
MAX_DUTIES = 300
INT64 = (-2 ** 63, 2 ** 63 - 1)


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


Runner = Callable[..., list[dict[str, Any]]]


def _write(work: Callable[[Runner], Any]) -> Any:
    """Выполняет work(run) одной транзакцией записи.

    Проверки и запись идут в одной транзакции: исключение (NotFound, Conflict,
    сбой Neo4j посреди замены связей) откатывает всё, и граф не остаётся в
    промежуточном состоянии. Временные сбои драйвер повторяет сам.
    """
    def tx_fn(tx):
        def run(query: str, **params) -> list[dict[str, Any]]:
            return [dict(record) for record in tx.run(query, **params)]
        return work(run)

    with get_driver().session() as session:
        return session.execute_write(tx_fn)


def _lock(run: Runner, node_id: str) -> None:
    """Берёт блокировку записи на узел до чтения его связей.

    Без неё два одновременных «заменить набор связей» читают старый набор
    до фиксации друг друга, и у правила остаётся объединение обоих наборов.
    """
    run("MATCH (n) WHERE elementId(n) = $node_id SET n._lock = true REMOVE n._lock",
        node_id=node_id)


# Замок на понятие, а не на узел (служебный :CatalogLock, единственный на id —
# ограничение уникальности в seed.cypher; в выгрузку не попадает).
Q_KEY_LOCK = "MERGE (l:CatalogLock {id: $key}) SET l._lock = true REMOVE l._lock"


def _lock_key(run: Runner, key: str) -> None:
    """Сериализует транзакции, которые проверяют «занято ли» и затем пишут.

    Два одновременных «срок исполнения» / «срок_исполнения» или два правила
    с одним автоматическим ruleId иначе оба проходят проверку до фиксации
    друг друга: двойник атрибута или 409 вместо свободного суффикса. Под
    замком вторая транзакция ждёт первую и видит её запись.
    """
    run(Q_KEY_LOCK, key=key)


def _first(rows: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
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


Q_FETCH_NODE = """
        MATCH (n) WHERE elementId(n) = $node_id
        RETURN labels(n) AS labels, properties(n) AS props, elementId(n) AS nodeId
        """


def _fetch_node(node_id: str, label: str | None = None, run: Runner | None = None) -> dict[str, Any]:
    """Находит узел по elementId, при необходимости проверяя метку.

    run — исполнитель внутри транзакции _write; без него — отдельный запрос.
    """
    row = _first((run or _run)(Q_FETCH_NODE, node_id=node_id))
    # Операции над «произвольным узлом» — только над узлами каталога: в той же
    # базе лежат пользователи (:User), и правка их свойств по elementId
    # означала бы выдачу себе любой роли в обход /auth/users.
    if not row or not any(l in BUSINESS_KEYS for l in row["labels"]):
        raise NotFound("Узел не найден — возможно, его удалили. Обновите страницу.")
    if label and label not in row["labels"]:
        raise Conflict(f"Ожидался узел :{label}, а это :{'/'.join(row['labels'])}")
    # Служебные поля — после свойств: свойство «nodeId» их не затенит.
    return {**_props(row["props"]), "nodeId": row["nodeId"], "labels": row["labels"]}


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
       size(coalesce(j.duties, [])) AS duties, coalesce(j.dutiesReviewed, false) AS dutiesReviewed,
       coalesce(j.dutiesStatus, 'ready') AS dutiesStatus
ORDER BY title
"""
Q_CREATE_JOB_DESCRIPTION = """
MATCH (d:Department) WHERE elementId(d) = $department_node_id
CREATE (j:JobDescription {jobDescriptionId: $id, title: $title, text: $text, status: $status,
                          dutiesStatus: 'pending'})
CREATE (d)-[:HAS_JOB_DESCRIPTION]->(j)
RETURN elementId(j) AS nodeId, properties(j) AS props
"""
Q_TARGETS = """
MATCH (t:CheckTarget)
OPTIONAL MATCH (r:Rule)-[:APPLIES_TO]->(t)
// Правило без ruleId — тоже ссылка: иначе атрибут выглядел бы свободным.
RETURN elementId(t) AS nodeId, properties(t) AS props,
       collect(DISTINCT CASE WHEN r IS NULL THEN NULL ELSE coalesce(r.ruleId, '(без ruleId)') END) AS rules
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
            # Нормализуется до булева: у правил, заведённых раньше, свойства нет.
            "studentsOnly": bool(props.get("studentsOnly")),
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
                                       "duties", "dutiesReviewed", "dutiesStatus")}
                for j in jobs.get(row["nodeId"], []) if _keep(j, include_archived)
            ],
        })
    result.sort(key=lambda d: str(d.get("departmentId") or ""))
    return result


# Выражение меток вместо обхода всех узлов: история проверок и оценки SMART
# лежат в той же базе и с годами многократно превосходят каталог.
CATALOG_LABELS = "|".join(BUSINESS_KEYS)
Q_GRAPH_NODES = f"""
MATCH (n:{CATALOG_LABELS})
RETURN elementId(n) AS id, [l IN labels(n) WHERE l IN $labels] AS labels, properties(n) AS props
"""
Q_GRAPH_EDGES = f"""
MATCH (a:{CATALOG_LABELS})-[r]->(b:{CATALOG_LABELS})
WHERE type(r) <> 'EXCEPT_IN'
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


def _scalar_kind(name: str, value: Any) -> type:
    """Тип скалярного значения свойства; иное — Conflict, а не 500 от Neo4j."""
    if isinstance(value, bool):
        return bool
    if isinstance(value, int):
        if not INT64[0] <= value <= INT64[1]:
            raise Conflict(f"Свойство {name!r}: число вне допустимого диапазона")
        return int
    if isinstance(value, float):
        # NaN и бесконечность JSON пропускает, а в Cypher у них нет литерала.
        if not math.isfinite(value):
            raise Conflict(f"Свойство {name!r}: недопустимое число {value!r}")
        return float
    if isinstance(value, str):
        return str
    raise Conflict(
        f"Свойство {name!r}: значение должно быть строкой, числом, true/false или списком из них"
    )


def _check_value(name: str, value: Any) -> None:
    """Значение — скаляр или однородный список скаляров (так хранит Neo4j)."""
    if value is None:
        return
    if isinstance(value, list):
        kinds = {_scalar_kind(name, item) for item in value}
        if len(kinds) > 1:
            raise Conflict(f"Свойство {name!r}: в списке значения разных типов")
        return
    _scalar_kind(name, value)


def _controlled_value(label: str, name: str, value: Any) -> Any:
    """Проверяет свойства, от которых зависит проверка целей, и приводит их к типу.

    Неверное значение такого свойства не ломает запись, а молча выключает
    правило (type = 'Prohibition') или роняет каждую проверку
    (studentsOnly = 'true' в NOT coalesce(...)), поэтому оно отклоняется сразу.
    """
    if label == "Rule" and name == "type":
        return _validate_rule_type(value)
    if (label, name) in (("Rule", "studentsOnly"), ("ViolationExample", "isViolation")):
        if value is None and name == "studentsOnly":
            return None
        if not isinstance(value, bool):
            raise Conflict(f"Свойство {name!r} — логическое: true или false")
        return value
    if label == "CheckTarget" and name == "source":
        if value in (None, ""):
            return None
        if value not in TARGET_SOURCES:
            raise Conflict(f"Недопустимый источник атрибута {value!r}, ожидался один из {TARGET_SOURCES}")
        return value
    if label == "Order" and name == "date":
        if value in (None, ""):
            return None
        # date хранится временным типом: драйвер передаёт datetime.date как Date.
        try:
            return datetime.date.fromisoformat(str(value))
        except ValueError:
            raise Conflict(f"Дата {value!r} не в формате ГГГГ-ММ-ДД") from None
    return value


def _assert_no_twin(run: Runner, name: str, exclude_node_id: str | None = None) -> None:
    """Не даёт завести второй атрибут, отличающийся только написанием."""
    normalized = normalize_name(name)
    for existing in run("MATCH (t:CheckTarget) RETURN t.name AS name, elementId(t) AS nodeId"):
        if existing["nodeId"] == exclude_node_id or not existing["name"]:
            continue
        if normalize_name(existing["name"]) == normalized:
            raise Conflict(
                f'Атрибут с таким написанием уже есть: "{existing["name"]}". '
                "Двойники ломают проверку — используйте существующий."
            )


def update_properties(node_id: str, properties: dict[str, Any]) -> dict[str, Any]:
    """Пишет произвольные свойства узла. None удаляет свойство.

    Имена свойств ограничены буквами, цифрами и подчёркиванием: они попадают в
    текст выгрузки seed (export_graph.py). Управляющие свойства (Rule.type,
    studentsOnly, isViolation, source, Order.date) проверяются по смыслу.
    Бизнес-ключ (orderId, ruleId...) проверяется на уникальность — иначе
    выгрузка склеит два разных узла в один MERGE. Всё пишется одним запросом.
    """
    def work(run: Runner) -> None:
        # Копия на каждую попытку: драйвер может повторить транзакцию.
        props = dict(properties)
        node = _fetch_node(node_id, run=run)
        label = next((l for l in node["labels"] if l in BUSINESS_KEYS), None)
        business_key = BUSINESS_KEYS.get(label or "")

        for name in props:
            if not isinstance(name, str):
                raise Conflict(f"Недопустимое имя свойства {name!r}")
            # Удаление (null) старого свойства с «неудобным» именем разрешено:
            # имя уходит параметром, а не в текст запроса, — иначе такое
            # свойство нельзя было бы убрать из интерфейса.
            if props[name] is not None and not PROPERTY_NAME.fullmatch(name):
                raise Conflict(
                    f"Недопустимое имя свойства {name!r}: только буквы, цифры и подчёркивание, "
                    "первой — буква, до 64 символов"
                )
            if name in RESERVED_PROPERTIES:
                raise Conflict(f"Имя {name!r} занято служебным полем")
            if name in GUARDED_PROPERTIES or name in GUARDED_BY_LABEL.get(label or "", ()):
                raise Conflict(
                    f"Свойство {name!r} меняется отдельной операцией, а не редактором свойств"
                )
            _check_value(name, props[name])
            props[name] = _controlled_value(label or "", name, props[name])

        if business_key and business_key in props:
            if label == "CheckTarget":
                _lock_key(run, "CheckTarget.name")
            value = props[business_key]
            if value is None or (isinstance(value, str) and not value.strip()):
                raise Conflict(f"{business_key} — ключ узла, его нельзя очистить")
            if not isinstance(value, str):
                raise Conflict(f"{business_key} — ключ узла, он задаётся строкой")
            clash = _first(run(
                f"MATCH (n:{label} {{{business_key}: $value}}) "
                "WHERE elementId(n) <> $node_id RETURN elementId(n) AS nodeId",
                value=value,
                node_id=node_id,
            ))
            if clash:
                raise Conflict(f"{business_key} {value!r} уже занят другим узлом :{label}")
            if label == "CheckTarget":
                _assert_no_twin(run, value, exclude_node_id=node_id)

        if props:
            run("MATCH (n) WHERE elementId(n) = $node_id SET n += $props",
                node_id=node_id, props=props)

    _write(work)
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
    Проверка «используется ли» и удаление идут одной транзакцией.
    """
    node = _fetch_node(node_id)
    labels = node["labels"]

    if "ViolationExample" in labels:
        _run("MATCH (n) WHERE elementId(n) = $node_id DETACH DELETE n", node_id=node_id)
        return {"deleted": node_id, "examples": 1}

    if "CheckTarget" in labels:
        if not force:
            _assert_archived(node, "атрибут")

        def drop_target(run: Runner) -> None:
            _lock(run, node_id)
            # Считаются ссылки, а не ruleId: правило без ruleId тоже повиснет.
            used = run(
                "MATCH (r:Rule)-[:APPLIES_TO]->(t) WHERE elementId(t) = $node_id "
                "RETURN DISTINCT coalesce(r.ruleId, '(без ruleId)') AS rule_id",
                node_id=node_id,
            )
            if used:
                raise Conflict(
                    "Атрибут используется правилами: " + ", ".join(r["rule_id"] for r in used)
                    + ". Сначала отвяжите его."
                )
            run("MATCH (n) WHERE elementId(n) = $node_id DETACH DELETE n", node_id=node_id)

        _write(drop_target)
        return {"deleted": node_id}

    if "JobDescription" in labels:
        if not force:
            _assert_archived(node, "должностную инструкцию")
        _run("MATCH (n) WHERE elementId(n) = $node_id DETACH DELETE n", node_id=node_id)
        return {"deleted": node_id}

    if "Department" in labels:
        if not force:
            _assert_archived(node, "подразделение")

        def drop_department(run: Runner) -> None:
            _lock(run, node_id)
            # Без подразделения ограничение ONLY_IN исчезло бы вместе со связью,
            # и правило молча стало бы действовать для всех.
            used = run(
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
            run(
                """
                MATCH (n) WHERE elementId(n) = $node_id
                OPTIONAL MATCH (n)-[:HAS_JOB_DESCRIPTION]->(j:JobDescription)
                DETACH DELETE j, n
                """,
                node_id=node_id,
            )

        _write(drop_department)
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


Q_COUNT_DESCENDANTS = """
MATCH (n) WHERE elementId(n) = $node_id
OPTIONAL MATCH (n)-[:CONTAINS|DEFINES|HAS_EXAMPLE*1..3]->(d)
WITH n, collect(DISTINCT d) AS ds
OPTIONAL MATCH (n)-[:HAS_JOB_DESCRIPTION]->(j:JobDescription)
WITH ds, count(DISTINCT j) AS jobs
RETURN size([x IN ds WHERE x:Clause])           AS clauses,
       size([x IN ds WHERE x:Rule])             AS rules,
       size([x IN ds WHERE x:ViolationExample]) AS examples,
       jobs                                     AS jobDescriptions
"""


def count_descendants(node_id: str) -> dict[str, int]:
    """Что уйдёт вместе с узлом — для честного диалога подтверждения.

    Один проход по нисходящим связям вместо набора OPTIONAL MATCH:
    так запрос остаётся в одной области видимости и его нечем сломать.
    Должностные инструкции удаляются вместе с подразделением — они тоже в счёте.
    """
    row = _one(Q_COUNT_DESCENDANTS, node_id=node_id)
    return row or {"clauses": 0, "rules": 0, "examples": 0, "jobDescriptions": 0}


# --------------------------------------------------------------------------
#  Создание
# --------------------------------------------------------------------------


def create_order(number: str, title: str, date: str | None = None,
                 order_id: str | None = None) -> dict[str, Any]:
    order_id = order_id or slugify_id(number)
    if _one("MATCH (o:Order {orderId: $id}) RETURN o.orderId AS id", id=order_id):
        raise Conflict(f"Приказ с идентификатором {order_id!r} уже существует")
    order_date = _controlled_value("Order", "date", date)

    row = _one(
        """
        CREATE (o:Order {orderId: $id, number: $number, title: $title, status: $status})
        SET o.date = $date
        RETURN elementId(o) AS nodeId, properties(o) AS props
        """,
        id=order_id, number=number, title=title, date=order_date, status=ACTIVE_STATUS,
    )
    log.info("Создан приказ %s (%s)", order_id, number)
    return {"nodeId": row["nodeId"], **_props(row["props"])}


def _free_id(run: Runner, query: str, base: str) -> str:
    """Первый незанятый идентификатор: base, base.2, base.3..."""
    candidate, suffix = base, 1
    while run(query, id=candidate):
        suffix += 1
        candidate = f"{base}.{suffix}"
    return candidate


Q_CLAUSE_ID_TAKEN = "MATCH (c:Clause {clauseId: $id}) RETURN c.clauseId AS id"


def create_clause(order_node_id: str, code: str, text: str,
                  clause_id: str | None = None) -> dict[str, Any]:
    def work(run: Runner) -> dict[str, Any]:
        order = _fetch_node(order_node_id, "Order", run)
        # Подбор id и создание — одной транзакцией под замком: иначе два
        # одновременных пункта получают один id и второй падает с 409.
        _lock_key(run, "Clause.clauseId")
        if clause_id:
            # Явно заданный идентификатор не подменяется: о занятом сообщаем.
            if run(Q_CLAUSE_ID_TAKEN, id=clause_id):
                raise Conflict(f"Пункт с идентификатором {clause_id!r} уже существует")
            new_id = clause_id
        else:
            # Автоматический может совпасть с архивным или перенесённым пунктом —
            # тогда берётся свободный суффикс, как у правил.
            base = f"{order.get('orderId') or slugify_id(order.get('number', 'order'))}/{slugify_id(code)}"
            new_id = _free_id(run, Q_CLAUSE_ID_TAKEN, base)
        return run(
            """
            MATCH (o:Order) WHERE elementId(o) = $order_node_id
            CREATE (c:Clause {clauseId: $id, code: $code, text: $text, status: $status})
            CREATE (o)-[:CONTAINS]->(c)
            RETURN elementId(c) AS nodeId, properties(c) AS props
            """,
            order_node_id=order_node_id, id=new_id, code=code, text=text, status=ACTIVE_STATUS,
        )[0]

    row = _write(work)
    log.info("Создан пункт %s", row["props"].get("clauseId"))
    return {"nodeId": row["nodeId"], **_props(row["props"])}


Q_CREATE_RULE = """
MATCH (c:Clause) WHERE elementId(c) = $clause_node_id
CREATE (r:Rule {ruleId: $id, type: $type, description: $description,
                checkInstruction: $instruction, status: $status,
                studentsOnly: $students_only})
CREATE (c)-[:DEFINES]->(r)
RETURN elementId(r) AS nodeId, properties(r) AS props
"""


def create_rule(clause_node_id: str, rule_type: str, description: str,
                check_instruction: str = "", targets: list[str] | None = None,
                rule_id: str | None = None, students_only: bool = False,
                only: list[str] | None = None) -> dict[str, Any]:
    """Создаёт правило вместе с атрибутами и областью действия — одной транзакцией.

    Неизвестный атрибут или подразделение откатывает всё: не остаётся ни
    правила без атрибутов, ни правила, которое до отдельного запроса области
    действия действует во всех подразделениях.
    """
    _validate_rule_type(rule_type)
    targets, only = list(targets or []), list(only or [])

    def work(run: Runner) -> dict[str, Any]:
        clause = _fetch_node(clause_node_id, "Clause", run)
        _check_targets_known(run, targets)
        _check_departments_known(run, only)
        _lock_key(run, "Rule.ruleId")
        new_id = _free_id(run, "MATCH (r:Rule {ruleId: $id}) RETURN r.ruleId AS id",
                          rule_id or f"R-{slugify_id(clause.get('code') or 'rule')}")
        row = run(
            Q_CREATE_RULE,
            clause_node_id=clause_node_id, id=new_id, type=rule_type,
            description=description, instruction=check_instruction, status=ACTIVE_STATUS,
            students_only=bool(students_only),
        )[0]
        if targets:
            _replace_links(run, row["nodeId"], "targets", targets)
        if only:
            _replace_links(run, row["nodeId"], "only", only)
        return {"nodeId": row["nodeId"], **_props(row["props"])}

    # Журнал — после фиксации: драйвер может повторить транзакцию.
    rule = _write(work)
    log.info("Создано правило %s (%s)", rule.get("ruleId"), rule_type)
    return rule


def create_example(rule_node_id: str, text: str, is_violation: bool,
                   example_id: str | None = None) -> dict[str, Any]:
    def work(run: Runner) -> dict[str, Any]:
        rule = _fetch_node(rule_node_id, "Rule", run)
        new_id = example_id
        if not new_id:
            _lock_key(run, "ViolationExample.exampleId")
            used = run(
                "MATCH (r)-[:HAS_EXAMPLE]->(e) WHERE elementId(r) = $id RETURN e.exampleId AS id",
                id=rule_node_id,
            )
            base = rule.get("ruleId") or "EX"
            new_id = f"{base}-EX{len(used) + 1}"
            while run("MATCH (e:ViolationExample {exampleId: $id}) RETURN e.exampleId AS id",
                      id=new_id):
                new_id += "x"
        return run(
            """
            MATCH (r:Rule) WHERE elementId(r) = $rule_node_id
            CREATE (e:ViolationExample {exampleId: $id, text: $text,
                                        isViolation: $is_violation, status: $status})
            CREATE (r)-[:HAS_EXAMPLE]->(e)
            RETURN elementId(e) AS nodeId, properties(e) AS props
            """,
            rule_node_id=rule_node_id, id=new_id, text=text,
            is_violation=is_violation, status=ACTIVE_STATUS,
        )[0]

    row = _write(work)
    return {"nodeId": row["nodeId"], **_props(row["props"])}


def create_check_target(name: str, description: str = "",
                        source: str | None = None) -> dict[str, Any]:
    """Заводит атрибут, не давая создать двойника по написанию.

    source = JOB_SOURCE — атрибут определяется сравнением цели с должностными
    инструкциями подразделения, а description служит критерием сравнения.
    """
    if source and source not in TARGET_SOURCES:
        raise Conflict(f"Недопустимый источник атрибута {source!r}, ожидался один из {TARGET_SOURCES}")
    def work(run: Runner) -> dict[str, Any]:
        # Проверка двойника и создание — под одним замком: два одновременных
        # «срок исполнения» / «срок_исполнения» иначе проходят оба.
        _lock_key(run, "CheckTarget.name")
        _assert_no_twin(run, name)
        return run(
            """
            CREATE (t:CheckTarget {name: $name, description: $description, status: $status})
            SET t.source = $source
            RETURN elementId(t) AS nodeId, properties(t) AS props
            """,
            name=name, description=description, status=ACTIVE_STATUS, source=source or None,
        )[0]

    row = _write(work)
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


# --------------------------------------------------------------------------
#  Должностные инструкции
# --------------------------------------------------------------------------


def _job_view(node: dict[str, Any]) -> dict[str, Any]:
    """Узел инструкции с состоянием выписки обязанностей.

    У инструкций, загруженных до фоновой выписки, состояния нет — для них
    список считается готовым (каким бы он ни был).
    """
    return {**node, "dutiesStatus": node.get("dutiesStatus") or DUTIES_READY,
            "dutiesError": node.get("dutiesError")}


def get_job_description(node_id: str) -> dict[str, Any]:
    """Инструкция с обязанностями и состоянием выписки — интерфейс опрашивает её, пока pending."""
    return _job_view(_fetch_node(node_id, "JobDescription"))


Q_JOB_ID_TAKEN = "MATCH (j:JobDescription {jobDescriptionId: $id}) RETURN j.jobDescriptionId AS id"


def create_job_description(department_node_id: str, title: str, text: str,
                           job_description_id: str | None = None) -> dict[str, Any]:
    """Загружает должностную инструкцию в подразделение.

    С её текстом сравнивается цель, когда в подразделении действует правило
    на атрибуте с source = JOB_SOURCE. Узел создаётся сразу в состоянии
    pending: обязанности выписывает фоновая задача (routes.py).
    """
    title, text = title.strip(), text.strip()

    def work(run: Runner) -> dict[str, Any]:
        department = _fetch_node(department_node_id, "Department", run)
        _lock_key(run, "JobDescription.jobDescriptionId")
        if job_description_id:
            if run(Q_JOB_ID_TAKEN, id=job_description_id):
                raise Conflict(f"Должностная инструкция с идентификатором {job_description_id!r} уже существует")
            new_id = job_description_id
        else:
            base = (f"{department.get('departmentId') or slugify_id(department.get('name') or 'dep')}"
                    f"/{slugify_id(title)}")
            new_id = _free_id(run, Q_JOB_ID_TAKEN, base)
        return run(
            Q_CREATE_JOB_DESCRIPTION,
            department_node_id=department_node_id, id=new_id,
            title=title, text=text, status=ACTIVE_STATUS,
        )[0]

    row = _write(work)
    log.info("Загружена должностная инструкция %s (%d символов)",
             row["props"].get("jobDescriptionId"), len(text))
    return _job_view({"nodeId": row["nodeId"], **_props(row["props"])})


def update_job_description(node_id: str, title: str, text: str) -> tuple[dict[str, Any], bool]:
    """Правит должность и текст инструкции. Возвращает (узел, изменился ли текст).

    С новым текстом прежний список обязанностей уже не сверен — он
    сбрасывается, а узел переходит в pending; вызывающий запускает выписку.
    """
    node = _fetch_node(node_id, "JobDescription")
    title, text = title.strip(), text.strip()
    changed = text != (node.get("text") or "").strip()
    _run(
        """
        MATCH (j) WHERE elementId(j) = $node_id
        SET j.title = $title, j.text = $text,
            j.duties = CASE WHEN $changed THEN [] ELSE j.duties END,
            j.dutiesReviewed = CASE WHEN $changed THEN false ELSE j.dutiesReviewed END,
            j.dutiesStatus = CASE WHEN $changed THEN 'pending' ELSE j.dutiesStatus END,
            j.dutiesError = CASE WHEN $changed THEN null ELSE j.dutiesError END
        """,
        node_id=node_id, title=title, text=text, changed=changed,
    )
    return get_job_description(node_id), changed


Q_START_DUTIES = """
MATCH (j:JobDescription) WHERE elementId(j) = $node_id
  AND coalesce(j.dutiesStatus, '') <> 'pending'
SET j.dutiesStatus = 'pending', j.dutiesError = null
RETURN elementId(j) AS nodeId
"""


def start_duties_extraction(node_id: str) -> dict[str, Any]:
    """Переводит инструкцию в pending перед повторной выпиской.

    Уже идущая выписка не запускается второй раз — Conflict (409).
    """
    def work(run: Runner) -> None:
        _fetch_node(node_id, "JobDescription", run)
        _lock(run, node_id)
        if not run(Q_START_DUTIES, node_id=node_id):
            raise Conflict("Обязанности уже выписываются — дождитесь окончания")

    _write(work)
    return get_job_description(node_id)


def _clean_duties(duties: list[Any]) -> list[str]:
    cleaned: list[str] = []
    for item in duties:
        duty = " ".join(str(item).split())
        if duty and duty not in cleaned:
            cleaned.append(duty)
    return cleaned


# Результат пишется, только если инструкция всё ещё ждёт именно эту выписку:
# текст за это время не меняли, а редактор не сохранил список вручную.
Q_FINISH_DUTIES = """
MATCH (j:JobDescription) WHERE elementId(j) = $node_id
  AND j.dutiesStatus = 'pending' AND j.text = $text
SET j.dutiesStatus = $status, j.dutiesError = $error,
    j.duties = CASE WHEN $duties IS NULL THEN j.duties ELSE $duties END,
    j.dutiesReviewed = CASE WHEN $duties IS NULL THEN j.dutiesReviewed ELSE false END
RETURN elementId(j) AS nodeId
"""


def finish_duties(node_id: str, text: str, duties: list[str] | None = None,
                  error: str | None = None) -> bool:
    """Записывает итог фоновой выписки. Возвращает, записан ли он.

    duties = None — выписка не удалась, причина в error. Слишком длинный список
    обрезается до MAX_DUTIES с предупреждением в dutiesError: инструкция уже
    загружена, и отказ (409) её бы не вернул.
    """
    status = DUTIES_ERROR if duties is None else DUTIES_READY
    if duties is not None:
        duties = _clean_duties(duties)
        if len(duties) > MAX_DUTIES:
            error = (f"Модель выписала {len(duties)} обязанностей, сохранены первые {MAX_DUTIES}. "
                     "Проверьте список и сократите формулировки.")
            duties = duties[:MAX_DUTIES]
    written = bool(_run(Q_FINISH_DUTIES, node_id=node_id, text=text, status=status,
                        error=error, duties=duties))
    if written:
        log.info("Инструкция %s: выписка %s, обязанностей %s", node_id, status,
                 len(duties) if duties is not None else "—")
    else:
        log.info("Инструкция %s: итог выписки устарел (текст или список изменили), не записан", node_id)
    return written


DUTIES_LOST = "Выписка прервана: итог не сохранился (сбой базы), запустите заново"
Q_FAIL_ORPHANED_DUTIES = """
MATCH (j:JobDescription) WHERE elementId(j) = $node_id AND j.dutiesStatus = 'pending'
SET j.dutiesStatus = 'error', j.dutiesError = $error
RETURN elementId(j) AS nodeId
"""


def fail_orphaned_duties(node_id: str) -> bool:
    """pending одной инструкции, у которой нет идущей выписки, переводит в error.

    Решение «выписки нет» принимает вызывающий (routes.py знает свои задачи).
    """
    return bool(_run(Q_FAIL_ORPHANED_DUTIES, node_id=node_id, error=DUTIES_LOST))


def fail_pending_duties() -> int:
    """Выписки, оборванные перезапуском API, переводит в error. Вызывается при старте."""
    row = _one(
        """
        MATCH (j:JobDescription {dutiesStatus: 'pending'})
        SET j.dutiesStatus = 'error', j.dutiesError = $error
        RETURN count(j) AS total
        """,
        error=DUTIES_INTERRUPTED,
    )
    return int((row or {}).get("total") or 0)


def set_job_duties(node_id: str, duties: list[str], reviewed: bool) -> dict[str, Any]:
    """Сохраняет список обязанностей — с ним сравнивается цель.

    reviewed = False — список выписала модель и редактор его ещё не смотрел.
    Список, сохранённый вручную, заменяет и идущую выписку: её итог не запишется.
    """
    _fetch_node(node_id, "JobDescription")
    cleaned = _clean_duties(duties)
    if len(cleaned) > MAX_DUTIES:
        raise Conflict(f"Слишком длинный список обязанностей: {len(cleaned)}, допустимо {MAX_DUTIES}")
    _run(
        "MATCH (j) WHERE elementId(j) = $node_id "
        "SET j.duties = $duties, j.dutiesReviewed = $reviewed, "
        "j.dutiesStatus = 'ready', j.dutiesError = null",
        node_id=node_id, duties=cleaned, reviewed=reviewed,
    )
    log.info("Инструкция %s: обязанностей %d, проверено редактором: %s", node_id, len(cleaned), reviewed)
    return get_job_description(node_id)


# --------------------------------------------------------------------------
#  Связи
# --------------------------------------------------------------------------
#
# Набор связей заменяется одной транзакцией: блокировка узла, проверка,
# удаление старых и создание новых связей. Сбой посередине откатывает всё —
# правило не теряет атрибуты и не становится всеобщим, пункт не пропадает.

# Что заменяется: (тип связи, метка цели, как цель находится по значению).
Q_REPLACE_LINKS = {
    "targets": """
        MATCH (r:Rule) WHERE elementId(r) = $id
        OPTIONAL MATCH (r)-[old:APPLIES_TO]->()
        DELETE old
        WITH DISTINCT r
        UNWIND $values AS name
        MATCH (t:CheckTarget {name: name})
        MERGE (r)-[:APPLIES_TO]->(t)
        RETURN count(DISTINCT t) AS linked
    """,
    "only": """
        MATCH (r:Rule) WHERE elementId(r) = $id
        OPTIONAL MATCH (r)-[old:ONLY_IN]->()
        DELETE old
        WITH DISTINCT r
        UNWIND $values AS dep
        MATCH (d:Department {departmentId: dep})
        MERGE (r)-[:ONLY_IN]->(d)
        RETURN count(DISTINCT d) AS linked
    """,
    "references": """
        MATCH (a:Clause) WHERE elementId(a) = $id
        OPTIONAL MATCH (a)-[old:REFERENCES]->()
        DELETE old
        WITH DISTINCT a
        UNWIND $values AS target
        MATCH (b:Clause) WHERE elementId(b) = target
        MERGE (a)-[:REFERENCES]->(b)
        RETURN count(DISTINCT b) AS linked
    """,
}


def _replace_links(run: Runner, node_id: str, kind: str, values: list[str]) -> None:
    rows = run(Q_REPLACE_LINKS[kind], id=node_id, values=values)
    # Цель могла исчезнуть между проверкой и записью — тогда откатываем всё.
    if rows and rows[0].get("linked") is not None and rows[0]["linked"] != len(set(values)):
        raise Conflict("Каталог изменился во время сохранения. Обновите страницу и повторите.")


def _check_targets_known(run: Runner, targets: list[str]) -> None:
    if not targets:
        return
    known = {t["name"] for t in run(
        "MATCH (t:CheckTarget) WHERE t.name IN $names RETURN t.name AS name", names=targets)}
    unknown = [t for t in targets if t not in known]
    if unknown:
        raise NotFound("Нет таких атрибутов: " + ", ".join(unknown))


def _check_departments_known(run: Runner, only: list[str]) -> None:
    repeated = sorted({d for d in only if only.count(d) > 1})
    if repeated:
        raise Conflict("Подразделение указано дважды: " + ", ".join(repeated))
    if not only:
        return
    known = {d["id"] for d in run(
        "MATCH (d:Department) WHERE d.departmentId IN $ids RETURN d.departmentId AS id", ids=only)}
    unknown = sorted({d for d in only if d not in known})
    if unknown:
        raise NotFound("Нет таких подразделений: " + ", ".join(unknown))


def set_rule_targets(rule_node_id: str, targets: list[str]) -> list[str]:
    """Полностью заменяет набор атрибутов правила."""
    def work(run: Runner) -> None:
        _fetch_node(rule_node_id, "Rule", run)
        _lock(run, rule_node_id)
        _check_targets_known(run, targets)
        _replace_links(run, rule_node_id, "targets", targets)

    _write(work)
    log.info("Правило %s теперь применяется к %s", rule_node_id, targets)
    return targets


def set_rule_scope(rule_node_id: str, only: list[str]) -> dict[str, Any]:
    """Полностью заменяет область действия правила по подразделениям.

    only — departmentId, в которых правило действует; пусто — для всех.
    """
    def work(run: Runner) -> None:
        _fetch_node(rule_node_id, "Rule", run)
        _lock(run, rule_node_id)
        _check_departments_known(run, only)
        _replace_links(run, rule_node_id, "only", only)

    _write(work)
    log.info("Правило %s: только в %s", rule_node_id, only)
    return {"only": only}


def set_rule_audience(rule_node_id: str, students_only: bool) -> dict[str, Any]:
    """Для кого действует правило: только для студентов или для всех.

    Хранится свойством Rule.studentsOnly; проверка читает его через
    coalesce(r.studentsOnly, false), поэтому у старых правил оно может отсутствовать.
    """
    _fetch_node(rule_node_id, "Rule")
    _run("MATCH (r:Rule) WHERE elementId(r) = $id SET r.studentsOnly = $value",
         id=rule_node_id, value=bool(students_only))
    log.info("Правило %s: %s", rule_node_id, "только для студентов" if students_only else "для всех")
    return {"studentsOnly": bool(students_only)}


def set_clause_references(clause_node_id: str, target_node_ids: list[str]) -> list[str]:
    """Перекрёстные ссылки между пунктами: (:Clause)-[:REFERENCES]->(:Clause)."""
    if clause_node_id in target_node_ids:
        raise Conflict("Пункт не может ссылаться сам на себя")

    def work(run: Runner) -> None:
        _fetch_node(clause_node_id, "Clause", run)
        _lock(run, clause_node_id)
        for target in target_node_ids:
            _fetch_node(target, "Clause", run)
        _replace_links(run, clause_node_id, "references", target_node_ids)

    _write(work)
    return target_node_ids


def _assert_active_parent(parent: dict[str, Any], what: str) -> None:
    # Правило в архивном пункте (пункт в архивном приказе) выпадает из
    # проверок молча — перенос туда почти всегда ошибка выбора.
    if _status_of(parent) != ACTIVE_STATUS:
        raise Conflict(f"Нельзя перенести в архивный {what}. Сначала верните его из архива.")


def move_clause(clause_node_id: str, order_node_id: str) -> dict[str, Any]:
    """Переносит пункт в другой приказ."""
    def work(run: Runner) -> None:
        _fetch_node(clause_node_id, "Clause", run)
        _assert_active_parent(_fetch_node(order_node_id, "Order", run), "приказ")
        _lock(run, clause_node_id)
        run(
            """
            MATCH (o:Order) WHERE elementId(o) = $order_node_id
            MATCH (c:Clause) WHERE elementId(c) = $clause_node_id
            OPTIONAL MATCH (:Order)-[old:CONTAINS]->(c)
            DELETE old
            WITH DISTINCT o, c
            MERGE (o)-[:CONTAINS]->(c)
            """,
            order_node_id=order_node_id, clause_node_id=clause_node_id,
        )

    _write(work)
    return _fetch_node(clause_node_id)


Q_CLAUSE_IN_ARCHIVED_ORDER = """
MATCH (o:Order)-[:CONTAINS]->(c:Clause) WHERE elementId(c) = $node_id
  AND coalesce(o.status, 'active') <> 'active'
RETURN elementId(o) AS nodeId LIMIT 1
"""


def move_rule(rule_node_id: str, clause_node_id: str) -> dict[str, Any]:
    """Переносит правило в другой пункт."""
    def work(run: Runner) -> None:
        _fetch_node(rule_node_id, "Rule", run)
        _assert_active_parent(_fetch_node(clause_node_id, "Clause", run), "пункт")
        # Действующий пункт архивного приказа из проверок тоже выпадает.
        if run(Q_CLAUSE_IN_ARCHIVED_ORDER, node_id=clause_node_id):
            raise Conflict("Пункт входит в архивный приказ — правило в нём не будет "
                           "участвовать в проверках. Сначала верните приказ из архива.")
        _lock(run, rule_node_id)
        run(
            """
            MATCH (c:Clause) WHERE elementId(c) = $clause_node_id
            MATCH (r:Rule) WHERE elementId(r) = $rule_node_id
            OPTIONAL MATCH (:Clause)-[old:DEFINES]->(r)
            DELETE old
            WITH DISTINCT c, r
            MERGE (c)-[:DEFINES]->(r)
            """,
            clause_node_id=clause_node_id, rule_node_id=rule_node_id,
        )

    _write(work)
    return _fetch_node(rule_node_id)


# --------------------------------------------------------------------------
#  Ремонт данных
# --------------------------------------------------------------------------


def _assign_ids(run: Runner, label: str, rows: list[dict[str, Any]]) -> int:
    """Проставляет бизнес-ключ узлам rows ({nodeId, base}) с проверкой занятости.

    Занятость проверяется в Python по всем ключам метки: совпадение с чужим
    ключом получает суффикс, а не роняет ремонт на ограничении уникальности.
    """
    key = BUSINESS_KEYS[label]
    taken = {str(r["id"]) for r in run(
        f"MATCH (n:{label}) WHERE n.{key} IS NOT NULL RETURN n.{key} AS id")}
    for row in rows:
        candidate, suffix = row["base"], 1
        while candidate in taken:
            suffix += 1
            candidate = f"{row['base']}.{suffix}"
        taken.add(candidate)
        run(f"MATCH (n:{label}) WHERE elementId(n) = $node_id SET n.{key} = $value",
            node_id=row["nodeId"], value=candidate)
    return len(rows)


def _missing(key: str) -> str:
    return f"(n.{key} IS NULL OR trim(toString(n.{key})) = '')"


def repair_identifiers() -> dict[str, Any]:
    """Проставляет недостающие бизнес-ключи и статусы.

    Без orderId/clauseId выгрузка в seed невозможна: MERGE строится именно по
    этим ключам. Пункт без приказа тоже получает ключ (с префиксом ORD),
    инструкция — из подразделения и должности. Атрибуты без имени и
    подразделения без departmentId не чинятся (ключ смысловой) — их nodeId
    возвращаются в unnamedTargets / departmentsWithoutId. Всё — одной транзакцией.
    """
    def work(run: Runner) -> dict[str, Any]:
        report: dict[str, Any] = {}
        orders = run(f"""
            MATCH (n:Order) WHERE {_missing('orderId')}
            RETURN elementId(n) AS nodeId, coalesce(n.number, n.title, 'order') AS name
        """)
        report["orders"] = _assign_ids(run, "Order", [
            {"nodeId": o["nodeId"], "base": "ORD-" + slugify_id(str(o["name"]))} for o in orders])

        # Приказы к этому моменту уже с ключами — пункт берёт ключ своего приказа.
        clauses = run(f"""
            MATCH (n:Clause) WHERE {_missing('clauseId')}
            OPTIONAL MATCH (o:Order)-[:CONTAINS]->(n)
            RETURN elementId(n) AS nodeId, n.code AS code, head(collect(o.orderId)) AS orderId
        """)
        report["clauses"] = _assign_ids(run, "Clause", [
            {"nodeId": c["nodeId"],
             "base": f"{c['orderId'] or 'ORD'}/{slugify_id(str(c['code'])) if c['code'] else c['nodeId']}"}
            for c in clauses])

        rules = run(f"MATCH (n:Rule) WHERE {_missing('ruleId')} RETURN elementId(n) AS nodeId")
        report["rules"] = _assign_ids(run, "Rule", [
            {"nodeId": r["nodeId"], "base": "R-" + r["nodeId"]} for r in rules])

        examples = run(f"MATCH (n:ViolationExample) WHERE {_missing('exampleId')} "
                       "RETURN elementId(n) AS nodeId")
        report["examples"] = _assign_ids(run, "ViolationExample", [
            {"nodeId": e["nodeId"], "base": "EX-" + e["nodeId"]} for e in examples])

        # Инструкция: id из подразделения и должности, как при загрузке.
        jobs = run(f"""
            MATCH (n:JobDescription) WHERE {_missing('jobDescriptionId')}
            OPTIONAL MATCH (d:Department)-[:HAS_JOB_DESCRIPTION]->(n)
            RETURN elementId(n) AS nodeId, n.title AS title, head(collect(d.departmentId)) AS departmentId
        """)
        report["jobDescriptions"] = _assign_ids(run, "JobDescription", [
            {"nodeId": j["nodeId"],
             "base": f"{j['departmentId'] or 'dep'}/{slugify_id(str(j['title'])) if j['title'] else j['nodeId']}"}
            for j in jobs])

        # Имя атрибута и id подразделения — смысловые (их пишут в целях и
        # передают в запросе проверки), придумать их нельзя: только сообщаем.
        report["unnamedTargets"] = [r["nodeId"] for r in run(
            f"MATCH (n:CheckTarget) WHERE {_missing('name')} RETURN elementId(n) AS nodeId")]
        report["departmentsWithoutId"] = [r["nodeId"] for r in run(
            f"MATCH (n:Department) WHERE {_missing('departmentId')} RETURN elementId(n) AS nodeId")]

        report["statuses"] = len(run(f"""
            MATCH (n:{CATALOG_LABELS})
            WHERE n.status IS NULL
            SET n.status = 'active'
            RETURN elementId(n) AS id
        """))
        return report

    report = _write(work)
    log.warning("Ремонт идентификаторов: %s", report)
    return report


def merge_duplicate_targets() -> dict[str, Any]:
    """Сводит атрибуты-двойники, различающиеся только написанием, к одному узлу.

    Двойники определяются тем же naming.normalize_name, что и в агенте и в
    диагностике, — а не приближённой Cypher-нормализацией. Сводятся только
    узлы с одинаковым статусом и источником (source): перенос правил с
    архивного атрибута на действующий включил бы отключённые правила, а
    атрибут «по инструкции» и обычный проверяются по-разному. Такие группы
    попадают в skipped — их разбирают вручную. Канонический узел: с описанием,
    затем с большим числом правил. Связи APPLIES_TO переносятся на него,
    удаляются только сведённые двойники.
    """
    def work(run: Runner) -> dict[str, Any]:
        _lock_key(run, "CheckTarget.name")
        rows = run(Q_TARGETS_FOR_MERGE)
        groups: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            if row["name"]:
                groups.setdefault(normalize_name(row["name"]), []).append(row)

        merged: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        for group in groups.values():
            if len(group) < 2:
                continue
            kinds: dict[tuple, list[dict[str, Any]]] = {}
            for row in group:
                kinds.setdefault((row["status"], row.get("source") or None), []).append(row)
            if len(kinds) > 1:
                skipped.append({
                    "names": sorted(str(t["name"]) for t in group),
                    "reason": "двойники различаются статусом или источником (source) — "
                              "сведите вручную: архивируйте лишний или выровняйте source",
                })
            for kind in kinds.values():
                if len(kind) < 2:
                    continue
                kind.sort(key=lambda t: (not t["described"], -t["rules"], str(t["name"])))
                keep, twins = kind[0], kind[1:]
                run(
                    """
                    MATCH (keep:CheckTarget) WHERE elementId(keep) = $keep
                    UNWIND $twins AS twin_id
                    MATCH (dup:CheckTarget) WHERE elementId(dup) = twin_id
                    OPTIONAL MATCH (r:Rule)-[:APPLIES_TO]->(dup)
                    FOREACH (x IN CASE WHEN r IS NULL THEN [] ELSE [r] END | MERGE (x)-[:APPLIES_TO]->(keep))
                    WITH DISTINCT dup
                    DETACH DELETE dup
                    """,
                    keep=keep["nodeId"], twins=[t["nodeId"] for t in twins],
                )
                merged.append({"kept": keep["name"], "removed": [t["name"] for t in twins]})
        return {"merged": merged, "skipped": skipped}

    report = _write(work)
    if report["merged"]:
        log.warning("Сведены двойники атрибутов: %s", report["merged"])
    if report["skipped"]:
        log.warning("Двойники атрибутов не сведены (разный статус или source): %s", report["skipped"])
    return report


Q_TARGETS_FOR_MERGE = """
MATCH (t:CheckTarget)
OPTIONAL MATCH (r:Rule)-[:APPLIES_TO]->(t)
RETURN elementId(t) AS nodeId, t.name AS name,
       coalesce(t.status, 'active') AS status, t.source AS source,
       trim(coalesce(t.description, '')) <> '' AS described,
       count(r) AS rules
"""
