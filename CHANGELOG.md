# Changelog

All notable changes to this project are documented here. Format inspired by
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The dates are in `YYYY-MM-DD`. Commits referenced as `[abc1234]` link to the
authoritative diff — the changelog entry is a hand-curated summary of *why*
the change matters; the commit log is the source of truth for *what* changed.

## [Unreleased]

Hardening + ops-quality-of-life pass driven by an external audit. Nothing in
this block is user-facing on the AC server itself; operators get a new
clinical health endpoint, a CSV/JSON audit export, louder warnings when
`TRUST_PROXY` is misconfigured, and a fast unit-test layer in front of the
existing smoke run. The Dashboard also grows four new KPI tiles bringing the
metrics row to seven evenly-spaced cards and the panel back in line with its
BeamMP sibling.

### Added

- **CPU temperature badge on the Dashboard's "Uso CPU" tile.** Small
  number in the top-right corner of the existing CPU card, no layout
  changes. Sourced from `/sys/class/thermal/thermal_zone*/temp` — pure
  kernel surface, no extra package, no sudo, plug-and-play on every
  modern Linux host. `_getCpuTempC` walks each zone, prefers ones whose
  `type` matches a CPU sensor (`x86_pkg_temp`, `coretemp`,
  `cpu[-_]thermal`, `core_N`, `package_N`) and reports the highest
  reading among the preferred set so a multi-package box shows the
  hottest die. On hosts where the thermal tree doesn't exist (some VPS,
  LXC containers, FreeBSD, Windows) or every reading is out of plausible
  range, the helper returns null and the badge simply doesn't render —
  the tile looks exactly like before. Same implementation as the BeamMP
  sibling panel so the two dashboards behave identically.
- **Four new Dashboard KPI tiles** alongside the existing
  Status / Players / CPU / RAM row. All four are served by a new
  `GET /api/dashboard/extra` endpoint and refreshed every 30 s on the
  client; SQL aggregations run against tables the panel already
  maintains (`players`, `laps`), and disk walks are bounded by a
  50 GB cap so a runaway symlink can't pin the event loop.
  - **Mods en disco** — bytes consumed by content/cars + content/tracks
    **excluding** vanilla Kunos directories (the existing
    `KUNOS_CAR_IDS` / `KUNOS_TRACK_IDS` sets loaded at startup from
    `src/assets/kunos/` are used to filter the top-level walk). The
    meta line surfaces the running `acServer vX.Y.Z` when the binary
    reports a version, falling back to a static "excludes Kunos
    content" label otherwise. Version lookup is cached for 6 h so the
    only per-poll work is the (small, now-Kunos-free) disk walk.
  - **Conexiones (24 h)** — distinct drivers whose `last_seen` falls in
    the trailing 24 h. Same shape as the BeamMP sibling's "Joins
    today" tile; reuses the players table the ACSP UDP listener
    already updates on every JOIN line, so no new schema was needed.
  - **Vueltas (24 h)** — laps recorded in the trailing 24 h, the
    closest "how active was the server" proxy available without
    rebuilding uptime history from logs. Lap rows land in real time
    from the listener so the tile reflects live activity within
    minutes.
  - **Pilotos totales** — cumulative distinct drivers ever seen by
    the server (PRIMARY KEY scan over `players`). Closes the temporal
    trio "now / last 24 h / lifetime" with one cheap query.
- Twelve new i18n keys (en + es + it) for the four tile titles + meta
  lines: `dash.mods_disk`, `dash.mods_disk_meta`,
  `dash.joins_today`, `dash.joins_today_meta`,
  `dash.laps_today`, `dash.laps_today_meta`,
  `dash.total_drivers`, `dash.total_drivers_meta`.
