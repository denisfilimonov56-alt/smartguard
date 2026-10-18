"""Схемы запросов для CRUD-эндпоинтов каталога, пакетной проверки и советчика."""

from typing import Annotated, Any, Literal, Optional

from pydantic import AfterValidator, BaseModel, BeforeValidator, Field, StringConstraints
from pydantic_core import PydanticCustomError

import settings

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
RuleType = Literal["PROHIBITION", "REQUIREMENT"]


class StatusRequest(BaseModel):
    status: Status


class PropertiesRequest(BaseModel):
    """Произвольные свойства узла. null удаляет свойство."""

    properties: dict[str, Any]


class OrderCreate(BaseModel):
    number: str = Field(..., min_length=1, max_length=100, description="Номер приказа, например ПР-01")
    title: str = Field(..., min_length=1, max_length=500)
    date: Optional[str] = Field(None, description="Дата в формате YYYY-MM-DD")
    orderId: Optional[str] = Field(None, description="Идентификатор; по умолчанию из номера")


class ClauseCreate(BaseModel):
    orderNodeId: str
    code: str = Field(..., min_length=1, max_length=50, description="Номер пункта, например 3.1")
    text: str = Field(..., min_length=1, max_length=8000)
    clauseId: Optional[str] = None


class RuleCreate(BaseModel):
    clauseNodeId: str
    type: RuleType
    description: str = Field(..., min_length=1, max_length=4000)
    checkInstruction: str = Field("", max_length=4000)
    targets: list[str] = Field(default_factory=list)
    studentsOnly: bool = Field(False, description="Правило действует только для целей студентов")
    only: list[str] = Field(default_factory=list,
                            description="departmentId: правило действует только в этих подразделениях; "
                                        "пустой список — во всех. Задаётся в той же транзакции, что и правило")
    ruleId: Optional[str] = None


class ExampleCreate(BaseModel):
    ruleNodeId: str
    text: str = Field(..., min_length=1, max_length=4000)
    isViolation: bool
    exampleId: Optional[str] = None


class CheckTargetCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field("", max_length=4000)
    source: Optional[Literal["job_descriptions"]] = Field(
        None,
        description="job_descriptions — атрибут определяется сравнением цели с должностными "
                    "инструкциями подразделения; по умолчанию — по тексту цели",
    )


class DepartmentCreate(BaseModel):
    departmentId: str = Field(..., min_length=1, max_length=100,
                              description="Идентификатор, который передаётся в запросе проверки")
    name: str = Field(..., min_length=1, max_length=500)


class JobDescriptionCreate(BaseModel):
    """Должностная инструкция подразделения."""

    departmentNodeId: str
    title: str = Field(..., min_length=1, max_length=500, description="Должность")
    text: str = Field(..., min_length=1, max_length=100_000,
                      description="Текст инструкции; достаточно раздела с обязанностями")
    jobDescriptionId: Optional[str] = None


class JobDescriptionUpdate(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)
    text: str = Field(..., min_length=1, max_length=100_000)


class JobDuties(BaseModel):
    """Список обязанностей, проверенный редактором."""

    # Пустые строки отбрасываются до проверки предела MAX_DUTIES в catalog.set_job_duties,
    # поэтому сам список может быть длиннее с запасом.
    duties: list[str] = Field(..., max_length=2000)


class RuleTargets(BaseModel):
    targets: list[str]


class RuleScope(BaseModel):
    """Область действия правила по подразделениям. Пустой список — правило для всех."""

    only: list[str] = Field(default_factory=list, description="departmentId: действует только в")


class RuleAudience(BaseModel):
    """Для кого действует правило: для всех или только для студентов."""

    studentsOnly: bool = Field(..., description="true — правило проверяется только у целей студентов")


class ClauseReferences(BaseModel):
    references: list[str] = Field(default_factory=list, description="nodeId пунктов")


class MoveRequest(BaseModel):
    parentNodeId: str = Field(..., description="nodeId нового родителя")


class GoalItem(BaseModel):
    """Одна цель в пакетной проверке."""

    goal: GoalText = Field(..., description="Формулировка цели, не длиннее настройки goalMaxChars")
    # В пакете поле обязательно: вызывающая кадровая система подразделение знает.
    # Неизвестный графу идентификатор пакет не роняет — см. agent.resolve_department.
    department_id: Annotated[str, BeforeValidator(_id_as_text),
                             StringConstraints(strip_whitespace=True, min_length=1, max_length=100)] = Field(
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
    department_id: Optional[str] = Field(
        None, description="Подразделение; нужно атрибуту, определяемому по должностным инструкциям")
