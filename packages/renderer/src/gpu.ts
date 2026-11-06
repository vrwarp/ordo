import { type Compositor, type FrameInputs, MAX_VIDEO_SLOTS } from './compositor.ts';
import {
  type LayerStack,
  SRC_BITMAP,
  SRC_EMPTY,
  SRC_SCENE,
  SRC_VIDEO,
  type Stack,
  fitRect,
} from './stacks.ts';

/**
 * WebGPU compositor. Every pipeline, the sampler, uniform buffer, layer textures (two per layer, at
 * output resolution) and every bind group over those textures are created at startup. The frame path
 * writes into a pre-allocated Float32Array and mutates pre-allocated descriptors.
 *
 * Unavoidable per-frame objects come from the WebGPU API itself: the command encoder, the canvas texture
 * view, and, for video, the GPUExternalTexture imported from the latest VideoFrame plus its bind group.
 *
 * Every draw is a fullscreen triangle; the fragment shader maps the fragment position into each
 * source's rect (device px), so bitmaps (always full-frame) and fitted videos use the same pipelines.
 * Colours are premultiplied; blending is "over" (one, one-minus-src-alpha). A crossfade draws the
 * outgoing and incoming stacks in one pass with mix(a, b, t), which is exact for any alpha.
 */

const UNIFORM_SLOT_BYTES = 256;
const UNIFORM_SLOT_FLOATS = UNIFORM_SLOT_BYTES / 4;
const UNIFORM_SIZE = 64; // 4 x vec4f
const TEST_SLOT = 5;
const SLOTS = 6;

type SrcKind = 't' | 'e';

const COMMON = /* wgsl */ `
struct U { rectA: vec4f, rectB: vec4f, p: vec4f, color: vec4f };
@group(0) @binding(0) var<uniform> u: U;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[i], 0.0, 1.0);
}

fn uvIn(pos: vec2f, r: vec4f) -> vec3f {
  let uv = (pos - r.xy) / max(r.zw, vec2f(1.0));
  let inside = select(0.0, 1.0, all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)));
  return vec3f(clamp(uv, vec2f(0.0), vec2f(1.0)), inside);
}
`;

function sourceDecl(kind: SrcKind, name: string, binding: number): string {
  if (kind === 't')
    return `
@group(0) @binding(${binding}) var ${name}: texture_2d<f32>;
fn sample_${name}(pos: vec2f, r: vec4f) -> vec4f {
  let q = uvIn(pos, r);
  return textureSampleLevel(${name}, samp, q.xy, 0.0) * q.z;
}`;
  return `
@group(0) @binding(${binding}) var ${name}: texture_external;
fn sample_${name}(pos: vec2f, r: vec4f) -> vec4f {
  let q = uvIn(pos, r);
  let c = textureSampleBaseClampToEdge(${name}, samp, q.xy);
  return vec4f(c.rgb * c.a, c.a) * q.z;
}`;
}

function singleShader(kind: SrcKind): string {
  return `${COMMON}
@group(0) @binding(1) var samp: sampler;
${sourceDecl(kind, 'srcA', 2)}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return sample_srcA(pos.xy, u.rectA) * u.p.y;
}`;
}

function pairShader(a: SrcKind, b: SrcKind): string {
  return `${COMMON}
@group(0) @binding(1) var samp: sampler;
${sourceDecl(a, 'srcA', 2)}
${sourceDecl(b, 'srcB', 3)}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ca = sample_srcA(pos.xy, u.rectA);
  let cb = sample_srcB(pos.xy, u.rectB);
  return mix(ca, cb, u.p.x) * u.p.y;
}`;
}

const SOLID_SHADER = `${COMMON}
@fragment fn fs() -> @location(0) vec4f { return u.color; }`;

type Pipes = {
  t: GPURenderPipeline;
  e: GPURenderPipeline;
  tt: GPURenderPipeline;
  te: GPURenderPipeline;
  et: GPURenderPipeline;
  ee: GPURenderPipeline;
  solid: GPURenderPipeline;
};

/** Mutable bind group descriptor whose source entries are swapped per draw (video only). */
type DynDesc = { desc: GPUBindGroupDescriptor; entries: GPUBindGroupEntry[] };

export type GpuInit = {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  layerCount: number;
  onLost: (reason: string) => void;
  onError?: (message: string) => void;
  /** Called once the canvas is bound to WebGPU (it can no longer give a 2D context). */
  onContext?: () => void;
};

