import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD } from './ops.ts';
import type { GeomPath } from './path.ts';

/*
 * How the sub-paths of one built path nest (design/27 §7.1): which contain which, worked out within a bound of
 * work, and the even-odd area that follows from it. Pure and DOM-free (no Path2D, no canvas): the drawer
 * (`draw.ts` `traceUnionPath`, which re-exports what is here) traces a picture's clip or an effect's
 * silhouette by it, and the converter (`pptx-scene` `geom.ts` `inkOf`) rates a custom geometry's legacy shape
 * by `evenOddArea`, so both agree on what a path fills.
 */

/**
 * Sub-paths of one path above which `traceUnionPath` no longer works out nesting (each pair's bounding boxes
 * are compared): they are all traced one way round, as filled outlines without holes. A traced decoration is
 * one outline holding a few hundred holes, often stored in pieces (`ShapeGeom.paths[].cont`) that arrive here
 * joined into one path.
 */
export const UNION_NESTING_LIMIT = 2_048;

/**
 * Polygon edges `traceUnionPath` tests at most to work out nesting (each sub-path's first point against the
 * flattened sub-paths whose bounding boxes hold it): past it, nesting is not worked out (as past
 * UNION_NESTING_LIMIT), so a hostile path costs a few milliseconds at most.
 */
export const UNION_NESTING_WORK = 4_000_000;

/** A sub-path: its segments' points (start, controls, end per segment), flattened for area and containment. */
export interface UnionSub {
  /** Commands after the move (CMD_LINE, CMD_QUAD, CMD_CUBIC), with their points (x y pairs, the start first). */
  readonly segs: { op: number; p: number[] }[];
  readonly flat: number[];
  readonly area: number;
  /** Bounding box of `flat`: min x, min y, max x, max y. */
  readonly box: readonly [number, number, number, number];
}

const FLAT_STEPS = 8;

/** A path's sub-paths (`traceUnionPath`, `evenOddArea`): each closed or open one with its flattened points. */
export function unionSubs(path: GeomPath): UnionSub[] {
  const out: UnionSub[] = [];
  const p = path.pts;
  let at = 0;
  let segs: UnionSub['segs'] = [];
  let flat: number[] = [];
  let cx = 0;
  let cy = 0;
  const end = (): void => {
    if (segs.length) {
      let area = 0;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0, n = flat.length; i < n; i += 2) {
        const j = (i + 2) % n;
        const x = flat[i]!;
        const y = flat[i + 1]!;
        area += x * flat[j + 1]! - flat[j]! * y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      out.push({ segs, flat, area: area / 2, box: [x0, y0, x1, y1] });
    }
    segs = [];
    flat = [];
  };
  for (const op of path.cmds) {
    if (op === CMD_MOVE) {
      end();
      cx = p[at]!;
      cy = p[at + 1]!;
      flat.push(cx, cy);
      at += 2;
    } else if (op === CMD_CLOSE) {
      const sx = flat[0];
      const sy = flat[1];
      end();
      if (sx !== undefined && sy !== undefined) {
        cx = sx;
        cy = sy;
        flat.push(cx, cy);
      }
    } else {
      const n = op === CMD_LINE ? 2 : op === CMD_QUAD ? 4 : op === CMD_CUBIC ? 6 : 0;
      if (n === 0) continue;
      if (!flat.length) flat.push(cx, cy);
      const pts = [cx, cy];
      for (let k = 0; k < n; k++) pts.push(p[at + k]!);
      at += n;
      segs.push({ op, p: pts });
      if (op === CMD_LINE) flat.push(pts[2]!, pts[3]!);
      else
        for (let i = 1; i <= FLAT_STEPS; i++) {
          const t = i / FLAT_STEPS;
          const u = 1 - t;
          if (op === CMD_QUAD)
            flat.push(
              u * u * pts[0]! + 2 * u * t * pts[2]! + t * t * pts[4]!,
              u * u * pts[1]! + 2 * u * t * pts[3]! + t * t * pts[5]!,
            );
          else
            flat.push(
              u * u * u * pts[0]! + 3 * u * u * t * pts[2]! + 3 * u * t * t * pts[4]! + t * t * t * pts[6]!,
              u * u * u * pts[1]! + 3 * u * u * t * pts[3]! + 3 * u * t * t * pts[5]! + t * t * t * pts[7]!,
            );
        }
      cx = pts[pts.length - 2]!;
      cy = pts[pts.length - 1]!;
    }
  }
  end();
  return out;
}

/** Whether (x, y) is inside a flattened polygon (even-odd crossing test). */
function inside(flat: readonly number[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, n = flat.length; i < n; i += 2) {
    const j = (i + 2) % n;
    const yi = flat[i + 1]!;
    const yj = flat[j + 1]!;
    if (yi > y !== yj > y && x < ((flat[j]! - flat[i]!) * (y - yi)) / (yj - yi) + flat[i]!) c = !c;
  }
  return c;
}

/**
 * How many of `subs` other than each one contain its first point (its nesting depth), or undefined past
 * UNION_NESTING_LIMIT sub-paths or UNION_NESTING_WORK edges tested. A sub-path is tested only against those
 * whose bounding boxes hold the point.
 */
export function nestingDepths(subs: readonly UnionSub[]): number[] | undefined {
  if (subs.length > UNION_NESTING_LIMIT) return undefined;
  const depths: number[] = [];
  let work = 0;
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i]!;
    const x = s.flat[0]!;
    const y = s.flat[1]!;
    let depth = 0;
    for (let j = 0; j < subs.length; j++) {
      if (j === i) continue;
      const o = subs[j]!;
      const b = o.box;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      work += o.flat.length / 2;
      if (work > UNION_NESTING_WORK) return undefined;
      if (inside(o.flat, x, y)) depth++;
    }
    depths.push(depth);
  }
  return depths;
}

/**
 * The area a path fills under the even-odd rule (GEOM_FILL_RULE, as every drawer fills it), in its own units
 * squared: each sub-path's area (curves flattened as `traceUnionPath` flattens them, an open one closed as a
 * fill closes it) added when an even number of the path's other sub-paths contain its first point, taken away
 * (a hole) when an odd number do, the nesting `traceUnionPath` works out. Exact for sub-paths that cross
 * neither themselves nor each other (a traced outline and its holes); crossing ones count as they nest.
 * Undefined when the nesting is not worked out (past UNION_NESTING_LIMIT sub-paths or UNION_NESTING_WORK
 * edges tested) or a point is not a finite number. Pure and bounded as `traceUnionPath` is; never throws.
 * The converter rates a custom geometry's legacy shape by it (`pptx-scene` `geom.ts` `customPaths` `ink`).
 */
export function evenOddArea(path: GeomPath): number | undefined {
  let moves = 0;
  for (const op of path.cmds) if (op === CMD_MOVE && ++moves > UNION_NESTING_LIMIT) return undefined;
  const subs = unionSubs(path);
  const depths = nestingDepths(subs);
  if (!depths) return undefined;
  let area = 0;
  for (let i = 0; i < subs.length; i++) {
    const a = Math.abs(subs[i]!.area);
    area += depths[i]! % 2 === 0 ? a : -a;
  }
  return Number.isFinite(area) ? Math.max(0, area) : undefined;
}
