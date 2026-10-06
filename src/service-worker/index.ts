import { self } from '$app/service-worker';
import { version } from '$app/env';
import { immutable, assets } from '$app/manifest';

// Cache only public, deployment-owned files. Relay traffic, uploaded media,
// profiles, credentials and message data never enter this cache.
const scope = new URL(self.registration.scope);
const prefix = `anagram-shell-${encodeURIComponent(scope.pathname)}-`;
const cacheName = `${prefix}${version}`;
const shell = new URL('index.html', scope).href;
const urls = new Set([
  shell,
  ...immutable.map(({ path }) => new URL(path.replace(/^\//, ''), scope).href),
  ...assets
    .filter(({ path }) => !path.endsWith('.d.ts') && !path.endsWith('.txt'))
    .map(({ path }) => new URL(path.replace(/^\//, ''), scope).href),
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      await cache.addAll([...urls].map((url) => new Request(url, { cache: 'reload' })));
      // No skipWaiting: a deployment must not interrupt calls/drafts in open tabs.
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith(prefix) && name !== cacheName) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    request.cache === 'no-store' ||
    url.origin !== scope.origin ||
    request.headers.has('range')
  )
    return;
  if (request.mode === 'navigate') {
    // Serve the HTML belonging to this worker, not a newer deployment's HTML
    // whose hashed chunks may not be cached. Deep links work offline too.
    event.respondWith(
      (async () => (await (await caches.open(cacheName)).match(shell)) ?? fetch(request))(),
    );
    return;
  }
  url.search = '';
  if (!urls.has(url.href)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      const saved = await cache.match(url.href);
      if (saved) return saved;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') await cache.put(url.href, response.clone());
      return response;
    })(),
  );
});
