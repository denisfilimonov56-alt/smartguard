#!/usr/bin/env bash
# Подготовка офлайн-набора на машине С ИНТЕРНЕТОМ.
#
# Результат — каталог dist/offline с образами, исходниками и контрольными
# суммами плюс каталог models с весами модели. Оба переносятся на сервер
# без интернета, где их разворачивает scripts/offline/install.sh.
#
# Что делает:
#   1. Скачивает wheel-файлы Python под целевую платформу в api/vendor/wheels
#      (их можно закоммитить: набор небольшой и делает сборку воспроизводимой).
#   2. Собирает образ API из этих колёс без доступа к сети — так сборка
#      проверяется здесь, а не впервые на сервере. Собирает образ интерфейса
#      (React): ему сеть нужна, npm ci ставит пакеты по package-lock.json.
#   3. Скачивает образы Neo4j, vLLM и базовый python под целевую
#      платформу и сохраняет всё вместе с образами API и интерфейса одним архивом.
#   4. Скачивает веса модели с Hugging Face в ${MODELS_DIR}/${VLLM_MODEL_DIR}.
#   5. Упаковывает исходники проекта и пишет контрольные суммы.
#
# Переменные (можно задать в .env или окружении):
#   TARGET_PLATFORM  платформа сервера, по умолчанию linux/amd64
#   VLLM_MODEL       имя модели на Hugging Face, например Qwen/Qwen3-8B
#   VLLM_MODEL_DIR   имя каталога весов, по умолчанию последний сегмент VLLM_MODEL
#   MODELS_DIR       куда класть веса, по умолчанию ./models
#   VLLM_IMAGE       образ vLLM, по умолчанию vllm/vllm-openai:v0.9.2
#   APP_VERSION      тег образов API и интерфейса, по умолчанию latest
#   HF_TOKEN         токен Hugging Face, нужен только для закрытых моделей
#   SKIP_MODEL=1     не скачивать веса (если они уже есть)
#   SKIP_IMAGES=1    не скачивать и не сохранять образы

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# .env лежит в git; секреты вроде HF_TOKEN — в неотслеживаемом .env.local.
for env_file in .env .env.local; do
  if [[ -f $env_file ]]; then
    # shellcheck disable=SC1090
    set -a; source "$env_file"; set +a
  fi
done

TARGET_PLATFORM="${TARGET_PLATFORM:-linux/amd64}"
VLLM_MODEL="${VLLM_MODEL:?задайте VLLM_MODEL, например Qwen/Qwen3-8B}"
VLLM_MODEL_DIR="${VLLM_MODEL_DIR:-${VLLM_MODEL##*/}}"
MODELS_DIR="${MODELS_DIR:-./models}"
VLLM_IMAGE="${VLLM_IMAGE:-vllm/vllm-openai:v0.9.2}"
APP_VERSION="${APP_VERSION:-latest}"
OUT="${OUT:-$ROOT/dist/offline}"

PYTHON_IMAGE="python:3.12-slim"
API_IMAGE="goal-checker-api:${APP_VERSION}"
WEB_IMAGE="goal-checker-web:${APP_VERSION}"
# nginx отдельно не нужен: он уже внутри образа интерфейса.
IMAGES=("neo4j:5.26" "$PYTHON_IMAGE" "$VLLM_IMAGE")

# pip download --platform принимает только бинарные колёса, поэтому
# перечислены все теги manylinux, под которыми публикуются нужные пакеты.
case "$TARGET_PLATFORM" in
  linux/amd64) WHEEL_ARCH="x86_64" ;;
  linux/arm64) WHEEL_ARCH="aarch64" ;;
  *) echo "Неизвестная платформа: $TARGET_PLATFORM" >&2; exit 1 ;;
esac

log() { printf '\n==> %s\n' "$*"; }

mkdir -p "$OUT" "$MODELS_DIR"

# --- 1. Колёса Python -------------------------------------------------------
log "Колёса Python под $TARGET_PLATFORM → api/vendor/wheels"
# Качаем во временный каталог и подменяем старый только после успеха: иначе
# сбой docker (демон не запущен, нет сети) оставляет api/vendor/wheels пустым,
# и образ API перестаёт собираться — в том числе в онлайн-режиме.
rm -rf api/vendor/wheels.new
mkdir -p api/vendor/wheels.new
trap 'rm -rf "$ROOT/api/vendor/wheels.new"' EXIT
docker run --rm --platform "$TARGET_PLATFORM" -v "$ROOT/api:/src" "$PYTHON_IMAGE" \
  pip download --quiet --disable-pip-version-check \
    --dest /src/vendor/wheels.new \
    --requirement /src/requirements.txt \
    --platform "manylinux2014_${WHEEL_ARCH}" \
    --platform "manylinux_2_17_${WHEEL_ARCH}" \
    --platform "manylinux_2_28_${WHEEL_ARCH}" \
    --platform "linux_${WHEEL_ARCH}" \
    --python-version 3.12 --implementation cp \
    --abi cp312 --abi abi3 --abi none \
    --only-binary=:all:
