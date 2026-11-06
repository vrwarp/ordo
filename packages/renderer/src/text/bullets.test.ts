import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LYRIC_STYLE,
  LOOK_LOWER_THIRD,
  LOOK_STAGE,
  readableText,
  type TextObject,
  type TextStyle,
} from '@ordo/domain';
import { lyricTextFor } from '../text2d.ts';
import { paraBullets } from './bullets.ts';
import { LEGACY_FONT_ENV } from './fonts.ts';
import { itemize } from './itemize.ts';
import { clampTextObject, drawRichText, layoutRich } from './rich.ts';
import { recordingCtx, testMeasurer } from './test-util.ts';

const red = { r: 255, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 255, a: 1 };

/** A rich text object at 20 px in a 400x300 box at the origin, through the clamp as drawers see it. */
function obj(text: string, extra: Partial<TextObject> = {}, style: Partial<TextStyle> = {}): TextObject {
  return clampTextObject({
    id: 't',
    type: 'text',
    box: { x: 0, y: 0, w: 400, h: 300, rotation: 0 },
    text,
    style: {
      ...DEFAULT_LYRIC_STYLE,
      padding: 0,
      fontSizePx: 20,
      fontWeight: 400,
      lineHeight: 1,
      align: 'left',
      ...style,
    },
    opacity: 1,
    ...extra,
  });
}

const verse = (startAt: number) => ({ bullet: { auto: 'arabicParenBoth', startAt } });

describe('paraBullets', () => {
  it('numbers verses from startAt, skipping empty and soft paragraphs', () => {
    const o = obj('For God\n\nso loved\nthe world', {
      paras: [verse(16), verse(16), verse(16), { soft: true }],
    });
    const b = paraBullets(o, itemize(o));
    expect(b.map((x) => x?.text ?? null)).toEqual(['(16)', null, '(17)', null]);
  });

  it("uses the bullet's own font, colour and size, else the first run's", () => {
    const o = obj(
      'one\ntwo\nthree',
      {
        runs: [
          { start: 0, end: 3, fontFamily: 'Georgia', color: red, fontWeight: 700, fontStyle: 'italic' },
          { start: 4, end: 7, color: blue },
        ],
        paras: [
          { bullet: { char: '•' } },
          { bullet: { char: '–', fontFamily: 'Arial', color: red, sizePct: 0.5 } },
          // Mapped at import or not, a symbol-font bullet is drawn in the text's font.
          { bullet: { char: '\u{a7}', fontFamily: 'Wingdings' } },
        ],
      },
      { color: { r: 1, g: 2, b: 3, a: 1 } },
    );
    const [a, b, c] = paraBullets(o, itemize(o));
    expect(a).toEqual({
      text: '•',
      family: 'Georgia',
      fallbacks: [],
      weight: 700,
      italic: true,
      sizePct: 1,
      color: red,
    });
    expect(b).toMatchObject({
      text: '–',
      family: 'Arial',
      color: red,
      sizePct: 0.5,
      weight: 400,
      italic: false,
    });
    expect(c).toMatchObject({ text: '\u{25aa}', family: 'Inter', color: { r: 1, g: 2, b: 3, a: 1 } });
  });
});

describe('bullets in the layout', () => {
  it('sit on the first line of their paragraph at sizePct × the main size, in their font', () => {
    const o = obj(`${'aaaa '.repeat(12)}\nb`, {
      paras: [
        {
          indentPx: 40,
          firstLinePx: -40,
          bullet: { auto: 'arabicPeriod', sizePct: 0.5, fontFamily: 'Arial' },
        },
        { bullet: { auto: 'arabicPeriod' } },
      ],
    });
    const l = layoutRich(testMeasurer({ em: 0.5 }), o, LEGACY_FONT_ENV);
    const withBullet = l.lines.filter((line) => line.bullet);
    expect(withBullet.map((line) => [line.para, line.bullet!.text])).toEqual([
      [0, '1.'],
      [1, '2.'],
    ]);
    expect(l.lines.filter((line) => line.para === 0).length).toBeGreaterThan(1);
    const first = withBullet[0]!.bullet!;
    expect(first.sizePx).toBe(10);
    expect(first.font).toContain('"Arial"');
    expect(first.font).toContain(' 10px ');
  });

  it('draws what readableText writes', () => {
    const o = obj('For God so loved the world\nthat he gave\n\nFor God did not send', {
      paras: [verse(16), { soft: true }, verse(16), verse(16)],
    });
    const ctx = recordingCtx(0.5);
    const l = drawRichText(ctx, o, 1, LEGACY_FONT_ENV);
    const drawn = ctx.ops.filter((op) => op.op === 'fillText').map((op) => op.args[0]);
    expect(drawn).toContain('(16)');
    expect(drawn).toContain('(17)');
    const lines = readableText(o).split('\n');
    for (const line of l.lines)
      if (line.bullet) expect(lines[line.para]!.startsWith(line.bullet.text)).toBe(true);
    expect(l.lines.filter((line) => line.bullet)).toHaveLength(2);
  });
});

describe('bands', () => {
  it('lyric-only and next-slide bands read the numbers as text', () => {
    const o = obj('For God so loved the world\nFor God did not send', { paras: [verse(16), verse(16)] });
    const slide = { id: 's', objects: [o], lyricObjectId: o.id };
    const want = '(16)\u{a0}For God so loved the world\n(17)\u{a0}For God did not send';
    expect(lyricTextFor(slide, LOOK_LOWER_THIRD, true)).toBe(want);
    expect(lyricTextFor(slide, LOOK_STAGE, true)).toBe(want);
  });
});
