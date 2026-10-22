"""Схемы запросов для CRUD-эндпоинтов каталога, пакетной проверки и советчика."""

from typing import Annotated, Any, Literal, Optional

from pydantic import AfterValidator, BaseModel, BeforeValidator, Field, StringConstraints
from pydantic_core import PydanticCustomError

import settings
from catalog import TEXT_LIMITS
from naming import has_template_mark

Status = Literal["active", "archived"]

# Предел длины цели — настройка goalMaxChars, общая для одиночной и пакетной
# проверки и советчика; интерфейс берёт её из /auth/me (limits.goalMaxChars).
# Текст цели целиком уходит в промпт модели и в ключи кэшей, поэтому без
# предела одна длинная цель переполняет окно модели и раздувает память API.
# Верхняя граница настройки отсекается ещё при разборе запроса, до чтения настроек.
GOAL_MAX_CHARS_CEILING = settings.NUMBERS["goalMaxChars"][2]


def _within_goal_limit(goal: str) -> str:
    """Длина цели не больше настройки goalMaxChars; ошибка — как у встроенного max_length."""
    limit = int(settings.number("goalMaxChars"))
    if len(goal) > limit:
        raise PydanticCustomError("string_too_long", "String should have at most {max_length} characters",
                                  {"max_length": limit})
    return goal


# Пробелы по краям срезаются до проверки длины: цель из одних пробелов — 422.
GoalText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=GOAL_MAX_CHARS_CEILING),
                     AfterValidator(_within_goal_limit)]


def _id_as_text(value: Any) -> Any:
    """Числовой идентификатор вызывающей системы принимается и возвращается строкой."""
    if isinstance(value, bool):
        return value
    return str(value) if isinstance(value, (int, float)) else value


def _blank_as_none(value: Any) -> Any:
    """Пустое подразделение (или из одних пробелов) — то же, что не указанное."""
    value = _id_as_text(value)
    return None if isinstance(value, str) and not value.strip() else value


