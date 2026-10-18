"""Тесты каталога: сборка дерева, адресация по nodeId, мягкое удаление.

Neo4j не нужен — низкоуровневые _run/_one подменяются диспетчером по тексту
запроса, поэтому проверяется логика, а не драйвер.
"""

import datetime

import pytest

import catalog
from catalog import Conflict, NotFound

ORDER_NODE = "4:db:1"
CLAUSE_NODE = "4:db:2"
RULE_NODE = "4:db:3"
EXAMPLE_NODE = "4:db:4"

FETCH = catalog.Q_FETCH_NODE
Q_TARGET_NAMES = "MATCH (t:CheckTarget) RETURN t.name AS name, elementId(t) AS nodeId"
Q_KNOWN_TARGETS = "MATCH (t:CheckTarget) WHERE t.name IN $names RETURN t.name AS name"
Q_TARGET_USAGE = ("MATCH (r:Rule)-[:APPLIES_TO]->(t) WHERE elementId(t) = $node_id "
                  "RETURN DISTINCT coalesce(r.ruleId, '(без ruleId)') AS rule_id")


@pytest.fixture
def db(monkeypatch):
    rows: dict[str, list[dict]] = {}
    calls: list[tuple[str, dict]] = []

    def fake_run(query, **params):
        calls.append((query, params))
        return rows.get(query, [])

    def fake_one(query, **params):
        result = fake_run(query, **params)
        return result[0] if result else None

    writes: list[int] = []

    def fake_write(work):
        # Транзакция записи: отмечаем, какие вызовы шли внутри неё.
        writes.append(len(calls))
        # Через catalog._run: тест может подменить его своим диспетчером.
        return work(lambda query, **params: catalog._run(query, **params))

    monkeypatch.setattr(catalog, "_run", fake_run)
    monkeypatch.setattr(catalog, "_one", fake_one)
    monkeypatch.setattr(catalog, "_write", fake_write)
    return type("DB", (), {"rows": rows, "calls": calls, "writes": writes})


def _exists(db, node_id, labels, **props):
    db.rows[FETCH] = db.rows.get(FETCH, []) + [
        {"labels": labels, "props": props, "nodeId": node_id}
    ]


# ------------------------------ slugify_id ----------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [("ПР-01", "пр_01"), ("3.1", "3.1"), ("  Раздел  IV ", "раздел_iv"), ("!!!", "id")],
)
def test_slugify(value, expected):
    assert catalog.slugify_id(value) == expected


# ------------------------------ build_tree ----------------------------------


def _seed(db, order_props=None, clause_props=None, rule_props=None):
    db.rows[catalog.Q_ORDERS] = [
        {"nodeId": ORDER_NODE, "props": order_props or {"number": "ПР-01", "status": "active"}},
    ]
    db.rows[catalog.Q_CLAUSES] = [
        {"parent": ORDER_NODE, "nodeId": CLAUSE_NODE,
         "props": clause_props or {"code": "1.1", "text": "текст"}},
    ]
    db.rows[catalog.Q_RULES] = [
        {"parent": CLAUSE_NODE, "nodeId": RULE_NODE,
         "props": rule_props or {"ruleId": "R-1.1", "type": "REQUIREMENT"}},
    ]
    db.rows[catalog.Q_RULE_TARGETS] = [{"parent": RULE_NODE, "name": "проект"}]
    db.rows[catalog.Q_EXAMPLES] = [
        {"parent": RULE_NODE, "nodeId": EXAMPLE_NODE,
         "props": {"exampleId": "EX-1", "text": "пример", "isViolation": False}}
    ]
    db.rows[catalog.Q_CLAUSE_REFS] = []
    return db


def test_tree_nests_and_carries_node_ids(db):
    """nodeId обязателен на каждом уровне: по нему интерфейс раскрывает карточки."""
    _seed(db)
    order = catalog.build_tree()["orders"][0]
    assert order["nodeId"] == ORDER_NODE
    clause = order["clauses"][0]
    assert clause["nodeId"] == CLAUSE_NODE
    rule = clause["rules"][0]
    assert rule["nodeId"] == RULE_NODE
    assert rule["targets"] == ["проект"]
    assert rule["examples"][0]["nodeId"] == EXAMPLE_NODE


def test_tree_works_without_business_keys(db):
    """Регрессия: у узлов может не быть orderId/clauseId — дерево всё равно строится."""
    _seed(db, order_props={"number": "ПР-01"}, clause_props={"code": "1.1", "text": "т"},
          rule_props={"type": "REQUIREMENT", "description": "п"})
    order = catalog.build_tree()["orders"][0]
    assert order["nodeId"] == ORDER_NODE
    assert "orderId" not in order
    assert order["status"] == "active", "узел без status считается активным"
    assert order["clauses"][0]["rules"][0]["nodeId"] == RULE_NODE


def test_tree_hides_archived_by_default(db):
    _seed(db, order_props={"number": "ПР-01", "status": "archived"})
    assert catalog.build_tree()["orders"] == []
    assert len(catalog.build_tree(include_archived=True)["orders"]) == 1


def test_tree_hides_archived_rule_and_example(db):
    _seed(db, rule_props={"ruleId": "R-1.1", "status": "archived"})
    assert catalog.build_tree()["orders"][0]["clauses"][0]["rules"] == []


def test_tree_serializes_temporal_values(db):
    class FakeDate:
        def __str__(self):
            return "2024-03-01"

    _seed(db, order_props={"number": "ПР-01", "date": FakeDate()})
    assert catalog.build_tree()["orders"][0]["date"] == "2024-03-01"


def test_tree_includes_clause_references(db):
    _seed(db)
    db.rows[catalog.Q_CLAUSE_REFS] = [
        {"parent": CLAUSE_NODE, "nodeId": "4:db:9", "code": "2.5"}
    ]
    refs = catalog.build_tree()["orders"][0]["clauses"][0]["references"]
    assert refs == [{"nodeId": "4:db:9", "code": "2.5"}]


def test_check_targets_list(db):
    db.rows[catalog.Q_TARGETS] = [
        {"nodeId": "4:db:7", "props": {"name": "проект"}, "rules": ["R-1.1", None]},
    ]
    target = catalog.list_check_targets()[0]
    assert target["nodeId"] == "4:db:7"
    assert target["description"] == ""
    assert target["rules"] == ["R-1.1"], "пустые значения из collect отфильтрованы"


# --------------------------- защита от двойников ----------------------------


@pytest.mark.parametrize("existing", ["срок исполнения", "Срок-Исполнения", "СРОК_ИСПОЛНЕНИЯ"])
def test_create_target_rejects_spelling_twin(db, existing):
    db.rows[Q_TARGET_NAMES] = [{"name": existing, "nodeId": "4:db:7"}]
    with pytest.raises(Conflict) as exc:
        catalog.create_check_target("срок_исполнения", "описание")
    assert existing in str(exc.value)


# ------------------------- правка произвольных свойств ----------------------


def test_properties_reject_status(db):
    _exists(db, ORDER_NODE, ["Order"], number="ПР-01")
    with pytest.raises(Conflict) as exc:
        catalog.update_properties(ORDER_NODE, {"status": "archived"})
    assert "отдельной операцией" in str(exc.value)


def test_properties_reject_empty_business_key(db):
    _exists(db, ORDER_NODE, ["Order"], orderId="PR-01")
    with pytest.raises(Conflict) as exc:
        catalog.update_properties(ORDER_NODE, {"orderId": ""})
    assert "нельзя очистить" in str(exc.value)


def test_properties_reject_duplicate_business_key(db):
    _exists(db, ORDER_NODE, ["Order"], orderId="PR-01")
    db.rows["MATCH (n:Order {orderId: $value}) WHERE elementId(n) <> $node_id "
            "RETURN elementId(n) AS nodeId"] = [{"nodeId": "4:db:99"}]
    with pytest.raises(Conflict) as exc:
        catalog.update_properties(ORDER_NODE, {"orderId": "PR-02"})
    assert "уже занят" in str(exc.value)


