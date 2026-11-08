import type { ArrowEnd, LineCap, LineDash, LineJoin } from '@ordo/domain';
import { ARROW_MIN_BASE, arrowFor, type GeomEnds } from './ends.ts';

/*
 * A shape's outline as it is drawn (design/27 §3.1 ShapeObject M6 fields, §15 M6): its width, joins, caps,
 * dash pattern and line ends resolved from the stored fields, shared by the drawer (`shape.ts`) and the
 * drawing estimate (`cost.ts`), so what is rated is what is drawn. Pure: the converter reads it too.
 * - Dash: prstDash scaled by the line width (LibreOffice lclConvertPresetDash); a round or square cap is drawn
 *   within a preset dash's length as Office draws it: LibreOffice takes one line width off each dash or dot of
 *   at least that length and adds it to the gaps (lineproperties.cxx), so a round-capped sysDot is a row of
 *   round dots.
 * - Joins: miter (limit 8: OOXML's usual `a:miter lim="800000"`), else round or bevel; caps: flat (Office's
 *   default), else round or square.
 */

/** Dash and gap lengths of each preset dash, × the line width (LibreOffice lclConvertPresetDash). */
export const DASH_PATTERNS: Readonly<Record<LineDash, readonly number[]>> = {
  solid: [],
  dot: [1, 3],
  dash: [4, 3],
  dashDot: [4, 3, 1, 3],
  longDash: [8, 3],
  longDashDot: [8, 3, 1, 3],
  longDashDotDot: [8, 3, 1, 3, 1, 3],
  sysDot: [1, 1],
  sysDash: [3, 1],
  sysDashDot: [3, 1, 1, 1],
  sysDashDotDot: [3, 1, 1, 1, 1, 1],
};

/** The miter limit of shape outlines (OOXML a:miter lim="800000", the Office themes' line style). */
export const SHAPE_MITER_LIMIT = 8;

/**
 * A preset dash pattern (× the line width) with a round or square cap: each dash or dot of at least one line
 * width loses 0.99 of it and every gap gains 0.99 when one does (LibreOffice lineproperties.cxx: Office
 * counts those caps within a preset dash's length; Canvas adds them).
 */
export function cappedDash(pattern: readonly number[], cap: LineCap | undefined): number[] {
  if (cap !== 'round' && cap !== 'square') return [...pattern];
  const long = pattern.some((v, i) => i % 2 === 0 && v >= 1);
  if (!long) return [...pattern];
  return pattern.map((v, i) => (i % 2 === 0 ? (v >= 1 ? v - 0.99 : v) : v + 0.99));
}

/** Canvas's lineJoin and lineCap for a shape's (defaults: miter, butt). */
export function lineStyleOf(o: { lineJoin?: LineJoin | undefined; lineCap?: LineCap | undefined }): {
  join: CanvasLineJoin;
  cap: CanvasLineCap;
} {
  return {
    join: o.lineJoin === 'round' || o.lineJoin === 'bevel' ? o.lineJoin : 'miter',
    cap: o.lineCap === 'round' ? 'round' : o.lineCap === 'square' ? 'square' : 'butt',
  };
}

/** Whether a shape uses any M6 drawing field (it is drawn by `drawGeomShape`, else by `drawShape`). */
export function hasShapeExtras(o: {
  readonly geom?: unknown;
  readonly gradient?: unknown;
  readonly dash?: unknown;
  readonly ends?: unknown;
  readonly flipH?: unknown;
  readonly flipV?: unknown;
  readonly shadow?: unknown;
  readonly glow?: unknown;
  readonly softEdge?: unknown;
  readonly lineJoin?: unknown;
  readonly lineCap?: unknown;
}): boolean {
  return (
    o.geom !== undefined ||
    o.gradient !== undefined ||
    o.dash !== undefined ||
    o.ends !== undefined ||
    o.flipH === true ||
    o.flipV === true ||
    o.shadow !== undefined ||
    o.glow !== undefined ||
    o.softEdge !== undefined ||
    (o.lineJoin !== undefined && o.lineJoin !== 'miter') ||
    (o.lineCap !== undefined && o.lineCap !== 'flat')
  );
}

/** The stored fields an outline is drawn from (a clamped `ShapeObject`'s, or the converter's for one). */
export interface OutlineFields {
  readonly stroke?: { readonly width: number } | undefined;
  readonly dash?: LineDash | undefined;
  readonly lineJoin?: LineJoin | undefined;
  readonly lineCap?: LineCap | undefined;
  readonly ends?: { readonly head?: ArrowEnd | undefined; readonly tail?: ArrowEnd | undefined } | undefined;
}

/** An outline as drawn: box units (logical px), Canvas's join and cap, the dash in box units. */
export interface Outline {
  readonly width: number;
  readonly join: CanvasLineJoin;
  readonly cap: CanvasLineCap;
  readonly miterLimit: number;
  /** Dash and gap lengths (box units, `ctx.setLineDash`); none for a solid line. */
  readonly dash?: readonly number[];
  readonly ends?: GeomEnds;
}

/**
 * The outline a shape draws (`width` the clamped `stroke.width`), or undefined when it draws none (no stroke,
 * a width of 0 or less, not a number).
 */
export function outlineOf(o: OutlineFields, width = o.stroke?.width): Outline | undefined {
  const lw = typeof width === 'number' && Number.isFinite(width) ? width : 0;
  if (!o.stroke || !(lw > 0)) return undefined;
  const { join, cap } = lineStyleOf(o);
  const pattern = cappedDash(DASH_PATTERNS[o.dash ?? 'solid'] ?? [], o.lineCap);
  const head = arrowFor(o.ends?.head?.type, o.ends?.head?.w, o.ends?.head?.len, lw, ARROW_MIN_BASE);
  const tail = arrowFor(o.ends?.tail?.type, o.ends?.tail?.w, o.ends?.tail?.len, lw, ARROW_MIN_BASE);
  return {
    width: lw,
    join,
    cap,
    miterLimit: SHAPE_MITER_LIMIT,
    ...(pattern.length ? { dash: pattern.map((v) => v * lw) } : {}),
    ...(head || tail ? { ends: { ...(head ? { head } : {}), ...(tail ? { tail } : {}) } } : {}),
  };
}
