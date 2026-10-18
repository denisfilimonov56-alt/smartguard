"""Проверка примеров правил на модели: узнаёт ли она то, что каталог считает образцом.

У примера ответ известен заранее: на примере нарушения правило должно
сработать, на корректном — нет. Каждый текст примера уходит в модель тем же
промптом, что и настоящая цель, и ответ сравнивается с этим ожиданием.
Если включены примеры в промпте (настройка promptExamples), проверяемый
пример из них исключается: модель не должна видеть ответ.
Расхождение — это неточное описание атрибута, неверно помеченный пример или
предел модели; во всех трёх случаях настоящие цели проверяются так же неверно.

Прогон идёт в фоне и на вердикты не влияет: в историю и кэш проверок не
попадает, слоты ручных проверок не занимает, /ready от него не зависит.
Результат живёт в памяти процесса и после правки каталога помечается
устаревшим.

Примеры правил на атрибутах, определяемых по должностным инструкциям,
пропускаются: такому сравнению нужно подразделение, а у примера его нет.
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

from fastapi import APIRouter, Depends

import agent
import auth
import metrics
from graph import ACTIVE, JOB_SOURCE, get_check_targets, get_driver

log = logging.getLogger(__name__)

# Отдельно от routes.router: тот после любого изменяющего запроса сбрасывает
# кэш проверок, а прогон каталог не меняет.
router = APIRouter(prefix="/catalog/examples-check", tags=["catalog"],
                   dependencies=[Depends(auth.viewer)])

MATCHED, MISMATCHED, FAILED, SKIPPED = "matched", "mismatched", "failed", "skipped"
ORDER = {MISMATCHED: 0, FAILED: 1, SKIPPED: 2}
# Столько сбоев подряд — модель недоступна: остальные примеры не отправляются,
# иначе прогон ждал бы таймаут на каждом.
GIVE_UP_AFTER = 5
BATCH_ID = "examples"

Q_EXAMPLES = f"""
MATCH (o:Order)-[:CONTAINS]->(c:Clause)
      -[:DEFINES]->(r:Rule)
      -[:HAS_EXAMPLE]->(e:ViolationExample)
WHERE {ACTIVE.format('o')}
  AND {ACTIVE.format('c')}
  AND {ACTIVE.format('r')}
  AND {ACTIVE.format('e')}
  AND trim(coalesce(e.text, '')) <> ''
OPTIONAL MATCH (r)-[:APPLIES_TO]->(t:CheckTarget)
WHERE {ACTIVE.format('t')}
RETURN elementId(e)                   AS nodeId,
       e.exampleId                    AS example_id,
       e.text                         AS text,
       coalesce(e.isViolation, false) AS is_violation,
       elementId(r)                   AS rule_node_id,
       r.ruleId                       AS rule_id,
       r.type                         AS rule_type,
       r.description                  AS rule_text,
       o.number                       AS order_number,
       c.code                         AS clause_code,
       collect(DISTINCT t.name)       AS targets,
       collect(DISTINCT CASE WHEN t.source = '{JOB_SOURCE}' THEN t.name END) AS job_targets
