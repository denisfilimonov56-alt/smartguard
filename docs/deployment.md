# Установка на сервер

[← README](../README.md) · [Релиз (обновление версии)](release.md)

Здесь — как поставить сервис на чистый сервер Ubuntu с нуля. Обновление уже
установленного сервера на новую версию — отдельная инструкция:
[релиз](release.md).

Что получится в итоге:

```
браузер ──https:443──▶ nginx на сервере (TLS) ──▶ 127.0.0.1:3000 web ──▶ api ──▶ neo4j
                                                                          └──▶ vllm (модель на GPU)
вход: браузер ◀──▶ корпоративный Keycloak
```

Всё, кроме nginx с TLS, работает в docker compose. Интернет нужен серверу
только во время установки и релиза: скачать образы, собрать API и интерфейс,
скачать веса модели. Потом стек работает без сети.

## Что подготовить заранее

| Что | Требование |
|---|---|
| Сервер | Ubuntu Server 22.04 или 24.04 LTS, x86_64, доступ по SSH с `sudo` |
| Видеокарта | NVIDIA от Ampere (A10, A100 и новее), не меньше 24 ГБ памяти ([видеокарта](#видеокарта)); на картах 48 ГБ и больше параллельно идёт больше запросов. Нет GPU — модель на другом сервере ([без GPU](#без-gpu)) |
| Диск | не меньше 100 ГБ свободно: веса модели ~19 ГБ, образ vLLM ~10 ГБ, остальные образы, база, резервные копии |
| Интернет | на время установки — напрямую или через прокси ([прокси](release.md#сеть-для-релиза-через-прокси)) |
| Keycloak | корпоративный Keycloak и право завести в нём клиент |
| Имя и сертификат | DNS-имя интерфейса (например `goals.corp.local`) и TLS-сертификат с ключом на это имя |
| NTP | адрес NTP-сервера контура (обычно контроллер домена) |
| Администратор | логин первого администратора сервиса (логин домена без домена, например `i.ivanov`) |
| Каталог | по желанию — выгрузка каталога со стенда `data.cypher` (шаг 9) |

## Установка с нуля на Ubuntu

Команды выполняются под своим пользователем с правом `sudo`. Если интернет
только через прокси, сначала прочитайте [сеть через прокси](release.md#сеть-для-релиза-через-прокси).

### Шаг 1. Базовые пакеты

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y ca-certificates curl git gnupg chrony nginx
```

### Шаг 2. Синхронизация часов

API проверяет токены Keycloak по своим часам. Если часы сервера и Keycloak
расходятся на десятки секунд, вход у всех пользователей зацикливается на
«Сессия завершена». Поэтому часы берутся с того же NTP-сервера, что
у Keycloak:

```bash
echo "server ntp.corp.local iburst" | sudo tee /etc/chrony/sources.d/corp.sources
sudo sed -i 's/^pool /#pool /' /etc/chrony/chrony.conf    # отключить внешние пулы
sudo systemctl restart chrony
chronyc sources                     # у ntp.corp.local — значок ^*
timedatectl                         # System clock synchronized: yes
```

`ntp.corp.local` замените адресом NTP-сервера контура.

### Шаг 3. Docker

Ставится из репозитория Docker, а не пакет `docker.io` из Ubuntu: нужен
docker compose 2.20 или новее.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"     # затем выйти из SSH и зайти снова
docker compose version              # 2.20 или новее
```

Группа `docker` даёт права root на сервере — добавляйте в неё только тех,
кто обслуживает сервис.

### Шаг 4. Доступ контейнеров к GPU

Только если модель работает на этом сервере. Модель на другом сервере —
шаг пропускается.

Драйвер NVIDIA на сервере уже установлен — проверьте, что он видит карту:

```bash
nvidia-smi                          # видна карта и версия драйвера
```

Контейнерам GPU отдаёт NVIDIA Container Toolkit. Проверка:

```bash
docker run --rm --gpus all ubuntu:24.04 nvidia-smi   # та же таблица, что на хосте
```

Если команда выводит ту же таблицу — переходите к шагу 5. Если ошибка
`could not select device driver "" with capabilities: [[gpu]]` — Toolkit
не установлен, ставится так:

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker run --rm --gpus all ubuntu:24.04 nvidia-smi   # теперь — таблица с картой
```

### Шаг 5. Код проекта

```bash
sudo git clone <репозиторий> /opt/goal-checker
sudo chown -R "$USER": /opt/goal-checker
cd /opt/goal-checker
git checkout v1.4.0                 # тег устанавливаемой версии
```

Все дальнейшие команды — из `/opt/goal-checker`.

### Шаг 6. Файл настроек `.env`

В git лежит `.env` стенда с комментариями ко всем переменным. На сервере
в этом же файле задаются свои значения, а блок «Только стенд» (`COMPOSE_FILE`,
`KEYCLOAK_IMAGE`, `KEYCLOAK_ADMIN_PASSWORD`, `ENABLE_DOCS`) удаляется целиком:
иначе вместе с боевым стеком поднимется Keycloak стенда с паролем из git.

```bash
chmod 600 .env
openssl rand -hex 24                # пригодится как пароль Neo4j
nano .env
```

Что заполнить обязательно:

| Переменная | Что указать |
|---|---|
| `NEO4J_PASSWORD` | свой пароль (не `password123` стенда). Записывается в базу при первом старте, потом меняется только [через базу](#смена-пароля-neo4j) |
| `APP_VERSION` | версия, например `1.4.0` — у каждого релиза своя, иначе откат будет требовать сети |
| `KEYCLOAK_URL` | `https://`-адрес корпоративного Keycloak, тот же, что видит браузер |
| `KEYCLOAK_INTERNAL_URL` | убрать (адрес Keycloak стенда) или внутренний `https://`-адрес корпоративного Keycloak для API |
| `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID` | realm и клиент из шага 8 |
| `AUTH_ADMIN_LOGINS` | логин первого администратора (не `admin` стенда) |
| `WEB_BIND` | `127.0.0.1` — TLS-прокси на этом же сервере (шаг 12) |

Зависит от сервера:

| Случай | Что указать |
|---|---|
| Модель на этом сервере | `VLLM_REPLICAS=1`; `VLLM_MODEL` и `VLLM_MODEL_DIR` — как в `.env` репозитория, если модель не меняется; `MODELS_DIR` — каталог для весов (по умолчанию `./models`), на диске с запасом места |
| Модель на другом сервере | `VLLM_URL=https://…/v1`, `VLLM_API_KEY`, `VLLM_REPLICAS=0` |
| Keycloak или модель с сертификатом внутреннего ЦС | `KEYCLOAK_CA_FILE=/certs/corp-ca.pem`, `LLM_CA_FILE=/certs/corp-ca.pem` (файл — в шаге 7) |
| Интернет через прокси | `NO_PROXY_EXTRA` — адреса Keycloak и модели ([подробнее](release.md#сеть-для-релиза-через-прокси)) |

`TRUSTED_PROXY` задаётся позже, в шаге 12. Остальные переменные можно не
трогать — их значения по умолчанию в [таблице](#переменные-окружения).

### Шаг 7. Сертификат внутреннего ЦС

Если Keycloak или модель работают по `https://` с сертификатом внутреннего
центра сертификации, положите корневой сертификат в `certs/`:

```bash
cp ~/corp-ca.pem certs/
chmod 644 certs/corp-ca.pem
```

Без него вход отвечает «Сервис входа недоступен», а проверки уходят на
ручную проверку (`CERTIFICATE_VERIFY_FAILED` в логе API).

### Шаг 8. Клиент в Keycloak

В Keycloak (realm организации) заводится клиент интерфейса:

| Настройка клиента | Значение |
|---|---|
| Client type | OpenID Connect |
| Client ID | то же, что `KEYCLOAK_CLIENT_ID`, например `goal-checker-web` |
| Client authentication | Off (публичный клиент, секрета нет) |
| Standard flow | On; Direct access grants и Implicit — Off |
| PKCE Method (Advanced) | `S256` |
| Valid redirect URIs | адрес интерфейса, например `https://goals.corp.local/*` |
| Valid post logout redirect URIs | тот же |
| Web origins | origin интерфейса, например `https://goals.corp.local` (браузер меняет код на токен запросом в Keycloak) |

Пользователи приходят из домена через федерацию Keycloak (User
federation → LDAP/AD); `preferred_username` в токене должен быть логином
без домена — для AD это `sAMAccountName`, стандартная настройка маппера
`username`.

```dotenv
KEYCLOAK_URL=https://sso.corp.local
KEYCLOAK_REALM=corp
KEYCLOAK_CLIENT_ID=goal-checker-web
KEYCLOAK_CA_FILE=/certs/corp-ca.pem  # если Keycloak подписан внутренним ЦС; файл в ./certs
AUTH_ADMIN_LOGINS=i.ivanov
WEB_BIND=127.0.0.1                   # TLS-прокси на этом же сервере
TRUSTED_PROXY=172.18.0.0/16          # подсеть docker-сети стека (прокси на этом же сервере) или адрес прокси
```

- **TLS до пользователя** завершается на внешнем прокси, который
  направляет запросы на порт 3000. Адрес, под которым интерфейс открыт
  пользователям, должен быть в Valid redirect URIs и Web origins клиента —
  иначе Keycloak откажет ещё на входе. Проверка цели и пакет идут до
  10 минут, поэтому у прокси `proxy_read_timeout` и `proxy_send_timeout` —
  не меньше 600 с, `client_max_body_size` — не меньше `2m` (как у nginx
  интерфейса).
- **`WEB_BIND`** — на каком адресе слушает порт 3000 (без TLS). Прокси на
  этом же сервере — `127.0.0.1`: тогда в обход TLS к интерфейсу не
  подключиться. Прокси на другой машине — `0.0.0.0` (по умолчанию) или адрес
  нужного сетевого интерфейса, а порт 3000 закрывается файрволом для всех,
  кроме прокси. Правила закрывают в цепочке `DOCKER-USER`: обычные правила
  `INPUT` к опубликованным портам docker не применяются.
- **`KEYCLOAK_URL`** — публичный адрес Keycloak, тот же, что видит браузер:
  он записан издателем в токенах. Адрес с путём (`https://sso.corp.local/auth`)
  поддерживается: в `Content-Security-Policy` (`connect-src`) попадает только
  его origin. Схема и хост разбираются без учёта регистра и пишутся в CSP
  в нижнем регистре. В хосте допустимы буквы, цифры, `.`, `-`, `_` или
  IPv6-адрес в скобках, плюс порт; иное (в том числе перевод строки)
  исключает Keycloak из CSP с предупреждением в логе `web` — тогда вход
  в браузере не заработает.
  Если API ходит в Keycloak другим путём (внутренняя сеть, docker), этот
  путь — в `KEYCLOAK_INTERNAL_URL`; издатель остаётся публичным. По
  `http://` внутренний адрес допустим только с именем сервиса docker
  (`http://keycloak:8080`), иначе API предупреждает при старте: ключи
  подписи пошли бы по сети без TLS.
- **`TRUSTED_PROXY`** — адрес или подсеть прокси перед интерфейсом. Из его
  `X-Forwarded-For` берётся адрес клиента для журнала; без настройки все
  пользователи будут видны под адресом прокси. Прокси на этом же сервере
  приходит в контейнер не с `127.0.0.1`, а с шлюза docker-сети стека:
  укажите её подсеть (`docker network inspect goal-checker_default`, поле `Subnet`).
- **Сертификат Keycloak** проверяется при `https://`. Если он выдан своим
  центром сертификации, без `KEYCLOAK_CA_FILE` API будет отвечать «сервис
  входа недоступен», а в логе API появится причина; файл, которого нет,
  API отмечает в логе при старте.
- **Neo4j Browser и bolt** снаружи закрыты. С рабочего места:
  `ssh -L 7474:localhost:7474 -L 7687:localhost:7687 <сервер>`.


### Шаг 9. Каталог для первой загрузки (по желанию)

Шаг не обязательный. Важно различать две вещи:

| | Схема базы | Каталог |
|---|---|---|
| Что это | ограничения уникальности и индексы | содержимое: приказы, пункты, правила, атрибуты с описаниями и примерами, подразделения, должностные инструкции |
| Где лежит | `neo4j/init/seed.cypher` — в git, приходит с кодом | в базе Neo4j; файл `neo4j/init/data.cypher` — только для первой загрузки |
| Когда применяется | сидером при каждом старте стека, сама; от шага 9 не зависит | из файла — один раз, только в пустой каталог |

`data.cypher` — не тестовые данные, а выгрузка настоящего каталога
(`export_graph.py`), обычно со стенда, где каталог заполняли и проверяли.
Он нужен, чтобы новый сервер начал с готового каталога, а не с пустого:

```bash
scp стенд:/opt/goal-checker/neo4j/init/data.cypher neo4j/init/
chmod 644 neo4j/init/data.cypher    # сидер читает файл от uid 10001
```

Без файла сервис поднимется с пустым каталогом, и его заполняют в интерфейсе.
Заготовку `neo4j/init/data.example.cypher` на боевой сервер не кладите:
это образец формата.

После первой загрузки источник истины — база. Атрибуты, правила и примеры,
которые добавляют и правят в интерфейсе, хранятся в Neo4j; ни перезапуск,
ни релиз их не откатывают — сидер на непустом каталоге файл не читает.
Единственное исключение — явный `SEED_DATA=1`: он заменяет каталог
содержимым файла ([данные каталога](#данные-каталога)). Пользователи, роли, ключи
доступа, настройки и история проверок в `data.cypher` не входят и от него
не зависят.

### Шаг 10. Образы, сборка и веса модели

Здесь нужен интернет.

```bash
PULL_POLICY=always docker compose pull --ignore-buildable   # образы Neo4j, vLLM, autoheal
docker compose build --pull                                 # образы API и интерфейса
PULL_POLICY=always docker compose run --rm model            # веса модели, ~19 ГБ
```

Что делает первая команда. Образы бывают двух видов: готовые из реестра
(Neo4j, vLLM, autoheal) и собираемые из исходников проекта (API — `build:
./api`, интерфейс — `build: ./web`). `docker compose pull` скачивает образы
из реестра, а части команды нужны вот зачем:

- `PULL_POLICY=always` — разрешение скачивать. В `docker-compose.yml` у
  сервисов стоит `pull_policy: ${PULL_POLICY:-never}`: без переменной
  compose в реестр не ходит никогда, и работающий сервер не скачает ничего
  тайком (например, при `docker compose up`). Переменная действует только
  на эту одну команду и в `.env` не записывается.
- `--ignore-buildable` — пропустить сервисы, у которых есть `build:`
  (`api`, `seeder`, `web`). Образов `goal-checker-api` и `goal-checker-web`
  в реестре нет — их собирает следующая команда, `docker compose build`;
  без флага `pull` пытался бы скачать их и падал.

Флага `-d` у `docker compose pull` нет (он у `up`): с ним команда
завершится ошибкой `unknown shorthand flag: 'd' in -d`.

- Модель на другом сервере — образ vLLM и веса не нужны: первая команда —
  `PULL_POLICY=always docker compose pull neo4j autoheal`, третья пропускается.
- Скачивание весов прервалось — запустите третью команду ещё раз, она
  докачает недостающее.
- Закрытая модель на Hugging Face — с токеном:
  `HF_TOKEN=hf_… PULL_POLICY=always docker compose run --rm model`.

### Шаг 11. Запуск

```bash
docker compose up -d --no-build
docker compose ps -a                # seeder — exited (0), остальные — running / healthy
curl -s localhost:8080/ready        # "status": "ready"
```

vLLM загружает веса до 15 минут. Всё это время `/ready` отвечает `llm: false`,
а вход и каталог уже работают. Если сервис не поднялся — `docker compose logs
--tail 100 <сервис>`.

### Шаг 12. TLS-прокси и файрвол

Пользователи заходят по `https://` на порт 443. TLS завершает nginx на самом
сервере и передаёт запросы интерфейсу на `127.0.0.1:3000`.

Сертификат и ключ для `goals.corp.local`:

```bash
sudo install -d -m 700 /etc/nginx/ssl
sudo cp ~/goals.crt ~/goals.key /etc/nginx/ssl/     # сертификат вместе с цепочкой ЦС
sudo chmod 600 /etc/nginx/ssl/goals.key
```

Файл `/etc/nginx/sites-available/goal-checker`:

```nginx
server {
    listen 80;
    server_name goals.corp.local;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name goals.corp.local;

    ssl_certificate     /etc/nginx/ssl/goals.crt;
    ssl_certificate_key /etc/nginx/ssl/goals.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 2m;      # как у nginx интерфейса
    proxy_read_timeout   600s;    # проверка пакета целей идёт до 10 минут
    proxy_send_timeout   600s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/goal-checker /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Чтобы в журнале аудита были адреса пользователей, а не адрес прокси,
пропишите в `.env` подсеть docker-сети стека — с неё прокси приходит
в контейнер:

```bash
docker network inspect goal-checker_default -f '{{(index .IPAM.Config 0).Subnet}}'
# в .env: TRUSTED_PROXY=<эта подсеть>, например 172.18.0.0/16
docker compose up -d --no-build     # пересоздаст web с новой настройкой
```

Файрвол — снаружи открыты только SSH и 443:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp               # только для перенаправления на https
sudo ufw allow 443/tcp
sudo ufw enable
```

Порты Neo4j, vLLM, API и интерфейса привязаны к `127.0.0.1` и снаружи
недоступны и без файрвола. К Neo4j Browser с рабочего места —
через туннель: `ssh -L 7474:localhost:7474 -L 7687:localhost:7687 <сервер>`.

### Шаг 13. Первый вход

1. Откройте `https://goals.corp.local` и войдите под логином из
   `AUTH_ADMIN_LOGINS`.
2. В разделе «Пользователи» назначьте роли остальным.
3. Проверьте одну цель — ответ модели, а не «на ручную проверку».

### Шаг 14. Регламентные резервные копии и мониторинг

Копии снимаются автоматически по таймерам systemd
([регламент](#регламент-резервного-копирования)):

| Что | Когда | Простой | Хранится |
|---|---|---|---|
| ночная копия (`scripts/backup.sh`): каталог, пользователи, ключи, настройки, журнал аудита | каждый день в 02:15 | нет | 14 дней |
| полный дамп с проверкой (`scripts/dump.sh`): вся база, включая историю проверок | по воскресеньям в 03:30 | API и Neo4j ~1 минуту | 60 дней |

Включение (`$USER` — пользователь из группы `docker`, от которого идут копии):

```bash
sudo cp deploy/systemd/goal-checker-*@.service deploy/systemd/goal-checker-*@.timer /etc/systemd/system/
sudo cp deploy/systemd/goal-checker-backup.env.example /etc/default/goal-checker-backup
sudo nano /etc/default/goal-checker-backup     # BACKUP_DIR — лучше другой диск или сетевой ресурс
sudo systemctl daemon-reload
sudo systemctl enable --now goal-checker-backup@$USER.timer goal-checker-dump@$USER.timer
systemctl list-timers 'goal-checker-*'          # время следующего запуска
```

Проверить сразу, не дожидаясь ночи:

```bash
sudo systemctl start goal-checker-backup@$USER.service
tail backups/backup.log                         # «готово: …/auto-<дата>»
```

Опрос готовности — в `crontab -e` того же пользователя:

```bash
*/5 * * * * curl -fsS --max-time 20 -o /dev/null http://127.0.0.1:8080/ready || logger -p user.err -t goal-checker "ready: не готов"
```

Вместо `logger` подставьте свой способ оповещения; что ещё включить
в мониторинг — в разделе [мониторинг](#мониторинг-и-автоперезапуск).

Установка закончена. Новые версии ставятся по инструкции [релиза](release.md).

## Как устроен стек

| Сервис | Что делает | Адрес |
|---|---|---|
| `web` | интерфейс и прокси `/api` к API | `WEB_BIND`:3000 — только через TLS-прокси |
| `api` | API проверки целей | `127.0.0.1:8080`; Swagger `/docs` — при `ENABLE_DOCS=1` |
| `neo4j` | база: каталог, пользователи, история | `127.0.0.1:7474` (браузер), `127.0.0.1:7687` (bolt) |
| `vllm` | модель | `127.0.0.1:8000`; при `VLLM_REPLICAS=0` не запускается |
| `seeder` | разово при каждом старте: схема базы и первая загрузка каталога | — |
| `autoheal` | перезапускает зависшие `vllm` и `api` | без сети |
| `model` | разово при релизе: скачивает веса (профиль `release`) | — |

Keycloak стенда в боевой стек не входит: он описан в
`docker-compose.stand.yml`, который на сервере не подключается.

Порядок подъёма: `neo4j` → `seeder` → `api`; `vllm` поднимается параллельно.
API стартует, только когда сидер успешно отработал: схема базы должна
появиться до первой правки каталога. Сидер загружает `data.cypher` только
в пустой каталог, на непустом он файл не читает ([данные каталога](#данные-каталога)).
Готовности модели API не ждёт: вход, каталог и настройки работают, пока
vLLM грузит веса, а готовность модели видна в `/ready` (поле `llm`).

Имя compose-проекта задано в `docker-compose.yml` (`name: goal-checker`):
тома, сеть и контейнеры называются `goal-checker_*`, в каком бы каталоге
ни лежал клон.

Логи контейнеров ротируются (`LOG_MAX_SIZE` × `LOG_MAX_FILES`, по умолчанию
50 МБ × 5); vLLM промпты в лог не пишет. Журнал аудита API пишется ещё и
в файл на томе `api_audit` ([журнал аудита](#журнал-аудита)).
При остановке API идущим запросам даётся 45 секунд доработать, docker
ждёт 60.

### Что закрыто от сети

| Обращение в интернет | Когда и чем закрыто |
|---|---|
| `pip install` и `npm ci` | только при сборке образов (`docker compose build`); в контейнерах — готовые пакеты и статика |
| `docker pull` | только с `PULL_POLICY=always` при релизе; по умолчанию у всех сервисов `pull_policy: never` — недостающий образ даёт ошибку, а не тихую загрузку |
| корпоративный прокси | работающему стеку не нужен; `NO_PROXY` у `api`, `seeder` и `vllm` исключает обращения между сервисами, даже если прокси подставлен из `~/.docker/config.json` ([сеть через прокси](release.md#сеть-для-релиза-через-прокси)) |
| веса с Hugging Face | только разовым сервисом `model`; vLLM читает `${MODELS_DIR}` с `HF_HUB_OFFLINE=1` |
| телеметрия vLLM и Hugging Face | `VLLM_NO_USAGE_STATS=1`, `HF_HUB_DISABLE_TELEMETRY=1`, `DO_NOT_TRACK=1` |

Веб-интерфейс внешних скриптов и шрифтов не подключает: браузеру
пользователя интернет тоже не нужен.

Перезапуск установленного стека сети не требует:
`docker compose up -d --no-build`. `--build` без сети не сработает —
пересборка образов входит в релиз.

Для разработки, когда стеку можно ходить в интернет и во время работы,
есть надстройка `docker-compose.online.yml` (образы и веса скачиваются сами):

```bash
docker compose -f docker-compose.yml -f docker-compose.online.yml up -d --build
```

### Видеокарта

Модель по умолчанию — `RedHatAI/Qwen3.8-27B-INT4`: Qwen3.8-27B, сжатая
до 4 бит (W4A16). Веса около 19 ГБ на диске и около 17 ГБ в памяти GPU:
энкодер изображений не грузится (`--language-model-only`). Остаток памяти,
который vLLM берёт себе (`VLLM_GPU_MEMORY_UTILIZATION`), уходит под кэш
одновременных запросов.

| Карта | `VLLM_GPU_MEMORY_UTILIZATION` | `LLM_MAX_CONCURRENCY` | `LLM_INTERACTIVE_RESERVE` |
|---|---|---|---|
| 24 ГБ (A10, L4, RTX 4090) | `0.93` | `8` | `2` |
| 48 ГБ и больше | `0.90` | `32` | `4` |

На карте 24 ГБ под кэш остаётся 2–3 ГБ. Модель гибридная: полное внимание
только в 16 слоях из 64, и запрос на всё окно 16K занимает около 1 ГБ кэша,
короткая цель — во много раз меньше. Окно (`VLLM_MAX_MODEL_LEN`) там
не увеличивайте. Предел запросов подстройте по мониторингу: если
`gpu_cache_usage_perc` держится около 100% и запросы копятся в очереди
vLLM, его надо снизить в «Настройках».

Карта 24 ГБ обычно стоит на сервере с небольшой оперативной памятью. При
32 ГБ RAM задайте Neo4j явные пределы heap и pagecache, чтобы vLLM, API,
Keycloak и база не вытесняли друг друга.

На картах с FP8 (Ada, Hopper, Blackwell) и памятью от 40 ГБ можно взять
`Qwen/Qwen3.8-27B-FP8`: точнее INT4, веса около 30 ГБ. Для Blackwell нужен
vLLM не ниже v0.28; `VLLM_IMAGE` по умолчанию — v0.30.0.

### Без GPU

Модель на другом сервере — внешний OpenAI-совместимый эндпоинт:

```dotenv
VLLM_URL=https://llm.corp.local/v1
VLLM_API_KEY=…            # если эндпоинт требует ключ
VLLM_REPLICAS=0           # сервис vllm не запускается
LLM_CA_FILE=/certs/corp-ca.pem   # если сертификат выдан внутренним ЦС
```

При внешнем `VLLM_URL` должно быть `VLLM_REPLICAS=0`, без него —
`VLLM_REPLICAS=1`: иначе compose поднимет vLLM на сервере без GPU или API
пойдёт в выключенный локальный vLLM. Без файла ЦС каждый вызов модели падает
с `CERTIFICATE_VERIFY_FAILED`, цели уходят на ручную проверку, `/ready`
отвечает `llm: false`. Если к эндпоинту нельзя идти через прокси из
`~/.docker/config.json`, добавьте его имя в `NO_PROXY_EXTRA`. Вернуться
к локальной модели — убрать `VLLM_URL`, задать `VLLM_REPLICAS=1` и скачать
веса (шаг 10).

## Обслуживание

**Резервные копии.** Регламентные копии снимают таймеры из шага 14. Перед
релизом, миграциями, полным сбросом и `SEED_DATA=1` дамп снимается ещё и
вручную — `scripts/dump.sh` ([восстановление](#резервная-копия)).

**Время.** При расхождении часов сервера и Keycloak вход зацикливается
у всех пользователей. Проверка: `timedatectl` — `System clock
synchronized: yes`; `chronyc tracking` — `System time` в пределах долей секунды.

### Смена пароля Neo4j

Пароль записывается в базу при первом старте; новое значение
`NEO4J_PASSWORD` в `.env` его не меняет, и healthcheck с новым паролем не
пройдёт. Сначала меняется пароль в базе, потом `.env`:

```bash
docker compose exec neo4j cypher-shell -u neo4j -p '<старый>' \
  "ALTER CURRENT USER SET PASSWORD FROM '<старый>' TO '<новый>'"
# поправить NEO4J_PASSWORD в .env
docker compose up -d --no-build
```

### Мониторинг и автоперезапуск

Docker без Swarm по статусу `unhealthy` контейнер не перезапускает:
`restart: unless-stopped` срабатывает, только когда процесс завершился.
Зависший vLLM (например, после сбоя драйвера GPU) или API так и остаются
висеть, а все проверки уходят на ручную. Поэтому нужны две вещи.

**Автоперезапуск — сервис `autoheal`** в `docker-compose.yml`. Раз в
`AUTOHEAL_INTERVAL` секунд (по умолчанию 30) он перезапускает контейнеры
с меткой `autoheal=true` — это `vllm` и `api`, — у которых healthcheck в
состоянии `unhealthy`. Пока идёт `start_period` (у vLLM — 15 минут на
загрузку весов), контейнер не бывает `unhealthy`, и загрузку autoheal не
прерывает. Перезапуски видны в `docker compose logs autoheal`.

autoheal получает `/var/run/docker.sock`, то есть права root на хосте; сети
у контейнера нет (`network_mode: none`). Если политика безопасности этого
не допускает — `AUTOHEAL_REPLICAS=0` в `.env` и systemd-таймер на хосте:

```ini
# /etc/systemd/system/goal-checker-heal.service
[Service]
Type=oneshot
# $$ — чтобы systemd не подставлял свои переменные вместо переменных оболочки
ExecStart=/bin/sh -c 'for c in $$(docker ps -q --filter label=com.docker.compose.project=goal-checker --filter health=unhealthy); do logger -t goal-checker "перезапуск $$(docker inspect -f {{.Name}} $$c): unhealthy"; docker restart -t 60 $$c; done'

# /etc/systemd/system/goal-checker-heal.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
```

`systemctl enable --now goal-checker-heal.timer`; перезапуски — в
`journalctl -t goal-checker`.

**Внешний опрос готовности с оповещением.** `/health` отвечает, пока жив
процесс API (это healthcheck контейнера), а `/ready` проверяет то, без чего
проверки целей не работают: Neo4j, каталог и модель (`503` и причина в теле,
если что-то не так). Оба адреса, как и `/metrics`, доступны только с самого
сервера (`127.0.0.1:8080`), поэтому опрашивает их агент на сервере:

- **cron** — строка опроса из шага 14; вместо `logger` — `mail`, отправка
  в мессенджер или файл, который забирает общий мониторинг;
- **Zabbix** — элемент агента `web.page.get[127.0.0.1,/ready,8080]` и триггер
  на отсутствие `"status": "ready"` в ответе.

После перезапуска vLLM грузит веса до 15 минут, и всё это время `/ready`
отвечает `503` с `llm: false`: оповещайте, если готовности нет дольше
20 минут (в Zabbix — триггер по `nodata`/`count` за 20 минут), иначе каждый
релиз и каждое срабатывание autoheal будет давать ложную тревогу.

**Метрики — `GET /metrics`** в формате Prometheus: очередь к модели,
итоги проверок (в том числе доля `NEEDS_MANUAL_REVIEW`), состояние
предохранителей, ручные проверки сверх `CHECK_MAX_PENDING`, буфер истории,
расхождение часов с Keycloak. Как и `/ready`, он доступен только с сервера: Prometheus на этом
же сервере опрашивает `http://127.0.0.1:8080/metrics`; Prometheus на другой
машине — через агент на сервере (например, node_exporter с textfile-коллектором,
куда cron складывает `curl -s 127.0.0.1:8080/metrics`) или через
SSH-туннель. vLLM отдаёт свои метрики на `http://127.0.0.1:8000/metrics`.

Что ещё стоит включить в оповещения: строку «ОШИБКА» в
`backups/backup.log` и упавшие таймеры копий (`systemctl is-failed
goal-checker-backup@<пользователь> goal-checker-dump@<пользователь>`,
[регламент](#регламент-резервного-копирования)) и
свободное место на диске с `/var/lib/docker` и `MODELS_DIR`.

**Кэш оценок SMART.** Ограничение уникальности `:SmartScore.goalHash`
создаёт сам API при первой записи оценки, а не сидер: если в базе от прежних
версий остались повторяющиеся `goalHash`, остаётся обычный индекс,
в логе API — предупреждение. Очистка кэша «Оценки по SMART» в «Настройках»
удаляет все оценки, после этого ограничение создастся.

## Данные каталога

Каталог хранится в двух файлах `neo4j/init/`:

| Файл | Что в нём | Когда применяется |
|---|---|---|
| `seed.cypher` | только схема: ограничения и индексы | сидером при каждом `docker compose up`, идемпотентно |
| `data.cypher` | данные каталога — выгрузка из живой базы этого сервера; в git не хранится, заготовка — `data.example.cypher` | только вместе со стандартным `seed.cypher` и только к пустому каталогу (первый запуск на новой базе) или по явному `SEED_DATA=1`; при `reset_and_load` и миграциях не применяется даже с `SEED_DATA=1` |

Сами приказы не пишутся в файл руками — они выгружаются из живой базы
(на хосте, из каталога с `docker-compose.yml`):

```bash
docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
  && diff -u neo4j/init/data.cypher neo4j/init/data.cypher.new | less   # что поменялось в нормативке
mkdir -p backups && chmod 700 backups
cp -p neo4j/init/data.cypher "backups/data-$(date +%Y%m%d-%H%M%S).cypher" 2>/dev/null
mv neo4j/init/data.cypher.new neo4j/init/data.cypher
```

`data.cypher` — файл сервера, а не репозитория: он в `.gitignore`, `git pull`
и откат версии его не трогают, коммитить его не нужно (у стенда и сервера
каталоги разные, общий файл в git сталкивал бы их выгрузки). Историю
выгрузок хранит `backups/`: прежняя версия откладывается туда перед `mv`,
туда же её кладут дамп перед релизом и [ночная копия](#регулярная-копия).
Каталог со стенда на сервер переносится файлом (`scp`), а не через git.

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

Это восстановление, а не слияние: в одной транзакции сидер удаляет узлы
каталога (приказы, пункты, правила, атрибуты, примеры, подразделения,
инструкции — те же метки, что очищает `reset_and_load`) и загружает файл.
Узлы, заведённые после выгрузки, и переименованные с тех пор узлы исчезают,
двойников не остаётся. Пользователи (`:User`), ключи доступа (`:ApiKey`),
настройки (`:Setting`), история проверок, оценки SMART и учёт миграций
не трогаются. Сбой откатывает всё целиком. Если файла нет или в нём нет
операторов, `SEED_DATA=1` каталог не трогает — в логе сидера предупреждение.

Файла `data.cypher` нет вовсе (новая установка, в git его нет) — сидер
загружает только схему, каталог остаётся пустым и заполняется в интерфейсе
или из заготовки `data.example.cypher`
(`cp neo4j/init/data.example.cypher neo4j/init/data.cypher`).

## Резервная копия

Копий два вида:

| | Ночная копия — `scripts/backup.sh` | Дамп — `scripts/dump.sh` |
|---|---|---|
| Что в ней | каталог, пользователи и роли, ключи доступа, настройки, журнал аудита | вся база, включая историю проверок и оценки SMART, и копия `data.cypher` |
| Простой | нет | API и Neo4j останавливаются (около минуты на небольшой базе) |
| Где | `backups/auto-<дата>/` | `backups/dump-<дата>/neo4j.dump` |
| Когда | каждую ночь по таймеру | раз в неделю по таймеру, а также вручную перед релизом, миграциями, `reset_and_load`, `SEED_DATA=1` |

Обе запускаются сами по [регламенту](#регламент-резервного-копирования).
Перед операцией, которая меняет или удаляет данные, дамп снимается вручную,
из каталога проекта:

```bash
scripts/dump.sh
```

Что делает скрипт: останавливает `api` и `neo4j` (Neo4j 5 Community делает
дамп только остановленной базы), снимает дамп с тома `neo4j_data`, затем
проверяет его — загружает во временный каталог внутри одноразового
контейнера (не в том `neo4j_data`) и прогоняет `neo4j-admin database check`,
— и запускает `neo4j` и `api` обратно, даже если дамп не удался. Для
проверки нужно свободное место размером с базу. Копия годится, только если
в выводе есть «ДАМП ПРОВЕРЕН» и последняя строка — «готово: …»; строка
«ОШИБКА» значит, что дамп обрезан или повреждён — разрушающие операции не
начинайте. Каталог `dump-<дата>` появляется, только когда дамп снят и
проверен; по размеру файла повреждение не определить: дамп пустой базы
Neo4j 5.26 весит около 13 КБ. Каталог `backups/` в git не попадает;
другой диск — `BACKUP_DIR=/mnt/backup/goal-checker scripts/dump.sh`.
Дампы старше `DUMP_KEEP_DAYS` дней (по умолчанию 60) скрипт удаляет;
снятые вручную до появления скрипта (`backups/<дата>`) не трогает.

Восстановление заменяет базу целиком:

```bash
docker compose stop api neo4j
docker compose run --rm --no-deps -v "$PWD/backups/dump-<дата>:/backups" neo4j \
  neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true
docker compose start neo4j api
```

Журнал аудита в дамп не входит: он лежит в файлах на томе `api_audit`
([подробнее](#журнал-аудита)), копируйте его отдельно — это
делает [ночная копия](#регулярная-копия).

### Регламент резервного копирования

| Копия | Расписание | Хранится | Таймер systemd |
|---|---|---|---|
| ночная (`scripts/backup.sh`) | каждый день, 02:15 | 14 дней (`BACKUP_KEEP_DAYS`) | `goal-checker-backup@<пользователь>.timer` |
| дамп с проверкой (`scripts/dump.sh`) | воскресенье, 03:30; простой ~1 минуту | 60 дней (`DUMP_KEEP_DAYS`) | `goal-checker-dump@<пользователь>.timer` |
| дамп перед релизом и разрушающими операциями | вручную | 60 дней, как и еженедельные | — |
| проверка восстановления на стенде | раз в месяц | запись в журнале эксплуатации | — ([ниже](#регулярная-копия)) |

Юниты лежат в `deploy/systemd`. Экземпляр таймера — имя пользователя из
группы `docker`, от которого идут копии. Установка — один раз, из каталога
проекта:

```bash
sudo cp deploy/systemd/goal-checker-*@.service deploy/systemd/goal-checker-*@.timer /etc/systemd/system/
sudo cp deploy/systemd/goal-checker-backup.env.example /etc/default/goal-checker-backup
sudo nano /etc/default/goal-checker-backup     # BACKUP_DIR, сроки хранения
sudo systemctl daemon-reload
sudo systemctl enable --now goal-checker-backup@$USER.timer goal-checker-dump@$USER.timer
```

- **Куда.** По умолчанию — `backups/` в каталоге проекта, то есть на том же
  диске, что и база: при отказе диска пропадут обе. Задайте `BACKUP_DIR`
  в `/etc/default/goal-checker-backup` — другой диск или сетевой ресурс,
  смонтированный до запуска таймеров, с правом записи для пользователя копий.
- **Пропуски.** У таймеров `Persistent=true`: если сервер был выключен во
  время копии, она снимется сразу после включения.
- **Одновременно не идут.** Обе копии берут общий замок `.lock` в каталоге
  копий: дамп останавливает API, и ночная копия в это время подождёт.
- **Проверка, что работает:** `systemctl list-timers 'goal-checker-*'` —
  время прошлого и следующего запуска; `tail backups/backup.log` — строки
  «готово: …»; `journalctl -u 'goal-checker-*'` — запуски таймеров.
- **Оповещение.** Сбой — строка «ОШИБКА» в `backup.log` и состояние `failed`
  у службы (`systemctl is-failed goal-checker-backup@<пользователь>
  goal-checker-dump@<пользователь>`): оба признака стоит отдать мониторингу
  ([мониторинг](#мониторинг-и-автоперезапуск)).
- **Изменить время** — `sudo systemctl edit goal-checker-dump@.timer`,
  в разделе `[Timer]` пустая строка `OnCalendar=` и новое значение.

Без systemd те же скрипты запускаются из cron пользователя с правом на docker:

```bash
crontab -e
PATH=/usr/local/bin:/usr/bin:/bin
15 2 * * * /opt/goal-checker/scripts/backup.sh
30 3 * * 0 /opt/goal-checker/scripts/dump.sh
```

Перенаправлять вывод в строке cron не нужно: скрипты сами создают каталог
копий и пишут журнал `backups/backup.log` (другое место — `BACKUP_LOG`).
Перенаправление в `backups/backup.log` при первой установке, пока каталога
ещё нет, не дало бы скрипту даже запуститься.

### Регулярная копия

Ночная копия снимается без остановки сервиса и защищает данные между
дампами.

Скрипт кладёт в `backups/auto-<дата>/`:

| Файл | Что в нём | Как снят |
|---|---|---|
| `data.cypher` | каталог: приказы, пункты, правила, атрибуты, примеры, подразделения, инструкции | `export_graph.py --stdout`, одна транзакция чтения |
| `state.cypher` | пользователи и роли (`:User`), ключи доступа внешних систем (`:ApiKey`, хранятся хэши), настройки (`:Setting`) | драйвер Neo4j из контейнера API, одна транзакция чтения; `MERGE` по `login`, `keyId`, `key` |
| `audit.tar.gz` | журнал аудита с тома `api_audit` | `tar` в контейнере API; API пишет журнал во время копии, поэтому код 1 GNU tar («file changed as we read it») — не ошибка, в архиве файл на момент чтения |

Копия собирается во временном каталоге и получает имя `auto-<дата>`, только
когда снята целиком; любая ошибка — ненулевой код и строка «ОШИБКА» с номером
строки и командой в `backup.log` (её же скрипт пишет в stderr — cron пришлёт
письмо, если на сервере настроена почта; иначе следите за журналом
мониторингом). Копии старше `BACKUP_KEEP_DAYS` дней
(по умолчанию 14) удаляются; дампы (`backups/dump-<дата>`)
скрипт не трогает. Другой диск или сетевой ресурс —
`BACKUP_DIR=/mnt/backup/goal-checker` в строке cron. В `state.cypher` —
хэши ключей доступа и логины: каталог копий закрыт (`chmod 700`), на другой
носитель — с теми же правами. `data.cypher` внутри него читаем всем (0644):
его читает сидер от uid 10001.

История проверок (`:CheckRecord`) и оценки SMART в ночную копию не входят:
история велика, а оценки SMART пересчитываются. Их сохраняет только дамп.

**Допустимая потеря данных.** При отказе диска:

| Данные | Теряется не больше | Чем восстанавливается |
|---|---|---|
| каталог, пользователи и роли, ключи доступа, настройки | суток (с последней ночной копии) | `data.cypher` + `state.cypher` |
| журнал аудита | суток | `audit.tar.gz` |
| история проверок | недели (с последнего еженедельного дампа) | только дамп |

Историю проверок между релизами защищает еженедельный дамп
([регламент](#регламент-резервного-копирования)): при отказе диска теряется
не больше недели истории. Если нужно меньше — запускайте дамп чаще.

**Восстановление из ночной копии** — на пустую базу (новый сервер или после
потери тома), с той же версией, на которой копия снята:

```bash
d=backups/auto-<дата>
cp "$d/data.cypher" neo4j/init/data.cypher      # без -p: права копии не переносить
chmod 0644 neo4j/init/data.cypher               # сидер читает файл от uid 10001
docker compose up -d --no-build                 # сидер загрузит каталог в пустую базу
docker compose exec -T neo4j sh -c 'cypher-shell -u neo4j -p "${NEO4J_AUTH#neo4j/}"' < "$d/state.cypher"
docker compose exec -T api tar -C /data/audit -xzf - < "$d/audit.tar.gz"
docker compose restart api                      # сбросить кэши пользователей, ключей и настроек
```

**Проверка восстановления** — раз в месяц и после изменений в схеме данных,
на стенде, а не на боевом сервере:

1. Скопировать свежую `backups/auto-<дата>` с сервера на стенд.
2. На стенде — `docker compose down` и `docker volume rm goal-checker_neo4j_data`
   (на стенде данные не нужны; если нужны — сначала дамп).
3. Выполнить команды восстановления выше.
4. Сверить: новая копия со стенда совпадает с восстановленной строка в
   строку (порядок строк в выгрузках стабильный):

   ```bash
   BACKUP_DIR=/tmp/verify scripts/backup.sh
   diff "$d/data.cypher" /tmp/verify/auto-*/data.cypher && \
     diff "$d/state.cypher" /tmp/verify/auto-*/state.cypher && echo "КОПИЯ ВОССТАНОВЛЕНА"
   curl -s localhost:8080/ready | python3 -m json.tool   # ready
   ```

   Затем — проверка одной цели ключом внешней системы сервера
   (`Authorization: Bearer gc_…`): ключи восстановлены, если
   ответ не 401. Вход в интерфейс на стенде идёт через Keycloak стенда, и
   пользователи сервера там не заведены — роли сверяет `diff` выше.
5. Записать дату проверки и результат в журнал эксплуатации. Если что-то не
   сошлось — копия не годится, пока причина не найдена.

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
`docker compose down && docker volume rm goal-checker_neo4j_data`.

В скрипте заведено то, что видно по ответам API: ПР-01, пункты 1.1 и 2.4.
Остальную нормативку добавляйте по закомментированному шаблону в конце файла
или через интерфейс — он делает ровно то же самое.

### Миграции

Разовые правки данных лежат в `neo4j/init/migrations/` и запускаются
тем же сидером через `SEED_FILE`. Как и сброс, каждая миграция выполняется
одной транзакцией и увеличивает версию каталога; `data.cypher` вместе
с миграцией не применяется. Перед миграцией — [резервная копия](#резервная-копия).

Применённая миграция отмечается узлом `(:Migration {id, appliedAt})` (`id` —
имя файла без `.cypher`) в той же транзакции: сбой откатывает и отметку.
Повторный запуск уже применённой миграции сидер пропускает с сообщением
«уже применена (дата) — пропущена»; выполнить её ещё раз —
`-e SEED_REAPPLY=1`:

```bash
docker compose run --rm -e SEED_REAPPLY=1 \
  -e SEED_FILE=/init/migrations/002_check_target_descriptions.cypher seeder
```

Узлы `:Migration` к каталогу не относятся: в выгрузку не попадают, сброс
и `SEED_DATA=1` их не трогают. Миграции, применённые до появления учёта,
отметки не имеют и при первом запуске выполнятся ещё раз — поэтому сами
миграции написаны так, чтобы повтор не портил данные (ниже).

```bash
docker compose run --rm -e SEED_FILE=/init/migrations/001_cleanup_demo_data.cypher seeder
docker compose run --rm \
  -e SEED_FILE=/init/migrations/002_check_target_descriptions.cypher seeder
```

| Миграция | Что делает |
|---|---|
| `001_cleanup_demo_data` | удаляет демо-приказы ПР-2024-15 / ПР-2024-22 со всеми пунктами, правилами и примерами и примеры, оставшиеся без правила. Двойников атрибутов больше не сводит и атрибуты без правил не удаляет — двойников сводит API (ниже) |
| `002_check_target_descriptions` | проставляет описания атрибутам `проект` и `срок_исполнения`, только если описания нет или оно пустое: описание, отлаженное в интерфейсе или советчиком, не затирается; шаблон для остальных внутри файла |
| `003_job_descriptions` | заводит атрибут «дублирование_должностных_обязанностей» (определяется по должностным инструкциям) и, если в базе есть пункт 3.5 без правил, запрет `R-3.5` на нём; `source` и статус ставятся только новому атрибуту, описание — только если его нет: повтор не возвращает тип, сменённый в интерфейсе |
| `004_settings_api_keys` | создаёт ограничения уникальности для настроек (`:Setting`) и ключей доступа (`:ApiKey`); данных не меняет |
| `005_drop_exceptions` | удаляет связи `EXCEPT_IN`: исключений больше нет, проверка их не учитывает. До запуска отметьте «Не действует» там, где правило в подразделении действовать не должно |
| `006_api_key_names` | заполняет `nameKey` у старых ключей доступа и запрещает одноимённые ключи (без учёта регистра); у уже существующих дублей к `nameKey` дописывается `#keyId` — такие ключи стоит перевыпустить |

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
# (прежняя выгрузка — в backups/, как в разделе «Данные каталога»)
docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
  && diff -u neo4j/init/data.cypher neo4j/init/data.cypher.new | less
cp -p neo4j/init/data.cypher "backups/data-$(date +%Y%m%d-%H%M%S).cypher" 2>/dev/null
mv neo4j/init/data.cypher.new neo4j/init/data.cypher
```

## Журнал аудита

Каждое изменение, вход, выход, отказ в правах и отвергнутый токен —
JSON-строка логгера `audit`. Строки пишутся в файл
`/data/audit/audit.log` на томе `api_audit` — он переживает пересоздание
контейнера и обновления — и дублируются в общий лог API. Файл сменяется
в полночь (UTC) или раньше, когда превысит `AUDIT_MAX_FILE_MB` (по умолчанию
100 МБ). Сменённые файлы удаляются, когда им больше `AUDIT_RETENTION_DAYS`
суток (по умолчанию 365), — по возрасту, а не по числу: поток запросов,
сменяющий файл по размеру, историю за год не вытесняет. Предел на все файлы
журнала — `AUDIT_MAX_TOTAL_MB` (по умолчанию 20480): сверх него история не
удаляется, но анонимные отказы в файл больше не пишутся, а в лог API не чаще
раза в час идёт ERROR — освободите место или перенесите старые файлы. Журнал пишется независимо от `LOG_LEVEL`. Если каталог недоступен
на запись, API пишет журнал только в stdout и предупреждает об этом в логе.

```bash
docker compose exec api tail -n 100 /data/audit/audit.log
docker compose logs api | grep ' audit: '      # то же, но только пока жив контейнер
```

Том `api_audit` включайте в резервное копирование сервера: в дамп Neo4j
журнал не входит. Ночная копия `scripts/backup.sh` снимает его в
`backups/auto-<дата>/audit.tar.gz` ([регулярная копия](#регулярная-копия)).

```json
{"ts": "2026-10-02T09:14:03+00:00", "event": "login_ok", "login": "i.ivanov", "role": "editor", "source": "ui",
 "ip": "10.1.2.3", "session_id": "5f0c…", "request_id": "9b1e…", "object": "session", "result": "success", "blocked": false}
{"ts": "2026-10-02T09:15:40+00:00", "event": "request", "login": "i.ivanov", "role": "editor", "source": "ui",
 "ip": "10.1.2.3", "session_id": "5f0c…", "request_id": "c41a…", "object": "/catalog/nodes/4:…:12/properties",
 "result": "success", "blocked": false, "method": "PATCH", "path": "/catalog/nodes/4:…:12/properties",
 "status": 200, "ms": 31, "body": "{\"properties\": …}"}
{"ts": "2026-10-02T09:16:02+00:00", "event": "access_denied", "login": "p.petrov", "role": null, "source": "ui",
 "ip": "10.1.2.9", "session_id": "77d2…", "request_id": "e803…", "object": "/catalog/tree",
 "result": "denied", "blocked": true, "reason": "not_registered"}
```

### Поля строки (требование ИБ 13.1)

Поля ниже есть в каждой строке, даже пустые (`null`), — разбор в SIEM не
зависит от вида события.

| Требование 13.1 | Поле | Что в нём |
|---|---|---|
| Идентификатор пользователя | `login` | логин из Keycloak; внешняя система — `key:<имя ключа>`; без входа — `null` |
| Роль | `role` | роль того, кто действует: `viewer`, `editor`, `admin`, у ключа — `service` |
| Источник | `source` | `ui` — интерфейс сервиса (токен Keycloak), `api` — внешняя система по ключу, `system` — событие вне запроса |
| Адрес | `ip` | адрес клиента из `X-Real-IP`, который ставит nginx; за TLS-прокси — при верном `TRUSTED_PROXY` |
| Время | `ts` | UTC, ISO 8601 |
| Идентификатор сессии | `session_id` | сессия Keycloak (claim `sid`): по ней собираются все запросы одного входа; у ключа сессии нет — `null` |
| Идентификатор запроса | `request_id` | `$request_id` nginx (32 шестнадцатеричных знака), он же в заголовке ответа `X-Request-ID`; запрос мимо nginx получает свой |
| Действие | `event` | вид события; у `request` — ещё `method` и `path` |
| Объект доступа | `object` | путь запроса; у действий администратора — `user:<логин>`, `api_key:<id>`, `settings`, `cache:<имя>`; у входа и выхода — `session` |
| Результат действия | `result` | `success`, `failure` (ошибка, код 4xx/5xx) или `denied` (отказ) |
| Признак блокировки | `blocked` | `true` — действие остановлено защитой: нет входа или прав (401, 403), превышен предел частоты (429), отвергнут токен или ключ |

В `user_created` и `user_deleted` роль учётной записи, которую создали или
удалили, — в `target_role`: `role` всегда роль администратора.

### Отправка в SIEM

При заданном `AUDIT_SYSLOG_URL` каждая строка журнала дополнительно уходит
в SIEM сообщением syslog RFC 5424; сама строка JSON — его текст (MSG):

```
<110>1 2026-10-02T09:15:40.512+00:00 ALB-PH-UCTLLM1 goal-checker - AUDIT - {"ts": …, "event": "request", …}
```

Facility — 13 (log audit), severity — 4 (warning) у строк с
`"blocked": true` и 6 (informational) у остальных.

| Переменная | Что задаёт |
|---|---|
| `AUDIT_SYSLOG_URL` | `udp://хост[:514]`, `tcp://хост[:514]` или `tls://хост[:6514]`; пусто — в SIEM не отправляется |
| `AUDIT_SYSLOG_CA_FILE` | корень внутреннего ЦС для `tls://`, файл в `./certs` (`/certs/<файл>`) |
| `AUDIT_SYSLOG_HOSTNAME` | имя сервера в сообщениях; по умолчанию — имя контейнера, на боевом сервере задайте имя хоста |
| `AUDIT_SYSLOG_APP_NAME` | APP-NAME в сообщениях, по умолчанию `goal-checker` |

По TCP и TLS сообщения разделяются подсчётом октетов (RFC 6587). Отправка
идёт из отдельного потока через очередь на 10 000 строк: недоступный SIEM
не задерживает запросы. Не удалось отправить и со второй попытки или
очередь полна — строка отбрасывается, а в лог API не чаще раза в минуту
идёт ERROR с числом потерянных строк; в файле на томе они есть. Формат
согласуется с СБиПР ИБ: если нужен другой (например, CEF), меняется только
`_SyslogSink.line` в `api/audit.py`.

Для изменений каталога пишется тело запроса (первые 2000 символов) —
видно, что именно поменяли. У советчика (`/catalog/advice`) из тела
пишутся только `attribute`, `expected` и `department_id`: цель и
обоснование — тексты пользователей. Тела запросов к `/auth` и тексты
проверяемых целей в журнал не попадают. Строка запроса пишется до 1000
символов. У вошедших пишется каждый запрос — и изменения, и чтение, и
проверки целей по ключу внешней системы (без текста цели). Исключение —
удачный опрос, который интерфейс повторяет каждые несколько секунд, пока
раздел открыт (`GET /monitoring/now`, `GET /catalog/examples-check`): иначе
он вытеснил бы действия. Отказ в опросе пишется.

Анонимные отказы — запрос без входа, отвергнутый токен (`token_rejected`),
неверный ключ (`api_key_rejected`) — пишутся без тела, со строкой запроса
до 200 символов и не больше 10 строк в минуту с одного адреса. Остальные
считаются и, когда минута адреса закончилась, пишутся одной строкой
`anonymous_suppressed` с `ip`, началом окна `since` и `counts` по событиям:
иначе любой без учётной записи наполнял бы журнал.

`login_ok` пишется при первом запросе с новой сессией Keycloak (claim
`sid`), а не на каждый обновлённый токен; тогда же обновляется «последний
вход» в реестре. `access_denied` с `reason`: `not_registered` — вошёл
в Keycloak, но роль не назначена или пользователь заблокирован;
`wrong_client:…` — токен выдан другому клиенту; `bad_login:…` — логин
с недопустимыми символами. `login_sub_mismatch` — логин закреплён за другой
учётной записью Keycloak. `token_rejected` — токен не прошёл проверку
(`reason` — почему, до 200 символов; `kid` токена не пишется) или Keycloak
недоступен (`keycloak_unavailable`). Сами попытки входа и неверные пароли —
в журнале Keycloak.

Действия администратора с реестром: `user_created` (`target`, `role`),
`user_changed` (`target`, `changes` и прежние значения в `before`),
`user_deleted` (`target`, `role`, `status`), `user_unbound` — снята привязка
к учётной записи Keycloak.

## Зависимости API

`api/requirements.txt` — прямые зависимости, `api/requirements.lock` —
полный список с версиями и sha256, по которому собирается образ
(`--require-hashes --no-deps`: подменённый пакет или пакет сверх lock —
ошибка сборки). После правки `requirements.txt`:

```bash
docker run --rm --platform linux/amd64 -v "$PWD/api:/src:ro" \
  python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 sh -ec '
    pip install --quiet --root-user-action=ignore --disable-pip-version-check pip-tools >&2
    cp /src/requirements.txt /src/requirements.lock /tmp/ && cd /tmp
    pip-compile --quiet --generate-hashes --strip-extras --allow-unsafe --no-emit-index-url \
      --output-file requirements.lock requirements.txt >&2
    cat requirements.lock' > api/requirements.lock.new \
  && mv api/requirements.lock.new api/requirements.lock
```

Существующий lock берётся за основу: новые пакеты дописываются, версии
прочих не меняются. Поднять все незакреплённые транзитивные версии —
добавить `--upgrade` к `pip-compile`.

Нужны интернет и Docker. Lock собирается в контейнере с тем же базовым
образом, что и API (`ARG PYTHON_IMAGE` в `api/Dockerfile`), под `linux/amd64` —
маркеры окружения вычисляются как на сервере. Каталог `api` смонтирован
только на чтение, а lock выводится в stdout: файл остаётся за владельцем
на хосте, а при ошибке прежний lock цел. На сервер новый lock попадает
со следующим релизом.
Согласованность lock и `requirements.txt` проверяет тест `tests/test_lock.py`.

## Переменные окружения

Переменные, которые читает API, перечислены в `environment` сервиса `api`
в `docker-compose.yml` с теми же значениями по умолчанию, что в коде
(сверяет `tests/test_deploy.py`). Переменная из `.env`, которой там нет,
до контейнера не доходит.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `NEO4J_PASSWORD` | — | пароль Neo4j (обязательна); смена — см. выше |
| `VLLM_MODEL` | `RedHatAI/Qwen3.8-27B-INT4` | имя, под которым модель доступна через API vLLM (задайте явно) |
| `VLLM_MODEL_DIR` | `Qwen3.8-27B-INT4` | каталог весов внутри `MODELS_DIR` (задайте явно) |
| `MODELS_DIR` | `./models` | каталог с весами моделей на хосте |
| `VLLM_IMAGE` | `vllm/vllm-openai:v0.30.0` | образ vLLM, скачивается при релизе |
| `APP_VERSION` | `latest` | тег образов API и интерфейса; разный у релизов — откат без сети ([release.md](release.md#откат)) |
| `HF_TOKEN` | — | только для сервиса `model` при релизе, если модель закрытая; работающему стеку не нужен |
| `VLLM_URL` | `http://vllm:8000/v1` | адрес OpenAI-совместимого API; внешний — вместе с `VLLM_REPLICAS=0`, см. «Без GPU» |
| `VLLM_REPLICAS` | `1` | только для compose (`deploy.replicas` сервиса `vllm`): `0` — локальный vLLM не запускать (модель по внешнему `VLLM_URL`); допустимо `0` или `1` |
| `VLLM_API_KEY` | `dummy` | ключ внешнего эндпоинта модели |
| `LLM_CA_FILE` | системные | корневой сертификат модели по `https://` (внутренний ЦС), путь внутри контейнера (`/certs/…`); файл кладётся в `./certs`; наличие файла проверяется при старте, как у `KEYCLOAK_CA_FILE` |
| `VLLM_MAX_MODEL_LEN` | `16384` | окно модели в токенах; больше окно — больше памяти GPU на каждый запрос |
| `VLLM_GPU_MEMORY_UTILIZATION` | `0.90` | доля памяти GPU, которую берёт vLLM: веса модели, остальное — кэш одновременных запросов; на карте 24 ГБ — `0.93` ([видеокарта](#видеокарта)) |
| `LLM_TIMEOUT_SECONDS` | `60` | таймаут ответа модели при проверке |
| `LLM_CONNECT_TIMEOUT_SECONDS` | `5` | таймаут соединения с моделью |
| `LLM_MAX_RETRIES` | `2` | повторов запроса к модели — только при ошибке соединения и ответе 5xx; после таймаута ответа повтора нет |
| `LLM_BREAKER_TIMEOUTS` | `3` | после стольких таймаутов подряд (ручные и пакетные запросы считаются раздельно) модель не опрашивается `LLM_BREAKER_SECONDS`: ручные проверки сразу уходят на ручную проверку, пакетные ждут; `0` — выключено |
| `LLM_BREAKER_SECONDS` | `60` | на сколько секунд срабатывает предохранитель; затем к модели идёт один пробный запрос |
| `LLM_BREAKER_BULK_WAIT_SECONDS` | `300` | сколько пакетные цели ждут закрытия предохранителя от начала сбоя, затем уходят на ручную проверку; `0` — не ждать |
| `LLM_QUEUE_TIMEOUT_SECONDS` | `120` | сколько ручная проверка (и подбор описания советчиком) ждёт места в очереди к модели, затем `503` с `Retry-After`; `0` — без предела; пакеты ждут без предела; советчик целиком ограничен 300 с |
| `LLM_MAX_TOKENS` | `1024` | потолок длины ответа модели при проверке |
| `LLM_JSON_MODE` | `1` | ответ модели по JSON-схеме; `0` — разбор свободного текста |
| `BULK_MAX_WORKERS` | `16` | потоков на один пакет целей |
| `BULK_DEADLINE_SECONDS` | `520` | пакет `/check-goals` отвечает не позже стольких секунд; цели, до которых не дошли, — `NEEDS_MANUAL_REVIEW` с пометкой и `"unchecked": true`. Умолчание — 600 (таймаут nginx) − `LLM_TIMEOUT_SECONDS` − `LLM_CONNECT_TIMEOUT_SECONDS` − 15: после остановки ещё дожидается запрос к модели, уже бывший в полёте. Если срок вместе с таймаутом модели не меньше 600 с, API при старте пишет предупреждение |
| `CHECK_MAX_PENDING` | пусто | предел ожидающих ручных проверок на весь сервис; сверх — сразу `503` с `Retry-After`; пусто — вдвое больше предела запросов к модели |
| `BULK_MAX_REQUESTS` | `4` | одновременных запросов `/check-goals` на весь сервис; сверх — сразу `503` с `Retry-After: 30` |
| `API_THREADS` | пусто | потоков для обработчиков API, не меньше 40; пусто — `40 + 2 × llmMaxConcurrency + BULK_MAX_WORKERS + BULK_MAX_REQUESTS`, при увеличении «Предела запросов к модели» в «Настройках» растёт без перезапуска |
| `LLM_MAX_CONCURRENCY` | `32` | одновременных запросов к модели на весь сервис; остальные ждут в очереди API; значение по умолчанию для настройки «Предел запросов к модели» в интерфейсе, правка там действует без перезапуска; на карте 24 ГБ — `8` ([видеокарта](#видеокарта)) |
| `LLM_INTERACTIVE_RESERVE` | `4` | слотов из них, недоступных пакетной проверке, — для ручных проверок; не больше предела минус один; значение по умолчанию для настройки «Резерв для ручных проверок» в интерфейсе |
| `CHECK_CACHE_TTL_SECONDS` | `3600` | сколько помнить ответ на ту же цель того же подразделения; `0` — не помнить; значение по умолчанию для настройки «Срок жизни кэша» в интерфейсе |
| `CHECK_CACHE_MAX_ENTRIES` | `20000` | предельный размер кэша ответов (и кэша оценок SMART в памяти) |
| `SMART_CACHE_TTL_SECONDS` | `86400` | сколько помнить оценку SMART в памяти API; `0` — без срока |
| `SMART_SCORE_RETENTION_DAYS` | `365` | оценки SMART в графе, не обновлявшиеся дольше, удаляются раз в сутки; `0` — хранить всегда |
| `JOB_DESCRIPTIONS_CACHE_TTL_SECONDS` | `60` | сколько секунд проверка помнит должностные инструкции подразделения и правила на них; `0` — читать из графа на каждую проверку; значение по умолчанию для настройки «Кэш должностных инструкций» в интерфейсе |
| `HISTORY_RETENTION_DAYS` | `365` | срок хранения истории проверок; `0` — не удалять; значение по умолчанию для настройки «Срок хранения истории» в интерфейсе |
| `JOB_TEXT_MAX_CHARS` | `24000` | символов должностных инструкций в одном запросе к модели; должно помещаться в окно |
| `DUTIES_MAX_TOKENS` | `4096` | потолок длины ответа при выписке обязанностей из инструкции |
| `DUTIES_TIMEOUT_SECONDS` | `600` | таймаут одного запроса выписки обязанностей (идёт в фоне) |
| `DUTIES_WORKERS` | `1` | одновременных фоновых выписок обязанностей; не больше 2 |
| `MAX_GOALS_PER_REQUEST` | `200` | предел размера пакета в `/check-goals`; интерфейс узнаёт его из `/auth/me` |
| `CHECK_RATE_PER_MINUTE` | `600` | сколько целей в минуту может проверить один пользователь или один ключ доступа; сверх этого — `429`; `0` — без ограничения; значение по умолчанию для настройки «Лимит проверок» в интерфейсе |
| `GOAL_MAX_CHARS` | `4000` | предел длины цели в символах (100–8000) для проверки, пакета и советчика; длиннее — `422`; значение по умолчанию для настройки «Длина цели» в интерфейсе |
| `PROMPT_EXAMPLES_PER_KIND` | `2` | сколько примеров «есть» и «нет» на атрибут уходит в промпт, когда включена настройка «Примеры в промпте»; значение по умолчанию для настройки «Примеров на атрибут» в интерфейсе |
| `PROMPT_EXAMPLE_MAX_CHARS` | `300` | до скольких символов обрезается пример в промпте |
| `ADVICE_MAX_ATTEMPTS` | `3` | сколько описаний атрибута советчик перебирает, пока ответ на цели не изменится |
| `ADVICE_MAX_EXAMPLES` | `40` | на скольких примерах каталога советчик проверяет новое описание |
| `LOG_LEVEL` | `INFO` | уровень логирования; журнал аудита пишется всегда |
| `AUDIT_LOG_DIR` | `/data/audit` | каталог файла журнала аудита в контейнере; в compose задан жёстко (том `api_audit`), из `.env` не меняется |
| `AUDIT_RETENTION_DAYS` | `365` | сколько суток хранить сменённые файлы журнала аудита — по возрасту, а не по числу файлов (файл сменяется в полночь UTC или по `AUDIT_MAX_FILE_MB`) |
| `AUDIT_MAX_TOTAL_MB` | `20480` | предел объёма всех файлов журнала аудита, МБ; сверх него история не удаляется, но анонимные отказы в файл больше не пишутся, а в лог API идёт ERROR |
| `AUDIT_MAX_FILE_MB` | `100` | предельный размер одного файла журнала аудита, МБ; при превышении файл сменяется раньше полуночи |
| `AUDIT_SYSLOG_URL` | — | отправка журнала аудита в SIEM (syslog RFC 5424): `udp://`, `tcp://` или `tls://хост[:порт]`; пусто — не отправляется ([подробнее](#отправка-в-siem)) |
| `AUDIT_SYSLOG_CA_FILE` | — | корень внутреннего ЦС для `tls://`, файл в `./certs` (`/certs/<файл>`) |
| `AUDIT_SYSLOG_HOSTNAME` | имя контейнера | имя сервера в сообщениях syslog |
| `AUDIT_SYSLOG_APP_NAME` | `goal-checker` | APP-NAME в сообщениях syslog |
| `LOG_MAX_SIZE` | `50m` | размер одного файла лога контейнера |
| `LOG_MAX_FILES` | `5` | сколько файлов лога хранить на контейнер |
| `AUTOHEAL_REPLICAS` | `1` | только для compose: `0` — не запускать `autoheal` (вместо него systemd-таймер, см. «Мониторинг и автоперезапуск») |
| `AUTOHEAL_INTERVAL` | `30` | раз во сколько секунд `autoheal` ищет `unhealthy`-контейнеры |
| `AUTOHEAL_IMAGE` | `willfarrell/autoheal:1.2.0` | образ `autoheal`, скачивается при релизе |
| `SEED_DATA` | `0` | `1` — восстановление каталога из `data.cypher`: в одной транзакции сидер удаляет узлы каталога и загружает файл (`:User`, `:ApiKey`, `:Setting`, история проверок и оценки SMART не трогаются); нет файла или он пуст — каталог не трогается; обычно задаётся разово: `docker compose run --rm -e SEED_DATA=1 seeder` |
| `SEED_REAPPLY` | `0` | `1` — выполнить миграцию из `SEED_FILE` повторно, даже если она уже отмечена применённой (узел `:Migration`); разово: `docker compose run --rm -e SEED_REAPPLY=1 -e SEED_FILE=… seeder` |
| `SEED_DATA_FILE` | `/init/data.cypher` | файл данных сидера (в compose задан жёстко) |

Вход через Keycloak и публикация интерфейса (подробности — в [шаге 8](#шаг-8-клиент-в-keycloak)):

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `KEYCLOAK_URL` | — | публичный адрес Keycloak, `https://…` — по нему ходит браузер, он же издатель токенов (обязательна); может содержать путь (`/auth`) |
| `KEYCLOAK_REALM` | — | realm, в котором заведён клиент интерфейса (обязательна) |
| `KEYCLOAK_CLIENT_ID` | — | публичный клиент интерфейса в этом realm-е (обязательна) |
| `KEYCLOAK_INTERNAL_URL` | `KEYCLOAK_URL` | адрес Keycloak для самого API, если отличается от публичного (например, `http://keycloak:8080` внутри docker); `http://` — только с именем сервиса docker, иначе предупреждение при старте |
| `KEYCLOAK_CA_FILE` | системные | корневой сертификат Keycloak, путь внутри контейнера (`/certs/…`); действует для `https://`, наличие файла проверяется при старте |
| `NO_PROXY_EXTRA` | — | только для compose: имена и адреса через запятую, которые дописываются к `NO_PROXY` сервисов `api`, `seeder`, `vllm` (сервисы стека и `localhost` исключены всегда); `.corp.local` — весь домен; подсети не понимаются |
| `KEYCLOAK_TIMEOUT_SECONDS` | `5` | таймаут чтения ключей подписи из Keycloak |
| `AUTH_ADMIN_LOGINS` | — | логины, которые всегда администраторы, через запятую |
| `PULL_POLICY` | `never` | `always` — только при релизе: разрешить compose скачивать образы |
| `WEB_BIND` | `0.0.0.0` | адрес, на котором слушает интерфейс (порт 3000); `127.0.0.1` — TLS-прокси на этом же сервере (так в шаблоне и `.env` стенда) |
| `TRUSTED_PROXY` | `127.0.0.1` | адрес или подсеть прокси с TLS, чьему `X-Forwarded-For` верит nginx интерфейса; по этому адресу клиента nginx и ограничивает частоту запросов к API (`API_RATE_LIMIT` в секунду, всплеск до `API_RATE_BURST`, сверх — `429`): без настройки все пользователи делят один предел адреса прокси |
| `API_RATE_LIMIT` | `50` | сколько запросов к `/api/` в секунду nginx интерфейса пропускает с одного адреса (`limit_req`); целое больше нуля, иначе — умолчание с предупреждением в журнале контейнера |
| `API_RATE_BURST` | `200` | всплеск сверх `API_RATE_LIMIT`: столько запросов разом проходит без задержки; поднимите оба предела, если офис ходит через NAT без `TRUSTED_PROXY` |
| `ENABLE_DOCS` | `0` | `1` — включить Swagger |
