import { CacheApiStore, type FileStore, JsonStore, MemoryStore } from '@ordo/cache';
import {
  api,
  FallbackClient,
  isControl,
  OutputLink,
  portEndpoint,
  reportFatal,
  startHeartbeat,
} from '@ordo/client';
import { APP_VERSION, type OutputConfigRes, ROUTES } from '@ordo/protocol';
import { MuxEndpoint } from './bus.ts';
import { StageLinkCore } from './link-core.ts';
import type { LinkToMain, MainToLink } from './protocol.ts';

/**
 * Stage link worker (design/16, design/25): the stage window's socket, live mirror, config, fonts,
 * timers, persistence, invariants and health, off the main thread. Supervised by the host: it posts a
 * heartbeat every 250 ms and is restarted (painting again from IndexedDB) when it dies.
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

let core: StageLinkCore | undefined;
let mux: MuxEndpoint | undefined;
const early: MainToLink[] = [];

scope.addEventListener('unhandledrejection', (e) => {
  console.error('[ordo stage link] unhandled rejection', e.reason);
  core?.diagLog(`unhandled rejection: ${String((e.reason as Error)?.message ?? e.reason).slice(0, 200)}`);
});

function init(m: Extract<MainToLink, { t: 'init' }>): void {
  let fallback: FallbackClient | null = null;
  if (m.bridge) {
    mux = new MuxEndpoint(portEndpoint(m.bridge));
    fallback = new FallbackClient({ endpoint: mux, outputId: m.outputId });
  }
  const link = new OutputLink({
    role: 'stage',
    appVersion: APP_VERSION,
    outputId: m.outputId,
    token: m.token,
    fallback,
  });
  let store: FileStore;
  try {
    store = typeof caches !== 'undefined' ? new CacheApiStore('ordo-files') : new MemoryStore();
  } catch {
    store = new MemoryStore();
  }
  const json = new JsonStore('ordo-stage');
  core = new StageLinkCore({
    link,
    json,
    store,
    post,
    loadConfig: () => api<OutputConfigRes>(ROUTES.outputConfig),
    testMode: m.testMode,
    loadedFonts: m.loadedFonts,
  });
  json.onLog = (l) => core?.diagLog(l);
  if (m.generation > 0) core.diagLog(`link worker restarted (generation ${m.generation})`);
  for (const x of early.splice(0)) handle(x);
  core.start(m.reloadReason).catch((err: Error) => {
    reportFatal(scope, `stage link start failed: ${err.message}`);
  });
}

function handle(m: MainToLink): void {
  const c = core;
  if (!c) {
    if (m.t !== 'host' && m.t !== 'tick') early.push(m);
    return;
  }
  switch (m.t) {
    case 'busPort':
      mux?.setPort(portEndpoint(m.port));
      c.diagLog('fallback bus: new port from the operator');
      return;
    case 'opener':
      c.setOpenerClosed(m.closed);
      return;
    case 'host':
      c.onHost(m.stats);
      return;
    case 'tick':
      c.onTick();
      return;
    case 'fontAck':
      c.onFontAck(m.hash, m.ok, m.error);
      return;
    case 'chaos':
      if (m.k === 'badState') c.injectBadState();
      else c.injectFromHub(m.k, m.msg);
      return;
    case 'init':
      return;
  }
}

scope.onmessage = (ev) => {
  const m = ev.data;
  if (isControl(m)) return;
  if (!m || typeof m !== 'object') return;
  if (m.t === 'init') {
    if (!core) init(m);
    return;
  }
  handle(m);
};
