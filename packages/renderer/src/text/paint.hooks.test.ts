import { DEFAULT_LYRIC_STYLE, type Rgba, type TextObject, type TextStyle } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { traceCtx, traceDigest } from '../trace.test-util.ts';
import { LEGACY_FONT_ENV } from './fonts.ts';
import {
  DIRECT_TARGET,
  type FaceTarget,
  faceTargetFor,
  type GlyphPainter,
  type GlyphPass,
  glyphPainterFor,
  PLAIN_PAINTER,
  paintPlan,
  paintRich,
  registerFaceTarget,
  registerGlyphPainter,
} from './paint.ts';
import { clampTextObject, drawRichText, layoutRich } from './rich.ts';
import { testMeasurer } from './test-util.ts';

/*
 * The paint seams of M9 (design/27 M9 render-seams; plan decision 6): `paintRich` draws through a glyph
 * painter (plain, upright, warp) and a face target (direct, sprite). With nothing registered it is the plain
 * painter on the direct target, and it must draw exactly what `paintRich` drew before the seam: every case
 * below logs every call and assignment on a context (trace.test-util.ts) and pins the log's digest, recorded
 * on the code before the seam.
 */

const rgba = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
const RED = rgba(200, 0, 0);
const NAVY = rgba(10, 20, 60);
const GOLD = rgba(255, 200, 0, 0.5);
const SHADOW = { dx: 3, dy: 4, blur: 5, color: rgba(0, 0, 0, 0.6) };

function obj(text: string, style: Partial<TextStyle> = {}, extra: Partial<TextObject> = {}): TextObject {
  return clampTextObject({
    id: 't',
    type: 'text',
    box: { x: 100, y: 80, w: 900, h: 500, rotation: 0 },
    text,
    style: {
      ...DEFAULT_LYRIC_STYLE,
      fontFamily: 'Golden',
      fontSizePx: 48,
      outline: undefined,
      shadow: undefined,
      lang: 'en',
      ...style,
    },
    opacity: 1,
    ...extra,
  });
}

/** Every effect pass at once: fill box, highlight, shadows, glow, outline, decorations and bullets. */
const EVERYTHING = obj(
  'Amazing grace, how sweet the sound\nThat saved a wretch like me',
  {
    fill: { color: NAVY, radius: 12 },
    insets: { l: 8, t: 4, r: 8, b: 4 },
    shadow: SHADOW,
    outline: { width: 2, color: RED },
    glow: { radius: 10, color: GOLD },
  },
  {
    runs: [
      { start: 0, end: 7, highlight: rgba(255, 255, 0), underline: true },
      { start: 8, end: 14, strike: true, shadow: null, color: rgba(0, 200, 0) },
      { start: 35, end: 40, caps: 'all', outline: null },
    ],
    paras: [{ bullet: { char: '•' } }, { bullet: { char: '–' }, level: 1 }],
  },
);

/** The box's gradient paint (M6) over runs without their own colour, turned and translucent. */
const GRADIENT = obj(
  'He is risen indeed',
  {
    paint: {
      kind: 'linear',
      angle: 30,
      stops: [
        { at: 0, color: RED },
        { at: 0.5, color: GOLD },
        { at: 1, color: NAVY },
      ],
    },
    shadow: SHADOW,
  },
  {
    box: { x: 300, y: 200, w: 800, h: 300, rotation: 12 },
    opacity: 0.7,
    runs: [{ start: 6, end: 12, color: rgba(255, 255, 255) }],
  },
);

/** Right-to-left text with a language and letter spacing, and a hidden paragraph (the M8 split reveal). */
const BIDI = obj(
  'שלום עולם\nhidden line\nAnd peace on earth',
  {},
  {
    runs: [{ start: 0, end: 9, lang: 'he', letterSpacing: 3 }],
    paras: [null, { hidden: true }, null],
  },
);

const CASES: Record<string, TextObject> = { everything: EVERYTHING, gradient: GRADIENT, bidi: BIDI };

