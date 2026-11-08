import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Compositor, FrameInputs } from './compositor.ts';
import { RenderEngine } from './engine.ts';
import { GpuCompositor } from './gpu.ts';
import { LAYERS, LAYER_INDEX, LayerStack, SRC_BITMAP, SRC_VIDEO } from './stacks.ts';

/**
 * The engine's video frames and texture uploads (design/27 §7.2 frame selection, §7.3 uploads): frames
 * reach the compositors through the 2-deep ring, chosen by media time on every frame and closed exactly
 * once; bitmaps are uploaded outside `draw`, what a frame samples before it and armed content after the
 * frame's submit. The GPU side runs the real GpuCompositor on a fake device that logs queue operations.
 */

const W = 64;
const H = 36;
const SLIDE = LAYER_INDEX.slide;

// ---- fake WebGPU device ----------------------------------------------------------------------------------

type Tex = { label: string; destroy(): void; createView(): { tex: Tex } };

class FakeDevice {
  /** Queue operations in order: `copy:<bitmap>:<texture>` and `submit`. */
  readonly log: string[] = [];
  readonly queue = {
    writeBuffer: () => undefined,
    submit: () => {
      this.log.push('submit');
    },
    copyExternalImageToTexture: (src: { source: { name: string } }, dst: { texture: Tex }) => {
      this.log.push(`copy:${src.source.name}:${dst.texture.label}`);
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
      setPipeline: () => undefined,
      setBindGroup: () => undefined,
      setScissorRect: () => undefined,
      draw: () => undefined,
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

/**
 * The real compositor on the fake device. These tests check where uploads happen, so the budget is
 * unlimited (0) and every upload is one copy; gpu.sprites.test.ts covers strips within a budget.
 */
async function fakeGpu(dev = new FakeDevice()): Promise<{ gpu: GpuCompositor; dev: FakeDevice }> {
  const gpu = new GpuCompositor(dev as unknown as GPUDevice, context, 'rgba8unorm', W, H, LAYERS.length, {
    bytes: 0,
    ms: 0,
  });
  await gpu.compile();
  return { gpu, dev };
}

const bitmap = (name: string) => {
  const b = { name, width: W, height: H, closed: 0, close: () => b.closed++ };
  return b as unknown as ImageBitmap;
};

// ---- engine ------------------------------------------------------------------------------------------------

function engine(compositor: () => Promise<Compositor>) {
  const clock = { now: 0 };
  let pending: ((ts: number) => void) | null = null;
  let ts = 0;
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
      wallNow: () => clock.now,
      createGpu: compositor,
      setTimeout: () => 0,
    },
  );
  /** Run one rAF frame at hub time `now`. */
  const frame = (now: number) => {
    clock.now = now;
    const cb = pending;
    pending = null;
    cb?.((ts += 16));
  };
  return { e, frame, clock };
}

type Fake = { id: string; timestamp: number; closes: number; close(): void };
const vframe = (made: Fake[], id: string, mediaMs: number): VideoFrame => {
  const f: Fake = {
    id,
    timestamp: Math.round(mediaMs * 1000),
    closes: 0,
    close() {
      f.closes++;
    },
  };
  made.push(f);
  return f as unknown as VideoFrame;
};

class Recorder implements Compositor {
  readonly kind = 'webgpu' as const;
  readonly width = W;
  readonly height = H;
  readonly calls: string[] = [];
  /** The frame each draw saw in slot 2. */
  readonly drawn: (string | null)[] = [];
  draw(f: FrameInputs): void {
    this.calls.push('draw');
    this.drawn.push((f.video.frames[2] as unknown as Fake | null)?.id ?? null);
  }
  drainUploads(_f: FrameInputs, all: boolean): void {
    this.calls.push(all ? 'uploads:all' : 'uploads:drawn');
  }
  destroy(): void {}
}

beforeEach(() => {
  vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 });
  vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, UNIFORM: 64 });
  // For a compositor that makes a placeholder VideoFrame from a canvas at startup (scene drawing).
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
});

