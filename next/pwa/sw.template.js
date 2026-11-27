/*
 * CinemaVault service worker — APP SHELL ONLY.
 *
 * What it does:   keeps the app's own code (JS, CSS, icons, manifest, index.html) so the app can
 *                 open with no network. The library itself is NOT handled here: it lives in
 *                 IndexedDB, per signed-in user (src/data/local).
 * What it never does:
 *   - cache any response it got from the network at run time (so an auth redirect, a Supabase
 *     answer, or anything user-specific can never end up in Cache Storage);
 *   - touch cross-origin requests (Supabase, TMDB, Google Fonts) or anything under /api/;
 *   - touch non-GET requests;
 *   - activate a new version underneath a running page (no automatic skipWaiting): the page asks
 *     for it, and reloads when the user presses "Reload".
 *
 * The version and the file list below are filled in at build time by vite-plugins/pwa.ts.
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE_PREFIX = 'cv-shell-';
const SHELL_CACHE = CACHE_PREFIX + VERSION;
const INDEX_URL = '/index.html';
const PRECACHED = new Set(PRECACHE);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        PRECACHE.map(async (url) => {
          // `reload` bypasses the HTTP cache so a half-stale shell can never be pinned.
          const response = await fetch(new Request(url, { cache: 'reload' }));
          // A failed or redirected file must fail the whole install: better to keep the old
          // worker than to activate one that cannot open the app.
          if (!response.ok || response.redirected) {
            throw new Error('Precache failed for ' + url + ' (' + response.status + ')');
          }
          await cache.put(url, response);
        }),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    // Network first: a deploy is picked up immediately and auth redirects are always live.
    // Only when the network itself fails do we fall back to the saved shell.
    event.respondWith(
      fetch(request).catch(async () => {
        const shell = await caches.match(INDEX_URL, { cacheName: SHELL_CACHE });
        return shell || Response.error();
      }),
    );
    return;
  }

  if (PRECACHED.has(url.pathname)) {
    // Fingerprinted build output: the cached copy is exactly what the network would return.
    event.respondWith(
      (async () => {
        const hit = await caches.match(url.pathname, { cacheName: SHELL_CACHE });
        return hit || fetch(request);
      })(),
    );
  }
  // Anything else: not ours, let the browser handle it.
});
