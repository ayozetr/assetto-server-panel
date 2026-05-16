require('dotenv').config();

const http          = require('http');
const https         = require('https');
const fs            = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const fsp           = fs.promises;
const path          = require('path');
const os            = require('os');
const crypto        = require('crypto');
const { spawn }     = require('child_process');

// ── Mod extraction libraries (loaded lazily to avoid startup errors if missing) ─
// Each format has an optional dependency. We log a clear banner at startup if a
// library is missing so ops can see "RAR support disabled" before users hit a 500.
let StreamZip, Unrar, sevenZ, sevenBin;
const _missingExtractors = [];
try { StreamZip = require('node-stream-zip'); } catch { _missingExtractors.push('zip (node-stream-zip)'); }
try { Unrar    = require('node-unrar-js');   } catch { _missingExtractors.push('rar (node-unrar-js)'); }
try { sevenZ   = require('node-7z');         } catch { _missingExtractors.push('7z (node-7z)'); }
try { sevenBin = require('7zip-bin');        } catch { _missingExtractors.push('7z binary (7zip-bin)'); }
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
function _logEmit(level, args) {
  const ctx    = _reqContext.getStore();
  const ts     = new Date().toISOString();
  const prefix = ctx?.reqId ? `${ts} ${level} [${ctx.reqId}]` : `${ts} ${level}`;
  const stream = (level === 'ERROR' || level === 'WARN') ? console.error : console.log;
  stream(prefix, ...args);
  // Mirror into logBuffer so the Dashboard activity card sees [UDP] events
  // and other panel-internal log lines, not just stdout from a spawned
  // acServer child (which is empty whenever acServer was adopted via pidof).
  try {
    if (typeof appendLog === 'function') {
      const body = args.map(a => typeof a === 'string' ? a : (a && a.stack) || String(a)).join(' ');
      appendLog(`${prefix} ${body}`);
    }
  } catch {}
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
const HOST         = process.env.HOST              || '0.0.0.0';
const PORT         = parseInt(process.env.PORT     || '3000', 10);
const AC_HTTP_PORT = parseInt(process.env.AC_HTTP_PORT || '8081', 10);
const AC_LOG_FILE  = process.env.AC_SERVER_LOG     || path.join(__dirname, 'logs', 'ac_server.log');
const AC_RESULTS   = process.env.AC_SERVER_RESULTS || path.join(os.homedir(), 'ac_server', 'results');
const AC_CFG_FILE  = path.join(process.env.AC_CFG_DIR || '/srv/assetto/cfg', 'server_cfg.ini');
const AC_CARS_DIR  = path.join(process.env.AC_CONTENT_DIR || '/srv/assetto/content', 'cars');
const AC_TRACKS_DIR= path.join(process.env.AC_CONTENT_DIR || '/srv/assetto/content', 'tracks');
const DB_PATH      = process.env.DB_PATH || path.join(__dirname, 'assetto.db');
const AC_BIN          = process.env.AC_SERVER_BIN || path.join(os.homedir(), 'ac_server', 'acServer');
const AC_BIN_DIR      = process.env.AC_SERVER_DIR || path.dirname(AC_BIN);
const AC_BLACKLIST    = process.env.AC_BLACKLIST_FILE || path.join(AC_BIN_DIR, 'blacklist.txt');
const ADMIN_TOKEN     = process.env.ADMIN_TOKEN || '';
const ROOT            = __dirname;
const KUNOS_ASSETS_DIR = path.join(__dirname, 'src/assets/kunos');

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
  'serverControl', 'sessionEdit', 'serverConfig', 'whitelistManage',
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
  // Schema migrations (safe to run on every start)
  try { db.exec(`ALTER TABLE panel_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE audit_log ADD COLUMN prev_hash     TEXT    NOT NULL DEFAULT ''`); } catch {}
  try { db.exec(`ALTER TABLE audit_log ADD COLUMN row_hash      TEXT    NOT NULL DEFAULT ''`); } catch {}
  try { db.exec(`ALTER TABLE audit_log ADD COLUMN chain_version INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE players   ADD COLUMN nickname      TEXT    NOT NULL DEFAULT ''`); } catch {}
  // Lap-dedup index for cross-source ingestion. The UDP plugin and the
  // result-file importer both write into `laps`; this unique index keys a
  // lap by content (driver+time+car+track) so neither source can create
  // a duplicate row regardless of the millisecond it captured the event.
  // The original UNIQUE(...) constraint on the table is wider so it stays
  // harmless; this index is the one we rely on at runtime.
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS laps_dedup_runtime ON laps(driver_guid, ms, car, track, track_config)`); } catch (e) { console.error('  laps_dedup_runtime migration:', e.message); }

  // Seed default settings
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('upload_max_mb', '500')`).run();
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('lang', 'en')`).run();
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('chunked_upload', '0')`).run();
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('discord_webhook', '')`).run();
  // Default permission set for the `user` role. Mirrors the live state right
  // before this granular-permissions feature shipped (server control, session
  // edit and mod upload were already open to users), so an upgrade in place
  // doesn't yank capabilities away from existing accounts.
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('role_permissions_user', ?)`)
    .run(JSON.stringify({
      serverControl:    true,
      sessionEdit:      true,
      modUpload:        true,
      serverConfig:     false,
      whitelistManage:  false,
      playerModeration: false,
      discordWebhook:   false,
      auditView:        false,
      dbBackup:         false,
    }));
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
        first_seen = CASE WHEN players.first_seen = '' OR excluded.first_seen < players.first_seen
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
function startResultsWatcher() {
  if (!db) return;
  try {
    fs.watch(AC_RESULTS, (eventType, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
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
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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

function respond(res, status, mime, body, extraHeaders) {
  res.writeHead(status, {
    'Content-Type':  mime,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    ...extraHeaders,
  });
  res.end(body);
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
    req.on('data', chunk => { raw += chunk; if (raw.length > 512_000) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
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

function isValidContentId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_\-\.]+$/.test(id) && !id.includes('..');
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

// Fire-and-forget POST to the Discord webhook. Times out after 5s so a Discord
// outage cannot stall the UDP handler. Errors are logged at warn level only —
// missing a notification is never worth crashing the server for.
function postDiscordMessage(content) {
  const url = getDiscordWebhook();
  if (!url) return;
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  const payload = JSON.stringify({ content });
  const req = https.request({
    method: 'POST',
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent':     'assetto-dashboard',
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
    if (m) { section = m[1]; result[section] = result[section] || {}; continue; }
    const eq = line.indexOf('=');
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
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
function sanitizeIniVal(v) {
  return String(v).replace(/[\r\n\0]/g, ' ');
}
// Strict text fields (NAME, WELCOME_MESSAGE) — strip control chars and INI metacharacters
// that could alter parsing (`[`, `]`, `;`, `#`, `=`).
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
        return `${k}=${sanitizeIniVal(obj[section][k])}`;
      }
    }
    return rawLine;
  });

  for (const [sec, keys] of Object.entries(obj)) {
    if (sec === '__default__') continue;
    for (const [k, v] of Object.entries(keys)) {
      if (updated.has(`${sec}|${k}`)) continue;
      const val = sanitizeIniVal(v);
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

let cachedPublicIp = null;
async function getPublicIp() {
  if (process.env.PUBLIC_IP) return process.env.PUBLIC_IP;
  if (cachedPublicIp) return cachedPublicIp;
  try {
    const res = await new Promise((resolve, reject) => {
      const req = require('https').get('https://api.ipify.org', r => {
        if (r.statusCode !== 200) { r.destroy(); return resolve(null); }
        let d = '';
        r.on('data', chunk => d += chunk);
        r.on('end', () => resolve(d.trim()));
      });
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    });
    if (res) cachedPublicIp = res;
    return res || getNetworkIP();
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

// ── Log parser ────────────────────────────────────────────────────────────────
// Heuristic log line parser. AC server output is unstructured English text, so
// classification is best-effort: word-boundary regex matches narrow the false
// positive rate, but if AC ever changes its strings or runs in another language
// the worst case is "info" tag/level — never a crash. The frontend filters by
// these levels so accuracy isn't load-bearing.
const _LVL_ERROR   = /\b(error|exception|fatal|fail(ed|ure)?)\b/i;
const _LVL_WARN    = /\b(warn(ing)?|deprecated|skipped|missing)\b/i;
const _LVL_OK      = /\b(connected|joined|lap completed|validated|best lap|ok|success)\b/i;
const _TAG_BRACKET = /\[([A-Z_0-9]{2,12})\]/;
const _TAG_HTTP    = /^(PAGE:|Serve |GET |POST |HEAD )/;
const _TAG_CFG     = /^(REQ|\{)/;
const _TIME        = /(\d{2}:\d{2}:\d{2})/;

function parseLine(raw, id) {
  const lvl = _LVL_ERROR.test(raw) ? 'error'
            : _LVL_WARN.test(raw)  ? 'warn'
            : _LVL_OK.test(raw)    ? 'ok'
            : 'info';
  const tm  = raw.match(_TAG_BRACKET);
  const tag = tm                          ? tm[1]
            : _TAG_HTTP.test(raw)         ? 'HTTP'
            : _TAG_CFG.test(raw.trim())   ? 'CFG'
            : 'SRV';
  const timeMatch = raw.match(_TIME);
  return { id, time: timeMatch ? timeMatch[1] : '', lvl, tag, msg: raw };
}

// ── API handlers ──────────────────────────────────────────────────────────────

async function apiMetrics(res) {
  try {
    const [cpu, ram, acInfo, publicIp] = await Promise.all([getCPU(), Promise.resolve(getRAM()), getACInfo(), getPublicIp()]);
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
      cpu, ram,
      running:   acInfo.running,
      liveTrack: acInfo.liveTrack,
      uptime:    getACUptime(),
      cpuName:   getCPUName(),
      osInfo:    getOSInfo(),
      publicIp,
      httpPort:  AC_HTTP_PORT,
      players,
    });
  } catch (e) { json(res, 500, { error: e.message }); }
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
    for (const r of [...sseClients]) {
      try { r.write(`event: clear\ndata: {}\n\n`); } catch { sseClients.delete(r); }
    }
    insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'logs.clear');
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
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

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);
  req.on('close', () => {
    sseClients.delete(res);
    const set = _sseByUser.get(user);
    if (set) {
      set.delete(res);
      if (set.size === 0) _sseByUser.delete(user);
    }
    clearInterval(heartbeat);
  });
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
    }
    json(res, 200, { ok: true, restarted, restartError, applied, rejected });
  } catch (e) { json(res, 500, { error: e.message }); }
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
  } catch (e) { json(res, 500, { error: e.message }); }
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
  } catch (e) { json(res, 500, { error: e.message }); }
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
  } catch (e) { json(res, 500, { error: e.message }); }
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
  } catch (e) { json(res, 500, { error: e.message }); }
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
  } catch (e) { json(res, 500, { error: e.message }); }
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
  } catch (e) { json(res, 500, { error: e.message }); }
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
  } catch (e) { json(res, 500, { error: e.message }); }
}

