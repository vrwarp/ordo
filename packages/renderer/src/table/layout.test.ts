import { cellRich, setCell, type TextObject } from '@ordo/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_FONT_ENV } from '../text/fonts.ts';
import { insetsOf } from '../text/lines.ts';
import { clampTextObject, layoutRich } from '../text/rich.ts';
import { testMeasurer } from '../text/test-util.ts';
import { tableHit, tablePoint } from './hit.ts';
import { clearTableCache, layoutTable, prepareTableLayout, tableCacheSize } from './layout.ts';
import { BASE, gridTable, tableShape } from './test-util.ts';

/*
 * The table layout (design/27 M9, tables-object.md §6 renderer tests): rows grow to their text as
 * LibreOffice's TableLayouter and PowerPoint grow them, merges give their extra height to their last row,
 * columns and minimum rows scale to the box, right-to-left tables mirror, fixed rows stay, and the layout is
 * linear and incremental (one cell laid out per edited cell; slices for the asset worker).
 */

const env = LEGACY_FONT_ENV;

/** The height a text object of this text and style needs at width `w`, laid out on its own. */
function need(text: string, w: number, style = BASE): number {
  const o = clampTextObject({
    id: 'x',
    type: 'text',
    box: { x: 0, y: 0, w, h: 0, rotation: 0 },
    text,
    style: { ...style, valign: 'top' },
    opacity: 1,
  } as TextObject);
  const l = layoutRich(testMeasurer(), o, env);
  const first = l.lines[0]!;
  const last = l.lines[l.lines.length - 1]!;
  const ins = insetsOf(o.style);
  return last.top + last.height - first.top + ins.t + ins.b;
}

beforeEach(() => clearTableCache());

