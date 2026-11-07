import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Compositor, FrameInputs } from './compositor.ts';
import { RenderEngine } from './engine.ts';
import { GpuCompositor, U_OVER_A, U_RECT_A, U_RECT_B } from './gpu.ts';
import { PLANE_FLOATS, PLANE_OPACITY } from './scene.ts';
import { FIT_CONTAIN, LAYERS, LAYER_INDEX, LayerStack, SRC_BITMAP, SRC_SCENE, SRC_VIDEO } from './stacks.ts';

/**
 * M7 on the WebGPU compositor (design/27 §7.3), against a fake device that records queue copies with their
 * origins and sizes, scissor rects and pipelines: tight sprites (a sub-rect copy at the sprite's offset,
 * the uniform rect, the scissor of single and crossfaded draws), the opaque replace path (and the layers it
 * hides), strip uploads within the per-frame byte and time budget (the flip waits, the previous content
 * stays, nothing is torn), the engine's same-frame upload of a due flip that fits, device loss, and the
 * `uploadMs` telemetry. The pixels are checked in a browser by the compositor golden.
 */

const W = 64;
const H = 36;
const SLIDE = LAYER_INDEX.slide;
const BG = LAYER_INDEX.background;

type Tex = { label: string; destroy(): void; createView(): { tex: Tex } };
type Copy = {
  bitmap: string;
  texture: string;
  src: [number, number];
  dst: [number, number];
  size: [number, number];
};

class FakeDevice {
  copies: Copy[] = [];
  log: string[] = [];
  /** Per draw: pipeline label and the scissor in effect. */
  draws: { pipe: string; scissor: number[] }[] = [];
  uniform = new Float32Array(0);
  private pipe = '';
  private scissor: number[] = [];
  readonly queue = {
    writeBuffer: (_b: unknown, _o: number, data: Float32Array) => {
      this.uniform = new Float32Array(data);
    },
    submit: () => {
      this.log.push('submit');
    },
    copyExternalImageToTexture: (
      src: { source: { name: string }; origin?: { x: number; y: number } },
      dst: { texture: Tex; origin?: { x: number; y: number } },
      size: ArrayLike<number>,
    ) => {
      const c: Copy = {
        bitmap: src.source.name,
        texture: dst.texture.label,
        src: [src.origin?.x ?? 0, src.origin?.y ?? 0],
        dst: [dst.origin?.x ?? 0, dst.origin?.y ?? 0],
        size: [size[0]!, size[1]!],
      };
      this.copies.push(c);
      this.log.push(`copy:${c.bitmap}`);
    },
  };
  createSampler = () => ({});
  createBuffer = () => ({ destroy: () => undefined });
  createShaderModule = () => ({});
  createRenderPipelineAsync = async (d: { label: string }) => ({
    label: d.label,
    getBindGroupLayout: () => ({}),
  });
  createTexture = (d: { label: string }): Tex => {
    const t: Tex = { label: d.label, destroy: () => undefined, createView: () => ({ tex: t }) };
    return t;
  };
  createBindGroup = () => ({});
  importExternalTexture = () => ({});
  createCommandEncoder = () => ({
    beginRenderPass: () => ({
      setPipeline: (p: { label: string }) => {
        this.pipe = p.label;
      },
      setBindGroup: () => undefined,
      setScissorRect: (x: number, y: number, w: number, h: number) => {
        this.scissor = [x, y, w, h];
      },
      draw: () => {
        this.draws.push({ pipe: this.pipe, scissor: this.scissor });
      },
      end: () => undefined,
    }),
    finish: () => ({}),
  });
  destroy = () => undefined;
}

const context = {
  getCurrentTexture: () => ({ createView: () => ({}) }),
  unconfigure: () => undefined,
} as unknown as GPUCanvasContext;

async function gpu(budget: { bytes?: number; ms?: number } = { bytes: 0, ms: 0 }, dev = new FakeDevice()) {
  const c = new GpuCompositor(
    dev as unknown as GPUDevice,
    context,
    'rgba8unorm',
    W,
    H,
    LAYERS.length,
    budget,
  );
  await c.compile();
  return { c, dev };
}

