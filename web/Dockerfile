# Образ интерфейса: собранная статика в nginx.
#
# Сборка идёт только на машине с интернетом (scripts/offline/prepare.sh или
# compose с docker-compose.online.yml): npm ci берёт пакеты из реестра по
# package-lock.json. На сервер без интернета попадает готовый образ из
# images.tar — ни node, ни npm там не нужны.

FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------

FROM nginx:1.27-alpine

# Адрес внешнего прокси, чьему X-Forwarded-For можно верить (см. шаблон).
# Значение по умолчанию безвредно: сам контейнер себе запросов не шлёт.
ENV TRUSTED_PROXY=127.0.0.1

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
