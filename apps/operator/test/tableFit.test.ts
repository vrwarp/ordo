/**
 * Rows follow the text on an edit (design/15 "Table editing", r2b 1b tables-form): an imported table's rows
 * are fixed (`rowRule: 'fixed'`, LibreOffice's), so an edit that makes a cell's text need more room grows its
 * row, by the increase in the cell's need only (`tableFit.ts` `fitRows`), on every committed table change:
 * an edit of a cell (`editCell`, typing), Find & Replace in cells (`findInCells`), a column added
 * (`rowCol`), the box resized (`updateObject`, `transformGroup`). The synthetic table has the condition the
 * absolute shortfall gets wrong (all-tables' P1): a cell whose drawn need is 3 px over its fixed row before
 * any edit, so a one-letter fix and a Find & Replace that wraps nothing must move no row. A shorter box
 * gives a row back the room it took, down to its text (review 1b: fixed rows squashed with the box spilled
 * every cell over the row below), and a row or column op pairs each cell with itself by its place.
 */
import { cellRich, Presentation, type ShapeObject, type SlideObject, type TableData } from '@ordo/domain';
import { cellStyleEntry } from '@ordo/domain/table.ts';
import { verticalTable } from '@ordo/domain/vertical-table.test-util.ts';
import { clampShapeObject } from '@ordo/renderer/shape.ts';
import { layoutTable } from '@ordo/renderer/table/layout.ts';
import { gridTable } from '@ordo/renderer/table/test-util.ts';
import { LEGACY_FONT_ENV } from '@ordo/renderer/text/fonts.ts';
import { testMeasurer } from '@ordo/renderer/text/test-util.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { editCell, findAndReplace, rowCol, typeText } from '../src/views/editor/actions.ts';
import { change, openPresentation, undo, useEditor } from '../src/views/editor/editorStore.ts';
import { updateObject } from '../src/views/editor/ops.ts';
import { tableBoxAfterTransform } from '../src/views/editor/SlideCanvas.tsx';
import { transformGroup } from '../src/views/editor/ops/group.ts';
import { editText } from '../src/views/editor/ops/index.ts';
import { findInCells } from '../src/views/editor/ops/slides.ts';
import { fitRows, setTableLayout } from '../src/views/editor/tableFit.ts';

/** The drawer's layout of a table shape, with a measurer of half an em a character (20 px text: 10 px). */
const meas = testMeasurer({ em: 0.5 });
const layout = (o: ShapeObject) => layoutTable(meas, clampShapeObject(o), LEGACY_FONT_ENV);

/** A table shape at (100, 100), its box the sum of its columns and rows. */
function shape(t: TableData): ShapeObject {
  return {
    id: 'table',
    type: 'shape',
    box: {
      x: 100,
      y: 100,
      w: t.cols.reduce((s, w) => s + w, 0),
      h: t.rows.reduce((s, h) => s + h, 0),
      rotation: 0,
    },
    shape: 'rect',
    opacity: 1,
    radius: 0,
    table: t,
    origin: { src: 'pptx', role: 'table' },
  };
}

/** What cell `i` needs in table `o` (its text and insets, as the drawer lays it out). */
const needOf = (o: ShapeObject, i: number) => {
  const l = layout(o)!;
  return l.cells[l.cellAt[i]!]!.need;
};

/** 'r0c0'... fit a 100 px cell on one line; 'aaa bbb' (70 px) too, but wraps in a 70 px column. */
const ONE = needOf(shape({ ...gridTable(1, 1), rowRule: 'fixed' }), 0);
const TWO = needOf(
  shape({ ...gridTable(1, 1, { cols: [60], cells: [{ text: 'aaa bbb' }] }), rowRule: 'fixed' }),
  0,
);

/**
 * An imported 3 × 2 table: rows fixed, row 0 three px shorter than its one-line cells need (the drawer's lines
 * taller than the converter's model of LibreOffice's), rows 1 and 2 with room; cell 3 holds 'aaa bbb'.
 */
function imported(): ShapeObject {
  const t = gridTable(3, 2, { rows: [ONE - 3, 40, 40], rowRule: 'fixed' });
  t.cells[3] = { text: 'aaa bbb' };
  return shape(t);
}

const rows = (o: SlideObject) => (o as ShapeObject).table!.rows;
/** Each laid cell's need past its drawn row(s), in px (> 0: its text draws over the row below). */
const spill = (o: SlideObject) => {
  const l = layout(o as ShapeObject)!;
  return l.cells.map((c) => c.need - (l.rowY[c.row + c.rows]! - l.rowY[c.row]!));
};
const type = (o: SlideObject, i: number, text: string) =>
  editCell(o, i, (v) => editText(v, text, text.length)) as ShapeObject;

