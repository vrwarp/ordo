import type { Box, ShapeObject, TextObject } from '@ordo/domain';
import { clampShapeObject } from '../shape.ts';
import { currentFontEnv } from '../text/fonts.ts';
import { type MeasureCtx, measurerFor } from '../text/measure.ts';
import { isRichText } from '../text/rich.ts';
import type { FontEnv } from '../text/types.ts';
import { tableHit, tablePoint } from './hit.ts';
import { layoutTable, type TableLayout } from './layout.ts';

/*
 * A table cell edited on the editor's canvas (design/15 "Table editing"): the cell's text as the drawer lays it
 * out and paints it, as a text object in slide coordinates, so the text editing geometry of `text/cursor.ts`
 * (caretPosition, selectionRects, hitTestText, moveCaretVertically, drawTextEditingOverlay) places the caret,
 * the selection and a click exactly where the drawing has the glyphs. `drawTable` paints cell k's laid text
 * (`layout.cells[k].text`, laid at (0, 0), top-anchored, at the cell's width) from the cell's corner moved by its
 * anchor (`dy`); the edit view is that text object at the same place in slide coordinates: the same width,
 * style, runs and paragraph styles, so the same line breaks, and every x and y moved by the same offset.
 *
 * The view always goes through the rich engine (a table cell is always drawn by it): a cell whose style has
 * no rich field gets empty paragraph styles, which lay out as none. Each view is memoised per laid cell text
 * (the layout's cache keeps one per cell content and width) and table box, so the view of an unchanged cell is
 * the same object, and the engine's layout memo lays it out once.
 */

/**
 * The layout the drawer makes of a stored table shape (its clamped copy, memoised by identity, then by the
 * layout's own caches), measured as `ctx`'s drawers measure; undefined without a drawable table.
 */
export function tableEditLayout(
  ctx: MeasureCtx,
  o: ShapeObject,
  env: FontEnv = currentFontEnv(),
): TableLayout | undefined {
  if (!o.table) return undefined;
  const c = clampShapeObject(o);
  return c.table ? layoutTable(measurerFor(ctx), c, env) : undefined;
}

const views = new WeakMap<TextObject, { key: string; view: TextObject }>();

/**
 * Cell `i` (its index in `TableData.cells`) of table shape `o`, laid out as `layout`, as the text object the
 * canvas edits: its drawn text in slide coordinates (box at the table's corner plus the cell's, moved down by its
 * anchor `dy`; the cell's width; rotation 0: tables do not turn in the editor), with the table's id. Undefined
 * for a cell the layout does not place.
 */
export function cellEditView(o: ShapeObject, layout: TableLayout, i: number): TextObject | undefined {
  const k = layout.cellAt[i];
  const c = k === undefined || k < 0 ? undefined : layout.cells[k];
  if (!c) return undefined;
  const box: Box = {
    x: o.box.x + c.box.x,
    y: o.box.y + c.box.y + c.dy,
    w: c.text.box.w,
    h: c.text.box.h,
    rotation: 0,
  };
  const key = `${o.id}\u0001${box.x}\u0001${box.y}\u0001${box.w}\u0001${box.h}`;
  const hit = views.get(c.text);
  if (hit && hit.key === key) return hit.view;
  const view: TextObject = { ...c.text, id: o.id, box };
  if (!isRichText(view)) view.paras = [];
  views.set(c.text, { key, view });
  return view;
}

/** Cell `i`'s rect in slide coordinates (unrotated), or undefined for a cell the layout does not place. */
export function cellRect(o: ShapeObject, layout: TableLayout, i: number): Box | undefined {
  const k = layout.cellAt[i];
  const c = k === undefined || k < 0 ? undefined : layout.cells[k];
  if (!c) return undefined;
  return { x: o.box.x + c.box.x, y: o.box.y + c.box.y, w: c.box.w, h: c.box.h, rotation: 0 };
}

/** The cell under slide point (x, y) (`tablePoint` and `tableHit`), or -1 outside the table. */
export function cellAtPoint(o: ShapeObject, layout: TableLayout, x: number, y: number): number {
  const p = tablePoint(o, x, y);
  return tableHit(layout, p.x, p.y);
}
