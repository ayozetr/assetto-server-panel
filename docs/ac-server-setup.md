# Assetto Corsa Dedicated Server — Setup Guide

Step-by-step instructions to install and configure an Assetto Corsa dedicated server on Linux using SteamCMD, ready to be managed by this dashboard.

---

## Requirements

- A Linux server (Ubuntu 20.04+ or Debian 11+ recommended)
- A Steam account that **owns Assetto Corsa** (required to download server files)
- At least 4 GB of free disk space
- Ports `9600` (TCP+UDP) and `8081` (TCP) open in your firewall

---

## 1. Install SteamCMD

SteamCMD is a command-line version of Steam used to download dedicated server files.

> **Official documentation:** [https://developer.valvesoftware.com/wiki/SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD)
> The Valve wiki covers installation on all platforms (Linux, Windows, macOS), all available commands, login options, and advanced usage. Refer to it for anything not covered here.

Quick install on Ubuntu/Debian:

```bash
# Install dependencies
sudo apt-get update
sudo apt-get install -y software-properties-common lib32gcc-s1 curl

# Create a dedicated user (optional but recommended)
sudo useradd -m steamuser
sudo su - steamuser

# Download and extract SteamCMD
mkdir -p ~/steamcmd && cd ~/steamcmd
curl -sqL "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" | tar zxvf -
```

---

## 2. Download the Assetto Corsa Server

Run SteamCMD and log in with your Steam account:

```bash
~/steamcmd/steamcmd.sh \
  +login YOUR_STEAM_USERNAME \
  +force_install_dir ~/ac_server \
  +app_update 302550 validate \
  +quit
```

> `302550` is the Steam App ID for the **Assetto Corsa Dedicated Server**. It requires a Steam account that owns Assetto Corsa (App ID `244210`).

SteamCMD will prompt for your Steam password and, if enabled, a Steam Guard code. After the download finishes, the server files will be in `~/ac_server`.

### Verify the installation

```bash
ls ~/ac_server
# Expected output includes: acServer  cfg/  content/  results/  ...
```

---

## 3. Add content

The server ships with **no cars or tracks** by default. You need to copy content from your Assetto Corsa PC installation.

### Option A — Copy from a Windows machine

On your Windows PC (Steam library → `assettocorsa\content\`), copy the `cars/` and `tracks/` folders to the server:

```bash
scp -r "C:/Program Files (x86)/Steam/steamapps/common/assettocorsa/content/cars" user@YOUR_SERVER:~/ac_server/content/
scp -r "C:/Program Files (x86)/Steam/steamapps/common/assettocorsa/content/tracks" user@YOUR_SERVER:~/ac_server/content/
```

### Option B — Upload mods via the dashboard

Once the dashboard is running you can upload `.zip`, `.rar`, or `.7z` mod archives directly from the browser. The dashboard will detect whether each archive is a car or track and place it in the correct folder automatically.

---

## 4. Configure the server

The main configuration file is `~/ac_server/cfg/server_cfg.ini`. A minimal working configuration looks like this:

```ini
[SERVER]
NAME=My Assetto Corsa Server
CARS=ks_ferrari_f40
TRACK=magione
CONFIG_TRACK=
SUN_ANGLE=-16
PASSWORD=
ADMIN_PASSWORD=secretadmin
MAX_CLIENTS=10
RACE_OVER_TIME=60
ALLOWED_TYRES_OUT=2
LOOP_MODE=1
SLEEP_TIME=1
CLIENT_SEND_INTERVAL_HZ=18
SEND_BUFFER_SIZE=0
RECV_BUFFER_SIZE=0
REGISTER_TO_LOBBY=1
UDP_PORT=9600
TCP_PORT=9600
HTTP_PORT=8081
NUM_THREADS=2
```

> **Important:** `HTTP_PORT` must match `AC_HTTP_PORT` in your `.env` file. The dashboard uses this port to detect whether the server is running and to fetch live player data.

### UDP plugin (live lap capture)

Two extra lines enable live event streaming from `acServer` to the dashboard so laps land in the database the instant a driver crosses the finish line (instead of waiting for `acServer` to write the post-session JSON, which only happens at session end):

```ini
UDP_PLUGIN_LOCAL_PORT=12000
UDP_PLUGIN_ADDRESS=127.0.0.1:12001
```

You **do not need to set these manually**. The first time an admin clicks "Apply" on the Session page, the panel detects `UDP_PLUGIN_LOCAL_PORT=0` (or an empty `UDP_PLUGIN_ADDRESS`) and writes the two lines automatically. The subsequent `acServer` restart picks them up and the dashboard's UDP listener binds on the matching port. From then on every `NEW_CONNECTION` / `LAP_COMPLETED` / `CONNECTION_CLOSED` event is consumed in real time.

If you ever want to disable it, set `UDP_PLUGIN_LOCAL_PORT=0` and the panel falls back to the (slower) post-session JSON importer. The cross-source dedup index makes both paths safe to enable simultaneously.

### Entry list

`~/ac_server/cfg/entry_list.ini` defines the car slots. One `[CAR_N]` block per slot:

```ini
[CAR_0]
MODEL=ks_ferrari_f40
SKIN=red_1
SPECTATOR_MODE=0
DRIVERNAME=
TEAM=
GUID=
BALLAST=0
RESTRICTOR=0
```

Add as many `[CAR_N]` blocks as `MAX_CLIENTS` allows.

---

## 5. Test the server manually

Before connecting the dashboard, verify the server starts cleanly on its own:

```bash
cd ~/ac_server
./acServer
```

You should see output like:
```
Assetto Corsa Dedicated Server
...
Listening on port 9600 UDP/TCP
HTTP server started on port 8081
```

Press `Ctrl+C` to stop it once you have confirmed it works.

---

## 6. Open firewall ports

```bash
# UFW (Ubuntu)
sudo ufw allow 9600/tcp
sudo ufw allow 9600/udp
sudo ufw allow 8081/tcp

# firewalld (CentOS/Fedora)
sudo firewall-cmd --permanent --add-port=9600/tcp
sudo firewall-cmd --permanent --add-port=9600/udp
sudo firewall-cmd --permanent --add-port=8081/tcp
sudo firewall-cmd --reload
```

> Port `3000` (the dashboard) only needs to be open if you are **not** using a reverse proxy or Cloudflare Tunnel. See [Production deployment](deployment.md) for details.

---

## 7. Configure the dashboard

Edit the dashboard's `.env` to point at your new server:

```env
AC_SERVER_RESULTS=/home/steamuser/ac_server/results
AC_CFG_DIR=/home/steamuser/ac_server/cfg
AC_CONTENT_DIR=/home/steamuser/ac_server/content
AC_SERVER_BIN=/home/steamuser/ac_server/acServer
AC_SERVER_DIR=/home/steamuser/ac_server
AC_HTTP_PORT=8081
```

Then start the dashboard — it will automatically import any result files already in `results/` and detect the AC server status via the HTTP port.

---

## Directory layout after setup

```
~/ac_server/
├── acServer            ← server binary
├── cfg/
│   ├── server_cfg.ini  ← main config (edited via the dashboard Config page)
│   ├── entry_list.ini  ← car slot definitions
│   └── whitelist.txt   ← optional IP/GUID whitelist
├── content/
│   ├── cars/           ← car mods go here
│   └── tracks/         ← track mods go here
└── results/            ← session result JSON files (imported automatically by dashboard)
```

---

## Updating the server

Run SteamCMD again at any time to update to the latest server version:

```bash
~/steamcmd/steamcmd.sh \
  +login YOUR_STEAM_USERNAME \
  +force_install_dir ~/ac_server \
  +app_update 302550 \
  +quit
```

Your `cfg/` and `content/` directories are preserved during updates.

---

## Troubleshooting

| Problem | Likely cause | Solution |
|---------|-------------|----------|
| `./acServer: No such file or directory` | Wrong architecture; missing 32-bit libs | Install `lib32gcc-s1` and `lib32stdc++6` |
| Server starts but clients can't connect | Firewall blocking UDP 9600 | Open the port with `ufw` or `firewalld` |
| Dashboard shows server as stopped | `HTTP_PORT` mismatch between `server_cfg.ini` and `.env` | Make sure both use the same port (default `8081`) |
| `steam guard` prompts on every run | Steam Guard blocks automated logins | Use SteamCMD's anonymous mode for tools that don't need it, or whitelist the server IP in Steam settings |

For more general troubleshooting, see [troubleshooting.md](troubleshooting.md).
