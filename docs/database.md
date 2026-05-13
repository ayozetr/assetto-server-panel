# Database

The panel uses a single SQLite database file (`assetto.db`) created automatically on first run. All tables are created on startup if they don't already exist.

The database path defaults to `<project>/assetto.db` and can be overridden with the `DB_PATH` environment variable.

---

## Tables

### `panel_users`

Panel login accounts.

| Column | Type | Description |
|--------|------|-------------|
| `username` | TEXT PK | Login username (1–64 chars: letters, numbers, `_`, `-`) |
| `password_hash` | TEXT | scrypt hash (`scrypt$<hex>`). Legacy PBKDF2-SHA512 hashes (bare hex) are still verified and lazily upgraded to scrypt on next successful login. |
| `salt` | TEXT | 32-byte random salt, hex-encoded |
| `role` | TEXT | `admin` or `user` |
| `created_at` | TEXT | Creation timestamp |
| `must_change_password` | INTEGER | `1` = user must change password on next login |

---

### `sessions`

Active login sessions.

| Column | Type | Description |
|--------|------|-------------|
| `token` | TEXT PK | Random session token |
| `username` | TEXT | Owner of the session |
| `role` | TEXT | Role at time of login |
| `expires_at` | INTEGER | Expiry as Unix timestamp (ms) |

Sessions expire after 7 days. Expired tokens are purged on each new login.

---

### `panel_settings`

Key-value store for panel configuration.

| Key | Default | Description |
|-----|---------|-------------|
| `upload_max_mb` | `500` | Maximum upload size in MB |
| `chunked_upload` | `0` | `1` = chunked upload enabled |
| `lang` | `en` | Interface language (`en`, `es`, `it`) |
| `discord_webhook` | _empty_ | Discord webhook URL. When set, the server POSTs a localized record-notification message every time a driver beats the previous best lap for a `(track, layout, car)` combination on the live UDP path. Only readable by admins or users with the `discordWebhook` permission. |
| `role_permissions_user` | _JSON_ | Effective permissions for the `user` role, stored as JSON. Seeded with `{ "serverControl": true, "sessionEdit": true, "modUpload": true, ... }` (rest `false`). Edited by admins via the **Usuarios** → Permissions card or `PUT /api/permissions/role`. Admin role always passes every permission check regardless of this value. Unknown keys are dropped; missing keys become `false`. |

---

### `players`

Historical record of every player who has connected to the server.

| Column | Type | Description |
|--------|------|-------------|
| `guid` | TEXT PK | Steam GUID |
| `name` | TEXT | In-game display name (set by acServer) |
| `nickname` | TEXT | Admin-set real name shown alongside the in-game name on the Players and Lap times pages. Empty by default. Added by ALTER migration. |
| `nation` | TEXT | 3-letter country code |
| `first_seen` | TEXT | Date of first connection |
| `last_seen` | TEXT | Date of last connection |
| `total_laps` | INTEGER | Total valid laps driven |
| `last_car` | TEXT | Last car used |
| `last_track` | TEXT | Last track played |

---

### `laps`

Every lap time. Laps are ingested from two sources and merged via a content-based dedup index:

1. **UDP plugin listener** (live). Each `ACSP_LAP_COMPLETED` event from acServer becomes a row with `source_file = 'udp:live'` and `s1 = s2 = s3 = 0` (the UDP protocol carries lap_time + cuts but not sectors).
2. **Result-file importer** (post-session). When acServer writes its session JSON, `importResultFile` reads each lap. New laps are inserted normally; laps that the UDP listener already wrote are detected by the dedup index and instead get an UPDATE that fills in the sectors and replaces `source_file = 'udp:live'` with the actual filename — so the row ends up identical to one written purely from the JSON.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `driver_name` | TEXT | Driver display name |
| `driver_guid` | TEXT | Steam GUID |
| `car` | TEXT | Car ID |
| `track` | TEXT | Track ID |
| `track_config` | TEXT | Layout name (empty for single-layout) |
| `ms` | INTEGER | Lap time in milliseconds |
| `s1`, `s2`, `s3` | INTEGER | Sector times in milliseconds (0 until the JSON importer fills them in for UDP-captured laps) |
| `cuts` | INTEGER | Number of track cuts |
| `valid` | INTEGER | `1` = clean lap, `0` = invalid |
| `lap_timestamp` | INTEGER | Millis-since-session-start. UDP captures roughly the same value as the JSON; the JSON importer overwrites it when it has a more authoritative figure. |
| `session_date` | TEXT | Date of the session |
| `source_file` | TEXT | Origin: `udp:live` while only the UDP listener has seen the lap, otherwise the result JSON filename |

