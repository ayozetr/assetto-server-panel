<div align="center">
  <img src="src/assets/icon.png" width="96" alt="Assetto Server Panel" />
  <h1>Assetto Server Panel</h1>
  <p>A web-based administration panel for <strong>Assetto Corsa</strong> dedicated servers on Linux</p>

  ![Node.js](https://img.shields.io/badge/Node.js-20.20.2-339933?logo=node.js&logoColor=white)
  ![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)
  ![No build step](https://img.shields.io/badge/build-none-lightgrey)
  ![License](https://img.shields.io/badge/license-MIT-blue)
</div>

---

## What is it?

A full web interface to manage your Assetto Corsa server without touching the terminal. Accessible from any device on your network, or from anywhere in the world using Cloudflare Tunnel.

---

## Features

### 📊 Real-time monitoring
Live server metrics (CPU, RAM, uptime), AC server status, and a real-time log stream — all updated instantly via Server-Sent Events.

### 🏎️ Player management
Live player table with car, lap count, best/last time and country flag. Kick and ban directly from the panel. Full history of every player who has ever joined the server.

### ⏱️ Lap times database
Every lap time stored in SQLite automatically. Filter by track, car, date or driver. Sector splits, multi-driver comparison and CSV export.

### 🚗 Cars & tracks catalogue
Browse all installed cars and tracks with images, specs and multi-layout support. Add them to the next session with a single click.

### 📦 Mod installer
Upload mods as `.zip`, `.rar` or `.7z` straight from the browser. The server automatically detects whether it's a car or a track and installs it in the right folder. Works remotely too, with chunked upload support for Cloudflare and other proxies.

### ⚙️ Server configuration
Edit `server_cfg.ini` through a visual interface: server name, ports, slots, passwords, driving aids, whitelist and more.

### 👥 User management
Create, edit and delete panel users. Each user has their own profile with password change and a built-in secure password generator.

### 🌍 Multilingual
Full interface available in **English**, **Spanish** and **Italian**.

---

## Quick start

```bash
git clone https://github.com/ayozetr/assetto-dashboard.git
cd assetto-dashboard
nvm use 20.20.2
npm install
cp .env.example .env   # fill in your server paths
npm start
```

Open `http://<server-ip>:3000` in your browser.

**Default credentials:** `Admin` / `Admin1234!` — change them after first login.

---

## Documentation

| Document | Description |
|----------|-------------|
| [AC server setup (SteamCMD)](docs/ac-server-setup.md) | Install and configure an AC dedicated server from scratch |
| [Installation & configuration](docs/installation.md) | Requirements, setup steps and environment variables |
| [Production deployment](docs/deployment.md) | Systemd service, Cloudflare Tunnel, firewall |
| [Authentication & users](docs/authentication.md) | Session system, roles and user management |
| [Mod installer](docs/mod-upload.md) | Supported formats, auto-detection, chunked upload |
| [Database](docs/database.md) | SQLite schema and what gets stored |
| [API reference](docs/api.md) | All server endpoints |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and how to fix them |
| [Tools](docs/tools.md) | Scripts for extracting and compressing bundled Kunos assets |

---

## Tech stack

- **Frontend:** React 18 + Babel Standalone (no build step)
- **Backend:** Node.js native HTTP (no Express)
- **Database:** SQLite via `better-sqlite3`
- **Mod extraction:** `node-stream-zip`, `node-unrar-js`, `node-7z`
- **Real-time logs:** Server-Sent Events (SSE)
