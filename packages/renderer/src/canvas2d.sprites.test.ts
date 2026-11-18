import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Canvas2DCompositor } from './canvas2d.ts';
import type { FrameInputs } from './compositor.ts';
import { LAYERS, LAYER_INDEX, LayerStack, SRC_BITMAP, type StackContent } from './stacks.ts';

/**
 * M7 on the Canvas 2D compositor (design/27 §7.3): tight sprites are drawn 1:1 at their offsets, a
 * crossfade of sprites is mixed only within the rect they cover, and a full-frame opaque layer at full
 * weight is drawn with 'copy' with neither the clear nor the layers under it drawn. Contexts are recorders.
 */

type Call = [string, ...unknown[]];
let log: Record<string, Call[]>;
let made = 0;

function recorder(name: string): Record<string, unknown> {
  const calls: Call[] = [];
  log[name] = calls;
  const state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
  return new Proxy(state, {
    get: (t, k) => {
      if (typeof k !== 'string') return undefined;
      if (k in t) return t[k];
      return (...args: unknown[]) => calls.push([k, ...args.map((a) => (a as { tag?: string })?.tag ?? a)]);
    },
    set: (t, k, v) => {
      if (typeof k !== 'string') return false;
      t[k] = v;
      calls.push([`${k}=`, v]);
      return true;
    },
  });
}

const W = 1920;
const H = 1080;
const bitmap = (tag: string, w = W, h = H) =>
  ({ tag, width: w, height: h, close: () => undefined }) as unknown as ImageBitmap;

function compositor(): Canvas2DCompositor {
  const ctx = recorder('main');
  return new Canvas2DCompositor({ getContext: () => ctx } as unknown as OffscreenCanvas, W, H);
}

function inputs(): FrameInputs {
  return {
    layers: LAYERS.map(() => new LayerStack<ImageBitmap>()),
    video: { frames: [null, null, null, null], version: new Int32Array(4), gen: new Int32Array(4).fill(-1) },
    now: 0,
    clear: new Float32Array([0, 0, 0, 1]),
    testPixel: new Int32Array([-1, 0, 0]),
  };
}

function show(f: FrameInputs, l: number, c: StackContent<ImageBitmap>): void {
  f.layers[l]!.offer(c);
  f.layers[l]!.requestFlip(c.key, 0, 0, 0);
  f.layers[l]!.tick(0, 16);
}

const drawsOf = (name: string) =>
  (log[name] ?? []).filter((c) => c[0] === 'drawImage' || c[0] === 'fillRect' || c[0] === 'clearRect');

