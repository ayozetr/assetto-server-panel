// Assetto Server Panel — Service Worker
// Strategy: Network-first for API calls, Cache-first for static assets

const CACHE_NAME  = 'ac-panel-v10';
const API_PREFIX  = '/api/';

// Static assets to pre-cache on install
const PRECACHE = [
  '/',
  '/src/styles.css',
  '/src/tweaks-panel.jsx',
  '/src/icons.jsx',
  '/src/utils.jsx',
  '/src/i18n.jsx',
  '/src/shell.jsx',
  '/src/pages/monitoring.jsx',
  '/src/pages/content.jsx',
  '/src/pages/settings.jsx',
  '/src/pages/laptimes.jsx',
  '/src/pages/mods.jsx',
  '/src/app.jsx',
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

  // Never intercept chunk uploads — SW's fetch(request) corrupts large POST bodies
  if (url.pathname === '/api/mods/upload/chunk') return;

  // Always go network-first for API calls (real-time data)
  if (url.pathname.startsWith(API_PREFIX)) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
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
