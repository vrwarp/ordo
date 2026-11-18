import { type ShapeObject, type TextObject, rgbaCss } from '@ordo/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { clampObject } from '../clamp.ts';
import { drawObject } from '../text2d.ts';
import { LEGACY_FONT_ENV } from '../text/fonts.ts';
import { measurerFor } from '../text/measure.ts';
import { paintRich } from '../text/paint.ts';
import { drawRichText, layoutRich } from '../text/rich.ts';
import { type CtxOp, recordingCtx } from '../text/test-util.ts';
import { drawTable } from './draw.ts';
import './index.ts';
import { clearTableCache, layoutTable } from './layout.ts';
import { legacyGroup } from './legacy.ts';
import { BASE, grey, gridTable, navy, tableShape } from './test-util.ts';

/*
 * Table-cell text on device pixels (text-lines, sub-wave 1b; design/27 §6 "Paint passes"): LibreOffice's pages,
 * as the reference rasterizer draws them (pdftoppm, at 144 and 288 dpi), put every baseline on the device row its
 * position falls in, every glyph run's start on the quarter of a device column it falls in, and underlines and
 * strikes on whole rows (the text-lines probe deck). The table drawer asks the plain painter for that
 * (`PaintHooks.devicePixels`) at every output scale; layout stays scale-free, and every other caller (text
 * boxes, ordo's own text) paints as before. These are the cell twins of paint.hooks.test.ts "the plain painter
 * draws today's pixels", paint.test.ts "draws underline and strike F/18 thick around the baseline" and
 * lines.test.ts "breaks and places lines identically at any output scale", which stay as they are.
 */

beforeEach(() => clearTableCache());

/** Where a call drew (x, y), in device px. */
function at(op: CtxOp, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = op.transform as [number, number, number, number, number, number];
  return [a * x + c * y + e, b * x + d * y + f];
}

const EPS = 1e-6;
/** The device row a baseline falls in (floor), and the quarter column a run start falls in (floor). */
const row = (y: number) => Math.floor(y + EPS);
const quarter = (x: number) => Math.floor(x * 4 + EPS) / 4;

/** A device coordinate rounded to 1e-6 px (float noise of differently composed transforms is none). */
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** The text calls of a recording as [text, device x, device y]. */
function glyphCalls(ops: CtxOp[]): [string, number, number][] {
  return ops
    .filter((o) => o.op === 'fillText' || o.op === 'strokeText')
    .map((o) => {
      const [x, y] = at(o, o.args[1] as number, o.args[2] as number);
      return [o.args[0] as string, r6(x), r6(y)];
    });
}

/** The rect calls of a recording as [device top, device bottom, device left, device right]. */
function rectCalls(ops: CtxOp[]): [number, number, number, number][] {
  return ops
    .filter((o) => o.op === 'fillRect')
    .map((o) => {
      const [x, y, w, h] = o.args as [number, number, number, number];
      const [x0, y0] = at(o, x, y);
      const [x1, y1] = at(o, x + w, y + h);
      return [r6(y0), r6(y1), r6(x0), r6(x1)];
    });
}

/** What the M6 group of the same table draws (one text box per cell, the plain painter). */
function groupOps(o: ShapeObject, scale: number): CtxOp[] {
  const group = recordingCtx();
  const l = layoutTable(measurerFor(group), o, LEGACY_FONT_ENV)!;
  for (const g of legacyGroup(o, l)) if (g.type === 'text') drawObject(group, clampObject(g)!, scale);
  return group.ops;
}

/** A 2 x 2 table at a fractional position: words, an underlined and struck run, a highlighted one. */
function table(box: Partial<ShapeObject['box']> = {}): ShapeObject {
  const t = gridTable(2, 2, {
    cells: [
      { text: 'Time of', style: 0 },
      { text: 'Order of service', runs: [[0, 5, 0]] },
      { text: '10:00', runs: [[0, 5, 1]] },
      { text: 'Call to worship and opening hymn' },
    ],
    styles: [{ align: 'center', valign: 'middle' }],
    runStyles: [{ underline: true, strike: true }, { highlight: { r: 250, g: 230, b: 120, a: 1 } }],
  });
  return tableShape(t, { x: 100.3, y: 77.7, ...box });
}