beforeEach(() => {
  log = {};
  made = 0;
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      readonly name = ['scratch', 'scene', 'mask'][made++] ?? 'canvas';
      private ctx = recorder(this.name);
      tag = this.name;
      getContext() {
        return this.ctx;
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Canvas 2D sprites and opaque layers', () => {
  it('draws a sprite 1:1 at its offset', () => {
    const c = compositor();
    const f = inputs();
    show(f, LAYER_INDEX.slide, {
      key: 'S',
      kind: SRC_BITMAP,
      bitmap: bitmap('band', 800, 200),
      x: 100,
      y: 700,
    });
    c.draw(f);
    expect(drawsOf('main')).toEqual([
      ['fillRect', 0, 0, W, H],
      ['drawImage', 'band', 100, 700, 800, 200],
    ]);
  });

  it('mixes a crossfade of two sprites only within the rect they cover', () => {
    const c = compositor();
    const f = inputs();
    const ls = f.layers[LAYER_INDEX.slide]!;
    show(f, LAYER_INDEX.slide, { key: 'A', kind: SRC_BITMAP, bitmap: bitmap('a', 400, 100), x: 100, y: 800 });
    ls.offer({ key: 'B', kind: SRC_BITMAP, bitmap: bitmap('b', 600, 150), x: 300, y: 700 });
    ls.requestFlip('B', 1000, 1000, 0);
    ls.tick(1000, 16);
    f.now = 1500;
    c.draw(f);
    expect(drawsOf('scratch')).toEqual([
      ['clearRect', 100, 700, 800, 200],
      ['drawImage', 'a', 100, 800, 400, 100],
      ['drawImage', 'b', 300, 700, 600, 150],
    ]);
    expect(drawsOf('main').at(-1)).toEqual(['drawImage', 'scratch', 100, 700, 800, 200, 100, 700, 800, 200]);
  });

  it('copies an opaque full-frame layer without the clear or the layers under it', () => {
    const c = compositor();
    const f = inputs();
    show(f, LAYER_INDEX.background, { key: 'bg', kind: SRC_BITMAP, bitmap: bitmap('bg') });
    show(f, LAYER_INDEX.slide, { key: 'photo', kind: SRC_BITMAP, bitmap: bitmap('photo'), opaque: true });
    show(f, LAYER_INDEX.props, {
      key: 'p',
      kind: SRC_BITMAP,
      bitmap: bitmap('clock', 200, 80),
      x: 1700,
      y: 20,
    });
    c.draw(f);
    const main = log.main!;
    const at = main.findIndex((x) => x[0] === 'drawImage');
    expect(main[at - 1]).toEqual(['globalCompositeOperation=', 'copy']);
    expect(drawsOf('main')).toEqual([
      ['drawImage', 'photo', 0, 0, W, H],
      ['drawImage', 'clock', 1700, 20, 200, 80],
    ]);
  });

  it('draws an opaque layer like any other while it fades', () => {
    const c = compositor();
    const f = inputs();
    const ls = f.layers[LAYER_INDEX.background]!;
    show(f, LAYER_INDEX.background, { key: 'a', kind: SRC_BITMAP, bitmap: bitmap('a'), opaque: true });
    ls.offer({ key: 'b', kind: SRC_BITMAP, bitmap: bitmap('b'), opaque: true });
    ls.requestFlip('b', 1000, 1000, 0);
    ls.tick(1000, 16);
    f.now = 1500;
    c.draw(f);
    expect(drawsOf('main')[0]).toEqual(['fillRect', 0, 0, W, H]);
    expect(drawsOf('main').at(-1)).toEqual(['drawImage', 'scratch', 0, 0]);
  });
});

describe('Canvas 2D in-place fade of late parts (design/14 "Late units", r2b units-live)', () => {
  it('an in-place refresh at mid-fade blends both copies, then draws the fresh one alone', () => {
    const c = compositor();
    const f = inputs();
    const ls = f.layers[LAYER_INDEX.slide]!;
    show(f, LAYER_INDEX.slide, {
      key: 'A',
      kind: SRC_BITMAP,
      bitmap: bitmap('a1', 400, 100),
      x: 100,
      y: 800,
    });
    ls.offer({
      key: 'A',
      kind: SRC_BITMAP,
      bitmap: bitmap('a2', 400, 120),
      x: 100,
      y: 780,
      refresh: true,
      refreshFadeMs: 300,
    });
    ls.tick(1000, 16);
    f.now = 1150;
    c.draw(f);
    // Mixed in the scratch within both copies' rect: the old one at 1 - w, the fresh one at w (0.5).
    expect(drawsOf('scratch')).toEqual([
      ['clearRect', 100, 780, 400, 120],
      ['drawImage', 'a1', 100, 800, 400, 100],
      ['drawImage', 'a2', 100, 780, 400, 120],
    ]);
    const alphas = (log.scratch ?? []).filter((x) => x[0] === 'globalAlpha=').map((x) => x[1]);
    expect(alphas).toEqual([0.5, 0.5]);
    expect(drawsOf('main').at(-1)).toEqual(['drawImage', 'scratch', 100, 780, 400, 120, 100, 780, 400, 120]);
    // Past its end: the fresh copy alone, at full weight.
    ls.tick(1300, 16);
    log.main!.length = 0;
    f.now = 1316;
    c.draw(f);
    expect(drawsOf('main').at(-1)).toEqual(['drawImage', 'a2', 100, 780, 400, 120]);
  });

  it('a GO in the middle of an in-place fade ends it and flips at once, fading out the fresh copy', () => {
    const c = compositor();
    const f = inputs();
    const ls = f.layers[LAYER_INDEX.slide]!;
    show(f, LAYER_INDEX.slide, {
      key: 'A',
      kind: SRC_BITMAP,
      bitmap: bitmap('a1', 400, 100),
      x: 100,
      y: 800,
    });
    ls.offer({ key: 'B', kind: SRC_BITMAP, bitmap: bitmap('b', 400, 100), x: 100, y: 100 });
    ls.offer({
      key: 'A',
      kind: SRC_BITMAP,
      bitmap: bitmap('a2', 400, 100),
      x: 100,
      y: 800,
      refresh: true,
      refreshFadeMs: 300,
    });
    ls.tick(1000, 16);
    ls.requestFlip('B', 1100, 300, 1090);
    expect(ls.tick(1100, 16)).toBe(true);
    f.now = 1250;
    c.draw(f);
    const drawn = drawsOf('scratch')
      .filter((x) => x[0] === 'drawImage')
      .map((x) => x[1]);
    expect(drawn).toEqual(['a2', 'b']);
  });
});
