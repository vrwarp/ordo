import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LYRIC_STYLE,
  LOOK_LOWER_THIRD,
  LOOK_STREAM,
  type Look,
  type Slide,
  type TextObject,
} from '@ordo/domain';
import { rasterLowerThird } from './raster.ts';
import { bandObject } from './text/rich.ts';
import {
  bandSource,
  drawObject,
  drawSlide2D,
  drawText,
  layoutText,
  paragraphDirections,
  wrapLines,
} from './text2d.ts';
import { recordingCtx } from './text/test-util.ts';

function fakeCtx() {
  // Every glyph is 10px wide at any font; enough to test wrapping and alignment maths.
  return {
    font: '',
    letterSpacing: '0px',
    measureText: (s: string) => ({ width: s.length * 10 }) as TextMetrics,
  } as unknown as CanvasRenderingContext2D;
}

describe('text layout', () => {
  it('wraps words greedily and breaks long words', () => {
    const ctx = fakeCtx();
    expect(wrapLines(ctx, 'aaa bbb ccc', 75)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapLines(ctx, 'abcdefghij', 40)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapLines(ctx, 'one\n\ntwo', 100)).toEqual(['one', '', 'two']);
  });

  it('centres a block and shrinks to fit when asked', () => {
    const ctx = fakeCtx();
    const style = { ...DEFAULT_LYRIC_STYLE, padding: 0, fontSizePx: 100, lineHeight: 1 };
    const box = { x: 0, y: 0, w: 200, h: 100, rotation: 0 };
    const l = layoutText(ctx, 'ab', style, box, 1);
    expect(l.lines[0]).toMatchObject({ x: 90, y: 0, width: 20 });
    const fitted = layoutText(ctx, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', style, box, 1, true);
    expect(fitted.fontSize).toBeLessThan(100);
    expect(fitted.fontSize).toBeGreaterThanOrEqual(50);
  });
});

describe('text object dispatch (design/27 §6)', () => {
  const legacy: TextObject = {
    id: 't',
    type: 'text',
    box: { x: 100, y: 100, w: 800, h: 300, rotation: 0 },
    text: 'Amazing grace',
    style: { ...DEFAULT_LYRIC_STYLE, fontSizePx: 60 },
    opacity: 1,
  };

  it('draws a legacy object through drawText at device size', () => {
    const ctx = recordingCtx();
    drawObject(ctx, legacy, 0.5);
    const fills = ctx.ops.filter((o) => o.op === 'fillText');
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) {
      expect(f.font).toContain(' 30px "Inter"');
      expect(f.transform).toEqual([1, 0, 0, 1, 0, 0]);
    }
  });

  it('draws an object with a rich field through the rich engine, in logical px under the scale', () => {
    const ctx = recordingCtx();
    drawObject(ctx, { ...legacy, runs: [{ start: 0, end: 7, fontWeight: 400 }] }, 0.5);
    const fills = ctx.ops.filter((o) => o.op === 'fillText');
    expect(fills.map((f) => f.args[0])).toContain('Amazing');
    for (const f of fills) {
      expect(f.font).toContain(' 60px "Inter"');
      expect(f.transform).toEqual([0.5, 0, 0, 0.5, 0, 0]);
    }
  });
});

describe('legacy direction rule (design/27 §6)', () => {
  const style = { ...DEFAULT_LYRIC_STYLE, fontSizePx: 40 };
  const box = { x: 0, y: 0, w: 1600, h: 600, rotation: 0 };
  const assigned = (draw: (ctx: CanvasRenderingContext2D) => void) => {
    const keys: string[] = [];
    const ctx = recordingCtx();
    draw(
      new Proxy(ctx, {
        set(t, k, v) {
          keys.push(String(k));
          return Reflect.set(t, k, v);
        },
      }),
    );
    return { ctx, keys };
  };

  it('never touches direction or alignment for left-to-right text', () => {
    expect(paragraphDirections('Amazing grace\nhow sweet')).toBeNull();
    const { keys } = assigned((ctx) => drawText(ctx, 'Amazing grace\nhow sweet the sound', style, box, 1));
    expect(keys).not.toContain('direction');
    expect(keys).not.toContain('textAlign');
  });

  it('draws a paragraph with a strong right-to-left character in its first strong direction', () => {
    const text = 'Amazing grace\nשָׁלוֹם עֲלֵיכֶם\nPsalm 23 מזמור';
    expect(paragraphDirections(text)).toEqual([null, 'rtl', 'ltr']);
    const { ctx } = assigned((c) => drawText(c, text, style, box, 1));
    const drawn = ctx.ops.filter((o) => o.op === 'fillText' || o.op === 'strokeText');
    expect(drawn).toHaveLength(9); // shadow, outline and fill passes
    for (const o of drawn) {
      const expected = /^Amazing/.test(String(o.args[0]))
        ? 'inherit'
        : /^Psalm/.test(String(o.args[0]))
          ? 'ltr'
          : 'rtl';
      expect([o.args[0], o.state.direction, o.state.textAlign]).toEqual([o.args[0], expected, 'left']);
    }
    expect(ctx.direction).toBe('inherit'); // restored
    const l = layoutText(recordingCtx(), text, style, box, 1);
    expect(l.lines.map((x) => x.dir)).toEqual([undefined, 'rtl', 'ltr']);
  });
});