def test_properties_missing_node(db):
    with pytest.raises(NotFound):
        catalog.update_properties("4:db:404", {"title": "x"})


def test_properties_date_written_with_other_fields_in_one_query(db):
    """date проверяется в Python и пишется временным типом тем же SET n += $props."""
    _exists(db, ORDER_NODE, ["Order"], number="ПР-01")
    catalog.update_properties(ORDER_NODE, {"title": "новый", "date": "2024-03-01"})
    writes = [p for q, p in db.calls if "SET n += $props" in q]
    assert len(writes) == 1
    assert writes[0]["props"] == {"title": "новый", "date": datetime.date(2024, 3, 1)}
    catalog.update_properties(ORDER_NODE, {"date": ""})
    assert [p for q, p in db.calls if "SET n += $props" in q][-1]["props"] == {"date": None}


def test_properties_bad_date_writes_nothing(db):
    """Раньше остальные поля успевали сохраниться, а дата падала 500."""
    _exists(db, ORDER_NODE, ["Order"], number="ПР-01")
    with pytest.raises(Conflict) as exc:
        catalog.update_properties(ORDER_NODE, {"title": "новый", "date": "01.02.2024"})
    assert "ГГГГ-ММ-ДД" in str(exc.value)
    assert not any("SET n +=" in q for q, _ in db.calls)


@pytest.mark.parametrize("name", [
    "примечание автора", "a-b", "a.b", "1abc", "",
    "x = 1; MATCH (n) DETACH DELETE n; MATCH (z) SET z.q",
    "a = 1 MERGE (u:User {login:'me'}) SET u.role='admin' WITH n SET n.b",
])
def test_properties_reject_unsafe_names(db, name):
    """Имя свойства попадает в текст выгрузки seed — только буквы, цифры, подчёркивание."""
    _exists(db, ORDER_NODE, ["Order"], number="ПР-01")
    with pytest.raises(Conflict) as exc:
        catalog.update_properties(ORDER_NODE, {name: "x"})
    assert "имя свойства" in str(exc.value)
    assert not any("SET n +=" in q for q, _ in db.calls)


def test_properties_accept_cyrillic_name(db):
    _exists(db, ORDER_NODE, ["Order"], number="ПР-01")
    catalog.update_properties(ORDER_NODE, {"примечание_автора": "x", "версия2": 2})
    assert any("SET n +=" in q for q, _ in db.calls)


@pytest.mark.parametrize("value", [
    float("nan"), float("inf"), {"вложенный": 1}, [1, "a"], [[1]], 2 ** 70, [None],
])
def test_properties_reject_unstorable_values(db, value):
    _exists(db, ORDER_NODE, ["Order"], number="ПР-01")
    with pytest.raises(Conflict):
        catalog.update_properties(ORDER_NODE, {"note": value})


@pytest.mark.parametrize("name", ["nodeId", "labels"])
def test_properties_reject_reserved_names(db, name):
    _exists(db, ORDER_NODE, ["Order"], number="ПР-01")
    with pytest.raises(Conflict):
        catalog.update_properties(ORDER_NODE, {name: "x"})


def test_fetch_node_metadata_is_not_shadowed(db):
    db.rows[FETCH] = [{"labels": ["Order"], "nodeId": ORDER_NODE,
                       "props": {"number": "ПР-01", "nodeId": "чужой", "labels": ["User"]}}]
    node = catalog.get_node(ORDER_NODE)
    assert node["nodeId"] == ORDER_NODE and node["labels"] == ["Order"]


@pytest.mark.parametrize("labels,name,value", [
    (["Rule"], "type", "Prohibition"),
    (["Rule"], "type", None),
    (["Rule"], "studentsOnly", "true"),
    (["ViolationExample"], "isViolation", "true"),
    (["ViolationExample"], "isViolation", None),
    (["CheckTarget"], "source", "employees"),
])
def test_properties_validate_controlled_values(db, labels, name, value):
    """Неверное управляющее свойство молча выключало правило или роняло проверки."""
    _exists(db, RULE_NODE, labels, ruleId="R-1.1")
    with pytest.raises(Conflict):
        catalog.update_properties(RULE_NODE, {name: value})
    assert not any("SET n +=" in q for q, _ in db.calls)


def test_properties_accept_valid_controlled_values(db):
    _exists(db, RULE_NODE, ["Rule"], ruleId="R-1.1")
    catalog.update_properties(RULE_NODE, {"type": "PROHIBITION", "studentsOnly": True})
    catalog.update_properties(RULE_NODE, {"studentsOnly": None})
    writes = [p["props"] for q, p in db.calls if "SET n +=" in q]
    assert writes == [{"type": "PROHIBITION", "studentsOnly": True}, {"studentsOnly": None}]


def test_target_rename_rejects_spelling_twin(db):
    """Переименование обходило защиту от двойников, которая была только при создании."""
    _exists(db, "4:db:7", ["CheckTarget"], name="проект")
    db.rows[Q_TARGET_NAMES] = [{"name": "проект", "nodeId": "4:db:7"},
                               {"name": "срок исполнения", "nodeId": "4:db:8"}]
    with pytest.raises(Conflict) as exc:
        catalog.update_properties("4:db:7", {"name": "Срок_исполнения"})
    assert "срок исполнения" in str(exc.value)
    # Собственное прежнее имя двойником не считается.
    catalog.update_properties("4:db:7", {"name": "Проект"})


# ------------------------------ мягкое удаление -----------------------------


def test_delete_refuses_active_node(db):
    _exists(db, ORDER_NODE, ["Order"], number="ПР-01", status="active")
    with pytest.raises(Conflict) as exc:
        catalog.delete_node(ORDER_NODE)
    assert "архивированный" in str(exc.value)


def test_delete_example_does_not_require_archive(db):
    """Примеры дёшево пересоздаются, поэтому не требуют архивирования."""
    _exists(db, EXAMPLE_NODE, ["ViolationExample"], text="пример")
    assert catalog.delete_node(EXAMPLE_NODE)["deleted"] == EXAMPLE_NODE


def test_delete_target_refuses_while_used(db):
    _exists(db, "4:db:7", ["CheckTarget"], name="проект", status="archived")
    db.rows[Q_TARGET_USAGE] = [{"rule_id": "R-1.1"}]
    with pytest.raises(Conflict) as exc:
        catalog.delete_node("4:db:7")
    assert "R-1.1" in str(exc.value)
    assert not any("DETACH DELETE" in q for q, _ in db.calls)


def test_delete_target_refuses_when_used_by_rule_without_rule_id(db):
    """Правило без ruleId — тоже ссылка; раньше атрибут удалялся, а правило повисало."""
    _exists(db, "4:db:7", ["CheckTarget"], name="обучение", status="archived")
    db.rows[Q_TARGET_USAGE] = [{"rule_id": "(без ruleId)"}]
    with pytest.raises(Conflict) as exc:
        catalog.delete_node("4:db:7", force=True)
    assert "(без ruleId)" in str(exc.value)
    assert db.writes, "проверка и удаление — в одной транзакции"


def test_check_targets_list_counts_rules_without_rule_id():
    assert "coalesce(r.ruleId, '(без ruleId)')" in catalog.Q_TARGETS


def test_status_is_validated(db):
    with pytest.raises(Conflict):
        catalog.set_status(ORDER_NODE, "deleted")


def test_rule_type_is_validated():
    with pytest.raises(Conflict):
        catalog._validate_rule_type("OBLIGATION")


# ------------------------------ связи ---------------------------------------


def test_set_rule_targets_rejects_unknown(db):
    _exists(db, RULE_NODE, ["Rule"], ruleId="R-1.1")
    db.rows[Q_KNOWN_TARGETS] = [{"name": "проект"}]
    with pytest.raises(NotFound) as exc:
        catalog.set_rule_targets(RULE_NODE, ["проект", "выдумка"])
    assert "выдумка" in str(exc.value)
    assert not any("DELETE old" in q for q, _ in db.calls), "старые связи не тронуты"


