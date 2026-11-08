import { type ShapeObject, type SlideObject, rgbaCss } from '@ordo/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { clampObject } from '../clamp.ts';
import { drawObject, drawShape } from '../text2d.ts';
import { type CtxOp, recordingCtx } from '../text/test-util.ts';
import { drawTable } from './draw.ts';
import './index.ts';
import { clearTableCache, layoutTable } from './layout.ts';
import { legacyGroup } from './legacy.ts';
import { grey, gridTable, navy, tableShape, white } from './test-util.ts';
import { measurerFor } from '../text/measure.ts';
import { LEGACY_FONT_ENV } from '../text/fonts.ts';

/*
 * Drawing a table (design/27 M9, tables-object.md §4.5): M6's order (background, fills, lines, text), fills
 * joined along a row, lines stretched at the vertices so corners close, text where the M6 group's text boxes
 * draw it, the shape dispatch drawing the table (and its legacy rect when the table cannot be drawn).
 */

beforeEach(() => clearTableCache());

/** Where a call drew (x, y), in device px. */
function at(op: CtxOp, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = op.transform as [number, number, number, number, number, number];
  return [a * x + c * y + e, b * x + d * y + f];
}

/** The text calls of a recording as (text, device x, device y), rounded to 1e-6 px. */
function texts(ops: CtxOp[]): string[] {
  return ops
    .filter((o) => o.op === 'fillText')
    .map((o) => {
      const [x, y] = at(o, o.args[1] as number, o.args[2] as number);
      return `${o.args[0]} ${x.toFixed(6)} ${y.toFixed(6)}`;
    });
}

