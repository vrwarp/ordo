/// <reference lib="webworker" />
import { type KeysIn, keysOf } from './bakeKeys.ts';

/** The keys worker (see bakeKeys.ts): answers each `keys` message with the keys of its slides. Not supervised, one-shot. */
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (ev: MessageEvent<KeysIn>) => {
  const m = ev.data;
  if (!m || typeof m !== 'object' || m.t !== 'keys') return;
  scope.postMessage(keysOf(m));
};