describe('RenderEngine video frames', () => {
  it('presents frames by the media time of each drawn frame, through the ring', async () => {
    const r = new Recorder();
    const { e, frame } = engine(async () => r);
    await e.start();
    const made: Fake[] = [];
    const T0 = 10_000;
    const fms = e.clock.frameMs;
    // Playing since T0; the element is 20 ms ahead of hub time, so each frame arrives before it is due.
    e.setVideoFrame(2, vframe(made, 'a', 1000), 3, T0, 0);
    frame(T0 + 1000 - fms / 2);
    e.setVideoFrame(2, vframe(made, 'b', 1000 + 1000 / 30), 3, T0, 0);
    frame(T0 + 1020 - fms / 2);
    frame(T0 + 1000 + 1000 / 30 - fms / 2);
    expect(r.drawn).toEqual(['a', 'a', 'b']);
    expect(e.video.gen[2]).toBe(3);
    // Paused: frames come without a clock and the newest shows at once.
    e.setVideoFrame(2, vframe(made, 'c', 5000), 3);
    frame(T0 + 1100);
    expect(r.drawn.at(-1)).toBe('c');
    // vclear, then stop: every frame was closed exactly once.
    e.setVideoFrame(2, null);
    frame(T0 + 1120);
    expect(r.drawn.at(-1)).toBeNull();
    e.setVideoFrame(1, vframe(made, 'd', 0), 1);
    e.stop();
    expect(made.map((f) => [f.id, f.closes])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 1],
      ['d', 1],
    ]);
    expect(e.video.frames.every((f) => f === null)).toBe(true);
  });

  it('closes a frame for a slot that does not exist, and the frames of a reloaded slot at once', async () => {
    const { e } = engine(async () => new Recorder());
    await e.start();
    const made: Fake[] = [];
    e.setVideoFrame(9, vframe(made, 'x', 0), 1);
    e.setVideoFrame(2, vframe(made, 'a1', 0), 1);
    e.setVideoFrame(2, vframe(made, 'a2', 40), 1);
    e.setVideoFrame(2, vframe(made, 'b1', 0), 2);
    expect(made.filter((f) => f.closes === 0).map((f) => f.id)).toEqual(['b1']);
    expect(e.video.gen[2]).toBe(2);
    e.stop();
    expect(made.every((f) => f.closes === 1)).toBe(true);
  });
});

