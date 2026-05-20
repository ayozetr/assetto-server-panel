# Roadmap

Where the panel is, what's done, what's next.

This document is a public summary of the project's state — not the internal
backlog (`TASKS.md` and `ASSESSMENT.md` are gitignored). It exists so anyone
landing on the repo can answer three questions in under a minute:

1. Is the panel production-ready? **Yes** — see [Status](#status).
2. How does it compare with what already exists in the AC ecosystem? — see
   [Comparison vs ACSM / Stracker](#comparison-vs-acsm--stracker).
3. What's planned next? — see [Backlog](#backlog).

---

## Status

| Aspect | Score | Notes |
|---|---:|---|
| **Hardening** | **99 / 100** | All CRITICAL and HIGH findings with active exploits are closed. `npm audit` and the bundled `npm run audit:deps` both report **0 vulnerabilities** as of 2026-05-20. The one remaining point is `§6.5 extractRar` (no streaming API in `node-unrar-js`, so a `.rar` upload is read into RAM; mitigated by the 2 GB hard cap on upload size plus a 2-slot extractor semaphore that bounds peak memory). The other items originally counted against the score in May (`tar-fs` CVEs in 2.x, `prebuild-install` deprecation, `node-stream-zip` and `node-unrar-js` upstream stalls) have either been patched upstream (`tar-fs@2.1.4` carries the fixes for CVE-2024-12905 / CVE-2025-48387) or remain as deprecation / no-update warnings with no exploitable CVE — they don't move the score because they don't increase risk. |
| **Tests** | 75 / 100 | `npm test` covers auth, must-change gate, CSRF, rate-limit, TOTP (RFC 6238 reference vector), INI render guard. No deep coverage of mod extractors or UDP packet parsing yet. |
| **Docs** | 90 / 100 | README, 9 dedicated `docs/*.md` files (installation, Docker, Cloudflare, AC server setup, mods, auth, API, database, troubleshooting, tools), SECURITY.md with supply-chain section, CHANGELOG. Missing: architecture diagram, screenshots, formal threat model doc. |
| **Portability** | 95 / 100 | One-command Docker (`docker compose up -d`), bare-metal systemd, auto-detect of AC paths from conventional layouts, `npm run setup` wizard, public `/api/setup/status` endpoint, sane defaults across `.env`. Missing: a Helm chart and a one-click "deploy to VPS" option. |
| **Features vs the field** | 70 / 100 | Caught up with most of ACSM's table stakes (mod manager, session apply, lap times, Discord notifications, audit log, scheduled backups). Leads on security (2FA, ban TTLs, hash-chained audit). Lags on multi-server, race events / championships, public player profiles. See the comparison table below. |

**Overall: ~93 / 100.** The remaining 7 points are mostly product surface
area (championships, multi-server, telemetry replay, league features)
rather than technical debt — public driver profiles and live position
telemetry already shipped in 1.5.x and 1.6.x.

The project follows [Semantic Versioning](https://semver.org). The current
release is documented in [`CHANGELOG.md`](CHANGELOG.md); the latest version
also appears on the badge row at the top of [`README.md`](README.md).

---

## Comparison vs ACSM / Stracker

Quick reference. Reflects the public state of each project at the time this
document was written; check upstream for newer releases.

**ACSM** = various community forks of "Assetto Corsa Server Manager"
(originally JustaPenguin/assetto-server-manager), Go-based.

**Stracker** = `NeysX/stracker` and forks — a Python web service that
plugs into the AC UDP plugin to record lap-time statistics. Not a full
admin panel; its scope is narrower than ACSM.

| Feature | Assetto Server Panel | ACSM | Stracker |
|---|:-:|:-:|:-:|
| Mods upload (.zip / .rar / .7z) | ✅ | ✅ | ❌ |
| Session apply (track / cars / weather / time) | ✅ | ✅ | ❌ |
| Lap times + per-track records | ✅ | ✅ | ✅ (its core) |
| UDP live capture (laps, joins, sessions) | ✅ | ✅ | ✅ |
| Discord webhook on records | ✅ | ✅ | ❌ |
| Audit log with **SHA-256 hash chain** | ✅ | ❌ | ❌ |
| **Two-factor auth (TOTP, RFC 6238)** | ✅ | ❌ | ❌ |
| **Ban list with reason + duration + auto-unban** | ✅ | ❌ | ❌ |
| Scheduled DB backups with retention | ✅ (opt-in) | ❌ | ❌ |
| Docker first-class (multi-stage, hardened) | ✅ | ✅ | ❌ |
| **Supply-chain scanner** (`npm run audit:deps`) | ✅ | ❌ | ❌ |
| Granular per-user permissions (9 toggles) | ✅ | ✅ | ❌ |
| Three-language UI (en / es / it) | ✅ | partial | ❌ |
| PWA / offline read-only | ✅ | ❌ | ❌ |
| Multi-server (manage several acServer instances) | ❌ | ✅ | ❌ |
| Race events / championships with standings | ❌ | ✅ | ❌ |
| Public player profile pages | ✅ | ✅ | ✅ |
| Live position telemetry on a track map | ✅ | partial | ❌ |
| ELO / Glicko rating per driver | ❌ | ❌ | ❌ |
| Stints heatmap (consistency over a session) | ❌ | ❌ | partial |
| Strava-like driver statistics page | ❌ | ✅ | partial |

**Where the panel leads**: security (the only one with hash-chained
auditing, 2FA, ban TTLs, an integrated supply-chain scanner, and a public
`/api/setup/status` endpoint to drive a first-run banner) and operational
ergonomics (`npm run setup` wizard, one-command Docker, brotli-compressed
responses, dedicated SECURITY.md).

**Where the panel lags**: anything that turns the panel into a "league
hosting tool" rather than a "single-server admin tool" — multi-server,
championships, public driver pages, live telemetry. These are the gaps
that decide whether a league organiser picks this panel over ACSM.

---

## Backlog

Ordered by **return on investment** (ROI = impact ÷ effort) so the
top entries are what to do next. Difficulty is a rough effort
estimate: **S** ≤ 1 day · **M** 1-3 days · **L** 3-7 days · **XL** weeks.

### Doing next (top-ROI)

| # | Feature | Effort | Why it's high-ROI |
|---|---|:-:|---|
| 1 | **Race events / championships** | XL | The single biggest reason a league organiser picks ACSM over a generic panel. New tables (`championships`, `championship_rounds`, `championship_entries`), a calendar UI, a points-system editor, a standings page that updates as result files land. This is what would push the panel from "good admin tool" to "league platform". |
| 2 | **Session presets / templates** | M | Save "Practice 30m + Qualy 15m + Race 12 laps at Spa with GT3 grid" as a single click. Quality-of-life that operators flip to ACSM for. Lightweight table + one new card in the Session page. |
| 3 | **Stints heatmap** | M | Visual of how a driver's lap times evolve through a session. Chart.js or plain SVG; the data is already in `laps` (by `session_date` + `lap_timestamp`). |
| 4 | **Multi-server support** | XL | Refactor: `AC_BIN`, `AC_CFG_DIR`, `AC_CONTENT_DIR` stop being globals and become entries in a `servers` table. Sidebar gets a server picker; every existing endpoint scoped by `?server=N`. Big change, breaks the "single file server.js" feel; worth it only if you actually run several `acServer` instances. |

### Maybe later (lower-ROI or higher-risk)

| Feature | Effort | Notes |
|---|:-:|---|
| ELO / Glicko / TrueSkill rating | L | Needs proper race-result parsing (the panel records laps, not finishing positions). Worth pairing with #2 (championships) — same data dependency. |
| Replay viewer integrated in the panel | XL | AC server doesn't record replays itself — would need a per-driver upload flow and a streaming player. Big infra change. |
| Email password recovery (SMTP) | M | The README currently says "edit `assetto.db` with SQL if you lock yourself out". A self-service flow with `nodemailer` would be friendlier. Needs SMTP config in `.env`. |
| API keys for external integrations | M | Token-based read-only access to `/api/results`, `/api/players/history`, etc. so a Discord bot or a Twitch overlay can pull data without sharing a session cookie. |
| Notifications channel beyond Discord | S | Slack / Telegram / generic webhook — small abstraction over the existing record-notification path. |
| Strava-like driver page (mileage, podiums, badges) | M | Build on top of #1 (public player pages). Aggregations from `laps` + a `race_results` table when #2 lands. |
| CLI companion tool | M | `assetto-panel-cli backup`, `... user-list`, `... ban add` — useful for SRE / scripts. Hits the same HTTP API with an API key from the bullet above. |
| Importer from Stracker / ACSM | L | Read their SQLite, map to the panel's tables. Migration tooling for users coming from those projects. |
| Per-driver private admin notes | S | Tiny table; modal next to the existing nickname editor. |

### Internal / non-product

| Item | Effort | Notes |
|---|:-:|---|
| Modularise `server.js` into `lib/*.js` | L | 4.7k lines in one file is fine today but grows worse with every release. Internal refactor; no user-visible change. |
| JSDoc-typed shapes (`Player`, `Lap`, `Session`) | M | IDE warnings + auto-complete without a TypeScript migration. `// @ts-check` at the top of each file. |
| Move `index.html` paths to absolute | S | `src/assets/icon.png` etc. currently relative; breaks if the panel is ever mounted at a sub-path behind a reverse proxy. |
| Architecture diagram + screenshots in README | S | Cheap content that helps adoption. |
| Formal STRIDE threat-model document | S | README has an informal threat model; a structured doc would help auditors. |

### Upstream-blocked (in the audit, not actionable here)

| Dependency | Status |
|---|---|
| `prebuild-install@7.1.3` | Marked deprecated by maintainer. Transitive of `better-sqlite3`; nothing to do until that package migrates off it. |
| `tar-fs@2.1.4` | CVE history in 2.x; transitive of `prebuild-install`. Same boat. |
| `node-stream-zip@1.15.0` | No release since 2022. Application-level mitigations (symlink reject, zip-slip abort, decompression-bomb caps) are documented in `SECURITY.md`. `npm run audit:deps` confirms the current pinned version is clean. |
| `node-unrar-js@2.0.2` | Upstream frozen. Mitigation: same as above + the 2-extractor concurrency cap added in [1.1.0]. |

These do not affect production but are tracked so a future refresh can
swap them all in one focused release.

---

## Done

Everything in this list is shipped in a tagged release and verified in
production. See [`CHANGELOG.md`](CHANGELOG.md) for the per-release detail.

### [1.6.0] — 2026-05-19

- **Live position telemetry on the Dashboard** — top-down minimap of the
  current track with one dot per connected car at ~4 Hz, driven by a new
  `/api/positions/stream` SSE channel. Built on top of the existing UDP
  plugin (`CAR_UPDATE` event 53, with a `REALTIMEPOS_INTERVAL` subscribe
  on boot) and the per-layout `data/map.ini` projection so the dots line
  up with what drivers actually see in-game. Card is hidden on an idle
  server; the SSE timer is ref-counted on subscribers so an empty
  Dashboard tab doesn't burn CPU. Closes the comparison-vs-ACSM row that
  was ❌ since launch.
- **`acServer` survives a panel restart.** `spawnAC()` now uses
  `detached: true` + file-FD stdio (writing straight to `AC_LOG_FILE`,
  no node-held pipes), and the panel re-reads its output by tailing the
  file. `systemctl restart assetto-dashboard` no longer drops connected
  drivers — the existing `findACPid()` adoption picks the orphaned
  process back up on the new panel boot.

### [1.5.1] — 2026-05-19

- **Public profile polish**: light/dark theme variant for `/p/<guid>`
  + OG card (URL-controlled via `?theme=`), visible flag + sun-moon
  switchers, full SSR i18n (en/es/it), recent-laps card, real flag
  images via flagcdn.com (no more Windows-rendering glitches with
  unicode emoji), Steam glyph next to the GUID everywhere.
- **Downloadable PNG stat card** at `/p/<guid>/card.png` with 5
  KPIs including driver's best lap on their most-played track + a
  silhouette of that track's `map.png` rendered legible on both
  themes. New `@resvg/resvg-js` dep does the SVG → PNG raster.
- **OG image moved SVG → PNG** because Discord rejects SVG
  og:image with "couldn't load image". The PNG endpoint URL is
  versioned with `BUILD_VERSION-lastSeen` so cached previews
  auto-refresh after deploys + new sessions.
- **General cache-busting fixes**: `BUILD_VERSION` recomputes per
  request (was frozen at module load), `src/styles.css` link in
  `index.html` also gets the `?v=` cache-buster so CSS-only
  deploys reach browsers without operator intervention.

### [1.5.0] — 2026-05-18

- **Public driver profile pages** at `/p/<steam-id>` — totals, server
  records held, personal bests, OpenGraph previews for Discord shares.
  Companion `/api/public/players/<id>` for bots. Admin-toggleable from
  Settings; on by default. ROADMAP-doing-next #1 closed.
- **UDP live-driver fixes** — phantom drivers on dashboard boot are
  gone (boot burst now gated on `/JSON|0`'s `IsConnected` flag rather
  than blindly firing `GET_CAR_INFO` at 64 slots), and `players.nation`
  is now persisted from `/JSON|0` so the connection-history flag
  survives a disconnect even for drivers who have never closed a
  session result.

### [1.4.0] — 2026-05-17

- Banlist with `reason`, `duration`, auto-unban sweeper, manual unban,
  `/api/bans` list endpoint, `BanModal` form, `BansSection` table on the
  Players page.

### [1.3.0] — 2026-05-17

- Two-factor authentication (TOTP, RFC 6238) for panel accounts. Inline
  HMAC-SHA1 implementation, no new dep. Profile-page enable / disable
  flow, login second-factor field, full `en / es / it` i18n coverage,
  audit rows for enable / disable, smoke-test coverage of the RFC 6238
  reference vector.

### [1.2.0] — 2026-05-16

- LICENSE rewrite: use-anywhere (incl. public + commercial servers) +
  no redistribution + irremovable Attribution Marks.
- Multi-stage **Dockerfile** + **docker-compose.yml** + **.dockerignore**.
- **AC paths auto-detect** + `/api/setup/status` public endpoint +
  setup-mode banner on the login screen.
- **`npm run setup`** first-run wizard.
- **Scheduled DB backups** opt-in via `BACKUP_INTERVAL_HOURS`.
- **Numbered migrations runner** with `schema_migrations` table.
- **`npm test`** smoke runner (12 assertions in ~400 ms).
- **`npm run audit:deps`** supply-chain scanner.
- All Spanish UI captions in docs translated to English.
- Dedicated `docs/docker.md`.

### [1.1.0] — 2026-05-14

- Audit closure: every CRITICAL finding and ~30 HIGH from the May 2026
  internal audit. Headline items:
  - SRI hashes on the unpkg-loaded React + ReactDOM.
  - CSRF guard tightened (`Origin` / `Referer` required when `sid`
    cookie is present).
  - `TRUST_PROXY` validates the socket peer against a CIDR allowlist
    (default: Cloudflare edge IPs + loopback).
  - Symlink-rejection in mod extractors + `lstat` in content delete.
  - `_renderIniValue` guard against INI metacharacter injection.
  - Chunked upload serialised per `uploadId` + per-chunk hash + `O_EXCL`.
  - Audit retention boundary row preserves the hash chain across sweeps.
  - Login timing oracle closed (dummy scrypt on the not-found branch).
  - Discord webhook hostname allowlist after `new URL()`.
  - Compression negotiation (gzip / brotli) for compressible responses.
  - i18n for the Recent Activity feed.
  - Accessible `Switch` component with `role="switch"` + keyboard.
  - Focus trap + `aria-modal` on every modal.

### [1.0.0] — pre-2026-05

- Initial public release with all the foundational features (mod uploader,
  Discord webhook, granular role permissions, session apply, manual lap
  insert, UDP plugin listener, PWA / Service Worker, three-language UI,
  audit log with hash chain, light / dark themes). See `git log` before
  `2026-05-14` for the pre-1.0 history.
