// ============================================================
//  ПОЛНЫЙ СБРОС И ЗАГРУЗКА КАТАЛОГА
//
//  ВНИМАНИЕ: скрипт УДАЛЯЕТ ВСЕ УЗЛЫ КАТАЛОГА, а затем заводит
//  каталог заново — уже со всеми полями, которых требуют
//  текущие проверки и интерфейс. Пользователи интерфейса (:User)
//  и их роли сохраняются.
//
//  Перед запуском сделайте дамп:
//    docker compose exec neo4j \
//      neo4j-admin database dump neo4j --to-stdout > backup.dump
//
//  Запуск:
//    docker compose run --rm \
//      -e SEED_FILE=/init/reset_and_load.cypher seeder
//
//  Что получается на выходе:
//    * у каждого узла заполнен бизнес-ключ
//      (orderId / clauseId / ruleId / exampleId / name)
//    * у каждого узла проставлен status = 'active'
//    * у каждого атрибута заполнен description — без него модель
//      системно не распознаёт атрибут, и правило срабатывает всегда
//    * имена атрибутов в одном написании (через подчёркивание),
//      без двойников вида «срок исполнения» / «срок_исполнения»
//    * у каждого правила есть примеры того вида, который оно
//      показывает в ответе проверки
//
//  После запуска зафиксируйте состояние в репозитории:
//    docker compose exec api python export_graph.py --output /init/seed.cypher
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

// Реестр пользователей интерфейса (api/users.py). В выгрузку не попадает.
CREATE CONSTRAINT user_login IF NOT EXISTS
FOR (u:User) REQUIRE u.login IS UNIQUE;

// Настройки сервиса и ключи доступа внешних систем (api/settings.py,
// api/apikeys.py). В выгрузку не попадают.
CREATE CONSTRAINT setting_key IF NOT EXISTS
FOR (s:Setting) REQUIRE s.key IS UNIQUE;

CREATE CONSTRAINT api_key_id IF NOT EXISTS
FOR (k:ApiKey) REQUIRE k.keyId IS UNIQUE;

CREATE FULLTEXT INDEX rule_description_ft IF NOT EXISTS
FOR (r:Rule) ON EACH [r.description];

// ---------- ОЧИСТКА ----------
// Удаляются все узлы каталога. Узлы :User не трогаются: иначе сброс
// каталога лишал бы доступа всех, кому роль назначена в интерфейсе.
// Для очень большой базы удаляйте партиями: оберните оператор в
//   CALL { ... } IN TRANSACTIONS OF 10000 ROWS;
MATCH (n) WHERE n:Order OR n:Clause OR n:Rule
             OR n:CheckTarget OR n:ViolationExample OR n:Department
             OR n:JobDescription
DETACH DELETE n;

// ---------- Атрибуты (:CheckTarget) ----------
// description — это то, что уходит в промпт модели. Формулируйте как
// перечисление признаков, по которым видно, есть атрибут в цели или нет.
// Имена — в одном написании, через подчёркивание.

MERGE (t:CheckTarget {name: "проект"})
SET t.status = "active",
    t.description = "в цели явно назван проект, программа или инициатива, в рамках которой ведётся работа: 'в рамках проекта X', 'по проекту X'. Название системы, продукта или подразделения само по себе проектом не считается";

MERGE (t:CheckTarget {name: "срок_исполнения"})
SET t.status = "active",
    t.description = "в цели указан проверяемый срок: конкретная дата, месяц, квартал или год ('до 01.06.2025', 'до конца II квартала 2025'). Формулировки без даты — 'в ближайшее время', 'по возможности', 'до конца отчётного периода' — сроком не считаются";

// ---------- Приказ ПР-01 ----------
MERGE (o:Order {orderId: "PR-01"})
SET o.number = "ПР-01",
    o.title  = "О порядке постановки целей",
    o.status = "active";
//  Если известна дата приказа, добавьте её:
//  SET o.date = date("2024-01-01");

// ---------- Пункт 1.1 ----------
MATCH (o:Order {orderId: "PR-01"})
MERGE (c:Clause {clauseId: "PR-01/1.1"})
SET c.code = "1.1",
    c.status = "active",
    c.text = "В цели должно быть упоминание проекта, в рамках которого производится работа"
MERGE (o)-[:CONTAINS]->(c);

MATCH (c:Clause {clauseId: "PR-01/1.1"})
MERGE (r:Rule {ruleId: "R-1.1"})
SET r.type = "REQUIREMENT",
    r.status = "active",
    r.description = "Цель обязана содержать упоминание проекта",
    r.checkInstruction = "Проверь, указан ли в тексте цели проект, в рамках которого выполняется работа. Если проект не указан явно — правило нарушено."
MERGE (c)-[:DEFINES]->(r);

MATCH (r:Rule {ruleId: "R-1.1"}), (t:CheckTarget {name: "проект"})
MERGE (r)-[:APPLIES_TO]->(t);

// Требование показывает в ответе образцы правильных формулировок
// (isViolation = false). Пример нарушения добавлен для полноты картины.
MATCH (r:Rule {ruleId: "R-1.1"})
MERGE (e:ViolationExample {exampleId: "R-1.1-EX1"})
SET e.status = "active",
    e.isViolation = false,
    e.text = "В рамках проекта «Альфа» разработать API для интеграции до 01.06.2025"