export async function createGpuCompositor(init: GpuInit): Promise<GpuCompositor> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) throw new Error('WebGPU unavailable (navigator.gpu missing)');
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU unavailable (no adapter)');
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (ev) => {
    console.error('[ordo] WebGPU error:', (ev as GPUUncapturedErrorEvent).error.message);
    init.onError?.((ev as GPUUncapturedErrorEvent).error.message);
  });
  const context = init.canvas.getContext('webgpu');
  if (!context) throw new Error('WebGPU canvas context unavailable');
  init.onContext?.();
  const format = gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: 'opaque',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const c = new GpuCompositor(device, context, format, init.width, init.height, init.layerCount);
  // Keep the adapter reachable: if it is garbage collected some implementations drop the instance and
  // lose the device ("A valid external Instance reference no longer exists").
  c.adapter = adapter;
  await c.compile();
  let destroyed = false;
  c.onDestroy = () => {
    destroyed = true;
  };
  void device.lost.then((info) => {
    if (destroyed) return;
    init.onLost(info.message || String(info.reason));
  });
  return c;
}

export class GpuCompositor implements Compositor {
  readonly kind = 'webgpu' as const;
  onDestroy?: () => void;
  adapter?: GPUAdapter;
  private pipes!: Pipes;
  private sampler: GPUSampler;
  private uniformBuf: GPUBuffer;
  private uniformData = new Float32Array(SLOTS * UNIFORM_SLOT_FLOATS);
  private textures: GPUTexture[][] = [];
  private bgSingle: GPUBindGroup[][] = [];
  private bgPairTT: GPUBindGroup[][] = [];
  private bgSolidTest!: GPUBindGroup;
  private uploaded: Int32Array[] = [];
  // Video
  private ext: (GPUExternalTexture | null)[] = [];
  private extFrame = new Int32Array(MAX_VIDEO_SLOTS).fill(-1);
  private importDesc: GPUExternalTextureDescriptor[] = [];
  private dynSingleE: DynDesc[] = [];
  private dynTE: DynDesc[] = [];
  private dynET: DynDesc[] = [];
  private dynEE: DynDesc[] = [];
  private frameNo = 0;
  // Pass
  private colorAttachment: GPURenderPassColorAttachment;
  private passDesc: GPURenderPassDescriptor;
  private clearValue = { r: 0, g: 0, b: 0, a: 1 };
  private cmd: GPUCommandBuffer[] = [];
  private copyDst: GPUCopyExternalImageDestInfo;
  private copySrc: GPUCopyExternalImageSourceInfo;
  private copySize = new Uint32Array(2);

