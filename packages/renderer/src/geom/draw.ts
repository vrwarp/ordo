import { type Rgba, rgbaCss } from '@ordo/domain';
import type { Ctx2D } from '../ctx.ts';
import { type GeomEnds, withEnds } from './ends.ts';
import {
  CLOSED_TOLERANCE,
  CMD_CLOSE,
  CMD_CUBIC,
  CMD_LINE,
  CMD_MOVE,
  CMD_QUAD,
  type PathFill,
} from './ops.ts';

export { CLOSED_TOLERANCE };
import {
  evenOddArea,
  nestingDepths,
  UNION_NESTING_LIMIT,
  UNION_NESTING_WORK,
  type UnionSub,
  unionSubs,
} from './nesting.ts';
import type { BuiltGeom, GeomPath } from './path.ts';

export { evenOddArea, UNION_NESTING_LIMIT, UNION_NESTING_WORK };

/*
 * Drawing a built geometry (path.ts) with Canvas 2D (design/27 §7.1, §15 M6). Order and colours follow
 * LibreOffice, the fidelity reference (svx EnhancedCustomShape2d: CreateSubPath, CreatePathObj, GetColorData):
 * - Paths are drawn in document order, each filled and then stroked, except the outline of an open path (one
 *   with a sub-path that is neither closed nor ends where it starts), which is stroked after every path, in
 *   order. LibreOffice makes a fill object and a line object of each path, then moves the open line objects
 *   (PolyLine, `IsLine()`) behind the rest because every OOXML shape type sorts "filled objects to back"
 *   (`SortFilledObjectsToBackByDefault` is true for mso_sptNil). It shows in chartX, chartStar and chartPlus,
 *   whose lines come before the filled box and still draw over it. POI fills every path before stroking any.
 * - A path is filled with the even-odd rule, LibreOffice's (and PowerPoint's for freeforms); an open path is
 *   filled as if closed and stroked open.
 * - fill="none" is not filled, stroke="false" not stroked.
 * - The shaded modes blend the shape's fill: lighten and lightenLess towards white by 40 % and 20 %, darken and
 *   darkenLess towards black by 40 % and 20 %, per channel, truncated to an integer as LibreOffice does; alpha is
 *   kept. Strokes are never shaded. A gradient or picture fill is shaded by the caller's painter (LibreOffice
 *   shades each gradient stop).
 * - A stroke may carry a dash pattern and line ends (ends.ts): open sub-paths are stroked cut back for their
 *   arrowheads, which are filled in the stroke's paint without the dashes, after their path's outline.
 */

/** The blend of each fill mode: positive towards white, negative towards black (LibreOffice's dBrightness). */
export const FILL_BRIGHTNESS: Readonly<Record<PathFill, number>> = {
  norm: 0,
  none: 0,
  lighten: 0.4,
  lightenLess: 0.2,
  darken: -0.4,
  darkenLess: -0.2,
};

/** Fill rule of every geometry path (LibreOffice fills polygons even-odd). */
export const GEOM_FILL_RULE: CanvasFillRule = 'evenodd';

/** A channel within 0..255 (NaN is 0). */
function channel(v: number): number {
  return v > 0 ? Math.min(v, 255) : 0;
}

/**
 * A colour blended as LibreOffice's `GetColorData` blends it: brightness b > 0 moves each channel c to
 * c·(1 − b) + 255·b, b < 0 to c·(1 + b), clamped to 0..255 and truncated; alpha is unchanged. b = 0 returns `c`.
 */
export function shadeRgba(c: Rgba, brightness: number): Rgba {
  const b = Number.isFinite(brightness) ? Math.min(Math.max(brightness, -1), 1) : 0;
  if (b === 0) return c;
  const f =
    b > 0
      ? (v: number): number => Math.trunc(channel(channel(v) * (1 - b) + b * 255))
      : (v: number): number => Math.trunc(channel(channel(v) * (1 + b)));
  return { r: f(c.r), g: f(c.g), b: f(c.b), a: c.a };
}

/** A fill or stroke paint that is not a plain colour. */
export type GeomStyle = string | CanvasGradient | CanvasPattern;

/**
 * A paint defined in its own space: `style` (a gradient built there) is used under `transform`, the affine
 * (a b c d e f, as `DOMMatrix`) from that space to box space, so an elliptical radial gradient can be a
 * circle in a stretched space. The path is mapped into that space for the fill.
 */
