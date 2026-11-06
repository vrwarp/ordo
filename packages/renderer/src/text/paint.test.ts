import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, type Rgba, type TextObject, type TextStyle, rgbaCss } from '@ordo/domain';
import { LEGACY_FONT_ENV } from './fonts.ts';
import { DECORATION_THICKNESS, STRIKE_RISE, UNDERLINE_OFFSET, paintPlan, paintRich } from './paint.ts';
import { clampTextObject, layoutRich } from './rich.ts';
import { type CtxOp, recordingCtx, testMeasurer } from './test-util.ts';
import type { RichLayout, Seg } from './types.ts';

/** design/27 §6 "Paint passes": order, effects and scale handling on a recording context. */

const rgba = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
const NAVY = rgba(10, 20, 60);
const BLACK = rgba(0, 0, 0, 0.6);
const RED = rgba(200, 0, 0);
const YELLOW = rgba(255, 255, 0);
const GLOW = rgba(255, 200, 0, 0.5);
const WHITE = rgba(255, 255, 255);

function obj(text: string, style: Partial<TextStyle> = {}, extra: Partial<TextObject> = {}): TextObject {
  return clampTextObject({
    id: 't',
    type: 'text',
    box: { x: 100, y: 50, w: 400, h: 100, rotation: 0 },
    text,
    style: {
      ...DEFAULT_LYRIC_STYLE,
      fontSizePx: 20,
      lineHeight: 1,
      padding: 0,
      outline: undefined,
      shadow: undefined,
      lang: 'en',
      ...style,
    },
    opacity: 1,
    ...extra,
  });
}

function seg(p: Partial<Seg> & Pick<Seg, 'start' | 'end' | 'x' | 'w'>): Seg {
  return { run: -1, level: 0, font: '700 20px "Inter"', sizePx: 20, shift: 0, ...p };
}

/** A hand-made one-line layout of 'ab cd' at baseline 80: 'ab ' and 'cd' (run 0 covers both), with a bullet. */
function oneLine(): RichLayout {
  return {
    lines: [
      {
        para: 0,
        top: 64,
        baseline: 80,
        height: 20,
        x: 140,
        w: 50,
        segs: [
          seg({ start: 0, end: 3, x: 140, w: 30, run: 0 }),
          seg({ start: 3, end: 5, x: 170, w: 20, run: 0 }),
        ],
        extraPerSpace: 0,
        bullet: { text: '•', x: 120, font: '400 20px "Inter"', sizePx: 20, color: WHITE },
      },
    ],
    fontScale: 1,
    spacingScale: 1,
    overflow: false,
    ink: { x: 140, y: 64, w: 50, h: 20, rotation: 0 },
  };
}

const draws = (ops: CtxOp[]) => ops.filter((o) => /^(fill|stroke)(Text|Rect)$|^fill$/.test(o.op));
const shadowless = (o: CtxOp) => o.state.shadowColor === 'rgba(0, 0, 0, 0)' || o.state.shadowBlur === 0;

