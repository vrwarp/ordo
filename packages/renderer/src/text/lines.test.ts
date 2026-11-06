import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, type TextObject, type TextStyle } from '@ordo/domain';
import { LEGACY_FONT_ENV } from './fonts.ts';
import { itemize } from './itemize.ts';
import { layoutBox } from './lines.ts';
import { FIT_SLACK_PX } from './office.ts';
import { clampTextObject, drawRichText, layoutRich } from './rich.ts';
import { prepare } from './segments.ts';
import { recordingCtx, testMeasurer } from './test-util.ts';
import type { BulletSpec, RichLayout } from './types.ts';

/*
 * Lines, alignment, bullets, anchor and insets (design/27 §6 steps 6, 8 and 9) with the deterministic
 * measurer: 20 px text, every character 10 px wide.
 */

const WHITE = { r: 255, g: 255, b: 255, a: 1 };

function obj(text: string, style: Partial<TextStyle> = {}, extra: Partial<TextObject> = {}): TextObject {
  return clampTextObject({
    id: 't',
    type: 'text',
    box: { x: 0, y: 0, w: 200, h: 100, rotation: 0 },
    text,
    style: {
      ...DEFAULT_LYRIC_STYLE,
      padding: 0,
      fontSizePx: 20,
      lineHeight: 1,
      align: 'left',
      valign: 'top',
      lang: 'en',
      ...style,
    },
    opacity: 1,
    ...extra,
  });
}

const bullet = (text: string): BulletSpec => ({
  text,
  family: 'Inter',
  fallbacks: [],
  weight: 400,
  italic: false,
  sizePct: 1,
  color: WHITE,
});

/**
 * `layoutBox` over itemize and prepare, with right-to-left paragraphs forced (`rtl[i]`: the paragraph and
 * every piece at level 1, what bidi.ts gives an all-RTL paragraph) and bullets given directly.
 */
function layout(o: TextObject, opts: { rtl?: boolean[]; bullets?: (BulletSpec | null)[] } = {}): RichLayout {
  const prepared = prepare(itemize(o));
  opts.rtl?.forEach((r, i) => {
    const pp = prepared[i];
    if (!r || !pp) return;
    pp.bidi = { level: 1, levels: null };
    for (const p of pp.pieces) p.level = 1;
  });
  return layoutBox(testMeasurer({ em: 0.5 }), o, prepared, opts.bullets ?? [], LEGACY_FONT_ENV);
}

const box = (w: number, h = 100) => ({ box: { x: 0, y: 0, w, h, rotation: 0 } });
const segTexts = (o: TextObject, l: RichLayout, i: number) =>
  l.lines[i]!.segs.map((s) => [o.text.slice(s.start, s.end), s.x]);

describe('justify and distribute', () => {
  it('spreads the free width over the inter-piece spaces of every line but the last', () => {
    const o = obj('aaa bbb ccc ddd', {}, { ...box(75), paras: [{ align: 'justify' }] });
    const l = layout(o);
    expect(l.lines[0]).toMatchObject({ x: 0, w: 75, extraPerSpace: 5 });
    expect(segTexts(o, l, 0)).toEqual([
      ['aaa ', 0],
      ['bbb ', 45],
    ]);
    expect(l.lines[1]).toMatchObject({ x: 0, w: 70, extraPerSpace: 0 });
    const d = layout(obj('aaa bbb ccc ddd', {}, { ...box(75), paras: [{ align: 'distribute' }] }));
    expect(d.lines[1]).toMatchObject({ w: 75, extraPerSpace: 5 });
  });

  it('counts every whitespace unit, never the hanging ones, and leaves single-word lines alone', () => {
    const o = obj('aa  bb cc dd', {}, { ...box(85), paras: [{ align: 'justify' }] });
    const l = layout(o);
    expect(l.lines[0]!.extraPerSpace).toBe(12.5);
    expect(segTexts(o, l, 0)).toEqual([
      ['aa  ', 0],
      ['bb ', 65],
    ]);
    const one = layout(obj('abcdefgh ij', {}, { ...box(85), paras: [{ align: 'distribute' }] }));
    expect(one.lines[0]).toMatchObject({ x: 0, extraPerSpace: 0 });
  });

  it("justifies every box paragraph with style.justify, and a paragraph's own align wins", () => {
    const o = obj(
      'aaa bbb ccc\naaa bbb ccc',
      { justify: true },
      { ...box(75), paras: [null, { align: 'right' }] },
    );
    const l = layout(o);
    expect(l.lines[0]!.extraPerSpace).toBe(5);
    expect(l.lines[2]).toMatchObject({ x: 5, extraPerSpace: 0 });
  });
});

