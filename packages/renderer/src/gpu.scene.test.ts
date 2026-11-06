import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Compositor, FrameInputs } from './compositor.ts';
import { RenderEngine } from './engine.ts';
import { GpuCompositor, PIPELINES, UNIFORM_SIZE, U_P, U_PLANE_A, U_PLANE_B, pipelineSources } from './gpu.ts';
import { PLANE_FLAGS, PLANE_FLOATS, PLANE_HAS_OVER, PLANE_OPACITY, PLANE_VIDEO } from './scene.ts';
import {
  LAYERS,
  LAYER_INDEX,
  LayerStack,
  SRC_BITMAP,
  SRC_SCENE,
  SRC_VIDEO,
  type StackContent,
} from './stacks.ts';

/**
 * The WebGPU scene compositor (design/27 §7.2) against a recording fake GPUDevice: pipelines, the uniform
 * layout, when over textures are allocated, the per-frame "video present" bit and bindings, and the
 * re-upload after a device loss. The pixels are checked in a browser by the compositor golden
 * (golden/compositor-run.ts).
 */

type Tex = { label: string; size: number[]; usage: number; destroyed: boolean; createView(): View };
type View = { tex: Tex };
type Frame = { name: string; displayWidth: number; displayHeight: number; closed: boolean; close(): void };

class FakeDevice {
  pipelines: string[] = [];
  textures: Tex[] = [];
  bindGroups: unknown[][] = [];
  bufferBindings: GPUBufferBinding[] = [];
  imports: unknown[] = [];
  copies: { source: unknown; texture: unknown }[] = [];
  uniform = new Float32Array(0);
  /** Per draw call: [pipeline label, bound resources]. */
  draws: [string, unknown[]][] = [];
  private pipe = '';
  private group: unknown[] = [];
  queue = {
    writeBuffer: (_b: unknown, _o: number, data: Float32Array) => {
      this.uniform = new Float32Array(data);
    },
    submit: () => undefined,
    copyExternalImageToTexture: (src: { source: unknown }, dst: { texture: unknown }) => {
      this.copies.push({ source: src.source, texture: dst.texture });
    },
  };
  createSampler() {
    return { sampler: true };
  }
  createBuffer() {
    return { destroy: () => undefined };
  }
  createShaderModule(d: { code: string }) {
    return d;
  }
  async createRenderPipelineAsync(d: { label: string }) {
    this.pipelines.push(d.label);
    return { label: d.label, getBindGroupLayout: () => ({ layout: d.label }) };
  }
  createTexture(d: { label: string; size: number[]; usage: number }): Tex {
    const t: Tex = {
      ...d,
      destroyed: false,
      createView: () => ({ tex: t }),
    };
    (t as unknown as { destroy(): void }).destroy = () => {
      t.destroyed = true;
    };
    this.textures.push(t);
    return t;
  }
  createBindGroup(d: { entries: { resource: unknown }[] }) {
    for (const e of d.entries)
      if ((e.resource as GPUBufferBinding).buffer) this.bufferBindings.push(e.resource as GPUBufferBinding);
    const g = d.entries.map((e) => e.resource);
    this.bindGroups.push(g);
    return { resources: g };
  }
  importExternalTexture(d: { source: unknown }) {
    this.imports.push(d.source);
    return { ext: d.source };
  }
  createCommandEncoder() {
    const pass = {
      setPipeline: (p: { label: string }) => {
        this.pipe = p.label;
      },
      setBindGroup: (_i: number, g: { resources: unknown[] }) => {
        this.group = g.resources;
      },
      setScissorRect: () => undefined,
      draw: () => {
        this.draws.push([this.pipe, this.group]);
      },
      end: () => undefined,
    };
    return { beginRenderPass: () => pass, finish: () => ({}) };
  }
  destroy() {}
}

const context = {
  getCurrentTexture: () => ({ createView: () => ({ canvas: true }) }),
  unconfigure: () => undefined,
} as unknown as GPUCanvasContext;

const W = 64;
const H = 36;
const SLOT_FLOATS = 64;
const SLIDE = LAYER_INDEX.slide;

async function compositor(dev = new FakeDevice()) {
  const c = new GpuCompositor(dev as unknown as GPUDevice, context, 'rgba8unorm', W, H, LAYERS.length);
  await c.compile();
  return { c, dev };
}

const bitmap = (name: string) =>
  ({ name, width: W, height: H, close: () => undefined }) as unknown as ImageBitmap;