beforeAll(() => setTableLayout(layout));
afterAll(() => setTableLayout(undefined));

describe('fitRows: rows grow by the increase in need only', () => {
  it('the condition: a one-line cell of row 0 needs 3 px more than its fixed row', () => {
    const o = imported();
    expect(ONE).toBeGreaterThan(20);
    expect(needOf(o, 0) - rows(o)[0]!).toBeCloseTo(3, 9);
    expect(TWO).toBeGreaterThan(ONE);
  });

  it('a one-character edit moves no row where its cell already needs more than its row', () => {
    const o = imported();
    const out = type(o, 0, 'r0c0x');
    expect(cellRich(out.table!, 0)!.text).toBe('r0c0x');
    expect(rows(out)).toEqual(rows(o));
    expect(out.box).toEqual(o.box);
  });

  it('a long line typed into a cell grows its row by the increase in its need, the other rows unchanged', () => {
    const o = imported();
    const long = 'aaaa bbbb cccc dddd eeee';
    const out = type(o, 0, long);
    const grew = needOf(out, 0) - ONE;
    expect(grew).toBeGreaterThan(20);
    // From the row's own height (3 px short), by what the cell needs more: still 3 px short.
    expect(rows(out)[0]).toBeCloseTo(ONE - 3 + grew, 9);
    expect(rows(out).slice(1)).toEqual([40, 40]);
    expect(out.box.h).toBeCloseTo(o.box.h + grew, 9);
    expect(out.table!.rowRule).toBe('fixed');
    // Shortening it again shrinks nothing.
    expect(rows(type(out, 0, 'r0c0'))).toEqual(rows(out));
  });

  it('Find & Replace in cells moves no row while the text wraps no more, and grows the one it makes wrap', () => {
    const o = imported();
    const same = findInCells(o, 'r0c0', {}, 'R0C0').o as ShapeObject;
    expect(cellRich(same.table!, 0)!.text).toBe('R0C0');
    expect(rows(same)).toEqual(rows(o));
    const wraps = findInCells(o, 'r1c0', {}, 'aaaa bbbb cccc dddd eeee').o as ShapeObject;
    expect(rows(wraps)[1]).toBeCloseTo(40 + (needOf(wraps, 2) - 40), 9);
    expect(rows(wraps)[0]).toBe(rows(o)[0]);
  });

  it('a narrower box grows the rows whose text now wraps more (columns follow box.w)', () => {
    const o = imported();
    const narrow = { ...o, box: { ...o.box, w: 140 } }; // columns of 70: 'aaa bbb' wraps in 60
    const out = fitRows(o, narrow, layout) as ShapeObject;
    expect(rows(out)).toEqual([ONE - 3, 40 + (TWO - 40), 40]);
    expect(out.box).toEqual({ ...narrow.box, h: o.box.h + (TWO - 40) });
    // A wider box changes nothing (rows never shrink).
    expect(fitRows(o, { ...o, box: { ...o.box, w: 400 } }, layout)).toEqual({
      ...o,
      box: { ...o.box, w: 400 },
    });
  });

  it("a merged cell's need past its rows goes to its last row", () => {
    const t = gridTable(3, 2, { rows: [40, 40, 40], rowRule: 'fixed' });
    t.cells = [{ text: 'a' }, { text: 'm', rowSpan: 2 }, { text: 'b' }, { text: 'c' }, { text: 'd' }];
    const o = shape(t);
    const many = 'x x x x x x x x x x x x x x x x x x x x x x x x';
    const out = type(o, 1, many);
    const need = needOf(out, 1);
    expect(need).toBeGreaterThan(80);
    expect(rows(out)).toEqual([40, need - 40, 40]);
  });

  it('leaves a table whose rows grow (made in ordo) to the drawer, and anything that is no table', () => {
    const t = gridTable(1, 1, { rows: [10] });
    const o = shape(t);
    const out = type(o, 0, 'aaaa bbbb cccc dddd eeee');
    expect(rows(out)).toEqual([10]);
    const text = { id: 'x', type: 'text', text: 'a' } as SlideObject;
    expect(fitRows(text, text, layout)).toBe(text);
  });
});

