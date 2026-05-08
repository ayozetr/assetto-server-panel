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
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('[PWA] Service Worker registered', reg.scope))
      .catch(err => console.warn('[PWA] Service Worker registration failed', err));
  });
}
`;

function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

async function build() {
  rmrf(DIST_DIR);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(path.join(DIST_DIR, 'pages'), { recursive: true });

  const startedAt = Date.now();
  await esbuild.build({
    entryPoints: ENTRY_POINTS,
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
    minify:    process.env.NODE_ENV === 'production',
    sourcemap: process.env.NODE_ENV === 'production' ? false : 'inline',
    logLevel:  'info',
  });

  // SW registration extracted from inline <script>
  fs.writeFileSync(path.join(DIST_DIR, 'sw-register.js'), SW_REGISTER_SRC.trim() + '\n');

  console.log(`[build] dist/ ready in ${Date.now() - startedAt} ms`);
}

build().catch(e => { console.error('[build] failed:', e.message); process.exit(1); });
