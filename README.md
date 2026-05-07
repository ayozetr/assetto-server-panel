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
Edit `server_cfg.ini` through a visual interface: server name, ports, slots, passwords (with show/hide toggle), driving aids, whitelist and more. Race-rule and behaviour options persist correctly even at value `0`.

### 👥 User management
Create, edit and delete panel users. Each user has their own profile with password change and a built-in secure password generator (uses `crypto.getRandomValues`). The panel refuses to delete the last admin and revokes a user's active sessions when an admin resets their password.

### 🛡️ Security
- **Sessions:** scrypt password hashing (constant-time compare), `HttpOnly; SameSite=Strict` cookies with 7-day TTL, automatic 401 → logout interceptor on the client.
- **Forced first-login change:** seeded `Admin / Admin1234!` is locked into a blocking modal until the password is changed; server-side gate refuses every authenticated endpoint until the flag clears.
- **CSRF:** unsafe methods require `Origin`/`Referer` to match `Host`; combined with `SameSite=Strict` cookies, cross-site requests are rejected at two layers.
- **Headers:** CSP, Permissions-Policy, X-Frame-Options, Referrer-Policy on every response. HSTS auto-enabled when behind an HTTPS-terminating proxy.
- **Rate-limited** login, change-password, mod uploads, server start/stop/restart and config writes. Optional `TRUST_PROXY=1` to honour `CF-Connecting-IP` / `X-Forwarded-For` so the limiter sees real client IPs through Cloudflare.
- **Mod uploads:** strict zip-slip abort, archive entry-count and aggregate-size caps, INI value sanitisation against injection.
- **Per-user audit log** of every admin action, with cursor pagination.

### 📱 Responsive
Sidebar collapses into a drawer with a hamburger toggle below 900 px wide; layouts re-flow to single columns on phones. Tested on portrait phones down to 360 px.

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

**Default credentials:** `Admin` / `Admin1234!`. The first login forces a password change in a blocking modal — the rest of the panel is unreachable (server-side enforced) until the password is changed. If you ever lock yourself out, run:

```sql
UPDATE panel_users SET must_change_password = 0 WHERE username = 'Admin';
```
in the SQLite DB and log in normally.

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

## Threat model

This is a **single-tenant admin tool**, not a multi-tenant web app. Trust assumptions:

- **Authenticated users are trusted to operate the AC server.** Every logged-in user can upload mods, which extract files into the AC content directory and run inside the AC server process. There is **no sandbox** between mods and the host — a malicious mod can do anything `acServer` can do.
- **Admins are fully trusted.** Admin role can change passwords, delete users, edit `server_cfg.ini`, restart the AC process, and download the SQLite DB.
- **Do not expose the panel to the public internet without HTTPS and credentialled access.** Do not give panel accounts to anyone you would not give shell access to the host. Always set `TRUST_PROXY=1` when behind Cloudflare/Tunnel/reverse-proxy so rate limits and audit logs see real client IPs.
- **The audit log is best-effort.** Any admin can call `DELETE FROM audit_log` directly on `assetto.db`. Keep external backups (`/api/admin/backup` endpoint or scheduled `cp`) if you need tamper-evident history.

What the panel **does** defend against:
- Anonymous attackers (CSRF, brute-force on login, path traversal, INI injection, decompression bombs, malformed archives).
- Compromised non-admin accounts (cannot read AC server passwords, cannot wipe history, cannot list/manage users).
- Stolen old SW caches (network-first navigation strategy ensures security fixes propagate without manual cache bumps).

What the panel does **not** defend against:
- Malicious mods (no sandboxing — admins are responsible for vetting upload sources).
- A compromised admin account (full control by design).
- Filesystem access via the host shell or other services.

---

## Tech stack

- **Frontend:** React 18 + Babel Standalone (no build step)
- **Backend:** Node.js native HTTP (no Express)
- **Database:** SQLite via `better-sqlite3`
- **Mod extraction:** `node-stream-zip`, `node-unrar-js`, `node-7z`
- **Real-time logs:** Server-Sent Events (SSE)