const frame = (name: string): Frame => {
  const f: Frame = {
    name,
    displayWidth: 32,
    displayHeight: 18,
    closed: false,
    close: () => {
      f.closed = true;
    },
  };
  return f;
};

function inputs(): FrameInputs {
  return {
    layers: LAYERS.map(() => new LayerStack<ImageBitmap>()),
    video: {
      frames: [null, null, null, null],
      version: new Int32Array(4),
      gen: new Int32Array(4).fill(-1),
    },
    now: 0,
    clear: new Float32Array([0, 0, 0, 1]),
    testPixel: new Int32Array([-1, 0, 0]),
  };
}

function scene(key: string, over: boolean, slot = 2, gen = 5): StackContent<ImageBitmap> {
  const plane = new Float32Array(PLANE_FLOATS);
  plane[0] = 0.5;
  plane[PLANE_OPACITY] = 0.75;
  plane[PLANE_FLAGS] = PLANE_HAS_OVER | PLANE_VIDEO; // the compositor decides both bits itself
  return {
    key,
    kind: SRC_SCENE,
    bitmap: bitmap(`${key}-base`),
    over: over ? bitmap(`${key}-over`) : null,
    plane,
    videoSlot: slot,
    videoGen: gen,
  };
}

/** Offer `c` to a layer and make it live at once (cut). */
function show(f: FrameInputs, layer: number, c: StackContent<ImageBitmap>, gpu?: Compositor): void {
  gpu?.prepare?.(layer, c);
  const ls = f.layers[layer]!;
  ls.offer(c);
  ls.requestFlip(c.key, 0, 0, 0);
  ls.tick(0, 16);
}

/** One engine frame (engine.ts drawFrame): uploads for the draw, the draw, then the armed stacks' uploads. */
function drawn(c: GpuCompositor, f: FrameInputs): void {
  c.drainUploads(f, false);
  c.draw(f);
  c.drainUploads(f, true);
}

