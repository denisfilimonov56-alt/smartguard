"""Схемы запросов для CRUD-эндпоинтов каталога, пакетной проверки и советчика."""

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

Status = Literal["active", "archived"]
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

    duties: list[str] = Field(..., max_length=300)


class RuleTargets(BaseModel):
    targets: list[str]


class RuleScope(BaseModel):
    """Область действия правила по подразделениям. Пустой список — правило для всех."""

    only: list[str] = Field(default_factory=list, description="departmentId: действует только в")


class ClauseReferences(BaseModel):
    references: list[str] = Field(default_factory=list, description="nodeId пунктов")


class MoveRequest(BaseModel):
    parentNodeId: str = Field(..., description="nodeId нового родителя")


class GoalItem(BaseModel):
    """Одна цель в пакетной проверке."""

    goal: str = Field(..., min_length=1, description="Формулировка цели")
    # В пакете поле обязательно: вызывающая кадровая система подразделение знает.
    # Неизвестный графу идентификатор пакет не роняет — см. agent.resolve_department.
    department_id: str = Field(..., min_length=1,
                               description="Идентификатор подразделения (Department.departmentId)")
    id: Optional[str] = Field(None, description="Идентификатор вызывающей системы; возвращается как есть")


class AdviceRequest(BaseModel):
    """Несогласие с ответом проверки по одному атрибуту одной цели."""

    goal: str = Field(..., min_length=1, max_length=4000, description="Формулировка цели")
    attribute: str = Field(..., min_length=1, max_length=200, description="Имя атрибута (CheckTarget.name)")
    expected: bool = Field(..., description="true — атрибут должен быть найден в цели, false — не должен")
    reason: str = Field(..., min_length=1, max_length=2000,
                        description="Обоснование: почему ответ должен быть таким")
    department_id: Optional[str] = Field(
        None, description="Подразделение; нужно атрибуту, определяемому по должностным инструкциям")
