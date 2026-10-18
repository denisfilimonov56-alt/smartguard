# API

[← README](../README.md)

Полный список с интерактивными схемами — Swagger на http://localhost:8080/docs
(выключен по умолчанию, включается `ENABLE_DOCS=1`).

## Вход

Все маршруты, кроме `/health`, `/ready` и входа, требуют сессию либо — для
проверки целей — [ключ доступа](#ключ-доступа-для-внешних-систем). Снаружи
API доступен под `/api` интерфейса; порт 8080 слушает только сам сервер.

```bash
# Вход: cookie сессии сохраняется в файл. Пароль лучше не оставлять в истории оболочки.
curl -s -c cookies.txt https://<интерфейс>/api/auth/login \
  -H 'X-Requested-With: XMLHttpRequest' -H 'Content-Type: application/json' \
  -d '{"login": "i.ivanov", "password": "…"}'

curl -s -b cookies.txt https://<интерфейс>/api/check-goal \
  -H 'X-Requested-With: XMLHttpRequest' -H 'Content-Type: application/json' \
  -d '{"goal": "Снизить долю просроченных заявок до 5% к 31.12.2025", "department_id": "UCT"}'
```

### Ключ доступа для внешних систем

Системе, которая проверяет цели без человека (кадровая система), входить
через домен нечем. Ей администратор выдаёт ключ в разделе «Настройки»; ключ
передаётся в заголовке `Authorization` и открывает только `/check-goal`
и `/check-goals` — каталог, настройки и мониторинг по ключу недоступны (`403`).

```bash
curl -s https://<интерфейс>/api/check-goals \
  -H 'Authorization: Bearer gc_1a2b3c4d_…' -H 'Content-Type: application/json' \
  -d '[{"id": "kpi-1", "goal": "…", "department_id": "UCT"}]'
```

Заголовок `X-Requested-With` при запросе с ключом не нужен. Неверный или
отозванный ключ — `401`. В истории проверок и журнале аудита такая система
видна как `key:<название ключа>`.

### Ограничение частоты

Один пользователь или один ключ проверяет не больше заданного числа целей
в минуту (настройка «Лимит проверок», по умолчанию `CHECK_RATE_PER_MINUTE` = 600; пакет считается по числу целей, ответы из
кэша тоже). Сверх этого — `429` с заголовком `Retry-After` в секундах.
Пакет крупнее самого лимита проходит, если за последнюю минуту запросов не было.

```
POST   /auth/login                {login, password} → {login, role, displayName}, ставит cookie
POST   /auth/logout               закрывает сессию
GET    /auth/me                   кто вошёл

GET    /auth/users                реестр пользователей            (администратор)
POST   /auth/users                {login, role, displayName}      (администратор)
PATCH  /auth/users/{login}        {role, status, displayName}     (администратор)
DELETE /auth/users/{login}                                        (администратор)
```

Изменяющие запросы (`POST`, `PUT`, `PATCH`, `DELETE`) обязаны нести заголовок
`X-Requested-With: XMLHttpRequest` — без него ответ `403`. Чтение каталога
и проверка целей доступны любой роли, правка — редактору, физическое
удаление, `repair-identifiers` и `/auth/users` — администратору;
см. [роли](security.md#роли).

## Проверка целей

### Пакетная проверка

```bash
curl -s -b cookies.txt https://<интерфейс>/api/check-goals \
  -H 'X-Requested-With: XMLHttpRequest' -H 'Content-Type: application/json' \
  -d '[{"goal": "Снизить долю просроченных заявок до 5% к 31.12.2025", "department_id": "UCT", "id": "kpi-1"},
       {"goal": "Улучшить работу с заявками", "department_id": "AGD", "id": "kpi-2"}]'
```

Вход — массив объектов `{"goal": "...", "department_id": "...", "id": "..."}`.

| Поле | Обязательно | Назначение |
|---|---|---|
| `goal` | да | формулировка цели |
| `department_id` | да | `departmentId` подразделения, чья это цель; без поля или с пустой строкой запрос отклоняется с `422` |
| `id` | нет | идентификатор вызывающей системы, возвращается как передан (или `null`) |

Идентификатор, которого нет в графе, пакет не роняет: цель проверяется
по всем правилам, а причина пишется в её `notes` — см.
[разграничение по подразделениям](architecture.md#разграничение-по-подразделениям).

Ответ:

```json
{
  "results": [ { "id": "kpi-1", "goal": "...", "status": "...", "allowed": true,
                 "department": {"id": "UCT", "name": "УЦТ"},
                 "detected_attributes": [], "violations": [], "notes": [] } ],
  "summary": { "total": 2, "allowed": 1, "violations": 1, "manual_review": 0 }
}
```

Порядок ответов совпадает с порядком входа. Словари атрибутов и подразделений
читаются один раз на весь пакет, обращения к модели идут параллельно (`BULK_MAX_WORKERS`,
по умолчанию 16, в пределах общей [очереди к модели](architecture.md#нагрузка-очередь-к-модели-и-кэш)) — узкое место именно они. Сбой одной цели не роняет пакет:
она получает `NEEDS_MANUAL_REVIEW`, остальные проверяются как обычно.
Размер пакета ограничен `MAX_GOALS_PER_REQUEST` (по умолчанию 200), при
превышении — `413`.

### Прочее

```bash
curl -s localhost:8080/health          # liveness, без входа
curl -s localhost:8080/ready           # readiness + диагностика графа, без входа, только с сервера
```

`GET /check-targets` — словарь проверяемых атрибутов, `POST /check-goal` —
одна цель (пример — в разделе «Вход»).

В одиночной проверке `department_id` необязателен: без него применяются
все правила, а в `notes` появляется причина.

`/ready` отдаёт 503 и список `problems`, если Neo4j недоступен, граф пуст,
есть двойники атрибутов, атрибуты без описания, атрибуты без правил или
правила без атрибутов — то есть в любой ситуации, когда проверка целей
будет молча неполной. Разбор каждой проверки — в [диагностике](web-ui.md#диагностика).

Ответ `/check-goal`:

```json
{
  "goal": "...",
  "status": "ALLOWED | VIOLATIONS_FOUND | NEEDS_MANUAL_REVIEW",
  "allowed": false,
  "department": {"id": "UCT", "name": "УЦТ"},
  "detected_attributes": ["срок_исполнения", "измеримость"],
  "attribute_quotes": {"срок_исполнения": "до 31 декабря 2026 года", "измеримость": "на 15%"},
  "violations": [
    {
      "order_number": "ПР-01",
      "order_title": "О порядке постановки целей",
      "clause_code": "1.1",
      "clause_text": "...",
      "rule_id": "R-1.1",
      "rule_text": "...",
      "check_instruction": "Проверь, указан ли в тексте цели проект...",
      "violation_type": "MISSING_REQUIREMENT",
      "attribute": "проект",
      "example_kind": "correct",
      "examples": ["..."],
      "matched_duties": [{"job_description_id": "UCT/аналитик", "title": "Аналитик", "duty": "..."}]
    }
  ],
  "notes": []
}
```

`department` — найденное подразделение или `null`, если оно не передано,
неизвестно графу или в архиве: тогда применены все правила, причина в `notes`.

`matched_duties` есть только у нарушений по атрибуту, который определяется
сравнением с [должностными инструкциями](architecture.md#должностные-инструкции):
обязанности, с которыми совпала цель. Если сравнить цель с инструкциями
не удалось, а других нарушений нет, статус — `NEEDS_MANUAL_REVIEW`.

`notes` — не декоративное поле. Туда попадают атрибуты, которых нет
в словаре графа, обнаруженные двойники написаний и неопределённое
подразделение: это причины, по которым результат проверки может быть
неполным или строже ожидаемого.

Оба типа нарушений возвращаются с одинаковым набором полей; различать их
следует по `violation_type` и `example_kind` (`violation` — так делать нельзя,
`correct` — образец правильной формулировки).

### Режим отказа: fail-closed

Если извлечь атрибуты не удалось (модель недоступна, вернула не JSON,
словарь `CheckTarget` пуст), ответ будет `status: NEEDS_MANUAL_REVIEW`
и `allowed: false`, а причина — в `notes`. Проверка соответствия
никогда не «разрешает» цель из-за собственного сбоя.

## Мониторинг

Только администратору.

```
GET /monitoring/now                              очередь к модели, пакеты в работе, показатели за 5 минут, vLLM, кэш
GET /monitoring/stats?start=&end=&step=&timezone=&mode=&status=
                                                 средние показатели за период; step: minute | hour | day | week | month
GET /monitoring/history?start=&end=&limit=&offset=&mode=&status=
                                                 проверки за период постранично: {records, total}; limit до 100, по умолчанию 10
```

`start` и `end` — ISO 8601, конец не включается. `timezone` (например
`Europe/Moscow`) задаёт границы интервалов. В каждом интервале и в `totals`:
`total`, `avg_ms`, `avg_computed_ms` (без ответов из кэша), `p95_ms`, `max_ms`,
`avg_queue_ms`, `avg_llm_ms`, `llm_calls`, `cached`, `allowed`, `violations`,
`manual_review`.

## Настройки и ключи доступа

Только администратору.

```
GET    /settings                                 все настройки: {promptExamples, injectionGuard, …}
PUT    /settings                                 меняет переданные настройки; число вне границ — 422
GET    /settings/api-keys                        ключи: {keys: [{keyId, name, createdAt, createdBy, lastUsedAt}]}
POST   /settings/api-keys                        {name} → тот же объект и key — сам ключ, показывается один раз
DELETE /settings/api-keys/{keyId}                отозвать ключ; действует со следующего запроса
```

| Настройка | По умолчанию | Что делает |
|---|---|---|
| `promptExamples` | `false` | к атрибутам в промпте добавляются примеры из каталога — см. [архитектуру](architecture.md#примеры-в-промпте) |
| `injectionGuard` | `true` | цель с текстом, похожим на указания модели, получает `NEEDS_MANUAL_REVIEW` вместо `ALLOWED` — см. [безопасность](security.md#указания-модели-в-тексте-цели) |
| `evidenceQuotes` | `true` | модель подтверждает каждый найденный атрибут цитатой из цели (`attribute_quotes`); если цитаты в тексте цели нет, цель получает `NEEDS_MANUAL_REVIEW` вместо `ALLOWED` |
| `promptExamplesPerKind` | `2` | сколько примеров «есть» и «нет» на атрибут уходит в промпт; от 1 до 10 |
| `checkCache` | `true` | помнить ответ на ту же цель того же подразделения |
| `checkCacheTtlSeconds` | `3600` | срок жизни ответа в кэше, с; от 0 до 604800 |
| `bulkChecks` | `true` | `false` — `/check-goals` отвечает `503`, `/check-goal` работает |
| `checkRatePerMinute` | `600` | целей в минуту на пользователя или ключ; `0` — без ограничения; до 100000 |
| `historyEnabled` | `true` | проверки записываются в историю |
| `historyRetentionDays` | `365` | срок хранения истории, дней; `0` — не удалять; до 3650 |
| `apiKeysEnabled` | `true` | `false` — любой запрос с ключом доступа получает `403`, ключи при этом не отзываются |
| `maintenance` | `false` | режим обслуживания: всем, кроме администратора, проверка и каталог отвечают `503` с `Retry-After`; вход и `/auth/me` работают |

У числовых настроек значение по умолчанию берётся из одноимённой переменной
окружения (`PROMPT_EXAMPLES_PER_KIND`, `CHECK_CACHE_TTL_SECONDS`,
`CHECK_RATE_PER_MINUTE`, `HISTORY_RETENTION_DAYS`) и действует, пока настройку
не сохранили через API. Готовые ответы проверок сбрасываются только при смене
настроек, от которых зависит промпт: `promptExamples`, `promptExamplesPerKind`,
`injectionGuard`, `evidenceQuotes`.

## Эндпоинты каталога

```
GET    /catalog/tree?include_archived=false     всё дерево одним ответом
GET    /catalog/check-targets                   словарь атрибутов
GET    /catalog/clauses                         плоский список пунктов
GET    /catalog/departments?include_archived=false   подразделения и их правила
GET    /catalog/diagnostics                     развёрнутая диагностика
GET    /catalog/graph                           узлы и связи каталога для визуального графа
GET    /catalog/examples-check                  ход и результат проверки примеров на модели: {state, total, done,
                                                counts, items, stale}; в items — всё, кроме совпавших примеров
POST   /catalog/examples-check                  запустить проверку в фоне (редактор); 202 и текущий ход

POST   /catalog/advice                          советчик (редактор): как поправить граф, чтобы атрибут по цели
                                                определялся иначе; граф не меняет — см. ниже

GET    /catalog/nodes/{nodeId}                  все свойства узла
PATCH  /catalog/nodes/{nodeId}/properties       правка любых свойств (null удаляет)
POST   /catalog/nodes/{nodeId}/status           active / archived
GET    /catalog/nodes/{nodeId}/descendants      что уйдёт при удалении
DELETE /catalog/nodes/{nodeId}                  физическое удаление

POST   /catalog/orders                          POST /catalog/clauses
POST   /catalog/rules                           POST /catalog/examples
POST   /catalog/check-targets                   POST /catalog/departments
POST   /catalog/job-descriptions                {departmentNodeId, title, text} — должностная инструкция;
                                                модель сразу выписывает обязанности (duties, dutiesError)
PUT    /catalog/job-descriptions/{nodeId}       {title, text}; новый текст — обязанности выписываются заново
POST   /catalog/job-descriptions/{nodeId}/extract-duties   выписать обязанности ещё раз
PUT    /catalog/job-descriptions/{nodeId}/duties           {duties: [...]} — список, проверенный редактором

PUT    /catalog/rules/{nodeId}/targets          привязка правила к атрибутам
PUT    /catalog/rules/{nodeId}/departments      область действия: в каких подразделениях правило действует
PUT    /catalog/clauses/{nodeId}/references     перекрёстные ссылки
POST   /catalog/clauses/{nodeId}/move           перенос в другой приказ
POST   /catalog/rules/{nodeId}/move             перенос в другой пункт
POST   /catalog/repair-identifiers              проставить недостающие ключи

DELETE /catalog/nodes/{nodeId}?force=true       удалить без архивирования
```

Тело `PUT /catalog/rules/{nodeId}/departments` заменяет область действия целиком:

```json
{"only": ["UCT", "AGD"]}
```

Пустой список — правило действует для всех.

### Советчик по графу

`POST /catalog/advice` — редактор не согласен с ответом проверки по одному
атрибуту одной цели:

```json
{
  "goal": "Сдать отчёт во втором квартале",
  "attribute": "срок_исполнения",
  "expected": true,
  "reason": "квартал — проверяемый срок",
  "department_id": "UCT"
}
```

`expected` — каким ответ должен быть: `true` — атрибут найден. `department_id`
нужен только атрибуту, определяемому по должностным инструкциям. Ответ:

```json
{
  "attribute": "срок_исполнения", "nodeId": "4:…:7", "source": null, "expected": true,
  "current": {"present": false, "evidence": null},
  "already": false,
  "diagnosis": "в описании перечислены только даты…",
  "description": {"old": "…", "new": "…", "verified": true, "attempts": 1},
  "regression": {"checked": 6, "broken": [], "alreadyWrong": 1, "failed": 0},
  "examples": [{"ruleNodeId": "4:…:12", "ruleId": "R-2.4", "ruleType": "REQUIREMENT",
                "ruleText": "…", "isViolation": false}],
  "examplesInPrompt": false,
  "notes": []
}
```

| Поле | Что означает |
|---|---|
| `current` | что модель отвечает сейчас (мимо кэша); `evidence` — цитата цели или обязанность из инструкции |
| `already` | модель уже отвечает как нужно — предложений нет |
| `description` | новое описание атрибута; `verified` — с ним модель ответила на цель как нужно, `attempts` — сколько описаний перебрано |
| `regression` | примеры каталога с новым описанием: `broken` — перестали распознаваться верно, `alreadyWrong` — модель ошибалась и раньше; `null` — не проверялись |
| `examples` | правила, которым цель можно добавить примером, и с какой пометкой |

Предложение применяется обычными запросами: `PATCH /catalog/nodes/{nodeId}/properties`
с `{"properties": {"description": "…"}}` и `POST /catalog/examples`. `404` —
атрибута нет, `409` — атрибуту по должностным инструкциям не хватает подразделения
или инструкций, `503` — модель не ответила.

`401` — нет сессии или она истекла, `403` — не хватает роли либо нет
заголовка `X-Requested-With`, `429` — слишком много неудачных входов,
`404` — узла нет, `409` — операция противоречит состоянию графа
(двойник по написанию, удаление неархивированного узла, используемый атрибут
или подразделение, занятый бизнес-ключ),
`422` — не прошла валидация схемы.
