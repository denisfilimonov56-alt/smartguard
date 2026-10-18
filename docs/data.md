# Работа с данными

[← README](../README.md)

## Данные: база — источник истины

`neo4j/init/seed.cypher` содержит только схему (ограничения и индексы) и
маркер `// ---------- Данные ----------`. Сами приказы не пишутся в файл
руками — они выгружаются из живой базы:

```bash
docker compose exec api python export_graph.py --output /init/seed.cypher
```

Скрипт снимает приказы, пункты, правила, атрибуты, примеры, подразделения и связи и
дописывает в файл идемпотентный `MERGE`-скрипт со стабильным порядком
строк. После этого `docker compose up` воспроизводит граф один в один,
а `git diff` показывает, что именно поменялось в нормативке.

Посмотреть выгрузку, ничего не записывая:

```bash
docker compose exec api python export_graph.py --stdout
```

### Полный сброс и загрузка

`neo4j/init/reset_and_load.cypher` удаляет все узлы каталога и заводит его заново —
уже со всеми полями, которых требуют текущие проверки: бизнес-ключи, статусы,
описания атрибутов, примеры нужного вида. Пользователи интерфейса (`:User`)
и их роли при сбросе сохраняются.

```bash
docker compose exec neo4j neo4j-admin database dump neo4j --to-stdout > backup.dump
docker compose run --rm -e SEED_FILE=/init/reset_and_load.cypher seeder
curl -s localhost:8080/ready | python3 -m json.tool     # ожидается ready
docker compose exec api python export_graph.py --output /init/seed.cypher
```

Скрипт удаляет данные — дамп перед запуском обязателен. Полная альтернатива,
если не жаль тома целиком: `docker compose down && docker volume rm <проект>_neo4j_data`.

В скрипте заведено то, что видно по ответам API: ПР-01, пункты 1.1 и 2.4.
Остальную нормативку добавляйте по закомментированному шаблону в конце файла
или через интерфейс — он делает ровно то же самое.

### Миграции

Разовые правки данных лежат в `neo4j/init/migrations/` и запускаются
тем же сидером через `SEED_FILE`:

```bash
# перед любой миграцией — дамп
docker compose exec neo4j neo4j-admin database dump neo4j --to-stdout > backup.dump

docker compose run --rm \
  -e SEED_FILE=/init/migrations/001_cleanup_demo_data.cypher seeder
docker compose run --rm \
  -e SEED_FILE=/init/migrations/002_check_target_descriptions.cypher seeder
```

| Миграция | Что делает |
|---|---|
| `001_cleanup_demo_data` | удаляет демо-приказы ПР-2024-15 / ПР-2024-22, сводит двойники `CheckTarget`, чистит осиротевшие атрибуты и примеры |
| `002_check_target_descriptions` | проставляет описания атрибутам `проект` и `срок_исполнения`; шаблон для остальных внутри файла |
| `003_job_descriptions` | заводит атрибут «дублирование_должностных_обязанностей» (определяется по должностным инструкциям) и, если в базе есть пункт 3.5 без правил, запрет `R-3.5` на нём |
| `004_settings_api_keys` | создаёт ограничения уникальности для настроек (`:Setting`) и ключей доступа (`:ApiKey`); данных не меняет |
| `005_drop_exceptions` | удаляет связи `EXCEPT_IN`: исключений больше нет, проверка их не учитывает. До запуска отметьте «Не действует» там, где правило в подразделении действовать не должно |

Миграции правят существующую базу, не удаляя её. Если проще начать с чистого
листа — используйте `reset_and_load.cypher` выше.

### Порядок приведения базы в порядок

```bash
docker compose exec neo4j neo4j-admin database dump neo4j --to-stdout > backup.dump
docker compose run --rm -e SEED_FILE=/init/migrations/001_cleanup_demo_data.cypher seeder
docker compose run --rm -e SEED_FILE=/init/migrations/002_check_target_descriptions.cypher seeder
curl -s localhost:8080/ready | python3 -m json.tool   # что ещё осталось починить
# дописать описания оставшимся атрибутам, затем зафиксировать состояние:
docker compose exec api python export_graph.py --output /init/seed.cypher
git diff neo4j/init/seed.cypher
```
