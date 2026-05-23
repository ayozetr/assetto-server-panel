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
sudo systemctl status assetto-server-panel   # if running as a service
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

The panel uses several layers to make sure a deploy reaches every browser without manual cache busting:

- **`updateViaCache: 'none'`** in the SW registration call — the browser bypasses its HTTP cache when checking `/sw.js` for updates, so a 4-hour `max-age` (Cloudflare's default downstream value) doesn't keep the old SW alive for hours.
- **Cache-bust query strings** — `server.js` rewrites `index.html` on the fly to append `?v=BUILD_VERSION` (the mtime of `dist/app.js`) to every `dist/*.js` script src. After a deploy the version changes and every browser sees fresh URLs → guaranteed cache miss at every layer (browser, CDN, SW).
- **Network-first for `/dist/`** in the SW — every JS bundle request goes to the network first; the cache is fallback for offline only. This prevents the classic "old JS paired with new HTML" mismatch.
- **`clients.navigate(c.url)`** in the SW's activate hook — when a new SW version takes over, every open tab is reloaded automatically so the upgrade lands without users needing to close/reopen.
- **CACHE_NAME bump** on every behaviour change so the activate hook deletes the previous cache.

If you still see a stale UI:

1. Confirm the server is actually up to date (`git log -1` and `systemctl status assetto-server-panel`).
2. Hard reload once (Ctrl+Shift+R / Cmd+Shift+R) to bypass everything and seat the new SW.
3. As a last resort, DevTools → Application → Service Workers → **Unregister**, then reload.

---

## F5 leaves the page blank but Ctrl+Shift+R works

Symptom: regular reloads (`F5`) produce a blank page with `Uncaught ReferenceError: React is not defined` in the console; hard reload (`Ctrl+Shift+R`) renders normally.

Cause: a Service Worker that intercepts cross-origin requests (React, ReactDOM, Google Fonts loaded from `unpkg.com` and `fonts.googleapis.com`). When the SW does `respondWith(fetch(request))` against a foreign origin, the call is governed by the page's CSP `connect-src` directive (not `script-src`). Since the panel ships with a strict `connect-src 'self'`, those fetches get blocked and React never loads → the rest of the bundles fail to mount → blank page. Hard reload bypasses the SW entirely so the browser's native `<script src=...>` honours `script-src` correctly and React loads.

Fixed in SW v18+: the fetch handler returns early on `url.origin !== self.location.origin`, leaving cross-origin requests to the browser. If you're on an older self-hosted version with the bug, deploy the latest `sw.js` and bump `CACHE_NAME` to force activation.

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

---

## "TRUST_PROXY=1 but the trusted-proxy allowlist is EMPTY" at boot

The startup banner prints this when `TRUST_PROXY=1` is set in `.env` but every entry in `TRUST_PROXY_FROM` failed to parse, or the variable was set to an empty string. The defensive code in `clientIp()` still does the right thing (it ignores forward-IP headers entirely when the allowlist is empty, so a spoof attempt cannot succeed), but **the operator who set `TRUST_PROXY=1` expected those headers to do something** — per-IP rate limits, audit-log attribution and the `checkOrigin` `X-Forwarded-Host` fallback all silently revert to using the socket peer (typically the upstream proxy itself, so every request looks like it came from the same IP).

**Fix:** read the rejected entries the banner lists right above the warning and check the CIDR shape:

- IPv4: `192.168.0.0/24`, `10.0.0.0/8`, `100.64.0.0/10` (Tailscale CGNAT), `127.0.0.0/8` (loopback).
- IPv6: an exact prefix like `2606:4700::` or `fd00::` — the panel does a coarse prefix-string match, not a full CIDR engine, so trailing `/N` masks are ignored.
- Multiple entries are comma-separated.

If you have no proxy in front, **unset `TRUST_PROXY`** entirely (or set it to `0`). The panel will then read the socket peer as the client IP, which is correct for direct LAN / localhost access.

---

## "TRUST_PROXY_FROM has N unparseable entries" at boot

The banner lists every entry that didn't parse. Typical mistakes:

- Spaces inside an entry: `192.168.0.0 / 24` instead of `192.168.0.0/24`.
- Hostnames instead of IPs: `cf.example.com` won't resolve — use the published Cloudflare ranges.
- An IPv6 entry with a `/N` mask that the coarse prefix matcher doesn't understand: drop the mask and use the prefix only (`2606:4700::` not `2606:4700::/32`).

If `Origin` is absent (some proxies strip it), the request is allowed and the cookie's `SameSite=Strict` is the only line of defence — that's intentional.
