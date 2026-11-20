import type { ShapeObject, SlideObject } from '@ordo/domain';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  clearFrameWork,
  dropFrameWork,
  FRAME_BUDGET_MS,
  FRAME_WORK_MAX,
  type FramePictures,
  frameIncomplete,
  frameKey,
  frameProgress,
  frameStats,
  frameUnit,
  frameWorkBytes,
  framesInProgress,
  makeFrame,
  setFrames,
  splitFrame,
} from './frame.ts';
import { picture, slideOf, squares } from './frame.test-util.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { type TraceCtx, traceCtx } from './trace.test-util.ts';
import { loneChain, panel } from './units.effects.test-util.ts';
import { clearUnits, SLICE_MS, unitCache, unitUnmade } from './units.ts';

/*
 * Making the frame (frame.ts `makeFrame`): in turns within the slice, one object a step, resumable by key, one
 * picture held at a time, its heavy objects through units of their own, kept in the unit cache like any unit.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterEach(() => {
  clearUnits();
  clearFrameWork();
  setFrames(true);
  vi.unstubAllGlobals();
  vi.stubGlobal('Path2D', RecPath);
});

/** A canvas standing in for OffscreenCanvas: a trace context without pixels, its bitmap a record of its size. */
class FakeOffscreenCanvas {
  static made: FakeOffscreenCanvas[] = [];
  readonly width: number;
  readonly height: number;
  readonly ctx: TraceCtx;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    const t = traceCtx(w, h);
    (t as unknown as { getImageData: unknown }).getImageData = () => ({ data: new Uint8ClampedArray(4) });
    this.ctx = new Proxy(t, { get: (target, k) => (k === 'canvas' ? this : Reflect.get(target, k)) });
    FakeOffscreenCanvas.made.push(this);
  }
  getContext() {
    return this.ctx;
  }
  transferToImageBitmap() {
    return { width: this.width, height: this.height, close() {} };
  }
}

/** A lane's turns on an injected clock: every reading of the clock is `tick` ms, so a turn takes what its steps read. */
function runner(o: { tick?: number; cancelAfter?: number } = {}) {
  const log = { slices: 0, checks: 0, turns: [] as number[], clock: 0 };
  const run = {
    slice: async <T>(fn: () => T): Promise<T> => {
      log.slices++;
      const t0 = log.clock;
      const out = fn();
      log.turns.push(log.clock - t0);
      return out;
    },
    check: () => {
      log.checks++;
      if (o.cancelAfter !== undefined && log.slices >= o.cancelAfter) throw new Error('Cancelled');
    },
    now: () => (log.clock += o.tick ?? 1),
  };
  return { run, log };
}

const fills = (c: FakeOffscreenCanvas) =>
  c.ctx.trace.filter((e) => e[0] === 'call' && e[1] === 'fill').length;
const frameCanvases = (w: number) => FakeOffscreenCanvas.made.filter((c) => c.width === w);

/** The split of 340 squares (the bottom 140 are the frame) at `scale`. */
function crowded(extra: SlideObject[] = [], scale = 1) {
  const f = splitFrame(slideOf([...extra, ...squares(340)]), scale)!;
  expect(f).toBeDefined();
  return f;
}

