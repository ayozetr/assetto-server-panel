require('dotenv').config();

const http          = require('http');
const fs            = require('fs');
const fsp           = fs.promises;
const path          = require('path');
const os            = require('os');
const crypto        = require('crypto');
const { spawn }     = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const HOST         = process.env.HOST              || '0.0.0.0';
const PORT         = parseInt(process.env.PORT     || '3000', 10);
const AC_HTTP_PORT = parseInt(process.env.AC_HTTP_PORT || '8081', 10);
const AC_LOG_FILE  = process.env.AC_SERVER_LOG     || '/home/<user>/ac_server/server_output.log';
const AC_RESULTS   = process.env.AC_SERVER_RESULTS || '/home/<user>/ac_server/results';
const AC_CFG_FILE  = path.join(process.env.AC_CFG_DIR || '/srv/assetto/cfg', 'server_cfg.ini');
const AC_CARS_DIR  = path.join(process.env.AC_CONTENT_DIR || '/srv/assetto/content', 'cars');
const AC_TRACKS_DIR= path.join(process.env.AC_CONTENT_DIR || '/srv/assetto/content', 'tracks');
const DB_PATH      = process.env.DB_PATH || path.join(__dirname, 'assetto.db');
const AC_BIN          = process.env.AC_SERVER_BIN || '/home/<user>/ac_server/acServer';
const AC_BIN_DIR      = process.env.AC_SERVER_DIR || path.dirname(AC_BIN);
const AC_BLACKLIST    = process.env.AC_BLACKLIST_FILE || path.join(AC_BIN_DIR, 'blacklist.txt');
const ADMIN_TOKEN     = process.env.ADMIN_TOKEN || '';
const ROOT            = __dirname;

let acChild = null; // tracked child process for the AC server

// ── Session store ─────────────────────────────────────────────────────────────
const sessions = new Map(); // token → { username, role, expiresAt }
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

function createSession(username, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, role, expiresAt: Date.now() + SESSION_TTL });
  return token;
}

function getSession(req) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith('sid='));
  if (!match) return null;
  const token = match.slice(4);
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return s;
}

function sessionCookieHeader(token) {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`;
}

function checkAdminAuth(req) {
  // Valid admin session cookie takes priority
  const sess = getSession(req);
  if (sess?.role === 'admin') return true;
  // ADMIN_TOKEN header fallback (for headless/script access)
  if (!ADMIN_TOKEN) return true; // no token configured → open (original behaviour)
  const h = req.headers['x-admin-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
  return h === ADMIN_TOKEN;
}

// ── MIME ──────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.jsx':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
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
  `);
  console.log('  Database ready:', DB_PATH);
} catch (e) {
  console.error('  Database init failed:', e.message);
}