MERGE (r)-[:HAS_EXAMPLE]->(e);

MATCH (r:Rule {ruleId: "R-1.1"})
MERGE (e:ViolationExample {exampleId: "R-1.1-EX2"})
SET e.status = "active",
    e.isViolation = true,
    e.text = "Реализовать требования по автоматизации процесса в системе 1С:KPI"
MERGE (r)-[:HAS_EXAMPLE]->(e);

// ---------- Пункт 2.4 ----------
MATCH (o:Order {orderId: "PR-01"})
MERGE (c:Clause {clauseId: "PR-01/2.4"})
SET c.code = "2.4",
    c.status = "active",
    c.text = "Цель должна иметь конкретные сроки исполнения"
MERGE (o)-[:CONTAINS]->(c);

MATCH (c:Clause {clauseId: "PR-01/2.4"})
MERGE (r:Rule {ruleId: "R-2.4"})
SET r.type = "REQUIREMENT",
    r.status = "active",
    r.description = "Цель обязана содержать конкретный срок исполнения",
    r.checkInstruction = "Проверь, есть ли в цели конкретная дата или период исполнения. Формулировки 'в ближайшее время', 'по возможности' — нарушение."
MERGE (c)-[:DEFINES]->(r);

MATCH (r:Rule {ruleId: "R-2.4"}), (t:CheckTarget {name: "срок_исполнения"})
MERGE (r)-[:APPLIES_TO]->(t);

MATCH (r:Rule {ruleId: "R-2.4"})
MERGE (e:ViolationExample {exampleId: "R-2.4-EX1"})
SET e.status = "active",
    e.isViolation = false,
    e.text = "Внедрить систему мониторинга в проекте «Бета» до 15.09.2025"
MERGE (r)-[:HAS_EXAMPLE]->(e);

MATCH (r:Rule {ruleId: "R-2.4"})
MERGE (e:ViolationExample {exampleId: "R-2.4-EX2"})
SET e.status = "active",
    e.isViolation = true,
    e.text = "Доработать функционал до конца отчётного периода"
MERGE (r)-[:HAS_EXAMPLE]->(e);

// ============================================================
//  ШАБЛОН ДЛЯ ОСТАЛЬНОЙ НОРМАТИВКИ
//
//  Здесь заведены только те пункты, которые видны по ответам
//  вашего API: ПР-01 п. 1.1 и п. 2.4. Остальное добавляйте по
//  образцу ниже — или через интерфейс на http://localhost:3000,
//  он делает ровно то же самое.
//
//  1) Атрибут:
//     MERGE (t:CheckTarget {name: "обучающий_материал"})
//     SET t.status = "active",
//         t.description = "целью является изучение чего-либо или разработка обучающих материалов: курс, инструкция, регламент, обучение сотрудников";
//
//  2) Пункт:
//     MATCH (o:Order {orderId: "PR-01"})
//     MERGE (c:Clause {clauseId: "PR-01/3.2"})
//     SET c.code = "3.2", c.status = "active",
//         c.text = "Текст пункта приказа"
//     MERGE (o)-[:CONTAINS]->(c);
//
//  3) Правило. type = REQUIREMENT — нарушено, когда атрибута НЕТ
//     в цели; type = PROHIBITION — нарушено, когда атрибут ЕСТЬ:
//     MATCH (c:Clause {clauseId: "PR-01/3.2"})
//     MERGE (r:Rule {ruleId: "R-3.2"})
//     SET r.type = "PROHIBITION", r.status = "active",
//         r.description = "Формулировка правила",
//         r.checkInstruction = "Что подсказать автору цели"
//     MERGE (c)-[:DEFINES]->(r);
//
//  4) Привязка правила к атрибуту — без неё правило не сработает:
//     MATCH (r:Rule {ruleId: "R-3.2"}), (t:CheckTarget {name: "обучающий_материал"})
//     MERGE (r)-[:APPLIES_TO]->(t);
//
//  5) Пример. Для PROHIBITION нужен isViolation = true,
//     для REQUIREMENT — isViolation = false: именно этот вид
//     попадает в поле examples ответа проверки.
//     MATCH (r:Rule {ruleId: "R-3.2"})
//     MERGE (e:ViolationExample {exampleId: "R-3.2-EX1"})
//     SET e.status = "active", e.isViolation = true,
//         e.text = "Так формулировать нельзя"
//     MERGE (r)-[:HAS_EXAMPLE]->(e);
//
//  6) Перекрёстная ссылка между пунктами (на проверку не влияет):
//     MATCH (a:Clause {clauseId: "PR-01/3.2"}), (b:Clause {clauseId: "PR-01/1.1"})
//     MERGE (a)-[:REFERENCES]->(b);
//
//  7) Подразделение. departmentId — идентификатор, который кадровая
//     система передаёт в запросе проверки (department_id):
//     MERGE (d:Department {departmentId: "UCT"})
//     SET d.name = "УЦТ", d.status = "active";
//
//  8) Правило действует только в перечисленных подразделениях
//     (без таких связей правило действует для всех):
//     MATCH (r:Rule {ruleId: "R-1.1"}), (d:Department)
//     WHERE d.departmentId IN ["UCT", "AGD"]
//     MERGE (r)-[:ONLY_IN]->(d);
// ============================================================
