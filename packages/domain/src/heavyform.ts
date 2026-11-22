import type { PrerenderWhy, Slide } from './schemas.ts';
import type { SlideFile } from './slidefile.ts';

// STUB (red first, step 1): the names and shapes exist and do nothing useful until their commit.
export type HeavyOk = {
  ok: true;
  file: SlideFile;
  standIn: Slide;
  uses: { media: string[]; files: string[]; fonts: string[] };
  cut: boolean;
};
export type HeavyRefused = { ok: false; reason: string; message: string; standIn: Slide };
export type HeavyNothing = { ok: false; reason: 'nothing-to-do'; message: string };
export type HeavyResult = HeavyOk | HeavyRefused | HeavyNothing;
export function heavyForm(
  _full: Slide,
  _opts: { why: readonly PrerenderWhy[]; live?: readonly string[] },
): HeavyResult {
  throw new Error('not built');
}
