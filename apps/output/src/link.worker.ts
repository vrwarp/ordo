import { JsonStore } from '@ordo/cache';
import {
  FallbackClient,
  OutputLink,
  isControl,
  portEndpoint,
  reportFatal,
  startHeartbeat,
} from '@ordo/client';
import { APP_VERSION } from '@ordo/protocol';
import { MuxEndpoint } from './bus.ts';
import type { LinkToMain, MainToLink } from './host-protocol.ts';
import { LinkCore } from './link-core.ts';
import { MemoryStreamStore, OpfsStreamStore, type StreamStore } from './opfs.ts';

/**
 * Link worker (design/25): the output window's networking, live state, service cache, persistence,
 * planning, arming and health, off the main thread. Talks to the render and asset workers over ports the
 * host hands over, and to the host with typed commands (host-protocol.ts). Supervised by the host: it
 * posts a heartbeat every 250 ms and is restarted from IndexedDB and OPFS when it dies.
 */

const scope = self as unknown as {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<MainToLink>) => void) | null;
  addEventListener(t: 'unhandledrejection', fn: (e: PromiseRejectionEvent) => void): void;
};

function post(m: LinkToMain, transfer: Transferable[] = []): void {
  scope.postMessage(m, transfer);
}

startHeartbeat(scope);

let core: LinkCore | undefined;
let mux: MuxEndpoint | undefined;
const early: MainToLink[] = [];

scope.addEventListener('unhandledrejection', (e) => {
  console.error('[ordo link] unhandled rejection', e.reason);
});

function init(m: Extract<MainToLink, { t: 'init' }>): void {
  mux = new MuxEndpoint(portEndpoint(m.bridge));
  if (m.busPort) mux.setPort(portEndpoint(m.busPort));
  const fallback = new FallbackClient({ endpoint: mux, outputId: m.outputId });
  const link = new OutputLink({
    role: 'output',
    appVersion: APP_VERSION,
    outputId: m.outputId,
    token: m.token,
    fallback,
  });
  let store: StreamStore;
  try {
    store =
      typeof navigator.storage?.getDirectory === 'function'
        ? new OpfsStreamStore()
        : new MemoryStreamStore(true);
  } catch {
    store = new MemoryStreamStore(true);
  }
  const json = new JsonStore('ordo-output');
  core = new LinkCore({ link, store, json, post, width: m.width, height: m.height, testMode: m.testMode });
  json.onLog = (l) => core?.diagLog(l);
  if (m.generation > 0) core.diagLog(`link worker restarted (generation ${m.generation})`);
  for (const x of early.splice(0)) handle(x);
  core.start(m.reloadReason).catch((err: Error) => {
    reportFatal(scope, `link start failed: ${err.message}`);
  });
}

function handle(m: MainToLink): void {
  const c = core;
  if (!c) {
    if (m.t !== 'tick' && m.t !== 'host') early.push(m);
    return;
  }
  switch (m.t) {
    case 'ports':
      c.onPorts(m.render, m.asset, m.gens);
      return;
    case 'busPort':
      mux?.setPort(portEndpoint(m.port));
      c.diagLog('fallback bus: new port from the operator');
      // Answer on the new port at once, so the operator knows it works even while the hub is the authority.
      c.link.fallback?.ready(c.link.mirror.state.seq);
      return;
    case 'tick':
      c.onTick();
      return;
    case 'host':
      c.onHost(m.status);
      return;
    case 'opener':
      c.setOpenerClosed(m.closed);
      return;
    case 'media':
      c.onMediaEvent(m.ev, m.replay);
      // Handled: the host need not keep it for a successor (review 2026-11-04 item 2).
      if (m.n !== undefined) post({ t: 'mediaAck', n: m.n });
      return;
    case 'hubSend':
      c.link.hub.send(m.msg);
      return;
    case 'chaos':
      if (m.action === 'injectDelta') c.injectDelta(m.delta);
      else void c.verifyCache(true);
      return;
    case 'init':
      return;
  }
}

scope.onmessage = (ev) => {
  const m = ev.data;
  if (isControl(m)) return;
  if (m.t === 'init') {
    if (!core) init(m);
    return;
  }
  handle(m);
};
