import type { LiveState } from '@ordo/domain';
import type { OutputHealthEntry } from '@ordo/protocol';

export type Dot = 'green' | 'amber' | 'red' | 'grey';

/** Overall health dot for an output in the top bar. */
export function outputDot(h: OutputHealthEntry | undefined, now = Date.now()): Dot {
  if (!h || !h.connected) return 'red';
  if (now - h.lastSeen > 5000) return 'red';
  if (h.error || h.audio === 'lost' || h.armedOk === false) return 'red';
  if (h.cache.total > 0 && h.cache.ready < h.cache.total) return 'amber';
  if (h.bus === 'fallback') return 'amber';
  return 'green';
}

/** Per-output arm marker for a cue: grey (not armed), amber (arming), green (armed), red (failed). */
export function armDot(h: OutputHealthEntry | undefined, cueIndex: number, state: LiveState): Dot {
  if (!h || !h.connected) return 'grey';
  if (h.armed === cueIndex) {
    if (h.armedOk === false) return 'red';
    if (h.armedOk === true) return 'green';
    return 'amber';
  }
  if (h.live === cueIndex && state.live === cueIndex) return 'green';
  if (state.armed === cueIndex) return 'amber';
  return 'grey';
}

/** Whether an output is still waiting to show the live cue (GO on an unarmed slide). */
export function waitingForLive(h: OutputHealthEntry | undefined, state: LiveState): boolean {
  if (!h || !h.connected || state.live === undefined) return false;
  return h.live !== state.live;
}

/** Minimum cache progress across windows (the operator's own fill counts as one window). */
export function cacheSummary(
  entries: OutputHealthEntry[],
  own?: { ready: number; total: number },
): { ready: number; total: number; frac: number } {
  let worst = own && own.total > 0 ? own.ready / own.total : 1;
  let ready = own?.ready ?? 0;
  let total = own?.total ?? 0;
  for (const h of entries) {
    if (!h.connected || h.cache.total === 0) continue;
    const f = h.cache.ready / h.cache.total;
    if (f < worst) {
      worst = f;
      ready = h.cache.ready;
      total = h.cache.total;
    }
  }
  return { ready, total, frac: worst };
}

export function dotTitle(h: OutputHealthEntry | undefined, name: string): string {
  if (!h) return `${name}: not connected`;
  return [
    `${name}: ${h.connected ? 'connected' : 'disconnected'}${h.bus ? ` via ${h.bus}` : ''}`,
    `frames ${h.presented}, missed ${h.missed}, long tasks ${h.longTasks}, late flips ${h.lateFlips ?? 0}`,
    `cache ${h.cache.ready}/${h.cache.total}`,
    h.fps !== undefined ? `fps ${h.fps.toFixed(1)}` : '',
    h.gpuLost ? `GPU lost ${h.gpuLost}×` : '',
    h.videoDropped ? `video dropped ${h.videoDropped}` : '',
    h.audio ? `audio ${h.audio}` : '',
    h.error ? `error: ${h.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
