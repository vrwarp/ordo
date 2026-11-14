import type { Slide } from '@ordo/domain';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RecPath } from './geom/path2d.test-util.ts';
import { drawSlide2D } from './text2d.ts';
import { traceCtx } from './trace.test-util.ts';
import { clearUnits, prepareSlideUnits, unitCache, unitsOfSlide } from './units.ts';

/*
 * Hostile slides through the geometry units (design/27 §13 "Geometry units"): random shapes of random stored
 * geometries with NaN, infinite, huge and negative boxes, turns and flips, garbage paints and path text, many of
 * them past the slide's drawing budget, are planned, made (on a stand-in canvas) and drawn without a throw, in
 * bounded time; every unit is cut to the frame and a slide's units stay within one frame.
 */

/** A canvas standing in for OffscreenCanvas: a trace context without pixels. */
class FakeOffscreenCanvas {
  readonly width: number;
  readonly height: number;
  private readonly ctx = traceCtx();
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    (this.ctx as unknown as { getImageData: unknown }).getImageData = () => ({
      data: new Uint8ClampedArray(4),
    });
  }
  getContext() {
    return this.ctx;
  }
  transferToImageBitmap() {
    return { width: this.width, height: this.height, close() {} };
  }
}

beforeAll(() => {
  vi.stubGlobal('Path2D', RecPath);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
});
afterAll(() => {
  clearUnits();
  vi.unstubAllGlobals();
});

/** A small deterministic random source. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 2 ** 32;
  };
}

const NASTY = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1e9, 1e12, 0, -0, 1e-12];

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

function num(r: () => number, scale: number): number {
  return r() < 0.2 ? pick(r, NASTY) : (r() - 0.25) * scale;
}

/** A zigzag of `n` points in a w x h space, sometimes with junk tokens. */
function path(r: () => number, n: number): string {
  let d = 'M 0 0';
  for (let k = 0; k < n; k++) d += ` L ${(r() * 2000).toFixed(1)} ${(r() * 2000).toFixed(1)}`;
  if (r() < 0.1) d += ' Q NaN 1e999 C x y z';
  return `${d} Z`;
}

function hostileSlide(seed: number): Slide {
  const r = rng(seed);
  const objects = Array.from({ length: 4 + Math.floor(r() * 40) }, (_, i) => ({
    id: `h${i}`,
    type: 'shape',
    box: { x: num(r, 2400), y: num(r, 1400), w: num(r, 2400), h: num(r, 1400), rotation: num(r, 720) },
    shape: pick(r, ['rect', 'ellipse', 'line', 'bogus']),
    fill: r() < 0.9 ? { r: 0, g: 0, b: 0, a: r() } : 'red',
    stroke: r() < 0.3 ? { width: num(r, 40), color: { r: 1, g: 2, b: 3, a: 1 } } : undefined,
    opacity: r() < 0.9 ? r() : Number.NaN,
    radius: 0,
    flipH: r() < 0.3,
    flipV: r() < 0.3 ? 'yes' : false,
    geom:
      r() < 0.1
        ? { ref: '__proto__' }
        : r() < 0.1
          ? 42
          : { paths: [{ d: path(r, 50 + Math.floor(r() * 3000)), w: num(r, 4000), h: 2000 }] },
    ...(r() < 0.2 ? { shadow: { dx: 4, dy: 4, blur: num(r, 100), color: { r: 0, g: 0, b: 0, a: 1 } } } : {}),
  }));
  return { id: `hostile-${seed}`, objects } as unknown as Slide;
}

describe('geometry units under hostile slides', () => {
  it('plans, makes and draws them without a throw, within the frame, in bounded time', async () => {
    const t0 = performance.now();
    let units = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const slide = hostileSlide(seed);
      for (const scale of [0.1, 1, 2]) {
        const planned = unitsOfSlide(slide, scale);
        const fw = Math.ceil(1920 * scale - 1e-6);
        const fh = Math.ceil(1080 * scale - 1e-6);
        let area = 0;
        for (const u of planned) {
          expect(u.rect.x).toBeGreaterThanOrEqual(0);
          expect(u.rect.y).toBeGreaterThanOrEqual(0);
          expect(u.rect.x + u.rect.w).toBeLessThanOrEqual(fw);
          expect(u.rect.y + u.rect.h).toBeLessThanOrEqual(fh);
          area += u.rect.w * u.rect.h;
        }
        expect(area).toBeLessThanOrEqual(fw * fh);
        units += planned.length;
        await prepareSlideUnits(slide, scale, undefined, { slice: async (fn) => fn(), check: () => {} });
        drawSlide2D(traceCtx(fw, fh), slide, { scale });
      }
    }
    expect(units).toBeGreaterThan(0);
    expect(unitCache.bytes('unit')).toBeLessThanOrEqual(unitCache.budgetBytes);
    expect(performance.now() - t0).toBeLessThan(budgetMs(20_000));
  }, 120_000);
});
