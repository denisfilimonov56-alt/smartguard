# Зависимости ставятся с PyPI строго по requirements.lock: все пакеты, включая
# транзитивные, с версиями и sha256 (--require-hashes). Подменённый или битый
# файл — ошибка сборки; --no-deps не даёт pip добрать что-то сверх lock,
# --only-binary — собрать пакет из исходников (компилятора в slim-образе нет).
# Сеть нужна только при сборке — она часть релиза (docs/release.md);
# работающему контейнеру интернет не нужен.
#
# Базовый образ закреплён по digest: тег со временем указывает на другие
# сборки. Обновлять осознанно: docker buildx imagetools inspect python:3.12-slim.

ARG PYTHON_IMAGE=python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

FROM ${PYTHON_IMAGE} AS deps

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.lock /tmp/requirements.lock

RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --require-hashes --no-deps --only-binary=:all: \
      -r /tmp/requirements.lock \
 && /opt/venv/bin/pip check

# ---------------------------------------------------------------------------

FROM ${PYTHON_IMAGE}

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/opt/venv/bin:$PATH

WORKDIR /app

COPY --from=deps /opt/venv /opt/venv

# Приложение — плоский набор модулей. Копируем только их: тесты
# в рабочем образе не нужны. Новый подкаталог с кодом нужно добавить сюда.
COPY *.py ./

# Контейнер не должен работать от root. Каталог журнала аудита создаётся
# заранее и принадлежит appuser: именованный том api_audit при первом
# подключении наследует эти права.
RUN useradd --create-home --uid 10001 appuser \
 && mkdir -p /data/audit \
 && chown -R appuser:appuser /app /data/audit
USER appuser

EXPOSE 8080

# В образе нет curl, поэтому проверяем эндпоинт средствами Python.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4).status == 200 else sys.exit(1)"

# При остановке uvicorn даёт идущим запросам 45 с доработать (история
# проверок успевает записаться), затем выходит сам — раньше, чем docker
# пришлёт SIGKILL по stop_grace_period: 60s из compose.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--timeout-graceful-shutdown", "45"]
