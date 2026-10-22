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
    export_graph.py этого сервера, в git её нет) и всё после маркера данных
    в SEED_FILE прежних версий — только на пустой каталог или по явному
    SEED_DATA=1. Иначе каждый подъём стека откатывал бы правки из интерфейса
    к моменту выгрузки. Файл данных читается, только когда данные
    действительно применяются; нет файла — загружается только схема.
  * SEED_DATA=1 — восстановление каталога из файла: в той же транзакции
    сначала удаляются узлы каталога (как в reset_and_load), затем
    загружается файл. Без удаления MERGE смешал бы файл с базой: двойники
    переименованных узлов, лишние связи. Пользователи (:User), ключи
    (:ApiKey), настройки (:Setting), история проверок и оценки SMART не
    трогаются.
  * Если SEED_FILE — не схема seed.cypher (reset_and_load, миграция),
    SEED_DATA_FILE не применяется вовсе: он шёл бы в той же транзакции и
    перекрыл бы сброс или миграцию.
  * Миграция (файл из каталога migrations/) отмечается узлом
    :Migration {id, appliedAt} в той же транзакции; уже применённая
    пропускается, повторить — SEED_REAPPLY=1.
  * Условная миграция (её операторы ничего не делают, пока в каталоге нет
    нужных узлов) объявляет условие строкой-комментарием
    `// @mark-if: <запрос, возвращающий столбец done>`. Запрос выполняется
    в той же транзакции после операторов; done = false — отметка не
    ставится, и миграция выполнится снова при следующем запуске (на пустом
    каталоге 003 иначе считалась бы применённой, и правило R-3.5 после
    загрузки каталога уже не появилось бы).

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
REAPPLY_MIGRATION = os.getenv("SEED_REAPPLY", "0").strip().lower() in ("1", "true", "yes", "on")
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
# SEED_DATA=1: перед загрузкой файла удаляются узлы каталога — те же метки,
# что очищает reset_and_load.cypher. Прочие узлы (:User, :ApiKey, :Setting,
# :CheckRecord, :SmartScore, :CatalogVersion, :Migration) остаются.
CLEAR_CATALOG = """
MATCH (n) WHERE n:Order OR n:Clause OR n:Rule OR n:CheckTarget OR n:ViolationExample
             OR n:Department OR n:JobDescription
DETACH DELETE n
"""
# Учёт миграций: узел на файл миграции.
MIGRATION_APPLIED = "MATCH (m:Migration {id: $id}) RETURN toString(m.appliedAt) AS appliedAt"
MARK_MIGRATION = """
MERGE (m:Migration {id: $id})
SET m.appliedAt = datetime()
"""
# Условие отметки условной миграции — строка-комментарий в её файле.
MARK_IF_RE = re.compile(r"^\s*//\s*@mark-if:\s*(\S.*?)\s*$", re.MULTILINE)
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


def migration_id(seed_file: Path) -> str | None:
    """Идентификатор миграции (имя файла без .cypher) или None, если это не миграция."""
    return seed_file.stem if seed_file.parent.name == "migrations" else None


def migration_applied(driver, migration: str) -> str | None:
    """Когда миграция уже применялась (строка даты) или None."""
    with driver.session() as session:
        row = session.run(MIGRATION_APPLIED, id=migration).single()
    return row["appliedAt"] if row else None


def mark_condition(script: str) -> str | None:
    """Условие отметки миграции (// @mark-if: ...) или None — отмечать всегда."""
    match = MARK_IF_RE.search(script)
    return match.group(1) if match else None


def _mark(tx, migration: str, mark_if: str | None = None) -> bool:
    """Отмечает миграцию применённой, если её условие выполнено. Возвращает, отмечена ли.

    Условие проверяется после операторов миграции в той же транзакции: оно
    видит их результат.
    """
    if mark_if:
        row = tx.run(mark_if).single()
        if not (row and row["done"]):
            return False
    tx.run(MARK_MIGRATION, id=migration).consume()
    return True


def _write_all(tx, statements: list[str], migration: str | None = None,
               mark_if: str | None = None) -> tuple[int, bool]:
    """Операторы, отметка миграции и версия каталога. Возвращает (версия, отмечена ли)."""
    for stmt in statements:
        log.debug("Данные: %s", stmt.splitlines()[0][:90])
        tx.run(stmt).consume()
    # Отметка — в той же транзакции: сбой откатит и её.
    marked = _mark(tx, migration, mark_if) if migration else False
    return tx.run(BUMP_CATALOG_VERSION).single()["version"], marked


