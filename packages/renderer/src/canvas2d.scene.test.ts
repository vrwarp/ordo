import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Canvas2DCompositor } from './canvas2d.ts';
import type { FrameInputs } from './compositor.ts';
import { PLANE_FLOATS, type PlaneSource, encodePlane, planeForward } from './scene.ts';
import { LayerStack, SRC_BITMAP, SRC_SCENE, type StackContent } from './stacks.ts';

/**
 * The Canvas 2D scene drawing (design/27 §7.2, SCENE.md item C) against a recording 2D context: base, the
 * video through its plane (transform, mask clip, cropped 9-argument drawImage), over; poster only for a
 * stale generation or no frame; exact composition when a scene fades or crossfades; mask paths made when
 * the scene is offered, never per frame. Pixels are checked in headless Chromium by
 * golden/canvas-scene-run.ts.
 */

type Call = [string, ...unknown[]];

/** Every 2D context and Path2D made, by name, with what was called on it and set on it. */
let log: { name: string; calls: Call[] }[];
let canvases = 0;
let paths: FakePath2D[];

function recorder(name: string): Record<string, unknown> {
  const entry = { name, calls: [] as Call[] };
  log.push(entry);
  const state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
  const stack: Record<string, unknown>[] = [];
  return new Proxy(state, {
    get: (t, k) => {
      if (typeof k !== 'string') return undefined;
      if (k in t) return t[k];
      return (...args: unknown[]) => {
        entry.calls.push([k, ...args]);
        if (k === 'save') stack.push({ ...t });
        if (k === 'restore') Object.assign(t, stack.pop());
      };
    },
    set: (t, k, v) => {
      if (typeof k !== 'string') return false;
      t[k] = v;
      entry.calls.push([`${k}=`, v]);
      return true;
    },
  });
}

class FakeCanvas {
  readonly name: string;
  private ctx: Record<string, unknown>;
  constructor(
    public width = 1920,
    public height = 1080,
  ) {
    // In the order a compositor makes them when scenes are offered through prepare().
    this.name = ['scratch', 'scene', 'mask'][canvases] ?? `canvas${canvases}`;
    canvases++;
    this.ctx = recorder(this.name);
  }
  getContext(): unknown {
    return this.ctx;
  }
}

class FakePath2D {
  calls: Call[] = [];
  constructor() {
    paths.push(this);
  }
  roundRect(...a: unknown[]): void {
    this.calls.push(['roundRect', ...a]);
  }
  ellipse(...a: unknown[]): void {
    this.calls.push(['ellipse', ...a]);
  }
  moveTo(...a: unknown[]): void {
    this.calls.push(['moveTo', ...a]);
  }
  lineTo(...a: unknown[]): void {
    this.calls.push(['lineTo', ...a]);
  }
  closePath(): void {
    this.calls.push(['closePath']);
  }
}

const W = 1920;
const H = 1080;

function compositor(): Canvas2DCompositor {
  const main = { name: 'main', ctx: recorder('main'), getContext: () => main.ctx };
  return new Canvas2DCompositor(main as unknown as OffscreenCanvas, W, H);
}

const calls = (name: string): Call[] => log.find((e) => e.name === name)?.calls ?? [];
/** Drawing calls only (no state sets), with sources named and numbers to 3 decimals (planes are float32). */
const draws = (name: string): unknown[][] =>
  calls(name)
    .filter((c) => !c[0].endsWith('='))
    .map((c) =>
      c.map((x) =>
        typeof x === 'number'
          ? Math.round(x * 1000) / 1000 + 0
          : x && typeof x === 'object' && 'tag' in x
            ? (x as { tag: string }).tag
            : x instanceof FakeCanvas
              ? x.name
              : x,
      ),
    );

const bitmap = (tag: string) =>
  ({ tag, width: W, height: H, close: () => undefined }) as unknown as ImageBitmap;
const frame = (tag = 'frame', w = 640, h = 360) =>
  ({ tag, displayWidth: w, displayHeight: h, close: () => undefined }) as unknown as VideoFrame;

