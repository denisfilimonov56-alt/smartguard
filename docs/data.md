# Работа с данными

[← README](../README.md)

## Данные: база — источник истины

Каталог хранится в двух файлах `neo4j/init/`:

| Файл | Что в нём | Когда применяется |
|---|---|---|
| `seed.cypher` | только схема: ограничения и индексы | сидером при каждом `docker compose up`, идемпотентно |
| `data.cypher` | данные каталога — выгрузка из живой базы | только вместе со стандартным `seed.cypher` и только к пустому каталогу (первый запуск на новой базе) или по явному `SEED_DATA=1`; при `reset_and_load` и миграциях не применяется даже с `SEED_DATA=1` |

Сами приказы не пишутся в файл руками — они выгружаются из живой базы
(на хосте, из каталога с `docker-compose.yml`):

```bash
docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
  && mv neo4j/init/data.cypher.new neo4j/init/data.cypher
git diff neo4j/init/data.cypher      # что поменялось в нормативке
git commit neo4j/init/data.cypher
```

Сразу `> neo4j/init/data.cypher` нельзя: оболочка обнулит файл до начала
выгрузки, и при её сбое прежние данные пропадут. После `mv` файл
принадлежит тому, кто выгружал. Если нужна выгрузка изнутри контейнера
(`--output`, ниже), выдайте uid 10001 право записи в файл:
`sudo chgrp 10001 neo4j/init/data.cypher && sudo chmod g+w neo4j/init/data.cypher`.

Внутри контейнера: `docker compose exec api python export_graph.py --output /init/data.cypher`.
`--output` пишет во временный `<файл>.new` рядом и затем `os.replace`, если
процессу API (uid 10001) можно писать в каталог `neo4j/init`. Если право
выдано только на сам файл — тогда выгрузка, уже собранная целиком,
записывается прямо в `data.cypher`. Нет права и на файл — ошибка с
подсказкой про `--stdout`, прежний `data.cypher` цел.
Свойство или связь с пустым именем в графе — понятная ошибка выгрузки
(в Cypher их не записать), файл не трогается.

Скрипт одной транзакцией чтения снимает приказы, пункты, правила, атрибуты,
примеры, подразделения, должностные инструкции и связи и пишет идемпотентный
`MERGE`-скрипт со стабильным порядком строк. Реестр пользователей, настройки,
ключи доступа, история проверок и оценки SMART в выгрузку не попадают.

