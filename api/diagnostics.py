"""Диагностика графа: что именно мешает проверкам работать честно.

Каждая проверка отвечает на вопрос «как это проявится снаружи». Молчаливая
неполнота хуже явной ошибки: правило, повисшее без атрибута, и атрибут без
описания выглядят как «модель тупит», хотя это дефект данных.

severity:
  error   — проверка целей уже даёт неверный результат; /ready отдаёт 503
  warning — данные противоречивы или бесполезны, но проверка работает
  info    — справочно
"""

from __future__ import annotations

import logging
from typing import Any

from catalog import TEXT_LIMITS
from graph import ACTIVE, JOB_SOURCE, get_driver
from naming import normalize_name

log = logging.getLogger(__name__)

ERROR, WARNING, INFO = "error", "warning", "info"


def _run(query: str, **params) -> list[dict[str, Any]]:
    with get_driver().session() as session:
        return [dict(record) for record in session.run(query, **params)]


def _text(value: Any) -> str:
    """Текстовое свойство как строка: число или true/false в описании не роняют сбор."""
    return "" if value is None else value if isinstance(value, str) else str(value)


# --------------------------------------------------------------------------
#  Запросы проверок
# --------------------------------------------------------------------------

Q_TARGETS = """
MATCH (t:CheckTarget)
RETURN elementId(t) AS nodeId, t.name AS name,
       coalesce(t.description, '') AS description,
       coalesce(t.status, 'active') AS status
ORDER BY name
"""

# Использование атрибутов считаем отдельным запросом, а не подзапросом внутри
# RETURN: обычный MATCH поддерживается всеми версиями Neo4j 5 одинаково.
Q_TARGET_USAGE = f"""
MATCH (r:Rule)-[:APPLIES_TO]->(t:CheckTarget)
WHERE {ACTIVE.format('r')}
RETURN t.name AS name, count(r) AS rule_count
"""

Q_RULES_WITHOUT_TARGET = f"""
MATCH (r:Rule) WHERE {ACTIVE.format('r')}
  AND NOT (r)-[:APPLIES_TO]->(:CheckTarget)
RETURN elementId(r) AS nodeId, coalesce(r.ruleId, '(без ruleId)') AS label
ORDER BY label
"""

# Атрибуты у правила есть, но все в архиве: архивный атрибут не попадает в
# словарь модели, и правило молча не срабатывает.
Q_RULES_ONLY_ARCHIVED_TARGETS = f"""
MATCH (r:Rule) WHERE {ACTIVE.format('r')}
  AND (r)-[:APPLIES_TO]->(:CheckTarget)
  AND NOT EXISTS {{
    MATCH (r)-[:APPLIES_TO]->(t:CheckTarget) WHERE {ACTIVE.format('t')}
  }}
RETURN elementId(r) AS nodeId, coalesce(r.ruleId, '(без ruleId)') AS label
ORDER BY label
"""

Q_MISSING_IDS = """
MATCH (n)
WHERE (n:Order       AND (n.orderId   IS NULL OR trim(toString(n.orderId))   = ''))
   OR (n:Clause      AND (n.clauseId  IS NULL OR trim(toString(n.clauseId))  = ''))
   OR (n:Rule        AND (n.ruleId    IS NULL OR trim(toString(n.ruleId))    = ''))
   OR (n:ViolationExample AND (n.exampleId IS NULL OR trim(toString(n.exampleId)) = ''))
RETURN elementId(n) AS nodeId, head(labels(n)) AS kind,
       coalesce(toStringOrNull(n.number), toStringOrNull(n.code), toStringOrNull(n.description),
                toStringOrNull(n.text), '(без названия)') AS label
ORDER BY kind, label
LIMIT 200
"""