- **`GET /api/admin/health`** — clinical-style readiness probe for
  Uptime-Kuma / blackbox-exporter / Kubernetes. Aggregates DB + disk +
  process + acServer checks into a `healthy` / `degraded` / `unhealthy`
  verdict; HTTP code mirrors the verdict (200 for the first two, 503 for
  the last) so the alert rule is a one-line non-2xx check. Admin-gated —
  the public `/api/health` still returns `{ ok: true }` and intentionally
  leaks no fingerprintable signal. Thresholds: < 500 MB free disk →
  unhealthy, < 5 GB → degraded; RSS > 1 GB → degraded; acServer down →
  degraded, not unhealthy (the panel keeps serving config edits + uploads
  when AC isn't up). [`1bb5da4`]
- **`GET /api/audit/export?format=csv|json`** — streams the audit log for
  offline analysis with optional `since` / `until` / `actor` / `action`
  filters. CSV uses `better-sqlite3` `.iterate()` so a multi-year export
  stays flat on memory; JSON ships one well-formed document because jq /
  SIEM ingestion prefers that over NDJSON. RFC 4180 quoting handles
  commas, quotes and newlines inside reason / detail fields. The export
  action is itself audit-logged with the chosen filter so an operator
  scraping the table leaves a trace. [`2925ee8`]
- **Unit tests.** `npm run test:unit` loads `lib/pure.js` directly and
  asserts on the CSV-quoting + log-parsing invariants without booting
  the HTTP server / DB / log watcher. Runs in ~5 ms; chained ahead of
  the existing smoke run by `npm test` so a broken invariant fails fast.
  [`5b12ecc`]

### Changed

- **Boot banner surfaces silent `TRUST_PROXY` misconfigurations.** Before,
  setting `TRUST_PROXY=1` with a `TRUST_PROXY_FROM` that had typos or
  malformed CIDRs would silently drop the bad entries and could leave the
  trusted-proxy allowlist completely empty — `clientIp()` then ignored
  `CF-Connecting-IP` / `X-Forwarded-For` on every request, so per-IP rate
  limits and audit-log attribution silently fell back to using the socket
  peer (typically the upstream proxy itself, one bucket for everyone). The
  defensive fallback was still correct (spoofs got ignored, not honoured),
  but there was no way for an operator to discover the misconfiguration
  short of grepping audit logs. The boot banner now prints the effective
  range count + source (`TRUST_PROXY_FROM` vs Cloudflare defaults), lists
  any unparseable entries by their original string, and warns again when
  the resulting allowlist is empty. See `docs/troubleshooting.md` for the
  remediation paths. [`0053f54`]

## [1.7.1] — 2026-05-20

Presets are now portable. Operators can download any saved preset as a
`.json` file and re-import it into the same panel or onto another
installation — useful for sharing a known-good GP / endurance / cup
configuration without having to reproduce the grid by hand.

### Added

- **Preset export.** A new download button on every preset card (next
  to edit / delete) hits `GET /api/session-presets/:id/export` and the
  browser saves the response as `<name>.json` via the
  `Content-Disposition` header the route sets. The payload is a
  self-describing envelope:
  ```json
  {
    "format": "assetto-server-panel-preset",
    "formatVersion": 1,
    "exportedAt": "<ISO>",
    "exportedFrom": "<username>",
    "panelVersion": "1.7.1",
    "preset": { "name": "...", "description": "...", "config": { … } }
  }
  ```
  The filename is sanitised against the usual hostile filesystem
  characters (`\/:*?"<>|`, control bytes), collapses runs of
  whitespace, and is capped at 80 chars with a `preset` fallback for
  edge cases. Gated by `presetManage` and writes a `preset.export`
  audit row.
- **Preset import.** A new `Import` button in the Presets page header
  opens a hidden file picker; the chosen JSON is parsed client-side
  and POSTed to `POST /api/session-presets/import`. The endpoint
  accepts both the full envelope above and a bare
  `{ name, description, config }` for hand-crafted files. When the
  requested name collides with an existing preset (case-insensitive,
  matching the schema's `UNIQUE` constraint) it auto-suffixes with
  ` (2)`, ` (3)`, … instead of erroring out, and the response
  surfaces both the final name and the original so the success toast
  can read "Imported as X — Y already existed" when a collision was
  auto-resolved. Gated by `presetManage` and writes a `preset.import`
  audit row.
- New i18n keys `presets.btn_import`, `presets.card.export`,
  `presets.toast.imported`, `presets.toast.imported_renamed`,
  `presets.toast.import_invalid`, `presets.toast.import_failed` in
  EN/ES/IT.

## [1.7.0] — 2026-05-20

Saved session presets shipped. Operators can stash a `sessionCfg` under a
name and load it back later in one click — and the page graduated from
"new feature in 1.6.0's Unreleased queue" into something ready to hand to
non-admin users: a full inline editor that opens from the pencil icon, a
new dedicated `presetManage` permission so granting preset access no
longer also hands over `server_cfg.ini` write rights, and a clutch of
layout / scroll / icon fixes from actual use. Two operational papercuts
also got patched: `dist/` self-rebuilds when the panel is restarted
through anything other than `npm start` (which `systemd` is), and
chunked mod uploads no longer fall over with a generic HTTP 500 when
`node_modules/7zip-bin` lost its `+x` bit during install.

### Added

- **Session presets.** New `Presets` page in the Content group between
  Tracks and Session, plus a "Save as preset" button on the Session page
  that snapshots the current `sessionCfg` (track, layout, slots with car
  + skin per grid position, session toggles + durations, weather,
  time-of-day, penalties, maxClients) into a saved bundle. Each card in
  the library shows track + layout name, slot count, sessions enabled,
  last-modified date and "by username". "Load into Session" drops the
  preset's config into the live `sessionCfg` and navigates to the
  Session page — the operator reviews and pushes Apply to actually send
  it to acServer, so loading a preset never directly reboots a running
  session by accident. Names are unique (case-insensitive) so re-saving
  with an existing name is the natural "overwrite" path; edit via the
  card's pencil button (opens the builder pre-filled, see below),
  delete via the trash. New endpoints `GET /api/session-presets` (list
  with summary), `POST` (create), `GET /:id` (full config), `PUT /:id`
  (update), `DELETE /:id`. All gated by the new `presetManage`
  permission (see Added below). Audit rows `preset.create`,
  `preset.update`, `preset.delete` distinguish each action. The
  `config` column is a JSON blob keeping the same shape `sessionCfg`
  has on the client + `/api/session/apply` consumes, so adding a
  Session field later doesn't need a schema migration — default-fill
  on load. Migration `012 session_presets_table` runs idempotently on
  boot. New i18n keys `nav.presets`, `presets.*`, `sess.btn_save_preset`
  translated into en/es/it.
- **Custom preset builder modal.** The "New preset" button opens a
  self-contained editor where the operator picks track + layout,
  builds the grid one slot at a time via two dropdowns (car + optional
  skin) and an "Add slot" button (so adding the same car twice with
  different skins produces two distinct grid slots, matching how
  `content.jsx` handles slots), toggles practice / qualify / race with
  their own duration / laps inputs, sets max clients, weather,
  time-of-day, air temp and penalties — all without touching the live
  `sessionCfg` or leaving the Presets page. POSTs the same `config`
  JSON shape `/api/session-presets` already accepts, so the saved row
  is interchangeable with snapshot presets when "Load into Session"
  pulls it back. A "Use current session" shortcut in the modal header
  imports the live `sessionCfg` into the draft as a starting point
  (hidden when editing — the existing preset is already the starting
  point). Adds `presets.build_modal.*` strings in EN/ES/IT.
- **Sidebar reorder in the Content group**: Cars → Tracks → Presets →
  Session → Mods. The natural flow is now "pick a preset → review in
  Session → Apply", with mod installation at the end where it belongs
  (it's a content-management action, not part of the running-config
  flow).
- **Full preset editor.** The edit (pencil) button on a preset card now
  opens the same builder modal as "New preset", pre-filled with the
  loaded config — track, layout, every slot, session toggles +
  durations, weather, time-of-day, air temp, penalties and maxClients.
  Submitting PUTs by id instead of POSTing a new row. The old
  rename-only modal is gone; the same field is editable inline through
  the full editor. Adds a new i18n key `presets.build_modal.edit_title`
  in EN/ES/IT and renames `presets.card.rename` → `presets.card.edit`.
- **`presetManage` permission.** Granular permission gating the Presets
  page and the "Save as preset" button on the Session page. Replaces
  the previous double-up where these features required `serverConfig`,
  so a user account that should only manage saved presets no longer
  has to also be granted the right to edit `server_cfg.ini`. Listed in
  the Users → Role permissions card directly below "Edit server
  configuration". Default `true` for the `user` role; the backend
  backfills the key into pre-existing `role_permissions_user` rows so
  upgrades grant it automatically rather than silently denying it.

### Fixed

- **Cards inside the builder/edit modal clipped their own bottoms.**
  In practice operators saw only the labels of Track & layout (no
  selects), the Race row sliced in half in Sessions, the bottom two
  cells of Conditions (Temp + Penalties) gone, and only the first
  added car in the Cars list. Cause: `.modal-body` is a flex column
  with a max-height, every `.card` has `overflow: hidden` for its
  rounded corner, and flex containers compute an item's min-content
  size *without* its overflow-hidden contents — so the body had no
  reason to scroll, it just shrunk every card past its natural height
  and each card clipped the missing portion. Adds `flex-shrink: 0` to
  every direct child of the modal-body (the name+description grid
  plus the four cards) so they hold their natural height and the body
  actually scrolls when the total exceeds the max-height.
- **BuildPresetModal crashed with React error #310** ("Rendered more
  hooks during this render than during the previous render") the
  moment the modal mounted. The `useMemo` calls for `sortedCars` /
  `sortedTracks` sat below the `if (!open) return null` early-return,
  so the closed-render saw N hooks (useState + useEffect only) while
  the open-render saw N+2 — React's hook-count check fired the
  instant `open` flipped from false to true and the error boundary
  tore down the whole app. Moves both `useMemo` calls above the
  early return so the hook count stays constant across renders.
- **Infinite refetch loop on the Presets page** when the list was
  empty. The `t()` and toast objects passed into `refresh()`'s
  `useCallback` dep array got a fresh reference on every render
  (`AppI18n.t.bind(...)` returns a new function ref each time,
  `useToast()` returns a new context value), so `refresh()`'s
  identity flipped each render, the `useEffect` that depends on it
  fired, `setLoading(true)` re-rendered the component, and the cycle
  repeated — the "Loading…" placeholder never settled and the
  empty-state card never had a chance to render. Captures both
  through `useRef` so `refresh` keeps an empty dep array, and adds a
  manual Refresh button in the page header for explicit reloads.
- **Edit / delete icon buttons on preset cards were left-aligned
  inside the 32×32 box** instead of centred. `.btn` is
  `display: inline-flex` with the default `justify-content: flex-start`,
  and the prior `.btn.icon-btn { padding: 0; gap: 0; }` reset left
  that alignment in place, so the 13px SVG drew against the left edge
  of the box. CSS now also forces `justify-content: center` on the
  combined selector, snapping the icon to the middle.
- **Edit / delete icon buttons on preset cards rendering as blank
  32×32 squares**. `.btn.icon-btn` inherited `padding: 7px 14px` from
  `.btn` while keeping the fixed 32×32 from `.icon-btn` — with
  `box-sizing: border-box` that left ~4px of content area, so the
  13px SVG inside got squeezed out of the visible box even though the
  button itself drew correctly. Resets `padding` + `gap` to 0 only
  when both classes are combined so the bordered icon button keeps
  `.btn`'s surface/border/hover treatment but actually shows the icon.
- **`dist/` served stale UI after deployments that invoke `node server.js`
  directly.** The `prestart` hook in `package.json` only fires under
  `npm start`; the production systemd unit runs `node server.js`, so
  `git pull` updated `src/` but `dist/` kept the previous build's
  bundles — operators saw old UI until someone manually ran
  `node build.js`. `server.js` now runs an auto-build check at startup:
  it compares the newest `src/**` mtime against the `dist/app.js` mtime
  and invokes `build.js` synchronously (via `spawnSync`) only when
  `dist/` is missing or older. Warm restarts stay fast (single `stat`
  per file, no rebuild when up to date), fresh clones work with
  `node server.js` directly without a separate build step, and a failed
  build is non-fatal — the panel still boots and serves whatever
  `dist/` currently has, with a warning in the log.
- **HTTP 500 on chunked mod upload when `node_modules/7zip-bin/linux/x64/7za`
  was missing its +x bit.** `npm install --ignore-scripts`, tarball
  restores, and `node_modules` copied between machines all drop the
  execute bit on the bundled 7za binary; the chunk upload route then
  hits `spawn EACCES` inside `node-7z.extractFull` and the handler
  responds with a generic 500, so the operator only sees "upload
  failed" with no clue why. `server.js` now runs an idempotent
  `fs.chmodSync(sevenBin.path7za, 0o755)` right after the
  `require('7zip-bin')`, gated to non-Windows. Any chmod failure
  (read-only `node_modules`, missing file) is swallowed so the panel
  still boots; the underlying spawn error would still surface clearly
  at upload time.

## [1.6.0] — 2026-05-19

The Dashboard finally answers the "where are they on the track right now?"
question — a live minimap with a dot per car, driven by the UDP position
stream. The release also fixes a long-standing operational paper-cut: every
`systemctl restart assetto-dashboard` used to kick `acServer` along with the
panel, dropping connected drivers mid-session. Panel restarts are now
transparent to players.

### Added

- **Live position telemetry on the Dashboard.** New widget renders the
  current track's `map.png` as a top-down minimap with one absolute-positioned
  dot per connected car, animated at ~4Hz from a new
  `GET /api/positions/stream` SSE channel. The dots follow the world→pixel
  projection encoded in each layout's `data/map.ini` (`WIDTH`, `HEIGHT`,
  `X_OFFSET`, `Z_OFFSET`, `SCALE_FACTOR`, `MARGIN`) — same formula Content
  Manager and CSP use, so the trail/dot alignment matches what drivers see
  in-game. UDP `CAR_UPDATE` (event 53) is now parsed and stored on
  `udpState.cars[carId].pos`; on listener boot the panel sends
  `ACSP.REALTIMEPOS_INTERVAL` (event 200, 100ms) once to subscribe acServer's
  10Hz position stream. The SSE timer is ref-counted on the subscriber set
  so an empty Dashboard tab doesn't drain CPU. Two new content endpoints
  expose the assets: `GET /api/content/tracks/:id/map?layout=…` serves the
  PNG, `GET /api/content/tracks/:id/map-meta?layout=…` returns the parsed
  INI as JSON. Helpers `_trackMapPngPath` / `_trackMapIniPath` resolve the
  per-layout vs root-of-track file conventions and fall back to the bundled
  Kunos assets directory. Graceful degradation: layouts without map data
  show a "live map not available for this layout" placeholder instead of
  breaking the dashboard. The widget only mounts when the server is running
  AND ≥1 player is connected AND the active track resolves to a catalogue
  entry — the rest of the time the card is hidden, so the Dashboard stays
  compact on an idle server. New i18n keys `dash.live_map`,
  `dash.live_map_unavailable`, `dash.live_map_waiting` in en/es/it.

### Fixed

- **`acServer` no longer dies when the panel is restarted.** Previously
  `systemctl restart assetto-dashboard` killed `acServer` along with the
  panel — two reasons: (1) the child shared the panel's POSIX session, so
  the panel's exit propagated `SIGHUP` to it via the session-leader rules,
  and (2) `acServer`'s stdout/stderr were piped into the panel, so node
  closing those pipes on exit gave the child `SIGPIPE` on its next write
  regardless. Both are now addressed: `spawnAC()` passes `detached: true`
  to `spawn()` (which calls `setsid(2)`, putting `acServer` in its own
  session + process group), and its `stdio` is now `['ignore', fd, fd]`
  with `fd` a write-append handle on `AC_LOG_FILE` that the panel closes
  immediately after the spawn — `acServer` keeps a dup'd copy and writes
  straight to disk, no node-held pipe in the middle. The panel re-attaches
  to log output by tailing `AC_LOG_FILE` with `fs.watch` + a 2 s safety-net
  poll (`startLogTail()`); the existing `/api/logs/stream` SSE channel is
  unchanged. The existing `findACPid()` adoption path picks the orphaned
  `acServer` back up on the new panel boot, so connected drivers see no
  disconnect across a `git pull && systemctl restart` deploy. Heads-up: the
  first restart that lands this fix still kicks players one last time —
  the running panel was spawned with the old (pipe-based) code; the
  detached spawn only takes effect from the next start onwards.

## [1.5.1] — 2026-05-19

Polish patch for the v1.5.0 public driver profile feature, plus general
cache-busting infrastructure improvements. Every driver page is now
multilingual, ships proper raster previews for Discord, and exports a
downloadable stat card with the driver's personal best on their
most-played combo.

### Added

- **Light theme variant** for `/p/<steam-id>` and its OpenGraph card.
  Toggled via the new sun/moon button in the page topbar (anchor-based,
  navigates with `?theme=light|dark`); choice propagates to the OG
  image URL so a `?theme=light` link in Discord previews with the
  light variant rather than the panel-default dark.
- **Visible language switcher** in the SSR topbar — three flag chips
  (EN/ES/IT) that flip the page via `?lang=…`, preserved across
  subsequent toggles so changing language doesn't reset theme and
  vice-versa.
- **i18n for the SSR page**: every visible label and the OG /
  Twitter card description text translates to English / Spanish /
  Italian. Detection is layered — `?lang=` query override →
  `Accept-Language` header → `panel_settings.lang` (panel-wide
  default) → `en`. The OG image language also follows the chosen
  lang when explicit, so Discord previews stay consistent with the
  sharer's link rather than always rendering in the panel default.
- **Recent laps** card on `/p/<steam-id>` showing the last 10 laps
  the driver has set (any combo), with invalid-lap strike-through
  + amber badge for laps with cuts. Surfaces in the JSON response
  as `recentLaps[]`.
- **Downloadable stat card** at `/p/<steam-id>/card.png` — a
  1200×630 shareable PNG with the panel logo, five KPI tiles
  (total laps, time on track, most-used car, driver's best lap
  on their most-played track, server records held), and a small
  silhouette of the most-played track's `map.png` in the upper
  right. Light and dark variants follow the page's `?theme=`;
  the download button next to the language switcher carries the
  current theme + lang through into the saved file. Filename
  suggestion (`driver-76561198000000001.png`) baked into
  `Content-Disposition`.
- **Steam glyph** before the GUID on every preview surface — the
  `/p/<guid>` page chip, the OG card, and the download card — so
  the chip reads as a Steam profile id at a glance.
- **Real flag images** via `flagcdn.com` instead of the unicode
  regional-indicator pair the v1.5.0 page used; Windows visitors
  no longer see "ES" / "GB" / "IT" as literal letters when their
  fonts lack the regional-indicator face.
- **Most-used car** + **most-played track** + **driver's best on
  most-played track** computed in `/api/public/players/:guid` and
  surfaced in `kpis.mostUsedCar`, `kpis.mostPlayedTrack` and
  `kpis.bestOnMostPlayed`, so Discord bots / external dashboards
  get the same data structure the rendered cards use.

### Changed

- **OG image moved from SVG to PNG** at `/p/<guid>/og.png` via the
  new `@resvg/resvg-js` pure-WASM dependency. Discord's OpenGraph
  parser hard-rejects `image/svg+xml` and bails with "couldn't
  load image"; PNG works everywhere. The SVG endpoint stays
  available at `/p/<guid>/og.svg` for direct browsing.
- **OG image URL is now versioned** with
  `?v=<BUILD_VERSION>-<lastSeen>` so Discord re-fetches when (a)
  the panel is redeployed or (b) the driver records a session
  more recent than the previous one. Without this, Discord
  pinned the first preview it ever saw under that URL
  indefinitely regardless of subsequent updates.
- **`BUILD_VERSION` cache-buster** is now recomputed per
  `/index.html` request with a 5-second TTL instead of being
  frozen at module load. Previously a `git pull && npm run build`
  without a `systemctl restart` left the `?v=` query stuck at
  the boot-time mtime, so Cloudflare's edge replayed the old
  bundle. Now any rebuild reaches browsers on the next page load.
- **`src/styles.css` link** also gets a `?v=…` cache buster in
  `index.html`. CSS-only deploys were previously invisible for
  up to 10 minutes while Cloudflare's edge served the previous
  stylesheet.
- **Spanish UI terminology refresh**: the mod upload page and
  the permission-hint copy now say "tramo" / "tramos" instead
  of "circuito" / "circuitos" — matches the touge / rally
  framing the panel's primary deployment uses. The Tracks
  sidebar nav also switches to a new `IconCircuit` (an
  irregular-loop silhouette) instead of the athletics-oval
  `IconTrack` it shared with the Session card.

### Fixed

- **`bestDate` on `/api/public/players/:guid`** pointed at the
  earliest valid lap instead of the date the fastest lap was
  actually set. The fastest-lap-on-X-date KPI in the rendered
  page was therefore showing the wrong date for any driver
  whose PB came after an earlier slower lap. Now a follow-up
  query filters by `ms = bestMs` and returns the matching
  `session_date`.
- **`/p/<guid>`, `/p/<guid>/og.png`, `/p/<guid>/og.svg`,
  `/api/public/players/:guid` and `/p/_theme.js`** all accept
  `HEAD` requests now, matching the `GET` response shape.
  Discord/Twitter scrape with `GET` but `curl -I`, Cloudflare
  healthchecks and link-unfurl bots use `HEAD` and were getting
  401 / 404 / wrong-content-type back from those handlers.
- **Map silhouette on the download card** is now legible on the
  light theme — was rendering near-invisible because AC's
  `map.png` ships anti-aliased low-contrast trails that wash
  out on a pure white surface. The map's container rect is now
  always dark regardless of card theme with the trail inverted
  to white, so the thumbnail reads as a focal element on both
  light and dark cards.
- **KPI tile overflow** on the download card: long car names
  like "Toyota AE86" used to clip out of the 210px
  tile width with the ellipsis spilling past the rounded
  border. Now greedy-pack text values across two lines with a
  16-char-per-line budget, so the full name is visible without
  truncation.
- **`/p/<guid>/card.png` download link** had a relative `href`
  that resolved against `/p/<guid>` (no trailing slash) and
  landed at `/p/card.png` instead of the intended path. The
  browser returned "El archivo no estaba disponible en el sitio"
  for the click. Href is now absolute.
- **OG image lang propagation**: a link shared with `?lang=en`
  used to render the page in English but the Discord preview
  still in the panel default (because Discord's crawler
  doesn't send `Accept-Language`). The OG image URL now
  includes `&lang=…` when the lang was set explicitly, so the
  preview language matches what the sharer chose.

### Upgrade notes

- New dependency: `@resvg/resvg-js` (pure-WASM, no native
  compilation, ~6 MB installed). Run `npm install` after
  pulling.
- Service Worker cache name bumped from `ac-panel-v38` to
  `ac-panel-v39` so existing PWA installs drop their old
  cached bundle on the next reload and pick up the new JS.
- `panel_settings.lang` is now consulted by the public profile
  language resolver as a fallback. Setting it (via Settings →
  Idioma) controls the default language used in OG previews
  when a visitor's `Accept-Language` doesn't match a supported
  locale.
- No DB migration — every new SQL query against `players` /
  `laps` uses columns that already existed.

## [1.5.0] — 2026-05-18

Public-facing release: every driver the panel has seen now has a
shareable, login-less profile page, plus a couple of UDP live-driver
fixes that landed in the same session.

### Added

- **Public driver profile pages.** Every driver the panel has seen gets a
  shareable URL at `/p/<steam-id>` rendering a server-side page with their
  totals (laps, time on track, sessions), best lap, server records held
  (combos where they own the per-(track, layout, car) MIN(ms)) and personal
  bests across every combo they've driven. No login required, no scraping
  of the SPA — the page is plain HTML with the panel's `src/styles.css`
  for visual continuity, an Inter + JetBrains Mono `<link>`, OpenGraph +
  Twitter card meta tags so Discord previews show name + headline stats,
  a small unicode-flag (ISO-3166 codepoint pair, no SVG asset), a hero
  card with avatar + nickname/in-game/GUID, four KPI cards, and the two
  records / personal-bests tables. Track and layout names resolved through
  `ui_track.json` so a combo reads as "Red Bull Ring / Grand Prix"
  (matching the **Active Session** card) instead of the raw
  `ks_red_bull_ring / layout_gp` slug; car names resolved through
  `ui_car.json` the same way. The hero's GUID chip is the Steam link
  itself — the entire pill clicks through to `steamcommunity.com/profiles/<guid>`
  with the Steam logo on the left and the GUID text after it (no
  external-link icon needed, the destination is self-evident). A
  companion `/api/public/players/<id>` endpoint returns the same data as
  JSON for Discord bots / Twitch overlays — both raw `trackConfig`
  slug and pretty `layoutName` ship in the response so machine
  consumers don't need to guess. Both endpoints validate the 17-digit
  Steam GUID shape, accept `GET` and `HEAD`, rate-limit at 120/min/IP,
  and respect a new `public_profiles_enabled` toggle in Settings
  (admin-only PUT, default on, audited as `panel.public_profiles`). A
  share-link button (`IconLink`) joined the Players page's history table
  next to the edit-nickname pencil so an admin can copy the public URL
  with one click. Four cheap SQL queries against the existing `players`
  + `laps` tables; no schema migration. Closes ROADMAP item "#1 Public
  player profile pages".

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
