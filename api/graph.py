"""Доступ к графу нормативных требований в Neo4j.

Драйвер создаётся лениво и закрывается на shutdown приложения
(см. lifespan в main.py), чтобы соединения не текли между перезапусками.
"""

import logging
import os
from typing import Any, Optional

from neo4j import Driver, GraphDatabase

log = logging.getLogger(__name__)

_driver: Optional[Driver] = None


def get_driver() -> Driver:
    """Ленивая инициализация драйвера (потокобезопасна на уровне neo4j-драйвера)."""
    global _driver
    if _driver is None:
        uri = os.getenv("NEO4J_URI", "bolt://neo4j:7687")
        user = os.getenv("NEO4J_USER", "neo4j")
        password = os.getenv("NEO4J_PASSWORD", "password123")
        log.info("Инициализация драйвера Neo4j: %s", uri)
        _driver = GraphDatabase.driver(
            uri,
            auth=(user, password),
            max_connection_lifetime=3600,
            connection_acquisition_timeout=30,
        )
    return _driver


def close_driver() -> None:
    """Закрывает драйвер. Вызывается при остановке приложения."""
    global _driver
    if _driver is not None:
        log.info("Закрытие драйвера Neo4j")
        _driver.close()
        _driver = None


def verify_connectivity() -> bool:
    """Проверка доступности Neo4j. Не бросает исключений."""
    try:
        get_driver().verify_connectivity()
        return True
    except Exception as exc:  # noqa: BLE001 — здесь нужен именно широкий перехват
        log.warning("Neo4j недоступен: %s", exc)
        return False


# --------------------------------------------------------------------------
#  Cypher-запросы
# --------------------------------------------------------------------------

# Словарь проверяемых атрибутов. description идёт в промпт агента,
# поэтому единственный источник истины по атрибутам — граф, а не код.
# Архивирование — мягкое удаление: узел остаётся в графе, но выпадает из
# проверок. coalesce нужен для узлов, заведённых до появления status.
ACTIVE = "coalesce({0}.status, 'active') = 'active'"

# Разграничение по подразделениям — часть приказа, поэтому оно в графе:
#   (r:Rule)-[:ONLY_IN]->(d:Department)     правило действует только в перечисленных
# Правило без ONLY_IN действует для всех. $department_id = null означает
# «подразделение неизвестно»: тогда применяются все правила.
# Ограничение ONLY_IN учитывается независимо от статуса подразделения:
# архивирование подразделения не должно молча делать правило всеобщим.
FOR_DEPARTMENT = """($department_id IS NULL
       OR NOT (r)-[:ONLY_IN]->(:Department)
       OR (r)-[:ONLY_IN]->(:Department {departmentId: $department_id}))"""

ALL_DEPARTMENTS = """
MATCH (d:Department)
WHERE d.departmentId IS NOT NULL
RETURN d.departmentId AS id, d.name AS name, coalesce(d.status, 'active') AS status
ORDER BY id
"""

ALL_CHECK_TARGETS = f"""
MATCH (t:CheckTarget)
WHERE {ACTIVE.format('t')}
RETURN t.name AS name, coalesce(t.description, '') AS description, t.source AS source
ORDER BY name
"""

# Должностные инструкции подразделения:
#   (d:Department)-[:HAS_JOB_DESCRIPTION]->(j:JobDescription {{jobDescriptionId, title, text}})
# Атрибут с source = 'job_descriptions' определяется не по одному тексту цели,
# а сравнением цели с этими инструкциями (см. agent.check_job_targets).
JOB_SOURCE = "job_descriptions"

DEPARTMENT_JOB_DESCRIPTIONS = f"""
MATCH (:Department {{departmentId: $department_id}})-[:HAS_JOB_DESCRIPTION]->(j:JobDescription)
WHERE {ACTIVE.format('j')}
  AND (trim(coalesce(j.text, '')) <> '' OR size(coalesce(j.duties, [])) > 0)
RETURN j.jobDescriptionId AS id, coalesce(j.title, '') AS title,
       coalesce(j.text, '') AS text, coalesce(j.duties, []) AS duties
ORDER BY title, id
"""

