import { cellRich, setCell, type ShapeObject, type TextObject } from '@ordo/domain';
import { cellStyleEntry } from '@ordo/domain/table.ts';
import { verticalTable } from '@ordo/domain/vertical-table.test-util.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_FONT_ENV } from '../text/fonts.ts';
import { caretPosition, hitTestText, moveCaretVertically, selectionRects } from '../text/cursor.ts';
import { measurerFor } from '../text/measure.ts';
import { isRichText, layoutRich, RICH_STYLE_KEYS } from '../text/rich.ts';
import { recordingCtx } from '../text/test-util.ts';
import { cellAtPoint, cellEditView, cellRect, tableEditLayout } from './edit.ts';
import { clearTableCache, layoutTable } from './layout.ts';
import { BASE, gridTable, tableShape } from './test-util.ts';

/*
 * The edit view of a table cell (design/15 "Table editing"): the drawn cell text in slide coordinates, so the
 * canvas's caret, selection and clicks (text/cursor.ts) land where `drawTable` paints the glyphs, and an edit
 * lays out the edited cell only.
 */

const env = LEGACY_FONT_ENV;

beforeEach(() => clearTableCache());

/** Every glyph run the drawer paints for cell `k` of the layout, in slide coordinates: line, x, width. */
function drawnLines(l: NonNullable<ReturnType<typeof layoutTable>>, k: number, ox: number, oy: number) {
  const c = l.cells[k]!;
  return c.layout.lines.map((line) => ({
    top: oy + c.box.y + c.dy + line.top,
    x: ox + c.box.x + line.x,
    w: line.w,
    segs: line.segs.map((s) => [s.start, s.end]),
  }));
}

