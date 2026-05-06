# Troubleshooting

## The panel won't start

**`Error: Cannot find module '...'`**
Run `npm install` — a dependency is missing.

**`Port 3000 already in use`**
Something else is already listening on that port.
```bash
sudo lsof -i :3000
```
Either stop the conflicting process or change `PORT` in `.env`.

**`Database init failed`**
The path in `DB_PATH` is not writable. Check directory permissions or leave `DB_PATH` unset to use the default location inside the project folder.

---

## Page loads but shows no cars or tracks

The paths in `.env` point to the wrong directories. The panel expects:
- `AC_CONTENT_DIR/cars/<car-id>/ui/ui_car.json`
- `AC_CONTENT_DIR/tracks/<track-id>/ui/ui_track.json`

Verify the paths and that the files exist and are readable.

---

## Server always shows "Stopped"

The panel detects the AC server by sending an HTTP request to `http://127.0.0.1:<AC_HTTP_PORT>/INFO`.

- Make sure `AC_HTTP_PORT` in `.env` matches `HTTP_PORT` in `server_cfg.ini`.
- Make sure the AC server is actually running and its HTTP API is accessible.

---

## Lap times table is empty

AC result files must exist in `AC_SERVER_RESULTS` and follow the expected format:

```json
{
  "TrackName": "loros",
  "Laps": [
    { "LapTime": 349284, "Sectors": [...], "Cuts": 0, "DriverName": "...", "CarModel": "..." }
  ]
}
```

`LapTime` is in milliseconds. Check the path and file permissions.

---

## Mod upload fails with "No valid mod found"

The archive was not recognised as a car or a track. Common reasons:

- The archive contains files loose at the root instead of inside a single folder.
- The archive is missing the required signature files. See [Mod installer → Auto detection](mod-upload.md#automatic-mod-detection).
- The archive contains another archive inside it (nested archives are not supported).

---

## Upload stuck at 0% (remote access)

Cloudflare and other reverse proxies often block large binary POST bodies before they reach the server.

**Fix:** enable **Chunked upload** in the Configuration page. This splits the file into 5 MB JSON chunks that pass through without issues.

---

## "JSON invalid" or "Offline" error during chunked upload

The service worker may be intercepting the chunk upload request. Make sure you are running an up-to-date version of the panel — older versions had a bug where the SW corrupted large POST bodies. After updating, open DevTools → Application → Service Workers and click **Unregister**, then hard-reload the page (`Ctrl+Shift+R`).

---

## Logs page is empty

The panel captures AC server output only when it **spawns** the AC process itself (via the Start button). If you started `acServer` manually or via another service, its output is not captured. Check `AC_SERVER_LOG` in `.env` — if you point it to an existing log file, the panel will tail it instead.

---

## ERR_CONNECTION_REFUSED

Nothing is listening on port 3000.

```bash
sudo systemctl status assetto-dashboard   # if running as a service
npm start                                 # or start manually
```

---

## JSX files return 404

All source files live under `src/`. If you moved files or cloned into a different directory structure, check that the paths in `index.html` match the actual file locations.

---

## Changes after update don't appear

The service worker caches static files aggressively. After pulling an update and restarting the server, force a full refresh in the browser:

- **Chrome / Edge:** `Ctrl+Shift+R`
- **Firefox:** `Ctrl+Shift+R`
- **Safari:** `Cmd+Option+R`

Or go to DevTools → Application → Service Workers → **Unregister**, then reload.
