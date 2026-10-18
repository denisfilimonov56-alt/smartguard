"""requirements.lock — то, из чего ставится образ API.

pip ставит ровно lock (--require-hashes --no-deps, api/Dockerfile), поэтому
здесь проверяется, что lock полон и согласован с requirements.txt: у каждого
пакета есть sha256, а каждая прямая зависимость закреплена той же версией.
Сборка образа ловит то же самое, но только при релизе и уже после коммита.
"""

import re
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
LOCK = API_DIR / "requirements.lock"
REQUIREMENTS = API_DIR / "requirements.txt"


def canonical(name: str) -> str:
    """Имя пакета по PEP 503: PyJWT, pyjwt и py_jwt — один пакет."""
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_lock() -> dict[str, tuple[str, set[str]]]:
    """{имя: (версия, {sha256})} из requirements.lock (формат pip-compile)."""
    packages: dict[str, tuple[str, set[str]]] = {}
    current = None
    for line in LOCK.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==([^\s\;]+)", line)
        if match:
            current = canonical(match.group(1))
            packages[current] = (match.group(2), set())
        for digest in re.findall(r"--hash=sha256:([0-9a-f]{64})", line):
            assert current, "хэш до первого пакета в requirements.lock"
            packages[current][1].add(digest)
    return packages


def parse_requirements() -> dict[str, str]:
    """{имя: версия} прямых зависимостей из requirements.txt."""
    pins = {}
    for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==(\S+)$", line)
        assert match, f"requirements.txt: версия должна быть закреплена через ==: {line!r}"
        pins[canonical(match.group(1))] = match.group(2)
    return pins


LOCKED = parse_lock()


def test_lock_is_not_empty_and_fully_hashed():
    assert LOCKED, "requirements.lock пуст"
    unhashed = [name for name, (_, hashes) in LOCKED.items() if not hashes]
    assert not unhashed, f"в requirements.lock нет sha256 у: {unhashed}"


def test_direct_requirements_are_locked_with_same_version():
    for name, version in parse_requirements().items():
        assert name in LOCKED, f"{name} есть в requirements.txt, но нет в requirements.lock — пересоберите lock (docs/deployment.md, «Зависимости API»)"
        assert LOCKED[name][0] == version, (
            f"{name}: requirements.txt {version}, requirements.lock {LOCKED[name][0]} — пересоберите lock (docs/deployment.md)")


def test_dockerfile_installs_exactly_the_lock():
    dockerfile = (API_DIR / "Dockerfile").read_text(encoding="utf-8")
    assert "--require-hashes" in dockerfile and "--no-deps" in dockerfile and "requirements.lock" in dockerfile
