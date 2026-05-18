# Changelog

All notable changes to this project are documented here. Format inspired by
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The dates are in `YYYY-MM-DD`. Commits referenced as `[abc1234]` link to the
authoritative diff — the changelog entry is a hand-curated summary of *why*
the change matters; the commit log is the source of truth for *what* changed.

## [Unreleased]

### Fixed

- **Phantom player on dashboard boot.** The UDP listener used to fire
  `GET_CAR_INFO` at every slot 0..63 on startup to rehydrate the live
  driver map after a panel restart. This particular Go `acServer` build
  replies `isConnected=1` for slots that held a driver in a past
  session, so the burst seeded `udpState.cars` with phantom entries
  that surfaced on `/api/players` until the real driver rejoined —
  often onto a different slot, producing a duplicate row with the same
  name. The boot burst is now gated on `/JSON|0`'s `IsConnected` flag
  (which tracks the live socket state, not stale slot metadata), so we
  only ask about slots a real client currently occupies. If `/JSON|0`
  is unreachable the burst is skipped; the existing
  unknown-car_id-on-LAP_COMPLETED fallback already requests CAR_INFO on
  demand, so active drivers still recover without seeding phantoms.
- **Nation flag disappearing from connection history on disconnect.**
  `apiPlayers` enriches connected drivers with `DriverNation` from
  `/JSON|0` at request time, but nation was only ever *written* to the
  `players` table by the post-session results JSON importer. Players
  who had never closed a session with a result containing their nation
  stayed at `nation=''` in the DB, so the flag vanished from the
  history view the moment they disconnected. `apiPlayers` now persists
  any nation it learns from `/JSON|0` with an `UPDATE … WHERE guid=?
  AND nation=''` — gated so we never overwrite an admin-curated value
  and the write runs at most once per player.

## [1.4.1] — 2026-05-17

Quality-of-life polish on the 2FA flow, plus the repo rename that was
deferred from 1.4.0.

### Added

- **QR code on the 2FA setup screen.** The setup card now renders the
  `otpauth://` URI as a scannable QR drawn locally on a `<canvas>`. The
  secret never leaves the device — no third-party QR service is involved
  — and the manual base32 key remains visible as a fallback for
  workflows where scanning isn't an option (terminal, screen reader,
  copy/paste into a password manager).
- **Vendored qrcode-generator (MIT, Kazuhiko Arase).** Shipped from
  `src/vendor/` through esbuild to `dist/vendor/qrcode-generator.js` so
  there is no runtime CDN dependency and no new npm package — the file
  is pinned in the repo and goes through the same supply-chain controls
  as the rest of the codebase.

### Changed

- **Repository renamed to `assetto-server-panel`.** All references
  across `LICENSE`, `README.md`, `CHANGELOG.md`, `ROADMAP.md`,
  `docs/*`, `package.json` and source comments updated. Existing
  clones will need a `git remote set-url`.
- Service Worker cache bumped to `ac-panel-v37` so existing installs
  pick up the vendored QR script on the next reload.

## [1.4.0] — 2026-05-17

Bans gain context. Previously `POST /api/players/ban` only appended a GUID
to acServer's flat `blacklist.txt`, so the panel had no idea who was
banned, why, or whether the ban should ever expire — the only record was
the audit log row. 1.4.0 introduces a richer ban model with reasons and
optional TTLs, while keeping `blacklist.txt` (the file acServer actually
reads) authoritative for the in-game enforcement.

### Added

- **`bans` table** with `guid` PK, `name_snapshot`, `reason`, `banned_by`,
  `banned_at`, `expires_at` (NULLABLE — NULL = permanent). Indexed on
  `expires_at` so the sweeper that lifts expired bans is cheap. Migration
  `011 bans_table` runs idempotently on boot.
- **Extended `POST /api/players/ban` payload.** Backwards compatible — the
  legacy body (just `guid` and `name`) still works as a permanent,
  reason-less ban. Two new optional fields:
    - `reason`        : free-form text, ≤240 chars, control chars stripped.
    - `durationDays`  : positive integer = TTL in days (1..36500); 0 or
                        omitted = permanent.
  Response now carries `expiresAt` so the caller knows when the ban will
  lift.
