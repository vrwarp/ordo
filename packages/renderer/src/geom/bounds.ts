import { arrowReach } from './ends.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD } from './ops.ts';
import type { Outline } from './outline.ts';
import type { BuiltGeom } from './path.ts';

/*
 * What a shape covers (design/27 §12 drawing cost, §7.5): the bounds its fills, outlines and arrowheads are
 * drawn within, in box space, and where they land on the slide. The effect drawer makes a shape's shadow, glow
 * and soft-edge layers over these bounds (`effects.ts` `drawEffected`), the effect budget sizes the layers by
 * them (`cost.ts` `effectArea`) and the drawing estimate cuts painted areas to the slide with them, so the
 * drawer, the renderer's slide budget and the converter measure the same area. Pure: the converter reads it.
 */

/** A rectangle (box space or slide space, logical px). */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Where a box lies on the slide (an ordo `Box`, logical px, rotation in degrees about its centre) and its flips. */
export interface Placement {
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly rotation?: number | undefined;
  };
  readonly flipH?: boolean | undefined;
  readonly flipV?: boolean | undefined;
}

/** The canvas every drawer draws a slide on, in logical px (`raster.ts`: the 1920 x 1080 frame at a scale). */
export const CANVAS_W = 1920;
export const CANVAS_H = 1080;

