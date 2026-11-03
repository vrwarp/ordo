/* ordo output service worker: app-shell precache, cache-first (design/17).
 *
 * - Install: precache index.html and every built file listed in precache.json (written at build time).
 * - Navigations: network first with a short timeout (a fresh deploy is picked up on the next load),
 *   falling back to the cached shell when the hub is unreachable.
 * - Everything else under this scope: cache first, network fallback (and cached on the way).
 * - Never touches /api/ or /ws (live data, files and auth go to the hub or the OPFS service cache).
 */
const PREFIX = 'ordo-output-shell';
const CACHE = `${PREFIX}-v1`;
const SCOPE = new URL(self.registration.scope);
const SHELL = new URL('index.html', SCOPE).href;
const MANIFEST = new URL('precache.json', SCOPE).href;

function bypass(url) {
  return url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/ws/') || !url.href.startsWith(SCOPE.href);
}

async function readManifest() {
  const res = await fetch(MANIFEST, { cache: 'no-store' });
  if (!res.ok) throw new Error(`precache.json ${res.status}`);
  return res.json();
}

async function precache(manifest) {
  const cache = await caches.open(CACHE);
  const urls = [...new Set([SHELL, ...manifest.files.map((f) => new URL(f, SCOPE).href)])];
  await cache.addAll(urls.map((u) => new Request(u, { cache: 'reload' })));
  // Drop shell files of older builds.
  const keep = new Set(urls);
  for (const req of await cache.keys()) if (!keep.has(req.url) && req.url !== MANIFEST) await cache.delete(req);
  await cache.put(MANIFEST, new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } }));
}

async function refresh() {
  try {
    const manifest = await readManifest();
    const cache = await caches.open(CACHE);
    const old = await cache.match(MANIFEST);
    const oldVersion = old ? (await old.json()).version : undefined;
    if (oldVersion !== manifest.version) await precache(manifest);
  } catch {
    /* offline or dev build without precache.json */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        await precache(await readManifest());
      } catch {
        // Dev server or no manifest: cache the shell alone.
        const cache = await caches.open(CACHE);
        await cache.add(SHELL).catch(() => undefined);
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (bypass(url)) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await Promise.race([fetch(req), timeout(4000)]);
          if (res.ok) {
            await cache.put(SHELL, res.clone());
            event.waitUntil(refresh());
            return res;
          }
          throw new Error(`HTTP ${res.status}`);
        } catch {
          const hit = await cache.match(SHELL);
          return hit ?? Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') await cache.put(req, res.clone()).catch(() => undefined);
      return res;
    })(),
  );
});
