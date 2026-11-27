/// <reference lib="webworker" />
import { handle, setScope } from './hub.ts';
import { getDoc, putDoc } from './store.ts';
import type { DemoHubMode, RelayReply, RelayRequest } from './vm-wire.ts';

/**
 * The demo hub service worker (GitHub Pages). Registered by the operator, output and stage apps built with
 * ORDO_DEMO=1, with the site root as its scope; it answers every `/api/v1/*` request those pages and their
 * workers make. Everything else goes to the network (the site is static).
 *
 * Two hubs, chosen by the operator page (packages/client demo.ts) and kept here (`mode`):
 * - 'vm' (docs/design/26-pages-demo.md, "The VM hub"): the real hub runs in a Linux machine in the operator tab
 *   (vm-host.ts). This worker only relays: each request goes to the window clients, the VM host accepts it and streams
 *   the hub's answer back. With no host to accept (the operator tab is closed), 503.
 * - 'legacy': the hub's REST API answered here, in the worker (hub.ts), for browsers that cannot run the machine.
 *
 * `GET …/api/v1/__demo/mode` answers the mode itself (`{ mode }`): the pages and workers ask it before they open a
 * hub socket. The operator sets it with a message `{ t: 'ordo-demo-mode', mode }`, answered on the message's port.
 */
declare const self: ServiceWorkerGlobalScope;

setScope(self.registration.scope);

let mode: DemoHubMode | undefined;
async function currentMode(): Promise<DemoHubMode> {
  mode ??= (await getDoc<DemoHubMode>('mode').catch(() => undefined)) ?? 'legacy';
  return mode;
}

const ACCEPT_MS = 5000;
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One request to the VM host in a window of this site, streamed back. */
async function relay(request: Request, path: string): Promise<Response> {
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
  const headers: [string, string][] = [];
  request.headers.forEach((v, k) => {
    headers.push([k, v]);
  });
  const msg: RelayRequest = { t: 'ordo-vm-fetch', method: request.method, path, headers, body };
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return new Promise<Response>((resolve) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settled = false;
    let chosen: MessagePort | undefined;
    const ports: MessagePort[] = [];
    const fail = (status: number, message: string) => {
      if (settled) return controller?.error(new Error(message));
      settled = true;
      for (const p of ports) p.close();
      resolve(json({ error: { code: 'demo_hub_unavailable', message } }, status));
    };
    const timer = setTimeout(
      () =>
        fail(
          503,
          'The demo hub runs in the ordo operator tab of this browser: open the operator (the demo’s main page) to use it.',
        ),
      ACCEPT_MS,
    );
    // Every window gets the request on a port of its own; the one that runs the VM host accepts it.
    for (const w of windows) {
      const ch = new MessageChannel();
      const port = ch.port1;
      ports.push(port);
      port.onmessage = (ev: MessageEvent<RelayReply>) => {
        const m = ev.data;
        if (m.t === 'accept') {
          if (chosen) return port.close();
          chosen = port;
          clearTimeout(timer);
          for (const p of ports) if (p !== port) p.close();
          return;
        }
        if (port !== chosen) return;
        if (m.t === 'head') {
          settled = true;
          const nullBody = request.method === 'HEAD' || [101, 204, 205, 304].includes(m.status);
          const stream = nullBody
            ? null
            : new ReadableStream<Uint8Array>({
                start(c) {
                  controller = c;
                },
                cancel() {
                  port.close();
                },
              });
          resolve(new Response(stream, { status: m.status, statusText: m.statusText, headers: m.headers }));
        } else if (m.t === 'chunk') controller?.enqueue(new Uint8Array(m.data));
        else if (m.t === 'end') {
          controller?.close();
          port.close();
        } else if (m.t === 'error') {
          fail(m.status, m.message);
          port.close();
        }
      };
      w.postMessage(msg, [ch.port2]);
    }
    if (!windows.length) {
      clearTimeout(timer);
      fail(503, 'No ordo window is open.');
    }
  });
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const at = url.pathname.indexOf('/api/v1/');
  const path = url.pathname.slice(at) + url.search;
  if (path.startsWith('/api/v1/__demo/mode')) return json({ mode: await currentMode() }, 200);
  if ((await currentMode()) === 'vm') return relay(request, path);
  return handle(request);
}

self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('message', (e: ExtendableMessageEvent) => {
  const m = e.data as { t?: string; mode?: DemoHubMode } | undefined;
  if (m?.t !== 'ordo-demo-mode' || (m.mode !== 'vm' && m.mode !== 'legacy')) return;
  mode = m.mode;
  e.waitUntil(
    putDoc('mode', m.mode)
      .catch(() => undefined)
      .then(() => e.ports[0]?.postMessage({ ok: true })),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.includes('/api/v1/')) return;
  e.respondWith(route(e.request));
});
