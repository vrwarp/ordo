/**
 * Source of the operator's service worker (design/17, ADR 0013 "Service worker caching"): precache the
 * app shell on install. Navigations to the app root are network-first with a timeout (so a new deploy is
 * picked up on the next reload) and fall back to the cached shell, so a reload with the hub down still
 * loads the app. Hashed assets are cache-first. Only the precached files and a navigation to the app root
 * are handled; /api, /ws and every other path (including /output/ and /stage/ in path mode) pass straight
 * to the network.
 */
export const SW_NAV_TIMEOUT_MS = 4000;

export function swSource(files: string[], version: string, navTimeoutMs = SW_NAV_TIMEOUT_MS): string {
  const list = JSON.stringify(files.map((f) => f.replace(/^\.?\//, '')));
  return `/* ordo operator service worker ${version} (generated) */
const VERSION = ${JSON.stringify(version)};
const CACHE = 'ordo-shell-' + VERSION;
const FILES = ${list};
const NAV_TIMEOUT_MS = ${navTimeoutMs};
const scopeUrl = new URL(self.registration ? self.registration.scope : './', self.location.href);
const PRECACHE = FILES.map((f) => new URL(f, scopeUrl).href);
const SHELL = new URL('index.html', scopeUrl).href;

function isNeverCached(url) {
  return url.pathname.includes('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/ws/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ordo-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Fetch from the network and refresh the cache entry. For a navigation a 5xx (the reverse proxy while the
 * hub restarts) counts as a failure so the cached shell is served instead.
 */
function fromNetwork(cache, req, key, strict) {
  return fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(key, res.clone());
    if (strict && res.status >= 500) throw new Error('HTTP ' + res.status);
    return res;
  });
}

/** Network-first with a timeout, then the cached shell; with nothing cached, whatever the network says. */
function navigationResponse(cache, req, key) {
  let timer;
  const network = fromNetwork(cache, req, key, true);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), NAV_TIMEOUT_MS);
  });
  return Promise.race([network, timeout])
    .then((res) => {
      clearTimeout(timer);
      return res;
    })
    .catch(() =>
      cache.match(key).then((hit) => {
        clearTimeout(timer);
        if (hit) return hit;
        return network;
      }),
    );
}

/** Cache-first: hashed assets never change under the same name. */
function assetResponse(cache, req, key) {
  return cache.match(key).then((hit) => hit || fromNetwork(cache, req, key, false));
}

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
    caches.open(CACHE).then((c) => (isRootNav ? navigationResponse(c, req, key) : assetResponse(c, req, key))),
  );
});
`;
}
