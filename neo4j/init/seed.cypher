// ============================================================
//  Схема графа нормативных требований к формулировке целей
//
//  Модель данных (совпадает с запросами в api/graph.py):
//    (:Order   {orderId, number, title, date, status})
//      -[:CONTAINS]->   (:Clause {clauseId, code, text})
//      -[:DEFINES]->    (:Rule   {ruleId, type, description, checkInstruction, studentsOnly})
//      -[:APPLIES_TO]-> (:CheckTarget {name, description})
//    (:Rule)-[:HAS_EXAMPLE]->(:ViolationExample {exampleId, text, isViolation})
//    (:Clause)-[:REFERENCES]->(:Clause)
//
//  Rule.type:
//    PROHIBITION — нарушение, если атрибут ПРИСУТСТВУЕТ в цели
//    REQUIREMENT — нарушение, если атрибут ОТСУТСТВУЕТ в цели
//
//  Разграничение по подразделениям:
//    (:Department {departmentId, name, status})
//    (:Rule)-[:ONLY_IN]->(:Department)      правило действует только в перечисленных
//    Правило без ONLY_IN действует для всех.
//
//  Правила только для студентов:
//    Rule.studentsOnly = true — проверяется, только если в запросе проверки
//    передано is_student = true; без признака применяются все правила.
//
//  Должностные инструкции:
//    (:Department)-[:HAS_JOB_DESCRIPTION]->(:JobDescription {jobDescriptionId, title, text, status})
//    (:CheckTarget {source: "job_descriptions"}) — атрибут определяется не по
//    тексту цели, а сравнением цели с инструкциями её подразделения.
//
//  ------------------------------------------------------------
//  ЗДЕСЬ ТОЛЬКО СХЕМА. Сидер выполняет этот файл при каждом подъёме
//  стека, поэтому данных в нём нет: иначе каждый `docker compose up`
//  откатывал бы правки из интерфейса.
//
//  Данные каталога — в data.cypher рядом. Источник истины — сама база;
//  зафиксировать её состояние в репозитории (на хосте):
//
//      docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher
//
//  Сидер применяет data.cypher только к пустому каталогу (первый запуск
//  на новой базе) или по явному флагу — тогда MERGE возвращает каталог к
//  состоянию файла:
//
//      docker compose run --rm -e SEED_DATA=1 seeder
//
//  Любой запуск сидера с данными или миграцией увеличивает версию
//  каталога (:CatalogVersion), и API сбрасывает кэш готовых ответов.
//
//  Демонстрационные приказы ПР-2024-15 и ПР-2024-22 удалены намеренно:
//  рабочий набор — ПР-01. Убрать их из уже поднятой базы:
//
//      docker compose run --rm \
//        -e SEED_FILE=/init/migrations/001_cleanup_demo_data.cypher seeder
//  ------------------------------------------------------------
//
//  Скрипт идемпотентен: схема создаётся через IF NOT EXISTS.
// ============================================================

// ---------- Ограничения и индексы ----------
CREATE CONSTRAINT order_id IF NOT EXISTS
FOR (o:Order) REQUIRE o.orderId IS UNIQUE;

CREATE CONSTRAINT clause_id IF NOT EXISTS
FOR (c:Clause) REQUIRE c.clauseId IS UNIQUE;

CREATE CONSTRAINT rule_id IF NOT EXISTS
FOR (r:Rule) REQUIRE r.ruleId IS UNIQUE;

CREATE CONSTRAINT check_target_name IF NOT EXISTS
FOR (t:CheckTarget) REQUIRE t.name IS UNIQUE;

CREATE CONSTRAINT example_id IF NOT EXISTS
FOR (e:ViolationExample) REQUIRE e.exampleId IS UNIQUE;

CREATE CONSTRAINT department_id IF NOT EXISTS
FOR (d:Department) REQUIRE d.departmentId IS UNIQUE;

CREATE CONSTRAINT job_description_id IF NOT EXISTS
FOR (j:JobDescription) REQUIRE j.jobDescriptionId IS UNIQUE;

// Реестр пользователей интерфейса (api/users.py). В выгрузку не попадает.
CREATE CONSTRAINT user_login IF NOT EXISTS
FOR (u:User) REQUIRE u.login IS UNIQUE;

// Настройки сервиса и ключи доступа внешних систем (api/settings.py,
// api/apikeys.py). В выгрузку не попадают.
CREATE CONSTRAINT setting_key IF NOT EXISTS
FOR (s:Setting) REQUIRE s.key IS UNIQUE;

CREATE CONSTRAINT api_key_id IF NOT EXISTS
FOR (k:ApiKey) REQUIRE k.keyId IS UNIQUE;

// История проверок (api/history.py). В выгрузку не попадает.
CREATE INDEX check_record_at IF NOT EXISTS
FOR (r:CheckRecord) ON (r.at);

CREATE FULLTEXT INDEX rule_description_ft IF NOT EXISTS
FOR (r:Rule) ON EACH [r.description];

// Ограничение уникальности кэша оценок SMART (:SmartScore.goalHash) здесь
// не создаётся: API заводит его сам при первой записи оценки
// (graph._ensure_smart_schema), а если в базе уже есть двойники — оставляет
// обычный индекс. Ошибка в сидере остановила бы весь стек.

// Версия каталога: сидер и API увеличивают её при каждой правке каталога,
// API по ней сбрасывает кэш ответов (api/metrics.py). В выгрузку не попадает.
CREATE CONSTRAINT catalog_version_id IF NOT EXISTS
FOR (v:CatalogVersion) REQUIRE v.id IS UNIQUE;

// Служебные замки каталога (api/catalog.py, _lock_key): сериализуют
// «проверить, занято ли, и записать» — двойники атрибутов, подбор
// свободного id. Единственный узел на id. В выгрузку не попадает.
CREATE CONSTRAINT catalog_lock_id IF NOT EXISTS
FOR (l:CatalogLock) REQUIRE l.id IS UNIQUE;
