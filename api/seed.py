#!/usr/bin/env python3
"""Загрузка графа нормативных требований в Neo4j.

Запускается отдельным сервисом `seeder` из docker-compose до старта API.
Neo4j 5 не исполняет .cypher-файлы автоматически, поэтому скрипт читает
neo4j/init/seed.cypher, разбивает его на отдельные операторы и выполняет их.

Скрипт идемпотентен настолько, насколько идемпотентен сам .cypher-файл
(в нём используются MERGE и `IF NOT EXISTS`), поэтому его безопасно
запускать при каждом подъёме стека.
"""

import logging
import os
import re
import sys
import time
from pathlib import Path

from neo4j import GraphDatabase
from neo4j.exceptions import Neo4jError, ServiceUnavailable

log = logging.getLogger("seeder")

SEED_FILE = Path(os.getenv("SEED_FILE", "/init/seed.cypher"))
CONNECT_RETRIES = int(os.getenv("SEED_CONNECT_RETRIES", "30"))
CONNECT_DELAY = float(os.getenv("SEED_CONNECT_DELAY", "2"))

SCHEMA_RE = re.compile(r"^\s*(CREATE|DROP)\s+(CONSTRAINT|INDEX|FULLTEXT)", re.IGNORECASE)


def split_statements(script: str) -> list[str]:
    """Разбивает Cypher-скрипт на операторы по `;`.

    Учитывает строковые литералы ('...', "..."), экранирование, backtick-идентификаторы,
    построчные комментарии `//` и блочные `/* ... */`, чтобы точка с запятой
    внутри текста не разрывала оператор.
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
            elif ch == "\\":
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


def run_statements(driver, statements: list[str]) -> None:
    """Выполняет сначала схемные операторы, затем данные."""
    schema = [s for s in statements if SCHEMA_RE.match(s)]
    data = [s for s in statements if not SCHEMA_RE.match(s)]

    with driver.session() as session:
        for stmt in schema:
            log.info("Схема: %s", stmt.splitlines()[0][:90])
            session.run(stmt).consume()

        if schema:
            # Констрейнты создаются асинхронно — дожидаемся, иначе MERGE
            # может отработать до появления уникального индекса.
            session.run("CALL db.awaitIndexes(300)").consume()

        for stmt in data:
            log.debug("Данные: %s", stmt.splitlines()[0][:90])
            session.run(stmt).consume()

    log.info("Выполнено операторов: схема=%d, данные=%d", len(schema), len(data))


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

    statements = split_statements(SEED_FILE.read_text(encoding="utf-8"))
    if not statements:
        log.error("В файле %s нет ни одного оператора", SEED_FILE)
        return 1
    log.info("Прочитано операторов: %d из %s", len(statements), SEED_FILE)

    driver = GraphDatabase.driver(
        os.getenv("NEO4J_URI", "bolt://neo4j:7687"),
        auth=(
            os.getenv("NEO4J_USER", "neo4j"),
            os.getenv("NEO4J_PASSWORD", "password123"),
        ),
    )
    try:
        wait_for_neo4j(driver)
        run_statements(driver, statements)
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
