"""Доступ к графу нормативных требований в Neo4j.

Драйвер создаётся лениво и закрывается на shutdown приложения
(см. lifespan в main.py), чтобы соединения не текли между перезапусками.
"""

import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
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

# Правила только для студентов — свойство правила: Rule.studentsOnly = true.
# Такое правило проверяется, только если цель ставит студент ($is_student = true).
# $is_student = null означает «признак не передан»: тогда применяются все
# правила — тот же отказ в сторону строгости, что и для подразделения.
FOR_AUDIENCE = """(coalesce($is_student, true) OR NOT coalesce(r.studentsOnly, false))"""

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
  AND {FOR_AUDIENCE}
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
  AND {FOR_AUDIENCE}
OPTIONAL MATCH (r)-[:HAS_EXAMPLE]->(e:ViolationExample {{isViolation: true}})
WHERE {ACTIVE.format('e')}
RETURN o.number             AS order_number,
       o.title              AS order_title,
       c.code               AS clause_code,
       c.text               AS clause_text,
       r.ruleId             AS rule_id,
       elementId(r)         AS rule_node_id,
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
  AND {FOR_AUDIENCE}
OPTIONAL MATCH (r)-[:HAS_EXAMPLE]->(e:ViolationExample {{isViolation: false}})
WHERE {ACTIVE.format('e')}
RETURN o.number             AS order_number,
       o.title              AS order_title,
       c.code               AS clause_code,
       c.text               AS clause_text,
       r.ruleId             AS rule_id,
       elementId(r)         AS rule_node_id,
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


def get_job_rules(attributes: list[str], department_id: Optional[str] = None,
                  is_student: Optional[bool] = None) -> list[dict[str, Any]]:
    """Правила на атрибутах, определяемых по должностным инструкциям.

    Пустой список — для подразделения (и студента / не студента) таких правил
    нет, сравнивать незачем. is_student — см. find_violations.
    """
    with get_driver().session() as session:
        return [dict(record) for record in session.run(
            JOB_RULES_FOR_DEPARTMENT, attributes=attributes, department_id=department_id,
            is_student=is_student)]


def get_all_attributes() -> list[str]:
    """Только имена атрибутов (обратная совместимость)."""
    return [t["name"] for t in get_check_targets()]


def get_departments() -> dict[str, dict[str, str]]:
    """Справочник подразделений: {departmentId: {'id', 'name', 'status'}}."""
    with get_driver().session() as session:
        return {record["id"]: dict(record) for record in session.run(ALL_DEPARTMENTS)}


def find_violations(
    attributes: list[str], department_id: Optional[str] = None,
    is_student: Optional[bool] = None,
) -> list[dict[str, Any]]:
    """Все нарушения: сработавшие запреты + невыполненные требования.

    Оба набора результатов имеют одинаковый набор ключей; отличить их
    можно по violation_type и example_kind.

    department_id — подразделение, чья цель проверяется. None означает
    «неизвестно»: применяются все правила.
    is_student — ставит ли цель студент. False отключает правила
    с studentsOnly = true; None означает «не передано»: применяются все.
    """
    params = {"attributes": attributes, "department_id": department_id,
              "is_student": is_student}
    with get_driver().session() as session:
        prohibitions = [dict(r) for r in session.run(FIND_PROHIBITIONS, **params)]
        missing = [dict(r) for r in session.run(FIND_MISSING_REQUIREMENTS, **params)]
    log.debug(
        "Найдено нарушений: запретов=%d, невыполненных требований=%d",
        len(prohibitions),
        len(missing),
    )
    return prohibitions + missing


# Оценки по SMART хранятся в графе, чтобы пережить перезапуск API: одна
# формулировка — одна оценка. К каталогу узлы не относятся (как :Setting).
SMART_SCORE_GET = "MATCH (s:SmartScore {goalHash: $hash}) RETURN s.scores AS scores"
SMART_SCORE_PUT = """
MERGE (s:SmartScore {goalHash: $hash})
SET s.scores = $scores, s.updatedAt = $now
"""
# Уникальность goalHash: без неё одновременные MERGE одной формулировки
# создают двойники. Ограничение нельзя создать поверх обычного индекса на том
# же свойстве (его заводили прежние версии), поэтому индекс сначала убирается;
# если в базе уже есть двойники, остаётся обычный индекс.
SMART_SCORE_OLD_INDEX_DROP = "DROP INDEX smart_score_hash IF EXISTS"
SMART_SCORE_CONSTRAINT = """
CREATE CONSTRAINT smart_score_hash_unique IF NOT EXISTS
FOR (s:SmartScore) REQUIRE s.goalHash IS UNIQUE
"""
SMART_SCORE_INDEX = "CREATE INDEX smart_score_hash IF NOT EXISTS FOR (s:SmartScore) ON (s.goalHash)"
_smart_index_ready = False