describe('makeFrame', () => {
  it('runs in turns within the slice: a 340-object frame is more than 40 turns, none past SLICE_MS', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.made = [];
    const split = crowded();
    const key = frameKey(split);
    const { run, log } = runner();
    const longest = await makeFrame(split, key, run);
    expect(longest).toBeDefined();
    expect(unitCache.has('unit', key)).toBe(true);
    const turns = log.turns.filter((t) => t > 0);
    expect(turns.length).toBeGreaterThan(40);
    expect(Math.max(...turns)).toBeLessThanOrEqual(SLICE_MS);
    expect(longest).toBeLessThanOrEqual(SLICE_MS);
    // one square a step: each of the frame's squares drawn once on the scratch
    const scratch = frameCanvases(1920)[0]!;
    expect(fills(scratch)).toBe(split.under.length);
    // the scratch was the frame: the work state is gone, the unit is in the cache at the frame's size
    expect(framesInProgress()).toBe(0);
    expect(unitCache.get('unit', key)).toMatchObject({ w: 1920, h: 1080, bytes: 1920 * 1080 * 4 });
    expect(frameStats().made).toBe(1);
    // The longest turn and the longest single step the frame took (what M2 and M5 read, and a step over 50 ms is D11's).
    expect(frameStats().longestTurn).toBe(longest);
    expect(frameStats().longestStep).toBeGreaterThan(0);
    expect(frameStats().longestStep).toBeLessThanOrEqual(longest!);
  });

  it('is made once each step across a stop and a resume, and a cancelled call keeps the cache empty but its work', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.made = [];
    const split = crowded();
    const key = frameKey(split);
    const fresh = runner();
    await makeFrame(split, key, fresh.run);
    const freshSlices = fresh.log.slices;
    unitCache.delete('unit', key);
    clearFrameWork();
    FakeOffscreenCanvas.made = [];
    // the first call is hurried after 30 turns
    const first = runner({ cancelAfter: 30 });
    await expect(makeFrame(split, key, first.run)).rejects.toThrow('Cancelled');
    expect(unitCache.has('unit', key)).toBe(false);
    const progress = frameProgress(key)!;
    expect(progress.done).toBeGreaterThan(20);
    expect(progress.done).toBeLessThan(split.under.length);
    // the next call resumes at the step it stopped, and finishes in fewer turns than a fresh one
    const second = runner();
    await makeFrame(split, key, second.run);
    expect(unitCache.has('unit', key)).toBe(true);
    expect(second.log.slices).toBeLessThan(freshSlices);
    expect(second.log.slices + first.log.slices).toBeLessThanOrEqual(freshSlices + 2);
    // every square drawn exactly once on the one scratch (none made again after the resume)
    expect(frameCanvases(1920)).toHaveLength(1);
    expect(fills(frameCanvases(1920)[0]!)).toBe(split.under.length);
    expect(frameStats().resumed).toBe(1);
  });

  it('keeps at most FRAME_WORK_MAX frames in progress, the oldest dropped, and says their bytes', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.made = [];
    const keys: string[] = [];
    for (let i = 0; i < FRAME_WORK_MAX + 1; i++) {
      const objs = squares(340).map((o) => ({ ...o, opacity: 0.5 + i * 0.1 }) as ShapeObject);
      const split = splitFrame(slideOf(objs, `w${i}`), 1)!;
      const key = frameKey(split);
      keys.push(key);
      await expect(makeFrame(split, key, runner({ cancelAfter: 2 }).run)).rejects.toThrow('Cancelled');
    }
    expect(framesInProgress()).toBe(FRAME_WORK_MAX);
    expect(frameProgress(keys[0]!)).toBeUndefined();
    expect(frameProgress(keys[1]!)).toBeDefined();
    expect(frameProgress(keys[2]!)).toBeDefined();
    expect(frameWorkBytes()).toBe(FRAME_WORK_MAX * 1920 * 1080 * 4);
    dropFrameWork(keys[1]!);
    expect(framesInProgress()).toBe(FRAME_WORK_MAX - 1);
  });

  it('drops a frame past FRAME_BUDGET_MS, counted, and remembers it as unmade (the slide keeps its direct part)', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.made = [];
    expect(FRAME_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
    const split = crowded();
    const key = frameKey(split);
    // every clock reading is 400 ms: the turns add up to past the budget long before the 340 steps are done
    const { run } = runner({ tick: 400 });
    const r = await makeFrame(split, key, run);
    expect(r).toBeUndefined();
    expect(unitCache.has('unit', key)).toBe(false);
    expect(unitUnmade(key)).toBe(true);
    expect(framesInProgress()).toBe(0);
    expect(frameStats().over).toBe(1);
  });

  it('is unmade, not an error, where no canvas can be made', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const split = crowded();
    const key = frameKey(split);
    expect(await makeFrame(split, key, runner().run)).toBeUndefined();
    expect(unitUnmade(key)).toBe(true);
  });
});

