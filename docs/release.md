# Релиз на сервере

[← README](../README.md) · [Запуск и развёртывание](deployment.md)

Работающий стек в интернет не ходит: compose сам не обращается к реестру
образов (`pull_policy: ${PULL_POLICY:-never}`), vLLM читает веса с диска
(`HF_HUB_OFFLINE=1`). Сеть нужна серверу только на время релиза — шаги 2–4
ниже: скачать образы, собрать API и интерфейс, докачать веса модели.

Все команды выполняются из каталога проекта на сервере, например
`/opt/goal-checker`. Нужны git, Docker и docker compose 2.20 или новее
(`docker compose version`).

Имя compose-проекта задано в `docker-compose.yml` (`name: goal-checker`),
а не берётся из имени каталога: тома называются `goal-checker_neo4j_data`,
`goal-checker_api_audit` и т. д., где бы ни лежал клон. Сервер, который
ставили офлайн через `install.sh`, переводится на git по разделу
[«Переход с офлайн-установки»](#переход-с-офлайн-установки).

**Часы сервера должны быть синхронизированы** (chrony или `systemd-timesyncd`
с NTP-сервером контура — обычно это контроллер домена) — с теми же часами,
что у Keycloak. API сверяет время выдачи и срок токена Keycloak по своим
часам: если они расходятся с Keycloak на десятки секунд, токены отвергаются
и вход у всех пользователей зацикливается на «Сессия завершена», а если часы
API спешат дольше срока токена (5 минут) — все токены приходят уже истёкшими. Проверка: `timedatectl` — `System clock synchronized: yes`;
`chronyc tracking` — `System time` в пределах долей секунды.

## Первая установка

```bash
git clone <репозиторий> /opt/goal-checker
cd /opt/goal-checker
cp .env.example .env
chmod 600 .env
```

Заполните `.env` (полный список переменных — в [deployment.md](deployment.md#переменные-окружения)).
Стек с незаполненными настройками либо не поднимется, либо в него некому
будет войти, поэтому перед первым релизом сверьте:

- `NEO4J_PASSWORD` — свой пароль, не `change_me`. Пароль записывается в базу
  при первом старте; потом менять его только через базу
  ([смена пароля](deployment.md#обновление-и-обслуживание)).
- `KEYCLOAK_URL` — `https://`-адрес корпоративного Keycloak, плюс
  `KEYCLOAK_REALM` и `KEYCLOAK_CLIENT_ID` ([настройка клиента](security.md#настройка-на-сервере)).
  `http://` — только для стенда.
- `AUTH_ADMIN_LOGINS` — логин первого администратора.
- `VLLM_MODEL` и `VLLM_MODEL_DIR` — имя модели на Hugging Face и каталог
  весов внутри `MODELS_DIR` (обычно последний сегмент имени: `Qwen3.6-27B-FP8`).
- `WEB_BIND` — `127.0.0.1`, если TLS-прокси на этом же сервере.
- `APP_VERSION` — версия релиза, например `1.4.0`: так образы прежней
  версии остаются на сервере и к ней можно откатиться без сети (см. «Откат»).
- Модель на другом сервере (без GPU здесь) — `VLLM_URL` внешнего эндпоинта
  и `VLLM_REPLICAS=0`. Без `VLLM_URL` должно быть `VLLM_REPLICAS=1`.
- Keycloak стенда (`COMPOSE_PROFILES=idp`) — только вместе с
  `KEYCLOAK_ADMIN_PASSWORD`.
- Модель или Keycloak по `https://` с сертификатом внутреннего ЦС — файл ЦС
  в `./certs` и `LLM_CA_FILE` / `KEYCLOAK_CA_FILE=/certs/<файл>`.
- Время сервера синхронизировано (см. выше).

Каталог для первой загрузки — файл `neo4j/init/data.cypher`. В git его нет:
это выгрузка из живой базы, у каждого сервера своя
([выгрузка каталога](#выгрузка-каталога-в-файл)). Перенесите выгрузку со
стенда (`scp`) или начните с заготовки `neo4j/init/data.example.cypher`
(`cp neo4j/init/data.example.cypher neo4j/init/data.cypher`). Без файла
стек поднимется с пустым каталогом.

Дальше — шаги релиза 2–5 (шаг 1 при первой установке не нужен).

## Релиз

**0. Резервная копия базы** (не при первой установке) — команды в
[работе с данными](data.md#резервная-копия). Дальше — только если она
завершилась строкой «ДАМП ПРОВЕРЕН».

**1. Код.** В git лежит `.env` стенда, а на сервере он свой, поэтому перед
обновлением серверный `.env` откладывается и возвращается обратно. Выгрузка
каталога `neo4j/init/data.cypher` в git не хранится и `git pull` её не
трогает; её копия откладывается тоже — на случай обновления с версии, где
файл ещё был в git (такой `pull` его удалил бы):

```bash
cp -p .env ~/goal-checker.env
rm -f ~/goal-checker.data.cypher    # копия прошлого релиза не должна вернуться вместо нынешней
cp -p neo4j/init/data.cypher ~/goal-checker.data.cypher 2>/dev/null || true
git checkout -- .env
git checkout -- neo4j/init/data.cypher 2>/dev/null || true   # только если он ещё в git
git pull --ff-only                  # или: git fetch --tags && git checkout v1.4.0
cp -p ~/goal-checker.env .env
[ -f ~/goal-checker.data.cypher ] && cp -p ~/goal-checker.data.cypher neo4j/init/data.cypher
git status --short                  # кроме .env правок быть не должно
```

Сравните `.env.example` до и после: новые переменные из шаблона в серверный
`.env` сами не попадут (`git diff <прежняя версия> -- .env.example`).
Если релиз идёт с новым `APP_VERSION`, поправьте его в `.env`.

**2. Образы Neo4j, vLLM, autoheal и Keycloak:**

```bash
PULL_POLICY=always docker compose pull --ignore-buildable
```

Образ Keycloak скачивается только с профилем `idp`. Модель на другом сервере
(`VLLM_REPLICAS=0`) — образ vLLM (около 10 ГБ) не нужен, перечислите сервисы
явно: `PULL_POLICY=always docker compose pull neo4j autoheal`
(без autoheal, если `AUTOHEAL_REPLICAS=0`).

**3. Сборка API и интерфейса:**

```bash
docker compose build --pull
```

pip ставит пакеты с PyPI строго по `api/requirements.lock` (версии и sha256,
`--require-hashes`), npm — по `web/package-lock.json`. Ошибка сборки
останавливает релиз здесь: работающая версия ещё не тронута.

**4. Веса модели** (только для локальной модели):

```bash
PULL_POLICY=always docker compose run --rm model
```

Разовый сервис `model` скачивает или докачивает веса в
`${MODELS_DIR}/${VLLM_MODEL_DIR}` и проверяет, что на месте все шарды из
`model.safetensors.index.json`. Уже скачанное заново не качается; прервалось —
запустите ещё раз. Закрытая модель — с токеном:
`HF_TOKEN=hf_… PULL_POLICY=always docker compose run --rm model`.

**5. Запуск** — дальше без сети:

```bash
docker compose up -d --no-build
```

Без `PULL_POLICY` compose ничего не скачивает: недостающий образ — ошибка,
а не тихая загрузка.

## Проверка после релиза

```bash
docker compose ps -a                # все сервисы running/healthy, seeder — exited (0), autoheal — running
curl -s localhost:8080/ready        # llm: true — после загрузки весов (несколько минут)
docker compose logs --tail 50 api
```

Затем — вход в интерфейс и проверка одной цели. Образы прежней версии,
когда новая проверена: `docker image prune` (удалит только образы без тега;
образы с прежним `APP_VERSION` — `docker image rm goal-checker-api:<версия>
goal-checker-web:<версия>`).

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
обновлении он откладывается так же (шаг 1).

Иначе — те же шаги 1–5 на прежней версии. Если новая версия успела
применить миграции базы, вернуть данные можно только из резервной копии
шага 0 ([восстановление](data.md#резервная-копия)).

## Сеть для релиза через прокси

Если интернет на сервере есть только через корпоративный прокси, не
прописывайте его в раздел `proxies` файла `~/.docker/config.json`: docker
подставляет оттуда `HTTP_PROXY`/`HTTPS_PROXY` во **все** создаваемые
контейнеры, в том числе в работающий стек после шага 5. Сервисы стека
исключают друг друга из прокси сами (`NO_PROXY` в `docker-compose.yml`:
`vllm`, `keycloak`, `neo4j`, `api`, `web`, `localhost`), но внешний `VLLM_URL`
и корпоративный Keycloak пошли бы через прокси — их адреса тогда нужно
перечислить в `NO_PROXY_EXTRA` в `.env` (например `.corp.local`). Надёжнее
давать прокси только тем шагам, которым нужна сеть:

| Шаг | Как передать прокси |
|---|---|
| 2. `docker compose pull` | образы качает демон Docker, а не контейнер: прокси демона — `/etc/systemd/system/docker.service.d/http-proxy.conf` с `Environment="HTTPS_PROXY=http://proxy:3128"`, затем `systemctl daemon-reload && systemctl restart docker` (перезапуск демона перезапустит и стек — делайте до шага 5 или в окно обслуживания). В контейнеры прокси демона не попадает |
| 3. `docker compose build` | `docker compose build --pull --build-arg HTTP_PROXY=http://proxy:3128 --build-arg HTTPS_PROXY=http://proxy:3128` — переменные действуют только на время сборки (pip, npm) и в образ не записываются |
| 4. веса модели | `PULL_POLICY=always docker compose run --rm -e HTTPS_PROXY=http://proxy:3128 model` — прокси получает только разовый контейнер `model` |

Если `proxies` в `config.json` всё же есть, проверьте после шага 5, что
модель и вход работают: `curl -s localhost:8080/ready` — `llm: true`, вход в
интерфейс — без «Сервис входа недоступен».

## Переход с офлайн-установки

Серверы, поставленные прежним `install.sh`, получили каталог
`/opt/goal-checker` из архива без `.git`: шаг 1 там отвечает «not a git
repository», а `git clone` в тот же путь — «destination path already exists».
Данные (каталог, пользователи, история) лежат в томе `goal-checker_neo4j_data`
и при переходе не теряются, если стек поднимается под тем же именем проекта
`goal-checker` — оно теперь задано в `docker-compose.yml`.

**1. Резервная копия** — пока работает старая версия: дамп с проверкой
([работа с данными](data.md#резервная-копия)), а также `.env` и прежний
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
cp .env.example .env && chmod 600 .env
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
скачанный каталог в `MODELS_DIR`, иначе шаг 4 релиза скачает модель заново.

**5. Шаги релиза 2–5**, затем проверка и выгрузка каталога уже новой
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

Прежние версии выгрузки — в `backups/` (там же их кладёт шаг 0 и ночная
копия). Подробнее — в [работе с данными](data.md).