/** The bounds of a geometry's points (control points included, so conservative) and its box. */
export function geomBounds(b: BuiltGeom): Bounds {
  let x0 = 0;
  let y0 = 0;
  let x1 = b.w;
  let y1 = b.h;
  for (const p of b.paths)
    for (let i = 0; i + 1 < p.pts.length; i += 2) {
      const x = p.pts[i]!;
      const y = p.pts[i + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return { x0, y0, x1, y1 };
}

const miterMemo = new WeakMap<BuiltGeom, Map<number, number>>();

/**
 * The largest miter of a geometry's stroked paths, as a multiple of half the line width (1: none reaches past
 * half the width): at each join between two segments (the incoming segment's last leg and the outgoing one's
 * first, a curve's tangent at its ends; a closed sub-path's start too) the miter tip lies 1/cos(turn/2) half
 * widths from the vertex, where Canvas draws it at all: within `limit`, else the join is beveled (half a width).
 * A curve's inside has no join (its offset stays within half a width of it). Memoised per geometry and limit.
 */
export function miterFactor(built: BuiltGeom, limit: number): number {
  let byLimit = miterMemo.get(built);
  const hit = byLimit?.get(limit);
  if (hit !== undefined) return hit;
  let worst = 1;
  for (const p of built.paths) {
    if (!p.stroke) continue;
    worst = Math.max(worst, pathMiter(p.cmds, p.pts, limit));
  }
  if (!byLimit) miterMemo.set(built, (byLimit = new Map()));
  byLimit.set(limit, worst);
  return worst;
}

function pathMiter(cmds: readonly number[], pts: readonly number[], limit: number): number {
  let worst = 1;
  let at = 0;
  let cx = 0;
  let cy = 0;
  // Of the sub-path being walked: the first leg's direction, the last leg's, and whether one was seen.
  let fdx = 0;
  let fdy = 0;
  let ldx = 0;
  let ldy = 0;
  let legs = 0;
  let sx = 0;
  let sy = 0;
  const join = (ax: number, ay: number, bx: number, by: number) => {
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (!(la > 0) || !(lb > 0)) return;
    const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
    // cos(turn / 2) = √((1 + cos turn) / 2): the miter ratio is its inverse.
    const half = Math.sqrt((1 + cos) / 2);
    const ratio = half > 0 ? 1 / half : Number.POSITIVE_INFINITY;
    if (ratio <= limit && ratio > worst) worst = ratio;
  };
  /** One segment from the current point through `n` pairs: joined to the last leg at its start. */
  const segment = (n: number) => {
    let first = true;
    for (let j = 0; j < n && at + 1 < pts.length; j++, at += 2) {
      const x = pts[at]!;
      const y = pts[at + 1]!;
      const dx = x - cx;
      const dy = y - cy;
      if (dx !== 0 || dy !== 0) {
        if (first) {
          if (legs) join(ldx, ldy, dx, dy);
          else {
            fdx = dx;
            fdy = dy;
          }
          first = false;
        }
        ldx = dx;
        ldy = dy;
        legs++;
      }
      cx = x;
      cy = y;
    }
  };
  for (const op of cmds) {
    if (op === CMD_MOVE) {
      if (at + 1 >= pts.length) break;
      sx = cx = pts[at]!;
      sy = cy = pts[at + 1]!;
      at += 2;
      legs = 0;
      continue;
    }
    if (op === CMD_CLOSE) {
      if (cx !== sx || cy !== sy) {
        const dx = sx - cx;
        const dy = sy - cy;
        if (legs) join(ldx, ldy, dx, dy);
        ldx = dx;
        ldy = dy;
        legs++;
      }
      if (legs > 1) join(ldx, ldy, fdx, fdy);
      cx = sx;
      cy = sy;
      legs = 0;
      continue;
    }
    if (op === CMD_LINE) segment(1);
    else if (op === CMD_QUAD) segment(2);
    else if (op === CMD_CUBIC) segment(3);
  }
  return worst;
}

/**
 * How far an outline reaches past the path it strokes (box units): half its width times the farthest its
 * joins (`miterFactor` for miter joins; half a width for round and bevel ones) and caps (a square cap's
 * corner, √2 half widths; flat and round caps half a width) reach, and its arrowheads' size from the end point.
 */
export function outlineReach(built: BuiltGeom, o: Outline | undefined): number {
  if (!o || !(o.width > 0)) return 0;
  const half = o.width / 2;
  const join = o.join === 'miter' ? miterFactor(built, Math.max(1, o.miterLimit)) : 1;
  const cap = o.cap === 'square' ? Math.SQRT2 : 1;
  const r = Math.max(half * Math.max(join, cap), arrowReach(o.ends?.head), arrowReach(o.ends?.tail));
  return Number.isFinite(r) ? r : 0;
}

/**
 * What a shape draws, in box space: its geometry's points and box (`geomBounds`) grown by its outline's reach
 * (`outlineReach`). Its effect layers are made over these bounds (`effects.ts`) and sized by them (`effectArea`).
 */
export function drawnBounds(built: BuiltGeom, o: Outline | undefined): Bounds {
  const b = geomBounds(built);
  const grow = outlineReach(built, o);
  return { x0: b.x0 - grow, y0: b.y0 - grow, x1: b.x1 + grow, y1: b.y1 + grow };
}

/**
 * A box-space rectangle on the slide (logical px): the bounds of its corners flipped about the box's centre,
 * rotated about it and moved to the box, as `placeBox` draws them.
 */
export function placedBounds(b: Bounds, p: Placement): Bounds {
  const { x, y, w, h } = p.box;
  const cx = w / 2;
  const cy = h / 2;
  const rad = ((Number.isFinite(p.box.rotation) ? p.box.rotation! : 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = p.flipH ? -1 : 1;
  const sy = p.flipV ? -1 : 1;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x0, b.y1],
    [b.x1, b.y1],
  ] as const) {
    const u = (px - cx) * sx;
    const v = (py - cy) * sy;
    const X = x + cx + u * cos - v * sin;
    const Y = y + cy + u * sin + v * cos;
    if (X < x0) x0 = X;
    if (X > x1) x1 = X;
    if (Y < y0) y0 = Y;
    if (Y > y1) y1 = Y;
  }
  return { x0, y0, x1, y1 };
}

/** The largest reach past the canvas `canvasArea` takes (logical px; far past any effect the clamp allows). */
const MAX_REACH = 1e5;

/** The area (logical px²) of `b` (slide space) within the canvas grown by `reach` a side; 0 when empty. */
export function canvasArea(b: Bounds, reach = 0): number {
  const r = Number.isFinite(reach) && reach > 0 ? Math.min(reach, MAX_REACH) : 0;
  const w = Math.min(b.x1, CANVAS_W + r) - Math.max(b.x0, -r);
  const h = Math.min(b.y1, CANVAS_H + r) - Math.max(b.y0, -r);
  const a = w > 0 && h > 0 ? w * h : 0;
  return Number.isFinite(a) ? a : (CANVAS_W + 2 * r) * (CANVAS_H + 2 * r);
}
