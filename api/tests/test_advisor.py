"""Тесты советчика по графу. Neo4j и LLM подменяются."""

import json

import pytest
from fastapi.testclient import TestClient

import advisor
import agent
import auth
import graph
import main
import metrics

TARGETS = [
    {"name": "проект", "description": "проект", "source": None},
    {"name": "срок_исполнения", "description": "дата", "source": None},
    {"name": "должностные_обязанности", "description": "дублирует обязанность",
     "source": graph.JOB_SOURCE},
]

GOAL = "Сдать отчёт во втором квартале"


def rule(n=1, rule_type="REQUIREMENT", targets=1):
    return {"node_id": "4:db:7", "rule_node_id": f"4:db:10{n}", "rule_id": f"R-{n}",
            "rule_type": rule_type, "rule_text": "Цель обязана содержать срок", "targets": targets}


def example(text, is_violation, rule_type="REQUIREMENT", targets=("срок_исполнения",)):
    return {"text": text, "is_violation": is_violation, "rule_type": rule_type, "targets": list(targets)}


@pytest.fixture
def world(monkeypatch):
    """Граф и модель.

    Классификатор находит атрибут, когда в тексте есть слово из его описания
    (слова разделены запятой). Советчик отвечает описаниями из proposals по очереди.
    """
    state = {"rules": [rule()], "examples": [], "proposals": [], "asked": [], "extracted": []}

    def extract(text, targets, examples=None, holdout=False):
        state["extracted"].append((text, holdout))
        assert all(t.get("source") != graph.JOB_SOURCE for t in targets), \
            "«инструкционные» атрибуты в промпт извлечения не попадают"
        found = [t["name"] for t in targets
                 if any(word.strip() and word.strip() in text.lower() for word in t["description"].split(","))]
        return agent.Extraction(found, quotes={name: "цитата" for name in found})

    def ask(prompt, schema=None, max_tokens=None, system=None):
        state["asked"].append({"prompt": prompt, "system": system})
        answer = state["proposals"].pop(0)
        if isinstance(answer, Exception):
            raise answer
        return json.dumps({"diagnosis": "в описании нет квартала", "description": answer})

    monkeypatch.setattr(advisor, "get_check_targets", lambda: TARGETS)
    monkeypatch.setattr(advisor, "get_target_rules", lambda name: state["rules"])
    monkeypatch.setattr(advisor, "get_rule_examples", lambda: state["examples"])
    monkeypatch.setattr(agent, "extract_attributes", extract)
    monkeypatch.setattr(agent, "ask_model", ask)
    return state


def advise(expected=True, attribute="срок_исполнения", goal=GOAL, **kwargs):
    return advisor.advise(goal, attribute, expected, "квартал — это срок", login="tester", **kwargs)


# ------------------------------ предложение ---------------------------------


def test_verified_proposal(world):
    world["proposals"] = ["дата, квартал"]
    result = advise()
    assert result["attribute"] == "срок_исполнения" and result["nodeId"] == "4:db:7"
    assert result["current"] == {"present": False, "evidence": None}
    assert result["already"] is False
    assert result["diagnosis"] == "в описании нет квартала"
    assert result["description"] == {"old": "дата", "new": "дата, квартал", "verified": True, "attempts": 1}
    assert result["regression"] == {"checked": 0, "broken": [], "alreadyWrong": 0, "failed": 0}

    asked = world["asked"][0]
    assert "квартал — это срок" in asked["prompt"] and GOAL in asked["prompt"]
    assert "Ответ классификатора сейчас: атрибут не найден" in asked["prompt"]
    assert "Ожидание редактора: атрибут найден" in asked["prompt"]
    assert GOAL not in asked["system"], "цель и обоснование — данные, а не инструкции"


def test_nothing_to_change_when_model_already_agrees(world):
    result = advise(goal="Сдать отчёт, дата 01.03.2026")
    assert result["already"] is True and result["description"] is None
    assert result["current"] == {"present": True, "evidence": "цитата"}
    assert result["notes"] == [advisor.ALREADY_NOTE]
    assert world["asked"] == [], "модель уже отвечает как нужно — советчика не спрашиваем"


def test_failed_attempt_is_reported_to_the_next_one(world):
    world["proposals"] = ["дата, месяц", "дата, квартал"]
    result = advise()
    assert result["description"]["verified"] is True and result["description"]["attempts"] == 2
    assert result["description"]["new"] == "дата, квартал"
    assert "Уже пробовали" not in world["asked"][0]["prompt"]
    assert "Уже пробовали описание «дата, месяц» — не помогло" in world["asked"][1]["prompt"]


