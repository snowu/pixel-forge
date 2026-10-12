/* App-shell offline cache, scoped to this editor. Network first keeps deploys fresh.
   GitHub requests and repository files never enter this cache. */
const PREFIX = 'spritewright-shell-';
const CACHE = PREFIX + '__BUILD__';
const SHELL = ['./', './index.html', './spritewright.js', './install.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];
const shellUrls = new Set(SHELL.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = ''; url.hash = '';
  if (!shellUrls.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(url.href, response.clone());
      return response;
    } catch {
      const cached = await cache.match(url.href);
      return cached || Response.error();
    }
  })());
});
