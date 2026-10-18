"""HTTP-маршруты раздела «Настройки»: переключатели проверки и ключи внешних систем.

Только для администратора: настройки меняют вердикты всех проверок, а ключ
даёт доступ к проверке без входа через домен.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

import apikeys
import audit
import auth
import metrics
import settings
from graph import delete_smart_scores

log = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"], dependencies=[Depends(auth.admin)])


def _number(key: str, description: str):
    _, low, high = settings.NUMBERS[key]
    return Field(None, ge=low, le=high, strict=True, description=description)


class SettingsPatch(BaseModel):
    promptExamples: Optional[bool] = Field(None, description="Примеры каталога в промпте извлечения")
    injectionGuard: Optional[bool] = Field(
        None, description="Цель с указаниями для модели автоматически не разрешается")
    evidenceQuotes: Optional[bool] = Field(
        None, description="Модель подтверждает каждый найденный атрибут цитатой из цели")
    smartCheck: Optional[bool] = Field(None, description="Оценка цели по SMART; на статус проверки не влияет")
    smartCheckBulk: Optional[bool] = Field(
        None, description="Оценка SMART в пакетной проверке; false — в пакетах /check-goals не считается")
    promptExamplesPerKind: Optional[int] = _number(
        "promptExamplesPerKind", "Примеров «есть» и «нет» на атрибут в промпте")
    checkCache: Optional[bool] = Field(None, description="Помнить ответ на ту же цель")
    checkCacheTtlSeconds: Optional[int] = _number("checkCacheTtlSeconds", "Срок жизни ответа в кэше, с")
    jobDescriptionsCacheTtlSeconds: Optional[int] = _number(
        "jobDescriptionsCacheTtlSeconds",
        "Сколько секунд помнить должностные инструкции подразделения между проверками; 0 — не помнить")
    bulkChecks: Optional[bool] = Field(None, description="Пакетная проверка разрешена")
    checkRatePerMinute: Optional[int] = _number(
        "checkRatePerMinute", "Целей в минуту на пользователя или ключ; 0 — без ограничения")
    goalMaxChars: Optional[int] = _number(
        "goalMaxChars", "Предел длины цели в символах для проверки, пакета и советчика")
    historyEnabled: Optional[bool] = Field(None, description="Проверки записываются в историю")
    historyRetentionDays: Optional[int] = _number(
        "historyRetentionDays", "Срок хранения истории, дней; 0 — не удалять")
    apiKeysEnabled: Optional[bool] = Field(None, description="Проверка по ключам доступа разрешена")
    maintenance: Optional[bool] = Field(
        None, description="Режим обслуживания: сервис открыт только администратору")
    llmMaxConcurrency: Optional[int] = _number(
        "llmMaxConcurrency", "Одновременных запросов к модели на весь сервис; действует сразу")
    llmInteractiveReserve: Optional[int] = _number(
        "llmInteractiveReserve", "Слотов из них, недоступных пакетной проверке; не больше предела минус один")


class CacheClear(BaseModel):
    departmentId: Optional[str] = Field(
        None, min_length=1, max_length=200,
        description="Очистить только записи этого подразделения (кэши results и jobDescriptions)")


class ApiKeyCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=apikeys.NAME_MAX,
                      description="Какая система будет ходить с этим ключом")


def _handle(func, *args, **kwargs):
    try:
        return func(*args, **kwargs)
    except apikeys.NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except apikeys.Conflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("")
def get_settings():
    return settings.read_all()


@router.put("")
def put_settings(body: SettingsPatch, request: Request, me: auth.Principal = Depends(auth.admin)):
    """Меняет переданные настройки; если от них зависит промпт, готовые ответы проверок сбрасываются."""
    changes = body.model_dump(exclude_none=True)
    result = settings.update(changes, me.login)
    audit.event("settings_changed", login=me.login, ip=audit.client_ip(request), changes=changes)
    return result


@router.get("/caches")
def get_caches():
    """Состояние кэшей проверки: сколько записей в каждом, срок жизни, попадания и промахи."""
    return {"caches": metrics.caches_snapshot()}


@router.post("/caches/{name}/clear")
def clear_cache(name: str, request: Request, body: Optional[CacheClear] = None,
                me: auth.Principal = Depends(auth.admin)):
    """Очищает один кэш: целиком или, для ответов и должностных инструкций, по одному подразделению.

    Для оценок SMART вместе с памятью удаляются и оценки, сохранённые в графе:
    следующая проверка каждой формулировки спросит модель заново.
    """
    department_id = body.departmentId.strip() if body and body.departmentId else None
    if name not in metrics.CACHES:
        raise HTTPException(status_code=404, detail=f"Кэша '{name}' нет: "
                            + ", ".join(metrics.CACHES))
    if department_id and name not in metrics.SCOPED_CACHES:
        raise HTTPException(status_code=422, detail=f"Кэш '{name}' не делится по подразделениям")
    entries = metrics.clear_cache(name, department_id)
    stored = None
    if name == "smart":
        try:
            stored = delete_smart_scores()
        except Exception as exc:  # noqa: BLE001 — граф для оценок не обязателен
            log.warning("Сохранённые оценки SMART не удалены: %s", exc)
            raise HTTPException(status_code=503, detail="Память очищена, но оценки в графе не удалены: "
                                "граф недоступен. Повторите позже") from exc
    audit.event("cache_cleared", login=me.login, ip=audit.client_ip(request), cache=name,
                department_id=department_id, entries=entries, stored=stored)
    return {"cache": name, "entries": entries, "stored": stored, "departmentId": department_id}


@router.get("/api-keys")
def get_api_keys():
    return {"keys": _handle(apikeys.list_keys)}


@router.post("/api-keys", status_code=201)
def post_api_key(body: ApiKeyCreate, request: Request, me: auth.Principal = Depends(auth.admin)):
    """Новый ключ. Сам ключ (поле key) есть только в этом ответе."""
    created = _handle(apikeys.create, body.name, me.login)
    audit.event("api_key_created", login=me.login, ip=audit.client_ip(request),
                key_id=created["keyId"], key_name=created["name"])
    return created


@router.delete("/api-keys/{key_id}")
def delete_api_key(key_id: str, request: Request, me: auth.Principal = Depends(auth.admin)):
    """Отзывает ключ: действует со следующего запроса."""
    deleted = _handle(apikeys.delete, key_id)
    audit.event("api_key_revoked", login=me.login, ip=audit.client_ip(request),
                key_id=deleted["keyId"], key_name=deleted["name"])
    return {"deleted": deleted["keyId"]}