def test_unverified_proposal_is_not_checked_on_examples(world):
    world["proposals"] = ["дата, месяц"] * advisor.ADVICE_MAX_ATTEMPTS
    world["examples"] = [example("Сдать отчёт, дата 01.03.2026", False)]
    result = advise()
    assert result["description"]["verified"] is False
    assert result["description"]["attempts"] == advisor.ADVICE_MAX_ATTEMPTS
    assert result["regression"] is None
    assert advisor.NOT_VERIFIED_NOTE in result["notes"]


def test_unchanged_description_is_not_sent_to_the_model_again(world):
    world["proposals"] = ["дата"] * advisor.ADVICE_MAX_ATTEMPTS
    assert advise()["description"]["verified"] is False
    assert [text for text, _ in world["extracted"]] == [GOAL], "то же описание даст тот же ответ"


def test_removing_an_attribute(world):
    """Обратный случай: атрибут найден, а не должен был."""
    world["proposals"] = ["число"]
    result = advise(expected=False, goal="Сдать отчёт, дата не определена")
    assert result["current"]["present"] is True
    assert result["description"]["verified"] is True
    assert "Ожидание редактора: атрибут не найден" in world["asked"][0]["prompt"]


def test_name_is_matched_regardless_of_spelling(world):
    world["proposals"] = ["дата, квартал"]
    assert advise(attribute="Срок исполнения")["attribute"] == "срок_исполнения"


# ------------------------- примеры каталога ---------------------------------


def test_regression_on_catalog_examples(world):
    world["proposals"] = ["квартал"]  # нужный ответ на цели, но даты распознаваться перестают
    world["examples"] = [
        example("Сдать отчёт, дата 01.03.2026", False),      # был верен — сломан
        example("Закрыть этап в третьем квартале", False),   # раньше модель ошибалась — исправлен
        example("Сделать когда-нибудь", True),               # атрибута нет — так и осталось
        example("Сделать в срок", False),                    # модель ошибалась и раньше
        example("Проект и дата", False, targets=("проект", "срок_исполнения")),
        example("Без проекта и даты", True, targets=("проект", "срок_исполнения")),  # неоднозначен
    ]
    result = advise()
    assert result["regression"] == {
        "checked": 5, "alreadyWrong": 1, "failed": 0,
        "broken": [{"text": "Сдать отчёт, дата 01.03.2026", "expected": True},
                   {"text": "Проект и дата", "expected": True}],
    }
    checks = [(text, holdout) for text, holdout in world["extracted"] if text != GOAL]
    assert checks and all(holdout for _, holdout in checks), \
        "проверяемый пример не должен попадать в свой же промпт"
    assert "Примеры каталога, где атрибут есть" in world["asked"][0]["prompt"]
    assert metrics.snapshot()["checks"]["batches"] == [], "пакет из мониторинга уходит"


def test_regression_batch_is_attributed_to_the_editor(world, monkeypatch):
    """Пакет советчика — того, кто спросил, а не того, чья проверка была в потоке раньше (L29)."""
    seen = []
    real = metrics.start_batch
    monkeypatch.setattr(metrics, "start_batch", lambda *a, **k: seen.append(real(*a, **k)) or seen[-1])
    world["proposals"] = ["дата, квартал"]
    world["examples"] = [example("Сдать отчёт, дата 01.03.2026", False), example("Сделать когда-нибудь", True)]
    metrics.set_actor("hr-system")
    try:
        advise()
    finally:
        metrics.set_actor(None)
    [batch] = seen
    assert batch.login == "tester"
    assert (batch.done, batch.running) == (2, 0)


def test_goal_itself_is_not_a_regression_example(world):
    world["proposals"] = ["дата, квартал"]
    world["examples"] = [example(GOAL, False)]
    result = advise()
    assert result["regression"]["checked"] == 0
    assert result["examples"] == [], "цель уже есть среди примеров с нужной пометкой"


def test_goal_marked_the_opposite_way_in_catalog(world):
    world["proposals"] = ["дата, квартал"]
    world["examples"] = [example(GOAL, True)]
    assert any("Каталог считает эту цель примером обратного" in note for note in advise()["notes"])


def test_model_failure_on_example_is_counted(world, monkeypatch):
    world["proposals"] = ["дата, квартал"]
    world["examples"] = [example("Сдать отчёт, дата 01.03.2026", False)]
    extract = agent.extract_attributes

    def flaky(text, targets, examples=None, holdout=False):
        if holdout:
            raise agent.ExtractionError("таймаут")
        return extract(text, targets, examples, holdout)

    monkeypatch.setattr(agent, "extract_attributes", flaky)
    assert advise()["regression"] == {"checked": 1, "broken": [], "alreadyWrong": 0, "failed": 1}


