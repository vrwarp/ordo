import { useLive } from '../state/live.ts';
import { log } from './log.ts';
import { outputWindows } from './outputs.ts';

/**
 * After an operator reload during a live service the output WindowProxy handles are lost. On the first
 * user gesture (window.open needs one) re-acquire the windows by their stable names so the fallback bus
 * can reach them.
 */
export function reacquireOnFirstGesture(): void {
  const handler = (e: Event) => {
    // Launch and Relaunch open the windows by the same names themselves. Re-acquiring in the same gesture
    // would open and close blank windows under those names and race the launch, losing the outputs.
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('[data-launch]')) {
      detach();
      return;
    }
    detach();
    if (!launchedEarlier()) return;
    if (useLive.getState().state.mode !== 'live') return;
    const n = outputWindows()?.reacquire() ?? 0;
    if (n) log('info', `re-acquired ${n} output windows`);
  };
  const detach = () => {
    window.removeEventListener('pointerdown', handler, true);
    window.removeEventListener('keydown', handler, true);
  };
  window.addEventListener('pointerdown', handler, true);
  window.addEventListener('keydown', handler, true);
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

function launchedEarlier(): boolean {
  try {
    return sessionStorage.getItem(LAUNCHED_KEY) === '1';
  } catch {
    return true;
  }
}