# Какие правила на «инструкционных» атрибутах касаются подразделения.
JOB_RULES_FOR_DEPARTMENT = f"""
MATCH (o:Order)-[:CONTAINS]->(c:Clause)
      -[:DEFINES]->(r:Rule)
      -[:APPLIES_TO]->(t:CheckTarget)
WHERE t.name IN $attributes
  AND {ACTIVE.format('o')}
  AND {ACTIVE.format('c')}
  AND {ACTIVE.format('r')}
  AND {ACTIVE.format('t')}
  AND {FOR_DEPARTMENT}
RETURN t.name AS attribute, r.ruleId AS rule_id
"""

# Запрет нарушен, если атрибут ПРИСУТСТВУЕТ в цели.
FIND_PROHIBITIONS = f"""
MATCH (o:Order)-[:CONTAINS]->(c:Clause)
      -[:DEFINES]->(r:Rule)
      -[:APPLIES_TO]->(t:CheckTarget)
WHERE r.type = 'PROHIBITION'
  AND t.name IN $attributes
  AND {ACTIVE.format('o')}
  AND {ACTIVE.format('c')}
  AND {ACTIVE.format('r')}
  AND {ACTIVE.format('t')}
  AND {FOR_DEPARTMENT}
OPTIONAL MATCH (r)-[:HAS_EXAMPLE]->(e:ViolationExample {{isViolation: true}})
WHERE {ACTIVE.format('e')}
RETURN o.number             AS order_number,
       o.title              AS order_title,
       c.code               AS clause_code,
       c.text               AS clause_text,
       r.ruleId             AS rule_id,
       r.description        AS rule_text,
       r.checkInstruction   AS check_instruction,
       'PROHIBITION'        AS violation_type,
       t.name               AS attribute,
       'violation'          AS example_kind,
       collect(DISTINCT e.text) AS examples
ORDER BY order_number, clause_code, rule_id, attribute
"""

# Требование нарушено, если атрибут ОТСУТСТВУЕТ в цели.
FIND_MISSING_REQUIREMENTS = f"""
MATCH (o:Order)-[:CONTAINS]->(c:Clause)
      -[:DEFINES]->(r:Rule)
      -[:APPLIES_TO]->(t:CheckTarget)
WHERE r.type = 'REQUIREMENT'
  AND NOT t.name IN $attributes
  AND {ACTIVE.format('o')}
  AND {ACTIVE.format('c')}
  AND {ACTIVE.format('r')}
  AND {ACTIVE.format('t')}
  AND {FOR_DEPARTMENT}
OPTIONAL MATCH (r)-[:HAS_EXAMPLE]->(e:ViolationExample {{isViolation: false}})
WHERE {ACTIVE.format('e')}
RETURN o.number             AS order_number,
       o.title              AS order_title,
       c.code               AS clause_code,
       c.text               AS clause_text,
       r.ruleId             AS rule_id,
       r.description        AS rule_text,
       r.checkInstruction   AS check_instruction,
       'MISSING_REQUIREMENT' AS violation_type,
       t.name               AS attribute,
       'correct'            AS example_kind,
       collect(DISTINCT e.text) AS examples
ORDER BY order_number, clause_code, rule_id, attribute
"""

# Примеры правил для промпта извлечения (agent.attribute_examples).
RULE_EXAMPLES = f"""
MATCH (o:Order)-[:CONTAINS]->(c:Clause)
      -[:DEFINES]->(r:Rule)
      -[:HAS_EXAMPLE]->(e:ViolationExample)
WHERE {ACTIVE.format('o')}
  AND {ACTIVE.format('c')}
  AND {ACTIVE.format('r')}
  AND {ACTIVE.format('e')}
  AND trim(coalesce(e.text, '')) <> ''
MATCH (r)-[:APPLIES_TO]->(t:CheckTarget)
WHERE {ACTIVE.format('t')}
RETURN elementId(e)                   AS node_id,
       coalesce(e.exampleId, '')      AS example_id,
       e.text                         AS text,
       coalesce(e.isViolation, false) AS is_violation,
       r.type                         AS rule_type,
       collect(DISTINCT t.name)       AS targets
ORDER BY example_id, text
"""

