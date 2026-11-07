import type { VenueReport } from './gpu-venue.page.ts';

/**
 * Reading the live runs of gpu-venue.page.ts (`bench:gpu`, `bench:venue`): the engine on a shown canvas,
 * one late flip asked each second. A run whose late content never flipped has no frames to take
 * statistics of, and `stats([])` is all zeros, which would read as the best result; a run that presented
 * far fewer frames than its seconds at the display's refresh was throttled (a hidden or unfocused window)
 * and measured nothing.
 */

export type LiveRun = VenueReport['sizes'][number]['live'][number];

/** A run presented too few frames when under this share of its seconds at the display's refresh. */
export const PRESENTED_SHARE = 0.5;

/** The late content of a run in words: frames from its arrival to its flip, and how many never flipped. */
export function lateContent(l: LiveRun): string {
  const n = l.lateContentFrames.n;
  const asked = l.lateAsked;
  if (n === 0) return `late content never flipped (n=0 of ${asked})`;
  const after = `late content flipped after ${l.lateContentFrames.p50} frame(s) p50 (max ${l.lateContentFrames.max})`;
  return n < asked ? `${after}, the rest never flipped (n=${n} of ${asked})` : after;
}

/**
 * What makes a run on a shown window not a measurement (for the budget check's `over`): late content that
 * did not all flip, and fewer frames presented than PRESENTED_SHARE of its seconds at the display's frame
 * interval `frameMs` (when it was measured). Empty when there is nothing.
 */
export function liveProblems(l: LiveRun, frameMs: number | undefined, where: string): string[] {
  const out: string[] = [];
  if (l.lateContentFrames.n < l.lateAsked)
    out.push(`${where}: late content never flipped (n=${l.lateContentFrames.n} of ${l.lateAsked})`);
  if (frameMs && frameMs > 0) {
    const expected = Math.round((l.seconds * 1000) / frameMs);
    if (l.presented < PRESENTED_SHARE * expected)
      out.push(
        `${where}: presented ${l.presented} frames of about ${expected} (${l.seconds} s at ${frameMs.toFixed(2)} ms): the window was hidden, unfocused or throttled`,
      );
  }
  return out;
}
