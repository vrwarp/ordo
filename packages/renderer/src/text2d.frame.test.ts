import { LOOK_MAIN, type SlideObject } from '@ordo/domain';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { frameKey, frameUnitsLeft, splitFrame, underFrame } from './frame.ts';
import { picture, slideOf, squares, textBox, texts } from './frame.test-util.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { rasterScene } from './scene-raster.ts';
import { slideReach } from './sprite.ts';
import { drawSlide2D, type UnderFrame } from './text2d.ts';
import { type TraceCtx, traceCtx } from './trace.test-util.ts';
import { clearUnits, markUnitUnmade, slideUnitsLeft, unitCache } from './units.ts';
import { effectsSlide } from './units.effects.test-util.ts';

/*
 * The frame in the raster (design 29 R1): `SlideDrawOptions.under` is copied 1:1 under the direct objects when it
 * is ready, left out and reported through `late` when it is not, and never drawn directly in the raster.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterEach(() => {
  clearUnits();
  vi.unstubAllGlobals();
  vi.stubGlobal('Path2D', RecPath);
});

const calls = (t: TraceCtx, name: string) => t.trace.filter((e) => e[0] === 'call' && e[1] === name);
const order = (t: TraceCtx) => t.trace.filter((e) => e[0] === 'call').map((e) => e[1] as string);

/** A frame under 340 objects: a handle whose picture the test controls. */
function handle(ready: boolean, unmade = false): { under: UnderFrame; rect: UnderFrame['rect'] } {
  const rect = { x: 0, y: 0, w: 1920, h: 1080 };
  const img = { width: 1920, height: 1080, id: 'frame' };
  return {
    rect,
    under: {
      key: 'k1',
      rect,
      image: () => (ready ? (img as unknown as CanvasImageSource) : undefined),
      unmade: () => unmade,
    },
  };
}

describe('drawSlide2D with an underlay frame', () => {
  const split = splitFrame(slideOf(squares(340)), 1)!;

  it('copies a ready frame at its rect before the first object, then draws the direct objects', () => {
    const { under, rect } = handle(true);
    const late = vi.fn();
    const t = traceCtx(1920, 1080);
    drawSlide2D(t, split.direct, { scale: 1, under, late });
    const images = calls(t, 'drawImage');
    expect(images).toEqual([['call', 'drawImage', { image: [1920, 1080, 'frame'] }, rect.x, rect.y]]);
    // the frame's copy comes before the first object's paint, and every direct object is drawn
    const o = order(t);
    expect(o.indexOf('drawImage')).toBeLessThan(o.indexOf('fill'));
    expect(calls(t, 'fill')).toHaveLength(split.direct.objects.length);
    expect(late).not.toHaveBeenCalled();
  });

  it('draws a frame under a copy that is exactly source-over, opaque, at 1:1', () => {
    const { under } = handle(true);
    const t = traceCtx(1920, 1080);
    drawSlide2D(t, split.direct, { scale: 1, under });
    const sets = t.trace.filter(
      (e) => e[0] === 'set' && (e[1] === 'globalAlpha' || e[1] === 'globalCompositeOperation'),
    );
    expect(sets).toContainEqual(['set', 'globalCompositeOperation', 'source-over']);
  });

  it('leaves a frame that is not ready out, reports its key once through late, and draws only the direct objects', () => {
    const { under } = handle(false);
    const late = vi.fn();
    const t = traceCtx(1920, 1080);
    drawSlide2D(t, split.direct, { scale: 1, under, late });
    expect(calls(t, 'drawImage')).toEqual([]);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith('k1');
    expect(calls(t, 'fill')).toHaveLength(split.direct.objects.length);
  });

  it('draws nothing of a frame that is not ready where nobody is told (no late) and does not throw', () => {
    const { under } = handle(false);
    const t = traceCtx(1920, 1080);
    expect(() => drawSlide2D(t, split.direct, { scale: 1, under })).not.toThrow();
    expect(calls(t, 'drawImage')).toEqual([]);
  });

  it('does not report a frame that could not be made (the slide keeps its direct part)', () => {
    const { under } = handle(false, true);
    const late = vi.fn();
    drawSlide2D(traceCtx(1920, 1080), split.direct, { scale: 1, under, late });
    expect(late).not.toHaveBeenCalled();
  });

  it('gives a context that cannot copy 1:1 no frame, without throwing', () => {
    const { under } = handle(true);
    const zoomed = traceCtx(1920, 1080);
    zoomed.scale(0.5, 0.5);
    expect(() => drawSlide2D(zoomed, split.direct, { scale: 1, under })).not.toThrow();
    expect(calls(zoomed, 'drawImage')).toEqual([]);
    // a whole-pixel translation (a tight sprite's surface) keeps the copy exact
    const sprite = traceCtx(1920, 1080);
    sprite.translate(-64, -32);
    drawSlide2D(sprite, split.direct, { scale: 1, under });
    expect(calls(sprite, 'drawImage')).toHaveLength(1);
  });

  it("draws the slide as it always was without a frame (today's path, call for call)", () => {
    const a = traceCtx(1920, 1080);
    const b = traceCtx(1920, 1080);
    drawSlide2D(a, split.direct, { scale: 1 });
    drawSlide2D(b, split.direct, { scale: 1, under: undefined });
    expect(b.trace).toEqual(a.trace);
  });

  it('is the underFrame handle of the unit cache: ready once its key is in the cache', () => {
    const u = underFrame(split);
    expect(u.key).toBe(frameKey(split));
    expect(u.image()).toBeUndefined();
    expect(u.unmade?.()).toBe(false);
    unitCache.set('unit', u.key, {
      source: { width: 1920, height: 1080 } as never,
      w: 1920,
      h: 1080,
      bytes: 1920 * 1080 * 4,
    });
    expect(u.image()).toBeDefined();
    clearUnits();
    markUnitUnmade(u.key);
    expect(u.unmade?.()).toBe(true);
  });
});