# Правила атрибута для советчика (advisor.py): узел атрибута и действующие
# правила на нём. targets — сколько действующих атрибутов у правила: пример
# говорит про атрибут однозначно, только когда он у правила один.
TARGET_RULES = f"""
MATCH (t:CheckTarget {{name: $name}})
WHERE {ACTIVE.format('t')}
OPTIONAL MATCH (o:Order)-[:CONTAINS]->(c:Clause)
      -[:DEFINES]->(r:Rule)
      -[:APPLIES_TO]->(t)
WHERE {ACTIVE.format('o')}
  AND {ACTIVE.format('c')}
  AND {ACTIVE.format('r')}
OPTIONAL MATCH (r)-[:APPLIES_TO]->(other:CheckTarget)
WHERE {ACTIVE.format('other')}
RETURN elementId(t)          AS node_id,
       elementId(r)          AS rule_node_id,
       r.ruleId              AS rule_id,
       r.type                AS rule_type,
       r.description         AS rule_text,
       count(DISTINCT other) AS targets
ORDER BY rule_id
"""

GRAPH_OVERVIEW = """
MATCH (n)-[r]->(m)
RETURN n, r, m
LIMIT $limit
"""

# --- Диагностика целостности словаря атрибутов ---------------------------
# Уникальность CheckTarget.name не спасает от «срок исполнения» и
# «срок_исполнения» — для базы это разные строки. Такие двойники приводят
# к ложным нарушениям, поэтому их надо видеть явно, а не по симптомам.

DUPLICATE_CHECK_TARGETS = f"""
MATCH (t:CheckTarget)
WHERE {ACTIVE.format('t')}
WITH toLower(replace(replace(trim(t.name), ' ', '_'), '-', '_')) AS norm,
     collect(t.name) AS variants
WHERE size(variants) > 1
RETURN norm, variants
ORDER BY norm
"""

CHECK_TARGETS_WITHOUT_DESCRIPTION = f"""
MATCH (t:CheckTarget)
WHERE {ACTIVE.format('t')}
  AND (t.description IS NULL OR trim(t.description) = '')
RETURN t.name AS name
ORDER BY name
"""

ORPHAN_CHECK_TARGETS = f"""
MATCH (t:CheckTarget)
WHERE {ACTIVE.format('t')}
  AND NOT (:Rule)-[:APPLIES_TO]->(t)
RETURN t.name AS name
ORDER BY name
"""

RULES_WITHOUT_TARGET = f"""
MATCH (r:Rule)
WHERE {ACTIVE.format('r')}
  AND NOT (r)-[:APPLIES_TO]->(:CheckTarget)
RETURN r.ruleId AS rule_id
ORDER BY rule_id
"""


# --------------------------------------------------------------------------
#  Публичный API модуля
# --------------------------------------------------------------------------


def get_check_targets() -> list[dict[str, str]]:
    """Словарь проверяемых атрибутов: [{'name': ..., 'description': ..., 'source': ...}, ...]."""
    with get_driver().session() as session:
        return [dict(record) for record in session.run(ALL_CHECK_TARGETS)]


def get_rule_examples() -> list[dict[str, Any]]:
    """Действующие примеры правил с атрибутами их правил, в устойчивом порядке."""
    with get_driver().session() as session:
        return [dict(record) for record in session.run(RULE_EXAMPLES)]


def get_target_rules(name: str) -> list[dict[str, Any]]:
    """Узел атрибута и действующие правила на нём; пусто — такого атрибута нет.

    У атрибута без правил — одна строка с rule_node_id = None.
    """
    with get_driver().session() as session:
        return [dict(record) for record in session.run(TARGET_RULES, name=name)]