describe("an East Asian vertical cell's rows grow as a horizontal cell's (eaVert, sub-wave 1c)", () => {
  it("typing into the narrow eaVert cell grows its merge's last row by need, as the same cell without vert", () => {
    // The renderer draws eaVert cells horizontally (as LibreOffice 24.2 does): the need is a horizontal cell's.
    const vertical = shape(verticalTable());
    const t = verticalTable();
    const plain = shape({ ...t, styles: undefined, cells: t.cells.map(({ style: _, ...c }) => c) });
    expect(rows(vertical)).toEqual(rows(plain));
    const long = '1년차 첫해 둘째 셋째 넷째 다섯째 여섯째';
    const a = type(vertical, 0, long);
    const b = type(plain, 0, long);
    expect(needOf(a, 0)).toBeGreaterThan(160);
    expect(rows(a)).toEqual(rows(b));
    expect(rows(a).slice(0, 3)).toEqual([40, 40, 40]);
    expect(rows(a)[3]).toBeCloseTo(needOf(a, 0) - 120, 9);
    expect(cellStyleEntry(a.table!, a.table!.cells[0])?.vert).toBe('eaVert');
  });
});

describe('the ops that commit a table change grow its fixed rows, one undo step with the change', () => {
  const deck = Presentation.parse({
    id: 'deck',
    title: 'Order of service',
    kind: 'slides',
    sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 'sl', objects: [imported()] }] }],
  });
  const table = () => useEditor.getState().draft!.sections[0]!.slides[0]!.objects[0] as ShapeObject;

  beforeEach(() => {
    openPresentation(deck);
    useEditor.setState({ slideId: 'sl' });
  });

  it('typing in a cell: the row grows with the text; undo restores both', () => {
    const before = table();
    const long = 'aaaa bbbb cccc dddd eeee';
    typeText({ objectId: 'table', cell: 0 }, long, long.length);
    const grew = needOf(table(), 0) - ONE;
    expect(rows(table())[0]).toBeCloseTo(ONE - 3 + grew, 9);
    expect(table().box.h).toBeCloseTo(before.box.h + grew, 9);
    undo();
    expect(table()).toEqual(before);
  });

  it('Find & Replace across the presentation: the row of the cell it makes wrap grows', () => {
    const before = table();
    expect(findAndReplace('aaa bbb', 'aaa bbb ccc ddd eee fff')).toBe(1);
    expect(rows(table())[1]).toBeGreaterThan(40);
    expect(rows(table())[0]).toBe(rows(before)[0]);
    undo();
    expect(table()).toEqual(before);
  });

  it('a column added: the narrower columns wrap "aaa bbb" and its row grows; undo restores both', () => {
    const before = table();
    rowCol('table', 'colRight', 1);
    const t = table().table!;
    expect(t.cols).toHaveLength(3);
    // Row 1's 'aaa bbb' wraps in a column of 66.7 px (56.7 inside): its row grows by what it needs more.
    expect(rows(table())[1]).toBeCloseTo(TWO, 6);
    expect(rows(table())[0]).toBe(rows(before)[0]);
    expect(rows(table())[2]).toBe(40);
    undo();
    expect(table()).toEqual(before);
  });

  it('a box resize (the canvas, the Object panel) and a group transform grow the rows that wrap more', () => {
    const before = table();
    change((p) => updateObject(p, 'sl', 'table', (o) => ({ ...o, box: { ...o.box, w: 140 } })));
    expect(rows(table())).toEqual([ONE - 3, TWO, 40]);
    undo();
    expect(table()).toEqual(before);
    const from = before.box;
    change((p) => transformGroup(p, 'sl', ['table'], from, { ...from, w: 140 }));
    expect(rows(table())[1]).toBeCloseTo(TWO, 6);
    undo();
    expect(table()).toEqual(before);
  });
});