const flags = (dev: FakeDevice, layer: number, plane = U_PLANE_A) =>
  dev.uniform[layer * SLOT_FLOATS + plane + PLANE_FLAGS];

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
      closed = false;
      close() {
        this.closed = true;
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebGPU scene compositor', () => {
  it('compiles 13 pipelines (t e v, the 9 pairs, solid) before it is ready, with a 192-byte uniform', async () => {
    const { dev } = await compositor();
    expect(PIPELINES).toEqual([
      'single-t',
      'single-e',
      'single-v',
      'pair-tt',
      'pair-te',
      'pair-tv',
      'pair-et',
      'pair-ee',
      'pair-ev',
      'pair-vt',
      'pair-ve',
      'pair-vv',
      'solid',
    ]);
    expect(dev.pipelines).toEqual(PIPELINES);
    expect(UNIFORM_SIZE).toBe(192);
    expect(dev.bufferBindings.length).toBeGreaterThan(0);
    for (const b of dev.bufferBindings) {
      expect(b.size).toBe(192);
      expect((b.offset ?? 0) % 256).toBe(0);
      expect((b.offset ?? 0) + 192).toBeLessThanOrEqual(6 * 256);
    }
    // Every scene pipeline declares base, over and video for each scene source; vv stays within the
    // default 16 sampled textures per stage (an external texture counts 4).
    const src = pipelineSources();
    const vv = src[PIPELINES.indexOf('pair-vv')]!;
    expect(vv.match(/texture_external/g)).toHaveLength(2);
    expect(vv.match(/texture_2d<f32>/g)).toHaveLength(4);
    expect(vv).toContain('@binding(7) var srcB_video');
    expect(src[PIPELINES.indexOf('single-t')]).not.toContain('planeSample');
    expect(src[PIPELINES.indexOf('single-v')]).toContain('struct U');
  });

  it('allocates two over textures when the first scene with an over is offered, never in draw', async () => {
    const { c, dev } = await compositor();
    const startup = dev.textures.length;
    // Two textures per layer plus the 1x1 transparent texture, and nothing for overs yet.
    expect(startup).toBe(LAYERS.length * 2 + 1);
    expect(c.overBytes).toBe(0);
    c.prepare(SLIDE, scene('plain', false));
    c.prepare(SLIDE, { key: 'b', kind: SRC_BITMAP, bitmap: bitmap('b') });
    expect(dev.textures.length).toBe(startup);
    const f = inputs();
    show(f, SLIDE, scene('S', true), c);
    expect(dev.textures.length).toBe(startup + 2);
    expect(dev.textures.slice(startup).map((t) => t.label)).toEqual(['layer1-over0', 'layer1-over1']);
    expect(c.overBytes).toBe(2 * W * H * 4);
    c.prepare(SLIDE, scene('T', true));
    const allocated = dev.textures.length;
    drawn(c, f);
    show(f, SLIDE, scene('T', true), c);
    drawn(c, f);
    expect(dev.textures.length).toBe(allocated);
    // Base and over of each scene were uploaded into its stack's textures (S went to stack 1, T to 0).
    expect(dev.copies.map((x) => [(x.source as { name: string }).name, (x.texture as Tex).label])).toEqual([
      ['S-base', 'layer1-stack1'],
      ['S-over', 'layer1-over1'],
      ['T-base', 'layer1-stack0'],
      ['T-over', 'layer1-over0'],
    ]);
  });

  it('sets the video bit only while the slot holds a frame of the stack generation, and binds the placeholder otherwise', async () => {
    const { c, dev } = await compositor();
    const f = inputs();
    show(f, SLIDE, scene('S', true, 2, 5), c);
    // No frame: base and over draw, the placeholder frame satisfies the binding.
    drawn(c, f);
    expect(flags(dev, SLIDE)).toBe(PLANE_HAS_OVER);
    let [pipe, res] = dev.draws.at(-1)!;
    expect(pipe).toBe('single-v');
    expect((res[4] as { ext: { name: string } }).ext.name).toBe('placeholder');
    // A frame of the stack's generation: the video is drawn through the plane.
    const a = frame('clip-a');
    f.video.frames[2] = a as unknown as VideoFrame;
    f.video.gen[2] = 5;
    drawn(c, f);
    expect(flags(dev, SLIDE)).toBe(PLANE_HAS_OVER | PLANE_VIDEO);
    [pipe, res] = dev.draws.at(-1)!;
    expect((res[4] as { ext: Frame }).ext).toBe(a);
    const base = SLIDE * SLOT_FLOATS;
    expect(dev.uniform[base + U_PLANE_A]).toBe(0.5);
    expect(dev.uniform[base + U_PLANE_A + PLANE_OPACITY]).toBe(0.75);
    expect(dev.uniform[base + U_P + 1]).toBe(1);
    // The slot reloaded with another clip (a new generation): the poster in base shows instead.
    f.video.gen[2] = 6;
    drawn(c, f);
    expect(flags(dev, SLIDE)).toBe(PLANE_HAS_OVER);
    expect((dev.draws.at(-1)![1][4] as { ext: { name: string } }).ext.name).toBe('placeholder');
    // No over: the over bit stays off and the transparent texture is bound.
    show(f, SLIDE, scene('N', false, 2, 6), c);
    drawn(c, f);
    expect(flags(dev, SLIDE)).toBe(PLANE_VIDEO);
    expect(((dev.draws.at(-1)![1][3] as View).tex as Tex).label).toBe('transparent-1x1');
  });

  it('imports each frame once per drawn frame and adds no per-frame bind group for static bitmaps', async () => {
    const { c, dev } = await compositor();
    const f = inputs();
    show(f, LAYER_INDEX.background, { key: 'bg', kind: SRC_BITMAP, bitmap: bitmap('bg') }, c);
    const groups = dev.bindGroups.length;
    drawn(c, f);
    drawn(c, f);
    expect(dev.bindGroups.length).toBe(groups);
    expect(dev.imports).toHaveLength(0);
    expect(dev.draws.map((d) => d[0])).toEqual(['single-t', 'single-t']);
    // A scene and a media video sharing one slot import its frame once per frame.
    const a = frame('clip-a');
    f.video.frames[2] = a as unknown as VideoFrame;
    f.video.gen[2] = 5;
    show(f, SLIDE, scene('S', false, 2, 5), c);
    show(f, LAYER_INDEX.media, { key: 'm', kind: SRC_VIDEO, videoSlot: 2, fit: 1 }, c);
    drawn(c, f);
    expect(dev.imports).toEqual([a]);
  });

  it('crossfades two scenes in one pass with both planes and the pair-vv pipeline', async () => {
    const { c, dev } = await compositor();
    const f = inputs();
    const ls = f.layers[SLIDE]!;
    show(f, SLIDE, scene('A', false, 2, 1), c);
    const b = scene('B', true, 3, 2);
    b.plane![0] = 0.25;
    c.prepare(SLIDE, b);
    ls.offer(b);
    ls.requestFlip('B', 1000, 1000, 0);
    ls.tick(1000, 16);
    f.now = 1500;
    f.video.frames[2] = frame('a') as unknown as VideoFrame;
    f.video.gen[2] = 1;
    f.video.frames[3] = frame('b') as unknown as VideoFrame;
    f.video.gen[3] = 3; // stale: B shows its poster
    drawn(c, f);
    const slideDraws = dev.draws.filter((d) => d[0].startsWith('pair') || d[0].startsWith('single'));
    expect(slideDraws).toHaveLength(1);
    const [pipe, res] = slideDraws[0]!;
    expect(pipe).toBe('pair-vv');
    expect(res).toHaveLength(8);
    const base = SLIDE * SLOT_FLOATS;
    expect(dev.uniform[base + U_P]).toBeCloseTo(0.5);
    expect(dev.uniform[base + U_PLANE_A]).toBe(0.5);
    expect(dev.uniform[base + U_PLANE_B]).toBe(0.25);
    expect(flags(dev, SLIDE, U_PLANE_A)).toBe(PLANE_VIDEO);
    expect(flags(dev, SLIDE, U_PLANE_B)).toBe(PLANE_HAS_OVER);
    expect((res[4] as { ext: Frame }).ext.name).toBe('a');
    expect((res[7] as { ext: { name: string } }).ext.name).toBe('placeholder');
  });

  it('releases the over textures and the placeholder frame on destroy', async () => {
    const { c, dev } = await compositor();
    c.prepare(SLIDE, scene('S', true));
    const placeholder = (c as unknown as { placeholder: { closed: boolean } }).placeholder;
    c.destroy();
    expect(dev.textures.every((t) => t.destroyed)).toBe(true);
    expect(placeholder.closed).toBe(true);
  });
});