def test_set_rule_targets_replaces_links_in_one_transaction(db):
    """Удаление и создание связей — один запрос в одной транзакции после блокировки правила."""
    _exists(db, RULE_NODE, ["Rule"], ruleId="R-1.1")
    db.rows[Q_KNOWN_TARGETS] = [{"name": "проект"}]
    catalog.set_rule_targets(RULE_NODE, ["проект"])
    assert db.writes == [0]
    queries = [q for q, _ in db.calls]
    lock = next(i for i, q in enumerate(queries) if "_lock" in q)
    replace = next(i for i, q in enumerate(queries) if "DELETE old" in q)
    assert lock < replace
    assert "MERGE (r)-[:APPLIES_TO]->(t)" in queries[replace]


def test_set_rule_targets_rolls_back_when_target_vanished(db):
    """Атрибут удалили между проверкой и записью — вся транзакция откатывается."""
    _exists(db, RULE_NODE, ["Rule"], ruleId="R-1.1")
    db.rows[Q_KNOWN_TARGETS] = [{"name": "проект"}, {"name": "срок"}]
    db.rows[catalog.Q_REPLACE_LINKS["targets"]] = [{"linked": 1}]
    with pytest.raises(Conflict):
        catalog.set_rule_targets(RULE_NODE, ["проект", "срок"])


# ------------------------------ подразделения -------------------------------

DEPARTMENT_NODE = "4:db:9"
Q_KNOWN_DEPARTMENTS = "MATCH (d:Department) WHERE d.departmentId IN $ids RETURN d.departmentId AS id"
Q_DEPARTMENT_USAGE = (
    "MATCH (r:Rule)-[:ONLY_IN]->(d) WHERE elementId(d) = $node_id "
    "RETURN DISTINCT coalesce(r.ruleId, '(без ruleId)') AS rule_id"
)


def _rule_with_departments(db, *ids):
    _exists(db, RULE_NODE, ["Rule"], ruleId="R-1.1")
    db.rows[Q_KNOWN_DEPARTMENTS] = [{"id": i} for i in ids]


def test_tree_carries_rule_scope(db):
    _seed(db)
    db.rows[catalog.Q_RULE_DEPARTMENTS] = [
        {"parent": RULE_NODE, "departmentId": "UCT", "name": "УЦТ"},
    ]
    rule = catalog.build_tree()["orders"][0]["clauses"][0]["rules"][0]
    assert rule["onlyIn"] == [{"departmentId": "UCT", "name": "УЦТ"}]
    assert "exceptions" not in rule


def test_tree_rule_without_scope_applies_to_all(db):
    _seed(db)
    rule = catalog.build_tree()["orders"][0]["clauses"][0]["rules"][0]
    assert rule["onlyIn"] == []


def test_tree_rule_students_only_is_a_boolean(db):
    """У правил, заведённых до появления признака, свойства нет — в дереве это false."""
    _seed(db)
    assert catalog.build_tree()["orders"][0]["clauses"][0]["rules"][0]["studentsOnly"] is False
    _seed(db, rule_props={"ruleId": "R-1.1", "type": "REQUIREMENT", "studentsOnly": True})
    assert catalog.build_tree()["orders"][0]["clauses"][0]["rules"][0]["studentsOnly"] is True


def test_set_rule_audience_writes_boolean(db):
    _exists(db, RULE_NODE, ["Rule"], ruleId="R-1.1")
    assert catalog.set_rule_audience(RULE_NODE, 1) == {"studentsOnly": True}
    query, params = db.calls[-1]
    assert "SET r.studentsOnly = $value" in query and params["value"] is True


def test_departments_list_with_rules(db):
    db.rows[catalog.Q_DEPARTMENTS] = [
        {"nodeId": DEPARTMENT_NODE, "props": {"departmentId": "UCT", "name": "УЦТ"}},
        {"nodeId": "4:db:10", "props": {"departmentId": "OLD", "name": "Старый", "status": "archived"}},
    ]
    db.rows[catalog.Q_DEPARTMENT_LINKS] = [
        {"parent": DEPARTMENT_NODE, "ruleId": "R-1.1"},
    ]
    departments = catalog.list_departments()
    assert [d["departmentId"] for d in departments] == ["UCT"], "архив по умолчанию скрыт"
    assert departments[0]["status"] == "active"
    assert departments[0]["onlyRules"] == ["R-1.1"]
    assert len(catalog.list_departments(include_archived=True)) == 2


def test_create_department_rejects_duplicate_id(db):
    db.rows["MATCH (d:Department {departmentId: $id}) RETURN d.departmentId AS id"] = [{"id": "UCT"}]
    with pytest.raises(Conflict) as exc:
        catalog.create_department("UCT", "УЦТ")
    assert "уже существует" in str(exc.value)


def test_delete_department_refuses_while_used(db):
    """Иначе ограничение ONLY_IN исчезло бы, и правило стало бы действовать для всех."""
    _exists(db, DEPARTMENT_NODE, ["Department"], departmentId="UCT", status="archived")
    db.rows[Q_DEPARTMENT_USAGE] = [{"rule_id": "R-1.1"}]
    with pytest.raises(Conflict) as exc:
        catalog.delete_node(DEPARTMENT_NODE, force=True)
    assert "R-1.1" in str(exc.value)


def test_delete_unused_department(db):
    _exists(db, DEPARTMENT_NODE, ["Department"], departmentId="UCT", status="active")
    with pytest.raises(Conflict):
        catalog.delete_node(DEPARTMENT_NODE)
    assert catalog.delete_node(DEPARTMENT_NODE, force=True) == {"deleted": DEPARTMENT_NODE}


def test_department_id_is_a_business_key(db):
    _exists(db, DEPARTMENT_NODE, ["Department"], departmentId="UCT")
    with pytest.raises(Conflict):
        catalog.update_properties(DEPARTMENT_NODE, {"departmentId": ""})


def test_scope_rejects_unknown_department(db):
    _rule_with_departments(db, "UCT")
    with pytest.raises(NotFound) as exc:
        catalog.set_rule_scope(RULE_NODE, ["UCT", "XXX"])
    assert "XXX" in str(exc.value)


def test_scope_rejects_repeated_department(db):
    _rule_with_departments(db, "UCT")
    with pytest.raises(Conflict):
        catalog.set_rule_scope(RULE_NODE, ["UCT", "UCT"])


def test_scope_replaces_old_links(db):
    _rule_with_departments(db, "UCT", "FIN")
    result = catalog.set_rule_scope(RULE_NODE, ["UCT", "FIN"])
    assert result == {"only": ["UCT", "FIN"]}
    replace = [q for q, _ in db.calls if "DELETE old" in q]
    assert len(replace) == 1, "удаление и создание — один запрос"
    assert "[old:ONLY_IN]" in replace[0] and "MERGE (r)-[:ONLY_IN]->(d)" in replace[0]


def test_empty_scope_only_clears(db):
    _rule_with_departments(db, "UCT")
    catalog.set_rule_scope(RULE_NODE, [])
    params = [p for q, p in db.calls if "DELETE old" in q]
    assert params[0]["values"] == [], "пустая область — правило для всех"


def test_clause_cannot_reference_itself(db):
    _exists(db, CLAUSE_NODE, ["Clause"], code="1.1")
    with pytest.raises(Conflict):
        catalog.set_clause_references(CLAUSE_NODE, [CLAUSE_NODE])


def test_fetch_node_checks_label(db):
    _exists(db, CLAUSE_NODE, ["Clause"], code="1.1")
    with pytest.raises(Conflict) as exc:
        catalog.create_clause(CLAUSE_NODE, "1.2", "текст")
    assert "Ожидался узел :Order" in str(exc.value)


# ------------------------- должностные инструкции ---------------------------


