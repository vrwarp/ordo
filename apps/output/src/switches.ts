import type { DrawingSwitches } from '@ordo/renderer';

/*
 * The output window's URL switches (main.ts; design/14 "Late units"): venue troubleshooting switches beside
 * `?renderer=2d`, each a way back to an earlier drawing should a venue PC misbehave, never a setting users see
 * (design/24):
 * - `?renderer=2d` forces the Canvas 2D compositor, `?renderer=webgpu` keeps WebGPU on a software adapter;
 * - `?late=next`: a slide's parts made after it was shown appear at its next draw instead of fading in
 *   (`LATE_UNIT` 'fade' otherwise);
 * - `?warm=off`: the live playlist's units are not made ahead;
 * - `?effects=base`: effects and decorations drawn as 62a1c3a drew them (wave r2b's effect units off; C6);
 * - test mode only, `?unitTurnMs=N`: each turn of unit making is followed by an N ms wait (1-5000), so the e2e
 *   can make units slow; refused (and said in the console) outside test mode.
 */

export type OutputSwitches = {
  forceCanvas2d: boolean;
  allowFallbackAdapter: boolean;
  /** Carried to the asset worker in its init. */
  drawing: DrawingSwitches;
  /** Switches this window would not take (test-mode ones outside test mode). */
  refused: string[];
};

export function outputSwitches(q: URLSearchParams, testMode: boolean): OutputSwitches {
  const drawing: DrawingSwitches = {};
  const late = q.get('late');
  if (late === 'next' || late === 'fade') drawing.late = late;
  if (q.get('warm') === 'off') drawing.warm = false;
  if (q.get('effects') === 'base') drawing.effects = 'base';
  const refused: string[] = [];
  const turn = q.get('unitTurnMs');
  if (turn !== null) {
    if (!testMode) refused.push('unitTurnMs');
    else {
      const ms = Number(turn);
      if (Number.isFinite(ms) && ms > 0) drawing.unitTurnMs = Math.min(5000, Math.round(ms));
    }
  }
  return {
    forceCanvas2d: q.get('renderer') === '2d',
    allowFallbackAdapter: q.get('renderer') === 'webgpu',
    drawing,
    refused,
  };
}
