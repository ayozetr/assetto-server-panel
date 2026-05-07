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
TimeoutStopSec=15    # matches the server's 10 s force-exit guard

[Install]
WantedBy=multi-user.target
```

> **`ExecStartPre=node build.js`** — the panel ships JSX in `src/` that needs to be transpiled to plain JS in `dist/` before the server starts serving it. esbuild does this in ~20 ms. If you start the server via `npm start` instead, the `prestart` script in `package.json` runs the same step automatically; either form works.

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
npm install          # in case dependencies changed
sudo systemctl restart assetto-dashboard
```
