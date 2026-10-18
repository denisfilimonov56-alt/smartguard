#!/usr/bin/env python3
"""Загрузка графа нормативных требований в Neo4j.

Запускается отдельным сервисом `seeder` из docker-compose до старта API.
Neo4j 5 не исполняет .cypher-файлы автоматически, поэтому скрипт читает
.cypher-файлы, разбивает их на отдельные операторы и выполняет.

Что и когда выполняется:
  * SEED_FILE (по умолчанию neo4j/init/seed.cypher — схема) — всегда.
    Схемные операторы (IF NOT EXISTS) идемпотентны; прочие операторы этого
    файла — миграция или reset_and_load, их запускают явно через
    `-e SEED_FILE=...`.
  * SEED_DATA_FILE (по умолчанию neo4j/init/data.cypher — выгрузка
    export_graph.py) и всё после маркера данных в SEED_FILE прежних версий —
    только на пустой каталог или по явному SEED_DATA=1. Иначе каждый подъём
    стека откатывал бы правки из интерфейса к моменту выгрузки. Файл данных
    читается, только когда данные действительно применяются.
  * Если SEED_FILE — не схема seed.cypher (reset_and_load, миграция),
    SEED_DATA_FILE не применяется вовсе: он шёл бы в той же транзакции и
    перекрыл бы сброс или миграцию.

Не-схемные операторы выполняются одной транзакцией и в ней же увеличивают
версию каталога (:CatalogVersion): API по ней сбрасывает кэш ответов и не
видит каталог «наполовину загруженным».
"""

from __future__ import annotations

import logging
import os
import re
import sys
import time
from pathlib import Path

from neo4j import GraphDatabase
from neo4j.exceptions import Neo4jError, ServiceUnavailable

from export_graph import DATA_MARKER

log = logging.getLogger("seeder")

SEED_FILE = Path(os.getenv("SEED_FILE", "/init/seed.cypher"))
SEED_DATA_FILE = Path(os.getenv("SEED_DATA_FILE", "/init/data.cypher"))
FORCE_DATA = os.getenv("SEED_DATA", "0").strip().lower() in ("1", "true", "yes", "on")
CONNECT_RETRIES = int(os.getenv("SEED_CONNECT_RETRIES", "30"))
CONNECT_DELAY = float(os.getenv("SEED_CONNECT_DELAY", "2"))

# Схема — единственный SEED_FILE, вместе с которым применяется SEED_DATA_FILE.
SCHEMA_SEED_NAME = "seed.cypher"

SCHEMA_RE = re.compile(r"^\s*(CREATE|DROP)\s+(CONSTRAINT|INDEX|FULLTEXT)", re.IGNORECASE)

# Каталог пуст — нет ни одного узла каталожных меток.
CATALOG_IS_EMPTY = """
MATCH (n) WHERE n:Order OR n:Clause OR n:Rule OR n:CheckTarget OR n:ViolationExample
             OR n:Department OR n:JobDescription
RETURN count(n) = 0 AS empty LIMIT 1
"""
# Контракт с API (metrics): любая правка каталога в обход API увеличивает версию.
BUMP_CATALOG_VERSION = """
MERGE (v:CatalogVersion {id: "catalog"})
SET v.version = coalesce(v.version, 0) + 1
RETURN v.version AS version
"""


def split_statements(script: str) -> list[str]:
    """Разбивает Cypher-скрипт на операторы по `;`.

    Учитывает строковые литералы ('...', "..."), экранирование, backtick-идентификаторы,
    построчные комментарии `//` и блочные `/* ... */`, чтобы точка с запятой
    внутри текста не разрывала оператор. Как в Cypher: обратная косая черта
    экранирует только в строках; в `...` её нет, а обратная кавычка внутри
    имени удваивается (``) — это закрытие и сразу новое открытие.
    """
    statements: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(script)
    quote: str | None = None
    escaped = False

    while i < n:
        ch = script[i]

        if quote:
            buf.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\" and quote != "`":
                escaped = True
            elif ch == quote:
                quote = None
            i += 1
            continue

        # Комментарии вне строковых литералов
        if ch == "/" and i + 1 < n and script[i + 1] == "/":
            while i < n and script[i] != "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < n and script[i + 1] == "*":
            end = script.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue

        if ch in ("'", '"', "`"):
            quote = ch
            buf.append(ch)
            i += 1
            continue

        if ch == ";":
            statement = "".join(buf).strip()
            if statement:
                statements.append(statement)
            buf = []
            i += 1
            continue

        buf.append(ch)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements


def wait_for_neo4j(driver) -> None:
    """Ждёт готовности Neo4j; бросает ServiceUnavailable, если не дождались."""
    last_error: Exception | None = None
    for attempt in range(1, CONNECT_RETRIES + 1):
        try:
            driver.verify_connectivity()
            log.info("Neo4j доступен (попытка %d)", attempt)
            return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            log.info("Neo4j ещё не готов (попытка %d/%d)", attempt, CONNECT_RETRIES)
            time.sleep(CONNECT_DELAY)
    raise ServiceUnavailable(f"Neo4j не поднялся: {last_error}")


def split_data(script: str) -> tuple[str, str]:
    """Делит файл на явную часть и данные после маркера (seed.cypher прежних версий)."""
    index = script.find(DATA_MARKER)
    if index == -1:
        return script, ""
    return script[:index], script[index + len(DATA_MARKER):]