describe('right-to-left paragraphs', () => {
  it('run from the right: the last line of a justified paragraph ends at the right edge', () => {
    const o = obj('aaa bbb ccc', {}, { ...box(75), paras: [{ align: 'justify' }] });
    const l = layout(o, { rtl: [true] });
    // Visual order: the second word on the left. Its trailing space hangs out on the left.
    expect(segTexts(o, l, 0)).toEqual([
      ['bbb ', -10],
      ['aaa ', 35],
    ]);
    expect(l.lines[0]).toMatchObject({ x: 0, w: 75 });
    expect(l.lines[1]).toMatchObject({ x: 45, w: 30 });
  });

  it('hang trailing whitespace on the visual left and keep align visual', () => {
    const right = obj('aaa bbb ccc', { align: 'right' }, box(75));
    const r = layout(right, { rtl: [true] });
    expect(r.lines[0]).toMatchObject({ x: 5, w: 70 });
    expect(segTexts(right, r, 0)).toEqual([
      ['bbb ', -5],
      ['aaa ', 35],
    ]);
    const left = layout(obj('aaa bbb ccc', { align: 'left' }, box(75)), { rtl: [true] });
    expect(left.lines[1]!.x).toBe(0);
  });
});

describe('bullets', () => {
  it('hang in the negative indent; following lines start at the margin', () => {
    const o = obj('aaa bbb ccc', {}, { ...box(115), paras: [{ indentPx: 40, firstLinePx: -40 }] });
    const l = layout(o, { bullets: [bullet('•')] });
    expect(l.lines.map((x) => x.x)).toEqual([40, 40]);
    expect(l.lines[0]!.bullet).toMatchObject({ text: '•', x: 0, sizePx: 20 });
    expect(l.lines[1]!.bullet).toBeUndefined();
    expect(l.ink.x).toBe(0);
  });

  it('push the text along when wider than the hanging indent', () => {
    const o = obj('aaa bbb', {}, { ...box(200), paras: [{ indentPx: 20, firstLinePx: -20 }] });
    const l = layout(o, { bullets: [bullet('(17)')] });
    expect(l.lines[0]!.x).toBe(40);
    expect(l.lines[0]!.bullet!.x).toBe(0);
  });

  it('move with centred text and sit on the right in a right-to-left paragraph', () => {
    const c = layout(obj('ab', { align: 'center' }), { bullets: [bullet('•')] });
    expect(c.lines[0]!.x).toBe(95);
    expect(c.lines[0]!.bullet!.x).toBe(85);
    const o = obj('ccc', { align: 'right' }, { paras: [{ indentPx: 40, firstLinePx: -40 }] });
    const r = layout(o, { rtl: [true], bullets: [bullet('•')] });
    expect(r.lines[0]!.x).toBe(130);
    expect(r.lines[0]!.bullet!.x).toBe(190);
    expect(r.ink.x + r.ink.w).toBe(200);
  });

  it('are sized from the paragraph main size and never drawn on soft or empty paragraphs', () => {
    const o = obj('a\n\nb\nc', {}, { paras: [null, null, null, { soft: true }] });
    const l = layout(o, {
      bullets: [bullet('•'), bullet('•'), { ...bullet('–'), sizePct: 0.5 }, bullet('•')],
    });
    expect(l.lines.map((x) => x.bullet?.text ?? null)).toEqual(['•', null, '–', null]);
    expect(l.lines[2]!.bullet!.sizePx).toBe(10);
    expect(l.lines[2]!.x).toBe(5);
  });

  it('are drawn on an empty first line when a soft line of the paragraph has text', () => {
    const o = obj('\nabc\n\nd', {}, { paras: [null, { soft: true }, null, null] });
    const l = layout(o, { bullets: [bullet('1.'), null, null, bullet('2.')] });
    expect(l.lines.map((x) => x.bullet?.text ?? null)).toEqual(['1.', null, null, '2.']);
  });

  it('come from the domain labels end to end: an empty paragraph gets none and does not count', () => {
    const num = { bullet: { auto: 'arabicPeriod' } };
    const o = obj('a\n\nb\n\nc', {}, { paras: [num, num, num, num, { ...num, soft: true }] });
    const l = layoutRich(testMeasurer({ em: 0.5 }), o, LEGACY_FONT_ENV);
    expect(l.lines.map((x) => x.bullet?.text ?? null)).toEqual(['1.', null, '2.', '3.', null]);
  });
});

