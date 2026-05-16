# Changelog

All notable changes to this project are documented here. Format inspired by
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The dates are in `YYYY-MM-DD`. Commits referenced as `[abc1234]` link to the
authoritative diff — the changelog entry is a hand-curated summary of *why*
the change matters; the commit log is the source of truth for *what* changed.

## [Unreleased]

## [1.1.0] — 2026-05-16

This release closes the entire CRITICAL backlog and ~30 HIGH-severity findings
from the 2026-05-16 security audit. Production deployment verified on the
maintainer's panel (<redacted-ip>) with backup, restart and post-deploy smoke
test. No breaking API or data-format changes.

### Security

- **CSRF guard tightened.** `checkOrigin` used to permit POST/PUT/DELETE/PATCH
  when both `Origin` and `Referer` were absent. Modern browsers always attach
  `Origin` to state-changing requests, so the "permissive when missing" branch
  only ever benefited hand-crafted attacker traffic. Now refuses when a session
  cookie is present and neither header arrives; headless `ADMIN_TOKEN` callers
  (which never carry the cookie) pass unchanged. [`64c756a`]
- **`TRUST_PROXY` no longer trusts every socket.** `CF-Connecting-IP` and
  `X-Forwarded-For` are now honoured only when the request's socket-level peer
  is in a configurable trusted-proxy CIDR allowlist (defaults to Cloudflare's
  published edge ranges plus loopback; override with `TRUST_PROXY_FROM`).
  Closes a spoofing window that let a LAN client bypass the per-IP login
  lockout and frame other IPs in the audit log. [`c0c859f`]
- **Symlink defences across mod pipeline + content delete.**
  `apiContentDelete` now uses `fsp.lstat` (was `stat`) so a planted dir-symlink
  at `content/cars/<id>` no longer routes `fsp.rm({ recursive })` through to
  whatever it pointed at (e.g. `/etc`). Each archive extractor (zip, rar, 7z)
  flags symlink entries via `isSymlink`; `processModBuffer` aborts the whole
  upload on the first occurrence. `fs.open(O_NOFOLLOW)` on every entry write so
  even a stale link at the destination can't be followed. [`4ebb5ad`]
- **INI metacharacter injection blocked at the render layer.** `patchINI` now
  routes every value through `_renderIniValue`, which refuses values containing
  control characters or beginning with `;` / `#` / `[`. Defence-in-depth for
  any future field that forgets to call `sanitizeIniText` upstream. [`8130ee4`]
- **Chunked upload race + chunk integrity.** Replaced the leaky `_chunkAssembling`
  Set with a per-`uploadId` async mutex (`withUploadLock`) that spans the
  whole flow — chunk write, readdir count, and assembly. Chunks now go through
  `O_EXCL` write; an `EEXIST` retry that doesn't byte-match returns 409 instead
  of silently overwriting. Optional `body.sha256` per chunk is verified
  server-side. [`4847df2`]
- **Audit hash chain visible across retention boundary.** Before deleting old
  rows the sweeper now records an `audit.retention.sweep` row carrying the
  count and the hash of the most-recent row that will survive — external
  verifiers can reconcile the new chain head against the recorded tail.
  Tampering by deleting the most recent row now disagrees with the boundary's
  recorded count. [`30d1765`]
- **Server lifecycle events audited on failure too.** `apiServerStart/Stop/Restart`
  used to insert audit rows only on success, so an attacker hammering
  /api/server/restart against a broken AC_SERVER_BIN left no trail. Now writes
  `server.{start,stop,restart}.fail` with the underlying error. [`30d1765`]
- **Auth hardening bundle.** Login timing oracle closed by running a dummy
  scrypt in the not-found branch; Discord webhook adds an authoritative
  hostname allowlist after `new URL()`; `getPublicIp` validates response shape
  and caches with a 1 h TTL; self-password-change and admin role changes now
  purge existing sessions; a 1 h-cadence sweeper deletes expired session rows.
  [`0ec4588`]
- **Service Worker stops caching `/api/config`.** The endpoint returns AC
  server `PASSWORD` and `ADMIN_PASSWORD` to admins; the SW had been writing
  the response to `Cache Storage`, which persists on disk past logout and
  remains readable by any XSS via `caches.match('/api/config')`. Removed
  from `OFFLINE_API_PATHS`; SW bumped to v36 so the old cache is evicted on
  activate. [`5e29898`, `3ddf4f3`]
- **SRI on CDN scripts.** React 18.3.1 and ReactDOM 18.3.1 from unpkg now
  carry `integrity="sha384-…"` attributes. A unpkg compromise or MITM no
  longer translates to arbitrary JS execution inside the panel's origin.
  [`0a06df8`]
- **localStorage no longer holds role / permissions.** The browser-side user
  blob is trimmed to `{ name }`; role and permissions are pulled fresh from
  `/api/auth/me` on every mount and held in memory only. [`69d0583`]
