import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, type TextObject } from '@ordo/domain';
import { traceCtx, traceDigest } from '../trace.test-util.ts';
import { LEGACY_FONT_ENV } from './fonts.ts';
import {
  type GlyphPainter,
  type GlyphPass,
  PLAIN_PAINTER,
  type PlannedGlyphs,
  type PlannedRect,
  type RectPass,
  paintRich,
} from './paint.ts';
import { clampTextObject, layoutRich } from './rich.ts';
import { testMeasurer } from './test-util.ts';

/*
 * The gates of text-lines (sub-wave 1b, design/27 §6): LibreOffice's line breaks and own-run line heights
 * apply to office-model text only (`TextStyle.lineModel` 'office'), and device-pixel placement to table-cell
 * text only (the table drawer asks for it, `PaintHooks.devicePixels`). Ordo's own text (songs, scripture,
 * slides made in ordo: no `lineModel`, or 'ordo') and every caller that does not ask paint exactly as at the
 * base (r2b-sw1m, m9/r2b 2fb4499). If a gate leaks, these fail:
 * - the plain painter puts every call where the base's plain painter puts it, for any plan, pass and
 *   transform (a property: a floor in `PLAIN_PAINTER` itself fails it);
 * - `paintRich` without the cell option paints an ordo-model object call for call as the base's painter does
 *   (a property over random objects and scales);
 * - ordo-model text over a fixed set of objects (verse ranges, quotes before brackets, web addresses,
 *   mixed run sizes, underlines, at several widths and scales) paints the calls recorded at the base
 *   (digests pinned on the base commit, as paint.hooks.test.ts pins its own).
 */

type TextRun = NonNullable<TextObject['runs']>[number];

/** The plain painter of the base, copied as it was: the reference the gate is held to. */
const BASE_PLAIN: GlyphPainter = {
  kind: 'plain',
  glyphs(ctx, g, pass) {
    if (pass === 'outline') ctx.strokeText(g.text, g.x, g.y);
    else ctx.fillText(g.text, g.x, g.y);
  },
  rect(ctx, r) {
    ctx.fillRect(r.x, r.y, r.w, r.h);
  },
};

const coord = fc.double({ min: -2000, max: 4000, noNaN: true, noDefaultInfinity: true });
const scale = fc.double({ min: 0.05, max: 8, noNaN: true, noDefaultInfinity: true });
/** A transform: axis-aligned (where device-pixel placement would apply) or turned, flipped, skewed. */
const transform = fc.oneof(
  fc.record({ a: scale, b: fc.constant(0), c: fc.constant(0), d: scale, e: coord, f: coord }),
  fc.record({
    a: fc.double({ min: -8, max: 8, noNaN: true }),
    b: fc.double({ min: -8, max: 8, noNaN: true }),
    c: fc.double({ min: -8, max: 8, noNaN: true }),
    d: fc.double({ min: -8, max: 8, noNaN: true }),
    e: coord,
    f: coord,
  }),
);
const glyphs: fc.Arbitrary<PlannedGlyphs> = fc.record({
  line: fc.nat(40),
  text: fc.string({ minLength: 1, maxLength: 12 }),
  x: coord,
  y: coord,
  font: fc.constant('400 20px "Golden"'),
  dir: fc.constantFrom('ltr' as const, 'rtl' as const),
  lang: fc.constant('en'),
  spacing: fc.constant(0),
  fill: fc.constant('#fff'),
  cast: fc.constant('#000'),
  shadow: fc.constant(null),
  shadowColor: fc.constant('#000'),
  outline: fc.constant(null),
});
const rect: fc.Arbitrary<PlannedRect> = fc.record({
  line: fc.nat(40),
  x: coord,
  y: coord,
  w: fc.double({ min: 0, max: 500, noNaN: true }),
  h: fc.double({ min: 0, max: 40, noNaN: true }),
  color: fc.constant('#fff'),
  shadow: fc.constant(null),
  shadowColor: fc.constant('#000'),
});
const glyphPass = fc.constantFrom<GlyphPass>('shadow', 'glow', 'outline', 'fill', 'bullet');
const rectPass = fc.constantFrom<RectPass>('lineMask', 'highlight', 'shadow', 'decoration');

