import { LOOK_MAIN, type Look, type ShapeObject, type Slide } from '@ordo/domain';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import {
  clampSlide,
  clearGeomFiles,
  clearUnits,
  drawableContent,
  drawSlide2D,
  overGeomBudget,
  unitCache,
  unitsOfSlide,
  unitWork,
} from '@ordo/renderer';
import { RecPath } from '@ordo/renderer/geom/path2d.test-util.ts';
import { lineArtSlide } from '@ordo/renderer/units.test-util.ts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type PrepareHost, prepareSlides, prepareSteps } from './index.ts';
import { geometryUnits, holdUnits, setGeometryUnits } from './units.ts';

/*
 * The geometry units prepare step (design/27 §12-13, M9 "Slow-to-draw elements", Runtime): each object a slide's
 * drawing budget sends to its legacy copy is drawn whole into a unit in the job's turns, so the draw that follows
 * copies it.
 */

/** A 2D context that records draw calls; a one-pixel read (each step's flush) takes `stepMs`. */
function fakeCtx(ops: string[], stepMs: () => number) {
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 };
  return new Proxy(state, {
    get(t, k) {
      if (k === 'getImageData')
        return () => {
          const until = performance.now() + stepMs();
          while (performance.now() < until) {
            /* a slow machine's step */
          }
          return { data: new Uint8ClampedArray(4) };
        };
      if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      if (k === 'measureText') return (t: string) => ({ width: t.length * 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k in t) return t[k];
      return (...args: unknown[]) => {
        if (k === 'fill' || k === 'stroke' || k === 'drawImage') ops.push(String(k));
        if (k === 'drawImage') ops.push(`image:${(args[0] as { tag?: string }).tag ?? ''}`);
      };
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
    has: () => true,
  });
}

let stepMs = 0;
class FakeOffscreenCanvas {
  static made: FakeOffscreenCanvas[] = [];
  readonly ops: string[] = [];
  width: number;
  height: number;
  private ctx = fakeCtx(this.ops, () => stepMs);
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    FakeOffscreenCanvas.made.push(this);
  }
  getContext() {
    return this.ctx;
  }
  transferToImageBitmap() {
    return { tag: `unit ${this.width}x${this.height}`, width: this.width, height: this.height, close() {} };
  }
}

beforeAll(() => {
  vi.stubGlobal('Path2D', RecPath);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
});

afterEach(() => {
  stepMs = 0;
  setGeometryUnits(true);
  clearUnits();
  clearGeomFiles();
  FakeOffscreenCanvas.made = [];
});

/** A host that runs slices at once and counts them and its checks. */
function host(log: { slices: number; checks: number }, read: PrepareHost['read'] = async () => undefined) {
  return {
    read,
    slice: async <T>(fn: () => T) => {
      log.slices++;
      return fn();
    },
    check: () => {
      log.checks++;
    },
  } satisfies PrepareHost;
}

const objectsOf = (s: Slide) => drawableContent(clampSlide(s)).objects;

