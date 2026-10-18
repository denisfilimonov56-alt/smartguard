"""Общее для всех тестов: показатели и кэш ответов не переходят из теста в тест."""

import pytest

import apikeys
import auth
import metrics
import settings


@pytest.fixture(autouse=True)
def clean_metrics():
    metrics.reset()
    yield
    metrics.reset()


@pytest.fixture(autouse=True)
def default_settings(monkeypatch):
    """Настройки по умолчанию без обращения к Neo4j; счётчики и память о ключах — с нуля."""
    monkeypatch.setattr(settings, "_read", lambda: {})
    auth.check_rate.reset()
    apikeys.forget()