describe('a frame with pictures', () => {
  /** A picture provider that counts what it holds. */
  function provider(missing: string[] = []) {
    const p = {
      held: 0,
      maxHeld: 0,
      released: 0,
      acquired: [] as string[],
      missing: new Set(missing),
      arrived: false,
      async acquire(o: { id: string; mediaId: string }) {
        p.held++;
        p.maxHeld = Math.max(p.maxHeld, p.held);
        p.acquired.push(o.id);
        const miss = p.missing.has(o.mediaId);
        const bmp = { width: 64, height: 64, close() {} };
        return {
          lookup: () => (miss ? undefined : (bmp as never)),
          release: () => {
            p.held--;
            p.released++;
          },
          ...(miss ? { missing: o.mediaId } : {}),
        };
      },
      async arrivedFiles() {
        return p.arrived;
      },
    };
    return p;
  }
  const pics = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      picture(`p${i}`, `m${i % 12}`, {
        x: 10 + (i % 10) * 180,
        y: 10 + Math.floor(i / 10) * 120,
        w: 170,
        h: 110 + (i % 5),
      }),
    );
  const split = () => splitFrame(slideOf([...pics(40), ...squares(300)], 'pics'), 1)!;

  it('holds one bitmap at a time, releases each after its draw, and draws every picture of the frame', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.made = [];
    const s = split();
    const p = provider();
    const key = frameKey(s);
    await makeFrame(s, key, runner().run, { pictures: p as unknown as FramePictures });
    expect(p.acquired).toHaveLength(s.under.filter((o) => o.type === 'image').length);
    expect(p.maxHeld).toBe(1);
    expect(p.held).toBe(0);
    expect(p.released).toBe(p.acquired.length);
    const scratch = frameCanvases(1920)[0]!;
    expect(scratch.ctx.trace.filter((e) => e[0] === 'call' && e[1] === 'drawImage')).toHaveLength(
      p.acquired.length,
    );
    expect(frameIncomplete(key)).toBe(false);
  });

  it('releases the held bitmap when the job is cancelled mid-picture, and resumes at that picture', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.made = [];
    const s = split();
    const p = provider();
    const key = frameKey(s);
    await expect(
      makeFrame(s, key, runner({ cancelAfter: 3 }).run, { pictures: p as unknown as FramePictures }),
    ).rejects.toThrow('Cancelled');
    expect(p.held).toBe(0);
    const done = frameProgress(key)!.done;
    await makeFrame(s, key, runner().run, { pictures: p as unknown as FramePictures });
    // the pictures drawn before the stop were not drawn again
    const total = s.under.filter((o) => o.type === 'image').length;
    expect(p.acquired.length).toBeGreaterThanOrEqual(total);
    expect(p.acquired.length).toBeLessThanOrEqual(total + 1);
    expect(done).toBeGreaterThan(0);
  });

  it('reports a missing picture, skips it this time and makes the frame again once its file has arrived', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.made = [];
    const s = split();
    const p = provider(['m3']);
    const opts = {
      pictures: { acquire: p.acquire, arrived: async () => p.arrived } as unknown as FramePictures,
    };
    const unit = frameUnit(s, opts);
    expect(await unit.ready()).toBe(false);
    expect(await unit.make(runner().run)).toBeDefined();
    // it is in the cache but flagged: ready while the file has not arrived
    expect(frameIncomplete(unit.key)).toBe(true);
    expect(await unit.ready()).toBe(true);
    expect(unitCache.has('unit', unit.key)).toBe(true);
    // the file arrives: the frame is forgotten, so it is made again with the picture
    p.arrived = true;
    p.missing.clear();
    expect(await unit.ready()).toBe(false);
    expect(unitCache.has('unit', unit.key)).toBe(false);
    expect(frameIncomplete(unit.key)).toBe(false);
    await unit.make(runner().run);
    expect(await unit.ready()).toBe(true);
    expect(frameIncomplete(unit.key)).toBe(false);
  });
});

describe('a frame with objects past the budget by themselves', () => {
  it('draws a lone chain through its own unit in steps and copies it into the frame in bands', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.made = [];
    const chain = loneChain();
    const split = splitFrame(slideOf([chain, ...squares(300)], 'chain'), 2)!;
    expect(split.under[0]).toBe(split.slide.objects.find((o) => o.id === chain.id));
    const key = frameKey(split);
    const { run, log } = runner();
    expect(await makeFrame(split, key, run)).toBeDefined();
    expect(unitCache.has('unit', key)).toBe(true);
    // the chain's strokes were drawn on a canvas of their own, group by group, never on the frame itself ...
    const strokesOn = (c: FakeOffscreenCanvas) =>
      c.ctx.trace.filter((e) => e[0] === 'call' && e[1] === 'stroke').length;
    const canvases = FakeOffscreenCanvas.made;
    const frame = canvases[0]!;
    expect(strokesOn(frame)).toBe(0);
    expect(canvases.slice(1).reduce((n, c) => n + strokesOn(c), 0)).toBeGreaterThan(1);
    // ... and copied into it, source-over, in more than one band
    const copies = frame.ctx.trace.filter((e) => e[0] === 'call' && e[1] === 'drawImage');
    expect(copies.length).toBeGreaterThan(1);
    expect(Math.max(...log.turns)).toBeLessThanOrEqual(SLICE_MS);
  });

  it('draws a shadowed panel past the effect budget by itself from its unit, its body live over it when layered', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.made = [];
    const panels: SlideObject[] = [];
    for (let i = 0; i < 6; i++) panels.push(panel(`pa${i}`, 100 + i * 20, 80 + i * 20, 1400, 800, i));
    const split = splitFrame(slideOf([...panels, ...squares(300)], 'panels'), 2)!;
    const key = frameKey(split);
    expect(await makeFrame(split, key, runner().run)).toBeDefined();
    expect(unitCache.has('unit', key)).toBe(true);
  });
});
