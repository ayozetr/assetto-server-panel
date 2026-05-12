# API Reference

All endpoints are served by `server.js` under the same origin as the frontend (`http://<server-ip>:3000`).

## Authentication

All API endpoints except `/api/health` and the four `/api/auth/*` routes require a valid session. The session token is stored in an `HttpOnly` cookie (`sid`) set by the server on login. The browser sends it automatically with every request.

Requests that lack a valid session receive `401 Unauthorized`.

---

## Auth endpoints

### `GET /api/health`
Liveness probe. No auth required. Intentionally returns no diagnostic data to anonymous clients.

**Response:** `{ "ok": true }`

---

### `POST /api/auth/login`
Authenticate with username and password.

**Body:** `{ "username": "Admin", "password": "..." }`

**Response:**
```json
{
  "ok": true,
  "user": { "name": "Admin", "role": "admin", "mustChangePassword": false }
}
```

Sets an `HttpOnly` session cookie (`sid`).

Rate-limited: 5 failed attempts per IP locks the endpoint for 15 minutes.

---

### `POST /api/auth/logout`
Invalidate the current session and clear the cookie.

---

### `GET /api/auth/me`
Return the currently authenticated user.

**Response:** `{ "username": "Admin", "role": "admin", "mustChangePassword": false }`

---

### `POST /api/auth/change-password`
Change the authenticated user's own password.

**Auth required:** yes (session). Username is read from the session — it can not be passed in the body.

**Rate limit:** shares the login limiter (5 attempts per IP per 15 minutes).

**Body:**
```json
{ "currentPassword": "...", "newPassword": "..." }
```

Resets `mustChangePassword` to `false` on success.

---

### Request tracing

Every request is tagged with an `X-Request-Id` header in the response. If the client sends one (e.g. set by Cloudflare), the panel honours it; otherwise the panel mints a short hex id. Server-side log lines include this id so you can correlate UI errors with backend logs by reading the response header.

---

### CSRF & Origin checks

All `POST`/`PUT`/`DELETE`/`PATCH` requests require either a missing `Origin`/`Referer` header (when the proxy strips it) **or** a value whose `host` matches the request `Host` header. Cross-origin requests are rejected with `403 { error: 'Cross-origin request blocked' }`.

---

## Server metrics

### `GET /api/metrics`
Live server metrics.

**Auth required:** yes

**Response:**
```json
{
  "cpu": 12.4,
  "ram": { "used": 1840, "total": 8192 },
  "uptime": 3600,
  "running": true,
  "cpuName": "Intel Core i7-...",
  "publicIp": "1.2.3.4",
  "liveTrack": "loros",
  "httpPort": 8081
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

**Per-user concurrency cap:** at most 6 simultaneous SSE connections per username. The 7th returns `429 { error: "Too many concurrent log streams for this user — close other tabs and retry" }`. The cap covers normal usage (a few tabs, a phone, an ops dashboard) while preventing an authenticated client from pinning unlimited file descriptors and heartbeat timers.

```
event: init
data: [...]

