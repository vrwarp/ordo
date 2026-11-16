import { beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_FONT_ENV } from '../text/fonts.ts';
import { measurerFor } from '../text/measure.ts';
import { type CtxOp, recordingCtx } from '../text/test-util.ts';
import { drawTable } from './draw.ts';
import { clearTableCache, layoutTable } from './layout.ts';
import { gridTable, tableShape } from './test-util.ts';

/*
 * Fixed rows on an output whose faces run wider than the converter measured (r2b 1b tables-form): an imported
 * table stores LibreOffice's rows, fixed, as the converter measured its text; an output that measures the
 * text 3 % wider (another face, estimated widths) wraps a cell the converter did not. The row stays as stored
 * and the cell's text runs past it, as a text box's overflows its box: every word drawn, below the row for
 * top-anchored text, nothing clipped, nothing thrown.
 */

beforeEach(() => clearTableCache());

/** The words a recording drew, each with its device y. */
const words = (ops: CtxOp[]) =>
  ops
    .filter((o) => o.op === 'fillText')
    .map((o) => {
      const [, b, , d, , f] = o.transform as number[];
      return {
        text: String(o.args[0]).trim(),
        y: b! * (o.args[1] as number) + d! * (o.args[2] as number) + f!,
      };
    });

describe('a fixed row on an output that measures its text wider', () => {
  // 'aaaa bbbb' is 90 px at 20 px and half an em a character: one line in a 101 px column (91 inside its 5 px
  // insets); 3 % wider it is 92.7 px and wraps 'bbbb' to a second line.
  const table = () =>
    gridTable(1, 2, {
      cols: [101, 101],
      rows: [40],
      rowRule: 'fixed',
      cells: [{ text: 'aaaa bbbb' }, { text: 'x' }],
    });

  it('keeps the row as stored and draws the wrapped word past it, unclipped', () => {
    const o = tableShape(table());
    const narrow = layoutTable(measurerFor(recordingCtx(0.5)), o, LEGACY_FONT_ENV)!;
    expect(narrow.cells[0]!.layout.lines).toHaveLength(1);
    clearTableCache();
    const wide = recordingCtx(0.515);
    const l = layoutTable(measurerFor(wide), o, LEGACY_FONT_ENV)!;
    expect(l.cells[0]!.layout.lines).toHaveLength(2);
    expect(l.height).toBe(40);
    expect(l.cells[0]!.need).toBeGreaterThan(40);
    expect(() => drawTable(wide, o, 1)).not.toThrow();
    const drawn = words(wide.ops);
    expect(drawn.map((w) => w.text)).toEqual(['aaaa', 'bbbb', 'x']);
    // Top-anchored: the second line sits below the first, past the row's bottom (y 100 + 40).
    const [a, b] = [drawn[0]!, drawn[1]!];
    expect(b.y).toBeGreaterThan(a.y);
    expect(b.y).toBeGreaterThan(140);
    expect(wide.ops.some((op) => op.op === 'clip')).toBe(false);
  });
});
