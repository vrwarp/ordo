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

  it('breaks an address that starts its paragraph after its slashes and before its %, as the drawer does', () => {
    // LibreOffice keeps the break after a slash with no whitespace in the 64 units before it (text-falls probe
    // C): 15.5 characters hold each of 'https://' / 'archive.org/' / 'details/' / 'copticlanguage/' / 'Coptic'
    // / '%20Language/' / 'mode/2up' but never two: seven lines, where a cut by width would make five.
    const url = 'https://archive.org/details/copticlanguage/Coptic%20Language/mode/2up';
    const w = 15.5 * 18;
    expect(measure().layout(body(paraOf([url, 18])), w).baselines).toHaveLength(7);
    // After words in its paragraph every slash is within 64 units of the space and glued: 'see ', three cuts
    // by width ('https://archive' / '.org/details/co' / 'pticlanguage/Co'), 'ptic' at the break before '%',
    // then '%20Language/mod' / 'e/2up' by width: seven lines (six without the '%' break).
    expect(measure().layout(body(paraOf([`see ${url}`, 18])), w).baselines).toHaveLength(7);
  });
});

describe("the converter's table measure sizes each line by its own runs", () => {
  it('makes a short line of a smaller citation that wraps onto it, in all three measures (Matthew 16v18)', () => {
    // 'aaaa ' at 18 pt (18 px a character), then 'bbbb cccc' at 9 pt (9 px): 140 px holds 'aaaa bbbb ', so
    // 'cccc' wraps onto a line of its own. That line is as tall as a 9 pt line, as LibreOffice draws it.
    const w = 140;
    const mixed = body(paraOf(['aaaa ', 18], ['bbbb cccc', 9]));
    const big = body(paraOf(['aaaa', 18]));
    const small = body(paraOf(['cccc', 9]));
    const m = measure();
    // Ordo's rows (the office model's single spacing): 1.2 × 36 + 1.2 × 18.
    expect(m.height(mixed, w)).toBeCloseTo(m.height(big, w) + m.height(small, w), 6);
    expect(m.height(mixed, w)).toBeCloseTo(1.2 * 36 + 1.2 * 18, 6);
    // The block the drawer draws: its second baseline is a 9 pt ascent below the first line.
    const block = m.layout(mixed, w);
    expect(block.height).toBeCloseTo(1.2 * 36 + 1.2 * 18, 6);
    expect(block.baselines[1]! - block.baselines[0]!).toBeCloseTo(1.2 * 36 - 36 + 18, 6);
    // LibreOffice's rows (1/100 mm, the face's own line heights).
    for (const mode of ['font', 'independent'] as const) {
      const lo = m.loLayout(mixed, w, mode);
      expect(lo.height).toBe(m.loLayout(big, w, mode).height + m.loLayout(small, w, mode).height);
      expect(lo.drawn.height).toBe(
        m.loLayout(big, w, mode).drawn.height + m.loLayout(small, w, mode).drawn.height,
      );
    }
  });
});

describe("the converter's table measure keeps the kerning across an office-only break", () => {
  // A face whose '-' is a quarter em and kerns with a following '4' by a quarter em (9 px at 36 px), as Inter's
  // '-2' does: the renderer places '3-' and '4…' on one line as the whole string is shaped (text-falls A).
  const KERNED: FaceSource = () => ({
    advance: (cp: number) => (cp === 0x2d ? 0.25 : 0.5),
    kern: (a: number, b: number) => (a === 0x2d && b === 0x34 ? -0.25 : 0),
  });
  const kerned = () => new Measure(frameOf(12_192_000, 6_858_000), KERNED);

  it("fits 'aa 3-4bbbb' kerned on one line, and measures the line after the break without the pair", () => {
    // 'aa 3-' is 81 px, '4bbbb' 90 px, the pair -9 px: 162 px kerned, 171 apart.
    const b = body(paraOf(['aa 3-4bbbb', 18]));
    for (const w of [165, 162.5]) {
      expect(kerned().layout(b, w).baselines).toHaveLength(1);
      expect(kerned().height(b, w)).toBeCloseTo(1.2 * 36, 6);
      expect(kerned().loLayout(b, w, 'font').drawn.baselines).toHaveLength(1);
    }
    // 85 px: 'aa 3-' / then '4bbbb' alone is 90 px (the pair is across the line end), cut once more: 3 lines.
    expect(kerned().layout(b, 85).baselines).toHaveLength(3);
  });
});
