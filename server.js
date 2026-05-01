require('dotenv').config();

const http             = require('http');
const fs               = require('fs');
const path             = require('path');
const os               = require('os');
// (child_process removed — AC detection via HTTP ping instead)

// ── Config ────────────────────────────────────────────────────────────────────
const HOST         = process.env.HOST           || '0.0.0.0';
const PORT         = parseInt(process.env.PORT  || '3000', 10);
const AC_LOG_FILE  = process.env.AC_SERVER_LOG  || '/home/<user>/ac_server/server_output.log';
const AC_HTTP_PORT = parseInt(process.env.AC_HTTP_PORT || '8081', 10);
const ROOT         = __dirname;

// ── MIME types ────────────────────────────────────────────────────────────────
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

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type':                'application/json; charset=utf-8',
    'Cache-Control':               'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function respond(res, status, mime, body) {
  res.writeHead(status, {
    'Content-Type':                mime,
    'Cache-Control':               'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// ── System metrics ────────────────────────────────────────────────────────────
function getCPUName() {
  try {
    const info = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const m    = info.match(/model name\s*:\s*(.+)/);
    return m ? m[1].trim() : (os.cpus()[0]?.model || 'Unknown CPU');
  } catch {
    return os.cpus()[0]?.model || 'Unknown CPU';
  }
}

function getCPU() {
  return new Promise(resolve => {
    const readStat = () => {
      const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
      const vals = line.split(/\s+/).slice(1).map(Number);
      return {
        idle:  vals[3] + (vals[4] || 0),
        total: vals.reduce((a, b) => a + b, 0),
      };
    };
    const s1 = readStat();
    setTimeout(() => {
      const s2    = readStat();
      const dIdle = s2.idle  - s1.idle;
      const dTot  = s2.total - s1.total;
      resolve(dTot === 0 ? 0 : Math.round((1 - dIdle / dTot) * 100));
    }, 250);
  });
}

function getRAM() {
  const data = fs.readFileSync('/proc/meminfo', 'utf8');
  const get  = k => { const m = data.match(new RegExp(k + ':\\s+(\\d+)')); return m ? parseInt(m[1]) : 0; };
  const total = get('MemTotal'), avail = get('MemAvailable');
  return {
    used:  Math.round((total - avail) / 1024),
    total: Math.round(total / 1024),
  };
}

// Track when dashboard first saw the AC server running (used for uptime estimate)
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

// ── Log parsing ───────────────────────────────────────────────────────────────
function parseLine(raw, id) {
  const l   = raw.toLowerCase();
  const lvl = /\berror\b/.test(l)                            ? 'error'
            : /\bwarn/.test(l)                               ? 'warn'
            : /lap completed|validated|best lap|steam.*ok/.test(l) ? 'ok'
            : 'info';
  const tagM = raw.match(/\[([A-Z_0-9]{2,10})\]/);
  const tag  = tagM
    ? tagM[1]
    : raw.startsWith('PAGE') ? 'NET'
    : raw.startsWith('REQ')  ? 'NET'
    : raw.startsWith('Serve')? 'NET'
    : 'SRV';
  return { id, lvl, tag, msg: raw };
}

// ── API handlers ──────────────────────────────────────────────────────────────
async function apiMetrics(res) {
  try {
    const [cpu, ram, running] = await Promise.all([getCPU(), Promise.resolve(getRAM()), checkACRunning()]);
    json(res, 200, { cpu, ram, running, uptime: getACUptime(), cpuName: getCPUName() });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

function apiLogs(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const n      = Math.min(500, parseInt(params.get('n') || '150'));
  fs.readFile(AC_LOG_FILE, 'utf8', (err, data) => {
    if (err) return json(res, 200, { lines: [] });
    const lines = data
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-n)
      .map((raw, i) => parseLine(raw, i));
    json(res, 200, { lines });
  });
}

// ── Request handler ───────────────────────────────────────────────────────────
function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return respond(res, 405, 'text/plain', 'Method Not Allowed');
  }

  const urlPath = req.url.split('?')[0];

  // API routes
  if (urlPath.startsWith('/api/')) {
    if (urlPath === '/api/metrics') return apiMetrics(res);
    if (urlPath === '/api/logs')    return apiLogs(req, res);
    return json(res, 404, { error: 'Unknown endpoint' });
  }

  // Static files
  const filePath = path.resolve(ROOT, urlPath === '/' ? 'index.html' : '.' + urlPath);

  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) {
    return respond(res, 403, 'text/plain', '403 Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      const code = err.code === 'ENOENT' ? 404 : 500;
      return respond(res, code, 'text/plain', `${code} — ${urlPath}`);
    }
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    respond(res, 200, mime, data);
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
    console.error(`\n  ✖  Port ${PORT} is already in use. Change PORT in .env\n`);
  } else {
    console.error('\n  ✖  Server error:', err.message, '\n');
  }
  process.exit(1);
});
