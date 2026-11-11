import { useLive } from '../state/live.ts';
import { settings } from '../state/library.ts';
import { log } from './log.ts';
import { outputWindows } from './outputs.ts';

/**
 * After an operator reload (or in a new tab) during a live service the output WindowProxy handles are
 * lost: the fallback bus cannot reach the windows and Relaunch cannot close them. `window.open` needs a
 * user gesture, so on gestures we re-acquire the windows by their stable names whenever handles are
 * missing: when this browser session launched them earlier (sessionStorage flag), when confirmed locally
 * via BroadcastChannel probe, or when the hub reports an output connected that this page holds no handle for.
 *
 * Windows are only re-acquired if confirmed to be running locally in this browser via BroadcastChannel
 * ping/pong before window.open is ever called, preventing blank tabs and focus stealing.
 * Each output is tried at most once per RETRY_MS.
 */
export const RETRY_MS = 60_000;

const attempted = new Map<string, number>();

/** Enabled outputs that need a handle: known to exist (connected, launched earlier, or confirmed local) and not held. */
export function missingHandles(now = Date.now()): { ids: string[]; due: string[] } {
  const ow = outputWindows();
  if (!ow) return { ids: [], due: [] };
  const launched = launchedEarlier();
  const health = useLive.getState().health;
  const ids = ow
    .missing()
    .filter((o) => launched || !!health[o.id]?.connected || ow.isConfirmedLocal(o.id))
    .map((o) => o.id);
  const due = ids.filter((id) => now - (attempted.get(id) ?? 0) >= RETRY_MS);
  return { ids, due };
}

/** Try to re-acquire missing windows by name now (must run inside a user gesture). `force` ignores the throttle. */
export async function reacquireMissing(force = false, now = Date.now()): Promise<number> {
  const ow = outputWindows();
  if (!ow) return 0;
  const m = missingHandles(now);
  const due = force ? m.ids : m.due;
  if (!due.length) return 0;
  for (const id of due) attempted.set(id, now);
  const found = await ow.probeLocal(due, 40);
  if (!found.size) return 0;
  const n = ow.reacquire(found);
  if (n) log('info', `re-acquired ${n} output windows`);
  else log('warn', `could not re-acquire ${due.length} output windows by name`);
  return n;
}

/** Forget the retry throttle (after Launch/Relaunch, which open the windows themselves). */
export function resetReacquire(): void {
  attempted.clear();
}

export function reacquireOnGesture(): () => void {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return () => {};
  const handler = (e: Event) => {
    if (!e.isTrusted) return;
    // Launch and Relaunch open the windows by the same names themselves. Re-acquiring in the same gesture
    // would open and close blank windows under those names and race the launch, losing the outputs.
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('[data-launch]')) {
      resetReacquire();
      return;
    }
    if (useLive.getState().state.mode !== 'live') return;
    if (!settings().outputs.some((o) => o.enabled)) return;
    void reacquireMissing();
  };
  window.addEventListener('pointerdown', handler, true);
  window.addEventListener('keydown', handler, true);
  return () => {
    window.removeEventListener('pointerdown', handler, true);
    window.removeEventListener('keydown', handler, true);
  };
}

/** Kept for callers from before gestures were watched continuously. */
export function reacquireOnFirstGesture(): void {
  reacquireOnGesture();
}

const LAUNCHED_KEY = 'ordo.outputsLaunched';

/** Remember (per browser session) that this operator has output windows open, so a reload re-acquires them. */
export function markLaunched(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(LAUNCHED_KEY, '1');
    else sessionStorage.removeItem(LAUNCHED_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function launchedEarlier(): boolean {
  try {
    return sessionStorage.getItem(LAUNCHED_KEY) === '1';
  } catch {
    return false;
  }
}
