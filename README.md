# Assetto Server Panel

A professional web-based administration panel for **Assetto Corsa** dedicated servers running on Linux. Monitor server health, manage players, review lap times, configure sessions, and control the server process — all from a clean, responsive interface accessible from any device on your network.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Project Structure](#project-structure)
- [Pages Reference](#pages-reference)
- [Demo Credentials](#demo-credentials)
- [Troubleshooting](#troubleshooting)

---

## Overview

Assetto Server Panel is a single-page application (SPA) built with **React 18** and served by a lightweight **Node.js** static file server. There is no build step, no bundler, and no transpilation pipeline on the server — JSX files are transpiled directly in the browser via **Babel Standalone**. This makes the project trivial to deploy: install one dependency (`dotenv`), run `npm start`, and the panel is live.

The panel operates entirely in **demo/simulation mode** out of the box — all server state, player data, lap times, and logs are mocked in memory. Real backend integration (AC server API, database reads) is a planned extension.

---

## Features

| Category | Capability |
|----------|-----------|
| **Server control** | Start · Stop · Restart · Reload config (admin only) |
| **Live monitoring** | CPU usage · RAM consumption · uptime · player count (updates every 1.5 s) |
| **Player management** | Live player list with lap count, best time, last time, ping · Kick · Ban · Session history |
| **Lap times** | Full records table filterable by track, car, and driver · sector splits · validity flag |
| **Live logs** | Streaming server log output with level badges (INFO · OK · WARN) |
| **Cars** | Visual catalogue with silhouette thumbnails, class, power, and weight |
| **Tracks** | Circuit catalogue with SVG layout previews, length, pit count, and layouts |
| **Session config** | Track · layout · mode · laps · time of day · weather · damage · assists |
| **Server config** | Network ports · paths · passwords · autostart / autorestart |
| **User management** | Panel user list with role assignment (admin / user) |
| **Themes** | Light and dark mode — persisted in `localStorage` |
| **Tweaks panel** | Live accent colour · border radius · density controls |
| **Auth** | Login screen with role-based access control (admin vs. user) |

---

## Architecture

```
Browser
  │
  │  HTTP GET /
  ▼
server.js  (Node.js · http module · reads .env)
  │
  │  serves static files from project root
  ▼
index.html
  ├── CDN: React 18 · ReactDOM · Babel Standalone  (SRI-pinned)
  └── src/
      ├── tweaks-panel.jsx   → window globals: useTweaks, TweaksPanel, TweakSection …
      ├── icons.jsx          → window.AppIcons
      ├── data.jsx           → window.AppData  (mock cars, tracks, players, lap times)
      ├── shell.jsx          → window.AppShell (Sidebar, Topbar, Login, ToastProvider)
      ├── pages/
      │   ├── pages-a.jsx    → window.AppPagesA (Dashboard, Players, Logs)
      │   ├── pages-b.jsx    → window.AppPagesB (Cars, Tracks, Session)
      │   ├── pages-c.jsx    → window.AppPagesC (Config, Users)
      │   └── pages-d.jsx    → window.AppPagesD (Times)
      ├── styles.css         → CSS custom properties · light/dark themes
      └── app.jsx            → App root — global state, routing, ReactDOM.createRoot
```

**Load order matters.** Babel Standalone fetches and transpiles each `<script type="text/babel">` sequentially. Each file attaches its exports to `window.*` so subsequent files can reference them without a module system.

**State management** is handled with plain React `useState` and `useEffect` hooks at the `App` level, passed down as props. There is no external state library.

---

## Requirements

| Tool    | Required version |
|---------|-----------------|
| Node.js | **20.20.2**      |
| npm     | **11.13.0**      |

> Both versions are managed with [nvm](https://github.com/nvm-sh/nvm). If nvm is not installed on your system, see [Installing nvm](#installing-nvm) below.

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
# or, if not installed yet:
nvm install 20.20.2 && nvm use 20.20.2
npm install -g npm@11.13.0
```

### 3 · Install dependencies

```bash
npm install
```

### 4 · Configure environment

```bash
cp .env.example .env
# Edit .env if you need a different port
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

Open the **Network** URL from any machine on the same network.

---

## Configuration

All configuration lives in `.env` (never committed to git).

| Variable | Default   | Description |
|----------|-----------|-------------|
| `HOST`   | `0.0.0.0` | Bind address. Use `127.0.0.1` to restrict to localhost. |
| `PORT`   | `3000`    | TCP port the web server listens on. |

---

## Deployment

### Running in the background with `pm2`

```bash
npm install -g pm2
pm2 start server.js --name assetto-panel
pm2 save
pm2 startup   # follow the printed command to enable autostart on boot
```

Useful pm2 commands:

```bash
pm2 status              # check running processes
pm2 logs assetto-panel  # tail logs
pm2 restart assetto-panel
pm2 stop assetto-panel
```

### Systemd service (alternative to pm2)

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
│   │   ├── pages-b.jsx        # Cars · Tracks · Session
│   │   ├── pages-c.jsx        # Configuration · Users
│   │   └── pages-d.jsx        # Lap Times
│   ├── app.jsx                # Root component — routing, global state
│   ├── data.jsx               # Mock data (cars, tracks, players, lap records)
│   ├── icons.jsx              # SVG icon library (AppIcons)
│   ├── shell.jsx              # Sidebar · Topbar · Login · Toast system
│   ├── styles.css             # CSS custom properties · light / dark themes
│   └── tweaks-panel.jsx       # Floating customisation panel + controls
├── index.html                 # SPA entry point
├── server.js                  # Static file server (Node.js http module)
├── .env                       # Local environment variables — not in git
├── .env.example               # Environment variable template
├── .gitignore
├── package.json
└── README.md
```

---

## Pages Reference

| Page          | Sidebar label   | Role required | Description |
|---------------|-----------------|---------------|-------------|
| Dashboard     | Dashboard       | All           | Live server metrics: status pill, CPU/RAM gauges, uptime, active players, current session summary |
| Players       | Jugadores       | All           | Live player table (laps, best/last time, ping) with kick/ban actions; session history tab |
| Lap Times     | Tiempos         | All           | Full lap record database with filters by track, car, and driver; sector splits and validity |
| Logs          | Logs            | All           | Live server log stream with level indicators (INFO, OK, WARN) |
| Cars          | Coches          | All           | Vehicle catalogue with class, power output, weight, and SVG silhouette |
| Tracks        | Tramos          | All           | Circuit catalogue with SVG layout previews, length, pit capacity, and available layouts |
| Session       | Sesión          | All           | Current session setup: track, layout, mode, laps, time of day, weather, damage, driving aids |
| Configuration | Configuración   | **Admin**     | Server name, network ports, file paths, passwords, autostart options |
| Users         | Usuarios        | **Admin**     | Panel user management: roles, status, creation date |

---

## Default Credentials

Passwords are validated against a SQLite database seeded on first run. All accounts share the same default password; change it from **My account** (key icon in the sidebar footer).

| Username  | Default password | Role          |
|-----------|-----------------|---------------|
| `admin`   | `Admin1234!`    | Administrator |
| `mattia`  | `Admin1234!`    | Administrator |

Administrator accounts have access to server control actions (start/stop/restart) and the Configuration and Users pages.

> **Security note**: Change the default password immediately after first login.

---

## Troubleshooting

### `ERR_CONNECTION_REFUSED`

Nothing is listening on the port. Verify the server is running:

```bash
ss -tlnp | grep 3000
```

If the port is not listed, start the server:

```bash
npm start
```

### Page loads but JSX files return 404

The file paths in `index.html` must match the actual directory structure. All source files live under `src/` — the HTML references them as `src/app.jsx`, `src/pages/pages-a.jsx`, etc.

### Fonts or CDN scripts fail to load

The panel loads React, ReactDOM, and Babel from `unpkg.com`, and fonts from `fonts.googleapis.com`. The server must have outbound internet access on port 443.

### Port already in use

```
✖  Port 3000 is already in use. Change PORT in .env
```

Either stop the conflicting process (`sudo lsof -i :3000`) or change `PORT` in `.env`.

---

## Installing nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc   # or: source ~/.zshrc

nvm install 20.20.2
nvm use 20.20.2
npm install -g npm@11.13.0
```
