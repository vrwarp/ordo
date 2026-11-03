import { CacheCheckTracker, cacheIntegrity, cacheIntegrityMessage } from '../lib/health.ts';
import { settings } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import { toast } from '../state/toasts.ts';
import { log } from './log.ts';
import { useLaunch } from './outputs.ts';

const POLL_MS = 500;

/**
 * Cache integrity check at Launch outputs (prd/08): once a launch finishes, watch the health of every
 * window that opened until each holds the whole live manifest, or its fill stops moving, or the check
 * times out; then report what is missing. Nothing to check while no playlist is live (an idle manifest is
 * fonts only) or when nothing opened.
 */
export function runCacheCheck(now = () => Date.now()): Promise<void> {
  if (useLive.getState().state.mode !== 'live') return Promise.resolve();
  const open = useLaunch.getState().open;
  const outputs = settings().outputs.filter((o) => o.enabled && open[o.id]);
  if (!outputs.length) return Promise.resolve();
  const tracker = new CacheCheckTracker(now());
  return new Promise((resolve) => {
    const tick = () => {
      const t = now();
      const rows = cacheIntegrity(outputs, useLive.getState().health);
      if (!tracker.update(rows, t)) {
        setTimeout(tick, POLL_MS);
        return;
      }
      const message = cacheIntegrityMessage(rows);
      useLive.setState({ cacheCheck: { at: t, message, rows } });
      if (message) {
        log('warn', `cache check: ${message}`);
        toast(`${message}. Missing items load from the hub when cued.`, 'warn', 12_000);
      } else {
        const total = rows.reduce((m, r) => Math.max(m, r.total), 0);
        log('info', `cache check: complete on ${rows.length} window(s), ${total} files`);
        toast(`Service cache complete on every output (${total} files).`, 'ok');
      }
      resolve();
    };
    tick();
  });
}

let unsub: (() => void) | undefined;

/** Run the check whenever a Launch or Relaunch finishes. */
export function installCacheCheck(): () => void {
  unsub?.();
  let wasBusy = useLaunch.getState().busy;
  unsub = useLaunch.subscribe((s) => {
    // The launch refreshes its open-window map right after clearing busy: look at it a tick later.
    if (wasBusy && !s.busy) setTimeout(() => void runCacheCheck(), 0);
    wasBusy = s.busy;
  });
  return unsub;
}
