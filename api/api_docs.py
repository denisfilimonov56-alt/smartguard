"""Swagger (OpenAPI): описание API, схема входа и формы ответов проверки целей.

У маршрутов нет response_model: он отфильтровал бы поля ответа, которых нет
в модели, а ответы проверки дополняются (unchecked, retryable, matched_duties).
Поэтому модели ниже только описывают ответ в Swagger через responses= и на сам
ответ не влияют. Меняете ответ проверки — поправьте и здесь, и web/src/api/types.ts.
"""

from typing import Any, Literal, Optional, Union

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from pydantic import BaseModel, Field

# Маршруты, открытые без входа (как PUBLIC в tests/test_auth.py); /metrics в схему не входит.
PUBLIC_PATHS = {"/health", "/ready", "/auth/config"}
SECURITY_SCHEME = "bearer"

DESCRIPTION = """
API проверки целей сотрудников на соответствие приказам и каталога правил.

**Вход.** Все маршруты, кроме `/health`, `/ready` и `/auth/config`, требуют заголовок
`Authorization: Bearer <токен>`: access-токен Keycloak либо — только для `/check-goal`,
`/check-goals` и `/suggest-goal` — ключ доступа внешней системы (`gc_…`), который выдаёт
администратор в разделе «Настройки». Кнопка **Authorize** принимает и то и другое.

**Изменяющие запросы** без заголовка `Authorization` должны нести
`X-Requested-With: XMLHttpRequest`, иначе `403`.

**Роли.** Чтение каталога и проверка целей — любой роли, правка каталога — редактору,
физическое удаление, обслуживание каталога, пользователи, настройки и мониторинг — администратору.

**Лимит.** Пользователь или ключ проверяет не больше заданного числа целей в минуту;
сверх — `429` с `Retry-After`. В каждом ответе есть `X-Request-ID` — по нему запрос
находится в журнале аудита.
"""

TAGS = [
    {"name": "check", "description": "Проверка целей: одна цель, пакет, рекомендованная формулировка. "
                                     "`/check-goal`, `/check-goals` и `/suggest-goal` доступны и по ключу "
                                     "внешней системы."},
    {"name": "catalog", "description": "Каталог: приказы, пункты, правила, атрибуты, примеры, подразделения, "
                                       "должностные инструкции, диагностика и советчик. Правка — редактору."},
    {"name": "auth", "description": "Вход, текущий пользователь и реестр пользователей (администратор)."},
    {"name": "settings", "description": "Переключатели проверки, кэши и ключи доступа внешних систем "
                                        "(администратор)."},
    {"name": "monitoring", "description": "Очередь к модели, нагрузка и история проверок (администратор)."},
    {"name": "service", "description": "Liveness и readiness для оркестратора; без входа."},
]


# ------------------------------ формы ответов ------------------------------

CheckStatus = Literal["ALLOWED", "VIOLATIONS_FOUND", "NEEDS_MANUAL_REVIEW"]


class Error(BaseModel):
    detail: str = Field(..., description="Причина отказа для человека")


class Department(BaseModel):
    id: str = Field(..., description="Department.departmentId")
    name: str


class SmartCriterion(BaseModel):
    score: int = Field(..., ge=0, le=100)
    comment: str = Field(..., description="Пояснение одним предложением")


class SmartScore(BaseModel):
    """Оценка по SMART: справка автору цели, на status не влияет."""

    specific: SmartCriterion
    measurable: SmartCriterion
    achievable: SmartCriterion
    relevant: SmartCriterion
    time_bound: SmartCriterion


class MatchedDuty(BaseModel):
    job_description_id: Optional[str] = None
    title: Optional[str] = Field(None, description="Должность")
    duty: Optional[str] = Field(None, description="Обязанность дословно из текста инструкции")


class Violation(BaseModel):
    """Нарушенное правило. Тип различают по violation_type и example_kind."""

    order_number: Optional[str] = None
    order_title: Optional[str] = None
    clause_code: Optional[str] = None
    clause_text: Optional[str] = None
    rule_id: Optional[str] = None
    rule_node_id: Optional[str] = Field(None, description="nodeId правила: /catalog/nodes/{nodeId}")
    rule_text: Optional[str] = None
    check_instruction: Optional[str] = None
    violation_type: Literal["PROHIBITION", "MISSING_REQUIREMENT"]
    attribute: Optional[str] = Field(None, description="CheckTarget.name, на котором сработало правило")
    example_kind: Literal["violation", "correct"] = Field(
        ..., description="violation — так делать нельзя, correct — образец правильной формулировки")
    examples: list[str] = Field(default_factory=list)
    matched_duties: Optional[list[MatchedDuty]] = Field(
        None, description="Только у атрибутов, определяемых по должностным инструкциям")


