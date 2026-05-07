# Mod Installer

## Overview

The Mods page lets any logged-in user upload and install car or track mods directly from the browser. The server automatically detects the mod type, validates the archive, and extracts it into the correct AC content directory.

---

## Supported formats

| Format | Extension |
|--------|-----------|
| ZIP | `.zip` |
| RAR | `.rar` |
| 7-Zip | `.7z` |

The default upload size limit is **500 MB**, configurable from the Configuration page. The panel enforces an absolute hard cap of **2 GB** (`UPLOAD_HARD_CAP_BYTES` in `server.js`) on top of whatever the admin sets — values higher than 2 GB in `panel_settings.upload_max_mb` are silently capped, so a misconfiguration can't OOM the panel.

---

## Automatic mod detection

When an archive is uploaded, the server inspects its file tree looking for definitive signals that identify whether it's a car or a track. These signals never overlap between the two types.

### Car signals

| File | Why it's definitive |
|------|---------------------|
| `data.acd` | Encrypted physics blob — only car mods have this |
| `data/car.ini` | Car physics configuration |
| `data/engine.ini` | Engine configuration |
| `data/tyres.ini` | Tyre configuration |
| `data/suspensions.ini` | Suspension configuration |
| `ui/ui_car.json` | Car metadata file |

### Track signals

| File | Why it's definitive |
|------|---------------------|
| `models.ini` / `models_*.ini` | 3D scene object declarations — present in all tracks, single or multi-layout |
| `data/surfaces.ini` | Physics surface properties — tracks always have this, cars never do |
| `ui/ui_track.json` | Track metadata file |
| `ai/` folder + `.kn5` file | Fallback for older tracks that predate `models.ini` |

Car signals are checked first. If `data.acd` is found, it is always a car — no further checks needed. Track signals are checked second.

---

## Extraction rules

- The archive must contain **exactly one root folder** (e.g. `my_car/`). Archives with multiple root folders or files loose at the root are rejected.
- Only game-relevant file extensions are extracted. Scripts, executables and unknown formats are silently skipped.
- **Zip-Slip protection** — any archive entry whose path escapes the destination directory aborts the entire install (no silent skip; partial installs would be dangerous).
- **Decompression-bomb caps** — archives are rejected before extraction if they have more than **50 000 entries**. During extraction, any entry over **2 GB** uncompressed, or a cumulative extracted size over **5 GB**, also aborts the install.
- **INI value sanitisation** — text fields written into `server_cfg.ini` (server name, welcome message, passwords) are stripped of `[`, `]`, `;`, `#`, `=`, control chars, and (for passwords) non-printable bytes — protecting against config injection.
- The extracted folder is placed in `AC_CONTENT_DIR/cars/` for cars and `AC_CONTENT_DIR/tracks/` for tracks.
- After a successful install, the car/track lists update automatically in the UI without a page reload (mtime-keyed cache invalidation).

---

## Upload history

Every upload attempt — success or failure — is recorded in SQLite with:
- Filename
- Mod type (car or track)
- Mod ID (folder name)
- Number of extracted files
- Who uploaded it
- Date and time

The history is shared across all connected clients and persists between server restarts. It can be cleared from the Mods page.

---

## Chunked upload

When accessing the panel through **Cloudflare Tunnel** or similar proxies, large binary POST bodies are often blocked by the WAF before they reach the server.

**Chunked upload** solves this by splitting the file into 5 MB pieces, encoding each as base64 JSON, and sending them one by one as `application/json` requests — a format that passes through Cloudflare without issues.

### How to enable

Go to **Configuration → Chunked upload** and toggle it on. The setting is saved server-side and applies to all users.

### How it works internally

1. The browser splits the file into 5 MB chunks.
2. Each chunk is base64-encoded and sent to `POST /api/mods/upload/chunk` as JSON.
3. The server stores each chunk in a temporary directory under `/tmp/ac-upload-chunks/<uploadId>/`.
4. When the last chunk arrives, the server **streams** each chunk file into a single assembled temp file on disk (no `Buffer.concat` of the whole upload in RAM) and then passes it to the extraction pipeline. Peak RAM during assembly is ~5 MB (one chunk), not 2× the upload size.
5. Temporary files are cleaned up automatically after assembly (or after 2 hours if an upload was abandoned).
6. **Per-user quota:** each user can have at most one upload in-flight; a second `uploadId` from the same user is rejected with `429` until the active one finishes or stales out (5 min of no chunks).
7. **Bounds:** `chunkIndex` must be `0 ≤ idx < totalChunks`, and `totalChunks` is capped at 4 096 (~20 GB ceiling, well above the 2 GB hard cap).

The single-shot `POST /api/mods/upload` endpoint also streams the multipart body straight to a temp file as bytes arrive (the multipart parser is stream-based), so neither path ever buffers the whole archive in memory.

> **Note:** The service worker explicitly bypasses `/api/mods/upload/chunk` to avoid a known browser bug where the SW's `fetch(request)` forwarding corrupts large POST bodies.