/** Device px bounds of the test box (960x540 at 480, 270) turned by `deg` about its centre. */
function rotatedBoundsDevice(w: number, h: number, deg: number): { x: number; w: number } {
  const t = (deg * Math.PI) / 180;
  const hw = (w * Math.abs(Math.cos(t)) + h * Math.abs(Math.sin(t))) / 2;
  return { x: 960 - hw, w: 2 * hw };
}

function plane(src: Partial<PlaneSource> = {}, srcW = 640, srcH = 360): Float32Array {
  const p = new Float32Array(PLANE_FLOATS);
  encodePlane(
    { box: { x: 480, y: 270, w: 960, h: 540, rotation: 0 }, fit: 'stretch', ...src },
    1,
    srcW,
    srcH,
    p,
  );
  return p;
}

function scene(key: string, p: Float32Array, over = true, gen = 7): StackContent<ImageBitmap> {
  return {
    key,
    kind: SRC_SCENE,
    bitmap: bitmap(`${key}.base`),
    over: over ? bitmap(`${key}.over`) : null,
    plane: p,
    videoSlot: 2,
    videoGen: gen,
  };
}

/** A layer showing `c` (no fade). */
function shown(c: StackContent<ImageBitmap>, comp?: Canvas2DCompositor): LayerStack<ImageBitmap> {
  const ls = new LayerStack<ImageBitmap>();
  comp?.prepare(1, c);
  ls.offer(c);
  ls.requestFlip(c.key, 0, 0, 0);
  ls.tick(0, 16);
  return ls;
}

/** A layer half way through a 1 s crossfade from `from` (or nothing) to `to`, at now = 1500. */
function fading(
  from: StackContent<ImageBitmap> | null,
  to: StackContent<ImageBitmap>,
  comp?: Canvas2DCompositor,
): LayerStack<ImageBitmap> {
  const ls = from ? shown(from, comp) : new LayerStack<ImageBitmap>();
  comp?.prepare(1, to);
  ls.offer(to);
  ls.requestFlip(to.key, 1000, 1000, 0);
  ls.tick(1000, 16);
  return ls;
}

function inputs(
  layers: LayerStack<ImageBitmap>[],
  fr: VideoFrame | null = frame(),
  gen = 7,
  now = 0,
): FrameInputs {
  return {
    layers,
    video: {
      frames: [null, null, fr, null],
      version: new Int32Array(4),
      gen: Int32Array.from([-1, -1, fr ? gen : -1, -1]),
    },
    now,
    clear: new Float32Array([0, 0, 0, 1]),
    testPixel: Int32Array.from([-1, 0, 0]),
  };
}