def test_departments_list_carries_job_descriptions(db):
    db.rows[catalog.Q_DEPARTMENTS] = [
        {"nodeId": DEPARTMENT_NODE, "props": {"departmentId": "UCT", "name": "УЦТ"}}]
    db.rows[catalog.Q_JOB_DESCRIPTIONS] = [
        {"parent": DEPARTMENT_NODE, "nodeId": "4:db:20", "jobDescriptionId": "UCT/аналитик",
         "title": "Аналитик", "status": "active", "chars": 1200, "duties": 12, "dutiesReviewed": True,
         "dutiesStatus": "ready"},
        {"parent": DEPARTMENT_NODE, "nodeId": "4:db:21", "jobDescriptionId": "UCT/old",
         "title": "Старая", "status": "archived", "chars": 10},
    ]
    assert catalog.list_departments()[0]["jobDescriptions"] == [
        {"nodeId": "4:db:20", "jobDescriptionId": "UCT/аналитик", "title": "Аналитик",
         "status": "active", "chars": 1200, "duties": 12, "dutiesReviewed": True,
         "dutiesStatus": "ready"}]
    assert len(catalog.list_departments(include_archived=True)[0]["jobDescriptions"]) == 2


def test_create_job_description_builds_id_from_department_and_title(db):
    _exists(db, DEPARTMENT_NODE, ["Department"], departmentId="UCT", name="УЦТ")
    db.rows[catalog.Q_CREATE_JOB_DESCRIPTION] = [{"nodeId": "4:db:20", "props": {"title": "Ведущий аналитик"}}]
    created = catalog.create_job_description(DEPARTMENT_NODE, " Ведущий аналитик ", " текст ")
    assert created["nodeId"] == "4:db:20"
    params = db.calls[-1][1]
    assert params["id"] == "UCT/ведущий_аналитик"
    assert (params["title"], params["text"]) == ("Ведущий аналитик", "текст")


def test_create_job_description_requires_department(db):
    _exists(db, RULE_NODE, ["Rule"], ruleId="R-1.1")
    with pytest.raises(Conflict):
        catalog.create_job_description(RULE_NODE, "Аналитик", "текст")


def test_job_description_is_a_catalog_node(db):
    """Правка и архив инструкции идут через общие операции над узлом."""
    _exists(db, "4:db:20", ["JobDescription"], jobDescriptionId="UCT/a", title="Аналитик")
    assert catalog.get_node("4:db:20")["title"] == "Аналитик"
    with pytest.raises(Conflict):
        catalog.delete_node("4:db:20")


def test_create_target_rejects_unknown_source(db):
    with pytest.raises(Conflict):
        catalog.create_check_target("атрибут", "описание", "employees")


def test_graph_view_uses_catalog_labels_and_trims_text(db):
    db.rows[catalog.Q_GRAPH_NODES] = [
        {"id": "1", "labels": ["Rule"], "props": {"ruleId": "R-1.1", "type": "PROHIBITION",
                                                  "description": "о" * 500}},
        {"id": "2", "labels": ["JobDescription"], "props": {"title": "Аналитик", "text": "секрет",
                                                            "jobDescriptionId": "UCT/a", "status": "archived"}},
    ]
    db.rows[catalog.Q_GRAPH_EDGES] = [{"source": "1", "target": "2", "type": "X", "status": None}]
    view = catalog.graph_view()
    assert view["nodes"][0] == {"id": "1", "label": "Rule", "title": "R-1.1", "detail": "о" * 300,
                                "status": "active", "type": "PROHIBITION"}
    assert view["nodes"][1] == {"id": "2", "label": "JobDescription", "title": "Аналитик",
                                "detail": "UCT/a", "status": "archived"}
    assert "User" not in db.calls[0][1]["labels"] and "CheckRecord" not in db.calls[0][1]["labels"]
    assert view["edges"] == db.rows[catalog.Q_GRAPH_EDGES]


def test_job_text_and_duties_are_not_editable_as_plain_properties(db):
    _exists(db, "4:db:20", ["JobDescription"], jobDescriptionId="UCT/a", title="Аналитик")
    for name in ("text", "duties", "dutiesReviewed"):
        with pytest.raises(Conflict):
            catalog.update_properties("4:db:20", {name: "x"})


def test_changed_text_resets_duties(db):
    _exists(db, "4:db:20", ["JobDescription"], jobDescriptionId="UCT/a", title="Аналитик", text="старый")
    _, changed = catalog.update_job_description("4:db:20", "Аналитик", " новый ")
    assert changed is True
    assert db.calls[-2][1] == {"node_id": "4:db:20", "title": "Аналитик", "text": "новый", "changed": True}
    _, changed = catalog.update_job_description("4:db:20", "Ведущий аналитик", "старый")
    assert changed is False


def test_set_job_duties_cleans_list(db):
    _exists(db, "4:db:20", ["JobDescription"], jobDescriptionId="UCT/a")
    catalog.set_job_duties("4:db:20", ["  Готовит   отчёт ", "", "Готовит отчёт", "Ведёт реестр"], True)
    assert db.calls[-2][1]["duties"] == ["Готовит отчёт", "Ведёт реестр"]
    assert db.calls[-2][1]["reviewed"] is True


# ------------------------- создание правила целиком -------------------------


def _clause_for_rule(db):
    _exists(db, CLAUSE_NODE, ["Clause"], code="3.1", status="active")
    db.rows[catalog.Q_CREATE_RULE] = [{"nodeId": RULE_NODE, "props": {"ruleId": "R-3.1"}}]


def test_create_rule_checks_targets_before_create(db):
    """Неизвестный атрибут — 404 без правила-сироты, которое плодило бы R-x.2 при повторе."""
    _clause_for_rule(db)
    db.rows[Q_KNOWN_TARGETS] = [{"name": "проект"}]
    with pytest.raises(NotFound):
        catalog.create_rule(CLAUSE_NODE, "REQUIREMENT", "описание", targets=["проект", "удалённый"])
    assert not any(q == catalog.Q_CREATE_RULE for q, _ in db.calls)


def test_create_rule_checks_departments_before_create(db):
    _clause_for_rule(db)
    db.rows[Q_KNOWN_TARGETS] = [{"name": "проект"}]
    db.rows[Q_KNOWN_DEPARTMENTS] = [{"id": "UCT"}]
    with pytest.raises(NotFound):
        catalog.create_rule(CLAUSE_NODE, "REQUIREMENT", "описание", targets=["проект"], only=["XXX"])
    assert not any(q == catalog.Q_CREATE_RULE for q, _ in db.calls)


def test_create_rule_links_targets_and_scope_in_one_transaction(db):
    """Область действия задаётся вместе с правилом: оно ни мгновения не действует во всех."""
    _clause_for_rule(db)
    db.rows[Q_KNOWN_TARGETS] = [{"name": "проект"}]
    db.rows[Q_KNOWN_DEPARTMENTS] = [{"id": "UCT"}]
    created = catalog.create_rule(CLAUSE_NODE, "REQUIREMENT", "описание",
                                  targets=["проект"], only=["UCT"])
    assert created["nodeId"] == RULE_NODE
    assert db.writes == [0], "всё — одна транзакция"
    replaced = [p for q, p in db.calls if "DELETE old" in q]
    assert [p["values"] for p in replaced] == [["проект"], ["UCT"]]


def test_create_rule_route_passes_scope(monkeypatch, api):
    seen = {}
    monkeypatch.setattr(catalog, "create_rule", lambda *a: seen.update(args=a) or {"nodeId": "1"})
    response = api.post("/catalog/rules", json={"clauseNodeId": CLAUSE_NODE, "type": "PROHIBITION",
                                                "description": "о", "only": ["UCT"]})
    assert response.status_code == 201
    assert seen["args"][-1] == ["UCT"]


# ---------------------------- идентификатор пункта ---------------------------


