import type { Slide } from '@ordo/domain';
import { DECOR_BENCH_CASES } from './decor.ts';
import { TABLE_BENCH_CASES } from './table.ts';
import { UNITS_BENCH_CASES } from './units.ts';

/*
 * The raster bench cases of M9's areas (design/27 M9 render-seams): each area track writes its slides in
 * `bench/cases/<area>.ts` (decorations, tables, charts, 3-D, warps, vector pictures) and lists them here with
 * one line. bench/raster.page.ts draws them after its own cases, and bench/raster.ts checks them by their
 * names as it checks its own: '(rich' against the M2 text budget, '(bounded geometry' against design/27
 * §13's 50 ms task at both sizes, '(bounded effects' against the cold effect budget, '(bounded' against the
 * large effects budget, '(warm task' against the 50 ms task at both sizes drawn warm, ', cold' drawn with the
 * sprite cache emptied before every job; other names are reported, not checked.
 */

/**
 * How a case's jobs are drawn (default: the slide, one raster a job, `iterations` times after a warm-up):
 * - `alternate`: the slide and another drawn in turn, one raster each, for `rounds` rounds from a cold start
 *   (every cache emptied and both slides' units made first, as two looks showing them make them): what two
 *   looks that show a slide and the next one draw (r2a land review). Its draws of rounds 3 on are the case's.
 * - `second`: the slide's second draw after its decorations' sprites and marks are forgotten, `rounds` times:
 *   the draw that makes a slide's decoration sprites (its first draw marks them, r2a land re-review).
 */
export type BenchRun =
  | { readonly alternate: Slide; readonly rounds: number }
  | { readonly second: true; readonly rounds: number };

/** A named slide the bench rasterizes at 1920 and 3840 px wide (and how, `BenchRun`). */
export type BenchCase = readonly [name: string, slide: Slide, run?: BenchRun];

/** Every area's cases. */
export const AREA_BENCH_CASES: readonly BenchCase[] = [
  ...TABLE_BENCH_CASES,
  ...UNITS_BENCH_CASES,
  ...DECOR_BENCH_CASES,
];
