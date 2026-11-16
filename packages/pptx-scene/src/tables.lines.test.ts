import { describe, expect, it } from 'vitest';
import { frameOf } from './frame.ts';
import type { Para, RunStyle, TextBody } from './ir.ts';
import type { FaceSource } from './metrics.ts';
import { Measure } from './tables.ts';

/*
 * The converter's table measure breaks and sizes lines as the renderer lays out office text (text-lines,
 * sub-wave 1b): table cells are in the office line model, so their rows hold the lines the drawer draws.
 * Every character half an em wide; 18 pt is 36 px on a 16:9 slide 1920 px wide, so a character is 18 px.
 */

const HALF_EM: FaceSource = () => ({ advance: () => 0.5 });
const style: RunStyle = {
  sizePt: 18,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } },
  baseline: 0,
  spacingPt: 0,
  caps: 'none',
};
/** A paragraph of runs `[text, size in pt]`, its end mark at the first run's size. */
const paraOf = (...runs: [string, number][]): Para => ({
  runs: runs.map(([text, sizePt]) => ({ kind: 'text', text, style: { ...style, sizePt } })),
  align: 'left',
  level: 0,
  marL: 0,
  indent: 0,
  rtl: false,
  end: { ...style, sizePt: runs[0]?.[1] ?? 18 },
});
const body = (...paras: Para[]): TextBody => ({
  paras,
  insets: { l: 0, t: 0, r: 0, b: 0 },
  anchor: 'top',
  wrap: true,
  autofit: { kind: 'none' },
});
const measure = () => new Measure(frameOf(12_192_000, 6_858_000), HALF_EM);

describe("the converter's table measure breaks office text where LibreOffice does", () => {
  it('ends a line after a hyphen before a digit, as the drawer breaks a cell (1000 Years p1)', () => {
    // 11.5 characters wide: 'xxxxxxxx 3-' fits; UAX#14 keeps '3-4yyy' whole, so 'xxxxxxxx ' / '3-4yyy ' /
    // 'zzzzz' (three lines); LibreOffice's break after the hyphen gives 'xxxxxxxx 3-' / '4yyy zzzzz' (two).
    const b = body(paraOf(['xxxxxxxx 3-4yyy zzzzz', 18]));
    const w = 11.5 * 18;
    const m = measure();
    expect(m.height(b, w)).toBeCloseTo(2 * 1.2 * 36, 6);
    expect(m.layout(b, w).baselines).toHaveLength(2);
    expect(m.loLayout(b, w, 'font').drawn.baselines).toHaveLength(2);
    // A quotation mark, a space, an opening bracket: 'the “aa” ' / '[bb] cc' (UAX#14 keeps '“aa” [bb]').
    const q = body(paraOf(['the “aa” [bb] cc', 18]));
    expect(measure().layout(q, 9.5 * 18).baselines).toHaveLength(2);
  });
});