def get_job_descriptions(department_id: str) -> list[dict[str, str]]:
    """Действующие должностные инструкции подразделения: [{'id', 'title', 'text', 'duties'}].

    duties — список обязанностей, выписанный из текста при загрузке; пуст,
    если его ещё нет.
    """
    with get_driver().session() as session:
        return [dict(record) for record in
                session.run(DEPARTMENT_JOB_DESCRIPTIONS, department_id=department_id)]


def get_job_rules(attributes: list[str], department_id: Optional[str] = None) -> list[dict[str, Any]]:
    """Правила на атрибутах, определяемых по должностным инструкциям.

    Пустой список — для подразделения таких правил нет, сравнивать незачем.
    """
    with get_driver().session() as session:
        return [dict(record) for record in session.run(
            JOB_RULES_FOR_DEPARTMENT, attributes=attributes, department_id=department_id)]


def get_all_attributes() -> list[str]:
    """Только имена атрибутов (обратная совместимость)."""
    return [t["name"] for t in get_check_targets()]


def get_departments() -> dict[str, dict[str, str]]:
    """Справочник подразделений: {departmentId: {'id', 'name', 'status'}}."""
    with get_driver().session() as session:
        return {record["id"]: dict(record) for record in session.run(ALL_DEPARTMENTS)}


def find_violations(
    attributes: list[str], department_id: Optional[str] = None
) -> list[dict[str, Any]]:
    """Все нарушения: сработавшие запреты + невыполненные требования.

    Оба набора результатов имеют одинаковый набор ключей; отличить их
    можно по violation_type и example_kind.

    department_id — подразделение, чья цель проверяется. None означает
    «неизвестно»: применяются все правила.
    """
    params = {"attributes": attributes, "department_id": department_id}
    with get_driver().session() as session:
        prohibitions = [dict(r) for r in session.run(FIND_PROHIBITIONS, **params)]
        missing = [dict(r) for r in session.run(FIND_MISSING_REQUIREMENTS, **params)]
    log.debug(
        "Найдено нарушений: запретов=%d, невыполненных требований=%d",
        len(prohibitions),
        len(missing),
    )
    return prohibitions + missing


def diagnose() -> dict[str, Any]:
    """Проверка целостности словаря атрибутов и правил.

    Возвращает найденные проблемы: дубликаты написаний, атрибуты без
    описания (модель не получит по ним критерия и будет их пропускать),
    атрибуты без правил и правила без атрибутов.
    """
    with get_driver().session() as session:
        duplicates = [dict(r) for r in session.run(DUPLICATE_CHECK_TARGETS)]
        no_description = [r["name"] for r in session.run(CHECK_TARGETS_WITHOUT_DESCRIPTION)]
        orphan_targets = [r["name"] for r in session.run(ORPHAN_CHECK_TARGETS)]
        rules_without_target = [r["rule_id"] for r in session.run(RULES_WITHOUT_TARGET)]

    problems: list[str] = []
    for row in duplicates:
        problems.append(
            "Дубликаты атрибута, различающиеся написанием: "
            + ", ".join(f'"{v}"' for v in row["variants"])
        )
    if no_description:
        problems.append(
            "Атрибуты без описания (промпт останется без критерия, модель будет "
            "их пропускать): " + ", ".join(no_description)
        )
    if orphan_targets:
        problems.append("Атрибуты, к которым не привязано ни одного правила: "
                        + ", ".join(orphan_targets))
    if rules_without_target:
        problems.append("Правила без привязки к атрибуту (никогда не сработают): "
                        + ", ".join(rules_without_target))

    return {
        "duplicate_check_targets": duplicates,
        "check_targets_without_description": no_description,
        "orphan_check_targets": orphan_targets,
        "rules_without_target": rules_without_target,
        "problems": problems,
    }
