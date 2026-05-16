# Docker

Containerised deployment of the Assetto Server Panel. This is the shortest path from a fresh host to a running panel: install Docker, edit a four-line `.env`, run one command.

> **acServer is not in the container.** The panel's Docker image bundles only the panel itself plus its native build toolchain. The Assetto Corsa Dedicated Server (`acServer`) runs on the host (or in a separate container). The panel reaches `acServer` over `127.0.0.1:${AC_HTTP_PORT}` and writes to its `cfg/` and `content/` dirs through bind mounts — see [Networking](#networking) and [Volumes](#volumes) below.

---

## Prerequisites

- **Docker Engine 24+** (older versions work but the BuildKit syntax in the `Dockerfile` assumes a recent builder).
- **Docker Compose v2** (the `docker compose ...` subcommand, not the legacy `docker-compose` binary).
- A host that already runs `acServer` (or where you plan to), with its `cfg/` and `content/` directories accessible to the user that owns the Docker daemon.

Verify both with:

```bash
docker --version              # Docker version 24+
docker compose version        # Docker Compose version v2+
```

---

## Quick start (3 steps)

```bash
git clone https://github.com/ayozetr/assetto-server-panel.git
cd assetto-server-panel
cp .env.example .env          # edit the four AC_* paths to point at your acServer
docker compose up -d
```

That's the whole setup. After `docker compose up -d` returns, open `http://localhost:3000` — the default credentials are `Admin` / `Admin1234!` and the first login forces a password change.

To follow the boot output:

```bash
docker compose logs -f panel
```

You should see the migration ✓ lines, `Database ready`, `[UDP] listening on 127.0.0.1:12001`, the banner, and the AC paths health check.

---

## How the image is built

The `Dockerfile` is a **two-stage** build (`builder` + `runtime`):

### Stage 1 — builder

- Starts from `node:${NODE_VERSION}-bookworm-slim` (default `20.20.2`, override with `--build-arg NODE_VERSION=...`).
- Installs `python3`, `make`, `g++` so `better-sqlite3`'s native bindings can compile from source if `prebuild-install` cannot find a matching prebuilt binary.
- Runs `npm ci --no-audit --no-fund` against the **pinned `package-lock.json`** — refuses to install anything that isn't already in the lockfile, so the image content is byte-for-byte reproducible from the same commit.
- Runs `NODE_ENV=production node build.js` to transpile JSX into `dist/` and emit a minified bundle.
- Runs `npm prune --omit=dev` so `esbuild` and the rest of the dev-only deps don't ship to runtime.

### Stage 2 — runtime

