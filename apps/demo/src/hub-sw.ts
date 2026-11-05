/// <reference lib="webworker" />
import { handle, setScope } from './hub.ts';

/**
 * The demo hub service worker (GitHub Pages). Registered by the operator, output and stage apps built with
 * ORDO_DEMO=1, with the site root as its scope; it answers every `/api/v1/*` request those pages and their
 * workers make (hub.ts). Everything else goes to the network (the site is static).
 */
declare const self: ServiceWorkerGlobalScope;

setScope(self.registration.scope);

self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.includes('/api/v1/')) return;
  e.respondWith(handle(e.request));
});
