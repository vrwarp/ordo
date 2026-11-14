import { LOOK_MAIN, type ShapeObject, type Slide, type SlideObject } from '@ordo/domain';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clampSlide } from './clamp.ts';
import { drawableContent } from './content.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { clearGeomFiles, putGeomFile } from './geom/stored.ts';
import { legacyOf, overGeomBudget, slideBudget, withinDrawBudget } from './geombudget.ts';
import { sceneSlides } from './scene-raster.ts';
import { geomShapeReach, slideReach } from './sprite.ts';
import { drawSlide2D } from './text2d.ts';
import { type TraceCtx, traceCtx } from './trace.test-util.ts';
import {
  clearUnits,
  type GeomUnit,
  makeUnit,
  prepareSlideUnits,
  putUnit,
  slideUnits,
  UNIT_SLIDE_AREAS,
  UNIT_VERSION,
  unitCache,
  unitKey,
  unitOf,
  unitReady,
  unitsOfSlide,
  unitWork,
} from './units.ts';

/*
 * Geometry units (design/27 §12-13, M9 "Slow-to-draw elements", Runtime): an object the slide's drawing budget
 * sends to its legacy copy is drawn whole from a unit made in slices, wherever the legacy copy would be drawn.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));

afterEach(() => {
  clearUnits();
  clearGeomFiles();
  vi.unstubAllGlobals();
  vi.stubGlobal('Path2D', RecPath);
});

/** A path zigzagging across a 2000 x 2000 space (a costly fill within the per-geometry bound). */
function zigzag(points: number): string {
  let d = 'M 1000 1000';
  for (let k = 1; k < points; k++) {
    const a = (k / points) * Math.PI * 2 * 37;
    const r = k % 2 ? 1000 : 50;
    d += ` L ${(1000 + r * Math.cos(a)).toFixed(1)} ${(1000 + r * Math.sin(a)).toFixed(1)}`;
  }
  return `${d} Z`;
}

const shape = (id: string, extra: Partial<ShapeObject> = {}): ShapeObject => ({
  id,
  type: 'shape',
  box: { x: 100, y: 50, w: 1600, h: 900, rotation: 0 },
  shape: 'rect',
  fill: { r: 0, g: 0, b: 0, a: 1 },
  opacity: 1,
  radius: 0,
  geom: { paths: [{ d: zigzag(250), w: 2000, h: 2000 }] },
  ...extra,
});

/** A slide past `GEOM_COST.slide`: eight zigzags, the last ones drawn as their legacy shapes by the budget. */
function busySlide(extra: Partial<ShapeObject> = {}): Slide {
  return {
    id: 'busy',
    objects: Array.from({ length: 12 }, (_, i) =>
      shape(`z${i}`, {
        box: { x: 50 + (i % 4) * 400 + i, y: 50 + Math.floor(i / 4) * 250, w: 700, h: 500, rotation: 0 },
        ...extra,
      }),
    ),
  };
}

/** The clamped objects a slide draws, as `drawSlide2D` hands them to the budget. */
const objectsOf = (s: Slide) => drawableContent(clampSlide(s)).objects;

/** A picture standing in for a unit's bitmap (the trace logs it by its size and id). */
const fakeBitmap = (u: GeomUnit) => ({
  width: u.rect.w,
  height: u.rect.h,
  id: `unit-${u.object.id}`,
  close() {},
});

/** Every unit the slide asks for, made ready with a stand-in picture. */
function ready(slide: Slide, scale = 1): readonly GeomUnit[] {
  const units = slideUnits(objectsOf(slide), scale);
  for (const u of units) expect(putUnit(u, fakeBitmap(u) as unknown as CanvasImageSource)).toBe(true);
  return units;
}

/** The fills and strokes of a trace (what a legacy rect or a geometry paints). */
const paints = (t: TraceCtx) => t.trace.filter((e) => e[0] === 'call' && /^(fill|stroke)/.test(e[1]));
const images = (t: TraceCtx) => t.trace.filter((e) => e[0] === 'call' && e[1] === 'drawImage');

