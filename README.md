<div align="center">
  <img src="src/assets/icon.png" width="96" alt="Assetto Server Panel" />
  <h1>Assetto Server Panel</h1>
  <p>A web-based administration panel for <strong>Assetto Corsa</strong> dedicated servers on Linux</p>

  <p>
    <a href="CHANGELOG.md"><img alt="Version"   src="https://img.shields.io/badge/version-1.8.0-blue"></a>
    <a href="ROADMAP.md"><img   alt="Status"    src="https://img.shields.io/badge/status-production--ready-brightgreen"></a>
    <a href="ROADMAP.md#status"><img alt="Hardening" src="https://img.shields.io/badge/hardening-99%2F100-success"></a>
    <img alt="Audit"     src="https://img.shields.io/badge/npm%20audit-clean-success?logo=npm&logoColor=white">
    <img alt="2FA"       src="https://img.shields.io/badge/2FA-TOTP-blueviolet?logo=keycdn&logoColor=white">
  </p>
  <p>
    <a href="https://www.assettocorsa.gg/"><img alt="Game" src="https://img.shields.io/badge/game-Assetto%20Corsa-E60012"></a>
    <a href="https://acstuff.club/app/"><img    alt="Launcher" src="https://img.shields.io/badge/launcher-Content%20Manager-FFCC00"></a>
    <img alt="Node.js"          src="https://img.shields.io/badge/Node.js-20.20.2-339933?logo=node.js&logoColor=white">
    <img alt="SQLite"           src="https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white">
    <img alt="Build"            src="https://img.shields.io/badge/build-esbuild-FFCF00?logo=esbuild">
    <img alt="Docker"           src="https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white">
    <img alt="License"          src="https://img.shields.io/badge/license-Source--Available%20%2B%20Attribution-orange?logo=opensourceinitiative&logoColor=white">
    <img alt="Redistribution"   src="https://img.shields.io/badge/redistribution-prohibited-red">
  </p>
</div>

---

## What is it?

A full web interface to manage your Assetto Corsa server without touching the terminal. Accessible from any device on your network, or from anywhere in the world using Cloudflare Tunnel.

<p align="center">
  <img src="docs/screenshots/dashboard.webp" alt="Assetto Server Panel dashboard — light and dark themes" width="900"/>
</p>

---

## Features