# Оценки, которые давно не перезаписывались, удаляются (раз в сутки, в фоне):
# без этого узлы :SmartScore копятся с каждой новой формулировкой. 0 — хранить всегда.
SMART_SCORE_RETENTION_DAYS = max(0, int(os.getenv("SMART_SCORE_RETENTION_DAYS", "365")))
SMART_SCORE_PRUNE_INTERVAL = 24 * 3600
# Удаление порциями в отдельных транзакциях: одна транзакция на сотни тысяч
# узлов съела бы память Neo4j. Запускается только в авто-коммит сессии (session.run).
SMART_SCORE_BATCH = 10_000
SMART_SCORE_DELETE_ALL = f"""
MATCH (s:SmartScore)
CALL {{ WITH s DETACH DELETE s }} IN TRANSACTIONS OF {SMART_SCORE_BATCH} ROWS
"""
SMART_SCORE_DELETE_STALE = f"""
MATCH (s:SmartScore)
WHERE s.updatedAt IS NULL OR s.updatedAt < $cutoff
CALL {{ WITH s DETACH DELETE s }} IN TRANSACTIONS OF {SMART_SCORE_BATCH} ROWS
"""
_smart_pruned_at = 0.0
_smart_prune_lock = threading.Lock()


def get_smart_score(goal_hash: str) -> Optional[dict[str, Any]]:
    """Сохранённая оценка SMART по хэшу формулировки; None — её ещё нет."""
    with get_driver().session() as session:
        row = session.run(SMART_SCORE_GET, hash=goal_hash).single()
    return json.loads(row["scores"]) if row and row["scores"] else None


# Схему :SmartScore создаёт один поток: одновременные первые записи оценок
# иначе наперегонки удаляли бы старый индекс и создавали ограничение.
_smart_schema_lock = threading.Lock()


def _ensure_smart_schema(session) -> None:
    global _smart_index_ready
    if _smart_index_ready:
        return
    with _smart_schema_lock:
        if _smart_index_ready:
            return
        session.run(SMART_SCORE_OLD_INDEX_DROP).consume()
        try:
            session.run(SMART_SCORE_CONSTRAINT).consume()
        except Exception as exc:  # noqa: BLE001 — двойники в базе: хотя бы индекс
            log.warning("Ограничение уникальности :SmartScore не создано, остаётся индекс: %s", exc)
            session.run(SMART_SCORE_INDEX).consume()
        _smart_index_ready = True


def save_smart_score(goal_hash: str, scores: dict[str, Any]) -> None:
    """Запоминает оценку SMART; повторная запись той же формулировки её заменяет.

    Раз в сутки заодно запускает в фоне удаление устаревших оценок.
    """
    with get_driver().session() as session:
        _ensure_smart_schema(session)
        session.run(SMART_SCORE_PUT, hash=goal_hash, scores=json.dumps(scores, ensure_ascii=False),
                    now=datetime.now(timezone.utc).isoformat(timespec="seconds")).consume()
    _schedule_smart_prune()


def _schedule_smart_prune() -> None:
    global _smart_pruned_at
    if not SMART_SCORE_RETENTION_DAYS:
        return
    with _smart_prune_lock:
        if time.monotonic() - _smart_pruned_at < SMART_SCORE_PRUNE_INTERVAL and _smart_pruned_at:
            return
        _smart_pruned_at = time.monotonic()
    threading.Thread(target=_prune_quietly, name="smart-prune", daemon=True).start()


def _prune_quietly() -> None:
    try:
        removed = prune_smart_scores(SMART_SCORE_RETENTION_DAYS)
        if removed:
            log.info("Удалено устаревших оценок SMART: %d", removed)
    except Exception as exc:  # noqa: BLE001 — очистка не обязательна, повторится завтра
        log.warning("Устаревшие оценки SMART не удалены: %s", exc)


def prune_smart_scores(days: int) -> int:
    """Удаляет оценки SMART, не обновлявшиеся дольше days дней. Возвращает, сколько удалено."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
    with get_driver().session() as session:
        summary = session.run(SMART_SCORE_DELETE_STALE, cutoff=cutoff).consume()
    return summary.counters.nodes_deleted


def delete_smart_scores() -> int:
    """Удаляет все сохранённые оценки SMART: следующая проверка каждой формулировки спросит модель заново.
    Возвращает, сколько оценок удалено."""
    with get_driver().session() as session:
        summary = session.run(SMART_SCORE_DELETE_ALL).consume()
    return summary.counters.nodes_deleted
