FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/kad-agent.sqlite
ENV HEALTH_HOST=127.0.0.1
ENV HEALTH_PORT=3000
WORKDIR /app

RUN groupadd --system --gid 10001 kad-agent \
  && useradd --system --uid 10001 --gid 10001 --home-dir /app --no-create-home kad-agent \
  && mkdir -p /data \
  && chown -R kad-agent:kad-agent /app /data

COPY --from=dependencies --chown=kad-agent:kad-agent /app/node_modules ./node_modules
COPY --from=build --chown=kad-agent:kad-agent /app/dist ./dist

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HEALTH_PORT || '3000') + '/readyz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]
USER kad-agent
ENTRYPOINT ["node", "dist/index.js"]
