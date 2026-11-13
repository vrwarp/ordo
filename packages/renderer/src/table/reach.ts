import type { ShapeObject } from '@ordo/domain';
import { CLAMP, num } from '../clamp.ts';
import type { Ctx2D } from '../ctx.ts';
import { richLayoutBounds, textHooked, turned } from '../sprite.ts';
import { currentFontEnv } from '../text/fonts.ts';
import { measurerFor } from '../text/measure.ts';
import { layoutTable, tableStrokes } from './layout.ts';

/** Logical px every table bound is grown by: antialiasing and the lines' rounding to whole device px. */
const TABLE_SLACK = 1;

/**
 * Where `drawTable` draws a clamped table shape (logical px, slide space; `ShapeReach` for the tight sprites,
 * design/27 §7.3): the drawn table (its grown height: rows grow with their text), every line and diagonal
 * grown by half its width (a line is stretched at its ends by half the widest line it meets, still inside
 * that), and each cell's text as the rich engine lays it out and paints it (`richLayoutBounds`, which includes
 * the text's overflow of a fixed row and its effects), turned with the table's box about its centre.
 * Undefined when the shape has no drawable table (it falls to its legacy rect); null when a cell's text is
 * painted by a registered hook (a vertical or warped text painter), which the plain plan does not bound.
 */
export function tableReach(
  ctx: Ctx2D,
  o: ShapeObject,
): { x: number; y: number; w: number; h: number } | null | undefined {
  const m = measurerFor(ctx);
  const l = layoutTable(m, o, currentFontEnv());
  if (!l) return undefined;
  let x0 = Math.min(0, l.width);
  let y0 = Math.min(0, l.height);
  let x1 = Math.max(0, l.width);
  let y1 = Math.max(0, l.height);
  const styles = l.model.t.lineStyles ?? [];
  const half = (li: number | undefined) =>
    li === undefined || !styles[li] ? 0 : Math.max(num(styles[li]!.width, 0, CLAMP.maxEffectPx, 0), 0.5) / 2;
  const add = (ax: number, ay: number, bx: number, by: number, h: number) => {
    if (!(Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(bx) && Number.isFinite(by))) return;
    x0 = Math.min(x0, ax - h, bx - h);
    y0 = Math.min(y0, ay - h, by - h);
    x1 = Math.max(x1, ax + h, bx + h);
    y1 = Math.max(y1, ay + h, by + h);
  };
  for (const stroke of tableStrokes(l)) {
    const h = half(stroke.line);
    const q = stroke.segs;
    for (let i = 0; i + 3 < q.length; i += 4) add(q[i]!, q[i + 1]!, q[i + 2]!, q[i + 3]!, h);
  }
  let fx = 0;
  for (const c of l.cells) {
    const diag = l.model.t.cells[c.index]?.diag;
    if (diag) {
      const h = Math.max(half(diag.down), half(diag.up));
      add(c.box.x, c.box.y, c.box.x + c.box.w, c.box.y + c.box.h, h);
    }
    if (!c.text.text) continue;
    if (textHooked(c.text)) return null;
    const k = richLayoutBounds(m, c.text, c.layout);
    if (!k) continue;
    // `drawTable` paints the cell's layout from the cell's corner moved by its anchor.
    const dx = c.box.x;
    const dy = c.box.y + c.dy;
    x0 = Math.min(x0, k.x0 + dx);
    y0 = Math.min(y0, k.y0 + dy);
    x1 = Math.max(x1, k.x1 + dx);
    y1 = Math.max(y1, k.y1 + dy);
    fx = Math.max(fx, k.fx);
  }
  const b = o.box;
  return turned(b.x + x0, b.y + y0, b.x + x1, b.y + y1, b, fx + TABLE_SLACK);
}