describe('RenderEngine texture uploads', () => {
  it('uploads around draw, never inside it: what the frame samples first, the rest after its submit', async () => {
    const r = new Recorder();
    const { e, frame } = engine(async () => r);
    await e.start();
    frame(0);
    expect(r.calls).toEqual(['uploads:drawn', 'draw', 'uploads:all']);
  });

  it('draws nothing it has not uploaded, and uploads armed content after the submit', async () => {
    const { gpu, dev } = await fakeGpu();
    const { e, frame } = engine(async () => gpu);
    await e.start();
    // A cut to A on the next frame: A is uploaded before that frame is drawn.
    e.offer(SLIDE, { key: 'A', kind: SRC_BITMAP, bitmap: bitmap('A') });
    e.flip(SLIDE, 'A', 0, 0);
    frame(0);
    expect(dev.log).toEqual(['copy:A:layer1-stack1', 'submit']);
    // B armed for a later flip: uploaded after the frame's submit, off its critical path.
    dev.log.length = 0;
    e.offer(SLIDE, { key: 'B', kind: SRC_BITMAP, bitmap: bitmap('B') });
    frame(16);
    expect(dev.log).toEqual(['submit', 'copy:B:layer1-stack0']);
    // The flip to B needs no upload; nothing is uploaded twice.
    dev.log.length = 0;
    e.flip(SLIDE, 'B', 32, 300);
    frame(32);
    frame(48);
    expect(dev.log).toEqual(['submit', 'submit']);
    // Content offered during the fade waits in the queue; promoted and flipped on one frame, it is
    // uploaded before that frame draws it.
    dev.log.length = 0;
    e.offer(SLIDE, { key: 'C', kind: SRC_BITMAP, bitmap: bitmap('C') });
    e.flip(SLIDE, 'C', 400, 0);
    frame(64);
    expect(dev.log).toEqual(['submit']);
    frame(400);
    expect(dev.log).toEqual(['submit', 'copy:C:layer1-stack1', 'submit']);
  });

  it('uploads the outgoing stack before a draw while it fades out', async () => {
    const { gpu, dev } = await fakeGpu();
    const f: FrameInputs = {
      layers: LAYERS.map(() => new LayerStack<ImageBitmap>()),
      video: {
        frames: [null, null, null, null],
        version: new Int32Array(4),
        gen: new Int32Array(4).fill(-1),
      },
      now: 0,
      clear: new Float32Array(4),
      testPixel: new Int32Array([-1, 0, 0]),
    };
    const ls = f.layers[SLIDE]!;
    ls.offer({ key: 'A', kind: SRC_BITMAP, bitmap: bitmap('A') });
    ls.requestFlip('A', 0, 0, 0);
    ls.tick(0, 16);
    ls.offer({ key: 'B', kind: SRC_BITMAP, bitmap: bitmap('B') });
    ls.requestFlip('B', 0, 500, 0);
    ls.tick(0, 16);
    expect(ls.fading).toBe(true);
    // Neither was uploaded yet (a compositor driven by hand): both are sampled by the crossfade.
    gpu.drainUploads(f, false);
    expect(dev.log.sort()).toEqual(['copy:A:layer1-stack1', 'copy:B:layer1-stack0']);
    // draw() itself never uploads.
    dev.log.length = 0;
    ls.offer({ key: 'C', kind: SRC_BITMAP, bitmap: bitmap('C') });
    gpu.draw(f);
    expect(dev.log).toEqual(['submit']);
  });

  it('a video stack needs no upload', async () => {
    const { gpu, dev } = await fakeGpu();
    const { e, frame } = engine(async () => gpu);
    await e.start();
    e.offer(LAYER_INDEX.media, { key: 'V', kind: SRC_VIDEO, videoSlot: 2 });
    e.flip(LAYER_INDEX.media, 'V', 0, 0);
    frame(0);
    expect(dev.log).toEqual(['submit']);
  });

  it('draws a WebGPU retry with its uploads before it replaces Canvas 2D', async () => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return new Proxy({}, { get: () => () => undefined });
        }
      },
    );
    const timers: (() => void)[] = [];
    const { gpu, dev } = await fakeGpu();
    let calls = 0;
    const e = new RenderEngine(
      {
        canvas: new OffscreenCanvas(W, H),
        width: W,
        height: H,
        testPixel: false,
        clear: { r: 0, g: 0, b: 0, a: 1 },
        clockOffset: 0,
        gpuRetryMs: 1000,
      },
      {
        raf: () => 0,
        wallNow: () => 0,
        requestCanvas: async () => new OffscreenCanvas(W, H),
        createGpu: async () => {
          if (calls++ === 0) throw new Error('no adapter');
          return gpu;
        },
        setTimeout: (fn) => {
          timers.push(fn);
          return 0;
        },
      },
    );
    expect((await e.start()).kind).toBe('2d');
    e.offer(SLIDE, { key: 'A', kind: SRC_BITMAP, bitmap: bitmap('A') });
    e.flip(SLIDE, 'A', 0, 0);
    e.layers[SLIDE]!.tick(0, 16);
    e.offer(SLIDE, { key: 'B', kind: SRC_BITMAP, bitmap: bitmap('B') });
    timers.shift()!();
    await vi.waitFor(() => expect(e.kind).toBe('webgpu'));
    expect(dev.log).toEqual(['copy:A:layer1-stack1', 'submit', 'copy:B:layer1-stack0']);
  });
});