Подъём стека данные не трогает: правки из интерфейса после выгрузки
сохраняются. При непустом каталоге `data.cypher` даже не читается; нечитаемый
или не в UTF-8 файл мешает, только когда данные действительно применяются, —
тогда сидер завершается с понятной ошибкой (код 1) и API не стартует. Вернуть каталог к состоянию файла — явно, после [резервной копии](#резервная-копия):

```bash
docker compose run --rm -e SEED_DATA=1 seeder
```

`MERGE` выгрузки возвращает свойства и связи из файла, но не удаляет
узлы, заведённые после выгрузки.

## Резервная копия

Перед любой операцией, которая меняет или удаляет данные (`reset_and_load`,
миграции, `SEED_DATA=1`, релиз), снимается дамп базы. Neo4j 5 Community
делает дамп только остановленной базы, поэтому `api` и `neo4j` на это время
останавливаются (на маленькой базе — около минуты). Команды выполняются из
каталога проекта:

```bash
docker compose stop api neo4j
mkdir -p backups && chmod 700 backups          # в дампе весь каталог — посторонним незачем
d="backups/$(date +%Y%m%d-%H%M%S)" && mkdir "$d" && chmod 777 "$d"
docker compose run --rm --no-deps -v "$PWD/$d:/backups" neo4j sh -ec '
  neo4j-admin database dump neo4j --to-path=/backups
  printf "server.directories.data=/tmp/verify\nserver.directories.transaction.logs.root=/tmp/verify/transactions\n" > /tmp/verify.conf
  neo4j-admin database load neo4j --from-path=/backups --additional-config=/tmp/verify.conf
  neo4j-admin database check neo4j --additional-config=/tmp/verify.conf --report-path=/tmp
  echo "ДАМП ПРОВЕРЕН: /backups/neo4j.dump"'
docker compose start neo4j api                 # обязательно, даже если дамп не удался
cp neo4j/init/data.cypher "$d/" 2>/dev/null || true
```

Что происходит в `docker compose run`: дамп снимается с тома `neo4j_data`
в `backups/<дата>/neo4j.dump`, затем проверяется — загружается во временный
каталог внутри одноразового контейнера (не в том `neo4j_data`) и прогоняется
`neo4j-admin database check`. Для проверки нужно свободное место размером
с базу. Копия годится, только если команда завершилась строкой
«ДАМП ПРОВЕРЕН»; любая ошибка (`sh -e`) значит, что дамп обрезан или
повреждён — разрушающие операции не начинайте. Проверка по размеру
файла повреждения не ловит: дамп пустой базы Neo4j 5.26 весит около 13 КБ.
Рядом с дампом кладётся копия текущего `data.cypher`. Каталог `backups/`
в git не попадает; другой диск — замените `backups` на свой путь.

Восстановление заменяет базу целиком:

```bash
docker compose stop api neo4j
docker compose run --rm --no-deps -v "$PWD/backups/<дата>:/backups" neo4j \
  neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true
docker compose start neo4j api
```

Журнал аудита в дамп не входит: он лежит в файлах на томе `api_audit`
([подробнее](security.md#журнал-аудита)), копируйте его отдельно.

### Полный сброс и загрузка

`neo4j/init/reset_and_load.cypher` удаляет все узлы каталога и заводит его заново —
уже со всеми полями, которых требуют текущие проверки: бизнес-ключи, статусы,
описания атрибутов, примеры нужного вида. Пользователи интерфейса (`:User`)
и их роли при сбросе сохраняются.

Сначала — [резервная копия](#резервная-копия), затем:

```bash
docker compose run --rm -e SEED_FILE=/init/reset_and_load.cypher seeder
curl -s localhost:8080/ready | python3 -m json.tool     # ожидается ready
docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
  && mv neo4j/init/data.cypher.new neo4j/init/data.cypher
```

`data.cypher` при этом не применяется даже с `SEED_DATA=1`: он шёл бы
в той же транзакции и перекрыл бы сброс.

Очистка и загрузка выполняются одной транзакцией вместе с увеличением
версии каталога: API не увидит каталог пустым посреди сброса и не позже чем
через 30 секунд сбросит кэш готовых ответов — чистить его руками не нужно.
Полная альтернатива, если не жаль тома целиком:
`docker compose down && docker volume rm <проект>_neo4j_data`.

В скрипте заведено то, что видно по ответам API: ПР-01, пункты 1.1 и 2.4.
Остальную нормативку добавляйте по закомментированному шаблону в конце файла
или через интерфейс — он делает ровно то же самое.

### Миграции

Разовые правки данных лежат в `neo4j/init/migrations/` и запускаются
тем же сидером через `SEED_FILE`. Как и сброс, каждая миграция выполняется
одной транзакцией и увеличивает версию каталога; `data.cypher` вместе
с миграцией не применяется. Перед миграцией — [резервная копия](#резервная-копия).

```bash
docker compose run --rm -e SEED_FILE=/init/migrations/001_cleanup_demo_data.cypher seeder
docker compose run --rm \
  -e SEED_FILE=/init/migrations/002_check_target_descriptions.cypher seeder
```

| Миграция | Что делает |
|---|---|
| `001_cleanup_demo_data` | удаляет демо-приказы ПР-2024-15 / ПР-2024-22 со всеми пунктами, правилами и примерами и примеры, оставшиеся без правила. Двойников атрибутов больше не сводит и атрибуты без правил не удаляет — двойников сводит API (ниже) |
| `002_check_target_descriptions` | проставляет описания атрибутам `проект` и `срок_исполнения`; шаблон для остальных внутри файла |
| `003_job_descriptions` | заводит атрибут «дублирование_должностных_обязанностей» (определяется по должностным инструкциям) и, если в базе есть пункт 3.5 без правил, запрет `R-3.5` на нём |
| `004_settings_api_keys` | создаёт ограничения уникальности для настроек (`:Setting`) и ключей доступа (`:ApiKey`); данных не меняет |
| `005_drop_exceptions` | удаляет связи `EXCEPT_IN`: исключений больше нет, проверка их не учитывает. До запуска отметьте «Не действует» там, где правило в подразделении действовать не должно |

Двойников атрибутов («срок исполнения» / «срок_исполнения») сводит
`POST /catalog/merge-duplicate-targets` — кнопка «Свести двойников»
в «Замечаниях» (администратор). Нормализация та же, что у проверки
и диагностики; связи правил переносятся на оставшийся узел. Сводятся только
двойники с одинаковыми статусом и `source`; смешанные группы (архивный
и действующий, «по инструкции» и обычный) остаются — их сводят вручную.

Миграции правят существующую базу, не удаляя её. Если проще начать с чистого
листа — используйте `reset_and_load.cypher` выше.

### Порядок приведения базы в порядок

```bash
# сначала — резервная копия (раздел выше)
docker compose run --rm -e SEED_FILE=/init/migrations/001_cleanup_demo_data.cypher seeder
docker compose run --rm -e SEED_FILE=/init/migrations/002_check_target_descriptions.cypher seeder
curl -s localhost:8080/ready | python3 -m json.tool   # что ещё осталось починить
# свести двойников («Замечания» → «Свести двойников»), дописать описания
# оставшимся атрибутам, затем зафиксировать состояние:
docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
  && mv neo4j/init/data.cypher.new neo4j/init/data.cypher
git diff neo4j/init/data.cypher
```
