/**
 * Source of the stage window's service worker (design/17): precache the app shell on install and serve it
 * cache-first so a reload with the hub down still shows the stage. Only the precached files and a
 * navigation to the app root are handled; /api, /ws and everything else go to the network.
 */
export function swSource(files: string[], version: string): string {
  const list = JSON.stringify(files.map((f) => f.replace(/^\.?\//, '')));
  return `/* ordo stage service worker ${version} (generated) */
const VERSION = ${JSON.stringify(version)};
const CACHE = 'ordo-stage-shell-' + VERSION;
const FILES = ${list};
const scopeUrl = new URL(self.registration ? self.registration.scope : './', self.location.href);
const PRECACHE = FILES.map((f) => new URL(f, scopeUrl).href);
const SHELL = new URL('index.html', scopeUrl).href;

function isNeverCached(url) {
  return url.pathname.includes('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/ws/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ordo-stage-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isNeverCached(url)) return;
  const isRootNav = req.mode === 'navigate' && (url.pathname === scopeUrl.pathname || url.href.split('?')[0].split('#')[0] === SHELL);
  const clean = url.origin + url.pathname;
  if (!isRootNav && !PRECACHE.includes(clean)) return;
  const key = isRootNav ? SHELL : clean;
  event.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(key).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') c.put(key, res.clone());
          return res;
        });
      }),
    ),
  );
});
`;
}