describe('geometry units (M9 Slow-to-draw, Runtime)', () => {
  it('asks for a unit for each object the budget sends to a legacy copy, in z-order', () => {
    const slide = busySlide();
    const objects = objectsOf(slide);
    const over = [...overGeomBudget(objects)];
    expect(over.length).toBeGreaterThanOrEqual(4);
    const units = slideUnits(objects, 2);
    // In z-order, while their area stays within one frame: the rest keep their legacy copies.
    expect(units.length).toBeGreaterThanOrEqual(2);
    expect(units.length).toBeLessThan(over.length);
    expect(units.map((u) => u.object)).toEqual(over.filter((o) => units.some((u) => u.object === o)));
    expect(units.reduce((a, u) => a + u.rect.w * u.rect.h, 0)).toBeLessThanOrEqual(
      3840 * 2160 * UNIT_SLIDE_AREAS,
    );
    // Drawn whole without effects, at the device scale, over its reach cut to the frame at an integer origin.
    for (const u of units) {
      expect(u.scale).toBe(2);
      for (const v of Object.values(u.rect)) expect(Number.isInteger(v)).toBe(true);
      expect(u.rect.x).toBeGreaterThanOrEqual(0);
      expect(u.rect.y).toBeGreaterThanOrEqual(0);
      expect(u.rect.x + u.rect.w).toBeLessThanOrEqual(3840);
      expect(u.rect.y + u.rect.h).toBeLessThanOrEqual(2160);
      expect(u.bytes).toBe(u.rect.w * u.rect.h * 4);
      const r = geomShapeReach(u.drawn as ShapeObject, 2)!;
      expect(u.rect.x).toBe(Math.floor(r.x * 2));
      expect(u.rect.y).toBe(Math.floor(r.y * 2));
    }
    // Memoised; none for a slide within the budget, a look that draws bands, or text.
    expect(slideUnits(objects, 2)).toBe(units);
    expect(unitsOfSlide({ id: 'calm', objects: [shape('a')] }, 2)).toEqual([]);
    expect(
      unitsOfSlide(slide, 2, {
        ...LOOK_MAIN,
        layers: { ...LOOK_MAIN.layers, slide: { mode: 'hidden' } },
      } as never),
    ).toEqual([]);
    expect(
      unitOf({ id: 't', type: 'text', box: shape('x').box, text: 'Hi' } as SlideObject, 1),
    ).toBeUndefined();
  });

  it('a slide past GEOM_COST.slide with ready units draws no legacy fill for them: each copied 1:1 at its origin', () => {
    const slide = busySlide();
    const objects = objectsOf(slide);
    // Without units: the legacy copies are drawn (a fill each).
    const before = traceCtx(1920, 1080);
    drawSlide2D(before, slide, { scale: 1 });
    expect(images(before)).toEqual([]);
    const units = ready(slide);
    const after = traceCtx(1920, 1080);
    drawSlide2D(after, slide, { scale: 1 });
    // Each object past the budget is one copy of its unit at its rect's origin, and no legacy paint is left.
    expect(images(after)).toEqual(
      units.map((u) => [
        'call',
        'drawImage',
        { image: [u.rect.w, u.rect.h, `unit-${u.object.id}`] },
        u.rect.x,
        u.rect.y,
      ]),
    );
    expect(paints(before).length - paints(after).length).toBe(units.length);
    // The other objects are drawn as before (within the budget, or as legacy copies past the units' frame), in
    // the same order around the copies.
    const copied = new Set(units.map((u) => u.object));
    const drawn = withinDrawBudget(objects);
    const live = objects.flatMap((o, i) => (copied.has(o) ? [] : [drawn[i]!]));
    const alone = traceCtx(1920, 1080);
    drawSlide2D(alone, { id: 'live', objects: live }, { scale: 1 });
    expect(paints(after)).toEqual(paints(alone));
  });

  it('leaves the legacy copy where the unit is not ready, at another scale or under a transform', () => {
    const slide = busySlide();
    const [first, ...rest] = slideUnits(objectsOf(slide), 1);
    putUnit(first!, fakeBitmap(first!) as unknown as CanvasImageSource);
    const t = traceCtx(1920, 1080);
    drawSlide2D(t, slide, { scale: 1 });
    expect(images(t)).toHaveLength(1);
    expect(rest.length).toBeGreaterThan(0);
    // At 2x the unit of 1x is not used.
    const big = traceCtx(3840, 2160);
    drawSlide2D(big, slide, { scale: 2 });
    expect(images(big)).toEqual([]);
    // Under a scale (the editor's zoom), a copy would not be 1:1: every legacy copy is drawn as before.
    const zoomed = traceCtx(1920, 1080);
    zoomed.scale(0.5, 0.5);
    drawSlide2D(zoomed, slide, { scale: 1 });
    expect(images(zoomed)).toEqual([]);
    // A whole-pixel translation (a tight sprite's surface) keeps the copy exact.
    const sprite = traceCtx(1920, 1080);
    sprite.translate(-64, -32);
    drawSlide2D(sprite, slide, { scale: 1 });
    expect(images(sprite)).toHaveLength(1);
  });

  it('keys a unit by what it draws: not its id, its effects or editor fields; its geometry by file hash', () => {
    const a = shape('a');
    const rect = { x: 0, y: 0, w: 10, h: 10 };
    const key = unitKey(a, 1, rect);
    expect(key.startsWith(`u${UNIT_VERSION}:`)).toBe(true);
    expect(unitKey({ ...a, id: 'b', origin: { src: 'pptx' }, locked: true }, 1, rect)).toBe(key);
    expect(unitKey({ ...a, fill: { r: 9, g: 0, b: 0, a: 1 } }, 1, rect)).not.toBe(key);
    expect(unitKey({ ...a, box: { ...a.box, rotation: 10 } }, 1, rect)).not.toBe(key);
    expect(unitKey({ ...a, flipH: true }, 1, rect)).not.toBe(key);
    expect(unitKey(a, 2, rect)).not.toBe(key);
    expect(unitKey(a, 1, { ...rect, x: 1 })).not.toBe(key);
    expect(unitKey(a, 1, { ...rect, w: 11 })).not.toBe(key);
    const f1 = unitKey({ ...a, geom: { ref: 'f'.repeat(64) } } as SlideObject, 1, rect);
    expect(f1).not.toBe(unitKey({ ...a, geom: { ref: 'e'.repeat(64) } } as SlideObject, 1, rect));
    // Effects are not drawn on a unit: a shadowed copy of a shape asks for the same unit.
    const plain = objectsOf(busySlide());
    const shadowed = objectsOf(
      busySlide({ shadow: { dx: 4, dy: 4, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.5 } } }),
    );
    const u = unitOf(shadowed.at(-1)!, 1)!;
    expect(u.key).toBe(unitOf(plain.at(-1)!, 1)!.key);
    expect((u.drawn as ShapeObject).shadow).toBeUndefined();
  });

  it("a geometry file not read yet makes no unit; once read, the slide's units are worked out again", () => {
    const hash = 'a'.repeat(64);
    const slide: Slide = {
      id: 'file',
      objects: Array.from({ length: 8 }, (_, i) =>
        shape(`f${i}`, {
          box: { x: 100 + i, y: 50, w: 1600, h: 900, rotation: 0 },
          geom: { ref: hash } as never,
        }),
      ),
    };
    expect(unitsOfSlide(slide, 1)).toEqual([]);
    putGeomFile(hash, { paths: [{ d: zigzag(250), w: 2000, h: 2000 }] });
    const units = unitsOfSlide(slide, 1);
    expect(units.length).toBeGreaterThan(0);
  });

  it("cuts a unit to the frame: an object partly off the slide is drawn from the frame's edge", () => {
    const slide: Slide = {
      id: 'off',
      objects: Array.from({ length: 8 }, (_, i) =>
        shape(`o${i}`, { box: { x: -400 + i, y: 700, w: 1600, h: 900, rotation: 0 } }),
      ),
    };
    const units = slideUnits(objectsOf(slide), 1);
    expect(units.length).toBeGreaterThan(0);
    for (const u of units) {
      expect(u.rect.x).toBe(0);
      expect(u.rect.y + u.rect.h).toBe(1080);
    }
  });

  it("sizes a slide's reach by the unit's rect where the unit is drawn: its original's drawn bounds", () => {
    const slide = busySlide();
    const objects = objectsOf(slide);
    const last = slideUnits(objects, 1).at(-1)!.object;
    const lonely: Slide = { id: 'one', objects: [last] };
    // Within the budget alone: the slide reaches its original's drawn bounds.
    const original = slideReach(traceCtx(), lonely, { scale: 1 })!;
    // On the busy slide, the legacy copy reaches its box until the unit is ready, then its original's bounds.
    const legacyOnly: Slide = { id: 'legacy', objects: [withinDrawBudget(objects)[objects.indexOf(last)]!] };
    const { x, y, w, h } = last.box;
    expect(slideReach(traceCtx(), legacyOnly, { scale: 1 })).toEqual({ x, y, w, h });

    ready(slide);
    const viaUnit = slideReach(traceCtx(), legacyOnly, { scale: 1 })!;
    const u = unitOf(last, 1)!;
    expect(viaUnit).toEqual({ x: u.rect.x, y: u.rect.y, w: u.rect.w, h: u.rect.h });
    // The unit's rect is the original's drawn bounds rounded out to whole device px.
    expect(viaUnit.x).toBeLessThanOrEqual(original.x);
    expect(viaUnit.y).toBeLessThanOrEqual(original.y);
    expect(viaUnit.x + viaUnit.w).toBeGreaterThanOrEqual(original.x + original.w);
    expect(viaUnit.y + viaUnit.h).toBeGreaterThanOrEqual(original.y + original.h);
    expect(viaUnit.w - original.w).toBeLessThan(2);
    expect(viaUnit.h - original.h).toBeLessThan(2);
  });

  it("keeps the budget's legacy copies in a scene's parts, so base and over draw their units too", () => {
    const slide: Slide = {
      id: 'scene',
      objects: [
        {
          id: 'vid',
          type: 'image',
          box: { x: 1500, y: 800, w: 300, h: 200, rotation: 0 },
          mediaId: 'm',
          fit: 'contain',
          opacity: 1,
          radius: 0,
          play: { mediaId: 'clip' },
        } as SlideObject,
        ...busySlide().objects,
      ],
    };
    const objects = objectsOf(slide);
    const copies = [...slideBudget(objects).values()];
    expect(copies.length).toBeGreaterThan(0);
    for (const c of copies) expect(legacyOf(c)?.original).toBeDefined();
    ready(slide);
    const scene = sceneSlides(traceCtx(), slide, LOOK_MAIN, 1, () => undefined, 'vid')!;
    // Base and over hold the very legacy copies (clamping them again keeps them), so their units are found.
    const parts = [...scene.base.objects, ...(scene.over?.objects ?? [])];
    for (const c of copies) expect(parts).toContain(c);
    for (const part of [scene.base, scene.over].filter((p) => p !== null)) {
      expect(clampSlide(part).objects).toEqual(part.objects);
      for (const o of clampSlide(part).objects) if (legacyOf(o)) expect(copies).toContain(o);
    }
    const t = traceCtx(1920, 1080);
    drawSlide2D(t, scene.base, { scale: 1 });
    if (scene.over) drawSlide2D(t, scene.over, { scale: 1 });
    expect(images(t)).toHaveLength(slideUnits(objects, 1).length);
  });
});

