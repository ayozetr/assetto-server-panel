require('dotenv').config();

const http = require('http');
const fs   = require('fs');
const fsp  = fs.promises;
const path = require('path');
const os   = require('os');

// ── Config ────────────────────────────────────────────────────────────────────
const HOST         = process.env.HOST            || '0.0.0.0';
const PORT         = parseInt(process.env.PORT   || '3000', 10);
const AC_HTTP_PORT = parseInt(process.env.AC_HTTP_PORT || '8081', 10);
const AC_LOG_FILE  = process.env.AC_SERVER_LOG   || '/home/<user>/ac_server/server_output.log';
const AC_RESULTS   = process.env.AC_SERVER_RESULTS || '/home/<user>/ac_server/results';
const AC_CFG_FILE  = path.join(process.env.AC_CFG_DIR || '/srv/assetto/cfg', 'server_cfg.ini');
const AC_CARS_DIR  = path.join(process.env.AC_CONTENT_DIR || '/srv/assetto/content', 'cars');
const AC_TRACKS_DIR= path.join(process.env.AC_CONTENT_DIR || '/srv/assetto/content', 'tracks');
const ROOT         = __dirname;

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

// ── Helpers ───────────────────────────────────────────────────────────────────
function getNetworkIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function respond(res, status, mime, body) {
  res.writeHead(status, {
    'Content-Type':                mime,
    'Cache-Control':               'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function json(res, status, data) {
  respond(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 512_000) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ── Name formatter ────────────────────────────────────────────────────────────
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
  return parseFloat((n < 50 ? n : n / 1000).toFixed(3)); // normalize to km
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

function serializeINI(obj) {
  return Object.entries(obj)
    .filter(([s]) => s !== '__default__')
    .map(([section, keys]) =>
      `[${section}]\n` + Object.entries(keys).map(([k, v]) => `${k}=${v}`).join('\n')
    ).join('\n\n') + '\n';
}

// ── System metrics ────────────────────────────────────────────────────────────
function getCPUName() {
  try {
    const m = fs.readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.+)/);
    return m ? m[1].trim() : (os.cpus()[0]?.model || 'Unknown');
  } catch { return os.cpus()[0]?.model || 'Unknown'; }
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
  const lvl = /\berror\b/.test(l)                                    ? 'error'
            : /\bwarn/.test(l)                                       ? 'warn'
            : /lap completed|validated|best lap|steam.*ok/.test(l)   ? 'ok'
            : 'info';
  const tm  = raw.match(/\[([A-Z_0-9]{2,10})\]/);
  const tag = tm   ? tm[1]
            : raw.startsWith('PAGE')  ? 'NET'
            : raw.startsWith('REQ')   ? 'NET'
            : raw.startsWith('Serve') ? 'NET'
            : 'SRV';
  return { id, lvl, tag, msg: raw };
}

// ── Results helpers ───────────────────────────────────────────────────────────
function parseDateFromFilename(name) {
  const m = name.match(/^(\d{4})_(\d{1,2})_(\d{1,2})/);
  return m ? `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}` : '';
}

// ── API handlers ──────────────────────────────────────────────────────────────

async function apiMetrics(res) {
  try {
    const [cpu, ram, running] = await Promise.all([getCPU(), Promise.resolve(getRAM()), checkACRunning()]);
    json(res, 200, { cpu, ram, running, uptime: getACUptime(), cpuName: getCPUName() });
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
      name:          s['NAME']                   || '',
      welcome:       s['WELCOME_MESSAGE']         || '',
      password:      s['PASSWORD']               || '',
      adminPass:     s['ADMIN_PASSWORD']          || '',
      tcp:           parseInt(s['TCP_PORT'])      || 9600,
      udp:           parseInt(s['UDP_PORT'])      || 9600,
      http:          parseInt(s['HTTP_PORT'])     || 8081,
      tickrate:      parseInt(s['CLIENT_SEND_INTERVAL_HZ']) || 18,
      maxClients:    parseInt(s['MAX_CLIENTS'])   || 0,
      publicLobby:   s['REGISTER_TO_LOBBY'] === '1',
      fuelRate:      parseInt(s['FUEL_RATE'])     || 100,
      damage:        parseInt(s['DAMAGE_MULTIPLIER']) || 100,
      tyreWear:      parseInt(s['TYRE_WEAR_RATE'])|| 100,
      abs:           parseInt(s['ABS_ALLOWED'])   || 0,
      tc:            parseInt(s['TC_ALLOWED'])    || 0,
      autoclutch:    s['AUTOCLUTCH_ALLOWED'] === '1',
      stability:     s['STABILITY_ALLOWED']  === '1',
      track:         s['TRACK']              || '',
      trackConfig:   s['CONFIG_TRACK']       || '',
      cars:          (s['CARS'] || '').split(';').filter(Boolean),
    });
  });
}