Q_CLAUSES_WITHOUT_RULES = f"""
MATCH (o:Order)-[:CONTAINS]->(c:Clause)
WHERE {ACTIVE.format('o')} AND {ACTIVE.format('c')}
  AND NOT (c)-[:DEFINES]->(:Rule)
RETURN elementId(c) AS nodeId,
       coalesce(toStringOrNull(o.number), '?') + ' ' + coalesce(toStringOrNull(c.code), '?') AS label
ORDER BY label
"""

# Правила у пункта есть, но все в архиве — пункт ничего не проверяет.
Q_CLAUSES_ONLY_ARCHIVED_RULES = f"""
MATCH (o:Order)-[:CONTAINS]->(c:Clause)
WHERE {ACTIVE.format('o')} AND {ACTIVE.format('c')}
  AND (c)-[:DEFINES]->(:Rule)
  AND NOT EXISTS {{
    MATCH (c)-[:DEFINES]->(r:Rule) WHERE {ACTIVE.format('r')}
  }}
RETURN elementId(c) AS nodeId,
       coalesce(toStringOrNull(o.number), '?') + ' ' + coalesce(toStringOrNull(c.code), '?') AS label
ORDER BY label
"""

Q_ORDERS_WITHOUT_CLAUSES = f"""
MATCH (o:Order) WHERE {ACTIVE.format('o')}
  AND NOT (o)-[:CONTAINS]->(:Clause)
RETURN elementId(o) AS nodeId, coalesce(toStringOrNull(o.number), toStringOrNull(o.orderId), '?') AS label
ORDER BY label
"""

Q_EXAMPLE_COVERAGE = f"""
MATCH (r:Rule) WHERE {ACTIVE.format('r')}
OPTIONAL MATCH (r)-[:HAS_EXAMPLE]->(e:ViolationExample) WHERE {ACTIVE.format('e')}
WITH r, collect(e) AS examples
RETURN elementId(r) AS nodeId,
       coalesce(r.ruleId, '(без ruleId)') AS label,
       r.type AS type,
       size(examples) AS total,
       size([x IN examples WHERE x.isViolation = true])  AS violating,
       size([x IN examples WHERE x.isViolation = false]) AS correct
ORDER BY label
"""

Q_DUPLICATE_CODES = f"""
MATCH (o:Order)-[:CONTAINS]->(c:Clause)
WHERE {ACTIVE.format('o')} AND {ACTIVE.format('c')}
WITH o, c.code AS code, collect(elementId(c)) AS nodes
WHERE size(nodes) > 1 AND code IS NOT NULL
RETURN coalesce(toStringOrNull(o.number), '?') + ' — пункт ' + coalesce(toStringOrNull(code), '?') AS label, nodes
"""

# Область действия правил по подразделениям: одна выборка на все проверки.
Q_RULE_SCOPE = f"""
MATCH (r:Rule)-[x:ONLY_IN|EXCEPT_IN]->(d:Department)
WHERE {ACTIVE.format('r')}
RETURN elementId(r) AS nodeId,
       coalesce(r.ruleId, '(без ruleId)') AS rule,
       type(x) AS kind,
       coalesce(toStringOrNull(d.name), toStringOrNull(d.departmentId), '?') AS department,
       coalesce(d.status, 'active') AS departmentStatus
ORDER BY rule, department
"""

Q_DEPARTMENTS_WITHOUT_ID = """
MATCH (d:Department)
WHERE d.departmentId IS NULL OR trim(toString(d.departmentId)) = ''
RETURN elementId(d) AS nodeId, coalesce(toStringOrNull(d.name), '(без названия)') AS label
ORDER BY label
"""

# Действующие правила на атрибутах, которые определяются по должностным
# инструкциям: пока такие есть, каждому подразделению нужны инструкции.
Q_JOB_RULES = f"""
MATCH (r:Rule)-[:APPLIES_TO]->(t:CheckTarget {{source: '{JOB_SOURCE}'}})
WHERE {ACTIVE.format('r')} AND {ACTIVE.format('t')}
RETURN coalesce(r.ruleId, '(без ruleId)') AS rule
ORDER BY rule
"""

