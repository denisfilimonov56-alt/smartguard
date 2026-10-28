# Релиз на сервере

[← README](../README.md) · [Установка на сервер](deployment.md)

Релиз — обновление уже установленного сервера на новую версию. Первая
установка на чистый сервер — в [установке на сервер](deployment.md).

Коротко, что происходит:

| Этап | Сеть | Работа сервиса |
|---|---|---|
| 1–2. Подготовка | нужна | не затрагивается |
| 3. Резервная копия (`scripts/dump.sh`) | — | API и Neo4j остановлены ~1 минуту |
| 4–8. Код, настройки, образы, сборка, веса | нужна | не затрагивается — работает прежняя версия |
| 9. Переключение на новую версию | — | перезапуск; модель грузится до 15 минут |
| 10–11. Проверка и уборка | — | работает новая версия |

Все команды — из каталога проекта на сервере (`/opt/goal-checker`). Ниже
в примерах прежняя версия — `v1.3.0`, новая — `v1.4.0`.

## Этапы релиза

### 1. Узнать, что меняется

```bash
cd /opt/goal-checker
git fetch --tags
git log --oneline v1.3.0..v1.4.0               # что вошло в релиз
git diff v1.3.0 v1.4.0 -- .env                 # новые и изменённые настройки
git diff --stat v1.3.0 v1.4.0 -- neo4j/init/migrations   # есть ли миграции базы
```

