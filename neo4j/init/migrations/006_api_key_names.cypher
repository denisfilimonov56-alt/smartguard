// ============================================================
//  Миграция 006: уникальные названия ключей доступа
//
//  Ключ внешней системы учитывается в квоте и истории по названию
//  (key:<название>), поэтому два ключа с одним названием делили бы квоту.
//  api/apikeys.py пишет в узел nameKey — название в нижнем регистре;
//  миграция заполняет его у ключей, созданных раньше, и ставит
//  ограничение уникальности, чтобы одноимённые ключи не появились и при
//  одновременных запросах.
//
//  Если одноимённые ключи уже есть, nameKey получает только самый ранний,
//  у остальных к нему дописывается #keyId — их стоит отозвать и выпустить
//  заново под другими названиями.
//
//  Скрипт идемпотентен. Запуск:
//      docker compose run --rm \
//        -e SEED_FILE=/init/migrations/006_api_key_names.cypher seeder
// ============================================================

MATCH (k:ApiKey) WHERE k.nameKey IS NULL
WITH toLower(k.name) AS nameKey, k ORDER BY k.createdAt, k.keyId
WITH nameKey, collect(k) AS keys
OPTIONAL MATCH (taken:ApiKey {nameKey: nameKey})
WITH nameKey, keys, count(taken) AS busy
UNWIND range(0, size(keys) - 1) AS i
WITH keys[i] AS k, CASE WHEN i = 0 AND busy = 0 THEN nameKey
                        ELSE nameKey + '#' + keys[i].keyId END AS value
SET k.nameKey = value;

CREATE CONSTRAINT api_key_name_key IF NOT EXISTS
FOR (k:ApiKey) REQUIRE k.nameKey IS UNIQUE;