describe('the geometry units prepare step (M9 Slow-to-draw, Runtime)', () => {
  it('is registered after the geometry files: a unit draws what they hold', () => {
    const names = prepareSteps().map((s) => s.name);
    expect(names.indexOf('geometry units')).toBeGreaterThan(names.indexOf('geometry files'));
    expect(names.at(-1)).toBe('geometry units');
  });

  it('makes the units of a slide past the budget in slices of its turns, and the draw then copies them', async () => {
    const slide = lineArtSlide();
    const units = unitsOfSlide(slide, 2);
    expect(units.length).toBe(overGeomBudget(objectsOf(slide)).size);
    expect(units.length).toBeGreaterThanOrEqual(2);
    // Each step (the frame's scratch, a draw call, the copy) takes 3 ms: about two steps a turn.
    stepMs = 3;
    const log = { slices: 0, checks: 0 };
    const before = unitWork();
    expect(await geometryUnits.run({ slides: [slide], scale: 2 }, host(log))).toBeUndefined();
    const work = unitWork();
    expect(work.made - before.made).toBe(units.length);
    // The plan (one turn), then the units' turns.
    expect(log.slices).toBe(1 + work.turns - before.turns);
    expect(log.slices).toBeGreaterThan(units.length);
    expect(log.slices).toBeLessThan(work.steps - before.steps);
    expect(log.checks).toBeGreaterThanOrEqual(log.slices);
    // The draw copies each unit where the budget draws the legacy copy, and draws no legacy copy.
    const out = new FakeOffscreenCanvas(3840, 2160);
    drawSlide2D(out.getContext() as unknown as OffscreenCanvasRenderingContext2D, slide, { scale: 2 });
    expect(out.ops.filter((o) => o.startsWith('image:unit'))).toEqual(
      units.map((u) => `image:unit ${u.rect.w}x${u.rect.h}`),
    );
    // Made again for the same slide (the GO after an arm): nothing is drawn, one turn plans it.
    const again = { slices: 0, checks: 0 };
    await geometryUnits.run({ slides: [slide], scale: 2 }, host(again));
    expect(unitWork().made).toBe(work.made);
    expect(again.slices).toBe(1);
  });

  it('makes nothing for a slide within the budget, a look that does not draw it, or when turned off', async () => {
    // A slide within the budget: its plan only (one turn).
    const calm: Slide = { id: 'calm', objects: lineArtSlide().objects.slice(0, 2) };
    const planned = { slices: 0, checks: 0 };
    await geometryUnits.run({ slides: [calm], scale: 1 }, host(planned));
    expect(planned).toEqual({ slices: 1, checks: 0 });
    const log = { slices: 0, checks: 0 };
    const hidden = { ...LOOK_MAIN, layers: { ...LOOK_MAIN.layers, slide: { mode: 'hidden' } } } as Look;
    await geometryUnits.run({ slides: [lineArtSlide()], scale: 1, look: hidden }, host(log));
    setGeometryUnits(false);
    await geometryUnits.run({ slides: [lineArtSlide()], scale: 1 }, host(log));
    expect(log).toEqual({ slices: 0, checks: 0 });
    expect(unitCache.count('unit')).toBe(0);
  });

  it('stops at a cancelled job between turns of a unit and keeps nothing', async () => {
    const slide = lineArtSlide();
    // Two steps a turn: the first unit is cancelled after its first turn.
    stepMs = 3;
    let n = 0;
    const cancelled: PrepareHost = {
      ...host({ slices: 0, checks: 0 }),
      check: () => {
        if (++n > 1) throw new Error('cancelled');
      },
    };
    await expect(geometryUnits.run({ slides: [slide], scale: 1 }, cancelled)).rejects.toThrow('cancelled');
    expect(unitCache.count('unit')).toBe(0);
  });

  it('a geometry file the hub lacks makes no unit: the slide draws its legacy copies, nothing throws', async () => {
    const ref = 'f'.repeat(64);
    const slide: Slide = {
      ...lineArtSlide(),
      objects: lineArtSlide().objects.map((o) =>
        o.type === 'shape' ? ({ ...o, geom: { ref } } as ShapeObject) : o,
      ),
    };
    const log = { slices: 0, checks: 0 };
    // The whole registry, as a job runs it: the geometry files step reports the file missing.
    const missing = await prepareSlides({ slides: [slide], scale: 1 }, host(log));
    expect(missing).toEqual([ref]);
    expect(unitCache.count('unit')).toBe(0);
    // Read once the file arrives (a retry, past the wait after a miss): the next job makes its units.
    const file = (lineArtSlide().objects[0] as ShapeObject).geom!;
    const read = async () => ({ size: 10, text: async () => JSON.stringify(file) }) as unknown as Blob;
    clearGeomFiles();
    expect(await prepareSlides({ slides: [slide], scale: 1 }, host(log, read))).toEqual([]);
    expect(unitCache.count('unit')).toBeGreaterThan(0);
  });

  it('bounds hostile slides: a slide copies at most one frame of units, and a job stops after its wait', async () => {
    // Two hundred line-art shapes pushed far past the frame (clamped), each a frame-sized unit at 4K.
    const art = lineArtSlide().objects[1] as ShapeObject;
    const slide: Slide = {
      id: 'hostile',
      objects: Array.from({ length: 200 }, (_, i) => ({
        ...art,
        id: `h${i}`,
        box: { x: -1e9, y: -1e9 + i, w: 1e12, h: Number.NaN, rotation: Number.POSITIVE_INFINITY },
      })) as Slide['objects'],
    };
    const units = unitsOfSlide(slide, 2);
    for (const u of units) {
      expect(u.rect.x + u.rect.w).toBeLessThanOrEqual(3840);
      expect(u.rect.y + u.rect.h).toBeLessThanOrEqual(2160);
    }
    const t0 = performance.now();
    await geometryUnits.run({ slides: [slide], scale: 2 }, host({ slices: 0, checks: 0 }));
    expect(performance.now() - t0).toBeLessThan(budgetMs(2_000));
    expect(unitCache.bytes('unit')).toBeLessThanOrEqual(3840 * 2160 * 4);
  });

  it('pins what a job makes or finds until it lets it go, and only for a host that holds them', async () => {
    const slide = lineArtSlide();
    const h = host({ slices: 0, checks: 0 });
    const hold = holdUnits(h);
    await geometryUnits.run({ slides: [slide], scale: 1 }, h);
    const keys = unitsOfSlide(slide, 1).map((u) => u.key);
    expect([...hold.keys]).toEqual(keys);
    expect(unitCache.pinned).toBe(keys.length);
    // Another job of the same slide finds them ready and holds them too.
    const h2 = host({ slices: 0, checks: 0 });
    const hold2 = holdUnits(h2);
    await geometryUnits.run({ slides: [slide], scale: 1 }, h2);
    expect([...hold2.keys]).toEqual(keys);
    hold.release();
    hold.release();
    expect(unitCache.pinned).toBe(keys.length);
    hold2.release();
    expect(unitCache.pinned).toBe(0);
    // A host nobody holds (the thumbnail worker) pins nothing.
    clearUnits();
    await geometryUnits.run({ slides: [slide], scale: 1 }, host({ slices: 0, checks: 0 }));
    expect(unitCache.pinned).toBe(0);
    expect(unitCache.count('unit')).toBe(keys.length);
  });
});
