# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    GMOS_SERVE_PORT=4787 \
    GMOS_SERVE_KEYS=1 \
    GMOS_SERVE_RATE_LIMIT=600 \
    GMOS_SERVE_ALLOW_NON_LOOPBACK=1
WORKDIR /app
COPY package.json README.md SECURITY.md ./
COPY docs ./docs
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/gmos-docker-entrypoint
RUN chmod +x /usr/local/bin/gmos-docker-entrypoint /app/dist/cli/gmos.js \
  && ln -s /app/dist/cli/gmos.js /usr/local/bin/gmos \
  && mkdir -p /data \
  && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 4787
ENTRYPOINT ["gmos-docker-entrypoint"]