// ── Auth helpers ─────────────────────────────────────────────────────────────
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function seedDefaultUsers() {
  if (!db) return;
  try {
    const DEFAULT_PASS = 'Admin1234!';
    for (const [username, role] of [['admin', 'admin'], ['mattia', 'admin']]) {
      const existing = db.prepare('SELECT 1 FROM panel_users WHERE username = ?').get(username);
      if (!existing) {
        const salt = crypto.randomBytes(32).toString('hex');
        db.prepare('INSERT INTO panel_users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)')
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

function importResultFile(filename) {
  if (!db) return false;
  const filepath = path.join(AC_RESULTS, filename);
  try {
    const raw  = fs.readFileSync(filepath, 'utf8');
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

function importAllResults() {
  if (!db) return;
  try {
    const files = fs.readdirSync(AC_RESULTS).filter(f => f.endsWith('.json')).sort();
    let imported = 0;
    for (const file of files) {
      const already = db.prepare('SELECT 1 FROM processed_files WHERE filename = ?').get(file);
      if (!already && importResultFile(file)) imported++;
    }
    if (imported > 0) console.log(`  Imported ${imported} result file(s) into database`);
  } catch (e) {
    console.error('  Cannot scan results dir:', e.message);
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
      setTimeout(() => {
        _pendingImports.delete(filename);
        const already = db.prepare('SELECT 1 FROM processed_files WHERE filename = ?').get(filename);
        if (!already) importResultFile(filename);
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

function respond(res, status, mime, body, extraHeaders) {
  res.writeHead(status, {
    'Content-Type':  mime,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    ...extraHeaders,
  });
  res.end(body);
}

function respondImage(res, data) {
  res.writeHead(200, {
    'Content-Type':  'image/png',
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(data);
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
        return `${k}=${obj[section][k]}`;
      }
    }
    return rawLine;
  });

  // Append any keys that did not exist in the original file
  for (const [sec, keys] of Object.entries(obj)) {
    if (sec === '__default__') continue;
    for (const [k, v] of Object.entries(keys)) {
      if (updated.has(`${sec}|${k}`)) continue;
      const secIdx = patched.findIndex(l => l.trim() === `[${sec}]`);
      if (secIdx >= 0) {
        patched.splice(secIdx + 1, 0, `${k}=${v}`);
      } else {
        patched.push('', `[${sec}]`, `${k}=${v}`);
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

function getRAM() {
  const d = fs.readFileSync('/proc/meminfo', 'utf8');
  const g = k => { const m = d.match(new RegExp(k + ':\\s+(\\d+)')); return m ? parseInt(m[1]) : 0; };
  const total = g('MemTotal'), avail = g('MemAvailable');
  return { used: Math.round((total - avail) / 1024), total: Math.round(total / 1024) };
}

// ── AC Server detection ───────────────────────────────────────────────────────
let _acRunSince = null;

function checkACRunning() {
  return new Promise(resolve => {
    const req = http.get(
      { hostname: '127.0.0.1', port: AC_HTTP_PORT, path: '/INFO', timeout: 1500 },
      res => {
        const ok = res.statusCode === 200;
        res.destroy();
        if (ok && !_acRunSince) _acRunSince = Date.now();
        if (!ok) _acRunSince = null;
        resolve(ok);
      }
    );
    req.on('error', () => { _acRunSince = null; resolve(false); });
    req.setTimeout(1500, () => { req.destroy(); _acRunSince = null; resolve(false); });
  });
}

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
    const [cpu, ram, running] = await Promise.all([getCPU(), Promise.resolve(getRAM()), checkACRunning()]);
    json(res, 200, { cpu, ram, running, uptime: getACUptime(), cpuName: getCPUName(), osInfo: getOSInfo() });
  } catch (e) { json(res, 500, { error: e.message }); }
}

function apiLogs(req, res) {
  const n = Math.min(500, parseInt(new URL(req.url, 'http://x').searchParams.get('n') || '150'));
  fs.readFile(AC_LOG_FILE, 'utf8', (err, data) => {
    if (err) return json(res, 200, { lines: [] });
    const lines = data.trim().split('\n').filter(Boolean).slice(-n).map(parseLine);
    json(res, 200, { lines });
  });
}

function apiConfig(res) {
  fs.readFile(AC_CFG_FILE, 'utf8', (err, data) => {
    if (err) return json(res, 404, { error: 'server_cfg.ini not found' });
    const ini = parseINI(data);
    const s   = ini['SERVER'] || {};
    json(res, 200, {
      name:        s['NAME']                    || '',
      welcome:     s['WELCOME_MESSAGE']          || '',
      password:    s['PASSWORD']                || '',
      adminPass:   s['ADMIN_PASSWORD']           || '',
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

function validPort(v) { const n = parseInt(v); return n >= 1024 && n <= 65535 ? n : null; }
function clampInt(v, lo, hi) { const n = parseInt(v); return isNaN(n) ? null : Math.max(lo, Math.min(hi, n)); }

async function apiConfigUpdate(req, res) {
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
    json(res, 200, { ok: true });
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
        let ui = {};
        try { ui = JSON.parse(await fsp.readFile(path.join(AC_CARS_DIR, id, 'ui', 'ui_car.json'), 'utf8')); } catch {}

        let skins = [];
        try {
          const entries = await fsp.readdir(path.join(AC_CARS_DIR, id, 'skins'), { withFileTypes: true });
          skins = entries.filter(e => e.isDirectory()).map(e => e.name);
        } catch {}

        const cls = ui.class || ui.tags?.[0] || '';

        let thumb = null;
        if (skins.length > 0) {
          thumb = `/api/content/cars/${encodeURIComponent(id)}/skins/${encodeURIComponent(skins[0])}/preview`;
        } else {
          const badgePath = path.join(AC_CARS_DIR, id, 'ui', 'badge.png');
          try { await fsp.access(badgePath); thumb = `/api/content/cars/${encodeURIComponent(id)}/thumb`; } catch {}
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
      const uiDir = path.join(AC_TRACKS_DIR, id, 'ui');
      let mainJson = null;
      let layouts  = [];

      // Try direct ui_track.json (single-layout tracks)
      try {
        mainJson = JSON.parse(await fsp.readFile(path.join(uiDir, 'ui_track.json'), 'utf8'));
      } catch {}

      // Scan for layout sub-directories
      try {
        const entries = await fsp.readdir(uiDir, { withFileTypes: true });
        const layoutDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
        if (layoutDirs.length > 0) {
          layouts = layoutDirs;
          if (!mainJson) {
            try {
              mainJson = JSON.parse(
                await fsp.readFile(path.join(uiDir, layoutDirs[0], 'ui_track.json'), 'utf8')
              );
            } catch {}
          }
        }
      } catch {}

      if (!layouts.length) layouts = [''];
      if (!mainJson) mainJson = {};

      // Per-layout details (only for multi-layout tracks)
      let layoutDetails = {};
      if (layouts.length > 1 || (layouts.length === 1 && layouts[0] !== '')) {
        for (const layout of layouts) {
          if (!layout) continue;
          let lJson = {};
          try { lJson = JSON.parse(await fsp.readFile(path.join(uiDir, layout, 'ui_track.json'), 'utf8')); } catch {}
          layoutDetails[layout] = {
            name:        lJson.name        || mainJson.name    || formatName(id),
            description: stripHtml(lJson.description || mainJson.description || '').slice(0, 400),
            length:      parseTrackLength(lJson.length  || mainJson.length),
            pits:        parseInt(lJson.pitboxes || mainJson.pitboxes) || 0,
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
      };
    }));
    json(res, 200, tracks.sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e) { json(res, 500, { error: e.message }); }
}

// Serve car badge image (badge.png from ui folder)
function apiCarThumb(carId, res) {
  if (!isValidContentId(carId)) return respond(res, 400, 'text/plain', 'Invalid ID');
  const imgPath = path.join(AC_CARS_DIR, carId, 'ui', 'badge.png');
  fs.readFile(imgPath, (err, data) => {
    if (err) return respond(res, 404, 'text/plain', 'Not found');
    respondImage(res, data);
  });
}

// Serve a specific car skin preview (skins/{name}/preview.jpg)
function apiCarSkinPreview(carId, skinName, res) {
  if (!isValidContentId(carId) || !isValidSkinName(skinName))
    return respond(res, 400, 'text/plain', 'Invalid ID');
  const imgPath = path.join(AC_CARS_DIR, carId, 'skins', skinName, 'preview.jpg');
  if (!imgPath.startsWith(AC_CARS_DIR + path.sep))
    return respond(res, 403, 'text/plain', 'Forbidden');
  fs.readFile(imgPath, (err, data) => {
    if (err) return respond(res, 404, 'text/plain', 'Not found');
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
    res.end(data);
  });
}

// Serve track preview image (preview.png — direct or first layout sub-folder)
function apiTrackThumb(trackId, res) {
  if (!isValidContentId(trackId)) return respond(res, 400, 'text/plain', 'Invalid ID');
  const uiDir = path.join(AC_TRACKS_DIR, trackId, 'ui');
  const direct = path.join(uiDir, 'preview.png');

  fs.readFile(direct, (err, data) => {
    if (!err) return respondImage(res, data);

    // Try first layout sub-folder
    fsp.readdir(uiDir, { withFileTypes: true }).then(entries => {
      const dir = entries.find(e => e.isDirectory());
      if (!dir) return respond(res, 404, 'text/plain', 'Not found');
      fs.readFile(path.join(uiDir, dir.name, 'preview.png'), (e2, d2) => {
        if (e2) return respond(res, 404, 'text/plain', 'Not found');
        respondImage(res, d2);
      });
    }).catch(() => respond(res, 404, 'text/plain', 'Not found'));
  });
}

// Serve a specific layout's preview.png
function apiTrackLayoutThumb(trackId, layout, res) {
  if (!isValidContentId(trackId) || !isValidContentId(layout))
    return respond(res, 400, 'text/plain', 'Invalid ID');
  const imgPath = path.join(AC_TRACKS_DIR, trackId, 'ui', layout, 'preview.png');
  if (!imgPath.startsWith(AC_TRACKS_DIR + path.sep))
    return respond(res, 403, 'text/plain', 'Forbidden');
  fs.readFile(imgPath, (err, data) => {
    if (err) return respond(res, 404, 'text/plain', 'Not found');
    respondImage(res, data);
  });
}

// ── Player kick / ban ─────────────────────────────────────────────────────────
async function apiPlayerKick(req, res) {
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
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
}

async function apiPlayerBan(req, res) {
  try {
    const body = await readBody(req);
    const guid = body.guid;
    if (!guid) return json(res, 400, { error: 'guid required' });
    let existing = '';
    try { existing = fs.readFileSync(AC_BLACKLIST, 'utf8'); } catch {}
    const guids = existing.split('\n').map(s => s.trim()).filter(Boolean);
    if (!guids.includes(guid)) fs.appendFileSync(AC_BLACKLIST, guid + '\n');
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
  try {
    const body = await readBody(req);
    const raw  = await fsp.readFile(AC_CFG_FILE, 'utf8');
    const ini  = parseINI(raw);
    const s    = ini['SERVER'] = ini['SERVER'] || {};
    if (body.trackId !== undefined) s['TRACK']        = body.trackId;
    if (body.layout  !== undefined) s['CONFIG_TRACK'] = body.layout || '';
    if (Array.isArray(body.cars) && body.cars.length)
      s['CARS'] = [...new Set(body.cars)].join(';');
    await fsp.copyFile(AC_CFG_FILE, AC_CFG_FILE + '.bak');
    await fsp.writeFile(AC_CFG_FILE, patchINI(raw, ini), 'utf8');
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
}

// ── Server control ────────────────────────────────────────────────────────────
function spawnAC() {
  try {
    acChild = spawn(AC_BIN, [], { cwd: AC_BIN_DIR, stdio: 'ignore', detached: false });
    acChild.on('exit', () => { acChild = null; });
  } catch (e) {
    console.error('acServer spawn failed:', e.message);
    acChild = null;
  }
}

function killAC() {
  if (acChild && !acChild.killed) {
    try { acChild.kill('SIGTERM'); } catch {}
    acChild = null;
  }
}

function apiServerStart(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (acChild && !acChild.killed) return json(res, 409, { error: 'Already running' });
  spawnAC();
  json(res, 200, { ok: true });
}

function apiServerStop(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  killAC();
  json(res, 200, { ok: true });
}

function apiServerRestart(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  killAC();
  setTimeout(spawnAC, 1500);
  json(res, 200, { ok: true });
}

function apiServerReload(req, res) {
  if (!checkAdminAuth(req)) return json(res, 401, { error: 'Unauthorized' });
  if (acChild && !acChild.killed) {
    try { acChild.kill('SIGHUP'); } catch {}
  }
  json(res, 200, { ok: true });
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
      return json(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });

    const body = await readBody(req);
    const { username, password } = body;
    if (!username || !password) return json(res, 400, { error: 'Usuario y contraseña requeridos' });

    if (!db) {
      const role = (username === 'admin' || username === 'mattia') ? 'admin' : 'user';
      return json(res, 200, { ok: true, user: { name: username, role } });
    }

    const user = db.prepare('SELECT * FROM panel_users WHERE username = ?').get(username);
    if (!user) return json(res, 401, { error: 'Usuario o contraseña incorrectos' });

    const hash = hashPassword(password, user.salt);
    if (hash !== user.password_hash) return json(res, 401, { error: 'Usuario o contraseña incorrectos' });

    _loginAttempts.delete(ip); // reset on success
    const token = createSession(username, user.role);
    res.setHeader('Set-Cookie', sessionCookieHeader(token));
    json(res, 200, { ok: true, user: { name: username, role: user.role } });
  } catch (e) { json(res, 500, { error: e.message }); }
}

function apiAuthLogout(req, res) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('sid='));
  if (raw) sessions.delete(raw.slice(4));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  json(res, 200, { ok: true });
}

async function apiAuthChangePassword(req, res) {
  try {
    const body = await readBody(req);
    const { username, currentPassword, newPassword } = body;
    if (!username || !currentPassword || !newPassword)
      return json(res, 400, { error: 'Todos los campos son obligatorios' });
    if (newPassword.length < 8)
      return json(res, 400, { error: 'La contraseña debe tener al menos 8 caracteres' });
    if (!db) return json(res, 500, { error: 'Base de datos no disponible' });

    const user = db.prepare('SELECT * FROM panel_users WHERE username = ?').get(username);
    if (!user) return json(res, 404, { error: 'Usuario no encontrado' });

    if (hashPassword(currentPassword, user.salt) !== user.password_hash)
      return json(res, 401, { error: 'Contraseña actual incorrecta' });

    const newSalt = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE panel_users SET password_hash = ?, salt = ? WHERE username = ?')
      .run(hashPassword(newPassword, newSalt), newSalt, username);

    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
}

// ── Panel users CRUD ─────────────────────────────────────────────────────────
function apiPanelUsers(res) {
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
  try {
    const body = await readBody(req);
    const { username, password, role } = body;
    if (!username || !password) return json(res, 400, { error: 'usuario y contraseña requeridos' });
    if (password.length < 8) return json(res, 400, { error: 'contraseña mínimo 8 caracteres' });
    if (!db) return json(res, 500, { error: 'base de datos no disponible' });
    const exists = db.prepare('SELECT 1 FROM panel_users WHERE username = ?').get(username);
    if (exists) return json(res, 409, { error: 'El usuario ya existe' });
    const salt = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO panel_users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)')
      .run(username, hashPassword(password, salt), salt, role === 'admin' ? 'admin' : 'user');
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
}

async function apiPanelUserUpdate(req, res, username) {
  try {
    const body = await readBody(req);
    if (!db) return json(res, 500, { error: 'base de datos no disponible' });
    const user = db.prepare('SELECT * FROM panel_users WHERE username = ?').get(username);
    if (!user) return json(res, 404, { error: 'Usuario no encontrado' });
    if (body.role !== undefined && (body.role === 'admin' || body.role === 'user'))
      db.prepare('UPDATE panel_users SET role = ? WHERE username = ?').run(body.role, username);
    if (body.password && body.password.length >= 8) {
      const s = crypto.randomBytes(32).toString('hex');
      db.prepare('UPDATE panel_users SET password_hash = ?, salt = ? WHERE username = ?')
        .run(hashPassword(body.password, s), s, username);
    }
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: e.message }); }
}

function apiPanelUserDelete(res, username) {
  if (!db) return json(res, 500, { error: 'base de datos no disponible' });
  db.prepare('DELETE FROM panel_users WHERE username = ?').run(username);
  json(res, 200, { ok: true });
}

// ── Router ────────────────────────────────────────────────────────────────────
function handler(req, res) {
  const urlPath = req.url.split('?')[0];

  if (urlPath.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Allow': 'GET, PUT, POST, OPTIONS',
      });
      return res.end();
    }

    // Auth
    if (urlPath === '/api/auth/login'           && req.method === 'POST') return apiAuthLogin(req, res);
    if (urlPath === '/api/auth/logout'          && req.method === 'POST') return apiAuthLogout(req, res);
    if (urlPath === '/api/auth/change-password' && req.method === 'POST') return apiAuthChangePassword(req, res);

    // Panel users CRUD
    if (urlPath === '/api/panel/users' && req.method === 'GET')  return apiPanelUsers(res);
    if (urlPath === '/api/panel/users' && req.method === 'POST') return apiPanelUserCreate(req, res);
    const panelUserM = urlPath.match(/^\/api\/panel\/users\/([^/]+)$/);
    if (panelUserM && req.method === 'PUT')    return apiPanelUserUpdate(req, res, decodeURIComponent(panelUserM[1]));
    if (panelUserM && req.method === 'DELETE') return apiPanelUserDelete(res, decodeURIComponent(panelUserM[1]));

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
    const carThumbMatch        = urlPath.match(/^\/api\/content\/cars\/([^/]+)\/thumb$/);
    const trackThumbMatch      = urlPath.match(/^\/api\/content\/tracks\/([^/]+)\/thumb$/);
    const trackLayoutThumbMatch= urlPath.match(/^\/api\/content\/tracks\/([^/]+)\/layout\/([^/]+)\/thumb$/);
    if (carSkinMatch         && req.method === 'GET') return apiCarSkinPreview(decodeURIComponent(carSkinMatch[1]), decodeURIComponent(carSkinMatch[2]), res);
    if (carThumbMatch        && req.method === 'GET') return apiCarThumb(decodeURIComponent(carThumbMatch[1]), res);
    if (trackLayoutThumbMatch && req.method === 'GET') return apiTrackLayoutThumb(decodeURIComponent(trackLayoutThumbMatch[1]), decodeURIComponent(trackLayoutThumbMatch[2]), res);
    if (trackThumbMatch      && req.method === 'GET') return apiTrackThumb(decodeURIComponent(trackThumbMatch[1]), res);

    // Data endpoints
    if (urlPath === '/api/metrics'         && req.method === 'GET') return apiMetrics(res);
    if (urlPath === '/api/logs'            && req.method === 'GET') return apiLogs(req, res);
    if (urlPath === '/api/config'          && req.method === 'GET') return apiConfig(res);
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

  const filePath = path.resolve(ROOT, urlPath === '/' ? 'index.html' : '.' + urlPath);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) {
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
importAllResults();
startResultsWatcher();

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