- **CSRF and request-id surface cleanup.** `X-Request-Id` from upstream is
  stripped to `[A-Za-z0-9-]` before reaching log lines; cookie parsing was
  already exact-match-by-name (no prefix-eq trap). [`c0c859f`]

### Performance

- **Compression negotiation.** `respond()` now gzip/brotli encodes
  application/json, application/javascript, text/css, text/html, text/csv and
  text/event-stream payloads larger than 1 KB when the client offers a
  matching `Accept-Encoding`. `dist/i18n.js` drops from 194 KB to 46 KB
  gzipped, 45 KB brotli — roughly a 4× wire reduction. `Vary: Accept-Encoding`
  set on every compressible response. [`3ddf4f3`]
- **`processModBuffer` concurrency cap.** A 2-slot semaphore limits how many
  in-progress mod extractions hold their buffer in RAM simultaneously. With
  the 2 GB hard cap this bounds the panel's peak extraction memory at ~4 GB.
  [`0e335b3`]
- **`laptimes.jsx` records lookup memoised.** The records-view delta column
  used to do `records.find(...)` per row per render — O(rows × records) every
  time anything in the page state changed. A `bestPerTrack` Map memoized off
  `[records]` collapses it to O(rows) lookups. [`62300af`]
- **Disk space check before mod upload.** `processModBuffer` now refuses
  uploads when the destination volume's free bytes are below max(5×
  compressed, 256 MB floor), returning 507 Insufficient Storage instead of
  blowing up halfway through extraction. [`94b7bdf`]

### Robustness

- **Top-level process error handlers.** `unhandledRejection` logs without
  exiting; `uncaughtException` logs and exits with code 1 (systemd
  `Restart=on-failure` picks the panel back up). Without these, an unhandled
  rejection inside an async handler crashed the panel without surfacing the
  triggering event. [`0e335b3`]
- **Request body timeout.** `readBody` now destroys the socket after 30 s of
  partial bytes. Stops a slow-loris client from tying up a file descriptor
  forever via drip-feed bodies. [`0e335b3`]
- **SSE cleanup unified.** Every termination path (req close/error, res
  close/error, heartbeat write failure) goes through a single idempotent
  `cleanup()`. Previously a heartbeat-write failure cleared the timer but
  left the response pinned in `sseClients` and `_sseByUser`, eroding the
  per-user SSE cap every time the network blipped. [`0e335b3`]
- **Logger re-entrancy guard.** `log.*` feeds `appendLog`, which iterates SSE
  clients. A future `log.warn` raised inside that path could infinite-loop;
  `_logEmitDepth` short-circuits the mirror call to a console-only emit when
  re-entered. [`0e335b3`]
- **Auto-restart on session/config save now holds the same lock as
  `/api/server/restart`.** Two requests could otherwise race through `killAC
  + spawnAC` and end up with duplicate acServer processes. [`dc0f5ff`]
- **Flat-file list mutations serialised.** `apiPlayerBan`, `apiWhitelistPut`
  and `apiWhitelistAdd` now mutate blacklist.txt/whitelist.txt through
  per-path `withFileLock` mutexes, eliminating the read-modify-write race
  where concurrent requests could lose appends or clobber a parallel
  replace. `apiPlayerBan` also gained the missing 17-digit GUID validation;
  `apiWhitelistPut` now writes an audit row. [`dc0f5ff`]
- **Watcher filename validation.** `fs.watch(AC_RESULTS, …)` on exotic
  filesystems (FUSE/NFS) can yield arbitrary strings. The post-event
  handler now refuses any name that isn't a `[A-Za-z0-9_.-]+\.json` leaf,
  closing a latent path traversal in `importResultFile`. [`dc0f5ff`]

### Frontend / UX

- **Destructive actions confirmed.** Delete car, delete track, kick, ban,
  and clear mod history now route through the existing `ConfirmModal`
  instead of `window.confirm()` (or no prompt at all). Native `confirm()`
  bypassed theme + i18n; missing confirmations on kick/ban let a single
  misclick permanently blacklist a driver. [`62300af`]
- **Settings Cancel reverts.** Previously the Cancel button cleared the
  "unsaved changes" pill but kept the edited values in state, so the next
  Save shipped them anyway. Now refetches `/api/config` and overlays the
  server's current state. [`62300af`]
- **CSV export properly escaped.** Driver names containing commas, quotes
  or newlines no longer shift every later column right; values are wrapped
  per RFC 4180 (`"…"` with internal quotes doubled), line terminator
  switched to CRLF. Blob URL revoked 5 s after export. [`62300af`]
- **Avatar render no longer crashes on null name.** Every `*.name.slice(0,1)`
  call in shell, users, players and tracks is null-guarded. Profile.jsx's
  `!@#$%^&*()_+-=[]{}|` hint string is rendered as a JS literal so the
  `{` and `}` actually appear. [`62300af`, `462b1b4`]