# Правило на таком атрибуте подразделения касается, если оно не ограничено
# другими подразделениями.
Q_DEPARTMENTS_WITHOUT_JOB_DESCRIPTIONS = f"""
MATCH (d:Department)
WHERE {ACTIVE.format('d')} AND d.departmentId IS NOT NULL
  AND NOT EXISTS {{
    MATCH (d)-[:HAS_JOB_DESCRIPTION]->(j:JobDescription)
    WHERE {ACTIVE.format('j')} AND trim(coalesce(j.text, '')) <> ''
  }}
  AND EXISTS {{
    MATCH (r:Rule)-[:APPLIES_TO]->(t:CheckTarget {{source: '{JOB_SOURCE}'}})
    WHERE {ACTIVE.format('r')} AND {ACTIVE.format('t')}
      AND (NOT (r)-[:ONLY_IN]->(:Department) OR (r)-[:ONLY_IN]->(d))
  }}
RETURN elementId(d) AS nodeId, coalesce(toStringOrNull(d.name), toStringOrNull(d.departmentId), '?') AS label
ORDER BY label
"""

# Инструкции, у которых список обязанностей не выписан или не просмотрен.
Q_JOB_DUTIES = f"""
MATCH (d:Department)-[:HAS_JOB_DESCRIPTION]->(j:JobDescription)
WHERE {ACTIVE.format('d')} AND {ACTIVE.format('j')}
  AND coalesce(j.dutiesStatus, 'ready') <> 'pending'
  AND (size(coalesce(j.duties, [])) = 0 OR coalesce(j.dutiesReviewed, false) = false)
RETURN elementId(d) AS nodeId,
       coalesce(toStringOrNull(d.name), toStringOrNull(d.departmentId), '?') + ' — '
         + coalesce(toStringOrNull(j.title), '?') AS label,
       size(coalesce(j.duties, [])) AS duties
ORDER BY label
"""

# Известные текстовые свойства (catalog.TEXT_LIMITS) — для проверки типа и
# длины. Текст должностной инструкции сюда не входит: он большой и правится
# своей операцией.
# Текстовые свойства, без которых проверка идёт неверно: по имени атрибут
# ищется в цели и в правилах, по описанию его распознаёт модель, по коду
# находится подразделение. Нестроковое значение здесь — ошибка (и /ready 503),
# у остальных свойств — предупреждение: они только показываются.
CHECK_TEXT_PROPERTIES = frozenset({
    ("CheckTarget", "name"), ("CheckTarget", "description"), ("Department", "departmentId"),
})

Q_TEXT_PROPERTIES = """
MATCH (n)
WHERE n:Order OR n:Clause OR n:Rule OR n:CheckTarget OR n:ViolationExample OR n:Department
   OR n:JobDescription
WITH n, [l IN labels(n) WHERE l IN $labels][0] AS kind
RETURN elementId(n) AS nodeId, kind,
       CASE kind
         WHEN 'Order' THEN n {.number, .title, key: n.orderId}
         WHEN 'Clause' THEN n {.code, .text, key: n.clauseId}
         WHEN 'Rule' THEN n {.description, .checkInstruction, key: n.ruleId}
         WHEN 'ViolationExample' THEN n {.text, key: n.exampleId}
         WHEN 'CheckTarget' THEN n {.name, .description, key: n.name}
         WHEN 'Department' THEN n {.departmentId, .name, key: n.departmentId}
         ELSE n {.title, key: n.jobDescriptionId}
       END AS props
"""

Q_ARCHIVED = """
MATCH (n)
WHERE (n:Order OR n:Clause OR n:Rule OR n:CheckTarget OR n:ViolationExample OR n:Department
       OR n:JobDescription)
  AND n.status = 'archived'
RETURN head(labels(n)) AS kind, count(*) AS total
"""

