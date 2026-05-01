require('dotenv').config();

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Config ────────────────────────────────────────────────────────────────────
const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT = __dirname;

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

function respond(res, status, mime, body) {
  res.writeHead(status, {
    'Content-Type':                mime,
    'Cache-Control':               'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// ── Request handler ───────────────────────────────────────────────────────────
function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return respond(res, 405, 'text/plain', 'Method Not Allowed');
  }

  const urlPath  = req.url.split('?')[0];
  const filePath = path.resolve(ROOT, urlPath === '/' ? 'index.html' : '.' + urlPath);

  // Block directory traversal
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
  const ip = getNetworkIP();
  const line = '─'.repeat(44);
  console.log(`\n  ${line}`);
  console.log(`    Assetto Server Panel`);
  console.log(`  ${line}`);
  console.log(`    Local    →  http://localhost:${PORT}`);
  console.log(`    Network  →  http://${ip}:${PORT}`);
  console.log(`  ${line}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✖  Port ${PORT} is already in use. Change PORT in .env\n`);
  } else {
    console.error('\n  ✖  Server error:', err.message, '\n');
  }
  process.exit(1);
});
