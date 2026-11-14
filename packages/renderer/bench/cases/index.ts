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

/** A named slide the bench rasterizes at 1920 and 3840 px wide. */
export type BenchCase = readonly [name: string, slide: Slide];

/** Every area's cases. */
export const AREA_BENCH_CASES: readonly BenchCase[] = [
  ...TABLE_BENCH_CASES,
  ...UNITS_BENCH_CASES,
  ...DECOR_BENCH_CASES,
];
