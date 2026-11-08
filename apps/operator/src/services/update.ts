import type { Emitter } from '@ordo/client';
import { create } from 'zustand';
import {
  nextUpdateAttempt,
  parseAttempts,
  UPDATE_RETRY_CAP,
  type UpdatePhase,
  updatePhaseOnLoad,
} from '../lib/update.ts';
import { log } from './log.ts';

const KEY = 'ordo.op.updateAttempts';

export type UpdateStore = { phase: UpdatePhase; attempt: number; cap: number; hubVersion?: string };

function readAttempts(): number {
  try {
    return parseAttempts(sessionStorage.getItem(KEY));
  } catch {
    return 0;
  }
}

function writeAttempts(n: number): void {
  try {
    if (n > 0) sessionStorage.setItem(KEY, String(n));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the cap cannot be enforced, the reload still happens */
  }
}

/** Decided once per page load, before the hub connection starts, so a failed update cannot loop. */
export const useUpdate = create<UpdateStore>(() => {
  const attempt = readAttempts();
  return { phase: updatePhaseOnLoad(attempt), attempt, cap: UPDATE_RETRY_CAP };
});

/**
 * Watch the hub connection: a `bye: version` means this tab is stale and the client reloads in 500 ms.
 * Show "Updating…" meanwhile and count the attempt; a welcome (versions agree) clears the count.
 */
export type UpdateSource = Pick<Emitter<{ bye: { reason: string }; welcome: { appVersion: string } }>, 'on'>;

export function installUpdateGuard(hub: UpdateSource): () => void {
  const offBye = hub.on('bye', (m) => {
    if (m.reason !== 'version') return;
    const { attempt, exhausted } = nextUpdateAttempt(useUpdate.getState().attempt);
    writeAttempts(attempt);
    useUpdate.setState({ phase: exhausted ? 'failed' : 'updating', attempt });
    log('warn', `app version differs from the hub: reloading (attempt ${attempt} of ${UPDATE_RETRY_CAP})`);
    // The socket lives in the core worker, which cannot reload the page: the host does it.
    setTimeout(() => location.reload(), 500);
  });
  const offWelcome = hub.on('welcome', (w) => {
    if (useUpdate.getState().attempt) log('info', `updated to ${w.appVersion}`);
    writeAttempts(0);
    useUpdate.setState({ phase: 'idle', attempt: 0, hubVersion: w.appVersion });
  });
  return () => {
    offBye();
    offWelcome();
  };
}

/** Operator asked to try again: forget the attempts, drop the cached shell, reload. */
export async function retryUpdate(): Promise<void> {
  writeAttempts(0);
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('ordo-shell-')).map((k) => caches.delete(k)));
    }
  } catch {
    /* best effort */
  }
  location.reload();
}