async function apiPlayerBan(req, res) {
  if (!checkPermission(req, 'playerModeration')) return json(res, 403, { error: 'Forbidden' });
  try {
    const body = await readBody(req);
    const guid = body.guid;
    if (!guid) return json(res, 400, { error: 'guid required' });
    let existing = '';
    try { existing = fs.readFileSync(AC_BLACKLIST, 'utf8'); } catch {}
    const guids = existing.split('\n').map(s => s.trim()).filter(Boolean);
    if (!guids.includes(guid)) fs.appendFileSync(AC_BLACKLIST, guid + '\n');
    const actor = checkAnyAuth(req)?.username || 'unknown';
    insertAuditLog(actor, 'player.ban', guid, body.name || '');
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
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
  } catch (e) { json(res, 500, { error: e.message }); }
}

// ── Whitelist ─────────────────────────────────────────────────────────────────
// path.resolve canonicalises the path so the whitelist write/read can never escape
// to an unintended location via env var injection (e.g. AC_WHITELIST_FILE=/etc/passwd).
const AC_WHITELIST = path.resolve(
  process.env.AC_WHITELIST_FILE
  || path.join(process.env.AC_CFG_DIR || '/srv/assetto/cfg', 'whitelist.txt')
);

function apiWhitelistGet(res) {
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
    await fsp.writeFile(AC_WHITELIST, clean.join('\n') + (clean.length ? '\n' : ''), 'utf8');
    json(res, 200, { ok: true, saved: clean.length });
  } catch (e) { json(res, 500, { error: e.message }); }
}