# Названия типов узлов в начале строки замечания: «Приказ: ПР-02», «Пункт: 3.1».
KIND_NAMES = {
    "Order": "Приказ", "Clause": "Пункт", "Rule": "Правило",
    "CheckTarget": "Атрибут", "ViolationExample": "Пример",
    "Department": "Подразделение", "JobDescription": "Должностная инструкция",
}


def _issue(code, severity, title, detail, items=None, fix=None) -> dict[str, Any]:
    return {
        "code": code, "severity": severity, "title": title, "detail": detail,
        "items": items or [], "fix": fix,
    }


# --------------------------------------------------------------------------
#  Сбор
# --------------------------------------------------------------------------


def collect() -> dict[str, Any]:
    """Полная диагностика графа."""
    issues: list[dict[str, Any]] = []

    usage = {row["name"]: row["rule_count"] for row in _run(Q_TARGET_USAGE)}
    targets = [{**row, "rule_count": usage.get(row["name"], 0)} for row in _run(Q_TARGETS)]
    active_targets = [t for t in targets if t["status"] == "active"]

    if not active_targets:
        issues.append(_issue(
            "no_check_targets", ERROR,
            "Словарь атрибутов пуст",
            "Без активных :CheckTarget агент не может извлечь из цели ничего, "
            "и любая проверка вернёт NEEDS_MANUAL_REVIEW.",
        ))

    # Двойники по написанию
    by_norm: dict[str, list[dict]] = {}
    for target in active_targets:
        by_norm.setdefault(normalize_name(target["name"] or ""), []).append(target)
    duplicates = [group for group in by_norm.values() if len(group) > 1]
    if duplicates:
        issues.append(_issue(
            "duplicate_check_targets", ERROR,
            "Атрибуты-двойники, различающиеся написанием",
            "Для Neo4j «срок исполнения» и «срок_исполнения» — разные узлы. "
            "Правило висит на одном из них, модель возвращает другое — получается "
            "ложное нарушение. Сведите двойников к одному узлу.",
            items=[{"label": " ↔ ".join(t["name"] for t in group),
                    "nodeId": group[0]["nodeId"], "kind": "CheckTarget"}
                   for group in duplicates],
            fix={"action": "merge_duplicate_targets", "label": "Свести двойников"},
        ))

    # Атрибуты без описания
    no_description = [t for t in active_targets if not _text(t["description"]).strip()]
    if no_description:
        issues.append(_issue(
            "targets_without_description", ERROR,
            "Атрибуты без описания",
            "Без описания модель не узнает атрибут в формулировке цели, и правило "
            "на нём будет срабатывать всегда.",
            items=[{"label": t["name"], "nodeId": t["nodeId"], "kind": "CheckTarget"}
                   for t in no_description],
        ))

    # Правила без атрибутов
    rules_without_target = _run(Q_RULES_WITHOUT_TARGET)
    if rules_without_target:
        issues.append(_issue(
            "rules_without_target", ERROR,
            "Правила без привязки к атрибуту",
            "Такое правило не участвует ни в одном запросе и никогда не сработает.",
            items=[{"label": r["label"], "nodeId": r["nodeId"], "kind": "Rule"}
                   for r in rules_without_target],
        ))

    rules_archived_targets = _run(Q_RULES_ONLY_ARCHIVED_TARGETS)
    if rules_archived_targets:
        issues.append(_issue(
            "rules_with_archived_targets", WARNING,
            "Правила, у которых все атрибуты в архиве",
            "Архивный атрибут не попадает в словарь модели, поэтому такое правило "
            "молча не срабатывает. Верните атрибут из архива или привяжите правило к другому.",
            items=[{"label": r["label"], "nodeId": r["nodeId"], "kind": "Rule"}
                   for r in rules_archived_targets],
        ))

    # Отсутствующие бизнес-ключи
    missing_ids = _run(Q_MISSING_IDS)
    if missing_ids:
        issues.append(_issue(
            "missing_identifiers", ERROR,
            "Не заданы идентификаторы",
            "Без идентификатора приказ, пункт, правило или пример не попадут "
            "в резервную копию каталога, и состояние базы нельзя будет восстановить.",
            items=[{"label": f"{KIND_NAMES.get(m['kind'], m['kind'])}: {m['label']}",
                    "nodeId": m["nodeId"], "kind": m["kind"]} for m in missing_ids],
            fix={"action": "repair_identifiers", "label": "Проставить идентификаторы"},
        ))

    # Атрибуты, на которые никто не ссылается
    orphan = [t for t in active_targets if t["rule_count"] == 0]
    if orphan:
        issues.append(_issue(
            "orphan_check_targets", WARNING,
            "Атрибуты, к которым не привязано ни одного правила",
            "Такой атрибут попадает в промпт, тратит контекст модели, но ни на что "
            "не влияет. Либо привяжите правило, либо отправьте в архив.",
            items=[{"label": t["name"], "nodeId": t["nodeId"], "kind": "CheckTarget"}
                   for t in orphan],
        ))

    # Пункты без правил и приказы без пунктов
    clauses_without_rules = _run(Q_CLAUSES_WITHOUT_RULES)
    if clauses_without_rules:
        issues.append(_issue(
            "clauses_without_rules", WARNING,
            "Пункты без правил",
            "Пункт хранит текст нормативки, но ничего не проверяет.",
            items=[{"label": c["label"], "nodeId": c["nodeId"], "kind": "Clause"}
                   for c in clauses_without_rules],
        ))

    clauses_archived_rules = _run(Q_CLAUSES_ONLY_ARCHIVED_RULES)
    if clauses_archived_rules:
        issues.append(_issue(
            "clauses_with_archived_rules", WARNING,
            "Пункты, у которых все правила в архиве",
            "Пункт действует, но ни одно его правило не участвует в проверке.",
            items=[{"label": c["label"], "nodeId": c["nodeId"], "kind": "Clause"}
                   for c in clauses_archived_rules],
        ))

    orders_without_clauses = _run(Q_ORDERS_WITHOUT_CLAUSES)
    if orders_without_clauses:
        issues.append(_issue(
            "orders_without_clauses", WARNING,
            "Приказы без пунктов",
            "Пустой приказ ни на что не влияет.",
            items=[{"label": o["label"], "nodeId": o["nodeId"], "kind": "Order"}
                   for o in orders_without_clauses],
        ))

    # Примеры: наличие и соответствие типу правила
    coverage = _run(Q_EXAMPLE_COVERAGE)
    mismatched = [
        row for row in coverage
        if (row["type"] == "PROHIBITION" and row["violating"] == 0)
        or (row["type"] == "REQUIREMENT" and row["correct"] == 0)
    ]
    no_examples = [row for row in coverage if row["total"] == 0]
    only_mismatched = [row for row in mismatched if row["total"] > 0]

    if only_mismatched:
        issues.append(_issue(
            "example_kind_mismatch", WARNING,
            "Примеры не того вида, что нужен правилу",
            "Запрет показывает в ответе примеры с isViolation = true, требование — "
            "с isViolation = false. У этих правил примеры есть, но не те, поэтому "
            "поле examples в ответе останется пустым.",
            items=[{"label": f"{row['label']} ({row['type']})",
                    "nodeId": row["nodeId"], "kind": "Rule"} for row in only_mismatched],
        ))

    if no_examples:
        issues.append(_issue(
            "rules_without_examples", INFO,
            "Правила без примеров",
            "Примеры попадают в ответ проверки и подсказывают автору цели, "
            "как переформулировать. Без них ответ суше.",
            items=[{"label": row["label"], "nodeId": row["nodeId"], "kind": "Rule"}
                   for row in no_examples],
        ))

    # Дубли номеров пунктов внутри приказа
    duplicate_codes = _run(Q_DUPLICATE_CODES)
    if duplicate_codes:
        issues.append(_issue(
            "duplicate_clause_codes", WARNING,
            "Повторяющиеся номера пунктов",
            "В одном приказе два пункта с одинаковым номером — в ответе проверки "
            "их невозможно различить.",
            items=[{"label": row["label"], "nodeId": row["nodes"][0], "kind": "Clause"}
                   for row in duplicate_codes],
        ))

    # Разграничение по подразделениям
    scope = _run(Q_RULE_SCOPE)
    exceptions = [row for row in scope if row["kind"] == "EXCEPT_IN"]

    def scope_item(row: dict) -> dict:
        return {"label": f"{row['rule']} — {row['department']}",
                "nodeId": row["nodeId"], "kind": "Rule"}

    # Исключений больше нет: оставшиеся связи проверка не учитывает.
    if exceptions:
        issues.append(_issue(
            "legacy_exceptions", WARNING,
            "Исключения, которые больше не учитываются",
            "Связи EXCEPT_IN остались от прежней версии: проверка их не видит, правило "
            "в подразделении действует. Если правило там действовать не должно, отметьте "
            "«Не действует» в матрице правил; сами связи убирает миграция "
            "005_drop_exceptions.cypher.",
            items=[scope_item(row) for row in exceptions],
        ))

    only_by_rule: dict[str, list[dict]] = {}
    for row in scope:
        if row["kind"] == "ONLY_IN":
            only_by_rule.setdefault(row["nodeId"], []).append(row)
    only_archived = [rows[0] for rows in only_by_rule.values()
                     if all(r["departmentStatus"] == "archived" for r in rows)]
    if only_archived:
        issues.append(_issue(
            "rules_only_in_archived_departments", WARNING,
            "Правила, ограниченные только архивными подразделениями",
            "Правило действует только в подразделениях, которые все в архиве. "
            "Для действующих подразделений оно не применяется никогда.",
            items=[{"label": row["rule"], "nodeId": row["nodeId"], "kind": "Rule"}
                   for row in only_archived],
        ))

    departments_without_id = _run(Q_DEPARTMENTS_WITHOUT_ID)
    if departments_without_id:
        issues.append(_issue(
            "departments_without_id", WARNING,
            "Подразделения без идентификатора",
            "Идентификатор подразделения приходит из кадровой системы в запросе проверки. Без него "
            "на подразделение нельзя сослаться: его цели проверяются по всем правилам, а в резервную "
            "копию каталога оно не попадает. Автоматически идентификатор не проставляется.",
            items=[{"label": d["label"], "nodeId": d["nodeId"], "kind": "Department"}
                   for d in departments_without_id],
        ))

    # Должностные инструкции: без них правило проверить нечем
    without_jobs = _run(Q_DEPARTMENTS_WITHOUT_JOB_DESCRIPTIONS)
    if without_jobs:
        issues.append(_issue(
            "departments_without_job_descriptions", WARNING,
            "Подразделения без должностных инструкций",
            "В подразделении действует правило, которое сравнивает цель с должностными "
            "инструкциями (" + ", ".join(r["rule"] for r in _run(Q_JOB_RULES)) + "), "
            "но инструкции не загружены. Сравнивать не с чем, поэтому цели этих "
            "подразделений не разрешаются автоматически и уходят на ручную проверку.",
            items=[{"label": d["label"], "nodeId": d["nodeId"], "kind": "Department"}
                   for d in without_jobs],
        ))

    job_duties = _run(Q_JOB_DUTIES)
    no_duties = [row for row in job_duties if not row["duties"]]
    if no_duties:
        issues.append(_issue(
            "job_descriptions_without_duties", WARNING,
            "Должностные инструкции без списка обязанностей",
            "Список обязанностей не выписан — модель не ответила при загрузке. Цель "
            "сравнивается с полным текстом инструкции: это медленнее, а длинный текст "
            "сравнивается не целиком. Откройте инструкцию и извлеките обязанности заново.",
            items=[{"label": row["label"], "nodeId": row["nodeId"], "kind": "Department"}
                   for row in no_duties],
        ))
    unreviewed = [row for row in job_duties if row["duties"]]
    if unreviewed:
        issues.append(_issue(
            "job_duties_unreviewed", INFO,
            "Списки обязанностей, не проверенные редактором",
            "Список выписала модель, и он уже используется в проверках. Просмотрите его: "
            "пропущенная обязанность — это пропущенное нарушение.",
            items=[{"label": row["label"], "nodeId": row["nodeId"], "kind": "Department"}
                   for row in unreviewed],
        ))

    # Текстовые свойства не той формы: не строка или длиннее предела
    not_text, not_text_shown, too_long = [], [], []
    for row in _run(Q_TEXT_PROPERTIES, labels=sorted({label for label, _ in TEXT_LIMITS})):
        props = row["props"] or {}
        for name, value in props.items():
            limit = TEXT_LIMITS.get((row["kind"], name))
            if limit is None or value is None:
                continue
            item = {"label": f"{KIND_NAMES.get(row['kind'], row['kind'])} "
                             f"{_text(props.get('key')) or '(без ключа)'}: {name}",
                    "nodeId": row["nodeId"], "kind": row["kind"]}
            if not isinstance(value, str):
                (not_text if (row["kind"], name) in CHECK_TEXT_PROPERTIES else not_text_shown).append(item)
            elif len(value) > limit:
                too_long.append({**item, "label": f"{item['label']} — {len(value)} симв., предел {limit}"})
    if not_text:
        issues.append(_issue(
            "non_text_properties", ERROR,
            "Свойства проверки с нестроковым значением",
            "Имя или описание атрибута либо код подразделения хранится числом, true/false "
            "или списком. Проверка сравнивает их как текст: атрибут с таким именем не "
            "находится в цели, без описания модель его не распознаёт, подразделение с "
            "таким кодом не находится — цели проверяются неверно. Сохраните значение строкой.",
            items=not_text,
        ))
    if not_text_shown:
        issues.append(_issue(
            "non_text_display_properties", WARNING,
            "Текстовые свойства с нестроковым значением",
            "Номер или название приказа, текст пункта, описание правила, текст примера, "
            "название подразделения или инструкции хранится числом, true/false или списком. "
            "Проверку это не ломает (пример-список в промпт не попадает), но в ответах и "
            "в интерфейсе значение показывается не так. Сохраните значение строкой.",
            items=not_text_shown,
        ))
    if too_long:
        issues.append(_issue(
            "too_long_texts", WARNING,
            "Слишком длинные тексты",
            "Текст длиннее предела, который действует при создании и правке. Описания и "
            "примеры целиком уходят в промпт модели: слишком длинный текст переполняет её "
            "окно, и все цели уходят на ручную проверку. Сократите текст.",
            items=too_long,
        ))

    # Справка про архив
    archived = _run(Q_ARCHIVED)
    if archived:
        issues.append(_issue(
            "archived_nodes", INFO,
            "В архиве",
            "Архивные узлы не участвуют в проверках, но остаются в графе "
            "и попадают в резервную копию каталога.",
            items=[{"label": f"{KIND_NAMES.get(row['kind'], row['kind'])}: {row['total']}"}
                   for row in archived],
        ))

    errors = [i for i in issues if i["severity"] == ERROR]
    return {
        "issues": issues,
        "counts": {
            "error": len(errors),
            "warning": len([i for i in issues if i["severity"] == WARNING]),
            "info": len([i for i in issues if i["severity"] == INFO]),
        },
        "check_targets": len(active_targets),
        "ready": not errors,
        # Плоский список строк — для /ready и логов
        "problems": [f"{i['title']}: " + ", ".join(x["label"] for x in i["items"])
                     if i["items"] else i["title"] for i in errors],
    }
