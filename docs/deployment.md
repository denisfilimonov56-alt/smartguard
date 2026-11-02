# Установка на сервер

[← README](../README.md) · [Релиз (обновление версии)](release.md)

Установка на чистый сервер Ubuntu. Обновление на новую версию —
[релиз](release.md).

```
браузер ──https:443──▶ nginx на сервере (TLS) ──▶ 127.0.0.1:3000 web ──▶ api ──▶ neo4j
                                                                          └──▶ vllm (модель на GPU)
вход: браузер ◀──▶ корпоративный Keycloak
```

Всё, кроме nginx с TLS, работает в docker compose. Интернет нужен только
при установке и релизе — скачать образы и собрать API и интерфейс. Веса
модели лежат в отдельном каталоге, docker их не скачивает; после установки
стек работает без сети.

## Что подготовить заранее

| Что | Требование |
|---|---|
| Сервер | Ubuntu Server 22.04 или 24.04 LTS, x86_64, SSH с `sudo` |
| Видеокарта | NVIDIA RTX PRO 6000 Blackwell (96 ГБ), драйвер 570+ ([видеокарта](#видеокарта)); нет GPU — [модель на другом сервере](#без-gpu) |
| Диск | от 100 ГБ: веса 19–30 ГБ, образ vLLM ~10 ГБ, остальные образы, база, копии |
| Веса модели | каталог с моделью (`config.json` и все `*.safetensors`), скопированный на сервер |
| Интернет | на время установки, напрямую или [через прокси](release.md#сеть-для-релиза-через-прокси) |
| Keycloak | корпоративный Keycloak и право завести клиент |
| Имя и сертификат | DNS-имя интерфейса (`goals.corp.local`) и TLS-сертификат с ключом |
| NTP | NTP-сервер контура (обычно контроллер домена) |
| Администратор | логин первого администратора без домена (`i.ivanov`) |
| Каталог | по желанию — `data.cypher` со стенда (шаг 9) |

## Установка с нуля на Ubuntu

Команды — под своим пользователем с `sudo`.

### Шаг 1. Пакеты

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y ca-certificates curl git gnupg chrony nginx
```

### Шаг 2. Часы

API проверяет токены Keycloak по своим часам: расхождение в десятки секунд
зацикливает вход на «Сессия завершена». Часы — с того же NTP, что у Keycloak:

```bash
echo "server ntp.corp.local iburst" | sudo tee /etc/chrony/sources.d/corp.sources
sudo sed -i 's/^pool /#pool /' /etc/chrony/chrony.conf    # без внешних пулов
sudo systemctl restart chrony
chronyc sources                     # у ntp.corp.local — ^*
timedatectl                         # System clock synchronized: yes
```

### Шаг 3. Docker

Из репозитория Docker, а не `docker.io` из Ubuntu: нужен compose 2.20+.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"     # затем перезайти по SSH
docker compose version              # 2.20 или новее
```

Группа `docker` — это права root: только для тех, кто обслуживает сервис.

### Шаг 4. GPU в контейнерах

Только для модели на этом сервере. RTX PRO 6000 (Blackwell) работает с
драйвером 570 или новее и только с открытыми модулями ядра (пакет
`nvidia-driver-570-open` или новее):

```bash
nvidia-smi                                           # RTX PRO 6000, Driver Version 570+
docker run --rm --gpus all ubuntu:24.04 nvidia-smi   # та же таблица — шаг готов
```

Ошибка `could not select device driver "" with capabilities: [[gpu]]` —
нет NVIDIA Container Toolkit:

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
docker run --rm --gpus all ubuntu:24.04 nvidia-smi
```

### Шаг 5. Код

```bash
sudo git clone <репозиторий> /opt/goal-checker
sudo chown -R "$USER": /opt/goal-checker
cd /opt/goal-checker
git checkout v1.4.0                 # тег устанавливаемой версии
```

Дальше все команды — из `/opt/goal-checker`.

### Шаг 6. `.env`

В git лежит `.env` стенда с комментариями ко всем переменным. На сервере
в нём задаются свои значения, а блок «Только стенд» (`COMPOSE_FILE`,
`KEYCLOAK_IMAGE`, `KEYCLOAK_ADMIN_PASSWORD`, `ENABLE_DOCS`) удаляется: иначе
поднимется Keycloak стенда с паролем из git.

```bash
chmod 600 .env
openssl rand -hex 24                # пароль для Neo4j
nano .env
```

| Переменная | Что указать |
|---|---|
| `NEO4J_PASSWORD` | свой пароль; записывается в базу при первом старте, потом меняется [через базу](#смена-пароля-neo4j) |
| `APP_VERSION` | версия, например `1.4.0`; у каждого релиза своя — для отката без сети |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID` | Keycloak, realm и клиент из шага 8 |
| `KEYCLOAK_INTERNAL_URL` | убрать (это адрес стенда) или внутренний `https://`-адрес Keycloak для API |
| `AUTH_ADMIN_LOGINS` | логин первого администратора |
| `WEB_BIND` | `127.0.0.1` — TLS-прокси на этом же сервере |
| `MODELS_DIR`, `VLLM_MODEL_DIR` | каталог с моделями (по умолчанию `./models`) и каталог модели в нём; `VLLM_MODEL` — имя модели для API |
| пределы GPU | по [таблице видеокарты](#видеокарта) |
| модель на другом сервере | `VLLM_URL=https://…/v1`, `VLLM_API_KEY`, `VLLM_REPLICAS=0` ([без GPU](#без-gpu)) |
| внутренний ЦС | `KEYCLOAK_CA_FILE=/certs/corp-ca.pem`, `LLM_CA_FILE=/certs/corp-ca.pem` (шаг 7) |
| интернет через прокси | `NO_PROXY_EXTRA` — адреса Keycloak и модели |

`TRUSTED_PROXY` — в шаге 12, остальное — [по умолчанию](#переменные-окружения).

### Шаг 7. Сертификат внутреннего ЦС

Если Keycloak или модель подписаны внутренним ЦС:

```bash
cp ~/corp-ca.pem certs/ && chmod 644 certs/corp-ca.pem
```

Без него вход отвечает «Сервис входа недоступен», а цели уходят на ручную
проверку (`CERTIFICATE_VERIFY_FAILED` в логе API).

### Шаг 8. Клиент в Keycloak

| Настройка клиента | Значение |
|---|---|
| Client type | OpenID Connect |
| Client ID | как `KEYCLOAK_CLIENT_ID`, например `goal-checker-web` |
| Client authentication | Off (публичный клиент) |
| Standard flow | On; Direct access grants и Implicit — Off |
| PKCE Method (Advanced) | `S256` |
| Valid redirect URIs, Valid post logout redirect URIs | `https://goals.corp.local/*` |
| Web origins | `https://goals.corp.local` |

Пользователи — из домена через User federation (LDAP/AD); `preferred_username`
должен быть логином без домена (для AD — `sAMAccountName`, маппер `username`
по умолчанию).

```dotenv
KEYCLOAK_URL=https://sso.corp.local
KEYCLOAK_REALM=corp
KEYCLOAK_CLIENT_ID=goal-checker-web
KEYCLOAK_CA_FILE=/certs/corp-ca.pem  # если Keycloak подписан внутренним ЦС
AUTH_ADMIN_LOGINS=i.ivanov
WEB_BIND=127.0.0.1                   # TLS-прокси на этом же сервере
```

- **`KEYCLOAK_URL`** — публичный адрес, тот же, что у браузера: он издатель
  токенов. Путь (`/auth`) допустим, в CSP попадает только origin. Хост с
  недопустимыми символами исключается из CSP с предупреждением в логе `web` —
  вход в браузере тогда не работает.
- **`KEYCLOAK_INTERNAL_URL`** — если API ходит в Keycloak другим путём;
  `http://` — только с именем сервиса docker (`http://keycloak:8080`).
- **`WEB_BIND`** — адрес порта 3000 (без TLS). Прокси на другой машине —
  `0.0.0.0` и файрвол на порт 3000 в цепочке `DOCKER-USER` (правила `INPUT`
  к портам docker не применяются).
- **Внешний TLS-прокси** — адрес интерфейса в Valid redirect URIs и Web
  origins; `proxy_read_timeout` и `proxy_send_timeout` от 600 с (пакет
  проверяется до 10 минут), `client_max_body_size` от `2m`.

### Шаг 9. Каталог для первой загрузки (по желанию)

Схема базы (`neo4j/init/seed.cypher`, в git) применяется сидером при каждом
старте. Каталог — приказы, пункты, правила, атрибуты, подразделения,
инструкции — живёт в базе; `neo4j/init/data.cypher` (выгрузка, обычно со
стенда) загружается только в пустой каталог:

```bash
scp стенд:/opt/goal-checker/neo4j/init/data.cypher neo4j/init/
chmod 644 neo4j/init/data.cypher    # сидер читает от uid 10001
```

Без файла каталог пустой и заполняется в интерфейсе. `data.example.cypher` —
образец формата, на сервер его не кладут. После загрузки источник истины —
база: перезапуск и релиз правки из интерфейса не откатывают
([данные каталога](#данные-каталога)).

### Шаг 10. Образы и сборка

Нужен интернет.

```bash
docker compose pull --ignore-buildable   # Neo4j, vLLM, autoheal; модель на другом сервере — pull neo4j autoheal
docker compose build --pull              # API и интерфейс
```

У образов из реестра `pull_policy: missing`: образ скачивается, только если
его нет на диске, и дальше берётся с диска. Теги закреплены, поэтому новая
версия образа — новый тег, и она скачается так же. `--ignore-buildable`
пропускает `api`, `seeder`, `web` — их нет в реестре, они собираются.

Веса модели docker не скачивает: каталог модели кладут в `MODELS_DIR`
(в vLLM — `/models`, только чтение), его имя — `VLLM_MODEL_DIR`.

### Шаг 11. Запуск

```bash
docker compose up -d --no-build
docker compose ps -a                # seeder — exited (0), остальные — running / healthy
curl -s localhost:8080/ready        # "status": "ready" — когда модель загрузится
```

vLLM грузит веса до 15 минут: всё это время `/ready` отвечает `503` с
`llm: false`, а вход и каталог уже работают. Не поднялось —
`docker compose logs --tail 100 <сервис>`.

### Шаг 12. TLS-прокси и файрвол

TLS завершает nginx на сервере и передаёт запросы на `127.0.0.1:3000`.

```bash
sudo install -d -m 700 /etc/nginx/ssl
sudo cp ~/goals.crt ~/goals.key /etc/nginx/ssl/     # сертификат с цепочкой ЦС
sudo chmod 600 /etc/nginx/ssl/goals.key
```

`/etc/nginx/sites-available/goal-checker`:

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
    proxy_read_timeout   600s;    # пакет целей проверяется до 10 минут
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

Прокси приходит в контейнер с шлюза docker-сети, а не с `127.0.0.1`. Чтобы
в журнале были адреса пользователей, а предел частоты считался по каждому,
укажите эту подсеть в `TRUSTED_PROXY`:

```bash
docker network inspect goal-checker_default -f '{{(index .IPAM.Config 0).Subnet}}'
# в .env: TRUSTED_PROXY=<подсеть>, например 172.18.0.0/16
docker compose up -d --no-build     # пересоздаст web
```

Файрвол — снаружи SSH, 80 (перенаправление) и 443:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Neo4j, vLLM и API слушают `127.0.0.1`. К Neo4j Browser с рабочего места —
`ssh -L 7474:localhost:7474 -L 7687:localhost:7687 <сервер>`.

### Шаг 13. Первый вход

1. `https://goals.corp.local` — вход под логином из `AUTH_ADMIN_LOGINS`.
2. «Пользователи» — роли остальным.
3. Проверка одной цели: ответ модели, а не «на ручную проверку».

### Шаг 14. Резервные копии и мониторинг

Копии снимают таймеры systemd ([регламент](#регламент-резервного-копирования));
`$USER` — пользователь из группы `docker`:

```bash
sudo cp deploy/systemd/goal-checker-*@.service deploy/systemd/goal-checker-*@.timer /etc/systemd/system/
sudo cp deploy/systemd/goal-checker-backup.env.example /etc/default/goal-checker-backup
sudo nano /etc/default/goal-checker-backup     # BACKUP_DIR — лучше другой диск
sudo systemctl daemon-reload
sudo systemctl enable --now goal-checker-backup@$USER.timer goal-checker-dump@$USER.timer
systemctl list-timers 'goal-checker-*'
sudo systemctl start goal-checker-backup@$USER.service   # проверить сразу
tail backups/backup.log                                  # «готово: …/auto-<дата>»
```

Опрос готовности — `crontab -e` того же пользователя:

```bash
*/5 * * * * curl -fsS --max-time 20 -o /dev/null http://127.0.0.1:8080/ready || logger -p user.err -t goal-checker "ready: не готов"
```

Вместо `logger` — свой способ оповещения ([мониторинг](#мониторинг-и-автоперезапуск)).
Установка закончена; новые версии — по [релизу](release.md).

## Как устроен стек

| Сервис | Что делает | Адрес |
|---|---|---|
| `web` | интерфейс и прокси `/api` | `WEB_BIND`:3000 — только через TLS-прокси |
| `api` | API проверки целей | `127.0.0.1:8080`; Swagger `/docs` при `ENABLE_DOCS=1` |
| `neo4j` | база: каталог, пользователи, история | `127.0.0.1:7474` (браузер), `127.0.0.1:7687` (bolt) |
| `vllm` | модель | `127.0.0.1:8000`; при `VLLM_REPLICAS=0` не запускается |
| `seeder` | при каждом старте: схема и первая загрузка каталога | — |
| `autoheal` | перезапускает зависшие `vllm` и `api` | без сети |

Keycloak стенда — только в `docker-compose.stand.yml`, на сервере не
подключается. Порядок подъёма: `neo4j` → `seeder` → `api`, `vllm`
параллельно; модель API не ждёт, её готовность — поле `llm` в `/ready`.
Имя проекта задано (`name: goal-checker`): тома и сеть — `goal-checker_*`
в любом каталоге клона. Логи контейнеров ротируются (`LOG_MAX_SIZE` ×
`LOG_MAX_FILES`, 50 МБ × 5), vLLM промпты не пишет. При остановке API
дорабатывает запросы 45 с, docker ждёт 60.

### Что закрыто от сети

| Обращение в интернет | Когда |
|---|---|
| `pip install`, `npm ci` | только при `docker compose build` |
| `docker pull` | только для образа, которого нет на диске (`pull_policy: missing`) |
| веса с Hugging Face | никогда: vLLM читает `${MODELS_DIR}` с `HF_HUB_OFFLINE=1` |
| телеметрия | выключена: `VLLM_NO_USAGE_STATS=1`, `HF_HUB_DISABLE_TELEMETRY=1`, `DO_NOT_TRACK=1` |
| корпоративный прокси | стеку не нужен; `NO_PROXY` у `api`, `seeder`, `vllm` исключает сервисы стека |

Интерфейс внешних скриптов и шрифтов не подключает. Перезапуск —
`docker compose up -d --no-build`, без сети; `--build` без сети не
сработает. На рабочем месте разработчика всё так же: первый
`docker compose up -d` скачает недостающие образы и соберёт API и интерфейс.

### Видеокарта

Боевая карта — NVIDIA RTX PRO 6000 Blackwell, 96 ГБ. Для Blackwell нужны
драйвер 570+ (open) и vLLM v0.28+; `VLLM_IMAGE` по умолчанию — v0.30.0.

Модель по умолчанию — `RedHatAI/Qwen3.8-27B-INT4` (W4A16): ~19 ГБ на диске,
~17 ГБ в памяти GPU (`--language-model-only`, без энкодера изображений).
Карта поддерживает FP8, поэтому на ней можно взять `Qwen/Qwen3.8-27B-FP8`:
точнее INT4, ~30 ГБ весов (`VLLM_MODEL`, `VLLM_MODEL_DIR` — на её каталог).
Остаток доли `VLLM_GPU_MEMORY_UTILIZATION` — кэш одновременных запросов:
на 96 ГБ его хватает с большим запасом при любой из двух моделей.

| Карта | `VLLM_GPU_MEMORY_UTILIZATION` | `LLM_MAX_CONCURRENCY` | `LLM_INTERACTIVE_RESERVE` |
|---|---|---|---|
| RTX PRO 6000 (96 ГБ) | `0.90` | `32` | `4` |
| 24 ГБ (A10, L4 — стенд) | `0.93` | `8` | `2` |

На 96 ГБ предел запросов можно поднять в «Настройках» (без перезапуска),
пока `gpu_cache_usage_perc` в метриках vLLM не держится около 100% и запросы
не копятся в его очереди. Окно `VLLM_MAX_MODEL_LEN` (16K) на 24 ГБ не
увеличивайте. При 32 ГБ оперативной памяти задайте Neo4j явные пределы heap
и pagecache.

### Без GPU

```dotenv
VLLM_URL=https://llm.corp.local/v1
VLLM_API_KEY=…                   # если эндпоинт требует ключ
VLLM_REPLICAS=0                  # vllm не запускается
LLM_CA_FILE=/certs/corp-ca.pem   # если сертификат внутреннего ЦС
```

Внешний `VLLM_URL` — только с `VLLM_REPLICAS=0`, локальный — с `1`. Без
файла ЦС вызовы модели падают с `CERTIFICATE_VERIFY_FAILED`, `/ready` —
`llm: false`. Вернуться к локальной модели — убрать `VLLM_URL`,
`VLLM_REPLICAS=1`, положить веса в каталог из `MODELS_DIR`/`VLLM_MODEL_DIR`.

## Обслуживание

Перед релизом, миграциями, сбросом и `SEED_DATA=1` — дамп вручную:
`scripts/dump.sh` ([резервная копия](#резервная-копия)). Часы:
`timedatectl` — `synchronized: yes`, `chronyc tracking` — `System time` в
долях секунды.

### Смена пароля Neo4j

Пароль записан в базе; новый `NEO4J_PASSWORD` в `.env` сам его не меняет.
Сначала база, потом `.env`:

```bash
docker compose exec neo4j cypher-shell -u neo4j -p '<старый>' -d system \
  "ALTER CURRENT USER SET PASSWORD FROM '<старый>' TO '<новый>'"
# NEO4J_PASSWORD=<новый> в .env
docker compose up -d --no-build
```

### Мониторинг и автоперезапуск

Docker без Swarm не перезапускает `unhealthy`-контейнеры: зависший vLLM или
API висит, а проверки уходят на ручную.

**`autoheal`** раз в `AUTOHEAL_INTERVAL` с (30) перезапускает `unhealthy`
контейнеры с меткой `autoheal=true` (`vllm`, `api`); во время `start_period`
(у vLLM 15 минут) их не трогает. Журнал — `docker compose logs autoheal`.
Ему нужен `/var/run/docker.sock` (права root, сети нет). Нельзя —
`AUTOHEAL_REPLICAS=0` и таймер на хосте:

```ini
# /etc/systemd/system/goal-checker-heal.service
[Service]
Type=oneshot
# $$ — литерал $ для оболочки, а не переменная systemd
ExecStart=/bin/sh -c 'for c in $$(docker ps -q --filter label=com.docker.compose.project=goal-checker --filter health=unhealthy); do logger -t goal-checker "перезапуск $$(docker inspect -f {{.Name}} $$c): unhealthy"; docker restart -t 60 $$c; done'

# /etc/systemd/system/goal-checker-heal.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
```

`sudo systemctl daemon-reload && sudo systemctl enable --now goal-checker-heal.timer`;
перезапуски — `journalctl -t goal-checker`.

**Готовность.** `/health` — жив ли процесс API (healthcheck контейнера),
`/ready` — Neo4j, каталог и модель (`503` и причина в теле). Оба, как и
`/metrics`, доступны только с сервера, поэтому опрашивает агент на нём:
cron из шага 14 или Zabbix (`web.page.get[127.0.0.1,/ready,8080]`, триггер
на отсутствие `"status": "ready"`). После перезапуска vLLM `/ready` до
15 минут отвечает `503` — оповещайте, если готовности нет дольше 20 минут.

**Метрики** — `GET /metrics` (Prometheus): очередь к модели, итоги проверок
и доля `NEEDS_MANUAL_REVIEW`, предохранители, ручные проверки сверх
`CHECK_MAX_PENDING`, буфер истории, расхождение часов с Keycloak. Prometheus
на другой машине — через агент на сервере (textfile-коллектор node_exporter)
или SSH-туннель. Метрики vLLM — `http://127.0.0.1:8000/metrics`.

Ещё в оповещения: «ОШИБКА» в `backups/backup.log`, `failed` у таймеров копий
(`systemctl is-failed goal-checker-backup@<пользователь> goal-checker-dump@<пользователь>`),
место на дисках с `/var/lib/docker` и `MODELS_DIR`.

**Кэш оценок SMART.** Ограничение уникальности `:SmartScore.goalHash`
создаёт API при первой записи оценки. Остались повторы `goalHash` от
прежних версий — в логе API предупреждение; очистка кэша «Оценки по SMART»
в «Настройках» удалит оценки, и ограничение создастся.

## Данные каталога

| Файл `neo4j/init/` | Что в нём | Когда применяется |
|---|---|---|
| `seed.cypher` | схема: ограничения и индексы | сидером при каждом `docker compose up`, идемпотентно |
| `data.cypher` | выгрузка каталога этого сервера; в git нет, образец — `data.example.cypher` | только к пустому каталогу или по `SEED_DATA=1`; при `reset_and_load` и миграциях — никогда |

Выгрузка из живой базы (на хосте, из каталога проекта):

```bash
docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
  && diff -u neo4j/init/data.cypher neo4j/init/data.cypher.new | less   # что поменялось
mkdir -p backups && chmod 700 backups
cp -p neo4j/init/data.cypher "backups/data-$(date +%Y%m%d-%H%M%S).cypher" 2>/dev/null
mv neo4j/init/data.cypher.new neo4j/init/data.cypher
```

Сразу в `data.cypher` писать нельзя: оболочка обнулит файл до выгрузки.
Файл серверный: в `.gitignore`, `git pull` и откат его не трогают, со стенда
переносится `scp`. Выгрузка внутри контейнера —
`docker compose exec api python export_graph.py --output /init/data.cypher`;
для неё uid 10001 нужно право записи в `neo4j/init` или в сам файл
(`sudo chgrp 10001 neo4j/init/data.cypher && sudo chmod g+w neo4j/init/data.cypher`).

В выгрузке — приказы, пункты, правила, атрибуты, примеры, подразделения,
инструкции и связи, одной транзакцией чтения, в стабильном порядке строк.
Пользователей, настроек, ключей, истории и оценок SMART в ней нет.

Вернуть каталог к файлу — после [резервной копии](#резервная-копия):

```bash
docker compose run --rm -e SEED_DATA=1 seeder
```

Это замена, а не слияние: одной транзакцией сидер удаляет узлы каталога и
загружает файл; заведённое после выгрузки исчезает. `:User`, `:ApiKey`,
`:Setting`, история, оценки SMART и учёт миграций не трогаются. Файла нет
или он пуст — каталог не трогается, в логе предупреждение. Нечитаемый файл —
сидер завершается с кодом 1, API не стартует.

## Резервная копия

| | Ночная копия — `scripts/backup.sh` | Дамп — `scripts/dump.sh` |
|---|---|---|
| Что в ней | каталог, пользователи и роли, ключи, настройки, журнал аудита | вся база, включая историю и оценки SMART, и копия `data.cypher` |
| Простой | нет | API и Neo4j ~1 минуту |
| Где | `backups/auto-<дата>/` | `backups/dump-<дата>/neo4j.dump` |
| Когда | каждую ночь | раз в неделю и вручную перед релизом, миграциями, `reset_and_load`, `SEED_DATA=1` |

Дамп вручную:

```bash
scripts/dump.sh
```

Скрипт останавливает `api` и `neo4j` (Community делает дамп только
остановленной базы), снимает дамп, проверяет его в одноразовом контейнере
(`neo4j-admin database check`, нужно место размером с базу) и запускает
сервис обратно даже при сбое. Копия годится, только если в выводе есть
«ДАМП ПРОВЕРЕН» и последняя строка — «готово: …»; «ОШИБКА» — дамп негоден,
разрушающие операции не начинать. По размеру не судите: дамп пустой базы —
около 13 КБ. Другой диск — `BACKUP_DIR=/mnt/backup/goal-checker scripts/dump.sh`;
дампы старше `DUMP_KEEP_DAYS` (60) удаляются.

Восстановление заменяет базу целиком:

```bash
docker compose stop api neo4j
docker compose run --rm --no-deps -v "$PWD/backups/dump-<дата>:/backups" neo4j \
  neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true
docker compose start neo4j api
```

Журнала аудита в дампе нет — его снимает [ночная копия](#ночная-копия).

### Регламент резервного копирования

| Копия | Расписание | Хранится | Таймер |
|---|---|---|---|
| ночная | ежедневно 02:15 | 14 дней (`BACKUP_KEEP_DAYS`) | `goal-checker-backup@<пользователь>.timer` |
| дамп с проверкой | воскресенье 03:30 | 60 дней (`DUMP_KEEP_DAYS`) | `goal-checker-dump@<пользователь>.timer` |
| дамп перед релизом и разрушающими операциями | вручную | 60 дней | — |
| проверка восстановления на стенде | раз в месяц | журнал эксплуатации | — |

Установка таймеров — [шаг 14](#шаг-14-резервные-копии-и-мониторинг).

- **Куда.** По умолчанию `backups/` — тот же диск, что и база. Задайте
  `BACKUP_DIR` в `/etc/default/goal-checker-backup`: другой диск или сетевой
  ресурс, смонтированный до таймеров, с правом записи для пользователя копий.
- **Пропуски** снимаются после включения сервера (`Persistent=true`).
- **Одновременно** копии не идут: общий замок `.lock` в каталоге копий.
- **Проверка:** `systemctl list-timers 'goal-checker-*'`, `tail backups/backup.log`,
  `journalctl -u 'goal-checker-*'`.
- **Другое время** — `sudo systemctl edit goal-checker-dump@.timer`: в
  `[Timer]` пустая `OnCalendar=` и новое значение.

Без systemd — cron пользователя с правом на docker (`crontab -e`):

```bash
PATH=/usr/local/bin:/usr/bin:/bin
15 2 * * * /opt/goal-checker/scripts/backup.sh
30 3 * * 0 /opt/goal-checker/scripts/dump.sh
```

Вывод не перенаправляйте: скрипты сами создают каталог копий и пишут
`backups/backup.log` (другое место — `BACKUP_LOG`), а перенаправление в ещё
не созданный каталог не дало бы им запуститься.

### Ночная копия

Без остановки сервиса, в `backups/auto-<дата>/`:

| Файл | Что в нём |
|---|---|
| `data.cypher` | каталог (`export_graph.py --stdout`) |
| `state.cypher` | пользователи и роли (`:User`), ключи доступа (`:ApiKey`, хэши), настройки (`:Setting`); `MERGE` по `login`, `keyId`, `key` |
| `audit.tar.gz` | журнал аудита с тома `api_audit`; код 1 GNU tar («file changed as we read it») — не ошибка |

Каталог `auto-<дата>` появляется, только когда копия снята целиком; сбой —
ненулевой код и «ОШИБКА» с номером строки в `backup.log` и stderr (cron
пришлёт письмо, если настроена почта). Копии старше `BACKUP_KEEP_DAYS` (14)
удаляются. Каталог копий закрыт (`chmod 700`: в `state.cypher` хэши ключей и
логины), `data.cypher` в нём — 0644 для сидера. Истории проверок и оценок
SMART в ночной копии нет — их хранит только дамп.

| При отказе диска | Теряется не больше | Восстанавливается из |
|---|---|---|
| каталог, пользователи, ключи, настройки | суток | `data.cypher` + `state.cypher` |
| журнал аудита | суток | `audit.tar.gz` |
| история проверок | недели (чаще — дампы чаще) | дампа |

**Восстановление** — на пустую базу, той же версией, что сняла копию:

```bash
d=backups/auto-<дата>
cp "$d/data.cypher" neo4j/init/data.cypher      # без -p: права копии не переносить
chmod 0644 neo4j/init/data.cypher               # сидер читает от uid 10001
docker compose up -d --no-build                 # сидер загрузит каталог в пустую базу
docker compose exec -T neo4j sh -c 'cypher-shell -u neo4j -p "${NEO4J_AUTH#neo4j/}"' < "$d/state.cypher"
docker compose exec -T api tar -C /data/audit -xzf - < "$d/audit.tar.gz"
docker compose restart api                      # сбросить кэши пользователей, ключей, настроек
```

**Проверка восстановления** — раз в месяц и после изменений схемы, на стенде:

1. Скопировать свежую `backups/auto-<дата>` на стенд.
2. `docker compose down && docker volume rm goal-checker_neo4j_data`
   (нужны данные стенда — сначала дамп).
3. Восстановить командами выше и сверить:

   ```bash
   BACKUP_DIR=/tmp/verify scripts/backup.sh
   diff "$d/data.cypher" /tmp/verify/auto-*/data.cypher && \
     diff "$d/state.cypher" /tmp/verify/auto-*/state.cypher && echo "КОПИЯ ВОССТАНОВЛЕНА"
   curl -s localhost:8080/ready | python3 -m json.tool
   ```

4. Проверить цель ключом внешней системы сервера (`Authorization: Bearer gc_…`):
   не 401 — ключи восстановлены. Роли сверяет `diff`: пользователей сервера
   в Keycloak стенда нет.
5. Записать результат в журнал эксплуатации.

### Полный сброс и загрузка

`neo4j/init/reset_and_load.cypher` удаляет все узлы каталога и заводит
базовый каталог заново (ПР-01, пункты 1.1 и 2.4; шаблон для остального — в
конце файла). Пользователи и роли сохраняются. После
[резервной копии](#резервная-копия):

```bash
docker compose run --rm -e SEED_FILE=/init/reset_and_load.cypher seeder
curl -s localhost:8080/ready | python3 -m json.tool
docker compose exec -T api python export_graph.py --stdout > neo4j/init/data.cypher.new \
  && mv neo4j/init/data.cypher.new neo4j/init/data.cypher
```

Сброс — одна транзакция с повышением версии каталога: API не увидит пустой
каталог и сам сбросит кэш ответов за 30 с. `data.cypher` при сбросе не
применяется. Сбросить том целиком —
`docker compose down && docker volume rm goal-checker_neo4j_data`.

### Миграции

Разовые правки в `neo4j/init/migrations/` запускает сидер через `SEED_FILE`,
одной транзакцией с повышением версии каталога. Перед ними —
[резервная копия](#резервная-копия).

```bash
docker compose run --rm -e SEED_FILE=/init/migrations/002_check_target_descriptions.cypher seeder
```

Применённая миграция отмечается узлом `(:Migration {id, appliedAt})`, и
повторный запуск пропускается («уже применена»); выполнить ещё раз —
`-e SEED_REAPPLY=1`. Миграции написаны так, что повтор данных не портит.

| Миграция | Что делает |
|---|---|
| `001_cleanup_demo_data` | удаляет демо-приказы ПР-2024-15 / ПР-2024-22 с пунктами, правилами и примерами и примеры без правила |
| `002_check_target_descriptions` | описания атрибутам `проект` и `срок_исполнения`, если их нет; шаблон для остальных внутри |
| `003_job_descriptions` | атрибут «дублирование_должностных_обязанностей» и запрет `R-3.5` на пункте 3.5 без правил |
| `004_settings_api_keys` | ограничения уникальности `:Setting` и `:ApiKey`; данных не меняет |
| `005_drop_exceptions` | удаляет связи `EXCEPT_IN`; до запуска отметьте «Не действует», где правило действовать не должно |
| `006_api_key_names` | `nameKey` у старых ключей и запрет одноимённых; дублям дописывается `#keyId` — их стоит перевыпустить |

Двойников атрибутов («срок исполнения» / «срок_исполнения») сводит кнопка
«Свести двойников» в «Замечаниях» (администратор,
`POST /catalog/merge-duplicate-targets`); группы с разным статусом или
`source` остаются — их сводят вручную.

### Как привести базу в порядок

После резервной копии: миграции `001` и `002`, `/ready` — что осталось,
«Свести двойников», описания оставшимся атрибутам, затем
[выгрузка](#данные-каталога) в `data.cypher`.

## Журнал аудита

Каждое изменение, вход, выход, отказ в правах и отвергнутый токен —
JSON-строка логгера `audit` в `/data/audit/audit.log` на томе `api_audit`
и в логе API. Файл сменяется в полночь UTC или по `AUDIT_MAX_FILE_MB`
(100 МБ); сменённые удаляются старше `AUDIT_RETENTION_DAYS` (365). Сверх
`AUDIT_MAX_TOTAL_MB` (20480) история не удаляется, но анонимные отказы в
файл не пишутся, а в лог API раз в час идёт ERROR. Журнал не зависит от
`LOG_LEVEL`; недоступен каталог — только stdout.

```bash
docker compose exec api tail -n 100 /data/audit/audit.log
docker compose logs api | grep ' audit: '      # пока жив контейнер
```

В дамп журнал не входит — его снимает [ночная копия](#ночная-копия).

```json
{"ts": "2026-10-02T09:15:40+00:00", "event": "request", "login": "i.ivanov", "role": "editor", "source": "ui",
 "ip": "10.1.2.3", "session_id": "5f0c…", "request_id": "c41a…", "object": "/catalog/nodes/4:…:12/properties",
 "result": "success", "blocked": false, "method": "PATCH", "path": "/catalog/nodes/4:…:12/properties",
 "status": 200, "ms": 31, "body": "{\"properties\": …}"}
```

### Поля строки (требование ИБ 13.1)

Поля есть в каждой строке, даже пустые (`null`).

| Требование 13.1 | Поле | Что в нём |
|---|---|---|
| Идентификатор пользователя | `login` | логин из Keycloak; внешняя система — `key:<имя ключа>`; без входа — `null` |
| Роль | `role` | `viewer`, `editor`, `admin`, у ключа — `service` |
| Источник | `source` | `ui` — интерфейс, `api` — ключ внешней системы, `system` — вне запроса |
| Адрес | `ip` | из `X-Real-IP` nginx; за TLS-прокси — при верном `TRUSTED_PROXY` |
| Время | `ts` | UTC, ISO 8601 |
| Идентификатор сессии | `session_id` | сессия Keycloak (`sid`); у ключа — `null` |
| Идентификатор запроса | `request_id` | `$request_id` nginx, он же `X-Request-ID` ответа |
| Действие | `event` | вид события; у `request` — ещё `method` и `path` |
| Объект доступа | `object` | путь; у действий администратора — `user:<логин>`, `api_key:<id>`, `settings`, `cache:<имя>`; у входа и выхода — `session` |
| Результат | `result` | `success`, `failure` (4xx/5xx) или `denied` |
| Признак блокировки | `blocked` | `true` — нет входа или прав (401, 403), предел частоты (429), отвергнут токен или ключ |

Что пишется:

- изменения каталога — с телом запроса (первые 2000 символов); у советчика
  (`/catalog/advice`) — только `attribute`, `expected`, `department_id`.
  Тела `/auth` и тексты целей не пишутся; строка запроса — до 1000 символов;
- у вошедших — каждый запрос, кроме удачного автоопроса
  (`GET /monitoring/now`, `GET /catalog/examples-check`);
- анонимные отказы (`token_rejected`, `api_key_rejected`, запрос без входа) —
  без тела, не больше 10 в минуту с адреса, остальные — одной строкой
  `anonymous_suppressed` с `counts`;
- `login_ok` — при первом запросе новой сессии Keycloak; `access_denied` с
  `reason`: `not_registered` (нет роли или заблокирован), `wrong_client:…`,
  `bad_login:…`; `login_sub_mismatch` — логин закреплён за другой учётной
  записью; `token_rejected` — с причиной или `keycloak_unavailable`.
  Неверные пароли — в журнале Keycloak;
- реестр: `user_created`, `user_changed` (`changes`, `before`),
  `user_deleted`, `user_unbound`; роль учётной записи — в `target_role`.

### Отправка в SIEM

При `AUDIT_SYSLOG_URL` каждая строка уходит ещё и в syslog RFC 5424 (MSG —
строка JSON; facility 13, severity 4 при `"blocked": true`, иначе 6):

```
<110>1 2026-10-02T09:15:40.512+00:00 ALB-PH-UCTLLM1 goal-checker - AUDIT - {"ts": …, "event": "request", …}
```

Переменные — `AUDIT_SYSLOG_*` в [таблице](#переменные-окружения). По TCP/TLS —
подсчёт октетов (RFC 6587). Отправка — отдельным потоком через очередь на
10 000 строк: недоступный SIEM запросы не задерживает; неотправленное со
второй попытки отбрасывается (в файле оно есть), в лог API раз в минуту —
ERROR с числом потерь. Другой формат (CEF) — `_SyslogSink.line` в `api/audit.py`.

## Зависимости API

`api/requirements.txt` — прямые зависимости, `api/requirements.lock` —
полный список с sha256, по которому собирается образ (`--require-hashes`).
После правки `requirements.txt` (нужны интернет и Docker):

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

Образ тот же, что у API (`ARG PYTHON_IMAGE` в `api/Dockerfile`), платформа —
сервера. Версии уже закреплённых пакетов не меняются; поднять все —
`--upgrade` у `pip-compile`. Согласованность проверяет `tests/test_lock.py`.

## Переменные окружения

Переменные API перечислены в `environment` сервиса `api` в
`docker-compose.yml` с теми же умолчаниями, что в коде (сверяет
`tests/test_deploy.py`); переменная из `.env`, которой там нет, до контейнера
не доходит.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `NEO4J_PASSWORD` | — | пароль Neo4j (обязательна); [смена](#смена-пароля-neo4j) |
| `VLLM_MODEL` | `RedHatAI/Qwen3.8-27B-INT4` | имя модели в API vLLM (задайте явно) |
| `VLLM_MODEL_DIR` | `Qwen3.8-27B-INT4` | каталог весов внутри `MODELS_DIR` (задайте явно) |
| `MODELS_DIR` | `./models` | каталог с моделями на хосте; веса кладут туда сами |
| `VLLM_IMAGE` | `vllm/vllm-openai:v0.30.0` | образ vLLM; для Blackwell — v0.28+ |
| `APP_VERSION` | `latest` | тег образов API и интерфейса; свой у каждого релиза ([откат](release.md#откат)) |
| `VLLM_URL` | `http://vllm:8000/v1` | OpenAI-совместимый API модели; внешний — с `VLLM_REPLICAS=0` |
| `VLLM_REPLICAS` | `1` | только compose: `0` — локальный vLLM не запускать |
| `VLLM_API_KEY` | `dummy` | ключ внешнего эндпоинта |
| `LLM_CA_FILE` | системные | корень ЦС модели (`/certs/…`, файл в `./certs`) |
| `VLLM_MAX_MODEL_LEN` | `16384` | окно модели в токенах |
| `VLLM_GPU_MEMORY_UTILIZATION` | `0.90` | доля памяти GPU для vLLM ([видеокарта](#видеокарта)) |
| `LLM_TIMEOUT_SECONDS` | `60` | таймаут ответа модели |
| `LLM_CONNECT_TIMEOUT_SECONDS` | `5` | таймаут соединения с моделью |
| `LLM_MAX_RETRIES` | `2` | повторы при ошибке соединения и 5xx; после таймаута ответа — нет |
| `LLM_BREAKER_TIMEOUTS` | `3` | таймаутов подряд до срабатывания предохранителя (ручные и пакетные — раздельно); `0` — выключен |
| `LLM_BREAKER_SECONDS` | `60` | на сколько срабатывает предохранитель, затем пробный запрос |
| `LLM_BREAKER_BULK_WAIT_SECONDS` | `300` | сколько пакетные цели ждут предохранителя, затем — ручная проверка; `0` — не ждать |
| `LLM_QUEUE_TIMEOUT_SECONDS` | `120` | сколько ручная проверка ждёт очереди к модели, затем `503`; `0` — без предела |
| `LLM_MAX_TOKENS` | `1024` | потолок ответа модели |
| `LLM_JSON_MODE` | `1` | ответ по JSON-схеме; `0` — свободный текст |
| `BULK_MAX_WORKERS` | `16` | потоков на пакет |
| `BULK_DEADLINE_SECONDS` | `520` | срок ответа пакета; недошедшие цели — `NEEDS_MANUAL_REVIEW`, `"unchecked": true`. Вместе с таймаутом модели — меньше 600 с (таймаут nginx) |
| `CHECK_MAX_PENDING` | пусто | предел ожидающих ручных проверок, сверх — `503`; пусто — вдвое больше предела запросов к модели |
| `BULK_MAX_REQUESTS` | `4` | одновременных `/check-goals`, сверх — `503` |
| `API_THREADS` | пусто | потоков API, не меньше 40; пусто — по пределам модели и пакетов |
| `LLM_MAX_CONCURRENCY` | `32` | одновременных запросов к модели; умолчание «Предела запросов к модели» |
| `LLM_INTERACTIVE_RESERVE` | `4` | слотов только для ручных проверок; умолчание «Резерва для ручных проверок» |
| `CHECK_CACHE_TTL_SECONDS` | `3600` | кэш ответа на ту же цель подразделения; `0` — нет; умолчание «Срока жизни кэша» |
| `CHECK_CACHE_MAX_ENTRIES` | `20000` | размер кэша ответов и оценок SMART |
| `SMART_CACHE_TTL_SECONDS` | `86400` | оценка SMART в памяти; `0` — без срока |
| `SMART_SCORE_RETENTION_DAYS` | `365` | оценки SMART в графе; `0` — хранить всегда |
| `JOB_DESCRIPTIONS_CACHE_TTL_SECONDS` | `60` | кэш должностных инструкций; `0` — без кэша; умолчание настройки интерфейса |
| `HISTORY_RETENTION_DAYS` | `365` | история проверок; `0` — не удалять; умолчание «Срока хранения истории» |
| `JOB_TEXT_MAX_CHARS` | `24000` | символов инструкций в одном запросе к модели |
| `DUTIES_MAX_TOKENS` | `4096` | потолок ответа при выписке обязанностей |
| `DUTIES_TIMEOUT_SECONDS` | `600` | таймаут фоновой выписки обязанностей |
| `DUTIES_WORKERS` | `1` | одновременных выписок, не больше 2 |
| `MAX_GOALS_PER_REQUEST` | `200` | предел пакета `/check-goals` |
| `CHECK_RATE_PER_MINUTE` | `600` | целей в минуту на пользователя или ключ, сверх — `429`; `0` — без предела; умолчание «Лимита проверок» |
| `GOAL_MAX_CHARS` | `4000` | длина цели (100–8000), длиннее — `422`; умолчание «Длины цели» |
| `PROMPT_EXAMPLES_PER_KIND` | `2` | примеров «есть»/«нет» на атрибут в промпте; умолчание «Примеров на атрибут» |
| `PROMPT_EXAMPLE_MAX_CHARS` | `300` | длина примера в промпте |
| `ADVICE_MAX_ATTEMPTS` | `3` | описаний, которые перебирает советчик |
| `ADVICE_MAX_EXAMPLES` | `40` | примеров, на которых советчик проверяет описание |
| `LOG_LEVEL` | `INFO` | уровень логов; журнал аудита пишется всегда |
| `AUDIT_LOG_DIR` | `/data/audit` | каталог журнала аудита; в compose задан жёстко |
| `AUDIT_RETENTION_DAYS` | `365` | срок хранения сменённых файлов журнала |
| `AUDIT_MAX_TOTAL_MB` | `20480` | предел объёма журнала, МБ |
| `AUDIT_MAX_FILE_MB` | `100` | размер одного файла журнала, МБ |
| `AUDIT_SYSLOG_URL` | — | SIEM: `udp://`, `tcp://` или `tls://хост[:порт]`; пусто — не отправлять |
| `AUDIT_SYSLOG_CA_FILE` | — | корень ЦС для `tls://` (`/certs/<файл>`) |
| `AUDIT_SYSLOG_HOSTNAME` | имя контейнера | имя сервера в syslog; на сервере — имя хоста |
| `AUDIT_SYSLOG_APP_NAME` | `goal-checker` | APP-NAME в syslog |
| `LOG_MAX_SIZE` | `50m` | размер файла лога контейнера |
| `LOG_MAX_FILES` | `5` | файлов лога на контейнер |
| `AUTOHEAL_REPLICAS` | `1` | только compose: `0` — без `autoheal` ([таймер](#мониторинг-и-автоперезапуск)) |
| `AUTOHEAL_INTERVAL` | `30` | период проверки `autoheal`, с |
| `AUTOHEAL_IMAGE` | `willfarrell/autoheal:1.2.0` | образ `autoheal` |
| `SEED_DATA` | `0` | `1` — заменить каталог содержимым `data.cypher` ([данные каталога](#данные-каталога)); разово через `docker compose run` |
| `SEED_REAPPLY` | `0` | `1` — повторить уже применённую миграцию |
| `SEED_DATA_FILE` | `/init/data.cypher` | файл данных сидера (в compose задан жёстко) |

Вход и публикация интерфейса ([шаг 8](#шаг-8-клиент-в-keycloak)):

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `KEYCLOAK_URL` | — | публичный адрес Keycloak, издатель токенов (обязательна); путь допустим |
| `KEYCLOAK_REALM` | — | realm клиента (обязательна) |
| `KEYCLOAK_CLIENT_ID` | — | публичный клиент интерфейса (обязательна) |
| `KEYCLOAK_INTERNAL_URL` | `KEYCLOAK_URL` | адрес Keycloak для API; `http://` — только с именем сервиса docker |
| `KEYCLOAK_CA_FILE` | системные | корень ЦС Keycloak (`/certs/…`) |
| `KEYCLOAK_TIMEOUT_SECONDS` | `5` | таймаут чтения ключей подписи |
| `NO_PROXY_EXTRA` | — | только compose: адреса через запятую к `NO_PROXY` у `api`, `seeder`, `vllm`; `.corp.local` — домен; подсети не понимаются |
| `AUTH_ADMIN_LOGINS` | — | логины, которые всегда администраторы |
| `WEB_BIND` | `0.0.0.0` | адрес порта 3000; `127.0.0.1` — TLS-прокси на этом сервере |
| `TRUSTED_PROXY` | `127.0.0.1` | адрес или подсеть TLS-прокси, чьему `X-Forwarded-For` верит nginx: по нему адрес в журнале и предел частоты |
| `API_RATE_LIMIT` | `50` | запросов к `/api/` в секунду с адреса (`limit_req`) |
| `API_RATE_BURST` | `200` | всплеск сверх `API_RATE_LIMIT`; за NAT без `TRUSTED_PROXY` поднимите оба |
| `ENABLE_DOCS` | `0` | `1` — Swagger |