describe('a shorter box gives each fixed row back the room it took, down to its text', () => {
  /** A 3 × 2 imported table, every row exactly its one-line cells' need: nothing spills before the edit. */
  const fitted = () => shape(gridTable(3, 2, { rows: [ONE, ONE, ONE], rowRule: 'fixed' }));
  const deckOf = (o: ShapeObject) =>
    Presentation.parse({
      id: 'deck',
      title: 'Order of service',
      kind: 'slides',
      sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 'sl', objects: [o] }] }],
    });
  const table = () => useEditor.getState().draft!.sections[0]!.slides[0]!.objects[0] as ShapeObject;
  const open = (o: ShapeObject) => {
    openPresentation(deckOf(o));
    useEditor.setState({ slideId: 'sl' });
  };
  const resize = (box: ShapeObject['box']) =>
    change((p) => updateObject(p, 'sl', 'table', (o) => ({ ...o, box })));

  it('the canvas height drag to 60 %: every row back at its text, the box as tall as before', () => {
    const o = fitted();
    expect(Math.max(...spill(o))).toBeLessThanOrEqual(1e-9);
    open(o);
    resize(tableBoxAfterTransform(o, o.box.h, { x: 150, y: 130, scaleX: 1, scaleY: 0.6 }));
    expect(Math.max(...spill(table()))).toBeLessThanOrEqual(1e-6);
    expect(layout(table())!.height).toBeCloseTo(3 * ONE, 6);
    expect(table().box.h).toBeCloseTo(3 * ONE, 6);
    undo();
    expect(table()).toEqual(o);
  });

  it('a corner drag to 80 % (the usual resize) and the Object panel H field at half: no cell spills', () => {
    const o = fitted();
    open(o);
    resize(tableBoxAfterTransform(o, o.box.h, { x: 140, y: 140, scaleX: 0.8, scaleY: 0.8 }));
    expect(Math.max(...spill(table()))).toBeLessThanOrEqual(1e-6);
    open(o);
    resize({ ...o.box, h: o.box.h / 2 });
    expect(Math.max(...spill(table()))).toBeLessThanOrEqual(1e-6);
    expect(table().box.h).toBeCloseTo(3 * ONE, 6);
  });

  it('a row already short of its text before the squash keeps that shortfall, no more and no less', () => {
    const o = imported(); // row 0 three px short; rows 1 and 2 with room (40)
    open(o);
    resize({ ...o.box, h: o.box.h / 2 });
    const s = spill(table());
    const l = layout(table())!;
    const rowOf = l.cells.map((c) => c.row);
    for (const [i, d] of s.entries()) expect(d).toBeCloseTo(rowOf[i] === 0 ? 3 : 0, 6);
    // Rows 1 and 2 had room: they give back only what their text needs (ONE < 40), not all of it.
    expect(l.rowY[3]! - l.rowY[1]!).toBeCloseTo(2 * ONE, 6);
  });

  it('a taller box grows nothing and shrinks nothing (the room stays)', () => {
    const o = imported();
    const tall = { ...o, box: { ...o.box, h: o.box.h * 2 } };
    expect(fitRows(o, tall, layout)).toEqual(tall);
  });
});

describe('a row or column op pairs each cell with itself, by its place', () => {
  const deckOf = (o: ShapeObject) =>
    Presentation.parse({
      id: 'deck',
      title: 'Order of service',
      kind: 'slides',
      sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 'sl', objects: [o] }] }],
    });
  const table = () => useEditor.getState().draft!.sections[0]!.slides[0]!.objects[0] as ShapeObject;

  /**
   * Fixed rows [ONE, TWO - 3, ONE]: row 1's 'aaa bbb' sits in the narrow column (two lines, 3 px short of
   * its row before any edit), row 0's 'aaa bbb' in the wide one (one line).
   */
  function repeated(): ShapeObject {
    const t = gridTable(3, 2, { cols: [200, 60], rows: [ONE, TWO - 3, ONE], rowRule: 'fixed' });
    t.cells[0] = { text: 'aaa bbb' };
    t.cells[3] = { text: 'aaa bbb' };
    return shape(t);
  }

  it("deleting a row whose cell repeats a later cell's text grows no row", () => {
    const o = repeated();
    expect(needOf(o, 3) - rows(o)[1]!).toBeCloseTo(3, 9);
    openPresentation(deckOf(o));
    useEditor.setState({ slideId: 'sl' });
    rowCol('table', 'deleteRow', 0);
    expect(rows(table())).toEqual([TWO - 3, ONE]);
    expect(table().box.h).toBeCloseTo(o.box.h - ONE, 9);
  });

  it('a row added above grows no row, and a row deleted under a merged cell grows its last row', () => {
    const o = repeated();
    openPresentation(deckOf(o));
    useEditor.setState({ slideId: 'sl' });
    rowCol('table', 'rowAbove', 0);
    expect(rows(table())).toEqual([ONE, ONE, TWO - 3, ONE]);
    // A merged cell over rows 0-1 whose text needs both rows: deleting row 1 leaves it one row short.
    const t = gridTable(3, 2, { rows: [40, 40, 40], rowRule: 'fixed' });
    t.cells = [
      { text: 'a' },
      { text: 'x x x x x x x', rowSpan: 2 },
      { text: 'b' },
      { text: 'c' },
      { text: 'd' },
    ];
    const m = shape(t);
    const need = needOf(m, 1);
    expect(need).toBeGreaterThan(40);
    expect(need).toBeLessThanOrEqual(80);
    openPresentation(deckOf(m));
    useEditor.setState({ slideId: 'sl' });
    rowCol('table', 'deleteRow', 2); // cell 2 ('b') is row 1's: the merge now spans row 0 alone
    expect(rows(table())).toHaveLength(2);
    expect(rows(table())[0]).toBeCloseTo(need, 9);
    expect(rows(table())[1]).toBe(40);
    expect(Math.max(...spill(table()))).toBeLessThanOrEqual(1e-6);
  });
});