const bitmap = (name: string, w = W, h = H) =>
  ({ name, width: w, height: h, close: () => undefined }) as unknown as ImageBitmap;

function inputs(gated = true): FrameInputs {
  return {
    layers: LAYERS.map(() => {
      const ls = new LayerStack<ImageBitmap>();
      ls.gated = gated;
      return ls;
    }),
    video: { frames: [null, null, null, null], version: new Int32Array(4), gen: new Int32Array(4).fill(-1) },
    now: 0,
    clear: new Float32Array([0, 0, 0, 1]),
    testPixel: new Int32Array([-1, 0, 0]),
  };
}

/** One engine frame without the engine: tick, upload what a due flip waits for, draw with its uploads. */
function frame(c: GpuCompositor, f: FrameInputs, now: number): void {
  f.now = now;
  for (const ls of f.layers) ls.tick(now, 16);
  if (c.uploadDue(f, now, 16)) for (const ls of f.layers) if (ls.flipPending) ls.tick(now, 16);
  c.drainUploads(f, false);
  c.draw(f);
  c.drainUploads(f, true);
}

beforeEach(() => {
  vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 });
  vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, UNIFORM: 64 });
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return { fillStyle: '', fillRect: () => undefined };
      }
    },
  );
  vi.stubGlobal(
    'VideoFrame',
    class {
      readonly name = 'placeholder';
      close() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WebGPU tight sprites', () => {
  it('copies a sprite into its layer texture at its offset and draws it within its rect only', async () => {
    const { c, dev } = await gpu();
    const f = inputs();
    f.layers[SLIDE]!.offer({ key: 'S', kind: SRC_BITMAP, bitmap: bitmap('band', 40, 10), x: 12, y: 20 });
    f.layers[SLIDE]!.requestFlip('S', 0, 0, 0);
    frame(c, f, 0);
    expect(dev.copies).toEqual([
      { bitmap: 'band', texture: 'layer1-stack1', src: [0, 0], dst: [12, 20], size: [40, 10] },
    ]);
    expect(dev.draws).toEqual([{ pipe: 'single-t', scissor: [12, 20, 40, 10] }]);
    expect([...dev.uniform.slice(SLIDE * 64 + U_RECT_A, SLIDE * 64 + U_RECT_A + 4)]).toEqual([
      12, 20, 40, 10,
    ]);
  });

  it('cuts a sprite that reaches past the frame to the frame, in the copy and the scissor', async () => {
    const { c, dev } = await gpu();
    const f = inputs();
    f.layers[SLIDE]!.offer({ key: 'S', kind: SRC_BITMAP, bitmap: bitmap('wide', 40, 30), x: 50, y: 20 });
    f.layers[SLIDE]!.requestFlip('S', 0, 0, 0);
    frame(c, f, 0);
    expect(dev.copies[0]).toMatchObject({ dst: [50, 20], size: [14, 16] });
    expect(dev.draws[0]!.scissor).toEqual([50, 20, 14, 16]);
  });

  it('scissors a crossfade to the union of a full-frame layer and a sprite', async () => {
    const { c, dev } = await gpu();
    const f = inputs();
    const ls = f.layers[SLIDE]!;
    ls.offer({ key: 'A', kind: SRC_BITMAP, bitmap: bitmap('a', 20, 6), x: 4, y: 2 });
    ls.requestFlip('A', 0, 0, 0);
    frame(c, f, 0);
    ls.offer({ key: 'B', kind: SRC_BITMAP, bitmap: bitmap('b', 30, 8), x: 30, y: 26 });
    frame(c, f, 16);
    ls.requestFlip('B', 32, 1000, 32);
    dev.draws.length = 0;
    frame(c, f, 500);
    expect(ls.fading).toBe(true);
    expect(dev.draws).toEqual([{ pipe: 'pair-tt', scissor: [4, 2, 56, 32] }]);
    expect([...dev.uniform.slice(SLIDE * 64 + U_RECT_A, SLIDE * 64 + U_RECT_A + 4)]).toEqual([4, 2, 20, 6]);
    expect([...dev.uniform.slice(SLIDE * 64 + U_RECT_B, SLIDE * 64 + U_RECT_B + 4)]).toEqual([30, 26, 30, 8]);
    // A full-frame layer crossfading with the sprite covers the frame.
    ls.offer({ key: 'C', kind: SRC_BITMAP, bitmap: bitmap('c') });
    frame(c, f, 1100);
    frame(c, f, 1116);
    ls.requestFlip('C', 1200, 1000, 1200);
    dev.draws.length = 0;
    frame(c, f, 1500);
    expect(dev.draws).toEqual([{ pipe: 'pair-tt', scissor: [0, 0, W, H] }]);
  });

  it('writes a scene over its own rect and uploads base and over at their offsets', async () => {
    const { c, dev } = await gpu();
    const f = inputs();
    const plane = new Float32Array(PLANE_FLOATS);
    plane[PLANE_OPACITY] = 1;
    const s = {
      key: 'S',
      kind: SRC_SCENE,
      bitmap: bitmap('base', 50, 30),
      x: 2,
      y: 3,
      over: bitmap('over', 20, 8),
      overX: 30,
      overY: 25,
      plane,
      videoSlot: 2,
      videoGen: 1,
    };
    c.prepare(SLIDE, s);
    f.layers[SLIDE]!.offer(s);
    f.layers[SLIDE]!.requestFlip('S', 0, 0, 0);
    frame(c, f, 0);
    expect(dev.copies.map((x) => [x.bitmap, x.texture, x.dst, x.size])).toEqual([
      ['base', 'layer1-stack1', [2, 3], [50, 30]],
      ['over', 'layer1-over1', [30, 25], [20, 8]],
    ]);
    expect([...dev.uniform.slice(SLIDE * 64 + U_OVER_A, SLIDE * 64 + U_OVER_A + 4)]).toEqual([30, 25, 20, 8]);
    // Base and over (no video frame): the scissor covers both.
    expect(dev.draws[0]).toEqual({ pipe: 'single-v', scissor: [2, 3, 50, 30] });
  });

  it('scissors a contained video to its fitted rect', async () => {
    const { c, dev } = await gpu();
    const f = inputs();
    f.video.frames[2] = {
      displayWidth: 32,
      displayHeight: 32,
      close: () => undefined,
    } as unknown as VideoFrame;
    f.layers[LAYER_INDEX.media]!.offer({ key: 'V', kind: SRC_VIDEO, videoSlot: 2, fit: FIT_CONTAIN });
    f.layers[LAYER_INDEX.media]!.requestFlip('V', 0, 0, 0);
    frame(c, f, 0);
    expect(dev.draws).toEqual([{ pipe: 'single-e', scissor: [14, 0, 36, 36] }]);
  });
});

