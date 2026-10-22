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


@pytest.mark.parametrize("service", ["neo4j", "seeder", "vllm", "api", "web", "keycloak", "model", "autoheal"])
def test_logs_are_rotated(service):
    data = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    logging_cfg = data["services"][service].get("logging") or {}
    assert logging_cfg.get("driver") == "json-file" and "max-size" in logging_cfg.get("options", {}), (
        f"у сервиса {service} нет ротации логов")


def test_project_name_is_fixed():
    """Имя проекта задано явно: тома goal-checker_* не зависят от каталога клона."""
    data = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    assert data.get("name") == "goal-checker"


# Сервисы стека, которые сами ходят к другим сервисам: без NO_PROXY прокси из
# ~/.docker/config.json перехватил бы запросы к vllm, keycloak и 127.0.0.1.
STACK_HOSTS = {"vllm", "keycloak", "neo4j", "api", "web", "localhost", "127.0.0.1"}


@pytest.mark.parametrize("service", ["api", "seeder", "vllm"])
def test_internal_traffic_bypasses_proxy(service):
    env = compose_environment(service)
    for name in ("NO_PROXY", "no_proxy"):
        assert name in env, f"у сервиса {service} нет {name}"
        hosts = {h.strip() for h in env[name].split(",")}
        assert STACK_HOSTS <= hosts, f"сервис {service}: в {name} нет {sorted(STACK_HOSTS - hosts)}"


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


# ------------------------------ nginx интерфейса ------------------------------

WEB_DIR = API_DIR.parent / "web"


def test_api_rate_limit_is_configurable():
    """Предел limit_req берётся из API_RATE_LIMIT / API_RATE_BURST: переданы в compose
    с теми же умолчаниями, что в envsh образа, и подставляются в шаблон."""
    import subprocess

    env = compose_environment("web")
    assert env["API_RATE_LIMIT"] == "${API_RATE_LIMIT:-50}" and env["API_RATE_BURST"] == "${API_RATE_BURST:-200}"
    template = (WEB_DIR / "nginx.conf.template").read_text(encoding="utf-8")
    assert "rate=${API_RATE_LIMIT}r/s" in template and "burst=${API_RATE_BURST} " in template
    assert "15-api-rate.envsh" in (WEB_DIR / "Dockerfile").read_text(encoding="utf-8")
    script = WEB_DIR / "docker-entrypoint.d" / "15-api-rate.envsh"

    def run(**values):
        out = subprocess.run(["sh", "-c", f'. "{script}"; echo "$API_RATE_LIMIT $API_RATE_BURST"'],
                             env={"PATH": "/usr/bin:/bin", **values}, capture_output=True, text=True, check=True)
        return out.stdout.strip()

    assert run() == "50 200"
    assert run(API_RATE_LIMIT="80", API_RATE_BURST="400") == "80 400"
    # Опечатка не валит nginx: берётся умолчание.
    assert run(API_RATE_LIMIT="50r/s", API_RATE_BURST="0") == "50 200"


def test_bulk_deadline_fits_proxy_read_timeout():
    """Срок пакета по умолчанию считает код, compose его не перекрывает; таймаут nginx — тот же, что в коде."""
    import main

    assert compose_environment("api")["BULK_DEADLINE_SECONDS"] == "${BULK_DEADLINE_SECONDS:-}"
    template = (WEB_DIR / "nginx.conf.template").read_text(encoding="utf-8")
    assert f"proxy_read_timeout {main.PROXY_READ_TIMEOUT_SECONDS}s;" in template


# --------------------------- ночная копия и релиз ---------------------------

import os
import shutil
import stat
import subprocess

ROOT = API_DIR.parent
BACKUP_SH = ROOT / "scripts" / "backup.sh"
COMPOSE_SH = ROOT / "scripts" / "compose.sh"
DOCS = ROOT / "docs"

FAKE_DOCKER = r'''#!/usr/bin/env bash
# Фейковый docker: отвечает на три вызова backup.sh.
case "$*" in
  *export_graph.py*) [[ "${FAKE_FAIL:-}" == export ]] && exit 7; [[ "${FAKE_FAIL:-}" == empty ]] && exit 0
                     echo "MERGE (n:Order {id: 1});" ;;
  *"python -"*) cat > /dev/null; [[ "${FAKE_FAIL:-}" == state ]] && { echo "neo4j down" >&2; exit 1; }
               echo 'MERGE (n:User {login: "a"}) SET n = {};' ;;
  *tar*) tar -C "$FAKE_AUDIT" -czf - . ; exit "${FAKE_TAR_RC:-0}" ;;
  *) echo "неожиданный вызов: $*" >&2; exit 99 ;;
esac
'''