describe('wrap: false', () => {
  it('never breaks and grows from the alignment', () => {
    const left = layout(obj('aaa bbb ccc', { wrap: false, align: 'left' }, box(60)));
    expect(left.lines).toHaveLength(1);
    expect(left.lines[0]).toMatchObject({ x: 0, w: 110 });
    expect(left.overflow).toBe(true);
    const right = layout(obj('aaa bbb ccc', { wrap: false, align: 'right' }, box(60)));
    expect(right.lines[0]!.x).toBe(-50);
  });
});

describe('anchor and insets', () => {
  const placed = (style: Partial<TextStyle>) =>
    layout(
      obj(
        'ab',
        { insets: { l: 10, t: 5, r: 30, b: 15 }, ...style },
        { box: { x: 100, y: 50, w: 200, h: 100, rotation: 0 } },
      ),
    );

  it('places the text in the box less its insets', () => {
    expect(placed({ valign: 'top' }).lines[0]).toMatchObject({ top: 55, x: 110 });
    expect(placed({ valign: 'middle' }).lines[0]!.top).toBe(85);
    expect(placed({ valign: 'bottom' }).lines[0]!.top).toBe(115);
    expect(placed({ align: 'right' }).lines[0]!.x).toBe(250);
    expect(placed({}).ink).toEqual({ x: 110, y: 55, w: 20, h: 20, rotation: 0 });
  });

  it('wraps at the inner width and overflows the inner height (with 0.5 mm of slack)', () => {
    const o = (h: number) =>
      obj('aaa bbb ccc ddd eee', { insets: { l: 0, t: 0, r: 160, b: 0 } }, box(200, h));
    expect(layout(o(100)).lines).toHaveLength(5);
    expect(layout(o(100)).overflow).toBe(false);
    expect(layout(o(100 - FIT_SLACK_PX + 0.01)).overflow).toBe(false);
    expect(layout(o(98 - FIT_SLACK_PX)).overflow).toBe(true);
    const mid = layout(obj('a\nb\nc\nd\ne\nf', { valign: 'middle' }, box(200, 100)));
    expect(mid.lines[0]!.top).toBe(-10);
    expect(mid.overflow).toBe(true);
  });
});

describe("the 'ordo' line model", () => {
  it('reads lineSpacing as a multiple of single spacing (1.2F) and lineSpacingPx as the pitch', () => {
    const o = obj(
      'a\nb\nc\nd',
      { lineHeight: 1.5 },
      { paras: [null, { lineSpacing: 1 }, { lineSpacingPx: 50 }, { lineSpacing: 2 }] },
    );
    const l = layout(o);
    expect(l.lines.map((x) => x.height)).toEqual([30, 24, 50, 48]);
    for (const line of l.lines) expect(line.baseline - line.top).toBeCloseTo((line.height - 20) / 2 + 16, 9);
  });

  it('draws space before and after paragraphs between them only', () => {
    const o = obj(
      'a\nb',
      {},
      {
        paras: [
          { spaceBeforePx: 40, spaceAfterPx: 7 },
          { spaceBeforePx: 3, spaceAfterPx: 40 },
        ],
      },
    );
    expect(layout(o).lines.map((x) => x.top)).toEqual([0, 30]);
  });
});

describe('soft paragraphs', () => {
  it('continue their paragraph: its alignment, indent and spacing, no space between them', () => {
    const o = obj(
      'aaa\nbbb\nccc',
      {},
      {
        paras: [
          { align: 'right', spaceAfterPx: 10, indentPx: 20, firstLinePx: 30 },
          { soft: true },
          { spaceBeforePx: 5 },
        ],
      },
    );
    const l = layout(o);
    expect(l.lines.map((x) => [x.top, x.x])).toEqual([
      [0, 170],
      [20, 170],
      [55, 0],
    ]);
    const left = layout(obj('aaa\nbbb', {}, { paras: [{ indentPx: 20, firstLinePx: 30 }, { soft: true }] }));
    expect(left.lines.map((x) => x.x)).toEqual([50, 20]);
  });
});

describe('logical layout', () => {
  it('breaks and places lines identically at any output scale', () => {
    const o = obj('For God so loved the world that he gave', { align: 'center', wrap: true }, box(150));
    const draws = [0.5, 1, 2, 4].map((scale) => {
      const ctx = recordingCtx(0.5);
      drawRichText(ctx, o, scale, LEGACY_FONT_ENV);
      return ctx.ops.filter((op) => op.op === 'fillText').map((op) => [op.args, op.font]);
    });
    expect(draws[0]!.length).toBeGreaterThan(3);
    for (const d of draws) expect(d).toEqual(draws[0]);
  });
});
