# Релиз на сервере

[← README](../README.md) · [Запуск и развёртывание](deployment.md)

Работающий стек в интернет не ходит: compose сам не обращается к реестру
образов (`pull_policy: ${PULL_POLICY:-never}`), vLLM читает веса с диска
(`HF_HUB_OFFLINE=1`). Сеть нужна серверу только на время релиза — шаги 2–4
ниже: скачать образы, собрать API и интерфейс, докачать веса модели.

Все команды выполняются из каталога проекта на сервере, например
`/opt/goal-checker`. Нужны git, Docker и docker compose 2.20 или новее
(`docker compose version`).

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

Дальше — шаги релиза 2–5 (шаг 1 при первой установке не нужен).

## Релиз

**0. Резервная копия базы** (не при первой установке) — команды в
[работе с данными](data.md#резервная-копия). Дальше — только если она
завершилась строкой «ДАМП ПРОВЕРЕН».

**1. Код.** В git лежит `.env` стенда, а на сервере он свой, поэтому перед
обновлением серверный `.env` откладывается и возвращается обратно:

```bash
cp -p .env ~/goal-checker.env
git checkout -- .env
git pull --ff-only                  # или: git fetch --tags && git checkout v1.4.0
cp -p ~/goal-checker.env .env
git status --short                  # кроме .env правок быть не должно
```

Сравните `.env.example` до и после: новые переменные из шаблона в серверный
`.env` сами не попадут (`git diff <прежняя версия> -- .env.example`).
Если релиз идёт с новым `APP_VERSION`, поправьте его в `.env`.

**2. Образы Neo4j, vLLM и Keycloak:**

```bash
PULL_POLICY=always docker compose pull --ignore-buildable
```

Образ Keycloak скачивается только с профилем `idp`. Модель на другом сервере
(`VLLM_REPLICAS=0`) — образ vLLM (около 10 ГБ) не нужен, перечислите сервисы
явно: `PULL_POLICY=always docker compose pull neo4j`.

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
docker compose ps                   # все сервисы running/healthy, seeder — exited (0)
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
git checkout v1.3.0                 # с откладыванием .env, как в шаге 1
# в .env: APP_VERSION=1.3.0
docker compose up -d --no-build
```

Иначе — те же шаги 1–5 на прежней версии. Если новая версия успела
применить миграции базы, вернуть данные можно только из резервной копии
шага 0 ([восстановление](data.md#резервная-копия)).

## Выгрузка каталога в файл

`neo4j/init/data.cypher` — выгрузка каталога этого сервера, в git его нет,
и `git pull` его не трогает. Процесс API в контейнере работает от uid 10001
и писать в файл на хосте сам не может, поэтому выгрузку пишет оболочка
хоста:

```bash
docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
  && mv neo4j/init/data.cypher.new neo4j/init/data.cypher
```

Подробнее — в [работе с данными](data.md).
