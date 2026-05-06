# Database

The panel uses a single SQLite database file (`assetto.db`) created automatically on first run. All tables are created on startup if they don't already exist.

The database path defaults to `<project>/assetto.db` and can be overridden with the `DB_PATH` environment variable.

---

## Tables

### `panel_users`

Panel login accounts.

| Column | Type | Description |
|--------|------|-------------|
| `username` | TEXT PK | Login username |
| `password_hash` | TEXT | PBKDF2-SHA-512 hash |
| `salt` | TEXT | Random 32-byte hex salt |
| `role` | TEXT | `admin` or `user` |
| `created_at` | TEXT | Creation timestamp |

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

---

### `players`

Historical record of every player who has connected to the server.

| Column | Type | Description |
|--------|------|-------------|
| `guid` | TEXT PK | Steam GUID |
| `name` | TEXT | Display name |
| `nation` | TEXT | 3-letter country code |
| `first_seen` | TEXT | Date of first connection |
| `last_seen` | TEXT | Date of last connection |
| `total_laps` | INTEGER | Total valid laps driven |
| `last_car` | TEXT | Last car used |
| `last_track` | TEXT | Last track played |

---

### `laps`

Every lap time imported from AC result files.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `driver_name` | TEXT | Driver display name |
| `driver_guid` | TEXT | Steam GUID |
| `car` | TEXT | Car ID |
| `track` | TEXT | Track ID |
| `track_config` | TEXT | Layout name (empty for single-layout) |
| `ms` | INTEGER | Lap time in milliseconds |
| `s1`, `s2`, `s3` | INTEGER | Sector times in milliseconds |
| `cuts` | INTEGER | Number of track cuts |
| `valid` | INTEGER | `1` = clean lap, `0` = invalid |
| `lap_timestamp` | INTEGER | Timestamp from the result file |
| `session_date` | TEXT | Date of the session |
| `source_file` | TEXT | Result filename it came from |

A unique constraint on `(driver_guid, car, track, track_config, lap_timestamp, source_file)` prevents duplicate imports.

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
