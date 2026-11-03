/**
 * Reload guard for the hub's `bye: version` (review item 28). The hub closes a socket whose app version
 * does not match its own; the client then reloads so the service worker fetches the new shell (network-
 * first, ADR 0013). If the new shell never arrives (a failed install, a proxy serving a stale page) that
 * would loop forever, so attempts are counted across reloads and capped.
 */
export const UPDATE_RETRY_CAP = 3;

export type UpdatePhase = 'idle' | 'updating' | 'failed';

/** Next attempt number after a version mismatch, and whether the cap is reached. */
export function nextUpdateAttempt(
  previous: number,
  cap = UPDATE_RETRY_CAP,
): { attempt: number; exhausted: boolean } {
  const attempt = Math.max(0, Math.floor(previous)) + 1;
  return { attempt, exhausted: attempt > cap };
}

/** Phase to show on load given the attempts recorded so far. */
export function updatePhaseOnLoad(previous: number, cap = UPDATE_RETRY_CAP): UpdatePhase {
  return previous >= cap ? 'failed' : 'idle';
}

export function parseAttempts(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
