require('dotenv').config();

const http          = require('http');
const fs            = require('fs');
const fsp           = fs.promises;
const path          = require('path');
const os            = require('os');
const crypto        = require('crypto');
const { spawn }     = require('child_process');

// ── Mod extraction libraries (loaded lazily to avoid startup errors if missing) ─
let StreamZip, Unrar, sevenZ, sevenBin;
try { StreamZip = require('node-stream-zip'); } catch {}
try { Unrar    = require('node-unrar-js');   } catch {}
try { sevenZ   = require('node-7z');         } catch {}
try { sevenBin = require('7zip-bin');        } catch {}

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
  for (const res of sseClients) {
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

function getSession(req) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith('sid='));
  if (!match) return null;
  const token = match.slice(4);
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

function sessionCookieHeader(token) {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`;
}

function checkAdminAuth(req) {
  const sess = getSession(req);
  if (sess?.role === 'admin' && !userMustChangePassword(sess.username)) return true;
  if (!ADMIN_TOKEN) return false;
  const h = req.headers['x-admin-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
  return h === ADMIN_TOKEN;
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
  `);
  // Schema migrations (safe to run on every start)
  try { db.exec(`ALTER TABLE panel_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`); } catch {}

  // Seed default settings
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('upload_max_mb', '500')`).run();
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('lang', 'en')`).run();
  db.prepare(`INSERT OR IGNORE INTO panel_settings (key, value) VALUES ('chunked_upload', '0')`).run();
  console.log('  Database ready:', DB_PATH);
} catch (e) {
  console.error('  Database init failed:', e.message);
}

