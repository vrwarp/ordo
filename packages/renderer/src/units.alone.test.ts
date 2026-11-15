import type { ShapeObject, Slide } from '@ordo/domain';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clampSlide } from './clamp.ts';
import { drawableContent } from './content.ts';
import { charged, GEOM_COST } from './geom/cost.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { drawnCost, slideBudget } from './geombudget.ts';
import { geomSlices } from './shape.ts';
import { type TraceCtx, traceCtx } from './trace.test-util.ts';
import { loneChain } from './units.effects.test-util.ts';
import {
  clearUnits,
  makeUnit,
  SLICE_MS,
  SLICE_UNITS,
  slideUnits,
  slideUnitsLeft,
  unitReady,
} from './units.ts';

/*
 * Lone geometry in slices (r2a must c(1); design/14 "Effect units"): a geometry past `GEOM_COST.slide` on its own
 * is a 'sliced' unit, one group of sub-paths a step; one sub-path past the per-call bound keeps its legacy copy
 * (census `unitsAlone`, a failure anywhere).
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterEach(() => {
  clearUnits();
  vi.unstubAllGlobals();
  vi.stubGlobal('Path2D', RecPath);
});

const objectsOf = (s: Slide) => drawableContent(clampSlide(s)).objects;

class FakeOffscreenCanvas {
  static made: FakeOffscreenCanvas[] = [];
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
    FakeOffscreenCanvas.made.push(this);
  }
  getContext() {
    return this.ctx;
  }
  transferToImageBitmap() {
    return { width: this.width, height: this.height, close() {} };
  }
}

describe('lone geometry in slices', () => {
  it('draws a thin chain past GEOM_COST.slide on its own from a sliced unit, one group of rings a step', async () => {
    const slide: Slide = { id: 'chain', objects: [loneChain()] };
    const objects = objectsOf(slide);
    const chain = objects[0]!;
    expect(charged(drawnCost(chain))).toBeGreaterThan(GEOM_COST.slide);
    // Its legacy copy is its legacy shape (here the box's outline; the converter writes a line, which draws
    // nothing for an outline-only chain): 62a1c3a left it there ('alone').
    expect((slideBudget(objects).get(chain) as ShapeObject).geom).toBeUndefined();
    expect(slideUnitsLeft(objects, 2)).toEqual([]);
    const [u] = slideUnits(objects, 2);
    expect(u).toMatchObject({ kind: 'sliced', of: 'shape', object: chain });
    // Made on the frame's scratch, one stroke a step (each group within SLICE_UNITS), in turns of the clock.
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.made = [];
    let clock = 0;
    const turns: number[] = [];
    const longest = await makeUnit(u!, {
      slice: async (fn) => {
        const t0 = clock;
        const out = fn();
        turns.push(clock - t0);
        return out;
      },
      check: () => {},
      // Every reading of the clock is a millisecond: a turn takes steps until half of SLICE_MS has gone.
      now: () => clock++,
    });
    expect(longest).toBeDefined();
    expect(unitReady(u!)).toBeDefined();
    const scratch = FakeOffscreenCanvas.made.find((c) => c.width === 3840 && c.height === 2160)!;
    const strokes = scratch.ctx.trace.filter((e) => e[0] === 'call' && e[1] === 'stroke').length;
    // One stroke a group of rings, each group's estimate within SLICE_UNITS (half of SLICE_MS at 4K).
    const groups = geomSlices(chain as ShapeObject, SLICE_UNITS)!;
    expect(groups.length).toBeGreaterThan(1);
    expect(strokes).toBe(groups.length);
    for (const c of groups) expect(c).toBeLessThanOrEqual(SLICE_UNITS);
    expect(turns.length).toBeGreaterThan(1);
    expect(Math.max(...turns)).toBeLessThanOrEqual(SLICE_MS);
  });

  it('keeps the legacy copy of one sub-path past the per-call bound: no call within a task draws it', () => {
    // A zigzag of one sub-path stroked 500 px wide: its one outline alone is past GEOM_COST.geometry.
    let d = 'M 1000 1000';
    for (let k = 1; k < 250; k++) {
      const a = (k / 250) * Math.PI * 2 * 37;
      const r = k % 2 ? 1000 : 50;
      d += ` L ${(1000 + r * Math.cos(a)).toFixed(1)} ${(1000 + r * Math.sin(a)).toFixed(1)}`;
    }
    const hostile: ShapeObject = {
      id: 'h',
      type: 'shape',
      box: { x: 100, y: 50, w: 1600, h: 900, rotation: 0 },
      shape: 'rect',
      fill: { r: 0, g: 0, b: 0, a: 1 },
      opacity: 1,
      radius: 0,
      stroke: { width: 500, color: { r: 0, g: 0, b: 0, a: 1 } },
      geom: { paths: [{ d: `${d} Z`, w: 2000, h: 2000 }] },
    };
    const objects = objectsOf({ id: 'h', objects: [hostile] });
    expect(slideUnits(objects, 1)).toEqual([]);
    expect(slideUnitsLeft(objects, 1)).toEqual(['alone']);
  });
});
