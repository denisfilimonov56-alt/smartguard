"""Сверка docker-compose.yml с кодом: каждая переменная окружения, которую
читает API (или сидер), передаётся в контейнер с тем же значением по умолчанию.

Переменная из .env, не перечисленная в environment сервиса, до контейнера
не доходит: документированная настройка молча не действует. Имена и значения
по умолчанию берутся из кода разбором AST — os.getenv("ИМЯ", "умолчание") и
обёртки вида _env_int("ИМЯ", 20_000) — и из таблицы settings.NUMBERS.
"""

import ast
import re
from pathlib import Path

import pytest
import yaml

import settings

API_DIR = Path(__file__).resolve().parents[1]
COMPOSE = API_DIR.parent / "docker-compose.yml"

# Обёртки над os.getenv: имя — первый аргумент, умолчание — второй.
WRAPPERS = {"getenv", "_env_int", "_number", "_flag", "_env_float", "_env_flag"}
# Модули, которые запускаются не в сервисе api, а отдельно.
SEEDER_MODULES = {"seed.py"}
TOOL_MODULES = {"export_graph.py", "verify_cypher.py"}
# Переменные сидера, которые в compose задавать незачем (только для отладки).
SEEDER_OPTIONAL = {"SEED_CONNECT_RETRIES", "SEED_CONNECT_DELAY"}
NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]+$")
DEFAULT_RE = re.compile(r"^\$\{([A-Z0-9_]+)(?::?-(.*))?\}$")


def _literal(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float, bool)):
        return node.value
    return None


def _normalize(value) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def env_reads(modules) -> dict[str, set[str]]:
    """{ИМЯ: {умолчания}} из os.getenv и обёрток в перечисленных модулях."""
    found: dict[str, set[str]] = {}
    for path in modules:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not node.args:
                continue
            func = node.func
            fname = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
            if fname not in WRAPPERS:
                continue
            name = _literal(node.args[0])
            if not isinstance(name, str) or not NAME_RE.match(name):
                continue
            default = _literal(node.args[1]) if len(node.args) > 1 else None
            found.setdefault(name, set())
            if default is not None and default != "":
                found[name].add(_normalize(default))
    return found


def compose_environment(service: str) -> dict[str, str]:
    data = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    env = data["services"][service]["environment"]
    return {k: "" if v is None else str(v) for k, v in env.items()}


def _api_modules():
    skip = SEEDER_MODULES | TOOL_MODULES
    return [p for p in sorted(API_DIR.glob("*.py")) if p.name not in skip]


def _check(service: str, reads: dict[str, set[str]], optional=frozenset()):
    env = compose_environment(service)
    missing = sorted(set(reads) - set(env) - set(optional))
    assert not missing, f"сервис {service}: переменные из кода не переданы в docker-compose.yml: {missing}"
    for name, defaults in reads.items():
        if name not in env or not defaults:
            continue
        match = DEFAULT_RE.match(env[name])
        if not match or match.group(2) is None:
            # Значение задано явно (NEO4J_URI, AUDIT_LOG_DIR) или обязательно
            # без умолчания (NEO4J_PASSWORD) — сравнивать не с чем.
            continue
        compose_default = match.group(2).strip('"')
        assert compose_default in defaults, (
            f"сервис {service}: {name} по умолчанию в compose {compose_default!r}, в коде {sorted(defaults)}")


def test_api_environment_matches_code():
    reads = env_reads(_api_modules())
    for _key, (env_name, _low, _high) in settings.NUMBERS.items():
        reads.setdefault(env_name, set()).add(_normalize(settings.DEFAULTS[_key]))
    _check("api", reads)


def test_seeder_environment_matches_code():
    _check("seeder", env_reads([API_DIR / name for name in SEEDER_MODULES]), SEEDER_OPTIONAL)


@pytest.mark.parametrize("service", ["neo4j", "seeder", "vllm", "api", "web", "keycloak", "model"])
def test_logs_are_rotated(service):
    data = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    logging_cfg = data["services"][service].get("logging") or {}
    assert logging_cfg.get("driver") == "json-file" and "max-size" in logging_cfg.get("options", {}), (
        f"у сервиса {service} нет ротации логов")


class _UniqueKeyLoader(yaml.SafeLoader):
    """yaml.safe_load молча берёт последний из повторных ключей, а docker compose падает."""


def _no_duplicate_keys(loader, node, deep=False):
    seen = set()
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=deep)
        assert key not in seen, f"повторный ключ {key!r} в строке {key_node.start_mark.line + 1}"
        seen.add(key)
    return loader.construct_mapping(node, deep)


_UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _no_duplicate_keys)


@pytest.mark.parametrize("name", ["docker-compose.yml", "docker-compose.online.yml"])
def test_compose_has_no_duplicate_keys(name):
    path = COMPOSE.parent / name
    yaml.load(path.read_text(encoding="utf-8"), Loader=_UniqueKeyLoader)
