import type { ShapeObject } from '@ordo/domain';
import type { TableLayout } from './layout.ts';

/*
 * Which cell is where (design/27 M9 tables, for the editor's cell selection): a slide point to the table's
 * own space, and a table-local point to the cell under it.
 */

/** A slide point (logical px) in a table's own space: from its box's top-left corner, its turn undone. */
export function tablePoint(o: Pick<ShapeObject, 'box'>, x: number, y: number): { x: number; y: number } {
  const b = o.box;
  if (!b.rotation) return { x: x - b.x, y: y - b.y };
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const a = (-b.rotation * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return {
    x: dx * Math.cos(a) - dy * Math.sin(a) + b.w / 2,
    y: dx * Math.sin(a) + dy * Math.cos(a) + b.h / 2,
  };
}

/** The last index k with edges[k] ≤ v in an increasing list, or -1 below it. */
function below(edges: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = edges.length - 1;
  if (!(v >= edges[0]!)) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (edges[mid]! <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The index (in `TableData.cells`) of the cell under a table-local point (`tablePoint`), or -1 outside the
 * table or over a slot no cell covers.
 */
export function tableHit(l: TableLayout, x: number, y: number): number {
  const { R, C, slots } = l.model.placement;
  if (!(x >= 0 && x < l.width && y >= 0 && y < l.height) || !R || !C) return -1;
  const rtl = l.model.t.rtl === true;
  // Column edges from the left in logical order (mirrored back for a right-to-left table).
  const lx = rtl ? l.width - x : x;
  const left = rtl ? Float64Array.from(l.colX, (v) => l.width - v) : l.colX;
  const c = Math.min(C - 1, below(left, lx));
  const r = Math.min(R - 1, below(l.rowY, y));
  if (c < 0 || r < 0) return -1;
  return slots[r * C + c] ?? -1;
}