describe('drawing a table', () => {
  it("draws in M6's order: the background over the grown table, joined fills, stretched lines, then text", () => {
    const t = gridTable(2, 3, {
      fills: [{ color: white }, { color: navy }],
      background: 0,
      lineStyles: [
        { width: 4, color: grey },
        { width: 1, color: grey },
      ],
      h: [
        [0, 0, 3, 0],
        [2, 0, 3, 0],
      ],
      v: [[1, 0, 2, 1]],
    });
    t.cells[0]!.fill = 1;
    t.cells[1]!.fill = 1;
    t.cells[5]!.fill = 1;
    const r = recordingCtx();
    const o = tableShape(t);
    drawShape(r, o, 1);
    const ops = r.ops.map((x) => x.op);
    const firstText = ops.indexOf('fillText');
    expect(ops.slice(0, firstText)).toEqual([
      'fillRect', // background
      'beginPath',
      'rect', // cells 0 and 1 joined
      'rect', // cell 5
      'fill',
      'setLineDash',
      'beginPath',
      'moveTo',
      'lineTo',
      'moveTo',
      'lineTo',
      'stroke', // the 4 px style, horizontal
      'setLineDash',
      'beginPath',
      'moveTo',
      'lineTo',
      'stroke', // the 1 px style, vertical
      'setLineDash',
    ]);
    const fill = r.ops[0]!;
    expect(fill.args).toEqual([0, 0, 300, 80]);
    expect(fill.fillStyle).toBe(rgbaCss(white));
    expect(r.ops[2]!.args).toEqual([0, 0, 200, 40]);
    expect(r.ops[3]!.args).toEqual([200, 40, 100, 40]);
    // The vertical line at column edge 1 meets the 4 px lines at both its ends: stretched by 2 px each way.
    const v = r.ops.filter((x) => x.op === 'moveTo' || x.op === 'lineTo').slice(4);
    expect(v.map((x) => x.args)).toEqual([
      [100, -2],
      [100, 82],
    ]);
    // Every cell's text is drawn, after the grid.
    expect(texts(r.ops.slice(firstText)).map((s) => s.split(' ')[0])).toEqual([
      'r0c0',
      'r0c1',
      'r0c2',
      'r1c0',
      'r1c1',
      'r1c2',
    ]);
  });

  it('draws its text where the M6 group of the same table draws it, turned or not', () => {
    for (const rotation of [0, 30]) {
      const t = gridTable(3, 2, {
        cells: [
          { text: 'Time', style: 0 },
          { text: 'Order of service' },
          { text: '10:00', style: 1 },
          { text: 'Call to worship and opening hymn' },
          { text: '10:15' },
          { text: 'Reading' },
        ],
        styles: [{ align: 'center', valign: 'middle', fontWeight: 700 }, { valign: 'bottom' }],
      });
      const o = tableShape(t, { rotation });
      for (const scale of [0.5, 2]) {
        const mine = recordingCtx();
        drawTable(mine, o, scale);
        const group = recordingCtx();
        const l = layoutTable(measurerFor(group), o, LEGACY_FONT_ENV)!;
        for (const g of legacyGroup(o, l)) if (g.type === 'text') drawObject(group, clampObject(g)!, scale);
        expect(texts(mine.ops)).toEqual(texts(group.ops));
        // One call per drawn segment (word): every cell's words are there.
        const words = texts(mine.ops).map((x) => x.split(' ')[0]);
        for (const w of ['Time', 'Order', 'service', '10:00', 'opening', 'Reading'])
          expect(words).toContain(w);
      }
    }
  });

  it('draws a gradient fill over each cell, and dashed lines by the shape dash patterns', () => {
    const t = gridTable(1, 2, {
      fills: [
        {
          color: navy,
          gradient: {
            kind: 'linear',
            angle: 0,
            stops: [
              { at: 0, color: navy },
              { at: 1, color: white },
            ],
          },
        },
      ],
      cells: [{ fill: 0 }, { fill: 0 }],
      lineStyles: [{ width: 2, color: grey, dash: 'dash' }],
      h: [[0, 0, 2, 0]],
      v: [],
    });
    const r = recordingCtx();
    drawTable(r, tableShape(t), 1);
    const rects = r.ops.filter((x) => x.op === 'fillRect');
    expect(rects).toHaveLength(2);
    // Each in its cell's own box space (translated to the cell), over the cell's size.
    expect(rects.map((x) => [at(x, 0, 0)[0], x.args])).toEqual([
      [100, [0, 0, 100, 40]],
      [200, [0, 0, 100, 40]],
    ]);
    const dash = r.ops.find((x) => x.op === 'setLineDash')!;
    expect(dash.args[0]).toEqual([8, 6]);
  });

  it('draws nothing at opacity 0, and the grid at its opacity', () => {
    const none = recordingCtx();
    drawTable(none, tableShape(gridTable(1, 1), {}, { opacity: 0 }), 1);
    expect(none.ops.filter((x) => x.op !== 'setLineDash')).toEqual([]);
    const half = recordingCtx();
    drawTable(half, tableShape(gridTable(1, 1), {}, { opacity: 0.5 }), 1);
    expect(half.ops.find((x) => x.op === 'stroke')!.state.globalAlpha).toBe(0.5);
    expect(half.ops.find((x) => x.op === 'fillText')!.state.globalAlpha).toBe(0.5);
  });

  it('a shape whose table cannot be drawn draws its legacy rect', () => {
    const r = recordingCtx();
    const o = clampObject({
      ...tableShape(gridTable(1, 1)),
      fill: white,
      table: { ...gridTable(1, 1), cols: [0] },
    }) as ShapeObject;
    expect(o.table).toBeUndefined();
    drawShape(r, o, 1);
    expect(r.ops.map((x) => x.op).filter((x) => x !== 'beginPath')).toEqual(['rect', 'fill']);
    expect(r.ops.find((x) => x.op === 'rect')!.args).toEqual([100, 100, 100, 40]);
  });

  it('draws no stored line inside a merged cell', () => {
    // Every row edge stored across all three columns; the first two cells of row 0 merged over two rows.
    const t = gridTable(2, 3, {
      cells: [{ text: 'merged', colSpan: 2, rowSpan: 2 }, { text: 'a' }, { text: 'b' }],
      v: [],
    });
    const r = recordingCtx();
    drawTable(r, tableShape(t), 1);
    const segs = r.ops.filter((x) => x.op === 'moveTo' || x.op === 'lineTo').map((x) => x.args);
    // Rows 0 and 2 whole; row edge 1 only right of the merge (from x = 200).
    expect(segs).toEqual([
      [0, 0],
      [300, 0],
      [200, 40],
      [300, 40],
      [0, 80],
      [300, 80],
    ]);
  });

  it('draws diagonals across their cells', () => {
    const t = gridTable(1, 1, { h: [], v: [], cells: [{ diag: { down: 0, up: 0 } }] });
    const r = recordingCtx();
    drawTable(r, tableShape(t), 1);
    const lines = r.ops.filter((x) => x.op === 'moveTo' || x.op === 'lineTo').map((x) => x.args);
    expect(lines).toEqual([
      [0, 0],
      [100, 40],
      [0, 40],
      [100, 0],
    ]);
  });

  it('the M6 group it is compared with draws the same fills, lines and texts as objects', () => {
    const t = gridTable(2, 2, { fills: [{ color: navy }], background: 0 });
    const o = tableShape(t);
    const l = layoutTable(measurerFor(recordingCtx()), o, LEGACY_FONT_ENV)!;
    const g: SlideObject[] = legacyGroup(o, l);
    expect(g.map((x) => `${x.type}:${x.origin?.role}`)).toEqual([
      'shape:grid',
      'shape:grid',
      'text:cell',
      'text:cell',
      'text:cell',
      'text:cell',
    ]);
    for (const x of g) expect(clampObject(x)).toBeDefined();
  });
});