describe('RenderEngine and Compositor.prepare', () => {
  class Recorder implements Compositor {
    readonly kind = 'webgpu' as const;
    readonly width = 1920;
    readonly height = 1080;
    prepared: string[] = [];
    draw(): void {}
    destroy(): void {}
    prepare(layer: number, c: StackContent<ImageBitmap>): void {
      this.prepared.push(`${layer}:${c.key}`);
    }
  }

  function engine(gpus: Compositor[]) {
    let lost: ((reason: string) => void) | undefined;
    let n = 0;
    const e = new RenderEngine(
      {
        canvas: {} as OffscreenCanvas,
        width: 1920,
        height: 1080,
        testPixel: false,
        clear: { r: 0, g: 0, b: 0, a: 1 },
        clockOffset: 0,
        gpuRetryMs: 0,
      },
      {
        raf: () => 0,
        wallNow: () => 0,
        createGpu: async (init) => {
          lost = init.onLost;
          return gpus[n++]!;
        },
      },
    );
    return { e, lose: (r: string) => lost?.(r) };
  }

  it('hands every offer to the compositor before the layer holds it', async () => {
    const r = new Recorder();
    const { e } = engine([r]);
    await e.start();
    const c = scene('S', true);
    let held = '';
    r.prepare = (layer, x) => {
      held = e.layers[layer]!.armedStack.key;
      r.prepared.push(`${layer}:${x.key}`);
    };
    e.offer(SLIDE, c);
    expect(r.prepared).toEqual(['1:S']);
    expect(held).toBe('');
    expect(e.layers[SLIDE]!.armedStack.key).toBe('S');
  });

  it('hands a rebuilt compositor every held stack, so a device loss re-uploads base and over', async () => {
    const first = new Recorder();
    const dev = new FakeDevice();
    const gpu = new GpuCompositor(dev as unknown as GPUDevice, context, 'rgba8unorm', W, H, LAYERS.length);
    await gpu.compile();
    const { e, lose } = engine([first, gpu]);
    await e.start();
    e.offer(SLIDE, scene('S', true));
    e.flip(SLIDE, 'S', 0, 0);
    e.layers[SLIDE]!.tick(0, 16);
    e.offer(SLIDE, scene('T', false));
    lose('test');
    await vi.waitFor(() => expect(e.kind).toBe('webgpu'), { timeout: 2000 });
    await vi.waitFor(() => expect(gpu.overBytes).toBe(2 * W * H * 4), { timeout: 2000 });
    const before = dev.textures.length;
    drawn(gpu, (e as unknown as { inputs: FrameInputs }).inputs);
    expect(dev.textures.length).toBe(before);
    const names = dev.copies.map((x) => (x.source as { name: string }).name).sort();
    expect(names).toEqual(['S-base', 'S-over', 'T-base']);
  });
});
