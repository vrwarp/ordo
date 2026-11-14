import type { LiveState, MidiCue } from '@ordo/domain';

/**
 * The show-control cues to send when the operator's live view moves from `prev` to `next` (design/19 "MIDI
 * out"): the newly live cue's, once per change of the live cue. A view that went back to an earlier cue and
 * forward again would send that cue's MIDI again, so the operator's view must never step back on its own
 * (a hand-back, a second fallback, a core restart: apps/operator/test/liveCore.test.ts, run 76's order).
 */
export function midiCuesOnChange(prev: LiveState, next: LiveState): MidiCue[] {
  if (next.live === prev.live || next.live === undefined) return [];
  return next.cues[next.live]?.midiCues ?? [];
}