ORDER BY order_number, clause_code, rule_id, example_id
"""


def _examples() -> list[dict[str, Any]]:
    with get_driver().session() as session:
        return [dict(record) for record in session.run(Q_EXAMPLES)]


def judge(rule_type: str, is_violation: bool, targets: list[str],
          detected: list[str]) -> dict[str, Any]:
    """Сравнивает ответ модели с пометкой примера.

    Требование срабатывает, когда не найден хотя бы один его атрибут,
    запрет — когда найден хотя бы один. Пример нарушения ждёт срабатывания,
    корректный — нет.
    """
    found = [t for t in targets if t in detected]
    missing = [t for t in targets if t not in detected]
    fires = bool(found) if rule_type == "PROHIBITION" else bool(missing)
    return {"outcome": MATCHED if fires == bool(is_violation) else MISMATCHED,
            "found": found, "missing": missing}


def skip_reason(row: dict[str, Any]) -> Optional[str]:
    """Почему пример нельзя проверить одним текстом; None — можно."""
    if not row["targets"]:
        return "У правила нет действующих атрибутов"
    if row["rule_type"] not in ("PROHIBITION", "REQUIREMENT"):
        return f"Неизвестный тип правила: {row['rule_type']!r}"
    if row["job_targets"]:
        return ("Атрибут определяется по должностным инструкциям подразделения, "
                "а у примера подразделения нет")
    return None


def _item(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "nodeId": row["nodeId"], "exampleId": row["example_id"], "text": row["text"],
        "isViolation": bool(row["is_violation"]),
        "ruleNodeId": row["rule_node_id"], "ruleId": row["rule_id"],
        "ruleType": row["rule_type"], "ruleText": row["rule_text"],
        "order": row["order_number"], "clause": row["clause_code"],
        "targets": row["targets"],
        "outcome": None, "found": [], "missing": [], "reason": None,
    }


# --------------------------------------------------------------------------
#  Состояние прогона
# --------------------------------------------------------------------------


def _blank() -> dict[str, Any]:
    return {
        "state": "idle", "startedAt": None, "finishedAt": None, "startedBy": None,
        "total": 0, "done": 0, "error": None,
        "counts": {MATCHED: 0, MISMATCHED: 0, FAILED: 0, SKIPPED: 0},
        "items": [], "generation": None,
    }


_lock = threading.Lock()
_state: dict[str, Any] = _blank()
_thread: Optional[threading.Thread] = None


def status() -> dict[str, Any]:
    """Ход и результат последнего прогона. items — всё, кроме совпавших примеров."""
    with _lock:
        state = dict(_state)
    generation = state.pop("generation")
    # Правка каталога через API сбрасывает кэш проверок — по этому и видно, что каталог уже другой.
    state["stale"] = state["state"] == "done" and generation != metrics.results.generation
    return state


def start(login: Optional[str]) -> bool:
    """Запускает прогон в фоне. False — прогон уже идёт."""
    global _state, _thread
    with _lock:
        if _state["state"] == "running":
            return False
        _state = {**_blank(), "state": "running", "startedAt": metrics.now_iso(),
                  "startedBy": login, "generation": metrics.results.generation}
        _thread = threading.Thread(target=_run, args=(login,), name="examples-check", daemon=True)
        _thread.start()
    return True


def wait(timeout: Optional[float] = None) -> None:
    """Дождаться конца прогона (для тестов)."""
    if _thread is not None:
        _thread.join(timeout)


def reset() -> None:
    """Для тестов: чистое состояние."""
    global _state
    wait()
    with _lock:
        _state = _blank()


def _update(**changes: Any) -> None:
    with _lock:
        _state.update(changes)


def _run(login: Optional[str]) -> None:
    try:
        items = _check(login)
    except Exception as exc:  # noqa: BLE001 — чаще всего недоступная база
        log.exception("Проверка примеров не выполнена")
        _update(state="failed", error=str(exc), finishedAt=metrics.now_iso())
        return
    counts = {outcome: sum(1 for i in items if i["outcome"] == outcome)
              for outcome in (MATCHED, MISMATCHED, FAILED, SKIPPED)}
    rest = [i for i in items if i["outcome"] != MATCHED]
    rest.sort(key=lambda i: ORDER[i["outcome"]])
    log.info("Проверка примеров завершена: %s", counts)
    _update(state="done", counts=counts, items=rest, finishedAt=metrics.now_iso())


def _check(login: Optional[str]) -> list[dict[str, Any]]:
    items = []
    by_text: dict[str, list[dict[str, Any]]] = {}
    for row in _examples():
        item = _item(row)
        items.append(item)
        reason = skip_reason(row)
        if reason:
            item.update(outcome=SKIPPED, reason=reason)
        else:
            # Один текст может быть примером нескольких правил: модель спрашиваем раз.
            by_text.setdefault(row["text"].strip(), []).append(item)
    if not by_text:
        return items

    # Тот же словарь, что уходит в промпт настоящей проверки.
    targets = [t for t in get_check_targets() if t.get("source") != JOB_SOURCE]
    examples = agent.prompt_examples()
    _update(total=sum(len(group) for group in by_text.values()))

    metrics.set_actor(login)
    # Пакет виден в мониторинге и ставит запросы в общую очередь, мимо резерва ручных проверок.
    batch = metrics.start_batch(BATCH_ID, len(by_text))
    failures = 0
    gave_up = threading.Event()

    def ask(text: str) -> list[str] | agent.ExtractionError:
        nonlocal failures
        metrics.set_actor(login, batch)  # поток пула: контекст вызвавшего сюда не доходит
        if gave_up.is_set():
            return agent.ExtractionError("прогон остановлен: модель не отвечает")
        try:
            # holdout: сам пример из примеров в промпте убирается — иначе модель видела бы ответ.
            answer: list[str] | agent.ExtractionError = agent.extract_attributes(
                text, targets, examples, holdout=True).attributes
        except agent.ExtractionError as exc:
            answer = exc
        with _lock:
            failures = failures + 1 if isinstance(answer, agent.ExtractionError) else 0
            if failures >= GIVE_UP_AFTER:
                gave_up.set()
            _state["done"] += len(by_text[text])
        metrics.batch_step(batch)
        return answer

    try:
        with ThreadPoolExecutor(max_workers=min(agent.BULK_MAX_WORKERS, len(by_text)),
                                thread_name_prefix="examples-check") as pool:
            answers = list(pool.map(ask, by_text))
    finally:
        metrics.finish_batch(batch)
        metrics.set_actor(None)

    for group, answer in zip(by_text.values(), answers):
        for item in group:
            if isinstance(answer, agent.ExtractionError):
                item.update(outcome=FAILED, reason=str(answer))
            else:
                item.update(judge(item["ruleType"], item["isViolation"], item["targets"], answer))
    return items


# --------------------------------------------------------------------------
#  Маршруты
# --------------------------------------------------------------------------


@router.get("")
def get_examples_check():
    """Ход и результат последней проверки примеров."""
    return status()


@router.post("", status_code=202)
def post_examples_check(user: auth.Principal = Depends(auth.editor)):
    """Запустить проверку примеров на модели; если она уже идёт — вернуть её ход."""
    start(user.login)
    return status()
