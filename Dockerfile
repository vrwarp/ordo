# syntax=docker/dockerfile:1.7
# ordo hub image: the Node hub plus the built operator, output and stage apps (design/22).

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# Toolchain only for native modules without a prebuilt binary (better-sqlite3, argon2).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/hub/package.json apps/hub/
COPY apps/operator/package.json apps/operator/
COPY apps/output/package.json apps/output/
COPY apps/stage/package.json apps/stage/
COPY apps/demo/package.json apps/demo/
COPY packages ./packages
COPY tools/soak/package.json tools/soak/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r --filter "./apps/*" build
# Production node_modules for the hub (native deps are external to the bundle).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @ordo/hub deploy --prod --legacy /out/hub

FROM node:22-bookworm-slim AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="ordo-hub" org.opencontainers.image.version=$VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg poppler-utils libreoffice-impress fonts-dejavu fonts-liberation2 tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/*
WORKDIR /app
COPY --from=build --chown=node:node /out/hub/node_modules /app/apps/hub/node_modules
COPY --from=build --chown=node:node /src/apps/hub/package.json /app/apps/hub/package.json
COPY --from=build --chown=node:node /src/apps/hub/dist /app/apps/hub/dist
COPY --from=build --chown=node:node /src/apps/operator/dist /app/apps/operator/dist
COPY --from=build --chown=node:node /src/apps/output/dist /app/apps/output/dist
COPY --from=build --chown=node:node /src/apps/stage/dist /app/apps/stage/dist
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    ORDO_DATA=/data \
    ORDO_APPS_DIR=/app/apps \
    ORDO_PORT=8080 \
    ORDO_HOST=0.0.0.0 \
    ORDO_IMPORT_ROOTS=/data/import:/import
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ORDO_PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# tini reaps and forwards SIGTERM to the supervisor (main.js), which runs the live and library processes
# (design/12 "Processes", design/22 "Processes in the container").
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/apps/hub/dist/main.js"]