describe('paintRich', () => {
  it('paints the passes in drawText’s order: box, highlight, shadow, glow, outline, fill, lines, bullets', () => {
    const o = obj(
      'ab cd',
      {
        fill: { color: NAVY, radius: 6 },
        insets: { l: 4, t: 2, r: 4, b: 2 },
        shadow: { dx: 3, dy: 4, blur: 5, color: BLACK },
        outline: { width: 2, color: RED },
        glow: { radius: 8, color: GLOW },
      },
      { runs: [{ start: 0, end: 5, highlight: YELLOW, underline: true, strike: true }] },
    );
    const ctx = recordingCtx();
    paintRich(ctx, o, oneLine(), 2, LEGACY_FONT_ENV);
    const seq = draws(ctx.ops).map((d) => {
      if (d.op === 'fill') return 'box';
      if (d.op === 'strokeText') return 'outline';
      if (d.op === 'fillRect' && d.fillStyle === rgbaCss(YELLOW)) return 'highlight';
      if (d.op === 'fillText' && d.args[0] === '•') return 'bullet';
      if (d.op === 'fillText' && d.state.shadowOffsetX === 0 && d.state.shadowBlur === 16) return 'glow';
      if (!shadowless(d)) return d.op === 'fillText' ? 'shadow' : 'shadow-line';
      return d.op === 'fillText' ? 'fill' : 'line';
    });
    expect(seq).toEqual([
      'box',
      'highlight',
      'shadow',
      'shadow',
      'shadow-line',
      'shadow-line',
      'glow',
      'glow',
      'outline',
      'outline',
      'fill',
      'fill',
      'line',
      'line',
      'bullet',
    ]);
    // Everything is drawn in logical px under the scale; canvas shadows ignore it, so they are scaled.
    for (const d of draws(ctx.ops)) expect(d.transform).toEqual([2, 0, 0, 2, 0, 0]);
    const shadow = ctx.ops.find((d) => d.op === 'fillText' && !shadowless(d) && d.state.shadowOffsetX !== 0)!;
    expect(shadow.state).toMatchObject({ shadowBlur: 10, shadowOffsetX: 6, shadowOffsetY: 8 });
    expect(shadow.fillStyle).toBe(rgbaCss(RED)); // the outline colour casts the shadow, as drawText
    const glow = ctx.ops.find((d) => d.op === 'fillText' && d.state.shadowBlur === 16)!;
    expect(glow.state.shadowColor).toBe(rgbaCss({ ...GLOW, a: 1 }));
    expect(glow.fillStyle).toBe(rgbaCss(GLOW));
    const outline = ctx.ops.find((d) => d.op === 'strokeText')!;
    expect(outline.state).toMatchObject({ lineWidth: 4, lineJoin: 'round', strokeStyle: rgbaCss(RED) });
    // The fill box is the ink grown by the insets.
    const box = ctx.ops.find((d) => d.op === 'roundRect')!;
    expect(box.args).toEqual([136, 62, 58, 24, 6]);
  });

  it('draws underline and strike F/18 thick around the baseline, unbroken across segments', () => {
    const o = obj('ab cd', {}, { runs: [{ start: 0, end: 5, underline: true, strike: true }] });
    const ctx = recordingCtx();
    paintRich(ctx, o, oneLine(), 1, LEGACY_FONT_ENV);
    const lines = ctx.ops.filter((d) => d.op === 'fillRect');
    const t = 20 * DECORATION_THICKNESS;
    expect(lines.map((d) => d.args)).toEqual([
      [140, 80 + UNDERLINE_OFFSET * 20 - t / 2, 50, t],
      [140, 80 - STRIKE_RISE * 20 - t / 2, 50, t],
    ]);
  });

  it('stops highlights and lines at the hanging whitespace of a line end', () => {
    const o = obj('ab ', {}, { runs: [{ start: 0, end: 3, underline: true, highlight: YELLOW }] });
    const l = oneLine();
    l.lines[0]!.w = 20;
    l.lines[0]!.segs = [seg({ start: 0, end: 3, x: 140, w: 30, run: 0 })];
    const ctx = recordingCtx();
    paintRich(ctx, o, l, 1, LEGACY_FONT_ENV);
    for (const d of ctx.ops.filter((x) => x.op === 'fillRect')) expect(d.args[2]).toBe(20);
  });

  it('uses the run shadow over the box shadow, and none for a run that turns it off', () => {
    const run = { dx: 1, dy: 1, blur: 2, color: RED };
    const o = obj(
      'ab cd',
      { shadow: { dx: 3, dy: 4, blur: 5, color: BLACK } },
      {
        runs: [
          { start: 0, end: 3, shadow: run },
          { start: 3, end: 5, shadow: null },
        ],
      },
    );
    const l = oneLine();
    l.lines[0]!.segs[1]!.run = 1;
    const ctx = recordingCtx();
    paintRich(ctx, o, l, 1, LEGACY_FONT_ENV);
    const shadowed = ctx.ops.filter((d) => d.op === 'fillText' && !shadowless(d));
    expect(shadowed.map((d) => [d.args[0], d.state.shadowColor, d.state.shadowBlur])).toEqual([
      ['ab ', rgbaCss(RED), 2],
    ]);
  });

  it('sets each segment’s direction, language and spacing, and draws bullets left to right', () => {
    const o = obj('ab שלום', {}, { runs: [{ start: 3, end: 7, lang: 'he', letterSpacing: 2 }] });
    const l = oneLine();
    l.lines[0]!.segs = [
      seg({ start: 0, end: 3, x: 140, w: 30 }),
      seg({ start: 3, end: 7, x: 170, w: 40, run: 0, level: 1 }),
    ];
    const ctx = recordingCtx();
    paintRich(ctx, o, l, 1, LEGACY_FONT_ENV);
    const fills = ctx.ops.filter((d) => d.op === 'fillText');
    expect(fills.map((d) => [d.args[0], d.state.direction, d.state.lang, d.state.letterSpacing])).toEqual([
      ['ab ', 'ltr', 'en', '0px'],
      ['שלום', 'rtl', 'he', '2px'],
      ['•', 'ltr', 'inherit', '0px'],
    ]);
    for (const d of fills) expect(d.state.textAlign).toBe('left');
  });

  it('lays out hidden paragraphs but never paints them, so revealed lines do not move', () => {
    const m = testMeasurer();
    const shown = obj('one\ntwo', {}, { paras: [null, null] });
    const hidden = obj('one\ntwo', {}, { paras: [{ hidden: true }, null] });
    const a = layoutRich(m, shown, LEGACY_FONT_ENV);
    const b = layoutRich(m, hidden, LEGACY_FONT_ENV);
    expect(b.lines.map((l) => [l.para, l.top, l.baseline])).toEqual(
      a.lines.map((l) => [l.para, l.top, l.baseline]),
    );
    const ctx = recordingCtx();
    paintRich(ctx, hidden, b, 1, LEGACY_FONT_ENV);
    expect(ctx.ops.filter((d) => d.op === 'fillText').map((d) => d.args[0])).toEqual(['two']);
  });

  it('draws the same logical geometry at every scale, from one cached plan', () => {
    const o = obj('Amazing grace how sweet', { shadow: { dx: 2, dy: 2, blur: 4, color: BLACK } });
    const l = layoutRich(testMeasurer(), o, LEGACY_FONT_ENV);
    const at = (scale: number) => {
      const ctx = recordingCtx();
      paintRich(ctx, o, l, scale, LEGACY_FONT_ENV);
      return ctx.ops.filter((d) => d.op === 'fillText');
    };
    const one = at(1);
    const four = at(4);
    expect(four.map((d) => d.args)).toEqual(one.map((d) => d.args));
    expect(four.map((d) => d.font)).toEqual(one.map((d) => d.font));
    expect(four[0]!.state.shadowBlur).toBe(4 * (one[0]!.state.shadowBlur as number));
    expect(paintPlan(o, l)).toBe(paintPlan(o, l));
  });

  it('assigns unchanged font and fill state once per pass, not once per segment', () => {
    const o = obj('one two three four five six seven');
    const l = layoutRich(testMeasurer(), o, LEGACY_FONT_ENV);
    const sets: string[] = [];
    const ctx = recordingCtx();
    const spy = new Proxy(ctx, {
      set(t, k, v) {
        sets.push(String(k));
        return Reflect.set(t, k, v);
      },
    });
    paintRich(spy, o, l, 1, LEGACY_FONT_ENV);
    expect(l.lines.flatMap((x) => x.segs).length).toBeGreaterThan(3);
    expect(sets.filter((k) => k === 'font')).toHaveLength(1);
    expect(sets.filter((k) => k === 'fillStyle')).toHaveLength(1);
  });

  it('rotates about the box centre and applies the object opacity', () => {
    const o = obj('x', {}, { box: { x: 0, y: 0, w: 200, h: 100, rotation: 90 }, opacity: 0.5 });
    const l = layoutRich(testMeasurer(), o, LEGACY_FONT_ENV);
    const ctx = recordingCtx();
    paintRich(ctx, o, l, 2, LEGACY_FONT_ENV);
    const f = ctx.ops.find((d) => d.op === 'fillText')!;
    expect(f.state.globalAlpha).toBe(0.5);
    const [a, b, c, d, e, g] = f.transform;
    expect([a, b, c, d].map((v) => Math.round(v! * 1e9) / 1e9)).toEqual([0, 2, -2, 0]);
    expect([e, g].map((v) => Math.round(v!))).toEqual([300, -100]); // about (100, 50) logical, × 2
  });
});
