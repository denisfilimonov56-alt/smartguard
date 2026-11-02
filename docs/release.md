# Релиз на сервере

[← README](../README.md) · [Установка на сервер](deployment.md)

Обновление установленного сервера на новую версию. Первая установка —
[установка на сервер](deployment.md). Команды выполняются в `/opt/goal-checker`;
в примерах прежняя версия — `v1.3.0`, новая — `v1.4.0`.

| Шаги | Сеть | Сервис |
|---|---|---|
| 1–2. Подготовка | нужна | работает |
| 3. Дамп базы | — | API и Neo4j остановлены ~1 минуту |
| 4–8. Код, настройки, образы, сборка, модель | нужна для 6–7 | работает прежняя версия |
| 9. Переключение | — | перезапуск, модель грузится до 15 минут |
| 10–11. Проверка, уборка | — | работает новая версия |

## Этапы релиза

### 1. Что меняется

```bash
cd /opt/goal-checker
git fetch --tags
git log --oneline v1.3.0..v1.4.0                          # что вошло в релиз
git diff v1.3.0 v1.4.0 -- .env                            # новые настройки — перенести на шаге 5
git diff --stat v1.3.0 v1.4.0 -- neo4j/init/migrations    # миграции базы
```

Есть миграции — сначала прочитайте [миграции](deployment.md#миграции).

### 2. Сервер

```bash
timedatectl                         # System clock synchronized: yes
df -h /var/lib/docker .             # несколько ГБ под новые образы
docker compose ps -a                # прежняя версия: running / healthy
```

### 3. Дамп базы

```bash
scripts/dump.sh
```

Продолжать можно, только если в выводе есть «ДАМП ПРОВЕРЕН» и последняя
строка — «готово: …». «ОШИБКА» — релиз не начинать
([резервная копия](deployment.md#резервная-копия)).

### 4. Код

Серверный `.env` и выгрузка `neo4j/init/data.cypher` откладываются: в git
лежит `.env` стенда, а `data.cypher` в старых версиях тоже был в git, и
checkout мог бы его заменить.

```bash
cp -p .env ~/goal-checker.env
rm -f ~/goal-checker.data.cypher
cp -p neo4j/init/data.cypher ~/goal-checker.data.cypher 2>/dev/null || true
git checkout -- .env
git checkout -- neo4j/init/data.cypher 2>/dev/null || true
git checkout v1.4.0
cp -p ~/goal-checker.env .env
[ -f ~/goal-checker.data.cypher ] && cp -p ~/goal-checker.data.cypher neo4j/init/data.cypher
git status --short                  # кроме .env правок быть не должно
```

### 5. Настройки

В `.env`: `APP_VERSION=1.4.0` (у каждого релиза свой тег — образы прежней
версии остаются для отката) и новые переменные из шага 1, если их
умолчания не подходят ([переменные](deployment.md#переменные-окружения)).

### 6. Образы

```bash
docker compose pull --ignore-buildable
```

Скачиваются только образы, которых нет на диске: тег не менялся — ничего
не качается. Модель на другом сервере (`VLLM_REPLICAS=0`) —
`docker compose pull neo4j autoheal`.

### 7. Сборка API и интерфейса

```bash
docker compose build --pull
```

Ошибка сборки останавливает релиз: работает ещё прежняя версия, верните код
и `.env` ([откат](#откат), без `docker compose up`).

### 8. Модель

Только если в релизе меняется модель. Веса docker не скачивает: положите
новую модель в каталог внутри `MODELS_DIR` и укажите его в `VLLM_MODEL_DIR`
(имя для API — `VLLM_MODEL`). Прежний каталог оставьте до проверки — для
отката.

### 9. Переключение

```bash
docker compose up -d --no-build
```

Пересоздаются контейнеры, у которых поменялись образ или настройки. Сеть
не нужна.

### 10. Проверка

```bash
docker compose ps -a                # running / healthy, seeder — exited (0)
curl -s localhost:8080/ready        # "status": "ready" — когда модель загрузится (до 15 минут)
docker compose logs --tail 50 api   # без ошибок при старте
```

Затем — вход в интерфейс и проверка одной цели. Не работает — [откат](#откат).

### 11. Уборка

Образы прежней версии оставьте до следующего релиза, позапрошлой — удалите:

```bash
docker image ls 'goal-checker-*'
docker image rm goal-checker-api:1.2.0 goal-checker-web:1.2.0
docker image prune                  # образы без тега
```

## Откат

Образы прежней версии на сервере (у релизов разные `APP_VERSION`) — сеть
не нужна:

```bash
cp -p .env ~/goal-checker.env
rm -f ~/goal-checker.data.cypher
mv neo4j/init/data.cypher ~/goal-checker.data.cypher   # до checkout, см. ниже
git checkout -- .env
git checkout v1.3.0
cp -p ~/goal-checker.env .env
cp -p ~/goal-checker.data.cypher neo4j/init/data.cypher
# в .env: APP_VERSION=1.3.0
docker compose up -d --no-build
```

`data.cypher` в `.gitignore`, но если в прежней версии он лежал в git,
`git checkout` **молча перезапишет** серверную выгрузку — git не охраняет
игнорируемые файлы. Поэтому файл откладывается при любом откате.

Образов прежней версии нет — шаги 4–9 на прежней версии. Если новая версия
применила миграции, данные возвращает только дамп шага 3
([восстановление](deployment.md#резервная-копия)).

## Сеть для релиза через прокси

Не прописывайте прокси в `proxies` файла `~/.docker/config.json`: docker
подставит `HTTP_PROXY`/`HTTPS_PROXY` во **все** контейнеры, и через прокси
пойдут внешний `VLLM_URL` и корпоративный Keycloak (сервисы стека исключены
сами через `NO_PROXY`; внешние адреса пришлось бы дописать в `NO_PROXY_EXTRA`).
Надёжнее дать прокси только шагам, которым нужна сеть:

| Шаг | Как передать прокси |
|---|---|
| 1. `git fetch` | `git -c http.proxy=http://proxy:3128 fetch --tags` |
| 6. `docker compose pull` | образы качает демон Docker: `/etc/systemd/system/docker.service.d/http-proxy.conf` с `[Service]` и `Environment="HTTPS_PROXY=http://proxy:3128"`, затем `sudo systemctl daemon-reload && sudo systemctl restart docker`. Перезапуск демона перезапускает стек — делайте до шага 9 или в окно обслуживания |
| 7. `docker compose build` | `docker compose build --pull --build-arg HTTP_PROXY=http://proxy:3128 --build-arg HTTPS_PROXY=http://proxy:3128` — только на время сборки, в образ не попадает |

Если `proxies` в `config.json` всё же есть — после шага 9 проверьте
`/ready` (`llm: true`) и вход в интерфейс.

## Переход с офлайн-установки

Серверы, поставленные прежним `install.sh`, получили `/opt/goal-checker`
из архива без `.git`. Данные лежат в томе `goal-checker_neo4j_data` и не
теряются: имя проекта `goal-checker` теперь задано в `docker-compose.yml`.

**1. Копии** — пока работает старая версия: [дамп](deployment.md#резервная-копия),
`.env` и прежний `seed.cypher` (в нём старый `export_graph.py` хранил каталог).

```bash
cd /opt/goal-checker
cp -p .env ~/goal-checker.env
cp -p neo4j/init/seed.cypher ~/goal-checker.seed-offline.cypher
docker volume ls | grep goal-checker          # goal-checker_neo4j_data
docker compose down                           # без -v: тома остаются
```

**2. Код из git** — старый каталог в сторону, клон на его место:

```bash
mv /opt/goal-checker /opt/goal-checker.offline
git clone <репозиторий> /opt/goal-checker && cd /opt/goal-checker
git checkout v1.4.0
mv /opt/goal-checker.offline/models ./        # если MODELS_DIR=./models
cp -a /opt/goal-checker.offline/certs/. certs/ 2>/dev/null || true
```

**3. Настройки.** `.env` из клона — настройки стенда: `chmod 600 .env`,
блок «Только стенд» удалить, из `~/goal-checker.env` перенести
`NEO4J_PASSWORD` (тот же — он записан в базе), `VLLM_*`, `MODELS_DIR`,
`APP_VERSION`, `WEB_BIND`, `TRUSTED_PROXY`, `AUTH_ADMIN_LOGINS`. Вход теперь
через Keycloak: `LDAP_*`, `AUTH_BACKEND`, `AUTH_STATIC_USERS`, `SESSION_*`
удаляются, задаются `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`
и при внутреннем ЦС `KEYCLOAK_CA_FILE` (обычно годится бывший `LDAP_CA_FILE`).
Роли сохраняются: логин берётся из `preferred_username`, для AD — тот же
логин без домена.

**4. Шаги релиза 6–10**, затем выгрузка каталога новой версией:

```bash
docker volume ls | grep goal-checker          # те же тома, новых пустых нет
docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
  && mv neo4j/init/data.cypher.new neo4j/init/data.cypher
```

Появился том `<другое имя>_neo4j_data` (задан `COMPOSE_PROJECT_NAME`) —
`docker compose down`, убрать `COMPOSE_PROJECT_NAME` из окружения и `.env`,
поднять снова. `/opt/goal-checker.offline` удаляйте после проверки.

## Выгрузка каталога в файл

`neo4j/init/data.cypher` — выгрузка каталога этого сервера: в git его нет,
коммитить не нужно. Процесс API (uid 10001) писать на хост не может,
поэтому файл пишет оболочка хоста:

```bash
docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
  && diff -u neo4j/init/data.cypher neo4j/init/data.cypher.new | less   # что поменялось
mkdir -p backups && chmod 700 backups
cp -p neo4j/init/data.cypher "backups/data-$(date +%Y%m%d-%H%M%S).cypher" 2>/dev/null
mv neo4j/init/data.cypher.new neo4j/init/data.cypher
```

Подробнее — [данные каталога](deployment.md#данные-каталога).