def run_backup(tmp_path, **env):
    if shutil.which("bash") is None or shutil.which("tar") is None:
        pytest.skip("нет bash или tar")
    fake = tmp_path / "bin"
    fake.mkdir(parents=True, exist_ok=True)
    (fake / "docker").write_text(FAKE_DOCKER, encoding="utf-8")
    (fake / "docker").chmod(0o755)
    audit = tmp_path / "audit"
    audit.mkdir(exist_ok=True)
    (audit / "audit.jsonl").write_text("{}\n", encoding="utf-8")
    dest = tmp_path / "nested" / "backups"      # каталога ещё нет — как при первой установке
    proc = subprocess.run(
        ["bash", str(BACKUP_SH)], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60,
        env={"PATH": f"{fake}:{os.environ.get('PATH', '/usr/bin:/bin')}", "BACKUP_DIR": str(dest),
             "FAKE_AUDIT": str(audit), **env})
    log = (dest / "backup.log").read_text(encoding="utf-8") if (dest / "backup.log").exists() else ""
    return proc, dest, log


def _mode(path):
    return stat.S_IMODE(path.stat().st_mode)


def test_backup_catalog_is_readable_by_seeder(tmp_path):
    """N2: сидер (uid 10001) читает восстановленный data.cypher; каталог копий закрыт."""
    proc, dest, log = run_backup(tmp_path)
    assert proc.returncode == 0, proc.stderr + log
    [copy] = list(dest.glob("auto-*"))
    assert _mode(dest) == 0o700 and _mode(copy) == 0o700
    assert _mode(copy / "data.cypher") == 0o644
    assert _mode(copy / "state.cypher") == 0o600      # хэши ключей и логины — только владельцу
    assert "готово" in log and not proc.stdout      # из cron вывод — в журнал, не в почту


def test_restore_instruction_sets_seeder_readable_mode():
    text = (DOCS / "data.md").read_text(encoding="utf-8")
    assert 'cp -p "$d/data.cypher"' not in text
    assert "chmod 0644 neo4j/init/data.cypher" in text


@pytest.mark.parametrize("fail", ["export", "state"])
def test_backup_failure_writes_error(tmp_path, fail):
    """N8: любой сбой — ненулевой код, «ОШИБКА» с номером строки в журнале и в stderr (письмо cron)."""
    proc, dest, log = run_backup(tmp_path, FAKE_FAIL=fail)
    assert proc.returncode != 0
    assert re.search(r"ОШИБКА: строка \d+, код \d+: scripts/compose.sh exec", log), log
    assert "ОШИБКА" in proc.stderr
    assert "import json" not in log                 # тело heredoc в строку ошибки не попадает
    assert not list(dest.glob("auto-*")) and not list(dest.glob(".*partial"))


def test_backup_empty_export_reaches_stderr(tmp_path):
    """Пустая выгрузка каталога — тоже через fail: строка «ОШИБКА» и в stderr (письмо cron)."""
    proc, dest, log = run_backup(tmp_path, FAKE_FAIL="empty")
    assert proc.returncode == 1
    assert "ОШИБКА: строка" in log and "выгрузка каталога пустая" in log
    assert "ОШИБКА" in proc.stderr


def test_backup_uses_compose_wrapper():
    """Копия идёт через scripts/compose.sh: COMPOSE_PROJECT_NAME и прочее из .env.local
    действуют и на неё, иначе она искала бы сервис api в другом проекте."""
    text = BACKUP_SH.read_text(encoding="utf-8")
    assert not re.search(r"^[^#]*\bdocker compose\b", text, re.M)
    assert text.count("scripts/compose.sh exec") == 3


def test_backup_script_traps_errors():
    text = BACKUP_SH.read_text(encoding="utf-8")
    assert "set -Eeuo pipefail" in text
    assert re.search(r"^trap '.*' ERR$", text, re.M)


