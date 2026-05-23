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

### `GET /api/setup/status`
First-run readiness probe used by the install wizard. No auth required — surfacing whether the panel can already see `server_cfg.ini`, `cars/`, `tracks/` doesn't leak anything sensitive, and the wizard needs to read it before any user exists.

**Response:**

```json
{
  "ready": true,
  "issues": [],
  "paths": {
    "cfgFile": { "path": "/srv/assetto/cfg/server_cfg.ini", "exists": true },
    "cars":    { "path": "/srv/assetto/content/cars",       "exists": true },
    "tracks":  { "path": "/srv/assetto/content/tracks",     "exists": true },
    "…": "…"
  },
  "detectedAcRoot": "/srv/assetto"
}
```

`ready` is `true` only when all three critical paths (`cfgFile`, `cars`, `tracks`) resolve to an existing file/dir. `issues` lists which of those three are missing — the wizard renders one row per entry with the failing path so the operator knows what to fix. `detectedAcRoot` is the auto-discovered root (or `null` if nothing plausible was found).

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
Return the currently authenticated user, including their effective permission
set so the frontend can render conditional UI without an extra fetch.

**Response:**
```json
{
  "username": "Admin",
  "role": "admin",
  "mustChangePassword": false,
  "permissions": {
    "serverControl":    true,
    "sessionEdit":      true,
    "serverConfig":     true,
    "whitelistManage":  true,
    "playerModeration": true,
    "modUpload":        true,
    "discordWebhook":   true,
    "auditView":        true,
    "dbBackup":         true
  }
}
```

Admin always gets every permission as `true`. Users get whatever the admin has
configured via the Users → Permissions card (see `/api/permissions/role`).

---

### `GET /api/auth/2fa/status`
Whether the current session's user has 2FA enabled, and whether a setup is in progress but not yet confirmed.

**Auth required:** yes

**Response:** `{ "enabled": <bool>, "pending": <bool> }`. With no DB available, both fields fall back to `false`.

---

### `POST /api/auth/2fa/setup`
Generate a fresh TOTP secret for the current user. The secret lives in `totp_pending` until the next endpoint confirms it — actually enrolling 2FA always takes two server round-trips so a half-completed flow doesn't lock the user out.

**Auth required:** yes

**Response:**

```json
{
  "ok": true,
  "secret": "JBSWY3DPEHPK3PXP…",
  "otpauth": "otpauth://totp/Assetto%20Server%20Panel:ayoze?secret=…&issuer=Assetto%20Server%20Panel"
}
```

The `secret` is base32-encoded 20 random bytes (RFC 4226 SHA-1 min). `otpauth` is the URI an authenticator app encodes into the QR. Calling this endpoint again before confirm rotates the pending secret — a partial setup never blocks a retry.

---

### `POST /api/auth/2fa/confirm`
Promote the pending secret into the active `totp_secret` after the user types a code from their authenticator app.

**Auth required:** yes

**Body:** `{ "code": "123456" }` — six digits, whitespace stripped.

**Response:** `{ "ok": true }` on success, `400` if there's no pending setup or the code isn't six digits, `401` for an invalid code, `429` if the global login-attempt rate limit is currently throttling the client IP (same bucket as `/api/auth/login`, on the assumption that brute-force should also affect 2FA confirmation). Audited as `user.2fa.enable`.

---

### `POST /api/auth/2fa/disable`
Turn 2FA off for the current user. Requires both the current password (so a stolen session cookie can't disable 2FA on its own) **and** a current 2FA code (proves the user still has access to the authenticator they're disabling).

**Auth required:** yes

**Body:** `{ "currentPassword": "…", "code": "123456" }`.

**Response:** `{ "ok": true }`. Returns `401` on either wrong-password or wrong-code, `400` if 2FA isn't currently on, `429` if the login rate limit fires. Audited as `user.2fa.disable`.

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
  "httpPort": 8081,
  "players": 3
}
```

`players` is the count of currently connected drivers — sourced primarily from the UDP plugin's live cars map and fallback to `/JSON|0`'s `IsConnected` flags when the plugin has no data yet. The Dashboard KPI ("Players Online X/N") reads it directly so the panel polls metrics only and stays in sync without a separate `/api/players` request.

---

## Logs

### `GET /api/logs?n=150`
Return the last N log lines from the in-memory buffer (max 500).

**Auth required:** yes

**Response:** `[{ "id": 1, "time": "12:34:56", "lvl": "INFO", "tag": "SERVER", "msg": "..." }]`

---

### `GET /api/logs/stream`
Server-Sent Events stream. Pushes an `init` event with the full current buffer, then a `message` event for each new log line, plus a `clear` event whenever `POST /api/logs/clear` fires (all open tabs wipe their state in lock-step).

**Auth required:** yes

**Per-user concurrency cap:** at most 6 simultaneous SSE connections per username. The 7th returns `429 { error: "Too many concurrent log streams for this user — close other tabs and retry" }`. The cap covers normal usage (a few tabs, a phone, an ops dashboard) while preventing an authenticated client from pinning unlimited file descriptors and heartbeat timers.

```
event: init
data: [...]

