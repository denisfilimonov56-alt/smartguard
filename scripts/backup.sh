#!/usr/bin/env bash
# Регулярная резервная копия без остановки сервиса (docs/deployment.md,
# «Регулярная копия»). Снимает с работающего стека:
#
#   data.cypher   каталог — export_graph.py --stdout, тот же MERGE-скрипт,
#                 что грузит сидер (одна транзакция чтения: согласован);
#   state.cypher  пользователи и роли (:User), ключи доступа (:ApiKey) и
#                 настройки (:Setting) — MERGE-скрипт для cypher-shell;
#   audit.tar.gz  журнал аудита с тома api_audit;
#
# и удаляет свои копии старше BACKUP_KEEP_DAYS дней. История проверок и
# оценки SMART сюда не входят — их сохраняет только дамп базы (docs/deployment.md).
#
# Запуск — из любого каталога, от пользователя с правом на docker:
#   scripts/backup.sh
# Регламентно — таймер systemd goal-checker-backup@<пользователь>.timer
# (deploy/systemd) или cron (каждую ночь). Журнал скрипт ведёт сам — $BACKUP_DIR/backup.log,
# каталог создаёт тоже сам, поэтому строка cron без перенаправления и не
# зависит от того, есть ли уже backups/. Строка «ОШИБКА» при сбое уходит и
# в журнал, и в stderr — письмо cron, если на сервере настроена почта:
#   PATH=/usr/local/bin:/usr/bin:/bin
#   15 2 * * * /opt/goal-checker/scripts/backup.sh
#
# Настройки (переменные окружения):
#   BACKUP_DIR        куда класть копии; по умолчанию backups/ в каталоге
#                     проекта; лучше — другой диск или сетевой ресурс
#   BACKUP_KEEP_DAYS  сколько дней хранить копии (по умолчанию 14)
#   BACKUP_LOG        журнал; по умолчанию $BACKUP_DIR/backup.log

set -Eeuo pipefail