- **Initial-load fan-out wired to AbortController.** Logging out or closing
  the tab while `/api/config`, `/api/results`, `/api/cars`, `/api/tracks`,
  `/api/players/history`, `/api/panel/users`, `/api/panel/settings` were in
  flight used to setState on a now-unmounted component. Now aborts cleanly.
  [`69d0583`]
- **Mod upload tracks mount state.** XHR (`uploadDirect`) and chunk-loop
  (`uploadChunked`) completion handlers used to call setState after the
  user navigated away. `mountedRef` gates every setState; the chunk loop
  also bails between chunks, letting the server-side `cleanupOldChunks`
  sweeper reclaim the partial upload. [`69d0583`]
- **Accessible Switch component.** Every toggle in session, settings,
  profile and users now goes through `window.AppShell.Switch`, which
  adds `role="switch"`, `aria-checked`, `aria-disabled`, `aria-label`,
  `tabIndex`, and Space/Enter key handlers. Replaces eleven bare
  `<div className="switch">` widgets. [`462b1b4`]
- **i18n for the Recent Activity feed.** The seven activity message shapes
  (`'X se ha unido'`, `'Vuelta'`, `'Colisión'`, etc.) used to be hard-coded
  Spanish; en/it users now see the localised version. Mod upload-size
  message moved to a placeholder-aware key. `t()` itself gained
  replaceAll semantics so a placeholder used twice in a string is fully
  substituted. [`3ddf4f3`]

### Operational

- **Boot WARN when `TRUST_PROXY=1` and `HOST` is not loopback.** Operator-
  error guidance: the panel is still safe (clientIp ignores spoofed
  headers from non-allowlisted peers), but the combination indicates a
  configuration mistake worth flagging early. [`170d676`]
- **Service Worker `skipWaiting()` moved inside `event.waitUntil`.** A fast
  activate hook used to race the still-in-flight precache; the new chain
  guarantees the cache is fully populated before take-over. [`3ddf4f3`]
- **Session-expiry sweeper.** Old sessions used to be removed only when
  `createSession` minted a fresh token; a panel with no logins for weeks
  accumulated rows. Hourly sweeper now keeps the table tidy. [`0ec4588`]
- **Documentation.** README now opens with an explicit three-option
  block (Cloudflare Tunnel / LAN-with-firewall / reverse proxy) showing
  the matching `HOST` + `TRUST_PROXY` combinations. `docs/deployment.md`
  gains a Log rotation section with a complete `logrotate.d` config
  (with `copytruncate` rationale), a Routine maintenance section pointing
  at `npm outdated` / `npm audit`, a hardened systemd unit example
  (`NoNewPrivileges`, `ProtectSystem`, `ReadWritePaths`, `PrivateTmp`,
  `LimitNOFILE`, `MemoryMax`), and a switch from `npm install` to
  `npm ci` in the update flow. [`170d676`]
- **`tools/install-deps.sh` no longer hidden by `.gitignore`.** The
  `*.sh` rule in `.gitignore` was silently ignoring the install script;
  added `!tools/*.sh` so scripts under `tools/` are version-controlled.
  [`170d676`]
- **ASSESSMENT.md generated locally and gitignored.** [`4e59dc8`]

### Notes

- Service Worker version bumped to v36; clients receive the new cache on
  next activate. No user action needed.
- Database schema unchanged. No migration required.
- Production deploy verified on 2026-05-16 13:55 UTC. Backup
  `assetto.db.bak.predeploy.20260516-135421` kept on the maintainer's
  panel as a rollback point.

## [1.0.0] — pre-2026-05

Initial public version. See `git log --before=2026-05-16` for the change
history before this release. Notable feature work in the pre-1.0 era:

- Panel users CRUD with admin/user roles.
- Granular role permissions (`role_permissions_user` JSON in
  `panel_settings`): serverControl, sessionEdit, serverConfig,
  whitelistManage, playerModeration, modUpload, discordWebhook, auditView,
  dbBackup.
- Session apply: ordered slot list with per-slot skin, three independent
  session toggles (Practice/Qualify/Race), weather, air temp, penalties.
- Mod upload: ZIP / RAR / 7Z, streaming multipart parser, 50k entry cap,
  5 GB extracted cap, zip-slip strict abort, chunked upload mode for
  Cloudflare-hosted deployments.
- UDP plugin listener: live laps, players online, session info from
  acServer.
- Discord webhook for new track records, three locales.
- Lap times: filters, comparison, manual lap insert (admin), CSV export.
- Audit log with SHA-256 hash chain and offline verifier
  (`tools/verify-audit.js`).
- PWA / Service Worker with offline mode for selected GET endpoints.
- Three-language UI (en/es/it).
- Dark + light themes, mobile responsive layout.
- Cloudflare Tunnel-friendly defaults (cache-busting via `?v=BUILD_VERSION`,
  network-first SW for `/dist/` bundles).

[Unreleased]: https://github.com/ayozetr/assetto-dashboard/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ayozetr/assetto-dashboard/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ayozetr/assetto-dashboard/releases/tag/v1.0.0
