#!/usr/bin/env bash
# Установка на сервере БЕЗ ИНТЕРНЕТА из набора, собранного prepare.sh.
#
# Ожидает рядом с собой (или в каталоге BUNDLE_DIR):
#   images.tar               образы Neo4j, vLLM, python, API и интерфейса
#   goal-checker-src.tar.gz  исходники проекта (compose, web, neo4j/init, api)
#   .env.example             шаблон настроек
#
# И каталог с весами модели: ${MODELS_DIR}/${VLLM_MODEL_DIR}/config.json.
#
# Использование:
#   ./install.sh [каталог установки]      по умолчанию /opt/goal-checker
#
# Скрипт ничего не скачивает. Если какого-то образа нет в images.tar,
# он остановится до запуска compose, а не упадёт на середине подъёма.

set -euo pipefail

BUNDLE_DIR="${BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
INSTALL_DIR="${1:-/opt/goal-checker}"

log() { printf '\n==> %s\n' "$*"; }
die() { echo "ОШИБКА: $*" >&2; exit 1; }

command -v docker >/dev/null || die "docker не установлен"
docker compose version >/dev/null 2>&1 || die "нужен docker compose v2"

[[ -f "$BUNDLE_DIR/images.tar" ]] || die "нет $BUNDLE_DIR/images.tar"
[[ -f "$BUNDLE_DIR/goal-checker-src.tar.gz" ]] || die "нет $BUNDLE_DIR/goal-checker-src.tar.gz"

# --- Исходники ----------------------------------------------------------------
log "Исходники → $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$BUNDLE_DIR/goal-checker-src.tar.gz" -C "$INSTALL_DIR"
cd "$INSTALL_DIR"

if [[ ! -f .env ]]; then
  cp "$BUNDLE_DIR/.env.example" .env
  echo "Создан $INSTALL_DIR/.env из шаблона. Заполните NEO4J_PASSWORD, настройки входа (LDAP_*, AUTH_ADMIN_LOGINS) и проверьте пути."
fi
# shellcheck disable=SC1091
set -a; source .env; set +a

MODELS_DIR="${MODELS_DIR:-./models}"
VLLM_MODEL_DIR="${VLLM_MODEL_DIR:-${VLLM_MODEL##*/}}"

# --- Образы -------------------------------------------------------------------
log "docker load ← $BUNDLE_DIR/images.tar"
docker load -i "$BUNDLE_DIR/images.tar"

if [[ -f "$BUNDLE_DIR/images.list" ]]; then
  missing=0
  while read -r img; do
    [[ -z "$img" ]] && continue
    if docker image inspect "$img" >/dev/null 2>&1; then
      echo "  есть  $img"
    else
      echo "  НЕТ   $img"; missing=1
    fi
  done < "$BUNDLE_DIR/images.list"
  [[ $missing -eq 0 ]] || die "не все образы загружены, compose запускать нельзя"
fi

# --- Веса модели --------------------------------------------------------------
log "Проверка весов: $MODELS_DIR/$VLLM_MODEL_DIR"
if [[ ! -f "$MODELS_DIR/$VLLM_MODEL_DIR/config.json" ]]; then
  cat >&2 <<EOF
ОШИБКА: не найден $MODELS_DIR/$VLLM_MODEL_DIR/config.json
Скопируйте каталог с весами, подготовленный prepare.sh, в $MODELS_DIR/
или укажите другой MODELS_DIR в .env.
EOF
  exit 1
fi

# --- Настройки ----------------------------------------------------------------
if [[ -z "${NEO4J_PASSWORD:-}" || "${NEO4J_PASSWORD}" == "change_me" ]]; then
  die "в $INSTALL_DIR/.env не задан NEO4J_PASSWORD"
fi
# Стек, в который некому войти, поднимать бессмысленно.
if [[ "${AUTH_BACKEND:-ldap}" == "ldap" ]]; then
  if [[ -z "${LDAP_URL:-}" || "${LDAP_URL}" == *example.local* || "${LDAP_USER_TEMPLATE:-}" != *"{login}"* \
        || "${LDAP_USER_TEMPLATE}" == *example.local* ]]; then
    die "в $INSTALL_DIR/.env не заданы LDAP_URL и LDAP_USER_TEMPLATE (см. docs/security.md)"
  fi
fi
if [[ -z "${AUTH_ADMIN_LOGINS:-}" || "${AUTH_ADMIN_LOGINS}" == "change_me" ]]; then
  die "в $INSTALL_DIR/.env не задан AUTH_ADMIN_LOGINS — логин первого администратора"
fi
mkdir -p certs

# --- Запуск -------------------------------------------------------------------
log "docker compose up -d (без --build и без pull)"
docker compose up -d --no-build

cat <<EOF

Стек запущен из $INSTALL_DIR.
Загрузка весов модели занимает несколько минут; готовность:
  curl -s localhost:8080/ready
Редактор каталога: http://<сервер>:3000 — вход доменной учётной записью;
первый администратор — из AUTH_ADMIN_LOGINS. Перед портом 3000 нужен
прокси с TLS: cookie сессии по HTTP не передаётся (docs/security.md).
EOF