- **`DELETE /api/players/:guid/ban`** — manual unban. Removes the GUID
  from `blacklist.txt` (under the existing `withFileLock` so concurrent
  ban writes don't lose the unban) and drops the `bans` row. Audit row
  `player.unban`.
- **`GET /api/bans`** — list of bans the panel knows about, ordered
  permanent-first then by date. Each entry exposes `permanent` and
  `expired` booleans so the UI can render badges without parsing dates.
  Requires the same `playerModeration` permission as banning.
- **Hourly sweeper** that lifts expired bans automatically. Reuses the
  same code path the manual unban does (file lock + DB delete) so the
  state never drifts. Audits the automatic action as
  `player.unban.expired` to distinguish from manual lifts.
- **Ban modal in the Players page.** Replaces the previous one-click
  ConfirmModal with a form that collects the reason and the duration
  (preset chips: Permanent · 1 day · 7 days · 30 days · Custom). 240-char
  cap and inline validation mirror the server-side limits.
- **Active bans section** at the bottom of the Players page. Shows every
  ban with player name + GUID, reason, who banned, when, when it expires
  (permanent badge for indefinite bans), and an Unban button. Auto-reloads
  when the tab regains focus. Hidden for users without
  `playerModeration` permission.
- **i18n keys** for the entire ban flow in en/es/it (`pl.ban_*`,
  `pl.bans_*`, `toast.ban_until`, `common.optional`).

### Backwards compatibility

Existing `blacklist.txt` entries that the panel didn't write itself
(manually-edited files, imports from another panel, etc.) keep working —
acServer treats them the same. They simply don't appear in
`/api/bans` until somebody re-bans the player through the UI, at which
point the row is recorded with the new metadata. No automatic migration
of legacy GUID-only entries; that would invent context (reason, banner)
the panel doesn't have.

### Audit trail

Three actions are now distinguishable in `audit_log`:

| Action                  | When |
| ----------------------- | ---- |
| `player.ban`            | A panel user banned a GUID via the UI or API. |
| `player.unban`          | A panel user manually lifted a ban. |
| `player.unban.expired`  | The hourly sweeper lifted a ban whose `expires_at` passed. |

## [1.3.0] — 2026-05-17

Two-factor authentication is now available for panel accounts. The
implementation is RFC 6238 TOTP with the same defaults every off-the-shelf
authenticator app expects (HMAC-SHA1, 30-second step, 6 digits), so any
existing app — Aegis, Authy, Bitwarden, 2FAS, Google Authenticator — can
manage the secret without configuration.

### Added

- **`POST /api/auth/2fa/setup`** — server generates a fresh 20-byte secret,
  base32-encodes it, stores it in `panel_users.totp_pending`, and returns
  the secret + an `otpauth://totp/...` provisioning URI for the client to
  render. No QR-image library is bundled — the secret never leaves
  first-party control. [`<this commit>`]
- **`POST /api/auth/2fa/confirm`** — client sends the current 6-digit code;
  if it verifies against the pending secret with ±1-step drift tolerance,
  the secret is promoted to `totp_secret` and `totp_enabled` flips to 1.
  Audit row `user.2fa.enable`.
- **`POST /api/auth/2fa/disable`** — requires the current password AND a
  valid TOTP code (proves both that you're the live user and that you
  still have the authenticator). Audit row `user.2fa.disable`.
- **`GET /api/auth/2fa/status`** — used by the Profile UI to render the
  enable/disable view. Returns `{ enabled, pending }`.
- **Login flow update.** `POST /api/auth/login` now returns
  `{ ok: false, needsTotp: true }` when the username + password are valid
  but the account has 2FA enabled. The client resubmits with `totp`
  appended; an incorrect code returns `401 { needsTotp: true }`. Bad-code
  attempts count against the same per-IP login rate-limit bucket as bad
  passwords, so a brute-forcer cannot grind through the 1M code space.
- **Profile page 2FA card.** Three-state UI: idle (button to enable),
  setup (account label + base32 secret in copy-friendly boxes, expandable
  otpauth:// URI, 6-digit confirmation input), enabled (status badge +
  disable form). Manual-key entry is the primary flow because every
  modern authenticator app supports it without a QR scanner.
- **Login screen 2FA field.** Username + password stay populated when the
  server requests a second factor; a third input appears with
  `inputMode="numeric"` + `autoComplete="one-time-code"` so mobile
  keyboards and password managers behave correctly.
- **i18n keys** for the entire 2FA flow in `en/es/it`
  (`profile.tfa.*`, `login.totp*`).
- **Smoke test coverage**: `npm test` now asserts the RFC 6238 reference
  vector at `t=59` and the status / setup / wrong-code endpoint shapes.

### Migrations

Three numbered, idempotent additions to `panel_users` (recorded in
`schema_migrations`):

- `008 panel_users_totp_secret`  — `TEXT NOT NULL DEFAULT ''`
- `009 panel_users_totp_enabled` — `INTEGER NOT NULL DEFAULT 0`
- `010 panel_users_totp_pending` — `TEXT NOT NULL DEFAULT ''`

Existing installs upgrade in place on boot. Accounts without 2FA configured
keep working exactly as before; 2FA is opt-in per account.

### Security notes

- Secret generation uses `crypto.randomBytes(20)` (CSPRNG) and is rendered
  to base32 via an inline encoder. No third-party TOTP library is on the
  dependency surface.
- TOTP verification uses `crypto.timingSafeEqual` to prevent timing leaks
  on individual digit positions.
- The setup secret lives in `totp_pending` until confirmed; an interrupted
  flow leaves no enabled-but-orphan state.
- `apiAuthMe` returns the live `twoFactorEnabled` flag so the Profile UI
  always reflects server truth without an extra round-trip on mount.

## [1.2.0] — 2026-05-16

Operator-driven release: portability + supply-chain hardening + a major
LICENSE rewrite to the new "use-anywhere, no-redistribution, irremovable
attribution" model. No breaking API or data-format changes; the LICENSE
shift is a relaxation of operator constraints (any use, including public
+ commercial servers, is now permitted) coupled with a tightening of
redistribution and attribution requirements.

### License

- **Use grant broadened to "anywhere lawful, including commercial".**
  Public game servers (Kunos lobby, Content Manager / acstuff
  listings), paid leagues, sponsorships, for-profit organizations — all
  now permitted without a separate written agreement, provided the
  Attribution Marks remain intact and the Software itself is not
  Distributed.
- **Redistribution prohibited.** No republishing the source, no
  uploading to package registries, no bundling into another product
  for distribution, no hand-offs to third parties. Point users at the
  official repository so they accept their own copy of the LICENSE.
- **Attribution Marks are irremovable.** The "Developed by ayozetr"
  credit, the project name "Assetto Server Panel", the link to the
  official repository, and every copyright/about/credits reference
  must stay intact in every operated copy, including commercial
  deployments. Re-skins, white-label deployments, and themes that
  hide or replace the marks are explicit breaches.
- **Affiliation disclaimer expanded.** Kunos Simulazioni, Valve, 505
  Games, the Content Manager / acstuff community, AssettoServer / CSP /
  Pure, Discord / Slack / Telegram, Cloudflare, every major car and
  track brand whose imagery may appear via bundled Kunos previews —
  the LICENSE now enumerates each as not affiliated, not endorsed, not
  sponsored, not partnered. All trademarks remain the property of
  their respective owners.
- **Disclaimers strengthened.** No warranty, limitation of liability,
  no patent grant, automatic termination on breach, severability, and
  governing law (Spain — courts of Santa Cruz de Tenerife) all
  reformulated against current best practice. [`<this release>`]

### Portability

- **Dockerfile + docker-compose.yml.** Multi-stage build with
  non-root user, cap_drop ALL, healthcheck wired to /api/health,
  bind-mounts of the host's AC_CFG_DIR + AC_CONTENT_DIR, persistent
  named volumes for the DB and logs. `docker compose up -d` is now
  the smallest-possible install path. [`d331599`]
- **AC path auto-detect.** Server walks the conventional install
  layouts (~/ac_server, /srv/assetto, /opt/ac_server, /srv/acserver)
  and falls back to subdirs of the detected root for every AC_* env
  var that isn't explicitly set. Operators with a typical install
  layout only need the four core paths. [`d331599`]
- **`/api/setup/status` + Login banner.** Public endpoint exposes the
  ✓/✗ state of each AC path. The login screen reads it before any
  authentication and renders an actionable banner pointing operators
  at the specific path that's missing. [`d331599`]
- **`npm run setup` first-run wizard.** Detects an existing acServer
  install, suggests defaults from the detected layout, asks six
  questions, writes a minimal .env. Refuses to overwrite an existing
  .env unless --force. [`d331599`]
- **Scheduled DB backups.** Opt-in via BACKUP_INTERVAL_HOURS /
  BACKUP_KEEP / BACKUP_DIR. VACUUM INTO snapshots with rotation,
  surfaced via /api/admin/stats + Prometheus exporter. [`d331599`]
- **Boot config summary.** Server prints a one-shot AC paths block
  on startup with ✓/✗ next to each path, plus the panel version on
  the banner. Operator can verify auto-detection without grepping the
  source. [`d331599`]
- **`.env.example` rewritten** with HOST=127.0.0.1 as the safe
  default, a clear "minimum required" vs "optional" split, and every
  derivable path commented out. New TRUST_PROXY_FROM knob for
  operators behind proxies other than Cloudflare. [`d331599`]

### Database

- **Numbered migrations runner.** `schema_migrations` table records
  every applied change; the old ALTER+catch-and-pray block is
  replaced with a real list of `{id, name, sql}` migrations.
  Pre-existing DBs auto-record the migrations they already have
  thanks to the `duplicate column / already exists` catch — no
  upgrade-in-place breakage. Two new migrations (compound audit_log
  indices on actor and action) ship as part of this release.
  [`2357a3b`]

### Tests + supply chain

- **`npm test` smoke runner.** First test runner the project has
  ever shipped. Boots a real panel against a throwaway DB and fake
  AC paths in /tmp, hits the most regression-prone surfaces (auth,
  must_change_password gate, CSRF, rate limit, INI render guard) via
  real HTTP. 12 assertions in ~400 ms. [`8f297c3`]
- **`npm run audit:deps` supply-chain scanner.** Walks the lockfile
  against a hand-curated list of known-compromised package versions
  from past incidents (chalk/debug Sep 2025, Shai-Hulud Jul 2025,
  rxnt-* May 2024), runs `npm audit --audit-level=moderate`, and
  re-fetches each top-level dep's integrity hash from
  registry.npmjs.org for a parity check. The scanner confirmed the
  current tree is clean (debug@4.4.3 verified as the post-incident
  patched release). [`cbd9b5c`]
- **SECURITY.md + docs/deployment.md supply-chain sections.**
  Documents the npm ci policy, the safe-update procedure (diff
  lockfile → audit:deps → npm ci → optional --ignore-scripts →
  npm test → restart + watch journal), and why postinstall scripts
  are not used in this project. [`cbd9b5c`]
- **better-sqlite3 bumped** 12.9.0 → 12.10.0 (semver minor, audit
  clean). [`1605efc`]

## [1.1.0] — 2026-05-14

This release closes the entire CRITICAL backlog and ~30 HIGH-severity findings
from the 2026-05-16 security audit. Production deployment verified on the
maintainer's panel with backup, restart and post-deploy smoke
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

[Unreleased]: https://github.com/ayozetr/assetto-server-panel/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ayozetr/assetto-server-panel/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ayozetr/assetto-server-panel/releases/tag/v1.0.0
