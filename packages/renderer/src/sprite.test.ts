import { DEFAULT_LYRIC_STYLE, LOOK_LOWER_THIRD, LOOK_MAIN, type Look, type SlideObject } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
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

/** A 2D context that measures every glyph 10 px wide and reads back `alpha` everywhere. */
function fakeCtx(alpha = 0): Ctx2D {
  const state: Record<string | symbol, unknown> = { font: '10px x', letterSpacing: '0px', direction: 'ltr' };
  return new Proxy(state, {
    get(t, k) {
      if (k === 'measureText') return (s: string) => ({ width: s.length * 10 });
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
  it('rounds out, grows by the margin and cuts to the frame', () => {
    expect(spriteRect({ x: 100.4, y: 50.6, w: 200, h: 100 }, 0.5, 960, 540)).toEqual({
      x: 50 - SPRITE_MARGIN,
      y: 25 - SPRITE_MARGIN,
      w: 151 - 50 + 2 * SPRITE_MARGIN,
      h: 76 - 25 + 2 * SPRITE_MARGIN,
    });
    expect(spriteRect({ x: -50, y: 1000, w: 300, h: 200 }, 1, 1920, 1080)).toEqual({
      x: 0,
      y: 998,
      w: 252,
      h: 82,
    });
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

  it('bounds legacy text by its laid-out block and one em, turned with its box', () => {
    const r = objectReach(ctx, text('Hello', box(100, 100, 400, 100)), 1)!;
    expect(r.x).toBeLessThanOrEqual(100 - 40);
    expect(r.y).toBeLessThanOrEqual(100 - 40);
    expect(r.x + r.w).toBeGreaterThanOrEqual(500 + 40);
    const turned = objectReach(ctx, text('Hello', box(100, 100, 400, 100, 90)), 1)!;
    expect(turned.h).toBeGreaterThan(r.h);
    // Overflow: a long text in a short box reaches below the box.
    const long = objectReach(ctx, text('word '.repeat(80), box(100, 100, 400, 50)), 1)!;
    expect(long.y + long.h).toBeGreaterThan(150 + 40);
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
    expect(
      objectReach(ctx, { ...s, geom: { preset: 'wedgeRectCallout' } } as unknown as SlideObject, 1),
    ).toBeNull();
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
    const band = (LOOK_LOWER_THIRD.layers.slide as { band: { y: number } }).band;
    expect(r.y).toBeLessThanOrEqual(band.y);
    expect(r.y).toBeGreaterThan(band.y - 300);
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
