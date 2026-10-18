// ============================================================
//  Миграция 001 — убрать демонстрационные данные и свести дубли
//
//  Запуск:
//    docker compose run --rm \
//      -e SEED_FILE=/init/migrations/001_cleanup_demo_data.cypher seeder
//
//  Что делает:
//    1. Удаляет демо-приказы ПР-2024-15 и ПР-2024-22 со всеми
//       пунктами, правилами и примерами. Рабочий набор — ПР-01.
//    2. Сводит узлы :CheckTarget, отличающиеся только пробелом,
//       дефисом или регистром («срок исполнения» / «срок_исполнения»),
//       к одному. Именно из-за такой пары правило R-2.4 срабатывало
//       как невыполненное, хотя срок в цели был распознан.
//    3. Удаляет атрибуты, к которым после этого не привязано правил.
//
//  Скрипт идемпотентен: повторный запуск ничего не меняет.
//  ВНИМАНИЕ: шаги 1 и 3 удаляют узлы. Сделайте дамп базы перед запуском:
//    docker compose exec neo4j neo4j-admin database dump neo4j --to-stdout > backup.dump
// ============================================================

// ---------- 1. Демонстрационные приказы ----------
MATCH (o:Order)
WHERE o.orderId IN ["PR-2024-15", "PR-2024-22"]
OPTIONAL MATCH (o)-[:CONTAINS]->(c:Clause)
OPTIONAL MATCH (c)-[:DEFINES]->(r:Rule)
OPTIONAL MATCH (r)-[:HAS_EXAMPLE]->(e:ViolationExample)
DETACH DELETE e, r, c, o;

// ---------- 2. Дубликаты атрибутов ----------
// Канонический узел — тот, у которого заполнено описание: без описания
// атрибут не попадает в промпт с критерием, и модель его не распознаёт.
MATCH (t:CheckTarget)
WITH toLower(replace(replace(trim(t.name), ' ', '_'), '-', '_')) AS norm,
     collect(t) AS nodes
WHERE size(nodes) > 1
WITH nodes,
     head(
       [n IN nodes WHERE n.description IS NOT NULL AND trim(n.description) <> ''] + nodes
     ) AS keep
UNWIND nodes AS dup
WITH keep, dup
WHERE elementId(dup) <> elementId(keep)
MATCH (r:Rule)-[rel:APPLIES_TO]->(dup)
MERGE (r)-[:APPLIES_TO]->(keep)
DELETE rel;

// ---------- 3. Осиротевшие атрибуты ----------
MATCH (t:CheckTarget)
WHERE NOT (:Rule)-[:APPLIES_TO]->(t)
DETACH DELETE t;

// ---------- 4. Осиротевшие примеры ----------
MATCH (e:ViolationExample)
WHERE NOT (:Rule)-[:HAS_EXAMPLE]->(e)
DETACH DELETE e;