/** A canvas standing in for OffscreenCanvas: a trace context, its bitmap a record of its size. */
class FakeOffscreenCanvas {
  static made: FakeOffscreenCanvas[] = [];
  readonly width: number;
  readonly height: number;
  readonly ctx: TraceCtx;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    const t = traceCtx(w, h);
    // The trace has no pixels: a read gives a transparent one.
    (t as unknown as { getImageData: unknown }).getImageData = () => ({ data: new Uint8ClampedArray(4) });
    this.ctx = t;
    FakeOffscreenCanvas.made.push(this);
  }
  getContext() {
    return this.ctx;
  }
  transferToImageBitmap() {
    return { width: this.width, height: this.height, close() {} };
  }
}

describe('making geometry units in slices', () => {
  const run = (log: { slices: number; checks: number }) => ({
    slice: async <T>(fn: () => T) => {
      log.slices++;
      return fn();
    },
    check: () => {
      log.checks++;
    },
  });

  it('draws a unit call by call on a scratch of the frame, then copies its rect, in turns, and keeps it', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.made = [];
    // Shapes of two paths and an outline: a fill and an outline each, four draw calls.
    const slide = busySlide({
      geom: {
        paths: [
          { d: zigzag(150), w: 2000, h: 2000 },
          { d: zigzag(100), w: 2000, h: 2000 },
        ],
      },
      stroke: { width: 1, color: { r: 255, g: 0, b: 0, a: 1 } },
    });
    const u = slideUnits(objectsOf(slide), 2)[0];
    expect(u).toBeDefined();
    // A clock where each step takes 3 ms: about one step a turn (half of SLICE_MS is 5 ms).
    let clock = 0;
    const log = { slices: 0, checks: 0 };
    const before = unitWork();
    const longest = await makeUnit(u!, {
      ...run(log),
      now: () => {
        clock += 1.5;
        return clock;
      },
    });
    expect(longest).toBeGreaterThan(0);
    expect(unitReady(u!)).toBeDefined();
    const [scratch, unit] = FakeOffscreenCanvas.made.slice(-2);
    // The scratch is the frame at the job's scale, drawn at the frame's own transform: no clip, no offset.
    expect([scratch!.width, scratch!.height]).toEqual([3840, 2160]);
    const drawn = scratch!.ctx.trace.filter((e) => e[0] === 'call');
    expect(drawn.filter((e) => e[1] === 'clip')).toEqual([]);
    expect(drawn.filter((e) => e[1] === 'fill')).toHaveLength(2);
    expect(drawn.filter((e) => e[1] === 'stroke')).toHaveLength(2);
    // Its rect copied 1:1 into the unit's own picture.
    expect([unit!.width, unit!.height]).toEqual([u!.rect.w, u!.rect.h]);
    const { x, y, w, h } = u!.rect;
    expect(unit!.ctx.trace.filter((e) => e[1] === 'drawImage')).toEqual([
      ['call', 'drawImage', { image: [3840, 2160, ''] }, x, y, w, h, 0, 0, w, h],
    ]);
    const work = unitWork();
    expect(work.made - before.made).toBe(1);
    // The scratch, four calls and the copy.
    expect(work.steps - before.steps).toBe(6);
    expect(log.slices).toBe(work.turns - before.turns);
    expect(log.slices).toBeGreaterThan(1);
    expect(log.checks).toBeGreaterThanOrEqual(log.slices);
    // Ready: made again, nothing is drawn.
    expect(await makeUnit(u!, run(log))).toBe(0);
    expect(unitWork().made).toBe(work.made);
  });

  it('stops at a cancelled job and keeps nothing', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const [u] = slideUnits(objectsOf(busySlide()), 1);
    let n = 0;
    await expect(
      makeUnit(u!, {
        slice: async (fn) => fn(),
        check: () => {
          if (++n > 1) throw new Error('cancelled');
        },
        now: () => n * 100,
      }),
    ).rejects.toThrow('cancelled');
    expect(unitReady(u!)).toBeUndefined();
  });

  it('leaves the legacy copy without OffscreenCanvas, and bounds a job by its wait', async () => {
    const slide = busySlide();
    expect(await prepareSlideUnits(slide, 1, undefined, run({ slices: 0, checks: 0 }))).toMatchObject({
      made: 0,
      left: unitsOfSlide(slide, 1).length,
    });
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const units = unitsOfSlide(slide, 1);
    expect(units.length).toBeGreaterThanOrEqual(2);
    const pins: string[] = [];
    // Past the wait after the first unit, nothing more is started this time.
    let clock = 0;
    const one = await prepareSlideUnits(
      slide,
      1,
      undefined,
      { ...run({ slices: 0, checks: 0 }), now: () => (clock += 100) },
      { waitMs: 150, pin: (k) => pins.push(k) },
    );
    expect(one).toMatchObject({ units: units.length, made: 1, left: units.length - 1 });
    expect(pins).toEqual([units[0]!.key]);
    // The next job goes on; what is ready is only pinned.
    const all = await prepareSlideUnits(slide, 1, undefined, run({ slices: 0, checks: 0 }), {
      pin: (k) => pins.push(k),
    });
    expect(all).toMatchObject({ made: units.length - 1, ready: 1, left: 0 });
    expect(pins).toEqual([units[0]!.key, ...units.map((u) => u.key)]);
    expect(unitCache.bytes('unit')).toBe(units.reduce((n, u) => n + u.bytes, 0));
  });

  it('makes no unit for an object no task could draw: it keeps its legacy copy', () => {
    // A 500 px outline on a zigzag: past GEOM_COST.slide alone.
    const hostile = busySlide({ stroke: { width: 500, color: { r: 0, g: 0, b: 0, a: 1 } } });
    const objects = objectsOf(hostile);
    expect(overGeomBudget(objects).size).toBeGreaterThan(0);
    for (const o of overGeomBudget(objects)) expect(unitOf(o, 1)).toBeUndefined();
    expect(slideUnits(objects, 1)).toEqual([]);
  });
});