export interface GeomSpacePaint {
  readonly style: GeomStyle;
  readonly transform: readonly [number, number, number, number, number, number];
}

/**
 * The fill of a geometry: a colour (shaded here per path), or a painter that returns the style for a brightness
 * of FILL_BRIGHTNESS (0 for norm), built in box space (or its own, `GeomSpacePaint`) so one gradient spans
 * every path as in LibreOffice.
 */
export type GeomFill = Rgba | ((brightness: number) => GeomStyle | GeomSpacePaint);

/**
 * The outline: its paint and width (box units), and optionally its dash pattern (box units, already scaled
 * by the width: `ctx.setLineDash`) and line ends. Joins and caps are the caller's, set on the context.
 */
export interface GeomStroke {
  readonly color: Rgba | GeomStyle;
  readonly width: number;
  readonly dash?: readonly number[];
  readonly ends?: GeomEnds;
}

/** What a path is traced into: a CanvasRenderingContext2D, an OffscreenCanvasRenderingContext2D or a Path2D. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  closePath(): void;
}

/** Traces a built path into `sink` (box space). */
export function traceGeomPath(sink: PathSink, path: GeomPath): void {
  const p = path.pts;
  let at = 0;
  for (const op of path.cmds) {
    if (op === CMD_MOVE) {
      sink.moveTo(p[at]!, p[at + 1]!);
      at += 2;
    } else if (op === CMD_LINE) {
      sink.lineTo(p[at]!, p[at + 1]!);
      at += 2;
    } else if (op === CMD_QUAD) {
      sink.quadraticCurveTo(p[at]!, p[at + 1]!, p[at + 2]!, p[at + 3]!);
      at += 4;
    } else if (op === CMD_CUBIC) {
      sink.bezierCurveTo(p[at]!, p[at + 1]!, p[at + 2]!, p[at + 3]!, p[at + 4]!, p[at + 5]!);
      at += 6;
    } else if (op === CMD_CLOSE) sink.closePath();
  }
}

const OPEN_CACHE = new WeakMap<GeomPath, boolean>();

/**
 * Whether a built path is open as LibreOffice decides it: some sub-path with a segment is not closed and does
 * not end within `tolerance` of its start. Its outline is drawn after the other paths (drawGeom).
 */
export function geomPathOpen(path: GeomPath, tolerance = 0): boolean {
  const p = path.pts;
  let at = 0;
  let sx = 0;
  let sy = 0;
  let ex = 0;
  let ey = 0;
  let segments = 0;
  const open = () => segments > 0 && (Math.abs(ex - sx) > tolerance || Math.abs(ey - sy) > tolerance);
  for (const op of path.cmds) {
    if (op === CMD_MOVE) {
      if (open()) return true;
      sx = ex = p[at]!;
      sy = ey = p[at + 1]!;
      segments = 0;
      at += 2;
    } else if (op === CMD_CLOSE) {
      segments = 0;
      ex = sx;
      ey = sy;
    } else {
      const n = op === CMD_LINE ? 2 : op === CMD_QUAD ? 4 : op === CMD_CUBIC ? 6 : 0;
      if (n === 0) continue;
      at += n;
      ex = p[at - 2]!;
      ey = p[at - 1]!;
      segments++;
    }
  }
  return open();
}

/** geomPathOpen at CLOSED_TOLERANCE of the geometry's box, once per path object (`drawGeom` strokes it last). */
export function pathOpen(path: GeomPath, built: BuiltGeom): boolean {
  let open = OPEN_CACHE.get(path);
  if (open === undefined) {
    open = geomPathOpen(path, CLOSED_TOLERANCE * Math.max(built.w, built.h));
    OPEN_CACHE.set(path, open);
  }
  return open;
}

const PATH2D_CACHE = new WeakMap<GeomPath, Path2D>();

/** A Path2D of a built path, made once per path object. */
export function geomPath2D(path: GeomPath): Path2D {
  let p = PATH2D_CACHE.get(path);
  if (p === undefined) {
    p = new Path2D();
    traceGeomPath(p, path);
    PATH2D_CACHE.set(path, p);
  }
  return p;
}

