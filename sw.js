// Assetto Server Panel — Service Worker
// Strategy:
//   - /api/*                : network-first (no cache)
//   - / and /index.html     : network-first with cache fallback (so security/UI
//                             updates ship without manual SW bumps)
//   - cross-origin (CDN)    : stale-while-revalidate
//   - same-origin static    : stale-while-revalidate

// Bump on every behaviour change so old caches are dropped at activate-time.
const CACHE_NAME  = 'ac-panel-v15';
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
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
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
  const OFFLINE_API_PATHS = ['/api/cars', '/api/tracks', '/api/config', '/api/results', '/api/players/history'];
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

  // Stale-while-revalidate for CDN scripts (React, Babel, fonts)
  if (url.origin !== self.location.origin) {
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
    return;
  }

  // Stale-while-revalidate for local static files (serves cache, updates in background)
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
