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

## "Proceso terminó al arrancar" right after pressing *Start*

`acServer` died inside the 500 ms boot window. Read the tail of `AC_SERVER_LOG` to see the exact reason — the most common one is:

```
Error, entry list CAR_n car <model> is illegal
```

Every `[CAR_n].MODEL` in `entry_list.ini` has to appear in `[SERVER].CARS`. The dashboard now regenerates `entry_list.ini` automatically whenever the Session page writes a new car set, but pre-existing installs may carry stale entries left over from a previous fleet. Re-apply the session from the *Session* page once and `entry_list.ini` will be rewritten; the prior file is kept as `entry_list.ini.bak`.

---

## "Players Online" is empty even though somebody is connected

The dashboard reads the live driver list from `acServer`'s HTTP API. Current `acServer` builds reply `200 OK` with an empty body on `/api/details`, so the panel falls back to `/JSON|0`. That endpoint still lists the connected drivers (you'll see them in the table) but it does **not** expose lap stats, ping, or Steam GUID — those columns will read `0` / `0ms` until you switch to a binary build whose `/api/details` works.

---

## "Whitelist" / "Ban" buttons stay disabled on a live player

Both endpoints need the player's Steam GUID, which `/JSON|0` does not provide (see the previous entry). The panel recovers GUIDs by exact in-game-name match against the `players` table — populated when the result-file importer reads each session's JSON.

- **Returning player** (already imported once before): GUID is found, buttons are enabled.
- **First-time player**: no row in `players` yet, so GUID is blank and the buttons stay disabled. After they disconnect and `acServer` writes a result file, the importer creates their row; on their next reconnect the buttons work.
- **Ambiguous name** (two distinct GUIDs sharing the same in-game name): the match is intentionally suppressed — kicking/banning the wrong account is worse than waiting. Disambiguate from the *Players history* table (each row shows the GUID directly).

`Kick` is unaffected — it uses the car-slot index and works from the first connection.

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

The service worker may be intercepting the upload request. Make sure you are running an up-to-date version of the panel — older versions had a bug where the SW corrupted large POST bodies. Both `/api/mods/upload/chunk` and `/api/mods/upload` are now skipped by the SW so neither single multipart nor chunked uploads pass through it. After updating, open DevTools → Application → Service Workers and click **Unregister**, then hard-reload the page (`Ctrl+Shift+R`).

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

## `dist/*.js` returns 404 / "MIME type 'text/plain'" warning

Since the build step shipped, the panel serves pre-transpiled JS from `dist/` instead of raw JSX from `src/`. If `dist/` doesn't exist, the static-file allow-list will serve nothing and the page stays blank.

**Fix:** rebuild from the project root:
```bash
node build.js
# or
npm run build
```

`npm start` runs the build automatically via the `prestart` script. If you launch the panel with `node server.js` directly (e.g. from a custom systemd unit), make sure your unit also runs `node build.js` first (`ExecStartPre=…/node build.js`, see `docs/deployment.md`).

---

## Changes after update don't appear

This used to require a hard reload. Since SW v12 the panel uses **network-first for navigation** — `index.html` always comes from the network when reachable, so security and UI fixes propagate without manual cache busts. Bumping `CACHE_NAME` (`ac-panel-v15` at the time of writing) on every behaviour change drops the old offline cache at activate-time. If you still see a stale UI:

1. The browser may still be running the old SW. Reload twice — the first reload activates the new SW, the second uses it.
2. Confirm the server is actually up to date (`git log -1` and `systemctl status assetto-dashboard`).
3. As a last resort, DevTools → Application → Service Workers → **Unregister**, then reload.

---

## "Application crashed" red screen

The frontend has a top-level error boundary. When a render error escapes React's normal handling, the panel shows a red screen with the stack trace and a "Clear session and reload" button. The button wipes `localStorage.ac-user` and reloads — useful when stale local state is the trigger.

If it keeps happening, copy the stack trace and the `X-Request-Id` header from the failing request (DevTools → Network) and report it.

---

## Forced password change on first login

By design — the seeded `Admin / Admin1234!` is locked into a blocking modal until a new password is set. **Server-side**, every authenticated route returns `403 { mustChangePassword: true }` until you clear the flag. The modal accepts only passwords ≥ 12 chars (or ≥ 8 with a mix of three character classes).

If you lock yourself out, edit `assetto.db` directly:
```sql
UPDATE panel_users SET must_change_password = 0 WHERE username = 'Admin';
```

---

## Cross-origin request blocked (`403`)

The CSRF guard rejects POST/PUT/DELETE/PATCH whose `Origin` header does not match the request `Host`. Common causes:

- A reverse proxy rewrote `Host` but kept the original `Origin`. Fix the proxy config so both reflect the public hostname.
- A custom HTTP client setting an explicit `Origin: …` that differs from the panel's URL — drop the header or align it.

If `Origin` is absent (some proxies strip it), the request is allowed and the cookie's `SameSite=Strict` is the only line of defence — that's intentional.
