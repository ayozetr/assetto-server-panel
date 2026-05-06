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

The default upload size limit is **500 MB** and can be changed from the Configuration page (up to 10,240 MB).

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
- **Zip-Slip protection** — any archive entry whose path escapes the destination directory is rejected immediately.
- The extracted folder is placed in `AC_CONTENT_DIR/cars/` for cars and `AC_CONTENT_DIR/tracks/` for tracks.
- After a successful install, the car/track lists update automatically in the UI without a page reload.

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
4. When the last chunk arrives, all pieces are reassembled in memory and passed to the same extraction pipeline as a direct upload.
5. Temporary files are cleaned up automatically after assembly (or after 2 hours if an upload was abandoned).

> **Note:** The service worker explicitly bypasses `/api/mods/upload/chunk` to avoid a known browser bug where the SW's `fetch(request)` forwarding corrupts large POST bodies.