/** The digests of each case's log on the code before the seam (scale 0.5, 1, 2), recorded then. */
const BEFORE: Record<string, string> = {
  'bidi@0.5': '9464eb4d5c3de153',
  'bidi@0.5 drawRichText': '704686b41cbac47b',
  'bidi@1': 'd420f510a1932095',
  'bidi@1 drawRichText': '03179f47f9db5e20',
  'bidi@2': '10b349ad99315367',
  'bidi@2 drawRichText': '9253c3550e6680df',
  'everything@0.5': '899c8cba96603c65',
  'everything@0.5 drawRichText': 'e147d35fefca8f35',
  'everything@1': '61dbbb43f22ac39e',
  'everything@1 drawRichText': '508e28d548ad44b9',
  'everything@2': 'dd36c2ca4914b5d2',
  'everything@2 drawRichText': '55871a3f6ca894b5',
  'gradient@0.5': 'af4ea340474f2fea',
  'gradient@0.5 drawRichText': '51967ba7dfa7eb8c',
  'gradient@1': '6395ae8bc20c8c00',
  'gradient@1 drawRichText': 'a1f224f2ccf39e17',
  'gradient@2': '001b8e9706e2f0b0',
  'gradient@2 drawRichText': '07bf79bbb0637ba2',
};

function painted(o: TextObject, scale: number): string {
  const ctx = traceCtx();
  const l = layoutRich(testMeasurer(), o, LEGACY_FONT_ENV);
  paintRich(ctx, o, l, scale, LEGACY_FONT_ENV);
  return traceDigest(ctx.trace);
}

function drawn(o: TextObject, scale: number): string {
  const ctx = traceCtx();
  drawRichText(ctx, o, scale, LEGACY_FONT_ENV);
  return traceDigest(ctx.trace);
}

