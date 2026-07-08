require('dotenv').config();

const http          = require('http');
const https         = require('https');
const fs            = require('fs');
const zlib          = require('zlib');
const { AsyncLocalStorage } = require('async_hooks');
const fsp           = fs.promises;
const path          = require('path');
const os            = require('os');
const crypto        = require('crypto');
const { spawn, spawnSync } = require('child_process');

// ── Auto-build dist/ if stale or missing ────────────────────────────────────
// The package.json `prestart` hook only runs under `npm start`. Deployments
// that invoke `node server.js` directly (systemd unit, docker, fresh clone)
// would otherwise serve a stale or empty dist/ — users see old UI even after
// pulling new src/. Compare newest src/ mtime against the dist/app.js marker
// and rebuild only when needed so warm restarts stay fast.
(function ensureBuildFresh() {
  const distMarker = path.join(__dirname, 'dist', 'app.js');
  const srcDir     = path.join(__dirname, 'src');
  if (!fs.existsSync(srcDir)) return; // not a source tree (e.g. extracted dist-only build)
  let distMtime = 0;
  try { distMtime = fs.statSync(distMarker).mtimeMs; } catch { /* missing */ }
  let srcMtime = 0;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else { const m = fs.statSync(p).mtimeMs; if (m > srcMtime) srcMtime = m; }
    }
  })(srcDir);
  if (distMtime > 0 && distMtime >= srcMtime) return; // already fresh
  console.log(distMtime === 0
    ? '  [build] dist/ missing — running build.js…'
    : '  [build] dist/ older than src/ — running build.js…');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'build.js')], { stdio: 'inherit' });
  if (r.status !== 0) console.warn(`  [build] build.js exited with status ${r.status}; serving existing dist/ as-is`);
})();

// ── Mod extraction libraries (loaded lazily to avoid startup errors if missing) ─
// Each format has an optional dependency. We log a clear banner at startup if a
// library is missing so ops can see "RAR support disabled" before users hit a 500.
let StreamZip, Unrar, sevenZ, sevenBin;
const _missingExtractors = [];
try { StreamZip = require('node-stream-zip'); } catch { _missingExtractors.push('zip (node-stream-zip)'); }
try { Unrar    = require('node-unrar-js');   } catch { _missingExtractors.push('rar (node-unrar-js)'); }
try { sevenZ   = require('node-7z');         } catch { _missingExtractors.push('7z (node-7z)'); }
try { sevenBin = require('7zip-bin');        } catch { _missingExtractors.push('7z binary (7zip-bin)'); }
// Some npm installs (--ignore-scripts, tarball restores, or node_modules copied
// across machines) drop the +x bit on the bundled 7za binary, so spawn() later
// throws EACCES and chunked mod uploads fail with HTTP 500. chmod is a no-op on
// Windows and idempotent everywhere else.
if (sevenBin && sevenBin.path7za && process.platform !== 'win32') {
  try { fs.chmodSync(sevenBin.path7za, 0o755); } catch { /* read-only fs etc. — surfaced later at spawn time */ }
}
if (_missingExtractors.length) {
  console.warn(`  Mod extraction limited — missing: ${_missingExtractors.join(', ')}. Run "npm install" to enable.`);
}

// ── Logging ──────────────────────────────────────────────────────────────────
// Each HTTP request runs inside an AsyncLocalStorage scope holding a short
// request id, surfaced as the `X-Request-Id` response header. log.info / .warn /
// .error pick up that id automatically — no extra parameter to thread through.
// Outside a request scope (startup, sweepers, AC spawn callbacks…) the id is
// omitted and the line still gets a timestamp + level.
const _reqContext = new AsyncLocalStorage();
// Re-entrant guard. log.* feeds appendLog, which iterates SSE clients and may
// trigger a write failure that someone in the future could decide to log via
// log.warn — instant infinite loop. The flag short-circuits the inner call
// to a console-only emit, breaking the cycle without losing the message.
let _logEmitDepth = 0;
function _logEmit(level, args) {
  const ctx    = _reqContext.getStore();
  const ts     = new Date().toISOString();
  const prefix = ctx?.reqId ? `${ts} ${level} [${ctx.reqId}]` : `${ts} ${level}`;
  const stream = (level === 'ERROR' || level === 'WARN') ? console.error : console.log;
  stream(prefix, ...args);
  if (_logEmitDepth > 0) return; // mid-broadcast — don't loop back through appendLog
  // Mirror into logBuffer so the Dashboard activity card sees [UDP] events
  // and other panel-internal log lines, not just stdout from a spawned
  // acServer child (which is empty whenever acServer was adopted via pidof).
  _logEmitDepth++;
  try {
    if (typeof appendLog === 'function') {
      const body = args.map(a => typeof a === 'string' ? a : (a && a.stack) || String(a)).join(' ');
      appendLog(`${prefix} ${body}`);
    }
  } catch {} finally { _logEmitDepth--; }
}
const log = {
  info:  (...args) => _logEmit('INFO',  args),
  warn:  (...args) => _logEmit('WARN',  args),
  error: (...args) => _logEmit('ERROR', args),
};
function newRequestId() {
  // 8 hex chars is plenty for in-process correlation — collisions are not security-relevant
  return require('crypto').randomBytes(4).toString('hex');
}

// ── Config ────────────────────────────────────────────────────────────────────
// The four AC_* env vars below are the only ones a fresh install must supply.
// Everything else (results dir, log file, blacklist/whitelist paths) is
// derived so an operator can ship a 4-line .env and have it work.
//
// Auto-detect when an env var is missing: walk a small list of conventional
// paths and pick the first one that exists. Order matches what the README
// recommends — user-home install first, then the system-wide /srv layout.
function _firstExistingPath(candidates) {
  for (const p of candidates) {
    if (!p) continue;
    try { fs.accessSync(p); return p; } catch {}
  }
  return null;
}
const _DEFAULT_AC_ROOTS = [
  process.env.HOME && path.join(process.env.HOME, 'ac_server'),
  '/srv/assetto',
  '/opt/ac_server',
  '/srv/acserver',
].filter(Boolean);
const _detectedAcRoot = _firstExistingPath(_DEFAULT_AC_ROOTS);
// When neither the env var nor any auto-detect candidate exists, the panel
// still needs *some* string for the AC_* constants so error messages mention
// a real-looking path. Default to ~/ac_server (the documented convention) so
// the user sees a path they recognise from .env.example, not a system path
// they never chose.
const _FALLBACK_AC_ROOT = process.env.HOME ? path.join(process.env.HOME, 'ac_server') : '/opt/ac_server';
function _ac(envName, ...relParts) {
  if (process.env[envName]) return process.env[envName];
  if (!_detectedAcRoot) return null;
  return path.join(_detectedAcRoot, ...relParts);
}

const HOST         = process.env.HOST              || '127.0.0.1';
const PORT         = parseInt(process.env.PORT     || '3000', 10);
const AC_HTTP_PORT = parseInt(process.env.AC_HTTP_PORT || '8081', 10);

// AC_SERVER_DIR is the anchor: if the env var is missing, prefer an explicit
// AC_SERVER_BIN's parent, then the auto-detected root. The other AC_* paths
// fall back to subdirs of this anchor.
const AC_BIN_RAW   = process.env.AC_SERVER_BIN || _ac('AC_SERVER_BIN', 'acServer');
const AC_BIN_DIR_RAW = process.env.AC_SERVER_DIR
  || (AC_BIN_RAW ? path.dirname(AC_BIN_RAW) : null)
  || _detectedAcRoot
  || _FALLBACK_AC_ROOT;
const AC_BIN          = AC_BIN_RAW || path.join(AC_BIN_DIR_RAW, 'acServer');
const AC_BIN_DIR      = AC_BIN_DIR_RAW;

const AC_LOG_FILE  = process.env.AC_SERVER_LOG     || path.join(__dirname, 'logs', 'ac_server.log');
const AC_RESULTS   = process.env.AC_SERVER_RESULTS || path.join(AC_BIN_DIR, 'results');
const _AC_CFG_DIR_RESOLVED = process.env.AC_CFG_DIR
  || path.join(_detectedAcRoot || _FALLBACK_AC_ROOT, 'cfg');
const AC_CFG_FILE  = path.join(_AC_CFG_DIR_RESOLVED, 'server_cfg.ini');
const _AC_CONTENT_DIR_RESOLVED = process.env.AC_CONTENT_DIR
  || path.join(_detectedAcRoot || _FALLBACK_AC_ROOT, 'content');
const AC_CARS_DIR  = path.join(_AC_CONTENT_DIR_RESOLVED, 'cars');
const AC_TRACKS_DIR= path.join(_AC_CONTENT_DIR_RESOLVED, 'tracks');
const DB_PATH      = process.env.DB_PATH || path.join(__dirname, 'assetto.db');
const AC_BLACKLIST = path.resolve(process.env.AC_BLACKLIST_FILE || path.join(AC_BIN_DIR, 'blacklist.txt'));
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || '';
const ROOT            = __dirname;
const KUNOS_ASSETS_DIR = path.join(__dirname, 'src/assets/kunos');

// Boot-time path summary. Logged once on startup so operators can verify the
// auto-detection picked sane defaults without grepping the source. Failures
// here are non-fatal — the panel boots and shows a setup banner inside the UI.
function _logBootConfig() {
  const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
  const status = (label, p) => `    ${label.padEnd(20)} ${p || '(unset)'} ${p ? (exists(p) ? '✓' : '✗ MISSING') : ''}`;
  console.log('  AC paths:');
  console.log(status('AC_CFG_DIR',     _AC_CFG_DIR_RESOLVED));
  console.log(status('AC_CONTENT_DIR', _AC_CONTENT_DIR_RESOLVED));
  console.log(status('AC_SERVER_BIN',  AC_BIN));
  console.log(status('AC_SERVER_DIR',  AC_BIN_DIR));
  if (!process.env.AC_CFG_DIR && !process.env.AC_CONTENT_DIR && _detectedAcRoot) {
    console.log(`    (auto-detected root: ${_detectedAcRoot})`);
  }
  if (!exists(AC_CFG_FILE)) {
    console.warn(`  ⚠️  server_cfg.ini not found at ${AC_CFG_FILE}. The Config / Session pages will`);
    console.warn(`     show an error until you point AC_CFG_DIR at the directory that holds it.`);
  }
}

let acChild = null; // tracked child process for the AC server

// ── Log buffer + SSE ──────────────────────────────────────────────────────────
const LOG_MAX = 500;
let logBuffer = [];
let logSeq    = 0;
const sseClients = new Set();

function appendLog(raw) {
  if (!raw || !raw.trim()) return;
  const entry = parseLine(raw.trim(), logSeq++);
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  const data = JSON.stringify(entry);
  // Iterate a snapshot so deleting on write-failure doesn't skip the next client
  for (const res of [...sseClients]) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
}

function loadLogFileIntoBuffer() {
  try {
    fs.mkdirSync(path.dirname(AC_LOG_FILE), { recursive: true });
    const content = fs.readFileSync(AC_LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean).slice(-LOG_MAX);
    logBuffer = lines.map((l, i) => parseLine(l, i));
    logSeq = logBuffer.length;
  } catch {}
}

// Tail AC_LOG_FILE for new lines and push them to appendLog. acServer now
// writes its stdout/stderr directly to the file via a passed-in FD (so it
// survives a panel restart without dying of SIGPIPE on broken pipes); the
// panel reads them back via inotify + delta-read. Polling fallback covers
// edge cases where fs.watch misses events (e.g. log file truncated by the
// "Clear logs" admin action, or replaced under us by a rotator).
let _logTailPos     = 0;
let _logTailWatcher = null;
let _logTailBuffer  = '';
function startLogTail() {
  if (_logTailWatcher) return;
  try { _logTailPos = fs.statSync(AC_LOG_FILE).size; } catch { _logTailPos = 0; }

  const LINE_BUF_MAX = 8 * 1024;
  const flush = () => {
    let size;
    try { size = fs.statSync(AC_LOG_FILE).size; } catch { return; }
    if (size < _logTailPos) _logTailPos = 0;       // truncated or rotated
    if (size === _logTailPos) return;
    const len = size - _logTailPos;
    let fd;
    try { fd = fs.openSync(AC_LOG_FILE, 'r'); } catch { return; }
    const buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, _logTailPos); }
    finally { try { fs.closeSync(fd); } catch {} }
    _logTailPos = size;
    _logTailBuffer += buf.toString('utf8');
    const parts = _logTailBuffer.split('\n');
    _logTailBuffer = parts.pop();
    for (const line of parts) appendLog(line);
    if (_logTailBuffer.length > LINE_BUF_MAX) {
      appendLog(_logTailBuffer.slice(0, LINE_BUF_MAX) + ' …(truncated)');
      _logTailBuffer = '';
    }
  };

  try { _logTailWatcher = fs.watch(AC_LOG_FILE, { persistent: false }, flush); }
  catch (e) { log.warn('[LOG] fs.watch failed, falling back to poll-only:', e.message); }
  // Safety-net poll @ 2s for environments where fs.watch under-reports
  // (some networked filesystems, log rotators that replace the inode, etc.).
  setInterval(flush, 2000).unref();
}

// Called when the admin truncates AC_LOG_FILE via /api/logs/clear so the
// tail watcher doesn't mistake the new (smaller) file for a missed write.
function resetLogTailPosition() { _logTailPos = 0; _logTailBuffer = ''; }

// Authoritative Kunos content ID sets, populated at startup from bundled assets
const KUNOS_CAR_IDS   = new Set();
const KUNOS_TRACK_IDS = new Set();
async function loadKunosIds() {
  try { for (const id of await fsp.readdir(path.join(KUNOS_ASSETS_DIR, 'cars')))   KUNOS_CAR_IDS.add(id);   } catch {}
  try { for (const id of await fsp.readdir(path.join(KUNOS_ASSETS_DIR, 'tracks'))) KUNOS_TRACK_IDS.add(id); } catch {}
}

// ── Session store (SQLite-backed, survives server restarts) ───────────────────
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const _sessionsMemory = new Map(); // fallback when DB not ready

function createSession(username, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL;
  if (db) {
    try {
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      db.prepare('INSERT OR REPLACE INTO sessions (token, username, role, expires_at) VALUES (?, ?, ?, ?)').run(token, username, role, expiresAt);
    } catch { _sessionsMemory.set(token, { username, role, expiresAt }); }
  } else {
    _sessionsMemory.set(token, { username, role, expiresAt });
  }
  return token;
}

// Parse a cookie name out of the request header by exact name match (split on `=`),
// not by `startsWith('name=')` — that would also match `name_alt=…`, `name-other=…`,
// or any future cookie whose name happens to share a prefix.
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function getSession(req) {
  const token = readCookie(req, 'sid');
  if (!token) return null;
  if (db) {
    try {
      return db.prepare('SELECT username, role FROM sessions WHERE token = ? AND expires_at > ?').get(token, Date.now()) || null;
    } catch {}
  }
  const s = _sessionsMemory.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { _sessionsMemory.delete(token); return null; }
  return s;
}

function deleteSession(token) {
  if (db) { try { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); } catch {} }
  _sessionsMemory.delete(token);
}

// True when the request arrived over TLS, either directly or via a trusted proxy
// that set X-Forwarded-Proto. Browsers refuse Secure cookies on plain HTTP, so
// we only attach the flag when the connection is actually encrypted — otherwise
// dev/local installations would silently lose the cookie.
function requestIsHttps(req) {
  if (req?.connection?.encrypted) return true;
  const proto = (req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function sessionCookieHeader(token, isHttps) {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`
    + (isHttps ? '; Secure' : '');
}

function checkAdminAuth(req) {
  const sess = getSession(req);
  if (sess?.role === 'admin' && !userMustChangePassword(sess.username)) return true;
  if (!ADMIN_TOKEN) return false;
  const h = req.headers['x-admin-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
  // Constant-time compare so the header is not a timing oracle for ADMIN_TOKEN.
  // Length must match for timingSafeEqual; mismatched length is a non-secret
  // upper bound on the token, so the early return is fine.
  if (!h || h.length !== ADMIN_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(ADMIN_TOKEN));
  } catch { return false; }
}

function checkAnyAuth(req) {
  return getSession(req);
}

function userMustChangePassword(username) {
  if (!db || !username) return false;
  try {
    const row = db.prepare('SELECT must_change_password FROM panel_users WHERE username = ?').get(username);
    return row?.must_change_password === 1;
  } catch { return false; }
}

// Canonical list of granular permissions exposed via the Usuarios card. Any
// permission referenced in route guards must appear here so the UI surfaces
// it and the defaults block above seeds a value for it.
const ROLE_PERMISSIONS = [
  'serverControl', 'sessionEdit', 'serverConfig', 'presetManage', 'whitelistManage',
  'playerModeration', 'modUpload', 'discordWebhook', 'auditView', 'dbBackup',
];

function getUserRolePermissions() {
  const fallback = Object.fromEntries(ROLE_PERMISSIONS.map(p => [p, false]));
  if (!db) return fallback;
  try {
    const row = db.prepare(`SELECT value FROM panel_settings WHERE key = 'role_permissions_user'`).get();
    if (!row?.value) return fallback;
    const parsed = JSON.parse(row.value);
    // Re-key against the canonical list so a stale row (older deploy that knew
    // fewer permissions) cannot accidentally grant something we just added.
    const out = {};
    for (const p of ROLE_PERMISSIONS) out[p] = !!parsed[p];
    return out;
  } catch { return fallback; }
}

// Per-request permission check. Admin always passes (subject to the must-
// change-password gate, same as checkAdminAuth). Users consult the stored
// JSON for this role. Callers should follow the pattern:
//   if (!checkPermission(req, 'X')) return json(res, 403, { error: ... });
function checkPermission(req, perm) {
  const sess = getSession(req);
  if (!sess) return false;
  if (userMustChangePassword(sess.username)) return false;
  if (sess.role === 'admin') return true;
  const perms = getUserRolePermissions();
  return !!perms[perm];
}

// ── MIME ──────────────────────────────────────────────────────────────────────
const MIME = {
  '.html':        'text/html; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.js':          'application/javascript; charset=utf-8',
  '.jsx':         'application/javascript; charset=utf-8',
  '.json':        'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg':         'image/svg+xml',
  '.webp':        'image/webp',
  '.png':         'image/png',
  '.jpg':         'image/jpeg',
  '.ico':         'image/x-icon',
  '.woff2':       'font/woff2',
  '.woff':        'font/woff',
};

// ── Database ──────────────────────────────────────────────────────────────────
let db = null;
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_files (
      filename    TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS players (
      guid       TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      nation     TEXT DEFAULT '',
      first_seen TEXT DEFAULT '',
      last_seen  TEXT DEFAULT '',
      total_laps INTEGER DEFAULT 0,
      last_car   TEXT DEFAULT '',
      last_track TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS laps (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_name   TEXT NOT NULL,
      driver_guid   TEXT NOT NULL,
      car           TEXT NOT NULL,
      track         TEXT NOT NULL,
      track_config  TEXT DEFAULT '',
      ms            INTEGER NOT NULL,
      lap_timestamp INTEGER DEFAULT 0,
      s1            INTEGER DEFAULT 0,
      s2            INTEGER DEFAULT 0,
      s3            INTEGER DEFAULT 0,
      cuts          INTEGER DEFAULT 0,
      valid         INTEGER DEFAULT 1,
      session_date  TEXT DEFAULT '',
      source_file   TEXT DEFAULT '',
      UNIQUE(driver_guid, car, track, track_config, lap_timestamp, source_file)
    );

    CREATE INDEX IF NOT EXISTS idx_laps_track  ON laps(track);
    CREATE INDEX IF NOT EXISTS idx_laps_driver ON laps(driver_guid);
    CREATE INDEX IF NOT EXISTS idx_laps_valid  ON laps(valid);

    CREATE TABLE IF NOT EXISTS panel_users (
      username      TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt          TEXT NOT NULL,
      role          TEXT DEFAULT 'user',
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS panel_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      username   TEXT NOT NULL,
      role       TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mod_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ok              INTEGER NOT NULL,
      filename        TEXT,
      mod_type        TEXT,
      mod_id          TEXT,
      destination     TEXT,
      files_extracted INTEGER,
      error           TEXT,
      uploaded_by     TEXT,
      uploaded_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      target     TEXT DEFAULT '',
      detail     TEXT DEFAULT '',
      logged_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logged_at ON audit_log(logged_at);

    CREATE TABLE IF NOT EXISTS login_attempts (
      ip       TEXT PRIMARY KEY,
      count    INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );
  `);
  // ── Schema migrations ─────────────────────────────────────────────────────
  // Numbered, idempotent, recorded in schema_migrations so we know which ones
  // have run on a given DB. Each migration is a {id, sql} pair; run order is
  // ascending by id. Adding a new one means appending to the array — never
  // rewriting an older entry, otherwise existing DBs would skip your change.
  //
  // The migrations table itself uses INSERT OR IGNORE so re-running a freshly
  // initialised DB is a no-op. Failing migrations log loudly and skip the
  // record-insert so the next boot retries; an environment-specific failure
  // (CREATE UNIQUE INDEX against duplicate rows, for instance) doesn't poison
  // the chain — fix the data, restart, the migration runs again.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id      INTEGER PRIMARY KEY,
    name    TEXT    NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const MIGRATIONS = [
    { id: 1, name: 'add_must_change_password',
      sql: `ALTER TABLE panel_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0` },
    { id: 2, name: 'audit_chain_prev_hash',
      sql: `ALTER TABLE audit_log ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''` },
    { id: 3, name: 'audit_chain_row_hash',
      sql: `ALTER TABLE audit_log ADD COLUMN row_hash TEXT NOT NULL DEFAULT ''` },
    { id: 4, name: 'audit_chain_version',
      sql: `ALTER TABLE audit_log ADD COLUMN chain_version INTEGER NOT NULL DEFAULT 0` },
    { id: 5, name: 'players_nickname',
      sql: `ALTER TABLE players ADD COLUMN nickname TEXT NOT NULL DEFAULT ''` },
    { id: 6, name: 'laps_dedup_runtime_index',
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS laps_dedup_runtime
              ON laps(driver_guid, ms, car, track, track_config)` },
    { id: 7, name: 'audit_compound_indices',
      sql: `CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor);
            CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);` },
    { id: 8, name: 'panel_users_totp_secret',
      sql: `ALTER TABLE panel_users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT ''` },
    { id: 9, name: 'panel_users_totp_enabled',
      sql: `ALTER TABLE panel_users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0` },
    { id: 10, name: 'panel_users_totp_pending',
      sql: `ALTER TABLE panel_users ADD COLUMN totp_pending TEXT NOT NULL DEFAULT ''` },
    { id: 11, name: 'bans_table',
      sql: `CREATE TABLE IF NOT EXISTS bans (
              guid          TEXT PRIMARY KEY,
              name_snapshot TEXT NOT NULL DEFAULT '',
              reason        TEXT NOT NULL DEFAULT '',
              banned_by     TEXT NOT NULL DEFAULT '',
              banned_at     TEXT NOT NULL DEFAULT (datetime('now')),
              expires_at    TEXT DEFAULT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_bans_expires_at ON bans(expires_at);` },
    { id: 12, name: 'session_presets_table',
      // Saved bundles of (trackId, layout, slots[], session toggles, weather, time,
      // penalties…) that an operator can browse and "Load into Session" with one
      // click. The `config` column is a JSON blob keeping the exact same shape
      // `sessionCfg` has on the client + the same shape /api/session/apply
      // consumes — so adding a field to Session in the future doesn't need a
      // schema change here, just a default-fill on load. `name` is UNIQUE
      // (case-insensitive) so re-saving a preset with the same name reads as an
      // overwrite, not a silent duplicate.
      sql: `CREATE TABLE IF NOT EXISTS session_presets (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              name        TEXT    NOT NULL,
              description TEXT    NOT NULL DEFAULT '',
              config      TEXT    NOT NULL,
              created_by  TEXT    NOT NULL DEFAULT '',
              created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
              updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_session_presets_name_nocase ON session_presets(name COLLATE NOCASE);` },
    { id: 13, name: 'laps_combo_ms_index',
      // Covering index for per-(track, layout, car) record lookups. Serves the
      // WHERE track/track_config/car/valid + MIN(ms) in maybeNotifyRecord (runs on
      // every inserted lap) and the `WHERE valid=1 GROUP BY track, track_config,
      // car` MIN(ms) subquery + correlated (track, track_config, car, ms) lookups
      // behind public player records. Only idx_laps_track(track) existed, so those
      // fell back to a scan + temp b-tree; this turns them into a covering range.
      sql: `CREATE INDEX IF NOT EXISTS idx_laps_combo_ms
              ON laps(track, track_config, car, valid, ms)` },
    { id: 14, name: 'panel_users_role_index',
      sql: `CREATE INDEX IF NOT EXISTS idx_panel_users_role ON panel_users(role)` },
  ];
  const _appliedRows = db.prepare('SELECT id FROM schema_migrations').all();
  const _applied = new Set(_appliedRows.map(r => r.id));
  const _recordMigration = db.prepare('INSERT OR IGNORE INTO schema_migrations (id, name) VALUES (?, ?)');
  for (const m of MIGRATIONS) {
    if (_applied.has(m.id)) continue;
    try {
      db.exec(m.sql);
      _recordMigration.run(m.id, m.name);
      console.log(`  migration ${String(m.id).padStart(3, '0')}: ${m.name} ✓`);
    } catch (e) {
      // ALTER TABLE on an existing column throws "duplicate column" — that's
      // exactly the upgrade-in-place case where the column was added by the
      // pre-migrations-runner ALTER+catch code. Record the migration as
      // applied so we don't retry next boot, but log it for visibility.
      const msg = String(e && e.message || e);
      if (/duplicate column|already exists/i.test(msg)) {
        _recordMigration.run(m.id, m.name);
        console.log(`  migration ${String(m.id).padStart(3, '0')}: ${m.name} (already present, recorded)`);
      } else {
        console.error(`  migration ${String(m.id).padStart(3, '0')} ${m.name} FAILED:`, msg);
      }
    }
  }

  // Refresh SQLite's query-planner stats after migrations (cheap; pairs with the
  // periodic optimize in sweepDbMaintenance).
  try { db.pragma('optimize'); } catch {}

  // Seed default settings
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('upload_max_mb', '500')`).run();
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('lang', 'en')`).run();
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('chunked_upload', '0')`).run();
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('discord_webhook', '')`).run();
  // Public per-player profile pages reachable at /p/<guid> with a matching
  // JSON view at /api/public/players/<guid>. On by default so the feature is
  // discoverable; admins can flip it off if the server isn't meant to be
  // visible at all (e.g. development boxes behind Cloudflare Access).
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('public_profiles_enabled', '1')`).run();
  // Default permission set for the `user` role. Mirrors the live state right
  // before this granular-permissions feature shipped (server control, session
  // edit and mod upload were already open to users), so an upgrade in place
  // doesn't yank capabilities away from existing accounts.
  const DEFAULT_USER_PERMS = {
    serverControl:    true,
    sessionEdit:      true,
    modUpload:        true,
    presetManage:     true,
    serverConfig:     false,
    whitelistManage:  false,
    playerModeration: false,
    discordWebhook:   false,
    auditView:        false,
    dbBackup:         false,
  };
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('role_permissions_user', ?)`)
    .run(JSON.stringify(DEFAULT_USER_PERMS));
  // Backfill: for installs predating a release that introduced a new
  // permission key, the stored row won't have an entry for it and
  // getUserRolePermissions() will report it as false. Re-insert any missing
  // key with its intended default so "granted by default" actually applies
  // to existing user accounts, not just fresh installs. Only ADDS missing
  // keys — never overwrites a value the admin has already set.
  try {
    const row = db.prepare(`SELECT value FROM panel_settings WHERE key = 'role_permissions_user'`).get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      let changed = false;
      for (const [k, v] of Object.entries(DEFAULT_USER_PERMS)) {
        if (!(k in parsed)) { parsed[k] = v; changed = true; }
      }
      if (changed) {
        db.prepare(`UPDATE panel_settings SET value = ? WHERE key = 'role_permissions_user'`)
          .run(JSON.stringify(parsed));
      }
    }
  } catch {}
  console.log('  Database ready:', DB_PATH);
} catch (e) {
  console.error('  Database init failed:', e.message);
}

// ── Auth helpers ─────────────────────────────────────────────────────────────
// Stored hash format: "scrypt$<hex>" (current) or bare hex (legacy pbkdf2).
// Legacy hashes are upgraded in-place on the next successful login.
//
// Both hash and verify must use IDENTICAL scrypt parameters; relying on Node's
// defaults to "happen to match" is brittle (if a future Node release bumps the
// defaults, every existing password silently fails to verify). Pin the cost
// explicitly in one constant and pass it to both code paths.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 64;
function hashPasswordScrypt(password, salt) {
  return 'scrypt$' + crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS).toString('hex');
}
function hashPasswordPbkdf2(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}
function hashPassword(password, salt) {
  return hashPasswordScrypt(password, salt);
}

// Pre-computed dummy hash used by apiAuthLogin when the username is unknown.
// Without this the login path returns ~immediately for non-existent users but
// spends ~50ms in scryptSync for real users — a measurable timing oracle that
// lets an attacker enumerate valid usernames. By running verifyPassword against
// this dummy in the not-found branch, both paths perform exactly one scrypt.
// Computed once at module load with a fixed salt — never used to authenticate.
const _DUMMY_LOGIN_SALT = 'a'.repeat(64);
const _DUMMY_LOGIN_HASH = hashPasswordScrypt('not-a-real-password-do-not-use', _DUMMY_LOGIN_SALT);

function verifyPassword(password, salt, stored) {
  if (typeof stored !== 'string' || !stored) return false;
  try {
    if (stored.startsWith('scrypt$')) {
      const expected = stored.slice(7);
      const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS).toString('hex');
      return safeHexEqual(candidate, expected);
    }
    // Legacy pbkdf2 (bare hex)
    const candidate = hashPasswordPbkdf2(password, salt);
    return safeHexEqual(candidate, stored);
  } catch { return false; }
}
// Server-side password policy. Returns null when accepted, otherwise a human
// readable error message. Mirror this in the UI for nicer feedback, but the
// check here is the authoritative gate.
function passwordPolicyError(pw) {
  if (typeof pw !== 'string') return 'Password must be a string';
  if (pw.length < 12) {
    // Allow ≥8 chars only when the password mixes at least three character classes
    if (pw.length < 8) return 'Password must be at least 8 characters';
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(rx => rx.test(pw)).length;
    if (classes < 3) return 'Short passwords (8–11 chars) need a mix of lowercase, UPPERCASE, digits and a symbol';
  }
  if (pw.length > 128) return 'Password must be at most 128 characters';
  // Reject the most obvious sentinels
  const banned = new Set(['password', 'qwerty12', 'admin1234', 'admin1234!', '12345678', 'changeme', 'letmein!']);
  if (banned.has(pw.toLowerCase())) return 'This password is too common — choose something different';
  return null;
}

function safeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch { return false; }
}

// ── TOTP (RFC 6238) ──────────────────────────────────────────────────────────
// Time-based one-time password generator + verifier, implemented inline so we
// don't pull in another npm dep. Standard parameters (SHA-1, 30-second step,
// 6 digits) — every off-the-shelf authenticator app (Aegis, Authy, Bitwarden,
// 2FAS, Google Authenticator, etc.) reads them out of the otpauth:// URI.
//
// The secret is stored as base32 in panel_users.totp_secret. Setup writes the
// candidate into totp_pending; only after the user confirms by entering a
// valid code from their app does it move into totp_secret + totp_enabled=1.
// This prevents a half-setup state where 2FA is "on" but the user never
// scanned the QR.
const _BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function _base32Encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += _BASE32_ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return out;
}
function _base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of clean) bits += _BASE32_ALPHABET.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function _totpCode(secretBuf, time = Math.floor(Date.now() / 1000), step = 30, digits = 6) {
  const counter = Math.floor(time / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[off]     & 0x7f) << 24) |
              ((hmac[off + 1] & 0xff) << 16) |
              ((hmac[off + 2] & 0xff) <<  8) |
              ( hmac[off + 3] & 0xff);
  return String(bin % (10 ** digits)).padStart(digits, '0');
}
// Constant-time string compare so the verifier doesn't leak which digit
// failed via timing. Both sides must be the same length already.
function _ctEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}
function totpVerify(secretB32, code, drift = 1) {
  if (!secretB32 || !code || !/^\d{6}$/.test(String(code))) return false;
  const key = _base32Decode(secretB32);
  if (!key.length) return false;
  const now = Math.floor(Date.now() / 1000);
  for (let i = -drift; i <= drift; i++) {
    if (_ctEqual(_totpCode(key, now + i * 30), String(code))) return true;
  }
  return false;
}
function totpProvisioningUri({ secret, account, issuer }) {
  // otpauth://totp/<issuer>:<account>?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params}`;
}

function seedDefaultUsers() {
  if (!db) return;
  try {
    const DEFAULT_PASS = 'Admin1234!';
    for (const [username, role] of [['Admin', 'admin']]) {
      const existing = db.prepare('SELECT 1 FROM panel_users WHERE username = ?').get(username);
      if (!existing) {
        const salt = crypto.randomBytes(32).toString('hex');
        db.prepare('INSERT INTO panel_users (username, password_hash, salt, role, must_change_password) VALUES (?, ?, ?, ?, 1)')
          .run(username, hashPassword(DEFAULT_PASS, salt), salt, role);
      }
    }
  } catch (e) {
    console.error('  User seed failed:', e.message);
  }
}

// ── Results importer ──────────────────────────────────────────────────────────
function parseDateFromFilename(name) {
  const m = name.match(/^(\d{4})_(\d{1,2})_(\d{1,2})/);
  return m ? `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}` : '';
}

async function importResultFile(filename) {
  if (!db) return false;
  const filepath = path.join(AC_RESULTS, filename);
  try {
    const raw  = await fsp.readFile(filepath, 'utf8');
    const data = JSON.parse(raw);
    const date = parseDateFromFilename(filename);
    const track       = data.TrackName   || '';
    const trackConfig = data.TrackConfig || '';

    // Build player metadata from Cars array (has nation info)
    const playerMeta = {};
    for (const c of (data.Cars || [])) {
      if (c.Driver?.Guid && c.Driver.Name) {
        playerMeta[c.Driver.Guid] = {
          name:   c.Driver.Name,
          nation: c.Driver.Nation || '',
          car:    c.Model || '',
        };
      }
    }

    const stmtLap = db.prepare(`
      INSERT OR IGNORE INTO laps
        (driver_name, driver_guid, car, track, track_config, ms, lap_timestamp, s1, s2, s3, cuts, valid, session_date, source_file)
      VALUES
        (@driver_name, @driver_guid, @car, @track, @track_config, @ms, @lap_timestamp, @s1, @s2, @s3, @cuts, @valid, @session_date, @source_file)
    `);

    // When the UDP plugin already recorded a lap live, the row exists with
    // a placeholder s1 = lap_time and s2=s3=0. The JSON has authoritative
    // sector data (or the same lap_time-in-s1 layout if the track doesn't
    // emit per-sector splits), so we replace the row's sectors + canonical
    // lap_timestamp + source_file. Guard by `source_file='udp:live'` so we
    // only touch rows the UDP listener was the sole writer of — never
    // clobber a previous JSON import.
    const stmtFillSectors = db.prepare(`
      UPDATE laps
         SET s1 = @s1, s2 = @s2, s3 = @s3,
             lap_timestamp = @lap_timestamp,
             source_file = @source_file
       WHERE driver_guid = @driver_guid
         AND ms = @ms
         AND car = @car
         AND track = @track
         AND track_config = @track_config
         AND source_file = 'udp:live'
    `);

    const stmtPlayer = db.prepare(`
      INSERT INTO players (guid, name, nation, first_seen, last_seen, total_laps, last_car, last_track)
        VALUES (@guid, @name, @nation, @date, @date, @cnt, @car, @track)
      ON CONFLICT(guid) DO UPDATE SET
        name       = excluded.name,
        nation     = CASE WHEN excluded.nation != '' THEN excluded.nation ELSE players.nation END,
        last_seen  = MAX(players.last_seen, excluded.last_seen),
        first_seen = CASE WHEN players.first_seen = '' OR (excluded.first_seen != '' AND excluded.first_seen < players.first_seen)
                          THEN excluded.first_seen ELSE players.first_seen END,
        total_laps = players.total_laps + excluded.total_laps,
        last_car   = excluded.last_car,
        last_track = excluded.last_track
    `);

    const doImport = db.transaction(() => {
      const lapsByPlayer = {};

      for (const l of (data.Laps || [])) {
        if (!l.DriverGuid || !l.DriverName) continue;
        if (!l.LapTime || l.LapTime >= 999_000_000) continue;

        const sectors = l.Sectors || [];
        const s1 = (sectors[0] > 0 && sectors[0] < 2_000_000) ? sectors[0] : 0;
        const s2 = (sectors[1] > 0 && sectors[1] < 2_000_000) ? sectors[1] : 0;
        const s3 = (sectors[2] > 0 && sectors[2] < 2_000_000) ? sectors[2] : 0;

        const payload = {
          driver_name:   l.DriverName,
          driver_guid:   l.DriverGuid,
          car:           l.CarModel || '',
          track,
          track_config:  trackConfig,
          ms:            l.LapTime,
          lap_timestamp: l.Timestamp || 0,
          s1, s2, s3,
          cuts:          l.Cuts || 0,
          valid:         (l.Cuts || 0) === 0 ? 1 : 0,
          session_date:  date,
          source_file:   filename,
        };
        const r = stmtLap.run(payload);

        if (r.changes > 0) {
          if (!lapsByPlayer[l.DriverGuid]) lapsByPlayer[l.DriverGuid] = { cnt: 0, name: l.DriverName, car: l.CarModel || '' };
          lapsByPlayer[l.DriverGuid].cnt++;
        } else {
          // Row already exists (UDP plugin captured it live). Fill in sectors
          // and the canonical lap_timestamp + source_file from the JSON if
          // the existing row only had the live snapshot.
          stmtFillSectors.run(payload);
        }
      }

      for (const [guid, info] of Object.entries(lapsByPlayer)) {
        const meta = playerMeta[guid] || {};
        stmtPlayer.run({
          guid,
          name:   meta.name   || info.name,
          nation: meta.nation || '',
          date:   date || '',
          cnt:    info.cnt,
          car:    info.car,
          track,
        });
      }

      // Ensure players who connected but had no valid laps still appear
      for (const [guid, meta] of Object.entries(playerMeta)) {
        db.prepare(`
          INSERT OR IGNORE INTO players (guid, name, nation, first_seen, last_seen, total_laps, last_car, last_track)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        `).run(guid, meta.name, meta.nation, date || '', date || '', meta.car, track);
      }
    });

    doImport();
    db.prepare(`INSERT OR REPLACE INTO processed_files (filename, processed_at) VALUES (?, datetime('now'))`).run(filename);
    return true;
  } catch (e) {
    console.error(`  Import failed [${filename}]:`, e.message);
    return false;
  }
}

async function importAllResults() {
  if (!db) return;
  try {
    const files = (await fsp.readdir(AC_RESULTS)).filter(f => f.endsWith('.json')).sort();
    let imported = 0;
    for (const file of files) {
      const already = db.prepare('SELECT 1 FROM processed_files WHERE filename = ?').get(file);
      if (!already && await importResultFile(file)) imported++;
    }
    if (imported > 0) console.log(`  Imported ${imported} result file(s) into database`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('  Cannot scan results dir:', e.message);
  }
}

const _pendingImports = new Set();
// Defensive shape check on watcher-supplied filenames. Linux's fs.watch
// normally hands us a leaf basename, but exotic filesystems (FUSE, NFS,
// SMB mounts) can return arbitrary strings — including ones containing
// `..` or path separators. importResultFile does path.join(AC_RESULTS,
// filename), and a `..` would escape the directory. This check refuses
// anything that isn't a plain basename ending in `.json`.
function _isSafeResultFilename(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name.length > 128) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name === '.' || name === '..' || name.includes('..')) return false;
  return /^[A-Za-z0-9_\-.]+\.json$/.test(name);
}
function startResultsWatcher() {
  if (!db) return;
  try {
    fs.watch(AC_RESULTS, (eventType, filename) => {
      if (!_isSafeResultFilename(filename)) return;
      if (_pendingImports.has(filename)) return;
      _pendingImports.add(filename);
      setTimeout(async () => {
        _pendingImports.delete(filename);
        const already = db.prepare('SELECT 1 FROM processed_files WHERE filename = ?').get(filename);
        if (!already) await importResultFile(filename);
      }, 2500);
    });
  } catch (e) {
    console.error('  Cannot watch results dir:', e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getNetworkIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function setSecurityHeaders(req, res) {
  // Stash the request on the response so downstream helpers (respond, json)
  // can negotiate Content-Encoding without every call site threading req
  // through manually. Set once per request inside the handler.
  res._acReq = req;
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // The panel is an admin tool, not a public website — keep it out of search
  // engines so the login URL never surfaces in Google/Bing results when an
  // operator forgets to gate the panel behind a private network. The meta tag
  // in index.html covers HTML navigation; this header is what crawlers see on
  // every other response (assets, JSON, JS bundles) and on the index.html
  // fetch itself when only the headers are read.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  // Lock down browser features the panel never uses
  res.setHeader('Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()');
  // Content Security Policy. JSX is now pre-transpiled by build.js (esbuild) and
  // served from /dist/ as plain JS, so 'unsafe-eval' / 'unsafe-inline' are no
  // longer required. 'unsafe-inline' for style stays — many components use inline
  // style props which compile to inline `style="..."` attributes.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '));
  // HSTS only when the connection actually arrived over HTTPS (or via a TLS-terminating proxy).
  if (requestIsHttps(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

// Content types worth compressing. Already-compressed formats (webp, png,
// jpeg, woff2, …) come from MIME elsewhere and skip this path; for JSON, HTML,
// CSS, JS the saving over the wire is typically 4–8x and the CPU cost of
// gzip/brotli at default levels is negligible compared to the bytes saved.
const _COMPRESSIBLE_MIME = /^(?:application\/(?:json|javascript|manifest\+json)|text\/(?:plain|html|css|csv|event-stream))(?:\b|;)/i;
const _COMPRESS_MIN_BYTES = 1024; // skip compression for tiny payloads where the headers cost more than they save

function _negotiateEncoding(req, mime, bodyLen) {
  if (!_COMPRESSIBLE_MIME.test(mime)) return null;
  if (bodyLen < _COMPRESS_MIN_BYTES) return null;
  const ae = (req?.headers?.['accept-encoding'] || '').toLowerCase();
  if (!ae) return null;
  // Prefer brotli (smaller) when offered, otherwise gzip. Identity ('') is
  // always acceptable as a fallback.
  if (ae.includes('br')) return 'br';
  if (ae.includes('gzip')) return 'gzip';
  return null;
}

function _compress(body, encoding) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (encoding === 'br') return zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
  if (encoding === 'gzip') return zlib.gzipSync(buf, { level: 6 });
  return buf;
}

// `req` for Accept-Encoding negotiation is pulled from res._acReq (stashed by
// setSecurityHeaders) so existing call sites don't have to thread it through.
// Older callers (or paths that bypass setSecurityHeaders) still work — they
// just don't benefit from compression.
function respond(res, status, mime, body, extraHeaders) {
  const headers = {
    'Content-Type':  mime,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Vary':          'Accept-Encoding',
    ...extraHeaders,
  };
  let payload = body;
  const req = res._acReq;
  if (req && body && !headers['Content-Encoding']) {
    const bodyLen = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
    const enc = _negotiateEncoding(req, mime, bodyLen);
    if (enc) {
      payload = _compress(body, enc);
      headers['Content-Encoding'] = enc;
    }
  }
  res.writeHead(status, headers);
  res.end(payload);
}

function respondImage(res, data, mime = 'image/png') {
  res.writeHead(200, {
    'Content-Type':  mime,
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(data);
}

function serveAssetFallback(res, candidates) {
  const tryNext = (index) => {
    if (index >= candidates.length) return json(res, 404, { error: 'Asset not found' });
    const { path: p, mime } = candidates[index];
    fs.readFile(p, (err, data) => {
      if (err) tryNext(index + 1);
      else respondImage(res, data, mime);
    });
  };
  tryNext(0);
}

function json(res, status, data) {
  respond(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

function readBody(req) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) return Promise.reject(new Error('Content-Type must be application/json'));
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    const settle = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    // Hard timeout: a slow-loris client could otherwise stream a few bytes
    // every minute and tie up a file descriptor + this promise forever. 30s
    // is far longer than any real JSON body needs (the largest legitimate
    // payload is ~10 MB chunked upload, which streams in seconds).
    const timer = setTimeout(() => {
      try { req.destroy(); } catch {}
      settle(reject, new Error('Request body timeout'));
    }, 30000);
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 512_000) {
        try { req.destroy(); } catch {}
        settle(reject, new Error('Body too large'));
      }
    });
    req.on('end', () => { try { settle(resolve, JSON.parse(raw)); } catch { settle(reject, new Error('Invalid JSON')); } });
    req.on('error', e => settle(reject, e));
  });
}

function formatName(id) {
  return id
    .replace(/^(ks_|rfc_|av_|b16v_|rss_|css_|gr[a-z2]_|Gr[A-Z2]_|GrA_)/g, '')
    .replace(/_/g, ' ')
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
    .trim();
}

// AC ui_*.json files often contain raw newlines/tabs inside string values (invalid JSON).
// Replacing all control chars with spaces makes it valid everywhere (tokens + string values).
function parseLooseJson(raw, ctx) {
  try {
    return JSON.parse(raw.replace(/[\x00-\x1f]/g, ' '));
  } catch (e) {
    // Surface broken metadata so unrecognised mods can be debugged. The caller
    // wraps this in try/catch and falls back, so logging here is informational.
    if (ctx) console.warn(`  parseLooseJson failed for ${ctx}: ${e.message}`);
    throw e;
  }
}

function parseTrackLength(raw) {
  const n = parseFloat(String(raw || '0').replace(/[^0-9.]/g, ''));
  if (!n) return 0;
  return parseFloat((n < 50 ? n : n / 1000).toFixed(3));
}

function formatTotalTime(ms) {
  if (!ms || ms <= 0) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// Strict allowlist for AC content ids (car/track folder names): alphanumeric,
// underscore, hyphen, dot. The regex implicitly rejects `/`, `\`, `\0`, `%`
// and every other separator a path-traversal payload would need, but we
// also explicitly bar `..` (which the regex DOES match because `.` is in
// the set) and cap length so a hostile caller can't force unbounded work
// in callers that interpolate the id into a path or a log line.
function isValidContentId(id) {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 256) return false;
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(id)) return false;
  if (id === '.' || id === '..' || id.includes('..')) return false;
  return true;
}

// Synchronous display-name resolvers used by the Discord notifier on the
// (rare) record-lap path. Mirrors the priority order of apiCars/apiTracks
// (AC content first, kunos assets fallback) but avoids building the full
// catalogue — we only need a single name. Silent failures fall back to
// formatName(id) so a missing ui_car.json never crashes the UDP path.
function _readUiJsonSync(file) {
  try { return parseLooseJson(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function carDisplayName(carId) {
  if (!isValidContentId(carId)) return formatName(carId || '');
  const ac = _readUiJsonSync(path.join(AC_CARS_DIR, carId, 'ui', 'ui_car.json'));
  if (ac?.name) return ac.name;
  const kn = _readUiJsonSync(path.join(KUNOS_ASSETS_DIR, 'cars', carId, 'ui', 'ui_car.json'));
  if (kn?.name) return kn.name;
  return formatName(carId);
}
function trackDisplayName(trackId, layoutId) {
  if (!isValidContentId(trackId)) return formatName(trackId || '');
  const layout = layoutId && isValidContentId(layoutId) ? layoutId : '';
  // Multi-layout: read ui/<layout>/ui_track.json (or kunos fallback)
  let layoutName = '';
  let trackName  = '';
  if (layout) {
    const l = _readUiJsonSync(path.join(AC_TRACKS_DIR, trackId, 'ui', layout, 'ui_track.json'))
           || _readUiJsonSync(path.join(KUNOS_ASSETS_DIR, 'tracks', trackId, 'ui', layout, 'ui_track.json'));
    if (l?.name) layoutName = l.name;
  }
  // Single-layout or fallback base name
  const base = _readUiJsonSync(path.join(AC_TRACKS_DIR, trackId, 'ui', 'ui_track.json'))
            || _readUiJsonSync(path.join(KUNOS_ASSETS_DIR, 'tracks', trackId, 'ui', 'ui_track.json'));
  if (base?.name) trackName = base.name;
  if (!trackName && !layoutName) return formatName(trackId);
  if (!layout || !layoutName) return trackName || formatName(trackId);
  // If the layout name already contains the base track name (common in
  // mod tracks that prefix each layout with the track), don't repeat it.
  if (trackName && layoutName.toLowerCase().includes(trackName.toLowerCase())) {
    return layoutName;
  }
  if (!trackName) return layoutName;
  return `${trackName} (${layoutName})`;
}

function formatLapTime(ms) {
  if (!ms || ms < 0) return '0:00.000';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = ms % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(t).padStart(3, '0')}`;
}

// Localized record-message templates. Server-side because the webhook fires
// from the UDP path with nobody necessarily looking at the panel — the panel
// language stored in panel_settings.lang is the source of truth.
const DISCORD_RECORD_TEMPLATES = {
  en: ({ name, time, track, car }) => `**${name}** has set a new record of **${time}** at **${track}** with the **${car}**!`,
  es: ({ name, time, track, car }) => `¡El piloto **${name}** ha hecho un **${time}** en **${track}** con un **${car}**!`,
  it: ({ name, time, track, car }) => `Il pilota **${name}** ha segnato un nuovo record di **${time}** a **${track}** con la **${car}**!`,
};

const DISCORD_TEST_TEMPLATES = {
  en: 'Discord webhook test from the Assetto panel — record notifications are working.',
  es: 'Prueba de webhook de Discord desde el panel Assetto — las notificaciones de récord funcionan.',
  it: 'Prova del webhook Discord dal pannello Assetto — le notifiche di record funzionano.',
};

function getPanelLang() {
  try {
    const row = db?.prepare(`SELECT value FROM panel_settings WHERE key = 'lang'`).get();
    const v = row?.value;
    return DISCORD_RECORD_TEMPLATES[v] ? v : 'en';
  } catch { return 'en'; }
}

function getDiscordWebhook() {
  try {
    const row = db?.prepare(`SELECT value FROM panel_settings WHERE key = 'discord_webhook'`).get();
    return row?.value || '';
  } catch { return ''; }
}

// Discord webhook hosts — the only acceptable destinations for postDiscordMessage
// and apiDiscordWebhookTest. Defense in depth on top of isValidDiscordWebhook's
// regex: the regex validates the string shape, but `new URL(...)` could in
// principle yield a hostname that differs (IDN normalisation, unicode tricks,
// future regex relaxation). Comparing parsed.hostname against this Set is the
// authoritative gate — anything else and we refuse to make the HTTPS request,
// closing the SSRF window for good.
const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'canary.discord.com',
  'ptb.discord.com',
]);

// Fire-and-forget POST to the Discord webhook. Times out after 5s so a Discord
// outage cannot stall the UDP handler. Errors are logged at warn level only —
// missing a notification is never worth crashing the server for.
function postDiscordMessage(content) {
  const url = getDiscordWebhook();
  if (!url) return;
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  if (!DISCORD_WEBHOOK_HOSTS.has(parsed.hostname.toLowerCase())) {
    log.warn(`[discord] refusing webhook with non-Discord hostname: ${parsed.hostname}`);
    return;
  }
  const payload = JSON.stringify({ content });
  const req = https.request({
    method: 'POST',
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent':     'assetto-server-panel',
    },
    timeout: 5000,
  }, (res) => {
    // Drain so the socket can be reused / closed.
    res.on('data', () => {});
    res.on('end', () => {
      if (res.statusCode >= 400) {
        log.warn(`[discord] webhook returned ${res.statusCode}`);
      }
    });
  });
  req.on('timeout', () => { req.destroy(new Error('discord webhook timeout')); });
  req.on('error', (e) => { log.warn('[discord] webhook error:', e.message); });
  req.write(payload);
  req.end();
}

// Detect a per (track, layout, car) record from the just-inserted lap.
// Called after a successful INSERT into `laps` (valid only — cuts==0).
// Fires the Discord notification iff the new lap beats the previous best for
// that combination. First-ever valid lap for a combo is NOT a record.
function maybeNotifyRecord({ guid, name, lapMs, car, track, trackConfig, lapId }) {
  if (!db) return;
  if (!getDiscordWebhook()) return;
  try {
    const prev = db.prepare(`
      SELECT MIN(ms) AS best
      FROM laps
      WHERE track = ? AND track_config = ? AND car = ? AND valid = 1 AND id != ?
    `).get(track, trackConfig || '', car, lapId);
    const prevBest = prev?.best;
    if (prevBest == null || lapMs >= prevBest) return;

    const playerRow = db.prepare(`SELECT name, nickname FROM players WHERE guid = ?`).get(guid);
    const displayName = (playerRow?.nickname && playerRow.nickname.trim()) || playerRow?.name || name || '—';

    const lang = getPanelLang();
    const tpl  = DISCORD_RECORD_TEMPLATES[lang] || DISCORD_RECORD_TEMPLATES.en;
    const content = tpl({
      name:  displayName,
      time:  formatLapTime(lapMs),
      track: trackDisplayName(track, trackConfig),
      car:   carDisplayName(car),
    });
    postDiscordMessage(content);
  } catch (e) {
    log.warn('[discord] record check failed:', e.message);
  }
}

function isValidSkinName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 256 &&
    !name.includes('..') && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

// ── Brand logo + country flag helpers ─────────────────────────────────────────
// Keys are lowercase for case-insensitive lookup; values are carlogos.org slugs
const BRAND_LOGO_MAP = {
  'abarth': 'Abarth', 'abarth500': 'Abarth',
  'alfa romeo': 'Alfa-Romeo', 'alfa': 'Alfa-Romeo',
  'audi': 'Audi',
  'bmw': 'BMW',
  'chevrolet': 'Chevrolet', 'corvette': 'Chevrolet',
  'citroen': 'Citroen', 'citroën': 'Citroen',
  'ferrari': 'Ferrari',
  'fiat': 'Fiat',
  'ford': 'Ford',
  'lamborghini': 'Lamborghini',
  'lancia': 'Lancia',
  'lotus': 'Lotus',
  'maserati': 'Maserati',
  'mazda': 'Mazda',
  'mclaren': 'McLaren',
  'mercedes': 'Mercedes-Benz', 'mercedes-benz': 'Mercedes-Benz',
  'mitsubishi': 'Mitsubishi',
  'nissan': 'Nissan',
  'opel': 'Opel',
  'pagani': 'Pagani',
  'peugeot': 'Peugeot',
  'porsche': 'Porsche',
  'praga': 'Praga',
  'renault': 'Renault',
  'seat': 'SEAT',
  'simca': 'Simca',
  'skoda': 'Skoda', 'škoda': 'Skoda',
  'talbot': 'Talbot',
  'toyota': 'Toyota',
  'volkswagen': 'Volkswagen', 'vw': 'Volkswagen',
};
// Infer brand name from Kunos car ID prefix (e.g. ks_ferrari_f40 → 'Ferrari')
const KS_ID_BRAND = {
  'abarth': 'Abarth', 'abarth500': 'Abarth',
  'alfa': 'Alfa Romeo',
  'audi': 'Audi',
  'bmw': 'BMW',
  'corvette': 'Chevrolet',
  'ferrari': 'Ferrari',
  'ford': 'Ford',
  'glickenhaus': 'Glickenhaus',
  'lamborghini': 'Lamborghini',
  'lotus': 'Lotus',
  'maserati': 'Maserati',
  'mazda': 'Mazda',
  'mclaren': 'McLaren',
  'mercedes': 'Mercedes-Benz',
  'nissan': 'Nissan',
  'pagani': 'Pagani',
  'porsche': 'Porsche',
  'praga': 'Praga',
  'ruf': 'RUF',
  'toyota': 'Toyota',
};
function inferBrand(carId, uiBrand) {
  if (uiBrand) return uiBrand;
  if (carId.startsWith('ks_')) {
    const prefix = carId.slice(3).split('_')[0];
    return KS_ID_BRAND[prefix] || '';
  }
  return '';
}
function brandLogoUrl(brand) {
  if (!brand) return null;
  const slug = BRAND_LOGO_MAP[brand.toLowerCase()];
  return slug ? `https://www.carlogos.org/logo/${slug}-logo.png` : null;
}

// Country ISO codes (used for flag URL)
const COUNTRY_ISO2 = {
  'spain': 'es', 'españa': 'es',
  'italy': 'it', 'italia': 'it',
  'germany': 'de', 'alemania': 'de',
  'france': 'fr', 'francia': 'fr',
  'united kingdom': 'gb', 'uk': 'gb', 'england': 'gb',
  'japan': 'jp', 'japón': 'jp', 'japon': 'jp',
  'usa': 'us', 'united states': 'us',
  'austria': 'at',
  'belgium': 'be', 'bélgica': 'be',
  'portugal': 'pt',
  'hungary': 'hu', 'hungría': 'hu',
  'monaco': 'mc', 'mónaco': 'mc',
  'brazil': 'br', 'brasil': 'br',
  'australia': 'au',
  'netherlands': 'nl', 'países bajos': 'nl',
  'sweden': 'se', 'suecia': 'se',
  'switzerland': 'ch', 'suiza': 'ch',
  'finland': 'fi', 'finlandia': 'fi',
  'china': 'cn',
  'czech republic': 'cz', 'czechia': 'cz',
  'poland': 'pl', 'polonia': 'pl',
  'canada': 'ca', 'canadá': 'ca',
  'mexico': 'mx', 'méxico': 'mx',
  'argentina': 'ar',
  'south africa': 'za', 'sudáfrica': 'za',
  'romania': 'ro', 'rumanía': 'ro',
  'slovakia': 'sk',
  // regional
  'tenerife': 'es', 'canary islands': 'es', 'gran canaria': 'es',
};
// Spanish country names for display
const COUNTRY_ES = {
  'spain': 'España', 'españa': 'España',
  'italy': 'Italia', 'italia': 'Italia',
  'germany': 'Alemania',
  'france': 'Francia',
  'united kingdom': 'Reino Unido', 'uk': 'Reino Unido', 'england': 'Reino Unido',
  'japan': 'Japón',
  'usa': 'EE. UU.', 'united states': 'EE. UU.',
  'austria': 'Austria',
  'belgium': 'Bélgica',
  'portugal': 'Portugal',
  'hungary': 'Hungría',
  'monaco': 'Mónaco',
  'brazil': 'Brasil',
  'australia': 'Australia',
  'netherlands': 'Países Bajos',
  'sweden': 'Suecia',
  'switzerland': 'Suiza',
  'finland': 'Finlandia',
  'china': 'China',
  'czech republic': 'Rep. Checa', 'czechia': 'Rep. Checa',
  'poland': 'Polonia',
  'canada': 'Canadá',
  'mexico': 'México',
  'argentina': 'Argentina',
  'south africa': 'Sudáfrica',
  'romania': 'Rumanía',
  'slovakia': 'Eslovaquia',
  // regional → parent country
  'tenerife': 'España', 'canary islands': 'España', 'gran canaria': 'España',
};
function normalizeCountry(raw) {
  if (!raw) return '';
  // Fix potential Latin-1 / Windows-1252 decode artifacts
  return raw.replace(/�/g, 'ñ').trim();
}
function countryFlag(country) {
  if (!country) return null;
  const key = normalizeCountry(country).toLowerCase();
  const iso = COUNTRY_ISO2[key];
  return iso ? `https://flagcdn.com/16x12/${iso}.png` : null;
}
function countryEs(country) {
  if (!country) return '';
  const key = normalizeCountry(country).toLowerCase();
  return COUNTRY_ES[key] || normalizeCountry(country);
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── INI parser / serializer ───────────────────────────────────────────────────
function parseINI(text) {
  const result = {};
  let section = '__default__';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) {
      section = m[1];
      // Reject [__proto__]/[constructor]/[prototype] sections: a section named
      // __proto__ would make result[section][k]=v write straight onto
      // Object.prototype (prototype pollution from a crafted server_cfg.ini).
      if (section === '__proto__' || section === 'constructor' || section === 'prototype') { section = null; continue; }
      result[section] = result[section] || {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) {
      if (section === null) continue; // key line inside a rejected section
      const k = line.slice(0, eq).trim();
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const v = line.slice(eq + 1).trim();
      if (!result[section]) result[section] = {};
      result[section][k] = v;
    }
  }
  return result;
}

// Patch an INI file in-place: replaces changed values but keeps all comment and
// blank lines exactly as they were. New keys (not in the original) are inserted
// immediately after their section header.
//
// The sanitization here is deliberately layered:
//   - sanitizeIniVal     — minimum contract every patchINI value must satisfy
//                          (strip CR/LF/NUL, otherwise leave the value intact
//                          because some legitimate fields use INI metachars,
//                          e.g. `CARS=a;b;c` uses `;` as the list separator).
//   - sanitizeIniText    — for free-form text (NAME, WELCOME_MESSAGE, COUNTRY,
//                          CITY). Strips control chars AND the INI metacharacters
//                          (`[`, `]`, `;`, `#`, `=`) that would inject new keys
//                          or section headers if the value came from user input.
//   - sanitizeIniPassword — printable ASCII only, no quote characters.
//   - _renderIniValue    — render-time guard, called by patchINI for every
//                          value before it lands in the file. Refuses control
//                          chars and values that would syntactically start a
//                          new section or comment. Should be unreachable in
//                          practice (every callsite already sanitizes upstream),
//                          but catches the "future contributor forgets to
//                          sanitize" regression class.
function sanitizeIniVal(v) {
  return String(v).replace(/[\r\n\0]/g, ' ');
}
function sanitizeIniText(v) {
  return String(v)
    .replace(/[\r\n\0]/g, ' ')
    .replace(/[\[\];#=]/g, '');
}
// Password fields — printable ASCII only (excluding INI metacharacters and quote chars).
// AC server passwords are joined into a URL on the in-game UI; we keep the alphabet narrow
// so an admin cannot lock themselves (or others) out via stray glyphs.
function sanitizeIniPassword(v) {
  return String(v).replace(/[^\x21-\x7E]/g, '').replace(/[\[\];#"'`]/g, '');
}
function _renderIniValue(rawValue) {
  const v = sanitizeIniVal(rawValue);
  // After sanitizeIniVal these should be impossible; the assertion exists so a
  // future change that loosens the sanitizer cannot silently inject a newline
  // (which would forge a fresh `key=value` row downstream).
  if (/[\r\n\0]/.test(v)) {
    throw Object.assign(new Error('Refusing to write INI value with control characters'), { status: 400 });
  }
  // A value beginning with `;`, `#` or `[` would be interpreted by every INI
  // parser as a comment or section header — the panel's view of the config
  // would silently diverge from acServer's. Block at the render layer so a
  // mistakenly-unsanitised user input cannot poison the file.
  if (/^[;#\[]/.test(v.trimStart())) {
    throw Object.assign(new Error('Refusing to write INI value that begins with an INI metacharacter'), { status: 400 });
  }
  return v;
}

// Remove a whole section from the INI text — its header line plus every
// following line until the next section header (or EOF). Used to physically
// drop [PRACTICE]/[QUALIFY]/[RACE] when the admin disables that session.
// Setting IS_OPEN=0 isn't enough: acServer cycles through every section it
// finds, so the slot still passes through. Deleting the section is the only
// reliable way to keep the loop on a single session.
function removeIniSection(raw, sectionName) {
  const lines  = raw.split('\n');
  const target = `[${sectionName}]`;
  const out    = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === target) { skipping = true; continue; }
    if (skipping) {
      if (/^\[.+\]$/.test(trimmed)) { skipping = false; out.push(line); }
      // else: still inside the section we're dropping — discard
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

function patchINI(raw, obj) {
  const lines = raw.split('\n');
  let section = '__default__';
  const updated = new Set();

  const patched = lines.map(rawLine => {
    const line = rawLine.trim();
    const secM = line.match(/^\[(.+)\]$/);
    if (secM) { section = secM[1]; return rawLine; }
    if (!line || line.startsWith(';') || line.startsWith('#')) return rawLine;
    const eq = line.indexOf('=');
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      if (obj[section] && k in obj[section]) {
        updated.add(`${section}|${k}`);
        return `${k}=${_renderIniValue(obj[section][k])}`;
      }
    }
    return rawLine;
  });

  for (const [sec, keys] of Object.entries(obj)) {
    if (sec === '__default__') continue;
    for (const [k, v] of Object.entries(keys)) {
      if (updated.has(`${sec}|${k}`)) continue;
      const val = _renderIniValue(v);
      const secIdx = patched.findIndex(l => l.trim() === `[${sec}]`);
      if (secIdx >= 0) {
        patched.splice(secIdx + 1, 0, `${k}=${val}`);
      } else {
        patched.push('', `[${sec}]`, `${k}=${val}`);
      }
    }
  }

  return patched.join('\n');
}

// ── System metrics ────────────────────────────────────────────────────────────
function getCPUName() {
  try {
    const m = fs.readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.+)/);
    return m ? m[1].trim() : (os.cpus()[0]?.model || 'Unknown');
  } catch { return os.cpus()[0]?.model || 'Unknown'; }
}

function getOSInfo() {
  try {
    const raw  = fs.readFileSync('/etc/os-release', 'utf8');
    const get  = k => { const m = raw.match(new RegExp(`^${k}="?([^"\\n]+)"?`, 'm')); return m ? m[1] : ''; };
    return { name: get('NAME') || os.type(), version: get('VERSION_ID') || '' };
  } catch { return { name: os.type(), version: '' }; }
}

function getCPU() {
  return new Promise(resolve => {
    // /proc/stat is Linux-only. On macOS / FreeBSD / Windows readFileSync throws —
    // fall back to a 0 % reading so the dashboard still works.
    const read = () => {
      try {
        const v = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
        return { idle: v[3] + (v[4] || 0), total: v.reduce((a, b) => a + b, 0) };
      } catch { return null; }
    };
    const s1 = read();
    if (!s1) return resolve(0);
    setTimeout(() => {
      const s2 = read();
      if (!s2) return resolve(0);
      const di = s2.idle - s1.idle, dt = s2.total - s1.total;
      resolve(dt === 0 ? 0 : Math.round((1 - di / dt) * 100));
    }, 250);
  });
}

// Public IP discovery. Hits api.ipify.org once and caches with a TTL so a
// transient bad response (DNS hijack, MITM, or ipify simply going wrong for a
// second) does not get pinned in memory forever. Validates that the body looks
// like an IPv4/IPv6 address before accepting — otherwise a malicious upstream
// could return arbitrary HTML and we'd surface it to every /api/metrics caller.
// Override entirely with PUBLIC_IP=1.2.3.4 in .env when behind NAT/CGNAT.
let _publicIpCache = { value: null, fetchedAt: 0 };
const PUBLIC_IP_TTL_MS = 60 * 60 * 1000; // 1h — long enough to spare ipify, short enough to recover from a bad result
function _looksLikeIp(s) {
  if (typeof s !== 'string' || !s) return false;
  if (s.length > 45) return false; // longest valid IPv6 textual form
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || /^[0-9a-fA-F:]+$/.test(s);
}
async function getPublicIp() {
  if (process.env.PUBLIC_IP) return process.env.PUBLIC_IP;
  const now = Date.now();
  if (_publicIpCache.value && now - _publicIpCache.fetchedAt < PUBLIC_IP_TTL_MS) {
    return _publicIpCache.value;
  }
  try {
    const res = await new Promise((resolve, reject) => {
      const req = require('https').get('https://api.ipify.org', r => {
        if (r.statusCode !== 200) { r.destroy(); return resolve(null); }
        let d = '';
        // Cap at 64 bytes — a real IP is at most 45 chars; anything bigger is
        // garbage and we don't want to buffer megabytes from a hostile upstream.
        r.on('data', chunk => { if (d.length < 64) d += chunk.toString().slice(0, 64 - d.length); });
        r.on('end', () => resolve(d.trim()));
      });
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    });
    if (_looksLikeIp(res)) {
      _publicIpCache = { value: res, fetchedAt: now };
      return res;
    }
    return getNetworkIP();
  } catch {
    return getNetworkIP();
  }
}

function getRAM() {
  const d = fs.readFileSync('/proc/meminfo', 'utf8');
  const g = k => { const m = d.match(new RegExp(k + ':\\s+(\\d+)')); return m ? parseInt(m[1]) : 0; };
  const total = g('MemTotal'), avail = g('MemAvailable');
  return { used: Math.round((total - avail) / 1024), total: Math.round(total / 1024) };
}

// Best-effort CPU temperature via /sys/class/thermal — pure Linux kernel
// surface, no external binary, no extra package to install, no sudo. Walks
// every thermal_zone, prefers zones whose `type` looks like a CPU sensor
// (x86_pkg_temp, coretemp, cpu-thermal, core_N, package_N) and reports the
// highest reading among the preferred set (multi-package boxes). If no
// zones exist or all readings look bogus (the file is missing, the value
// is out of plausible range, the host is a VPS with thermal hidden by the
// hypervisor, …) the helper returns null and the frontend hides the badge —
// there is no fallback temperature to show, just absence.
async function _getCpuTempC() {
  try {
    const base = '/sys/class/thermal';
    const zones = await fsp.readdir(base).catch(() => []);
    const candidates = [];
    for (const z of zones) {
      if (!/^thermal_zone\d+$/.test(z)) continue;
      try {
        const type = (await fsp.readFile(path.join(base, z, 'type'), 'utf8')).trim();
        const tempRaw = await fsp.readFile(path.join(base, z, 'temp'), 'utf8');
        const tempC = parseInt(tempRaw, 10) / 1000;
        if (!Number.isFinite(tempC) || tempC <= 0 || tempC > 200) continue;
        const isCpuLike = /(x86_pkg_temp|coretemp|cpu[-_]thermal|core_?\d|package_?\d)/i.test(type);
        candidates.push({ tempC, isCpuLike });
      } catch { /* unreadable zone — skip */ }
    }
    if (!candidates.length) return null;
    const cpu = candidates.filter(c => c.isCpuLike);
    const pool = cpu.length ? cpu : candidates;
    return Math.round(Math.max(...pool.map(c => c.tempC)));
  } catch { return null; }
}

// ── AC Server detection ───────────────────────────────────────────────────────
let _acRunSince  = null;
let _acFailCount = 0;
const AC_FAIL_THRESHOLD = 3; // require N consecutive /INFO failures before declaring it down

// Fetches /INFO from the AC HTTP API and returns { running, liveTrack }.
// Also maintains _acRunSince for uptime tracking. Resilient to transient hiccups:
// a single failed poll keeps the previous "up" verdict; the uptime is only
// cleared after N consecutive failures.
function getACInfo() {
  return new Promise(resolve => {
    let body = '';
    const onDown = () => {
      _acFailCount++;
      if (_acFailCount >= AC_FAIL_THRESHOLD) _acRunSince = null;
      resolve({ running: false, liveTrack: null });
    };
    const req = http.get(
      { hostname: '127.0.0.1', port: AC_HTTP_PORT, path: '/INFO', timeout: 1500 },
      res => {
        if (res.statusCode !== 200) {
          res.destroy();
          return onDown();
        }
        res.on('data', d => { body += d; });
        res.on('end', () => {
          _acFailCount = 0;
          if (!_acRunSince) _acRunSince = Date.now();
          try {
            const info = JSON.parse(body);
            resolve({ running: true, liveTrack: info.track || null });
          } catch {
            resolve({ running: true, liveTrack: null });
          }
        });
      }
    );
    req.on('error', onDown);
    req.setTimeout(1500, () => { req.destroy(); onDown(); });
  });
}

function checkACRunning() { return getACInfo().then(i => i.running); }

function getACUptime() {
  if (!_acRunSince) return '—';
  const sec = Math.floor((Date.now() - _acRunSince) / 1000);
  const h   = Math.floor(sec / 3600);
  const m   = Math.floor((sec % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// Pure helpers (_csvCell, parseLine) live in lib/pure.js so unit tests can
// load them without booting the HTTP server / DB / log watcher. See that
// file's header for the rule about what belongs there.
const { parseLine } = require('./lib/pure.js');

// ── API handlers ──────────────────────────────────────────────────────────────

async function apiMetrics(res) {
  try {
    const [cpu, ram, acInfo, publicIp, cpuTemp] = await Promise.all([getCPU(), Promise.resolve(getRAM()), getACInfo(), getPublicIp(), _getCpuTempC()]);
    // Connected-player count, sourced in priority: UDP plugin (knows by GUID
    // from NEW_CONNECTION) → /JSON|0 IsConnected flags → unknown (-1).
    // Surfaced here so the Dashboard KPI can poll once and stay in sync with
    // the Players Online list.
    let players = -1;
    const live = udpGetLivePlayers();
    if (live && Array.isArray(live)) {
      players = live.length;
    } else if (acInfo.running) {
      const list = await acFetchJson('/JSON%7C0');
      if (list && Array.isArray(list.Cars)) {
        players = list.Cars.filter(c => c && c.IsConnected).length;
      } else {
        players = 0;
      }
    } else {
      players = 0;
    }
    json(res, 200, {
      cpu, ram, cpuTemp,
      running:   acInfo.running,
      liveTrack: acInfo.liveTrack,
      uptime:    getACUptime(),
      cpuName:   getCPUName(),
      osInfo:    getOSInfo(),
      publicIp,
      httpPort:  AC_HTTP_PORT,
      players,
    });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

function apiLogs(req, res) {
  const n = Math.min(500, parseInt(new URL(req.url, 'http://x').searchParams.get('n') || '150'));
  json(res, 200, { lines: logBuffer.slice(-n) });
}

// Persistent clear — drops the in-memory buffer, truncates AC_LOG_FILE so the
// next server restart doesn't reload the old lines via loadLogFileIntoBuffer,
// and broadcasts a `clear` SSE event so every open tab wipes its state.
// Admin-only because it affects every connected viewer + persists across
// restarts; non-admins still see the (now hidden) button as a no-op.
function apiLogsClear(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    logBuffer = [];
    // Keep logSeq monotonic so older client refs (clearedSeqRef) don't accidentally
    // un-suppress freshly-issued ids that happen to overlap with the pre-clear range.
    try { fs.truncateSync(AC_LOG_FILE, 0); } catch {}
    // The tail watcher tracks how many bytes it has already read; resetting
    // it here makes sure the post-truncate file is read from byte 0 instead
    // of skipped (size < stored pos triggers the rotation branch anyway, but
    // doing it explicitly avoids depending on that ordering).
    resetLogTailPosition();
    for (const r of [...sseClients]) {
      try { r.write(`event: clear\ndata: {}\n\n`); } catch { sseClients.delete(r); }
    }
    insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'logs.clear');
    json(res, 200, { ok: true });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Per-user concurrent SSE connection cap. Without this an authenticated user can
// open arbitrarily many `/api/logs/stream` connections (one per browser tab × N
// tabs × N devices) and pin file descriptors + heartbeat timers. Six is generous
// for normal usage (a few tabs, a phone, an ops dashboard) and well below any
// reasonable fd budget.
const _sseByUser = new Map(); // username -> Set<res>
const SSE_PER_USER_CAP = 6;

function apiLogsStream(req, res) {
  // Router has already gated /api/* on a valid session, so getSession(req) is
  // expected to return one. Fall back to '' for the (impossible) no-session
  // case so the cap still applies in aggregate.
  const user = getSession(req)?.username || '';
  const userSet = _sseByUser.get(user) || new Set();
  if (userSet.size >= SSE_PER_USER_CAP) {
    return json(res, 429, { error: 'Too many concurrent log streams for this user — close other tabs and retry' });
  }

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: init\ndata: ${JSON.stringify(logBuffer)}\n\n`);
  sseClients.add(res);
  userSet.add(res);
  _sseByUser.set(user, userSet);

  // Single cleanup path used by every termination route (req close, write
  // failure during heartbeat, write failure during appendLog broadcast).
  // Without this the heartbeat-failure branch would only stop the timer,
  // leaving the res object pinned in sseClients and _sseByUser forever and
  // burning per-user SSE cap until the next legitimate close.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    sseClients.delete(res);
    const set = _sseByUser.get(user);
    if (set) {
      set.delete(res);
      if (set.size === 0) _sseByUser.delete(user);
    }
  };

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch { cleanup(); try { res.destroy(); } catch {} }
  }, 25000);
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

function apiConfig(req, res) {
  const sess  = getSession(req);
  const isAdmin = sess?.role === 'admin';
  fs.readFile(AC_CFG_FILE, 'utf8', (err, data) => {
    if (err) return json(res, 404, { error: 'server_cfg.ini not found' });
    const ini = parseINI(data);
    const s   = ini['SERVER']    || {};
    const p   = ini['PRACTICE']  || null;
    const q   = ini['QUALIFY']   || null;
    const r0  = ini['RACE']      || null;
    const w   = ini['WEATHER_0'] || {};
    const g   = ini['GEO_PARAMS'] || {};
    // GEO_PARAMS.COUNTRY uses the "<Name>, <ISO2>" convention CM expects.
    // Split it back out for the form so the panel can present a country
    // picker; tolerate "Name" without the comma + ISO2 (some servers only
    // set the name).
    const rawCountry = (g['COUNTRY'] || '').trim();
    let countryName = '', countryIso = '';
    if (rawCountry) {
      const parts = rawCountry.split(',').map(s => s.trim()).filter(Boolean);
      countryName = parts[0] || '';
      if (parts[1] && /^[A-Za-z]{2}$/.test(parts[1])) countryIso = parts[1].toUpperCase();
    }
    // entry_list.ini is the source of truth for the grid layout — each
    // [CAR_n] block defines one slot's MODEL + SKIN. We walk them in order
    // so the Session page's "Selected Cars" list restores 1:1 after F5,
    // including same-car-different-skin entries.
    const ENTRY_LIST = path.join(path.dirname(AC_CFG_FILE), 'entry_list.ini');
    let slots = [];
    try {
      const entry = parseINI(fs.readFileSync(ENTRY_LIST, 'utf8'));
      const ordered = Object.entries(entry)
        .filter(([sec]) => /^CAR_\d+$/.test(sec))
        .sort(([a], [b]) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));
      for (const [, kv] of ordered) {
        const model = kv['MODEL'];
        if (!model) continue;
        const skin = (kv['SKIN'] && kv['SKIN'] !== 'Base') ? kv['SKIN'] : null;
        slots.push({ id: model, skin });
      }
    } catch {}
    json(res, 200, {
      name:        s['NAME']                    || '',
      welcome:     s['WELCOME_MESSAGE']          || '',
      password:    isAdmin ? (s['PASSWORD']         || '') : '',
      adminPass:   isAdmin ? (s['ADMIN_PASSWORD']   || '') : '',
      tcp:         intOr(s['TCP_PORT'],                 9600),
      udp:         intOr(s['UDP_PORT'],                 9600),
      http:        intOr(s['HTTP_PORT'],                8081),
      tickrate:    intOr(s['CLIENT_SEND_INTERVAL_HZ'],  18),
      maxClients:  intOr(s['MAX_CLIENTS'],              0),
      publicLobby: s['REGISTER_TO_LOBBY'] === '1',
      whitelist:   s['WELCOME_WHITELIST_ENABLED'] === '1',
      fuelRate:    intOr(s['FUEL_RATE'],                100),
      damage:      intOr(s['DAMAGE_MULTIPLIER'],        100),
      tyreWear:    intOr(s['TYRE_WEAR_RATE'],           100),
      abs:         intOr(s['ABS_ALLOWED'],              0),
      tc:          intOr(s['TC_ALLOWED'],               0),
      autoclutch:  s['AUTOCLUTCH_ALLOWED'] === '1',
      stability:   s['STABILITY_ALLOWED']  === '1',
      track:       s['TRACK']              || '',
      trackConfig: s['CONFIG_TRACK']       || '',
      cars:        (s['CARS'] || '').split(';').filter(Boolean),
      slots,
      // Per-session-type values. Each section can be physically present or
      // missing — `*Enabled` flags reflect that so the Session page can
      // restore the per-row toggles. When a section is absent we still
      // return a default duration/laps so toggling it back on shows
      // something sensible until the admin edits it.
      practiceEnabled: !!p,
      qualifyEnabled:  !!q,
      raceEnabled:     !!r0,
      practiceTime:    intOr(p?.['TIME'], 10),
      qualifyTime:     intOr(q?.['TIME'], 10),
      raceLaps:        intOr(r0?.['LAPS'], 5),
      // Hour-of-day is exposed as 0..23 to the client; SUN_ANGLE is the
      // native INI unit. Conversion: hour↔angle via (hour-13)*16 clamped
      // to [-80, +80] (matches Content Manager's slider).
      sunAngle:     intOr(s['SUN_ANGLE'], 48),
      weather:      w['GRAPHICS']                  || '3_clear',
      airTemp:      intOr(w['BASE_TEMPERATURE_AMBIENT'], 18),
      // RACE_GAS_PENALTY_DISABLED is inverted: "1" means penalties OFF.
      penalties:    s['RACE_GAS_PENALTY_DISABLED'] !== '1',
      // GEO_PARAMS — country + city for the Content Manager listing.
      country:      countryName,
      countryIso:   countryIso,
      city:         (g['CITY'] || '').trim(),
    });
  });
}

function validPort(v) { const n = parseInt(v); return n >= 1 && n <= 65535 ? n : null; }
function clampInt(v, lo, hi) { const n = parseInt(v); return isNaN(n) ? null : Math.max(lo, Math.min(hi, n)); }
// parseInt with explicit fallback. `parseInt('0') || N` returns N — wrong for legitimate 0.
function intOr(v, fallback) { const n = parseInt(v); return isNaN(n) ? fallback : n; }

async function apiConfigUpdate(req, res) {
  if (!checkPermission(req, 'serverConfig')) return json(res, 403, { error: 'Forbidden' });
  if (!checkRateLimit('config-put', clientIp(req), 30, 60 * 1000))
    return json(res, 429, { error: 'Rate limit: too many config writes' });
  try {
    const body = await readBody(req);
    const raw  = await fsp.readFile(AC_CFG_FILE, 'utf8');
    const ini  = parseINI(raw);
    const s    = ini['SERVER'] = ini['SERVER'] || {};

    // Track which fields were applied vs rejected (failed validation) so the UI
    // can flag the bad inputs instead of guessing why a save "didn't take".
    const applied  = [];
    const rejected = [];
    const set = (key, ok, name) => { if (ok) applied.push(name); else if (name) rejected.push(name); };

    // PASSWORD/ADMIN_PASSWORD are AC server credentials. Letting a permissioned
    // user rewrite them would let them lock out admins (regular PASSWORD) or
    // hand themselves the in-game admin command via ADMIN_PASSWORD. Hard-gate
    // these to checkAdminAuth even when serverConfig is granted.
    const sensitiveAdminOnly = checkAdminAuth(req);
    if (body.name        !== undefined) { s['NAME']                    = sanitizeIniText(body.name).slice(0, 255);     applied.push('name'); }
    if (body.welcome     !== undefined) { s['WELCOME_MESSAGE']         = sanitizeIniText(body.welcome).slice(0, 255);  applied.push('welcome'); }
    if (body.password    !== undefined && sensitiveAdminOnly) { s['PASSWORD']                = sanitizeIniPassword(body.password).slice(0, 64);  applied.push('password'); }
    if (body.adminPass   !== undefined && sensitiveAdminOnly) { s['ADMIN_PASSWORD']          = sanitizeIniPassword(body.adminPass).slice(0, 64); applied.push('adminPass'); }
    if ((body.password !== undefined || body.adminPass !== undefined) && !sensitiveAdminOnly) {
      if (body.password  !== undefined) rejected.push('password');
      if (body.adminPass !== undefined) rejected.push('adminPass');
    }
    if (body.tcp         !== undefined) { const p = validPort(body.tcp);         set('TCP_PORT',  p && (s['TCP_PORT']                = String(p)),  'tcp'); }
    if (body.udp         !== undefined) { const p = validPort(body.udp);         set('UDP_PORT',  p && (s['UDP_PORT']                = String(p)),  'udp'); }
    if (body.http        !== undefined) { const p = validPort(body.http);        set('HTTP_PORT', p && (s['HTTP_PORT']               = String(p)),  'http'); }
    if (body.tickrate    !== undefined) { const v = clampInt(body.tickrate,1,300);   set('TICKRATE',   v && (s['CLIENT_SEND_INTERVAL_HZ'] = String(v)), 'tickrate'); }
    if (body.maxClients  !== undefined) { const v = clampInt(body.maxClients,1,200); set('MAX_CLIENTS',v && (s['MAX_CLIENTS']          = String(v)),  'maxClients'); }
    if (body.publicLobby !== undefined) { s['REGISTER_TO_LOBBY']      = body.publicLobby ? '1' : '0'; applied.push('publicLobby'); }
    if (body.fuelRate    !== undefined) { const v = clampInt(body.fuelRate,0,200);   set('FUEL_RATE',  v !== null && (s['FUEL_RATE']     = String(v)), 'fuelRate'); }
    if (body.damage      !== undefined) { const v = clampInt(body.damage,0,200);     set('DAMAGE',     v !== null && (s['DAMAGE_MULTIPLIER'] = String(v)), 'damage'); }
    if (body.tyreWear    !== undefined) { const v = clampInt(body.tyreWear,0,200);   set('TYRE_WEAR',  v !== null && (s['TYRE_WEAR_RATE'] = String(v)), 'tyreWear'); }
    if (body.abs         !== undefined) { const v = clampInt(body.abs,0,2);          set('ABS',        v !== null && (s['ABS_ALLOWED']    = String(v)), 'abs'); }
    if (body.tc          !== undefined) { const v = clampInt(body.tc,0,2);           set('TC',         v !== null && (s['TC_ALLOWED']     = String(v)), 'tc'); }
    if (body.autoclutch  !== undefined) { s['AUTOCLUTCH_ALLOWED']      = body.autoclutch ? '1' : '0'; applied.push('autoclutch'); }
    if (body.stability   !== undefined) { s['STABILITY_ALLOWED']       = body.stability  ? '1' : '0'; applied.push('stability'); }
    if (body.whitelist   !== undefined) { s['WELCOME_WHITELIST_ENABLED']= body.whitelist  ? '1' : '0'; applied.push('whitelist'); }

    // GEO_PARAMS — Content Manager reads COUNTRY="<Name>, <ISO2>" from the
    // lobby payload to render the country flag + name. The section is
    // created on first write (patchINI appends missing sections); subsequent
    // writes update the same lines.
    if (body.country !== undefined || body.countryIso !== undefined || body.city !== undefined) {
      const g = ini['GEO_PARAMS'] = ini['GEO_PARAMS'] || {};
      if (body.country !== undefined) {
        const name = sanitizeIniText(body.country).slice(0, 64).trim();
        const iso  = body.countryIso !== undefined
          ? sanitizeIniText(body.countryIso).toUpperCase().slice(0, 2)
          : (g['COUNTRY'] || '').split(',')[1]?.trim() || '';
        const valid = /^[A-Z]{2}$/.test(iso);
        if (name) {
          g['COUNTRY'] = valid ? `${name}, ${iso}` : name;
          applied.push('country');
        } else {
          // Empty name = clear the row
          g['COUNTRY'] = '';
          applied.push('country');
        }
      } else if (body.countryIso !== undefined) {
        // ISO updated without a name — patch the second field in place
        const cur  = (g['COUNTRY'] || '').split(',')[0].trim();
        const iso  = sanitizeIniText(body.countryIso).toUpperCase().slice(0, 2);
        const valid = /^[A-Z]{2}$/.test(iso);
        g['COUNTRY'] = cur ? (valid ? `${cur}, ${iso}` : cur) : '';
        applied.push('countryIso');
      }
      if (body.city !== undefined) {
        g['CITY'] = sanitizeIniText(body.city).slice(0, 64).trim();
        applied.push('city');
      }
      // Leave IP blank so the lobby fills it from the registration packet —
      // hard-coding it would break servers behind dynamic IPs / NAT.
      if (!('IP' in g)) g['IP'] = '';
    }

    await rotateConfigBackup();
    await fsp.writeFile(AC_CFG_FILE, patchINI(raw, ini), 'utf8');
    insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'config.save', 'server_cfg.ini');

    // Optional auto-restart if requested. Requires serverControl on top of
    // serverConfig — otherwise a user with only config-edit could bypass
    // server-lifecycle gating via the convenience restart=true flag.
    let restarted = false, restartError = null;
    if (body.restart === true && !checkPermission(req, 'serverControl')) {
      restartError = 'restart skipped — serverControl permission required';
    } else if (body.restart === true) {
      // Take the same lock /api/server/{start,stop,restart} use — otherwise a
      // /api/config save with restart=true could race a manual restart and end
      // up with two acServer processes.
      const release = _acquireServerLock();
      if (!release) {
        restartError = 'Another server action is in progress; restart skipped';
      } else {
        try {
          const wasRunning = (acChild && !acChild.killed) || !!(await findACPid()) || (await getACInfo()).running;
          if (wasRunning) {
            const k = await killAC();
            if (!k.ok) restartError = k.error || 'Failed to stop server';
            else {
              await waitForACDown(6000);
              await sleep(500);
              const sp = await spawnAC();
              if (!sp.ok) restartError = sp.error || 'Failed to start server';
              else { await waitForACUp(10000); restarted = true; }
            }
          }
        } finally { release(); }
      }
    }
    json(res, 200, { ok: true, restarted, restartError, applied, rejected });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Fetch+parse a JSON path from the AC HTTP API. Resolves null on connection
// error, timeout, or non-JSON body — so callers can fall back without try/catch.
function acFetchJson(path) {
  return new Promise(resolve => {
    const req = http.get(
      { hostname: '127.0.0.1', port: AC_HTTP_PORT, path, timeout: 2000 },
      r => {
        let data = '';
        r.on('data', d => data += d);
        r.on('end', () => {
          if (!data) return resolve(null);
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

async function apiPlayers(res) {
  // Primary source: the UDP plugin listener, when it has live driver data.
  // It carries Steam GUIDs, model + best/last lap straight from acServer's
  // NEW_CONNECTION + LAP_COMPLETED events, so the Whitelist/Ban buttons
  // work from the first lap and best/last times populate live without
  // waiting for the post-session JSON.
  const live = udpGetLivePlayers();
  if (live && live.length) {
    // udpGetLivePlayers leaves nation='' because the UDP protocol does not
    // carry it. Enrich by guid against the players table (filled by past
    // result imports), then top up the remaining gaps by name against the
    // live /JSON|0 (which exposes DriverNation but no GUID). Both lookups
    // are best-effort: failures leave the flag absent, never blocking the
    // response.
    const byGuid = {};
    if (db) {
      try {
        const guids = live.map(p => p.steam).filter(g => /^\d{17}$/.test(g));
        if (guids.length) {
          const ph = guids.map(() => '?').join(',');
          for (const r of db.prepare(`SELECT guid, nation FROM players WHERE guid IN (${ph})`).all(...guids)) {
            if (r.nation) byGuid[r.guid] = r.nation;
          }
        }
      } catch {}
    }
    const enriched = live.map(p => ({ ...p, nation: byGuid[p.steam] || '' }));
    if (enriched.some(p => !p.nation)) {
      const list = await acFetchJson('/JSON%7C0');
      if (list && Array.isArray(list.Cars)) {
        const byName = {};
        for (const c of list.Cars) {
          if (c && c.IsConnected && c.DriverName && c.DriverNation) byName[c.DriverName] = c.DriverNation;
        }
        for (const p of enriched) {
          if (!p.nation && byName[p.name]) p.nation = byName[p.name];
        }
      }
    }
    // Persist any nation we just learned so the connection-history view still
    // shows the flag after the player disconnects. UDP NEW_CONNECTION can't
    // carry nation (the protocol omits it) and the post-session results JSON
    // is the only other writer — for players who have never had a result
    // imported (or whose result lacked Nation) the players row stays at
    // nation='' indefinitely without this. Update is gated on nation='' so
    // we never overwrite an admin-curated value and the write runs at most
    // once per player.
    if (db) {
      for (const p of enriched) {
        if (p.nation && /^\d{17}$/.test(p.steam)) {
          try {
            db.prepare(`UPDATE players SET nation = ? WHERE guid = ? AND (nation IS NULL OR nation = '')`).run(p.nation, p.steam);
          } catch {}
        }
      }
    }
    return json(res, 200, enriched);
  }

  // Older acServer builds return a rich payload with lap stats, ping and GUID
  // on /api/details. Current builds reply 200 with an empty body — so when
  // /api/details yields nothing usable, fall back to /JSON|0 which still lists
  // connected drivers (without lap stats / ping / GUID).
  const det = await acFetchJson('/api/details');
  if (det && Array.isArray(det.cars) && det.cars.some(c => c?.Driver?.Name)) {
    return json(res, 200, det.cars
      .filter(c => c.Driver && c.Driver.Name)
      .map(c => ({
        id:     c.ID,
        name:   c.Driver.Name,
        steam:  c.Driver.Guid   || '',
        nation: c.Driver.Nation || '',
        carId:  c.CarInfo?.Model || '',
        car:    formatName(c.CarInfo?.Model || ''),
        bestMs: c.BestTime  || 0,
        lastMs: c.Time      || 0,
        laps:   c.NumLaps   || 0,
        ping:   c.Driver?.Ping || 0,
      })));
  }
  const list = await acFetchJson('/JSON%7C0');
  if (!list || !Array.isArray(list.Cars)) return json(res, 200, []);
  // /JSON|0 doesn't expose Steam GUIDs. Recover them by exact in-game-name
  // match against the `players` table — that table is populated from every
  // imported result file, so any returning player gets their GUID back.
  // Skip names that map to multiple GUIDs: kicking/banning the wrong account
  // is worse than leaving the buttons disabled until the result importer
  // confirms the match.
  const nameToGuid = {};
  if (db) {
    try {
      const counts = {};
      for (const r of db.prepare('SELECT guid, name FROM players').all()) {
        counts[r.name] = (counts[r.name] || 0) + 1;
        nameToGuid[r.name] = r.guid;
      }
      for (const n of Object.keys(nameToGuid)) {
        if (counts[n] > 1) delete nameToGuid[n];
      }
    } catch {}
  }
  return json(res, 200, list.Cars
    .map((c, i) => ({ c, slot: i }))
    .filter(({ c }) => c && c.IsConnected && c.DriverName)
    .map(({ c, slot }) => ({
      id:     slot,
      name:   c.DriverName,
      steam:  nameToGuid[c.DriverName] || '',
      nation: c.DriverNation || '',
      carId:  c.Model || '',
      car:    formatName(c.Model || ''),
      bestMs: 0,
      lastMs: 0,
      laps:   0,
      ping:   0,
    })));
}

function apiResults(req, res) {
  if (!db) return json(res, 200, []);
  try {
    const qs    = new URLSearchParams(req.url.split('?')[1] || '');
    const limit = Math.min(Math.max(parseInt(qs.get('limit')) || 500, 1), 5000);
    // Optional server-side filters — push down to SQL so the client doesn't
    // have to round-trip thousands of rows just to filter in the browser.
    const track  = (qs.get('track')  || '').slice(0, 64);
    const car    = (qs.get('car')    || '').slice(0, 64);
    const driver = (qs.get('driver') || '').slice(0, 64);
    const from   = (qs.get('from')   || '').slice(0, 10); // YYYY-MM-DD
    const to     = (qs.get('to')     || '').slice(0, 10);
    const validOnly = qs.get('validOnly') === '1';

    const where = [];
    const args  = [];
    if (track)     { where.push('l.track = ?');         args.push(track); }
    if (car)       { where.push('l.car = ?');           args.push(car); }
    if (driver)    { where.push('l.driver_guid = ?');   args.push(driver); }
    if (from)      { where.push('l.session_date >= ?'); args.push(from); }
    if (to)        { where.push('l.session_date <= ?'); args.push(to); }
    if (validOnly) { where.push('l.valid = 1'); }
    args.push(limit);
    // LEFT JOIN players for the optional admin-set nickname so the lap-time
    // page can render "Apodo (in-game name)" without a second round-trip.
    const sql = `
      SELECT l.id, l.driver_name, l.driver_guid, p.nickname AS nickname,
             l.car, l.track, l.track_config, l.ms, l.s1, l.s2, l.s3,
             l.cuts, l.valid, l.session_date
      FROM laps l
      LEFT JOIN players p ON p.guid = l.driver_guid
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY l.ms ASC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...args);

    const laps = rows.map(r => ({
      id:       r.id,
      player:   r.driver_name,
      nickname: r.nickname || '',
      car:      r.car,
      track:    r.track,
      layout:   r.track_config,
      ms:       r.ms,
      s1:       r.s1,
      s2:       r.s2,
      s3:       r.s3,
      cuts:     r.cuts,
      valid:    r.valid === 1,
      date:     r.session_date,
    }));
    json(res, 200, laps);
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Admin-only manual lap insert. Used by the "Añadir tiempo" popup on the
// Tiempos page when an admin wants to backfill a lap that wasn't captured
// (e.g. server outage, external timing source). Shares the laps_dedup_runtime
// UNIQUE index with the UDP + JSON importers, so re-submitting the same
// (driver_guid, ms, car, track, track_config) is silently a no-op.
async function apiLapCreate(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (!db) return json(res, 500, { error: 'Database unavailable' });
  try {
    const body = await readBody(req);

    const driverName = String(body.driver_name || body.player || '').trim().slice(0, 64);
    if (!driverName) return json(res, 400, { error: 'driver_name required' });

    // GUID is optional — when missing we synthesise a deterministic one from
    // the driver name so the player row + future joins still work. A real
    // 17-digit Steam GUID is preferred; anything that doesn't match is stored
    // verbatim but prefixed with `manual:` so it can never collide with a
    // captured Steam GUID.
    const rawGuid = String(body.driver_guid || '').trim();
    let driverGuid;
    if (/^\d{17}$/.test(rawGuid)) {
      driverGuid = rawGuid;
    } else if (rawGuid) {
      driverGuid = 'manual:' + rawGuid.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    } else {
      driverGuid = 'manual:' + driverName.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 32);
    }

    const car   = String(body.car   || '').trim().slice(0, 128);
    const track = String(body.track || '').trim().slice(0, 128);
    if (!car)   return json(res, 400, { error: 'car required' });
    if (!track) return json(res, 400, { error: 'track required' });
    const trackConfig = String(body.track_config || body.layout || '').trim().slice(0, 64);

    const ms = Math.round(Number(body.ms));
    if (!Number.isFinite(ms) || ms <= 0 || ms >= 999_000_000) {
      return json(res, 400, { error: 'ms must be a positive integer below 999_000_000' });
    }

    const s1 = Math.max(0, Math.round(Number(body.s1) || 0));
    const s2 = Math.max(0, Math.round(Number(body.s2) || 0));
    const s3 = Math.max(0, Math.round(Number(body.s3) || 0));

    const valid = body.valid === false ? 0 : 1;
    const cuts  = valid ? 0 : Math.max(1, Math.round(Number(body.cuts) || 1));

    // Session date — accept YYYY-MM-DD; default to today.
    let sessionDate = String(body.session_date || body.date || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
      sessionDate = new Date().toISOString().slice(0, 10);
    }

    const lapTimestamp = Math.max(0, Math.round(Number(body.lap_timestamp) || 0));

    const ins = db.prepare(`
      INSERT OR IGNORE INTO laps
        (driver_name, driver_guid, car, track, track_config, ms, lap_timestamp,
         s1, s2, s3, cuts, valid, session_date, source_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
    `).run(
      driverName, driverGuid, car, track, trackConfig, ms, lapTimestamp,
      s1 || ms, s2, s3, cuts, valid, sessionDate,
    );

    if (ins.changes === 0) {
      return json(res, 409, { error: 'Duplicate lap (same driver/time/car/track already exists)' });
    }

    // Keep the players table in sync so the manual driver shows up on the
    // Jugadores page and joins for nickname rendering work.
    db.prepare(`
      INSERT INTO players (guid, name, nation, first_seen, last_seen, total_laps, last_car, last_track)
      VALUES (?, ?, '', ?, ?, 1, ?, ?)
      ON CONFLICT(guid) DO UPDATE SET
        name       = excluded.name,
        last_seen  = excluded.last_seen,
        total_laps = players.total_laps + 1,
        last_car   = excluded.last_car,
        last_track = excluded.last_track
    `).run(driverGuid, driverName, sessionDate, sessionDate, car, track);

    const actor = checkAnyAuth(req)?.username || 'unknown';
    insertAuditLog(actor, 'lap.create', String(ins.lastInsertRowid),
      `${driverName} ${formatLapTime(ms)} @ ${track}${trackConfig ? '/' + trackConfig : ''} (${car})`);

    if (valid && cuts === 0) {
      maybeNotifyRecord({
        guid: driverGuid, name: driverName, lapMs: ms,
        car, track, trackConfig, lapId: ins.lastInsertRowid,
      });
    }

    json(res, 200, { ok: true, id: ins.lastInsertRowid });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

function apiPlayersHistory(res) {
  if (!db) return json(res, 200, []);
  try {
    const rows = db.prepare(`
      SELECT
        p.guid,
        p.name,
        p.nickname,
        p.nation,
        p.first_seen,
        p.last_seen,
        p.last_car,
        p.last_track,
        COUNT(DISTINCT l.session_date)                    AS session_count,
        COUNT(l.id)                                       AS lap_count,
        COALESCE(SUM(l.ms), 0)                            AS total_ms,
        MIN(CASE WHEN l.valid = 1 THEN l.ms ELSE NULL END) AS best_ms
      FROM players p
      LEFT JOIN laps l ON p.guid = l.driver_guid
      GROUP BY p.guid
      ORDER BY p.last_seen DESC
    `).all();

    const players = rows.map(p => ({
      id:        p.guid,
      name:      p.name,
      nickname:  p.nickname || '',
      steam:     p.guid,
      nation:    p.nation || '',
      car:       formatName(p.last_car || ''),
      sessions:  p.session_count,
      laps:      p.lap_count,
      totalTime: formatTotalTime(p.total_ms),
      bestMs:    p.best_ms || null,
      lastSeen:  p.last_seen || '—',
    }));
    json(res, 200, players);
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// ── Public player profiles ───────────────────────────────────────────────────
// Two unauthenticated views per player at /api/public/players/<guid> (JSON)
// and /p/<guid> (HTML page rendered server-side, reusing the panel's CSS so
// the design is continuous). Off-switchable via panel_settings, see
// publicProfilesEnabled / apiPanelSettings*.
//
// Exposed: name, nickname, nation, GUID, totals, server records held, personal
// bests per (track, layout, car). NOT exposed: anything that isn't already in
// the players/laps tables (no IPs, no admin notes — the schema doesn't store
// them in the first place).

function publicProfilesEnabled() {
  if (!db) return false;
  try {
    const row = db.prepare(`SELECT value FROM panel_settings WHERE key = 'public_profiles_enabled'`).get();
    return row?.value !== '0';
  } catch { return true; }
}

// Resolves a (trackId, layoutId) pair into the same two display strings the
// React Tracks/Session pages render: the base track name (e.g. "Red Bull Ring")
// and the short layout name (e.g. "Grand Prix" — the variant after stripping
// the shared track prefix). Mirrors the algorithm in src/utils.jsx's
// `layoutShortName` so the public profile reads identically to the panel's own
// "Sesión activa" card. Reads ui_track.json per layout from disk; results are
// memoized for the lifetime of the process via _trackLayoutCache so a Players
// page with 50 rows of records doesn't re-stat the same dir 50 times.
const _trackLayoutCache = new Map();
function _trackLayoutDisplay(trackId, layoutId) {
  const key = `${trackId}|${layoutId || ''}`;
  const cached = _trackLayoutCache.get(key);
  if (cached) return cached;

  const out = { trackName: formatName(trackId || ''), layoutName: '' };
  if (!isValidContentId(trackId)) { _trackLayoutCache.set(key, out); return out; }

  // Per-layout ui_track.json — most multi-layout tracks live here. Kunos
  // fallback covers stock content shipped inside src/assets/kunos.
  let layoutJsonName = '';
  if (layoutId && isValidContentId(layoutId)) {
    const l = _readUiJsonSync(path.join(AC_TRACKS_DIR, trackId, 'ui', layoutId, 'ui_track.json'))
           || _readUiJsonSync(path.join(KUNOS_ASSETS_DIR, 'tracks', trackId, 'ui', layoutId, 'ui_track.json'));
    if (l?.name) layoutJsonName = l.name;
  }
  // Root ui_track.json — single-layout tracks live here, multi-layout tracks
  // sometimes carry it too as a parent label.
  let baseName = '';
  const base = _readUiJsonSync(path.join(AC_TRACKS_DIR, trackId, 'ui', 'ui_track.json'))
            || _readUiJsonSync(path.join(KUNOS_ASSETS_DIR, 'tracks', trackId, 'ui', 'ui_track.json'));
  if (base?.name) baseName = base.name;

  // Multi-layout track with no root ui_track.json — derive the base name from
  // the longest common prefix of every layout's display name. This matches
  // what trackBaseName() in src/utils.jsx does in the SPA so the public page
  // never disagrees with what the Tracks page shows for the same combo.
  if (!baseName) {
    try {
      const uiDir = path.join(AC_TRACKS_DIR, trackId, 'ui');
      const sub = fs.readdirSync(uiDir, { withFileTypes: true })
        .filter(e => e.isDirectory()).map(e => e.name);
      const names = [];
      for (const ld of sub) {
        const j = _readUiJsonSync(path.join(uiDir, ld, 'ui_track.json'));
        if (j?.name) names.push(j.name);
      }
      if (names.length >= 2) {
        let p = names[0];
        for (let i = 1; i < names.length; i++) {
          let j = 0;
          while (j < p.length && j < names[i].length && p[j] === names[i][j]) j++;
          p = p.slice(0, j);
          if (!p) break;
        }
        p = p.replace(/[\s_/-]+$/, '');
        if (p.length >= 3) baseName = p;
      } else if (names.length === 1) baseName = names[0];
    } catch {}
  }
  if (!baseName) baseName = formatName(trackId);

  // Short layout name = layout name with the base track prefix stripped, so
  // "Red Bull Ring" reads as "Grand Prix". If stripping
  // would empty the string (e.g. the layout name IS the base name) we keep
  // the full name so the cell isn't blank.
  let shortLayout = layoutJsonName;
  if (shortLayout && baseName && shortLayout.toLowerCase().startsWith(baseName.toLowerCase())) {
    const stripped = shortLayout.slice(baseName.length).replace(/^[\s_/-]+/, '').trim();
    if (stripped) shortLayout = stripped;
  }
  if (!shortLayout && layoutId) shortLayout = formatName(layoutId);

  out.trackName  = baseName;
  out.layoutName = shortLayout;
  _trackLayoutCache.set(key, out);
  return out;
}

// Pulls everything the public profile needs in four small queries. Returns
// null when the player has never been seen by the panel (no row in players).
function getPublicPlayerData(guid) {
  if (!db || !/^\d{17}$/.test(guid)) return null;
  const player = db.prepare(`
    SELECT guid, name, nickname, nation, first_seen, last_seen, last_car, last_track
    FROM players WHERE guid = ?
  `).get(guid);
  if (!player) return null;

  const kpis = db.prepare(`
    SELECT
      COUNT(DISTINCT session_date)                       AS sessions,
      COUNT(id)                                          AS lap_count,
      COALESCE(SUM(ms), 0)                               AS total_ms,
      MIN(CASE WHEN valid = 1 THEN ms ELSE NULL END)     AS best_ms
    FROM laps WHERE driver_guid = ?
  `).get(guid) || { sessions: 0, lap_count: 0, total_ms: 0, best_ms: null };
  // Date of the fastest valid lap. Separate query because the aggregate above
  // can't reach the session_date of the row that owns the MIN(ms) — a naive
  // MIN(session_date) returns the earliest valid lap, not the date of the
  // fastest one. LIMIT 1 covers the case where multiple laps share the
  // millisecond-rounded record; we just pick one deterministically.
  let bestDate = '';
  if (kpis.best_ms) {
    const row = db.prepare(`
      SELECT session_date FROM laps
      WHERE driver_guid = ? AND valid = 1 AND ms = ?
      ORDER BY session_date DESC LIMIT 1
    `).get(guid, kpis.best_ms);
    bestDate = row?.session_date || '';
  }

  // Personal best per (track, layout, car), valid laps only. The session_date
  // is the day that best was set (MAX over rows tied on the min — SQLite
  // resolves the MAX deterministically, good enough for "last set on" copy).
  const personalBests = db.prepare(`
    SELECT track, track_config, car, MIN(ms) AS best_ms, MAX(session_date) AS last_date
    FROM laps
    WHERE driver_guid = ? AND valid = 1
    GROUP BY track, track_config, car
    ORDER BY track, track_config, car
  `).all(guid);

  // Latest 10 laps the driver has set, valid or invalid. id is monotonic
  // auto-increment so DESC sorts correctly even when session_date collides
  // (multiple laps in the same day or in the same session). Invalid laps
  // are kept because seeing "set a 1:45 but with 3 cuts" is more useful
  // than hiding it — the SSR table renders them strike-through.
  const recentLaps = db.prepare(`
    SELECT id, track, track_config, car, ms, cuts, valid, session_date
    FROM laps
    WHERE driver_guid = ?
    ORDER BY id DESC
    LIMIT 10
  `).all(guid);

  // Most-used car + most-played track, by raw lap count. Computed here so
  // the download-card endpoint doesn't need its own DB roundtrip, and so
  // the JSON shape surfaces them for Discord bots / external dashboards.
  // Counts laps (not sessions) — a driver who did 200 laps on one combo
  // and 50 on another reads more authentically as "Toyota AE86" than
  // sessions where they only joined briefly.
  const mostUsedCar = db.prepare(`
    SELECT car, COUNT(*) AS n
    FROM laps WHERE driver_guid = ?
    GROUP BY car ORDER BY n DESC LIMIT 1
  `).get(guid);
  const mostPlayedTrack = db.prepare(`
    SELECT track, track_config, COUNT(*) AS n
    FROM laps WHERE driver_guid = ?
    GROUP BY track, track_config ORDER BY n DESC LIMIT 1
  `).get(guid);

  // Driver's personal best valid lap on their most-played combo, regardless
  // of car. Surfaces as a card KPI ("récord en este tramo") so the visitor
  // can answer 'how fast does Driver usually go round here?' without
  // scanning the records / personal-bests tables. Null when the driver has
  // played the combo only with cuts (no valid lap) — the tile then shows
  // an em-dash like the other KPIs do for missing values.
  const bestOnMostPlayed = mostPlayedTrack ? db.prepare(`
    SELECT ms, car, session_date
    FROM laps
    WHERE driver_guid = ? AND track = ? AND track_config = ? AND valid = 1
    ORDER BY ms ASC LIMIT 1
  `).get(guid, mostPlayedTrack.track, mostPlayedTrack.track_config) : null;

  // Server records this player holds. A combo's record is the min(ms) across
  // every valid lap; the player owns the record when their min lap on that
  // combo equals the server-wide min. Tied lap times (rare but possible)
  // surface the player here as long as one of their laps matches the min.
  const records = db.prepare(`
    SELECT
      sb.track, sb.track_config, sb.car, sb.best_ms,
      (SELECT MAX(session_date) FROM laps
        WHERE driver_guid = ? AND valid = 1
          AND track = sb.track AND track_config = sb.track_config
          AND car = sb.car AND ms = sb.best_ms) AS set_date,
      (SELECT COUNT(*) FROM laps
        WHERE valid = 1
          AND track = sb.track AND track_config = sb.track_config
          AND car = sb.car AND ms = sb.best_ms
          AND driver_guid != ?) AS tied_others
    FROM (
      SELECT track, track_config, car, MIN(ms) AS best_ms
      FROM laps WHERE valid = 1
      GROUP BY track, track_config, car
    ) sb
    INNER JOIN laps me
      ON me.track        = sb.track
     AND me.track_config = sb.track_config
     AND me.car          = sb.car
     AND me.ms           = sb.best_ms
     AND me.driver_guid  = ?
     AND me.valid        = 1
    GROUP BY sb.track, sb.track_config, sb.car
    ORDER BY sb.best_ms ASC
  `).all(guid, guid, guid);

  return {
    player: {
      guid:      player.guid,
      name:      player.name || '',
      nickname:  player.nickname || '',
      nation:    player.nation || '',
      firstSeen: player.first_seen || '',
      lastSeen:  player.last_seen  || '',
      lastCar:   player.last_car   || '',
      lastTrack: player.last_track || '',
    },
    kpis: {
      sessions:   kpis.sessions   || 0,
      laps:       kpis.lap_count  || 0,
      totalMs:    kpis.total_ms   || 0,
      totalTime:  formatTotalTime(kpis.total_ms),
      bestMs:     kpis.best_ms    || null,
      bestDate:   bestDate,
      recordsHeld: records.length,
      mostUsedCar: mostUsedCar ? {
        car:      mostUsedCar.car,
        carName:  carDisplayName(mostUsedCar.car),
        laps:     mostUsedCar.n,
      } : null,
      mostPlayedTrack: mostPlayedTrack ? (() => {
        const td = _trackLayoutDisplay(mostPlayedTrack.track, mostPlayedTrack.track_config);
        return {
          track:       mostPlayedTrack.track,
          trackName:   td.trackName,
          trackConfig: mostPlayedTrack.track_config || '',
          layoutName:  td.layoutName,
          laps:        mostPlayedTrack.n,
        };
      })() : null,
      bestOnMostPlayed: bestOnMostPlayed ? {
        ms:      bestOnMostPlayed.ms,
        car:     bestOnMostPlayed.car,
        carName: carDisplayName(bestOnMostPlayed.car),
        date:    bestOnMostPlayed.session_date,
      } : null,
    },
    records: records.map(r => {
      const td = _trackLayoutDisplay(r.track, r.track_config);
      return {
        track:       r.track,
        trackName:   td.trackName,
        trackConfig: r.track_config || '',
        layoutName:  td.layoutName,
        car:         r.car,
        carName:     carDisplayName(r.car),
        ms:          r.best_ms,
        date:        r.set_date || '',
        tiedOthers:  r.tied_others || 0,
      };
    }),
    personalBests: personalBests.map(pb => {
      const td = _trackLayoutDisplay(pb.track, pb.track_config);
      return {
        track:       pb.track,
        trackName:   td.trackName,
        trackConfig: pb.track_config || '',
        layoutName:  td.layoutName,
        car:         pb.car,
        carName:     carDisplayName(pb.car),
        ms:          pb.best_ms,
        date:        pb.last_date || '',
      };
    }),
    recentLaps: recentLaps.map(rl => {
      const td = _trackLayoutDisplay(rl.track, rl.track_config);
      return {
        track:       rl.track,
        trackName:   td.trackName,
        trackConfig: rl.track_config || '',
        layoutName:  td.layoutName,
        car:         rl.car,
        carName:     carDisplayName(rl.car),
        ms:          rl.ms,
        cuts:        rl.cuts || 0,
        valid:       rl.valid === 1,
        date:        rl.session_date || '',
      };
    }),
  };
}

function apiPublicPlayer(req, res, guid) {
  if (!publicProfilesEnabled()) return json(res, 404, { error: 'Not Found' });
  if (!/^\d{17}$/.test(guid))    return json(res, 400, { error: 'Invalid Steam ID' });
  // Cheap per-IP throttle. The endpoint is unauthenticated and trivially
  // scannable (17-digit GUIDs are guessable), so cap at 30/min/IP — plenty
  // for an honest browser refreshing a profile page and a Discord bot polling
  // a handful of regulars, painful enough for a scraper trying to enumerate
  // the full leaderboard. All five `public-player` callsites share this
  // bucket so a hostile client can't multiplex across endpoints.
  if (!checkRateLimit('public-player', clientIp(req), 30, 60 * 1000)) {
    return json(res, 429, { error: 'Rate limit' });
  }
  const data = getPublicPlayerData(guid);
  if (!data) return json(res, 404, { error: 'Player not found' });
  json(res, 200, data);
}

// Tiny HTML escape; the page renders user-controllable strings (driver name,
// nickname). Escaping here keeps the SSR template injection-free without
// pulling in a templating dependency.
function _htmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _fmtLapMs(ms) {
  if (ms == null || ms <= 0) return '—';
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0');
  return `${m}:${s}`;
}

// ISO-3166-1 alpha-3 → alpha-2 lookup used by both the unicode-flag fallback
// and the flagcdn.com image URL. Mirrors the _NATION_ISO2 map in
// src/utils.jsx (panel UI side) so a driver's nation renders identically on
// the public page and inside the panel's Players table. Falls back to the
// raw value when it's already a 2-letter code.
const _NATION_ISO3_TO_ISO2 = {
  AFG:'AF',ALB:'AL',ALG:'DZ',AND:'AD',ANG:'AO',ARG:'AR',ARM:'AM',AUS:'AU',AUT:'AT',AZE:'AZ',
  BEL:'BE',BGR:'BG',BIH:'BA',BLR:'BY',BOL:'BO',BRA:'BR',BUL:'BG',CAN:'CA',CHE:'CH',CHI:'CL',
  CHN:'CN',COL:'CO',CRO:'HR',CYP:'CY',CZE:'CZ',DEN:'DK',DNK:'DK',ECU:'EC',EGY:'EG',ESP:'ES',
  EST:'EE',ETH:'ET',FIN:'FI',FRA:'FR',GBR:'GB',GEO:'GE',GER:'DE',DEU:'DE',GRE:'GR',GRC:'GR',
  HKG:'HK',HRV:'HR',HUN:'HU',IND:'IN',IRL:'IE',IRN:'IR',ISL:'IS',ISR:'IL',ITA:'IT',JPN:'JP',
  KAZ:'KZ',KOR:'KR',LAT:'LV',LTU:'LT',LUX:'LU',MAR:'MA',MEX:'MX',MKD:'MK',MNE:'ME',MON:'MC',
  NED:'NL',NLD:'NL',NOR:'NO',NZL:'NZ',PER:'PE',POL:'PL',POR:'PT',PRT:'PT',ROM:'RO',ROU:'RO',
  RSA:'ZA',ZAF:'ZA',RUS:'RU',SCO:'GB',SER:'RS',SRB:'RS',SLO:'SI',SVN:'SI',SVK:'SK',SPA:'ES',
  SUI:'CH',SWE:'SE',THA:'TH',TUN:'TN',TUR:'TR',UAE:'AE',UKR:'UA',URU:'UY',USA:'US',VEN:'VE',
  WAL:'GB',
};
function _nationToIso2(nation) {
  if (!nation || !/^[A-Za-z]{2,3}$/.test(nation)) return '';
  const u = nation.toUpperCase();
  if (u.length === 2) return u;
  return _NATION_ISO3_TO_ISO2[u] || '';
}
function _nationFlagUrl(nation, size) {
  const iso2 = _nationToIso2(nation);
  if (!iso2) return '';
  return `https://flagcdn.com/${size || '20x15'}/${iso2.toLowerCase()}.png`;
}

// SSR i18n dictionary for the public profile page. Three flat keysets (en /
// es / it) covering every visible label and template fragment. The helper
// resolvePublicLang() picks one based on a ?lang= query param (highest
// precedence — explicit override), then Accept-Language (visitor's browser
// preference), then panel_settings.lang (operator's panel default), then a
// last-resort 'en'. Kept inline because there are only ~25 keys; pulling in
// src/i18n.jsx server-side would mean either a separate JSON file or a
// React dependency we don't need.
const _PUBLIC_PROFILE_I18N = {
  en: {
    driver_profile:      'Driver profile',
    toggle_theme:        'Toggle theme',
    download_card:       'Download stat card',
    most_used_car:       'Most-used car',
    most_played_track:   'Most-played track',
    best_on_this_track:  'Best on this track',
    open_steam:          'Open Steam profile',
    in_game:             'in-game:',
    total_laps:          'Total laps',
    session_one:         'session',
    session_many:        'sessions',
    time_on_track:       'Time on track',
    since:               'since',
    best_lap:            'Best lap',
    on:                  'on',
    server_records:      'Server records',
    combos_owned:        'combos owned',
    server_records_held: 'Server records held',
    personal_bests:      'Personal bests',
    recent_laps:         'Recent laps',
    col_track:           'Track',
    col_car:             'Car',
    col_lap_time:        'Lap time',
    col_set_on:          'Set on',
    col_date:            'Date',
    cuts_short:          'cuts',
    invalid_short:       'invalid',
    no_records_yet:      'No server records yet — pick a combo nobody owns and set the bar.',
    no_valid_laps:       'No valid laps recorded yet.',
    no_recent_laps:      'No laps recorded yet.',
    powered_by:          'Powered by',
    desc_with_nickname:  (n, ig, l, t, r, b) => `${n} (${ig}) on Assetto Corsa: ${l} laps, ${t} on track, ${r} server record${r === 1 ? '' : 's'}, best lap ${b}.`,
    desc_no_nickname:    (n, l, t, r, b)     => `${n} on Assetto Corsa: ${l} laps, ${t} on track, ${r} server record${r === 1 ? '' : 's'}, best lap ${b}.`,
    desc_fallback:       'Driver profile.',
    title_suffix:        (l, b) => `${l} laps · best ${b}`,
  },
  es: {
    driver_profile:      'Perfil de piloto',
    toggle_theme:        'Cambiar tema',
    download_card:       'Descargar tarjeta',
    most_used_car:       'Coche más usado',
    most_played_track:   'Tramo más jugado',
    best_on_this_track:  'Récord en este tramo',
    open_steam:          'Abrir perfil de Steam',
    in_game:             'en juego:',
    total_laps:          'Vueltas totales',
    session_one:         'sesión',
    session_many:        'sesiones',
    time_on_track:       'Tiempo en pista',
    since:               'desde',
    best_lap:            'Mejor vuelta',
    on:                  'el',
    server_records:      'Récords del servidor',
    combos_owned:        'combos en propiedad',
    server_records_held: 'Récords del servidor en propiedad',
    personal_bests:      'Mejores tiempos personales',
    recent_laps:         'Últimas vueltas',
    col_track:           'Tramo',
    col_car:             'Coche',
    col_lap_time:        'Vuelta',
    col_set_on:          'Fecha',
    col_date:            'Fecha',
    cuts_short:          'cortes',
    invalid_short:       'no válida',
    no_records_yet:      'Sin récords del servidor todavía — elige un combo que nadie tenga y marca la pauta.',
    no_valid_laps:       'Aún no hay vueltas válidas registradas.',
    no_recent_laps:      'Aún no hay vueltas registradas.',
    powered_by:          'Hecho con',
    desc_with_nickname:  (n, ig, l, t, r, b) => `${n} (${ig}) en Assetto Corsa: ${l} vueltas, ${t} en pista, ${r} récord${r === 1 ? '' : 's'} del servidor, mejor vuelta ${b}.`,
    desc_no_nickname:    (n, l, t, r, b)     => `${n} en Assetto Corsa: ${l} vueltas, ${t} en pista, ${r} récord${r === 1 ? '' : 's'} del servidor, mejor vuelta ${b}.`,
    desc_fallback:       'Perfil de piloto.',
    title_suffix:        (l, b) => `${l} vueltas · mejor ${b}`,
  },
  it: {
    driver_profile:      'Profilo pilota',
    toggle_theme:        'Cambia tema',
    download_card:       'Scarica scheda',
    most_used_car:       'Auto più usata',
    most_played_track:   'Tracciato più giocato',
    best_on_this_track:  'Record su questo tracciato',
    open_steam:          'Apri profilo Steam',
    in_game:             'in-game:',
    total_laps:          'Giri totali',
    session_one:         'sessione',
    session_many:        'sessioni',
    time_on_track:       'Tempo in pista',
    since:               'dal',
    best_lap:            'Miglior giro',
    on:                  'il',
    server_records:      'Record del server',
    combos_owned:        'combo possedute',
    server_records_held: 'Record del server detenuti',
    personal_bests:      'Migliori tempi personali',
    recent_laps:         'Ultimi giri',
    col_track:           'Tracciato',
    col_car:             'Auto',
    col_lap_time:        'Giro',
    col_set_on:          'Data',
    col_date:            'Data',
    cuts_short:          'tagli',
    invalid_short:       'non valido',
    no_records_yet:      'Nessun record del server ancora — scegli una combo che nessuno detiene e fissa il limite.',
    no_valid_laps:       'Nessun giro valido registrato.',
    no_recent_laps:      'Nessun giro registrato.',
    powered_by:          'Powered by',
    desc_with_nickname:  (n, ig, l, t, r, b) => `${n} (${ig}) su Assetto Corsa: ${l} giri, ${t} in pista, ${r} record del server, miglior giro ${b}.`,
    desc_no_nickname:    (n, l, t, r, b)     => `${n} su Assetto Corsa: ${l} giri, ${t} in pista, ${r} record del server, miglior giro ${b}.`,
    desc_fallback:       'Profilo pilota.',
    title_suffix:        (l, b) => `${l} giri · miglior ${b}`,
  },
};

function _panelDefaultLang() {
  if (!db) return 'en';
  try {
    const row = db.prepare(`SELECT value FROM panel_settings WHERE key = 'lang'`).get();
    return (row?.value && _PUBLIC_PROFILE_I18N[row.value]) ? row.value : 'en';
  } catch { return 'en'; }
}

// Returns { theme, explicit }. Mirrors resolvePublicLang(): explicit URL
// override wins (so a shared link respects the sharer's chosen theme),
// otherwise default to dark — that's the design the SSR page was built
// against and matches the panel's own default. No Accept-Color-Scheme /
// prefers-color-scheme inspection here because (a) HTTP doesn't carry it
// natively and (b) the panel doesn't auto-detect system theme elsewhere.
function resolvePublicTheme(req) {
  try {
    const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
    const t = (qs.get('theme') || '').toLowerCase();
    if (t === 'light' || t === 'dark') return { theme: t, explicit: true };
  } catch {}
  return { theme: 'dark', explicit: false };
}

// Returns { lang, explicit } so the caller can decide whether to propagate
// the lang through to the OG image URL — when the visitor passed ?lang=
// explicitly, we want every downstream image fetch to honour that choice
// even if Discord's crawler (which doesn't send Accept-Language) is the one
// fetching the og:image. Auto-detected langs (via Accept-Language) stay
// out of the URL because they're visitor-specific, not link-specific.
function resolvePublicLang(req) {
  try {
    const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
    const q = (qs.get('lang') || '').toLowerCase();
    if (_PUBLIC_PROFILE_I18N[q]) return { lang: q, explicit: true };
  } catch {}
  const al = (req.headers && req.headers['accept-language']) || '';
  for (const tok of al.split(',')) {
    const t = tok.split(';')[0].trim().toLowerCase().slice(0, 2);
    if (_PUBLIC_PROFILE_I18N[t]) return { lang: t, explicit: false };
  }
  return { lang: _panelDefaultLang(), explicit: false };
}

function renderPublicPlayerHtml(data, origin, lang, langExplicit, theme, themeExplicit) {
  const T = _PUBLIC_PROFILE_I18N[lang] || _PUBLIC_PROFILE_I18N.en;
  const p = data.player;
  const k = data.kpis;
  const initial = (p.nickname || p.name || '?').slice(0, 1).toUpperCase();
  const displayName = p.nickname ? `${p.nickname} (${p.name})` : p.name;
  const bestLap = _fmtLapMs(k.bestMs);
  const title = `${displayName} · ${T.title_suffix(k.laps, bestLap)}`;
  const desc = !p.name
    ? T.desc_fallback
    : (p.nickname
        ? T.desc_with_nickname(p.nickname, p.name, k.laps, k.totalTime, k.recordsHeld, bestLap)
        : T.desc_no_nickname(p.name, k.laps, k.totalTime, k.recordsHeld, bestLap));

  // Pre-render the tables on the server so the page is meaningful without
  // executing JS — Discord/Twitter cards render this, and the panel's own
  // CSP doesn't allow inline script anyway.
  const recordsRows = data.records.length === 0
    ? `<tr><td colspan="4" class="empty-cell">${_htmlEsc(T.no_records_yet)}</td></tr>`
    : data.records.map(r => `
        <tr>
          <td>
            <div class="combo-track">${_htmlEsc(r.trackName)}</div>
            ${r.layoutName ? `<div class="combo-layout">${_htmlEsc(r.layoutName)}</div>` : ''}
          </td>
          <td class="muted">${_htmlEsc(r.carName)}</td>
          <td class="mono lap-time">${_fmtLapMs(r.ms)}</td>
          <td class="mono muted date">${_htmlEsc(r.date) || '—'}</td>
        </tr>`).join('');

  const pbRows = data.personalBests.length === 0
    ? `<tr><td colspan="4" class="empty-cell">${_htmlEsc(T.no_valid_laps)}</td></tr>`
    : data.personalBests.map(pb => `
        <tr>
          <td>
            <div class="combo-track">${_htmlEsc(pb.trackName)}</div>
            ${pb.layoutName ? `<div class="combo-layout">${_htmlEsc(pb.layoutName)}</div>` : ''}
          </td>
          <td class="muted">${_htmlEsc(pb.carName)}</td>
          <td class="mono lap-time">${_fmtLapMs(pb.ms)}</td>
          <td class="mono muted date">${_htmlEsc(pb.date) || '—'}</td>
        </tr>`).join('');

  // Recent-laps section: last 10 laps the driver has set (any combo, valid
  // or invalid). Surfaces "what did I do today" without forcing the visitor
  // to scroll through the records table. Invalid laps render with a muted
  // strike-through on the time + a "no válida" badge so the visitor can tell
  // at a glance.
  const recentRows = (data.recentLaps || []).length === 0
    ? `<tr><td colspan="4" class="empty-cell">${_htmlEsc(T.no_recent_laps)}</td></tr>`
    : data.recentLaps.map(rl => `
        <tr${rl.valid ? '' : ' class="lap-invalid"'}>
          <td>
            <div class="combo-track">${_htmlEsc(rl.trackName)}</div>
            ${rl.layoutName ? `<div class="combo-layout">${_htmlEsc(rl.layoutName)}</div>` : ''}
          </td>
          <td class="muted">${_htmlEsc(rl.carName)}</td>
          <td class="mono lap-time">${_fmtLapMs(rl.ms)}${rl.valid ? '' : ` <span class="lap-invalid-tag" title="${_htmlEsc(T.cuts_short)}: ${rl.cuts}">${_htmlEsc(T.invalid_short)}</span>`}</td>
          <td class="mono muted date">${_htmlEsc(rl.date) || '—'}</td>
        </tr>`).join('');

  // Real flag image from flagcdn.com via ISO3→ISO2. Previously used unicode
  // regional-indicator codepoints which render inconsistently on Windows
  // (often falls back to the letters 'ES'/'GB'/etc); a 20×15 PNG over HTTPS
  // is a few KB and renders the same on every platform.
  const flagUrl = _nationFlagUrl(p.nation, '20x15');
  const flagUrl2x = _nationFlagUrl(p.nation, '40x30');

  // og:image points at the per-driver PNG card so a paste in Discord/Twitter
  // gets a rich preview with the avatar + KPIs instead of a text-only embed.
  // PNG instead of SVG because Discord's parser doesn't render SVG and bails
  // with 'couldn't load image'. PNG is rendered server-side on demand from
  // the same SVG template (see apiPublicPlayerOgPng).
  //
  // The ?v=… on og:image is critical: Discord caches social-card images by
  // their URL forever (effectively — no public TTL). Without a versioned
  // URL, the very first preview Discord sees gets pinned across deploys
  // and data updates. We combine getBuildVersion() (rolls forward on every
  // panel deploy) with the driver's lastSeen date (rolls forward on every
  // session they close) — when either changes, Discord sees a different
  // image URL and re-fetches. The server-side handler ignores the query
  // (router strips it before matching) so the same physical PNG keeps
  // serving; only the cache key changes.
  //
  // When the page URL had an explicit ?lang=…, propagate it onto the OG URL
  // so Discord's preview matches the language the sharer chose — without
  // this, Discord's crawler (which doesn't send Accept-Language) falls
  // back to the panel's default lang and the preview disagrees with the
  // page the visitor sees.
  const ogUrl = `${origin}/p/${p.guid}`;
  const ogCacheBust = `${getBuildVersion()}-${(p.lastSeen || '').replace(/-/g, '')}`;
  const ogImageUrl = `${origin}/p/${p.guid}/og.png?v=${encodeURIComponent(ogCacheBust)}${langExplicit ? `&lang=${encodeURIComponent(lang)}` : ''}${themeExplicit ? `&theme=${encodeURIComponent(theme)}` : ''}`;

  // The theme toggle is an <a> that links to the current URL with ?theme=
  // flipped to the opposite. Existing ?lang= (when explicit) is preserved
  // so toggling theme doesn't accidentally reset the language. Anchor +
  // full reload (instead of inline JS toggling document.documentElement)
  // means the URL is the source of truth — refreshing or sharing the new
  // URL renders in that theme deterministically and the OG card follows.
  const oppositeTheme = theme === 'dark' ? 'light' : 'dark';
  const toggleQs = new URLSearchParams();
  if (langExplicit) toggleQs.set('lang', lang);
  toggleQs.set('theme', oppositeTheme);
  const themeToggleHref = `?${toggleQs.toString()}`;

  return `<!DOCTYPE html>
<html lang="${_htmlEsc(lang)}" data-theme="${_htmlEsc(theme)}">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta name="theme-color" content="#dc2626"/>
  <title>${_htmlEsc(title)}</title>
  <meta name="description" content="${_htmlEsc(desc)}"/>
  <meta property="og:type" content="profile"/>
  <meta property="og:title" content="${_htmlEsc(displayName)}"/>
  <meta property="og:description" content="${_htmlEsc(desc)}"/>
  <meta property="og:url" content="${_htmlEsc(ogUrl)}"/>
  <meta property="og:site_name" content="Assetto Server Panel"/>
  <meta property="og:image" content="${_htmlEsc(ogImageUrl)}"/>
  <meta property="og:image:width" content="1200"/>
  <meta property="og:image:height" content="630"/>
  <meta property="og:image:type" content="image/png"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:title" content="${_htmlEsc(displayName)}"/>
  <meta name="twitter:description" content="${_htmlEsc(desc)}"/>
  <meta name="twitter:image" content="${_htmlEsc(ogImageUrl)}"/>
  <link rel="icon" type="image/png" href="/src/assets/icon.png"/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
  <link rel="stylesheet" href="/src/styles.css"/>
  <style>
    /* Public-profile-specific layout. Inherits all the design tokens from
       styles.css (--red, --bg, --surface, --radius, etc.) so the look is
       continuous with the panel; only the wrapping geometry differs. */
    body { background: var(--bg-2); }
    .pp-wrap { max-width: 980px; margin: 0 auto; padding: 28px 24px 56px; }
    .pp-topbar {
      display: flex; align-items: center; gap: 12px;
      padding: 0 0 22px; border-bottom: 1px solid var(--border);
      margin-bottom: 28px;
    }
    .pp-topbar .brand-mark { width: 28px; height: 28px; border-radius: 6px; }
    .pp-topbar .brand-name { font-weight: 600; font-size: 14px; letter-spacing: -0.01em; }
    .pp-topbar .brand-sub  { font-size: 11.5px; color: var(--text-muted); }
    /* Download button — same square chip pattern as the theme toggle so
       the three controls (download, lang, theme) read as a coherent group
       on the right edge. Auto-margin sits on this one so it pushes
       everything after it to the right. */
    .pp-card-download {
      margin-left: auto;
      width: 32px; height: 32px; border-radius: var(--radius-sm);
      display: grid; place-items: center; color: var(--text-muted);
      background: transparent; border: 1px solid var(--border);
      cursor: pointer; text-decoration: none;
      transition: background 120ms ease, color 120ms ease;
    }
    .pp-card-download:hover { background: var(--bg-3); color: var(--text); }
    .pp-card-download svg { width: 14px; height: 14px; }

    /* Lang switcher: 3 flag chips on the right of the topbar, just before
       the theme toggle. The active language is outlined with the panel
       accent so the visitor sees which one is in effect; the others are
       muted until hovered. Click navigates with ?lang=xx; the server picks
       up the override (resolvePublicLang) and re-renders. */
    .pp-lang-switch {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px; border-radius: 999px;
      background: var(--bg-3); border: 1px solid var(--border);
    }
    .pp-lang-btn {
      display: inline-grid; place-items: center;
      width: 24px; height: 24px; border-radius: 50%;
      text-decoration: none; opacity: 0.55;
      transition: opacity 120ms ease, box-shadow 120ms ease;
    }
    .pp-lang-btn:hover  { opacity: 0.95; }
    .pp-lang-btn.active { opacity: 1; box-shadow: 0 0 0 2px var(--red); }
    .pp-lang-btn img    { display: block; border-radius: 2px; }

    .pp-theme-toggle {
      width: 32px; height: 32px; border-radius: var(--radius-sm);
      display: grid; place-items: center; color: var(--text-muted);
      background: transparent; border: 1px solid var(--border);
      cursor: pointer; transition: background 120ms ease, color 120ms ease;
      text-decoration: none;
    }
    .pp-theme-toggle:hover { background: var(--bg-3); color: var(--text); }
    .pp-theme-toggle svg { width: 14px; height: 14px; }
    /* Show sun when on dark theme (click → go light), moon when on light
       theme (click → go dark). Matches the panel-wide Topbar convention:
       icon represents the DESTINATION, not the current state. */
    [data-theme="dark"]  .pp-theme-icon-moon { display: none; }
    [data-theme="light"] .pp-theme-icon-sun  { display: none; }

    .pp-hero {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      display: flex; align-items: center; gap: 20px;
      box-shadow: var(--shadow-sm);
      margin-bottom: 18px;
    }
    .pp-avatar {
      width: 72px; height: 72px;
      border-radius: 50%;
      background: var(--red); color: #fff;
      display: grid; place-items: center;
      font-weight: 600; font-size: 28px;
      flex-shrink: 0;
      box-shadow: 0 4px 14px rgba(220,38,38,0.25);
    }
    .pp-id { flex: 1; min-width: 0; }
    .pp-name {
      font-size: 22px; font-weight: 600; letter-spacing: -0.02em;
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    }
    /* Real flag image (flagcdn.com 20x15 PNG, 2x for retina). Slight
       border-radius so the rectangle reads as a chip not a poster, and a
       subtle ring so a white-on-white case (e.g. JP, KR) doesn't disappear
       against the surface. */
    .pp-flag {
      display: inline-block;
      width: 20px; height: 15px;
      border-radius: 2px;
      box-shadow: 0 0 0 1px var(--border);
      vertical-align: middle;
    }
    /* Recent-laps invalid-row treatment: muted strikethrough on the time,
       small badge tag inline. Keeps the row visible — invalid laps still
       happened, just shouldn't be confused with the driver's bests. */
    .pp-table tr.lap-invalid .lap-time { color: var(--text-muted); text-decoration: line-through; text-decoration-thickness: 1px; }
    .lap-invalid-tag {
      display: inline-block; margin-left: 6px;
      padding: 1px 6px; border-radius: 999px;
      font-family: var(--font-sans); font-size: 10px; font-weight: 500;
      background: color-mix(in srgb, #f59e0b 14%, transparent);
      color: #b45309; border: 1px solid transparent;
      text-decoration: none;
      vertical-align: 1px;
    }
    [data-theme="dark"] .lap-invalid-tag { color: #fbbf24; }
    .pp-aka { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
    /* Badge is the Steam link itself: the whole chip is clickable, icon on
       the left identifies the destination, GUID renders to the right. No
       extra external-link icon — the chip-as-link pattern is enough. */
    .pp-guid {
      display: inline-flex; align-items: center; gap: 8px;
      margin-top: 10px; padding: 5px 12px 5px 10px;
      background: var(--bg-3); border: 1px solid var(--border);
      border-radius: 999px;
      font-family: var(--font-mono); font-size: 11.5px;
      color: var(--text-muted);
      text-decoration: none;
      transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
    }
    .pp-guid:hover {
      color: var(--text);
      background: var(--bg);
      border-color: var(--border-strong);
    }
    .pp-guid-steam { display: inline-flex; align-items: center; flex-shrink: 0; }
    .pp-guid-steam svg { width: 13px; height: 13px; }

    .pp-kpis {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 18px;
    }
    .pp-kpi {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 20px;
    }
    .pp-kpi-label {
      font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-muted);
      font-weight: 600;
    }
    .pp-kpi-value {
      font-size: 26px; font-weight: 600; letter-spacing: -0.02em;
      margin-top: 6px; line-height: 1;
      font-family: var(--font-mono);
    }
    .pp-kpi-meta { font-size: 11.5px; color: var(--text-muted); margin-top: 6px; }

    .pp-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      margin-bottom: 18px;
    }
    .pp-card-header {
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 12px;
    }
    .pp-card-title { font-size: 13px; font-weight: 600; }
    .pp-card-trophy { color: var(--red); }
    .pp-badge {
      margin-left: auto;
      display: inline-flex; align-items: center;
      padding: 2px 9px; border-radius: 999px;
      font-size: 11px; font-weight: 500;
      background: var(--bg-2); color: var(--text-muted);
      border: 1px solid var(--border);
    }
    .pp-badge-record {
      background: color-mix(in srgb, var(--red) 14%, transparent);
      color: var(--red); border-color: transparent;
    }

    .pp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .pp-table th, .pp-table td {
      text-align: left;
      padding: 11px 18px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .pp-table th {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-faint);
      font-weight: 600;
      background: var(--bg-2);
    }
    .pp-table tbody tr:last-child td { border-bottom: none; }
    .pp-table tbody tr:hover { background: var(--bg-2); }
    .combo-track  { font-weight: 500; }
    .combo-layout { font-size: 11.5px; color: var(--text-muted); margin-top: 2px; }
    .lap-time     { font-weight: 600; color: var(--text); }
    .empty-cell {
      text-align: center !important; padding: 28px 18px !important;
      color: var(--text-faint); font-style: italic;
    }
    .muted { color: var(--text-muted); }
    .mono  { font-family: var(--font-mono); font-size: 12px; }
    .date  { white-space: nowrap; }

    .pp-footer {
      margin-top: 26px;
      text-align: center;
      font-size: 11.5px;
      color: var(--text-faint);
    }
    .pp-footer a { color: var(--text-muted); text-decoration: none; }
    .pp-footer a:hover { color: var(--text); }

    @media (max-width: 700px) {
      .pp-wrap   { padding: 18px 14px 36px; }
      .pp-hero   { padding: 18px; gap: 14px; }
      .pp-avatar { width: 56px; height: 56px; font-size: 22px; }
      .pp-name   { font-size: 18px; }
      .pp-kpis   { grid-template-columns: 1fr 1fr; gap: 10px; }
      .pp-kpi    { padding: 14px 16px; }
      .pp-kpi-value { font-size: 20px; }
      .pp-card-header { padding: 12px 14px; }
      .pp-table th, .pp-table td { padding: 9px 12px; }
      .pp-card { overflow-x: auto; }
      .pp-table { min-width: 480px; }
    }
  </style>
</head>
<body>
  <div class="pp-wrap">
    <div class="pp-topbar">
      <img class="brand-mark" src="/src/assets/icon.png" alt=""/>
      <div>
        <div class="brand-name">Assetto Server Panel</div>
        <div class="brand-sub">${_htmlEsc(T.driver_profile)}</div>
      </div>
      <a class="pp-card-download" href="/p/${encodeURIComponent(p.guid)}/card.png${themeExplicit || langExplicit ? '?' : ''}${[
        themeExplicit ? `theme=${encodeURIComponent(theme)}` : '',
        langExplicit  ? `lang=${encodeURIComponent(lang)}`   : '',
      ].filter(Boolean).join('&')}" download="${_htmlEsc((p.name || 'driver').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'driver')}-${_htmlEsc(p.guid)}.png" aria-label="${_htmlEsc(T.download_card)}" title="${_htmlEsc(T.download_card)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </a>
      <div class="pp-lang-switch" role="group" aria-label="Language">
        ${['en','es','it'].map(code => {
          const flag = code === 'en' ? 'gb' : (code === 'es' ? 'es' : 'it');
          const active = code === lang;
          // Preserve any explicit theme on lang change so toggling language
          // doesn't accidentally reset the visitor's chosen colour scheme.
          const qs = new URLSearchParams();
          qs.set('lang', code);
          if (themeExplicit) qs.set('theme', theme);
          return `<a class="pp-lang-btn${active ? ' active' : ''}" href="?${qs.toString()}" aria-current="${active ? 'true' : 'false'}" aria-label="${_htmlEsc(code.toUpperCase())}">
            <img src="https://flagcdn.com/16x12/${flag}.png" srcset="https://flagcdn.com/16x12/${flag}.png 1x, https://flagcdn.com/32x24/${flag}.png 2x" alt="" width="16" height="12"/>
          </a>`;
        }).join('')}
      </div>
      <a class="pp-theme-toggle" href="${_htmlEsc(themeToggleHref)}" aria-label="${_htmlEsc(T.toggle_theme)}" title="${_htmlEsc(T.toggle_theme)}">
        <svg class="pp-theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
        </svg>
        <svg class="pp-theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      </a>
    </div>

    <div class="pp-hero">
      <div class="pp-avatar">${_htmlEsc(initial)}</div>
      <div class="pp-id">
        <div class="pp-name">
          <span>${_htmlEsc(p.nickname || p.name)}</span>
          ${flagUrl ? `<img class="pp-flag" src="${_htmlEsc(flagUrl)}" srcset="${_htmlEsc(flagUrl)} 1x, ${_htmlEsc(flagUrl2x)} 2x" alt="${_htmlEsc(p.nation)}" title="${_htmlEsc(p.nation)}" width="20" height="15"/>` : ''}
        </div>
        ${p.nickname ? `<div class="pp-aka">${_htmlEsc(T.in_game)} ${_htmlEsc(p.name)}</div>` : ''}
        <a class="pp-guid" href="https://steamcommunity.com/profiles/${_htmlEsc(p.guid)}" target="_blank" rel="noreferrer noopener" title="${_htmlEsc(T.open_steam)}">
          <span class="pp-guid-steam" aria-hidden="true">
            <svg viewBox="-1.5 0 259 259" fill="currentColor" stroke="none" aria-hidden="true">
              <path fill-rule="evenodd" d="M127.778579,0 C60.4203546,0 5.24030561,52.412282 0,119.013983 L68.7236558,147.68805 C74.5451924,143.665561 81.5845466,141.322185 89.1497766,141.322185 C89.8324924,141.322185 90.5059824,141.340637 91.1702465,141.377541 L121.735621,96.668877 L121.735621,96.0415165 C121.735621,69.1388208 143.425688,47.2457835 170.088511,47.2457835 C196.751333,47.2457835 218.441401,69.1388208 218.441401,96.0415165 C218.441401,122.944212 196.751333,144.846475 170.088511,144.846475 C169.719475,144.846475 169.359666,144.83725 168.99063,144.828024 L125.398299,176.205276 C125.425977,176.786507 125.444428,177.367738 125.444428,177.939743 C125.444428,198.144443 109.160732,214.575753 89.1497766,214.575753 C71.5836817,214.575753 56.8868387,201.917832 53.5655182,185.163615 L4.40997549,164.654462 C19.6326942,218.967277 69.0834655,258.786219 127.778579,258.786219 C198.596511,258.786219 256,200.847629 256,129.393109 C256,57.9293643 198.596511,0 127.778579,0 Z M80.3519677,196.332478 L64.6033732,189.763644 C67.389592,195.63131 72.2239585,200.539484 78.6359521,203.233444 C92.4932392,209.064206 108.472481,202.430791 114.247888,188.435116 C117.043333,181.663313 117.061785,174.190342 114.294018,167.400086 C111.526251,160.609831 106.295171,155.31417 99.5879487,152.491048 C92.9176301,149.695603 85.7767911,149.797088 79.5031858,152.186594 L95.777656,158.976849 C105.999942,163.276114 110.834309,175.122157 106.571948,185.436702 C102.318812,195.751247 90.574254,200.631743 80.3519677,196.332478 Z M202.30901,96.0424391 C202.30901,78.1165345 187.85204,63.5211763 170.092201,63.5211763 C152.323137,63.5211763 137.866167,78.1165345 137.866167,96.0424391 C137.866167,113.968344 152.323137,128.554476 170.092201,128.554476 C187.85204,128.554476 202.30901,113.968344 202.30901,96.0424391 Z M145.938821,95.9870838 C145.938821,82.4988323 156.779242,71.5661525 170.138331,71.5661525 C183.506646,71.5661525 194.347066,82.4988323 194.347066,95.9870838 C194.347066,109.475335 183.506646,120.408015 170.138331,120.408015 C156.779242,120.408015 145.938821,109.475335 145.938821,95.9870838 Z"/>
            </svg>
          </span>
          <span>${_htmlEsc(p.guid)}</span>
        </a>
      </div>
    </div>

    <div class="pp-kpis">
      <div class="pp-kpi">
        <div class="pp-kpi-label">${_htmlEsc(T.total_laps)}</div>
        <div class="pp-kpi-value">${k.laps.toLocaleString(lang === 'en' ? 'en' : (lang === 'es' ? 'es-ES' : 'it-IT'))}</div>
        <div class="pp-kpi-meta">${k.sessions} ${_htmlEsc(k.sessions === 1 ? T.session_one : T.session_many)}</div>
      </div>
      <div class="pp-kpi">
        <div class="pp-kpi-label">${_htmlEsc(T.time_on_track)}</div>
        <div class="pp-kpi-value">${_htmlEsc(k.totalTime)}</div>
        <div class="pp-kpi-meta">${p.firstSeen ? `${_htmlEsc(T.since)} ${_htmlEsc(p.firstSeen)}` : '—'}</div>
      </div>
      <div class="pp-kpi">
        <div class="pp-kpi-label">${_htmlEsc(T.best_lap)}</div>
        <div class="pp-kpi-value">${_fmtLapMs(k.bestMs)}</div>
        <div class="pp-kpi-meta">${k.bestDate ? `${_htmlEsc(T.on)} ${_htmlEsc(k.bestDate)}` : '—'}</div>
      </div>
      <div class="pp-kpi">
        <div class="pp-kpi-label">${_htmlEsc(T.server_records)}</div>
        <div class="pp-kpi-value">${k.recordsHeld}</div>
        <div class="pp-kpi-meta">${k.recordsHeld ? _htmlEsc(T.combos_owned) : '—'}</div>
      </div>
    </div>

    <div class="pp-card">
      <div class="pp-card-header">
        <svg class="pp-card-trophy" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/>
          <path d="M17 4h3v2a3 3 0 0 1-3 3M7 4H4v2a3 3 0 0 0 3 3"/>
        </svg>
        <div class="pp-card-title">${_htmlEsc(T.server_records_held)}</div>
        <span class="pp-badge ${data.records.length ? 'pp-badge-record' : ''}">${data.records.length}</span>
      </div>
      <table class="pp-table">
        <thead>
          <tr>
            <th>${_htmlEsc(T.col_track)}</th>
            <th>${_htmlEsc(T.col_car)}</th>
            <th style="width: 120px">${_htmlEsc(T.col_lap_time)}</th>
            <th style="width: 110px">${_htmlEsc(T.col_set_on)}</th>
          </tr>
        </thead>
        <tbody>${recordsRows}</tbody>
      </table>
    </div>

    <div class="pp-card">
      <div class="pp-card-header">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color: var(--text-muted)">
          <polyline points="3 17 9 11 13 15 21 7"/>
          <polyline points="14 7 21 7 21 14"/>
        </svg>
        <div class="pp-card-title">${_htmlEsc(T.personal_bests)}</div>
        <span class="pp-badge">${data.personalBests.length}</span>
      </div>
      <table class="pp-table">
        <thead>
          <tr>
            <th>${_htmlEsc(T.col_track)}</th>
            <th>${_htmlEsc(T.col_car)}</th>
            <th style="width: 120px">${_htmlEsc(T.col_lap_time)}</th>
            <th style="width: 110px">${_htmlEsc(T.col_set_on)}</th>
          </tr>
        </thead>
        <tbody>${pbRows}</tbody>
      </table>
    </div>

    <div class="pp-card">
      <div class="pp-card-header">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color: var(--text-muted)">
          <circle cx="12" cy="12" r="9"/>
          <polyline points="12 7 12 12 15 14"/>
        </svg>
        <div class="pp-card-title">${_htmlEsc(T.recent_laps)}</div>
        <span class="pp-badge">${(data.recentLaps || []).length}</span>
      </div>
      <table class="pp-table">
        <thead>
          <tr>
            <th>${_htmlEsc(T.col_track)}</th>
            <th>${_htmlEsc(T.col_car)}</th>
            <th style="width: 140px">${_htmlEsc(T.col_lap_time)}</th>
            <th style="width: 110px">${_htmlEsc(T.col_date)}</th>
          </tr>
        </thead>
        <tbody>${recentRows}</tbody>
      </table>
    </div>

    <div class="pp-footer">
      ${_htmlEsc(T.powered_by)} <a href="/">Assetto Server Panel</a>
    </div>
  </div>
<!-- Theme is now URL-controlled (?theme=light|dark); no client-side JS
       toggle needed. The /p/_theme.js endpoint is still served for
       backwards-compat with bookmarked pages that pre-date this change,
       but new HTML responses don't reference it. -->
</body>
</html>`;
}

// Tiny client-side theme toggle for the public profile page. Lives at a fixed
// URL so the page's <script src> is /-relative (CSP-friendly) and stays
// cacheable. No template substitution, no React — just persists the
// data-theme attribute through reloads via localStorage.
const _PUBLIC_PROFILE_THEME_JS = `(function(){
  try {
    var saved = localStorage.getItem('ac-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {}
  var btn = document.getElementById('pp-theme-btn');
  if (!btn) return;
  btn.addEventListener('click', function() {
    var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', cur);
    try { localStorage.setItem('ac-theme', cur); } catch (e) {}
  });
})();`;

// OpenGraph card as a 1200×630 SVG. Servers like Discord / Twitter / Mastodon
// fetch the og:image URL and embed the rendered preview alongside the link.
// SVG keeps the panel dep-free (no canvas/sharp/jimp/etc) — modern Discord
// renders SVG OG images, and the platforms that don't (older Twitter cache)
// fall back to text-only embed which is what we had before anyway. Cached
// 5 minutes at the edge so a popular profile doesn't re-render the SVG on
// every preview-bot fetch.
// Colour palettes for the OG card. Kept inline because the dark variant is
// what the SVG was originally designed with and the light variant just
// inverts the surface/text tokens — same red accent, same glow alpha
// behaviour just dampened on light bg. Adding a third theme later is a
// matter of dropping in a new entry here.
const _PUBLIC_PROFILE_OG_THEMES = {
  dark: {
    bgStart:    '#0b0b0d', bgEnd:    '#17171b',
    glowColor:  '#dc2626', glowAlpha: '0.35',
    brand:      '#a1a1aa', brandSub: '#71717a',
    name:       '#f4f4f5', aka:      '#a1a1aa', guid: '#71717a',
    cardBg:     '#131318', cardBorder:'#26262c',
    kpiLabel:   '#a1a1aa', kpiValue: '#f4f4f5', kpiMeta:'#71717a',
  },
  light: {
    bgStart:    '#ffffff', bgEnd:    '#f4f4f5',
    glowColor:  '#dc2626', glowAlpha: '0.12',
    brand:      '#52525b', brandSub: '#71717a',
    name:       '#18181b', aka:      '#52525b', guid: '#71717a',
    cardBg:     '#ffffff', cardBorder:'#e4e4e7',
    kpiLabel:   '#71717a', kpiValue: '#18181b', kpiMeta:'#a1a1aa',
  },
};

function renderPublicPlayerOgSvg(data, lang, theme) {
  const T = _PUBLIC_PROFILE_I18N[lang] || _PUBLIC_PROFILE_I18N.en;
  const C = _PUBLIC_PROFILE_OG_THEMES[theme] || _PUBLIC_PROFILE_OG_THEMES.dark;
  const p = data.player;
  const k = data.kpis;
  const initial = (p.nickname || p.name || '?').slice(0, 1).toUpperCase();
  const bestLap = _fmtLapMs(k.bestMs);
  const displayName = p.nickname || p.name || '—';
  const inGameLine  = p.nickname && p.name ? `${T.in_game} ${p.name}` : '';

  // Truncate the display name + in-game line so a 30-char alias doesn't
  // spill past the SVG bounds. The widths are eyeballed against the chosen
  // font-size; trim with a trailing ellipsis when over the cutoff.
  const truncate = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
  const nameTxt = _xmlEsc(truncate(displayName, 22));
  const igTxt   = _xmlEsc(truncate(inGameLine, 30));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" font-family="Inter, system-ui, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${C.bgStart}"/>
      <stop offset="100%" stop-color="${C.bgEnd}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${C.glowColor}" stop-opacity="${C.glowAlpha}"/>
      <stop offset="100%" stop-color="${C.glowColor}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="200" cy="240" r="320" fill="url(#glow)"/>

  <!-- Brand strip top -->
  <text x="60" y="80" fill="${C.brand}" font-size="22" font-weight="600" letter-spacing="2">ASSETTO SERVER PANEL</text>
  <text x="60" y="110" fill="${C.brandSub}" font-size="18">${_xmlEsc(T.driver_profile.toUpperCase())}</text>

  <!-- Avatar — same red across themes; the brand accent stays constant -->
  <circle cx="180" cy="320" r="100" fill="#dc2626"/>
  <text x="180" y="356" text-anchor="middle" fill="#fff" font-size="92" font-weight="700">${_xmlEsc(initial)}</text>

  <!-- Name + in-game line; Steam glyph sits before the GUID so the chip
       reads as a Steam profile id at a glance, matching the chip on the
       SSR /p/<guid> page. -->
  <text x="320" y="290" fill="${C.name}" font-size="64" font-weight="700">${nameTxt}</text>
  ${igTxt ? `<text x="320" y="340" fill="${C.aka}" font-size="26" font-weight="400">${igTxt}</text>` : ''}
  ${_steamGlyph(320, igTxt ? 374 : 334, 22, C.guid)}
  <text x="350" y="${igTxt ? '390' : '350'}" fill="${C.guid}" font-size="20" font-family="JetBrains Mono, ui-monospace, monospace">${_xmlEsc(p.guid)}</text>

  <!-- KPI strip -->
  <g transform="translate(60, 460)">
    ${[
      [T.total_laps,     String(k.laps),       k.sessions ? `${k.sessions} ${k.sessions === 1 ? T.session_one : T.session_many}` : ''],
      [T.time_on_track,  k.totalTime,          p.firstSeen ? `${T.since} ${p.firstSeen}` : ''],
      [T.best_lap,       bestLap,              k.bestDate ? `${T.on} ${k.bestDate}` : ''],
      [T.server_records, String(k.recordsHeld),k.recordsHeld ? T.combos_owned : ''],
    ].map((kpi, i) => `
      <g transform="translate(${i * 270}, 0)">
        <rect x="0" y="0" width="250" height="120" rx="12" fill="${C.cardBg}" stroke="${C.cardBorder}" stroke-width="1"/>
        <text x="20" y="30" fill="${C.kpiLabel}" font-size="14" font-weight="600" letter-spacing="1">${_xmlEsc(kpi[0].toUpperCase())}</text>
        <text x="20" y="80" fill="${C.kpiValue}" font-size="40" font-weight="700" font-family="JetBrains Mono, ui-monospace, monospace">${_xmlEsc(kpi[1])}</text>
        <text x="20" y="105" fill="${C.kpiMeta}" font-size="14">${_xmlEsc(kpi[2])}</text>
      </g>`).join('')}
  </g>
</svg>`;
}

// Steam glyph as an inline SVG path. Reused inside both the OG card and the
// download card next to the GUID so the chip reads as a Steam profile id at
// a glance, matching the chip on the SSR /p/<guid> page. Renders in
// whatever `currentColor` resolves to in the parent `<g>` so we can match
// the surrounding text colour per theme without duplicating the path.
const _STEAM_GLYPH_PATH = 'M127.778579,0 C60.4203546,0 5.24030561,52.412282 0,119.013983 L68.7236558,147.68805 C74.5451924,143.665561 81.5845466,141.322185 89.1497766,141.322185 C89.8324924,141.322185 90.5059824,141.340637 91.1702465,141.377541 L121.735621,96.668877 L121.735621,96.0415165 C121.735621,69.1388208 143.425688,47.2457835 170.088511,47.2457835 C196.751333,47.2457835 218.441401,69.1388208 218.441401,96.0415165 C218.441401,122.944212 196.751333,144.846475 170.088511,144.846475 C169.719475,144.846475 169.359666,144.83725 168.99063,144.828024 L125.398299,176.205276 C125.425977,176.786507 125.444428,177.367738 125.444428,177.939743 C125.444428,198.144443 109.160732,214.575753 89.1497766,214.575753 C71.5836817,214.575753 56.8868387,201.917832 53.5655182,185.163615 L4.40997549,164.654462 C19.6326942,218.967277 69.0834655,258.786219 127.778579,258.786219 C198.596511,258.786219 256,200.847629 256,129.393109 C256,57.9293643 198.596511,0 127.778579,0 Z M80.3519677,196.332478 L64.6033732,189.763644 C67.389592,195.63131 72.2239585,200.539484 78.6359521,203.233444 C92.4932392,209.064206 108.472481,202.430791 114.247888,188.435116 C117.043333,181.663313 117.061785,174.190342 114.294018,167.400086 C111.526251,160.609831 106.295171,155.31417 99.5879487,152.491048 C92.9176301,149.695603 85.7767911,149.797088 79.5031858,152.186594 L95.777656,158.976849 C105.999942,163.276114 110.834309,175.122157 106.571948,185.436702 C102.318812,195.751247 90.574254,200.631743 80.3519677,196.332478 Z M202.30901,96.0424391 C202.30901,78.1165345 187.85204,63.5211763 170.092201,63.5211763 C152.323137,63.5211763 137.866167,78.1165345 137.866167,96.0424391 C137.866167,113.968344 152.323137,128.554476 170.092201,128.554476 C187.85204,128.554476 202.30901,113.968344 202.30901,96.0424391 Z M145.938821,95.9870838 C145.938821,82.4988323 156.779242,71.5661525 170.138331,71.5661525 C183.506646,71.5661525 194.347066,82.4988323 194.347066,95.9870838 C194.347066,109.475335 183.506646,120.408015 170.138331,120.408015 C156.779242,120.408015 145.938821,109.475335 145.938821,95.9870838 Z';
function _steamGlyph(x, y, size, color) {
  // The path's natural viewBox is roughly 256×259. Scale uniformly.
  const scale = size / 256;
  return `<g transform="translate(${x},${y}) scale(${scale})"><path fill="${color}" fill-rule="evenodd" d="${_STEAM_GLYPH_PATH}"/></g>`;
}

// Minimal XML-escape for SVG text nodes. Mostly the same as HTML escape but
// kept separate as a marker — SVG/XML strictness around quoted attributes
// catches its own breed of injection if we ever inline an attribute value.
function _xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function apiPublicPlayerOgImage(req, res, guid) {
  if (!publicProfilesEnabled()) return respond(res, 404, 'text/plain; charset=utf-8', 'Not Found');
  if (!/^\d{17}$/.test(guid))    return respond(res, 400, 'text/plain; charset=utf-8', 'Invalid Steam ID');
  if (!checkRateLimit('public-player', clientIp(req), 120, 60 * 1000)) {
    return respond(res, 429, 'text/plain; charset=utf-8', 'Too many requests');
  }
  const data = getPublicPlayerData(guid);
  if (!data) return respond(res, 404, 'text/plain; charset=utf-8', 'Player not found');
  const { lang } = resolvePublicLang(req);
  const svg  = renderPublicPlayerOgSvg(data, lang);
  res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min — bots re-fetch on each link share
  respond(res, 200, 'image/svg+xml; charset=utf-8', svg);
}

// Read the panel icon once and cache it as a base64 data URL. Used to embed
// the logo inside the SVG card (resvg-js renders data:image/png from <image>
// elements). Falls back to empty string when the file isn't there so the
// card still renders without the logo block instead of erroring.
let _panelIconDataUrl = null;
function _getPanelIconDataUrl() {
  if (_panelIconDataUrl !== null) return _panelIconDataUrl;
  try {
    const p = path.join(ROOT, 'src', 'assets', 'icon-192.png');
    _panelIconDataUrl = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
  } catch (e) {
    log.warn('[card-png] panel icon unavailable:', e.message);
    _panelIconDataUrl = '';
  }
  return _panelIconDataUrl;
}

// Same dance for track map.png — read the file the live-map feature already
// knows how to locate (single-layout root or per-layout subdir, Kunos asset
// fallback) and inline it as base64 so resvg can rasterize the embedded
// reference. Cached per (trackId, layoutId) for process lifetime; the file
// can't change without an apiServerStop/Start sequence which respawns the
// node process and clears the cache.
const _trackMapDataUrlCache = new Map();
function _getTrackMapDataUrl(trackId, layoutId) {
  const key = `${trackId}|${layoutId || ''}`;
  if (_trackMapDataUrlCache.has(key)) return _trackMapDataUrlCache.get(key);
  const p = _trackMapPngPath(trackId, layoutId);
  if (!p) { _trackMapDataUrlCache.set(key, ''); return ''; }
  try {
    const url = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
    _trackMapDataUrlCache.set(key, url);
    return url;
  } catch (e) {
    log.warn('[card-png] track map read failed for', trackId, layoutId || '(root)', ':', e.message);
    _trackMapDataUrlCache.set(key, '');
    return '';
  }
}

// Downloadable stat card: a slightly richer / shareable variant of the OG
// preview. Same 1200×630 canvas (Discord-friendly aspect, also fine for a
// fullsize export), same theme palette table, but with five KPI tiles
// instead of four and a row showing the most-used car + most-played track
// — data the OG card doesn't surface. Includes the panel logo embedded as
// a data: image and a small footer hint with the public profile URL so a
// downloaded image still tells the recipient where to look.
function renderPublicPlayerCardSvg(data, lang, theme, origin) {
  const T = _PUBLIC_PROFILE_I18N[lang] || _PUBLIC_PROFILE_I18N.en;
  const C = _PUBLIC_PROFILE_OG_THEMES[theme] || _PUBLIC_PROFILE_OG_THEMES.dark;
  const p = data.player;
  const k = data.kpis;
  const initial = (p.nickname || p.name || '?').slice(0, 1).toUpperCase();
  const bestLap = _fmtLapMs(k.bestMs);
  const displayName = p.nickname || p.name || '—';
  const inGameLine  = p.nickname && p.name ? `${T.in_game} ${p.name}` : '';
  const truncate = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
  const nameTxt = _xmlEsc(truncate(displayName, 22));
  const igTxt   = _xmlEsc(truncate(inGameLine, 30));

  // Raw car name fed into splitTwoLines below — DO NOT pre-truncate, the
  // splitter needs the full word boundaries to balance properly. Previous
  // version truncated to 14 chars first, leaving 'Toyota…' which
  // then split into 'Toyota' / 'Honda…' — losing the actual brand.
  const carNameFull = k.mostUsedCar ? k.mostUsedCar.carName : '—';
  const trackName   = k.mostPlayedTrack ? truncate(k.mostPlayedTrack.trackName, 14) : '—';
  const trackLayout = k.mostPlayedTrack && k.mostPlayedTrack.layoutName
    ? truncate(k.mostPlayedTrack.layoutName, 18) : '';

  // 5 KPI tiles in a single row at the bottom. ~210px wide each, 24px gaps,
  // so 5*210 + 4*24 = 1146 — leaves 27px margin on each side at canvas 1200.
  // Text-valued tiles (car names) split into two lines on 3+ words so a
  // mod-pack-prefixed name like 'Toyota AE86' shows entirely
  // ('Toyota' / 'CRX EE8') instead of being truncated after the
  // boring prefix. Numeric tiles stay single-line at 32px monospace.
  const lapsWord = lang === 'es' ? 'vueltas' : lang === 'it' ? 'giri' : 'laps';
  const lapWord  = lang === 'es' ? 'vuelta'  : lang === 'it' ? 'giro' : 'lap';

  // Split a text value into 1 or 2 lines, greedy by character budget so
  // 'Toyota AE86' becomes 'Toyota' + 'CRX EE8' (each
  // line fits the ~178px tile width at 20px font, roughly 16 chars). The
  // single-line path keeps short names like 'Ferrari F40' on one row.
  const splitTwoLines = (s, maxPerLine = 16) => {
    const words = String(s || '').split(/\s+/).filter(Boolean);
    if (words.length === 0) return ['—', ''];
    // 1-2 words and short enough → single line.
    const joined = words.join(' ');
    if (words.length === 1 || joined.length <= maxPerLine) return [truncate(joined, maxPerLine), ''];
    // Greedy pack line 1 as many words as fit, line 2 takes the rest
    // (truncated if it overflows). Keeps line 1 dominant which reads more
    // naturally for 'Brand Model Variant' patterns.
    let line1 = words[0];
    let i = 1;
    while (i < words.length && (line1 + ' ' + words[i]).length <= maxPerLine) {
      line1 += ' ' + words[i];
      i++;
    }
    const remainder = words.slice(i).join(' ');
    return [line1, truncate(remainder, maxPerLine)];
  };

  const kpis = [
    { label: T.total_laps,        value: String(k.laps),               value2: '', meta: k.sessions ? `${k.sessions} ${k.sessions === 1 ? T.session_one : T.session_many}` : '',                       isText: false },
    { label: T.time_on_track,     value: k.totalTime,                  value2: '', meta: p.firstSeen ? `${T.since} ${p.firstSeen}` : '',                                                            isText: false },
    (() => {
      const [v1, v2] = splitTwoLines(carNameFull);
      return { label: T.most_used_car, value: v1, value2: v2, meta: k.mostUsedCar ? `${k.mostUsedCar.laps} ${k.mostUsedCar.laps === 1 ? lapWord : lapsWord}` : '', isText: true };
    })(),
    { label: T.best_on_this_track,value: k.bestOnMostPlayed ? _fmtLapMs(k.bestOnMostPlayed.ms) : '—', value2: '', meta: k.bestOnMostPlayed ? truncate(k.bestOnMostPlayed.carName, 22) : '',           isText: false },
    { label: T.server_records,    value: String(k.recordsHeld),        value2: '', meta: k.recordsHeld ? T.combos_owned : '',                                                                       isText: false },
  ];

  const logo = _getPanelIconDataUrl();
  const profileShortUrl = `${origin.replace(/^https?:\/\//, '')}/p/${p.guid}`;

  // Map thumbnail for the most-played combo, when the track has a map.png
  // and a calibration ini on disk (covers ~all mod + Kunos tracks after
  // the 'copy missing map files to prod' pass earlier today). Inverted on
  // dark theme so the typical white-bg + dark-trail map.png reads against
  // the slate gradient; left as-is on light theme. preserveAspectRatio
  // keeps non-square tracks (touge hill climbs etc.) from squishing.
  const mapDataUrl = k.mostPlayedTrack
    ? _getTrackMapDataUrl(k.mostPlayedTrack.track, k.mostPlayedTrack.trackConfig)
    : '';
  // The AC map.png ships anti-aliased with a low-contrast trail colour
  // that fades into a #ffffff card surface to nearly invisible. Tried two
  // approaches: (a) RGB contrast-boost with feComponentTransfer — didn't
  // recover enough density because the trail's antialiased edges live in
  // the alpha channel, not RGB. (b) Always invert the map AND give its
  // container rect a dark fill regardless of theme — produces a sharp
  // white-trail-on-dark thumbnail that pops as a focal element on the
  // light card while staying cohesive on the dark one (the dark rect is
  // already the dark theme's cardBg). Going with (b).
  const mapImageFilter = 'filter="url(#mapInvert)"';
  const mapRectFill    = '#131318'; // matches the dark theme's cardBg
  const mapRectStroke  = theme === 'dark' ? C.cardBorder : '#131318'; // invisible border on light to keep it a clean rectangle

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" font-family="Inter, system-ui, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${C.bgStart}"/>
      <stop offset="100%" stop-color="${C.bgEnd}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${C.glowColor}" stop-opacity="${C.glowAlpha}"/>
      <stop offset="100%" stop-color="${C.glowColor}" stop-opacity="0"/>
    </radialGradient>
    <!-- Colour-matrix invert used to flip the AC track silhouette PNG
         from its native white-bg/dark-trail layout to a dark-bg/light-trail
         visual matching the card's dark theme. Alpha row left at identity
         so transparent pixels in the source stay transparent. -->
    <filter id="mapInvert" x="0%" y="0%" width="100%" height="100%">
      <feColorMatrix type="matrix" values="-1 0 0 0 1  0 -1 0 0 1  0 0 -1 0 1  0 0 0 1 0"/>
    </filter>
    <!-- Light-theme contrast booster: pushes any RGB value below 50%
         toward 0 (true black) and amplifies the rest, so a faint AC
         trail at ~40% grey reads sharp on the white card surface. The
         linear transform on each channel is slope*x + intercept; with
         slope=2 / intercept=-1 the function is f(x)=2x−1 clamped to
         [0,1], i.e. midpoint 0.5 becomes 0 and 1.0 stays 1.0. Alpha
         is left untouched so transparent map backgrounds keep showing
         the card surface beneath. -->
    <filter id="mapEnhanceLight" x="0%" y="0%" width="100%" height="100%">
      <feComponentTransfer>
        <feFuncR type="linear" slope="2" intercept="-1"/>
        <feFuncG type="linear" slope="2" intercept="-1"/>
        <feFuncB type="linear" slope="2" intercept="-1"/>
      </feComponentTransfer>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="200" cy="240" r="320" fill="url(#glow)"/>

  <!-- Brand strip with embedded logo. Logo positioned so its vertical
       midpoint lines up with the midpoint of the two text lines (centre
       around y=82); 44px logo at y=60 puts the centre at y=82. Previously
       at y=48 the logo sat too high relative to the text. -->
  ${logo ? `<image href="${logo}" x="60" y="60" width="44" height="44" preserveAspectRatio="xMidYMid meet"/>` : ''}
  <text x="${logo ? 120 : 60}" y="80" fill="${C.brand}" font-size="22" font-weight="600" letter-spacing="2">ASSETTO SERVER PANEL</text>
  <text x="${logo ? 120 : 60}" y="104" fill="${C.brandSub}" font-size="16">${_xmlEsc(T.driver_profile.toUpperCase())}</text>

  <!-- Avatar -->
  <circle cx="180" cy="280" r="92" fill="#dc2626"/>
  <text x="180" y="314" text-anchor="middle" fill="#fff" font-size="84" font-weight="700">${_xmlEsc(initial)}</text>

  <!-- Name + in-game + GUID; Steam glyph before the GUID for instant
       recognition (same pattern as the OG card and the SSR page chip). -->
  <text x="310" y="252" fill="${C.name}" font-size="56" font-weight="700">${nameTxt}</text>
  ${igTxt ? `<text x="310" y="296" fill="${C.aka}" font-size="22" font-weight="400">${igTxt}</text>` : ''}
  ${_steamGlyph(310, igTxt ? 322 : 280, 18, C.guid)}
  <text x="336" y="${igTxt ? '336' : '294'}" fill="${C.guid}" font-size="18" font-family="JetBrains Mono, ui-monospace, monospace">${_xmlEsc(p.guid)}</text>

  ${mapDataUrl ? `
  <!-- Most-played track silhouette, upper-right corner. Rect fill is the
       dark surface regardless of theme so the inverted (white-trail) map
       reads sharply on both light and dark cards. -->
  <g transform="translate(990, 60)">
    <rect x="0" y="0" width="170" height="170" rx="14" fill="${mapRectFill}" stroke="${mapRectStroke}" stroke-width="1"/>
    <image href="${mapDataUrl}" x="12" y="12" width="146" height="146" preserveAspectRatio="xMidYMid meet" ${mapImageFilter}/>
  </g>
  <text x="1075" y="252" text-anchor="middle" fill="${C.brandSub}" font-size="12" font-weight="600" letter-spacing="1">${_xmlEsc(T.most_played_track.toUpperCase())}</text>
  <text x="1075" y="272" text-anchor="middle" fill="${C.name}" font-size="15" font-weight="600">${_xmlEsc(trackName)}</text>
  ${trackLayout ? `<text x="1075" y="290" text-anchor="middle" fill="${C.kpiMeta}" font-size="12">${_xmlEsc(trackLayout)}</text>` : ''}
  ` : ''}

  <!-- KPI row (5 tiles). Labels render at natural width (no textLength —
       previously fixed-width labels stretched short ones and squished
       long ones, producing inconsistent visual weight across tiles).
       Text values may span 1 or 2 lines (see splitTwoLines above) — when
       2 lines, font shrinks to 20px so both fit cleanly between label
       (y=28) and meta (y=118). Numeric values stay single-line monospace
       at 32px. -->
  <g transform="translate(27, 414)">
    ${kpis.map((kpi, i) => {
      const hasTwoLines = !!kpi.value2;
      const valueFont = kpi.isText ? (hasTwoLines ? 20 : 24) : 32;
      const valueFamily = kpi.isText ? '' : 'font-family="JetBrains Mono, ui-monospace, monospace"';
      const line1Y = hasTwoLines ? 70 : (kpi.isText ? 80 : 82);
      const line2Y = hasTwoLines ? 96 : 0;
      return `
      <g transform="translate(${i * 234}, 0)">
        <rect x="0" y="0" width="210" height="140" rx="12" fill="${C.cardBg}" stroke="${C.cardBorder}" stroke-width="1"/>
        <text x="16" y="28" fill="${C.kpiLabel}" font-size="11" font-weight="600" letter-spacing="1">${_xmlEsc(kpi.label.toUpperCase())}</text>
        <text x="16" y="${line1Y}" fill="${C.kpiValue}" font-size="${valueFont}" font-weight="700" ${valueFamily}>${_xmlEsc(kpi.value)}</text>
        ${hasTwoLines ? `<text x="16" y="${line2Y}" fill="${C.kpiValue}" font-size="${valueFont}" font-weight="700">${_xmlEsc(kpi.value2)}</text>` : ''}
        <text x="16" y="118" fill="${C.kpiMeta}" font-size="13">${_xmlEsc(kpi.meta)}</text>
      </g>`;
    }).join('')}
  </g>

  <!-- Footer with public URL — gives anyone who sees the saved PNG a way back -->
  <text x="1140" y="600" text-anchor="end" fill="${C.kpiMeta}" font-size="14" font-family="JetBrains Mono, ui-monospace, monospace">${_xmlEsc(profileShortUrl)}</text>
</svg>`;
}

function apiPublicPlayerCardPng(req, res, guid) {
  if (!publicProfilesEnabled()) return respond(res, 404, 'text/plain; charset=utf-8', 'Not Found');
  if (!/^\d{17}$/.test(guid))    return respond(res, 400, 'text/plain; charset=utf-8', 'Invalid Steam ID');
  if (!checkRateLimit('public-player', clientIp(req), 120, 60 * 1000)) {
    return respond(res, 429, 'text/plain; charset=utf-8', 'Too many requests');
  }
  const data = getPublicPlayerData(guid);
  if (!data) return respond(res, 404, 'text/plain; charset=utf-8', 'Player not found');
  const resvg = _loadResvg();
  if (!resvg) return _fallbackOgPng(res);
  try {
    const { lang }  = resolvePublicLang(req);
    const { theme } = resolvePublicTheme(req);
    const proto = requestIsHttps(req) ? 'https' : 'http';
    const host  = req.headers.host || 'localhost';
    const svg   = renderPublicPlayerCardSvg(data, lang, theme, `${proto}://${host}`);
    const png   = new resvg.Resvg(svg, {
      fitTo: { mode: 'width', value: 1200 },
      font: {
        loadSystemFonts:  true,
        defaultFontFamily: 'DejaVu Sans',
        sansSerifFamily:   'DejaVu Sans',
        monospaceFamily:   'DejaVu Sans Mono',
      },
    }).render().asPng();
    // No edge cache: this is the download endpoint, the user explicitly
    // requested a fresh copy. Sub-100ms render is fine on every hit.
    res.setHeader('Cache-Control', 'no-store');
    // Suggest a filename so the browser saves it cleanly. Slug the in-game
    // name + first chunk of GUID; sanitise to ASCII / safe punctuation so
    // every OS accepts the resulting download.
    const slug = (data.player.name || 'driver').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'driver';
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-${guid}.png"`);
    respond(res, 200, 'image/png', png);
  } catch (e) {
    log.warn('[card-png] render failed for', guid, ':', e.message);
    _fallbackOgPng(res);
  }
}

// PNG version of the OG card. Discord, Slack and older Twitter parsers don't
// render SVG as og:image — they fail outright with 'Couldn't load image'.
// Rendering server-side via @resvg/resvg-js (pure WASM, no native binding,
// no system fonts needed because the SVG uses fallback families) produces a
// 1200×630 PNG every parser accepts. Lazy-loaded so the panel boot doesn't
// pay the WASM init cost when the OG endpoint is never hit, and the import
// failure (e.g. resvg-js not installed on a stale prod) doesn't crash the
// process — falls back to the static panel-logo PNG instead.
let _resvgLazy = null;
function _loadResvg() {
  if (_resvgLazy !== null) return _resvgLazy;
  try { _resvgLazy = require('@resvg/resvg-js'); }
  catch (e) { log.warn('[og-png] @resvg/resvg-js unavailable:', e.message); _resvgLazy = false; }
  return _resvgLazy;
}
function _fallbackOgPng(res) {
  // Static panel logo as the worst-case fallback — at least Discord shows
  // SOMETHING instead of "couldn't load image".
  const p = path.join(ROOT, 'src', 'assets', 'icon-512.png');
  fs.readFile(p, (err, data) => {
    if (err) return respond(res, 500, 'text/plain; charset=utf-8', 'OG fallback unavailable');
    res.setHeader('Cache-Control', 'public, max-age=300');
    respond(res, 200, 'image/png', data);
  });
}
function apiPublicPlayerOgPng(req, res, guid) {
  if (!publicProfilesEnabled()) return respond(res, 404, 'text/plain; charset=utf-8', 'Not Found');
  if (!/^\d{17}$/.test(guid))    return respond(res, 400, 'text/plain; charset=utf-8', 'Invalid Steam ID');
  if (!checkRateLimit('public-player', clientIp(req), 120, 60 * 1000)) {
    return respond(res, 429, 'text/plain; charset=utf-8', 'Too many requests');
  }
  const data = getPublicPlayerData(guid);
  if (!data) return respond(res, 404, 'text/plain; charset=utf-8', 'Player not found');

  const resvg = _loadResvg();
  if (!resvg) return _fallbackOgPng(res);
  try {
    const { lang }  = resolvePublicLang(req);
    const { theme } = resolvePublicTheme(req);
    const svg  = renderPublicPlayerOgSvg(data, lang, theme);
    // fitTo width:1200 matches the SVG's intrinsic viewBox so the output
    // is the exact 1200×630 Discord/Twitter expect for summary_large_image
    // cards. Font config: resvg ships no fonts of its own, so it MUST load
    // them from somewhere or every <text> element renders invisibly.
    // loadSystemFonts:true scans the host font directories (on a typical
    // Linux box that's /usr/share/fonts → DejaVu Sans / DejaVu Sans Mono);
    // the default* families below tell resvg what to substitute for the
    // generic CSS families the SVG references (Inter, JetBrains Mono, etc.)
    // when the exact face isn't installed. Pinning to DejaVu specifically
    // keeps rendering deterministic across the dev/prod boxes and the
    // operator doesn't need to install custom fonts for the OG card to
    // work — DejaVu ships with the systemd / fonts-dejavu Debian/Arch
    // packages by default.
    const png = new resvg.Resvg(svg, {
      fitTo: { mode: 'width', value: 1200 },
      font: {
        loadSystemFonts:  true,
        defaultFontFamily: 'DejaVu Sans',
        sansSerifFamily:   'DejaVu Sans',
        monospaceFamily:   'DejaVu Sans Mono',
      },
    }).render().asPng();
    res.setHeader('Cache-Control', 'public, max-age=300');
    respond(res, 200, 'image/png', png);
  } catch (e) {
    log.warn('[og-png] render failed for', guid, ':', e.message);
    _fallbackOgPng(res);
  }
}

function apiPublicPlayerPage(req, res, guid) {
  if (!publicProfilesEnabled()) return respond(res, 404, 'text/plain; charset=utf-8', 'Public profiles disabled');
  if (!/^\d{17}$/.test(guid))    return respond(res, 400, 'text/plain; charset=utf-8', 'Invalid Steam ID');
  if (!checkRateLimit('public-player', clientIp(req), 120, 60 * 1000)) {
    return respond(res, 429, 'text/plain; charset=utf-8', 'Too many requests');
  }
  const data = getPublicPlayerData(guid);
  if (!data) return respond(res, 404, 'text/plain; charset=utf-8', 'Player not found');
  // Origin for absolute OG URLs. Honours TRUST_PROXY if Cloudflare is in front
  // — operators behind a tunnel get the public hostname instead of 127.0.0.1.
  const proto = requestIsHttps(req) ? 'https' : 'http';
  const host  = req.headers.host || 'localhost';
  const { lang,  explicit: langExplicit  } = resolvePublicLang(req);
  const { theme, explicit: themeExplicit } = resolvePublicTheme(req);
  const html  = renderPublicPlayerHtml(data, `${proto}://${host}`, lang, langExplicit, theme, themeExplicit);
  res.setHeader('Cache-Control', 'no-store');
  respond(res, 200, 'text/html; charset=utf-8', html);
}

// Mtime-keyed memoization for the heavy content listings. /api/cars and /api/tracks
// hit hundreds of files per call; the panel SPA polls them on every login. Cached
// result is invalidated when (a) the parent directory's mtime changes (new mod added,
// renamed, deleted) or (b) processModBuffer explicitly calls invalidateContentCache.
const _contentCache = { cars: null, tracks: null };
function invalidateContentCache(which) {
  if (!which || which === 'cars')   _contentCache.cars   = null;
  if (!which || which === 'tracks') _contentCache.tracks = null;
}
async function maybeInvalidateByMtime(key, dir) {
  try {
    const st = await fsp.stat(dir);
    const cached = _contentCache[key];
    if (cached && cached.mtime === st.mtimeMs) return cached;
    return { mtime: st.mtimeMs, data: null };
  } catch { return { mtime: 0, data: null }; }
}

async function apiCars(res) {
  try {
    const probe = await maybeInvalidateByMtime('cars', AC_CARS_DIR);
    if (probe.data) return json(res, 200, probe.data);
    const dirs = await fsp.readdir(AC_CARS_DIR);
    const cars = await Promise.all(
      dirs.map(async id => {
        const acUiDir  = path.join(AC_CARS_DIR, id, 'ui');
        const knUiDir  = path.join(KUNOS_ASSETS_DIR, 'cars', id, 'ui');
        const knSkinDir = path.join(KUNOS_ASSETS_DIR, 'cars', id, 'skins');

        // ui_car.json: AC content first, kunos assets as fallback
        let ui = {};
        try { ui = parseLooseJson(await fsp.readFile(path.join(acUiDir, 'ui_car.json'), 'utf8'), `car/${id}`); } catch {
          try { ui = parseLooseJson(await fsp.readFile(path.join(knUiDir, 'ui_car.json'), 'utf8'), `kunos-car/${id}`); } catch {}
        }

        // skins: AC content first, kunos assets as fallback
        let skins = [];
        let skinsFromKunos = false;
        try {
          const entries = await fsp.readdir(path.join(AC_CARS_DIR, id, 'skins'), { withFileTypes: true });
          skins = entries.filter(e => e.isDirectory()).map(e => e.name);
        } catch {}
        if (skins.length === 0) {
          try {
            const entries = await fsp.readdir(knSkinDir, { withFileTypes: true });
            skins = entries.filter(e => e.isDirectory()).map(e => e.name);
            if (skins.length > 0) skinsFromKunos = true;
          } catch {}
        }

        const cls = ui.class || ui.tags?.[0] || '';

        // thumb: prefer first-skin preview, fallback to badge
        let thumb = null;
        if (skins.length > 0) {
          const prefix = skinsFromKunos
            ? `/api/content/cars/${encodeURIComponent(id)}/kunos-skin/${encodeURIComponent(skins[0])}/preview`
            : `/api/content/cars/${encodeURIComponent(id)}/skins/${encodeURIComponent(skins[0])}/preview`;
          thumb = prefix;
        } else {
          const hasThumb = await Promise.any([
            fsp.access(path.join(acUiDir, 'badge.webp')),
            fsp.access(path.join(acUiDir, 'badge.png')),
            fsp.access(path.join(knUiDir, 'badge.webp')),
            fsp.access(path.join(knUiDir, 'badge.png')),
          ]).then(() => true).catch(() => false);
          if (hasThumb) thumb = `/api/content/cars/${encodeURIComponent(id)}/thumb`;
        }

        const brand = inferBrand(id, ui.brand || '');
        return {
          id,
          name:        ui.name  || formatName(id),
          brand,
          brandLogo:   brandLogoUrl(brand),
          cls,
          year:        ui.year  || '',
          description: stripHtml(ui.description || '').slice(0, 500),
          specs: {
            bhp:      ui.specs?.bhp      || '',
            torque:   ui.specs?.torque   || '',
            weight:   ui.specs?.weight   || '',
            topspeed: ui.specs?.topspeed || '',
          },
          skins,
          thumb,
          isKunos: KUNOS_CAR_IDS.has(id),
        };
      })
    );
    const sorted = cars.sort((a, b) => a.name.localeCompare(b.name));
    _contentCache.cars = { mtime: probe.mtime, data: sorted };
    json(res, 200, sorted);
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

async function apiTracks(res) {
  try {
    const probe = await maybeInvalidateByMtime('tracks', AC_TRACKS_DIR);
    if (probe.data) return json(res, 200, probe.data);
    const dirs = await fsp.readdir(AC_TRACKS_DIR);
    const tracks = await Promise.all(dirs.map(async id => {
      const uiDir    = path.join(AC_TRACKS_DIR, id, 'ui');
      const knUiDir  = path.join(KUNOS_ASSETS_DIR, 'tracks', id, 'ui');
      let mainJson = null;
      let layouts  = [];

      // Try direct ui_track.json (single-layout tracks)
      try {
        mainJson = parseLooseJson(await fsp.readFile(path.join(uiDir, 'ui_track.json'), 'utf8'));
      } catch {}

      // Scan for layout sub-directories
      try {
        const entries = await fsp.readdir(uiDir, { withFileTypes: true });
        const layoutDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
        if (layoutDirs.length > 0) {
          layouts = layoutDirs;
          if (!mainJson) {
            try {
              mainJson = parseLooseJson(
                await fsp.readFile(path.join(uiDir, layoutDirs[0], 'ui_track.json'), 'utf8')
              );
            } catch {}
          }
        }
      } catch {}

      if (!layouts.length) layouts = [''];

      // Kunos assets fallback: use kunos ui_track.json when AC info is missing/empty
      let kunosJson = null;
      if (KUNOS_TRACK_IDS.has(id)) {
        try { kunosJson = parseLooseJson(await fsp.readFile(path.join(knUiDir, 'ui_track.json'), 'utf8')); } catch {
          // try first kunos layout subdir
          try {
            const knEntries = await fsp.readdir(knUiDir, { withFileTypes: true });
            const knFirst = knEntries.find(e => e.isDirectory());
            if (knFirst) kunosJson = parseLooseJson(await fsp.readFile(path.join(knUiDir, knFirst.name, 'ui_track.json'), 'utf8'));
          } catch {}
        }
      }

      // Merge: AC data takes priority, kunos fills in blanks
      if (!mainJson) mainJson = {};
      if (kunosJson) {
        if (!mainJson.name)        mainJson.name        = kunosJson.name;
        if (!mainJson.country)     mainJson.country     = kunosJson.country;
        if (!mainJson.city)        mainJson.city        = kunosJson.city;
        if (!mainJson.description) mainJson.description = kunosJson.description;
        if (!mainJson.length)      mainJson.length      = kunosJson.length;
        if (!mainJson.pitboxes)    mainJson.pitboxes    = kunosJson.pitboxes;
      }

      // Per-layout details (only for multi-layout tracks)
      let layoutDetails = {};
      if (layouts.length > 1 || (layouts.length === 1 && layouts[0] !== '')) {
        for (const layout of layouts) {
          if (!layout) continue;
          let lJson = {};
          try { lJson = parseLooseJson(await fsp.readFile(path.join(uiDir, layout, 'ui_track.json'), 'utf8')); } catch {}
          layoutDetails[layout] = {
            name:        lJson.name        || mainJson.name    || formatName(id),
            description: stripHtml(lJson.description || mainJson.description || '').slice(0, 400),
            length:      parseTrackLength(lJson.length  || mainJson.length),
            pits:        parseInt(lJson.pitboxes ?? mainJson.pitboxes) || 0,
            thumb:       `/api/content/tracks/${encodeURIComponent(id)}/layout/${encodeURIComponent(layout)}/thumb`,
          };
        }
      }

      const rawCountry = mainJson.country || '';
      const rawCity    = mainJson.city    || '';
      return {
        id,
        name:          mainJson.name    || formatName(id),
        city:          rawCity || rawCountry,
        country:       rawCountry,
        countryEs:     countryEs(rawCountry),
        flag:          countryFlag(rawCountry),
        length:        parseTrackLength(mainJson.length),
        pits:          parseInt(mainJson.pitboxes) || 0,
        layouts,
        layoutDetails,
        description:   stripHtml(mainJson.description || '').slice(0, 400),
        thumb:         `/api/content/tracks/${encodeURIComponent(id)}/thumb`,
        isKunos:       KUNOS_TRACK_IDS.has(id),
      };
    }));
    const sorted = tracks.sort((a, b) => a.name.localeCompare(b.name));
    _contentCache.tracks = { mtime: probe.mtime, data: sorted };
    json(res, 200, sorted);
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Admin-only recursive delete of a mod car or mod track from the AC content
// directory. Refuses Kunos IDs (the bundled DLC catalogue is the source of
// truth for the kunos toggle on the panel — wiping it would break the asset
// fallback resolution the rest of the panel relies on). The mtime-keyed
// content cache invalidates itself on the next GET because removing the
// directory changes the parent's mtime.
async function apiContentDelete(req, res, kind, id) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (!isValidContentId(id)) return json(res, 400, { error: 'Invalid ID' });
  const isCar    = kind === 'cars';
  const kunosSet = isCar ? KUNOS_CAR_IDS : KUNOS_TRACK_IDS;
  if (kunosSet.has(id)) return json(res, 403, { error: 'Kunos content cannot be deleted' });
  const baseDir  = isCar ? AC_CARS_DIR : AC_TRACKS_DIR;
  const target   = path.resolve(path.join(baseDir, id));
  // Defense in depth on top of isValidContentId — make absolutely sure the
  // resolved path is still inside the content root before rm -rf.
  if (!target.startsWith(path.resolve(baseDir) + path.sep)) {
    return json(res, 400, { error: 'Invalid path' });
  }
  try {
    // lstat (not stat) so a symlink planted as `content/cars/<id>` does NOT
    // resolve through to its target before deletion. fsp.rm with
    // { recursive: true } would otherwise traverse the symlink and wipe
    // whatever it points at — e.g. a malicious mod extracts a dir-symlink
    // `cars/evil -> /etc` and a later admin delete becomes `rm -rf /etc`.
    // Refuse symlinks at the top level; the underlying directory itself is
    // what we deleted, never a target reachable through a link.
    const st = await fsp.lstat(target).catch(() => null);
    if (!st) return json(res, 404, { error: 'Not found' });
    if (st.isSymbolicLink()) {
      // Unlink the link itself, not its target. Audit the refusal so an
      // operator can investigate how a symlink got there in the first place.
      await fsp.unlink(target).catch(() => {});
      insertAuditLog(checkAnyAuth(req)?.username || 'unknown', isCar ? 'car.delete.symlink' : 'track.delete.symlink', id, 'symlink unlinked, target preserved');
      return json(res, 200, { ok: true, symlink: true });
    }
    if (!st.isDirectory()) return json(res, 404, { error: 'Not found' });
    await fsp.rm(target, { recursive: true, force: true });
    insertAuditLog(checkAnyAuth(req)?.username || 'unknown', isCar ? 'car.delete' : 'track.delete', id);
    json(res, 200, { ok: true });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Serve car badge image (badge.png/webp from ui folder), falling back to bundled Kunos assets
function apiCarThumb(carId, res) {
  if (!isValidContentId(carId)) return respond(res, 400, 'text/plain', 'Invalid ID');
  const dir     = path.join(AC_CARS_DIR, carId, 'ui');
  const kunosDir = path.join(KUNOS_ASSETS_DIR, 'cars', carId, 'ui');
  serveAssetFallback(res, [
    { path: path.join(dir,      'badge.webp'), mime: 'image/webp' },
    { path: path.join(dir,      'badge.png'),  mime: 'image/png'  },
    { path: path.join(kunosDir, 'badge.webp'), mime: 'image/webp' },
    { path: path.join(kunosDir, 'badge.png'),  mime: 'image/png'  },
  ]);
}

// Serve a specific car skin preview (skins/{name}/preview.webp/jpg/png)
function apiCarSkinPreview(carId, skinName, res) {
  if (!isValidContentId(carId) || !isValidSkinName(skinName))
    return respond(res, 400, 'text/plain', 'Invalid ID');
  const dir      = path.join(AC_CARS_DIR, carId, 'skins', skinName);
  const kunosDir = path.join(KUNOS_ASSETS_DIR, 'cars', carId, 'skins', skinName);
  if (!dir.startsWith(AC_CARS_DIR + path.sep))
    return respond(res, 403, 'text/plain', 'Forbidden');
  serveAssetFallback(res, [
    { path: path.join(dir,      'preview.webp'), mime: 'image/webp' },
    { path: path.join(dir,      'preview.jpg'),  mime: 'image/jpeg' },
    { path: path.join(dir,      'preview.png'),  mime: 'image/png'  },
    { path: path.join(kunosDir, 'preview.webp'), mime: 'image/webp' },
    { path: path.join(kunosDir, 'preview.jpg'),  mime: 'image/jpeg' },
    { path: path.join(kunosDir, 'preview.png'),  mime: 'image/png'  },
  ]);
}

// Serve skin preview from bundled Kunos assets (for cars without skins in AC content)
function apiKunosSkinPreview(carId, skinName, res) {
  if (!isValidContentId(carId) || !isValidSkinName(skinName))
    return respond(res, 400, 'text/plain', 'Invalid ID');
  const dir = path.join(KUNOS_ASSETS_DIR, 'cars', carId, 'skins', skinName);
  // Defense in depth: even though the ID validators reject `..`/slashes, assert the
  // resolved path stays under KUNOS_ASSETS_DIR. Mirrors the guard in apiCarSkinPreview.
  if (!dir.startsWith(KUNOS_ASSETS_DIR + path.sep))
    return respond(res, 403, 'text/plain', 'Forbidden');
  serveAssetFallback(res, [
    { path: path.join(dir, 'preview.webp'), mime: 'image/webp' },
    { path: path.join(dir, 'preview.jpg'),  mime: 'image/jpeg' },
    { path: path.join(dir, 'preview.png'),  mime: 'image/png'  },
  ]);
}

// Serve track preview image, falling back to layout sub-folders then bundled Kunos assets
// (Kunos assets may also use layout sub-folders for multi-layout tracks)
async function apiTrackThumb(trackId, res) {
  if (!isValidContentId(trackId)) return respond(res, 400, 'text/plain', 'Invalid ID');
  const uiDir    = path.join(AC_TRACKS_DIR, trackId, 'ui');
  const kunosDir = path.join(KUNOS_ASSETS_DIR, 'tracks', trackId, 'ui');

  const subDir = async (dir) => {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const first = entries.find(e => e.isDirectory());
      return first ? first.name : null;
    } catch { return null; }
  };

  const [acSub, kunosSub] = await Promise.all([subDir(uiDir), subDir(kunosDir)]);

  serveAssetFallback(res, [
    { path: path.join(uiDir,    'preview.webp'),                    mime: 'image/webp' },
    { path: path.join(uiDir,    'preview.png'),                     mime: 'image/png'  },
    ...(acSub    ? [{ path: path.join(uiDir,    acSub,    'preview.webp'), mime: 'image/webp' },
                    { path: path.join(uiDir,    acSub,    'preview.png'),  mime: 'image/png'  }] : []),
    { path: path.join(kunosDir, 'preview.webp'),                    mime: 'image/webp' },
    { path: path.join(kunosDir, 'preview.png'),                     mime: 'image/png'  },
    ...(kunosSub ? [{ path: path.join(kunosDir, kunosSub, 'preview.webp'), mime: 'image/webp' },
                    { path: path.join(kunosDir, kunosSub, 'preview.png'),  mime: 'image/png'  }] : []),
  ]);
}

// Serve a specific layout's preview.png/webp, falling back to bundled Kunos assets
function apiTrackLayoutThumb(trackId, layout, res) {
  if (!isValidContentId(trackId) || !isValidContentId(layout))
    return respond(res, 400, 'text/plain', 'Invalid ID');
  const dir      = path.join(AC_TRACKS_DIR, trackId, 'ui', layout);
  if (!dir.startsWith(AC_TRACKS_DIR + path.sep))
    return respond(res, 403, 'text/plain', 'Forbidden');
  const kunosDir = path.join(KUNOS_ASSETS_DIR, 'tracks', trackId, 'ui');
  serveAssetFallback(res, [
    { path: path.join(dir,      'preview.webp'), mime: 'image/webp' },
    { path: path.join(dir,      'preview.png'),  mime: 'image/png'  },
    { path: path.join(kunosDir, 'preview.webp'), mime: 'image/webp' },
    { path: path.join(kunosDir, 'preview.png'),  mime: 'image/png'  },
  ]);
}

// ── Track minimap (Live position telemetry) ──────────────────────────────────
// AC ships a `map.png` (top-down silhouette of the trail) and a `data/map.ini`
// with the world→pixel calibration inside every track folder. Single-layout
// tracks (Monza, Spa, …) put both at the track root; multi-layout tracks
// (Red Bull Ring, Nordschleife, Silverstone, …) put one pair per layout dir.
// The same projection is what Content Manager + CSP use for their minimaps,
// so we don't have to invent geometry — we just expose what's already there.
//
// Cache strategy: paths and parsed INI are memoized for process lifetime
// because acServer can't repaint these files without an `apiServerRestart`
// (which respawns this node too). Image bytes themselves are served with a
// long Cache-Control because /api/session/apply already restarts the panel
// to pick up new content.

function _trackMapPngPath(trackId, layout) {
  if (!isValidContentId(trackId)) return null;
  if (layout && !isValidContentId(layout)) return null;
  const candidates = [];
  if (layout) {
    candidates.push(path.join(AC_TRACKS_DIR, trackId, layout, 'map.png'));
    candidates.push(path.join(KUNOS_ASSETS_DIR, 'tracks', trackId, layout, 'map.png'));
  }
  // Single-layout tracks put the file at the track root; this also acts as a
  // fallback for multi-layout tracks that share one map across variants.
  candidates.push(path.join(AC_TRACKS_DIR, trackId, 'map.png'));
  candidates.push(path.join(KUNOS_ASSETS_DIR, 'tracks', trackId, 'map.png'));
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

function _trackMapIniPath(trackId, layout) {
  if (!isValidContentId(trackId)) return null;
  if (layout && !isValidContentId(layout)) return null;
  const candidates = [];
  if (layout) {
    candidates.push(path.join(AC_TRACKS_DIR, trackId, layout, 'data', 'map.ini'));
    candidates.push(path.join(KUNOS_ASSETS_DIR, 'tracks', trackId, layout, 'data', 'map.ini'));
  }
  candidates.push(path.join(AC_TRACKS_DIR, trackId, 'data', 'map.ini'));
  candidates.push(path.join(KUNOS_ASSETS_DIR, 'tracks', trackId, 'data', 'map.ini'));
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

const _trackMapMetaCache = new Map();
function getTrackMapMeta(trackId, layout) {
  const key = `${trackId}|${layout || ''}`;
  if (_trackMapMetaCache.has(key)) return _trackMapMetaCache.get(key);
  const iniPath = _trackMapIniPath(trackId, layout);
  if (!iniPath) { _trackMapMetaCache.set(key, null); return null; }
  try {
    const ini = parseINI(fs.readFileSync(iniPath, 'utf8'));
    const p = ini.PARAMETERS || {};
    const meta = {
      width:        parseFloat(p.WIDTH)        || 0,
      height:       parseFloat(p.HEIGHT)       || 0,
      xOffset:      parseFloat(p.X_OFFSET)     || 0,
      zOffset:      parseFloat(p.Z_OFFSET)     || 0,
      scaleFactor:  parseFloat(p.SCALE_FACTOR) || 1,
      margin:       parseFloat(p.MARGIN)       || 0,
      drawingSize:  parseFloat(p.DRAWING_SIZE) || 10,
    };
    _trackMapMetaCache.set(key, meta);
    return meta;
  } catch { _trackMapMetaCache.set(key, null); return null; }
}

function apiTrackMap(req, res, trackId) {
  if (!isValidContentId(trackId)) return respond(res, 400, 'text/plain', 'Invalid ID');
  const qs = new URLSearchParams(req.url.split('?')[1] || '');
  const layout = qs.get('layout') || '';
  if (layout && !isValidContentId(layout)) return respond(res, 400, 'text/plain', 'Invalid layout');
  const png = _trackMapPngPath(trackId, layout);
  if (!png) return respond(res, 404, 'text/plain', 'No map.png for this track/layout');
  fs.readFile(png, (err, data) => {
    if (err) return respond(res, err.code === 'ENOENT' ? 404 : 500, 'text/plain', err.code || err.message);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    respond(res, 200, 'image/png', data);
  });
}

function apiTrackMapMeta(req, res, trackId) {
  if (!isValidContentId(trackId)) return json(res, 400, { error: 'Invalid ID' });
  const qs = new URLSearchParams(req.url.split('?')[1] || '');
  const layout = qs.get('layout') || '';
  if (layout && !isValidContentId(layout)) return json(res, 400, { error: 'Invalid layout' });
  const meta = getTrackMapMeta(trackId, layout);
  if (!meta) return json(res, 404, { error: 'No map.ini for this track/layout' });
  json(res, 200, meta);
}

// ── Player kick / ban ─────────────────────────────────────────────────────────
async function apiPlayerKick(req, res) {
  if (!checkPermission(req, 'playerModeration')) return json(res, 403, { error: 'Forbidden' });
  try {
    const body  = await readBody(req);
    const carId = body.carId;
    if (carId === undefined) return json(res, 400, { error: 'carId required' });
    const result = await new Promise(resolve => {
      const r = http.request(
        { hostname: '127.0.0.1', port: AC_HTTP_PORT, path: '/api/kick', method: 'POST',
          headers: { 'Content-Type': 'application/json' }, timeout: 2000 },
        resp => {
          let data = '';
          resp.on('data', d => data += d);
          resp.on('end', () => resolve({ status: resp.statusCode || 0, body: data }));
        }
      );
      r.on('error', e   => resolve({ status: 0, error: e.message }));
      r.setTimeout(2000, () => { r.destroy(); resolve({ status: 0, error: 'AC server timeout' }); });
      r.write(JSON.stringify({ car_id: carId }));
      r.end();
    });
    if (result.error || result.status === 0)
      return json(res, 502, { error: result.error || 'AC server unreachable' });
    if (result.status >= 400)
      return json(res, 502, { error: `AC server rejected kick: HTTP ${result.status}` });
    const actor = checkAnyAuth(req)?.username || 'unknown';
    insertAuditLog(actor, 'player.kick', String(carId));
    json(res, 200, { ok: true });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Process-wide mutex chain used by every endpoint that mutates a flat-file
// list (blacklist.txt, whitelist.txt). Without this, two concurrent ban
// requests can both pass the "is it already in the file?" check before
// either appends, or a whitelist replace can clobber an append that landed
// between read and write. The chain is keyed by path so blacklist and
// whitelist don't block each other.
//
// The Map stores a "safe tail" — a promise that always resolves — so a
// single fn() throwing doesn't poison the chain and reject every later
// waiter. The returned promise from withFileLock still rejects with fn's
// real error, so callers see failures normally.
const _fileLocks = new Map();
function withFileLock(filePath, fn) {
  const prev = _fileLocks.get(filePath) || Promise.resolve();
  const tail = prev.then(() => fn());
  _fileLocks.set(filePath, tail.then(() => {}, () => {}));
  return tail;
}

// Ban a player. The legacy contract (just guid + name) still works — body
// without `reason` or `durationDays` produces a permanent ban with empty
// reason, identical to the pre-1.4.0 behaviour. New optional fields:
//
//   reason         : free-form text, capped at 240 chars, control chars stripped.
//   durationDays   : positive integer = TTL in days (sweeper auto-unbans on
//                    expiry); 0 / null / undefined = permanent.
//
// State is duplicated to both `bans` (the rich metadata table) and the AC
// server's `blacklist.txt` (the source of truth for acServer's in-game gate).
// They are synced by the file lock + the sweeper. The blacklist.txt line is
// only the 17-digit GUID — acServer doesn't read reasons; the panel does.
async function apiPlayerBan(req, res) {
  if (!checkPermission(req, 'playerModeration')) return json(res, 403, { error: 'Forbidden' });
  try {
    const body = await readBody(req);
    const guid = String(body.guid || '').trim();
    if (!/^\d{17}$/.test(guid)) return json(res, 400, { error: 'guid must be 17 digits' });

    const reason = String(body.reason || '').replace(/[\r\n\t\0]/g, ' ').trim().slice(0, 240);
    const nameSnap = String(body.name || '').replace(/[\r\n\t\0]/g, ' ').trim().slice(0, 64);
    const durationDays = body.durationDays == null ? 0 : parseInt(body.durationDays, 10);
    if (!Number.isFinite(durationDays) || durationDays < 0 || durationDays > 36500) {
      return json(res, 400, { error: 'durationDays must be 0 (permanent) or 1..36500' });
    }

    const actor = checkAnyAuth(req)?.username || 'unknown';
    let expiresAt = null;
    if (durationDays > 0) {
      expiresAt = new Date(Date.now() + durationDays * 86400 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    }

    if (db) {
      try {
        db.prepare(`INSERT INTO bans (guid, name_snapshot, reason, banned_by, expires_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(guid) DO UPDATE SET
                      name_snapshot = excluded.name_snapshot,
                      reason        = excluded.reason,
                      banned_by     = excluded.banned_by,
                      banned_at     = datetime('now'),
                      expires_at    = excluded.expires_at`)
          .run(guid, nameSnap, reason, actor, expiresAt);
      } catch (e) { log.warn('[bans] DB insert failed:', e.message); }
    }

    await withFileLock(AC_BLACKLIST, async () => {
      let existing = '';
      try { existing = await fsp.readFile(AC_BLACKLIST, 'utf8'); } catch {}
      const guids = existing.split('\n').map(s => s.trim()).filter(Boolean);
      if (!guids.includes(guid)) await fsp.appendFile(AC_BLACKLIST, guid + '\n');
    });

    const detail = [
      nameSnap || null,
      reason ? `reason="${reason}"` : null,
      durationDays > 0 ? `duration=${durationDays}d` : 'permanent',
    ].filter(Boolean).join(' · ');
    insertAuditLog(actor, 'player.ban', guid, detail);
    json(res, 200, { ok: true, expiresAt });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Lift a ban: remove the GUID from blacklist.txt AND drop the bans row.
// Used both by the manual "Unban" button and by the TTL sweeper below.
// `actor` is the username of the operator (or 'system' when called by the
// sweeper); the audit row distinguishes manual vs automatic via the action
// column (`player.unban` vs `player.unban.expired`).
async function _unbanInternal(guid, actor, action) {
  if (!/^\d{17}$/.test(guid)) return false;
  await withFileLock(AC_BLACKLIST, async () => {
    let raw = '';
    try { raw = await fsp.readFile(AC_BLACKLIST, 'utf8'); } catch {}
    const ids = raw.split('\n').map(s => s.trim()).filter(Boolean);
    const next = ids.filter(g => g !== guid);
    if (next.length !== ids.length) {
      await fsp.writeFile(AC_BLACKLIST, next.join('\n') + (next.length ? '\n' : ''), 'utf8');
    }
  });
  let removed = false;
  if (db) {
    try {
      const r = db.prepare('DELETE FROM bans WHERE guid = ?').run(guid);
      removed = r.changes > 0;
    } catch {}
  }
  insertAuditLog(actor, action, guid);
  return removed;
}

async function apiPlayerUnban(req, res, guid) {
  if (!checkPermission(req, 'playerModeration')) return json(res, 403, { error: 'Forbidden' });
  if (!/^\d{17}$/.test(guid)) return json(res, 400, { error: 'guid must be 17 digits' });
  try {
    const actor = checkAnyAuth(req)?.username || 'unknown';
    await _unbanInternal(guid, actor, 'player.unban');
    json(res, 200, { ok: true });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// List active + recently-expired bans. The UI builds its "Bans" view off
// this; the playerModeration permission gates both ban creation and the
// list (the same permission either grants both or neither, by design).
function apiBansList(req, res) {
  if (!checkPermission(req, 'playerModeration')) return json(res, 403, { error: 'Forbidden' });
  if (!db) return json(res, 200, []);
  try {
    const rows = db.prepare(`
      SELECT guid, name_snapshot, reason, banned_by, banned_at, expires_at
      FROM bans
      ORDER BY (expires_at IS NULL) DESC, banned_at DESC
    `).all();
    const now = Date.now();
    const out = rows.map(r => ({
      guid:        r.guid,
      name:        r.name_snapshot || '',
      reason:      r.reason || '',
      bannedBy:    r.banned_by || '',
      bannedAt:    r.banned_at || '',
      expiresAt:   r.expires_at || null,
      permanent:   !r.expires_at,
      expired:     !!r.expires_at && (new Date(r.expires_at + 'Z').getTime() < now),
    }));
    json(res, 200, out);
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// ── Session presets (saved bundles of trackId + slots + weather + …) ─────────
// Storage is a JSON blob in `session_presets.config` so the shape stays in
// lockstep with the client's `sessionCfg` and /api/session/apply's body — adding
// a session field in the future doesn't need a column. Load-into-session is
// purely a client move (GET the row, drop it into sessionCfg, navigate to the
// Session page, user reviews and pushes Apply), so there is no /apply endpoint
// here — that would mean two paths to acServer with subtly different validation.
const PRESET_NAME_MAX = 120;
const PRESET_DESC_MAX = 500;

// Shape the row into the wire format the frontend expects, including a small
// `summary` so the list view can render chips (track id, slot count, sessions
// enabled) without re-parsing the JSON blob on every render.
function _shapePresetRow(r, withConfig) {
  let cfg = null;
  try { cfg = JSON.parse(r.config); } catch {}
  const slots = Array.isArray(cfg?.slots) ? cfg.slots : [];
  const summary = {
    trackId:         cfg?.trackId || '',
    layout:          cfg?.layout || '',
    slotCount:       slots.length,
    practiceEnabled: !!cfg?.practiceEnabled,
    qualifyEnabled:  !!cfg?.qualifyEnabled,
    raceEnabled:     !!cfg?.raceEnabled,
  };
  return {
    id:          r.id,
    name:        r.name,
    description: r.description || '',
    summary,
    createdBy:   r.created_by || '',
    createdAt:   r.created_at,
    updatedAt:   r.updated_at,
    ...(withConfig ? { config: cfg || {} } : {}),
  };
}

function _validatePresetPayload(body, { requireName = true } = {}) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (requireName && !name) return { error: 'name required' };
  if (name.length > PRESET_NAME_MAX) return { error: `name too long (max ${PRESET_NAME_MAX})` };
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  if (description.length > PRESET_DESC_MAX) return { error: `description too long (max ${PRESET_DESC_MAX})` };
  const config = body?.config;
  if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) {
    return { error: 'config must be an object' };
  }
  return { name, description, config };
}

function apiSessionPresetsList(req, res) {
  if (!checkPermission(req, 'presetManage')) return json(res, 403, { error: 'Forbidden' });
  if (!db) return json(res, 200, []);
  try {
    const rows = db.prepare(`
      SELECT id, name, description, config, created_by, created_at, updated_at
      FROM session_presets
      ORDER BY updated_at DESC, id DESC
    `).all();
    json(res, 200, rows.map(r => _shapePresetRow(r, false)));
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

function apiSessionPresetGet(req, res, id) {
  if (!checkPermission(req, 'presetManage')) return json(res, 403, { error: 'Forbidden' });
  if (!db) return json(res, 404, { error: 'Not found' });
  try {
    const row = db.prepare(`
      SELECT id, name, description, config, created_by, created_at, updated_at
      FROM session_presets WHERE id = ?
    `).get(id);
    if (!row) return json(res, 404, { error: 'Not found' });
    json(res, 200, _shapePresetRow(row, true));
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

async function apiSessionPresetCreate(req, res) {
  if (!checkPermission(req, 'presetManage')) return json(res, 403, { error: 'Forbidden' });
  if (!db) return json(res, 500, { error: 'DB not ready' });
  try {
    const body = await readBody(req);
    const v = _validatePresetPayload(body, { requireName: true });
    if (v.error) return json(res, 400, { error: v.error });
    if (v.config === undefined) return json(res, 400, { error: 'config required' });
    const actor = checkAnyAuth(req)?.username || '';
    const cfgJson = JSON.stringify(v.config);
    try {
      const info = db.prepare(`
        INSERT INTO session_presets (name, description, config, created_by)
        VALUES (?, ?, ?, ?)
      `).run(v.name, v.description, cfgJson, actor);
      insertAuditLog(actor, 'preset.create', v.name);
      json(res, 200, { id: Number(info.lastInsertRowid), name: v.name });
    } catch (e) {
      if (/UNIQUE constraint failed/i.test(String(e.message))) {
        return json(res, 409, { error: 'A preset with that name already exists' });
      }
      throw e;
    }
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

async function apiSessionPresetUpdate(req, res, id) {
  if (!checkPermission(req, 'presetManage')) return json(res, 403, { error: 'Forbidden' });
  if (!db) return json(res, 500, { error: 'DB not ready' });
  try {
    const body = await readBody(req);
    const v = _validatePresetPayload(body, { requireName: false });
    if (v.error) return json(res, 400, { error: v.error });
    const existing = db.prepare('SELECT id, name FROM session_presets WHERE id = ?').get(id);
    if (!existing) return json(res, 404, { error: 'Not found' });
    const sets  = [];
    const args  = [];
    if (v.name)                sets.push('name = ?'),        args.push(v.name);
    if (body?.description !== undefined) sets.push('description = ?'), args.push(v.description);
    if (v.config !== undefined) sets.push('config = ?'),     args.push(JSON.stringify(v.config));
    if (sets.length === 0) return json(res, 400, { error: 'no fields to update' });
    sets.push("updated_at = datetime('now')");
    args.push(id);
    try {
      db.prepare(`UPDATE session_presets SET ${sets.join(', ')} WHERE id = ?`).run(...args);
      const actor = checkAnyAuth(req)?.username || '';
      insertAuditLog(actor, 'preset.update', v.name || existing.name);
      json(res, 200, { ok: true });
    } catch (e) {
      if (/UNIQUE constraint failed/i.test(String(e.message))) {
        return json(res, 409, { error: 'A preset with that name already exists' });
      }
      throw e;
    }
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

function apiSessionPresetDelete(req, res, id) {
  if (!checkPermission(req, 'presetManage')) return json(res, 403, { error: 'Forbidden' });
  if (!db) return json(res, 500, { error: 'DB not ready' });
  try {
    const row = db.prepare('SELECT id, name FROM session_presets WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Not found' });
    db.prepare('DELETE FROM session_presets WHERE id = ?').run(id);
    const actor = checkAnyAuth(req)?.username || '';
    insertAuditLog(actor, 'preset.delete', row.name);
    json(res, 200, { ok: true });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Filename-safe version of the preset name for Content-Disposition. Strips
// characters that confuse Windows/macOS/Linux filesystems, collapses
// whitespace, and trims to a reasonable length. Falls back to "preset" if
// the result would be empty.
function _presetFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'preset';
}

// Pick a unique name for an imported preset. If the requested name already
// exists (case-insensitive, matching the schema's UNIQUE), append " (2)",
// " (3)" … until we find a free slot. Avoids the import flow dying on a
// 409 just because the operator already had a preset with the same name.
function _uniquePresetName(base) {
  const exists = (n) => !!db.prepare('SELECT 1 FROM session_presets WHERE LOWER(name) = LOWER(?)').get(n);
  if (!exists(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const cand = `${base} (${n})`;
    if (!exists(cand)) return cand;
  }
  // Pathological — 10k presets with the same base name. Append a timestamp.
  return `${base} (${Date.now()})`;
}

// Wrap a preset row in a portable envelope: format marker + version + a
// little provenance so an operator opening the file in a text editor can
// tell what it is. The `preset` object inside matches the POST payload
// /api/session-presets accepts, so re-importing into another panel is a
// straight pass-through after envelope unwrap.
const PRESET_EXPORT_FORMAT  = 'assetto-server-panel-preset';
const PRESET_EXPORT_VERSION = 1;

function apiSessionPresetExport(req, res, id) {
  if (!checkPermission(req, 'presetManage')) return json(res, 403, { error: 'Forbidden' });
  if (!db) return json(res, 404, { error: 'Not found' });
  try {
    const row = db.prepare(`
      SELECT id, name, description, config, created_by, created_at, updated_at
      FROM session_presets WHERE id = ?
    `).get(id);
    if (!row) return json(res, 404, { error: 'Not found' });
    let cfg = {};
    try { cfg = JSON.parse(row.config) || {}; } catch {}
    const envelope = {
      format:        PRESET_EXPORT_FORMAT,
      formatVersion: PRESET_EXPORT_VERSION,
      exportedAt:    new Date().toISOString(),
      exportedFrom:  checkAnyAuth(req)?.username || '',
      panelVersion:  require('./package.json').version,
      preset: {
        name:        row.name,
        description: row.description || '',
        config:      cfg,
      },
    };
    const filename = _presetFilename(row.name) + '.json';
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // RFC 6266: include filename* for non-ASCII (encodeURIComponent handles
    // the percent-encoding) while keeping a plain `filename=` fallback for
    // legacy clients that ignore the extended form.
    res.setHeader('Content-Disposition',
      `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(envelope, null, 2));
    const actor = checkAnyAuth(req)?.username || '';
    insertAuditLog(actor, 'preset.export', row.name);
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

async function apiSessionPresetImport(req, res) {
  if (!checkPermission(req, 'presetManage')) return json(res, 403, { error: 'Forbidden' });
  if (!db) return json(res, 500, { error: 'DB not ready' });
  try {
    const body = await readBody(req);
    if (!body || typeof body !== 'object') {
      return json(res, 400, { error: 'invalid body' });
    }
    // Accept both the full envelope and a bare preset object (`{ name,
    // description, config }`) — the former is what /export emits, the
    // latter is what someone hand-crafting a file is most likely to write.
    let preset;
    if (body.format === PRESET_EXPORT_FORMAT) {
      if (body.formatVersion !== PRESET_EXPORT_VERSION) {
        return json(res, 400, { error: `unsupported formatVersion ${body.formatVersion}` });
      }
      preset = body.preset;
    } else if (body.preset && typeof body.preset === 'object') {
      preset = body.preset;
    } else {
      preset = body;
    }
    const v = _validatePresetPayload(preset, { requireName: true });
    if (v.error) return json(res, 400, { error: v.error });
    if (v.config === undefined) return json(res, 400, { error: 'config required' });
    const finalName = _uniquePresetName(v.name);
    const actor = checkAnyAuth(req)?.username || '';
    const cfgJson = JSON.stringify(v.config);
    const info = db.prepare(`
      INSERT INTO session_presets (name, description, config, created_by)
      VALUES (?, ?, ?, ?)
    `).run(finalName, v.description, cfgJson, actor);
    insertAuditLog(actor, 'preset.import', finalName);
    json(res, 200, {
      id:       Number(info.lastInsertRowid),
      name:     finalName,
      // Surface the rename so the client can toast "Imported as X" when the
      // requested name collided.
      renamed:  finalName !== v.name,
      original: v.name,
    });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Admin-set display name for a player — stored alongside the in-game name so
// lap times (joined by GUID) can be rendered as "Apodo (in-game)" without
// touching the laps the acServer importer already wrote.
async function apiPlayerNickname(req, res, guid) {
  if (!checkPermission(req, 'playerModeration')) return json(res, 403, { error: 'Forbidden' });
  if (!db) return json(res, 500, { error: 'Database unavailable' });
  if (!/^\d{17}$/.test(guid)) return json(res, 400, { error: 'guid must be 17 digits' });
  try {
    const body = await readBody(req);
    // Allow clearing with empty string. Cap to a sensible display length and
    // strip control characters so the modal can't be used to inject weird
    // glyphs into the laps table.
    const raw = typeof body.nickname === 'string' ? body.nickname : '';
    const nickname = raw.replace(/[\r\n\t\0]/g, ' ').trim().slice(0, 64);
    const r = db.prepare('UPDATE players SET nickname = ? WHERE guid = ?').run(nickname, guid);
    if (r.changes === 0) return json(res, 404, { error: 'Player not found' });
    const actor = checkAnyAuth(req)?.username || 'unknown';
    insertAuditLog(actor, 'player.nickname', guid, nickname);
    const row = db.prepare('SELECT guid, name, nickname FROM players WHERE guid = ?').get(guid);
    json(res, 200, { ok: true, player: row });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// ── Whitelist ─────────────────────────────────────────────────────────────────
// path.resolve canonicalises the path so the whitelist write/read can never escape
// to an unintended location via env var injection (e.g. AC_WHITELIST_FILE=/etc/passwd).
const AC_WHITELIST = path.resolve(
  process.env.AC_WHITELIST_FILE
  || path.join(_AC_CFG_DIR_RESOLVED, 'whitelist.txt')
);

function apiWhitelistGet(req, res) {
  // Reading the GUID list needs an admin-ish permission: whitelist managers, or
  // Config-page viewers (serverConfig), since that page renders the list.
  if (!checkPermission(req, 'whitelistManage') && !checkPermission(req, 'serverConfig'))
    return json(res, 403, { error: 'Forbidden' });
  let raw = '';
  try { raw = fs.readFileSync(AC_WHITELIST, 'utf8'); } catch {}
  const ids = raw.split('\n').map(s => s.trim()).filter(Boolean);
  json(res, 200, { ids });
}

async function apiWhitelistPut(req, res) {
  if (!checkPermission(req, 'whitelistManage')) return json(res, 403, { error: 'Forbidden' });
  try {
    const body = await readBody(req);
    if (!Array.isArray(body.ids)) return json(res, 400, { error: 'ids array required' });
    const clean = body.ids.map(s => String(s).trim()).filter(s => /^\d{17}$/.test(s));
    const before = clean.length;
    await withFileLock(AC_WHITELIST, async () => {
      await fsp.writeFile(AC_WHITELIST, clean.join('\n') + (clean.length ? '\n' : ''), 'utf8');
    });
    const actor = checkAnyAuth(req)?.username || 'unknown';
    insertAuditLog(actor, 'whitelist.replace', '', `${before} ids`);
    json(res, 200, { ok: true, saved: clean.length });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Add a single GUID to the whitelist file. Used by the per-player button on the
// Players page so the caller doesn't have to read-modify-write the whole list.
async function apiWhitelistAdd(req, res) {
  if (!checkPermission(req, 'whitelistManage')) return json(res, 403, { error: 'Forbidden' });
  try {
    const body = await readBody(req);
    const guid = String(body.guid || '').trim();
    if (!/^\d{17}$/.test(guid)) return json(res, 400, { error: 'guid must be 17 digits' });
    const result = await withFileLock(AC_WHITELIST, async () => {
      let raw = '';
      try { raw = await fsp.readFile(AC_WHITELIST, 'utf8'); } catch {}
      const ids = raw.split('\n').map(s => s.trim()).filter(Boolean);
      if (ids.includes(guid)) return { alreadyPresent: true, total: ids.length };
      ids.push(guid);
      await fsp.writeFile(AC_WHITELIST, ids.join('\n') + '\n', 'utf8');
      return { alreadyPresent: false, total: ids.length };
    });
    if (result.alreadyPresent) return json(res, 200, { ok: true, alreadyPresent: true, total: result.total });
    const actor = checkAnyAuth(req)?.username || 'unknown';
    insertAuditLog(actor, 'whitelist.add', guid, body.name || '');
    json(res, 200, { ok: true, total: result.total });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// ── Session apply ─────────────────────────────────────────────────────────────
// Stock Assetto Corsa weather presets (GRAPHICS values). Limiting the writer
// to this allowlist prevents arbitrary INI injection via a forged `weather`.
const AC_WEATHER_PRESETS = new Set([
  '1_heavy_fog', '2_light_fog', '3_clear', '4_mid_clear',
  '5_light_clouds', '6_mid_clouds', '7_heavy_clouds',
]);

// Regenerate entry_list.ini from an ordered slot list. Each slot is an
// {id, skin} pair — the panel exposes per-slot skin selection so two slots
// of the same car can run different liveries. When `slotCount` is given and
// larger than the slot list, we cycle through it to fill the rest.
// Caller is responsible for already having validated each slot's id with
// isValidContentId and skin with isValidSkinName.
async function writeEntryList(slots, slotCount) {
  if (!Array.isArray(slots) || slots.length === 0) return;
  const ENTRY_LIST = path.join(path.dirname(AC_CFG_FILE), 'entry_list.ini');
  const total = Math.max(1, Math.min(200, (slotCount | 0) || slots.length));
  const blocks = [];
  for (let i = 0; i < total; i++) {
    const slot = slots[i % slots.length];
    const skin = slot.skin || 'Base';
    blocks.push(
      `[CAR_${i}]\n` +
      `MODEL=${slot.id}\n` +
      `SKIN=${skin}\n` +
      `SPECTATOR_MODE=0\n` +
      `DRIVERNAME=\n` +
      `TEAM=\n` +
      `GUID=\n` +
      `BALLAST=0\n` +
      `RESTRICTOR=0\n`
    );
  }
  // Single rolling .bak so an admin can recover the previous slot list if the
  // regeneration ever produces something unexpected. Best-effort: never block
  // the rewrite on a backup failure.
  try { await fsp.copyFile(ENTRY_LIST, ENTRY_LIST + '.bak'); } catch {}
  await fsp.writeFile(ENTRY_LIST, blocks.join('\n'), 'utf8');
}

async function apiSessionApply(req, res) {
  if (!checkPermission(req, 'sessionEdit')) return json(res, 403, { error: 'Forbidden' });
  try {
    const body = await readBody(req);
    const raw  = await fsp.readFile(AC_CFG_FILE, 'utf8');
    const ini  = parseINI(raw);
    const s    = ini['SERVER'] = ini['SERVER'] || {};
    if (body.trackId !== undefined) {
      if (body.trackId && !isValidContentId(body.trackId))
        return json(res, 400, { error: 'Invalid trackId' });
      s['TRACK'] = body.trackId || '';
    }
    if (body.layout !== undefined) {
      if (body.layout && !isValidContentId(body.layout))
        return json(res, 400, { error: 'Invalid layout' });
      s['CONFIG_TRACK'] = body.layout || '';
    }
    // Ordered slot list. Each slot has its own MODEL + SKIN so the same car
    // can appear multiple times in the grid with different liveries. The
    // [SERVER].CARS field gets the deduplicated set of ids (acServer's
    // "allowed cars" list); writeEntryList consumes the ordered slots
    // directly so position+skin land 1:1 in entry_list.ini.
    let cleanSlots = null;
    if (Array.isArray(body.slots)) {
      cleanSlots = [];
      for (const slot of body.slots) {
        if (!slot || typeof slot !== 'object') continue;
        const id = slot.id;
        if (!isValidContentId(id)) continue;
        const rawSkin = typeof slot.skin === 'string' ? slot.skin : '';
        const skin    = rawSkin && isValidSkinName(rawSkin) ? rawSkin : '';
        cleanSlots.push({ id, skin });
      }
      if (body.slots.length && !cleanSlots.length)
        return json(res, 400, { error: 'slots contains no valid entries' });
      if (cleanSlots.length) {
        const uniqIds = [...new Set(cleanSlots.map(x => x.id))];
        s['CARS'] = uniqIds.join(';');
      }
    }
    if (body.maxClients !== undefined) {
      const v = clampInt(body.maxClients, 1, 200);
      if (!v) return json(res, 400, { error: 'maxClients must be an integer between 1 and 200' });
      s['MAX_CLIENTS'] = String(v);
    }

    // Per-session enable/duration. Each session is independent now: the
    // admin can disable Qualify and Race entirely (sections get removed
    // from the INI so LOOP_MODE cycles only Practice), or have all three.
    // At least one has to stay on — a server with no sessions can't run.
    const sessionFlags = {
      Practice: body.practiceEnabled,
      Qualify:  body.qualifyEnabled,
      Race:     body.raceEnabled,
    };
    const anyExplicit = Object.values(sessionFlags).some(v => v !== undefined);
    if (anyExplicit) {
      // Resolve final enabled state per session, preserving the existing
      // value when the field wasn't sent.
      const resolved = {
        Practice: sessionFlags.Practice ?? !!ini['PRACTICE'],
        Qualify:  sessionFlags.Qualify  ?? !!ini['QUALIFY'],
        Race:     sessionFlags.Race     ?? !!ini['RACE'],
      };
      if (!resolved.Practice && !resolved.Qualify && !resolved.Race)
        return json(res, 400, { error: 'At least one session (Practice, Qualify or Race) must stay enabled' });
      // For disabled sessions, mark for INI removal after patch.
      var sectionsToRemove = [];
      for (const [name, on] of Object.entries(resolved)) {
        if (!on) {
          sectionsToRemove.push(name.toUpperCase());
          delete ini[name.toUpperCase()];
        }
      }
    }
    // Per-session values. We accept the modern shape (practiceTime, qualifyTime,
    // raceLaps) so the panel can edit all three independently without sending
    // a "mode" hint. If a section is being disabled this turn its value is
    // ignored — the section gets removed below.
    if (body.practiceTime !== undefined && (sessionFlags.Practice ?? true)) {
      const v = clampInt(body.practiceTime, 1, 9999);
      if (v === null) return json(res, 400, { error: 'practiceTime must be 1..9999' });
      const p = ini['PRACTICE'] = ini['PRACTICE'] || { NAME: 'Practice', IS_OPEN: '1' };
      p['TIME'] = String(v);
    }
    if (body.qualifyTime !== undefined && (sessionFlags.Qualify ?? true)) {
      const v = clampInt(body.qualifyTime, 1, 9999);
      if (v === null) return json(res, 400, { error: 'qualifyTime must be 1..9999' });
      const q = ini['QUALIFY'] = ini['QUALIFY'] || { NAME: 'Qualify', IS_OPEN: '1' };
      q['TIME'] = String(v);
    }
    if (body.raceLaps !== undefined && (sessionFlags.Race ?? true)) {
      const v = clampInt(body.raceLaps, 1, 9999);
      if (v === null) return json(res, 400, { error: 'raceLaps must be 1..9999' });
      const r = ini['RACE'] = ini['RACE'] || { NAME: 'Race', LAPS: '5', IS_OPEN: '1', WAIT_TIME: '60' };
      r['LAPS'] = String(v);
    }

    // Hour-of-day → SUN_ANGLE. Same formula Content Manager uses; the [-80,80]
    // clamp matches AC's renderable range, so hour=0 effectively saturates to
    // dawn rather than midnight.
    if (body.time !== undefined) {
      const h = clampInt(body.time, 0, 23);
      if (h === null) return json(res, 400, { error: 'time must be an hour 0..23' });
      const angle = Math.max(-80, Math.min(80, (h - 13) * 16));
      s['SUN_ANGLE'] = String(angle);
    }

    if (body.weather !== undefined) {
      if (!AC_WEATHER_PRESETS.has(body.weather))
        return json(res, 400, { error: 'Unknown weather preset' });
      const w = ini['WEATHER_0'] = ini['WEATHER_0'] || {};
      w['GRAPHICS'] = body.weather;
    }
    if (body.airTemp !== undefined) {
      const t = clampInt(body.airTemp, 0, 40);
      if (t === null) return json(res, 400, { error: 'airTemp must be 0..40' });
      const w = ini['WEATHER_0'] = ini['WEATHER_0'] || {};
      w['BASE_TEMPERATURE_AMBIENT'] = String(t);
    }
    if (body.penalties !== undefined) {
      s['RACE_GAS_PENALTY_DISABLED'] = body.penalties ? '0' : '1';
    }

    // Auto-enable the UDP plugin if the admin hasn't done it manually. This
    // is the price-of-entry for live lap capture; one-time write that costs
    // nothing if the panel ends up uninstalled later (the lines just sit
    // there, ignored by acServer when port=0). Defaults: 12000 (commands
    // acServer ← plugin) / 127.0.0.1:12001 (events acServer → plugin).
    const existingLocalPort = parseInt(s['UDP_PLUGIN_LOCAL_PORT'], 10) || 0;
    const existingAddress   = (s['UDP_PLUGIN_ADDRESS'] || '').trim();
    if (!existingLocalPort || !existingAddress) {
      if (!existingLocalPort) s['UDP_PLUGIN_LOCAL_PORT'] = '12000';
      if (!existingAddress)   s['UDP_PLUGIN_ADDRESS']   = '127.0.0.1:12001';
    }

    await rotateConfigBackup();
    let patched = patchINI(raw, ini);
    // Physically drop disabled sessions from the INI text. patchINI only
    // edits/appends; it doesn't remove. Done after patching so any
    // would-be values for disabled sessions don't make it to disk.
    if (typeof sectionsToRemove !== 'undefined') {
      for (const name of sectionsToRemove) patched = removeIniSection(patched, name);
    }
    await fsp.writeFile(AC_CFG_FILE, patched, 'utf8');

    // If the listener wasn't running yet (first Apply after install) it
    // boots here. The acServer restart below picks up the new INI lines
    // and starts pushing events at us. Subsequent restarts won't double-
    // bind because udpStartListener no-ops when state.socket is set.
    udpStartListener(s['UDP_PLUGIN_ADDRESS'], parseInt(s['UDP_PLUGIN_LOCAL_PORT'], 10) || 0);

    // When the slot list changes, entry_list.ini must be regenerated to match.
    // acServer requires every [CAR_n].MODEL to appear in [SERVER].CARS and
    // refuses to start otherwise — leaving stale slots crashes the boot.
    if (cleanSlots && cleanSlots.length) {
      await writeEntryList(cleanSlots, intOr(s['MAX_CLIENTS'], cleanSlots.length));
    }

    // Auto-restart if server is running and the caller asks for it. Acquire
    // the same global lock /api/server/{start,stop,restart} use so two
    // session-apply requests (or a session-apply + manual restart) cannot
    // race through killAC + spawnAC and end up with duplicate acServer
    // processes.
    let restarted = false, restartError = null;
    const wantRestart = body.restart !== false; // default ON
    if (wantRestart) {
      const release = _acquireServerLock();
      if (!release) {
        restartError = 'Another server action is in progress; restart skipped';
      } else try {
      const wasRunning = (acChild && !acChild.killed) || !!(await findACPid()) || (await getACInfo()).running;
      if (wasRunning) {
        const k = await killAC();
        if (!k.ok) restartError = k.error || 'Failed to stop server';
        else {
          await waitForACDown(6000);
          await sleep(500);
          const sp = await spawnAC();
          if (!sp.ok) restartError = sp.error || 'Failed to start server';
          else { await waitForACUp(10000); restarted = true; }
        }
      }
      } finally { release(); }
    }
    const actor = checkAnyAuth(req)?.username || 'unknown';
    const detail = [body.trackId, body.layout, ...(body.cars || [])].filter(Boolean).join(', ');
    insertAuditLog(actor, 'session.apply', body.trackId || '', detail);
    json(res, 200, { ok: true, restarted, restartError });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// ── UDP plugin (acServer live events) ────────────────────────────────────────
// acServer pushes a stream of live events over UDP — every connection, lap
// completion and session change. We bind a listener, parse the binary frames
// and persist laps the moment they happen (no waiting for session-end JSON
// dumps). The car_id → driver map also feeds the live "Players Online" table
// so the dashboard knows Steam GUID, model and best/last lap for every
// connected slot. Cross-source dedup lives at the schema level
// (laps_dedup_runtime UNIQUE INDEX on driver_guid+ms+car+track+track_config).
//
// Wire convention (per kunos UDP plugin spec):
//   UDP_PLUGIN_LOCAL_PORT     — acServer's command-listen port; plugin SENDS here
//   UDP_PLUGIN_ADDRESS=host:p — acServer's event-push target; plugin BINDS here
const dgram = require('dgram');

const ACSP = {
  // Inbound events from acServer
  NEW_SESSION:       50,
  NEW_CONNECTION:    51,
  CONNECTION_CLOSED: 52,
  CAR_UPDATE:        53,
  CAR_INFO:          54,
  END_SESSION:       55,
  VERSION:           56,
  CHAT:              57,
  CLIENT_LOADED:     58,
  SESSION_INFO:      59,
  ERROR:             60,
  LAP_COMPLETED:     73,
  CLIENT_EVENT:      130,
  // Outbound commands to acServer
  REALTIMEPOS_INTERVAL: 200,
  GET_CAR_INFO:         201,
  SEND_CHAT:            202,
  BROADCAST_CHAT:       203,
  GET_SESSION_INFO:     204,
  SET_SESSION_INFO:     205,
  KICK_USER:            206,
  NEXT_SESSION:         207,
  RESTART_SESSION:      208,
  ADMIN_COMMAND:        209,
};

// Two string flavours in the protocol:
//   utf32-le → uint8 char-count + char-count*4 bytes (driver name/team/GUID)
//   utf8     → uint8 byte-count + byte-count bytes (track, model, skin, weather)
function readUtf8Str(buf, off) {
  const len = buf[off];
  return { value: buf.slice(off + 1, off + 1 + len).toString('utf8'), next: off + 1 + len };
}
function readUtf32Str(buf, off) {
  const len = buf[off];
  let s = '';
  for (let i = 0; i < len; i++) {
    try { s += String.fromCodePoint(buf.readUInt32LE(off + 1 + i * 4)); } catch {}
  }
  return { value: s, next: off + 1 + len * 4 };
}

const udpState = {
  socket: null,
  remoteHost: '127.0.0.1',
  remotePort: 0,
  cars: new Map(), // car_id → { name, team, guid, model, skin, joinedAt, bestLap, lastLap, lapsCount }
  session: { type: null, name: null, track: null, config: null, weather: null, startedAt: 0, dateStr: '' },
  startedAt: 0,
  lastPacketAt: 0,
};

function udpTypeName(t) {
  return ({1:'PRACTICE',2:'QUALIFY',3:'RACE',4:'HOTLAP',5:'TIME_ATTACK',6:'DRIFT',7:'DRAG'})[t] || `TYPE_${t}`;
}

function udpStartListener(listenHostPort, sendCommandsToPort) {
  if (!sendCommandsToPort || !listenHostPort) {
    log.info('[UDP] plugin not configured (UDP_PLUGIN_LOCAL_PORT=0 or empty UDP_PLUGIN_ADDRESS) — live lap capture disabled');
    return;
  }
  if (udpState.socket) { log.warn('[UDP] listener already running'); return; }
  const [host, portStr] = String(listenHostPort).split(':');
  const listenPort = parseInt(portStr, 10);
  const listenHost = host || '127.0.0.1';
  if (!listenPort) return log.warn('[UDP] invalid UDP_PLUGIN_ADDRESS:', listenHostPort);

  udpState.remoteHost = '127.0.0.1';
  udpState.remotePort = sendCommandsToPort;

  const sock = dgram.createSocket('udp4');
  sock.on('error', e => log.error('[UDP] socket error:', e.message));
  sock.on('message', (msg) => {
    udpState.lastPacketAt = Date.now();
    try { udpParseEvent(msg); }
    catch (e) { log.warn('[UDP] parse error:', e.message, 'first_byte=' + (msg[0] ?? 'nil') + ' length=' + msg.length); }
  });
  sock.bind(listenPort, listenHost, async () => {
    udpState.socket = sock;
    udpState.startedAt = Date.now();
    log.info(`[UDP] listening on ${listenHost}:${listenPort}, commands → 127.0.0.1:${sendCommandsToPort}`);
    // Pull a snapshot in case acServer was already running when we booted.
    udpSendCommand(ACSP.GET_SESSION_INFO, Buffer.from([0xFF, 0xFF]));
    // Repopulate the cars map for slots that are actually occupied — needed
    // when the dashboard restarts while drivers are still connected (acServer
    // does not re-emit NEW_CONNECTION for them, so their next LAP_COMPLETED
    // would arrive for an unknown car_id and get dropped). We used to fire
    // GET_CAR_INFO at every slot 0..63 blindly, but this Go acServer build
    // replies isConnected=1 for slots that held a driver in a past session,
    // leaving phantom entries until the real driver rejoins (often onto a
    // different slot, producing a duplicate). Gate the burst on /JSON|0 —
    // its IsConnected flag tracks the live socket state — so we only ask
    // about slots a real client currently occupies.
    const list = await acFetchJson('/JSON%7C0');
    if (list && Array.isArray(list.Cars)) {
      for (let i = 0; i < list.Cars.length; i++) {
        if (list.Cars[i] && list.Cars[i].IsConnected) udpSendCommand(ACSP.GET_CAR_INFO, Buffer.from([i]));
      }
    }
    // If /JSON|0 was unreachable we deliberately skip the burst rather than
    // fall back to 0..63: any active driver's next LAP_COMPLETED hits the
    // unknown-car_id fallback in udpParseEvent which requests CAR_INFO for
    // that slot on demand, so we still recover — without seeding phantoms.

    // Subscribe to CAR_UPDATE position stream. See udpEnableRealtimePos for
    // the per-restart re-subscription logic — the boot-time send here only
    // covers the case where acServer is already up when the panel starts.
    udpEnableRealtimePos();
  });
}

// Tells acServer to start broadcasting CAR_UPDATE packets at 10Hz (100ms
// interval), the cadence Content Manager / CSP use for their minimaps. The
// subscription is per-process: every time acServer is killed and respawned
// (which happens on every panel restart because of the systemd-cgroup issue
// in KillMode=process, and on every /api/server/{start,restart}), the new
// acServer process has no record of the previous subscription. We re-send
// from three places:
//   1. udpStartListener — covers "acServer up before panel".
//   2. NEW_SESSION handler — acServer emits this on its own startup, so a
//      stand-alone acServer restart caught by the panel triggers a re-sub.
//   3. apiPositionsStream — last-resort idempotent send when the Dashboard
//      widget opens its EventSource (zero downside: acServer accepts repeat
//      subscriptions, the payload is 3 bytes, ignored if redundant).
// Without this re-sub, CAR_UPDATE silently stops arriving after any
// acServer restart and the live-map dots get stuck on the last known frame.
const _REALTIME_POS_INTERVAL_MS = 100;
function udpEnableRealtimePos() {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(_REALTIME_POS_INTERVAL_MS, 0);
  return udpSendCommand(ACSP.REALTIMEPOS_INTERVAL, buf);
}

function udpSendCommand(cmd, payload = Buffer.alloc(0)) {
  if (!udpState.socket || !udpState.remotePort) return false;
  const buf = Buffer.concat([Buffer.from([cmd]), payload]);
  udpState.socket.send(buf, udpState.remotePort, udpState.remoteHost);
  return true;
}

function udpParseEvent(buf) {
  const ev = buf[0];
  let off = 1;
  switch (ev) {
    case ACSP.VERSION:
      log.info('[UDP] protocol version:', buf[off]);
      break;

    case ACSP.NEW_SESSION:
    case ACSP.SESSION_INFO: {
      // Same payload shape for both events.
      const protoVersion = buf[off++]; void protoVersion;
      const sessIndex    = buf[off++]; void sessIndex;
      const currentIndex = buf[off++]; void currentIndex;
      const sessCount    = buf[off++]; void sessCount;
      const serverName   = readUtf32Str(buf, off); off = serverName.next;
      const track        = readUtf8Str(buf, off);  off = track.next;
      const trackConfig  = readUtf8Str(buf, off);  off = trackConfig.next;
      const sessName     = readUtf8Str(buf, off);  off = sessName.next;
      const type         = buf[off++];
      const time         = buf.readUInt16LE(off);  off += 2;
      const laps         = buf.readUInt16LE(off);  off += 2;
      const waitTime     = buf.readUInt16LE(off);  off += 2;
      const ambientTemp  = buf[off++];
      const roadTemp     = buf[off++];
      const weather      = readUtf8Str(buf, off);  off = weather.next;
      const elapsedMs    = buf.readInt32LE(off);   off += 4;

      udpState.session = {
        type, time, laps, waitTime, ambientTemp, roadTemp,
        track:     track.value,
        config:    trackConfig.value,
        name:      sessName.value,
        weather:   weather.value,
        startedAt: Date.now() - Math.max(0, elapsedMs),
        dateStr:   new Date().toISOString().slice(0, 10),
      };
      log.info(`[UDP] ${ev === ACSP.NEW_SESSION ? 'NEW_SESSION' : 'SESSION_INFO'} ${sessName.value} (${udpTypeName(type)}) track=${track.value}${trackConfig.value ? '/' + trackConfig.value : ''}`);
      // Reset per-session counters but keep the connected-cars map intact.
      for (const c of udpState.cars.values()) { c.bestLap = 0; c.lastLap = 0; c.lapsCount = 0; }
      // Re-subscribe to CAR_UPDATE every time acServer announces a session.
      // acServer emits NEW_SESSION on its own boot, so this covers the case
      // where the panel was started BEFORE acServer (boot-time REALTIMEPOS
      // packet went into the void because port 12000 had no listener yet),
      // and also handles operator-initiated restarts via /api/server/start.
      udpEnableRealtimePos();
      break;
    }

    case ACSP.NEW_CONNECTION:
    case ACSP.CONNECTION_CLOSED: {
      // Field layout in this Go acServer build (verified via hex capture):
      //   driver_name (utf32) → driver_guid (utf32) → car_id (1) →
      //   car_model (utf8) → car_skin (utf8)
      // The classic Kunos spec had a `driver_team` between name and guid;
      // this build omits it. Keep team as an empty placeholder so the
      // shape of state.cars stays consistent.
      const name  = readUtf32Str(buf, off); off = name.next;
      const guid  = readUtf32Str(buf, off); off = guid.next;
      const carId = buf[off++];
      const model = readUtf8Str(buf, off);  off = model.next;
      const skin  = readUtf8Str(buf, off);  off = skin.next;
      const team  = { value: '' };
      if (ev === ACSP.NEW_CONNECTION) {
        udpState.cars.set(carId, {
          carId,
          name:    name.value,
          team:    team.value,
          guid:    guid.value,
          model:   model.value,
          skin:    skin.value,
          joinedAt: Date.now(),
          bestLap: 0, lastLap: 0, lapsCount: 0,
        });
        log.info(`[UDP] JOIN ${name.value} (${guid.value}) car_id=${carId} model=${model.value}`);
        // Upsert the players row immediately so Whitelist/Ban buttons light up
        // on the first connection (the JSON importer only fires at session
        // end, which can be hours later).
        try {
          if (db && /^\d{17}$/.test(guid.value)) {
            const date = udpState.session.dateStr || new Date().toISOString().slice(0, 10);
            db.prepare(`
              INSERT OR IGNORE INTO players (guid, name, nation, first_seen, last_seen, total_laps, last_car, last_track)
              VALUES (?, ?, '', ?, ?, 0, ?, ?)
            `).run(guid.value, name.value, date, date, model.value, udpState.session.track || '');
            db.prepare(`
              UPDATE players SET name = ?, last_seen = ?, last_car = ?, last_track = ?
              WHERE guid = ?
            `).run(name.value, date, model.value, udpState.session.track || '', guid.value);
          }
        } catch (e) { log.warn('[UDP] player upsert failed:', e.message); }
      } else {
        log.info(`[UDP] LEAVE ${name.value} car_id=${carId}`);
        udpState.cars.delete(carId);
      }
      break;
    }

    case ACSP.LAP_COMPLETED: {
      const carId     = buf[off++];
      const lapTime   = buf.readUInt32LE(off); off += 4;
      const cuts      = buf[off++];
      const carsCount = buf[off++];
      const leaderboard = [];
      for (let i = 0; i < carsCount; i++) {
        leaderboard.push({
          carId:     buf[off],
          lapTime:   buf.readUInt32LE(off + 1),
          lapsCount: buf.readUInt16LE(off + 5),
          completed: buf[off + 7],
        });
        off += 8;
      }
      const gripLevel = buf.readFloatLE(off); off += 4;
      void gripLevel;

      const car = udpState.cars.get(carId);
      if (!car) {
        // Listener missed the JOIN (booted mid-session, or acServer restarted
        // without re-emitting events for active drivers). Ask for that slot's
        // CAR_INFO so the next lap from the same driver lands cleanly.
        log.warn(`[UDP] LAP_COMPLETED for unknown car_id=${carId} — requesting CAR_INFO`);
        udpSendCommand(ACSP.GET_CAR_INFO, Buffer.from([carId]));
        break;
      }
      car.lastLap = lapTime;
      const myEntry = leaderboard.find(x => x.carId === carId);
      if (myEntry) car.lapsCount = myEntry.lapsCount;
      if (!car.bestLap || lapTime < car.bestLap) car.bestLap = lapTime;

      log.info(`[UDP] LAP ${car.name} ${(lapTime/1000).toFixed(3)}s cuts=${cuts}`);

      if (!db) break;
      if (lapTime <= 0 || lapTime >= 999_000_000) break;
      if (!/^\d{17}$/.test(car.guid)) break;

      try {
        const date = udpState.session.dateStr || new Date().toISOString().slice(0, 10);
        const lapMsSinceStart = udpState.session.startedAt
          ? Math.max(0, Date.now() - udpState.session.startedAt)
          : 0;
        // Seed s1 with the full lap_time so the row reads "as if" it were a
        // single-sector lap (which is what this track's JSON ends up writing
        // too). The post-session JSON backfill below will replace these with
        // real s1/s2/s3 on tracks that emit per-sector splits.
        const ins = db.prepare(`
          INSERT OR IGNORE INTO laps
            (driver_name, driver_guid, car, track, track_config, ms, lap_timestamp,
             s1, s2, s3, cuts, valid, session_date, source_file)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 'udp:live')
        `).run(
          car.name,
          car.guid,
          car.model,
          udpState.session.track  || '',
          udpState.session.config || '',
          lapTime,
          lapMsSinceStart,
          lapTime,   // s1 placeholder = lap_time (overwritten by JSON if it has real sectors)
          cuts,
          cuts === 0 ? 1 : 0,
          date,
        );
        // Only bump player totals when the lap was actually new (the dedup
        // index rejects repeats; we don't double-count those).
        if (ins.changes > 0 && cuts === 0) {
          db.prepare(`
            UPDATE players SET total_laps = total_laps + 1, last_seen = ?, last_car = ?, last_track = ?
            WHERE guid = ?
          `).run(date, car.model, udpState.session.track || '', car.guid);
          maybeNotifyRecord({
            guid:        car.guid,
            name:        car.name,
            lapMs:       lapTime,
            car:         car.model,
            track:       udpState.session.track  || '',
            trackConfig: udpState.session.config || '',
            lapId:       ins.lastInsertRowid,
          });
        }
      } catch (e) { log.warn('[UDP] lap insert failed:', e.message); }
      break;
    }

    case ACSP.CAR_INFO: {
      // Verified against real captures of this Go acServer build:
      //   ev (1) → car_id (1) → isConnected (1) → model utf32 → skin utf32
      // For disconnected slots the packet ENDS at skin. For connected slots
      // it continues with name utf32 → an empty utf32 separator (likely
      // "driver_team" or a guids-list prefix) → guid utf32.
      const carId = buf[off++];
      const isConnected = !!buf[off++];
      const model = readUtf32Str(buf, off); off = model.next;
      const skin  = readUtf32Str(buf, off); off = skin.next;
      if (!isConnected) break; // empty slot — packet ends here
      const name  = readUtf32Str(buf, off); off = name.next;
      // Skip the empty utf32 string acServer puts between name and guid on
      // this build. Its semantic is unclear (driver_team? guids list?) but
      // it's always zero-length in observed traffic so the safe parse is to
      // consume one length byte and move on.
      const _team = readUtf32Str(buf, off); off = _team.next; void _team;
      const guid  = readUtf32Str(buf, off); off = guid.next;
      // Sanity-check the guid before touching state — a parser drift would
      // otherwise replace a known JOIN entry with garbage.
      if (!/^\d{17}$/.test(guid.value)) {
        log.warn(`[UDP] CAR_INFO car_id=${carId} parsed bad guid='${guid.value}' — skipping populate`);
        break;
      }
      const existing = udpState.cars.get(carId) || {};
      udpState.cars.set(carId, {
        carId,
        // CAR_INFO often replies with an empty name; preserve whatever the
        // NEW_CONNECTION path put there if we already had it.
        name:    name.value || existing.name || '',
        team:    '',
        guid:    guid.value,
        model:   model.value,
        skin:    skin.value,
        joinedAt: existing.joinedAt || Date.now(),
        bestLap:  existing.bestLap || 0,
        lastLap:  existing.lastLap || 0,
        lapsCount: existing.lapsCount || 0,
      });
      log.info(`[UDP] CAR_INFO car_id=${carId} ${name.value || '(unnamed)'} (${guid.value}) model=${model.value}`);
      break;
    }

    case ACSP.CAR_UPDATE: {
      // 10Hz position stream from acServer. Layout verified against this Go
      // build via hex capture:
      //   car_id (1) → pos.x (f32) → pos.y (f32) → pos.z (f32) →
      //   vel.x (f32) → vel.y (f32) → vel.z (f32) →
      //   gear (1) → engine_rpm (u16 LE) → normalized_spline_pos (f32)
      // Total payload after the event byte = 32 bytes. acServer's Y axis is
      // altitude (vertical), so we only need (x, z) for the top-down minimap.
      // Speed is the horizontal magnitude of the velocity vector.
      const carId = buf[off++];
      const car   = udpState.cars.get(carId);
      // Drop updates for unknown cars — the slot is mid-assignment or the
      // NEW_CONNECTION packet was lost. The next LAP_COMPLETED-on-unknown
      // fallback will request CAR_INFO and rehydrate the entry.
      if (!car) break;
      const px = buf.readFloatLE(off); off += 4;
      const py = buf.readFloatLE(off); off += 4; void py;
      const pz = buf.readFloatLE(off); off += 4;
      const vx = buf.readFloatLE(off); off += 4;
      const vy = buf.readFloatLE(off); off += 4; void vy;
      const vz = buf.readFloatLE(off); off += 4;
      const gear = buf[off++];
      const rpm  = buf.readUInt16LE(off); off += 2;
      const spl  = buf.readFloatLE(off);  off += 4;
      // 3.6 = m/s → km/h. We don't sqrt vy because the minimap is top-down;
      // a car going uphill at 100 km/h reads the same as one going on the
      // flat. Cosmetic difference, mostly invisible at AC's lateral scales.
      const velKmh = Math.sqrt(vx*vx + vz*vz) * 3.6;
      car.pos = {
        x:          px,
        z:          pz,
        velKmh:     velKmh,
        gear:       gear,
        rpm:        rpm,
        splinePos:  spl,
        updatedAt:  Date.now(),
      };
      break;
    }

    case ACSP.CHAT:
    case ACSP.CLIENT_LOADED:
    case ACSP.CLIENT_EVENT:
    case ACSP.END_SESSION:
    case ACSP.ERROR:
      // Acknowledged. Not on the critical path for lap persistence.
      break;

    default:
      log.warn('[UDP] unhandled event type:', ev, 'length:', buf.length);
  }
}

// Live-driver snapshot for apiPlayers. Returns null if the listener has no
// data so the caller falls back to /api/details / /JSON|0.
function udpGetLivePlayers() {
  if (!udpState.cars.size) return null;
  return Array.from(udpState.cars.values()).map(c => ({
    id:     c.carId,
    name:   c.name,
    steam:  c.guid,
    nation: '',
    carId:  c.model,
    car:    formatName(c.model),
    bestMs: c.bestLap || 0,
    lastMs: c.lastLap || 0,
    laps:   c.lapsCount || 0,
    ping:   0,
  }));
}

// Public helper: tell acServer to advance to the next session. Returns true
// if the command was sent (the server's response goes back as NEW_SESSION).
function udpNextSession() {
  return udpSendCommand(ACSP.NEXT_SESSION);
}

// ── Live position telemetry (SSE) ────────────────────────────────────────────
// Broadcasts the current position of every connected car to subscribers of
// /api/positions/stream at 4Hz. Even though acServer emits CAR_UPDATE at 10Hz,
// 4Hz on the wire is enough fluidity for top-down dots on a static map and
// roughly halves the per-client bandwidth.
//
// The broadcast timer is ref-counted on the subscriber set: it only ticks
// while at least one EventSource is open, so an empty Dashboard tab on the
// other side of Cloudflare doesn't drain CPU or push useless bytes.

const _positionSseClients = new Set();
let _positionBroadcastTimer = null;
const POSITION_BROADCAST_INTERVAL_MS = 250;

function _broadcastPositions() {
  if (_positionSseClients.size === 0) {
    clearInterval(_positionBroadcastTimer);
    _positionBroadcastTimer = null;
    return;
  }
  // Snapshot what's currently live. udpState.cars is keyed by car_id, but the
  // wire format collapses to a flat array — the frontend doesn't care about
  // the map ordering, and JSON.stringify(Map) is empty by default.
  const positions = [];
  for (const c of udpState.cars.values()) {
    if (!c.pos) continue; // car connected but no CAR_UPDATE seen yet
    positions.push({
      id:        c.carId,
      name:      c.name,
      car:       c.model,
      x:         c.pos.x,
      z:         c.pos.z,
      velKmh:    Math.round(c.pos.velKmh),
      splinePos: c.pos.splinePos,
    });
  }
  const data = `data: ${JSON.stringify({ positions, ts: Date.now() })}\n\n`;
  for (const res of [..._positionSseClients]) {
    try { res.write(data); } catch { _positionSseClients.delete(res); }
  }
}

function apiPositionsStream(req, res) {
  const user = getSession(req)?.username || '';
  const userSet = _sseByUser.get(user) || new Set();
  if (userSet.size >= SSE_PER_USER_CAP) {
    return json(res, 429, { error: 'Too many concurrent streams for this user — close other tabs and retry' });
  }
  // Idempotent re-subscribe: ensures the running acServer is emitting
  // CAR_UPDATE before the first frame is requested. Cheap (3-byte UDP
  // packet to localhost) and harmless if the subscription was already
  // active. Catches the case where the panel started before acServer
  // OR acServer was restarted while no SSE client was open.
  udpEnableRealtimePos();
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Initial snapshot so the client doesn't have to wait up to 250ms for the
  // first frame after connecting — feels noticeably snappier on dashboard load.
  _positionSseClients.add(res);
  userSet.add(res);
  _sseByUser.set(user, userSet);
  _broadcastPositions();

  // Kick off the broadcast timer if this is the first subscriber. Subsequent
  // subscribers just join the existing tick.
  if (!_positionBroadcastTimer) {
    _positionBroadcastTimer = setInterval(_broadcastPositions, POSITION_BROADCAST_INTERVAL_MS);
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    _positionSseClients.delete(res);
    const set = _sseByUser.get(user);
    if (set) {
      set.delete(res);
      if (set.size === 0) _sseByUser.delete(user);
    }
    // The broadcast timer stops itself on the next tick when the set is empty.
  };
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { cleanup(); try { res.destroy(); } catch {} }
  }, 25000);
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// ── Server control ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Find acServer PID by name (for adoption when dashboard restarts mid-run)
function findACPid() {
  return new Promise(resolve => {
    const p = spawn('pidof', ['-s', 'acServer']);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', () => {
      const pid = parseInt(out.trim(), 10);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
    p.on('error', () => resolve(null));
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Wait until either (a) HTTP /INFO answers, or (b) timeout elapses
async function waitForACUp(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { running } = await getACInfo();
    if (running) return true;
    await sleep(400);
  }
  return false;
}

async function waitForACDown(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { running } = await getACInfo();
    const childAlive = acChild && !acChild.killed;
    const adoptedAlive = !childAlive && (await findACPid());
    if (!running && !childAlive && !adoptedAlive) return true;
    await sleep(300);
  }
  return false;
}

function checkBinary() {
  try {
    const st = fs.statSync(AC_BIN);
    if (!st.isFile()) return `AC_SERVER_BIN no es un archivo: ${AC_BIN}`;
    fs.accessSync(AC_BIN, fs.constants.X_OK);
    return null;
  } catch (e) {
    if (e.code === 'ENOENT') return `Binario no encontrado: ${AC_BIN} (revisa AC_SERVER_BIN en .env)`;
    if (e.code === 'EACCES') return `Binario sin permiso de ejecución: ${AC_BIN}`;
    return `Binario inaccesible: ${e.message}`;
  }
}

function spawnAC() {
  return new Promise((resolve) => {
    const err = checkBinary();
    if (err) { log.error('[AC] spawn error:', err); _acRunSince = null; return resolve({ ok: false, error: err }); }

    // Open the log file once, hand its FD to the child as both stdout and
    // stderr, then close our own reference. The child keeps a dup'd copy of
    // the FD pointing at the file — so when the panel exits (e.g. systemd
    // restart) the child does NOT get SIGPIPE on its next write, the way a
    // pipe-based stdio would. Combined with `detached: true` below, this
    // makes acServer fully outlive a panel restart and be re-adopted by the
    // new node process via findACPid() / pidof.
    let logFd;
    try {
      fs.mkdirSync(path.dirname(AC_LOG_FILE), { recursive: true });
      logFd = fs.openSync(AC_LOG_FILE, 'a');
    } catch (e) {
      log.error('[AC] cannot open log file:', e.message);
      _acRunSince = null;
      return resolve({ ok: false, error: `No se puede abrir el log: ${e.message}` });
    }

    try {
      const child = spawn(AC_BIN, [], {
        cwd:      AC_BIN_DIR,
        // stdin ignored; stdout + stderr go straight to the log file. No node-held
        // pipes means nothing closes when the panel exits, so the child survives.
        stdio:    ['ignore', logFd, logFd],
        // setsid() — put acServer in its own session + process group so SIGHUP
        // / SIGTERM aimed at the panel's session do not propagate.
        detached: true,
      });
      // Parent no longer needs the FD; the child has its own copy.
      try { fs.closeSync(logFd); } catch {}
      // Let the event loop exit even if acServer is still running.
      try { child.unref(); } catch {}

      let settled = false;
      child.once('error', e => {
        if (settled) return;
        settled = true;
        log.error('[AC] spawn error:', e.message);
        acChild = null;
        resolve({ ok: false, error: e.message });
      });
      child.once('exit', (code, signal) => {
        if (acChild === child) acChild = null;
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: `Proceso terminó al arrancar (code=${code} signal=${signal})` });
        }
      });
      acChild = child;
      // Give it a moment to confirm it didn't crash immediately.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        if (acChild && !acChild.killed) resolve({ ok: true });
        else resolve({ ok: false, error: 'Proceso no continuó tras arrancar' });
      }, 500);
    } catch (e) {
      try { fs.closeSync(logFd); } catch {}
      log.error('[AC] spawn exception:', e.message);
      acChild = null;
      resolve({ ok: false, error: e.message });
    }
  });
}

async function killAC() {
  // 1. tracked child
  if (acChild && !acChild.killed) {
    try { acChild.kill('SIGTERM'); } catch {}
  }
  // 2. adopted process (dashboard restarted while AC was running)
  let adoptedPid = await findACPid();
  if (adoptedPid) {
    try { process.kill(adoptedPid, 'SIGTERM'); } catch {}
  }

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const childAlive = acChild && !acChild.killed && pidAlive(acChild.pid);
    if (!childAlive) acChild = null;
    adoptedPid = await findACPid();
    if (!childAlive && !adoptedPid) {
      _acRunSince  = null;
      _acFailCount = 0;
      return { ok: true };
    }
    await sleep(250);
  }

  // SIGKILL fallback
  if (acChild) { try { acChild.kill('SIGKILL'); } catch {} acChild = null; }
  adoptedPid = await findACPid();
  if (adoptedPid) { try { process.kill(adoptedPid, 'SIGKILL'); } catch {} }
  await sleep(400);

  const stillUp = await findACPid();
  _acRunSince  = null;
  _acFailCount = 0;
  if (stillUp) return { ok: false, error: 'Failed to terminate acServer' };
  return { ok: true };
}

// Serializes every code path that mutates acChild — start, stop, restart, AND
// the auto-restart that piggybacks on /api/config and /api/session/apply.
// Without a *global* lock spanning all four, two requests racing through
// killAC + spawnAC could end up with duplicate acServer processes, or with
// acChild pointing at the first while the second runs orphan.
let _serverActionInFlight = false;
function _acquireServerLock() {
  if (_serverActionInFlight) return null;
  _serverActionInFlight = true;
  return () => { _serverActionInFlight = false; };
}
async function withServerActionLock(req, res, fn) {
  const release = _acquireServerLock();
  if (!release) return json(res, 409, { error: 'Another server action is in progress' });
  try { return await fn(); }
  finally { release(); }
}

async function apiServerStart(req, res) {
  if (!checkPermission(req, 'serverControl')) return json(res, 403, { error: 'Forbidden' });
  if (!checkRateLimit('server-ctl', clientIp(req), 20, 60 * 1000))
    return json(res, 429, { error: 'Rate limit: too many server actions' });
  return withServerActionLock(req, res, async () => {
    const actor = checkAnyAuth(req)?.username || 'unknown';
    if (acChild && !acChild.killed) return json(res, 409, { error: 'Server is already running' });
    if (await findACPid())          return json(res, 409, { error: 'Server is already running' });
    const { running } = await getACInfo();
    if (running) return json(res, 409, { error: 'Server is already running' });

    const r = await spawnAC();
    if (!r.ok) {
      insertAuditLog(actor, 'server.start.fail', '', r.error || 'spawn failed');
      return json(res, 500, { error: r.error || 'Failed to start server' });
    }
    const up = await waitForACUp(8000);
    if (!up) {
      insertAuditLog(actor, 'server.start.fail', '', 'HTTP port did not respond within 8s');
      return json(res, 500, { error: 'acServer started but its HTTP port did not respond within 8s — check ports and logs' });
    }
    insertAuditLog(actor, 'server.start');
    json(res, 200, { ok: true });
  });
}

async function apiServerStop(req, res) {
  if (!checkPermission(req, 'serverControl')) return json(res, 403, { error: 'Forbidden' });
  if (!checkRateLimit('server-ctl', clientIp(req), 20, 60 * 1000))
    return json(res, 429, { error: 'Rate limit: too many server actions' });
  return withServerActionLock(req, res, async () => {
    const actor = checkAnyAuth(req)?.username || 'unknown';
    const r = await killAC();
    if (!r.ok) {
      insertAuditLog(actor, 'server.stop.fail', '', r.error || 'kill failed');
      return json(res, 500, { error: r.error || 'Failed to stop server' });
    }
    await waitForACDown(6000);
    insertAuditLog(actor, 'server.stop');
    json(res, 200, { ok: true });
  });
}

async function apiServerRestart(req, res) {
  if (!checkPermission(req, 'serverControl')) return json(res, 403, { error: 'Forbidden' });
  if (!checkRateLimit('server-ctl', clientIp(req), 20, 60 * 1000))
    return json(res, 429, { error: 'Rate limit: too many server actions' });
  return withServerActionLock(req, res, async () => {
    const actor = checkAnyAuth(req)?.username || 'unknown';
    const k = await killAC();
    if (!k.ok) {
      insertAuditLog(actor, 'server.restart.fail', '', `stop: ${k.error || 'kill failed'}`);
      return json(res, 500, { error: k.error || 'Failed to stop server' });
    }
    await waitForACDown(6000);
    await sleep(500);
    const s = await spawnAC();
    if (!s.ok) {
      insertAuditLog(actor, 'server.restart.fail', '', `spawn: ${s.error || 'spawn failed'}`);
      return json(res, 500, { error: s.error || 'Failed to start server' });
    }
    const up = await waitForACUp(10000);
    if (!up) {
      insertAuditLog(actor, 'server.restart.fail', '', 'HTTP port did not respond within 10s');
      return json(res, 500, { error: 'acServer restarted but its HTTP port did not respond within 10s — check ports and logs' });
    }
    insertAuditLog(actor, 'server.restart');
    json(res, 200, { ok: true });
  });
}

// acServer no soporta SIGHUP para recargar config: el "reload" es un restart
// rápido. Lo dejamos como alias claro para no romper la UI existente.
async function apiServerReload(req, res) {
  return apiServerRestart(req, res);
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Login attempts persist to SQLite so a brute-forcer cannot reset by triggering
// a server restart. Other rate buckets (mod uploads, server control) stay in
// memory — those are operational throttles, not a security boundary.
const _loginAttempts = new Map(); // memory cache to avoid hitting DB on every request when the IP is well-behaved
const _rateBuckets   = new Map(); // `${kind}|${ip}` → { count, resetAt }
function _loadLoginAttempt(ip) {
  if (_loginAttempts.has(ip)) return _loginAttempts.get(ip);
  if (!db) return null;
  try {
    const row = db.prepare('SELECT count, reset_at FROM login_attempts WHERE ip = ?').get(ip);
    if (!row) return null;
    const e = { count: row.count, resetAt: row.reset_at };
    _loginAttempts.set(ip, e);
    return e;
  } catch { return null; }
}
function _saveLoginAttempt(ip, e) {
  _loginAttempts.set(ip, e);
  if (!db) return;
  try {
    db.prepare(`INSERT INTO login_attempts (ip, count, reset_at) VALUES (?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at`)
      .run(ip, e.count, e.resetAt);
  } catch {}
}
function _clearLoginAttempt(ip) {
  _loginAttempts.delete(ip);
  if (!db) return;
  try { db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip); } catch {}
}
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const e   = _loadLoginAttempt(ip);
  if (e && now < e.resetAt) {
    if (e.count >= 5) return false;
    e.count++;
    _saveLoginAttempt(ip, e);
  } else {
    _saveLoginAttempt(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
  }
  return true;
}
function checkRateLimit(kind, ip, limit, windowMs) {
  const now = Date.now();
  const key = `${kind}|${ip || '_'}`;
  const e   = _rateBuckets.get(key);
  if (e && now < e.resetAt) {
    if (e.count >= limit) return false;
    e.count++;
  } else {
    _rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
  }
  return true;
}
// Behind Cloudflare / a trusted proxy, every request shares the same socket IP and the
// rate limiter would either DoS everyone (one bucket) or be useless. Set TRUST_PROXY=1
// in .env to honour CF-Connecting-IP / X-Forwarded-For instead.
//
// CRITICAL: only honour those headers when the **socket-level** peer is itself a
// trusted proxy. Without this check, any client that can reach the panel directly
// can send `CF-Connecting-IP: 1.2.3.4` to spoof IPs, bypassing the per-IP login
// lockout and framing other IPs in the audit log.
//
// The trusted-proxy set defaults to Cloudflare's published edge ranges
// (https://www.cloudflare.com/ips/) plus loopback. Override with
// TRUST_PROXY_FROM=cidr1,cidr2,... when sitting behind a different proxy (nginx,
// Caddy, Tailscale Funnel, etc.). When TRUST_PROXY=1 but the request did not
// arrive from a trusted IP, the headers are ignored and the socket IP wins —
// so a misconfigured `HOST=0.0.0.0` no longer means "anyone can spoof".
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// Cloudflare edge IPs (https://www.cloudflare.com/ips/). Refresh if/when CF
// publishes new ranges; the panel's own loopback covers direct healthchecks.
const DEFAULT_PROXY_CIDRS = [
  // IPv4
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  // IPv6 (prefix string match; coarse but adequate for /32–/48 CF ranges)
  '2400:cb00::', '2606:4700::', '2803:f800::', '2405:b500::',
  '2405:8100::', '2a06:98c0::', '2c0f:f248::',
  // Loopback
  '127.0.0.0/8', '::1',
];

function _parseProxyEntry(entry) {
  if (!entry) return null;
  const v4 = entry.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\/(\d+))?$/);
  if (v4) {
    const ip   = ((+v4[1]) << 24 | (+v4[2]) << 16 | (+v4[3]) << 8 | (+v4[4])) >>> 0;
    const bits = v4[5] !== undefined ? +v4[5] : 32;
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return { type: 'v4', net: ip & mask, mask };
  }
  if (entry.includes(':')) {
    // Coarse IPv6 prefix: strip trailing `::` or `/N` and match by string prefix.
    // Works for the common /32, /48 ranges Cloudflare publishes; not a full
    // CIDR engine. Refine if a future operator needs tighter IPv6 buckets.
    const prefix = entry.split('/')[0].replace(/::$/, ':').toLowerCase();
    return { type: 'v6', prefix };
  }
  return null;
}

// Returns { matchers, source, rejected } so the boot banner can surface a
// misconfiguration that would otherwise silently disable forward-IP trust:
// - source: 'env' if TRUST_PROXY_FROM was set, 'default' if we fell back to
//   the published Cloudflare ranges.
// - rejected: list of entries that didn't parse (typo, wrong CIDR shape, …).
//   When TRUST_PROXY=1 and matchers is empty AFTER parsing, the panel can
//   still boot but every clientIp() call ignores the headers — exactly the
//   silent "TRUST_PROXY=1 but nothing works" trap we want to flag loudly.
function _buildTrustedProxyMatchers() {
  const envRaw    = process.env.TRUST_PROXY_FROM;
  const usedEnv   = envRaw !== undefined && envRaw !== '';
  const raw       = usedEnv ? envRaw : DEFAULT_PROXY_CIDRS.join(',');
  const entries   = raw.split(',').map(s => s.trim()).filter(Boolean);
  const matchers  = [];
  const rejected  = [];
  for (const e of entries) {
    const m = _parseProxyEntry(e);
    if (m) matchers.push(m); else rejected.push(e);
  }
  return { matchers, source: usedEnv ? 'env' : 'default', rejected };
}
const _trustedProxyConfig   = _buildTrustedProxyMatchers();
const _trustedProxyMatchers = _trustedProxyConfig.matchers;

function _ipv4ToInt(ip) {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return (((+m[1]) << 24 | (+m[2]) << 16 | (+m[3]) << 8 | (+m[4])) >>> 0);
}

function isTrustedProxyIp(rawIp) {
  if (!rawIp) return false;
  // Normalise IPv4-mapped IPv6 (::ffff:1.2.3.4) — Node hands this shape out of
  // dual-stack sockets, and we want to match it against the v4 allowlist.
  const ip = rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;
  const v4 = _ipv4ToInt(ip);
  if (v4 !== null) {
    for (const e of _trustedProxyMatchers) {
      if (e.type === 'v4' && (v4 & e.mask) === e.net) return true;
    }
    return false;
  }
  const lower = ip.toLowerCase();
  for (const e of _trustedProxyMatchers) {
    if (e.type === 'v6' && lower.startsWith(e.prefix)) return true;
  }
  return false;
}

function clientIp(req) {
  const socketIp = req.socket?.remoteAddress || '';
  if (TRUST_PROXY && isTrustedProxyIp(socketIp)) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  // Untrusted source (or TRUST_PROXY off) — never honour spoofable headers.
  return socketIp;
}

// ── Auth API ─────────────────────────────────────────────────────────────────
async function apiAuthLogin(req, res) {
  try {
    const ip   = clientIp(req);
    if (!checkLoginRateLimit(ip))
      return json(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });

    const body = await readBody(req);
    const { username, password } = body;
    if (!username || !password) return json(res, 400, { error: 'Username and password are required' });

    if (!db) return json(res, 503, { error: 'Database unavailable' });

    const user = db.prepare('SELECT * FROM panel_users WHERE username = ?').get(username);
    if (!user) {
      // Run verifyPassword against the dummy hash so the no-user branch costs
      // the same wall-clock time as the bad-password branch. Without this, an
      // attacker can enumerate valid usernames by measuring response time —
      // ~50ms for real users (scrypt) vs <1ms for unknowns.
      verifyPassword(password, _DUMMY_LOGIN_SALT, _DUMMY_LOGIN_HASH);
      return json(res, 401, { error: 'Invalid username or password' });
    }

    if (!verifyPassword(password, user.salt, user.password_hash))
      return json(res, 401, { error: 'Invalid username or password' });

    // Second factor. When 2FA is enabled on this account, password alone is
    // not enough — the client must also send a 6-digit TOTP code in `totp`.
    // We respond { needsTotp: true } so the UI can render the second field
    // instead of treating the absence of `totp` as a generic auth failure.
    // The TOTP check itself counts against the same rate-limit bucket as a
    // bad password so a brute-forcer cannot grind through the 1M code space.
    if (user.totp_enabled === 1 && user.totp_secret) {
      const submittedCode = String(body.totp || '').replace(/\s/g, '');
      if (!submittedCode) {
        return json(res, 200, { ok: false, needsTotp: true });
      }
      if (!totpVerify(user.totp_secret, submittedCode)) {
        return json(res, 401, { error: 'Invalid 2FA code', needsTotp: true });
      }
    }

    // Lazy upgrade: re-hash legacy pbkdf2 entries with scrypt on successful login
    if (!user.password_hash.startsWith('scrypt$')) {
      try { db.prepare('UPDATE panel_users SET password_hash = ? WHERE username = ?')
        .run(hashPasswordScrypt(password, user.salt), username); } catch {}
    }

    _clearLoginAttempt(ip); // reset on success
    const token = createSession(username, user.role);
    res.setHeader('Set-Cookie', sessionCookieHeader(token, requestIsHttps(req)));
    const permissions = user.role === 'admin'
      ? Object.fromEntries(ROLE_PERMISSIONS.map(p => [p, true]))
      : getUserRolePermissions();
    json(res, 200, { ok: true, user: { name: username, role: user.role, mustChangePassword: user.must_change_password === 1, twoFactorEnabled: user.totp_enabled === 1, permissions } });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// ── 2FA / TOTP endpoints ─────────────────────────────────────────────────────
// Three-step flow:
//   1. POST /api/auth/2fa/setup     → server generates a fresh base32 secret,
//                                     stores it in totp_pending, returns the
//                                     secret + otpauth:// URI for the client
//                                     to render as QR + manual-entry key.
//   2. POST /api/auth/2fa/confirm   → client sends a 6-digit code; if valid
//                                     against totp_pending, the secret is
//                                     promoted to totp_secret + totp_enabled=1
//                                     and the pending slot cleared. Now the
//                                     account requires 2FA on every login.
//   3. POST /api/auth/2fa/disable   → requires the current password (proves
//                                     it's the live user, not a stolen cookie)
//                                     and a TOTP code (proves the user still
//                                     has the authenticator). Clears the
//                                     secret + enabled flag.
async function apiAuth2faSetup(req, res) {
  const sess = getSession(req);
  if (!sess) return json(res, 401, { error: 'Unauthorized' });
  if (!db) return json(res, 503, { error: 'Database unavailable' });
  // 20 random bytes → 32-char base32 secret (RFC 4226 minimum is 16 bytes for
  // SHA-1; 20 matches what most authenticator apps assume).
  const secret = _base32Encode(crypto.randomBytes(20));
  try {
    db.prepare('UPDATE panel_users SET totp_pending = ? WHERE username = ?').run(secret, sess.username);
  } catch (e) { return json(res, 500, { error: e.message }); }
  const otpauth = totpProvisioningUri({
    secret,
    account: sess.username,
    issuer:  'Assetto Server Panel',
  });
  json(res, 200, { ok: true, secret, otpauth });
}

async function apiAuth2faConfirm(req, res) {
  try {
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: 'Unauthorized' });
    const ip = clientIp(req);
    if (!checkLoginRateLimit(ip))
      return json(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
    const body = await readBody(req);
    const code = String(body.code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return json(res, 400, { error: 'code must be 6 digits' });
    if (!db) return json(res, 503, { error: 'Database unavailable' });
    const row = db.prepare('SELECT totp_pending FROM panel_users WHERE username = ?').get(sess.username);
    if (!row?.totp_pending) return json(res, 400, { error: 'No pending 2FA setup. Call /api/auth/2fa/setup first.' });
    if (!totpVerify(row.totp_pending, code)) return json(res, 401, { error: 'Invalid code. Make sure your authenticator clock is in sync.' });
    db.prepare(`UPDATE panel_users
                   SET totp_secret = totp_pending,
                       totp_pending = '',
                       totp_enabled = 1
                 WHERE username = ?`).run(sess.username);
    _clearLoginAttempt(ip);
    insertAuditLog(sess.username, 'user.2fa.enable', sess.username);
    json(res, 200, { ok: true });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

async function apiAuth2faDisable(req, res) {
  try {
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: 'Unauthorized' });
    const ip = clientIp(req);
    if (!checkLoginRateLimit(ip))
      return json(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
    const body = await readBody(req);
    const currentPassword = String(body.currentPassword || '');
    const code = String(body.code || '').replace(/\s/g, '');
    if (!currentPassword || !code) return json(res, 400, { error: 'currentPassword and code are required' });
    if (!db) return json(res, 503, { error: 'Database unavailable' });
    const user = db.prepare('SELECT * FROM panel_users WHERE username = ?').get(sess.username);
    if (!user) return json(res, 404, { error: 'User not found' });
    if (!verifyPassword(currentPassword, user.salt, user.password_hash))
      return json(res, 401, { error: 'Current password is incorrect' });
    if (!user.totp_enabled || !user.totp_secret)
      return json(res, 400, { error: '2FA is not currently enabled' });
    if (!totpVerify(user.totp_secret, code))
      return json(res, 401, { error: 'Invalid 2FA code' });
    db.prepare(`UPDATE panel_users
                   SET totp_secret = '',
                       totp_pending = '',
                       totp_enabled = 0
                 WHERE username = ?`).run(sess.username);
    _clearLoginAttempt(ip);
    insertAuditLog(sess.username, 'user.2fa.disable', sess.username);
    json(res, 200, { ok: true });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Rotate the TOTP secret without going through disable → setup. The user
// already has 2FA on, wants a fresh secret (lost device, new authenticator
// app, periodic rotation), and shouldn't have to leave the account
// without a second factor in between. Atomic in two phases like setup:
//   1. This endpoint requires currentPassword + a code from the CURRENT
//      secret (so a stolen session cookie can't replace the secret) and
//      stages a fresh base32 in totp_pending. totp_secret stays put, so
//      the old code still logs the user in if they back out here.
//   2. The user confirms with the existing /api/auth/2fa/confirm flow,
//      which promotes totp_pending → totp_secret and the old secret is
//      gone for good. Until that confirm, the rotation is reversible —
//      just don't re-scan the QR.
async function apiAuth2faRotate(req, res) {
  try {
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: 'Unauthorized' });
    const ip = clientIp(req);
    if (!checkLoginRateLimit(ip))
      return json(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
    const body = await readBody(req);
    const currentPassword = String(body.currentPassword || '');
    const code = String(body.code || '').replace(/\s/g, '');
    if (!currentPassword || !code) return json(res, 400, { error: 'currentPassword and code are required' });
    if (!db) return json(res, 503, { error: 'Database unavailable' });
    const user = db.prepare('SELECT * FROM panel_users WHERE username = ?').get(sess.username);
    if (!user) return json(res, 404, { error: 'User not found' });
    if (!user.totp_enabled || !user.totp_secret)
      return json(res, 400, { error: '2FA is not currently enabled — call /api/auth/2fa/setup instead' });
    if (!verifyPassword(currentPassword, user.salt, user.password_hash))
      return json(res, 401, { error: 'Current password is incorrect' });
    if (!totpVerify(user.totp_secret, code))
      return json(res, 401, { error: 'Invalid 2FA code' });
    const secret = _base32Encode(crypto.randomBytes(20));
    db.prepare('UPDATE panel_users SET totp_pending = ? WHERE username = ?').run(secret, sess.username);
    const otpauth = totpProvisioningUri({
      secret,
      account: sess.username,
      issuer:  'Assetto Server Panel',
    });
    _clearLoginAttempt(ip);
    insertAuditLog(sess.username, 'user.2fa.rotate', sess.username);
    json(res, 200, { ok: true, secret, otpauth, rotating: true });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Status endpoint for the Profile page UI — returns whether 2FA is on for the
// current session's user, and whether a pending (un-confirmed) setup exists.
function apiAuth2faStatus(req, res) {
  const sess = getSession(req);
  if (!sess) return json(res, 401, { error: 'Unauthorized' });
  if (!db) return json(res, 200, { enabled: false, pending: false });
  const row = db.prepare('SELECT totp_enabled, totp_pending FROM panel_users WHERE username = ?').get(sess.username);
  json(res, 200, {
    enabled: row?.totp_enabled === 1,
    pending: !!(row?.totp_pending && row.totp_pending.length > 0),
  });
}

function apiAuthLogout(req, res) {
  const token = readCookie(req, 'sid');
  if (token) deleteSession(token);
  // Mirror the Secure flag on the clearing cookie. Some browsers refuse to
  // overwrite a Secure cookie via a non-Secure Set-Cookie response, so the
  // expired sid would linger in the jar.
  const secure = requestIsHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
  json(res, 200, { ok: true });
}

function apiAuthMe(req, res) {
  const sess = getSession(req);
  if (!sess) return json(res, 401, { error: 'Not authenticated' });
  // db can be null when SQLite init failed at startup. Guard the lookup so the
  // request returns a sensible payload instead of crashing the handler with
  // "Cannot read properties of undefined (reading 'get')".
  let mustChange = false;
  let twoFactorEnabled = false;
  if (db) {
    try {
      const row = db.prepare('SELECT must_change_password, totp_enabled FROM panel_users WHERE username = ?').get(sess.username);
      mustChange = row?.must_change_password === 1;
      twoFactorEnabled = row?.totp_enabled === 1;
    } catch {}
  }
  const permissions = sess.role === 'admin'
    ? Object.fromEntries(ROLE_PERMISSIONS.map(p => [p, true]))
    : getUserRolePermissions();
  json(res, 200, { username: sess.username, role: sess.role, mustChangePassword: mustChange, twoFactorEnabled, permissions });
}

async function apiAuthChangePassword(req, res) {
  try {
    // Require a valid session — username is derived from it, not from the body
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: 'Unauthorized' });

    const ip = clientIp(req);
    if (!checkLoginRateLimit(ip))
      return json(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });

    const body = await readBody(req);
    const { currentPassword, newPassword } = body;
    if (!currentPassword || !newPassword)
      return json(res, 400, { error: 'All fields are required' });
    const policyErr = passwordPolicyError(newPassword);
    if (policyErr) return json(res, 400, { error: policyErr });
    if (!db) return json(res, 503, { error: 'Database unavailable' });

    const username = sess.username;
    const user = db.prepare('SELECT * FROM panel_users WHERE username = ?').get(username);
    if (!user) return json(res, 404, { error: 'User not found' });

    if (!verifyPassword(currentPassword, user.salt, user.password_hash))
      return json(res, 401, { error: 'Current password is incorrect' });

    const newSalt = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE panel_users SET password_hash = ?, salt = ?, must_change_password = 0 WHERE username = ?')
      .run(hashPassword(newPassword, newSalt), newSalt, username);

    // Purge every existing session for this user — including the one that just
    // changed the password — and mint a fresh one for the active request. If
    // the request that reached this endpoint was actually an attacker on a
    // stolen cookie, the legitimate user's password change now invalidates
    // every device that had cached state, not just future ones. Then refresh
    // the response cookie so the legitimate browser stays logged in.
    try { db.prepare('DELETE FROM sessions WHERE username = ?').run(username); } catch {}
    const newToken = createSession(username, user.role);
    res.setHeader('Set-Cookie', sessionCookieHeader(newToken, requestIsHttps(req)));

    _clearLoginAttempt(ip);
    insertAuditLog(username, 'user.update', username, 'self password change');
    json(res, 200, { ok: true });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// ── Panel users CRUD ─────────────────────────────────────────────────────────
function apiPanelUsers(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (!db) return json(res, 200, []);
  const rows = db.prepare('SELECT username, role, created_at FROM panel_users ORDER BY created_at').all();
  json(res, 200, rows.map(r => ({
    id:      r.username,
    name:    r.username,
    role:    r.role,
    created: (r.created_at || '').slice(0, 10),
  })));
}

async function apiPanelUserCreate(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    const body = await readBody(req);
    const { username, password, role } = body;
    if (!username || !password) return json(res, 400, { error: 'Username and password are required' });
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(username))
      return json(res, 400, { error: 'Username must be 1–64 chars: letters, numbers, _ and - only' });
    {
      const policyErr = passwordPolicyError(password);
      if (policyErr) return json(res, 400, { error: policyErr });
    }
    // Reject unknown roles instead of silently coercing — caller intent stays explicit
    if (role !== undefined && role !== 'admin' && role !== 'user')
      return json(res, 400, { error: 'role must be "admin" or "user"' });
    if (!db) return json(res, 503, { error: 'Database unavailable' });
    // Case-insensitive uniqueness — 'admin' and 'Admin' must not coexist
    const exists = db.prepare('SELECT 1 FROM panel_users WHERE LOWER(username) = LOWER(?)').get(username);
    if (exists) return json(res, 409, { error: 'Username already exists' });
    const salt = crypto.randomBytes(32).toString('hex');
    const finalRole = role || 'user';
    db.prepare('INSERT INTO panel_users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)')
      .run(username, hashPassword(password, salt), salt, finalRole);
    insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'user.create', username, finalRole);
    json(res, 200, { ok: true });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

async function apiPanelUserUpdate(req, res, username) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    const body = await readBody(req);
    if (!db) return json(res, 503, { error: 'Database unavailable' });
    const user = db.prepare('SELECT * FROM panel_users WHERE username = ?').get(username);
    if (!user) return json(res, 404, { error: 'User not found' });
    const changes = [];
    if (body.role !== undefined && (body.role === 'admin' || body.role === 'user')) {
      // Refuse to demote the last admin — mirrors apiPanelUserDelete. Without
      // this guard an admin could promote themselves out of the role and lock
      // the panel for everyone (no admin = no recoverable login).
      if (body.role === 'user' && user.role === 'admin') {
        const adminCount = db.prepare(`SELECT COUNT(*) AS n FROM panel_users WHERE role = 'admin'`).get().n;
        if (adminCount <= 1) return json(res, 400, { error: 'Cannot demote the last admin' });
      }
      db.prepare('UPDATE panel_users SET role = ? WHERE username = ?').run(body.role, username);
      // Sessions cache the role at login time (see createSession), so a live
      // session for this user would keep the old role until it expires. Wipe
      // every session so the new role takes effect on the next request — both
      // demotions (admin → user must lose admin instantly) and promotions
      // (user → admin should reload permissions) need the bounce.
      if (body.role !== user.role) {
        try { db.prepare('DELETE FROM sessions WHERE username = ?').run(username); } catch {}
      }
      changes.push(`role=${body.role}`);
    }
    if (body.password) {
      const policyErr = passwordPolicyError(body.password);
      if (policyErr) return json(res, 400, { error: policyErr });
      const s = crypto.randomBytes(32).toString('hex');
      db.prepare('UPDATE panel_users SET password_hash = ?, salt = ? WHERE username = ?')
        .run(hashPassword(body.password, s), s, username);
      // Revoke all live sessions for this user — admin reset must kick the user out
      try { db.prepare('DELETE FROM sessions WHERE username = ?').run(username); } catch {}
      changes.push('password changed');
    }
    if (changes.length) insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'user.update', username, changes.join(', '));
    json(res, 200, { ok: true });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

function apiPanelUserDelete(req, res, username) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (!db) return json(res, 503, { error: 'Database unavailable' });
  // Refuse to leave the panel without admins
  try {
    const target = db.prepare('SELECT role FROM panel_users WHERE username = ?').get(username);
    if (target?.role === 'admin') {
      const adminCount = db.prepare(`SELECT COUNT(*) AS n FROM panel_users WHERE role = 'admin'`).get().n;
      if (adminCount <= 1) return json(res, 400, { error: 'Cannot delete the last admin' });
    }
  } catch {}
  db.prepare('DELETE FROM panel_users WHERE username = ?').run(username);
  try { db.prepare('DELETE FROM sessions WHERE username = ?').run(username); } catch {}
  insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'user.delete', username);
  json(res, 200, { ok: true });
}

// ── Panel settings (upload_max_mb, etc.) ──────────────────────────────────────
function apiPanelSettingsGet(req, res) {
  if (!db) return json(res, 200, { uploadMaxMb: 500, chunkedUpload: false, lang: 'en', discordWebhook: '', publicProfilesEnabled: true });
  const mbRow       = db.prepare(`SELECT value FROM panel_settings WHERE key = 'upload_max_mb'`).get();
  const langRow     = db.prepare(`SELECT value FROM panel_settings WHERE key = 'lang'`).get();
  const chunkedRow  = db.prepare(`SELECT value FROM panel_settings WHERE key = 'chunked_upload'`).get();
  const webhookRow  = db.prepare(`SELECT value FROM panel_settings WHERE key = 'discord_webhook'`).get();
  const publicRow   = db.prepare(`SELECT value FROM panel_settings WHERE key = 'public_profiles_enabled'`).get();
  // The webhook URL is effectively a secret (anyone with it can post to the
  // channel). Return the raw value only to admins or to users with the
  // discordWebhook permission. Everyone else just gets the configured flag so
  // the UI can render a disabled placeholder.
  const canSeeWebhook = checkPermission(req, 'discordWebhook');
  json(res, 200, {
    uploadMaxMb:    parseInt(mbRow?.value || '500', 10),
    lang:           langRow?.value || 'en',
    chunkedUpload:  chunkedRow?.value === '1',
    discordWebhook: canSeeWebhook ? (webhookRow?.value || '') : '',
    discordConfigured: !!(webhookRow?.value),
    publicProfilesEnabled: publicRow?.value !== '0',
  });
}

function isValidDiscordWebhook(url) {
  if (typeof url !== 'string') return false;
  if (url === '') return true; // empty clears the setting
  return /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{50,}$/.test(url);
}

async function apiPanelSettingsPut(req, res) {
  // discordWebhook is the only field a permissioned user can edit; everything
  // else here (upload limits, panel-wide language default, chunked toggle)
  // stays admin-only because they affect every panel user.
  const isAdmin       = checkAdminAuth(req);
  const canSetWebhook = checkPermission(req, 'discordWebhook');
  if (!isAdmin && !canSetWebhook) return json(res, 403, { error: 'Forbidden' });
  if (!db) return json(res, 503, { error: 'Database unavailable' });
  try {
    const body = await readBody(req);
    if (body.uploadMaxMb !== undefined) {
      if (!isAdmin) return json(res, 403, { error: 'Forbidden (admin only)' });
      const mb = parseInt(body.uploadMaxMb, 10);
      if (!mb || mb < 1 || mb > 10240) return json(res, 400, { error: 'Invalid value (1–10240 MB)' });
      db.prepare(`INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('upload_max_mb', ?)`).run(String(mb));
    }
    if (body.lang !== undefined) {
      if (!isAdmin) return json(res, 403, { error: 'Forbidden (admin only)' });
      if (!['en', 'es', 'it'].includes(body.lang)) return json(res, 400, { error: 'Unsupported language' });
      db.prepare(`INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('lang', ?)`).run(body.lang);
    }
    if (body.chunkedUpload !== undefined) {
      if (!isAdmin) return json(res, 403, { error: 'Forbidden (admin only)' });
      db.prepare(`INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('chunked_upload', ?)`).run(body.chunkedUpload ? '1' : '0');
    }
    if (body.discordWebhook !== undefined) {
      if (!canSetWebhook) return json(res, 403, { error: 'Forbidden' });
      const url = typeof body.discordWebhook === 'string' ? body.discordWebhook.trim() : '';
      if (!isValidDiscordWebhook(url)) return json(res, 400, { error: 'Invalid Discord webhook URL' });
      db.prepare(`INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('discord_webhook', ?)`).run(url);
      insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'panel.discord_webhook', '', url ? 'set' : 'cleared');
    }
    if (body.publicProfilesEnabled !== undefined) {
      if (!isAdmin) return json(res, 403, { error: 'Forbidden (admin only)' });
      const next = body.publicProfilesEnabled ? '1' : '0';
      db.prepare(`INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('public_profiles_enabled', ?)`).run(next);
      insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'panel.public_profiles', '', next === '1' ? 'enabled' : 'disabled');
    }
    json(res, 200, { ok: true });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// ── Role permissions ─────────────────────────────────────────────────────────
// Admin-managed toggles that control what users with role='user' can do.
// Effective perms for the current session are returned by /api/auth/me; these
// endpoints are for the admin UI to read/write the canonical role config.

function apiRolePermissionsGet(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  json(res, 200, { permissions: getUserRolePermissions() });
}

async function apiRolePermissionsPut(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (!db) return json(res, 503, { error: 'Database unavailable' });
  try {
    const body = await readBody(req);
    const next = {};
    for (const p of ROLE_PERMISSIONS) next[p] = !!body[p];
    db.prepare(`INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('role_permissions_user', ?)`)
      .run(JSON.stringify(next));
    insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'role.permissions.update', 'user',
      Object.entries(next).filter(([, v]) => v).map(([k]) => k).join(',') || '(none)');
    json(res, 200, { ok: true, permissions: next });
  } catch (e) { json(res, e.status || 500, { error: e.message }); }
}

// Posts a synchronous test message to the Discord webhook. Accepts an optional
// `url` in the body so the UI can verify a URL before saving it; if absent, the
// stored one is used. Responds only after Discord answers (or times out) so the
// admin gets a definitive ok/error in the toast.
async function apiDiscordWebhookTest(req, res) {
  if (!checkPermission(req, 'discordWebhook')) return json(res, 403, { error: 'Forbidden' });
  try {
    const body = await readBody(req);
    let url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) url = getDiscordWebhook();
    if (!url)          return json(res, 400, { error: 'No webhook configured' });
    if (!isValidDiscordWebhook(url) || url === '') return json(res, 400, { error: 'Invalid Discord webhook URL' });

    const lang = getPanelLang();
    const content = DISCORD_TEST_TEMPLATES[lang] || DISCORD_TEST_TEMPLATES.en;
    const payload = JSON.stringify({ content });

    let parsed;
    try { parsed = new URL(url); } catch { return json(res, 400, { error: 'Invalid Discord webhook URL' }); }
    // Authoritative SSRF gate — even if isValidDiscordWebhook's regex were to
    // accept a unicode-trick URL (or a future regex relaxation lets something
    // through), the resolved hostname must literally be on the Discord list.
    if (!DISCORD_WEBHOOK_HOSTS.has(parsed.hostname.toLowerCase())) {
      return json(res, 400, { error: 'Invalid Discord webhook URL' });
    }

    // Audit the test — host only, never the URL (it carries the secret token).
    insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'discord.webhook_test', parsed.hostname, '');

    // Cap how much of Discord's response body we buffer. The previous code
    // sliced each chunk to 512 bytes but appended to `buf` without limit, so a
    // pathological server returning many tiny chunks could grow `buf`
    // unbounded. Limit `buf` total length at 1 KB — plenty for an error message.
    const BUF_CAP = 1024;
    await new Promise((resolve) => {
      const r = https.request({
        method: 'POST',
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent':     'assetto-server-panel',
        },
        timeout: 5000,
      }, (resp) => {
        let buf = '';
        resp.on('data', (c) => {
          if (buf.length < BUF_CAP) buf += c.toString().slice(0, BUF_CAP - buf.length);
        });
        resp.on('end', () => {
          if (resp.statusCode < 400) {
            json(res, 200, { ok: true });
          } else {
            json(res, 502, { error: `Discord responded ${resp.statusCode}: ${buf.slice(0, 200)}` });
          }
          resolve();
        });
      });
      r.on('timeout', () => { r.destroy(); json(res, 504, { error: 'Discord webhook timed out' }); resolve(); });
      r.on('error', (e) => { json(res, 502, { error: e.message }); resolve(); });
      r.write(payload);
      r.end();
    });
  } catch (e) { try { json(res, 500, { error: e.message }); } catch {} }
}

// ── Multipart parser (native, no dependencies) ────────────────────────────────
// Streaming multipart parser. The file field is piped directly to a temp file
// as bytes arrive, so the panel never holds the full upload (potentially up to
// UPLOAD_HARD_CAP_BYTES) in RAM. Other fields are kept as small buffers — they
// are typically just option flags.
//
// Returned shape (compatible with the buffered version it replaces):
//   { fieldName: { filename, filePath, size }   for the file part
//     fieldName: 'string value'                 for plain text fields }
//
// Caller owns filePath and must unlink() it when done.
function parseMultipart(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const bmatch = ct.match(/boundary=([^\s;]+)/);
    if (!bmatch) return reject(new Error('Missing multipart boundary'));
    const dashBoundary = Buffer.from('--' + bmatch[1]);
    const dashBoundaryWithCRLF = Buffer.from('\r\n--' + bmatch[1]);

    const result = {};
    let total    = 0;
    let buf      = Buffer.alloc(0);
    let state    = 'PREAMBLE'; // PREAMBLE → HEADERS → DATA(field|file) → PREAMBLE…
    let curName  = null;
    let curFilename = null;
    let fieldBuf = null;
    let fileWriter = null;
    let filePath   = null;
    let bytesWritten = 0;
    let aborted    = false;

    const fail = (err) => {
      if (aborted) return;
      aborted = true;
      try { req.destroy(); } catch {}
      if (fileWriter) {
        try { fileWriter.destroy(); } catch {}
        if (filePath) fsp.unlink(filePath).catch(() => {});
      }
      reject(err);
    };

    const finishPart = () => {
      if (!curName) return;
      if (curFilename != null) {
        // Close file writer; record filePath/size in result
        if (fileWriter) {
          fileWriter.end();
          fileWriter = null;
        }
        result[curName] = { filename: curFilename, filePath, size: bytesWritten };
        filePath = null;
        bytesWritten = 0;
      } else {
        result[curName] = (fieldBuf || Buffer.alloc(0)).toString('utf8');
      }
      curName = null;
      curFilename = null;
      fieldBuf = null;
    };

    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes)
        return fail(Object.assign(new Error('File too large'), { code: 'ELIMIT' }));
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      processBuffer();
    });
    req.on('error', fail);
    req.on('end', () => {
      if (aborted) return;
      processBuffer(true);
      finishPart();
      resolve(result);
    });

    function processBuffer(isEnd = false) {
      while (true) {
        if (state === 'PREAMBLE') {
          // Skip everything up to the first boundary marker
          const idx = buf.indexOf(dashBoundary);
          if (idx === -1) { buf = buf.slice(Math.max(0, buf.length - dashBoundary.length)); return; }
          buf = buf.slice(idx + dashBoundary.length);
          // Closing boundary?
          if (buf.length >= 2 && buf[0] === 0x2d && buf[1] === 0x2d) { buf = Buffer.alloc(0); return; }
          // Skip the trailing CRLF after the boundary marker
          if (buf.length >= 2 && buf[0] === 0x0d && buf[1] === 0x0a) buf = buf.slice(2);
          state = 'HEADERS';
        } else if (state === 'HEADERS') {
          const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'));
          if (headerEnd === -1) {
            if (isEnd) return fail(new Error('Truncated multipart headers'));
            return;
          }
          const headerStr = buf.slice(0, headerEnd).toString('utf8');
          buf = buf.slice(headerEnd + 4);
          const nameMatch = headerStr.match(/name="([^"]+)"/);
          const fileMatch = headerStr.match(/filename="([^"]+)"/);
          if (!nameMatch) return fail(new Error('Multipart part missing name'));
          curName = nameMatch[1];
          curFilename = fileMatch ? fileMatch[1] : null;
          if (curFilename != null) {
            // Open a temp file for streaming
            const safeName = path.basename(curFilename).replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(0, 64);
            filePath = path.join(os.tmpdir(), `ac-upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName}`);
            fileWriter = fs.createWriteStream(filePath);
            fileWriter.on('error', e => fail(Object.assign(new Error(`Disk write failed: ${e.message}`), { status: 500 })));
            bytesWritten = 0;
          } else {
            fieldBuf = Buffer.alloc(0);
          }
          state = 'DATA';
        } else if (state === 'DATA') {
          const idx = buf.indexOf(dashBoundaryWithCRLF);
          if (idx === -1) {
            // Keep enough bytes to detect a boundary that spans the next chunk
            const safe = Math.max(0, buf.length - dashBoundaryWithCRLF.length);
            if (safe > 0) {
              const slice = buf.slice(0, safe);
              if (curFilename != null) {
                bytesWritten += slice.length;
                if (!fileWriter.write(slice)) {
                  // backpressure — we don't drain since req.on('data') has already been delivered;
                  // the writer is still buffering, esbuild ones are fine in practice
                }
              } else {
                fieldBuf = Buffer.concat([fieldBuf, slice]);
              }
              buf = buf.slice(safe);
            }
            if (isEnd) return fail(new Error('Truncated multipart body'));
            return;
          }
          // Found the next boundary — write everything before it as the part's data
          const partData = buf.slice(0, idx);
          if (curFilename != null) {
            bytesWritten += partData.length;
            fileWriter.write(partData);
          } else {
            fieldBuf = Buffer.concat([fieldBuf, partData]);
          }
          buf = buf.slice(idx + 2); // consume the leading \r\n; leave the boundary itself for next state
          finishPart();
          state = 'PREAMBLE';
        }
      }
    }
  });
}

// ── Archive extractor — returns flat list of { name, getData } ────────────────
const ALLOWED_MOD_EXTS = new Set([
  '.kn5','.acd','.ini','.json','.csv','.txt','.xml','.lua',
  '.png','.jpg','.jpeg','.webp','.dds','.bmp',
  '.wav','.ogg','.mp3','.bank',
  '.bin','.lut','.rto','.sfx','.ksanim','.ksemitter',
  '.hdr','.pfm','.tga','.raw','.ksg','.kn5',
]);

function isSafeEntry(entryName, destRoot) {
  // Anti Zip-Slip: resolved path must start with destRoot
  const resolved = path.resolve(destRoot, entryName.replace(/[\\/]+/g, path.sep));
  return resolved.startsWith(destRoot + path.sep) || resolved === destRoot;
}

// POSIX file-mode constant for a symbolic link. ZIP entries store the unix
// permission bits in the upper 16 bits of `attr` (the external file
// attributes field). We use this to flag symlink entries and reject them at
// the processing layer — see processModBuffer.
const S_IFLNK = 0o120000;
const S_IFMT  = 0o170000;

async function extractZip(buffer) {
  if (!StreamZip) throw new Error('node-stream-zip not available');
  // node-stream-zip v1.x only accepts a file path, not a buffer
  const tmpIn = path.join(os.tmpdir(), `ac-mod-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.zip`);
  await fsp.writeFile(tmpIn, buffer);
  const zip = new StreamZip.async({ file: tmpIn });
  const entries = await zip.entries();
  const list = [];
  for (const [name, entry] of Object.entries(entries)) {
    // ZIP stores Unix permissions in the high 16 bits of the external attrs.
    // If the file-type bits say "symlink", flag it so processModBuffer can
    // refuse the whole archive instead of writing the symlink target text
    // out as a regular file (or, worse, following an earlier symlink entry).
    const unixMode = ((entry.attr || 0) >>> 16) & 0xFFFF;
    const isSymlink = (unixMode & S_IFMT) === S_IFLNK;
    list.push({
      name,
      isDirectory: entry.isDirectory,
      isSymlink,
      getData: async () => entry.isDirectory ? null : zip.entryData(name),
    });
  }
  return {
    entries: list,
    close: async () => {
      await Promise.resolve(zip.close()).catch(() => {});
      await fsp.rm(tmpIn, { force: true }).catch(() => {});
    },
  };
}

async function extract7z(buffer) {
  if (!sevenZ || !sevenBin) throw new Error('node-7z / 7zip-bin not available');
  const stamp  = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const tmpIn  = path.join(os.tmpdir(), `ac-mod-${stamp}.7z`);
  const tmpOut = path.join(os.tmpdir(), `ac-mod-${stamp}`);
  await fsp.writeFile(tmpIn, buffer);
  await fsp.mkdir(tmpOut, { recursive: true });
  await new Promise((resolve, reject) => {
    const stream = sevenZ.extractFull(tmpIn, tmpOut, { $bin: sevenBin.path7za });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  // Walk tmpOut and collect entries. Crucially: use lstat (via withFileTypes)
  // so a symlink restored by 7za is reported as `isSymbolicLink`, not followed
  // through to its target. processModBuffer then refuses the whole archive.
  // Without this, an entry like `data -> /etc` in the .7z would let a later
  // `physics.bin` entry land at `/etc/physics.bin` once an admin extracts.
  const list = [];
  const walk = async (dir, rel) => {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const itemRel = rel ? rel + '/' + item.name : item.name;
      if (item.isSymbolicLink()) {
        list.push({ name: itemRel, isDirectory: false, isSymlink: true, getData: async () => null });
        // Don't recurse through symlinks even if they point at directories.
        continue;
      }
      if (item.isDirectory()) {
        list.push({ name: itemRel + '/', isDirectory: true, isSymlink: false, getData: async () => null });
        await walk(path.join(dir, item.name), itemRel);
      } else {
        const fullPath = path.join(dir, item.name);
        list.push({ name: itemRel, isDirectory: false, isSymlink: false, getData: async () => fsp.readFile(fullPath) });
      }
    }
  };
  await walk(tmpOut, '');
  return {
    entries: list,
    close: async () => {
      await fsp.rm(tmpIn,  { force: true });
      await fsp.rm(tmpOut, { recursive: true, force: true });
    },
  };
}

async function extractRar(buffer) {
  if (!Unrar) throw new Error('node-unrar-js not available');
  // node-unrar-js v2 API
  const extractor = await Unrar.createExtractorFromData({ data: buffer });
  const { files } = extractor.extract();
  const list = [];
  for (const file of files) {
    const flags  = file.fileHeader.flags || {};
    const isDir  = !!flags.directory;
    // node-unrar-js v2 exposes a `symlink` flag on the header. It's optional —
    // older RARs without the link bit just produce `undefined` (falsy), which
    // is the safe default. Anything truthy here gets refused by processModBuffer.
    const isSymlink = !!flags.symlink;
    const data   = (isDir || isSymlink) ? null : Buffer.from(file.extraction);
    list.push({
      name:        file.fileHeader.name,
      isDirectory: isDir,
      isSymlink,
      getData:     async () => data,
    });
  }
  return { entries: list, close: () => {} };
}

async function extractArchive(buffer, ext) {
  if (ext === '.zip') return extractZip(buffer);
  if (ext === '.7z')  return extract7z(buffer);
  if (ext === '.rar') return extractRar(buffer);
  throw new Error(`Unsupported format: ${ext}`);
}

// ── Mod processing (shared by single and chunked upload) ─────────────────────
function insertModHistory(entry) {
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO mod_history (ok, filename, mod_type, mod_id, destination, files_extracted, error, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.ok ? 1 : 0,
      entry.filename || null,
      entry.modType  || null,
      entry.modId    || null,
      entry.destination || null,
      entry.filesExtracted ?? null,
      entry.error    || null,
      entry.uploadedBy || null
    );
  } catch {}
}

// Hash-chain the audit log for tamper-evidence. Each row's row_hash =
// sha256(JSON.stringify([chain_version, prev, logged_at, actor, action, target, detail])).
// `tools/verify-audit.js` (or any consumer) can walk the table and recompute the
// chain — a tampered or deleted row breaks every subsequent hash. This does not
// prevent deletion (any admin with DB access can DROP), but it does prevent silent
// edits and lets external backups detect tampering by comparing chains.
//
// Chain versions:
//   0 — legacy `${prev}|${loggedAt}|${actor}|${action}|${target}|${detail}` (still
//       verified by the tool but no longer written; vulnerable to a separator-shift
//       collision when a field contained `|`).
//   1 — current. JSON.stringify of the field array; element boundaries are explicit
//       so a `|` inside detail/target cannot collide with a different field assignment.
const AUDIT_CHAIN_VERSION = 1;
function insertAuditLog(actor, action, target = '', detail = '') {
  if (!db) return;
  // Cap free-form fields so a caller can't bloat the audit table / hash chain.
  if (typeof detail === 'string' && detail.length > 2000) detail = detail.slice(0, 2000) + '…';
  if (typeof target === 'string' && target.length > 512)  target = target.slice(0, 512);
  try {
    const tx = db.transaction(() => {
      const last = db.prepare('SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
      const prev = last?.row_hash || '';
      const loggedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const data = JSON.stringify([AUDIT_CHAIN_VERSION, prev, loggedAt, actor, action, target, detail]);
      const rowHash = crypto.createHash('sha256').update(data).digest('hex');
      db.prepare(
        'INSERT INTO audit_log (actor, action, target, detail, logged_at, prev_hash, row_hash, chain_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(actor, action, target, detail, loggedAt, prev, rowHash, AUDIT_CHAIN_VERSION);
    });
    tx();
  } catch (e) { log.warn('audit log insert failed:', e.message); }
}

// Admin: Prometheus exposition format. Scrape with HTTP basic / token auth or
// from a sidecar with the panel cookie. Each metric is a snapshot — no rate
// stats are kept in memory beyond the basic counters in `_sweeperState`.
async function apiAdminMetricsProm(req, res) {
  if (!checkAdminAuth(req)) return respond(res, 401, 'text/plain', 'Unauthorized');
  const lines = [];
  const m = (name, type, help, value, labels) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    const lbl = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
    lines.push(`${name}${lbl} ${value}`);
  };
  m('panel_uptime_seconds',         'counter', 'Process uptime in seconds',                          Math.floor(process.uptime()));
  m('panel_memory_rss_bytes',       'gauge',   'Resident memory size of the Node process',          process.memoryUsage().rss);
  m('panel_sse_clients',            'gauge',   'Active Server-Sent-Events connections',              sseClients.size);
  m('panel_active_uploads',         'gauge',   'Per-user uploads currently in-flight',               _userUploads.size);
  m('panel_server_action_in_flight','gauge',   'Whether an AC start/stop/restart is running (0/1)',  _serverActionInFlight ? 1 : 0);
  if (db) {
    try { m('panel_sessions_total',          'gauge', 'Active panel sessions',          db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n); } catch {}
    try { m('panel_panel_users_total',       'gauge', 'Configured panel users',         db.prepare('SELECT COUNT(*) AS n FROM panel_users').get().n); } catch {}
    try { m('panel_audit_log_total',         'gauge', 'Audit log entries',              db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n); } catch {}
    try { m('panel_login_attempts_total',    'gauge', 'Tracked login attempt buckets',  db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n); } catch {}
    try { m('panel_laps_total',              'gauge', 'Recorded lap times',             db.prepare('SELECT COUNT(*) AS n FROM laps').get().n); } catch {}
    try { m('panel_mod_history_total',       'gauge', 'Mod uploads recorded',           db.prepare('SELECT COUNT(*) AS n FROM mod_history').get().n); } catch {}
  }
  // AC server presence — best-effort from cached state, no fresh probe to avoid
  // a 1.5 s scrape latency.
  m('ac_server_up', 'gauge', 'Whether acServer was up at the last poll (0/1)', _acRunSince ? 1 : 0);
  if (_acRunSince) m('ac_server_uptime_seconds', 'counter', 'acServer uptime since first detection', Math.floor((Date.now() - _acRunSince) / 1000));
  for (const [name, st] of Object.entries(_sweeperState)) {
    if (st.lastRunAt) m('panel_sweeper_last_run_seconds', 'gauge', `Seconds since last sweep for ${name}`, Math.floor((Date.now() - st.lastRunAt) / 1000), { sweeper: name });
    m('panel_sweeper_last_removed_total', 'counter', `Last sweep removed count for ${name}`, st.lastRemoved, { sweeper: name });
  }
  respond(res, 200, 'text/plain; version=0.0.4; charset=utf-8', lines.join('\n') + '\n');
}

// Admin: panel internals snapshot for ops debugging. Returns sweeper status,
// table sizes, and current in-flight counters. Useful when "is the panel still
// alive?" can't be answered from the UI alone.
// Quick existence + type check for the four AC paths the panel needs. Used by
// /api/admin/stats and /api/setup/status to drive a setup banner in the UI.
async function _pathHealth() {
  const probe = async (p, kind) => {
    if (!p) return { path: p, exists: false, kind, missing: true };
    try {
      const st = await fsp.stat(p);
      const ok = kind === 'dir' ? st.isDirectory() : st.isFile();
      return { path: p, exists: true, kind, ok };
    } catch { return { path: p, exists: false, kind, missing: true }; }
  };
  return {
    cfgFile:   await probe(AC_CFG_FILE, 'file'),
    cars:      await probe(AC_CARS_DIR, 'dir'),
    tracks:    await probe(AC_TRACKS_DIR, 'dir'),
    serverBin: await probe(AC_BIN,       'file'),
    serverDir: await probe(AC_BIN_DIR,   'dir'),
    results:   await probe(AC_RESULTS,   'dir'),
  };
}

// Public endpoint: tells the frontend whether the panel is fully configured.
// Returns the boolean `ready` plus the per-path summary so the UI can render
// an actionable banner pointing operators at the specific path that's
// missing. No auth required because the same data is needed before any
// login can succeed if AC_CFG_DIR is wrong.
//
// Absolute paths and the auto-detected root are stripped for unauthenticated
// callers — they're useful to an admin staring at the setup banner but pure
// signal to an external scanner trying to fingerprint the host's filesystem
// layout. Authenticated callers still see the full path so the banner stays
// actionable after login.
async function apiSetupStatus(req, res) {
  const paths = await _pathHealth();
  const critical = ['cfgFile', 'cars', 'tracks'];
  const issues = critical.filter(k => !paths[k] || !paths[k].exists);
  const isAuthed = !!checkAnyAuth(req);
  const publicPaths = {};
  for (const [k, v] of Object.entries(paths)) {
    publicPaths[k] = isAuthed
      ? v
      : { exists: v.exists, kind: v.kind, ok: v.ok, missing: v.missing };
  }
  json(res, 200, {
    ready: issues.length === 0,
    issues,
    paths: publicPaths,
    detectedAcRoot: isAuthed ? (_detectedAcRoot || null) : null,
  });
}

async function apiAdminStats(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  const counts = {};
  if (db) {
    try { counts.sessions       = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n; } catch {}
    try { counts.audit_log      = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n; } catch {}
    try { counts.login_attempts = db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n; } catch {}
    try { counts.panel_users    = db.prepare('SELECT COUNT(*) AS n FROM panel_users').get().n; } catch {}
    try { counts.laps           = db.prepare('SELECT COUNT(*) AS n FROM laps').get().n; } catch {}
    try { counts.mod_history    = db.prepare('SELECT COUNT(*) AS n FROM mod_history').get().n; } catch {}
  }
  let chunkDirs = 0;
  try { chunkDirs = (await fsp.readdir(CHUNK_TMP_DIR).catch(() => [])).length; } catch {}
  json(res, 200, {
    nodeVersion:        process.version,
    panelVersion:       require('./package.json').version,
    uptimeSec:          Math.floor(process.uptime()),
    memoryMb:           Math.round(process.memoryUsage().rss / 1024 / 1024),
    auditRetentionDays: AUDIT_RETENTION_DAYS,
    trustProxy:         TRUST_PROXY,
    serverActionInFlight: _serverActionInFlight,
    activeUploads:      _userUploads.size,
    pendingChunkDirs:   chunkDirs,
    sseClients:         sseClients.size,
    sweepers:           _sweeperState,
    counts,
    paths:              await _pathHealth(),
    backupConfig: {
      intervalHours: BACKUP_INTERVAL_HOURS,
      keep:          BACKUP_KEEP,
      dir:           BACKUP_DIR,
    },
  });
}

// Clinical-style health endpoint for ops dashboards / Kubernetes readiness
// probes / Uptime-Kuma. Unlike the public /api/health (which returns just
// { ok: true } and intentionally leaks no fingerprintable signal), this one
// is admin-gated and aggregates the disk + DB + process + acServer checks
// into a status verdict the operator can alert on. HTTP code mirrors the
// verdict so an alerting rule can be a simple "non-2xx" check:
//   healthy   → 200 OK   (everything within thresholds)
//   degraded  → 200 OK   (advisory: free disk getting low, server expected up but down, …)
//   unhealthy → 503      (DB unavailable, disk effectively full, …)
async function apiAdminHealth(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  const checks = {};
  let worst = 'healthy';
  const escalate = level => {
    if (level === 'unhealthy' || worst === 'unhealthy') worst = 'unhealthy';
    else if (level === 'degraded') worst = 'degraded';
  };

  // DB: try a cheap SELECT and read the file size. Anything that throws here
  // counts as a hard failure — the panel can technically keep serving static
  // files without the DB, but every meaningful API call needs it.
  try {
    db.prepare('SELECT 1').get();
    const st = await fsp.stat(DB_PATH).catch(() => null);
    checks.db = { status: 'healthy', sizeMb: st ? Math.round(st.size / 1024 / 1024 * 100) / 100 : null };
  } catch (e) {
    checks.db = { status: 'unhealthy', error: e.message };
    escalate('unhealthy');
  }

  // Disk: fs.statfsSync against the dir that holds DB + uploads + backups.
  // < 500 MB free is hard fail (next upload or backup likely fails); < 5 GB
  // is degraded (operator has time to react before it bites).
  try {
    const sf = fs.statfsSync(path.dirname(DB_PATH));
    const freeBytes  = sf.bavail * sf.bsize;
    const totalBytes = sf.blocks * sf.bsize;
    const freeGb     = Math.round(freeBytes / 1024 / 1024 / 1024 * 100) / 100;
    const totalGb    = Math.round(totalBytes / 1024 / 1024 / 1024 * 100) / 100;
    let status = 'healthy';
    if (freeBytes < 500 * 1024 * 1024)       { status = 'unhealthy'; escalate('unhealthy'); }
    else if (freeBytes < 5 * 1024 * 1024 * 1024) { status = 'degraded';  escalate('degraded'); }
    checks.disk = { status, freeGb, totalGb };
  } catch (e) {
    checks.disk = { status: 'degraded', error: e.message };
    escalate('degraded');
  }

  // Process: RSS over 1 GB on a panel this size is a leak signal worth surfacing,
  // not enough to alert hard (the OOM killer would have taken us out already).
  const rss = process.memoryUsage().rss;
  const rssMb = Math.round(rss / 1024 / 1024);
  checks.process = {
    status: rss > 1024 * 1024 * 1024 ? 'degraded' : 'healthy',
    memoryMb: rssMb,
    uptimeSec: Math.floor(process.uptime()),
  };
  if (rss > 1024 * 1024 * 1024) escalate('degraded');

  // acServer presence: degraded (not unhealthy) when not running — the panel
  // is still useful with the server down (config edits, uploads, audit log).
  checks.acServer = {
    status: _acRunSince ? 'healthy' : 'degraded',
    running: !!_acRunSince,
    uptimeSec: _acRunSince ? Math.floor((Date.now() - _acRunSince) / 1000) : 0,
  };
  if (!_acRunSince) escalate('degraded');

  const httpCode = worst === 'unhealthy' ? 503 : 200;
  json(res, httpCode, {
    status: worst,
    version: require('./package.json').version,
    uptimeSec: Math.floor(process.uptime()),
    checks,
  });
}

// Admin: download a consistent DB snapshot via SQLite VACUUM INTO. Streams the
// resulting file as `assetto-YYYY-MM-DD.db`, then deletes the temp copy.
async function apiAdminBackup(req, res) {
  if (!checkPermission(req, 'dbBackup')) return respond(res, 401, 'text/plain', 'Unauthorized');
  if (!db) return json(res, 503, { error: 'Database unavailable' });
  const stamp = new Date().toISOString().slice(0, 10);
  const tmpPath = path.join(os.tmpdir(), `assetto-backup-${stamp}-${crypto.randomBytes(4).toString('hex')}.db`);
  try {
    await fsp.unlink(tmpPath).catch(() => {});
    db.prepare(`VACUUM INTO ?`).run(tmpPath);
    const stat = await fsp.stat(tmpPath);
    res.writeHead(200, {
      'Content-Type':  'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="assetto-${stamp}.db"`,
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(tmpPath);
    stream.pipe(res);
    stream.on('close', () => { fsp.unlink(tmpPath).catch(() => {}); });
    stream.on('error', () => { fsp.unlink(tmpPath).catch(() => {}); });
    insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'admin.backup', `${stat.size} bytes`);
  } catch (e) {
    await fsp.unlink(tmpPath).catch(() => {});
    json(res, 500, { error: e.message });
  }
}

// Recursive byte-count for a content directory. Walks lazily and bails out
// once a per-call cap is hit so a runaway symlink loop or a misconfigured
// path can't pin the event loop. Returns total bytes accumulated. Same shape
// as the BeamNG sibling panel's helper so the two dashboards behave the same.
async function _acDirSizeBytes(rootDir, capBytes = 50 * 1024 * 1024 * 1024) {
  let total = 0;
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) {
          const st = await fsp.stat(p);
          total += st.size;
          if (total > capBytes) return total;
        }
      } catch { /* unreadable entry — skip */ }
    }
  }
  return total;
}

// Same as _acDirSizeBytes but the top-level child directories whose names
// match the Kunos-ID set are skipped. The Dashboard's "Mods en disco" tile
// uses this to count only modder-supplied content — a healthy AC server's
// content/cars + content/tracks is mostly vanilla Kunos (~33 GB out of
// the box on a fully-installed server), so a naïve total would tell the
// operator nothing about how much disk their mods are actually consuming.
async function _acModsBytesIn(rootDir, kunosIds, capBytes = 50 * 1024 * 1024 * 1024) {
  let total = 0;
  let topLevel;
  try { topLevel = await fsp.readdir(rootDir, { withFileTypes: true }); }
  catch { return 0; }
  for (const e of topLevel) {
    if (!e.isDirectory()) continue;
    if (kunosIds.has(e.name)) continue;
    total += await _acDirSizeBytes(path.join(rootDir, e.name), capBytes - total);
    if (total > capBytes) return total;
  }
  return total;
}

// Best-effort acServer version. acServer's --version output varies across
// builds (some print "AC server <version>", some emit nothing on stdout
// and a banner on stderr) so we look for the first three-component numeric
// run. Returns null if the binary doesn't run or the regex misses — the
// dashboard tile falls back to a static label in that case.
let _acVersionCache = null; // { version, cachedAt }
const AC_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
async function _getLocalAcVersion() {
  if (_acVersionCache && Date.now() - _acVersionCache.cachedAt < AC_VERSION_TTL_MS) {
    return _acVersionCache.version;
  }
  let version = null;
  try {
    if (AC_BIN && fs.existsSync(AC_BIN)) {
      const out = await new Promise((resolve) => {
        const p = spawn(AC_BIN, ['--version'], { timeout: 3000 });
        let buf = '';
        p.stdout.on('data', d => { buf += d.toString(); });
        p.stderr.on('data', d => { buf += d.toString(); });
        p.on('close', () => resolve(buf));
        p.on('error', () => resolve(''));
      });
      const m = out.match(/(\d+\.\d+\.\d+)/);
      if (m) version = m[1];
    }
  } catch { /* ignore */ }
  _acVersionCache = { version, cachedAt: Date.now() };
  return version;
}

// Dashboard extras: best-effort metrics that aren't part of the canonical
// /api/server poll because they're slow (disk walks, SQL aggregations) or
// rarely change (binary version). The frontend polls this every 30 s; the
// version is further cached for 6 h so we don't shell out on every refresh.
async function apiDashboardExtra(req, res) {
  if (!checkAnyAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  // contentBytes intentionally EXCLUDES Kunos vanilla content — a fresh
  // AC server install carries ~33 GB of stock cars + tracks, so a naïve
  // total tells the operator nothing about how much disk their mods are
  // taking. KUNOS_CAR_IDS / KUNOS_TRACK_IDS are populated at startup from
  // the bundled src/assets/kunos/ catalogue and stay authoritative for
  // "what shipped with the game".
  let contentBytes = 0;
  try {
    const [cars, tracks] = await Promise.all([
      _acModsBytesIn(AC_CARS_DIR,   KUNOS_CAR_IDS).catch(()  => 0),
      _acModsBytesIn(AC_TRACKS_DIR, KUNOS_TRACK_IDS).catch(() => 0),
    ]);
    contentBytes = (cars || 0) + (tracks || 0);
  } catch {}
  // activeDrivers24h: drivers whose last_seen falls in the trailing 24 h
  // window. AC's player tracking updates last_seen on every JOIN line the
  // UDP listener parses, so this is the practical "how many distinct
  // people connected today" answer despite the absence of a dedicated
  // player_events table (the BeamMP sibling uses such a table because its
  // PanelBridge plugin writes one row per join/leave).
  let activeDrivers24h = 0;
  // laps24h: total laps the server has registered in the trailing 24 h.
  // No uptime-history table exists, so this is the closest proxy for
  // "how active was the server" without rebuilding history from logs.
  let laps24h = 0;
  // totalDrivers: cumulative distinct drivers ever seen by the server.
  // Closes the temporal trio "current / last 24 h / lifetime" with one
  // PRIMARY KEY scan — cheap even on a busy server.
  let totalDrivers = 0;
  try {
    if (db) {
      activeDrivers24h = db.prepare(`
        SELECT COUNT(*) AS n FROM players
        WHERE last_seen >= date('now', '-1 day')
      `).get()?.n || 0;
      laps24h = db.prepare(`
        SELECT COUNT(*) AS n FROM laps
        WHERE session_date >= date('now', '-1 day')
      `).get()?.n || 0;
      totalDrivers = db.prepare(`SELECT COUNT(*) AS n FROM players`).get()?.n || 0;
    }
  } catch {}
  const acVersion = await _getLocalAcVersion();
  return json(res, 200, { contentBytes, activeDrivers24h, laps24h, totalDrivers, acVersion });
}

function apiAuditGet(req, res) {
  if (!checkPermission(req, 'auditView')) return json(res, 403, { error: 'Forbidden' });
  if (!db) return json(res, 200, { rows: [], hasMore: false });
  const qs     = new URLSearchParams(req.url.split('?')[1] || '');
  const limit  = Math.min(Math.max(parseInt(qs.get('limit')) || 50, 1), 500);
  const before = parseInt(qs.get('before')); // cursor: id strictly less than this
  const where  = isFinite(before) && before > 0 ? 'WHERE id < ?' : '';
  const params = isFinite(before) && before > 0 ? [before, limit + 1] : [limit + 1];
  const rows = db.prepare(`
    SELECT id, actor, action, target, detail, logged_at
    FROM audit_log ${where} ORDER BY id DESC LIMIT ?
  `).all(...params);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  json(res, 200, { rows, hasMore, nextCursor: hasMore ? rows[rows.length - 1].id : null });
}

// Audit export: streams the audit_log as CSV or JSON for offline analysis.
// Filters (since/until ISO 8601, actor, action substring) compose into a
// single WHERE clause so the export can target an incident window without
// pulling the whole table. The CSV path streams row-by-row to keep memory
// flat on large exports; the JSON path renders an array in one shot because
// JSON.stringify on N rows of audit data is cheap and the output is meant
// for jq / SIEM ingestion which prefers one well-formed document over NDJSON.
// _csvCell lives in lib/pure.js so the CSV-quoting invariants can be unit-tested.
const { _csvCell } = require('./lib/pure.js');
function apiAuditExport(req, res) {
  if (!checkPermission(req, 'auditView')) return json(res, 403, { error: 'Forbidden' });
  if (!db) return json(res, 503, { error: 'Database unavailable' });
  const qs       = new URLSearchParams(req.url.split('?')[1] || '');
  const format   = (qs.get('format') || 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'json') return json(res, 400, { error: 'format must be csv or json' });
  // Parse filters. ISO-8601 strings round-trip into SQLite's TEXT timestamps
  // unchanged because the audit_log column was inserted with datetime('now'),
  // which uses the same shape ("YYYY-MM-DD HH:MM:SS"). We accept both forms
  // (with or without the T separator) and normalise.
  const normTs = s => {
    if (!s) return null;
    const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
    return m ? `${m[1]} ${m[2]}` : null;
  };
  const since  = normTs(qs.get('since'));
  const until  = normTs(qs.get('until'));
  const actor  = qs.get('actor');
  const action = qs.get('action');
  const where  = [];
  const params = [];
  if (since)  { where.push('logged_at >= ?'); params.push(since); }
  if (until)  { where.push('logged_at <= ?'); params.push(until); }
  if (actor)  { where.push('actor = ?');      params.push(actor); }
  if (action) { where.push('action LIKE ?');  params.push(`%${action}%`); }
  const sql = `SELECT id, actor, action, target, detail, logged_at FROM audit_log
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY id DESC`;
  insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'audit.export', format, where.join(' AND '));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  if (format === 'csv') {
    res.writeHead(200, {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="assetto-audit-${stamp}.csv"`,
      'Cache-Control':       'no-store',
    });
    res.write('id,actor,action,target,detail,logged_at\n');
    // better-sqlite3 .iterate() returns an iterator that fetches rows lazily,
    // keeping peak memory bound to one row at a time regardless of result size.
    for (const r of db.prepare(sql).iterate(...params)) {
      res.write(`${r.id},${_csvCell(r.actor)},${_csvCell(r.action)},${_csvCell(r.target)},${_csvCell(r.detail)},${_csvCell(r.logged_at)}\n`);
    }
    return res.end();
  }
  const rows = db.prepare(sql).all(...params);
  res.writeHead(200, {
    'Content-Type':        'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="assetto-audit-${stamp}.json"`,
    'Cache-Control':       'no-store',
  });
  res.end(JSON.stringify({ exportedAt: new Date().toISOString(), filter: { since, until, actor, action }, count: rows.length, rows }, null, 2));
}

function apiModHistoryGet(res) {
  if (!db) return json(res, 200, []);
  const rows = db.prepare(`
    SELECT id, ok, filename, mod_type, mod_id, destination, files_extracted, error, uploaded_by, uploaded_at
    FROM mod_history ORDER BY id DESC LIMIT 100
  `).all();
  json(res, 200, rows.map(r => ({
    id:             r.id,
    ok:             !!r.ok,
    filename:       r.filename,
    modType:        r.mod_type,
    modId:          r.mod_id,
    destination:    r.destination,
    filesExtracted: r.files_extracted,
    error:          r.error,
    uploadedBy:     r.uploaded_by,
    time:           r.uploaded_at,
  })));
}

function apiModHistoryDelete(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (!db) return json(res, 200, { ok: true });
  const r = db.prepare('DELETE FROM mod_history').run();
  insertAuditLog(checkAnyAuth(req)?.username || 'admin', 'mods.history_wipe', '', `${r.changes} rows`);
  json(res, 200, { ok: true });
}

// Decompression bomb caps: refuse archives that look pathological before we touch disk
const MAX_ARCHIVE_ENTRIES   = 50_000;                 // total entries
const MAX_ARCHIVE_TOTAL_B   = 5 * 1024 * 1024 * 1024; // 5 GB extracted total
const MAX_ARCHIVE_ENTRY_B   = 2 * 1024 * 1024 * 1024; // 2 GB single file

// Cap how many extractors can run at once. processModBuffer reads the whole
// archive buffer into RAM (the extractors operate on Buffer), so with the
// 2 GB hard cap a handful of concurrent uploads could OOM the panel. Two
// concurrent extractors is enough to keep one user productive while a slow
// upload runs in the background; a third waits in line.
const MAX_CONCURRENT_EXTRACTORS = 2;
let _activeExtractors = 0;
const _extractorWaiters = [];
function _acquireExtractor() {
  if (_activeExtractors < MAX_CONCURRENT_EXTRACTORS) {
    _activeExtractors++;
    return Promise.resolve();
  }
  return new Promise(resolve => _extractorWaiters.push(resolve));
}
function _releaseExtractor() {
  const next = _extractorWaiters.shift();
  if (next) {
    // Hand off the slot directly so the count stays at MAX while we wake the
    // next waiter; otherwise a parallel call could race in between.
    next();
  } else {
    _activeExtractors = Math.max(0, _activeExtractors - 1);
  }
}

// Refuse uploads when the destination filesystem doesn't have enough free
// space to safely expand the archive. We estimate the worst case as
// `compressed × 5` (matches what acServer mod packs typically expand to).
// fs.statfs is Node 19+; on older versions or non-POSIX FS the call throws
// and we skip the check — better to attempt the upload than to refuse
// blindly when we can't measure.
async function _checkFreeSpace(extractedDir, compressedBytes) {
  if (!fsp.statfs) return null; // older Node — silently skip
  try {
    // Walk up until we find a path that actually exists. Brand-new content
    // dirs (first-ever mod) won't exist yet; their parent will.
    let probe = extractedDir;
    for (let i = 0; i < 8; i++) {
      try { await fsp.stat(probe); break; } catch { probe = path.dirname(probe); if (probe === '/' || !probe) break; }
    }
    const s = await fsp.statfs(probe);
    const free = Number(s.bavail) * Number(s.bsize);
    const need = Math.max(compressedBytes * 5, 256 * 1024 * 1024); // floor at 256 MB so a tiny mod still has headroom
    if (free < need) {
      return { ok: false, free, need };
    }
    return { ok: true, free, need };
  } catch { return null; }
}

async function processModBuffer(buffer, filename) {
  await _acquireExtractor();
  try {
    // Disk-space gate. Refuse the upload before extracting if the destination
    // looks dangerously full — running out of disk mid-extract leaves a
    // half-installed mod that's worse than a clean rejection.
    const ext = path.extname(filename).toLowerCase();
    const probeDir = ext === '.zip' || ext === '.rar' || ext === '.7z'
      ? AC_CARS_DIR // either AC_CARS_DIR or AC_TRACKS_DIR works as a probe; both live on the same volume in practice
      : os.tmpdir();
    const space = await _checkFreeSpace(probeDir, buffer.length);
    if (space && !space.ok) {
      const freeMb = Math.floor(space.free / 1024 / 1024);
      const needMb = Math.ceil(space.need / 1024 / 1024);
      throw Object.assign(
        new Error(`Not enough disk space (free=${freeMb} MB, estimated need=${needMb} MB)`),
        { status: 507 } // 507 Insufficient Storage
      );
    }
    return await _processModBufferInner(buffer, filename);
  } finally {
    _releaseExtractor();
  }
}

async function _processModBufferInner(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!['.zip', '.rar', '.7z'].includes(ext))
    throw Object.assign(new Error(`Unsupported format: ${ext}. Use .zip, .rar or .7z`), { status: 400 });

  let archive = null;
  try {
    archive = await extractArchive(buffer, ext);
    const entries = archive.entries;

    if (entries.length > MAX_ARCHIVE_ENTRIES)
      throw Object.assign(new Error(`Archive has too many entries (${entries.length} > ${MAX_ARCHIVE_ENTRIES})`), { status: 413 });

    // Symlinks have no legitimate role in an AC mod. A malicious archive can
    // put a symlink-typed entry early (e.g. `data -> /etc`) and a regular-file
    // entry later (`data/passwd`) so the writeFile lands at /etc/passwd. We
    // refuse the whole archive on the first symlink entry — extractors flag
    // them via `isSymlink` (zip from Unix attr, 7z from lstat after extract,
    // rar from header flags). Don't silently skip: an admin who uploads a
    // tampered mod must see the rejection.
    for (const e of entries) {
      if (e.isSymlink)
        throw Object.assign(new Error(`Symlink entry rejected: ${e.name}`), { status: 400 });
    }

    const dummyRoot = path.join(os.tmpdir(), 'ac-slip-check');
    for (const e of entries) {
      if (!isSafeEntry(e.name, dummyRoot))
        throw Object.assign(new Error(`Zip-Slip path rejected: ${e.name}`), { status: 400 });
    }

    const names    = entries.map(e => e.name.replace(/\\/g, '/').toLowerCase());
    const allFiles = names.filter(n => !n.endsWith('/'));
    const allDirs  = names.filter(n => n.endsWith('/'));

    // ── Definitive car signals ────────────────────────────────────────────────
    // data.acd is encrypted physics — always a car, never a track
    const hasDataAcd  = allFiles.some(n => /(^|\/)data\.acd$/.test(n));
    // open data/ folder with car-specific INI files
    const hasCarIni   = allFiles.some(n => /(^|\/)data\/(car|engine|tyres|suspensions)\.ini$/.test(n));
    const hasCarUi    = allFiles.some(n => /ui_car\.json$/.test(n));
    const hasKn5      = allFiles.some(n => n.endsWith('.kn5'));

    // ── Definitive track signals ──────────────────────────────────────────────
    // models*.ini declares 3D scene objects — always a track, never a car
    const hasModels   = allFiles.some(n => /(^|\/)models(_[^/]+)?\.ini$/.test(n));
    // surfaces.ini defines physics surface properties — always a track
    const hasSurfaces = allFiles.some(n => /(^|\/)data\/surfaces\.ini$/.test(n));
    const hasTrackUi  = allFiles.some(n => /ui_track\.json$/.test(n));
    // ai/ can be in root or inside layout sub-directories
    const hasAi       = allDirs.some(n => /(\/|^)ai\/$/.test(n)) ||
                        allFiles.some(n => /(\/|^)ai\//.test(n));

    // Priority: definitive signals → ambiguous fallback
    let modType = null;
    if (hasDataAcd || hasCarIni || (hasCarUi && !hasModels && !hasSurfaces && !hasTrackUi && !hasAi)) {
      modType = 'car';
    } else if (hasModels || hasSurfaces || hasTrackUi || (hasAi && hasKn5)) {
      modType = 'track';
    }

    if (!modType)
      throw Object.assign(new Error(
        'No valid mod detected.\n' +
        'Car: needs data.acd, data/car.ini, or ui_car.json\n' +
        'Track: needs models.ini, data/surfaces.ini, ui_track.json, or ai/ + .kn5'
      ), { status: 422 });

    const roots = new Set();
    for (const n of names) { const p = n.split('/'); if (p[0]) roots.add(p[0]); }
    if (roots.size !== 1)
      throw Object.assign(new Error(`Archive must contain exactly one root folder. Found: ${[...roots].join(', ')}`), { status: 422 });

    const modRoot  = [...roots][0];
    const destBase = modType === 'car' ? AC_CARS_DIR : AC_TRACKS_DIR;
    const destDir  = path.join(destBase, modRoot);
    if (!destDir.startsWith(destBase + path.sep))
      throw Object.assign(new Error('Invalid destination path'), { status: 400 });

    await fsp.mkdir(destDir, { recursive: true });

    let filesExtracted = 0;
    let totalBytes     = 0;
    for (const entry of entries) {
      const normalName = entry.name.replace(/\\/g, '/');
      if (!normalName.startsWith(modRoot + '/')) continue;
      if (entry.isDirectory) {
        const relDir = normalName.slice(modRoot.length + 1);
        if (relDir) await fsp.mkdir(path.join(destDir, relDir), { recursive: true });
        continue;
      }
      const fileExt = path.extname(normalName).toLowerCase();
      if (!ALLOWED_MOD_EXTS.has(fileExt)) continue;
      const destFile = path.join(destDir, normalName.slice(modRoot.length + 1));
      // Resolve and re-check against the real destDir. Abort on any escape — never silently skip
      // (a partial install with one slip entry omitted is still dangerous if a future fix forgets).
      if (!destFile.startsWith(destDir + path.sep))
        throw Object.assign(new Error(`Zip-Slip path rejected: ${entry.name}`), { status: 400 });
      const data = await entry.getData();
      if (!data) continue;
      if (data.length > MAX_ARCHIVE_ENTRY_B)
        throw Object.assign(new Error(`Entry too large: ${normalName} (${data.length} bytes)`), { status: 413 });
      totalBytes += data.length;
      if (totalBytes > MAX_ARCHIVE_TOTAL_B)
        throw Object.assign(new Error(`Archive expands beyond size cap (${MAX_ARCHIVE_TOTAL_B} bytes)`), { status: 413 });
      await fsp.mkdir(path.dirname(destFile), { recursive: true });
      // O_NOFOLLOW on the WRITE call: if `destFile` already exists as a
      // symlink (e.g. a previous mod left one behind), refuse instead of
      // writing through to the target. We don't pass O_EXCL because legitimate
      // mod re-installs should be able to overwrite their own files.
      const fh = await fsp.open(destFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
      try { await fh.writeFile(data); } finally { await fh.close().catch(() => {}); }
      filesExtracted++;
    }

    return { modType, modId: modRoot, destination: destDir, filesExtracted };
  } finally {
    if (archive?.close) await Promise.resolve(archive.close()).catch(() => {});
  }
}

// ── Chunked upload ─────────────────────────────────────────────────────────────
const CHUNK_TMP_DIR    = path.join(os.tmpdir(), 'ac-upload-chunks');
// Hard ceiling for any single archive, regardless of panel_settings.upload_max_mb.
// The frontend setting goes in admin Configuración; this cap is a safety net so
// a misconfigured value (or hostile DB edit) cannot OOM the panel.
const UPLOAD_HARD_CAP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

// Atomic per-uploadId lock. Used to serialise every operation that touches the
// same uploadId — chunk write, readdir count, and assembly all happen inside
// the same critical section, so two concurrent final-chunk requests can never
// both pass the "received == totalChunks" check and double-extract. Releasing
// happens in the finally block of withUploadLock so a thrown exception or
// process crash mid-flight still drops the lock for the next request.
const _uploadLocks = new Map(); // uploadId -> Promise (resolves when current op done)
async function withUploadLock(uploadId, fn) {
  // Chain onto any in-flight lock for the same uploadId. Multiple waiters all
  // resolve when the previous holder releases, then the JS scheduler picks one
  // to actually run next; the others loop and wait again. Cooperative FIFO.
  while (_uploadLocks.has(uploadId)) {
    try { await _uploadLocks.get(uploadId); } catch {}
  }
  let release;
  const p = new Promise(r => { release = r; });
  _uploadLocks.set(uploadId, p);
  try { return await fn(); }
  finally { _uploadLocks.delete(uploadId); release(); }
}
// Per-user state: at most one active upload at a time. A new uploadId from the
// same user is rejected until the current one finishes or stales out (no chunks
// for STALE_MS). Cleared on success/failure of the assembly.
const _userUploads = new Map(); // username -> { uploadId, lastChunkAt }
const USER_UPLOAD_STALE_MS = 5 * 60 * 1000;
function noteUserUpload(username, uploadId) {
  _userUploads.set(username, { uploadId, lastChunkAt: Date.now() });
}
function clearUserUpload(username) { _userUploads.delete(username); }
function userHasOtherUploadActive(username, uploadId) {
  const entry = _userUploads.get(username);
  if (!entry) return false;
  if (entry.uploadId === uploadId) return false;
  if (Date.now() - entry.lastChunkAt > USER_UPLOAD_STALE_MS) {
    _userUploads.delete(username);
    return false;
  }
  return true;
}

async function cleanupOldChunks() {
  let removed = 0;
  try {
    const entries = await fsp.readdir(CHUNK_TMP_DIR).catch(() => []);
    const now = Date.now();
    for (const entry of entries) {
      const dir = path.join(CHUNK_TMP_DIR, entry);
      const stat = await fsp.stat(dir).catch(() => null);
      if (stat && now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
        await fsp.rm(dir, { recursive: true }).catch(() => {});
        removed++;
      }
    }
  } catch {}
  _sweeperState.chunks = { lastRunAt: Date.now(), lastRemoved: removed };
}

async function apiModUploadChunk(req, res) {
  if (!checkPermission(req, 'modUpload')) return json(res, 403, { error: 'Forbidden' });
  const uploadedBy = checkAnyAuth(req)?.username || 'unknown';
  // Each chunk is a separate request; allow up to 4096 chunks/hour per IP (≈ one full
  // 20 GB upload at 5 MB/chunk before lockout). Stops scripted spam without breaking
  // legitimate uploads.
  if (!checkRateLimit('mod-chunk', clientIp(req), 4096, 60 * 60 * 1000))
    return json(res, 429, { error: 'Rate limit: too many chunks' });

  // Body is JSON with base64-encoded chunk data — same format as other API calls,
  // avoids multipart/form-data and binary bodies which Cloudflare WAF may block
  let body;
  try {
    body = await new Promise((resolve, reject) => {
      const MAX = 10 * 1024 * 1024; // 10 MB JSON limit (base64 of 7 MB chunk)
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > MAX) { req.destroy(); reject(new Error('Body too large')); } });
      req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); } });
      req.on('error', reject);
    });
  } catch (e) { return json(res, 400, { error: e.message }); }

  const uploadId    = (body.uploadId    || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const chunkIndex  = parseInt(body.chunkIndex  ?? '-1', 10);
  const totalChunks = parseInt(body.totalChunks ?? '0',  10);
  const filename    = body.filename || '';
  const dataB64     = body.data || '';

  // Bounds: prevents an inflated chunkIndex (e.g. 9999) from inflating the readdir
  // count and triggering early assembly with missing chunks.
  const MAX_TOTAL_CHUNKS = 4096; // 4096 × 5 MB ≈ 20 GB ceiling — much higher than any real mod
  if (!uploadId || chunkIndex < 0 || totalChunks < 1 || !filename || !dataB64)
    return json(res, 400, { error: 'Invalid chunk parameters' });
  if (totalChunks > MAX_TOTAL_CHUNKS)
    return json(res, 400, { error: `totalChunks > ${MAX_TOTAL_CHUNKS}` });
  if (userHasOtherUploadActive(uploadedBy, uploadId))
    return json(res, 429, { error: 'You already have an upload in progress — wait for it to finish or 5 min' });
  noteUserUpload(uploadedBy, uploadId);
  if (chunkIndex >= totalChunks)
    return json(res, 400, { error: 'chunkIndex out of range' });

  const uploadDir = path.join(CHUNK_TMP_DIR, uploadId);
  if (!uploadDir.startsWith(CHUNK_TMP_DIR + path.sep))
    return json(res, 400, { error: 'Invalid uploadId' });

  let chunkData;
  try { chunkData = Buffer.from(dataB64, 'base64'); }
  catch { return json(res, 400, { error: 'Invalid base64 data' }); }

  // Optional client-supplied sha256 of the raw chunk bytes. When present, verify
  // — a mismatch means the chunk got corrupted in transit (or somebody is trying
  // to swap chunk contents mid-upload). When absent, fall back to byte-equality
  // on duplicates below; the client is encouraged to send the hash for safety.
  if (body.sha256 != null) {
    if (typeof body.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(body.sha256)) {
      return json(res, 400, { error: 'sha256 must be 64 hex chars' });
    }
    const have = crypto.createHash('sha256').update(chunkData).digest('hex');
    if (have !== body.sha256.toLowerCase()) {
      return json(res, 400, { error: 'sha256 mismatch — chunk corrupted in transit' });
    }
  }

  try {
    await fsp.mkdir(uploadDir, { recursive: true });

    // Everything from here is serialised per uploadId. Without this, two
    // requests carrying the same final chunk index could both reach the
    // `received === totalChunks` check between each other's awaits and both
    // proceed to assembly — extracting the same archive twice (and triggering
    // mod-install audit rows twice). The lock also covers chunk-duplicate
    // handling: a retry of the same chunk while assembly is in progress sees
    // the lock and waits, instead of racing the unlink during assembly.
    return await withUploadLock(uploadId, async () => {
      // Refuse duplicate chunks unless they are byte-identical to the existing
      // copy. O_EXCL on a fresh fd makes the "first write wins" semantics
      // explicit: a legitimate client retry of a flaky chunk is idempotent;
      // an attacker (or buggy client) trying to swap chunk content with a
      // different payload gets 409.
      const chunkPath = path.join(uploadDir, `chunk-${chunkIndex}`);
      try {
        const fh = await fsp.open(chunkPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
        try { await fh.writeFile(chunkData); } finally { await fh.close().catch(() => {}); }
      } catch (e) {
        if (e.code === 'EEXIST') {
          const existing = await fsp.readFile(chunkPath).catch(() => null);
          if (!existing || !existing.equals(chunkData)) {
            return json(res, 409, { error: `chunk ${chunkIndex} already received with different contents` });
          }
          // Same bytes — accept the duplicate as idempotent.
        } else { throw e; }
      }

      const received = (await fsp.readdir(uploadDir)).filter(f => f.startsWith('chunk-')).length;
      if (received < totalChunks)
        return json(res, 200, { ok: true, done: false, received, total: totalChunks });

      // Assemble chunks into a single temp file on disk — never `Buffer.concat` the
      // whole upload, which would peak at 2× the file size in RAM. Read each chunk,
      // append it to the output stream, free the buffer. Peak RAM stays at one
      // chunk (≈5 MB).
      const assembledPath = path.join(os.tmpdir(), `ac-assembled-${uploadId}.bin`);
      try {
        const out = fs.createWriteStream(assembledPath);
        let totalBytes = 0;
        for (let i = 0; i < totalChunks; i++) {
          const cPath = path.join(uploadDir, `chunk-${i}`);
          const buf = await fsp.readFile(cPath);
          totalBytes += buf.length;
          if (totalBytes > UPLOAD_HARD_CAP_BYTES) {
            out.destroy();
            throw Object.assign(new Error(`Upload exceeds hard cap of ${UPLOAD_HARD_CAP_BYTES} bytes`), { status: 413 });
          }
          await new Promise((resolve, reject) => {
            out.write(buf, e => e ? reject(e) : resolve());
          });
          await fsp.unlink(cPath).catch(() => {});
        }
        await new Promise(r => out.end(r));
        await fsp.rm(uploadDir, { recursive: true }).catch(() => {});

        // Pass the assembled file to processModBuffer. We still read it into a Buffer
        // here because the extractors operate on Buffer; refactoring them to streaming
        // input is a follow-up task. At least we no longer hold N + 1 copies in RAM.
        const fileBuf = await fsp.readFile(assembledPath);
        const result = await processModBuffer(fileBuf, filename);
        invalidateContentCache(result.modType === 'car' ? 'cars' : 'tracks');
        insertModHistory({ ok: true, filename, uploadedBy, ...result });
        insertAuditLog(uploadedBy || 'unknown', 'mod.install', result.modId || filename, `${result.modType}, ${result.filesExtracted} files`);
        clearUserUpload(uploadedBy);
        return json(res, 200, { ok: true, done: true, ...result });
      } finally {
        await fsp.unlink(assembledPath).catch(() => {});
      }
    });
  } catch (e) {
    await fsp.rm(uploadDir, { recursive: true }).catch(() => {});
    clearUserUpload(uploadedBy);
    insertModHistory({ ok: false, filename, uploadedBy, error: e.message });
    log.error('chunk upload failed:', e.message);
    json(res, e.status || 500, { error: e.message });
  }
}

// ── Mod upload endpoint ───────────────────────────────────────────────────────
async function apiModUpload(req, res) {
  if (!checkPermission(req, 'modUpload')) return json(res, 403, { error: 'Forbidden' });
  if (!checkRateLimit('mod-upload', clientIp(req), 30, 60 * 60 * 1000))
    return json(res, 429, { error: 'Rate limit: too many uploads (max 30/hour)' });

  let maxMb = 500;
  if (db) {
    const row = db.prepare(`SELECT value FROM panel_settings WHERE key = 'upload_max_mb'`).get();
    if (row) maxMb = parseInt(row.value, 10) || 500;
  }
  // Cap whatever the admin configured — UPLOAD_HARD_CAP_BYTES is the absolute
  // ceiling so a runaway setting cannot OOM the panel.
  const effectiveCap = Math.min(maxMb * 1024 * 1024, UPLOAD_HARD_CAP_BYTES);

  let parts;
  try { parts = await parseMultipart(req, effectiveCap); }
  catch (e) {
    if (e.code === 'ELIMIT') return json(res, 413, { error: `File too large (max ${Math.floor(effectiveCap / 1024 / 1024)} MB)` });
    return json(res, 400, { error: `Error en la subida: ${e.message}` });
  }
  const filePart = parts.file;
  if (!filePart?.filePath) return json(res, 400, { error: 'No file received (field: file)' });

  const uploadedBy = checkAnyAuth(req)?.username || null;
  try {
    // The streaming parser wrote the upload straight to disk — read it back as a
    // Buffer here for the existing processModBuffer pipeline. Peak RAM is now 1×
    // file size (the readFile) instead of the previous 2× (buffered chunks +
    // concat). Refactoring the extractors to consume a stream is a follow-up.
    const fileBuf = await fsp.readFile(filePart.filePath);
    const result = await processModBuffer(fileBuf, filePart.filename);
    invalidateContentCache(result.modType === 'car' ? 'cars' : 'tracks');
    insertModHistory({ ok: true, filename: filePart.filename, uploadedBy, ...result });
    insertAuditLog(uploadedBy || 'unknown', 'mod.install', result.modId || filePart.filename, `${result.modType}, ${result.filesExtracted} files`);
    json(res, 200, { ok: true, ...result });
  } catch (e) {
    insertModHistory({ ok: false, filename: filePart.filename, uploadedBy, error: e.message });
    log.error('mod upload failed:', e.message);
    json(res, e.status || 500, { error: e.message });
  } finally {
    fsp.unlink(filePart.filePath).catch(() => {});
  }
}

// CSRF: reject unsafe methods whose Origin/Referer does not match Host.
// Cookie is SameSite=Strict so cross-site requests already lose the cookie,
// but the Origin check is a belt-and-braces second layer (e.g. against
// subtle browser bugs or a same-site malicious context).
//
// CSRF only matters for cookie-based auth. A request with no `sid` cookie
// cannot replay the user's session (a malicious site has no way to forge a
// cookie that is HttpOnly + SameSite=Strict); such requests bypass the
// Origin check so headless ADMIN_TOKEN callers (which use X-Admin-Token /
// Authorization: Bearer, never cookies) keep working.
//
// When a session cookie IS present, the request MUST carry a matching
// Origin or Referer. Modern browsers always attach Origin to
// POST/PUT/DELETE/PATCH; a missing pair would only come from a hand-crafted
// client or a `Referrer-Policy: no-referrer` form from another origin —
// the exact shape of a CSRF attempt. Refuse.
function isUnsafeMethod(m) { return m === 'POST' || m === 'PUT' || m === 'DELETE' || m === 'PATCH'; }
function checkOrigin(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (!host) return false;
  // No session cookie = no cookie-based auth = no CSRF vector. Token-only
  // headless callers (ADMIN_TOKEN) hit this branch and pass without an Origin.
  if (!readCookie(req, 'sid')) return true;
  const raw = req.headers.origin || req.headers.referer || '';
  if (!raw) {
    console.warn(`[checkOrigin] reject ${req.method} ${req.url} — session cookie present but no Origin/Referer header (peer=${req.socket?.remoteAddress || '?'})`);
    return false;
  }
  try {
    const u = new URL(raw);
    const originHost = u.host.toLowerCase();
    if (originHost === host) return true;
    // Behind a reverse proxy that rewrites the Host header to the upstream socket
    // (nginx without `proxy_set_header Host`, Caddy with default reverse_proxy,
    // cloudflared with `httpHostHeader: localhost`), Origin will match the public
    // hostname while Host arrives as `localhost:PORT`. Accept the forwarded host
    // when the peer is a trusted proxy — same trust gate the rate limiter uses.
    if (TRUST_PROXY && isTrustedProxyIp(req.socket?.remoteAddress || '')) {
      const xfh = (req.headers['x-forwarded-host'] || '').toLowerCase().split(',')[0].trim();
      if (xfh && originHost === xfh) return true;
    }
    console.warn(`[checkOrigin] reject ${req.method} ${req.url} — origin "${originHost}" ≠ host "${host}"` +
      (TRUST_PROXY ? ` (x-forwarded-host="${req.headers['x-forwarded-host'] || ''}", peer=${req.socket?.remoteAddress || '?'})` : ''));
    return false;
  } catch {
    console.warn(`[checkOrigin] reject ${req.method} ${req.url} — invalid Origin/Referer "${raw}"`);
    return false;
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
function handler(req, res) {
  setSecurityHeaders(req, res);
  const urlPath = req.url.split('?')[0];

  // Belt-and-braces alongside the X-Robots-Tag header and the <meta robots> in
  // index.html: a polite crawler reads /robots.txt before anything else and a
  // Disallow: / here stops it cold. Served unauthenticated and cached for a
  // day so it never causes load. Lives above the /api prefix so the static
  // fallback never gets a shot at returning a 404 for it.
  if (urlPath === '/robots.txt' && req.method === 'GET') {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return respond(res, 200, 'text/plain; charset=utf-8',
      'User-agent: *\nDisallow: /\n');
  }

  // Public player profile page — server-rendered HTML at /p/<guid>. Lives
  // above the auth gate because the whole point is "share a link nobody
  // needs a panel login to open". The toggle in panel_settings disables it
  // server-side when an operator doesn't want the panel publicly visible.
  const publicPlayerPageMatch = urlPath.match(/^\/p\/(\d{17})$/);
  if (publicPlayerPageMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    return apiPublicPlayerPage(req, res, publicPlayerPageMatch[1]);
  }
  // OpenGraph card image for the same driver. PNG is the canonical version
  // (Discord / Slack / Twitter render it), SVG endpoint kept around for the
  // few clients that prefer vector + direct human browsing.
  const publicPlayerOgPngMatch = urlPath.match(/^\/p\/(\d{17})\/og\.png$/);
  if (publicPlayerOgPngMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    return apiPublicPlayerOgPng(req, res, publicPlayerOgPngMatch[1]);
  }
  const publicPlayerOgSvgMatch = urlPath.match(/^\/p\/(\d{17})\/og\.svg$/);
  if (publicPlayerOgSvgMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    return apiPublicPlayerOgImage(req, res, publicPlayerOgSvgMatch[1]);
  }
  // Downloadable stat card (5 KPIs + map of most-played track + footer URL).
  // Same machinery as the OG PNG but a richer layout meant for sharing on
  // Discord/Twitter as an attachment rather than a link preview.
  const publicPlayerCardPngMatch = urlPath.match(/^\/p\/(\d{17})\/card\.png$/);
  if (publicPlayerCardPngMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    return apiPublicPlayerCardPng(req, res, publicPlayerCardPngMatch[1]);
  }
  // Companion JS for the public profile page's theme toggle. Tiny static
  // string; served unauthenticated so the page actually loads without a
  // session cookie. Cached aggressively because the body is a constant.
  if (urlPath === '/p/_theme.js' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    return respond(res, 200, 'application/javascript; charset=utf-8', _PUBLIC_PROFILE_THEME_JS);
  }

  if (urlPath.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Allow': 'GET, PUT, POST, DELETE, OPTIONS' });
      return res.end();
    }

    // CSRF guard: unsafe methods must come from same-origin contexts
    if (isUnsafeMethod(req.method) && !checkOrigin(req)) {
      return json(res, 403, { error: 'Cross-origin request blocked' });
    }

    // Public endpoints — no auth required. Don't leak process.uptime to anonymous
    // clients; it is a fingerprinting signal worth nothing to legitimate health probes.
    if (urlPath === '/api/health' && req.method === 'GET')
      return json(res, 200, { ok: true });
    // /api/setup/status is also public: the login screen reads it to render a
    // configuration banner before any login can succeed when AC_CFG_DIR is
    // wrong. No secrets leak — only the filesystem paths the operator chose.
    if (urlPath === '/api/setup/status' && req.method === 'GET') return apiSetupStatus(req, res);

    // Public player profile JSON — same data as /p/<guid> but in machine form,
    // for Discord bots, Twitch overlays and similar integrations that want the
    // stats without scraping the HTML. Auth-less; rate-limited per IP. Match
    // on the prefix (not the strict 17-digit shape) so an invalid Steam ID
    // produces a 400 from the handler instead of a confusing 401 from the
    // auth gate below. HEAD is accepted so a Discord bot's existence check
    // doesn't trip the auth gate either.
    if (urlPath.startsWith('/api/public/players/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const guid = urlPath.slice('/api/public/players/'.length);
      return apiPublicPlayer(req, res, guid);
    }

    // Auth
    if (urlPath === '/api/auth/me'              && req.method === 'GET')  return apiAuthMe(req, res);
    if (urlPath === '/api/auth/login'           && req.method === 'POST') return apiAuthLogin(req, res);
    if (urlPath === '/api/auth/logout'          && req.method === 'POST') return apiAuthLogout(req, res);
    if (urlPath === '/api/auth/change-password' && req.method === 'POST') return apiAuthChangePassword(req, res);
    // Second-factor management. Each endpoint requires a valid session and is
    // self-gated; they live alongside change-password so they remain reachable
    // even while the must_change_password flag is set on the user.
    if (urlPath === '/api/auth/2fa/status'      && req.method === 'GET')  return apiAuth2faStatus(req, res);
    if (urlPath === '/api/auth/2fa/setup'       && req.method === 'POST') return apiAuth2faSetup(req, res);
    if (urlPath === '/api/auth/2fa/confirm'     && req.method === 'POST') return apiAuth2faConfirm(req, res);
    if (urlPath === '/api/auth/2fa/rotate'      && req.method === 'POST') return apiAuth2faRotate(req, res);
    if (urlPath === '/api/auth/2fa/disable'     && req.method === 'POST') return apiAuth2faDisable(req, res);

    // All routes below require a valid session
    const sess = checkAnyAuth(req);
    if (!sess) return json(res, 401, { error: 'Unauthorized' });

    // While must_change_password is set, deny everything except the change-password
    // flow (already handled above as a public endpoint with credential proof).
    if (userMustChangePassword(sess.username)) {
      return json(res, 403, { error: 'Password change required', mustChangePassword: true });
    }

    // Panel users CRUD
    if (urlPath === '/api/panel/users' && req.method === 'GET')  return apiPanelUsers(req, res);
    if (urlPath === '/api/panel/users' && req.method === 'POST') return apiPanelUserCreate(req, res);

    // Panel settings
    if (urlPath === '/api/panel/settings' && req.method === 'GET') return apiPanelSettingsGet(req, res);
    if (urlPath === '/api/panel/settings' && req.method === 'PUT') return apiPanelSettingsPut(req, res);
    if (urlPath === '/api/discord/webhook/test' && req.method === 'POST') return apiDiscordWebhookTest(req, res);

    // Role permissions
    if (urlPath === '/api/permissions/role' && req.method === 'GET') return apiRolePermissionsGet(req, res);
    if (urlPath === '/api/permissions/role' && req.method === 'PUT') return apiRolePermissionsPut(req, res);

    // Mod upload & history
    if (urlPath === '/api/mods/upload'       && req.method === 'POST')   return apiModUpload(req, res);
    if (urlPath === '/api/mods/upload/chunk' && req.method === 'POST')   return apiModUploadChunk(req, res);
    if (urlPath === '/api/mods/history'      && req.method === 'GET')    return apiModHistoryGet(res);
    if (urlPath === '/api/mods/history'      && req.method === 'DELETE') return apiModHistoryDelete(req, res);
    if (urlPath === '/api/audit'             && req.method === 'GET')    return apiAuditGet(req, res);
    if (urlPath === '/api/audit/export'      && req.method === 'GET')    return apiAuditExport(req, res);
    if (urlPath === '/api/dashboard/extra'   && req.method === 'GET')    return apiDashboardExtra(req, res);
    if (urlPath === '/api/admin/backup'      && req.method === 'GET')    return apiAdminBackup(req, res);
    if (urlPath === '/api/admin/stats'       && req.method === 'GET')    return apiAdminStats(req, res);
    if (urlPath === '/api/admin/health'      && req.method === 'GET')    return apiAdminHealth(req, res);
    if (urlPath === '/api/admin/metrics'     && req.method === 'GET')    return apiAdminMetricsProm(req, res);
    const panelUserM = urlPath.match(/^\/api\/panel\/users\/([^/]+)$/);
    if (panelUserM && req.method === 'PUT')    return apiPanelUserUpdate(req, res, decodeURIComponent(panelUserM[1]));
    if (panelUserM && req.method === 'DELETE') return apiPanelUserDelete(req, res, decodeURIComponent(panelUserM[1]));

    // Server control (auth-protected)
    if (urlPath === '/api/server/start'   && req.method === 'POST') return apiServerStart(req, res);
    if (urlPath === '/api/server/stop'    && req.method === 'POST') return apiServerStop(req, res);
    if (urlPath === '/api/server/restart' && req.method === 'POST') return apiServerRestart(req, res);
    if (urlPath === '/api/server/reload'  && req.method === 'POST') return apiServerReload(req, res);

    // Player control
    if (urlPath === '/api/players/kick'   && req.method === 'POST') return apiPlayerKick(req, res);
    if (urlPath === '/api/players/ban'    && req.method === 'POST') return apiPlayerBan(req, res);
    if (urlPath === '/api/bans'           && req.method === 'GET')  return apiBansList(req, res);
    const unbanMatch = urlPath.match(/^\/api\/players\/(\d{17})\/ban$/);
    if (unbanMatch && req.method === 'DELETE') return apiPlayerUnban(req, res, unbanMatch[1]);
    const playerNickMatch = urlPath.match(/^\/api\/players\/(\d{17})\/nickname$/);
    if (playerNickMatch && req.method === 'PUT') return apiPlayerNickname(req, res, playerNickMatch[1]);

    // Whitelist
    if (urlPath === '/api/whitelist'     && req.method === 'GET')  return apiWhitelistGet(req, res);
    if (urlPath === '/api/whitelist'     && req.method === 'PUT')  return apiWhitelistPut(req, res);
    if (urlPath === '/api/whitelist/add' && req.method === 'POST') return apiWhitelistAdd(req, res);

    // Session apply
    if (urlPath === '/api/session/apply'  && req.method === 'POST') return apiSessionApply(req, res);

    // Session presets (saved bundles a user can load back into the Session page)
    if (urlPath === '/api/session-presets'        && req.method === 'GET')  return apiSessionPresetsList(req, res);
    if (urlPath === '/api/session-presets'        && req.method === 'POST') return apiSessionPresetCreate(req, res);
    if (urlPath === '/api/session-presets/import' && req.method === 'POST') return apiSessionPresetImport(req, res);
    const presetExportMatch = urlPath.match(/^\/api\/session-presets\/(\d+)\/export$/);
    if (presetExportMatch && req.method === 'GET') return apiSessionPresetExport(req, res, Number(presetExportMatch[1]));
    const presetIdMatch = urlPath.match(/^\/api\/session-presets\/(\d+)$/);
    if (presetIdMatch) {
      const presetId = Number(presetIdMatch[1]);
      if (req.method === 'GET')    return apiSessionPresetGet(req, res, presetId);
      if (req.method === 'PUT')    return apiSessionPresetUpdate(req, res, presetId);
      if (req.method === 'DELETE') return apiSessionPresetDelete(req, res, presetId);
    }

    // Content image endpoints
    const carSkinMatch         = urlPath.match(/^\/api\/content\/cars\/([^/]+)\/skins\/([^/]+)\/preview$/);
    const carKunosSkinMatch    = urlPath.match(/^\/api\/content\/cars\/([^/]+)\/kunos-skin\/([^/]+)\/preview$/);
    const carThumbMatch        = urlPath.match(/^\/api\/content\/cars\/([^/]+)\/thumb$/);
    const trackThumbMatch      = urlPath.match(/^\/api\/content\/tracks\/([^/]+)\/thumb$/);
    const trackLayoutThumbMatch= urlPath.match(/^\/api\/content\/tracks\/([^/]+)\/layout\/([^/]+)\/thumb$/);
    if (carKunosSkinMatch    && req.method === 'GET') return apiKunosSkinPreview(decodeURIComponent(carKunosSkinMatch[1]), decodeURIComponent(carKunosSkinMatch[2]), res);
    if (carSkinMatch         && req.method === 'GET') return apiCarSkinPreview(decodeURIComponent(carSkinMatch[1]), decodeURIComponent(carSkinMatch[2]), res);
    if (carThumbMatch        && req.method === 'GET') return apiCarThumb(decodeURIComponent(carThumbMatch[1]), res);
    if (trackLayoutThumbMatch && req.method === 'GET') return apiTrackLayoutThumb(decodeURIComponent(trackLayoutThumbMatch[1]), decodeURIComponent(trackLayoutThumbMatch[2]), res);
    if (trackThumbMatch      && req.method === 'GET') return apiTrackThumb(decodeURIComponent(trackThumbMatch[1]), res);
    // Minimap PNG + INI calibration for the Live position telemetry widget.
    // Layout selection is via ?layout=... query string (single-layout tracks
    // can omit it and the helper falls back to the track root). Both
    // endpoints accept HEAD so Cloudflare healthchecks don't trip the auth.
    const trackMapMatch     = urlPath.match(/^\/api\/content\/tracks\/([^/]+)\/map$/);
    const trackMapMetaMatch = urlPath.match(/^\/api\/content\/tracks\/([^/]+)\/map-meta$/);
    if (trackMapMatch     && (req.method === 'GET' || req.method === 'HEAD')) return apiTrackMap(req, res, decodeURIComponent(trackMapMatch[1]));
    if (trackMapMetaMatch && (req.method === 'GET' || req.method === 'HEAD')) return apiTrackMapMeta(req, res, decodeURIComponent(trackMapMetaMatch[1]));

    // Data endpoints
    if (urlPath === '/api/metrics'         && req.method === 'GET') return apiMetrics(res);
    if (urlPath === '/api/logs'            && req.method === 'GET') return apiLogs(req, res);
    if (urlPath === '/api/logs/clear'      && req.method === 'POST') return apiLogsClear(req, res);
    if (urlPath === '/api/logs/stream'     && req.method === 'GET') return apiLogsStream(req, res);
    if (urlPath === '/api/positions/stream' && req.method === 'GET') return apiPositionsStream(req, res);
    if (urlPath === '/api/config'          && req.method === 'GET') return apiConfig(req, res);
    if (urlPath === '/api/config'          && req.method === 'PUT') return apiConfigUpdate(req, res);
    if (urlPath === '/api/players'         && req.method === 'GET') return apiPlayers(res);
    if (urlPath === '/api/players/history' && req.method === 'GET') return apiPlayersHistory(res);
    if (urlPath === '/api/results'         && req.method === 'GET') return apiResults(req, res);
    if (urlPath === '/api/laps'            && req.method === 'POST') return apiLapCreate(req, res);
    if (urlPath === '/api/cars'            && req.method === 'GET') return apiCars(res);
    if (urlPath === '/api/tracks'          && req.method === 'GET') return apiTracks(res);
    // Admin-only delete of mod content (Kunos refused server-side)
    const carDeleteMatch   = urlPath.match(/^\/api\/content\/cars\/([^/]+)$/);
    const trackDeleteMatch = urlPath.match(/^\/api\/content\/tracks\/([^/]+)$/);
    if (carDeleteMatch   && req.method === 'DELETE') return apiContentDelete(req, res, 'cars',   decodeURIComponent(carDeleteMatch[1]));
    if (trackDeleteMatch && req.method === 'DELETE') return apiContentDelete(req, res, 'tracks', decodeURIComponent(trackDeleteMatch[1]));
    return json(res, 404, { error: 'Unknown endpoint' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return respond(res, 405, 'text/plain', 'Method Not Allowed');
  }

  // Static files: allow-list of public roots only. Blocks /.env, /assetto.db,
  // /.git, /server.js, /node_modules, /package.json, /tools, etc.
  const STATIC_ALLOWED_FILES = new Set([
    '/index.html',
    '/sw.js',
    '/manifest.webmanifest',
    '/src/styles.css',
  ]);
  // /src/assets/ is kept reachable for the bundled Kunos preview images only;
  // JSX is served from /dist/ now (pre-transpiled by build.js).
  const STATIC_ALLOWED_PREFIXES = ['/src/assets/', '/dist/'];
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const isAllowed = STATIC_ALLOWED_FILES.has(requested)
    || STATIC_ALLOWED_PREFIXES.some(p => requested.startsWith(p));
  if (!isAllowed) {
    return respond(res, 404, 'text/plain', '404 Not Found');
  }

  const filePath = path.resolve(ROOT, '.' + requested);
  if (!filePath.startsWith(ROOT + path.sep)) {
    return respond(res, 403, 'text/plain', '403 Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      return respond(res, err.code === 'ENOENT' ? 404 : 500, 'text/plain', `${err.code} — ${urlPath}`);
    }
    // Smart Cache-Control: long for /dist/ JS and /src/assets/ images (rare changes,
    // network-first SW handles the few that matter); short for index.html / sw.js so
    // updates propagate quickly; no-store for /api/ already handled by `respond()`'s
    // default. Lets Cloudflare cache the heavy stuff and saves bandwidth.
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    let cache = 'no-store';
    if (requested.startsWith('/dist/'))            cache = 'public, max-age=600';
    else if (requested.startsWith('/src/assets/')) cache = 'public, max-age=86400, immutable';
    else if (requested === '/src/styles.css')      cache = 'public, max-age=600';
    else if (requested === '/manifest.webmanifest')cache = 'public, max-age=3600';
    else if (requested === '/sw.js')               cache = 'no-cache';
    else if (requested === '/index.html')          cache = 'no-cache';
    // Rewrite index.html to append a cache-busting ?v=BUILD_VERSION to each
    // /dist/*.js script source. Cloudflare aggressively upgrades the bundle
    // max-age downstream regardless of origin's `no-cache`, so without
    // versioned URLs a deploy can stay invisible for hours in browser caches.
    // The query param is stripped on the server side (urlPath ignores it),
    // so the same physical files keep serving — only the cache key changes.
    if (requested === '/index.html') {
      const v = getBuildVersion();
      data = Buffer.from(
        data.toString('utf8')
          // Cache-bust /dist/*.js script tags
          .replace(/(src="(?:[^"]*\/)?dist\/[^"]+\.js)"/g, `$1?v=${v}"`)
          // Cache-bust src/styles.css link too — Cloudflare honours the
          // origin's max-age=600 on the file so without a versioned URL a
          // CSS-only deploy stays invisible for up to 10 min while the
          // edge replays the previous stylesheet.
          .replace(/(href="(?:[^"]*\/)?src\/styles\.css)"/g, `$1?v=${v}"`),
        'utf8'
      );
    }
    respond(res, 200, mime, data, { 'Cache-Control': cache });
  });
}

// Build identity used to invalidate bundle URLs after every redeploy. Re-read
// from dist/app.js's mtime on each call, with a 5-second memoization to avoid
// stat-ing on every static request. Previously this was computed once at
// module load, which left `?v=…` frozen at the boot-time value — a deploy
// that ran `git pull && npm run build` without a node restart kept serving
// the old query string, so Cloudflare's edge happily replayed the previous
// bundle under that URL until the next node restart. With this, every
// rebuild reaches browsers on the next /index.html fetch (the cache is at
// most 5s stale; well below the 'visit panel after deploy' latency).
const _BUILD_VERSION_TTL_MS = 5000;
let _buildVersionCached = null;
let _buildVersionStaleAt = 0;
function getBuildVersion() {
  const now = Date.now();
  if (_buildVersionCached && now < _buildVersionStaleAt) return _buildVersionCached;
  try {
    const st = fs.statSync(path.join(ROOT, 'dist', 'app.js'));
    _buildVersionCached = String(Math.floor(st.mtimeMs));
  } catch {
    _buildVersionCached = String(now);
  }
  _buildVersionStaleAt = now + _BUILD_VERSION_TTL_MS;
  return _buildVersionCached;
}

// Rotate up to N timestamped backups of server_cfg.ini before each save. Without
// rotation, a single .bak file is overwritten on every save — two bad saves in
// a row would lose the last good config. We keep the legacy .bak for backwards
// compat and add per-day timestamped copies (or per-save when run multiple times
// in the same minute) up to a hard cap.
const CFG_BACKUPS_KEEP = Math.max(1, parseInt(process.env.CFG_BACKUPS_KEEP, 10) || 10);
async function rotateConfigBackup() {
  try {
    const dir   = path.dirname(AC_CFG_FILE);
    const base  = path.basename(AC_CFG_FILE);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const dated = path.join(dir, `${base}.${stamp}.bak`);
    await fsp.copyFile(AC_CFG_FILE, AC_CFG_FILE + '.bak');     // legacy single .bak
    await fsp.copyFile(AC_CFG_FILE, dated).catch(() => {});    // dated rotation
    // Trim oldest dated backups beyond the limit
    const entries = await fsp.readdir(dir).catch(() => []);
    const ours    = entries
      .filter(n => n.startsWith(base + '.') && n.endsWith('.bak') && n !== base + '.bak')
      .sort();
    while (ours.length > CFG_BACKUPS_KEEP) {
      const drop = ours.shift();
      await fsp.unlink(path.join(dir, drop)).catch(() => {});
    }
  } catch (e) { log.warn('config backup rotation failed:', e.message); }
}

// ── Start ─────────────────────────────────────────────────────────────────────
seedDefaultUsers();
loadKunosIds();
importAllResults();
startResultsWatcher();
loadLogFileIntoBuffer();
startLogTail();
cleanupOldChunks();

// Boot the UDP plugin listener if server_cfg.ini already has it enabled. If
// the admin hasn't applied a session yet, the auto-config in apiSessionApply
// will fill the lines on the first Apply and the listener kicks in after the
// subsequent acServer restart.
(function bootUdpListener() {
  try {
    const ini = parseINI(fs.readFileSync(AC_CFG_FILE, 'utf8'));
    const s = ini['SERVER'] || {};
    const localPort = parseInt(s['UDP_PLUGIN_LOCAL_PORT'], 10) || 0;
    const address   = (s['UDP_PLUGIN_ADDRESS'] || '').trim();
    if (localPort > 0 && address) udpStartListener(address, localPort);
    else log.info('[UDP] plugin lines absent in server_cfg.ini — will be auto-configured on next session apply');
  } catch (e) { log.warn('[UDP] could not read server_cfg.ini to boot listener:', e.message); }
})();
setInterval(cleanupOldChunks, 60 * 60 * 1000); // sweep abandoned chunk dirs every hour

// Sweeper status counters surfaced via /api/admin/stats so ops can see whether
// the background tasks are firing in prod without grepping logs.
const _sweeperState = {
  audit:    { lastRunAt: null, lastRemoved: 0 },
  login:    { lastRunAt: null, lastRemoved: 0 },
  chunks:   { lastRunAt: null, lastRemoved: 0 },
  sessions: { lastRunAt: null, lastRemoved: 0 },
};

// Audit log retention: keep entries for AUDIT_RETENTION_DAYS (env, default 365),
// sweep daily. Without this the table grows unbounded forever.
//
// The hash chain (insertAuditLog) is broken by definition when we delete the
// oldest rows — the next surviving row's prev_hash points at a now-gone row.
// We can't avoid that without unbounded retention, but we CAN make the gap
// visible: before deleting, insert an `audit.retention.sweep` row containing
// the count of rows being removed and the row_hash of the most recent
// row being kept. Any external verifier that walks the chain from the boundary
// row forward gets a continuous chain; tampering with the cutoff (e.g. an
// attacker deleting the most recent row to hide their tracks) makes the
// boundary row's `detail` disagree with the actual database state.
const AUDIT_RETENTION_DAYS = Math.max(1, parseInt(process.env.AUDIT_RETENTION_DAYS, 10) || 365);
function sweepAuditLog() {
  if (!db) return;
  try {
    const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    // Count what we're about to delete; if zero, skip the boundary row entirely.
    const countRow = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE logged_at < ?').get(cutoff);
    const toDelete = countRow?.n || 0;
    if (toDelete > 0) {
      // Record the boundary BEFORE the delete so the new row's prev_hash chains
      // off the surviving most-recent row, not the row we're about to remove.
      // Note the most recent kept row's hash too, so an external verifier can
      // reconcile: boundary.prev_hash === (most recent kept row).row_hash.
      const mostRecentKept = db.prepare(`SELECT row_hash FROM audit_log WHERE logged_at >= ? ORDER BY id DESC LIMIT 1`).get(cutoff);
      insertAuditLog('system', 'audit.retention.sweep', String(toDelete),
        `${toDelete} rows older than ${cutoff} pruned; tail=${(mostRecentKept?.row_hash || '').slice(0, 16)}`);
    }
    const r = db.prepare('DELETE FROM audit_log WHERE logged_at < ?').run(cutoff);
    _sweeperState.audit = { lastRunAt: Date.now(), lastRemoved: r.changes };
    if (r.changes > 0) log.info(`audit sweep: removed ${r.changes} entries older than ${AUDIT_RETENTION_DAYS}d`);
  } catch (e) { log.warn('audit sweep failed:', e.message); }
}
sweepAuditLog();
setInterval(sweepAuditLog, 24 * 60 * 60 * 1000);

// Drop expired login_attempts every 30 min so the table doesn't grow unbounded
function sweepLoginAttempts() {
  if (!db) return;
  try {
    const r = db.prepare('DELETE FROM login_attempts WHERE reset_at < ?').run(Date.now());
    _sweeperState.login = { lastRunAt: Date.now(), lastRemoved: r.changes };
  } catch {}
}
sweepLoginAttempts();
setInterval(sweepLoginAttempts, 30 * 60 * 1000);

// The in-memory rate-limit / login / upload maps have no DB backing to sweep
// from, so expired entries would otherwise accumulate forever — a scanner
// rotating source IPs (resolved via CF-Connecting-IP), or just normal traffic
// over weeks, grows them unbounded. Drop entries whose window has elapsed.
function sweepMemoryMaps() {
  const now = Date.now();
  let removed = 0;
  for (const [k, e]  of _rateBuckets)   if (!e || now >= e.resetAt) { _rateBuckets.delete(k);    removed++; }
  for (const [ip, e] of _loginAttempts) if (!e || now >= e.resetAt) { _loginAttempts.delete(ip); removed++; }
  for (const [u, e]  of _userUploads)   if (!e || now - e.lastChunkAt > 2 * 60 * 60 * 1000) { _userUploads.delete(u); removed++; }
  _sweeperState.memory = { lastRunAt: Date.now(), lastRemoved: removed };
}
setInterval(sweepMemoryMaps, 10 * 60 * 1000);

// Daily DB hygiene: drop processed-results markers older than 90 days (those
// result files are long gone from disk, and re-import is idempotent anyway) and
// let SQLite refresh its query-planner stats.
function sweepDbMaintenance() {
  if (!db) return;
  try {
    const r = db.prepare("DELETE FROM processed_files WHERE processed_at < datetime('now','-90 days')").run();
    db.pragma('optimize');
    _sweeperState.dbMaintenance = { lastRunAt: Date.now(), lastRemoved: r.changes };
  } catch {}
}
setInterval(sweepDbMaintenance, 24 * 60 * 60 * 1000);

// Drop expired sessions every hour. createSession opportunistically clears
// expired rows when minting a new token, but if the panel has zero logins
// for weeks the table grows unbounded. getSession already filters by
// `expires_at > ?` at read time, so this is for table hygiene rather than
// correctness — keeps /api/admin/stats honest and the rows count tiny.
function sweepExpiredSessions() {
  if (!db) return;
  try {
    const r = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    _sweeperState.sessions = { lastRunAt: Date.now(), lastRemoved: r.changes };
  } catch {}
}
sweepExpiredSessions();
setInterval(sweepExpiredSessions, 60 * 60 * 1000);

// Lift bans whose TTL has passed. Runs hourly. _unbanInternal removes the
// GUID from blacklist.txt under the same file lock used by the ban endpoint
// and drops the bans row; the audit trail keeps a `player.unban.expired`
// line so an operator can still see who was banned, by whom, and when the
// ban was cleared. The blacklist.txt + DB stay in sync regardless of which
// path triggered the unban.
_sweeperState.bans = { lastRunAt: null, lastRemoved: 0 };
async function sweepExpiredBans() {
  if (!db) return;
  try {
    const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const rows = db.prepare('SELECT guid FROM bans WHERE expires_at IS NOT NULL AND expires_at <= ?').all(nowIso);
    let removed = 0;
    for (const r of rows) {
      await _unbanInternal(r.guid, 'system', 'player.unban.expired');
      removed++;
    }
    _sweeperState.bans = { lastRunAt: Date.now(), lastRemoved: removed };
    if (removed > 0) log.info(`bans sweep: auto-unbanned ${removed} expired entr${removed === 1 ? 'y' : 'ies'}`);
  } catch (e) { log.warn('bans sweep failed:', e.message); }
}
sweepExpiredBans();
setInterval(sweepExpiredBans, 60 * 60 * 1000);

// ── Scheduled DB backups ─────────────────────────────────────────────────────
// VACUUM INTO produces a consistent snapshot of the live DB without locking
// readers/writers, so the sweep can run while the panel is serving requests.
// BACKUP_INTERVAL_HOURS=0 (default) disables auto-backups; the manual
// /api/admin/backup endpoint still works either way.
//
// Files land in BACKUP_DIR (default: a `backups/` dir next to the DB) with
// names like `assetto-2026-05-16T14-30-00.db`. Anything older than the most
// recent BACKUP_KEEP files is deleted.
const BACKUP_INTERVAL_HOURS = Math.max(0, parseInt(process.env.BACKUP_INTERVAL_HOURS, 10) || 0);
const BACKUP_KEEP           = Math.max(1, parseInt(process.env.BACKUP_KEEP, 10) || 14);
const BACKUP_DIR            = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups'));
_sweeperState.backups = { lastRunAt: null, lastRemoved: 0, lastFile: null, lastError: null };

async function runScheduledBackup() {
  if (!db) return;
  try {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const dest  = path.join(BACKUP_DIR, `assetto-${stamp}.db`);
    // VACUUM INTO refuses to overwrite. The timestamp resolution is 1 s so
    // two manually-forced sweeps in the same second would collide; unlink
    // any pre-existing file first to keep the cron robust.
    await fsp.unlink(dest).catch(() => {});
    db.prepare('VACUUM INTO ?').run(dest);
    // Retention: keep the newest BACKUP_KEEP files, drop the rest.
    const files = (await fsp.readdir(BACKUP_DIR))
      .filter(n => /^assetto-.*\.db$/.test(n))
      .sort()
      .reverse();
    let removed = 0;
    for (const f of files.slice(BACKUP_KEEP)) {
      await fsp.unlink(path.join(BACKUP_DIR, f)).catch(() => {});
      removed++;
    }
    _sweeperState.backups = { lastRunAt: Date.now(), lastRemoved: removed, lastFile: dest, lastError: null };
    const st = await fsp.stat(dest);
    insertAuditLog('system', 'admin.backup.auto', path.basename(dest), `${st.size} bytes; pruned ${removed} older snapshot(s)`);
    log.info(`backup sweep: wrote ${path.basename(dest)} (${st.size} bytes), pruned ${removed} old file(s)`);
  } catch (e) {
    _sweeperState.backups.lastError = e.message;
    log.warn('backup sweep failed:', e.message);
  }
}
if (BACKUP_INTERVAL_HOURS > 0) {
  // Don't run on boot — wait a full interval so a panel that restarts every
  // few minutes (during initial setup) doesn't spam backup files. The first
  // backup fires BACKUP_INTERVAL_HOURS hours after boot.
  setInterval(runScheduledBackup, BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
  log.info(`scheduled backups enabled: every ${BACKUP_INTERVAL_HOURS}h, keeping ${BACKUP_KEEP} snapshots in ${BACKUP_DIR}`);
}

const server = http.createServer((req, res) => {
  // Honour an upstream X-Request-Id (e.g. from Cloudflare) to keep correlation
  // across the proxy → panel → AC server hops; otherwise mint a fresh one.
  // Strip anything that isn't [A-Za-z0-9-] — control chars or spaces in this
  // header land in our log lines (see _logEmit) and downstream parsers, so
  // letting them through is a log-injection vector.
  const reqIdRaw = String(req.headers['x-request-id'] || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
  const reqId = reqIdRaw || newRequestId();
  res.setHeader('X-Request-Id', reqId);
  _reqContext.run({ reqId }, () => handler(req, res));
});

server.listen(PORT, HOST, () => {
  const ip   = getNetworkIP();
  const line = '─'.repeat(44);
  console.log(`\n  ${line}`);
  console.log(`    Assetto Server Panel v${require('./package.json').version}`);
  console.log(`  ${line}`);
  console.log(`    Local    →  http://localhost:${PORT}`);
  console.log(`    Network  →  http://${ip}:${PORT}`);
  console.log(`  ${line}\n`);
  _logBootConfig();
  console.log('');

  // Boot-time misconfiguration warning. TRUST_PROXY=1 plus HOST=0.0.0.0 used to
  // let any LAN client spoof CF-Connecting-IP and frame the audit log / bypass
  // the login lockout. clientIp now ignores the headers when the socket peer
  // isn't in the trusted-proxy allowlist (see _trustedProxyMatchers), so the
  // worst case is "spoof attempts get ignored" rather than "spoof attempts
  // succeed" — but the combination is still operator error worth surfacing.
  if (TRUST_PROXY && (HOST === '0.0.0.0' || HOST === '::')) {
    console.warn(`  ⚠️  TRUST_PROXY=1 with HOST=${HOST} — the panel is reachable directly from any LAN client.`);
    console.warn(`     Forwarded-IP headers will only be honoured from the Cloudflare ranges (or your`);
    console.warn(`     TRUST_PROXY_FROM override). Set HOST=127.0.0.1 in .env when behind Cloudflare`);
    console.warn(`     Tunnel / a local reverse proxy to remove direct LAN exposure entirely.\n`);
  }
  if (TRUST_PROXY) {
    // Surface what TRUST_PROXY=1 will actually trust at runtime. The defensive
    // fallback in clientIp() means an empty matcher set just makes the panel
    // ignore forward-IP headers — but the operator who set TRUST_PROXY=1
    // expected those headers to do something, so making the discrepancy noisy
    // is what flips this from "silent footgun" to "obvious misconfiguration".
    const cfg = _trustedProxyConfig;
    console.log(`  trust-proxy: ${cfg.matchers.length} trusted ${cfg.matchers.length === 1 ? 'range' : 'ranges'} (source: ${cfg.source === 'env' ? 'TRUST_PROXY_FROM' : 'Cloudflare defaults'})`);
    if (cfg.rejected.length > 0) {
      console.warn(`  ⚠️  TRUST_PROXY_FROM has ${cfg.rejected.length} unparseable ${cfg.rejected.length === 1 ? 'entry' : 'entries'}: ${cfg.rejected.join(', ')}`);
      console.warn(`     These are silently dropped — fix the CIDR shape (e.g. 192.168.0.0/24) or the`);
      console.warn(`     IPv6 prefix (e.g. 2606:4700::) and restart.\n`);
    }
    if (cfg.matchers.length === 0) {
      console.warn(`  ⚠️  TRUST_PROXY=1 but the trusted-proxy allowlist is EMPTY after parsing.`);
      console.warn(`     Every request will be read as coming directly from the socket peer —`);
      console.warn(`     CF-Connecting-IP / X-Forwarded-For / X-Forwarded-Host will be ignored.`);
      console.warn(`     Either unset TRUST_PROXY (if you have no proxy in front) or fix`);
      console.warn(`     TRUST_PROXY_FROM to list your proxy's source CIDRs.\n`);
    }
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✖  Port ${PORT} already in use — change PORT in .env\n`);
  } else {
    console.error('\n  ✖ ', err.message, '\n');
  }
  process.exit(1);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
function shutdown() {
  console.log('\n  Shutting down…');
  server.close(() => {
    cleanupOldChunks().finally(() => {
      // Intentionally NOT killing acChild — acServer is independent of the
      // dashboard's lifecycle (kicking everyone every time we redeploy the
      // panel was driving operators crazy). After a Node restart the new
      // process re-adopts the running acServer via findACPid(). If an
      // operator actually wants to stop AC they hit the panel's stop button.
      try { if (acChild && acChild.unref) acChild.unref(); } catch {}
      process.exit(0);
    });
  });
  // Force-exit after 10 s if in-flight requests don't finish
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

// Last-resort error handlers. Without these, any unhandled exception or
// rejection inside an async route handler crashes the panel — and on crash
// systemd restarts the process, but the in-flight request never sees a
// response (browser hangs until timeout) and the audit trail loses the
// triggering event. Log loudly so ops can find the root cause; let systemd
// restart us on a *fatal* error (uncaughtException with no recovery).
process.on('unhandledRejection', (reason) => {
  try { log.error('unhandled rejection:', reason && (reason.stack || reason.message || String(reason))); }
  catch { /* swallow — never let the handler itself crash */ }
});
process.on('uncaughtException', (err) => {
  try { log.error('uncaught exception:', err && (err.stack || err.message || String(err))); }
  catch {}
  // The process is in an undefined state after an uncaughtException. Don't
  // pretend we can keep serving — let systemd Restart=on-failure pick us up.
  setTimeout(() => process.exit(1), 100).unref();
});