@pytest.mark.parametrize("rule_type, expected, is_violation", [
    # Требование нарушено, когда атрибута нет; запрет — когда он есть.
    ("REQUIREMENT", True, False),
    ("REQUIREMENT", False, True),
    ("PROHIBITION", True, True),
    ("PROHIBITION", False, False),
])
def test_example_options(rule_type, expected, is_violation):
    options = advisor.example_options([rule(1, rule_type), rule(2, rule_type, targets=2)], expected)
    assert [(o["ruleNodeId"], o["isViolation"]) for o in options] == [("4:db:101", is_violation)]


def test_example_options_for_attribute_without_rules():
    assert advisor.example_options([{"node_id": "4:db:7", "rule_node_id": None, "rule_id": None,
                                     "rule_type": None, "rule_text": None, "targets": 0}], True) == []


def test_examples_are_offered_with_a_note_while_setting_is_off(world):
    world["proposals"] = ["дата, квартал"]
    result = advise()
    assert [o["ruleId"] for o in result["examples"]] == ["R-1"]
    assert result["examplesInPrompt"] is False and advisor.EXAMPLES_OFF_NOTE in result["notes"]


# --------------------- атрибут по должностным инструкциям -------------------


@pytest.fixture
def job_world(world, monkeypatch):
    monkeypatch.setattr(advisor, "get_departments",
                        lambda: {"UCT": {"id": "UCT", "name": "УЦТ", "status": "active"}})
    monkeypatch.setattr(advisor, "get_job_descriptions", lambda department_id: [
        {"id": "JD-1", "title": "Инженер", "text": "", "duties": ["готовить отчёты"]}])

    def compare(goal, criterion, descriptions):
        return [{"job_description_id": "JD-1", "title": "Инженер", "duty": "готовить отчёты"}] \
            if "строго" not in criterion else None

    monkeypatch.setattr(agent, "compare_with_job_descriptions", compare)
    return world


def test_job_attribute_needs_a_department(job_world):
    with pytest.raises(advisor.catalog.Conflict, match="укажите подразделение"):
        advise(expected=False, attribute="должностные_обязанности")


def test_job_attribute_is_checked_against_job_descriptions(job_world):
    job_world["proposals"] = ["строго дословное совпадение"]
    result = advise(expected=False, attribute="должностные_обязанности", department_id="UCT")
    assert result["current"] == {"present": True, "evidence": "готовить отчёты"}
    assert result["description"]["verified"] is True
    assert result["regression"] is None and result["examples"] == []
    assert "должностными инструкциями" in job_world["asked"][0]["system"]
    assert job_world["extracted"] == []


# ------------------------------- маршруты -----------------------------------

BODY = {"goal": GOAL, "attribute": "срок_исполнения", "expected": True, "reason": "квартал — это срок"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    role = {"value": "editor"}
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("tester", role["value"])
    with TestClient(main.app, headers={"X-Requested-With": "XMLHttpRequest"}) as c:
        c.role = role
        yield c
    main.app.dependency_overrides.clear()


def test_route(client, world):
    world["proposals"] = ["дата, квартал"]
    generation = metrics.results.generation
    response = client.post("/catalog/advice", json=BODY)
    assert response.status_code == 200
    assert response.json()["description"]["new"] == "дата, квартал"
    assert metrics.results.generation == generation, "советчик каталог не меняет и кэш не сбрасывает"


def test_route_errors(client, world):
    assert client.post("/catalog/advice", json={**BODY, "attribute": "бюджет"}).status_code == 404
    assert client.post("/catalog/advice", json={**BODY, "reason": ""}).status_code == 422
    world["proposals"] = [agent.ExtractionError("модель недоступна")]
    response = client.post("/catalog/advice", json=BODY)
    assert response.status_code == 503 and "Модель не ответила" in response.json()["detail"]


def test_route_queue_timeout_is_503(client, world, monkeypatch):
    def busy(*a, **k):
        raise metrics.QueueTimeout(120)

    monkeypatch.setattr(agent, "extract_attributes", busy)
    response = client.post("/catalog/advice", json=BODY)
    assert response.status_code == 503 and response.headers["Retry-After"]


def test_viewer_cannot_ask(client):
    client.role["value"] = "viewer"
    assert client.post("/catalog/advice", json=BODY).status_code == 403
