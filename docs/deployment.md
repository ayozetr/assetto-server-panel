# Production Deployment

This document covers the **systemd path** — running the panel as a long-lived service on a Linux host with Node 20+ installed. If you'd rather skip the runtime setup and let the panel install in two commands, see **[docs/docker.md](docker.md)** for the containerised path (`docker compose up -d`, named volumes, healthcheck, reverse-proxy front-end, troubleshooting).

Both paths are first-class. Pick the one that matches your operational style; they share the same `.env`, the same migrations, and the same auto-update flow.

---

## Systemd service (bare-metal)

Running the panel as a systemd service ensures it starts automatically on boot and restarts if it crashes.

### 1. Create the service file

```bash
sudo nano /etc/systemd/system/assetto-server-panel.service
```

```ini
[Unit]
Description=Assetto Server Panel
After=network.target

[Service]
Type=simple
User=<your-user>
WorkingDirectory=/path/to/assetto-server-panel
ExecStartPre=/home/<your-user>/.nvm/versions/node/v20.20.2/bin/node build.js
ExecStart=/home/<your-user>/.nvm/versions/node/v20.20.2/bin/node server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/path/to/assetto-server-panel/.env
TimeoutStopSec=15      # matches the server's 10 s force-exit guard
KillMode=process       # only signal the panel — acServer keeps running across panel redeploys

[Install]
WantedBy=multi-user.target
```

> **`ExecStartPre=node build.js`** — the panel ships JSX in `src/` that needs to be transpiled to plain JS in `dist/` before the server starts serving it. esbuild does this in ~20 ms. If you start the server via `npm start` instead, the `prestart` script in `package.json` runs the same step automatically; either form works.

> **`KillMode=process`** is important: without it systemd kills the entire cgroup on `systemctl restart`, which takes `acServer` down with the panel and kicks every connected driver every time you redeploy. With `KillMode=process` systemd only signals the Node process; `acServer` (which the panel may have spawned as a child) keeps running and the new panel re-adopts it on startup via `pidof acServer`.

### 2. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now assetto-server-panel
```

### 3. Useful commands

```bash
sudo systemctl status assetto-server-panel     # check status
sudo systemctl restart assetto-server-panel    # apply changes after update
sudo systemctl stop assetto-server-panel       # stop the panel
journalctl -u assetto-server-panel -f          # live logs
journalctl -u assetto-server-panel -n 100      # last 100 log lines
```

---

## Cloudflare Tunnel (remote access without port forwarding)

Cloudflare Tunnel lets you expose the panel to the internet without opening any firewall ports. Ideal for accessing the panel from outside your home network.

### Prerequisites

- A domain managed by Cloudflare
- `cloudflared` installed on the server

### Setup

1. Authenticate and create a tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create assetto-panel
```

2. Edit `/etc/cloudflared/config.yml` to add an ingress rule:

```yaml
tunnel: <your-tunnel-id>
credentials-file: /etc/cloudflared/<your-tunnel-id>.json

ingress:
  - hostname: panel.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

3. Add a DNS record in Cloudflare pointing `panel.yourdomain.com` to the tunnel.

4. Enable cloudflared as a service:

```bash
sudo systemctl enable --now cloudflared
```

### Trust the proxy

Add `TRUST_PROXY=1` to `.env` so the panel honours `CF-Connecting-IP` / `X-Forwarded-For` for rate-limiting, login lockouts, and audit-log IPs. Without this, every request appears to come from the Cloudflare edge and the per-IP limiter would either lock everyone out together or be useless. **Only set `TRUST_PROXY=1` when the panel is reachable exclusively through Cloudflare** — if it is also reachable directly on the LAN, clients could spoof the header.

### Chunked upload

When accessing the panel via Cloudflare, large file uploads may be blocked by the WAF. Enable **Chunked upload** in the panel's Configuration page to split files into 5 MB JSON chunks that pass through without issues.

---

## Opening the firewall (LAN access)

If you only need LAN access and are not using Cloudflare Tunnel, open port 3000 on your firewall:

```bash
# ufw
sudo ufw allow 3000/tcp

# firewalld
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

---

## Updating

```bash
cd assetto-server-panel
git pull
npm ci               # reproducible install, refuses to drift from package-lock.json
sudo systemctl restart assetto-server-panel
```

