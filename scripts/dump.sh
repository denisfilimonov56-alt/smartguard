#!/usr/bin/env bash
# Полный дамп базы с проверкой (docs/deployment.md, «Резервная копия»). В отличие
# от ночной копии (scripts/backup.sh) в дампе вся база, включая историю
# проверок и оценки SMART, но Neo4j 5 Community снимает дамп только
# с остановленной базы: API и Neo4j на это время останавливаются (на
# небольшой базе — около минуты).
#
#   1. stop api neo4j;
#   2. neo4j-admin database dump в backups/dump-<дата>/neo4j.dump;
#   3. проверка: дамп загружается во временный каталог одноразового
#      контейнера (не в том neo4j_data) и прогоняется neo4j-admin database
#      check — обрезанный или повреждённый дамп даёт ошибку;
#   4. start neo4j api — всегда, даже если дамп не удался;
#   5. рядом — копия neo4j/init/data.cypher;
#   6. дампы dump-* старше DUMP_KEEP_DAYS дней удаляются.
#
# Каталог dump-<дата> появляется, только когда дамп снят и проверен.
# Запуск — из любого каталога, от пользователя с правом на docker:
#   scripts/dump.sh                 перед релизом и разрушающими операциями
# Регламентно — таймер systemd goal-checker-dump@<пользователь>.timer
# (deploy/systemd, docs/deployment.md).
#
# Настройки (переменные окружения; для таймера — /etc/default/goal-checker-backup):
#   BACKUP_DIR       куда класть дампы; по умолчанию backups/ в каталоге проекта
#   DUMP_KEEP_DAYS   сколько дней хранить дампы (по умолчанию 60)
#   BACKUP_LOG       журнал; по умолчанию $BACKUP_DIR/backup.log (общий с backup.sh)

set -Eeuo pipefail

log() { printf '%s dump: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Как в backup.sh: любой сбой — строка «ОШИБКА» в журнале (её ловит
# мониторинг), из таймера или cron — ещё и в исходный stderr (fd 3).
exec 3>&2
copy_to_stderr=0
fail() {
  local rc=$1 line=$2 cmd=${3%%$'\n'*}
  log "ОШИБКА: строка $line, код $rc: $cmd"
  if (( copy_to_stderr )); then log "ОШИБКА: строка $line, код $rc: $cmd" >&3; fi
  exit "$rc"
}
trap 'fail "$?" "$LINENO" "$BASH_COMMAND"' ERR

cd "$(dirname "${BASH_SOURCE[0]}")/.."
DEST="${BACKUP_DIR:-backups}"
KEEP_DAYS="${DUMP_KEEP_DAYS:-60}"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || { log "ОШИБКА: DUMP_KEEP_DAYS — число дней, а не «$KEEP_DAYS»" >&2; exit 2; }

umask 077
mkdir -p "$DEST"
chmod 700 "$DEST"
DEST="$(cd "$DEST" && pwd)"          # docker run -v принимает только абсолютный путь
LOG="${BACKUP_LOG:-$DEST/backup.log}"
if [[ -t 1 ]]; then
  exec > >(tee -a "$LOG") 2>&1
else
  exec >> "$LOG" 2>&1
  copy_to_stderr=1
fi

# Ночная копия и дамп не должны идти одновременно: копия снимается
# с работающего API, а дамп его останавливает.
# flock — из util-linux, на Ubuntu есть всегда; на машине разработчика
# (macOS) его может не быть — тогда без замка.
exec 9> "$DEST/.lock"
if command -v flock > /dev/null; then
  flock -w 1800 9 || fail 1 "$LINENO" "другая копия идёт дольше 30 минут"
else
  log "flock не найден — копия идёт без замка"
fi

name="dump-$(date +%Y%m%d-%H%M%S)"
tmp="$DEST/.$name.partial"
rm -rf "$tmp"
mkdir "$tmp"
chmod 777 "$tmp"                     # дамп пишет neo4j-admin от uid 7474
stopped=0
cleanup() {
  if (( stopped )); then
    log "запуск neo4j и api"
    docker compose start neo4j api || log "ОШИБКА: neo4j и api не запустились — docker compose start neo4j api"
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

log "остановка api и neo4j"
stopped=1
docker compose stop api neo4j

log "дамп и проверка → $DEST/$name/neo4j.dump"
docker compose run --rm --no-deps -v "$tmp:/backups" neo4j sh -ec '
  neo4j-admin database dump neo4j --to-path=/backups
  printf "server.directories.data=/tmp/verify\nserver.directories.transaction.logs.root=/tmp/verify/transactions\n" > /tmp/verify.conf
  neo4j-admin database load neo4j --from-path=/backups --additional-config=/tmp/verify.conf
  neo4j-admin database check neo4j --additional-config=/tmp/verify.conf --report-path=/tmp
  echo "ДАМП ПРОВЕРЕН: /backups/neo4j.dump"'

log "запуск neo4j и api"
docker compose start neo4j api
stopped=0

cp neo4j/init/data.cypher "$tmp/" 2>/dev/null || true
chmod 700 "$tmp"
mv "$tmp" "$DEST/$name"
trap - EXIT
log "готово: $DEST/$name ($(du -sh "$DEST/$name" | cut -f1))"

# Ротация — только дампы dump-*: ночные копии auto-* чистит backup.sh,
# дампы прежнего вида (backups/<дата>, снятые вручную) не трогаются.
find "$DEST" -mindepth 1 -maxdepth 1 -type d -name 'dump-*' -mtime "+$KEEP_DAYS" -print -exec rm -rf {} + \
  | sed 's/^/удалён старый дамп: /'
