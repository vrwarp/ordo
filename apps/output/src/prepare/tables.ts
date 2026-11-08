import type { ShapeObject } from '@ordo/domain';
import { type Measurer, clampSlide, currentFontEnv, measurerFor, prepareTableLayout } from '@ordo/renderer';
import { type PrepareStep, registerPrepareStep } from './index.ts';

/*
 * Tables laid out before the draw (design/27 M9 tables, §13's 50 ms task): a slide's table objects have their
 * cells laid out in slices of `TABLE_SLICE_MS` in the job's turns, so the synchronous draw that follows lays
 * out nothing, whatever the table holds (the corpus's largest, a 13,782-character chart, takes several slices).
 * The renderer keeps each cell's layout by its content, so the draw, the next slide's job and the editor's
 * thumbnails find it. A slide drawn by a look that does not draw it as authored (lyric-only, hidden) has none
 * to prepare.
 *
 * Importing this module registers the step (the asset worker and the thumbnail worker import it).
 */

/** The longest slice of table layout a job's turn runs (ms): a cell once started is finished. */
export const TABLE_SLICE_MS = 8;

let measurer: Measurer | null | undefined;

/** The measurer the drawers use (`measurerFor`: the worker's shared OffscreenCanvas one). */
function sharedMeasurer(): Measurer | null {
  if (measurer === undefined) {
    const probe = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d');
    measurer = probe ? measurerFor(probe) : null;
  }
  return measurer;
}

export const tableLayouts: PrepareStep = {
  name: 'table layouts',
  async run(job, host) {
    if ((job.look?.layers.slide.mode ?? 'authored') !== 'authored') return undefined;
    const tables: ShapeObject[] = [];
    for (const s of job.slides)
      for (const o of clampSlide(s).objects) if (o.type === 'shape' && o.table) tables.push(o);
    if (!tables.length) return undefined;
    const m = sharedMeasurer();
    if (!m) return undefined;
    for (const o of tables) {
      let done = false;
      while (!done) {
        host.check();
        done = await host.slice(() => prepareTableLayout(m, o, currentFontEnv(), TABLE_SLICE_MS));
      }
    }
    return undefined;
  },
};

/** For tests: lay out with this measurer instead of the worker's (undefined: the worker's again). */
export function setTableMeasurer(m: Measurer | undefined): void {
  measurer = m;
}

registerPrepareStep(tableLayouts);