data: { "id": 42, "time": "...", "lvl": "OK", "tag": "...", "msg": "..." }
```

---

## Configuration

### `GET /api/config`
Read `server_cfg.ini` as a JSON object.

**Auth required:** yes

In addition to the `[SERVER]` mapping, the response carries per-session values used by the *Session* page:

| Field | Source |
| --- | --- |
| `practiceEnabled` | `true` if `[PRACTICE]` exists in the INI |
| `qualifyEnabled`  | `true` if `[QUALIFY]` exists in the INI  |
| `raceEnabled`     | `true` if `[RACE]` exists in the INI |
| `practiceTime` | `[PRACTICE].TIME` (minutes) — falls back to 10 when the section is absent |
| `qualifyTime`  | `[QUALIFY].TIME`  (minutes) — falls back to 10 when the section is absent |
| `raceLaps`     | `[RACE].LAPS` — falls back to 5 when the section is absent |
| `sunAngle`     | `[SERVER].SUN_ANGLE` — convert to hour-of-day via `round(angle/16)+13` |
| `weather`      | `[WEATHER_0].GRAPHICS` (e.g. `3_clear`) |
| `airTemp`      | `[WEATHER_0].BASE_TEMPERATURE_AMBIENT` |
| `penalties`    | inverse of `[SERVER].RACE_GAS_PENALTY_DISABLED` |
| `slots`        | ordered array of `{ "id": "<carId>", "skin": "<skinName>"\|null }` parsed from each `[CAR_n]` block of `entry_list.ini`; preserves the grid layout so the Session page restores 1:1 on F5 |
| `cars`         | deduplicated list of `[SERVER].CARS` ids (convenience — same set the running server allows) |

---

### `PUT /api/config`
Write a JSON object back to `server_cfg.ini`. A `.bak` backup is created before writing.

**Auth required:** yes (admin)

**Body:** JSON object with any subset of config keys. Port values must be integers in range 1–65535.

---

### `GET /api/whitelist`
Read `whitelist.txt` as a list of Steam IDs.

**Auth required:** yes

**Response:** `{ "ids": ["76561198000000001", ...] }`

---

### `PUT /api/whitelist`
Write a new list of Steam IDs to `whitelist.txt`. Each ID is validated as a 17-digit number.

**Auth required:** yes (admin)

**Body:** `{ "ids": ["76561198000000001", ...] }`

---

### `POST /api/whitelist/add`
Append a single Steam GUID to the whitelist (used by the per-player button on the *Players* page).

**Auth required:** yes (admin)

**Body:** `{ "guid": "76561198000000001", "name": "optional display name" }`

**Response:** `{ "ok": true, "total": <count>, "alreadyPresent": false }`

---

## Players

### `GET /api/players`
Live player list — drivers currently connected to the AC server.

**Auth required:** yes

Source priority:
1. **UDP plugin listener** (primary). When the dashboard has live ACSP events flowing, the connected-car map carries every detail straight from acServer's `NEW_CONNECTION` + `LAP_COMPLETED` packets: name, Steam GUID, car model, best lap, last lap and lap count. This makes Whitelist/Ban work from the first connection and best/last times appear live without waiting for the post-session JSON.
2. **`/api/details`** (HTTP fallback). Older acServer builds expose rich per-car data here; current Go builds return `200 OK` with an empty body so this branch usually goes unused.
3. **`/JSON|0`** (last resort). Lists connected drivers' names + models. Best/last/laps/ping all read `0`. To still allow Whitelist/Ban, the GUID is recovered by exact name match against the `players` table (populated by the importer + UDP listener); ambiguous-name matches are skipped deliberately. Kick keeps working in any tier because it uses the car-slot index.

---

### `GET /api/players/history`
All past players from SQLite with session stats.

**Auth required:** yes

---

### `POST /api/players/kick`
Kick a player via the AC HTTP API.

**Auth required:** yes (admin)

**Body:** `{ "carId": 0 }` — the car slot index from the live player list.

---

### `POST /api/players/ban`
Add a Steam GUID to `blacklist.txt`.

**Auth required:** yes (admin)

**Body:** `{ "guid": "76561198...", "name": "PlayerName" }`

---

### `PUT /api/players/:guid/nickname`
Set or clear the admin-defined nickname for a player. Persisted in the `players.nickname` column; lap times (joined by GUID) pick it up automatically via `/api/results`.

**Auth required:** yes (admin)

**URL:** `:guid` must be a 17-digit Steam GUID.

**Body:** `{ "nickname": "José García" }` — empty string clears.

**Response:** `{ "ok": true, "player": { "guid": "...", "name": "...", "nickname": "..." } }` — `404` if the GUID has no `players` row yet (a player is only inserted when the result importer first sees them).

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

### `GET /api/results`
Lap times from imported result files. Supports server-side filtering — push the filter into the URL instead of round-tripping every row.

**Auth required:** yes

**Query params:**
- `limit` — max rows (default 500, hard cap 5000)
- `track` — exact track ID
- `car` — exact car ID
- `driver` — Steam GUID
- `from`, `to` — `YYYY-MM-DD` (inclusive)
- `validOnly=1` — exclude laps with cuts

---

### `POST /api/session/apply`
Write the *Session* page state to `server_cfg.ini`. Auto-restarts the AC server if it is running (unless `restart: false`).

**Auth required:** yes (admin)

**Body:** every field is optional — omitted fields are left untouched.

| Field | Target | Notes |
| --- | --- | --- |
| `trackId` | `[SERVER].TRACK` | |
| `layout`  | `[SERVER].CONFIG_TRACK` | |
| `slots`   | `entry_list.ini` *and* the deduplicated `[SERVER].CARS` list | ordered array of `{ "id": "<carId>", "skin": "<skinName>"\|null }`; each element becomes one `[CAR_n]` block (MODEL + SKIN). Cycled to fill `maxClients` when fewer slots are sent than there are grid positions. `skin: null` (or missing) maps to `SKIN=Base`. Ids and skin names go through `isValidContentId` / `isValidSkinName` validators; any invalid entry is dropped silently. |
| `maxClients` | `[SERVER].MAX_CLIENTS` | integer 1..200; also caps how many `[CAR_n]` blocks `entry_list.ini` gets when the slot list is shorter |
| `practiceEnabled` / `qualifyEnabled` / `raceEnabled` | `[PRACTICE]` / `[QUALIFY]` / `[RACE]` section presence | when `false` the whole section is removed; reject if all three end up `false` |
| `practiceTime` / `qualifyTime` / `raceLaps` | `[PRACTICE].TIME` / `[QUALIFY].TIME` / `[RACE].LAPS` | ignored for sessions being disabled this turn |
| `time`    | `[SERVER].SUN_ANGLE` | hour 0..23, written as `(h-13)·16` clamped to [-80,80] |
| `weather` | `[WEATHER_0].GRAPHICS` | one of the seven Kunos presets |
| `airTemp` | `[WEATHER_0].BASE_TEMPERATURE_AMBIENT` | 0..40 |
| `penalties` | `[SERVER].RACE_GAS_PENALTY_DISABLED` | inverted (`true` → `0`) |
| `restart` | — | default `true`; restarts the AC server iff it was running |

Whenever the body carries `cars`, `entry_list.ini` is rewritten so every `[CAR_n].MODEL` is in `[SERVER].CARS` — required, since `acServer` refuses to boot otherwise. The previous file is preserved as `entry_list.ini.bak`.

---

### `GET /api/content/cars/:id/thumb`
Serve the car's badge/preview image. Falls back to the bundled Kunos asset.

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

**Body:** `multipart/form-data` with a `file` field containing a `.zip`, `.rar`, or `.7z` archive.

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

**Auth required:** yes

---

### `POST /api/panel/users`
Create a new panel user.

**Auth required:** yes (admin)

**Body:** `{ "username": "Sample User", "password": "...", "role": "user" }`

Username must be 1–64 characters: letters, numbers, `_` and `-` only.

---

### `PUT /api/panel/users/:username`
Update a user's role or password.

**Auth required:** yes (admin)

**Body:** `{ "role": "admin" }` or `{ "password": "..." }` (or both)

---

### `DELETE /api/panel/users/:username`
Delete a panel user.

**Auth required:** yes (admin)

---

## Audit log

### `GET /api/audit`
Return audit log entries in reverse chronological order, with cursor pagination.

**Auth required:** yes (admin)

**Query params:**
- `limit` — page size (default 50, max 500)
- `before` — id cursor; returns entries with `id < before`. Use `nextCursor` from a previous response.

**Response:**
```json
{
  "rows": [
    {
      "id": 42,
      "actor": "Admin",
      "action": "player.ban",
      "target": "76561198000000001",
      "detail": "PlayerName",
      "logged_at": "2026-05-06 14:23:00"
    }
  ],
  "hasMore": true,
  "nextCursor": 23
}
```

Recorded actions: `server.start`, `server.stop`, `server.restart`, `player.kick`, `player.ban`, `config.save`, `session.apply`, `mod.install`, `user.create`, `user.update`, `user.delete`, `whitelist.add`, `admin.backup`.

A daily sweeper deletes entries older than `AUDIT_RETENTION_DAYS` (env, default 365).

---

### `GET /api/admin/backup`
Stream a consistent snapshot of `assetto.db` produced via SQLite `VACUUM INTO`. Response is `application/octet-stream` with `Content-Disposition: attachment`.

**Auth required:** yes (admin)

Useful for periodic backups before risky operations (mass user changes, password resets) or before an upgrade.

---

### `GET /api/admin/stats`
Internal status snapshot for ops debugging. Returns Node version + uptime + RSS memory, sweeper timestamps and last-removed counters, in-flight counters (active uploads, pending chunk dirs, SSE clients, server-control mutex), and table sizes.

**Auth required:** yes (admin)

```json
{
  "nodeVersion": "v20.20.2",
  "uptimeSec": 12345,
  "memoryMb": 78,
  "auditRetentionDays": 365,
  "trustProxy": true,
  "serverActionInFlight": false,
  "activeUploads": 0,
  "pendingChunkDirs": 0,
  "sseClients": 1,
  "sweepers": {
    "audit":  { "lastRunAt": 1778195408412, "lastRemoved": 0 },
    "login":  { "lastRunAt": 1778195408412, "lastRemoved": 3 },
    "chunks": { "lastRunAt": 1778195408415, "lastRemoved": 0 }
  },
  "counts": {
    "sessions": 2, "audit_log": 137, "login_attempts": 0,
    "panel_users": 2, "laps": 4521, "mod_history": 18
  }
}
```

Verify the audit hash chain locally with `node tools/verify-audit.js path/to/assetto.db` (downloadable via `/api/admin/backup`).

---

### `GET /api/admin/metrics`
Prometheus exposition format (`text/plain; version=0.0.4`). Each metric is a snapshot — no rate counters are kept across scrapes.

**Auth required:** yes (admin)

Exposed:
- `panel_uptime_seconds`, `panel_memory_rss_bytes`
- `panel_sessions_total`, `panel_panel_users_total`, `panel_audit_log_total`, `panel_login_attempts_total`, `panel_laps_total`, `panel_mod_history_total`
- `panel_sse_clients`, `panel_active_uploads`, `panel_server_action_in_flight`
- `panel_sweeper_last_run_seconds{sweeper="..."}` and `panel_sweeper_last_removed_total{sweeper="..."}`
- `ac_server_up`, `ac_server_uptime_seconds`

Scrape from a sidecar with cookie auth, or use `ADMIN_TOKEN` if you've set it.

---

### Offline data caching (PWA)
The Service Worker caches successful GETs for `/api/cars`, `/api/tracks`, `/api/config`, `/api/results`, `/api/players/history`. When the network is unreachable, it serves the last cached response and tags it with `X-AC-Cache: stale-offline`. Other endpoints return `503` with `{ "error": "Offline" }`.

The frontend listens for the browser's `online`/`offline` events and shows a banner while offline.

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
Alias for restart. `acServer` does not support live config reload via signal.