describe('cellEditView', () => {
  it('breaks the cell text as the drawing does and puts the caret within 0.5 px of the drawn glyphs', () => {
    const t = gridTable(3, 3);
    t.cols = [140, 180, 220];
    t.rows = [60, 120, 60];
    // A wrapped cell, centred in a tall row, and a right-aligned one.
    t.cells[4] = { text: 'Amazing grace how sweet the sound that saved' };
    t.cells[5] = { text: 'Psalm 23', style: 0 };
    t.styles = [{ align: 'right', valign: 'bottom' }];
    t.base = { ...BASE, valign: 'middle' };
    const o = tableShape(t, { x: 230, y: 170 });
    const ctx = recordingCtx(0.5);
    const l = tableEditLayout(ctx, o, env)!;
    expect(l).toBe(layoutTable(measurerFor(ctx), o, env));
    for (const i of [4, 5, 0]) {
      const k = l.cellAt[i]!;
      const v = cellEditView(o, l, i)!;
      const drawn = drawnLines(l, k, o.box.x, o.box.y);
      const mine = layoutRich(measurerFor(ctx), v, env).lines;
      // The same lines, with the same characters on each.
      expect(mine.map((x) => x.segs.map((s) => [s.start, s.end]))).toEqual(drawn.map((x) => x.segs));
      expect(mine.length).toBe(drawn.length);
      for (let n = 0; n < mine.length; n++) {
        expect(Math.abs(mine[n]!.top - drawn[n]!.top)).toBeLessThan(0.5);
        expect(Math.abs(mine[n]!.x - drawn[n]!.x)).toBeLessThan(0.5);
      }
      // The caret before each character and at the end, against the drawn glyphs: the measurer gives every
      // character 0.5 em (10 px at 20 px), so a caret is its segment's drawn x plus 10 px per character.
      const text = v.text;
      const cell = l.cells[k]!;
      for (let off = 0; off <= text.length; off++) {
        const c = caretPosition(ctx, v, off, false, env);
        const line = cell.layout.lines[c.line]!;
        expect(Math.abs(c.y - drawn[c.line]!.top)).toBeLessThan(0.5);
        const seg = line.segs.find((g) => off >= g.start && off <= g.end);
        if (!seg) continue;
        const x = o.box.x + cell.box.x + seg.x + (off - seg.start) * 10;
        expect(Math.abs(c.x - x), `cell ${i} offset ${off}`).toBeLessThan(0.5);
      }
      // A click on a character's left half is the offset before it.
      const at = caretPosition(ctx, v, 2, false, env);
      expect(hitTestText(ctx, v, at.x + 1, at.y + 2, env)).toBe(2);
    }
    // The first glyph of the right-aligned cell is where the drawer starts it: x within 0.5 px.
    const right = cellEditView(o, l, 5)!;
    const drawnRight = drawnLines(l, l.cellAt[5]!, o.box.x, o.box.y)[0]!;
    expect(Math.abs(caretPosition(ctx, right, 0, false, env).x - drawnRight.x)).toBeLessThan(0.5);
    // A selection across the wrapped cell's first line break covers both lines.
    const wrapped = cellEditView(o, l, 4)!;
    expect(selectionRects(ctx, wrapped, 0, wrapped.text.length, env).length).toBe(
      drawnLines(l, l.cellAt[4]!, 0, 0).length,
    );
    const down = moveCaretVertically(ctx, wrapped, 1, 1, undefined, env);
    expect(caretPosition(ctx, wrapped, down.offset, false, env).line).toBe(1);
  });

  it('edits an East Asian vertical cell (eaVert) as it is drawn, horizontally: caret, selection, clicks as horz', () => {
    // Sub-wave 1c stores the Korean bulletin's eaVert cells in the table object; the renderer draws them as
    // horizontal cells (`cellIsVertical`, no vertical text engine), so its edit view is a horizontal cell's.
    const long = (o: ShapeObject) => setCell(o, 0, { ...cellRich(o.table!, 0)!, text: '1년차 첫해 둘째' });
    const vt = verticalTable();
    const o = long(tableShape(vt, { x: 200, y: 100 }));
    const p = long(
      tableShape(
        { ...vt, styles: undefined, cells: vt.cells.map(({ style: _, ...c }) => c) },
        { x: 200, y: 100 },
      ),
    );
    expect(cellStyleEntry(o.table!, o.table!.cells[0])?.vert).toBe('eaVert');
    expect(cellStyleEntry(p.table!, p.table!.cells[0])).toBeUndefined();
    const ctx = recordingCtx(0.5);
    const lo = tableEditLayout(ctx, o, env)!;
    const lp = tableEditLayout(ctx, p, env)!;
    // Over its four rows, the narrow column: the same rect and the same drawn lines (it wraps).
    expect(cellRect(o, lo, 0)).toEqual(cellRect(p, lp, 0));
    expect(cellRect(o, lo, 0)!.h).toBe(160);
    const drawn = drawnLines(lo, lo.cellAt[0]!, o.box.x, o.box.y);
    expect(drawn.length).toBeGreaterThan(1);
    expect(drawn).toEqual(drawnLines(lp, lp.cellAt[0]!, p.box.x, p.box.y));
    const v = cellEditView(o, lo, 0)!;
    const w = cellEditView(p, lp, 0)!;
    expect(v.box).toEqual(w.box);
    for (let off = 0; off <= v.text.length; off++)
      expect(caretPosition(ctx, v, off, false, env)).toEqual(caretPosition(ctx, w, off, false, env));
    expect(selectionRects(ctx, v, 0, v.text.length, env)).toEqual(
      selectionRects(ctx, w, 0, w.text.length, env),
    );
    expect(selectionRects(ctx, v, 0, v.text.length, env)).toHaveLength(drawn.length);
    const at = caretPosition(ctx, v, 2, false, env);
    expect(hitTestText(ctx, v, at.x + 1, at.y + 2, env)).toBe(2);
    expect(cellAtPoint(o, lo, o.box.x + 10, o.box.y + 150)).toBe(0);
  });

  it('is the same object while the cell and the box are, and goes through the rich engine', () => {
    const o = tableShape(gridTable(2, 2), { x: 10, y: 20 });
    const ctx = recordingCtx(0.5);
    const l = tableEditLayout(ctx, o, env)!;
    const v = cellEditView(o, l, 3)!;
    expect(cellEditView(o, l, 3)).toBe(v);
    expect(v).toMatchObject({ id: 'table', text: 'r1c1' } satisfies Partial<TextObject>);
    expect(isRichText(v)).toBe(true);
    expect(v.box).toMatchObject({ x: 110, y: 60, w: 100, rotation: 0 });
    // The box moved: a new view at the new place.
    const moved = tableShape(gridTable(2, 2), { x: 50, y: 20 });
    expect(cellEditView(moved, tableEditLayout(ctx, moved, env)!, 3)!.box.x).toBe(150);
    expect(cellEditView(o, l, 99)).toBeUndefined();
    expect(cellRect(o, l, 3)).toEqual({ x: 110, y: 60, w: 100, h: 40, rotation: 0 });
    expect(cellAtPoint(o, l, 115, 65)).toBe(3);
    expect(cellAtPoint(o, l, 5, 5)).toBe(-1);
    // A table whose cells have no rich field: the view still goes through the rich engine, which draws it.
    const plainBase = Object.fromEntries(
      Object.entries(BASE).filter(([k]) => !(RICH_STYLE_KEYS as readonly string[]).includes(k)),
    ) as typeof BASE;
    const p = tableShape(gridTable(2, 2, { base: plainBase }));
    const pv = cellEditView(p, tableEditLayout(ctx, p, env)!, 0)!;
    expect(pv.paras).toEqual([]);
    expect(isRichText(pv)).toBe(true);
  });

  it('typing a character in a 160-cell table lays out that one cell again', () => {
    const t = gridTable(16, 10);
    const o = tableShape(t);
    const ctx = recordingCtx(0.5);
    const l = tableEditLayout(ctx, o, env)!;
    const before = l.cells.map((c) => c.layout);
    // Type into cell 57 as the editor does (setCell with the view's text and a character more).
    const typed = setCell(o, 57, { ...cellRich(o.table!, 57)!, text: `${cellRich(o.table!, 57)!.text}x` });
    const l2 = tableEditLayout(ctx, typed, env)!;
    let relaid = 0;
    l2.cells.forEach((c, k) => {
      if (c.layout !== before[k]) relaid++;
    });
    expect(relaid).toBe(1);
    expect(l2.cells[l2.cellAt[57]!]!.text.text).toBe('r5c7x');
    // Its edit view is laid out once more (its own place); every other cell's view is untouched.
    expect(cellEditView(typed, l2, 56)).toBe(cellEditView(o, l, 56));
  });
});