describe('table-cell text on device pixels', () => {
  it('puts every cell glyph run on its device row and quarter column, at any scale (twin of the plain painter pin)', () => {
    for (const scale of [0.5, 1, 1.5, 2]) {
      const o = table();
      const mine = recordingCtx();
      drawTable(mine, o, scale);
      const plain = glyphCalls(groupOps(o, scale));
      const cells = glyphCalls(mine.ops);
      // The same runs, in the same order, with the same text: only where they are painted moves.
      expect(cells.map((c) => c[0])).toEqual(plain.map((p) => p[0]));
      expect(cells.length).toBeGreaterThan(8);
      cells.forEach(([, x, y], i) => {
        const [, px, py] = plain[i]!;
        expect(y).toBeCloseTo(row(py), 6);
        expect(x).toBeCloseTo(quarter(px), 6);
      });
      // Something did move: the table sits at fractional positions.
      expect(
        cells.some(([, x, y], i) => Math.abs(x - plain[i]![1]) > 0.01 || Math.abs(y - plain[i]![2]) > 0.01),
      ).toBe(true);
    }
  });

  it('puts underlines and strikes on whole device rows, highlights where they were (twin of the underline pin)', () => {
    for (const scale of [1, 2]) {
      const o = table();
      const mine = recordingCtx();
      drawTable(mine, o, scale);
      const plainOps = groupOps(o, scale);
      // Cell 1's underline and strike (pass 6), then cell 2's highlight (pass 1), as the group draws them.
      const plain = rectCalls(plainOps);
      const cells = rectCalls(mine.ops.filter((x) => x.op === 'fillRect' && x.fillStyle !== rgbaCss(grey)));
      expect(plain).toHaveLength(3);
      expect(cells).toHaveLength(3);
      const [under, strike, hl] = cells;
      // The highlight is not snapped.
      expect(hl).toEqual(plain[2]);
      for (const [got, was] of [
        [under!, plain[0]!],
        [strike!, plain[1]!],
      ] as const) {
        const top = Math.round(was[0]);
        expect(got[0]).toBeCloseTo(top, 6);
        expect(got[1]).toBeCloseTo(Math.max(top + 1, Math.round(was[1])), 6);
        // Left and right edges are not snapped.
        expect(got[2]).toBeCloseTo(was[2], 6);
        expect(got[3]).toBeCloseTo(was[3], 6);
      }
    }
  });

  it('lays a cell out identically at any output scale and paints it at floor(scale x position) (twin of the scale pin)', () => {
    const o = table({ x: 13.37, y: 21.91 });
    const layouts = new Set<unknown>();
    const draws = [0.5, 1, 2, 4].map((scale) => {
      const r = recordingCtx(0.5);
      const l = drawTable(r, o, scale)!;
      layouts.add(JSON.stringify(l.cells.map((c) => c.layout.lines)));
      return { scale, calls: glyphCalls(r.ops) };
    });
    // Breaks, lines and logical positions do not depend on the output.
    expect(layouts.size).toBe(1);
    const logical = draws[1]!.calls; // scale 1: device = logical (at whole positions after snapping)
    const l = layoutTable(measurerFor(recordingCtx(0.5)), o, LEGACY_FONT_ENV)!;
    const exact: [string, number, number][] = [];
    for (const c of l.cells)
      for (const line of c.layout.lines)
        for (const s of line.segs) {
          const text = c.text.text.slice(s.start, s.end).trimEnd();
          if (!text) continue;
          exact.push([text, o.box.x + c.box.x + s.x, o.box.y + c.box.y + c.dy + line.baseline + s.shift]);
        }
    expect(logical.map((x) => x[0].trimEnd())).toEqual(exact.map((x) => x[0]));
    for (const { scale, calls } of draws)
      calls.forEach(([, x, y], i) => {
        const [, ex, ey] = exact[i]!;
        expect(y).toBeCloseTo(row(scale * ey), 6);
        expect(x).toBeCloseTo(quarter(scale * ex), 6);
      });
  });

  it('paints a turned table, and every text box, exactly as the plain painter (the gate)', () => {
    // Turned: no device grid to snap to; the cells paint where the group's text boxes paint.
    for (const scale of [0.5, 2]) {
      const o = table({ rotation: 30 });
      const mine = recordingCtx();
      drawTable(mine, o, scale);
      expect(glyphCalls(mine.ops)).toEqual(glyphCalls(groupOps(o, scale)));
    }
    // A text box of office text (an imported one) is painted as before: never on device pixels.
    const box: TextObject = {
      id: 't',
      type: 'text',
      box: { x: 100.3, y: 77.7, w: 400, h: 200, rotation: 0 },
      text: 'Call to worship and opening hymn',
      style: { ...BASE, color: navy },
      opacity: 1,
    };
    const drawn = recordingCtx();
    drawRichText(drawn, box, 1, LEGACY_FONT_ENV);
    const ref = recordingCtx();
    const c = clampObject(box) as TextObject;
    paintRich(ref, c, layoutRich(measurerFor(ref), c, LEGACY_FONT_ENV), 1, LEGACY_FONT_ENV, {
      devicePixels: false,
    });
    expect(glyphCalls(drawn.ops)).toEqual(glyphCalls(ref.ops));
    expect(glyphCalls(drawn.ops).some(([, x, y]) => x !== quarter(x) || y !== row(y))).toBe(true);
  });
});