  constructor(
    readonly device: GPUDevice,
    private context: GPUCanvasContext,
    private format: GPUTextureFormat,
    readonly width: number,
    readonly height: number,
    private layerCount: number,
  ) {
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.uniformBuf = device.createBuffer({
      size: SLOTS * UNIFORM_SLOT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.colorAttachment = {
      view: undefined as unknown as GPUTextureView,
      clearValue: this.clearValue,
      loadOp: 'clear',
      storeOp: 'store',
    };
    this.passDesc = { colorAttachments: [this.colorAttachment] };
    this.copySrc = { source: undefined as unknown as ImageBitmap };
    this.copyDst = { texture: undefined as unknown as GPUTexture, premultipliedAlpha: true };
    for (let s = 0; s < MAX_VIDEO_SLOTS; s++) {
      this.ext.push(null);
      this.importDesc.push({ source: undefined as unknown as VideoFrame });
    }
  }

  /** Compile all pipelines and allocate every texture and bind group. */
  async compile(): Promise<void> {
    const d = this.device;
    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const make = async (code: string, label: string) => {
      const module = d.createShaderModule({ code, label });
      return d.createRenderPipelineAsync({
        label,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    };
    const [t, e, tt, te, et, ee, solid] = await Promise.all([
      make(singleShader('t'), 'single-tex'),
      make(singleShader('e'), 'single-ext'),
      make(pairShader('t', 't'), 'pair-tt'),
      make(pairShader('t', 'e'), 'pair-te'),
      make(pairShader('e', 't'), 'pair-et'),
      make(pairShader('e', 'e'), 'pair-ee'),
      make(SOLID_SHADER, 'solid'),
    ]);
    this.pipes = { t, e, tt, te, et, ee, solid };

    const ubuf = (slot: number): GPUBufferBinding => ({
      buffer: this.uniformBuf,
      offset: slot * UNIFORM_SLOT_BYTES,
      size: UNIFORM_SIZE,
    });
    for (let l = 0; l < this.layerCount; l++) {
      const texs: GPUTexture[] = [];
      for (let s = 0; s < 2; s++)
        texs.push(
          d.createTexture({
            label: `layer${l}-stack${s}`,
            size: [this.width, this.height],
            format: 'rgba8unorm',
            usage:
              GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
          }),
        );
      this.textures.push(texs);
      const views = texs.map((x) => x.createView());
      this.bgSingle.push(
        [0, 1].map((s) =>
          d.createBindGroup({
            layout: t.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: ubuf(l) },
              { binding: 1, resource: this.sampler },
              { binding: 2, resource: views[s]! },
            ],
          }),
        ),
      );
      // Pair (A = outgoing stack, B = incoming stack), indexed by the outgoing stack.
      this.bgPairTT.push(
        [0, 1].map((out) =>
          d.createBindGroup({
            layout: tt.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: ubuf(l) },
              { binding: 1, resource: this.sampler },
              { binding: 2, resource: views[out]! },
              { binding: 3, resource: views[1 - out]! },
            ],
          }),
        ),
      );
      const dyn = (pipe: GPURenderPipeline, n: number): DynDesc => {
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: ubuf(l) },
          { binding: 1, resource: this.sampler },
        ];
        for (let i = 0; i < n; i++) entries.push({ binding: 2 + i, resource: views[0]! });
        return { entries, desc: { layout: pipe.getBindGroupLayout(0), entries } };
      };
      this.dynSingleE.push(dyn(e, 1));
      this.dynTE.push(dyn(te, 2));
      this.dynET.push(dyn(et, 2));
      this.dynEE.push(dyn(ee, 2));
      this.uploaded.push(new Int32Array(2).fill(-1));
    }
    this.bgSolidTest = d.createBindGroup({
      layout: solid.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: ubuf(TEST_SLOT) }],
    });
    this.textureViews = this.textures.map((l) => l.map((x) => x.createView()));
  }

  private textureViews: GPUTextureView[][] = [];

  draw(f: FrameInputs): void {
    /* @hot */
    this.frameNo++;
    const d = this.device;
    this.clearValue.r = f.clear[0]!;
    this.clearValue.g = f.clear[1]!;
    this.clearValue.b = f.clear[2]!;
    this.colorAttachment.view = this.context.getCurrentTexture().createView();
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass(this.passDesc);
    for (let l = 0; l < f.layers.length && l < this.layerCount; l++) this.drawLayer(pass, f.layers[l]!, l, f);
    if (f.testPixel[0]! >= 0) {
      const b = TEST_SLOT * UNIFORM_SLOT_FLOATS + 12;
      this.uniformData[b] = f.testPixel[0]! / 255;
      this.uniformData[b + 1] = f.testPixel[1]! / 255;
      this.uniformData[b + 2] = f.testPixel[2]! / 255;
      this.uniformData[b + 3] = 1;
      pass.setPipeline(this.pipes.solid);
      pass.setBindGroup(0, this.bgSolidTest);
      pass.setScissorRect(0, 0, 1, 1);
      pass.draw(3);
    }
    pass.end();
    d.queue.writeBuffer(this.uniformBuf, 0, this.uniformData);
    this.cmd[0] = enc.finish();
    d.queue.submit(this.cmd);
  }

  private drawLayer(
    pass: GPURenderPassEncoder,
    ls: LayerStack<ImageBitmap>,
    l: number,
    f: FrameInputs,
  ): void {
    /* @hot */
    const liveIdx = ls.live;
    const outIdx = 1 - liveIdx;
    const live = ls.stacks[liveIdx]!;
    const out = ls.stacks[outIdx]!;
    const liveOn = this.hasSource(live, f);
    const outOn = ls.fading && this.hasSource(out, f);
    if (!liveOn && !outOn) return;
    const w = ls.weight(f.now);
    const u = this.uniformData;
    const base = l * UNIFORM_SLOT_FLOATS;
    if (liveOn && outOn) {
      this.writeRect(out, f, base);
      this.writeRect(live, f, base + 4);
      u[base + 8] = w;
      u[base + 9] = 1;
      const ae = out.kind === SRC_VIDEO;
      const be = live.kind === SRC_VIDEO;
      if (!ae && !be) {
        pass.setPipeline(this.pipes.tt);
        pass.setBindGroup(0, this.bgPairTT[l]![outIdx]!);
      } else {
        const dd = ae && be ? this.dynEE[l]! : ae ? this.dynET[l]! : this.dynTE[l]!;
        dd.entries[2]!.resource = ae ? this.extFor(out.videoSlot, f) : this.textureViews[l]![outIdx]!;
        dd.entries[3]!.resource = be ? this.extFor(live.videoSlot, f) : this.textureViews[l]![liveIdx]!;
        pass.setPipeline(ae && be ? this.pipes.ee : ae ? this.pipes.et : this.pipes.te);
        pass.setBindGroup(0, this.device.createBindGroup(dd.desc));
      }
      pass.draw(3);
      return;
    }
    const s = liveOn ? live : out;
    const sIdx = liveOn ? liveIdx : outIdx;
    this.writeRect(s, f, base);
    u[base + 8] = 1;
    u[base + 9] = liveOn ? w : 1 - w;
    if (s.kind === SRC_VIDEO) {
      const dd = this.dynSingleE[l]!;
      dd.entries[2]!.resource = this.extFor(s.videoSlot, f);
      pass.setPipeline(this.pipes.e);
      pass.setBindGroup(0, this.device.createBindGroup(dd.desc));
    } else {
      pass.setPipeline(this.pipes.t);
      pass.setBindGroup(0, this.bgSingle[l]![sIdx]!);
    }
    pass.draw(3);
  }

  private writeRect(s: Stack<ImageBitmap>, f: FrameInputs, o: number): void {
    /* @hot */
    const u = this.uniformData;
    if (s.kind === SRC_VIDEO) {
      const fr = f.video.frames[s.videoSlot]!;
      fitRect(fr.displayWidth, fr.displayHeight, this.width, this.height, s.fit, u, o);
      return;
    }
    u[o] = 0;
    u[o + 1] = 0;
    u[o + 2] = this.width;
    u[o + 3] = this.height;
  }

  /** Import the slot's latest VideoFrame once per frame. */
  private extFor(slot: number, f: FrameInputs): GPUExternalTexture {
    /* @hot */
    if (this.extFrame[slot] !== this.frameNo || !this.ext[slot]) {
      const desc = this.importDesc[slot]!;
      desc.source = f.video.frames[slot]!;
      this.ext[slot] = this.device.importExternalTexture(desc);
      this.extFrame[slot] = this.frameNo;
    }
    return this.ext[slot]!;
  }

  private hasSource(s: Stack<ImageBitmap>, f: FrameInputs): boolean {
    /* @hot */
    if (s.kind === SRC_EMPTY) return false;
    // M5 (B, SCENE.md): a scene draws its base as a bitmap until the scene pipelines land.
    if (s.kind === SRC_BITMAP || s.kind === SRC_SCENE) return s.bitmap !== null;
    return s.videoSlot >= 0 && s.videoSlot < MAX_VIDEO_SLOTS && f.video.frames[s.videoSlot] != null;
  }

  /** See Compositor.drainUploads: `draw` samples only textures uploaded here. */
  drainUploads(f: FrameInputs, all: boolean): void {
    /* @hot */
    for (let l = 0; l < f.layers.length && l < this.layerCount; l++) {
      const ls = f.layers[l]!;
      const liveIdx = ls.live;
      this.ensureUploaded(l, liveIdx, ls.stacks[liveIdx]!);
      if (all || ls.fading) this.ensureUploaded(l, 1 - liveIdx, ls.stacks[1 - liveIdx]!);
    }
  }

  /** Upload a stack's bitmap into its texture when its content changed (arm time, not every frame). */
  private ensureUploaded(l: number, idx: number, s: Stack<ImageBitmap>): void {
    /* @hot */
    const up = this.uploaded[l]!;
    if (up[idx] === s.version) return;
    up[idx] = s.version;
    if ((s.kind !== SRC_BITMAP && s.kind !== SRC_SCENE) || !s.bitmap) return;
    this.upload(l, idx, s.bitmap);
  }

  private upload(l: number, idx: number, bitmap: ImageBitmap): void {
    this.copySrc.source = bitmap;
    this.copyDst.texture = this.textures[l]![idx]!;
    this.copySize[0] = Math.min(bitmap.width, this.width);
    this.copySize[1] = Math.min(bitmap.height, this.height);
    try {
      this.device.queue.copyExternalImageToTexture(this.copySrc, this.copyDst, this.copySize);
    } catch (err) {
      console.error('[ordo] texture upload failed', err);
    }
  }

  destroy(): void {
    this.onDestroy?.();
    for (const l of this.textures) for (const t of l) t.destroy();
    this.uniformBuf.destroy();
    try {
      this.context.unconfigure();
    } catch {
      /* already gone */
    }
    this.device.destroy();
  }
}
