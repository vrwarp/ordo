import type { ShapeObject } from '@ordo/domain';
import { bulletin, chart, masterGrid } from '../../bench/cases/table.ts';
import { clampShapeObject } from '../shape.ts';
import { currentFontEnv } from '../text/fonts.ts';
import { measurerFor } from '../text/measure.ts';
import { drawTable } from './draw.ts';
import { clearTableCache, layoutTable, prepareTableLayout } from './layout.ts';

/**
 * Browser side of table.browser.test.ts (design/27 M9 tables, §13's 50 ms task): in headless Chromium with a
 * real face, each of the bench's large tables (the 13,782-character chart, the 96-cell bulletin, the 640-cell
 * master grid) is prepared as the asset worker prepares it, in slices of 8 ms (`prepareTableLayout`), then
 * drawn at 3840: every slice and the draw must stay within the 50 ms task. The chart is drawn in words its
 * page has not measured before (as an output's first draw of a slide).
 */

export type TableTiming = {
  name: string;
  slices: number;
  maxSliceMs: number;
  prepareMs: number;
  /** The draw after preparing, at 3840 (layouts cached). */
  drawMs: number;
  /** A cold layout of the whole table in one call (what a draw without preparation would cost). */
  coldMs: number;
  cells: number;
  height: number;
};

async function run(face: ArrayBuffer): Promise<TableTiming[]> {
  const f = new FontFace('Bench', face);
  await f.load();
  document.fonts.add(f);
  const canvas = new OffscreenCanvas(3840, 2160);
  const ctx = canvas.getContext('2d')!;
  const m = measurerFor(ctx);
  const env = currentFontEnv();
  const out: TableTiming[] = [];
  // Each table in words no other has (`vocab`), so its widths are measured for the first time, as on an
  // output drawing a slide first: once whole (cold), once in slices (another vocabulary, as cold).
  let vocab = 1;
  for (const [name, make] of [
    ['13,782-character chart', (v: number) => chart(v)],
    ['96-cell bulletin', () => bulletin()],
    ['640-cell master grid', () => masterGrid()],
  ] as [string, (vocab: number) => ShapeObject][]) {
    // Warm the code: a layout of a copy in a vocabulary of its own.
    clearTableCache();
    layoutTable(m, clampShapeObject(make(vocab++)), env);
    clearTableCache();
    const cold = clampShapeObject(make(vocab++));
    let t = performance.now();
    layoutTable(m, cold, env);
    const coldMs = performance.now() - t;
    clearTableCache();
    const o = clampShapeObject(make(vocab++));
    let slices = 0;
    let maxSliceMs = 0;
    const t0 = performance.now();
    for (;;) {
      t = performance.now();
      const done = prepareTableLayout(m, o, env, 8);
      const d = performance.now() - t;
      slices++;
      if (d > maxSliceMs) maxSliceMs = d;
      if (done) break;
    }
    const prepareMs = performance.now() - t0;
    t = performance.now();
    const l = drawTable(ctx, o, 2, env)!;
    const drawMs = performance.now() - t;
    out.push({
      name,
      slices,
      maxSliceMs,
      prepareMs,
      drawMs,
      coldMs,
      cells: l.cells.length,
      height: l.height,
    });
  }
  return out;
}

(window as unknown as { __tables: (face: string) => Promise<TableTiming[]> }).__tables = (b64: string) =>
  run(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