// ── Auth helpers ─────────────────────────────────────────────────────────────
// Stored hash format: "scrypt$<hex>" (current) or bare hex (legacy pbkdf2).
// Legacy hashes are upgraded in-place on the next successful login.
function hashPasswordScrypt(password, salt) {
  return 'scrypt$' + crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
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
      const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
      return safeHexEqual(candidate, expected);
    }
    // Legacy pbkdf2 (bare hex)
    const candidate = hashPasswordPbkdf2(password, salt);
    return safeHexEqual(candidate, stored);
  } catch { return false; }
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

        const r = stmtLap.run({
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
        });

        if (r.changes > 0) {
          if (!lapsByPlayer[l.DriverGuid]) lapsByPlayer[l.DriverGuid] = { cnt: 0, name: l.DriverName, car: l.CarModel || '' };
          lapsByPlayer[l.DriverGuid].cnt++;
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

function setSecurityHeaders(res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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
function parseLooseJson(raw) {
  return JSON.parse(raw.replace(/[\x00-\x1f]/g, ' '));
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
    const read = () => {
      const v = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
      return { idle: v[3] + (v[4] || 0), total: v.reduce((a, b) => a + b, 0) };
    };
    const s1 = read();
    setTimeout(() => {
      const s2 = read();
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
let _acRunSince = null;

// Fetches /INFO from the AC HTTP API and returns { running, liveTrack }.
// Also maintains _acRunSince for uptime tracking.
function getACInfo() {
  return new Promise(resolve => {
    let body = '';
    const req = http.get(
      { hostname: '127.0.0.1', port: AC_HTTP_PORT, path: '/INFO', timeout: 1500 },
      res => {
        if (res.statusCode !== 200) {
          res.destroy();
          _acRunSince = null;
          return resolve({ running: false, liveTrack: null });
        }
        res.on('data', d => { body += d; });
        res.on('end', () => {
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
    req.on('error', () => { _acRunSince = null; resolve({ running: false, liveTrack: null }); });
    req.setTimeout(1500, () => { req.destroy(); _acRunSince = null; resolve({ running: false, liveTrack: null }); });
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
function parseLine(raw, id) {
  const l = raw.toLowerCase();
  const lvl = /\berror\b/.test(l)                                           ? 'error'
            : /\bwarn/.test(l)                                              ? 'warn'
            : /lap completed|validated|best lap|steam.*ok|connection.*ok/.test(l) ? 'ok'
            : /connected|new connection|driver.*joined/.test(l)            ? 'ok'
            : 'info';
  const tm  = raw.match(/\[([A-Z_0-9]{2,12})\]/);
  const tag = tm                              ? tm[1]
            : /^PAGE:|^Serve /.test(raw)      ? 'HTTP'
            : /^REQ/.test(raw)               ? 'CFG'
            : /^{/.test(raw.trim())          ? 'CFG'
            : 'SRV';
  const timeMatch = raw.match(/(\d{2}:\d{2}:\d{2})/);
  const time = timeMatch ? timeMatch[1] : '';
  return { id, time, lvl, tag, msg: raw };
}

// ── API handlers ──────────────────────────────────────────────────────────────

async function apiMetrics(res) {
  try {
    const [cpu, ram, acInfo, publicIp] = await Promise.all([getCPU(), Promise.resolve(getRAM()), getACInfo(), getPublicIp()]);
    json(res, 200, {
      cpu, ram,
      running:   acInfo.running,
      liveTrack: acInfo.liveTrack,
      uptime:    getACUptime(),
      cpuName:   getCPUName(),
      osInfo:    getOSInfo(),
      publicIp,
      httpPort:  AC_HTTP_PORT,
    });
  } catch (e) { json(res, 500, { error: e.message }); }
}

function apiLogs(req, res) {
  const n = Math.min(500, parseInt(new URL(req.url, 'http://x').searchParams.get('n') || '150'));
  json(res, 200, { lines: logBuffer.slice(-n) });
}

function apiLogsStream(req, res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: init\ndata: ${JSON.stringify(logBuffer)}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);
  req.on('close', () => { sseClients.delete(res); clearInterval(heartbeat); });
}

function apiConfig(req, res) {
  const sess  = getSession(req);
  const isAdmin = sess?.role === 'admin';
  fs.readFile(AC_CFG_FILE, 'utf8', (err, data) => {
    if (err) return json(res, 404, { error: 'server_cfg.ini not found' });
    const ini = parseINI(data);
    const s   = ini['SERVER'] || {};
    json(res, 200, {
      name:        s['NAME']                    || '',
      welcome:     s['WELCOME_MESSAGE']          || '',
      password:    isAdmin ? (s['PASSWORD']         || '') : '',
      adminPass:   isAdmin ? (s['ADMIN_PASSWORD']   || '') : '',
      tcp:         parseInt(s['TCP_PORT'])       || 9600,
      udp:         parseInt(s['UDP_PORT'])       || 9600,
      http:        parseInt(s['HTTP_PORT'])      || 8081,
      tickrate:    parseInt(s['CLIENT_SEND_INTERVAL_HZ']) || 18,
      maxClients:  parseInt(s['MAX_CLIENTS'])    || 0,
      publicLobby: s['REGISTER_TO_LOBBY'] === '1',
      whitelist:   s['WELCOME_WHITELIST_ENABLED'] === '1',
      fuelRate:    parseInt(s['FUEL_RATE'])      || 100,
      damage:      parseInt(s['DAMAGE_MULTIPLIER']) || 100,
      tyreWear:    parseInt(s['TYRE_WEAR_RATE']) || 100,
      abs:         parseInt(s['ABS_ALLOWED'])    || 0,
      tc:          parseInt(s['TC_ALLOWED'])     || 0,
      autoclutch:  s['AUTOCLUTCH_ALLOWED'] === '1',
      stability:   s['STABILITY_ALLOWED']  === '1',
      track:       s['TRACK']              || '',
      trackConfig: s['CONFIG_TRACK']       || '',
      cars:        (s['CARS'] || '').split(';').filter(Boolean),
    });
  });
}

function validPort(v) { const n = parseInt(v); return n >= 1 && n <= 65535 ? n : null; }
function clampInt(v, lo, hi) { const n = parseInt(v); return isNaN(n) ? null : Math.max(lo, Math.min(hi, n)); }

async function apiConfigUpdate(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    const body = await readBody(req);
    const raw  = await fsp.readFile(AC_CFG_FILE, 'utf8');
    const ini  = parseINI(raw);
    const s    = ini['SERVER'] = ini['SERVER'] || {};

    if (body.name        !== undefined) s['NAME']                    = String(body.name).slice(0, 255);
    if (body.welcome     !== undefined) s['WELCOME_MESSAGE']         = String(body.welcome).slice(0, 255);
    if (body.password    !== undefined) s['PASSWORD']                = String(body.password).slice(0, 255);
    if (body.adminPass   !== undefined) s['ADMIN_PASSWORD']          = String(body.adminPass).slice(0, 255);
    if (body.tcp         !== undefined) { const p = validPort(body.tcp);         if (p) s['TCP_PORT']                = String(p); }
    if (body.udp         !== undefined) { const p = validPort(body.udp);         if (p) s['UDP_PORT']                = String(p); }
    if (body.http        !== undefined) { const p = validPort(body.http);        if (p) s['HTTP_PORT']               = String(p); }
    if (body.tickrate    !== undefined) { const v = clampInt(body.tickrate,1,300); if (v) s['CLIENT_SEND_INTERVAL_HZ'] = String(v); }
    if (body.maxClients  !== undefined) { const v = clampInt(body.maxClients,1,200); if (v) s['MAX_CLIENTS']          = String(v); }
    if (body.publicLobby !== undefined) s['REGISTER_TO_LOBBY']      = body.publicLobby ? '1' : '0';
    if (body.fuelRate    !== undefined) { const v = clampInt(body.fuelRate,0,200);  if (v !== null) s['FUEL_RATE']     = String(v); }
    if (body.damage      !== undefined) { const v = clampInt(body.damage,0,200);    if (v !== null) s['DAMAGE_MULTIPLIER'] = String(v); }
    if (body.tyreWear    !== undefined) { const v = clampInt(body.tyreWear,0,200);  if (v !== null) s['TYRE_WEAR_RATE'] = String(v); }
    if (body.abs         !== undefined) { const v = clampInt(body.abs,0,2);         if (v !== null) s['ABS_ALLOWED']    = String(v); }
    if (body.tc          !== undefined) { const v = clampInt(body.tc,0,2);          if (v !== null) s['TC_ALLOWED']     = String(v); }
    if (body.autoclutch  !== undefined) s['AUTOCLUTCH_ALLOWED']      = body.autoclutch ? '1' : '0';
    if (body.stability   !== undefined) s['STABILITY_ALLOWED']       = body.stability  ? '1' : '0';
    if (body.whitelist   !== undefined) s['WELCOME_WHITELIST_ENABLED']= body.whitelist  ? '1' : '0';

    await fsp.copyFile(AC_CFG_FILE, AC_CFG_FILE + '.bak');
    await fsp.writeFile(AC_CFG_FILE, patchINI(raw, ini), 'utf8');
    insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'config.save', 'server_cfg.ini');

    // Optional auto-restart if requested
    let restarted = false, restartError = null;
    if (body.restart === true) {
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
    json(res, 200, { ok: true, restarted, restartError });
  } catch (e) { json(res, 500, { error: e.message }); }
}

function apiPlayers(res) {
  const req = http.get(
    { hostname: '127.0.0.1', port: AC_HTTP_PORT, path: '/api/details', timeout: 2000 },
    r => {
      let data = '';
      r.on('data', d => data += d);
      r.on('end', () => {
        try {
          const raw = JSON.parse(data);
          const players = (raw.cars || [])
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
            }));
          json(res, 200, players);
        } catch { json(res, 200, []); }
      });
    }
  );
  req.on('error', () => json(res, 200, []));
  req.setTimeout(2000, () => { req.destroy(); json(res, 200, []); });
}

function apiResults(req, res) {
  if (!db) return json(res, 200, []);
  try {
    const qs    = new URLSearchParams(req.url.split('?')[1] || '');
    const limit = Math.min(Math.max(parseInt(qs.get('limit')) || 500, 1), 5000);
    const rows = db.prepare(`
      SELECT id, driver_name, driver_guid, car, track, track_config, ms, s1, s2, s3, cuts, valid, session_date
      FROM laps
      ORDER BY ms ASC
      LIMIT ?
    `).all(limit);

    const laps = rows.map(r => ({
      id:     r.id,
      player: r.driver_name,
      car:    r.car,
      track:  r.track,
      layout: r.track_config,
      ms:     r.ms,
      s1:     r.s1,
      s2:     r.s2,
      s3:     r.s3,
      cuts:   r.cuts,
      valid:  r.valid === 1,
      date:   r.session_date,
    }));
    json(res, 200, laps);
  } catch (e) { json(res, 500, { error: e.message }); }
}

function apiPlayersHistory(res) {
  if (!db) return json(res, 200, []);
  try {
    const rows = db.prepare(`
      SELECT
        p.guid,
        p.name,
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

async function apiCars(res) {
  try {
    const dirs = await fsp.readdir(AC_CARS_DIR);
    const cars = await Promise.all(
      dirs.map(async id => {
        const acUiDir  = path.join(AC_CARS_DIR, id, 'ui');
        const knUiDir  = path.join(KUNOS_ASSETS_DIR, 'cars', id, 'ui');
        const knSkinDir = path.join(KUNOS_ASSETS_DIR, 'cars', id, 'skins');

        // ui_car.json: AC content first, kunos assets as fallback
        let ui = {};
        try { ui = parseLooseJson(await fsp.readFile(path.join(acUiDir, 'ui_car.json'), 'utf8')); } catch {
          try { ui = parseLooseJson(await fsp.readFile(path.join(knUiDir, 'ui_car.json'), 'utf8')); } catch {}
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
    json(res, 200, cars.sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e) { json(res, 500, { error: e.message }); }
}

async function apiTracks(res) {
  try {
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
    json(res, 200, tracks.sort((a, b) => a.name.localeCompare(b.name)));
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
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    const body  = await readBody(req);
    const carId = body.carId;
    if (carId === undefined) return json(res, 400, { error: 'carId required' });
    await new Promise(resolve => {
      const r = http.request(
        { hostname: '127.0.0.1', port: AC_HTTP_PORT, path: '/api/kick', method: 'POST',
          headers: { 'Content-Type': 'application/json' }, timeout: 2000 },
        resp => { resp.resume(); resolve(); }
      );
      r.on('error', resolve);
      r.setTimeout(2000, () => { r.destroy(); resolve(); });
      r.write(JSON.stringify({ car_id: carId }));
      r.end();
    });
    const actor = checkAnyAuth(req)?.username || 'unknown';
    insertAuditLog(actor, 'player.kick', String(carId));
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
}

async function apiPlayerBan(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
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

// ── Whitelist ─────────────────────────────────────────────────────────────────
const AC_WHITELIST = process.env.AC_WHITELIST_FILE
  || path.join(process.env.AC_CFG_DIR || '/srv/assetto/cfg', 'whitelist.txt');

function apiWhitelistGet(res) {
  let raw = '';
  try { raw = fs.readFileSync(AC_WHITELIST, 'utf8'); } catch {}
  const ids = raw.split('\n').map(s => s.trim()).filter(Boolean);
  json(res, 200, { ids });
}

async function apiWhitelistPut(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    const body = await readBody(req);
    if (!Array.isArray(body.ids)) return json(res, 400, { error: 'ids array required' });
    const clean = body.ids.map(s => String(s).trim()).filter(s => /^\d{17}$/.test(s));
    await fsp.writeFile(AC_WHITELIST, clean.join('\n') + (clean.length ? '\n' : ''), 'utf8');
    json(res, 200, { ok: true, saved: clean.length });
  } catch (e) { json(res, 500, { error: e.message }); }
}

// ── Session apply ─────────────────────────────────────────────────────────────
async function apiSessionApply(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
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
    if (Array.isArray(body.cars)) {
      const clean = body.cars.filter(isValidContentId);
      if (body.cars.length && !clean.length)
        return json(res, 400, { error: 'cars contains invalid identifiers' });
      if (clean.length) s['CARS'] = [...new Set(clean)].join(';');
    }
    if (body.slots !== undefined) {
      const v = clampInt(body.slots, 1, 200);
      if (v) s['MAX_CLIENTS'] = String(v);
    }

    await fsp.copyFile(AC_CFG_FILE, AC_CFG_FILE + '.bak');
    await fsp.writeFile(AC_CFG_FILE, patchINI(raw, ini), 'utf8');

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
    if (err) { console.error('[AC] spawn error:', err); _acRunSince = null; return resolve({ ok: false, error: err }); }
    let logStream = null;
    try {
      fs.mkdirSync(path.dirname(AC_LOG_FILE), { recursive: true });
      logStream = fs.createWriteStream(AC_LOG_FILE, { flags: 'a' });
    } catch {}
    const closeLog = () => { if (logStream) { try { logStream.end(); } catch {} logStream = null; } };
    try {
      const child = spawn(AC_BIN, [], { cwd: AC_BIN_DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
      let lineBuf = '';
      const onChunk = chunk => {
        if (logStream) logStream.write(chunk);
        lineBuf += chunk.toString();
        const parts = lineBuf.split('\n');
        lineBuf = parts.pop();
        parts.forEach(appendLog);
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      let settled = false;
      child.once('error', e => {
        if (settled) return;
        settled = true;
        console.error('[AC] spawn error:', e.message);
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
      console.error('[AC] spawn exception:', e.message);
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
      _acRunSince = null;
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
  _acRunSince = null;
  if (stillUp) return { ok: false, error: 'Failed to terminate acServer' };
  return { ok: true };
}

async function apiServerStart(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (acChild && !acChild.killed) return json(res, 409, { error: 'Server is already running' });
  if (await findACPid())          return json(res, 409, { error: 'Server is already running' });
  const { running } = await getACInfo();
  if (running) return json(res, 409, { error: 'Server is already running' });

  const r = await spawnAC();
  if (!r.ok) return json(res, 500, { error: r.error || 'Failed to start server' });
  await waitForACUp(8000);
  insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'server.start');
  json(res, 200, { ok: true });
}

async function apiServerStop(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  const r = await killAC();
  if (!r.ok) return json(res, 500, { error: r.error || 'Failed to stop server' });
  await waitForACDown(6000);
  insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'server.stop');
  json(res, 200, { ok: true });
}

async function apiServerRestart(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  const k = await killAC();
  if (!k.ok) return json(res, 500, { error: k.error || 'Failed to stop server' });
  await waitForACDown(6000);
  await sleep(500);
  const s = await spawnAC();
  if (!s.ok) return json(res, 500, { error: s.error || 'Failed to start server' });
  await waitForACUp(10000);
  insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'server.restart');
  json(res, 200, { ok: true });
}

// acServer no soporta SIGHUP para recargar config: el "reload" es un restart
// rápido. Lo dejamos como alias claro para no romper la UI existente.
async function apiServerReload(req, res) {
  return apiServerRestart(req, res);
}

// ── Login rate limiting ───────────────────────────────────────────────────────
const _loginAttempts = new Map(); // ip → { count, resetAt }
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const e   = _loginAttempts.get(ip);
  if (e && now < e.resetAt) {
    if (e.count >= 5) return false;
    e.count++;
  } else {
    _loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
  }
  return true;
}

// ── Auth API ─────────────────────────────────────────────────────────────────
async function apiAuthLogin(req, res) {
  try {
    const ip   = req.socket?.remoteAddress || '';
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

    _loginAttempts.delete(ip); // reset on success
    const token = createSession(username, user.role);
    res.setHeader('Set-Cookie', sessionCookieHeader(token));
    json(res, 200, { ok: true, user: { name: username, role: user.role, mustChangePassword: user.must_change_password === 1 } });
  } catch (e) { json(res, 500, { error: e.message }); }
}

function apiAuthLogout(req, res) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('sid='));
  if (raw) deleteSession(raw.slice(4));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  json(res, 200, { ok: true });
}

function apiAuthMe(req, res) {
  const sess = getSession(req);
  if (!sess) return json(res, 401, { error: 'Not authenticated' });
  const row = db?.prepare('SELECT must_change_password FROM panel_users WHERE username = ?').get(sess.username);
  json(res, 200, { username: sess.username, role: sess.role, mustChangePassword: row?.must_change_password === 1 });
}

async function apiAuthChangePassword(req, res) {
  try {
    // Require a valid session — username is derived from it, not from the body
    const sess = getSession(req);
    if (!sess) return json(res, 401, { error: 'Unauthorized' });

    const ip = req.socket?.remoteAddress || '';
    if (!checkLoginRateLimit(ip))
      return json(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });

    const body = await readBody(req);
    const { currentPassword, newPassword } = body;
    if (!currentPassword || !newPassword)
      return json(res, 400, { error: 'All fields are required' });
    if (newPassword.length < 8)
      return json(res, 400, { error: 'Password must be at least 8 characters' });
    if (!db) return json(res, 503, { error: 'Database unavailable' });

    const username = sess.username;
    const user = db.prepare('SELECT * FROM panel_users WHERE username = ?').get(username);
    if (!user) return json(res, 404, { error: 'User not found' });

    if (!verifyPassword(currentPassword, user.salt, user.password_hash))
      return json(res, 401, { error: 'Current password is incorrect' });

    const newSalt = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE panel_users SET password_hash = ?, salt = ?, must_change_password = 0 WHERE username = ?')
      .run(hashPassword(newPassword, newSalt), newSalt, username);

    _loginAttempts.delete(ip);
    insertAuditLog(username, 'user.update', username, 'self password change');
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
}

// ── Panel users CRUD ─────────────────────────────────────────────────────────
function apiPanelUsers(req, res) {
  if (!checkAnyAuth(req)) return json(res, 401, { error: 'Unauthorized' });
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
    if (password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
    if (!db) return json(res, 503, { error: 'Database unavailable' });
    const exists = db.prepare('SELECT 1 FROM panel_users WHERE username = ?').get(username);
    if (exists) return json(res, 409, { error: 'Username already exists' });
    const salt = crypto.randomBytes(32).toString('hex');
    const finalRole = role === 'admin' ? 'admin' : 'user';
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
      db.prepare('UPDATE panel_users SET role = ? WHERE username = ?').run(body.role, username);
      changes.push(`role=${body.role}`);
    }
    if (body.password && body.password.length >= 8) {
      const s = crypto.randomBytes(32).toString('hex');
      db.prepare('UPDATE panel_users SET password_hash = ?, salt = ? WHERE username = ?')
        .run(hashPassword(body.password, s), s, username);
      changes.push('password changed');
    }
    if (changes.length) insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'user.update', username, changes.join(', '));
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
}

function apiPanelUserDelete(req, res, username) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (!db) return json(res, 503, { error: 'Database unavailable' });
  db.prepare('DELETE FROM panel_users WHERE username = ?').run(username);
  insertAuditLog(checkAnyAuth(req)?.username || 'unknown', 'user.delete', username);
  json(res, 200, { ok: true });
}

// ── Panel settings (upload_max_mb, etc.) ──────────────────────────────────────
function apiPanelSettingsGet(res) {
  if (!db) return json(res, 200, { uploadMaxMb: 500, chunkedUpload: false, lang: 'en' });
  const mbRow      = db.prepare(`SELECT value FROM panel_settings WHERE key = 'upload_max_mb'`).get();
  const langRow    = db.prepare(`SELECT value FROM panel_settings WHERE key = 'lang'`).get();
  const chunkedRow = db.prepare(`SELECT value FROM panel_settings WHERE key = 'chunked_upload'`).get();
  json(res, 200, {
    uploadMaxMb:   parseInt(mbRow?.value || '500', 10),
    lang:          langRow?.value || 'en',
    chunkedUpload: chunkedRow?.value === '1',
  });
}

async function apiPanelSettingsPut(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (!db) return json(res, 503, { error: 'Database unavailable' });
  try {
    const body = await readBody(req);
    if (body.uploadMaxMb !== undefined) {
      const mb = parseInt(body.uploadMaxMb, 10);
      if (!mb || mb < 1 || mb > 10240) return json(res, 400, { error: 'Invalid value (1–10240 MB)' });
      db.prepare(`INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('upload_max_mb', ?)`).run(String(mb));
    }
    if (body.lang !== undefined) {
      if (!['en', 'es', 'it'].includes(body.lang)) return json(res, 400, { error: 'Unsupported language' });
      db.prepare(`INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('lang', ?)`).run(body.lang);
    }
    if (body.chunkedUpload !== undefined) {
      db.prepare(`INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('chunked_upload', ?)`).run(body.chunkedUpload ? '1' : '0');
    }
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
}

// ── Multipart parser (native, no dependencies) ────────────────────────────────
function parseMultipart(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const bmatch = ct.match(/boundary=([^\s;]+)/);
    if (!bmatch) return reject(new Error('Missing multipart boundary'));
    const boundary = '--' + bmatch[1];
    const chunks   = [];
    let total      = 0;

    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) { req.destroy(); return reject(Object.assign(new Error('File too large'), { code: 'ELIMIT' })); }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const body   = Buffer.concat(chunks);
        const bBytes = Buffer.from('\r\n' + boundary);
        const result = {};

        // Split body into parts by boundary
        let start = body.indexOf(boundary);
        while (start !== -1) {
          start += boundary.length;
          if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // '--' = final boundary
          if (body[start] === 0x0d) start += 2; // skip CRLF after boundary

          const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
          if (headerEnd === -1) break;
          const headerStr = body.slice(start, headerEnd).toString('utf8');
          const dataStart = headerEnd + 4;
          const dataEnd   = body.indexOf(bBytes, dataStart);
          const data      = body.slice(dataStart, dataEnd === -1 ? undefined : dataEnd);

          const nameMatch = headerStr.match(/name="([^"]+)"/);
          const fileMatch = headerStr.match(/filename="([^"]+)"/);
          if (nameMatch) {
            const fieldName = nameMatch[1];
            if (fileMatch) {
              result[fieldName] = { filename: fileMatch[1], data };
            } else {
              result[fieldName] = data.toString('utf8');
            }
          }
          start = dataEnd;
        }
        resolve(result);
      } catch (e) { reject(e); }
    });
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

async function extractZip(buffer) {
  if (!StreamZip) throw new Error('node-stream-zip not available');
  // node-stream-zip v1.x only accepts a file path, not a buffer
  const tmpIn = path.join(os.tmpdir(), `ac-mod-${Date.now()}.zip`);
  await fsp.writeFile(tmpIn, buffer);
  const zip = new StreamZip.async({ file: tmpIn });
  const entries = await zip.entries();
  const list = [];
  for (const [name, entry] of Object.entries(entries)) {
    list.push({
      name,
      isDirectory: entry.isDirectory,
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
  const tmpIn  = path.join(os.tmpdir(), `ac-mod-${Date.now()}.7z`);
  const tmpOut = path.join(os.tmpdir(), `ac-mod-${Date.now()}`);
  await fsp.writeFile(tmpIn, buffer);
  await fsp.mkdir(tmpOut, { recursive: true });
  await new Promise((resolve, reject) => {
    const stream = sevenZ.extractFull(tmpIn, tmpOut, { $bin: sevenBin.path7za });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  // Walk tmpOut and collect entries
  const list = [];
  const walk = async (dir, rel) => {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const itemRel = rel ? rel + '/' + item.name : item.name;
      if (item.isDirectory()) {
        list.push({ name: itemRel + '/', isDirectory: true, getData: async () => null });
        await walk(path.join(dir, item.name), itemRel);
      } else {
        const fullPath = path.join(dir, item.name);
        list.push({ name: itemRel, isDirectory: false, getData: async () => fsp.readFile(fullPath) });
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
    const isDir = file.fileHeader.flags.directory;
    const data  = isDir ? null : Buffer.from(file.extraction);
    list.push({
      name:        file.fileHeader.name,
      isDirectory: isDir,
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

function insertAuditLog(actor, action, target = '', detail = '') {
  if (!db) return;
  try {
    db.prepare('INSERT INTO audit_log (actor, action, target, detail) VALUES (?, ?, ?, ?)').run(actor, action, target, detail);
  } catch {}
}

function apiAuditGet(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (!db) return json(res, 200, []);
  const rows = db.prepare(`
    SELECT id, actor, action, target, detail, logged_at
    FROM audit_log ORDER BY id DESC LIMIT 200
  `).all();
  json(res, 200, rows);
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
  if (!checkAnyAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (!db) return json(res, 200, { ok: true });
  db.prepare('DELETE FROM mod_history').run();
  json(res, 200, { ok: true });
}

async function processModBuffer(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!['.zip', '.rar', '.7z'].includes(ext))
    throw Object.assign(new Error(`Unsupported format: ${ext}. Use .zip, .rar or .7z`), { status: 400 });

  let archive = null;
  try {
    archive = await extractArchive(buffer, ext);
    const entries = archive.entries;

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
      if (!destFile.startsWith(destDir + path.sep)) continue;
      const data = await entry.getData();
      if (!data) continue;
      await fsp.mkdir(path.dirname(destFile), { recursive: true });
      await fsp.writeFile(destFile, data);
      filesExtracted++;
    }

    return { modType, modId: modRoot, destination: destDir, filesExtracted };
  } finally {
    if (archive?.close) await Promise.resolve(archive.close()).catch(() => {});
  }
}

// ── Chunked upload ─────────────────────────────────────────────────────────────
const CHUNK_TMP_DIR    = path.join(os.tmpdir(), 'ac-upload-chunks');
const _chunkAssembling = new Set(); // per-uploadId lock to prevent double-assembly

async function cleanupOldChunks() {
  try {
    const entries = await fsp.readdir(CHUNK_TMP_DIR).catch(() => []);
    const now = Date.now();
    for (const entry of entries) {
      const dir = path.join(CHUNK_TMP_DIR, entry);
      const stat = await fsp.stat(dir).catch(() => null);
      if (stat && now - stat.mtimeMs > 2 * 60 * 60 * 1000)
        await fsp.rm(dir, { recursive: true }).catch(() => {});
    }
  } catch {}
}

async function apiModUploadChunk(req, res) {
  const uploadedBy = checkAnyAuth(req)?.username || null;
  if (!uploadedBy) return json(res, 401, { error: 'Unauthorized' });

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

  if (!uploadId || chunkIndex < 0 || totalChunks < 1 || !filename || !dataB64)
    return json(res, 400, { error: 'Invalid chunk parameters' });

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

    // Lock: only the first request that reaches full-chunk-count assembles the file
    if (_chunkAssembling.has(uploadId))
      return json(res, 409, { error: 'Assembly already in progress for this upload' });
    _chunkAssembling.add(uploadId);

    const buffers = [];
    try {
      for (let i = 0; i < totalChunks; i++)
        buffers.push(await fsp.readFile(path.join(uploadDir, `chunk-${i}`)));
    } finally {
      _chunkAssembling.delete(uploadId);
    }
    await fsp.rm(uploadDir, { recursive: true }).catch(() => {});

    const result = await processModBuffer(Buffer.concat(buffers), filename);
    insertModHistory({ ok: true, filename, uploadedBy, ...result });
    insertAuditLog(uploadedBy || 'unknown', 'mod.install', result.modId || filename, `${result.modType}, ${result.filesExtracted} files`);
    json(res, 200, { ok: true, done: true, ...result });
  } catch (e) {
    await fsp.rm(uploadDir, { recursive: true }).catch(() => {});
    insertModHistory({ ok: false, filename, uploadedBy, error: e.message });
    console.error('Chunk upload error:', e.message);
    json(res, e.status || 500, { error: e.message });
  }
}

// ── Mod upload endpoint ───────────────────────────────────────────────────────
async function apiModUpload(req, res) {
  if (!checkAnyAuth(req)) return json(res, 401, { error: 'Unauthorized' });

  let maxMb = 500;
  if (db) {
    const row = db.prepare(`SELECT value FROM panel_settings WHERE key = 'upload_max_mb'`).get();
    if (row) maxMb = parseInt(row.value, 10) || 500;
  }

  let parts;
  try { parts = await parseMultipart(req, maxMb * 1024 * 1024); }
  catch (e) {
    if (e.code === 'ELIMIT') return json(res, 413, { error: `File too large (max ${maxMb} MB)` });
    return json(res, 400, { error: `Error en la subida: ${e.message}` });
  }
  const filePart = parts.file;
  if (!filePart?.data) return json(res, 400, { error: 'No file received (field: file)' });

  const uploadedBy = checkAnyAuth(req)?.username || null;
  try {
    const result = await processModBuffer(filePart.data, filePart.filename);
    insertModHistory({ ok: true, filename: filePart.filename, uploadedBy, ...result });
    insertAuditLog(uploadedBy || 'unknown', 'mod.install', result.modId || filePart.filename, `${result.modType}, ${result.filesExtracted} files`);
    json(res, 200, { ok: true, ...result });
  } catch (e) {
    insertModHistory({ ok: false, filename: filePart.filename, uploadedBy, error: e.message });
    console.error('Mod upload error:', e.message);
    json(res, e.status || 500, { error: e.message });
  }
}

// CSRF: reject unsafe methods whose Origin/Referer does not match Host.
// Cookie is SameSite=Strict so cross-site requests already lose the cookie,
// but the Origin check is a belt-and-braces second layer (e.g. against
// subtle browser bugs or a same-site malicious context).
function isUnsafeMethod(m) { return m === 'POST' || m === 'PUT' || m === 'DELETE' || m === 'PATCH'; }
function checkOrigin(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (!host) return false;
  const raw = req.headers.origin || req.headers.referer || '';
  if (!raw) return true; // some proxies strip Origin/Referer; allow cookie-only flow
  try {
    const u = new URL(raw);
    return u.host.toLowerCase() === host;
  } catch { return false; }
}

// ── Router ────────────────────────────────────────────────────────────────────
function handler(req, res) {
  setSecurityHeaders(res);
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

    // Public endpoints — no auth required
    if (urlPath === '/api/health' && req.method === 'GET')
      return json(res, 200, { ok: true, uptime: Math.floor(process.uptime()) });

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
    if (urlPath === '/api/panel/settings' && req.method === 'GET') return apiPanelSettingsGet(res);
    if (urlPath === '/api/panel/settings' && req.method === 'PUT') return apiPanelSettingsPut(req, res);

    // Mod upload & history
    if (urlPath === '/api/mods/upload'       && req.method === 'POST')   return apiModUpload(req, res);
    if (urlPath === '/api/mods/upload/chunk' && req.method === 'POST')   return apiModUploadChunk(req, res);
    if (urlPath === '/api/mods/history'      && req.method === 'GET')    return apiModHistoryGet(res);
    if (urlPath === '/api/mods/history'      && req.method === 'DELETE') return apiModHistoryDelete(req, res);
    if (urlPath === '/api/audit'             && req.method === 'GET')    return apiAuditGet(req, res);
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

    // Whitelist
    if (urlPath === '/api/whitelist' && req.method === 'GET')  return apiWhitelistGet(res);
    if (urlPath === '/api/whitelist' && req.method === 'PUT')  return apiWhitelistPut(req, res);

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
    if (urlPath === '/api/logs/stream'     && req.method === 'GET') return apiLogsStream(req, res);
    if (urlPath === '/api/config'          && req.method === 'GET') return apiConfig(req, res);
    if (urlPath === '/api/config'          && req.method === 'PUT') return apiConfigUpdate(req, res);
    if (urlPath === '/api/players'         && req.method === 'GET') return apiPlayers(res);
    if (urlPath === '/api/players/history' && req.method === 'GET') return apiPlayersHistory(res);
    if (urlPath === '/api/results'         && req.method === 'GET') return apiResults(req, res);
    if (urlPath === '/api/cars'            && req.method === 'GET') return apiCars(res);
    if (urlPath === '/api/tracks'          && req.method === 'GET') return apiTracks(res);
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
  ]);
  const STATIC_ALLOWED_PREFIXES = ['/src/'];
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
    respond(res, 200, MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', data);
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
seedDefaultUsers();
loadKunosIds();
importAllResults();
startResultsWatcher();
loadLogFileIntoBuffer();
cleanupOldChunks();
setInterval(cleanupOldChunks, 60 * 60 * 1000); // sweep abandoned chunk dirs every hour

const server = http.createServer(handler);

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
      if (acChild && !acChild.killed) acChild.kill('SIGTERM');
      process.exit(0);
    });
  });
  // Force-exit after 10 s if in-flight requests don't finish
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