describe('look bands (design/27 §6)', () => {
  const box = { x: 100, y: 100, w: 1200, h: 400, rotation: 0 };
  const lyric = (text: string, extra: Partial<TextObject> = {}): Slide => ({
    id: 's',
    objects: [{ id: 'l', type: 'text', box, text, style: DEFAULT_LYRIC_STYLE, opacity: 1, ...extra }],
    lyricObjectId: 'l',
  });
  const fills = (slide: Slide, look = LOOK_LOWER_THIRD) => {
    const ctx = recordingCtx();
    drawSlide2D(ctx, slide, { scale: 0.5, look });
    return ctx.ops.filter((o) => o.op === 'fillText');
  };
  const legacy = (o: { transform: number[] }) => o.transform[0] === 1;

  it('draws a left-to-right legacy lyric through drawText, as before', () => {
    const f = fills(lyric('Amazing grace'));
    expect(f.length).toBeGreaterThan(0);
    expect(f.every(legacy)).toBe(true);
  });

  it('lays out a Hebrew lyric through the rich engine, in logical px under the scale', () => {
    const f = fills(lyric('שָׁלוֹם עֲלֵיכֶם'));
    expect(f.map((o) => o.args[0]).join('')).toContain('שָׁלוֹם');
    expect(f.every((o) => o.transform[0] === 0.5)).toBe(true);
  });

  it('lays out a rich source with its readable text and paragraph directions', () => {
    const src = lyric('17 For God\nשָׁלוֹם', {
      runs: [{ start: 0, end: 2, baseline: 0.3 }],
      paras: [null, { rtl: true }],
    });
    const f = fills(src);
    expect(f.every((o) => o.transform[0] === 0.5)).toBe(true);
    expect(f.map((o) => o.args[0]).join('')).toContain('For');
    const band = LOOK_LOWER_THIRD.layers.slide.mode === 'lyricOnly' ? LOOK_LOWER_THIRD.layers.slide : null;
    const o = bandObject('17 For God\nשָׁלוֹם', band!.style, band!.band, src.objects[0] as TextObject);
    expect(o.paras).toEqual([null, { rtl: true }]);
    expect(o.style.autofit).toBe('shrink');
    expect(o.runs).toBeUndefined(); // the look's style, not the source's runs
    const ltrBox = bandObject('a\nb', band!.style, band!.band, {
      ...(src.objects[0] as TextObject),
      paras: undefined,
      style: { ...DEFAULT_LYRIC_STYLE, direction: 'rtl' },
    });
    expect(ltrBox.paras).toEqual([{ rtl: true }, { rtl: true }]);
  });

  it('finds the band source only when it holds the band text', () => {
    const s = lyric('Amazing grace');
    expect(bandSource(s, 'Amazing grace')?.id).toBe('l');
    expect(bandSource(s, 'other text')).toBeUndefined();
  });

  it('sends the lower third through the rich engine for Hebrew text or a rich look style', () => {
    const at = (text: string, look: Look) => {
      const ctx = recordingCtx();
      rasterLowerThird(ctx, text, look, 0.5);
      return ctx.ops.filter((o) => o.op === 'fillText');
    };
    expect(at('Pastor Sam Jones', LOOK_STREAM).every(legacy)).toBe(true);
    expect(at('הכומר שמואל', LOOK_STREAM).every((o) => o.transform[0] === 0.5)).toBe(true);
    const rule = LOOK_STREAM.layers.slide;
    if (rule.mode !== 'lyricOnly') throw new Error('stream look is lyric-only');
    const rich: Look = {
      ...LOOK_STREAM,
      layers: { ...LOOK_STREAM.layers, slide: { ...rule, style: { ...rule.style, lang: 'en' } } },
    };
    const f = at('Pastor Sam Jones', rich);
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((o) => o.transform[0] === 0.5)).toBe(true);
  });
});
