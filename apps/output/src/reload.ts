import type { WorkerName } from './host-protocol.ts';

/** Crash-only reloads allowed within RELOAD_WINDOW_MS before the window stops reloading itself. */
export const RELOAD_MAX = 3;
export const RELOAD_WINDOW_MS = 10 * 60_000;

export type ReloadPlan =
  | { action: 'reload'; recent: number[] }
  /** The budget is spent: restart `worker` instead (when the caller named one), and say so. */
  | { action: 'restart'; worker: WorkerName; text: string }
  | { action: 'refuse'; text: string };

/**
 * The host's reload budget (design/14 crash-only restart): at most RELOAD_MAX reloads in RELOAD_WINDOW_MS,
 * so a deterministic failure cannot become a reload loop. A refused reload falls back to restarting the
 * named worker, e.g. the render worker for a stuck renderer (review 2026-11-04 item 9). A new app version
 * always reloads. `stored` is the sessionStorage list of earlier reload times.
 */
export function planReload(
  stored: string | null,
  now: number,
  reason: string,
  fallback?: WorkerName,
): ReloadPlan {
  let recent: number[] = [];
  try {
    const parsed = JSON.parse(stored ?? '[]') as unknown;
    if (Array.isArray(parsed))
      recent = parsed.filter((t): t is number => typeof t === 'number' && now - t < RELOAD_WINDOW_MS);
  } catch {
    recent = [];
  }
  if (recent.length >= RELOAD_MAX && reason !== 'new app version') {
    if (fallback)
      return {
        action: 'restart',
        worker: fallback,
        text: `reload refused (${recent.length} in 10 min): restarted the ${fallback} worker instead (${reason})`.slice(
          0,
          300,
        ),
      };
    return { action: 'refuse', text: `reload refused (${recent.length} in 10 min): ${reason}`.slice(0, 300) };
  }
  return { action: 'reload', recent: [...recent, now] };
}
