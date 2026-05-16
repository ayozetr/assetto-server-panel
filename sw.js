// Assetto Server Panel — Service Worker
// Strategy:
//   - /api/*                : network-first (no cache)
//   - / and /index.html     : network-first with cache fallback (so security/UI
//                             updates ship without manual SW bumps)
//   - cross-origin (CDN)    : stale-while-revalidate
//   - same-origin static    : stale-while-revalidate

// Bump on every behaviour change so old caches are dropped at activate-time.
const CACHE_NAME  = 'ac-panel-v35';
const API_PREFIX  = '/api/';

// Static assets to pre-cache on install. JSX is now pre-transpiled into /dist/
// by build.js; the SW pre-fetches the .js files instead of the source .jsx files.
const PRECACHE = [
  '/',
  '/src/styles.css',
  '/dist/tweaks-panel.js',
  '/dist/icons.js',
  '/dist/utils.js',
  '/dist/i18n.js',
  '/dist/shell.js',
  '/dist/pages/monitoring.js',
  '/dist/pages/players.js',
  '/dist/pages/logs.js',
  '/dist/pages/content.js',
  '/dist/pages/tracks.js',
  '/dist/pages/session.js',
  '/dist/pages/settings.js',
  '/dist/pages/users.js',
  '/dist/pages/profile.js',
  '/dist/pages/audit.js',
  '/dist/pages/laptimes.js',
  '/dist/pages/mods.js',
  '/dist/app.js',
  '/dist/sw-register.js',
  '/src/assets/icon.png',
  '/src/assets/icon-192.png',
  '/src/assets/icon-512.png',
  '/manifest.webmanifest',
];

// ── Install: pre-cache static shell ──────────────────────────────────────────
// Fetch each asset individually so a single 404 (e.g. a renamed file behind
// Cloudflare) does not abort the whole install and leave clients on the old SW.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        PRECACHE.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((res) => { if (res.ok) return cache.put(url, res); })
            .catch(() => {})
        )
      )
    )
  );
  self.skipWaiting();
});

// ── Activate: remove old caches ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
    // When a new SW version takes over, every open tab is still rendering
    // the pre-upgrade JS. Asking each window client to navigate to itself
    // forces a clean reload that picks up the fresh /dist/* bundles served
    // by the new network-first strategy — no more "F5 leaves the page blank"
    // because of a stale cached bundle paired with new HTML.
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) {
      try { c.navigate(c.url); } catch {}
    }
  })());
});

// ── Fetch: network-first for /api/, cache-first for static assets ─────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept uploads — SW's fetch(request) can corrupt large POST bodies.
  // The chunk endpoint is the documented offender (docs/troubleshooting.md), but
  // the multipart `/api/mods/upload` carries the same risk for big archives.
  if (url.pathname === '/api/mods/upload/chunk') return;
  if (url.pathname === '/api/mods/upload')       return;

  // Selected GETs are cached for offline read-only browsing (PWA mode). The
  // cache is updated on every successful network response; if the network is
  // unreachable the SW returns the last good response with a header marker so
  // the UI can hint that data may be stale.
  //
  // NEVER add an endpoint here whose response contains secrets. /api/config is
  // explicitly excluded: for admins it returns the AC server PASSWORD and
  // ADMIN_PASSWORD in clear text, and Cache Storage persists to disk — those
  // values would survive logout and remain readable by any later XSS or by
  // anyone with filesystem access to the browser profile.
  const OFFLINE_API_PATHS = ['/api/cars', '/api/tracks', '/api/results', '/api/players/history'];
  const isOfflineable = request.method === 'GET'
    && url.pathname.startsWith(API_PREFIX)
    && OFFLINE_API_PATHS.includes(url.pathname);

  // Always go network-first for API calls (real-time data).
  // Cache key uses the Request object (full URL incl. query string) so filtered
  // endpoints — `/api/results?driver=alice` vs `?driver=bob` — keep distinct
  // offline copies instead of clobbering each other under the same pathname.
  if (url.pathname.startsWith(API_PREFIX)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        if (isOfflineable && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone)).catch(() => {});
        }
        return res;
      } catch {
        if (isOfflineable) {
          const cached = await caches.match(request);
          if (cached) {
            const headers = new Headers(cached.headers);
            headers.set('X-AC-Cache', 'stale-offline');
            return new Response(await cached.clone().blob(), { status: cached.status, statusText: cached.statusText, headers });
          }
        }
        return new Response(JSON.stringify({ error: 'Offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    })());
    return;
  }

  // Network-first for the HTML shell so security headers and UI changes propagate
  // without users needing to manually clear cache. Cache fallback keeps the panel
  // usable when the server is briefly unreachable.
  const isNavigation = request.mode === 'navigate'
    || url.pathname === '/' || url.pathname === '/index.html';
  if (isNavigation) {
    event.respondWith(
      fetch(request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('/index.html').then((cached) =>
        cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
      ))
    );
    return;
  }

  // Cross-origin requests (React/ReactDOM on unpkg, Google fonts) — let the
  // browser handle them natively without SW interception. When the SW does
  // `fetch(request)` against a foreign origin the call is governed by the
  // page's CSP `connect-src` directive (not `script-src` like a normal
  // <script> tag would be), so a strict `connect-src 'self'` blocks it and
  // the page ends up without React. Skipping respondWith returns control to
  // the browser, which honours the `script-src` allowlist correctly.
  if (url.origin !== self.location.origin) return;

  // /dist/ JS bundles: NETWORK-FIRST so an F5 after a code deploy always pulls
  // the new build instead of serving a stale entry from the previous SW
  // version. The cache is still populated so an offline navigation keeps the
  // panel usable. Switched from stale-while-revalidate after observing blank
  // pages on F5 when the old cached bundle didn't pair with the new HTML.
  if (url.pathname.startsWith('/dist/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone());
          return res;
        } catch {
          const cached = await cache.match(request);
          return cached || new Response('Offline', { status: 503 });
        }
      })
    );
    return;
  }

  // Stale-while-revalidate for everything else local (icons, css, manifest).
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request).then((res) => {
        if (res.ok) cache.put(request, res.clone());
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