def data_file_for(seed_file: Path, data_file: Path) -> Path | None:
    """Файл данных, который применяется вместе с seed_file, или None.

    Только со схемой seed.cypher: reset_and_load и миграции выполняются
    одной транзакцией, и выгрузка в ней перекрыла бы сброс или миграцию.
    """
    if seed_file.name != SCHEMA_SEED_NAME:
        if data_file.exists():
            log.info("Файл данных %s не применяется: %s — не схема, а сброс или миграция",
                     data_file, seed_file.name)
        return None
    if not data_file.exists() or data_file.resolve() == seed_file.resolve():
        return None
    return data_file


def _write_all(tx, statements: list[str]) -> int:
    for stmt in statements:
        log.debug("Данные: %s", stmt.splitlines()[0][:90])
        tx.run(stmt).consume()
    return tx.run(BUMP_CATALOG_VERSION).single()["version"]


def catalog_is_empty(driver) -> bool:
    with driver.session() as session:
        row = session.run(CATALOG_IS_EMPTY).single()
    return bool(row and row["empty"])


def run_statements(driver, statements: list[str], data: list[str] | None = None,
                   load_data: bool = False) -> None:
    """Выполняет схемные операторы, затем прочие и (если load_data) данные.

    Прочие операторы и данные — одна транзакция с увеличением версии каталога:
    сбой откатывает всё, а API не кэширует ответы по неполному каталогу.
    """
    schema = [s for s in statements if SCHEMA_RE.match(s)]
    writes = [s for s in statements if not SCHEMA_RE.match(s)]
    data = data or []
    # Схема в файле данных (не должно быть, но) выполняется наравне со схемой.
    schema += [s for s in data if SCHEMA_RE.match(s)]
    data = [s for s in data if not SCHEMA_RE.match(s)]
    if load_data:
        writes += data

    with driver.session() as session:
        for stmt in schema:
            log.info("Схема: %s", stmt.splitlines()[0][:90])
            session.run(stmt).consume()

        if schema:
            # Констрейнты создаются асинхронно — дожидаемся, иначе MERGE
            # может отработать до появления уникального индекса.
            session.run("CALL db.awaitIndexes(300)").consume()

        if writes:
            version = session.execute_write(_write_all, writes)
            log.info("Версия каталога: %s", version)

    log.info("Выполнено операторов: схема=%d, данные=%d", len(schema), len(writes))
    if data and not load_data:
        log.info("Данные (%d операторов) не применялись: каталог не пуст. "
                 "Принудительно — SEED_DATA=1 (вернёт каталог к состоянию файла)", len(data))


def report(driver) -> None:
    """Короткая сводка по загруженному графу."""
    query = """
    OPTIONAL MATCH (o:Order) WITH count(o) AS orders
    OPTIONAL MATCH (c:Clause) WITH orders, count(c) AS clauses
    OPTIONAL MATCH (r:Rule) WITH orders, clauses, count(r) AS rules
    OPTIONAL MATCH (t:CheckTarget) WITH orders, clauses, rules, count(t) AS targets
    OPTIONAL MATCH (e:ViolationExample)
    RETURN orders, clauses, rules, targets, count(e) AS examples
    """
    with driver.session() as session:
        row = session.run(query).single()
    if row:
        log.info(
            "В графе: приказов=%d, пунктов=%d, правил=%d, атрибутов=%d, примеров=%d",
            row["orders"], row["clauses"], row["rules"], row["targets"], row["examples"],
        )


def main() -> int:
    # Настраиваем логирование только при запуске как скрипт, чтобы импорт
    # модуля в тестах не перехватывал конфигурацию корневого логгера.
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s seeder: %(message)s",
    )

    if not SEED_FILE.exists():
        log.error("Файл сида не найден: %s", SEED_FILE)
        return 1

    explicit, legacy_data = split_data(SEED_FILE.read_text(encoding="utf-8"))
    statements = split_statements(explicit)
    data = split_statements(legacy_data)
    data_file = data_file_for(SEED_FILE, SEED_DATA_FILE)
    if not statements and not data:
        log.error("В файле %s нет ни одного оператора", SEED_FILE)
        return 1
    log.info("Прочитано операторов: %d из %s, данных: %d", len(statements), SEED_FILE, len(data))

    driver = GraphDatabase.driver(
        os.getenv("NEO4J_URI", "bolt://neo4j:7687"),
        auth=(
            os.getenv("NEO4J_USER", "neo4j"),
            os.getenv("NEO4J_PASSWORD", "password123"),
        ),
    )
    try:
        wait_for_neo4j(driver)
        load_data = bool(data or data_file) and (FORCE_DATA or catalog_is_empty(driver))
        if load_data and data_file:
            # Файл данных читается, только когда он применяется: битый или
            # недоступный data.cypher не должен ронять обычный подъём стека.
            try:
                data += split_statements(data_file.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError) as exc:
                log.error("Не удалось прочитать файл данных %s: %s. Проверьте права и "
                          "кодировку (UTF-8) или выгрузите его заново (export_graph.py)",
                          data_file, exc)
                return 1
        load_data = load_data and bool(data)
        if load_data:
            log.info("Применяются данные: %s", "SEED_DATA=1" if FORCE_DATA else "каталог пуст")
        run_statements(driver, statements, data, load_data)
        report(driver)
    except (Neo4jError, ServiceUnavailable) as exc:
        log.error("Загрузка данных не удалась: %s", exc)
        return 1
    finally:
        driver.close()

    log.info("Граф успешно загружен")
    return 0


if __name__ == "__main__":
    sys.exit(main())
