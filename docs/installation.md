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
| `AC_CFG_DIR` | *(required)* | Directory containing `server_cfg.ini` (e.g. `/srv/assetto/cfg`). |
| `AC_CONTENT_DIR` | *(required)* | Root AC content directory. Must contain `cars/` and `tracks/` subdirectories. |
| `AC_SERVER_BIN` | *(required)* | Full path to the `acServer` binary. |
| `AC_SERVER_DIR` | `dirname(AC_SERVER_BIN)` | Working directory when spawning the AC process. Defaults to the folder containing the binary. |
| `AC_HTTP_PORT` | `8081` | AC HTTP API port. Must match `HTTP_PORT` in `server_cfg.ini`. Used for server detection and live player data. |
| `AC_BLACKLIST_FILE` | `<AC_SERVER_DIR>/blacklist.txt` | Path to the ban list file. |
| `AC_WHITELIST_FILE` | `<AC_CFG_DIR>/whitelist.txt` | Path to the whitelist file. |
| `DB_PATH` | `<project>/assetto.db` | SQLite database file path. Created automatically on first run. |
| `PUBLIC_IP` | *(empty)* | Optional. Public IP shown in the Dashboard join link. If not set, resolved automatically via `api.ipify.org`. |
| `ADMIN_TOKEN` | *(empty)* | Optional static bearer token for headless/script access to protected endpoints. |

### Minimal `.env` example

```env
AC_SERVER_RESULTS=/home/user/ac_server/results
AC_CFG_DIR=/srv/assetto/cfg
AC_CONTENT_DIR=/srv/assetto/content
AC_SERVER_BIN=/home/user/ac_server/acServer
AC_HTTP_PORT=8081
```

---

## First login

Open the panel in your browser and log in with:

- **Username:** `Admin`
- **Password:** `Admin1234!`

> Change the default password immediately after first login — go to **My account** (key icon in the sidebar footer).