describe('table layout', () => {
  it('rows grow to the tallest single-row cell', () => {
    // 'r0c0'... are 40 px wide at 20 px (0.5 em): one line in a 100 px cell. A long cell wraps.
    const t = gridTable(2, 2);
    t.cells[1] = { text: 'aaaa bbbb cccc dddd eeee' };
    const o = tableShape(t);
    const l = layoutTable(testMeasurer(), o, env)!;
    const one = need('r0c0', 100);
    const tall = need('aaaa bbbb cccc dddd eeee', 100);
    expect(one).toBeLessThan(40);
    expect(tall).toBeGreaterThan(40);
    expect([...l.rowY]).toEqual([0, tall, tall + 40]);
    expect(l.height).toBe(tall + 40);
    expect(l.width).toBe(200);
  });

  it("a merge's extra height goes to its last row", () => {
    const t = gridTable(3, 2, {
      cells: [
        { text: 'a' },
        { text: 'x x x x x x x x x x x x x x x x x x x x', rowSpan: 2 },
        { text: 'b' },
        { text: 'c' },
        { text: 'd' },
      ],
    });
    const l = layoutTable(testMeasurer(), tableShape(t), env)!;
    const merged = need('x x x x x x x x x x x x x x x x x x x x', 100);
    expect(merged).toBeGreaterThan(80);
    expect(l.rowY[1]).toBe(40);
    expect(l.rowY[2]).toBeCloseTo(merged, 9);
    expect(l.rowY[3]).toBeCloseTo(merged + 40, 9);
    // The merged cell spans both rows.
    expect(l.cells[1]!.box).toMatchObject({ y: 0, h: l.rowY[2] });
  });

  it('an empty cell is one line of its style size', () => {
    const t = gridTable(1, 2, {
      rows: [1],
      cells: [{}, { style: 0 }],
      styles: [{ fontSizePx: 60 }],
    });
    const l = layoutTable(testMeasurer(), tableShape(t), env)!;
    expect(l.rowY[1]).toBeCloseTo(need('', 100, { ...BASE, fontSizePx: 60 }), 9);
    expect(l.rowY[1]).toBeGreaterThan(need('', 100));
  });

  it('box.h scales the minimum rows and columns scale to box.w', () => {
    const t = gridTable(2, 2, { cols: [1, 3], rows: [10, 30] });
    const l = layoutTable(testMeasurer(), tableShape(t, { w: 800, h: 400 }), env)!;
    expect([...l.colX]).toEqual([0, 200, 800]);
    expect([...l.rowY]).toEqual([0, 100, 400]);
    expect(l.cells.map((c) => c.box.w)).toEqual([200, 600, 200, 600]);
  });

  it('rtl mirrors the columns', () => {
    const t = gridTable(1, 3, { cols: [100, 200, 300], rtl: true });
    const l = layoutTable(testMeasurer(), tableShape(t), env)!;
    expect([...l.colX]).toEqual([600, 500, 300, 0]);
    expect(l.cells.map((c) => [c.box.x, c.box.w])).toEqual([
      [500, 100],
      [300, 200],
      [0, 300],
    ]);
    // The hit test reads the mirrored columns: the right edge is column 0.
    expect(tableHit(l, 590, 10)).toBe(0);
    expect(tableHit(l, 10, 10)).toBe(2);
  });

  it('fixed rows do not grow, and the text overflows as its anchor says', () => {
    const long = 'aaaa bbbb cccc dddd eeee ffff gggg';
    const t = gridTable(1, 1, {
      rows: [30],
      rowRule: 'fixed',
      cells: [{ text: long, style: 0 }],
      styles: [{ valign: 'middle' }],
    });
    const l = layoutTable(testMeasurer(), tableShape(t), env)!;
    expect(l.height).toBe(30);
    const c = l.cells[0]!;
    // Centred text taller than the row overflows equally above and below it.
    expect(c.dy).toBeLessThan(0);
    expect(c.dy).toBeCloseTo((Math.max(1, 30 - 10) - c.textHeight) / 2, 9);
  });

  it('anchors text within its grown cell as a text box anchors it', () => {
    const t = gridTable(1, 3, {
      cells: [
        { text: 'x x x x x x x x x x x x x x x x x x x x' },
        { text: 'mid', style: 0 },
        { text: 'end', style: 1 },
      ],
      styles: [{ valign: 'middle' }, { valign: 'bottom' }],
    });
    const l = layoutTable(testMeasurer(), tableShape(t), env)!;
    const h = l.height;
    const [, mid, end] = l.cells;
    const inner = h - 10;
    expect(mid!.dy).toBeCloseTo((inner - mid!.textHeight) / 2, 9);
    expect(end!.dy).toBeCloseTo(inner - end!.textHeight, 9);
    // Drawn where a text box of the cell's rect would draw it.
    const box = clampTextObject({
      id: 'b',
      type: 'text',
      box: { x: end!.box.x, y: end!.box.y, w: end!.box.w, h: end!.box.h, rotation: 0 },
      text: 'end',
      style: { ...BASE, valign: 'bottom' },
      opacity: 1,
    } as TextObject);
    const alone = layoutRich(testMeasurer(), box, env);
    expect(end!.box.y + end!.dy + end!.layout.lines[0]!.baseline).toBeCloseTo(alone.lines[0]!.baseline, 9);
    expect(end!.box.x + end!.layout.lines[0]!.x).toBeCloseTo(alone.lines[0]!.x, 9);
  });

  it('editing one cell lays out one cell', () => {
    const o = tableShape(gridTable(4, 4));
    const m = testMeasurer();
    layoutTable(m, o, env);
    const before = new Set(m.texts);
    expect(before.has('r2c3')).toBe(true);
    m.texts.length = 0;
    // The same table sent again (a new object: a worker's copy) lays nothing out: its whole layout is kept.
    const first = layoutTable(m, o, env);
    expect(layoutTable(m, tableShape(gridTable(4, 4)), env)).toBe(first);
    expect(m.texts).toEqual([]);
    // At another box width it is laid out again (from the cells' own cache where their widths agree).
    expect(layoutTable(m, tableShape(gridTable(4, 4), { w: 500 }), env)).not.toBe(first);
    m.texts.length = 0;
    const edited = tableShape(setCell(o, 6, { ...cellRich(o.table!, 6)!, text: 'changed text' }).table!);
    layoutTable(m, edited, env);
    expect(m.texts.length).toBeGreaterThan(0);
    expect(m.texts.every((s) => 'changed text'.includes(s))).toBe(true);
  });

  it('lays equal cells out once (a master grid of 640 empty cells)', () => {
    const t = gridTable(20, 32, { cells: [...Array(640)].map(() => ({})) });
    const l = layoutTable(testMeasurer(), tableShape(t), env)!;
    expect(l.cells).toHaveLength(640);
    expect(tableCacheSize()).toBe(1);
  });

  it('prepares a table in slices that each stop at their budget, then the draw lays out nothing', () => {
    const t = gridTable(8, 8);
    const o = tableShape(t);
    const m = testMeasurer();
    let clock = 0;
    // Each measured string costs 1 ms of the fake clock.
    const timed = {
      ...m,
      width: (...a: Parameters<typeof m.width>) => {
        clock += 1;
        return m.width(...a);
      },
    };
    let slices = 0;
    while (!prepareTableLayout(timed, o, env, 8, () => clock)) slices++;
    expect(slices).toBeGreaterThan(4);
    const calls = m.calls;
    layoutTable(timed, o, env);
    expect(m.calls).toBe(calls);
    expect(prepareTableLayout(timed, o, env)).toBe(true);
  });

  it('maps slide points into the turned table and finds the cell', () => {
    const o = tableShape(gridTable(2, 2), { rotation: 90 });
    const l = layoutTable(testMeasurer(), o, env)!;
    // Turned 90° clockwise about its centre (200, 140): table-local (10, 10), 90 px left of and 30 px above
    // the centre, is now 30 px right of it and 90 px above.
    const p = tablePoint(o, 230, 50);
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBeCloseTo(10, 9);
    expect(tableHit(l, p.x, p.y)).toBe(0);
    expect(tableHit(l, 150, 50)).toBe(3);
    expect(tableHit(l, -1, 5)).toBe(-1);
    expect(tableHit(l, 5, l.height)).toBe(-1);
  });
});