/** The fill rule of `geomFillPath2D`'s union path (fill it, or clip to it, with this rule). */
export const GEOM_CLIP_RULE: CanvasFillRule = 'nonzero';

/** Traces a sub-path forwards, or backwards (the same outline the other way round), closed. */
function traceSub(sink: PathSink, sub: UnionSub, reverse: boolean): void {
  const segs = sub.segs;
  if (!reverse) {
    sink.moveTo(segs[0]!.p[0]!, segs[0]!.p[1]!);
    for (const s of segs) {
      const q = s.p;
      if (s.op === CMD_LINE) sink.lineTo(q[2]!, q[3]!);
      else if (s.op === CMD_QUAD) sink.quadraticCurveTo(q[2]!, q[3]!, q[4]!, q[5]!);
      else sink.bezierCurveTo(q[2]!, q[3]!, q[4]!, q[5]!, q[6]!, q[7]!);
    }
  } else {
    const last = segs[segs.length - 1]!.p;
    sink.moveTo(last[last.length - 2]!, last[last.length - 1]!);
    for (let i = segs.length - 1; i >= 0; i--) {
      const q = segs[i]!.p;
      if (segs[i]!.op === CMD_LINE) sink.lineTo(q[0]!, q[1]!);
      else if (segs[i]!.op === CMD_QUAD) sink.quadraticCurveTo(q[2]!, q[3]!, q[0]!, q[1]!);
      else sink.bezierCurveTo(q[4]!, q[5]!, q[2]!, q[3]!, q[0]!, q[1]!);
    }
  }
  sink.closePath();
}

/**
 * Traces a path so that its non-zero fill is its even-odd fill (GEOM_FILL_RULE) with winding 0 or 1: each
 * closed sub-path is turned to wind positively when an even number of the path's other sub-paths contain its
 * first point, negatively (a hole) when an odd number do. Paths traced so into one sink fill (GEOM_CLIP_RULE)
 * as the union of their even-odd regions: overlapping paths add up instead of cancelling. Exact for sub-paths
 * that do not cross themselves or each other (every preset); crossing ones fill as non-zero would. A stored
 * geometry's pieces (`cont`) arrive joined (`storedGeometry`), so holes in one piece of an outline stored in
 * another are holes here too.
 */
export function traceUnionPath(sink: PathSink, path: GeomPath): void {
  const subs = unionSubs(path);
  const depths = nestingDepths(subs);
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i]!;
    const want = (depths?.[i] ?? 0) % 2 === 0 ? 1 : -1;
    traceSub(sink, s, Math.sign(s.area) === -want);
  }
}

const UNION_CACHE = new WeakMap<BuiltGeom, Path2D>();

/**
 * One Path2D of the union of a geometry's filled paths (fill ≠ none), each with its holes (the even-odd rule),
 * for cutting a picture to the shape: fill it, or clip to it, with GEOM_CLIP_RULE (`traceUnionPath`). The
 * paths of a preset such as smileyFace overlap (its eyes are a second, darker path over the face): one even-odd
 * path of both would cut the eyes out of the picture. Made once per built geometry (a stored one is memoised
 * per box); never change the Path2D it returns.
 */
export function geomFillPath2D(built: BuiltGeom): Path2D {
  let p = UNION_CACHE.get(built);
  if (p === undefined) {
    p = new Path2D();
    for (const path of built.paths) if (path.fill !== 'none') traceUnionPath(p, path);
    UNION_CACHE.set(built, p);
  }
  return p;
}

function styleOf(paint: Rgba | GeomStyle): GeomStyle {
  return typeof paint === 'object' && paint !== null && 'r' in paint ? rgbaCss(paint) : paint;
}

function isSpacePaint(v: GeomStyle | GeomSpacePaint): v is GeomSpacePaint {
  return typeof v === 'object' && v !== null && 'transform' in v && 'style' in v;
}

/** Fills `p2d` (box space) with a style, or with a paint defined in its own space. */
function fillWith(ctx: Ctx2D, p2d: Path2D, style: GeomStyle | GeomSpacePaint): void {
  if (!isSpacePaint(style)) {
    ctx.fillStyle = style;
    ctx.fill(p2d, GEOM_FILL_RULE);
    return;
  }
  const [a, b, c, d, e, f] = style.transform;
  const det = a * d - b * c;
  if (!(Math.abs(det) > 1e-12) || typeof DOMMatrix === 'undefined') return;
  const inv = new DOMMatrix([a, b, c, d, e, f]).inverse();
  const q = new Path2D();
  q.addPath(p2d, inv);
  ctx.save();
  ctx.transform(a, b, c, d, e, f);
  ctx.fillStyle = style.style;
  ctx.fill(q, GEOM_FILL_RULE);
  ctx.restore();
}

