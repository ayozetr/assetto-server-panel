# syntax=docker/dockerfile:1.6
# ───────────────────────────────────────────────────────────────────────────────
# Assetto Server Panel — multi-stage Dockerfile
#
# Stage 1 (builder): install deps + run the JSX → /dist transpile step.
# Stage 2 (runtime): copies only the production artefacts and node_modules. No
# dev-deps (esbuild) ship in the runtime image.
#
# Build:
#   docker build -t assetto-panel .
#
# Run (standalone):
#   docker run -d --name assetto-panel \
#     -p 3000:3000 \
#     -v /home/YOUR_USER/ac_server/cfg:/home/YOUR_USER/ac_server/cfg \
#     -v /home/YOUR_USER/ac_server/content:/home/YOUR_USER/ac_server/content \
#     -v assetto-panel-db:/data \
#     -e DB_PATH=/data/assetto.db \
#     -e HOST=0.0.0.0 \
#     assetto-panel
#
# Or use docker-compose.yml for a config-as-code setup that mounts your
# server_cfg.ini + content tree and persists the DB to a named volume.
# ───────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=22

# ── Builder ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS builder

WORKDIR /app

# Install build toolchain (better-sqlite3 native bindings + node-gyp). Slim
# image strips these — we add them only in the builder layer; the runtime
# layer reuses the compiled node_modules so it stays slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Lockfile first → cache npm ci across source changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Source tree + build the dist/ bundle.
COPY . .
RUN NODE_ENV=production node build.js

# Strip dev-deps from node_modules now that the build is done. Runtime never
# needs esbuild again — prestart in production runs build.js once but if you
# want to skip that too, set SKIP_BUILD=1 and the runtime image trusts the
# pre-built dist/.
RUN npm prune --omit=dev

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    SKIP_BUILD=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/assetto.db

WORKDIR /app

# 7zip-bin ships its own static binary, but node-7z spawns `7za` via PATH on
# some flows. Install the system 7zip + unrar fallback so mod extraction never
# fails inside the container due to a missing binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends p7zip-full ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -r panel && useradd -r -g panel -d /app -s /usr/sbin/nologin panel

COPY --from=builder --chown=panel:panel /app/server.js     ./server.js
COPY --from=builder --chown=panel:panel /app/build.js      ./build.js
COPY --from=builder --chown=panel:panel /app/lib           ./lib
COPY --from=builder --chown=panel:panel /app/package.json  ./package.json
COPY --from=builder --chown=panel:panel /app/index.html    ./index.html
COPY --from=builder --chown=panel:panel /app/manifest.webmanifest ./manifest.webmanifest
COPY --from=builder --chown=panel:panel /app/sw.js         ./sw.js
COPY --from=builder --chown=panel:panel /app/src           ./src
COPY --from=builder --chown=panel:panel /app/dist          ./dist
COPY --from=builder --chown=panel:panel /app/node_modules  ./node_modules

# Persistent state lives outside the image so `docker rm` doesn't wipe it.
# Mount a host path or named volume at /data.
RUN mkdir -p /data /app/logs && chown -R panel:panel /data /app/logs

USER panel
EXPOSE 3000

# Bind-mounted secrets: docker-compose passes the host's server_cfg.ini and
# content dir read-write. The panel writes to them.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3000}/api/health || exit 1

# tini reaps zombies if the panel spawns acServer as a child — without it the
# acServer process would zombie on every panel restart.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