def test_create_clause_auto_id_gets_free_suffix(db):
    """Автоматический clauseId совпал с архивным пунктом — берётся суффикс, а не 409."""
    _exists(db, ORDER_NODE, ["Order"], orderId="PR-01")
    taken = {"PR-01/1.1", "PR-01/1.1.2"}

    def fake_run(query, **params):
        db.calls.append((query, params))
        if query == catalog.Q_CLAUSE_ID_TAKEN:
            return [{"id": params["id"]}] if params["id"] in taken else []
        if "CREATE (c:Clause" in query:
            return [{"nodeId": CLAUSE_NODE, "props": {"clauseId": params["id"]}}]
        return db.rows.get(query, [])

    # Фикстура monkeypatch вернёт исходные функции после теста.
    catalog._run = fake_run
    catalog._one = lambda query, **params: (fake_run(query, **params) or [None])[0]
    catalog.create_clause(ORDER_NODE, "1.1", "текст")
    assert db.calls[-1][1]["id"] == "PR-01/1.1.3"


def test_create_clause_explicit_id_conflicts(db):
    _exists(db, ORDER_NODE, ["Order"], orderId="PR-01")
    db.rows[catalog.Q_CLAUSE_ID_TAKEN] = [{"id": "PR-01/x"}]
    with pytest.raises(Conflict):
        catalog.create_clause(ORDER_NODE, "1.1", "текст", clause_id="PR-01/x")


# ------------------------------ что уйдёт с узлом ----------------------------


def test_count_descendants_counts_job_descriptions(db):
    assert "HAS_JOB_DESCRIPTION" in catalog.Q_COUNT_DESCENDANTS
    assert catalog.count_descendants(DEPARTMENT_NODE)["jobDescriptions"] == 0
    db.rows[catalog.Q_COUNT_DESCENDANTS] = [{"clauses": 0, "rules": 0, "examples": 0, "jobDescriptions": 3}]
    assert catalog.count_descendants(DEPARTMENT_NODE)["jobDescriptions"] == 3


# ------------------------------ перенос в архив ------------------------------


def test_move_rule_into_archived_clause_is_refused(db):
    db.rows[FETCH] = [{"labels": ["Rule"], "props": {"ruleId": "R-1.1"}, "nodeId": RULE_NODE}]

    def fake_run(query, **params):
        db.calls.append((query, params))
        if query == FETCH:
            if params["node_id"] == RULE_NODE:
                return [{"labels": ["Rule"], "props": {"ruleId": "R-1.1"}, "nodeId": RULE_NODE}]
            return [{"labels": ["Clause"], "props": {"code": "9", "status": "archived"}, "nodeId": "4:db:50"}]
        return []

    catalog._run = fake_run
    with pytest.raises(Conflict) as exc:
        catalog.move_rule(RULE_NODE, "4:db:50")
    assert "архивный пункт" in str(exc.value)
    assert not any("DELETE old" in q for q, _ in db.calls)


def test_move_clause_into_archived_order_is_refused(db):
    def fake_run(query, **params):
        db.calls.append((query, params))
        if query == FETCH:
            if params["node_id"] == CLAUSE_NODE:
                return [{"labels": ["Clause"], "props": {"code": "1.1"}, "nodeId": CLAUSE_NODE}]
            return [{"labels": ["Order"], "props": {"number": "ПР", "status": "archived"}, "nodeId": ORDER_NODE}]
        return []

    catalog._run = fake_run
    with pytest.raises(Conflict):
        catalog.move_clause(CLAUSE_NODE, ORDER_NODE)



def test_graph_view_walks_only_catalog_labels():
    """История проверок и оценки SMART в той же базе не обходятся."""
    assert "MATCH (n:Order|Clause|Rule|" in catalog.Q_GRAPH_NODES
    assert "MATCH (n) WHERE" not in catalog.Q_GRAPH_NODES
    assert "(b:Order|Clause|" in catalog.Q_GRAPH_EDGES


# ------------------------------ ремонт данных --------------------------------


def test_repair_identifiers_avoids_clause_id_collisions(db):
    """Совпадение с существующим clauseId получает суффикс, а не роняет ремонт."""
    def fake_run(query, **params):
        db.calls.append((query, params))
        if "MATCH (n:Clause) WHERE (n.clauseId IS NULL" in query:
            return [{"nodeId": "4:db:30", "code": "1.1", "orderId": "PR-01"},
                    {"nodeId": "4:db:31", "code": "2", "orderId": None}]
        if query.startswith("MATCH (n:Clause) WHERE n.clauseId IS NOT NULL"):
            return [{"id": "PR-01/1.1"}]
        return []

    catalog._run = fake_run
    report = catalog.repair_identifiers()
    assert report["clauses"] == 2
    assigned = [p["value"] for q, p in db.calls if "SET n.clauseId" in q]
    assert assigned == ["PR-01/1.1.2", "ORD/2"], "пункт без приказа тоже получает ключ"
    assert db.writes, "ремонт — одной транзакцией"


def test_merge_duplicate_targets_uses_normalize_name(db):
    """Двойники — по naming.normalize_name; канонический — с описанием.

    Архивный двойник с действующим не сводится: его отключённые правила
    иначе перешли бы на действующий атрибут и включились (C1).
    """
    db.rows[catalog.Q_TARGETS_FOR_MERGE] = [
        {"nodeId": "1", "name": "срок исполнения", "status": "active", "described": False, "rules": 3},
        {"nodeId": "2", "name": "Срок-Исполнения", "status": "active", "described": True, "rules": 1},
        {"nodeId": "3", "name": "срок_исполнения", "status": "archived", "described": True, "rules": 2},
        {"nodeId": "4", "name": "проект", "status": "active", "described": True, "rules": 2},
    ]
    report = catalog.merge_duplicate_targets()
    assert report["merged"] == [{"kept": "Срок-Исполнения", "removed": ["срок исполнения"]}]
    assert report["skipped"][0]["names"] == ["Срок-Исполнения", "срок исполнения", "срок_исполнения"]
    merge = [p for q, p in db.calls if "DETACH DELETE dup" in q]
    assert merge == [{"keep": "2", "twins": ["1"]}], "архивный двойник не тронут"
    assert db.calls[0][0] == catalog.Q_KEY_LOCK, "сведение — под замком атрибутов"


def test_merge_duplicate_targets_respects_source(db):
    """Атрибут «по инструкции» и обычный с тем же именем не сводятся."""
    db.rows[catalog.Q_TARGETS_FOR_MERGE] = [
        {"nodeId": "1", "name": "проект", "status": "active", "source": None, "described": True, "rules": 1},
        {"nodeId": "2", "name": "Проект", "status": "active", "source": "job_description",
         "described": True, "rules": 1},
    ]
    report = catalog.merge_duplicate_targets()
    assert report["merged"] == [] and len(report["skipped"]) == 1
    assert not any("DETACH DELETE dup" in q for q, _ in db.calls)


def _catalog_strings():
    import ast
    import inspect
    tree = ast.parse(inspect.getsource(catalog))
    return [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)]


# ------------------------- выписка обязанностей ------------------------------

JOB_NODE_ID = "4:db:20"


def test_start_extraction_refuses_while_pending(db):
    _exists(db, JOB_NODE_ID, ["JobDescription"], jobDescriptionId="UCT/a", dutiesStatus="pending")
    with pytest.raises(Conflict) as exc:
        catalog.start_duties_extraction(JOB_NODE_ID)
    assert "уже выписываются" in str(exc.value)


def test_start_extraction_sets_pending(db):
    _exists(db, JOB_NODE_ID, ["JobDescription"], jobDescriptionId="UCT/a")
    db.rows[catalog.Q_START_DUTIES] = [{"nodeId": JOB_NODE_ID}]
    catalog.start_duties_extraction(JOB_NODE_ID)
    assert any(q == catalog.Q_START_DUTIES for q, _ in db.calls)


def test_finish_duties_truncates_long_list_with_warning(db):
    """Больше MAX_DUTIES — обрезка с предупреждением, а не 409 после создания узла."""
    db.rows[catalog.Q_FINISH_DUTIES] = [{"nodeId": JOB_NODE_ID}]
    duties = [f"Обязанность {i}" for i in range(catalog.MAX_DUTIES + 5)]
    assert catalog.finish_duties(JOB_NODE_ID, "текст", duties) is True
    params = db.calls[-1][1]
    assert len(params["duties"]) == catalog.MAX_DUTIES
    assert params["status"] == "ready" and "сохранены первые" in params["error"]
    assert params["text"] == "текст", "запись только если текст не меняли"


