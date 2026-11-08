/// <reference lib="webworker" />
import { JsonStore } from '@ordo/cache';
import { isControl, reportFatal, startHeartbeat } from '@ordo/client';
import { CoreEngine } from './engine.ts';
import type { CoreToMain, MainToCore } from './protocol.ts';

/**
 * The operator's core worker (design/25): hub socket and clock, optimistic live state, fallback-bus
 * authority over MessagePorts, library and search, service-cache fill, health aggregation, budgets.
 * Supervised by the main thread: heartbeats every 250 ms; an uncaught error asks for a clean restart,
 * and the restarted core rebuilds from IndexedDB and a hub resync.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: CoreToMain, transfer: Transferable[] = []) => scope.postMessage(m, transfer);
const engine = new CoreEngine(post, new JsonStore('ordo-operator'));
engine.onFatal = (reason) => reportFatal(scope, reason);
const queue: MainToCore[] = [];
let ready = false;

startHeartbeat(scope);

scope.onmessage = (ev: MessageEvent<MainToCore>) => {
  const m = ev.data;
  if (!m || typeof m !== 'object' || isControl(m)) return;
  if (m.t === 'init') {
    void engine
      .init(m)
      .then(() => {
        ready = true;
        for (const q of queue.splice(0)) engine.handle(q);
      })
      .catch((e) => reportFatal(scope, `init failed: ${String(e)}`));
    return;
  }
  // Ports and ticks are cheap and safe before init; everything else waits for the restored state.
  if (!ready && m.t !== 'tick') {
    queue.push(m);
    return;
  }
  try {
    engine.handle(m);
  } catch (e) {
    engine.log('error', `core: ${m.t}: ${String(e)}`);
  }
};

scope.addEventListener('error', (e) => {
  reportFatal(scope, `uncaught: ${e.message}`);
});
scope.addEventListener('unhandledrejection', (e) => {
  engine.log('error', `core unhandled rejection: ${String(e.reason)}`);
});