beforeEach(() => {
  log = [];
  canvases = 0;
  paths = [];
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal('Path2D', FakePath2D);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Canvas2DCompositor scenes', () => {
  it('draws the base, the video in its box through the plane, then the over', () => {
    const c = compositor();
    c.draw(inputs([shown(scene('S', plane()))]));
    expect(draws('main').slice(1)).toEqual([
      ['drawImage', 'S.base', 0, 0, W, H],
      ['save'],
      ['setTransform', 960, 0, 0, 540, 480, 270],
      ['drawImage', 'frame', 0, 0, 640, 360, 0, 0, 1, 1],
      ['restore'],
      ['drawImage', 'S.over', 0, 0, W, H],
    ]);
    // A rect mask needs no clip: the image's own rect is the frame's.
    expect(calls('main').filter((x) => x[0] === 'clip')).toEqual([]);
  });

  it('weights the video by the object opacity inside save/restore', () => {
    const c = compositor();
    c.draw(inputs([shown(scene('S', plane({ opacity: 0.5 }), false))]));
    const m = calls('main');
    const save = m.findIndex((x) => x[0] === 'save');
    const restore = m.findIndex((x) => x[0] === 'restore');
    expect(m.slice(save, restore)).toContainEqual(['globalAlpha=', 0.5]);
    // restore puts the layer's alpha back.
    expect(m.slice(restore + 1)).not.toContainEqual(['globalAlpha=', 0.5]);
  });

  it('draws only the cropped part of the frame, and nothing in negative-crop padding', () => {
    const c = compositor();
    c.draw(inputs([shown(scene('A', plane({ crop: { l: 0.25, t: 0.1, r: 0.25, b: 0.4 } }), false))]));
    const a = draws('main').find((x) => x[0] === 'drawImage' && x[1] === 'frame')!;
    expect(a.slice(2)).toEqual([160, 36, 320, 180, 0, 0, 1, 1]);
    log = [];
    canvases = 0;
    const d = compositor();
    // Half the picture's width of padding on the left: the picture fills the right two thirds of the box.
    d.draw(inputs([shown(scene('B', plane({ crop: { l: -0.5, t: 0, r: 0, b: 0 } }), false))]));
    const b = draws('main').find((x) => x[0] === 'drawImage' && x[1] === 'frame')!;
    expect(b.slice(2)).toEqual([0, 0, 640, 360, 0.333, 0, 0.667, 1]);
  });

  it('cuts a turned plane with an anti-aliased fill in the mask canvas, over a slightly larger first draw', () => {
    const c = compositor();
    const p = plane({ box: { x: 480, y: 270, w: 960, h: 540, rotation: 30 }, flipH: true });
    c.draw(inputs([shown(scene('R', p, false), c)]));
    const fwd = new Float64Array(6);
    planeForward(p, fwd);
    const mk = draws('mask');
    expect(mk.map((x) => x[0])).toEqual([
      'save',
      'beginPath',
      'rect',
      'clip',
      'clearRect',
      'setTransform',
      'drawImage',
      'drawImage',
      'fillRect',
      'restore',
    ]);
    expect(mk[5]!.slice(1)).toEqual([...fwd].map((v) => Math.round(v * 1000) / 1000 + 0));
    // The first draw reaches 1.5 device px past each edge; the second is exact; the fill keeps the frame.
    const [bleed, exact] = mk.filter((x) => x[0] === 'drawImage');
    expect(exact!.slice(2)).toEqual([0, 0, 640, 360, 0, 0, 1, 1]);
    expect(bleed![6]).toBeCloseTo(-1.5 / 960, 3);
    expect(bleed![8]).toBeCloseTo(1 + 3 / 960, 3);
    expect(mk[8]).toEqual(['fillRect', 0, 0, 1, 1]);
    expect(calls('mask')).toContainEqual(['globalCompositeOperation=', 'destination-in']);
    // The cut rect is copied to the same place in the target, within the turned box's pixel bounds.
    const [, src, sx, sy, sw, sh, dx, dy, dw, dh] = draws('main').find(
      (x) => x[0] === 'drawImage' && x[1] !== 'R.base',
    )!;
    expect(src).toBe('mask');
    expect([dx, dy, dw, dh]).toEqual([sx, sy, sw, sh]);
    const r = rotatedBoundsDevice(960, 540, 30);
    expect(sx).toBeGreaterThanOrEqual(r.x - 3);
    expect(sx).toBeLessThanOrEqual(r.x);
    expect((sx as number) + (sw as number)).toBeGreaterThanOrEqual(r.x + r.w);
    expect((sx as number) + (sw as number)).toBeLessThanOrEqual(r.x + r.w + 3);
  });

  it('places a turned, flipped plane with its forward affine', () => {
    const c = compositor();
    const p = plane({ box: { x: 480, y: 270, w: 960, h: 540, rotation: 90 }, flipH: true });
    c.draw(inputs([shown(scene('R', p, false), c)]));
    const t = calls('main')
      .find((x) => x[0] === 'setTransform')!
      .slice(1) as number[];
    const fwd = new Float64Array(6);
    planeForward(p, fwd);
    expect(t).toEqual([...fwd]);
    // Frame (0, 0) is the box's right-top corner (flipped), turned 90° clockwise about the centre (960, 540).
    const [a, b, cc, d, e, f] = t as [number, number, number, number, number, number];
    expect(e).toBeCloseTo(960 + 270, 2);
    expect(f).toBeCloseTo(540 + 480, 2);
    // Frame (1, 1): the left-bottom corner, turned.
    expect(a + cc + e).toBeCloseTo(960 - 270, 2);
    expect(b + d + f).toBeCloseTo(540 - 480, 2);
    // A quarter turn is upright: drawn directly, its edges on whole pixels.
    expect(calls('mask')).toEqual([]);
  });

  it('cuts an elliptical mask with a fill made once, when the scene is offered', () => {
    const c = compositor();
    const ls = shown(scene('E', plane({ mask: { preset: 'ellipse' }, opacity: 0.5 }), false), c);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.calls).toEqual([['ellipse', 0.5, 0.5, 0.5, 0.5, 0, 0, 2 * Math.PI]]);
    for (let i = 0; i < 3; i++) c.draw(inputs([ls]));
    expect(paths).toHaveLength(1);
    const mk = calls('mask');
    expect(mk.filter((x) => x[0] === 'fill').map((x) => x[1])).toEqual([paths[0], paths[0], paths[0]]);
    // No clip by the mask (Chromium does not anti-alias 2D clips): only the whole-pixel bounds clip.
    const once = draws('mask').slice(0, 9);
    expect(once.map((x) => x[0])).toEqual([
      'save',
      'beginPath',
      'rect',
      'clip',
      'clearRect',
      'setTransform',
      'drawImage',
      'fill',
      'restore',
    ]);
    const [x, y, w, h] = once[2]!.slice(1) as number[];
    // The box's device rect (480, 270)-(1440, 810) with a margin of up to 3 px, in whole pixels.
    for (const [v, lo, hi] of [
      [x!, 477, 480],
      [y!, 267, 270],
      [x! + w!, 1440, 1443],
      [y! + h!, 810, 813],
    ] as const)
      expect(v >= lo && v <= hi && Number.isInteger(v), `${v} in [${lo}, ${hi}]`).toBe(true);
    expect(once[4]).toEqual(['clearRect', x, y, w, h]);
    expect(once[5]).toEqual(['setTransform', 960, 0, 0, 540, 480, 270]);
    expect(once[6]).toEqual(['drawImage', 'frame', 0, 0, 640, 360, 0, 0, 1, 1]);
    const k = mk.findIndex((c) => c[0] === 'fill');
    expect(mk[k - 1]).toEqual(['globalCompositeOperation=', 'destination-in']);
    // Copied to the same place in the target at the plane's opacity, then the layer's alpha is back.
    const m = calls('main');
    const j = m.findIndex((c) => c[0] === 'drawImage' && (c[1] as { name?: string }).name === 'mask');
    expect(m.slice(j - 1, j + 2)).toEqual([
      ['globalAlpha=', 0.5],
      ['drawImage', expect.objectContaining({ name: 'mask' }), x, y, w, h, x, y, w, h],
      ['globalAlpha=', 1],
    ]);
  });

  it('cuts a rounded-rect mask whose sides reach past the frame, shared by scenes with the same radii', () => {
    const c = compositor();
    const p = plane({ radius: 54 });
    const ls = shown(scene('R1', p, false), c);
    shown(scene('R2', plane({ radius: 54 }), false), c);
    expect(paths).toHaveLength(1);
    const rx = p[11]!;
    const ry = p[12]!;
    expect(rx).toBeCloseTo(54 / 960, 6);
    expect(ry).toBeCloseTo(54 / 540, 6);
    const q = Math.PI / 2;
    const arcs = paths[0]!.calls.filter((x) => x[0] === 'ellipse');
    expect(arcs).toEqual([
      ['ellipse', 1 - rx, ry, rx, ry, 0, -q, 0],
      ['ellipse', 1 - rx, 1 - ry, rx, ry, 0, 0, q],
      ['ellipse', rx, 1 - ry, rx, ry, 0, q, 2 * q],
      ['ellipse', rx, ry, rx, ry, 0, 2 * q, 3 * q],
    ]);
    // The straight sides run a frame outside it, so the frame's edges are cut only once.
    const pts = paths[0]!.calls.filter((x) => x[0] === 'lineTo').map((x) => x.slice(1) as number[]);
    expect(Math.min(...pts.map((x) => x[0]!))).toBe(-1);
    expect(Math.max(...pts.map((x) => x[1]!))).toBe(2);
    c.draw(inputs([ls]));
    expect(paths).toHaveLength(1);
    expect(calls('mask').find((x) => x[0] === 'fill')![1]).toBe(paths[0]);
    // Upright: no rect cut and no enlarged first draw.
    expect(draws('mask').filter((x) => x[0] === 'fillRect' || x[0] === 'drawImage')).toHaveLength(1);
  });

  it('makes a mask on the first draw of a scene offered without prepare, then reuses it', () => {
    const c = compositor();
    const ls = shown(scene('R', plane({ radius: 20 }), false));
    expect(paths).toHaveLength(0);
    c.draw(inputs([ls]));
    c.draw(inputs([ls]));
    expect(paths).toHaveLength(1);
  });

  it('keeps the masks of held scenes when the mask cache is full', () => {
    const c = compositor();
    const ls = shown(scene('R', plane({ radius: 10 }), false), c);
    c.draw(inputs([ls]));
    for (let r = 11; r < 40; r++) c.prepare(1, scene(`X${r}`, plane({ radius: r }), false));
    const made = paths.length;
    c.draw(inputs([ls]));
    expect(paths).toHaveLength(made);
    // A mask no stack holds was dropped: drawing it again makes it anew.
    c.draw(inputs([shown(scene('Y', plane({ radius: 11 }), false))]));
    expect(paths).toHaveLength(made + 1);
  });

  it('shows the poster (the base) for a stale generation, no frame or no generation', () => {
    for (const [fr, gen, stackGen] of [
      [frame(), 8, 7],
      [null, 7, 7],
      [frame(), -1, -1],
    ] as const) {
      log = [];
      canvases = 0;
      const c = compositor();
      c.draw(inputs([shown(scene('S', plane(), true, stackGen))], fr, gen));
      expect(draws('main').slice(1)).toEqual([
        ['drawImage', 'S.base', 0, 0, W, H],
        ['drawImage', 'S.over', 0, 0, W, H],
      ]);
    }
  });

  it('draws a scene without base or over from its video alone, and nothing without a frame', () => {
    const c = compositor();
    const s: StackContent<ImageBitmap> = { ...scene('V', plane(), false), bitmap: null };
    c.draw(inputs([shown(s)]));
    expect(draws('main').map((x) => x[0])).toEqual([
      'fillRect',
      'save',
      'setTransform',
      'drawImage',
      'restore',
    ]);
    log = [];
    canvases = 0;
    const d = compositor();
    d.draw(inputs([shown(s)], null));
    expect(draws('main').map((x) => x[0])).toEqual(['fillRect']);
  });

  it('composes a scene at full alpha before a crossfade mixes it (exact mix)', () => {
    const c = compositor();
    const from: StackContent<ImageBitmap> = { key: 'A', kind: SRC_BITMAP, bitmap: bitmap('A') };
    const ls = fading(from, scene('S', plane()), c);
    c.draw(inputs([ls], frame(), 7, 1500));
    // The scene canvas holds the whole scene, drawn at alpha 1.
    expect(draws('scene')).toEqual([
      ['clearRect', 0, 0, W, H],
      ['drawImage', 'S.base', 0, 0, W, H],
      ['save'],
      ['setTransform', 960, 0, 0, 540, 480, 270],
      ['drawImage', 'frame', 0, 0, 640, 360, 0, 0, 1, 1],
      ['restore'],
      ['drawImage', 'S.over', 0, 0, W, H],
    ]);
    expect(
      new Set(
        calls('scene')
          .filter((x) => x[0] === 'globalAlpha=')
          .map((x) => x[1]),
      ),
    ).toEqual(new Set([1]));
    // The scratch mixes the outgoing bitmap and the composed scene with 'lighter', as for any pair.
    expect(calls('scratch')).toEqual([
      ['globalCompositeOperation=', 'source-over'],
      ['clearRect', 0, 0, W, H],
      ['globalAlpha=', 0.5],
      ['drawImage', from.bitmap, 0, 0, W, H],
      ['globalCompositeOperation=', 'lighter'],
      ['globalAlpha=', 0.5],
      ['drawImage', expect.objectContaining({ name: 'scene' }), 0, 0],
    ]);
    expect(draws('main').slice(1)).toEqual([['drawImage', 'scratch', 0, 0]]);
  });

  it('crossfades two scenes through the one scene canvas', () => {
    const c = compositor();
    const ls = fading(scene('S1', plane()), scene('S2', plane({ mask: { preset: 'ellipse' } })), c);
    c.draw(inputs([ls], frame(), 7, 1500));
    const sc = draws('scene');
    expect(sc.filter((x) => x[0] === 'clearRect')).toHaveLength(2);
    // S2's elliptical video comes through the mask canvas.
    expect(sc.filter((x) => x[0] === 'drawImage').map((x) => x[1])).toEqual([
      'S1.base',
      'frame',
      'S1.over',
      'S2.base',
      'mask',
      'S2.over',
    ]);
    const mix = calls('scratch').filter((x) => x[0] === 'drawImage');
    expect(mix).toHaveLength(2);
    expect(mix.every((x) => (x[1] as { name: string }).name === 'scene')).toBe(true);
  });

  it('composes a scene fading in alone in the scratch, then draws it at its weight', () => {
    const c = compositor();
    c.draw(inputs([fading(null, scene('S', plane()), c)], frame(), 7, 1500));
    expect(draws('scratch').map((x) => x[1])).toEqual([
      0,
      'S.base',
      undefined,
      960,
      'frame',
      undefined,
      'S.over',
    ]);
    expect(
      new Set(
        calls('scratch')
          .filter((x) => x[0] === 'globalAlpha=')
          .map((x) => x[1]),
      ),
    ).toEqual(new Set([1]));
    const m = calls('main');
    const k = m.findIndex((x) => x[0] === 'drawImage');
    expect(m[k - 1]).toEqual(['globalAlpha=', 0.5]);
    expect(m[k]![1]).toMatchObject({ name: 'scratch' });
  });

  it('draws a single-part scene fading alone directly, like a bitmap', () => {
    const c = compositor();
    // No frame: the base alone.
    c.draw(inputs([fading(null, scene('S', plane(), false), c)], null, 7, 1500));
    expect(draws('scratch')).toEqual([]);
    expect(calls('main').slice(-3)).toEqual([
      ['globalAlpha=', 0.5],
      ['drawImage', expect.objectContaining({ tag: 'S.base' }), 0, 0, W, H],
      ['globalAlpha=', 1],
    ]);
  });

  it('makes the scene canvas with the first scene offered, and the mask canvas with the first masked one', () => {
    const c = compositor();
    expect(canvases).toBe(1); // the scratch
    c.prepare(1, { key: 'B', kind: SRC_BITMAP, bitmap: bitmap('B') });
    expect(canvases).toBe(1);
    c.prepare(1, scene('S', plane()));
    c.prepare(1, scene('T', plane()));
    expect(canvases).toBe(2);
    c.prepare(1, scene('Q', plane({ box: { x: 480, y: 270, w: 960, h: 540, rotation: 90 } })));
    expect(canvases).toBe(2); // a quarter turn is upright
    c.prepare(1, scene('E', plane({ mask: { preset: 'ellipse' } })));
    c.prepare(1, scene('R', plane({ radius: 9 })));
    expect(canvases).toBe(3);
    const d = compositor();
    d.prepare(1, scene('T', plane({ box: { x: 480, y: 270, w: 960, h: 540, rotation: 12 } })));
    expect(canvases).toBe(6); // scratch, scene, mask
  });

  it('keeps the legacy bitmap crossfade call for call', () => {
    const c = compositor();
    const a: StackContent<ImageBitmap> = { key: 'A', kind: SRC_BITMAP, bitmap: bitmap('A') };
    const b: StackContent<ImageBitmap> = { key: 'B', kind: SRC_BITMAP, bitmap: bitmap('B') };
    c.draw(inputs([fading(a, b, c)], null, 7, 1500));
    expect(calls('scratch')).toEqual([
      ['globalCompositeOperation=', 'source-over'],
      ['clearRect', 0, 0, W, H],
      ['globalAlpha=', 0.5],
      ['drawImage', a.bitmap, 0, 0, W, H],
      ['globalCompositeOperation=', 'lighter'],
      ['globalAlpha=', 0.5],
      ['drawImage', b.bitmap, 0, 0, W, H],
    ]);
    expect(canvases).toBe(1);
  });
});