- Same base image (`node:20-bookworm-slim`).
- Installs only `p7zip-full` (so `node-7z`'s `7za` binary works), `ca-certificates` (for HTTPS to api.ipify.org / Discord / unpkg-SRI checks), `curl` (the healthcheck calls `/api/health` over loopback), and `tini` (PID 1 zombie reaper).
- Creates a non-root user `panel` (UID/GID auto-assigned by `useradd -r`) and chowns the app dir to it.
- Copies the runtime artefacts from the builder stage: `server.js`, `build.js`, `package.json`, `index.html`, `manifest.webmanifest`, `sw.js`, `src/`, `dist/`, `node_modules/`.
- Declares two writable mount points under the `panel` user: `/data` (the SQLite DB) and `/app/logs` (the panel + acServer log mirror).
- Wires a Docker `HEALTHCHECK` to `curl -fsS http://127.0.0.1:3000/api/health`, polled every 30 s.
- Sets `tini` as the entrypoint and `node server.js` as the command. tini reaps any orphaned child the panel may spawn (notably, an adopted `acServer` if you ever run it from inside the same container — not recommended, but possible).

Build the image manually with:

```bash
docker build -t assetto-panel:latest .
# or pin a Node minor:
docker build --build-arg NODE_VERSION=20.20.2 -t assetto-panel:latest .
```

The `.dockerignore` mirrors `.gitignore` so the build context stays small (`node_modules`, `dist`, `.git`, `local-cfg`, `*.db`, `.env`, scratch files all excluded). A clean build context is ~3 MB.

---

## Environment variables

`docker-compose.yml` reads your host's `.env` via `env_file: .env`. The full list lives in `.env.example`; the values most relevant to a containerised deployment are:

| Variable | Default in Docker | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` *(overridden by compose)* | Inside the container the panel listens on all interfaces; the host port mapping is the only thing that decides reachability (see [Networking](#networking)). |
| `PORT` | `3000` | The port inside the container. Map to a different host port in `docker-compose.yml` if `3000` is taken on the host. |
| `DB_PATH` | `/data/assetto.db` | Set by the compose file so the DB lives on the `panel-data` named volume. |
| `AC_SERVER_LOG` | `/app/logs/ac_server.log` | Inside the `panel-logs` named volume. |
| `AC_CFG_DIR` | `${AC_CFG_DIR:-/home/YOUR_USER/ac_server/cfg}` | Host path bind-mounted at the same location inside the container. |
| `AC_CONTENT_DIR` | `${AC_CONTENT_DIR:-/home/YOUR_USER/ac_server/content}` | Same. |
| `AC_SERVER_BIN` / `AC_SERVER_DIR` | `${...}` | The panel needs to be able to `spawn()` `acServer` if you use the start/stop buttons. If `acServer` lives on the host and you don't want the container to launch it, set these to a valid-looking path inside the container and operate `acServer` independently. |
| `AC_HTTP_PORT` | `8081` | The panel polls `127.0.0.1:${AC_HTTP_PORT}/INFO` to detect `acServer` — that's loopback **inside the container**, which means `acServer` must also live in the same container *or* you must use `network_mode: host`. See [Running acServer alongside](#running-acserver-alongside-the-panel). |
| `TRUST_PROXY` | unset | Set to `1` when you put a reverse proxy / Cloudflare Tunnel in front. Also set `TRUST_PROXY_FROM` to the CIDR ranges of your proxy if it isn't Cloudflare. |
| `BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP`, `BACKUP_DIR` | unset | Opt-in. When set, the panel takes a VACUUM-INTO snapshot of `assetto.db` every interval and keeps the newest `BACKUP_KEEP` files in `BACKUP_DIR`. Mount `BACKUP_DIR` to a host path or a third named volume if you want the snapshots to survive a `docker compose down -v`. |

---

## Volumes

The compose file declares two **named volumes** and two **bind mounts**:

```yaml
volumes:
  - ${AC_CFG_DIR:-/home/YOUR_USER/ac_server/cfg}:${AC_CFG_DIR:-/home/YOUR_USER/ac_server/cfg}:rw      # bind
  - ${AC_CONTENT_DIR:-/home/YOUR_USER/ac_server/content}:${AC_CONTENT_DIR:-/home/YOUR_USER/ac_server/content}:rw   # bind
  - panel-data:/data          # named volume
  - panel-logs:/app/logs      # named volume
```

| Mount | Type | Purpose |
|---|---|---|
| `${AC_CFG_DIR}` (host) → same path inside container | bind | `server_cfg.ini`, `entry_list.ini`, `whitelist.txt`, the rotating `.bak` backups the panel writes when you save. Bind-mount so edits made via the panel UI land in the **real** files `acServer` reads. The in-container path mirrors the host path so log lines + audit entries reference the same string in both worlds. |
| `${AC_CONTENT_DIR}` (host) → same path inside container | bind | `cars/` + `tracks/` directories. The mod upload pipeline extracts new mods directly into these on the host. |
| `panel-data` → `/data` | named volume | The SQLite DB (`assetto.db`) + WAL files. Named volume so `docker compose down` does NOT wipe player history, audit log, or sessions. `docker volume rm assetto-server-panel_panel-data` is the only way to delete the DB. |
| `panel-logs` → `/app/logs` | named volume | `ac_server.log` mirror written by `appendLog`. |

> **Permissions trap.** The container runs as the non-root `panel` user (`useradd -r`). If the host's `${AC_CFG_DIR}` is owned by a different UID (typical: your interactive user owns `~/ac_server/cfg`), the panel won't be able to write `server_cfg.ini` and saves will fail with `EACCES`. Two ways out:
> 1. **`chown -R` the host dir** to a UID/GID that matches the in-container `panel` user. Run `docker compose exec panel id` to find the in-container UID (usually `999:999`), then `sudo chown -R 999:999 /path/to/ac_server/cfg /path/to/ac_server/content` on the host.
> 2. **Add the container user to the host's existing group**. Set `user: "${UID}:${GID}"` in `docker-compose.yml` with `UID` and `GID` exported in `.env` to match your interactive user (`id -u` / `id -g`). The container loses its hardened `panel` user but gains seamless write access.

The named volumes live under `/var/lib/docker/volumes/assetto-server-panel_panel-{data,logs}/_data` on the host by default. Inspect with `docker volume inspect assetto-server-panel_panel-data`.

---

## Networking

By default the compose file publishes port `3000` to **loopback only**:

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

That means:

- The panel is reachable from the host at `http://localhost:3000`.
- The panel is **not** reachable from the LAN (someone on the same Wi-Fi cannot hit `http://<host-ip>:3000`).
- You're expected to put a reverse proxy or a Cloudflare Tunnel in front for remote access.

### Reverse-proxy front-end

Examples for Nginx, Caddy, and Cloudflare Tunnel:

**Nginx** (host-level):
```nginx
server {
  listen 443 ssl;
  server_name panel.example.com;
  ssl_certificate ...;
  ssl_certificate_key ...;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 3600;     # SSE keepalive
  }
}
```

**Caddy** (one-liner Caddyfile):
```
panel.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

**Cloudflare Tunnel** (`cloudflared` running on the host):
```yaml
ingress:
  - hostname: panel.example.com
    service: http://localhost:3000
  - service: http_status:404
```

When using any of these, set `TRUST_PROXY=1` in `.env` so the panel honours the forwarded-IP headers (with the built-in Cloudflare CIDR allowlist by default; override with `TRUST_PROXY_FROM=10.0.0.0/8,127.0.0.0/8` for nginx/Caddy).

### Exposing the panel directly to the LAN

Edit `docker-compose.yml`:

```yaml
ports:
  - "3000:3000"        # was: "127.0.0.1:3000:3000"
```

`docker compose up -d` again. The panel is now reachable on every host interface. **Do not combine `0.0.0.0` exposure with `TRUST_PROXY=1`** unless you also lock down LAN access at the firewall — without a real proxy in front, any LAN client can spoof `CF-Connecting-IP` to bypass per-IP rate limits.

---

## Running `acServer` alongside the panel

The panel reaches `acServer`'s HTTP API on `127.0.0.1:${AC_HTTP_PORT}`. Inside Docker, `127.0.0.1` is the container's own loopback — **not** the host's. Three deployment shapes:

### A. acServer on the host, panel in Docker

The cleanest separation. Add `network_mode: host` (or use Linux's `host.docker.internal`) so the panel's loopback sees the host's `acServer`:

```yaml
services:
  panel:
    network_mode: host   # the panel binds 0.0.0.0:3000 directly on the host
```

Or, on Docker Desktop / Mac / Windows, replace the `AC_HTTP_PORT` callsites' implicit `127.0.0.1` with `host.docker.internal` — but the panel hardcodes `127.0.0.1`, so on Linux the practical answer is `network_mode: host`.

### B. acServer in a separate container

Run `acServer` in its own container with the same volumes mounted, and either share `network_mode: container:acserver` or set up a Docker network where the panel can reach `acserver:8081`. (You'll need to patch `AC_HTTP_HOST` if you go that route — the panel hardcodes `127.0.0.1` today, so this needs a local fork tweak.)

### C. Both in the same container

Discouraged. The panel image is intentionally minimal — no acServer binary, no Wine, no compiled-from-source build path. Bundling them together throws away the isolation that's the whole point of containerising in the first place.

**The default `docker-compose.yml` does NOT set `network_mode: host`.** If you want the panel to manage an acServer process running on the host (start/stop/restart buttons), add it.

---

## Day-to-day operations

```bash
# Tail logs (follow mode, --tail to limit history)
docker compose logs -f panel
docker compose logs --tail=200 panel

# Restart the panel without recreating the container
docker compose restart panel

# Recreate the container with current image (e.g. after env changes)
docker compose up -d

# Shell inside the running container (read-only inspection)
docker compose exec panel sh

# Run the smoke test from inside (uses /tmp for the throwaway DB)
docker compose exec panel npm test

# Run the supply-chain audit from inside
docker compose exec panel npm run audit:deps

# Open a SQLite shell against the live DB
docker compose exec panel sqlite3 /data/assetto.db
```

### Updating

```bash
cd assetto-server-panel
git pull
docker compose build --pull        # --pull refreshes the base node:20 image
docker compose up -d               # recreates the container with the new image
```

Migrations run on container start (the runner is in `server.js`). The `panel-data` volume keeps the DB across the rebuild — no data loss.

### Backups

The opt-in scheduled-backup feature works inside Docker too, but make sure `BACKUP_DIR` points somewhere persistent. Either reuse the `panel-data` volume (`BACKUP_DIR=/data/backups` — the panel creates the dir) or mount a host directory:

```yaml
volumes:
  - /var/backups/assetto-panel:/backups:rw
environment:
  BACKUP_INTERVAL_HOURS: "24"
  BACKUP_KEEP: "30"
  BACKUP_DIR: "/backups"
```

For a one-shot manual backup:

```bash
docker compose exec panel sqlite3 /data/assetto.db ".backup /data/manual-$(date +%F).db"
docker compose cp panel:/data/manual-$(date +%F).db ./
```

Or use the panel's UI **Admin → Backup** button — it returns a downloadable `.db` file straight to your browser.

### Removing everything

```bash
# Stop and remove the container
docker compose down

# ...and the volumes (WIPES THE DB AND LOGS — there is no undo)
docker compose down -v

# ...and the image
docker rmi assetto-panel:latest
```

---

## Security posture in a container

The compose file adds belt-and-braces hardening on top of the application-level defences described in `SECURITY.md`:

```yaml
cap_drop: [ALL]
cap_add:
  - CHOWN          # write to bind-mounted host dirs
  - DAC_OVERRIDE
  - SETUID
  - SETGID
security_opt:
  - no-new-privileges:true
```

The dropped capabilities mean a kernel-level escape would still struggle to do anything useful (no raw network, no module loading, no debug privileges). `no-new-privileges` prevents any setuid binary inside the image from elevating.

If you want tighter sandboxing:

- Add `read_only: true` and explicitly mount `/tmp` as a `tmpfs` (the panel writes chunk uploads there during streaming).
- Add `mem_limit: 512m` and `pids_limit: 256` so a runaway mod extraction can't OOM-kill the host.
- Run behind a `seccomp` profile (Docker's default profile already blocks ~50 syscalls).

---

## Healthcheck

Each container declares:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3000}/api/health || exit 1
```

`docker ps` will show `(healthy)` / `(unhealthy)` next to the container. Orchestrators like Portainer, Komodo, Dockge, or Kubernetes will route around an unhealthy container. The `start-period` of 10 s gives the panel time to run migrations + open the SQLite DB before the first health probe fires.

If you want to check programmatically:

```bash
docker inspect --format='{{json .State.Health}}' assetto-panel
```

---

## Troubleshooting

### "Cannot find module 'better-sqlite3'"

The builder stage failed to compile the native binding. Almost always because the base image's CPU architecture mismatches the prebuilt binary `prebuild-install` tried to download. Force a rebuild without prebuilts:

```bash
docker compose build --no-cache --build-arg NPM_CONFIG_BUILD_FROM_SOURCE=true
```

### Panel boots but every save returns `EACCES`

Host-dir permissions. See the [Permissions trap](#volumes) note above. The fastest fix is `sudo chown -R $(docker compose exec panel id -u):$(docker compose exec panel id -g) /path/to/ac_server/cfg /path/to/ac_server/content`.

### Port 3000 is already taken on the host

Edit `docker-compose.yml`:
```yaml
ports:
  - "127.0.0.1:3030:3000"     # host:container
```
And open `http://localhost:3030` instead. The in-container port stays `3000`.

### "Operation not permitted" trying to mount `${AC_CFG_DIR}`

Selinux. Either add `:z` to the mount (`${AC_CFG_DIR}:${AC_CFG_DIR}:rw,z`) to relabel the host dir, or temporarily set the container's SELinux label to `disabled` for testing:

```yaml
security_opt:
  - label=disable
```

### The healthcheck keeps reporting unhealthy

The `start-period` may be too short if your host's I/O is slow (NAS over NFS, etc.). Bump it:

```yaml
healthcheck:
  start_period: 30s
```

### Logs say `migration NNN failed`

Something with the bind-mounted host data the panel cannot reconcile (e.g. an existing `assetto.db` on a foreign volume that doesn't match the migration runner's expectations). Inspect:

```bash
docker compose exec panel sqlite3 /data/assetto.db "SELECT * FROM schema_migrations"
```

Compare against the list in `server.js`. If a migration is stuck, fix the data manually and restart — the runner retries on every boot until it succeeds (failed migrations are NOT recorded).

---

## When to NOT use Docker

- **You already run the panel under systemd and it works.** Migrating an existing install to Docker means a one-time `cp -r` of `assetto.db` into a named volume and adjusting your reverse-proxy / firewall — it's friction for no benefit. Stay on systemd; the `docs/deployment.md` Systemd section still applies.
- **You want the panel to manage `acServer` directly via start/stop buttons.** This is possible inside the container (see [option C](#running-acserver-alongside-the-panel)) but it throws away the container isolation. Run the panel and `acServer` separately on the host instead.
- **Your hosting environment forbids Docker.** Some shared VPS plans do. The systemd path works fine on any modern Linux with Node 20+.

---

## Reference: `docker-compose.yml` highlights

```yaml
services:
  panel:
    build:
      context: .
      dockerfile: Dockerfile
    image: assetto-panel:latest
    container_name: assetto-panel
    restart: unless-stopped
    env_file: [.env]
    environment:
      HOST: 0.0.0.0
      DB_PATH: /data/assetto.db
      AC_SERVER_LOG: /app/logs/ac_server.log
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - ${AC_CFG_DIR:-/home/YOUR_USER/ac_server/cfg}:${AC_CFG_DIR:-/home/YOUR_USER/ac_server/cfg}:rw
      - ${AC_CONTENT_DIR:-/home/YOUR_USER/ac_server/content}:${AC_CONTENT_DIR:-/home/YOUR_USER/ac_server/content}:rw
      - panel-data:/data
      - panel-logs:/app/logs
    cap_drop: [ALL]
    cap_add: [CHOWN, DAC_OVERRIDE, SETUID, SETGID]
    security_opt: [no-new-privileges:true]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  panel-data:
  panel-logs:
```

For the full file with comments, see [`docker-compose.yml`](../docker-compose.yml) at the repo root.
