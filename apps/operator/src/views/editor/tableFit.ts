import { growRow, placeCells, type ShapeObject, type SlideObject, type TableData } from '@ordo/domain';
import type * as TableKit from '@ordo/renderer/table/index.ts';
import type { TableLayout } from '@ordo/renderer/table/layout.ts';

/*
 * Rows follow the text on an edit (design/15 "Table editing"; r2b sub-wave 1b tables-form). An imported table
 * stores LibreOffice's rows, fixed (`rowRule: 'fixed'`, design/27 §15 "The stored form"), so the drawer never
 * grows them: a change that leaves a cell's text short of its row by more than before grows that cell's row
 * here, by that increase only (`fitRows`). Never by the absolute shortfall: where the drawer's lines are taller
 * than the converter's model of LibreOffice's (2 Corinthians 3 vs 7, Churchcraft), cells already need a few px
 * more than their fixed row before any edit, and a one-letter fix would make the rows jump. A shorter box
 * (a height drag, the Object panel's H) takes room from the rows; each gets back what its text needs, so no
 * text spills over the row below, as in PowerPoint (review 1b).
 *
 * `fitRows(before, after, layout, cellOf)` is pure: it lays both objects out with the drawer's layout
 * (`layout`, the renderer's `layoutTable` of the clamped shape; a cell's `need` is its text height plus its
 * insets) and grows a single-row cell's row by max(0, (needAfter - rowAfter) - max(0, needBefore - rowBefore)),
 * the largest per row, then a merged cell's last row the same way with its rows' sum (as the layout gives a
 * merge its extra); rows never shrink, other rows stay, `box.h` follows (`@ordo/domain` `growRow`). While the
 * row keeps its height (an edit, Find & Replace) that is max(0, needAfter - max(row, needBefore)). A cell is the
 * same cell before and after by its index while the grid keeps its rows, columns and cells (an edit, Find &
 * Replace, a box resize), else by its place across the row or column added or deleted (`cellsByPlace`, from
 * the op); a cell new to the table grows nothing. A table whose rows grow (made in ordo) is left to the drawer.
 *
 * `fitTable(before, after, cellOf)` is what the ops call after every committed table change (editCell, Find &
 * Replace in cells, the row and column ops, a box resize: `ops.ts` `updateObject`, `ops/group.ts`
 * `transformGroup`, `placement.ts`): `fitRows` with the editor's layout, the renderer's table kit measured as
 * the canvas measures. The kit is the module the canvas loads with its first table (`SlideCanvas.tsx`: the
 * editor's own chunk holds no table code); it is asked for here when this module loads, so a Find & Replace in
 * a table on a slide not yet shown grows its rows too. Until it is here, `fitTable` changes nothing.
 */

/** A table shape's layout as the drawer makes it, or undefined (no table, or none drawable). */
export type TableLayoutOf = (o: ShapeObject) => TableLayout | undefined;

/** The cell of `before` each cell of `after` is (by its index; -1: new to the table). */
export type CellOf = (afterCell: number) => number;

/**
 * Which cell of `before` each cell of `after` is when a row or column was added or deleted at line `at` of
 * `axis` (as `insertRow`, `deleteRow`, `insertCol`, `deleteCol` make them): a cell's first slot read across the
 * change, the cell covering that slot before. A cell on an added line is new (-1); a merged cell keeps itself
 * when the line was its first.
 */
export function cellsByPlace(
  before: TableData,
  after: TableData,
  axis: 'row' | 'col',
  at: number,
  added: boolean,
): CellOf {
  const b = placeCells(before);
  const { anchors } = placeCells(after);
  const back = (p: number) => (added ? (p < at ? p : p === at ? -1 : p - 1) : p < at ? p : p + 1);
  return (i) => {
    const a = anchors[i];
    if (!a) return -1;
    const row = axis === 'row' ? back(a.row) : a.row;
    const col = axis === 'col' ? back(a.col) : a.col;
    return row < 0 || col < 0 || row >= b.R || col >= b.C ? -1 : b.slots[row * b.C + col]!;
  };
}

/**
 * `after` with the rows its change left its text short of by more than before grown (see the module header),
 * or `after` itself when no row grows, it is no fixed-row table, `before` is no table, either does not lay
 * out, or the grid changed and `cellOf` does not say which cell is which.
 */
export function fitRows(
  before: SlideObject,
  after: SlideObject,
  layout: TableLayoutOf,
  cellOf?: CellOf,
): SlideObject {
  const a = after.type === 'shape' && after.table?.rowRule === 'fixed' ? after.table : undefined;
  const b = before.type === 'shape' && before !== after ? before.table : undefined;
  const la = a && b && layout(after as ShapeObject);
  const lb = la && layout(before as ShapeObject);
  if (!a || !b || !la || !lb) return after;
  // The same cell before: by index while the grid keeps its size, else by its place across the op.
  const same =
    a.cells.length === b.cells.length && a.rows.length === b.rows.length && a.cols.length === b.cols.length;
  if (!same && !cellOf) return after;
  const grow = new Float64Array(la.rowY.length - 1);
  // Single-row cells first, then each merge by its last row: its shortfall past its rows (grown) goes there.
  for (const c of [...la.cells].sort(
    (p, q) => +(p.rows > 1) - +(q.rows > 1) || p.row + p.rows - q.row - q.rows,
  )) {
    const k = lb.cellAt[same ? c.index : cellOf!(c.index)] ?? -1;
    if (k < 0) continue;
    const cb = lb.cells[k]!;
    let have = 0;
    for (let r = c.row; r < c.row + c.rows; r++)
      have += la.rowY[r + 1]! - la.rowY[r]! + (c.rows > 1 ? grow[r]! : 0);
    const short = Math.max(0, cb.need - (lb.rowY[cb.row + cb.rows]! - lb.rowY[cb.row]!));
    const d = c.need - have - short;
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
 * `after` (a committed change of `before`) with its fixed rows grown to what the change left its text short of
 * more (`fitRows` with the editor's layout; `cellOf` for a row or column op); `after` itself for anything
 * else, or before the kit is here.
 */
export function fitTable(before: SlideObject, after: SlideObject, cellOf?: CellOf): SlideObject {
  try {
    const k = kit;
    if (!override && !k) {
      void loadKit();
      return after;
    }
    // The page's 2D context, made at the first layout (the canvas measures in one alike).
    const layout = (o: ShapeObject) =>
      k!.tableEditLayout((ctx ??= document.createElement('canvas').getContext('2d'))!, o);
    return fitRows(before, after, override ?? layout, cellOf);
  } catch {
    return after;
  }
}