(cd api/vendor/wheels.new && ls -1 *.whl | xargs shasum -a 256 > MANIFEST.sha256)
rm -rf api/vendor/wheels
mv api/vendor/wheels.new api/vendor/wheels
echo "колёс: $(ls -1 api/vendor/wheels/*.whl | wc -l | tr -d ' ')"

# --- 2. Образ API без сети --------------------------------------------------
log "Сборка $API_IMAGE с --network none"
docker build --platform "$TARGET_PLATFORM" --network none -t "$API_IMAGE" api/

log "Сборка $WEB_IMAGE (npm ci — нужна сеть)"
docker build --platform "$TARGET_PLATFORM" -t "$WEB_IMAGE" web/

# --- 3. Образы --------------------------------------------------------------
if [[ "${SKIP_IMAGES:-0}" != "1" ]]; then
  for img in "${IMAGES[@]}"; do
    log "docker pull --platform $TARGET_PLATFORM $img"
    docker pull --platform "$TARGET_PLATFORM" "$img"
  done
  log "docker save → $OUT/images.tar"
  # --platform обязателен (Docker 28+): у многоплатформенных образов скачан
  # только вариант под сервер, и без флага save ищет остальные и падает
  # с «content digest … not found».
  docker save --platform "$TARGET_PLATFORM" -o "$OUT/images.tar" \
    "${IMAGES[@]}" "$API_IMAGE" "$WEB_IMAGE"
  printf '%s\n' "${IMAGES[@]}" "$API_IMAGE" "$WEB_IMAGE" > "$OUT/images.list"
fi

# --- 4. Веса модели ---------------------------------------------------------
if [[ "${SKIP_MODEL:-0}" != "1" ]]; then
  if [[ -f "$MODELS_DIR/$VLLM_MODEL_DIR/config.json" ]]; then
    log "Веса уже есть: $MODELS_DIR/$VLLM_MODEL_DIR, пропускаю"
  else
    log "Скачивание $VLLM_MODEL → $MODELS_DIR/$VLLM_MODEL_DIR"
    # huggingface_hub ставится в одноразовый контейнер: на хосте ничего не нужно.
    docker run --rm \
      -e HF_TOKEN="${HF_TOKEN:-}" -e HF_HUB_DISABLE_TELEMETRY=1 \
      -v "$(cd "$MODELS_DIR" && pwd):/models" "$PYTHON_IMAGE" bash -c '
        set -e
        pip install --quiet --disable-pip-version-check "huggingface_hub[cli]"
        hf download "'"$VLLM_MODEL"'" --local-dir "/models/'"$VLLM_MODEL_DIR"'" \
          --exclude "*.pth" --exclude "original/*" --exclude "*.gguf"
      '
  fi
  echo "размер весов: $(du -sh "$MODELS_DIR/$VLLM_MODEL_DIR" | cut -f1)"
fi

# --- 5. Исходники и контрольные суммы -----------------------------------------
log "Исходники → $OUT/goal-checker-src.tar.gz"
tar --exclude='./dist' --exclude='./models' --exclude='./.git' \
    --exclude='./.env' --exclude='./.env.local' --exclude='.DS_Store' --exclude='__pycache__' \
    --exclude='.pytest_cache' --exclude='node_modules' --exclude='./web/dist' \
    --exclude='./web/test-results' --exclude='./web/playwright-report' \
    -czf "$OUT/goal-checker-src.tar.gz" .

cp .env.example "$OUT/.env.example"
cp scripts/offline/install.sh "$OUT/install.sh"
chmod +x "$OUT/install.sh"

cat > "$OUT/MANIFEST.txt" <<EOF
platform:      $TARGET_PLATFORM
model:         $VLLM_MODEL
model_dir:     $VLLM_MODEL_DIR
vllm_image:    $VLLM_IMAGE
api_image:     $API_IMAGE
prepared_at:   $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
(cd "$OUT" && shasum -a 256 images.tar goal-checker-src.tar.gz > SHA256SUMS 2>/dev/null || true)

log "Готово"
cat "$OUT/MANIFEST.txt"
echo
echo "На сервер перенести:"
echo "  $OUT/                     (образы, исходники, install.sh)"
echo "  $MODELS_DIR/$VLLM_MODEL_DIR  (веса модели, отдельно от git)"