describe('paint hooks (M9 render-seams)', () => {
  it('the plain painter draws today’s pixels', () => {
    const got: Record<string, string> = {};
    for (const [name, o] of Object.entries(CASES))
      for (const scale of [0.5, 1, 2]) {
        got[`${name}@${scale}`] = painted(o, scale);
        got[`${name}@${scale} drawRichText`] = drawn(o, scale);
      }
    expect(got).toEqual(BEFORE);
  });

  it('routes every glyph and rectangle pass through the painter an object gets', () => {
    const passes: string[] = [];
    const recorder = (kind: 'upright' | 'warp'): GlyphPainter => ({
      kind,
      glyphs(ctx, g, pass) {
        passes.push(`${kind} ${pass} ${g.text} line ${g.line}`);
        PLAIN_PAINTER.glyphs(ctx, g, pass);
      },
      rect(ctx, r, pass) {
        passes.push(`${kind} rect ${pass} line ${r.line}`);
        PLAIN_PAINTER.rect(ctx, r, pass);
      },
    });
    const warped = { ...EVERYTHING, warp: { preset: 'textArchUp' as const } };
    const upright = { ...EVERYTHING, writing: { upright: 'cjk' as const } };
    const both = { ...warped, writing: { upright: 'cjk' as const } };
    const offWarp = registerGlyphPainter('warp', (o) => !!o.warp, recorder('warp'));
    const offUpright = registerGlyphPainter('upright', (o) => !!o.writing, recorder('upright'));
    try {
      expect(glyphPainterFor(EVERYTHING)).toBe(PLAIN_PAINTER);
      expect(glyphPainterFor(upright).kind).toBe('upright');
      // A warp wins over vertical writing.
      expect(glyphPainterFor(both).kind).toBe('warp');
      // The painter draws what the plain one would, call for call.
      const ctx = traceCtx();
      const l = layoutRich(testMeasurer(), warped, LEGACY_FONT_ENV);
      paintRich(ctx, warped, l, 1, LEGACY_FONT_ENV);
      const plain = traceCtx();
      paintRich(plain, warped, l, 1, LEGACY_FONT_ENV, { painter: PLAIN_PAINTER });
      expect(traceDigest(ctx.trace)).toBe(traceDigest(plain.trace));
      const plan = paintPlan(warped, l);
      const kinds = new Set(passes.map((p) => p.split(' ').slice(0, 2).join(' ')));
      expect([...kinds].sort()).toEqual(
        ['warp shadow', 'warp glow', 'warp outline', 'warp fill', 'warp bullet', 'warp rect'].sort(),
      );
      // Every planned run in each of its passes, each with the layout line it is on.
      const runs = plan.glyphs.length + plan.bullets.length;
      const count = (pass: GlyphPass) => passes.filter((p) => p.startsWith(`warp ${pass} `)).length;
      expect(count('glow')).toBe(runs);
      expect(count('fill')).toBe(plan.glyphs.length);
      expect(count('bullet')).toBe(plan.bullets.length);
      expect(plan.glyphs.every((g) => g.seg !== undefined && l.lines[g.line]!.segs[g.seg!])).toBe(true);
    } finally {
      offWarp();
      offUpright();
    }
    expect(glyphPainterFor(warped)).toBe(PLAIN_PAINTER);
  });

  it('lets a painter lay the text out its own way (its plan)', () => {
    const l = layoutRich(testMeasurer(), GRADIENT, LEGACY_FONT_ENV);
    const own = paintPlan(BIDI, layoutRich(testMeasurer(), BIDI, LEGACY_FONT_ENV));
    const texts: string[] = [];
    const painter: GlyphPainter = {
      kind: 'warp',
      plan: () => own,
      glyphs: (_c, g, pass) => {
        if (pass === 'fill') texts.push(g.text);
      },
      rect: () => {},
    };
    paintRich(traceCtx(), GRADIENT, l, 1, LEGACY_FONT_ENV, { painter });
    expect(texts).toEqual(own.glyphs.map((g) => g.text));
  });

  it('draws the face passes on the face target, the effects where the target says', () => {
    expect(faceTargetFor(EVERYTHING)).toBe(DIRECT_TARGET);
    const face = traceCtx(400, 200);
    const order: string[] = [];
    const sprite: FaceTarget = {
      kind: 'sprite',
      draw(ctx, _o, _plan, passes) {
        order.push('face');
        passes.face(face);
        order.push('effects');
        passes.effects(ctx);
        ctx.drawImage(face.canvas as never, 0, 0);
      },
    };
    const off = registerFaceTarget((o) => !!o.look3d, sprite);
    try {
      const lit = { ...EVERYTHING, look3d: { bevel: { prst: 'circle' as const, w: 4, h: 4 } } };
      expect(faceTargetFor(lit)).toBe(sprite);
      expect(faceTargetFor(EVERYTHING)).toBe(DIRECT_TARGET);
      const ctx = traceCtx();
      paintRich(ctx, lit, layoutRich(testMeasurer(), lit, LEGACY_FONT_ENV), 2, LEGACY_FONT_ENV);
      expect(order).toEqual(['face', 'effects']);
      const calls = (c: typeof ctx, name: string) => c.trace.filter((e) => e[0] === 'call' && e[1] === name);
      // The face (outline, fill, lines, bullets) on the target's context, set up as text is drawn.
      expect(calls(face, 'strokeText').length).toBeGreaterThan(0);
      expect(calls(face, 'fillText').length).toBeGreaterThan(0);
      expect(face.trace).toContainEqual(['set', 'textBaseline', 'alphabetic']);
      expect(face.trace.some((e) => e[1] === 'shadowBlur')).toBe(false);
      // The shadows and glow on the slide's context; the box and highlight there too, before them.
      expect(calls(ctx, 'strokeText')).toEqual([]);
      expect(ctx.trace.some((e) => e[0] === 'set' && e[1] === 'shadowBlur' && e[2] === 10)).toBe(true);
      expect(calls(ctx, 'drawImage')).toHaveLength(1);
    } finally {
      off();
    }
    expect(faceTargetFor({ ...EVERYTHING, look3d: {} })).toBe(DIRECT_TARGET);
  });
});