Новые переменные из `.env` репозитория в серверный `.env` сами не попадут —
их переносят на шаге 5. Если в релизе есть миграции базы, прочитайте
[миграции](deployment.md#миграции) до начала.

### 2. Проверить сервер

```bash
timedatectl                         # System clock synchronized: yes
df -h /var/lib/docker .             # на образы новой версии нужно несколько ГБ
docker compose ps -a                # прежняя версия работает: running / healthy
```

### 3. Резервная копия базы

```bash
scripts/dump.sh
```

Скрипт останавливает API и Neo4j (около минуты на небольшой базе), снимает
дамп в `backups/dump-<дата>/`, проверяет его и запускает сервис обратно.
Дальше — только если в выводе есть строка «ДАМП ПРОВЕРЕН» и скрипт
завершился словом «готово». Строка «ОШИБКА» — релиз не начинать
([подробнее](deployment.md#резервная-копия)).

### 4. Код новой версии

В git лежит `.env` стенда, а на сервере он свой, поэтому серверный `.env`
откладывается и возвращается обратно. Выгрузка каталога
`neo4j/init/data.cypher` в git не хранится, но её копия откладывается тоже —
на случай обновления с версии, где файл ещё был в git (такое обновление его
удалило бы):

```bash
cp -p .env ~/goal-checker.env
rm -f ~/goal-checker.data.cypher    # копия прошлого релиза не должна вернуться вместо нынешней
cp -p neo4j/init/data.cypher ~/goal-checker.data.cypher 2>/dev/null || true
git checkout -- .env
git checkout -- neo4j/init/data.cypher 2>/dev/null || true   # только если он ещё в git
git checkout v1.4.0
cp -p ~/goal-checker.env .env
[ -f ~/goal-checker.data.cypher ] && cp -p ~/goal-checker.data.cypher neo4j/init/data.cypher
git status --short                  # кроме .env правок быть не должно
```

### 5. Настройки

В `.env`:

- `APP_VERSION=1.4.0` — новое значение обязательно: образы прежней версии
  остаются на сервере под своим тегом, и откат не потребует сети;
- новые переменные, найденные на шаге 1, — если их значения по умолчанию
  не подходят ([таблица переменных](deployment.md#переменные-окружения)).

### 6. Образы Neo4j, vLLM и autoheal

```bash
PULL_POLICY=always docker compose pull --ignore-buildable
```

`PULL_POLICY=always` разрешает compose скачивать образы (по умолчанию у всех
сервисов `pull_policy: never`), `--ignore-buildable` пропускает API и
интерфейс — их не скачивают, а собирают на шаге 7
([подробнее](deployment.md#шаг-10-образы-сборка-и-веса-модели)).

Модель на другом сервере (`VLLM_REPLICAS=0`) — образ vLLM (около 10 ГБ)
не нужен: `PULL_POLICY=always docker compose pull neo4j autoheal`
(без autoheal, если `AUTOHEAL_REPLICAS=0`).

### 7. Сборка API и интерфейса

```bash
docker compose build --pull
```

pip ставит пакеты строго по `api/requirements.lock` (версии и sha256),
npm — по `web/package-lock.json`. Ошибка сборки останавливает релиз здесь:
работающая версия ещё не тронута — верните код и `.env` к прежней версии
([откат](#откат), без `docker compose up`).

### 8. Веса модели

Только для локальной модели:

```bash
PULL_POLICY=always docker compose run --rm model
```

Скачивается только недостающее: если модель в релизе не менялась, команда
быстро закончится проверкой шардов. Прервалось — запустите ещё раз.
Закрытая модель — с токеном:
`HF_TOKEN=hf_… PULL_POLICY=always docker compose run --rm model`.

### 9. Переключение на новую версию

Дальше сеть не нужна:

```bash
docker compose up -d --no-build
```

Compose пересоздаёт контейнеры, у которых поменялись образ или настройки.
Без `PULL_POLICY` он ничего не скачивает: недостающий образ даёт ошибку,
а не тихую загрузку.

### 10. Проверка

```bash
docker compose ps -a                # все сервисы running/healthy, seeder — exited (0), autoheal — running
curl -s localhost:8080/ready        # llm: true — после загрузки весов (до 15 минут)
docker compose logs --tail 50 api   # нет ошибок при старте
```

Затем — вход в интерфейс и проверка одной цели. Не прошло — [откат](#откат).

### 11. Уборка

Когда новая версия проверена, образы позапрошлой версии можно удалить.
Образы прежней версии стоит оставить до следующего релиза — для отката:

```bash
docker image ls 'goal-checker-*'
docker image rm goal-checker-api:1.2.0 goal-checker-web:1.2.0   # позапрошлая версия
docker image prune                  # образы без тега
```

## Откат

Если образы прежней версии остались на сервере (у релизов разные
`APP_VERSION`), сеть не нужна:

```bash
cp -p .env ~/goal-checker.env
rm -f ~/goal-checker.data.cypher
mv neo4j/init/data.cypher ~/goal-checker.data.cypher   # обязательно до checkout, см. ниже
git checkout -- .env
git checkout v1.3.0
cp -p ~/goal-checker.env .env
cp -p ~/goal-checker.data.cypher neo4j/init/data.cypher
# в .env: APP_VERSION=1.3.0
docker compose up -d --no-build
```

`data.cypher` откладывается при любом откате. Файл в `.gitignore`, и если
в прежней версии он ещё лежал в git, `git checkout` **молча перезапишет**
серверную выгрузку версией из репозитория — без ошибки «would be
overwritten» (git не охраняет игнорируемые файлы; проверено опытом).
Обратный переход с такой версии на новую файл удалит, поэтому при следующем
обновлении он откладывается так же (шаг 4).

Иначе — те же шаги 4–9 на прежней версии. Если новая версия успела
применить миграции базы, вернуть данные можно только из резервной копии
шага 3 ([восстановление](deployment.md#резервная-копия)).

## Сеть для релиза через прокси

Если интернет на сервере есть только через корпоративный прокси, не
прописывайте его в раздел `proxies` файла `~/.docker/config.json`: docker
подставляет оттуда `HTTP_PROXY`/`HTTPS_PROXY` во **все** создаваемые
контейнеры, в том числе в работающий стек после шага 9. Сервисы стека
исключают друг друга из прокси сами (`NO_PROXY` в `docker-compose.yml`:
`vllm`, `keycloak`, `neo4j`, `api`, `web`, `localhost`), но внешний `VLLM_URL`
и корпоративный Keycloak пошли бы через прокси — их адреса тогда нужно
перечислить в `NO_PROXY_EXTRA` в `.env` (например `.corp.local`). Надёжнее
давать прокси только тем шагам, которым нужна сеть:

| Шаг | Как передать прокси |
|---|---|
| 6. `docker compose pull` | образы качает демон Docker, а не контейнер: прокси демона — `/etc/systemd/system/docker.service.d/http-proxy.conf` с `Environment="HTTPS_PROXY=http://proxy:3128"`, затем `systemctl daemon-reload && systemctl restart docker` (перезапуск демона перезапустит и стек — делайте до шага 9 или в окно обслуживания). В контейнеры прокси демона не попадает |
| 7. `docker compose build` | `docker compose build --pull --build-arg HTTP_PROXY=http://proxy:3128 --build-arg HTTPS_PROXY=http://proxy:3128` — переменные действуют только на время сборки (pip, npm) и в образ не записываются |
| 8. веса модели | `PULL_POLICY=always docker compose run --rm -e HTTPS_PROXY=http://proxy:3128 model` — прокси получает только разовый контейнер `model` |

Если `proxies` в `config.json` всё же есть, проверьте после шага 9, что
модель и вход работают: `curl -s localhost:8080/ready` — `llm: true`, вход в
интерфейс — без «Сервис входа недоступен».

## Переход с офлайн-установки

Серверы, поставленные прежним `install.sh`, получили каталог
`/opt/goal-checker` из архива без `.git`: шаг 4 релиза там отвечает «not a git
repository», а `git clone` в тот же путь — «destination path already exists».
Данные (каталог, пользователи, история) лежат в томе `goal-checker_neo4j_data`
и при переходе не теряются, если стек поднимается под тем же именем проекта
`goal-checker` — оно теперь задано в `docker-compose.yml`.

**1. Резервная копия** — пока работает старая версия: дамп с проверкой
([работа с данными](deployment.md#резервная-копия)), а также `.env` и прежний
`neo4j/init/seed.cypher` — в нём старый `export_graph.py` хранил выгрузку
каталога после маркера данных.

```bash
cd /opt/goal-checker
cp -p .env ~/goal-checker.env
cp -p neo4j/init/seed.cypher ~/goal-checker.seed-offline.cypher
docker volume ls | grep goal-checker          # goal-checker_neo4j_data — тот самый том
```

Выгрузку для нового `data.cypher` снимает уже новая версия (шаг 5 ниже):
формат файлов поменялся, а каталог из базы при переходе никуда не денется.

**2. Остановка старого стека:** `docker compose down` (без `-v`: тома
остаются).

**3. Код из git** — на месте:

```bash
cd /opt/goal-checker
git init
git remote add origin <репозиторий>
git fetch origin --tags
git checkout -f main                # или нужный тег: git checkout -f v1.4.0
git status --short                  # лишние файлы старой версии — удалить вручную
```

или переложить старый каталог и клонировать в тот же путь (так старые файлы
не смешиваются с новыми):

```bash
mv /opt/goal-checker /opt/goal-checker.offline
git clone <репозиторий> /opt/goal-checker
mv /opt/goal-checker.offline/models /opt/goal-checker/   # если MODELS_DIR=./models
cp -a /opt/goal-checker.offline/certs/. /opt/goal-checker/certs/ 2>/dev/null || true
```

**4. Настройки.** Вход теперь через Keycloak, а не напрямую через LDAP:
`.env` переносится, но переменные входа меняются.

```bash
cd /opt/goal-checker
chmod 600 .env   # .env из клона — настройки стенда: заменить значения, убрать блок «только стенд»
# перенести из ~/goal-checker.env: NEO4J_PASSWORD (тот же — он записан в базе),
# VLLM_*, MODELS_DIR, APP_VERSION, WEB_BIND, TRUSTED_PROXY, AUTH_ADMIN_LOGINS
```

`LDAP_URL`, `LDAP_USER_TEMPLATE`, `LDAP_CA_FILE`, `LDAP_STARTTLS`,
`AUTH_BACKEND`, `AUTH_STATIC_USERS` и `SESSION_*` удаляются; вместо них —
`KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID` и, если сертификат
Keycloak выдан внутренним ЦС, `KEYCLOAK_CA_FILE` (бывший `LDAP_CA_FILE`
обычно годится — тот же корневой сертификат домена). Роли пользователей
сохраняются: логин берётся из `preferred_username` Keycloak, для AD это тот же
логин без домена. Каталог весов: `VLLM_MODEL_DIR` должен указывать на уже
скачанный каталог в `MODELS_DIR`, иначе шаг 8 релиза скачает модель заново.

**5. Шаги релиза 6–10**, затем проверка и выгрузка каталога уже новой
версией:

```bash
docker volume ls | grep goal-checker          # те же тома, новых пустых нет
docker compose ps -a                           # seeder — exited (0)
curl -s localhost:8080/ready                  # каталог не пуст, llm: true
docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
  && mv neo4j/init/data.cypher.new neo4j/init/data.cypher
```

Сидер на непустом каталоге `data.cypher` не читает, поэтому новая версия
поднимается и без него.

Если в списке томов появились `<другое имя>_neo4j_data` (стек подняли до
обновления `docker-compose.yml` или с другим `COMPOSE_PROJECT_NAME`) —
`docker compose down`, убрать `COMPOSE_PROJECT_NAME` из окружения и `.env`
и поднять снова: данные — в `goal-checker_*`. Старый каталог
`/opt/goal-checker.offline` удаляйте, когда новая версия проверена.

## Выгрузка каталога в файл

`neo4j/init/data.cypher` — выгрузка каталога этого сервера. Файл серверный:
в git его нет (он в `.gitignore`), `git pull` и откат его не трогают, а
коммитить его на сервере не нужно. Заготовка для новой установки —
`neo4j/init/data.example.cypher`. Процесс API в контейнере работает от
uid 10001 и писать в файл на хосте сам не может, поэтому выгрузку пишет
оболочка хоста:

```bash
docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
  && diff -u neo4j/init/data.cypher neo4j/init/data.cypher.new | less   # что поменялось
mkdir -p backups && chmod 700 backups
cp -p neo4j/init/data.cypher "backups/data-$(date +%Y%m%d-%H%M%S).cypher" 2>/dev/null
mv neo4j/init/data.cypher.new neo4j/init/data.cypher
```

Прежние версии выгрузки — в `backups/` (там же их кладёт шаг 3 релиза и ночная
копия). Подробнее — в [данных каталога](deployment.md#данные-каталога).