data: { "id": 42, "time": "...", "lvl": "OK", "tag": "...", "msg": "..." }

event: clear
data: {}
```

---

### `POST /api/logs/clear`
Persistent wipe — drops the in-memory `logBuffer`, truncates `AC_LOG_FILE` on disk (so the next process restart's `loadLogFileIntoBuffer` reads an empty file instead of replaying the old lines), and broadcasts the `clear` SSE event above so every connected tab empties its state. A `logs.clear` row is written to the audit log.

**Auth required:** yes (admin — strictly `checkAdminAuth`)

**Response:** `{ "ok": true }`

The "Clear logs" button in the Logs page invokes this. Non-admins don't see the button — the action affects every viewer and is irreversible.

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
| `country`      | English name parsed from `[GEO_PARAMS].COUNTRY` (everything before the comma), e.g. `Spain` |
| `countryIso`   | ISO-3166-1 alpha-2 code parsed from `[GEO_PARAMS].COUNTRY` (after the comma), e.g. `ES` — empty when the row has no comma or the suffix doesn't match `/^[A-Z]{2}$/` |
| `city`         | `[GEO_PARAMS].CITY` |

---

### `PUT /api/config`
Write a JSON object back to `server_cfg.ini`. Backups: a single `server_cfg.ini.bak` (legacy) plus a rotating set of timestamped copies (`server_cfg.ini.<timestamp>.bak`) are created before every write — see `rotateConfigBackup`.

**Auth required:** yes — requires the `serverConfig` permission. `password` / `adminPass` writes additionally require `admin` (a user with only `serverConfig` granted can't lock admins out via the AC server password). `restart=true` additionally requires `serverControl` — otherwise the convenience flag would bypass server-lifecycle gating.

**Body:** JSON object with any subset of config keys. Port values must be integers in range 1–65535. Country/city/iso are written into `[GEO_PARAMS]`, which is created on first write:

| Body key      | INI target | Notes |
| ---           | ---        | ---   |
| `country`     | `[GEO_PARAMS].COUNTRY` | Combined with `countryIso` as `"<Name>, <ISO2>"` — the format Content Manager and the acstuff lobby render with a flag. Empty string clears the row. |
| `countryIso`  | `[GEO_PARAMS].COUNTRY` | ISO-3166-1 alpha-2; non-matches are dropped, leaving just the name in the row. Sending only `countryIso` patches the suffix of the existing row. |
| `city`        | `[GEO_PARAMS].CITY`    | Free text, capped to 64 chars. |

`[GEO_PARAMS].IP` is always left blank so the lobby fills it from the registration packet — hard-coding it would break servers behind dynamic IPs / NAT.

The `[GEO_PARAMS]` value is read by the lobby at registration time, so changes require an AC server restart to reach Content Manager. Send `restart: true` in the same PUT to trigger it (gated by `serverControl` as noted above).

**Response:** `{ "ok": true, "restarted": false, "restartError": null, "applied": ["country", "city"], "rejected": [] }` — `applied` and `rejected` list the body keys that passed/failed validation so the UI can flag bad inputs instead of guessing why a save "didn't take".

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
Add a Steam GUID to `blacklist.txt` and write a row in the `bans` table for the audited/expiry view. Audited as `player.ban`.

**Auth required:** yes (`playerModeration` permission)

**Body:** `{ "guid": "76561198...", "name": "PlayerName", "reason": "...", "ttlHours": <int>|null }` — `ttlHours` makes the ban expire (`null` or omitted = permanent).

---

### `GET /api/bans`
List active and recently-expired bans for the Bans view.

**Auth required:** yes (`playerModeration` permission)

**Response:**

```json
[
  {
    "guid":      "76561198...",
    "name":      "PlayerName",
    "reason":    "...",
    "bannedBy":  "ayoze",
    "bannedAt":  "2026-05-19 22:11:03",
    "expiresAt": "2026-05-26 22:11:03",
    "permanent": false,
    "expired":   false
  }
]
```

Ordered with permanent bans first, then by `bannedAt` descending. `expiresAt` is `null` for permanent rows; `expired: true` is computed server-side so the UI doesn't have to compare clocks.

---

### `DELETE /api/players/:guid/ban`
Lift an active ban. Removes the GUID from `blacklist.txt` and the matching `bans` row. Audited as `player.unban`.

**Auth required:** yes (`playerModeration` permission)

**URL:** `:guid` must be a 17-digit Steam GUID.

**Response:** `{ "ok": true }`. The endpoint is idempotent — calling it on a GUID that wasn't banned still returns `ok` but the audit row records that nothing was actually removed.

---

### `PUT /api/players/:guid/nickname`
Set or clear the admin-defined nickname for a player. Persisted in the `players.nickname` column; lap times (joined by GUID) pick it up automatically via `/api/results`.

**Auth required:** yes (admin)

**URL:** `:guid` must be a 17-digit Steam GUID.

**Body:** `{ "nickname": "<display name>" }` — empty string clears.

**Response:** `{ "ok": true, "player": { "guid": "...", "name": "...", "nickname": "..." } }` — `404` if the GUID has no `players` row yet (a player is only inserted when the result importer first sees them).

---

## Public driver profiles

The two endpoints below are **unauthenticated** — they are the data layer behind the shareable `/p/<steam-id>` page (HTML, also unauthenticated, server-rendered). Both are rate-limited at **120 requests per minute per IP** under the `public-player` bucket and return `404` server-wide when the `publicProfilesEnabled` toggle in [`/api/panel/settings`](#put-apipanelsettings) is disabled.

### `GET /api/public/players/:guid`
Aggregated stats for a single driver. Same shape as the data the SSR `/p/<guid>` page renders. Useful for Discord bots, Twitch overlays, league standings boards — anything that wants the data without scraping HTML.

**Auth required:** no

**URL:** `:guid` must be a 17-digit Steam GUID. Anything else returns `400 { "error": "Invalid Steam ID" }`.

**Response 200:**

```jsonc
{
  "player": {
    "guid":      "76561198000000001",
    "name":      "Driver",              // in-game name
    "nickname":  "Sample Driver",       // admin-set, may be empty
    "nation":    "ESP",                // ISO-3 country code or empty
    "firstSeen": "2026-05-12",
    "lastSeen":  "2026-05-18",
    "lastCar":   "ks_toyota_ae86",
    "lastTrack": "ks_red_bull_ring"
  },
  "kpis": {
    "sessions":    4,
    "laps":        41,
    "totalMs":     10399664,
    "totalTime":   "2h 53m",                  // pretty-printed totalMs
    "bestMs":      238997,
    "bestDate":    "2026-05-13",              // date the bestMs lap was set, not first valid lap
    "recordsHeld": 10,                        // count of records[] below
    "mostUsedCar": {                          // null when the driver has no laps
      "car":     "ks_toyota_ae86",
      "carName": "Toyota AE86",     // from ui_car.json or formatted slug
      "laps":    10                           // total lap count on this car (any track)
    },
    "mostPlayedTrack": {                      // null when no laps
      "track":       "ks_red_bull_ring",
      "trackName":   "Red Bull Ring",
      "trackConfig": "layout_gp",
      "layoutName":  "Grand Prix",
      "laps":        25                       // total lap count on this combo
    },
    "bestOnMostPlayed": {                     // driver's PB on the most-played combo, any car. null when no valid lap
      "ms":      238997,
      "car":     "ks_toyota_ae86",
      "carName": "Toyota AE86",
      "date":    "2026-05-13"
    }
  },
  "records": [                          // combos where this driver has the panel-wide MIN(ms) valid lap
    {
      "track":       "ks_red_bull_ring",
      "trackName":   "Red Bull Ring",   // from ui_track.json with prefix-stripping
      "trackConfig": "layout_gp",   // raw slug, kept for clients
      "layoutName":  "Grand Prix",   // short name (track prefix stripped)
      "car":         "ks_toyota_ae86",
      "carName":     "EK Civic EF9",    // from ui_car.json or formatted slug
      "ms":          238997,
      "date":        "2026-05-13",
      "tiedOthers":  0                  // count of OTHER drivers tied on this exact ms
    }
  ],
  "personalBests": [                    // every (track, layout, car) combo this driver has driven, with their best
    {
      "track":       "ks_red_bull_ring",
      "trackName":   "Red Bull Ring",
      "trackConfig": "layout_gp",
      "layoutName":  "Grand Prix",
      "car":         "ks_toyota_ae86",
      "carName":     "EK Civic EF9",
      "ms":          238997,
      "date":        "2026-05-13"
    }
  ],
  "recentLaps": [                       // last 10 laps the driver has set (any combo), valid or invalid, newest first
    {
      "track":       "ks_red_bull_ring",
      "trackName":   "Red Bull Ring",
      "trackConfig": "layout_gp",
      "layoutName":  "Grand Prix",
      "car":         "ks_toyota_ae86",
      "carName":     "Toyota AE86",
      "ms":          238997,
      "cuts":        0,
      "valid":       true,              // false when cuts > 0
      "date":        "2026-05-18"
    }
  ]
}
```

**Response 404:** `{ "error": "Player not found" }` — the GUID has no row in `players`. Players are inserted on first `NEW_CONNECTION` from the UDP listener or on first valid lap imported from a results JSON.

**Response 400:** `{ "error": "Invalid Steam ID" }` — the path segment didn't match the 17-digit shape.

**Response 429:** `{ "error": "Rate limit" }` — more than 120 requests in the trailing 60 seconds from the requesting IP. Honours `TRUST_PROXY` so Cloudflare-fronted deployments see real client IPs through `CF-Connecting-IP`.

**Response 404 (toggle off):** `{ "error": "Not Found" }` — `publicProfilesEnabled` is `false`. The same response shape as a missing endpoint so an operator who turns the feature off doesn't leak that it exists.

---

### `GET /p/:guid`
The same data, but rendered as an HTML page using `/src/styles.css` for visual continuity with the panel. Lives outside `/api/` so the URL is short and shareable. OpenGraph + Twitter card meta tags ship the driver's name + headline stats + a per-driver PNG so a paste in Discord renders a proper preview with image.

**Auth required:** no

**URL:** `:guid` must be a 17-digit Steam GUID. Other shapes 404 at the static-file fallback.

**Methods:** `GET`, `HEAD`. `HEAD` returns the same status code and headers as `GET` with an empty body — Discord/Twitter scrape with `GET` but `curl -I` and Cloudflare healthchecks use `HEAD`.

**Query parameters (optional):**

| Param   | Values                | Effect |
|---------|-----------------------|--------|
| `lang`  | `en`, `es`, `it`      | Overrides the visitor's `Accept-Language` and the panel-default `panel_settings.lang`. Propagates to the OG image URL when explicit, so `?lang=en` previews in English on Discord even when the panel default is Spanish. |
| `theme` | `light`, `dark`       | Sets the page `data-theme` and propagates to the OG image URL so a `?theme=light` share previews with the light card variant. Defaults to `dark`. |

**Response:** `200 text/html; charset=utf-8`, ~15–25 KB depending on records / personal-bests / recent-laps volume. Headers include `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex` (the page is share-able but never search-engine indexed) and `Cache-Control: no-store` (stats change live as drivers set laps).

**Response 404:**
- player has no row in `players`, OR
- `publicProfilesEnabled` is `false`, OR
- the GUID didn't match the 17-digit shape.

---

### `GET /p/:guid/og.png`
PNG render of the driver's OpenGraph card — used as `og:image` / `twitter:image` on the HTML page so Discord, Slack and Twitter previews show a per-driver thumbnail rather than the panel logo alone. Generated server-side at 1200×630 via `@resvg/resvg-js`. SVG variant available at `/p/:guid/og.svg` for direct browsing; Discord rejects SVG og:image so PNG is the canonical version referenced from the HTML.

**Auth required:** no

**Methods:** `GET`, `HEAD`

**Query parameters:** `lang`, `theme` — same semantics as `/p/<guid>`. The HTML's `og:image` URL adds them automatically when explicit so cached Discord previews match the page they were shared from.

**Response:** `200 image/png`, ~90–140 KB depending on theme + content density. Cached at the edge for 5 minutes (`Cache-Control: public, max-age=300`).

**Fallback:** if `@resvg/resvg-js` is missing on the host or rendering fails, the handler returns `src/assets/icon-512.png` (the panel logo) with the same `Cache-Control` so Discord at least shows *something* instead of "couldn't load image".

---

### `GET /p/:guid/og.svg`
The raw SVG behind the PNG above. Same content, same query parameters (`lang`, `theme`), useful for direct browsing or for tooling that prefers vector input — but **not** what the HTML's `og:image` points at, because Discord and Twitter reject `image/svg+xml` for security reasons. Cached for 5 minutes (`Cache-Control: public, max-age=300`).

**Auth required:** no

**Methods:** `GET`, `HEAD`

**Response:** `200 image/svg+xml`, ~6–12 KB.

---

### `GET /p/:guid/card.png`
Downloadable PNG stat card with extended KPIs. Sent with `Content-Disposition: attachment` so clicking the download button on the SSR page saves it to disk with a filename like `<sanitized-name>-<guid>.png`. Layout differs from the OG card: 5 KPI tiles (total laps, time on track, most-used car, driver's best lap on their most-played track, server records held), a thumbnail of the most-played track's `map.png` in the upper-right, and a footer with the public profile URL.

**Auth required:** no

**Methods:** `GET`, `HEAD`

**Query parameters:** `lang`, `theme` — same semantics. The download button on the SSR page carries the current page's explicit `?lang=` / `?theme=` through so the saved file matches what the user is looking at.

**Response:** `200 image/png`, ~95–145 KB. `Content-Disposition: attachment; filename="..."`. Not edge-cached (`Cache-Control: no-store`) — every download click hits the renderer fresh.

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

### `POST /api/laps`
Insert a lap manually. Used by the "Add lap" popup on the Lap times page to backfill a record that wasn't captured by the UDP listener / result importer (e.g. server outage, external timing source). Shares the `laps_dedup_runtime` UNIQUE index with the other importers; re-submitting the same `(driver_guid, ms, car, track, track_config)` returns `409`.

**Auth required:** yes (admin only — strictly `checkAdminAuth`)

**Body:**

| Field | Required | Notes |
| --- | --- | --- |
| `driver_name` | yes | Display name, capped to 64 chars. |
| `driver_guid` | no | 17-digit Steam GUID. If empty or malformed, a synthetic `manual:<slug>` GUID is generated from the name so future joins still work. |
| `car` | yes | Car content ID. |
| `track` | yes | Track content ID. |
| `track_config` | no | Layout name. |
| `ms` | yes | Lap time in milliseconds; must be a positive integer below 999_000_000. |
| `s1`, `s2`, `s3` | no | Sector times in ms. When all three are 0, `s1` is seeded with the full lap time (matching the UDP-capture convention). |
| `valid` | no | Defaults to `true`. When `false`, `cuts` defaults to 1. |
| `cuts` | no | Cut count for invalid laps. |
| `session_date` | no | `YYYY-MM-DD`. Defaults to today. |

The driver is also upserted into the `players` table (`total_laps` incremented) so the new pilot shows up on the Players page. A `lap.create` audit log entry is written and, if the lap beats the previous best for `(track, layout, car)`, the Discord webhook fires the same record-broken notification used by the UDP path.

The Lap times page popup builds its driver dropdown from `/api/players/history`, so the common case ("backfill a lap for an existing pilot") sends the player's real Steam GUID and the lap lands on their existing `players` row instead of creating a `manual:<slug>` synthetic. A "Custom" sentinel in the dropdown re-reveals free-text name + GUID inputs for pilots who have never connected.

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

### `DELETE /api/content/cars/:id`
Recursively delete a **mod** car directory from `AC_CARS_DIR`. Refuses Kunos IDs (`KUNOS_CAR_IDS.has(id)` → `403 { error: "Kunos content cannot be deleted" }`) — the bundled DLC catalogue is the authoritative fallback the rest of the panel reads when an installed `ui_car.json` is missing/empty, so wiping it would break Discord notifications, Recent Activity, and the cars/tracks pages' Kunos toggle. Path is locked to `AC_CARS_DIR + sep` after `path.resolve` (defense-in-depth on top of `isValidContentId`'s `..` block).

**Auth required:** yes (admin only — strictly `checkAdminAuth`)

**Response:** `{ "ok": true }` on success, `404 { error: "Not found" }` if the directory doesn't exist, `400 { error: "Invalid ID" }` on a malformed id.

A `car.delete` row is written to the audit log. The Cars page Delete button calls this and also strips the deleted id from `sessionCfg.slots` so Apply doesn't reference a now-missing mod (acServer refuses to boot when a `[CAR_n].MODEL` is unknown).

---

### `DELETE /api/content/tracks/:id`
Same as the car-delete endpoint, against `AC_TRACKS_DIR`. Refuses Kunos track IDs. Audited as `track.delete`. The Tracks page button also clears `sessionCfg.trackId` if the deleted track was the active one, so the next Apply doesn't write a missing track to `server_cfg.ini`.

**Auth required:** yes (admin only — strictly `checkAdminAuth`)

---

### `GET /api/content/cars/:id/thumb`
Serve the car's badge/preview image. Falls back to the bundled Kunos asset.

---

### `GET /api/content/cars/:id/skins/:skin/preview`
Serve a skin preview image from the installed `AC_CARS_DIR/<id>/skins/<skin>/preview.{webp,jpg,png}` (whichever exists first).

---

### `GET /api/content/cars/:id/kunos-skin/:skin/preview`
Same as above, but reads from the bundled `KUNOS_ASSETS_DIR/cars/<id>/skins/<skin>/` instead of the live `AC_CARS_DIR`. Used by the Cars page to render the original Kunos skin previews even when the operator's installation only ships a subset of the stock content. Both `:id` and `:skin` go through `isValidContentId` / `isValidSkinName` and the resolved path is asserted to stay under `KUNOS_ASSETS_DIR` (defence-in-depth on top of the validators).

---

### `GET /api/content/tracks/:id/thumb`
Serve the track preview image.

---

### `GET /api/content/tracks/:id/layout/:layout/thumb`
Serve a per-layout track preview image.

---

### `GET /api/content/tracks/:id/map`
Serve the top-down `map.png` for a track, used by the Dashboard's live position minimap. Resolves per-layout first (`tracks/<id>/<layout>/map.png`), falls back to the track root (`tracks/<id>/map.png`), then to the bundled Kunos asset under `data/kunos-assets/tracks/<id>/`.

**Auth required:** yes

**Query parameters:**

| name | type | required | notes |
|---|---|:-:|---|
| `layout` | string | no | Layout slug (`gp_a`, `national`, …). Omitted for single-layout tracks. Must satisfy `isValidContentId` or the request is rejected with `400 Invalid layout`. |

**Responses:**

- `200 OK` with `Content-Type: image/png` and `Cache-Control: public, max-age=86400, immutable`. The body is the raw PNG.
- `400 Bad Request` — text body `Invalid ID` or `Invalid layout` when either fails the content-id charset check.
- `404 Not Found` — text body `No map.png for this track/layout` when no `map.png` exists at any of the three candidate paths. The Dashboard widget falls back to a "live map not available for this layout" placeholder instead of breaking.

---

### `GET /api/content/tracks/:id/map-meta`
Return the parsed `data/map.ini` calibration for a track layout — the same `[PARAMETERS]` block Content Manager and CSP use to project world coordinates onto the `map.png`. The Dashboard minimap fetches this once per layout change and caches it in component state.

**Auth required:** yes

**Query parameters:** same `layout` semantics as `/map` above.

**Response (`200 OK`):**

```json
{
  "width":         1600,
  "height":        1200,
  "xOffset":       457.32,
  "zOffset":       302.18,
  "scaleFactor":   1.0,
  "margin":        20,
  "drawingSize":   10
}
```

| key | source INI line | fallback |
|---|---|---|
| `width`       | `WIDTH`        | `0` |
| `height`      | `HEIGHT`       | `0` |
| `xOffset`     | `X_OFFSET`     | `0` |
| `zOffset`     | `Z_OFFSET`     | `0` |
| `scaleFactor` | `SCALE_FACTOR` | `1` |
| `margin`      | `MARGIN`       | `0` |
| `drawingSize` | `DRAWING_SIZE` | `10` |

The world→pixel formula is `px = (worldX + xOffset) * scaleFactor`, `py = (worldZ + zOffset) * scaleFactor`, then add `margin`. The result is cached process-wide in `_trackMapMetaCache` keyed by `<trackId>|<layout>`.

**Errors:**

- `400 Bad Request` `{ "error": "Invalid ID" }` / `{ "error": "Invalid layout" }`.
- `404 Not Found` `{ "error": "No map.ini for this track/layout" }` when no `data/map.ini` exists for the layout (or its track-root / Kunos fallbacks).

---

### `GET /api/positions/stream`
Server-Sent Events feed of every connected car's world position at ~4 Hz (`POSITION_BROADCAST_INTERVAL_MS = 250`). The Dashboard's `LiveMapCard` subscribes and renders one absolute-positioned dot per car on top of `/api/content/tracks/:id/map`.

**Auth required:** yes

**Per-user concurrency cap:** same 6-stream limit as `/api/logs/stream` — the 7th returns `429 { error: "Too many concurrent streams for this user — close other tabs and retry" }`.

The underlying data comes from acServer's UDP plugin: each `apiPositionsStream` connection re-sends `ACSP.REALTIMEPOS_INTERVAL` (event 200, 100 ms) to acServer (idempotent — covers the case where the panel started before acServer, or acServer was restarted while no subscriber was open), and the latest `CAR_UPDATE` (event 53) per car is cached on `udpState.cars[carId].pos`. The 4 Hz emit timer is **ref-counted on the subscriber set** — it stops itself on the first tick where the set is empty, so an idle Dashboard tab does not drain CPU.

The first frame is pushed immediately on connect so the minimap doesn't have to wait up to 250 ms for its initial render. There is no separate `init` event — every frame is a default `message`-event SSE chunk in the same shape:

```
data: {
  "ts": 1747663200250,
  "positions": [
    { "id": 0, "name": "Driver 1", "car": "ks_toyota_ae86", "x": 142.7, "z": -83.4, "velKmh": 84, "splinePos": 0.412 },
    { "id": 1, "name": "Driver 2", "car": "ks_toyota_ae86", "x": 156.1, "z": -71.9, "velKmh": 91, "splinePos": 0.398 }
  ]
}
```

Fields:

| name | type | notes |
|---|---|---|
| `ts`                  | number | Server clock in ms — the moment this frame was assembled, not when each car reported. |
| `positions[].id`      | number | `carId`: slot index in `entry_list.ini`. Same value the rest of the panel uses to key live drivers. |
| `positions[].name`    | string | Driver display name as currently held by the slot. Kept in sync with `udpState.cars[id].name`. |
| `positions[].car`     | string | Car model ID (`ks_toyota_ae86`, etc.). Lets the client render different dot colours / icons per car. |
| `positions[].x`       | number | World X in metres. Project with `map-meta`'s `xOffset` + `scaleFactor` to land on the PNG. |
| `positions[].z`       | number | World Z in metres. Pair with `zOffset` / `scaleFactor`. |
| `positions[].velKmh`  | number | Speed rounded to integer km/h. Surface as a tooltip / a "fast = bright" colour ramp. |
| `positions[].splinePos` | number | Position along the track spline in `[0, 1]`. Useful for ordering or sector colouring without a 2D layout. |

Slots with no `CAR_UPDATE` received yet (driver connected but stationary on the pit, or just joined) are **skipped** rather than emitted with zeroed coordinates — the dot only appears once a real position has been seen.

A keep-alive heartbeat (`: ping\n\n`) is written every 25 s so Cloudflare / reverse-proxies don't drop the long-lived connection mid-session.

---

## Session presets

Saved session configurations the operator can pick from the Presets page and reload into the Session editor with one click. All endpoints below are gated by the `presetManage` permission; admin always passes. Preset names are unique (case-insensitive) — the `UNIQUE` constraint in the schema makes a colliding `POST` / `PUT` return `409`; the import endpoint instead auto-suffixes with ` (2)`, ` (3)`, …

### `GET /api/session-presets`
List every saved preset with a summary used to render the card grid.

**Response:**

```json
[
  {
    "id": 7,
    "name": "GP Practice",
    "description": "Sunday warm-up loop",
    "summary": {
      "trackId": "ks_nordschleife",
      "layout": "endurance",
      "slotCount": 24,
      "practiceEnabled": true,
      "qualifyEnabled": false,
      "raceEnabled": true
    },
    "createdBy": "ayoze",
    "createdAt": "2026-05-19 22:11:03",
    "updatedAt": "2026-05-20 00:42:10"
  }
]
```

`config` is intentionally omitted — fetch it via `GET /:id` when you actually need to load.

---

### `POST /api/session-presets`
Create a new preset.

**Body:**

```json
{ "name": "GP Practice", "description": "Sunday warm-up loop", "config": { /* sessionCfg shape */ } }
```

`config` must be an object; its shape matches what `POST /api/session/apply` consumes plus any extra fields the Session page tracks client-side. Server preserves the JSON byte-for-byte (after `JSON.parse` round-trip), so adding a future Session field doesn't need a schema migration. Audited as `preset.create`.

**Response:** `{ "id": <number>, "name": <string> }` on success, `409 { "error": "A preset with that name already exists" }` on collision.

---

### `GET /api/session-presets/:id`
Full preset including its `config` blob — what the edit modal hydrates from and what `Load into Session` drops into the live `sessionCfg`.

**Response:** the list-shape row plus `"config": { … }`.

---

### `PUT /api/session-presets/:id`
Partial update. Send any subset of `name`, `description`, `config`; omitted fields are left untouched. `updated_at` is refreshed automatically. Audited as `preset.update`. Returns `{ "ok": true }`, or `409` if the new name collides.

---

### `DELETE /api/session-presets/:id`
Delete the row. Audited as `preset.delete`. Returns `{ "ok": true }` or `404`.

---

### `GET /api/session-presets/:id/export`
Download the preset as a portable JSON file. The browser saves it as `<name>.json` via `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`. The filename is sanitised against hostile filesystem characters (`\/:*?"<>|`, control bytes), collapses runs of whitespace, and is capped at 80 chars with a `preset` fallback.