const ENDED_CACHE = new WeakMap<GeomPath, { ends: GeomEnds; shaft: Path2D; markers: Path2D[] }>();

/** A path's shaft and marker Path2Ds for `ends`, made once per path object and ends. */
function endedPath2D(path: GeomPath, ends: GeomEnds, built: BuiltGeom): { shaft: Path2D; markers: Path2D[] } {
  const hit = ENDED_CACHE.get(path);
  if (hit && hit.ends === ends) return hit;
  const e = withEnds(path, ends, CLOSED_TOLERANCE * Math.max(built.w, built.h));
  const shaft = new Path2D();
  traceGeomPath(shaft, e.shaft);
  const markers = e.markers.map((m) => {
    const p = new Path2D();
    for (let i = 0; i < m.length; i += 2) {
      if (i === 0) p.moveTo(m[0]!, m[1]!);
      else p.lineTo(m[i]!, m[i + 1]!);
    }
    p.closePath();
    return p;
  });
  const out = { ends, shaft, markers };
  ENDED_CACHE.set(path, out);
  return out;
}

/**
 * Draws a built geometry at the context's current transform, which maps box space (0..w, 0..h) to the canvas
 * (the caller translates to the box and applies rotation, flips and opacity), in LibreOffice's order: each path
 * filled, then stroked unless it is open; the open paths' outlines last. No fill or no stroke: pass
 * undefined or null. Leaves fillStyle, strokeStyle and lineWidth changed; save and restore around it.
 */
export function drawGeom(
  ctx: Ctx2D,
  built: BuiltGeom,
  fill?: GeomFill | null,
  stroke?: GeomStroke | null,
): void {
  const width = stroke ? stroke.width : 0;
  const stroked = stroke !== undefined && stroke !== null && Number.isFinite(width) && width > 0;
  const strokeStyle = stroked ? styleOf(stroke.color) : undefined;
  const dash = stroked && stroke.dash?.length ? stroke.dash : undefined;
  const ends = stroked && (stroke.ends?.head || stroke.ends?.tail) ? stroke.ends : undefined;
  const shades = new Map<number, GeomStyle | GeomSpacePaint>();
  const fillStyle = (brightness: number): GeomStyle | GeomSpacePaint => {
    let s = shades.get(brightness);
    if (s === undefined) {
      s = typeof fill === 'function' ? fill(brightness) : rgbaCss(shadeRgba(fill as Rgba, brightness));
      shades.set(brightness, s);
    }
    return s;
  };
  const stroke2d = (path: GeomPath, p2d: Path2D): void => {
    ctx.lineWidth = width;
    ctx.strokeStyle = strokeStyle!;
    if (!ends || !pathOpen(path, built)) {
      if (dash) ctx.setLineDash(dash as number[]);
      ctx.stroke(p2d);
      if (dash) ctx.setLineDash([]);
      return;
    }
    const e = endedPath2D(path, ends, built);
    if (dash) ctx.setLineDash(dash as number[]);
    ctx.stroke(e.shaft);
    if (dash) ctx.setLineDash([]);
    if (e.markers.length) {
      ctx.fillStyle = strokeStyle!;
      for (const m of e.markers) ctx.fill(m, 'nonzero');
    }
  };
  let later: GeomPath[] | undefined;
  for (const path of built.paths) {
    const doFill = fill !== undefined && fill !== null && path.fill !== 'none';
    const doStroke = stroked && path.stroke;
    if ((!doFill && !doStroke) || path.cmds.length === 0) continue;
    const p2d = geomPath2D(path);
    if (doFill) fillWith(ctx, p2d, fillStyle(FILL_BRIGHTNESS[path.fill]));
    if (doStroke) {
      if (pathOpen(path, built)) (later ??= []).push(path);
      else stroke2d(path, p2d);
    }
  }
  if (later) for (const path of later) stroke2d(path, geomPath2D(path));
}