def test_finish_duties_error_keeps_list(db):
    assert catalog.finish_duties(JOB_NODE_ID, "текст", error="таймаут") is False
    params = db.calls[-1][1]
    assert params == {"node_id": JOB_NODE_ID, "text": "текст", "status": "error",
                      "error": "таймаут", "duties": None}


def test_fail_pending_duties_on_start(db):
    db.rows[next(q for q in _catalog_strings() if "count(j) AS total" in q)] = [{"total": 2}]
    assert catalog.fail_pending_duties() == 2
    assert db.calls[-1][1]["error"] == catalog.DUTIES_INTERRUPTED


def test_job_description_view_defaults_status(db):
    _exists(db, JOB_NODE_ID, ["JobDescription"], jobDescriptionId="UCT/a", duties=["А"])
    node = catalog.get_job_description(JOB_NODE_ID)
    assert node["dutiesStatus"] == "ready" and node["dutiesError"] is None


def test_new_job_description_is_pending():
    assert "dutiesStatus: 'pending'" in catalog.Q_CREATE_JOB_DESCRIPTION


def test_duties_state_is_not_editable_as_plain_property(db):
    _exists(db, JOB_NODE_ID, ["JobDescription"], jobDescriptionId="UCT/a")
    for name in ("dutiesStatus", "dutiesError"):
        with pytest.raises(Conflict):
            catalog.update_properties(JOB_NODE_ID, {name: "ready"})


# --------------------------- маршруты каталога -------------------------------


@pytest.fixture
def api(monkeypatch):
    """Клиент вошедшего администратора; Neo4j и модель подменены."""
    from fastapi.testclient import TestClient

    import auth
    import diagnostics
    import graph
    import main

    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    monkeypatch.setattr(diagnostics, "collect", lambda: {"ready": True, "problems": [], "issues": [],
                                                         "counts": {}, "check_targets": 1})
    monkeypatch.setattr(catalog, "fail_pending_duties", lambda: 0)
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("tester", "admin")
    with TestClient(main.app, headers={"X-Requested-With": "XMLHttpRequest"}) as client:
        yield client
    main.app.dependency_overrides.clear()


class SyncPool:
    """Фоновый пул, выполняющий задачу сразу — тест видит её итог."""

    def __init__(self):
        self.jobs = []

    def submit(self, fn, *args):
        self.jobs.append(args)
        fn(*args)


PENDING_JOB = {"nodeId": JOB_NODE_ID, "labels": ["JobDescription"], "title": "Аналитик",
               "text": "текст", "dutiesStatus": "pending", "dutiesError": None}


@pytest.fixture
def duties(monkeypatch):
    import agent
    import routes

    pool = SyncPool()
    finished = []
    monkeypatch.setattr(routes, "_duties_pool", pool)
    monkeypatch.setattr(routes, "_duties_running", set())
    orphaned = []
    monkeypatch.setattr(catalog, "fail_orphaned_duties", lambda node_id: orphaned.append(node_id) or False)
    monkeypatch.setattr(catalog, "finish_duties",
                        lambda node_id, text, duties=None, error=None:
                        finished.append((node_id, text, duties, error)) or True)
    monkeypatch.setattr(agent, "extract_duties", lambda text: ["Готовит отчёт"])
    return type("Duties", (), {"pool": pool, "finished": finished, "orphaned": orphaned})


def test_upload_returns_202_pending_and_extracts_in_background(api, duties, monkeypatch):
    import metrics
    monkeypatch.setattr(catalog, "create_job_description", lambda *a: dict(PENDING_JOB))
    generation = metrics.results.generation
    response = api.post("/catalog/job-descriptions",
                        json={"departmentNodeId": "4:db:9", "title": "Аналитик", "text": "текст"})
    assert response.status_code == 202
    assert response.json()["dutiesStatus"] == "pending" and response.json()["dutiesError"] is None
    assert duties.finished == [(JOB_NODE_ID, "текст", ["Готовит отчёт"], None)]
    assert metrics.results.generation > generation


def test_model_failure_is_saved_as_duties_error(api, duties, monkeypatch):
    import agent

    def boom(text):
        raise agent.ExtractionError("модель недоступна")

    monkeypatch.setattr(agent, "extract_duties", boom)
    monkeypatch.setattr(catalog, "create_job_description", lambda *a: dict(PENDING_JOB))
    response = api.post("/catalog/job-descriptions",
                        json={"departmentNodeId": "4:db:9", "title": "Аналитик", "text": "текст"})
    assert response.status_code == 202
    assert duties.finished == [(JOB_NODE_ID, "текст", None, "модель недоступна")]


def test_unexpected_failure_does_not_leave_pending(api, duties, monkeypatch):
    import agent
    monkeypatch.setattr(agent, "extract_duties", lambda text: 1 / 0)
    monkeypatch.setattr(catalog, "create_job_description", lambda *a: dict(PENDING_JOB))
    api.post("/catalog/job-descriptions",
             json={"departmentNodeId": "4:db:9", "title": "Аналитик", "text": "текст"})
    assert duties.finished[0][3].startswith("Внутренняя ошибка")


def test_edit_restarts_extraction_only_when_text_changed(api, duties, monkeypatch):
    ready = {**PENDING_JOB, "dutiesStatus": "ready"}
    monkeypatch.setattr(catalog, "update_job_description", lambda n, title, text: (ready, False))
    response = api.put(f"/catalog/job-descriptions/{JOB_NODE_ID}", json={"title": "А", "text": "текст"})
    assert response.status_code == 200 and duties.pool.jobs == []
    monkeypatch.setattr(catalog, "update_job_description", lambda n, title, text: (dict(PENDING_JOB), True))
    response = api.put(f"/catalog/job-descriptions/{JOB_NODE_ID}", json={"title": "А", "text": "новый"})
    assert response.status_code == 202 and len(duties.pool.jobs) == 1


def test_repeated_extraction_while_pending_is_409(api, duties, monkeypatch):
    def busy(node_id):
        raise catalog.Conflict("Обязанности уже выписываются — дождитесь окончания")

    monkeypatch.setattr(catalog, "start_duties_extraction", busy)
    response = api.post(f"/catalog/job-descriptions/{JOB_NODE_ID}/extract-duties")
    assert response.status_code == 409 and duties.pool.jobs == []
    monkeypatch.setattr(catalog, "start_duties_extraction", lambda node_id: dict(PENDING_JOB))
    assert api.post(f"/catalog/job-descriptions/{JOB_NODE_ID}/extract-duties").status_code == 202
    assert len(duties.pool.jobs) == 1


def test_job_description_is_polled_by_get(api, monkeypatch):
    import routes
    monkeypatch.setattr(routes, "_duties_running", {JOB_NODE_ID})  # выписка идёт в этом процессе
    monkeypatch.setattr(catalog, "fail_orphaned_duties", lambda node_id: pytest.fail("идущая выписка"))
    monkeypatch.setattr(catalog, "get_job_description", lambda node_id: {**PENDING_JOB, "duties": []})
    main_body = api.get(f"/catalog/job-descriptions/{JOB_NODE_ID}").json()
    assert main_body["dutiesStatus"] == "pending"


def test_recover_duties_jobs(monkeypatch):
    import routes
    monkeypatch.setattr(catalog, "fail_pending_duties", lambda: 3)
    assert routes.recover_duties_jobs() == 3

    def down():
        raise RuntimeError("Neo4j недоступен")

    monkeypatch.setattr(catalog, "fail_pending_duties", down)
    assert routes.recover_duties_jobs() == 0, "недоступный Neo4j не роняет старт"


def test_rejected_write_keeps_cache(api, monkeypatch):
    """404/409 — проверка до записи или откат транзакции: кэш ответов не сбрасывается."""
    import metrics

    def refused(*a):
        raise catalog.Conflict("уже существует")

    monkeypatch.setattr(catalog, "create_department", refused)
    generation = metrics.results.generation
    assert api.post("/catalog/departments", json={"departmentId": "HR", "name": "Кадры"}).status_code == 409
    assert api.post("/catalog/departments", json={"name": 1}).status_code == 422
    assert metrics.results.generation == generation


