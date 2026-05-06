# API Reference

All endpoints are served by `server.js` under the same origin as the frontend (`http://<server-ip>:3000`).

Protected endpoints require a valid session token sent as a `Bearer` header:

```
Authorization: Bearer <token>
```

Tokens are obtained from `POST /api/auth/login`.

---

## Authentication

### `POST /api/auth/login`
Authenticate with username and password.

**Body:** `{ "username": "Admin", "password": "..." }`

**Response:** `{ "ok": true, "token": "...", "user": { "name": "Admin", "role": "admin" } }`

Rate-limited: 5 failed attempts per IP locks the endpoint for 15 minutes.

---

### `POST /api/auth/logout`
Invalidate the current session token.

**Auth required:** yes

---

### `GET /api/auth/me`
Return the currently authenticated user.

**Auth required:** yes

**Response:** `{ "name": "Admin", "role": "admin" }`

---

### `POST /api/auth/change-password`
Change the authenticated user's own password.

**Auth required:** yes

**Body:** `{ "current": "...", "password": "..." }`

---

## Server metrics

### `GET /api/metrics`
Live server metrics.

**Auth required:** yes

**Response:**
```json
{
  "cpu": 12.4,
  "ram": 1840,
  "uptime": 3600,
  "acRunning": true,
  "cpuModel": "Intel Core i7-...",
  "publicIp": "1.2.3.4",
  "liveTrack": "loros"
}
```

---

## Logs

### `GET /api/logs?n=150`
Return the last N log lines from the in-memory buffer (max 500).

**Auth required:** yes

**Response:** `[{ "id": 1, "time": "12:34:56", "lvl": "INFO", "tag": "SERVER", "msg": "..." }]`

---

### `GET /api/logs/stream`
Server-Sent Events stream. Pushes an `init` event with the full current buffer, then a `message` event for each new log line.

**Auth required:** yes

```
event: init
data: [...]

data: { "id": 42, "time": "...", "lvl": "OK", "tag": "...", "msg": "..." }
```

---

## Configuration

### `GET /api/config`
Read `server_cfg.ini` as a JSON object.

**Auth required:** yes (admin)

---

### `PUT /api/config`
Write a JSON object back to `server_cfg.ini`. A `.bak` backup is created before writing.

**Auth required:** yes (admin)

**Body:** JSON object with any subset of config keys.

---

### `GET /api/whitelist`
Read `whitelist.txt` as a list of Steam IDs.

**Auth required:** yes (admin)

**Response:** `{ "ids": ["76561198000000001", ...] }`

---

### `PUT /api/whitelist`
Write a new list of Steam IDs to `whitelist.txt`. Each ID is validated as a 17-digit number.

**Auth required:** yes (admin)

**Body:** `{ "ids": ["76561198000000001", ...] }`

---

## Players

### `GET /api/players`
Live player list proxied from the AC HTTP API.

**Auth required:** yes

---

### `GET /api/players/history`
All past players from SQLite with session stats.

**Auth required:** yes

---

### `POST /api/players/kick`
Kick a player via the AC HTTP API.

**Auth required:** yes (admin)

**Body:** `{ "guid": "76561198..." }`

---

### `POST /api/players/ban`
Add a Steam GUID to `blacklist.txt`.

**Auth required:** yes (admin)

**Body:** `{ "guid": "76561198..." }`

---

## Content

### `GET /api/cars`
All cars from `AC_CONTENT_DIR/cars/`, normalised with name, brand, specs and skin list.

**Auth required:** yes

---

### `GET /api/tracks`
All tracks from `AC_CONTENT_DIR/tracks/`, normalised with name, country, length and layout list.

**Auth required:** yes

---

### `GET /api/results?limit=500`
All lap times from imported result files (max 5000).

**Auth required:** yes

---

### `POST /api/session/apply`
Write track and car selection to `server_cfg.ini`.

**Auth required:** yes (admin)

**Body:** `{ "track": "loros", "cars": ["av_citroen_saxo_ph1a_gra"] }`

---

### `GET /api/content/cars/:id/thumb`
Serve the car's badge/preview image.

---

### `GET /api/content/cars/:id/skins/:skin/preview`
Serve a skin preview image.

---

### `GET /api/content/tracks/:id/thumb`
Serve the track preview image.

---

### `GET /api/content/tracks/:id/layout/:layout/thumb`
Serve a per-layout track preview image.

---

## Mod upload

### `POST /api/mods/upload`
Direct multipart upload. Suitable for LAN access.

**Auth required:** yes

**Body:** `multipart/form-data` with a `file` field.

---

### `POST /api/mods/upload/chunk`
Chunked upload as base64 JSON. Use this when accessing via Cloudflare or other proxies that block large binary bodies. See [Mod installer → Chunked upload](mod-upload.md#chunked-upload).

**Auth required:** yes

**Body:**
```json
{
  "uploadId": "abc123",
  "chunkIndex": 0,
  "totalChunks": 12,
  "filename": "my_car.rar",
  "data": "<base64>"
}
```

---

### `GET /api/mods/history`
Upload history from SQLite (last 100 entries).

**Auth required:** yes

---

### `DELETE /api/mods/history`
Clear all upload history.

**Auth required:** yes

---

## Panel settings

### `GET /api/panel/settings`
Read panel settings (`upload_max_mb`, `chunked_upload`, `lang`).

**Auth required:** yes

---

### `PUT /api/panel/settings`
Update one or more panel settings.

**Auth required:** yes (admin)

**Body:** `{ "uploadMaxMb": 1000, "chunkedUpload": true, "lang": "en" }`

---

## Panel users

### `GET /api/panel/users`
List all panel users.

**Auth required:** yes (admin)

---

### `POST /api/panel/users`
Create a new panel user.

**Auth required:** yes (admin)

**Body:** `{ "username": "Sample User", "password": "...", "role": "user" }`

---

### `PUT /api/panel/users/:username`
Update a user's role or password.

**Auth required:** yes (admin)

**Body:** `{ "role": "admin" }` or `{ "password": "..." }`

---

### `DELETE /api/panel/users/:username`
Delete a panel user. Cannot delete yourself.

**Auth required:** yes (admin)

---

## Server control

All server control endpoints require admin.

### `POST /api/server/start`
Spawn the `acServer` binary.

### `POST /api/server/stop`
Kill the running `acServer` process.

### `POST /api/server/restart`
Stop then start.

### `POST /api/server/reload`
Send SIGHUP to `acServer` (reload config without full restart).