/** The trace of one painter call under a transform. */
function painted(
  painter: GlyphPainter,
  m: { a: number; b: number; c: number; d: number; e: number; f: number },
  call: (ctx: CanvasRenderingContext2D, p: GlyphPainter) => void,
): string {
  const ctx = traceCtx();
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  call(ctx, painter);
  return traceDigest(ctx.trace);
}

/** An ordo-model text object (no `lineModel`: songs, scripture, slides made in ordo). */
function ordo(text: string, w: number, runs: TextRun[] = []): TextObject {
  return clampTextObject({
    id: 't',
    type: 'text',
    box: { x: 37.3, y: 21.7, w, h: 600, rotation: 0 },
    text,
    style: {
      ...DEFAULT_LYRIC_STYLE,
      fontFamily: 'Golden',
      fontSizePx: 20,
      lineHeight: 1.2,
      padding: 0,
      align: 'left',
      valign: 'top',
      outline: undefined,
      shadow: undefined,
      lang: 'en',
    },
    opacity: 1,
    ...(runs.length ? { runs } : {}),
  });
}

describe('the plain painter and ordo text paint as at the base (text-lines gates)', () => {
  it('the plain painter puts every glyph run and rectangle where the base put it, under any transform', () => {
    fc.assert(
      fc.property(transform, glyphs, glyphPass, (m, g, pass) => {
        const call = (ctx: CanvasRenderingContext2D, p: GlyphPainter) => p.glyphs(ctx, g, pass);
        expect(painted(PLAIN_PAINTER, m, call)).toBe(painted(BASE_PLAIN, m, call));
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(transform, rect, rectPass, (m, r, pass) => {
        const call = (ctx: CanvasRenderingContext2D, p: GlyphPainter) => p.rect(ctx, r, pass);
        expect(painted(PLAIN_PAINTER, m, call)).toBe(painted(BASE_PLAIN, m, call));
      }),
      { numRuns: 300 },
    );
  });

  it('paintRich without the cell option paints ordo text call for call as the base painter', () => {
    const word = fc.constantFrom(
      'John',
      '3:16-17',
      '24:21-22',
      'x -5',
      '“every',
      'month”',
      '[offerings]',
      '(Num.',
      'and/or',
      'https://books.google.as/books?id=x',
      'Amazing',
      'grace',
    );
    const object = fc
      .record({
        words: fc.array(word, { minLength: 1, maxLength: 12 }),
        w: fc.double({ min: 40, max: 600, noNaN: true }),
        small: fc.boolean(),
        underline: fc.boolean(),
      })
      .map(({ words, w, small, underline }) => {
        const text = words.join(' ');
        const runs: TextRun[] = [];
        if (small) runs.push({ start: Math.floor(text.length / 2), end: text.length, sizeScale: 0.5 });
        if (underline) runs.push({ start: 0, end: Math.min(text.length, 4), underline: true, strike: true });
        runs.sort((a, b) => a.start - b.start);
        return ordo(text, w, runs[0] && runs[1] && runs[0].end > runs[1].start ? [runs[0]] : runs);
      });
    fc.assert(
      fc.property(object, fc.double({ min: 0.25, max: 4, noNaN: true }), (o, s) => {
        const l = layoutRich(testMeasurer(), o, LEGACY_FONT_ENV);
        const head = traceCtx();
        paintRich(head, o, l, s, LEGACY_FONT_ENV);
        const unasked = traceCtx();
        paintRich(unasked, o, l, s, LEGACY_FONT_ENV, { devicePixels: false });
        const base = traceCtx();
        paintRich(base, o, l, s, LEGACY_FONT_ENV, { painter: BASE_PLAIN });
        expect(traceDigest(head.trace)).toBe(traceDigest(base.trace));
        expect(traceDigest(unasked.trace)).toBe(traceDigest(base.trace));
      }),
      { numRuns: 150 },
    );
  });

  // The fixtures: every office rule's text, as ordo text, at widths that force each break, with a smaller
  // run that wraps onto lines of its own and underlined runs, at four scales (fractional positions).
  const TEXTS = [
    'Read John 3:16-17 today and Isa. 2:6-10, 24:21-22 and Rev. 20:1-3',
    'the “every month” [offerings] given, water out of this rock?” (Num. 20:10) and he said “ (aside)',
    'see https://books.google.as/books?id=wRY&pg=RA19-PA24 and this and/or that, a/b test, 1/2 cup',
    'http://www.bible-sabbath.com/Sabbath-Sunday/CanPersecutionAriseInAmerica.pdf value x -5 (-6)',
  ];
  const WIDTHS = [90, 150, 260];
  const SCALES = [0.5, 1, 1.5, 2];
  const fixtures = (): Record<string, TextObject> => {
    const out: Record<string, TextObject> = {};
    TEXTS.forEach((text, t) => {
      for (const w of WIDTHS) {
        out[`text${t}@${w}`] = ordo(text, w);
        const half = Math.floor(text.length / 3);
        out[`text${t}@${w} mixed`] = ordo(text, w, [
          { start: 0, end: 5, underline: true, strike: true },
          { start: half, end: text.length, sizeScale: 0.5 },
        ]);
      }
    });
    return out;
  };

  /** Digests of each fixture painted at each scale, recorded on the base commit (m9/r2b 2fb4499). */
  const BASE: Record<string, string> = {
    'text0@150 mixed@x0.5': '5526bcbe3ea30419',
    'text0@150 mixed@x1': '4471eccbb4a0038e',
    'text0@150 mixed@x1.5': 'f6069540f56158ee',
    'text0@150 mixed@x2': 'd191d9c1610a78b3',
    'text0@150@x0.5': 'daa7ab6bec9feb3b',
    'text0@150@x1': '8c06b4d53ff20c2b',
    'text0@150@x1.5': '80e04c843117d529',
    'text0@150@x2': '830db878f3a6bc4b',
    'text0@260 mixed@x0.5': '2e1fd0c4af997e9e',
    'text0@260 mixed@x1': '4eb35ca8ba06affa',
    'text0@260 mixed@x1.5': '42dc18751614913f',
    'text0@260 mixed@x2': 'cb09dde5644c7cdf',
    'text0@260@x0.5': '45ad3b8a76b78211',
    'text0@260@x1': '28ebe3ff82e764dd',
    'text0@260@x1.5': 'fe65669f4b7d224d',
    'text0@260@x2': 'e5590d9592c32296',
    'text0@90 mixed@x0.5': '7adfc6fd49bbb75e',
    'text0@90 mixed@x1': '35fcd04703f2a840',
    'text0@90 mixed@x1.5': '78ad845ea8069d26',
    'text0@90 mixed@x2': '8ec5dd6382738a5c',
    'text0@90@x0.5': 'e783345668458ed0',
    'text0@90@x1': '36b30cf65dd2c6e1',
    'text0@90@x1.5': '952598eb5482c4b8',
    'text0@90@x2': '31a1dac93bd465ed',
    'text1@150 mixed@x0.5': '3f8a83793ac64156',
    'text1@150 mixed@x1': 'f6e61db3b3339137',
    'text1@150 mixed@x1.5': '288516761040a283',
    'text1@150 mixed@x2': '1d37aff43ad93f53',
    'text1@150@x0.5': '70c37a58eb4730d3',
    'text1@150@x1': '16d69f00e77f7d0f',
    'text1@150@x1.5': '7e67bfaafaf27ae1',
    'text1@150@x2': 'b7229b279bb19be6',
    'text1@260 mixed@x0.5': '969714346b2f30fc',
    'text1@260 mixed@x1': 'bac07ffe65f43667',
    'text1@260 mixed@x1.5': '4b05b2485eab4273',
    'text1@260 mixed@x2': 'd7cc3ddffad97d87',
    'text1@260@x0.5': 'fe13ea65399d74ce',
    'text1@260@x1': '500ea1f1f4e75510',
    'text1@260@x1.5': '6d1003feaaa49c5a',
    'text1@260@x2': 'fe438fe837b67bc5',
    'text1@90 mixed@x0.5': '62a3fb085048a6ad',
    'text1@90 mixed@x1': '1cb5e0f9784890ca',
    'text1@90 mixed@x1.5': '2c34c1b854e616f8',
    'text1@90 mixed@x2': 'fb77fdffdfc6b7d5',
    'text1@90@x0.5': '6da30d3b98acb800',
    'text1@90@x1': '4688a6300f23ea9c',
    'text1@90@x1.5': 'f37eef9b0f784011',
    'text1@90@x2': '7cba75218c0969aa',
    'text2@150 mixed@x0.5': '36bf7a71589a0136',
    'text2@150 mixed@x1': '0886e916c0e4a4e2',
    'text2@150 mixed@x1.5': 'a43c3be6c31c0a1c',
    'text2@150 mixed@x2': '0a21719ef8c2c821',
    'text2@150@x0.5': 'cdc5adc7f6be1176',
    'text2@150@x1': '802aa8be84b10f7e',
    'text2@150@x1.5': '232a2598427e1ffa',
    'text2@150@x2': 'cbaf2cb798769a31',
    'text2@260 mixed@x0.5': '72111d499459ec91',
    'text2@260 mixed@x1': 'd06c4c447fac53c0',
    'text2@260 mixed@x1.5': 'bf7bb16764c207ee',
    'text2@260 mixed@x2': '6676762544365d2d',
    'text2@260@x0.5': '961f9c6edb0c62c0',
    'text2@260@x1': '2dc986bd184f10fa',
    'text2@260@x1.5': 'ba846a783324f8ee',
    'text2@260@x2': 'a7314af8fda7cf25',
    'text2@90 mixed@x0.5': 'c76be4d21330d02e',
    'text2@90 mixed@x1': '87e556593d5f6765',
    'text2@90 mixed@x1.5': '89fb7368999142fd',
    'text2@90 mixed@x2': 'edd68245a408fd8b',
    'text2@90@x0.5': '8463fb467c88cd0f',
    'text2@90@x1': '840163f11add8b98',
    'text2@90@x1.5': '07f59e307d6a9418',
    'text2@90@x2': 'fc3027692784f6bd',
    'text3@150 mixed@x0.5': 'f842422925c49b3c',
    'text3@150 mixed@x1': '09cb05cd5be72153',
    'text3@150 mixed@x1.5': '0b4e6c78dbfe6798',
    'text3@150 mixed@x2': '100872d2f9eaf4e0',
    'text3@150@x0.5': '34195e806e56e508',
    'text3@150@x1': 'f1cacff763bc5cce',
    'text3@150@x1.5': 'e3b371efcf17db01',
    'text3@150@x2': '9452a16c95317480',
    'text3@260 mixed@x0.5': 'a1e52bef88278f54',
    'text3@260 mixed@x1': '74af2a4b97617f53',
    'text3@260 mixed@x1.5': 'ac090020df213d1c',
    'text3@260 mixed@x2': '0d42bcd792d681d4',
    'text3@260@x0.5': '724c0087fe58b8ad',
    'text3@260@x1': '903a9102f7c8331b',
    'text3@260@x1.5': 'a1b702f57764f4d8',
    'text3@260@x2': 'c459b9502ae69bc4',
    'text3@90 mixed@x0.5': 'b350e74f69802ffc',
    'text3@90 mixed@x1': '79c24fa1408b637c',
    'text3@90 mixed@x1.5': '61b9ae6013313671',
    'text3@90 mixed@x2': 'd13be5c7e72571d9',
    'text3@90@x0.5': 'fd271e6b310004b6',
    'text3@90@x1': 'ff0df371ffad8a3a',
    'text3@90@x1.5': 'ee990de5cd39e0ee',
    'text3@90@x2': 'ead7f2c292cbfb8c',
  };

  it('paints the ordo-text fixtures exactly as the base did', () => {
    const got: Record<string, string> = {};
    for (const [name, o] of Object.entries(fixtures()))
      for (const s of SCALES) {
        const ctx = traceCtx();
        paintRich(ctx, o, layoutRich(testMeasurer(), o, LEGACY_FONT_ENV), s, LEGACY_FONT_ENV);
        got[`${name}@x${s}`] = traceDigest(ctx.trace);
      }
    expect(got).toEqual(BASE);
  });
});
