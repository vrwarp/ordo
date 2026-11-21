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
# Fonts (design/27 §10): metric-compatible substitutes (Carlito, Caladea, Liberation), the Noto script
# fallbacks and Inter. The hub registers them as bundled library fonts (ORDO_FONTS_DIR) and LibreOffice draws
# with the same files. They are SIL OFL 1.1; DejaVu, a general fallback face that is not served, is under the
# Bitstream Vera licence (apps/hub/src/fonts/LICENSES.md). Every package's copyright file stays in
# /usr/share/doc, not only the fonts' (the last command of this RUN).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg poppler-utils libreoffice-impress chromium tini ca-certificates \
      fonts-dejavu fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core fonts-inter \
 && rm -rf /var/lib/apt/lists/* /usr/share/man/* \
 && find /usr/share/doc -mindepth 2 -type f ! -name copyright ! -path '/usr/share/doc/fonts-*' -delete \
 && find /usr/share/doc -mindepth 1 -type d -empty -delete
# The licence notices (OQ-FU2): the copyright file of every package the image installs stays, as Debian ships it
# (ffmpeg, Chromium, LibreOffice, poppler and tini as much as the fonts). What goes is every other file in
# /usr/share/doc (changelogs, examples; the fonts' folders are left as they are) and the folders left empty;
# a link to another package's folder stays. The pull-request job lists the packages without a notice.
# Chinese, Japanese and Korean (design/27 §10): the Sans collections of fonts-noto-cjk (Noto Sans CJK, SIL OFL
# 1.1, apps/hub/src/fonts/LICENSES.md), for LibreOffice and for the hub's measuring of table cells in those
# scripts (apps/hub/src/pptx/systemFaces.ts). Never a library font and never sent to a screen. The dpkg rule
# leaves out its Serif collections (54 MB): LibreOffice then draws serif CJK font names with the Sans face, and
# where fontconfig asks for a Serif family that is not there (SimSun, or a serif with Chinese or Korean text) it
# takes the collection's first face, so some Chinese and Korean characters show their Japanese forms. The rule is
# removed at the end of the same RUN, so the published image keeps no dpkg rule of ours (a later install of the
# package gets the Serif collections). Its copyright file stays in /usr/share/doc/fonts-noto-cjk.
RUN echo 'path-exclude=/usr/share/fonts/opentype/noto/NotoSerifCJK-*' > /etc/dpkg/dpkg.cfg.d/ordo-noto-cjk-sans \
 && apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && rm /etc/dpkg/dpkg.cfg.d/ordo-noto-cjk-sans
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
    ORDO_IMPORT_ROOTS=/data/import:/import \
    ORDO_CHROMIUM=/usr/bin/chromium \
    ORDO_FONTS_DIR=/usr/share/fonts
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ORDO_PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# tini reaps and forwards SIGTERM to the supervisor (main.js), which runs the live and library processes
# (design/12 "Processes", design/22 "Processes in the container").
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/apps/hub/dist/main.js"]