// Add a single GUID to the whitelist file. Used by the per-player button on the
// Players page so the caller doesn't have to read-modify-write the whole list.
async function apiWhitelistAdd(req, res) {
  if (!checkPermission(req, 'whitelistManage')) return json(res, 403, { error: 'Forbidden' });
  try {
    const body = await readBody(req);
    const guid = String(body.guid || '').trim();
    if (!/^\d{17}$/.test(guid)) return json(res, 400, { error: 'guid must be 17 digits' });
    let raw = '';
    try { raw = await fsp.readFile(AC_WHITELIST, 'utf8'); } catch {}
    const ids = raw.split('\n').map(s => s.trim()).filter(Boolean);
    if (ids.includes(guid)) {
      return json(res, 200, { ok: true, alreadyPresent: true, total: ids.length });
    }
    ids.push(guid);
    await fsp.writeFile(AC_WHITELIST, ids.join('\n') + '\n', 'utf8');
    const actor = checkAnyAuth(req)?.username || 'unknown';
    insertAuditLog(actor, 'whitelist.add', guid, body.name || '');
    json(res, 200, { ok: true, total: ids.length });
  } catch (e) { json(res, 500, { error: e.message }); }
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

    // Auto-restart if server is running and the caller asks for it
    let restarted = false, restartError = null;
    const wantRestart = body.restart !== false; // default ON
    if (wantRestart) {
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
    }
    const actor = checkAnyAuth(req)?.username || 'unknown';
    const detail = [body.trackId, body.layout, ...(body.cars || [])].filter(Boolean).join(', ');
    insertAuditLog(actor, 'session.apply', body.trackId || '', detail);
    json(res, 200, { ok: true, restarted, restartError });
  } catch (e) { json(res, 500, { error: e.message }); }
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
  sock.bind(listenPort, listenHost, () => {
    udpState.socket = sock;
    udpState.startedAt = Date.now();
    log.info(`[UDP] listening on ${listenHost}:${listenPort}, commands → 127.0.0.1:${sendCommandsToPort}`);
    // Pull a snapshot in case acServer was already running when we booted.
    udpSendCommand(ACSP.GET_SESSION_INFO, Buffer.from([0xFF, 0xFF]));
    // Repopulate the cars map for every slot — important after a dashboard
    // restart while drivers are still connected (acServer does not re-emit
    // NEW_CONNECTION for them, so without this burst their next LAP_COMPLETED
    // would arrive for an unknown car_id and get dropped). 64 covers every
    // possible MAX_CLIENTS value; empty slots return CAR_INFO with
    // isConnected=0 and are ignored by the parser.
    for (let i = 0; i < 64; i++) udpSendCommand(ACSP.GET_CAR_INFO, Buffer.from([i]));
  });
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

    case ACSP.CHAT:
    case ACSP.CLIENT_LOADED:
    case ACSP.CLIENT_EVENT:
    case ACSP.END_SESSION:
    case ACSP.ERROR:
    case ACSP.CAR_UPDATE:
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
    let logStream = null;
    try {
      fs.mkdirSync(path.dirname(AC_LOG_FILE), { recursive: true });
      logStream = fs.createWriteStream(AC_LOG_FILE, { flags: 'a' });
    } catch {}
    const closeLog = () => { if (logStream) { try { logStream.end(); } catch {} logStream = null; } };
    try {
      const child = spawn(AC_BIN, [], { cwd: AC_BIN_DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
      let lineBuf = '';
      // Force-flush very long lines so misbehaving stdout (no newlines for kilobytes)
      // doesn't grow the buffer unbounded.
      const LINE_BUF_MAX = 8 * 1024;
      const onChunk = chunk => {
        if (logStream) logStream.write(chunk);
        lineBuf += chunk.toString();
        const parts = lineBuf.split('\n');
        lineBuf = parts.pop();
        parts.forEach(appendLog);
        if (lineBuf.length > LINE_BUF_MAX) {
          appendLog(lineBuf.slice(0, LINE_BUF_MAX) + ' …(truncated)');
          lineBuf = '';
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      let settled = false;
      child.once('error', e => {
        if (settled) return;
        settled = true;
        log.error('[AC] spawn error:', e.message);
        if (lineBuf) { appendLog(lineBuf); lineBuf = ''; }
        closeLog();
        acChild = null;
        resolve({ ok: false, error: e.message });
      });
      child.once('exit', (code, signal) => {
        if (acChild === child) acChild = null;
        if (lineBuf) { appendLog(lineBuf); lineBuf = ''; }
        closeLog();
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: `Proceso terminó al arrancar (code=${code} signal=${signal})` });
        }
      });
      acChild = child;
      // Give it a moment to confirm it didn't crash immediately
      setTimeout(() => {
        if (settled) return;
        settled = true;
        if (acChild && !acChild.killed) resolve({ ok: true });
        else resolve({ ok: false, error: 'Proceso no continuó tras arrancar' });
      }, 500);
    } catch (e) {
      log.error('[AC] spawn exception:', e.message);
      closeLog();
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

// Serializes server.start / .stop / .restart so rapid clicks cannot spawn
// duplicate processes or null-set acChild while a spawn is mid-flight.
let _serverActionInFlight = false;
async function withServerActionLock(req, res, fn) {
  if (_serverActionInFlight) return json(res, 409, { error: 'Another server action is in progress' });
  _serverActionInFlight = true;
  try { return await fn(); }
  finally { _serverActionInFlight = false; }
}

async function apiServerStart(req, res) {
  if (!checkPermission(req, 'serverControl')) return json(res, 403, { error: 'Forbidden' });
  if (!checkRateLimit('server-ctl', clientIp(req), 20, 60 * 1000))
    return json(res, 429, { error: 'Rate limit: too many server actions' });
  return withServerActionLock(req, res, async () => {
    if (acChild && !acChild.killed) return json(res, 409, { error: 'Server is already running' });
    if (await findACPid())          return json(res, 409, { error: 'Server is already running' });
    const { running } = await getACInfo();
    if (running) return json(res, 409, { error: 'Server is already running' });

    const r = await spawnAC();
    if (!r.ok) return json(res, 500, { error: r.error || 'Failed to start server' });
    const up = await waitForACUp(8000);
    if (!up) {
      return json(res, 500, { error: 'acServer started but its HTTP port did not respond within 8s — check ports and logs' });
    }
    insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'server.start');
    json(res, 200, { ok: true });
  });
}

async function apiServerStop(req, res) {
  if (!checkPermission(req, 'serverControl')) return json(res, 403, { error: 'Forbidden' });
  if (!checkRateLimit('server-ctl', clientIp(req), 20, 60 * 1000))
    return json(res, 429, { error: 'Rate limit: too many server actions' });
  return withServerActionLock(req, res, async () => {
    const r = await killAC();
    if (!r.ok) return json(res, 500, { error: r.error || 'Failed to stop server' });
    await waitForACDown(6000);
    insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'server.stop');
    json(res, 200, { ok: true });
  });
}

