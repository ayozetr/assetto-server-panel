# Installation & Configuration

## Requirements

| Tool | Version |
|------|---------|
| Node.js | **20.20.2** |
| npm | **11.13.0** |

Both are managed with [nvm](https://github.com/nvm-sh/nvm).

### Installing nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc   # or: source ~/.zshrc

nvm install 20.20.2
nvm use 20.20.2
npm install -g npm@11.13.0
```

---

## Installation steps

### 1. Clone the repository

```bash
git clone https://github.com/ayozetr/assetto-dashboard.git
cd assetto-dashboard
```

### 2. Select the correct Node.js version

```bash
nvm use 20.20.2
```

### 3. Install dependencies

```bash
npm install
```

This installs:
- `better-sqlite3` — database
- `dotenv` — environment config
- `node-stream-zip` — ZIP extraction
- `node-unrar-js` — RAR extraction
- `node-7z` + `7zip-bin` — 7z extraction

### 4. Create the environment file

```bash
cp .env.example .env
```

Edit `.env` with the paths specific to your server installation (see [Environment variables](#environment-variables) below).

### 5. Start the server

```bash
npm start
```

`npm start` first runs `node build.js` (esbuild transpiles `src/*.jsx` to `dist/*.js` in ~20 ms) and then launches the HTTP server. To skip the rebuild for a quick restart, run `node server.js` directly — but only if `dist/` is already up to date.

Expected output:

```
  ────────────────────────────────────────────
    Assetto Server Panel
  ────────────────────────────────────────────
    Local    →  http://localhost:3000
    Network  →  http://<LOCAL-IP>:3000
  ────────────────────────────────────────────
```

Open the **Network** URL from any device on the same network. On first start, the default `Admin` user is seeded into the database automatically.

---

## Environment variables

All configuration lives in `.env` at the project root. This file is never committed to git.

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to restrict to localhost only. |
| `PORT` | `3000` | TCP port the web server listens on. |
| `AC_SERVER_LOG` | `<project>/logs/ac_server.log` | Path where the AC server log is written. The dashboard creates this file when it spawns the AC process. |
| `AC_SERVER_RESULTS` | *(required)* | Directory containing AC result JSON files (e.g. `/home/user/ac_server/results`). |
| `AC_CFG_DIR` | *(required)* | Directory containing `server_cfg.ini` (e.g. `/home/<user>/ac_server/cfg`). |
| `AC_CONTENT_DIR` | *(required)* | Root AC content directory. Must contain `cars/` and `tracks/` subdirectories (e.g. `/home/<user>/ac_server/content`). |
| `AC_SERVER_BIN` | *(required)* | Full path to the `acServer` binary. |
| `AC_SERVER_DIR` | `dirname(AC_SERVER_BIN)` | Working directory when spawning the AC process. Defaults to the folder containing the binary. |
| `AC_HTTP_PORT` | `8081` | AC HTTP API port. Must match `HTTP_PORT` in `server_cfg.ini`. Used for server detection and live player data. |
| `AC_BLACKLIST_FILE` | `<AC_SERVER_DIR>/blacklist.txt` | Path to the ban list file. |
| `AC_WHITELIST_FILE` | `<AC_CFG_DIR>/whitelist.txt` | Path to the whitelist file. |
| `DB_PATH` | `<project>/assetto.db` | SQLite database file path. Created automatically on first run. |
| `PUBLIC_IP` | *(empty)* | Optional. Public IP shown in the Dashboard join link. If not set, resolved automatically via `api.ipify.org`. |
| `ADMIN_TOKEN` | *(empty)* | Optional static bearer token for headless/script access to protected endpoints. |
| `TRUST_PROXY` | `0` | Set to `1` only when the panel is reachable **exclusively** through a reverse proxy (Cloudflare Tunnel, nginx, etc.). Honours `CF-Connecting-IP` / `X-Forwarded-For` so rate limits and audit log see the real client IP. Leave unset if the panel is also reachable directly — clients can spoof those headers. |
| `AUDIT_RETENTION_DAYS` | `365` | How many days of `audit_log` entries to keep. A daily sweeper deletes older rows. |
| `CFG_BACKUPS_KEEP` | `10` | How many timestamped `server_cfg.ini.<datetime>.bak` rotations to retain. The single legacy `server_cfg.ini.bak` (last save) is always kept on top of these. |

### Minimal `.env` example

```env
AC_SERVER_RESULTS=/home/user/ac_server/results
AC_CFG_DIR=/home/user/ac_server/cfg
AC_CONTENT_DIR=/home/user/ac_server/content
AC_SERVER_BIN=/home/user/ac_server/acServer
AC_HTTP_PORT=8081
```

---

## First login

Open the panel in your browser and log in with:

- **Username:** `Admin`
- **Password:** `Admin1234!`

After authenticating, the panel **forces** a password change in a blocking modal — the rest of the UI is unreachable (server-side gate, not just UI) until you set a new password. This is by design: the seeded credentials are well-known.

If you ever lock yourself out (e.g. forget the new password before clearing the flag), open the SQLite DB and run:

```sql
UPDATE panel_users SET must_change_password = 0 WHERE username = 'Admin';
```

then log in normally and use the **Reset password** flow.
