# Образ интерфейса: собранная статика в nginx.
#
# Сборке нужна сеть: npm ci берёт пакеты из реестра по package-lock.json.
# На сервере образ собирается при релизе (docs/release.md); в контейнере
# только nginx со статикой — ни node, ни npm, ни интернет не нужны.
#
# Базовые образы закреплены по digest (индекс всех платформ): тег node:22 или
# nginx:1.27 со временем указывает на другие сборки, а digest — нет. Обновлять
# осознанно: docker buildx imagetools inspect <образ:тег> → новый digest.

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

# Адрес внешнего прокси, чьему X-Forwarded-For можно верить (см. шаблон).
# Значение по умолчанию безвредно: сам контейнер себе запросов не шлёт.
ENV TRUSTED_PROXY=127.0.0.1

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY security-headers.inc.template /etc/nginx/templates/security-headers.inc.template
# Origin Keycloak для CSP вычисляется из KEYCLOAK_URL при старте контейнера.
COPY --chmod=755 docker-entrypoint.d/16-keycloak-csp.envsh /docker-entrypoint.d/
COPY --from=build /app/dist /usr/share/nginx/html
