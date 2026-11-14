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
 * In path mode windows are only re-acquired once the BroadcastChannel probe confirms them running in this
 * browser, before window.open is ever called, so no blank tab opens and no focus is stolen. In domain mode
 * (op./outN./stage. hosts, the venue setup) every output has its own origin and the probe sees nothing: a
 * gesture then re-acquires the outputs this browser session launched that the hub reports connected, and an
 * explicit request (the fallback link, Relaunch, Diagnostics) every output launched or connected; a name
 * with no window behind it opens a blank window that is closed at once.
 * Each output is tried at most once per RETRY_MS, unless forced.
 */
export const RETRY_MS = 60_000;

const attempted = new Map<string, number>();

/**
 * Enabled outputs that need a handle: known to exist (connected, launched earlier, or confirmed local) and
 * not held. Without a probe (domain mode) a gesture (`explicit` false) asks for more: launched from this
 * browser session and connected to the hub, so a window that is gone, or runs on another computer, does not
 * flash a blank window on every click of the service.
 */
export function missingHandles(now = Date.now(), explicit = false): { ids: string[]; due: string[] } {
  const ow = outputWindows();
  if (!ow) return { ids: [], due: [] };
  const launched = launchedEarlier();
  const health = useLive.getState().health;
  const probe = ow.canProbe;
  const ids = ow
    .missing()
    .filter((o) => {
      const connected = !!health[o.id]?.connected;
      if (probe) return launched || connected || ow.isConfirmedLocal(o.id);
      return explicit ? launched || connected : launched && connected;
    })
    .map((o) => o.id);
  const due = ids.filter((id) => now - (attempted.get(id) ?? 0) >= RETRY_MS);
  return { ids, due };
}

/**
 * Try to re-acquire missing windows by name now (must run inside a user gesture). `force` (an explicit
 * request: the fallback link) ignores the throttle.
 */
export async function reacquireMissing(force = false, now = Date.now()): Promise<number> {
  const ow = outputWindows();
  if (!ow) return 0;
  const m = missingHandles(now, force);
  const due = force ? m.ids : m.due;
  if (!due.length) return 0;
  for (const id of due) attempted.set(id, now);
  // In path mode only the windows the probe finds in this browser; in domain mode no probe can see them.
  const found = ow.canProbe ? await ow.probeLocal(due, 40) : new Set(due);
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