async function apiConfigUpdate(req, res) {
  try {
    const body = await readBody(req);
    const raw  = await fsp.readFile(AC_CFG_FILE, 'utf8');
    const ini  = parseINI(raw);
    const s    = ini['SERVER'] = ini['SERVER'] || {};

    if (body.name        !== undefined) s['NAME']               = body.name;
    if (body.welcome     !== undefined) s['WELCOME_MESSAGE']    = body.welcome;
    if (body.password    !== undefined) s['PASSWORD']           = body.password;
    if (body.adminPass   !== undefined) s['ADMIN_PASSWORD']     = body.adminPass;
    if (body.tcp         !== undefined) s['TCP_PORT']           = String(body.tcp);
    if (body.udp         !== undefined) s['UDP_PORT']           = String(body.udp);
    if (body.http        !== undefined) s['HTTP_PORT']          = String(body.http);
    if (body.tickrate    !== undefined) s['CLIENT_SEND_INTERVAL_HZ'] = String(body.tickrate);
    if (body.maxClients  !== undefined) s['MAX_CLIENTS']        = String(body.maxClients);
    if (body.publicLobby !== undefined) s['REGISTER_TO_LOBBY'] = body.publicLobby ? '1' : '0';

    await fsp.copyFile(AC_CFG_FILE, AC_CFG_FILE + '.bak');
    await fsp.writeFile(AC_CFG_FILE, serializeINI(ini), 'utf8');
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
              id:       c.ID,
              name:     c.Driver.Name,
              steam:    c.Driver.Guid   || '',
              nation:   c.Driver.Nation || '',
              carId:    c.CarInfo?.Model || '',
              car:      formatName(c.CarInfo?.Model || ''),
              bestMs:   c.BestTime  || 0,
              lastMs:   c.Time      || 0,
              hasTime:  c.HasSetTime || false,
            }));
          json(res, 200, { running: true, players, session: raw.event || {} });
        } catch { json(res, 200, { running: false, players: [], session: {} }); }
      });
    }
  );
  req.on('error', () => json(res, 200, { running: false, players: [], session: {} }));
  req.setTimeout(2000, () => { req.destroy(); json(res, 200, { running: false, players: [], session: {} }); });
}

async function apiResults(res) {
  try {
    const files = (await fsp.readdir(AC_RESULTS))
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 50);

    const parsed = await Promise.all(
      files.map(f =>
        fsp.readFile(path.join(AC_RESULTS, f), 'utf8')
          .then(JSON.parse)
          .then(r => ({ file: f, data: r }))
          .catch(() => null)
      )
    );

    let id = 1;
    const laps = parsed.filter(Boolean).flatMap(({ file, data }) => {
      const date = parseDateFromFilename(file);
      return (data.Laps || []).map(l => ({
        id:     id++,
        player: l.DriverName  || '',
        car:    l.CarModel    || '',
        track:  data.TrackName || '',
        layout: data.TrackConfig || '',
        ms:     l.LapTime    || 0,
        s1:     (l.Sectors && l.Sectors[0] < 2_000_000) ? l.Sectors[0] : 0,
        s2:     (l.Sectors && l.Sectors[1] < 2_000_000) ? l.Sectors[1] : 0,
        s3:     (l.Sectors && l.Sectors[2] < 2_000_000) ? l.Sectors[2] : 0,
        cuts:   l.Cuts || 0,
        valid:  (l.Cuts || 0) === 0,
        date,
      }));
    });

    json(res, 200, laps);
  } catch (e) { json(res, 500, { error: e.message }); }
}

async function apiCars(res) {
  try {
    const dirs = await fsp.readdir(AC_CARS_DIR);
    const cars = await Promise.all(
      dirs.map(id =>
        fsp.readFile(path.join(AC_CARS_DIR, id, 'ui', 'ui_car.json'), 'utf8')
          .then(JSON.parse)
          .then(ui => ({ id, name: ui.name || formatName(id), brand: ui.brand || '', cls: ui.tags?.[0] || '' }))
          .catch(() => ({ id, name: formatName(id), brand: '', cls: '' }))
      )
    );
    json(res, 200, cars.sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e) { json(res, 500, { error: e.message }); }
}

async function apiTracks(res) {
  try {
    const dirs = await fsp.readdir(AC_TRACKS_DIR);
    const tracks = await Promise.all(
      dirs.map(id =>
        fsp.readFile(path.join(AC_TRACKS_DIR, id, 'ui', 'ui_track.json'), 'utf8')
          .then(JSON.parse)
          .then(ui => ({
            id,
            name:    ui.name    || formatName(id),
            city:    ui.city    || ui.country || '',
            length:  parseTrackLength(ui.length),
            pits:    parseInt(ui.pitboxes) || 0,
            layouts: [''],
          }))
          .catch(() => ({ id, name: formatName(id), city: '', length: 0, pits: 0, layouts: [''] }))
      )
    );
    json(res, 200, tracks.sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e) { json(res, 500, { error: e.message }); }
}

// ── Router ────────────────────────────────────────────────────────────────────
function handler(req, res) {
  const urlPath = req.url.split('?')[0];

  if (urlPath.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
    if (urlPath === '/api/metrics'  && req.method === 'GET') return apiMetrics(res);
    if (urlPath === '/api/logs'     && req.method === 'GET') return apiLogs(req, res);
    if (urlPath === '/api/config'   && req.method === 'GET') return apiConfig(res);
    if (urlPath === '/api/config'   && req.method === 'PUT') return apiConfigUpdate(req, res);
    if (urlPath === '/api/players'  && req.method === 'GET') return apiPlayers(res);
    if (urlPath === '/api/results'  && req.method === 'GET') return apiResults(res);
    if (urlPath === '/api/cars'     && req.method === 'GET') return apiCars(res);
    if (urlPath === '/api/tracks'   && req.method === 'GET') return apiTracks(res);
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