def test_backup_tolerates_live_audit_log(tmp_path):
    """N28: код 1 GNU tar («file changed as we read it») — не ошибка, 2 — ошибка."""
    proc, dest, log = run_backup(tmp_path, FAKE_TAR_RC="1")
    assert proc.returncode == 0, log
    assert list(dest.glob("auto-*/audit.tar.gz"))
    proc, dest, log = run_backup(tmp_path / "rc2", FAKE_TAR_RC="2")
    assert proc.returncode == 2 and "ОШИБКА" in log
    assert "--warning=no-file-changed" in BACKUP_SH.read_text(encoding="utf-8")


def test_cron_line_does_not_need_backup_dir():
    """N29: перенаправление в несуществующий backups/backup.log не дало бы cron запустить скрипт."""
    for path in (DOCS / "data.md", BACKUP_SH):
        for line in path.read_text(encoding="utf-8").splitlines():
            if "scripts/backup.sh" in line and re.search(r"^\s*#?\s*[\d*]+ [\d*]+ ", line):
                assert ">>" not in line, f"{path.name}: {line}"


def test_release_check_shows_exited_seeder():
    """N30: без -a docker compose ps не покажет завершившийся seeder."""
    text = (DOCS / "release.md").read_text(encoding="utf-8")
    assert "docker compose ps -a" in text
    assert not re.search(r"docker compose ps(?! -a)", text)


def test_rollback_sets_data_cypher_aside():
    """N7: git checkout молча перезаписывает игнорируемый data.cypher — откладывать до checkout."""
    text = (DOCS / "release.md").read_text(encoding="utf-8")
    rollback = text.split("## Откат", 1)[1].split("\n## ", 1)[0]
    assert rollback.index("mv neo4j/init/data.cypher") < rollback.index("git checkout v")
    assert "cp -p ~/goal-checker.data.cypher neo4j/init/data.cypher" in rollback
    assert "прерывает" not in rollback               # прежнее неверное «git остановится с ошибкой»
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "упёрлись бы" not in gitignore and "ОБЯЗАТЕЛЬНО" in gitignore


ENV_LOCAL_DOCS = [ROOT / "README.md", ROOT / ".env.example", DOCS / "development.md", ROOT / ".gitignore"]


def test_env_local_is_passed_explicitly():
    """N6: compose сам читает только .env — документация не обещает, что .env.local подхватится сам."""
    for path in ENV_LOCAL_DOCS:
        text = path.read_text(encoding="utf-8")
        assert ".env.local" in text
        assert "scripts/compose.sh" in text or "--env-file .env.local" in text, path.name


def test_compose_wrapper_adds_env_local(tmp_path):
    if shutil.which("bash") is None:
        pytest.skip("нет bash")
    project = tmp_path / "p"
    (project / "scripts").mkdir(parents=True)
    shutil.copy(COMPOSE_SH, project / "scripts" / "compose.sh")
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "docker").write_text('#!/bin/sh\necho "$@"\n', encoding="utf-8")
    (fake / "docker").chmod(0o755)
    env = {"PATH": f"{fake}:/usr/bin:/bin"}

    def run():
        return subprocess.run(["bash", str(project / "scripts" / "compose.sh"), "up", "-d"], env=env,
                              cwd=tmp_path, capture_output=True, text=True, check=True).stdout.strip()

    (project / ".env").write_text("A=1\n", encoding="utf-8")
    assert run() == "compose --env-file .env up -d"
    (project / ".env.local").write_text("A=2\n", encoding="utf-8")
    assert run() == "compose --env-file .env --env-file .env.local up -d"


NEW_FILES = ["web/docker-entrypoint.d/15-api-rate.envsh", "web/src/api/limits.ts", "scripts/backup.sh",
             "scripts/compose.sh", "neo4j/init/data.example.cypher"]


@pytest.mark.parametrize("name", NEW_FILES)
def test_new_files_are_tracked(name):
    """N9: файл, без которого не собирается образ или не работает инструкция, лежит в git."""
    if shutil.which("git") is None or not (ROOT / ".git").exists():
        pytest.skip("не git-клон")
    tracked = subprocess.run(["git", "ls-files", "--error-unmatch", name], cwd=ROOT, capture_output=True)
    assert tracked.returncode == 0, f"{name} не добавлен в git"
    ignored = subprocess.run(["git", "check-ignore", "-q", name], cwd=ROOT)
    assert ignored.returncode == 1, f"{name} в .gitignore"