async function apiServerRestart(req, res) {
  if (!checkPermission(req, 'serverControl')) return json(res, 403, { error: 'Forbidden' });
  if (!checkRateLimit('server-ctl', clientIp(req), 20, 60 * 1000))
    return json(res, 429, { error: 'Rate limit: too many server actions' });
  return withServerActionLock(req, res, async () => {
    const k = await killAC();
    if (!k.ok) return json(res, 500, { error: k.error || 'Failed to stop server' });
    await waitForACDown(6000);
    await sleep(500);
    const s = await spawnAC();
    if (!s.ok) return json(res, 500, { error: s.error || 'Failed to start server' });
    const up = await waitForACUp(10000);
    if (!up) {
      return json(res, 500, { error: 'acServer restarted but its HTTP port did not respond within 10s — check ports and logs' });
    }
    insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'server.restart');
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

const _trustedProxyMatchers = (() => {
  const raw = process.env.TRUST_PROXY_FROM || DEFAULT_PROXY_CIDRS.join(',');
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(_parseProxyEntry).filter(Boolean);
})();

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
    if (!user) return json(res, 401, { error: 'Invalid username or password' });

    if (!verifyPassword(password, user.salt, user.password_hash))
      return json(res, 401, { error: 'Invalid username or password' });

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
    json(res, 200, { ok: true, user: { name: username, role: user.role, mustChangePassword: user.must_change_password === 1, permissions } });
  } catch (e) { json(res, 500, { error: e.message }); }
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
  if (db) {
    try {
      const row = db.prepare('SELECT must_change_password FROM panel_users WHERE username = ?').get(sess.username);
      mustChange = row?.must_change_password === 1;
    } catch {}
  }
  const permissions = sess.role === 'admin'
    ? Object.fromEntries(ROLE_PERMISSIONS.map(p => [p, true]))
    : getUserRolePermissions();
  json(res, 200, { username: sess.username, role: sess.role, mustChangePassword: mustChange, permissions });
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

    _clearLoginAttempt(ip);
    insertAuditLog(username, 'user.update', username, 'self password change');
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
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
  } catch (e) { json(res, 500, { error: e.message }); }
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
  } catch (e) { json(res, 500, { error: e.message }); }
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
  if (!db) return json(res, 200, { uploadMaxMb: 500, chunkedUpload: false, lang: 'en', discordWebhook: '' });
  const mbRow       = db.prepare(`SELECT value FROM panel_settings WHERE key = 'upload_max_mb'`).get();
  const langRow     = db.prepare(`SELECT value FROM panel_settings WHERE key = 'lang'`).get();
  const chunkedRow  = db.prepare(`SELECT value FROM panel_settings WHERE key = 'chunked_upload'`).get();
  const webhookRow  = db.prepare(`SELECT value FROM panel_settings WHERE key = 'discord_webhook'`).get();
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
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
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
  } catch (e) { json(res, 500, { error: e.message }); }
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

    await new Promise((resolve) => {
      const r = https.request({
        method: 'POST',
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent':     'assetto-dashboard',
        },
        timeout: 5000,
      }, (resp) => {
        let buf = '';
        resp.on('data', (c) => { buf += c.toString().slice(0, 512); });
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
  db.prepare('DELETE FROM mod_history').run();
  json(res, 200, { ok: true });
}

// Decompression bomb caps: refuse archives that look pathological before we touch disk
const MAX_ARCHIVE_ENTRIES   = 50_000;                 // total entries
const MAX_ARCHIVE_TOTAL_B   = 5 * 1024 * 1024 * 1024; // 5 GB extracted total
const MAX_ARCHIVE_ENTRY_B   = 2 * 1024 * 1024 * 1024; // 2 GB single file

async function processModBuffer(buffer, filename) {
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
const _chunkAssembling = new Set(); // per-uploadId lock to prevent double-assembly
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

  try {
    await fsp.mkdir(uploadDir, { recursive: true });
    await fsp.writeFile(path.join(uploadDir, `chunk-${chunkIndex}`), chunkData);

    const received = (await fsp.readdir(uploadDir)).filter(f => f.startsWith('chunk-')).length;
    if (received < totalChunks)
      return json(res, 200, { ok: true, done: false, received, total: totalChunks });

    // Lock: only the first request that reaches full-chunk-count assembles the file.
    // The lock must cover the entire processModBuffer call — if released earlier, two
    // concurrent final-chunk requests can both pass the check and double-extract.
    if (_chunkAssembling.has(uploadId))
      return json(res, 409, { error: 'Assembly already in progress for this upload' });
    _chunkAssembling.add(uploadId);

    // Assemble chunks into a single temp file on disk — never `Buffer.concat` the
    // whole upload, which would peak at 2× the file size in RAM. Read each chunk,
    // append it to the output stream, free the buffer. Peak RAM stays at one
    // chunk (≈5 MB).
    const assembledPath = path.join(os.tmpdir(), `ac-assembled-${uploadId}.bin`);
    try {
      const out = fs.createWriteStream(assembledPath);
      let totalBytes = 0;
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(uploadDir, `chunk-${i}`);
        const buf = await fsp.readFile(chunkPath);
        totalBytes += buf.length;
        if (totalBytes > UPLOAD_HARD_CAP_BYTES) {
          out.destroy();
          throw Object.assign(new Error(`Upload exceeds hard cap of ${UPLOAD_HARD_CAP_BYTES} bytes`), { status: 413 });
        }
        await new Promise((resolve, reject) => {
          out.write(buf, e => e ? reject(e) : resolve());
        });
        await fsp.unlink(chunkPath).catch(() => {});
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
      json(res, 200, { ok: true, done: true, ...result });
    } finally {
      await fsp.unlink(assembledPath).catch(() => {});
      _chunkAssembling.delete(uploadId);
    }
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
  if (!raw) return false; // cookie present + no Origin/Referer → refuse
  try {
    const u = new URL(raw);
    return u.host.toLowerCase() === host;
  } catch { return false; }
}

// ── Router ────────────────────────────────────────────────────────────────────
function handler(req, res) {
  setSecurityHeaders(req, res);
  const urlPath = req.url.split('?')[0];

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

    // Auth
    if (urlPath === '/api/auth/me'              && req.method === 'GET')  return apiAuthMe(req, res);
    if (urlPath === '/api/auth/login'           && req.method === 'POST') return apiAuthLogin(req, res);
    if (urlPath === '/api/auth/logout'          && req.method === 'POST') return apiAuthLogout(req, res);
    if (urlPath === '/api/auth/change-password' && req.method === 'POST') return apiAuthChangePassword(req, res);

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
    if (urlPath === '/api/admin/backup'      && req.method === 'GET')    return apiAdminBackup(req, res);
    if (urlPath === '/api/admin/stats'       && req.method === 'GET')    return apiAdminStats(req, res);
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
    const playerNickMatch = urlPath.match(/^\/api\/players\/(\d{17})\/nickname$/);
    if (playerNickMatch && req.method === 'PUT') return apiPlayerNickname(req, res, playerNickMatch[1]);

    // Whitelist
    if (urlPath === '/api/whitelist'     && req.method === 'GET')  return apiWhitelistGet(res);
    if (urlPath === '/api/whitelist'     && req.method === 'PUT')  return apiWhitelistPut(req, res);
    if (urlPath === '/api/whitelist/add' && req.method === 'POST') return apiWhitelistAdd(req, res);

    // Session apply
    if (urlPath === '/api/session/apply'  && req.method === 'POST') return apiSessionApply(req, res);

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

    // Data endpoints
    if (urlPath === '/api/metrics'         && req.method === 'GET') return apiMetrics(res);
    if (urlPath === '/api/logs'            && req.method === 'GET') return apiLogs(req, res);
    if (urlPath === '/api/logs/clear'      && req.method === 'POST') return apiLogsClear(req, res);
    if (urlPath === '/api/logs/stream'     && req.method === 'GET') return apiLogsStream(req, res);
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
      data = Buffer.from(
        data.toString('utf8').replace(
          /(src="(?:[^"]*\/)?dist\/[^"]+\.js)"/g,
          `$1?v=${BUILD_VERSION}"`
        ),
        'utf8'
      );
    }
    respond(res, 200, mime, data, { 'Cache-Control': cache });
  });
}

