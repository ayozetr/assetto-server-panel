# Production Deployment

## Systemd service (recommended)

Running the panel as a systemd service ensures it starts automatically on boot and restarts if it crashes.

### 1. Create the service file

```bash
sudo nano /etc/systemd/system/assetto-dashboard.service
```

```ini
[Unit]
Description=Assetto Server Panel
After=network.target

[Service]
Type=simple
User=<your-user>
WorkingDirectory=/path/to/assetto-dashboard
ExecStartPre=/home/<your-user>/.nvm/versions/node/v20.20.2/bin/node build.js
ExecStart=/home/<your-user>/.nvm/versions/node/v20.20.2/bin/node server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/path/to/assetto-dashboard/.env
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
sudo systemctl enable --now assetto-dashboard
```

### 3. Useful commands

```bash
sudo systemctl status assetto-dashboard     # check status
sudo systemctl restart assetto-dashboard    # apply changes after update
sudo systemctl stop assetto-dashboard       # stop the panel
journalctl -u assetto-dashboard -f          # live logs
journalctl -u assetto-dashboard -n 100      # last 100 log lines
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
cd assetto-dashboard
git pull
npm ci               # reproducible install, refuses to drift from package-lock.json
sudo systemctl restart assetto-dashboard
```

> **`npm ci` vs `npm install`** — `npm install` rewrites `package-lock.json` whenever the lockfile and `package.json` disagree. If the panel host is ever compromised and `package.json` is amended with a malicious `postinstall`, `npm install` happily runs it on the next deploy. `npm ci` refuses any drift and aborts. Production deploys should use `npm ci`; switch back to `npm install` only when you intentionally edit `package.json` locally and want the lockfile to follow.

### Routine maintenance

```bash
# Once a month, check for outdated or vulnerable deps
npm outdated
npm audit --audit-level=high
```

`npm audit fix --dry-run` shows the proposed changes before they are applied. Don't run `npm audit fix` blindly — review the diff first; some "fixes" downgrade major versions.

---

## Log rotation

`AC_LOG_FILE` (default `<panel>/logs/ac_server.log`) grows as long as acServer runs. A panel that's been up for months can fill the disk and take everything down with it. The "Clear logs" admin button in the UI truncates the file on demand, but on a busy server you want automatic rotation too.

Create `/etc/logrotate.d/assetto-dashboard`:

```
/home/<your-user>/assetto-dashboard/logs/ac_server.log {
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

Test with `sudo logrotate -d /etc/logrotate.d/assetto-dashboard` (dry-run) before relying on the cron.

---

## Hardening the systemd unit

The minimal unit above is enough for a home lab. For tighter sandboxing add the following to the `[Service]` block:

```ini
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/path/to/assetto-dashboard /srv/assetto /home/<your-user>/ac_server
PrivateTmp=true
LimitNOFILE=4096
MemoryMax=512M
```

- `ProtectSystem=strict` makes the whole filesystem read-only except for the explicit `ReadWritePaths`.
- `PrivateTmp=true` gives the panel its own `/tmp` namespace — chunked-upload temp dirs live there, so this is purely an isolation win.
- `LimitNOFILE=4096` — the panel keeps several open file descriptors (SSE clients, UDP socket, DB, log fd). Default `1024` is fine but tight; bumping prevents surprise EMFILE under load.
- `MemoryMax=512M` is a safety belt: a runaway mod extraction or memory leak triggers OOM kill instead of swap-thrashing the box.
