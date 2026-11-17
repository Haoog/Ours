const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = `ours-web-${encodeURIComponent(SCOPE.pathname)}-`;
// The build substitutes a content-derived version; direct development uses unversioned URLs.
const BUILD_VERSION = 'dev';
const BUILD_ASSETS = null;
const CACHE = `${CACHE_PREFIX}v2-${BUILD_VERSION}`;
// The build supplies the deployed files; the fallback supports the development server.
const ASSET_PATHS = BUILD_ASSETS || ['./', './index.html', './styles.css', './app.js', './storage.js', './sync.js', './sync-engine.js', './backup.js', './wx-import.js', './wx-prepare.js', './manifest.webmanifest', './assets/icon.svg', './assets/icon-180.png', './assets/icon-192.png', './assets/icon-512.png', './assets/walk.svg', './assets/evening.svg', './assets/table.svg'];
const ASSETS = ASSET_PATHS.map(asset => BUILD_VERSION === 'dev' || asset === './' || asset === './index.html' ? asset : `${asset}?v=${BUILD_VERSION}`);
const ASSET_URLS = new Set(ASSETS.map(asset => new URL(asset, SCOPE).href));
// CSS and script-generated URLs can still refer to a precached file without ?v=.
const ASSET_ALIASES = new Map(ASSET_PATHS.map((asset, index) => [new URL(asset, SCOPE).href, new URL(ASSETS[index], SCOPE).href]));
const ASSET_DESTINATIONS = new Set(['script', 'style', 'image', 'font', 'manifest', 'worker', 'sharedworker']);
const INDEX_URL = new URL('./index.html', SCOPE).href;

self.addEventListener('install', event => {
  // Bypass the browser's HTTP cache when migrating an existing installation.
  const requests = ASSETS.map(asset => new Request(new URL(asset, SCOPE), { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(requests)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

async function networkFirst(request, cacheKey, cacheResponse = true, fallbackKey = null) {
  // A cache failure must not prevent the page from loading while online.
  const cache = await caches.open(CACHE).catch(() => null);
  const cachedResponse = async () => {
    if (!cache) return null;
    return await cache.match(cacheKey).catch(() => null) ||
      (fallbackKey && await cache.match(fallbackKey).catch(() => null));
  };
  try {
    // Revalidate even when the browser previously received a long-lived HTTP cache entry.
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.status >= 500) {
      const cached = await cachedResponse();
      if (cached) return cached;
    }
    if (response.ok && cache && cacheResponse) {
      await cache.put(cacheKey, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cachedResponse();
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;

  if (request.mode === 'navigate') {
    const isIndex = url.pathname === SCOPE.pathname || url.pathname === new URL(INDEX_URL).pathname;
    event.respondWith(networkFirst(request, INDEX_URL, isIndex));
  } else if (ASSET_URLS.has(url.href) || ASSET_ALIASES.has(url.href) || ASSET_DESTINATIONS.has(request.destination)) {
    event.respondWith(networkFirst(request, request, true, ASSET_ALIASES.get(url.href)));
  }
});
