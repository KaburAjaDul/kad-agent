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

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:f987682b3ea8d8e22497cb95edc5014d793612f7064e43df8104394db0ce19fe AS runtime

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/kad-agent.sqlite
ENV HEALTH_HOST=127.0.0.1
ENV HEALTH_PORT=3000
WORKDIR /app

COPY --from=dependencies --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist

# Distroless has no package manager or shell. Use its own Node binary once at
# build time (as root) to provision the persistent directory for the numeric
# runtime UID; the final image configuration remains non-root.
USER 0
RUN ["/nodejs/bin/node", "-e", "const fs = require('node:fs'); fs.mkdirSync('/data', { recursive: true }); fs.chownSync('/data', 10001, 10001)"]

VOLUME ["/data"]
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:' + (process.env.HEALTH_PORT || '3000') + '/readyz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]
USER 10001:10001
ENTRYPOINT ["/nodejs/bin/node", "dist/index.js"]
