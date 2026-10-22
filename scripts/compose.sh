#!/usr/bin/env bash
# docker compose с локальными настройками: .env и поверх него .env.local.
#
# Compose сам читает только .env в каталоге проекта. .env.local (секреты
# вроде HF_TOKEN, COMPOSE_PROJECT_NAME, AUTOHEAL_REPLICAS стенда) он не
# видит, а задать COMPOSE_ENV_FILES изнутри .env нельзя — список файлов
# окружения определяется до чтения .env. Поэтому файлы передаются явно:
#
#   scripts/compose.sh up -d --no-build
#   ==  docker compose --env-file .env --env-file .env.local up -d --no-build
#
# (несколько --env-file — compose 2.17+; значение из более позднего файла
# главнее). Без .env.local — обычный docker compose с .env. Запуск — из
# любого каталога: команда выполняется в корне проекта.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
args=()
[[ -f .env ]] && args+=(--env-file .env)
[[ -f .env.local ]] && args+=(--env-file .env.local)
exec docker compose ${args[@]+"${args[@]}"} "$@"
