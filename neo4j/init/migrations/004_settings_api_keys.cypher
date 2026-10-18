// ============================================================
//  Миграция 004: настройки сервиса и ключи доступа внешних систем
//
//  Раздел «Настройки» хранит переключатели проверки в узлах :Setting,
//  а ключи внешних систем — в узлах :ApiKey (api/settings.py,
//  api/apikeys.py). Сами узлы заводит интерфейс; миграция создаёт только
//  ограничения уникальности, чтобы два одновременных запроса не завели
//  одну настройку или один ключ дважды.
//
//  Без миграции раздел тоже работает — ограничения лишь страховка.
//
//  Скрипт идемпотентен. Запуск:
//      docker compose run --rm \
//        -e SEED_FILE=/init/migrations/004_settings_api_keys.cypher seeder
// ============================================================

CREATE CONSTRAINT setting_key IF NOT EXISTS
FOR (s:Setting) REQUIRE s.key IS UNIQUE;

CREATE CONSTRAINT api_key_id IF NOT EXISTS
FOR (k:ApiKey) REQUIRE k.keyId IS UNIQUE;