describe('WebGPU opaque layers', () => {
  it('writes an opaque full-frame layer without blending and draws nothing under it', async () => {
    const { c, dev } = await gpu();
    const f = inputs();
    const show = (l: number, key: string, b: ImageBitmap, opaque = false) => {
      f.layers[l]!.offer({ key, kind: SRC_BITMAP, bitmap: b, opaque });
      f.layers[l]!.requestFlip(key, 0, 0, 0);
    };
    show(BG, 'bg', bitmap('bg'));
    show(SLIDE, 'photo', bitmap('photo'), true);
    show(LAYER_INDEX.props, 'p', bitmap('clock', 10, 5));
    frame(c, f, 0);
    // The background under the opaque slide layer is not drawn.
    expect(dev.draws.map((d) => d.pipe)).toEqual(['replace-t', 'single-t']);
    // Fading, the opaque layer blends again and the layers under it show.
    f.layers[SLIDE]!.offer({ key: 'next', kind: SRC_BITMAP, bitmap: bitmap('next'), opaque: true });
    frame(c, f, 16);
    f.layers[SLIDE]!.requestFlip('next', 32, 300, 32);
    dev.draws.length = 0;
    frame(c, f, 100);
    expect(dev.draws.map((d) => d.pipe)).toEqual(['single-t', 'pair-tt', 'single-t']);
  });

  it('takes the flag only for a full-frame bitmap at 0, 0', () => {
    const ls = new LayerStack<ImageBitmap>();
    ls.offer({ key: 'a', kind: SRC_BITMAP, bitmap: bitmap('a', 10, 10), x: 3, y: 0, opaque: true });
    expect(ls.armedStack.opaque).toBe(false);
    ls.offer({ key: 'b', kind: SRC_VIDEO, videoSlot: 1, opaque: true });
    expect(ls.armedStack.opaque).toBe(false);
    ls.offer({ key: 'c', kind: SRC_BITMAP, bitmap: bitmap('c'), opaque: true, x: -4, y: Number.NaN });
    expect([ls.armedStack.opaque, ls.armedStack.x, ls.armedStack.y]).toEqual([true, 0, 0]);
  });
});

