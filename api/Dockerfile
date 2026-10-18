# Сборка без доступа в интернет.
#
# Зависимости ставятся из заранее скачанных колёс в vendor/wheels
# (см. scripts/offline/prepare.sh), pip к PyPI не обращается: PIP_NO_INDEX=1
# делает любое такое обращение ошибкой сборки, а не тихим фолбэком.
# Нужен только базовый образ python:3.12-slim, он входит в офлайн-набор.

FROM python:3.12-slim AS deps

ENV PIP_NO_INDEX=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt /wheels/requirements.txt
COPY vendor/wheels/ /wheels/

RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --find-links=/wheels -r /wheels/requirements.txt

# ---------------------------------------------------------------------------

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/opt/venv/bin:$PATH

WORKDIR /app

COPY --from=deps /opt/venv /opt/venv

# Приложение — плоский набор модулей. Копируем только их: колёса и тесты
# в рабочем образе не нужны. Новый подкаталог с кодом нужно добавить сюда.
COPY *.py ./

# Контейнер не должен работать от root.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

# В образе нет curl, поэтому проверяем эндпоинт средствами Python.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4).status == 200 else sys.exit(1)"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
