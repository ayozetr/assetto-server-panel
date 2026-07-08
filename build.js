// Pre-transpile JSX to plain JS with esbuild. Output mirrors src/ → dist/ so the
// existing one-script-per-file load order in index.html keeps working without a
// bundler or ES-modules refactor. The browser then loads regular <script src="...">
// tags and CSP can drop both 'unsafe-eval' and 'unsafe-inline'.
//
// React/ReactDOM still come from CDN as runtime globals — esbuild only transforms
// the JSX in our own files.

const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

const SRC_DIR  = path.join(__dirname, 'src');
const DIST_DIR = path.join(__dirname, 'dist');

// Keep the same set the SW pre-caches. Order in index.html still matters because
// each file attaches to a window.* global; build is order-independent — esbuild
// processes each file independently.
const ENTRY_POINTS = [
  'tweaks-panel.jsx',
  'icons.jsx',
  'utils.jsx',
  'i18n.jsx',
  'shell.jsx',
  'pages/monitoring.jsx',
  'pages/players.jsx',
  'pages/logs.jsx',
  'pages/content.jsx',
  'pages/tracks.jsx',
  'pages/session.jsx',
  'pages/presets.jsx',
  'pages/settings.jsx',
  'pages/users.jsx',
  'pages/profile.jsx',
  'pages/audit.jsx',
  'pages/laptimes.jsx',
  'pages/mods.jsx',
  'app.jsx',
].map(rel => path.join(SRC_DIR, rel));

// Tiny inline file moved out of index.html so we can drop CSP unsafe-inline.
const SW_REGISTER_SRC = `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // updateViaCache:'none' tells the browser to bypass its HTTP cache when
    // checking for sw.js updates. Without this, the browser can hold the
    // previous sw.js for hours (max-age) and new SW versions never reach the
    // user — leading to "F5 keeps showing the old bundle" after a deploy.
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then(reg => console.log('[PWA] Service Worker registered', reg.scope))
      .catch(err => console.warn('[PWA] Service Worker registration failed', err));
  });
}
`;

function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

// Plain-JS vendor files (no JSX, no transform — just copy through).
// These are third-party libraries we ship from disk instead of CDN to keep
// supply-chain control: the file is pinned in the repo with a hash, esbuild
// passes it through with the minify flag honoured.
const VENDOR_FILES = [
  'vendor/qrcode-generator.js',
].map(rel => path.join(SRC_DIR, rel));

async function build() {
  rmrf(DIST_DIR);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(path.join(DIST_DIR, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(DIST_DIR, 'vendor'), { recursive: true });

  const startedAt = Date.now();
  await esbuild.build({
    entryPoints: [...ENTRY_POINTS, ...VENDOR_FILES],
    outdir:     DIST_DIR,
    outbase:    SRC_DIR,
    outExtension: { '.js': '.js' },
    loader:    { '.jsx': 'jsx' },
    jsx:       'transform',
    jsxFactory:    'React.createElement',
    jsxFragment:   'React.Fragment',
    target:    ['es2020'],
    format:    'iife',  // wrap each file so internal lets/consts don't collide cross-file
    bundle:    false,
    // Production by default; only an explicit NODE_ENV=development opts into the
    // unminified + inline-sourcemap build. A bare-metal `npm start` without
    // NODE_ENV set used to ship the full unminified JSX sources to every admin.
    minify:    process.env.NODE_ENV !== 'development',
    sourcemap: process.env.NODE_ENV === 'development' ? 'inline' : false,
    logLevel:  'info',
  });

  // SW registration extracted from inline <script>
  fs.writeFileSync(path.join(DIST_DIR, 'sw-register.js'), SW_REGISTER_SRC.trim() + '\n');

  console.log(`[build] dist/ ready in ${Date.now() - startedAt} ms`);
}

build().catch(e => { console.error('[build] failed:', e.message); process.exit(1); });
