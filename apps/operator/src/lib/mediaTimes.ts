import type { LiveState } from '@ordo/domain';
import type { OutputHealthEntry } from '@ordo/protocol';

/** Health positions older than this are stale (the output stopped reporting). */
const HEALTH_STALE_MS = 3000;
/** Reducer and output disagree by more than this: trust the output (seek, loop, a slow start). */
const DRIFT_MS = 750;

/**
 * Media position and remaining time (prd/02). The reducer position drives the display so it moves from
 * the first frame; the audio master's 1 Hz health report corrects drift (loops, seeks, slow starts) and
 * supplies the duration when the library record has none (review item 30).
 */
export function mediaTimes(
  s: LiveState,
  now: number,
  durationMs: number | undefined,
  h?: OutputHealthEntry,
  wallNow = Date.now(),
): { pos: number; dur?: number } | null {
  const m = s.layers.media.content ?? s.audio.content;
  if (!m) return null;
  const playing = m.state === 'playing';
  let pos = Math.max(0, playing ? now - m.startedAt : m.positionMs);
  const dur = h?.mediaDurationMs || durationMs || undefined;
  if (h?.mediaPositionMs !== undefined && wallNow - h.lastSeen <= HEALTH_STALE_MS) {
    const reported = h.mediaPositionMs + (playing ? Math.max(0, wallNow - h.lastSeen) : 0);
    if (Math.abs(reported - pos) > DRIFT_MS) pos = Math.max(0, reported);
  }
  if (dur) pos = Math.min(pos, dur);
  return { pos, dur };
}