**Response payload** (the envelope on disk):

```json
{
  "format": "assetto-server-panel-preset",
  "formatVersion": 1,
  "exportedAt": "2026-05-20T00:00:00.000Z",
  "exportedFrom": "ayoze",
  "panelVersion": "1.7.1",
  "preset": {
    "name": "GP Practice",
    "description": "Sunday warm-up loop",
    "config": { /* sessionCfg shape */ }
  }
}
```

`Cache-Control: no-store` so a download is never served from a stale proxy / SW cache. Audited as `preset.export`.

---

### `POST /api/session-presets/import`
Create a new preset from an exported file.

**Body:** either the full envelope (`format` + `formatVersion` + `preset`) emitted by `/export`, or a bare `{ "name": "...", "description": "...", "config": {...} }` for hand-crafted files. Validation reuses the same `_validatePresetPayload` as the regular `POST`, so the field constraints (name ≤ 120, description ≤ 500, config object-only) are identical.

When the requested `name` collides with an existing preset (case-insensitive) the endpoint **does not** return `409` — it appends ` (2)`, ` (3)`, … until it finds a free slot and stores under that name, so a re-import never fails because the operator forgot they already had a copy.

**Response:**

```json
{ "id": 42, "name": "GP Practice (2)", "renamed": true, "original": "GP Practice" }
```

