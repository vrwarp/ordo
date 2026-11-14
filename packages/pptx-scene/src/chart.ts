/**
 * Charts drawn by ordo (design/27 §15 M9, `charts.md` §3; `charts-conv` fills this): a `c:chart` graphic
 * frame read into a `ChartElement` (`readChart`: the chart part's cache, bounded by `CHART_LIMITS`) and
 * emitted as one `ShapeObject.chart` over the legacy chart-area rect an older build draws (`emitChart`,
 * written only when `EmitOptions.m9Writes` has 'chart').
 *
 * Stubs since `conv-seams`: `readChart` reads none, so a chart frame stays a residual element (LibreOffice's
 * art, or `missing: ['chart']` without LibreOffice), and `emitChart` is never reached.
 *
 * Pure.
 */
import type { SlideObject } from '@ordo/domain';
import type { SlideCtx, Source } from './context.ts';
import type { EmitCtx } from './emit-ctx.ts';
import type { ChartElement, ElementBase } from './ir.ts';
import type { XNode } from './xml.ts';

/** The chart of a graphic frame, or undefined when ordo does not draw it (the frame stays residual). */
export function readChart(
  _ctx: SlideCtx,
  _frame: XNode,
  _from: Source,
  _base: ElementBase,
): ChartElement | undefined {
  return undefined;
}

/** A chart element's objects. Stub: no chart element is read yet, so nothing is written. */
export function emitChart(ctx: EmitCtx, _e: ChartElement, _out: SlideObject[]): void {
  ctx.log('a chart is not drawn yet');
}
