import { DECOR_LIMITS, type Slide } from '@ordo/domain';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clampSlide } from '../clamp.ts';
import { drawableContent } from '../content.ts';
import { RecPath } from '../geom/path2d.test-util.ts';
import { drawSlide2D } from '../text2d.ts';
import { type TraceCtx, traceCtx } from '../trace.test-util.ts';
import {
  clearUnits,
  DECOR_TURN_SHAPES,
  makeUnit,
  SLICE_MS,
  slideUnitsLeft,
  unitReady,
  unitsOfSlide,
} from '../units.ts';
import { DECOR_SPRITE, decorShapeCount, decorShapes } from './index.ts';
import { cappedSlide } from './test-util.ts';

/*
 * A decoration past `DECOR_SPRITE` on the outputs (r2a must a1, a2; design/14 "Effect units"): a whole unit made
 * by `drawDecorRange`, one source shape a step, at most `DECOR_TURN_SHAPES` a turn, each turn within `SLICE_MS`;
 * with drawSlide2D's `late` option (an output raster) a capped decoration whose unit is not ready is left out and
 * reported, never drawn directly (one call of about 100-115 ms at 3840).
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterEach(() => {
  clearUnits();
  vi.unstubAllGlobals();
  vi.stubGlobal('Path2D', RecPath);
});

const objectsOf = (s: Slide) => drawableContent(clampSlide(s)).objects;

/**
 * The work clock: 0.15 ms of the injected clock for every draw call recorded on the canvases made (the capped
 * decoration's calls come to about the 100 ms it takes drawn at once at 3840).
 */
let calls = 0;
const clock = () => calls * 0.15;
const counted = new WeakSet<object>();

class FakeOffscreenCanvas {
  readonly width: number;
  readonly height: number;
  readonly ctx: TraceCtx;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.ctx = traceCtx(w, h);
    (this.ctx as unknown as { getImageData: unknown }).getImageData = () => ({
      data: new Uint8ClampedArray(4),
    });
    const trace = this.ctx.trace;
    const push = trace.push.bind(trace);
    trace.push = (...e: Parameters<typeof push>) => {
      for (const x of e) if (x[0] === 'call' && /^(fill|stroke|drawImage)/.test(String(x[1]))) calls++;
      return push(...e);
    };
    counted.add(this);
  }
  getContext() {
    return this.ctx;
  }
  transferToImageBitmap() {
    return { width: this.width, height: this.height, close() {} };
  }
}

describe('decoration units', () => {
  it('makes the capped decoration a whole unit in turns of at most 32 shapes, none past SLICE_MS', async () => {
    const slide = cappedSlide();
    const d = objectsOf(slide)[0]!;
    const geo = decorShapes((d as { decor: Parameters<typeof decorShapes>[0] }).decor);
    expect(geo.points).toBe(DECOR_LIMITS.points);
    expect(geo.shadowed).toBe(DECOR_LIMITS.shadowed);
    expect(geo.points).toBeGreaterThan(DECOR_SPRITE.points);
    // 62a1c3a: no unit, the decoration drawn at once (one call) on every raster.
    const [u] = unitsOfSlide(slide, 2);
    expect(u).toMatchObject({ kind: 'whole', of: 'decor' });
    expect(slideUnitsLeft(objectsOf(slide), 2)).toEqual([]);
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    calls = 0;
    const turns: { shapes: number; ms: number }[] = [];
    let before = 0;
    const longest = await makeUnit(u!, {
      slice: async (fn) => {
        const t0 = clock();
        const out = fn();
        turns.push({ shapes: calls - before, ms: clock() - t0 });
        before = calls;
        return out;
      },
      check: () => {},
      now: clock,
    });
    expect(longest).toBeDefined();
    expect(unitReady(u!)).toBeDefined();
    // Made in many turns (the whole is about 100 ms of the clock), none over SLICE_MS.
    expect(clock()).toBeGreaterThan(5 * SLICE_MS);
    expect(turns.length).toBeGreaterThan(decorShapeCount(d as never) / DECOR_TURN_SHAPES);
    expect(Math.max(...turns.map((t) => t.ms))).toBeLessThanOrEqual(SLICE_MS);
    expect(longest).toBeLessThanOrEqual(SLICE_MS);
  });

  it('with the late option draws nothing of a capped decoration without its unit, and reports it', () => {
    const slide = cappedSlide();
    const [u] = unitsOfSlide(slide, 1);
    expect(u?.of).toBe('decor');
    const late: string[] = [];
    const t = traceCtx(1920, 1080);
    const t0 = performance.now();
    drawSlide2D(t, slide, { scale: 1, late: (k) => late.push(k) });
    const ms = performance.now() - t0;
    expect(late).toEqual([u!.key]);
    expect(t.trace.filter((e) => e[0] === 'call' && /^(fill|stroke)/.test(String(e[1])))).toEqual([]);
    // Left out, the raster draws nothing of it: far within the task (budgetMs for a shared test machine).
    expect(ms).toBeLessThan(budgetMs(50));
    // Without it (a caller that waits: the harness, thumbnails, the editor) it is drawn directly as before.
    const direct = traceCtx(1920, 1080);
    drawSlide2D(direct, slide, { scale: 1 });
    expect(
      direct.trace.filter((e) => e[0] === 'call' && /^(fill|stroke)/.test(String(e[1]))).length,
    ).toBeGreaterThan(200);
  });
});