`renamed: false` (and `original === name`) when no collision occurred. Audited as `preset.import`.

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
Read panel settings (`upload_max_mb`, `chunked_upload`, `lang`, `discord_webhook`, `public_profiles_enabled`).

The `discordWebhook` field is only returned to admins; non-admins get an empty
string plus a `discordConfigured` boolean so the UI can disable the field.

**Auth required:** yes

**Response:** `{ "uploadMaxMb": 500, "lang": "en", "chunkedUpload": false, "discordWebhook": "", "discordConfigured": false, "publicProfilesEnabled": true }`

---

### `PUT /api/panel/settings`
Update one or more panel settings.

**Auth required:** yes (admin)

**Body:** `{ "uploadMaxMb": 1000, "chunkedUpload": true, "lang": "en", "discordWebhook": "https://discord.com/api/webhooks/...", "publicProfilesEnabled": true }`

`discordWebhook` must match a Discord webhook URL or be an empty string to
clear the setting. When set, the server posts a record notification to that
webhook every time a driver beats the previous best lap for a (track, layout,
car) combination via live UDP. The message language follows the stored `lang`.

`publicProfilesEnabled` toggles the unauthenticated [`/p/<steam-id>`](#get-pguid) page and its JSON counterpart [`/api/public/players/:guid`](#get-apipublicplayersguid). Defaults to `true`; flipping to `false` makes both endpoints return `404` server-wide. Admin-only; the change is audited as `panel.public_profiles` with detail `enabled` / `disabled`.

---

### `POST /api/discord/webhook/test`
Post a localized test message to the saved Discord webhook (or to a URL passed
in the body, useful for verifying before saving).

**Auth required:** yes (admin)

**Body:** `{ "url": "https://discord.com/api/webhooks/..." }` (optional — falls
back to the saved webhook when absent)

---

## Role permissions

### `GET /api/permissions/role`
Return the canonical permission set for the `user` role.

**Auth required:** yes (admin)

**Response:** `{ "permissions": { "serverControl": true, "sessionEdit": true, ... } }`

---

### `PUT /api/permissions/role`
Update the permission set for the `user` role. Unknown keys are dropped;
missing keys become `false`.

**Auth required:** yes (admin)

**Body:** `{ "serverControl": true, "sessionEdit": false, ... }`

**Audit:** logs `role.permissions.update` with the list of enabled perms.

Permission keys recognised: `serverControl`, `sessionEdit`, `serverConfig`,
`whitelistManage`, `playerModeration`, `modUpload`, `discordWebhook`,
`auditView`, `dbBackup`. Panel-user CRUD and AC server passwords stay
admin-only and are NOT toggleable from this endpoint.

---

## Panel users

### `GET /api/panel/users`
List all panel users.

**Auth required:** yes

---

### `POST /api/panel/users`
Create a new panel user.

**Auth required:** yes (admin)

**Body:** `{ "username": "alice", "password": "...", "role": "user" }`

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

Recorded actions: `server.start`, `server.stop`, `server.restart`, `player.kick`, `player.ban`, `config.save`, `session.apply`, `mod.install`, `user.create`, `user.update`, `user.delete`, `whitelist.add`, `admin.backup`, `preset.create`, `preset.update`, `preset.delete`, `preset.export`, `preset.import`, `audit.export`, `role.permissions.update`.

A daily sweeper deletes entries older than `AUDIT_RETENTION_DAYS` (env, default 365).

---

### `GET /api/audit/export`
Stream the audit log as CSV or JSON for offline analysis (jq, SIEM, spreadsheet).
Optional filters compose into a single WHERE clause so a single request can
target an incident window without pulling the whole table.

**Auth required:** yes (`auditView` permission)

**Query params:**
- `format` — `csv` (default) or `json`
- `since` — ISO 8601 timestamp inclusive (e.g. `2026-05-01T00:00:00`)
- `until` — ISO 8601 timestamp inclusive
- `actor` — exact match on the actor column
- `action` — substring match (`LIKE %action%`) on the action column

**Response (CSV):**
```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="assetto-audit-2026-05-23-12-34-56.csv"

id,actor,action,target,detail,logged_at
42,Admin,player.ban,76561198000000001,"banned for griefing",2026-05-06 14:23:00
...
```

CSV cells follow RFC 4180 quoting — fields with comma, quote or newline are
double-quoted, internal quotes are escaped by doubling. The CSV path streams
row-by-row via `better-sqlite3` `.iterate()` so a multi-year export stays
flat on memory.

**Response (JSON):**
```json
{
  "exportedAt": "2026-05-23T12:34:56.789Z",
  "filter": { "since": "2026-05-01 00:00:00", "until": null, "actor": null, "action": "player" },
  "count": 38,
  "rows": [ { "id": 42, "actor": "Admin", "action": "player.ban", ... } ]
}
```

**Audit:** logs `audit.export` with the format and the rendered WHERE clause
so an operator scraping the table leaves a trace.

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

### `GET /api/admin/health`
Clinical-style health probe for ops dashboards / Kubernetes readiness /
Uptime-Kuma. Aggregates the disk + DB + process + acServer checks into a
single verdict the operator can alert on. Unlike the public `/api/health`
(which returns just `{ ok: true }` and intentionally hides fingerprintable
signal), this one is admin-gated and includes the underlying numbers.

**Auth required:** yes (admin)

**HTTP code mirrors the verdict** so an alerting rule is a one-liner
"non-2xx" check:
- `healthy` → **200**
- `degraded` → **200** (advisory)
- `unhealthy` → **503**

**Thresholds:**
- Disk free < 500 MB → unhealthy. < 5 GB → degraded.
- RSS > 1 GB → degraded (leak signal; the OOM killer would have taken us out before this matters).
- acServer not running → degraded, not unhealthy (the panel keeps serving config edits + uploads + audit log when AC isn't up).
- DB throws on `SELECT 1` → unhealthy.

**Response:**
```json
{
  "status": "healthy",
  "version": "1.7.1",
  "uptimeSec": 12345,
  "checks": {
    "db":       { "status": "healthy", "sizeMb": 3.21 },
    "disk":     { "status": "healthy", "freeGb": 87.4, "totalGb": 250.0 },
    "process":  { "status": "healthy", "memoryMb": 78, "uptimeSec": 12345 },
    "acServer": { "status": "healthy", "running": true, "uptimeSec": 4321 }
  }
}
```

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