**Dedup**: a unique index `laps_dedup_runtime` on `(driver_guid, ms, car, track, track_config)` prevents both sources from creating two rows for the same lap. `INSERT OR IGNORE` is the gate for both code paths; the JSON importer additionally runs a fill-sectors UPDATE when the conflicting row has zero sectors so professional-grade sector data lands as soon as the JSON arrives. The original table-level UNIQUE on `(driver_guid, car, track, track_config, lap_timestamp, source_file)` is intentionally wider and stays as a no-op redundancy.

The `total_laps` counter on the `players` table is only incremented when the INSERT actually adds a row (i.e. the lap is genuinely new), so a UDP-captured lap that later arrives in the JSON doesn't double-count.

---

### `processed_files`

Tracks which result JSON files have already been imported, so they are never processed twice.

| Column | Type | Description |
|--------|------|-------------|
| `filename` | TEXT PK | Result filename |
| `processed_at` | TEXT | Import timestamp |

---

### `mod_history`

Log of every mod upload attempt.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `ok` | INTEGER | `1` = success, `0` = failure |
| `filename` | TEXT | Original archive filename |
| `mod_type` | TEXT | `car` or `track` |
| `mod_id` | TEXT | Extracted folder name |
| `destination` | TEXT | Full path where it was installed |
| `files_extracted` | INTEGER | Number of files written to disk |
| `error` | TEXT | Error message if the upload failed |
| `uploaded_by` | TEXT | Username of the uploader |
| `uploaded_at` | TEXT | Upload timestamp |

---

### `audit_log`

Tamper-evident record of every admin action.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `actor` | TEXT | Username who performed the action |
| `action` | TEXT | Action key (see below) |
| `target` | TEXT | Subject of the action (e.g. Steam GUID, username, mod name) |
| `detail` | TEXT | Extra context (e.g. player display name) |
| `logged_at` | TEXT | Timestamp of the action |
| `prev_hash` | TEXT | SHA-256 of the previous row's `row_hash` (empty for the first row) |
| `row_hash` | TEXT | Per-row SHA-256 (canonicalization depends on `chain_version`, see below) |
| `chain_version` | INTEGER | `1` for current rows, `0` for legacy rows written before the format upgrade |

Each row chains into the next via `prev_hash`/`row_hash`. Editing or deleting an intermediate row breaks every subsequent hash.

**Canonicalization.** New rows (`chain_version = 1`) hash `JSON.stringify([1, prev_hash, logged_at, actor, action, target, detail])` so element boundaries are explicit. Legacy rows (`chain_version = 0`) used `${prev_hash}|${logged_at}|${actor}|${action}|${target}|${detail}` — that format had a separator-collision weakness when fields contained `|`, so it is no longer written. The verifier reads `chain_version` to pick the correct algorithm per row, which means existing chains continue to validate without rewriting history.

Verify the chain locally with:

```bash
node tools/verify-audit.js path/to/assetto.db
```

(returns exit code 0 if intact, 1 if tampered).

**Recorded action keys:** `server.start`, `server.stop`, `server.restart`, `player.kick`, `player.ban`, `config.save`, `session.apply`, `mod.install`, `user.create`, `user.update`, `user.delete`, `whitelist.add`, `admin.backup`.

A daily sweeper deletes rows older than `AUDIT_RETENTION_DAYS` (env, default 365). Readable via `GET /api/audit` (admin-only, cursor-paginated).

---

### `login_attempts`

Persistent rate-limit state for `/api/auth/login` and `/api/auth/change-password`.

| Column | Type | Description |
|--------|------|-------------|
| `ip` | TEXT PK | Client IP (or proxy-forwarded IP when `TRUST_PROXY=1`) |
| `count` | INTEGER | Failed attempts within the current window |
| `reset_at` | INTEGER | Unix ms when the count is cleared |

Persisting these to SQLite means a brute-forcer cannot reset the counter by triggering a server restart. A sweeper drops expired rows every 30 minutes.