def test_failed_write_still_drops_cache(monkeypatch):
    """Непредвиденный сбой посреди записи мог записать часть — кэш сбрасывается."""
    from fastapi.testclient import TestClient

    import auth
    import graph
    import main
    import metrics

    def half(*a):
        raise RuntimeError("сбой Neo4j посреди записи")

    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    monkeypatch.setattr(catalog, "fail_pending_duties", lambda: 0)
    monkeypatch.setattr(catalog, "create_department", half)
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("tester", "admin")
    try:
        with TestClient(main.app, raise_server_exceptions=False,
                        headers={"X-Requested-With": "XMLHttpRequest"}) as client:
            generation = metrics.results.generation
            response = client.post("/catalog/departments", json={"departmentId": "HR", "name": "Кадры"})
            assert response.status_code == 500
            assert metrics.results.generation > generation
    finally:
        main.app.dependency_overrides.clear()


def test_successful_write_drops_cache(api, monkeypatch):
    import metrics
    monkeypatch.setattr(catalog, "create_department", lambda *a: {"nodeId": "4:db:9"})
    generation = metrics.results.generation
    assert api.post("/catalog/departments", json={"departmentId": "HR", "name": "Кадры"}).status_code == 201
    assert metrics.results.generation > generation


def test_viewer_refused_write_does_not_drop_cache(monkeypatch):
    """E1: читатель циклом отклонённых (403) POST не опустошает кэш ответов."""
    from fastapi.testclient import TestClient

    import auth
    import graph
    import main
    import metrics

    monkeypatch.setattr(graph, "verify_connectivity", lambda: True)
    monkeypatch.setattr(graph, "close_driver", lambda: None)
    monkeypatch.setattr(catalog, "fail_pending_duties", lambda: 0)
    calls = []
    monkeypatch.setattr(metrics, "catalog_changed", lambda: calls.append(1))
    main.app.dependency_overrides[auth.current_user] = lambda: auth.Principal("reader", "viewer")
    try:
        with TestClient(main.app, headers={"X-Requested-With": "XMLHttpRequest"}) as client:
            assert client.post("/catalog/orders", json={}).status_code == 403
            assert client.delete("/catalog/nodes/x").status_code == 403
            assert client.post("/catalog/merge-duplicate-targets").status_code == 403
    finally:
        main.app.dependency_overrides.clear()
    assert calls == []


def test_constraint_error_is_409(api, monkeypatch):
    from neo4j.exceptions import ConstraintError

    def race(*a):
        raise ConstraintError("already exists")

    monkeypatch.setattr(catalog, "create_department", race)
    response = api.post("/catalog/departments", json={"departmentId": "HR", "name": "Кадры"})
    assert response.status_code == 409 and "уже занят" in response.json()["detail"]


def test_merge_duplicate_targets_route(api, monkeypatch):
    monkeypatch.setattr(catalog, "merge_duplicate_targets", lambda: {"merged": []})
    assert api.post("/catalog/merge-duplicate-targets").json() == {"merged": []}


# ------------------- выписка: обрыв записи итога (C2, C3) --------------------


def test_finish_is_retried_after_neo4j_failure(monkeypatch):
    """Сбой Neo4j при записи итога повторяется, а не оставляет pending навсегда."""
    import routes
    monkeypatch.setattr(routes, "FINISH_RETRY_PAUSE", 0)
    attempts = []

    def flaky(node_id, text, duties=None, error=None):
        attempts.append(1)
        if len(attempts) < 3:
            raise RuntimeError("Neo4j недоступен")
        return True

    monkeypatch.setattr(catalog, "finish_duties", flaky)
    routes._finish_duties(JOB_NODE_ID, "текст", duties=["А"])
    assert len(attempts) == 3


def test_finish_gives_up_after_attempts(monkeypatch):
    import routes
    monkeypatch.setattr(routes, "FINISH_RETRY_PAUSE", 0)
    attempts = []
    monkeypatch.setattr(catalog, "finish_duties",
                        lambda *a, **k: attempts.append(1) or (_ for _ in ()).throw(RuntimeError("down")))
    routes._finish_duties(JOB_NODE_ID, "текст", error="x")  # не бросает: фоновый поток
    assert len(attempts) == routes.FINISH_ATTEMPTS


def test_job_leaves_running_set_even_if_finish_failed(monkeypatch):
    import agent
    import routes
    monkeypatch.setattr(routes, "FINISH_RETRY_PAUSE", 0)
    monkeypatch.setattr(routes, "_duties_running", {JOB_NODE_ID})
    monkeypatch.setattr(agent, "extract_duties", lambda text: ["А"])
    monkeypatch.setattr(catalog, "finish_duties", lambda *a, **k: 1 / 0)
    routes._extract_duties_job(JOB_NODE_ID, "текст")
    assert JOB_NODE_ID not in routes._duties_running


def test_orphaned_pending_is_reported_as_error_on_poll(api, monkeypatch):
    """pending без идущей выписки (итог не записался) — error без перезапуска API."""
    import routes
    monkeypatch.setattr(routes, "_duties_running", set())
    state = {"status": "pending", "error": None}
    closed = []

    def fail(node_id):
        closed.append(node_id)
        state.update(status="error", error=catalog.DUTIES_LOST)
        return True

    monkeypatch.setattr(catalog, "fail_orphaned_duties", fail)
    monkeypatch.setattr(catalog, "get_job_description",
                        lambda node_id: {**PENDING_JOB, "dutiesStatus": state["status"],
                                         "dutiesError": state["error"]})
    body = api.get(f"/catalog/job-descriptions/{JOB_NODE_ID}").json()
    assert closed == [JOB_NODE_ID]
    assert body["dutiesStatus"] == "error" and body["dutiesError"] == catalog.DUTIES_LOST


def test_pending_is_not_closed_while_another_request_starts_extraction(api, monkeypatch):
    """Окно «уже pending, ещё не в очереди» — не обрыв."""
    import routes
    monkeypatch.setattr(routes, "_duties_running", set())
    monkeypatch.setattr(routes, "_duties_starting", 1)
    monkeypatch.setattr(catalog, "fail_orphaned_duties", lambda node_id: pytest.fail("не обрыв"))
    monkeypatch.setattr(catalog, "get_job_description", lambda node_id: dict(PENDING_JOB))
    assert api.get(f"/catalog/job-descriptions/{JOB_NODE_ID}").json()["dutiesStatus"] == "pending"


def test_restart_closes_orphaned_pending_first(api, duties, monkeypatch):
    """Повторная выписка при «зависшем» pending: сначала error, затем запуск (не 409)."""
    order = []
    monkeypatch.setattr(catalog, "fail_orphaned_duties", lambda node_id: order.append("close") or True)
    monkeypatch.setattr(catalog, "start_duties_extraction",
                        lambda node_id: order.append("start") or dict(PENDING_JOB))
    assert api.post(f"/catalog/job-descriptions/{JOB_NODE_ID}/extract-duties").status_code == 202
    assert order == ["close", "start"] and len(duties.pool.jobs) == 1


def test_fail_orphaned_duties_touches_only_pending(db):
    db.rows[catalog.Q_FAIL_ORPHANED_DUTIES] = [{"nodeId": JOB_NODE_ID}]
    assert catalog.fail_orphaned_duties(JOB_NODE_ID) is True
    assert "j.dutiesStatus = 'pending'" in catalog.Q_FAIL_ORPHANED_DUTIES
    assert db.calls[-1][1] == {"node_id": JOB_NODE_ID, "error": catalog.DUTIES_LOST}


