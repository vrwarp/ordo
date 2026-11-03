import { useLive } from '../state/live.ts';
import { log } from './log.ts';
import { outputWindows } from './outputs.ts';

/**
 * After an operator reload during a live service the output WindowProxy handles are lost. On the first
 * user gesture (window.open needs one) re-acquire the windows by their stable names so the fallback bus
 * can reach them.
 */
export function reacquireOnFirstGesture(): void {
  const handler = () => {
    window.removeEventListener('pointerdown', handler, true);
    window.removeEventListener('keydown', handler, true);
    if (useLive.getState().state.mode !== 'live') return;
    const n = outputWindows()?.reacquire() ?? 0;
    if (n) log('info', `re-acquired ${n} output windows`);
  };
  window.addEventListener('pointerdown', handler, true);
  window.addEventListener('keydown', handler, true);
}