class CheckResult(BaseModel):
    goal: str = Field(..., description="Цель как передана, без пробелов по краям")
    status: CheckStatus
    allowed: bool = Field(..., description="true только при status ALLOWED")
    department: Optional[Department] = Field(
        None, description="null — подразделение не передано, неизвестно или в архиве; причина в notes")
    is_student: Optional[bool] = Field(None, description="Признак из запроса как есть")
    detected_attributes: list[str]
    attribute_quotes: dict[str, str] = Field(default_factory=dict, description="{атрибут: цитата из цели}")
    smart: Optional[SmartScore] = Field(None, description="null — оценка выключена или не получена")
    violations: list[Violation]
    unverified_rule_node_ids: list[str] = Field(
        default_factory=list, description="Правила, которые проверить не удалось: не нарушены и не выполнены")
    notes: list[str] = Field(..., description="Причины, по которым результат может быть неполным или строже")
    unchecked: Optional[bool] = Field(
        None, description="Только в пакете: цель не проверена (срок или обрыв), отправьте её снова")
    retryable: Optional[bool] = Field(None, description="Временный сбой: цель не разбирали, можно повторить")


class BatchItemResult(CheckResult):
    id: Optional[str] = Field(None, description="Идентификатор вызывающей системы, как передан")


class BatchSummary(BaseModel):
    total: int
    allowed: int
    violations: int
    manual_review: int


class BatchResult(BaseModel):
    results: list[BatchItemResult] = Field(..., description="В порядке входа")
    summary: BatchSummary


class SuggestResult(BaseModel):
    goal: str = Field(..., description="Рекомендованная формулировка цели")


class CheckTarget(BaseModel):
    name: str
    description: Optional[str] = None
    source: Optional[str] = Field(None, description="job_descriptions — по должностным инструкциям")


class CheckTargets(BaseModel):
    targets: list[CheckTarget]


class Health(BaseModel):
    status: Literal["ok"]


class Ready(BaseModel):
    status: Literal["ready", "not_ready"]
    neo4j: bool
    llm: Optional[bool] = Field(None, description="Готова ли модель")
    check_targets: int = Field(..., description="Атрибутов в словаре")
    problems: list[str]
    diagnostics: dict[str, Any] = Field(..., description="Полный отчёт диагностики графа")
    clock_skew_seconds: Optional[float] = Field(
        None, description="Расхождение часов API и Keycloak за последний час, > 0 — API отстаёт")


# ------------------------------ ответы с ошибкой ----------------------------

Responses = dict[Union[int, str], dict[str, Any]]


def _error(description: str, retry_after: bool = False) -> dict[str, Any]:
    response: dict[str, Any] = {"model": Error, "description": description}
    if retry_after:
        response["headers"] = {"Retry-After": {"description": "Через сколько секунд повторить",
                                               "schema": {"type": "integer"}}}
    return response


RATE_LIMITED: Responses = {429: _error("Превышен лимит проверок в минуту", retry_after=True)}
CHECK_RESPONSES: Responses = {
    200: {"model": CheckResult, "description": "Результат проверки"},
    **RATE_LIMITED,
    503: _error("Слишком много проверок или модель не дождалась очереди", retry_after=True),
}
BATCH_RESPONSES: Responses = {
    200: {"model": BatchResult, "description": "Результаты в порядке входа и сводка"},
    413: _error("Целей больше MAX_GOALS_PER_REQUEST"),
    **RATE_LIMITED,
    503: _error("Пакетная проверка отключена или уже идёт BULK_MAX_REQUESTS пакетов", retry_after=True),
}
SUGGEST_RESPONSES: Responses = {
    200: {"model": SuggestResult, "description": "Рекомендованная формулировка"},
    502: _error("Модель не предложила формулировку"),
    503: _error("Слишком много проверок", retry_after=True),
}
PROGRESS_RESPONSES: Responses = {404: _error("Проверки с таким номером нет или она чужая")}
TARGETS_RESPONSES: Responses = {200: {"model": CheckTargets, "description": "Словарь атрибутов"}}
HEALTH_RESPONSES: Responses = {200: {"model": Health, "description": "Процесс жив"}}
READY_RESPONSES: Responses = {
    200: {"model": Ready, "description": "Готов к проверкам"},
    503: {"model": Ready, "description": "Не готов: Neo4j, модель или ошибки диагностики графа"},
}
SECURED_RESPONSES = {
    "401": {"description": "Нет токена, токен недействителен или ключ отозван"},
    "403": {"description": "Недостаточно прав, ключ на этом маршруте или нет X-Requested-With"},
}


def install(app: FastAPI) -> None:
    """Схема входа Bearer для кнопки Authorize и ответы 401/403 у закрытых маршрутов."""

    def openapi() -> dict[str, Any]:
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(title=app.title, version=app.version, description=app.description,
                             routes=app.routes, tags=app.openapi_tags)
        schema.setdefault("components", {})["securitySchemes"] = {SECURITY_SCHEME: {
            "type": "http", "scheme": "bearer",
            "description": "Access-токен Keycloak или ключ доступа внешней системы (gc_…)",
        }}
        schema["security"] = [{SECURITY_SCHEME: []}]
        for path, operations in schema["paths"].items():
            for operation in operations.values():
                if path in PUBLIC_PATHS:
                    operation["security"] = []
                    continue
                for code, response in SECURED_RESPONSES.items():
                    operation["responses"].setdefault(code, response)
        app.openapi_schema = schema
        return schema

    app.openapi = openapi  # type: ignore[method-assign]