log() { printf '%s backup: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Любой сбой (set -e, с pipefail — и в середине конвейера) пишет строку
# «ОШИБКА» с номером строки и командой: по ней журнал ловит мониторинг.
# Из cron строка дублируется в исходный stderr (fd 3) — для письма cron.
exec 3>&2
copy_to_stderr=0
fail() {
  local rc=$1 line=$2 cmd=${3%%$'\n'*}    # без тела heredoc — только команда
  log "ОШИБКА: строка $line, код $rc: $cmd"
  if (( copy_to_stderr )); then log "ОШИБКА: строка $line, код $rc: $cmd" >&3; fi
  exit "$rc"
}
trap 'fail "$?" "$LINENO" "$BASH_COMMAND"' ERR

cd "$(dirname "${BASH_SOURCE[0]}")/.."
DEST="${BACKUP_DIR:-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || { log "ОШИБКА: BACKUP_KEEP_DAYS — число дней, а не «$KEEP_DAYS»" >&2; exit 2; }

umask 077
mkdir -p "$DEST"
chmod 700 "$DEST"
LOG="${BACKUP_LOG:-$DEST/backup.log}"
# Из терминала вывод виден и пишется в журнал; из cron — только в журнал.
if [[ -t 1 ]]; then
  exec > >(tee -a "$LOG") 2>&1
else
  exec >> "$LOG" 2>&1
  copy_to_stderr=1
fi
# Не одновременно с дампом (scripts/dump.sh): он останавливает API.
# flock — из util-linux, на Ubuntu есть всегда; на машине разработчика
# (macOS) его может не быть — тогда без замка.
exec 9> "$DEST/.lock"
if command -v flock > /dev/null; then
  flock -w 1800 9 || fail 1 "$LINENO" "другая копия идёт дольше 30 минут"
else
  log "flock не найден — копия идёт без замка"
fi

# Копия собирается во временном каталоге и получает имя, только когда снята
# целиком: каталог auto-<дата> всегда полный.
name="auto-$(date +%Y%m%d-%H%M%S)"
tmp="$DEST/.$name.partial"
rm -rf "$tmp"
mkdir "$tmp"
trap 'rm -rf "$tmp"' EXIT

log "каталог → $DEST/$name/data.cypher"
docker compose exec -T api python export_graph.py --stdout > "$tmp/data.cypher"
[[ -s "$tmp/data.cypher" ]] || fail 1 "$LINENO" "выгрузка каталога пустая"
# Сидер читает файл от uid 10001: при umask 077 он был бы 0600 и после
# восстановления (docs/deployment.md) сидер упал бы с PermissionError. Каталог
# копий остаётся 0700 — чужие пользователи хоста до файла не доберутся.
chmod 0644 "$tmp/data.cypher"

log "пользователи, ключи доступа, настройки → state.cypher"
# Через драйвер в контейнере API, а не через текстовый вывод cypher-shell:
# строки экранируются как в JSON (совместимо с литералами Cypher), перевод
# строки или кавычка в отображаемом имени выгрузку не ломают.
docker compose exec -T api python - > "$tmp/state.cypher" <<'PY'
import json
import os
import sys

from neo4j import GraphDatabase

KEYS = (("User", "login"), ("ApiKey", "keyId"), ("Setting", "key"))


def lit(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ", ".join(lit(v) for v in value) + "]"
    sys.exit(f"неожиданный тип свойства: {type(value).__name__}")


def props(p):
    return "{" + ", ".join(f"`{k.replace('`', '``')}`: {lit(v)}" for k, v in sorted(p.items())) + "}"


def read(tx):
    return {label: [r["p"] for r in tx.run(f"MATCH (n:{label}) RETURN properties(n) AS p ORDER BY n.{key}")]
            for label, key in KEYS}


driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                              auth=(os.environ.get("NEO4J_USER", "neo4j"), os.environ["NEO4J_PASSWORD"]))
try:
    with driver.session() as session:
        data = session.execute_read(read)
finally:
    driver.close()

print("// Пользователи, ключи доступа и настройки (scripts/backup.sh).")
print("// Восстановление — docs/deployment.md, «Регулярная копия».")
for label, key in KEYS:
    rows = [p for p in data[label] if p.get(key) is not None]
    for p in rows:
        print(f"MERGE (n:{label} {{{key}: {lit(p[key])}}}) SET n = {props(p)};")
    print(f"{label}: {len(rows)}", file=sys.stderr)
PY

log "журнал аудита → audit.tar.gz"
# API пишет журнал прямо во время копии: GNU tar тогда выходит с кодом 1
# («file changed as we read it» / файл ротирован). Архив при этом цельный —
# в нём состояние файла на момент чтения, — поэтому код 1 не ошибка;
# 2 и выше (нет каталога, нет прав, сбой docker) — ошибка.
tar_rc=0
docker compose exec -T api tar --warning=no-file-changed --warning=no-file-removed \
  -C /data/audit -czf - . > "$tmp/audit.tar.gz" || tar_rc=$?
if (( tar_rc > 1 )); then
  fail "$tar_rc" "$LINENO" "tar журнала аудита"
elif (( tar_rc == 1 )); then
  log "журнал аудита менялся во время копии (tar: код 1) — архив цельный"
fi
tar -tzf "$tmp/audit.tar.gz" > /dev/null

mv "$tmp" "$DEST/$name"
trap - EXIT
log "готово: $DEST/$name ($(du -sh "$DEST/$name" | cut -f1))"

# Ротация — только своих копий auto-*: дампы перед релизом (backups/<дата>)
# не трогаются.
find "$DEST" -mindepth 1 -maxdepth 1 -type d -name 'auto-*' -mtime "+$KEEP_DAYS" -print -exec rm -rf {} + \
  | sed 's/^/удалена старая копия: /'
