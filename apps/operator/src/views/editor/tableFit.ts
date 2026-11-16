import { growRow, type ShapeObject, type SlideObject } from '@ordo/domain';
import type * as TableKit from '@ordo/renderer/table/index.ts';
import type { TableLayout } from '@ordo/renderer/table/layout.ts';

/*
 * Rows follow the text on an edit (design/15 "Table editing"; r2b sub-wave 1b tables-form). An imported table
 * stores LibreOffice's rows, fixed (`rowRule: 'fixed'`, design/27 §15 "The stored form"), so the drawer never
 * grows them: an edit that makes a cell's text need more room grows that cell's row here, by the increase in
 * the cell's need only (`fitRows`). Never by the absolute shortfall: where the drawer's lines are taller than
 * the converter's model of LibreOffice's (2 Corinthians 3 vs 7, Churchcraft), cells already need a few px
 * more than their fixed row before any edit, and a one-letter fix would make the rows jump.
 *
 * `fitRows(before, after, layout)` is pure: it lays both objects out with the drawer's layout (`layout`, the
 * renderer's `layoutTable` of the clamped shape; a cell's `need` is its text height plus its insets) and grows
 * a single-row cell's row by max(0, needAfter - max(rowHeight, needBefore)), the largest per row, then a merged
 * cell's last row by what it needs past its rows' sum (as the layout gives a merge its extra); rows never
 * shrink, other rows stay, `box.h` follows (`@ordo/domain` `growRow`). A cell is the same cell before and after
 * by its index while the grid keeps its rows, columns and cells (an edit, Find & Replace, a box resize), else
 * by its text in reading order (a row or column added or deleted); a cell with no text, or new to the table,
 * grows nothing. A table whose rows grow (made in ordo) is left to the drawer.
 *
 * `fitTable(before, after)` is what the ops call after every committed table change (editCell, Find & Replace
 * in cells, the row and column ops, a box resize: `ops.ts` `updateObject`, `ops/group.ts` `transformGroup`,
 * `placement.ts`): `fitRows` with the editor's layout, the renderer's table kit measured as the canvas
 * measures. The kit is the module the canvas loads with its first table (`SlideCanvas.tsx`: the editor's own
 * chunk holds no table code); it is asked for here when this module loads, so a Find & Replace in a table on a
 * slide not yet shown grows its rows too. Until it is here, `fitTable` changes nothing.
 */

/** A table shape's layout as the drawer makes it, or undefined (no table, or none drawable). */
export type TableLayoutOf = (o: ShapeObject) => TableLayout | undefined;

/**
 * `after` with the rows its change made its text need grown (see the module header), or `after` itself when
 * no row grows, it is no fixed-row table, `before` is no table, or either does not lay out.
 */
export function fitRows(before: SlideObject, after: SlideObject, layout: TableLayoutOf): SlideObject {
  const a = after.type === 'shape' && after.table?.rowRule === 'fixed' ? after.table : undefined;
  const b = before.type === 'shape' && before !== after ? before.table : undefined;
  const la = a && b && layout(after as ShapeObject);
  const lb = la && layout(before as ShapeObject);
  if (!a || !b || !la || !lb) return after;
  // The same cell before: by index while the grid keeps its size, else the first unused one of its text.
  const same = a.cells.length === b.cells.length && a.rows.length === b.rows.length;
  const texts = b.cells.map((c) => c.text);
  const grow = new Float64Array(la.rowY.length - 1);
  // Single-row cells first, then each merge by its last row: its need past its rows (grown) goes there.
  for (const c of [...la.cells].sort(
    (p, q) => +(p.rows > 1) - +(q.rows > 1) || p.row + p.rows - q.row - q.rows,
  )) {
    const text = a.cells[c.index]!.text;
    const j = same ? c.index : text ? texts.indexOf(text) : -1;
    if (!same && j >= 0) texts[j] = undefined;
    const k = lb.cellAt[j] ?? -1;
    if (k < 0) continue;
    let have = 0;
    for (let r = c.row; r < c.row + c.rows; r++)
      have += la.rowY[r + 1]! - la.rowY[r]! + (c.rows > 1 ? grow[r]! : 0);
    const d = c.need - Math.max(have, lb.cells[k]!.need);
    const last = c.row + c.rows - 1;
    grow[last] = c.rows > 1 ? grow[last]! + Math.max(0, d) : Math.max(grow[last]!, d);
  }
  // Layout px to stored heights: the layout's rows are the stored ones at the table's row scale.
  const scale = la.height / a.rows.slice(0, grow.length).reduce((s, h) => s + h, 0);
  let out = after as ShapeObject;
  grow.forEach((g, r) => {
    if (g > 1e-6 && scale > 0) out = growRow(out, r, a.rows[r]! + g / scale);
  });
  return out;
}

// ---- the editor's layout --------------------------------------------------------------------------------

let kit: typeof TableKit | undefined;
let ctx: CanvasRenderingContext2D | null | undefined;
let override: TableLayoutOf | undefined;

/** Ask for the renderer's table kit (the module loads it once; a failed load is asked for again). */
const loadKit = () =>
  import('@ordo/renderer/table/index.ts').then(
    (m) => {
      kit = m;
    },
    () => {},
  );
void loadKit();

/** The layout `fitTable` uses instead of the table kit's (tests; undefined restores the kit's). */
export function setTableLayout(layout: TableLayoutOf | undefined): void {
  override = layout;
}

/**
 * `after` (a committed change of `before`) with its fixed rows grown to what the change made its text need
 * more (`fitRows` with the editor's layout); `after` itself for anything else, or before the kit is here.
 */
export function fitTable(before: SlideObject, after: SlideObject): SlideObject {
  try {
    const k = kit;
    if (!override && !k) {
      void loadKit();
      return after;
    }
    // The page's 2D context, made at the first layout (the canvas measures in one alike).
    const layout = (o: ShapeObject) =>
      k!.tableEditLayout((ctx ??= document.createElement('canvas').getContext('2d'))!, o);
    return fitRows(before, after, override ?? layout);
  } catch {
    return after;
  }
}