### 📊 Real-time monitoring
Live CPU / RAM / uptime, AC server status and a log stream — all over Server-Sent Events. The Dashboard shows a **live-position minimap** (one dot per car, driven by acServer's UDP stream and aligned to the in-game map). Admin-only **persistent "Clear logs"** wipes memory *and* the on-disk log across every open tab. Panel restarts don't kick connected players.

### 🏎️ Player management
Live player table (car, lap count, best/last time, country flag) with kick and ban, plus a full join history. **Admin-set nicknames** attach a real name to an in-game alias and render as "Nickname (in-game)" everywhere.

<p align="center">
  <img src="docs/screenshots/players.webp" alt="Player management with live table, history and nicknames" width="800"/>
</p>

### ⏱️ Lap times database
Every lap stored in SQLite, **ingested live via the UDP plugin** — laps land within milliseconds of the finish line (auto-configured, no manual setup) and deduplicated against the session-end JSON dump, which backfills sector splits.

Three views — **Records** (best per driver+track), **All laps** (paginated) and **Compare drivers** (delta table, up to 4) — with filters by track/car/date/validity, CSV export, and an admin **manual lap insert** to backfill missed laps.

### 🌐 Public driver profiles
Shareable, no-login pages at `/p/<steam-id>` rendered with the panel's theme: KPI stats (total laps, time on track, best lap, records held), **server records**, **personal bests** and **recent laps**, with theme + EN/ES/IT toggles. OpenGraph / Twitter cards with a per-driver PNG for rich Discord previews, a downloadable stat card, and a matching JSON API (`/api/public/players/<id>`). All public endpoints are rate-limited and honour the **Settings → Public profiles** toggle.

### 🚗 Cars & tracks catalogue
Browse installed cars and tracks with images, specs and multi-layout support. Separate **Kunos / Mod** toggles, **per-slot skin selection** (the same car across grid slots with different liveries), and an admin **Delete** for mod content (Kunos content is protected server-side).

<p align="center">
  <img src="docs/screenshots/cars.webp" alt="Cars catalogue view" width="800"/>
  <br/>
  <img src="docs/screenshots/tracks.webp" alt="Tracks catalogue view with layouts" width="800"/>
</p>

### 🏁 Session planner
Per-session (Practice / Qualify / Race) toggles — disabling one removes its section from `server_cfg.ini`. Independent durations/laps, weather, air temperature, time of day and penalties. `entry_list.ini` is regenerated automatically when the car set changes.

<p align="center">
  <img src="docs/screenshots/session.webp" alt="Session planner with Practice / Qualify / Race configuration" width="800"/>
</p>

### 📋 Session presets
Save a whole session configuration (track, layout, per-slot cars/skins, toggles, durations, weather, time of day, penalties) under a name and load it back in one click. Build presets from the live session or from scratch, edit them, and **import/export** them as JSON. Loading a preset never reboots the running session by accident. Gated by the `presetManage` permission.

### 📦 Mod installer
Upload mods as `.zip`, `.rar` or `.7z` straight from the browser. The server automatically detects whether it's a car or a track and installs it in the right folder. Works remotely too, with chunked upload support for Cloudflare and other proxies.

<p align="center">
  <img src="docs/screenshots/mods.webp" alt="Mod installer with drag-and-drop upload and automatic car/track detection" width="800"/>
</p>

### ⚙️ Server configuration
Edit `server_cfg.ini` through a visual UI: name, ports, slots, passwords, driving aids, whitelist and more (values persist correctly even at `0`). A **country + city selector** writes the `[GEO_PARAMS]` section the lobby reads to show the server flag.

<p align="center">
  <img src="docs/screenshots/settings.webp" alt="Server configuration UI replacing manual server_cfg.ini edits" width="800"/>
</p>

### 👥 User management
Create, edit and delete panel users. Each user has their own profile with password change and a built-in secure password generator (uses `crypto.getRandomValues`). The panel refuses to delete *or demote* the last remaining admin and revokes a user's active sessions when an admin resets their password.

### 🔐 Granular role permissions
The `user` role is gated by ten independent toggles (`serverControl`, `sessionEdit`, `serverConfig`, `presetManage`, `whitelistManage`, `playerModeration`, `modUpload`, `discordWebhook`, `auditView`, `dbBackup`), edited from the **Users** page. Admin always passes, and changes take effect on the user's next request. Panel-user CRUD, the AC passwords and the permission set itself stay admin-only by design.

<p align="center">
  <img src="docs/screenshots/users.webp" alt="User management with role-based granular permissions" width="800"/>
</p>

### 🔔 Discord notifications for lap records
Drop a Discord webhook URL into Settings → Discord and the panel posts a localized message whenever a driver beats the best lap for a `(track, layout, car)` combo. First-ever laps aren't records (no spam). The webhook URL is treated as a secret.

### 🛡️ Security
- **Sessions:** scrypt password hashing with cost params pinned in `SCRYPT_PARAMS` (constant-time compare), `HttpOnly; SameSite=Strict` cookies with 7-day TTL plus the `Secure` flag when the request arrived over HTTPS, automatic 401 → logout interceptor on the client.
- **Forced first-login change:** seeded `Admin / Admin1234!` is locked into a blocking modal until the password is changed; server-side gate refuses every authenticated endpoint until the flag clears.
- **CSRF:** unsafe methods require `Origin`/`Referer` to match `Host`; combined with `SameSite=Strict` cookies, cross-site requests are rejected at two layers.
- **Headers:** CSP, Permissions-Policy, X-Frame-Options, Referrer-Policy on every response. HSTS auto-enabled when behind an HTTPS-terminating proxy.
- **Rate-limited** login, change-password, mod uploads, server start/stop/restart and config writes. Per-user concurrent SSE log-stream cap (6) caps file-descriptor usage. Optional `TRUST_PROXY=1` to honour `CF-Connecting-IP` / `X-Forwarded-For` so the limiter sees real client IPs through Cloudflare.
- **`ADMIN_TOKEN`** header (when configured) is compared in constant time via `crypto.timingSafeEqual` to avoid byte-by-byte timing oracles.
- **Mod uploads:** strict zip-slip abort, archive entry-count and aggregate-size caps, INI value sanitisation against injection.
- **Per-user audit log** of every admin action, with cursor pagination. Rows are SHA-256 hash-chained with a JSON-canonicalised payload (`chain_version = 1`) so a `|` inside a field cannot collide with a different field assignment; legacy rows still validate.

### 📱 Responsive
Sidebar collapses into a drawer with a hamburger toggle below 900 px wide; layouts re-flow to single columns on phones. Tested on portrait phones down to 360 px.

### 🌍 Multilingual
Full interface available in **English**, **Spanish** and **Italian**.

---

## Quick start

```bash
git clone https://github.com/ayozetr/assetto-server-panel.git
cd assetto-server-panel
nvm use 20.20.2
npm install
cp .env.example .env   # fill in your server paths
npm start              # automatically pre-builds dist/ via esbuild then runs server.js
```

The first time you run `npm start`, esbuild transpiles `src/*.jsx` to `dist/*.js`. Subsequent starts re-build (it takes ~20 ms — much cheaper than transpiling in the browser on every page load like before).

To rebuild manually after editing JSX without restarting the server:
```bash
npm run build
```

Open `http://<server-ip>:3000` in your browser.

> ### ⚠️ Before exposing the panel beyond `localhost`
>
> The default `HOST=0.0.0.0` listens on **every** network interface. Combine that with the wrong network config and the panel becomes reachable from places you didn't intend. Pick one of:
>
> 1. **Cloudflare Tunnel (recommended).** Set `HOST=127.0.0.1` and `TRUST_PROXY=1` in `.env`. The tunnel terminates TLS and forwards traffic to localhost; no firewall ports are opened. See [docs/deployment.md](docs/deployment.md#cloudflare-tunnel-remote-access-without-port-forwarding).
> 2. **LAN-only access.** Leave `HOST=0.0.0.0` but **block port 3000 from the internet** at the router / firewall. Do **not** set `TRUST_PROXY=1` — without a real proxy in front it lets any LAN client spoof their IP in `CF-Connecting-IP`. (Mitigated by an IP allowlist in 1.5+ but still operator error worth avoiding.)
> 3. **Reverse proxy (nginx / Caddy / Traefik).** Same shape as Cloudflare Tunnel: `HOST=127.0.0.1` + `TRUST_PROXY=1` + `TRUST_PROXY_FROM=<proxy IP CIDRs>` in `.env`.
>
> If the panel is publicly reachable you **must** change the default `Admin` password (the first login forces it, but a port scanner can still see the login screen). Consider also adding Cloudflare Access / Tailscale / a VPN as a second factor.

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
| [Docker deployment](docs/docker.md) | Containerised setup with `docker compose up -d`, volumes, networking, reverse-proxy front-end, troubleshooting |
| [Production deployment](docs/deployment.md) | Systemd service, Cloudflare Tunnel, firewall, log rotation, hardened systemd unit |
| [Authentication & users](docs/authentication.md) | Session system, roles and user management |
| [Mod installer](docs/mod-upload.md) | Supported formats, auto-detection, chunked upload |
| [Database](docs/database.md) | SQLite schema and what gets stored |
| [API reference](docs/api.md) | All server endpoints |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and how to fix them |
| [Tools](docs/tools.md) | Scripts for extracting and compressing bundled Kunos assets |
| [Tested on](docs/tested-on.md) | Exact OS / Node / npm / SQLite / Python versions the panel is known to run on |
| [Security policy](SECURITY.md) | How to report vulnerabilities and what is in / out of scope |
| [Roadmap](ROADMAP.md) | Project status, comparison with ACSM / Stracker, prioritized backlog |
| [Changelog](CHANGELOG.md) | Per-release summary of every notable change since 1.0.0 |

---

## Threat model

This is a **single-tenant admin tool**, not a multi-tenant web app. Trust assumptions:

- **Admins are fully trusted.** Admin role always passes every permission check. Exclusively allowed actions: managing panel users (create / delete / change role / reset password), editing the AC server `PASSWORD` and `ADMIN_PASSWORD` fields, wiping mod history, downloading the SQLite DB and reading or writing the role-permissions set itself. These are reserved by design — exposing them as toggles would let a `user` escalate to admin.
- **The `user` role is configurable per-permission, not "read-only".** An admin can grant a user the ability to start/stop the AC server, edit `server_cfg.ini` (everything except the two AC passwords), apply session changes, kick/ban drivers, manage the whitelist, upload mods, edit the Discord webhook, view the audit log and download DB backups — one toggle each. Trust accordingly: granting `serverConfig` lets the user reshape the running server; granting `modUpload` lets the user push arbitrary code that runs inside the AC server process (there is **no sandbox** between mods and the host).
- **Do not expose the panel to the public internet without HTTPS and credentialled access.** Do not give panel accounts to anyone you would not trust with the equivalent shell-level capability. Always set `TRUST_PROXY=1` when behind Cloudflare/Tunnel/reverse-proxy so rate limits and audit logs see real client IPs.
- **The audit log is hash-chained but deletable.** Each row stores a SHA-256 of the previous row's hash, so silent edits are detectable with `node tools/verify-audit.js` against an external backup. Anyone with shell access to `assetto.db` can still wipe rows entirely — keep periodic backups via `/api/admin/backup` if you need provable history. Every permission-gated action is recorded with the actor's username, so a per-user trail survives even when a permission set is broad.

What the panel **does** defend against:
- Anonymous attackers (CSRF, brute-force on login, path traversal, INI injection, decompression bombs, malformed archives).
- Privilege escalation from a compromised user account — even with every toggle on, the user role cannot create/delete panel users, change another user's role or password, read the AC server `PASSWORD` / `ADMIN_PASSWORD`, wipe mod history, or edit the role-permissions set.
- Stolen old SW caches (network-first navigation strategy ensures security fixes propagate without manual cache bumps).

What the panel does **not** defend against:
- Malicious mods (no sandboxing — only grant `modUpload` to people you trust to vet upload sources).
- A compromised admin account (full control by design).
- An over-permissioned user account — e.g. a user granted `serverConfig` can rewrite ports, ban-list flags and rules; a user granted `modUpload` can ship arbitrary native code. Defaults exist; the *configured* permission set is the operator's responsibility.
- Filesystem access via the host shell or other services.

---

## Tech stack

- **Frontend:** React 18 (production CDN) + esbuild build step transpiling JSX → plain JS at startup
- **Backend:** Node.js native HTTP (no Express)
- **Database:** SQLite via `better-sqlite3`
- **Mod extraction:** `node-stream-zip`, `node-unrar-js`, `node-7z`
- **Real-time logs:** Server-Sent Events (SSE)

---

## Tested on

The combinations below are the ones the maintainer actually runs day-to-day; the panel is reasonably portable but these are the ones that are known to work. Full version matrix and bundled-dependency lockfile excerpt in [`docs/tested-on.md`](docs/tested-on.md).

| Role         | OS                                  | Kernel              | Node.js   | npm     | SQLite (system) | Python |
| ------------ | ----------------------------------- | ------------------- | --------- | ------- | --------------- | ------ |
| Production   | Ubuntu 24.04.4 LTS (Noble Numbat)   | 6.8.0-111-generic   | v20.20.2  | 11.13.0 | 3.45.1          | 3.12.3 |
| Development  | CachyOS (Arch-based, rolling)       | 7.0.5-2-cachyos     | v20.20.2  | 11.14.1 | 3.53.0          | 3.14.4 |

Bundled npm packages on both hosts (production identical, dev installs the same lockfile):

`7zip-bin@5.2.0` · `better-sqlite3@12.10.0` · `dotenv@16.6.1` · `node-7z@3.0.0` · `node-stream-zip@1.15.0` · `node-unrar-js@2.0.2` · `esbuild@0.28.0`

Other Linux distributions on Node 20 LTS should work without changes — the panel only depends on a POSIX filesystem, a recent SQLite, and the libraries above. Windows/macOS will likely run but are not exercised regularly; please open an issue if you hit something distro-specific.

---

## License

Source-available. The full text — which is what binds you, not this summary — is in [`LICENSE`](LICENSE). Read it before deploying.

Short version (informative, not legally operative — only the LICENSE file is):

- **Free to download and run anywhere, for anything lawful.** Personal hobby use, private leagues, friend groups, amateur clubs, educational and research use are all fine. So is operating the panel for **public servers**, including servers advertised on the Kunos public-server list / Content Manager lobbies, **including commercial use** (paid leagues, sponsorships, ads, donations, for-profit organizations). You don't need a separate agreement to charge for participation or run a paid event on top of a server the panel manages.

- **No redistribution.** You may not republish the source code, fork it to a public repository as your own, upload it to a package registry, bundle it into another product, host it as a service for third parties to download, or otherwise hand copies to other people. If someone wants to use the panel, point them at the official repository — they can clone it themselves under their own acceptance of the LICENSE.

- **Attribution Marks are irremovable.** The "Developed by ayozetr" credit in the sidebar, the project name "Assetto Server Panel", the link to the official repository, the copyright notice, and every other identifier referring to the author or the project **must stay intact** in every copy you operate. This applies even to commercial deployments. A re-skin, white-label, or theme that hides the marks is a breach and terminates your rights automatically.

- **Local modifications are allowed.** Patch bugs, translate, add integrations, restyle (without touching the Attribution Marks) — keep them for yourself. You may submit them upstream via pull request; you may not publish them as your own fork.

- **No affiliation with anyone.** Not Kunos Simulazioni, not Valve, not 505 Games, not the Content Manager / acstuff projects, not any car / track manufacturer whose brand appears in bundled assets. The LICENSE has a long disclaimer section spelling this out.

- **No warranty, no liability.** "AS IS". Each tagged release is published with good-faith effort against known vulnerabilities at the time of publication, but the author makes no ongoing warranty and accepts no liability for damages, data loss, or downtime. See LICENSE sections 7 and 8.

For licensing questions, redistribution requests, or anything else: **`ayozetr@proton.me`**. For security disclosure see [`SECURITY.md`](SECURITY.md).
