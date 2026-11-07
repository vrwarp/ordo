/*
 * The golden cases of M9's areas (design/27 M9 render-seams): each area track writes its cases in
 * `golden/<area>-cases.ts` (decorations, tables, warps, 3-D, charts, vector pictures...) and lists them here
 * with one line. page.ts draws them with every other case and run.ts compares them with their expected PNGs
 * (golden/expected/<case>.png) under the same rules: a case without one fails a --strict run.
 */

/** A golden case: draws on a 960 x 540 canvas (`rich-cases.ts` `W`, `H`). */
export type GoldenCase = (ctx: OffscreenCanvasRenderingContext2D) => void;

/** Every area's cases, by case name (names unique across all files, as page.ts's own). */
export const AREA_CASES: readonly Readonly<Record<string, GoldenCase>>[] = [];
