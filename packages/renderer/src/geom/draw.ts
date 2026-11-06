import { type Rgba, rgbaCss } from '@ordo/domain';
import type { Ctx2D } from '../ctx.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD, type PathFill } from './ops.ts';
import type { BuiltGeom, GeomPath } from './path.ts';

/*
 * Drawing a built geometry (path.ts) with Canvas 2D (design/27 §7.1, §15 M6). Order and colours follow
 * LibreOffice, the fidelity reference (svx EnhancedCustomShape2d: CreateSubPath, GetColorData):
 * - Paths are drawn in document order, each filled and then stroked, so a later path covers an earlier one's
 *   outline (POI fills every path before stroking any; the presets look the same either way).
 * - A path is filled with the even-odd rule, LibreOffice's (and PowerPoint's for freeforms); an open path is
 *   filled as if closed and stroked open.
 * - fill="none" is not filled, stroke="false" not stroked.
 * - The shaded modes blend the shape's fill: lighten and lightenLess towards white by 40 % and 20 %, darken and
 *   darkenLess towards black by 40 % and 20 %, per channel, truncated to an integer as LibreOffice does; alpha is
 *   kept. Strokes are never shaded. A gradient or picture fill is shaded by the caller's painter (LibreOffice
 *   shades each gradient stop).
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
 * The fill of a geometry: a colour (shaded here per path), or a painter that returns the style for a brightness
 * of FILL_BRIGHTNESS (0 for norm), built in box space so one gradient spans every path as in LibreOffice.
 */
export type GeomFill = Rgba | ((brightness: number) => GeomStyle);

/** The outline: its paint and width (box units). Dashes, joins and caps are the caller's, set on the context. */
export interface GeomStroke {
  readonly color: Rgba | GeomStyle;
  readonly width: number;
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

/**
 * One Path2D of every filled path of a geometry (fill ≠ none), for clipping a picture to the shape (fill it, or
 * clip to it, with GEOM_FILL_RULE).
 */
export function geomFillPath2D(built: BuiltGeom): Path2D {
  const p = new Path2D();
  for (const path of built.paths) if (path.fill !== 'none') traceGeomPath(p, path);
  return p;
}

function styleOf(paint: Rgba | GeomStyle): GeomStyle {
  return typeof paint === 'object' && paint !== null && 'r' in paint ? rgbaCss(paint) : paint;
}

/**
 * Draws a built geometry at the context's current transform, which maps box space (0..w, 0..h) to the canvas
 * (the caller translates to the box and applies rotation, flips and opacity). No fill or no stroke: pass
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
  const shades = new Map<number, GeomStyle>();
  const fillStyle = (brightness: number): GeomStyle => {
    let s = shades.get(brightness);
    if (s === undefined) {
      s = typeof fill === 'function' ? fill(brightness) : rgbaCss(shadeRgba(fill as Rgba, brightness));
      shades.set(brightness, s);
    }
    return s;
  };
  for (const path of built.paths) {
    const doFill = fill !== undefined && fill !== null && path.fill !== 'none';
    const doStroke = stroked && path.stroke;
    if ((!doFill && !doStroke) || path.cmds.length === 0) continue;
    const p2d = geomPath2D(path);
    if (doFill) {
      ctx.fillStyle = fillStyle(FILL_BRIGHTNESS[path.fill]);
      ctx.fill(p2d, GEOM_FILL_RULE);
    }
    if (doStroke) {
      ctx.lineWidth = width;
      ctx.strokeStyle = strokeStyle!;
      ctx.stroke(p2d);
    }
  }
}