// Build identity used to invalidate bundle URLs after every redeploy. mtime of
// dist/app.js is stable across restarts of the same build (a `node build.js`
// touches everything, so a fresh deploy refreshes BUILD_VERSION automatically)
// and rolls forward on each restart of an updated tree.
const BUILD_VERSION = (() => {
  try {
    const st = fs.statSync(path.join(ROOT, 'dist', 'app.js'));
    return String(Math.floor(st.mtimeMs));
  } catch {
    return String(Date.now());
  }
})();

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
  audit:  { lastRunAt: null, lastRemoved: 0 },
  login:  { lastRunAt: null, lastRemoved: 0 },
  chunks: { lastRunAt: null, lastRemoved: 0 },
};

// Audit log retention: keep entries for AUDIT_RETENTION_DAYS (env, default 365),
// sweep daily. Without this the table grows unbounded forever.
const AUDIT_RETENTION_DAYS = Math.max(1, parseInt(process.env.AUDIT_RETENTION_DAYS, 10) || 365);
function sweepAuditLog() {
  if (!db) return;
  try {
    const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
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
  console.log(`    Assetto Server Panel`);
  console.log(`  ${line}`);
  console.log(`    Local    →  http://localhost:${PORT}`);
  console.log(`    Network  →  http://${ip}:${PORT}`);
  console.log(`  ${line}\n`);
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