describe('slideReach with an underlay frame', () => {
  it('covers the whole frame once it is ready, not before', () => {
    const split = splitFrame(slideOf(texts(340)), 1)!;
    const ctx = traceCtx(1920, 1080);
    const before = slideReach(ctx, split.direct, { scale: 1, under: handle(false).under });
    const after = slideReach(ctx, split.direct, { scale: 1, under: handle(true).under });
    const plain = slideReach(ctx, split.direct, { scale: 1 });
    expect(before).toEqual(plain);
    expect(after).not.toBeNull();
    expect(after).toEqual(expect.objectContaining({ x: expect.any(Number) }));
    const r = after as { x: number; y: number; w: number; h: number };
    expect(r.x).toBeLessThanOrEqual(0);
    expect(r.y).toBeLessThanOrEqual(0);
    expect(r.x + r.w).toBeGreaterThanOrEqual(1920);
    expect(r.y + r.h).toBeGreaterThanOrEqual(1080);
  });
});

describe('the scene of a crowded slide', () => {
  it('has the frame in the base only, the playing image in the direct list, over holding what overlaps it', () => {
    const objs: SlideObject[] = texts(400);
    objs[40] = picture('play', 'vid', { x: 100, y: 100, w: 640, h: 360 }, {
      play: { showWhenStopped: true },
    } as never);
    // a text over the video, one clear of it
    objs[398] = textBox('over-video', 'Over', 120, 120, 300, 80);
    objs[399] = textBox('clear', 'Clear', 1000, 900, 300, 80);
    const split = splitFrame(slideOf(objs), 1, { video: { objectId: 'play' } })!;
    expect(split.direct.objects.map((o) => o.id)).toContain('play');
    const t = traceCtx(1920, 1080);
    const bases: TraceCtx[] = [];
    const take = () => {
      const snap = { n: t.trace.length };
      bases.push(snap as never);
      return snap;
    };
    const { under } = handle(true);
    const scene = rasterScene(
      t,
      take as never,
      split.direct,
      LOOK_MAIN,
      1,
      () => ({ width: 640, height: 360 }) as never,
      'play',
      {
        under,
        clip: { w: 640, h: 360 },
      },
    )!;
    expect(scene).toBeDefined();
    const [baseSnap, overSnap] = bases as unknown as { n: number }[];
    const copies = t.trace
      .map((e, i) => [e, i] as const)
      .filter(([e]) => e[0] === 'call' && e[1] === 'drawImage' && JSON.stringify(e[2]).includes('frame'));
    expect(copies).toHaveLength(1);
    // the one copy of the frame is before the base was taken, none for the over
    expect(copies[0]![1]).toBeLessThan(baseSnap!.n);
    expect(overSnap).toBeDefined();
    expect(scene.over).not.toBeNull();
  });
});

describe('c(2): units past one frame of area, closed by the split', () => {
  it('a soft frame and 12 large shadowed panels: the whole slide reports area, the direct part and the frame none', () => {
    const slide = effectsSlide({ w: 1100, h: 700 });
    const whole = slideUnitsLeft(slide.objects, 1);
    expect(whole.filter((w) => w === 'area').length).toBeGreaterThan(0);
    const split = splitFrame(slide, 1)!;
    expect(split).toBeDefined();
    expect(split.why.area).toBe(true);
    expect(slideUnitsLeft(split.direct.objects, 1).filter((w) => w === 'area')).toEqual([]);
    // every object of the slide is in the direct part or in the frame, none drawn as a legacy copy for want of area
    expect(split.direct.objects.length + split.under.length).toBe(slide.objects.length);
    expect(frameUnitsLeft(split)).toEqual([]);
  });
});
