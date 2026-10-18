"""Тесты каталога: сборка дерева, адресация по nodeId, мягкое удаление.

Neo4j не нужен — низкоуровневые _run/_one подменяются диспетчером по тексту
запроса, поэтому проверяется логика, а не драйвер.
"""

import pytest

import catalog
from catalog import Conflict, NotFound

ORDER_NODE = "4:db:1"
CLAUSE_NODE = "4:db:2"
RULE_NODE = "4:db:3"
EXAMPLE_NODE = "4:db:4"

FETCH = """
        MATCH (n) WHERE elementId(n) = $node_id
        RETURN labels(n) AS labels, properties(n) AS props, elementId(n) AS nodeId
        """


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

    monkeypatch.setattr(catalog, "_run", fake_run)
    monkeypatch.setattr(catalog, "_one", fake_one)
    return type("DB", (), {"rows": rows, "calls": calls})


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
    db.rows["MATCH (t:CheckTarget) RETURN t.name AS name"] = [{"name": existing}]
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


def test_properties_date_handled_separately(db):
    """date — временной тип, его нельзя записать через SET n += $map."""
    _exists(db, ORDER_NODE, ["Order"], number="ПР-01")
    catalog.update_properties(ORDER_NODE, {"title": "новый", "date": "2024-03-01"})
    queries = [q for q, _ in db.calls]
    assert any("SET n += $props" in q for q in queries)
    assert any("date($value)" in q for q in queries)


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
    db.rows["MATCH (r:Rule)-[:APPLIES_TO]->(t) WHERE elementId(t) = $node_id "
            "RETURN r.ruleId AS rule_id"] = [{"rule_id": "R-1.1"}]
    with pytest.raises(Conflict) as exc:
        catalog.delete_node("4:db:7")
    assert "R-1.1" in str(exc.value)


def test_status_is_validated(db):
    with pytest.raises(Conflict):
        catalog.set_status(ORDER_NODE, "deleted")


def test_rule_type_is_validated():
    with pytest.raises(Conflict):
        catalog._validate_rule_type("OBLIGATION")


# ------------------------------ связи ---------------------------------------


def test_set_rule_targets_rejects_unknown(db):
    _exists(db, RULE_NODE, ["Rule"], ruleId="R-1.1")
    db.rows["MATCH (t:CheckTarget) RETURN t.name AS name"] = [{"name": "проект"}]
    with pytest.raises(NotFound) as exc:
        catalog.set_rule_targets(RULE_NODE, ["проект", "выдумка"])
    assert "выдумка" in str(exc.value)


def test_set_rule_targets_clears_old_links(db):
    _exists(db, RULE_NODE, ["Rule"], ruleId="R-1.1")
    db.rows["MATCH (t:CheckTarget) RETURN t.name AS name"] = [{"name": "проект"}]
    catalog.set_rule_targets(RULE_NODE, ["проект"])
    assert any("DELETE rel" in q for q, _ in db.calls)


# ------------------------------ подразделения -------------------------------

DEPARTMENT_NODE = "4:db:9"
Q_KNOWN_DEPARTMENTS = "MATCH (d:Department) RETURN d.departmentId AS id"
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
    queries = [q for q, _ in db.calls]
    assert any("[rel:ONLY_IN]" in q and "DELETE rel" in q for q in queries)
    assert any("MERGE (r)-[:ONLY_IN]->(d)" in q for q in queries)


def test_empty_scope_only_clears(db):
    _rule_with_departments(db, "UCT")
    catalog.set_rule_scope(RULE_NODE, [])
    assert not any("MERGE" in q for q, _ in db.calls), "пустая область — правило для всех"


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
         "title": "Аналитик", "status": "active", "chars": 1200, "duties": 12, "dutiesReviewed": True},
        {"parent": DEPARTMENT_NODE, "nodeId": "4:db:21", "jobDescriptionId": "UCT/old",
         "title": "Старая", "status": "archived", "chars": 10},
    ]
    assert catalog.list_departments()[0]["jobDescriptions"] == [
        {"nodeId": "4:db:20", "jobDescriptionId": "UCT/аналитик", "title": "Аналитик",
         "status": "active", "chars": 1200, "duties": 12, "dutiesReviewed": True}]
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