> **`npm ci` vs `npm install`** — `npm install` rewrites `package-lock.json` whenever the lockfile and `package.json` disagree. If the panel host is ever compromised and `package.json` is amended with a malicious `postinstall`, `npm install` happily runs it on the next deploy. `npm ci` refuses any drift and aborts. Production deploys should use `npm ci`; switch back to `npm install` only when you intentionally edit `package.json` locally and want the lockfile to follow.

### Routine maintenance

```bash
# Once a month, check for outdated or vulnerable deps
npm outdated
npm audit --audit-level=high

# Belt-and-braces supply-chain scan (compromised-version list +
# registry integrity check). See SECURITY.md for the rationale.
npm run audit:deps
```

`npm audit fix --dry-run` shows the proposed changes before they are applied. Don't run `npm audit fix` blindly — review the diff first; some "fixes" downgrade major versions.

### Safe update procedure

npm supply-chain attacks (Sep 2025 chalk/debug, Jul 2025 Shai-Hulud worm) repeatedly catch installs that just trust whatever is on the registry. Follow this checklist before bumping any dependency:

1. **Diff the lockfile** before applying.

   ```bash
   npm install <pkg>@<version> --package-lock-only --no-audit --no-fund
   git diff package-lock.json | less   # eyeball the integrity hashes
   ```

   New integrity hashes that look reasonable + the same `resolved` URL pattern as before are normal. Wildly different URL paths or a missing `integrity` field is a red flag — stop.

2. **Run the supply-chain audit** locally.

   ```bash
   npm run audit:deps
   ```

   This re-fetches each top-level package's integrity hash from `registry.npmjs.org` and compares it against the lockfile. A mismatch means the tarball was retroactively swapped — abort the update, report to the registry.

3. **Install for real** with `npm ci` (not `npm install`).

   ```bash
   npm ci --no-audit --no-fund
   ```

   `npm ci` refuses to install if the lockfile and `package.json` disagree, so the only way new code reaches your `node_modules` is via the lockfile you just diffed.

4. **(Optional, paranoid)** skip every transitive postinstall script.

   ```bash
   npm ci --ignore-scripts
   ```

   This skips `preinstall` / `install` / `postinstall` hooks across the tree. `better-sqlite3` uses such a hook to download a prebuilt native binary from GitHub Releases; with `--ignore-scripts` you'll need a build toolchain (`build-essential`, `python3`) so node-gyp can compile from source as a fallback. The Dockerfile in this repo already does that. Bare-metal installs may prefer to skip this step unless you're actively investigating a supply-chain incident.

5. **Run the smoke test** before restarting the live panel.

   ```bash
   npm test
   ```

6. **Restart and watch the journal** for unexpected logs in the first minute. The boot lines should be: `migration … applied/recorded`, `Database ready`, `[UDP] listening`, the banner, the AC paths check. Anything else is worth investigating before you walk away.

---

## Log rotation

`AC_LOG_FILE` (default `<panel>/logs/ac_server.log`) grows as long as acServer runs. A panel that's been up for months can fill the disk and take everything down with it. The "Clear logs" admin button in the UI truncates the file on demand, but on a busy server you want automatic rotation too.

Create `/etc/logrotate.d/assetto-server-panel`:

```
/home/<your-user>/assetto-server-panel/logs/ac_server.log {
  weekly
  rotate 4
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
```

> `copytruncate` is the load-bearing line. The panel keeps the log fd open while it writes; a normal `rename + create` rotate would leave the panel writing into a deleted inode that never frees disk space. `copytruncate` copies the current contents to the rotated file, then truncates the original in place — no fd disturbance, no panel restart needed.

Test with `sudo logrotate -d /etc/logrotate.d/assetto-server-panel` (dry-run) before relying on the cron.

---

## Hardening the systemd unit

The minimal unit above is enough for a home lab. For tighter sandboxing add the following to the `[Service]` block:

```ini
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/path/to/assetto-server-panel /srv/assetto /home/<your-user>/ac_server
PrivateTmp=true
LimitNOFILE=4096
MemoryMax=512M
```

- `ProtectSystem=strict` makes the whole filesystem read-only except for the explicit `ReadWritePaths`.
- `PrivateTmp=true` gives the panel its own `/tmp` namespace — chunked-upload temp dirs live there, so this is purely an isolation win.
- `LimitNOFILE=4096` — the panel keeps several open file descriptors (SSE clients, UDP socket, DB, log fd). Default `1024` is fine but tight; bumping prevents surprise EMFILE under load.
- `MemoryMax=512M` is a safety belt: a runaway mod extraction or memory leak triggers OOM kill instead of swap-thrashing the box.