def test_duties_pool_threads_are_daemon_and_shutdown_does_not_wait():
    """Остановка API не ждёт идущую выписку (C3)."""
    import threading
    import time

    import routes
    pool = routes.DaemonPool(1, "duties-test")
    release, started, done = threading.Event(), threading.Event(), []
    pool.submit(lambda: (started.set(), release.wait(5)))
    pool.submit(lambda: done.append("queued"))
    assert started.wait(2)
    assert all(t.daemon for t in pool._threads)
    began = time.monotonic()
    dropped = pool.shutdown()
    assert time.monotonic() - began < 1, "идущая задача не дожидается"
    assert dropped == [()], "очередь отменена"
    release.set()
    with pytest.raises(RuntimeError):
        pool.submit(lambda: None)
    assert done == []


def test_shutdown_forgets_cancelled_jobs(monkeypatch):
    import routes
    pool = routes.DaemonPool(1, "duties-test")
    pool._closed = False
    pool._queue.put((routes._extract_duties_job, ("4:db:77", "т")))  # в очереди, поток не заведён
    monkeypatch.setattr(routes, "_duties_pool", pool)
    monkeypatch.setattr(routes, "_duties_running", {"4:db:77"})
    routes.shutdown_duties_pool()
    assert routes._duties_running == set()
    assert isinstance(routes._duties_pool, routes.DaemonPool) and routes._duties_pool is not pool


# ------------------------- имена свойств (C5, C6) ---------------------------


def test_legacy_property_with_bad_name_can_be_deleted(db):
    """null удаляет старое свойство с «неудобным» именем: имя уходит параметром."""
    _exists(db, ORDER_NODE, ["Order"], number="ПР-01", **{"примечание автора": "x"})
    catalog.update_properties(ORDER_NODE, {"примечание автора": None})
    writes = [p["props"] for q, p in db.calls if "SET n +=" in q]
    assert writes == [{"примечание автора": None}]


@pytest.mark.parametrize("name,value", [("_lock", None), ("nodeId", None), ("labels", None),
                                        ("status", None)])
def test_service_properties_cannot_be_deleted(db, name, value):
    _exists(db, ORDER_NODE, ["Order"], number="ПР-01")
    with pytest.raises(Conflict):
        catalog.update_properties(ORDER_NODE, {name: value})
    assert not any("SET n +=" in q for q, _ in db.calls)


@pytest.mark.parametrize("name", ["_lock", "_x", "__proto"])
def test_underscore_names_are_reserved(db, name):
    _exists(db, ORDER_NODE, ["Order"], number="ПР-01")
    with pytest.raises(Conflict):
        catalog.update_properties(ORDER_NODE, {name: "x"})
    assert not any("SET n +=" in q for q, _ in db.calls)


# ------------------- перенос в архивный приказ (C7) --------------------------


def test_move_rule_into_clause_of_archived_order_is_refused(db):
    def fake_run(query, **params):
        db.calls.append((query, params))
        if query == FETCH:
            if params["node_id"] == RULE_NODE:
                return [{"labels": ["Rule"], "props": {"ruleId": "R-1"}, "nodeId": RULE_NODE}]
            return [{"labels": ["Clause"], "props": {"code": "9", "status": "active"}, "nodeId": "4:db:50"}]
        if query == catalog.Q_CLAUSE_IN_ARCHIVED_ORDER:
            return [{"nodeId": ORDER_NODE}]
        return []

    catalog._run = fake_run
    with pytest.raises(Conflict) as exc:
        catalog.move_rule(RULE_NODE, "4:db:50")
    assert "архивный приказ" in str(exc.value)
    assert not any("DELETE old" in q for q, _ in db.calls)


def test_move_rule_into_active_clause_of_active_order(db):
    db.rows[FETCH] = [{"labels": ["Rule", "Clause"], "props": {"ruleId": "R-1"}, "nodeId": RULE_NODE}]
    catalog.move_rule(RULE_NODE, CLAUSE_NODE)
    assert any("DELETE old" in q for q, _ in db.calls)


# --------------------- замки «проверить и записать» --------------------------


def _queries(db):
    return [q for q, _ in db.calls]


def test_create_target_checks_twin_under_lock_in_one_transaction(db):
    db.rows["\n            CREATE (t:CheckTarget {name: $name, description: $description, status: $status})"
            "\n            SET t.source = $source\n            RETURN elementId(t) AS nodeId, properties(t) AS props"
            "\n            "] = [{"nodeId": "4:db:7", "props": {"name": "проект"}}]
    catalog.create_check_target("проект")
    queries = _queries(db)
    assert queries[0] == catalog.Q_KEY_LOCK and queries[1] == Q_TARGET_NAMES
    assert db.calls[0][1] == {"key": "CheckTarget.name"}
    assert db.writes == [0], "замок, проверка и создание — одна транзакция"


def test_target_rename_takes_lock_before_twin_check(db):
    _exists(db, "4:db:7", ["CheckTarget"], name="проект")
    catalog.update_properties("4:db:7", {"name": "Проект"})
    queries = _queries(db)
    assert queries.index(catalog.Q_KEY_LOCK) < queries.index(Q_TARGET_NAMES)


def test_auto_ids_are_picked_under_lock(db):
    """Подбор свободного id и создание — в транзакции под замком (не 409 при гонке)."""
    _exists(db, ORDER_NODE, ["Order"], orderId="PR-01")

    def fake_run(query, **params):
        db.calls.append((query, params))
        if "CREATE (c:Clause" in query:
            return [{"nodeId": CLAUSE_NODE, "props": {"clauseId": params["id"]}}]
        return db.rows.get(query, [])

    catalog._run = fake_run
    catalog.create_clause(ORDER_NODE, "1.1", "текст")
    queries = _queries(db)
    lock = queries.index(catalog.Q_KEY_LOCK)
    assert lock < queries.index(catalog.Q_CLAUSE_ID_TAKEN)
    assert db.calls[lock][1] == {"key": "Clause.clauseId"} and db.writes


def test_rule_creation_logs_once_after_commit(db, caplog, monkeypatch):
    """Повтор транзакции драйвером не задваивает запись в журнале."""
    _exists(db, CLAUSE_NODE, ["Clause"], code="1.1")

    def fake_run(query, **params):
        db.calls.append((query, params))
        if query == catalog.Q_CREATE_RULE:
            return [{"nodeId": RULE_NODE, "props": {"ruleId": params["id"]}}]
        return db.rows.get(query, [])

    catalog._run = fake_run

    def retrying_write(work):
        work(catalog._run)  # первая попытка «упала» после работы
        return work(catalog._run)

    monkeypatch.setattr(catalog, "_write", retrying_write)
    caplog.set_level("INFO", logger="catalog")
    catalog.create_rule(CLAUSE_NODE, "PROHIBITION", "описание")
    assert caplog.text.count("Создано правило") == 1


# ------------------------------ ремонт: новые ключи ---------------------------


def test_repair_assigns_job_description_ids_and_reports_unfixable(db):
    def fake_run(query, **params):
        db.calls.append((query, params))
        if "MATCH (n:JobDescription) WHERE (n.jobDescriptionId IS NULL" in query:
            return [{"nodeId": "4:db:40", "title": "Ведущий аналитик", "departmentId": "UCT"}]
        if query.startswith("MATCH (n:JobDescription) WHERE n.jobDescriptionId IS NOT NULL"):
            return [{"id": "UCT/ведущий_аналитик"}]
        if "MATCH (n:CheckTarget) WHERE (n.name IS NULL" in query:
            return [{"nodeId": "4:db:41"}]
        if "MATCH (n:Department) WHERE (n.departmentId IS NULL" in query:
            return [{"nodeId": "4:db:42"}]
        return []

    catalog._run = fake_run
    report = catalog.repair_identifiers()
    assert report["jobDescriptions"] == 1
    assigned = [p["value"] for q, p in db.calls if "SET n.jobDescriptionId" in q]
    assert assigned == ["UCT/ведущий_аналитик.2"]
    assert report["unnamedTargets"] == ["4:db:41"] and report["departmentsWithoutId"] == ["4:db:42"]
    assert not any("SET n.name" in q or "SET n.departmentId" in q for q, _ in db.calls)