def catalog_is_empty(driver) -> bool:
    with driver.session() as session:
        row = session.run(CATALOG_IS_EMPTY).single()
    return bool(row and row["empty"])


def run_statements(driver, statements: list[str], data: list[str] | None = None,
                   load_data: bool = False, restore: bool = False,
                   migration: str | None = None, mark_if: str | None = None) -> None:
    """Выполняет схемные операторы, затем прочие и (если load_data) данные.

    Прочие операторы и данные — одна транзакция с увеличением версии каталога:
    сбой откатывает всё, а API не кэширует ответы по неполному каталогу.
    restore (SEED_DATA=1) — перед данными в той же транзакции удаляются узлы
    каталога: каталог возвращается к состоянию файла, а не смешивается с ним.
    migration — отметить миграцию узлом :Migration в той же транзакции;
    mark_if — только если этот запрос вернул done = true (условная миграция).
    """
    schema = [s for s in statements if SCHEMA_RE.match(s)]
    writes = [s for s in statements if not SCHEMA_RE.match(s)]
    data = data or []
    # Схема в файле данных (не должно быть, но) выполняется наравне со схемой.
    schema += [s for s in data if SCHEMA_RE.match(s)]
    data = [s for s in data if not SCHEMA_RE.match(s)]
    if load_data:
        if restore and data:
            writes.append(CLEAR_CATALOG.strip())
        writes += data

    with driver.session() as session:
        for stmt in schema:
            log.info("Схема: %s", stmt.splitlines()[0][:90])
            session.run(stmt).consume()

        if schema:
            # Констрейнты создаются асинхронно — дожидаемся, иначе MERGE
            # может отработать до появления уникального индекса.
            session.run("CALL db.awaitIndexes(300)").consume()

        marked = False
        if writes:
            version, marked = session.execute_write(_write_all, writes, migration, mark_if)
            log.info("Версия каталога: %s", version)
        elif migration:
            # Миграция только из схемы (ограничения) — отметка отдельно.
            marked = session.execute_write(_mark, migration, mark_if)
        if marked:
            log.info("Миграция %s отмечена как применённая", migration)
        elif migration:
            log.warning("Миграция %s выполнена, но не отмечена: её условие (%s) не выполнено — "
                        "в каталоге нет узлов, которые она дополняет. Запустите её снова "
                        "после загрузки каталога", migration, mark_if)

    log.info("Выполнено операторов: схема=%d, данные=%d", len(schema), len(writes))
    if data and not load_data:
        log.info("Данные (%d операторов) не применялись: каталог не пуст. "
                 "Принудительно — SEED_DATA=1: узлы каталога будут удалены и загружены "
                 "из файла заново (пользователи, ключи, настройки и история останутся)", len(data))


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
    migration = migration_id(SEED_FILE)
    try:
        wait_for_neo4j(driver)
        if migration:
            applied = migration_applied(driver, migration)
            if applied and not REAPPLY_MIGRATION:
                log.info("Миграция %s уже применена (%s) — пропущена. Повторить: SEED_REAPPLY=1",
                         migration, applied)
                return 0
        if SEED_FILE.name == SCHEMA_SEED_NAME and not data_file and not SEED_DATA_FILE.exists():
            log.info("Файла данных %s нет — загружается только схема. Каталог заполняют в "
                     "интерфейсе; образец — data.example.cypher, выгрузка — export_graph.py",
                     SEED_DATA_FILE)
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
        if FORCE_DATA and not data:
            log.warning("SEED_DATA=1, но данных нет (нет файла %s или в нём нет операторов) — "
                        "каталог не тронут", SEED_DATA_FILE)
        load_data = load_data and bool(data)
        if load_data:
            log.info("Применяются данные: %s", "SEED_DATA=1 — каталог удаляется и загружается из файла "
                     "заново (пользователи, ключи, настройки и история не трогаются)"
                     if FORCE_DATA else "каталог пуст")
        mark_if = mark_condition(explicit) if migration else None
        options = {"mark_if": mark_if} if mark_if else {}
        run_statements(driver, statements, data, load_data, restore=FORCE_DATA, migration=migration,
                       **options)
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