describe('WebGPU strip uploads', () => {
  const ROWS = 9;
  const budget = { bytes: ROWS * W * 4, ms: 0 };

  it('uploads a full frame in strips within the frame budget; the flip waits and the previous picture stays', async () => {
    const { c, dev } = await gpu(budget);
    const f = inputs();
    const ls = f.layers[SLIDE]!;
    ls.offer({ key: 'A', kind: SRC_BITMAP, bitmap: bitmap('A') });
    ls.requestFlip('A', 0, 0, 0);
    for (let i = 0; i < 4; i++) frame(c, f, i * 16);
    expect(ls.liveStack.key).toBe('A');
    dev.copies.length = 0;
    dev.draws.length = 0;
    // B is offered for a flip at 100 (asked at 50, so a later flip counts as late): it is uploaded 9 rows a
    // frame, into the armed texture only.
    ls.offer({ key: 'B', kind: SRC_BITMAP, bitmap: bitmap('B') });
    ls.requestFlip('B', 100, 0, 50);
    const shown: string[] = [];
    for (let i = 0; i < 6; i++) {
      frame(c, f, 100 + i * 16);
      shown.push(ls.liveStack.key);
    }
    expect(dev.copies.map((x) => [x.texture, x.src[1], x.dst[1], x.size[1]])).toEqual([
      ['layer1-stack0', 0, 0, 9],
      ['layer1-stack0', 9, 9, 9],
      ['layer1-stack0', 18, 18, 9],
      ['layer1-stack0', 27, 27, 9],
    ]);
    // Three frames of the old picture (A's texture, untouched), then B once its last strip is in.
    expect(shown).toEqual(['A', 'A', 'A', 'B', 'B', 'B']);
    expect(ls.lateFlips).toBe(1);
    expect(dev.draws.every((d) => d.pipe === 'single-t')).toBe(true);
  });

  it('flips on time when the content fits the frame budget (a small sprite due now)', async () => {
    const { c, dev } = await gpu(budget);
    const f = inputs();
    const ls = f.layers[SLIDE]!;
    ls.offer({ key: 'S', kind: SRC_BITMAP, bitmap: bitmap('S', 20, 8), x: 1, y: 1 });
    ls.requestFlip('S', 0, 0, 0);
    frame(c, f, 0);
    expect(ls.liveStack.key).toBe('S');
    expect(ls.lateFlips).toBe(0);
    expect(dev.log).toEqual(['copy:S', 'submit']);
  });

  it('stops issuing strips once the frame spent its upload time', async () => {
    const { c, dev } = await gpu({ bytes: 0, ms: 4 });
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    const f = inputs();
    const ls = f.layers[SLIDE]!;
    // Two layers armed at once: the first copy takes 5 ms of the frame, so the second waits a frame.
    const real = dev.queue.copyExternalImageToTexture;
    dev.queue.copyExternalImageToTexture = (...a: Parameters<typeof real>) => {
      t += 5;
      real(...a);
    };
    ls.offer({ key: 'A', kind: SRC_BITMAP, bitmap: bitmap('A') });
    f.layers[LAYER_INDEX.lowerThird]!.offer({ key: 'L', kind: SRC_BITMAP, bitmap: bitmap('L') });
    c.drainUploads(f, false);
    c.drainUploads(f, true);
    expect(dev.copies.map((x) => x.bitmap)).toEqual(['A']);
    c.drainUploads(f, false);
    c.drainUploads(f, true);
    expect(dev.copies.map((x) => x.bitmap)).toEqual(['A', 'L']);
    expect(c.uploadMs()).toBe(5);
  });

  it('uploads a refresh of the live copy whole before the draw (never a torn picture)', async () => {
    const { c, dev } = await gpu(budget);
    const f = inputs();
    const ls = f.layers[SLIDE]!;
    ls.offer({ key: 'A', kind: SRC_BITMAP, bitmap: bitmap('A') });
    ls.requestFlip('A', 0, 0, 0);
    for (let i = 0; i < 4; i++) frame(c, f, i * 16);
    dev.copies.length = 0;
    dev.log.length = 0;
    ls.offer({ key: 'A', kind: SRC_BITMAP, bitmap: bitmap('A2'), refresh: true });
    frame(c, f, 100);
    expect(dev.log).toEqual(['copy:A2', 'submit']);
    expect(dev.copies[0]!.size).toEqual([W, H]);
  });

  it('prefers the content a pending flip waits for over other armed content', async () => {
    const { c, dev } = await gpu({ bytes: W * H * 4, ms: 0 });
    const f = inputs();
    f.layers[BG]!.offer({ key: 'later', kind: SRC_BITMAP, bitmap: bitmap('later') });
    f.layers[SLIDE]!.offer({ key: 'soon', kind: SRC_BITMAP, bitmap: bitmap('soon') });
    f.layers[SLIDE]!.requestFlip('soon', 1000, 0, 0);
    c.drainUploads(f, false);
    c.drainUploads(f, true);
    expect(dev.copies.map((x) => x.bitmap)).toEqual(['soon']);
  });
});