# Подразделение вызывающей системы: число принимается строкой, пробелы по краям
# срезаются, длина ограничена — строка уходит в ключ кэша ответов и в notes.
DepartmentId = Annotated[str, BeforeValidator(_id_as_text),
                         StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
# Необязательное подразделение (/check-goal, советчик): пустая строка — None.
OptionalDepartmentId = Annotated[Optional[DepartmentId], BeforeValidator(_blank_as_none)]


def _no_template_marks(value: Any) -> Any:
    """Текст каталога без служебных меток шаблона чата (<|im_end|>, <think>...).

    Примеры, описания и инструкции идут в системное сообщение модели: метка в
    них закрыла бы его раньше времени для всех проверок. Ошибка — 422.
    """
    for text in (value if isinstance(value, list) else [value]):
        if isinstance(text, str) and has_template_mark(text):
            raise PydanticCustomError(
                "template_mark",
                "Служебные метки шаблона модели (<|...|>, <think>, <tool_call>) в тексте каталога недопустимы")
    return value


# Текст каталога, который попадает в промпт модели.
PromptText = AfterValidator(_no_template_marks)


def _limit(label: str, name: str) -> int:
    """Предел длины свойства — общий с правкой через PATCH (catalog.TEXT_LIMITS)."""
    return TEXT_LIMITS[(label, name)]


RuleType = Literal["PROHIBITION", "REQUIREMENT"]


class StatusRequest(BaseModel):
    status: Status


class PropertiesRequest(BaseModel):
    """Произвольные свойства узла. null удаляет свойство."""

    properties: dict[str, Any]
    # Оптимистичная блокировка: значения, которые видел редактор (как их отдал
    # GET /catalog/nodes/{id}; отсутствующее свойство — null). Если в базе любое
    # из них уже другое — 409, ничего не записано. Без поля — запись как раньше.
    expected: Optional[dict[str, Any]] = Field(
        None, description="{свойство: прежнее значение}; расхождение с базой — 409")


class OrderCreate(BaseModel):
    number: Annotated[str, PromptText] = Field(..., min_length=1, max_length=_limit("Order", "number"),
                                               description="Номер приказа, например ПР-01")
    title: Annotated[str, PromptText] = Field(..., min_length=1, max_length=_limit("Order", "title"))
    date: Optional[str] = Field(None, description="Дата в формате YYYY-MM-DD")
    orderId: Optional[str] = Field(None, description="Идентификатор; по умолчанию из номера")


class ClauseCreate(BaseModel):
    orderNodeId: str
    code: Annotated[str, PromptText] = Field(..., min_length=1, max_length=_limit("Clause", "code"),
                                             description="Номер пункта, например 3.1")
    text: Annotated[str, PromptText] = Field(..., min_length=1, max_length=_limit("Clause", "text"))
    clauseId: Optional[str] = None


class RuleCreate(BaseModel):
    clauseNodeId: str
    type: RuleType
    description: Annotated[str, PromptText] = Field(..., min_length=1, max_length=_limit("Rule", "description"))
    checkInstruction: Annotated[str, PromptText] = Field("", max_length=_limit("Rule", "checkInstruction"))
    targets: list[str] = Field(default_factory=list)
    studentsOnly: bool = Field(False, description="Правило действует только для целей студентов")
    only: list[str] = Field(default_factory=list,
                            description="departmentId: правило действует только в этих подразделениях; "
                                        "пустой список — во всех. Задаётся в той же транзакции, что и правило")
    ruleId: Optional[str] = None


class ExampleCreate(BaseModel):
    ruleNodeId: str
    text: Annotated[str, PromptText] = Field(..., min_length=1, max_length=_limit("ViolationExample", "text"))
    isViolation: bool
    exampleId: Optional[str] = None


class CheckTargetCreate(BaseModel):
    name: Annotated[str, PromptText] = Field(..., min_length=1, max_length=_limit("CheckTarget", "name"))
    description: Annotated[str, PromptText] = Field("", max_length=_limit("CheckTarget", "description"))
    source: Optional[Literal["job_descriptions"]] = Field(
        None,
        description="job_descriptions — атрибут определяется сравнением цели с должностными "
                    "инструкциями подразделения; по умолчанию — по тексту цели",
    )


class DepartmentCreate(BaseModel):
    departmentId: str = Field(..., min_length=1, max_length=_limit("Department", "departmentId"),
                              description="Идентификатор, который передаётся в запросе проверки")
    name: Annotated[str, PromptText] = Field(..., min_length=1, max_length=_limit("Department", "name"))


class JobDescriptionCreate(BaseModel):
    """Должностная инструкция подразделения."""

    departmentNodeId: str
    title: Annotated[str, PromptText] = Field(..., min_length=1, max_length=_limit("JobDescription", "title"),
                                              description="Должность")
    text: Annotated[str, PromptText] = Field(..., min_length=1, max_length=100_000,
                                             description="Текст инструкции; достаточно раздела с обязанностями")
    jobDescriptionId: Optional[str] = None


class JobDescriptionSnapshot(BaseModel):
    """Должность и текст инструкции, какими их видел редактор (как их отдал GET)."""

    title: str
    text: str


class JobDescriptionUpdate(BaseModel):
    title: Annotated[str, PromptText] = Field(..., min_length=1, max_length=_limit("JobDescription", "title"))
    text: Annotated[str, PromptText] = Field(..., min_length=1, max_length=100_000)
    # Оптимистичная блокировка, как expected у PATCH свойств: если в базе
    # title или text уже другие — 409, ничего не записано. Без поля — как раньше.
    expected: Optional[JobDescriptionSnapshot] = Field(
        None, description="Прежние {title, text}; расхождение с базой — 409")


class JobDuties(BaseModel):
    """Список обязанностей, проверенный редактором."""

    # Пустые строки отбрасываются до проверки предела MAX_DUTIES в catalog.set_job_duties,
    # поэтому сам список может быть длиннее с запасом.
    duties: Annotated[list[str], PromptText] = Field(..., max_length=2000)
    # Прежний список; сравнивается с базой как упорядоченный список. Расхождение — 409.
    expected: Optional[list[str]] = Field(
        None, description="Прежний список, который видел редактор; если в базе уже другой — 409")


# Прежний набор связей для оптимистичной блокировки PUT: тот же формат, что у
# основного списка. Расхождение с базой (как множества) — 409; без поля — как раньше.
EXPECTED_SET = "Прежний набор, который видел редактор; если в базе уже другой — 409"


class RuleTargets(BaseModel):
    targets: list[str]
    expected: Optional[list[str]] = Field(None, description=EXPECTED_SET)


class RuleScope(BaseModel):
    """Область действия правила по подразделениям. Пустой список — правило для всех."""

    only: list[str] = Field(default_factory=list, description="departmentId: действует только в")
    expected: Optional[list[str]] = Field(None, description=EXPECTED_SET)


class RuleAudience(BaseModel):
    """Для кого действует правило: для всех или только для студентов."""

    studentsOnly: bool = Field(..., description="true — правило проверяется только у целей студентов")


class ClauseReferences(BaseModel):
    references: list[str] = Field(default_factory=list, description="nodeId пунктов")
    expected: Optional[list[str]] = Field(None, description=EXPECTED_SET)


class MoveRequest(BaseModel):
    parentNodeId: str = Field(..., description="nodeId нового родителя")


class GoalItem(BaseModel):
    """Одна цель в пакетной проверке."""

    goal: GoalText = Field(..., description="Формулировка цели, не длиннее настройки goalMaxChars")
    # В пакете поле обязательно: вызывающая кадровая система подразделение знает.
    # Неизвестный графу идентификатор пакет не роняет — см. agent.resolve_department.
    department_id: DepartmentId = Field(
        ..., description="Идентификатор подразделения (Department.departmentId); число принимается как строка")
    # Необязателен ради совместимости с вызывающими системами, которые его ещё не
    # передают: без него применяются все правила, в том числе только для студентов.
    is_student: Optional[bool] = Field(
        None, description="Ставит ли цель студент; без поля применяются все правила")
    id: Optional[Annotated[str, BeforeValidator(_id_as_text), StringConstraints(max_length=200)]] = Field(
        None, description="Идентификатор вызывающей системы, до 200 символов; число принимается и "
                          "возвращается строкой")


class AdviceRequest(BaseModel):
    """Несогласие с ответом проверки по одному атрибуту одной цели."""

    goal: GoalText = Field(..., description="Формулировка цели")
    attribute: str = Field(..., min_length=1, max_length=200, description="Имя атрибута (CheckTarget.name)")
    expected: bool = Field(..., description="true — атрибут должен быть найден в цели, false — не должен")
    reason: str = Field(..., min_length=1, max_length=2000,
                        description="Обоснование: почему ответ должен быть таким")
    department_id: OptionalDepartmentId = Field(
        None, description="Подразделение, до 100 символов; нужно атрибуту, определяемому по должностным "
                          "инструкциям. Пустая строка — то же, что без поля")
