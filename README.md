# Assetto Server Panel

A web-based administration panel for **Assetto Corsa** dedicated servers running on Linux. Monitor server health, manage players, review lap times, configure sessions, and control the server process — all from a clean, responsive interface accessible from any device on your network.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Project Structure](#project-structure)
- [Pages Reference](#pages-reference)
- [API Reference](#api-reference)
- [Default Credentials](#default-credentials)
- [Troubleshooting](#troubleshooting)

---

## Features

### Monitoring
- **Live server metrics** — CPU usage, RAM consumption, uptime, player count; polls every 4 s
- **Live log stream** — tails the AC server log file with level badges (INFO · OK · WARN · ERROR), pause/resume, and export to `.txt`
- **Dashboard activity feed** — last 5 notable log events (connections, laps, errors) loaded on page open
- **Backend-down banner** — shown automatically after 3 consecutive failed metric polls

### Player management
- **Live player table** — name, car, lap count, best/last time, ping, country flag
- **Kick & Ban** — kick via AC HTTP API; ban writes the Steam GUID to `blacklist.txt`
- **Player history** — all past players from the SQLite DB, with session count, total laps, best lap time, and last seen; searchable by name; paginated

### Lap times
- **Full records database** — all laps from AC result JSON files, stored in SQLite and deduplicated; new result files are imported automatically via a filesystem watcher
- **Filters** — by track, car, validity, and date range (from/to); shows best lap per (player, track) in the records view
- **Sector splits** — S1, S2, S3 displayed with delta to track leader
- **Player comparison** — select up to 4 drivers for a side-by-side comparison across tracks
- **CSV export** — download the current filtered view as a `.csv` file
- **Pagination** — configurable rows per page across Times, Players history, Cars, and Tracks

### Car & track catalogue
- **Car browser** — full grid from `/content/cars/`, with skin thumbnails, specs (BHP, torque, weight, top speed), brand logos, and Kunos toggle
- **Car detail modal** — skin carousel with full-size preview per skin, specs panel, description
- **Track browser** — grid from `/content/tracks/` with country flag, circuit length, pit count
- **Track detail modal** — per-layout thumbnails, length, description, layout selector
- **Session integration** — click any car or track to add it to the next session directly
- **Kunos asset fallback** — bundled WebP previews for all Kunos stock cars and tracks; shown automatically when the AC content directory has no thumbnails

### Mod upload
- **Drag-and-drop uploader** — admin-only page to upload and install car or track mods directly from the browser
- **Supported formats** — `.zip`, `.rar`, `.7z`; configurable size limit (default 500 MB, max 10 240 MB)
- **Automatic mod detection** — identifies whether the archive contains a car (`.kn5` + `data/`) or a track (`models.ini` + `ai/`)
- **Surgical extraction** — only the mod root folder is extracted into the AC content directory; extra files, scripts, and nested archives are discarded
- **Security** — anti Zip-Slip path traversal protection; executable files are blocked; only game-relevant extensions are allowed

### Session & server configuration
- **Session configurator** — track, layout, mode (Practice / Quali / Race), laps/duration, time of day, weather, temperature, damage, driving aids; writes to `server_cfg.ini` with confirmation modal
- **Server config page** — server name, network ports, max clients, passwords, whitelist toggle, fuel/damage/tyre wear rates, ABS/TC/autoclutch/stability, autostart/autorestart; saving indicator while request is in flight
- **Whitelist editor** — inline Steam ID list (17-digit validation) with add/remove and save, shown when whitelist is enabled
- **Server control** — Start · Stop · Restart · Reload config (SIGHUP) from the top bar; admin-only

### Authentication & user management
- **Real login** — PBKDF2-SHA-512 (100 000 iterations) against a `panel_users` SQLite table
- **httpOnly session cookies** — 24 h TTL, invalidated on logout; token never exposed to JavaScript
- **Rate limiting** — 5 failed attempts per IP locks the login endpoint for 15 minutes
- **Panel user CRUD** — create, edit role, change another user's password, delete; admin-only; persisted in SQLite
- **My account page** — change own password (current + new + confirm) with show/hide toggles; secure password generator (length slider 8–24, special characters toggle, live preview field, copy and use buttons)

### UI/UX
- **Light / dark theme** — persisted in `localStorage`
- **Internationalisation (i18n)** — full English, Spanish, and Italian translations; language selector in the Configuration page; persisted in `localStorage` (`ac-lang`)
- **Direct join link** — Dashboard shows a Content Manager–compatible join URL (`acmanager://`) with copy-to-clipboard and Open in CM buttons; public IP resolved automatically via `api.ipify.org` or overridden with `PUBLIC_IP` in `.env`
- **Loading spinners** — shown in Cars, Tracks, and Lap Times while the initial fetch is in flight
- **Page not found fallback** — graceful message for unknown routes
- **Live tweaks panel** — floating panel for accent colour, border radius, and density; changes apply instantly

---

## Architecture

```
Browser
  │
  │  HTTP (same-origin only)
  ▼
server.js  ─── Node.js http module, no framework
  │
  ├── Serves static files from project root
  ├── All /api/* routes handled inline
  ├── SQLite (better-sqlite3): laps, players, processed_files, panel_users, panel_settings
  └── Sessions: in-memory Map, token → { role, expiresAt }
```

```
src/
  tweaks-panel.jsx  →  window globals: useTweaks, TweaksPanel …
  icons.jsx         →  window.AppIcons
  i18n.jsx          →  window.AppI18n  (t(), setLang(), en/es/it dictionaries)
  data.jsx          →  window.AppUtils (fmtMs, nationFlag)
  shell.jsx         →  window.AppShell (Sidebar, Topbar, Login, ToastProvider, useToast)
  pages/
    pages-a.jsx     →  window.AppPagesA  (Dashboard, Players, Logs)
    pages-b.jsx     →  window.AppPagesB  (Cars, Tracks, Session, Mods)
    pages-c.jsx     →  window.AppPagesC  (Config, Users, Profile)
    pages-d.jsx     →  window.AppPagesD  (Times)
  styles.css        →  CSS custom properties · light/dark themes
  app.jsx           →  App root — global state, routing, ReactDOM.createRoot
  assets/
    icon.png        →  App logo (sidebar brand + login screen)
    kunos/          →  Bundled WebP previews for Kunos stock cars and tracks
```

**No build step.** JSX is transpiled in the browser by Babel Standalone. Each file attaches its exports to `window.*` for use by subsequent scripts. Load order is defined in `index.html`.

**State** lives in the `App` component and is passed down as props. No external state library.

**AC server detection** uses an HTTP ping to `http://127.0.0.1:<AC_HTTP_PORT>/INFO` rather than `pgrep`, which avoids false positives from the dashboard's own shell environment.

**Results watcher** — on startup, all unprocessed result JSON files are imported into SQLite. A `fs.watch` listener on the results directory then imports any new files automatically within ~2.5 s of them appearing.

---

## Requirements

| Tool    | Version    |
|---------|-----------|
| Node.js | **20.20.2** |
| npm     | **11.13.0** |

> Managed with [nvm](https://github.com/nvm-sh/nvm). See [Installing nvm](#installing-nvm) if needed.

---

## Installation

### 1 · Clone the repository

```bash
git clone <repo-url>
cd assetto-dashboard
```

### 2 · Select the correct Node.js version

```bash
nvm use 20.20.2
# If not installed yet:
nvm install 20.20.2 && nvm use 20.20.2
npm install -g npm@11.13.0
```

### 3 · Install dependencies

```bash
npm install
```

Dependencies include `better-sqlite3` (database), `dotenv` (config), `node-stream-zip` (ZIP extraction), `node-unrar-js` (RAR extraction), `node-7z` + `7zip-bin` (7z extraction).

### 4 · Configure environment

```bash
cp .env.example .env
# Edit .env with your server paths
```

### 5 · Start the server

```bash
npm start
```

Expected output:

```
  ────────────────────────────────────────────
    Assetto Server Panel
  ────────────────────────────────────────────
    Local    →  http://localhost:3000
    Network  →  http://<redacted-ip>:3000
  ────────────────────────────────────────────
```

Open the **Network** URL from any machine on the same network. On first start, two default users are seeded into the database (see [Default Credentials](#default-credentials)).

---

## Configuration

All configuration lives in `.env` (never committed to git).

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to restrict to localhost. |
| `PORT` | `3000` | TCP port the web server listens on. |
| `AC_SERVER_LOG` | `/home/.../server_output.log` | Path to the AC server log file. |
| `AC_SERVER_RESULTS` | `/home/.../results` | Directory containing AC result JSON files. |
| `AC_CFG_DIR` | `/srv/assetto/cfg` | Directory containing `server_cfg.ini` (and `whitelist.txt`). |
| `AC_CONTENT_DIR` | `/srv/assetto/content` | Root content directory (must contain `cars/` and `tracks/`). |
| `AC_SERVER_BIN` | `/home/.../acServer` | Path to the `acServer` binary (used for Start). |
| `AC_SERVER_DIR` | `dirname(AC_SERVER_BIN)` | Working directory when spawning the AC process. |
| `AC_HTTP_PORT` | `8081` | AC HTTP API port (used for server detection and player data). |
| `AC_BLACKLIST_FILE` | `<AC_SERVER_DIR>/blacklist.txt` | Path to the ban list file. |
| `AC_WHITELIST_FILE` | `<AC_CFG_DIR>/whitelist.txt` | Path to the whitelist file. |
| `DB_PATH` | `<project>/assetto.db` | SQLite database path. |
| `PUBLIC_IP` | _(empty)_ | Optional. Public IP shown in the Dashboard join link. If unset, resolved automatically via `api.ipify.org`. |
| `ADMIN_TOKEN` | _(empty)_ | Optional static token for headless/script access to server control endpoints. Session cookies are the preferred mechanism for browser access. |

The upload size limit is not an env variable — it is stored in the `panel_settings` SQLite table and editable from the Configuration page (default: 500 MB).

---

## Deployment

### Running in the background with pm2

```bash
npm install -g pm2
pm2 start server.js --name assetto-panel
pm2 save
pm2 startup   # follow the printed command to enable autostart on boot
```

```bash
pm2 status
pm2 logs assetto-panel
pm2 restart assetto-panel
pm2 stop assetto-panel
```

### Systemd service (alternative)

Create `/etc/systemd/system/assetto-panel.service`:

```ini
[Unit]
Description=Assetto Server Panel
After=network.target

[Service]
Type=simple
User=administrador
WorkingDirectory=/home/<user>/assetto-dashboard
ExecStart=/home/<user>/.nvm/versions/node/v20.20.2/bin/node server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/home/<user>/assetto-dashboard/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now assetto-panel
sudo systemctl status assetto-panel
```

### Opening the firewall port

```bash
# iptables
sudo iptables -A INPUT -p tcp --dport 3000 -j ACCEPT

# firewalld
sudo firewall-cmd --permanent --add-port=3000/tcp && sudo firewall-cmd --reload
```

---

## Project Structure

```
assetto-dashboard/
├── src/
│   ├── pages/
│   │   ├── pages-a.jsx        # Dashboard · Players · Logs
│   │   ├── pages-b.jsx        # Cars · Tracks · Session · Mods
│   │   ├── pages-c.jsx        # Configuration · Users · My account
│   │   └── pages-d.jsx        # Lap Times
│   ├── assets/
│   │   ├── icon.png           # App logo
│   │   └── kunos/             # Bundled WebP previews for Kunos stock content
│   ├── app.jsx                # Root component — routing, global state
│   ├── data.jsx               # AppUtils helpers (fmtMs, nationFlag)
│   ├── i18n.jsx               # i18n engine — en/es/it dictionaries, window.AppI18n
│   ├── icons.jsx              # SVG icon library (window.AppIcons)
│   ├── shell.jsx              # Sidebar · Topbar · Login · Toast system
│   ├── styles.css             # CSS custom properties · light/dark themes
│   └── tweaks-panel.jsx       # Floating customisation panel
├── tools/
│   ├── extract_kunos_assets.py  # Extracts car/track assets from an AC installation
│   └── compress_to_webp.py      # Converts extracted images to WebP
├── index.html                 # SPA entry point
├── server.js                  # Node.js HTTP server + all API endpoints
├── assetto.db                 # SQLite database (created on first run, gitignored)
├── .env                       # Local environment variables — not in git
├── .env.example               # Environment variable template
├── package.json
└── README.md
```

---

## Pages Reference

| Page | Sidebar label | Role | Description |
|------|--------------|------|-------------|
| Dashboard | Dashboard | All | Live CPU/RAM gauges, server status pill, uptime, connected players, current session summary, recent activity feed from server log, direct join link with Content Manager protocol support |
| Players | Players | All | Live player table with flag, car, laps, best/last time, ping; kick and ban actions; history tab with search and pagination |
| Lap Times | Times | All | Records table filtered by track, car, validity, and date range; sector splits; delta to leader; player comparison view; CSV export; paginated |
| Logs | Logs | All | Live log tail (polls every 3 s) with level filters, pause/resume, clear, and export to `.txt` |
| Cars | Cars | All | Full car catalogue with skin thumbnails, specs, brand logos; add/remove to session; Kunos toggle; paginated |
| Tracks | Tracks | All | Circuit catalogue with country flag, length, pit count; multi-layout modal with per-layout thumbnails; paginated |
| Session | Session | All | Session parameters (track, layout, mode, conditions, aids); writes `server_cfg.ini` after confirmation |
| Mods | Mods | **Admin** | Drag-and-drop uploader for car/track mods (.zip/.rar/.7z); automatic mod detection and surgical extraction; session upload history |
| Configuration | Settings | **Admin** | Network ports, max clients, passwords, whitelist toggle + Steam ID editor, race rules, assists; mod upload size limit; language selector |
| Users | Users | **Admin** | Panel user CRUD: create, edit role, change password, delete; persisted in SQLite |
| My account | My Account | All | Change own password; secure password generator with length slider, special characters toggle, live preview, copy and use |

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/login` | Authenticate; sets `sid` httpOnly cookie (24 h TTL). Rate-limited: 5 attempts/15 min per IP. |
| `POST` | `/api/auth/logout` | Invalidate session and clear cookie. |
| `POST` | `/api/auth/change-password` | Change own password (requires current password). |
| `GET` | `/api/metrics` | CPU %, RAM MB, AC running status, uptime, CPU model, OS info, public IP, live track. |
| `GET` | `/api/logs?n=150` | Last N parsed log lines `{ id, time, lvl, tag, msg }`. Max 500. |
| `GET` | `/api/config` | Parsed `server_cfg.ini` as JSON. |
| `PUT` | `/api/config` | Write JSON back to `server_cfg.ini` (backs up to `.bak`). |
| `GET` | `/api/players` | Live player list proxied from AC HTTP API `/api/details`. |
| `GET` | `/api/players/history` | Past players from SQLite with session count, laps, best lap. |
| `POST` | `/api/players/kick` | Kick player via AC HTTP API. |
| `POST` | `/api/players/ban` | Add Steam GUID to `blacklist.txt`. |
| `GET` | `/api/results?limit=500` | All result files parsed to lap-time format. Max 5000. |
| `GET` | `/api/cars` | All `ui_car.json` files normalised (name, brand, specs, skins). |
| `GET` | `/api/tracks` | All `ui_track.json` files normalised (name, country, length, layouts). |
| `POST` | `/api/session/apply` | Write track/cars to `server_cfg.ini`. |
| `GET` | `/api/whitelist` | Read `whitelist.txt` as `{ ids: string[] }`. |
| `PUT` | `/api/whitelist` | Write Steam ID array to `whitelist.txt` (validates 17-digit format). |
| `GET` | `/api/panel/users` | List panel users (admin only). |
| `POST` | `/api/panel/users` | Create panel user. |
| `PUT` | `/api/panel/users/:username` | Update role or password. |
| `DELETE` | `/api/panel/users/:username` | Delete panel user. |
| `GET` | `/api/panel/settings` | Read panel settings (e.g. `upload_max_mb`). |
| `PUT` | `/api/panel/settings` | Update panel settings. |
| `POST` | `/api/mods/upload` | Upload and install a car or track mod (.zip/.rar/.7z). Admin only. Multipart stream; reads `Content-Length` for size check. |
| `POST` | `/api/server/start` | Spawn `acServer` process. |
| `POST` | `/api/server/stop` | Kill `acServer` process. |
| `POST` | `/api/server/restart` | Stop then start. |
| `POST` | `/api/server/reload` | Send SIGHUP to `acServer` (reload without restart). |
| `GET` | `/api/content/cars/:id/thumb` | Serve car preview image. |
| `GET` | `/api/content/cars/:id/skins/:skin/preview` | Serve skin preview image. |
| `GET` | `/api/content/cars/:id/kunos-skin/:skin/preview` | Serve bundled Kunos skin preview (WebP fallback). |
| `GET` | `/api/content/tracks/:id/thumb` | Serve track preview image. |
| `GET` | `/api/content/tracks/:id/layout/:layout/thumb` | Serve per-layout track preview image. |

All `POST`/`PUT` endpoints require `Content-Type: application/json` (except `/api/mods/upload` which is a raw binary stream). Server control and mod upload endpoints require an admin session cookie or a valid `ADMIN_TOKEN` header.

---

## Default Credentials

Passwords are hashed with PBKDF2-SHA-512 (100 000 iterations) and stored in SQLite. Both accounts are seeded on first run with the same default password.

| Username | Default password | Role |
|----------|-----------------|------|
| `admin` | `Admin1234!` | Administrator |
| `mattia` | `Admin1234!` | Administrator |

Administrators have access to server control, the Configuration page, the Users page, and the Mods uploader.

> **Change the default password immediately after first login** — use the key icon in the sidebar footer or navigate to **My account**.

---

## Troubleshooting

### `ERR_CONNECTION_REFUSED`

Nothing is listening on port 3000. Check the server is running:

```bash
ss -tlnp | grep 3000
npm start
```

### Page loads but shows no cars or tracks

The paths in `.env` point to the wrong directories. Verify that `AC_CONTENT_DIR/cars` and `AC_CONTENT_DIR/tracks` exist and contain `ui_car.json` / `ui_track.json` files.

### Lap times table is empty

AC result files must be JSON files matching the format `{ TrackName, Laps: [{ LapTime, Sectors, Cuts, DriverName, CarModel }] }` in the directory set by `AC_SERVER_RESULTS`. Check that path and file permissions.

### Server always shows "Stopped"

The panel detects the AC server via an HTTP ping to `http://127.0.0.1:<AC_HTTP_PORT>/INFO`. Verify `AC_HTTP_PORT` matches the `HTTP_PORT` value in your `server_cfg.ini`.

### Mod upload fails with "No valid mod found"

The archive must contain a car (a `.kn5` file and a `data/` folder at the mod root) or a track (`models.ini` and an `ai/` folder). Nested archives (zip inside zip) are not supported.

### JSX files return 404

All source files live under `src/`. Check that the directory structure matches the paths referenced in `index.html`.

### Port already in use

```
✖  Port 3000 already in use — change PORT in .env
```

```bash
sudo lsof -i :3000   # find the conflicting process
```

Or change `PORT` in `.env`.

---

## Installing nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc   # or: source ~/.zshrc

nvm install 20.20.2
nvm use 20.20.2
npm install -g npm@11.13.0
```
