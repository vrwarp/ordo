import { DEFAULT_LYRIC_STYLE, LOOK_LOWER_THIRD, LOOK_MAIN, type Look, type SlideObject } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { STACK_BLUR_SIGMA } from './effects.ts';
import {
  OVERHANG_EM,
  type Reach,
  SPRITE_ALIGN,
  SPRITE_MARGIN,
  coversFrame,
  drawSprite,
  imageReach,
  objectReach,
  opaqueColor,
  propsReach,
  slideReach,
  spriteRect,
} from './sprite.ts';
import type { Ctx2D } from './text2d.ts';

/**
 * Tight sprites (design/27 §7.3, M7): the reach of what a layer draws, its device rect, and `drawSprite`'s
 * fall back to full-frame when a drawing touches the sprite's edge ring. The pixels are checked in Chromium
 * by sprite.browser.test.ts.
 */

/**
 * A 2D context that measures every glyph 10 px wide and reads back `alpha` everywhere. With `ink`, its
 * metrics also report an ink box (`actualBoundingBox*`) that reaches `ink.ascent` above the baseline and
 * `ink.descent` below it, from the pen to the advance's end, relative to the left-aligned pen.
 */
function fakeCtx(alpha = 0, ink?: { ascent: number; descent: number }): Ctx2D {
  const state: Record<string | symbol, unknown> = { font: '10px x', letterSpacing: '0px', direction: 'ltr' };
  return new Proxy(state, {
    get(t, k) {
      if (k === 'measureText')
        return (s: string) =>
          ink
            ? {
                width: s.length * 10,
                actualBoundingBoxLeft: 0,
                actualBoundingBoxRight: s.length * 10,
                actualBoundingBoxAscent: ink.ascent,
                actualBoundingBoxDescent: ink.descent,
              }
            : { width: s.length * 10 };
      if (k === 'getImageData')
        return (_x: number, _y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 3; i < data.length; i += 4) data[i] = alpha;
          return { data };
        };
      if (k in t) return t[k];
      return () => undefined;
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as Ctx2D;
}

const box = (x: number, y: number, w: number, h: number, rotation = 0) => ({ x, y, w, h, rotation });
const style = { ...DEFAULT_LYRIC_STYLE, fontSizePx: 40, padding: 0, shadow: undefined, outline: undefined };
const text = (t: string, b: ReturnType<typeof box>, extra: Partial<SlideObject> = {}) =>
  ({ id: 't', type: 'text', box: b, text: t, style, opacity: 1, ...extra }) as SlideObject;

describe('spriteRect', () => {
  it('rounds out, grows by the margin, starts at a multiple of SPRITE_ALIGN and cuts to the frame', () => {
    // 50 - 2 = 48 is aligned already; 25 - 2 = 23 moves out to 16.
    expect(spriteRect({ x: 100.4, y: 50.6, w: 200, h: 100 }, 0.5, 960, 540)).toEqual({
      x: 50 - SPRITE_MARGIN,
      y: 16,
      w: 151 - 50 + 2 * SPRITE_MARGIN,
      h: 76 + SPRITE_MARGIN - 16,
    });
    // 1000 - 2 = 998 moves out to 992.
    expect(spriteRect({ x: -50, y: 1000, w: 300, h: 200 }, 1, 1920, 1080)).toEqual({
      x: 0,
      y: 992,
      w: 252,
      h: 88,
    });
    for (const x of [0.3, 7.9, 13, 101.5])
      expect(spriteRect({ x, y: x, w: 10, h: 10 }, 1.37, 1920, 1080)!.x % SPRITE_ALIGN).toBe(0);
  });

  it('is full-frame when the reach is unknown or covers most of the frame, 1x1 when nothing is drawn', () => {
    expect(spriteRect(null, 1, 1920, 1080)).toBeNull();
    expect(spriteRect({ x: 0, y: 0, w: 1800, h: 1000 }, 1, 1920, 1080)).toBeNull();
    expect(spriteRect({ x: 0, y: 0, w: 0, h: 0 }, 1, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(spriteRect({ x: 3000, y: 0, w: 100, h: 100 }, 1, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(spriteRect({ x: Number.NaN, y: 0, w: 100, h: 100 }, 1, 1920, 1080)).toBeNull();
  });
});

describe('reaches', () => {
  const ctx = fakeCtx();

  it('bounds legacy text by its laid-out block and the glyph overhang, turned with its box', () => {
    // 'Hello' is 50 px wide (10 px a glyph), centred in a 400 px box; one 40 px line, centred in 100 px.
    const r = objectReach(ctx, text('Hello', box(100, 100, 400, 100)), 1)!;
    const m = OVERHANG_EM * 40;
    const lh = 40 * style.lineHeight;
    expect(r.x).toBeCloseTo(275 - m);
    expect(r.w).toBeCloseTo(50 + 2 * m);
    expect(r.y).toBeCloseTo(150 - lh / 2 - m);
    expect(r.h).toBeCloseTo(lh + 2 * m);
    // Nothing of the box itself is drawn: the reach is the text's, not the box's.
    expect(r.w).toBeLessThan(400);
    const turned = objectReach(ctx, text('Hello', box(100, 100, 400, 100, 90)), 1)!;
    expect(turned.h).toBeGreaterThan(r.h);
    expect(turned.w).toBeLessThan(r.w);
    // Overflow: a long text in a short box reaches below the box.
    const long = objectReach(ctx, text('word '.repeat(80), box(100, 100, 400, 50)), 1)!;
    expect(long.y + long.h).toBeGreaterThan(150 + 40);
  });

  it('holds the ink of glyph parts that lie wholly beyond the line box and the overhang', () => {
    // 'Ễ' over a 0.7 line height: the ink reaches 1.5 em (60 px) above the baseline, past the 0.3 em
    // overhang above the line box. One 28 px line centred in the 100 px box: its top at 136, the baseline
    // (drawText's: the box centred on the font size, an ascent of 0.8 em) 26 px below it.
    const tight = { ...style, lineHeight: 0.7 };
    const o = { ...text('ỄỄ', box(100, 100, 400, 100)), style: tight } as SlideObject;
    const plain = objectReach(ctx, o, 1)!;
    expect(plain.y).toBeCloseTo(136 - OVERHANG_EM * 40);
    const r = objectReach(fakeCtx(0, { ascent: 60, descent: 2 }), o, 1)!;
    expect(r.y).toBeCloseTo(136 + 26 - 60 - 1);
    // Below and to the sides the line box and the overhang still hold more than the ink.
    expect(r.y + r.h).toBeCloseTo(plain.y + plain.h);
    expect(r.x).toBeCloseTo(plain.x);
    expect(r.w).toBeCloseTo(plain.w);
    // At scale 2 the same logical reach (layout and ink in device px, divided back).
    const r2 = objectReach(fakeCtx(0, { ascent: 120, descent: 4 }), o, 2)!;
    expect(r2.y).toBeCloseTo(r.y);
    // Rich text does the same with its measured runs: exact spacing of a third of the size.
    const rich = {
      ...text('ỄỄ', box(100, 100, 400, 100)),
      style: { ...style, lineModel: 'office' },
      paras: [{ lineSpacingPx: 40 / 3 }],
    } as SlideObject;
    const richPlain = objectReach(ctx, rich, 1)!;
    const richInk = objectReach(fakeCtx(0, { ascent: 60, descent: 2 }), rich, 1)!;
    expect(richInk.y).toBeLessThan(richPlain.y - 10);
    expect(richInk.y + richInk.h).toBeCloseTo(richPlain.y + richPlain.h);
  });

  it('widens text by its shadow and outline', () => {
    const plain = objectReach(ctx, text('Hello', box(100, 100, 400, 100)), 1)!;
    const fx = objectReach(
      ctx,
      {
        ...text('Hello', box(100, 100, 400, 100)),
        style: {
          ...style,
          shadow: { dx: 10, dy: 20, blur: 15, color: { r: 0, g: 0, b: 0, a: 1 } },
          outline: { width: 4, color: { r: 0, g: 0, b: 0, a: 1 } },
        },
      } as SlideObject,
      1,
    )!;
    expect(plain.x - fx.x).toBe(20 + 2 * 15);
  });

  it('bounds shapes by their box and stroke, and gives up on fields it does not know', () => {
    const s = {
      id: 's',
      type: 'shape',
      box: box(10, 20, 100, 50),
      shape: 'rect',
      stroke: { width: 6, color: { r: 0, g: 0, b: 0, a: 1 } },
      opacity: 1,
      radius: 0,
    } as SlideObject;
    expect(objectReach(ctx, s, 1)).toEqual({ x: 4, y: 14, w: 112, h: 62 });
    expect(objectReach(ctx, { ...s, future: { x: 1 } } as unknown as SlideObject, 1)).toBeNull();
  });

  it("bounds a PowerPoint shape (M6) by its geometry past its box, its outline's mitres and its effects", () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const s = {
      id: 's',
      type: 'shape',
      box: box(100, 100, 100, 50),
      shape: 'rect',
      fill: black,
      opacity: 1,
      radius: 0,
    } as SlideObject;
    const within = (inner: Reach, outer: Reach) =>
      !!inner &&
      !!outer &&
      inner.x >= outer.x - 1e-9 &&
      inner.y >= outer.y - 1e-9 &&
      inner.x + inner.w <= outer.x + outer.w + 1e-9 &&
      inner.y + inner.h <= outer.y + outer.h + 1e-9;
    // wedgeRectCallout's tail (adj1 -20,833, adj2 62,500): its tip at (29.2, 56.25) of the 100 x 50 box.
    const callout = objectReach(ctx, { ...s, geom: { preset: 'wedgeRectCallout' } } as SlideObject, 1)!;
    expect(callout.y + callout.h).toBeGreaterThanOrEqual(100 + 56.25);
    expect(callout.y + callout.h).toBeLessThan(100 + 56.25 + 3);
    // Flipped vertically, the tail points up.
    const up = objectReach(
      ctx,
      { ...s, geom: { preset: 'wedgeRectCallout' }, flipV: true } as SlideObject,
      1,
    )!;
    expect(up.y).toBeLessThanOrEqual(100 - 6.25);
    // A thick stroke reaches half its width past the outline, more at a sharp miter.
    const star = { ...s, geom: { preset: 'star5' }, stroke: { width: 10, color: black } } as SlideObject;
    const r = objectReach(ctx, star, 1)!;
    expect(r.x).toBeLessThan(100 - 5);
    // A shadow: its offset and three sigmas of its blur, plus the layer's slack; a glow around every side.
    const shadow = { dx: 20, dy: 10, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.5 } };
    const sh = objectReach(ctx, { ...s, shadow } as SlideObject, 1)!;
    expect(sh.x + sh.w).toBeGreaterThanOrEqual(200 + 20 + 3 * 12 * STACK_BLUR_SIGMA);
    expect(sh.x).toBeLessThanOrEqual(100);
    const gl = objectReach(ctx, { ...s, glow: { radius: 20, color: shadow.color } } as SlideObject, 1)!;
    expect(gl.x).toBeLessThanOrEqual(100 - 10 * (1 + 3 * STACK_BLUR_SIGMA));
    // A soft edge fades inside the outline; an invisible shadow casts nothing.
    const soft = objectReach(ctx, { ...s, softEdge: 20 } as SlideObject, 1)!;
    expect(
      within(soft, objectReach(ctx, { ...s, gradient: undefined, dash: 'solid' } as SlideObject, 1)),
    ).toBe(true);
    const clear = { ...shadow, color: { ...shadow.color, a: 0 } };
    expect(objectReach(ctx, { ...s, shadow: clear } as SlideObject, 1)).toEqual(
      objectReach(ctx, { ...s, dash: 'solid' } as SlideObject, 1),
    );
    // Turned with the box.
    const turned = objectReach(
      ctx,
      { ...s, box: box(100, 100, 100, 50, 90), dash: 'solid' } as SlideObject,
      1,
    )!;
    expect(turned.w).toBeLessThan(turned.h);
    // A geometry only in a file not read yet draws nothing.
    expect(objectReach(ctx, { ...s, geom: { ref: 'f'.repeat(64) } } as SlideObject, 1)).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    });
  });

  it('reaches the whole frame for a slide with its PowerPoint picture, nothing for a hidden look', () => {
    const slide = {
      id: 's',
      objects: [text('Hi', box(0, 0, 100, 50))],
      imported: { fileId: 'f', page: 0, imageMediaId: 'p' },
    };
    expect(slideReach(ctx, slide, { scale: 1, look: LOOK_MAIN })).toBeNull();
    const hidden = { ...LOOK_MAIN, layers: { ...LOOK_MAIN.layers, slide: { mode: 'hidden' } } } as Look;
    expect(slideReach(ctx, slide, { scale: 1, look: hidden })).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("bounds a lyric-only band around the look's band", () => {
    const slide = { id: 's', objects: [text('Amazing grace', box(0, 0, 1900, 1000))] };
    const r = slideReach(ctx, slide, { scale: 1, look: LOOK_LOWER_THIRD, isSong: true })!;
    const band = (LOOK_LOWER_THIRD.layers.slide as { band: { y: number; h: number } }).band;
    // The text's lines within the band (fitted to it), grown by the overhang only.
    expect(r.y).toBeGreaterThan(band.y - 100);
    expect(r.y + r.h).toBeLessThan(band.y + band.h + 100);
    expect(r.h).toBeLessThan(band.h + 100);
  });

  it('reaches the frame for a logo, and contain-fitted pictures only their fitted rect', () => {
    expect(
      propsReach(
        ctx,
        { key: 'p', empty: false, items: [], logo: { mediaId: 'l', box: box(0, 0, 10, 10) } },
        1,
      ),
    ).toBeNull();
    const img = { width: 400, height: 300 } as unknown as CanvasImageSource;
    expect(imageReach(img, 'contain')).toEqual({ x: 240, y: 0, w: 1440, h: 1080 });
    expect(imageReach(img, 'cover')).toBeNull();
  });

  it('knows when a fill over the logical frame covers the output', () => {
    expect(coversFrame(2, 3840, 2160)).toBe(true);
    expect(coversFrame(1, 1920, 1200)).toBe(false);
    expect(opaqueColor({ r: 0, g: 0, b: 0, a: 1 })).toBe(true);
    expect(opaqueColor({ r: 0, g: 0, b: 0, a: 0.5 })).toBe(false);
  });
});

describe('drawSprite', () => {
  function run(alpha: number, rect = { x: 10, y: 10, w: 20, h: 20 }) {
    const sizes: [number, number][] = [];
    const ctx = fakeCtx(alpha);
    const draws: number[] = [];
    const d = drawSprite(
      (w, h) => {
        sizes.push([w, h]);
        return ctx;
      },
      () => 'bitmap',
      100,
      100,
      rect,
      () => draws.push(1),
    );
    return { d, sizes, draws };
  }

  it('keeps a sprite whose edge ring is clear', () => {
    const { d, sizes } = run(0);
    expect(d).toEqual({ bitmap: 'bitmap', x: 10, y: 10, tight: true, missed: false });
    expect(sizes).toEqual([[20, 20]]);
  });

  it('draws again full-frame when the drawing touches the ring', () => {
    const { d, sizes, draws } = run(255);
    expect(d).toEqual({ bitmap: 'bitmap', x: 0, y: 0, tight: false, missed: true });
    expect(sizes).toEqual([
      [20, 20],
      [100, 100],
    ]);
    expect(draws).toHaveLength(2);
  });

  it('does not check ring sides that lie on the frame edge', () => {
    // A sprite filling the frame's top-left corner: only its right and bottom edges are checked; with
    // everything opaque it is still a miss, but with a sprite against every frame edge nothing is checked.
    expect(run(255, { x: 0, y: 0, w: 100, h: 100 }).d.tight).toBe(true);
  });
});