describe('RenderEngine with strip uploads', () => {
  function engine(make: () => Promise<Compositor>) {
    let pending: ((ts: number) => void) | null = null;
    let now = 0;
    let lost: ((reason: string) => void) | undefined;
    const e = new RenderEngine(
      {
        canvas: {} as OffscreenCanvas,
        width: W,
        height: H,
        testPixel: false,
        clear: { r: 0, g: 0, b: 0, a: 1 },
        clockOffset: 0,
        gpuRetryMs: 0,
      },
      {
        raf: (cb) => {
          pending = cb;
          return 1;
        },
        wallNow: () => now,
        createGpu: async (init) => {
          lost = init.onLost;
          return make();
        },
        setTimeout: () => 0,
      },
    );
    const frame = (t: number) => {
      now = t;
      const cb = pending;
      pending = null;
      cb?.(t);
    };
    return { e, frame, lose: (r: string) => lost?.(r) };
  }

  it('gates flips on uploads, re-uploads after a device loss, and reports uploadMs', async () => {
    const first = await gpu({ bytes: 9 * W * 4, ms: 0 });
    const second = await gpu({ bytes: 9 * W * 4, ms: 0 });
    const made = [first.c, second.c];
    const { e, frame, lose } = engine(async () => made.shift()!);
    await e.start();
    expect(e.layers[SLIDE]!.gated).toBe(true);
    e.offer(SLIDE, { key: 'A', kind: SRC_BITMAP, bitmap: bitmap('A') });
    e.flip(SLIDE, 'A', 0, 0);
    for (let i = 0; i < 4; i++) frame(i * 16);
    expect(e.layers[SLIDE]!.liveStack.key).toBe('A');
    e.offer(SLIDE, { key: 'B', kind: SRC_BITMAP, bitmap: bitmap('B') });
    expect(e.telemetry().uploadMs).toBeGreaterThanOrEqual(0);
    lose('test');
    await vi.waitFor(() => expect(made.length).toBe(0), { timeout: 3000 });
    await vi.waitFor(() => expect(e.kind).toBe('webgpu'), { timeout: 3000 });
    // After the rebuild the armed B is not ready until it is uploaded again; the live A is uploaded whole
    // before the first draw.
    expect(e.layers[SLIDE]!.armedStack.ready).toBe(false);
    frame(1000);
    expect(second.dev.copies[0]).toMatchObject({ bitmap: 'A', size: [W, H] });
    expect(second.dev.copies.slice(1).map((x) => [x.bitmap, x.size[1]])).toEqual([['B', 9]]);
    for (let i = 1; i < 4; i++) frame(1000 + i * 16);
    expect(e.layers[SLIDE]!.armedStack.ready).toBe(true);
  });
});
