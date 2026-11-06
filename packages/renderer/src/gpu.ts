import { type Compositor, type FrameInputs, MAX_VIDEO_SLOTS, sceneVideoPresent } from './compositor.ts';
import { PLANE_FLAGS, PLANE_HAS_OVER, PLANE_VIDEO } from './scene.ts';
import {
  type LayerStack,
  SRC_BITMAP,
  SRC_EMPTY,
  SRC_SCENE,
  SRC_VIDEO,
  type Stack,
  type StackContent,
  fitRect,
} from './stacks.ts';

/**
 * WebGPU compositor. Every pipeline, the sampler, uniform buffer, layer textures (two per layer, at
 * output resolution) and every bind group over those textures are created at startup. The frame path
 * writes into a pre-allocated Float32Array and mutates pre-allocated descriptors.
 *
 * Unavoidable per-frame objects come from the WebGPU API itself: the command encoder, the canvas texture
 * view, and, for video and scenes, the GPUExternalTexture imported from the latest VideoFrame plus its bind
 * group.
 *
 * Every draw is a fullscreen triangle; the fragment shader maps the fragment position into each
 * source's rect (device px), so bitmaps (always full-frame) and fitted videos use the same pipelines.
 * Colours are premultiplied; blending is "over" (one, one-minus-src-alpha). A crossfade draws the
 * outgoing and incoming stacks in one pass with mix(a, b, t), which is exact for any alpha.
 *
 * Source kinds (design/27 §7.2): t a bitmap texture, e a full-frame video (external texture), v a scene
 * (SRC_SCENE): the base texture, the slot's video drawn through the stack's plane (scene.ts) only while
 * the "video present" bit is set, then the over texture. Singles t e v, pairs tt te tv et ee ev vt ve vv
 * and the test-pixel solid make 13 pipelines, all compiled before the compositor is ready. A scene's
 * `over` textures (two full-frame textures per layer) are allocated when the first scene with an over is
 * offered (`prepare`), never on a flip; until then a 1x1 transparent texture is bound. A slot without a
 * frame of the stack's generation binds a 1x1 placeholder VideoFrame made at startup; the bit, not the
 * frame's alpha, decides whether it is sampled.
 */

const UNIFORM_SLOT_BYTES = 256;
const UNIFORM_SLOT_FLOATS = UNIFORM_SLOT_BYTES / 4;
/** struct U { rectA, rectB, p, color, planeA: array<vec4f, 4>, planeB: array<vec4f, 4> }: 12 x vec4f. */
export const UNIFORM_SIZE = 192;
/** Float offsets inside a layer's uniform slot. */
export const U_RECT_A = 0;
export const U_RECT_B = 4;
export const U_P = 8;
export const U_COLOR = 12;
export const U_PLANE_A = 16;
export const U_PLANE_B = 32;
const TEST_SLOT = 5;
const SLOTS = 6;

/** Source kinds, in pipeline index order: single k, pair ka * 3 + kb. */
type SrcKind = 't' | 'e' | 'v';
const KINDS: readonly SrcKind[] = ['t', 'e', 'v'];
const K_T = 0;
const K_E = 1;
const K_V = 2;
/** Bindings a source of each kind takes (v: base, over, video). */
const BINDINGS = [1, 1, 3];
/** The ext slot of the placeholder VideoFrame (after the real video slots). */
const PLACEHOLDER = MAX_VIDEO_SLOTS;

/** Pipeline labels in compile order: 3 singles, 9 pairs, solid. */
export const PIPELINES: readonly string[] = [
  ...KINDS.map((k) => `single-${k}`),
  ...KINDS.flatMap((a) => KINDS.map((b) => `pair-${a}${b}`)),
  'solid',
];

const COMMON = /* wgsl */ `
struct U {
  rectA: vec4f,
  rectB: vec4f,
  p: vec4f,
  color: vec4f,
  planeA: array<vec4f, 4>,
  planeB: array<vec4f, 4>,
};
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

/**
 * The plane of a scene (scene.ts, PLANE_FLOATS floats as 4 x vec4f: [a b c d] [e f u0 v0] [u1 v1 mask rx]
 * [ry opacity aa flags]), the same maths as planeSample: returns the video UV at device point `pos` and
 * its weight (mask coverage within the source, anti-aliased over `aa` device px, times opacity).
 */
const PLANE = /* wgsl */ `
fn ramp(d: f32, w: f32) -> f32 {
  if (w <= 0.0) { return select(0.0, 1.0, d >= 0.0); }
  return clamp(d / w + 0.5, 0.0, 1.0);
}

fn ellipseCov(p: vec2f, o: vec2f, r: vec2f, m: vec4f, aa: f32) -> f32 {
  let q = (p - o) / r;
  let g = length(q);
  if (g < 1e-6) { return 1.0; }
  let k = q / (r * g);
  let grad = length(vec2f(k.x * m.x + k.y * m.y, k.x * m.z + k.y * m.w));
  if (grad > 0.0) { return ramp((1.0 - g) / grad, aa); }
  return select(0.0, 1.0, g <= 1.0);
}

fn planeSample(pos: vec2f, pl: array<vec4f, 4>) -> vec3f {
  let m = pl[0];
  let u = m.x * pos.x + m.z * pos.y + pl[1].x;
  let v = m.y * pos.x + m.w * pos.y + pl[1].y;
  let uv0 = pl[1].zw;
  let span = pl[2].xy - uv0;
  let t = uv0 + vec2f(u, v) * span;
  let aa = pl[3].z;
  let du = length(m.xz);
  let dv = length(m.yw);
  let gu = abs(span.x) * du;
  let gv = abs(span.y) * dv;
  var fu = -1.0;
  var fv = -1.0;
  var su = -1.0;
  var sv = -1.0;
  if (du > 0.0) { fu = min(u, 1.0 - u) / du; }
  if (dv > 0.0) { fv = min(v, 1.0 - v) / dv; }
  if (gu > 0.0) { su = min(t.x, 1.0 - t.x) / gu; }
  if (gv > 0.0) { sv = min(t.y, 1.0 - t.y) / gv; }
  let kind = pl[2].z;
  let rad = vec2f(pl[2].w, pl[3].x);
  let src = ramp(su, aa) * ramp(sv, aa);
  var w = 0.0;
  if (kind > 0.5 && kind < 1.5) {
    w = min(ellipseCov(vec2f(u, v), vec2f(0.5), vec2f(0.5), m, aa), src);
  } else if (kind > 1.5 && kind < 2.5 && rad.x > 0.0 && rad.y > 0.0 &&
             (u < rad.x || u > 1.0 - rad.x) && (v < rad.y || v > 1.0 - rad.y)) {
    let o = vec2f(select(1.0 - rad.x, rad.x, u < rad.x), select(1.0 - rad.y, rad.y, v < rad.y));
    w = min(ellipseCov(vec2f(u, v), o, rad, m, aa), src);
  } else {
    w = ramp(min(fu, su), aa) * ramp(min(fv, sv), aa);
  }
  return vec3f(clamp(t, vec2f(0.0), vec2f(1.0)), w * pl[3].y);
}
`;

/** WGSL declarations and `sample_<name>(pos, rect)` of one source, from binding `b`. */
function sourceDecl(kind: SrcKind, name: string, b: number, plane: string): string {
  if (kind === 't')
    return `
@group(0) @binding(${b}) var ${name}: texture_2d<f32>;
fn sample_${name}(pos: vec2f, r: vec4f) -> vec4f {
  let q = uvIn(pos, r);
  return textureSampleLevel(${name}, samp, q.xy, 0.0) * q.z;
}`;
  if (kind === 'e')
    return `
@group(0) @binding(${b}) var ${name}: texture_external;
fn sample_${name}(pos: vec2f, r: vec4f) -> vec4f {
  let q = uvIn(pos, r);
  let c = textureSampleBaseClampToEdge(${name}, samp, q.xy);
  return vec4f(c.rgb * c.a, c.a) * q.z;
}`;
  // Scene: c = base; if (video present) c = video over c; if (has over) c = over over c.
  return `
@group(0) @binding(${b}) var ${name}_base: texture_2d<f32>;
@group(0) @binding(${b + 1}) var ${name}_over: texture_2d<f32>;
@group(0) @binding(${b + 2}) var ${name}_video: texture_external;
fn sample_${name}(pos: vec2f, r: vec4f) -> vec4f {
  let q = uvIn(pos, r);
  let pl = u.${plane};
  let flags = u32(pl[3].w + 0.5);
  var c = textureSampleLevel(${name}_base, samp, q.xy, 0.0) * q.z;
  if ((flags & ${PLANE_VIDEO}u) != 0u) {
    let s = planeSample(pos, pl);
    let t = textureSampleBaseClampToEdge(${name}_video, samp, s.xy);
    let vc = vec4f(t.rgb * t.a, t.a) * s.z;
    c = vc + c * (1.0 - vc.a);
  }
  if ((flags & ${PLANE_HAS_OVER}u) != 0u) {
    let o = textureSampleLevel(${name}_over, samp, q.xy, 0.0) * q.z;
    c = o + c * (1.0 - o.a);
  }
  return c;
}`;
}

function singleShader(kind: SrcKind): string {
  return `${COMMON}${kind === 'v' ? PLANE : ''}
@group(0) @binding(1) var samp: sampler;
${sourceDecl(kind, 'srcA', 2, 'planeA')}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return sample_srcA(pos.xy, u.rectA) * u.p.y;
}`;
}

function pairShader(a: SrcKind, b: SrcKind): string {
  return `${COMMON}${a === 'v' || b === 'v' ? PLANE : ''}
@group(0) @binding(1) var samp: sampler;
${sourceDecl(a, 'srcA', 2, 'planeA')}
${sourceDecl(b, 'srcB', 2 + BINDINGS[KINDS.indexOf(a)]!, 'planeB')}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ca = sample_srcA(pos.xy, u.rectA);
  let cb = sample_srcB(pos.xy, u.rectB);
  return mix(ca, cb, u.p.x) * u.p.y;
}`;
}

const SOLID_SHADER = `${COMMON}
@fragment fn fs() -> @location(0) vec4f { return u.color; }`;

/** The WGSL of every pipeline, in PIPELINES order (exported for tests). */
export function pipelineSources(): string[] {
  return [
    ...KINDS.map((k) => singleShader(k)),
    ...KINDS.flatMap((a) => KINDS.map((b) => pairShader(a, b))),
    SOLID_SHADER,
  ];
}

/** Mutable bind group descriptor whose source entries are swapped per draw (video and scenes). */
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

/**
 * The 1x1 VideoFrame bound for a scene whose slot has no frame of its generation. It is never sampled:
 * the "video present" bit decides, since external textures may not keep alpha. It is opaque black, so a
 * wrong bit shows as black (which the compositor golden's poster probes catch) instead of hiding behind
 * an alpha that some GPUs keep.
 */
function placeholderFrame(): VideoFrame {
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 1, 1);
  }
  return new VideoFrame(canvas, { timestamp: 0 });
}

export class GpuCompositor implements Compositor {
  readonly kind = 'webgpu' as const;
  onDestroy?: () => void;
  adapter?: GPUAdapter;
  /** Pipelines: single[k] and pair[ka * 3 + kb] by source kind (t e v), plus the test-pixel solid. */
  private single: GPURenderPipeline[] = [];
  private pair: GPURenderPipeline[] = [];
  private solid!: GPURenderPipeline;
  private sampler: GPUSampler;
  private uniformBuf: GPUBuffer;
  private uniformData = new Float32Array(SLOTS * UNIFORM_SLOT_FLOATS);
  private textures: GPUTexture[][] = [];
  private textureViews: GPUTextureView[][] = [];
  private bgSingle: GPUBindGroup[][] = [];
  private bgPairTT: GPUBindGroup[][] = [];
  private bgSolidTest!: GPUBindGroup;
  /** Per layer, by kind index (e, v) and by pair index (all but tt): descriptors re-bound per draw. */
  private dynSingle: DynDesc[][] = [];
  private dynPair: DynDesc[][] = [];
  private uploaded: Int32Array[] = [];
  // Scenes
  /** Per layer, the over textures of stacks 0 and 1 (null until a scene with an over is offered). */
  private overTex: (GPUTexture[] | null)[] = [];
  private overViews: (GPUTextureView[] | null)[] = [];
  /** 1x1 transparent texture bound for a scene without an over (or without a base). */
  private clearTex!: GPUTexture;
  private clearView!: GPUTextureView;
  private placeholder: VideoFrame | null = null;
  /** Bytes of scene over textures allocated (GPU memory telemetry and tests). */
  overBytes = 0;
  // Video (external textures by slot; PLACEHOLDER is the placeholder frame)
  private ext: (GPUExternalTexture | null)[] = [];
  private extFrame = new Int32Array(MAX_VIDEO_SLOTS + 1).fill(-1);
  private importDesc: GPUExternalTextureDescriptor[] = [];
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
    for (let s = 0; s <= MAX_VIDEO_SLOTS; s++) {
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
    const sources = pipelineSources();
    const pipes = await Promise.all(sources.map((code, i) => make(code, PIPELINES[i]!)));
    this.single = pipes.slice(0, 3);
    this.pair = pipes.slice(3, 12);
    this.solid = pipes[12]!;

    this.clearTex = d.createTexture({
      label: 'transparent-1x1',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.clearView = this.clearTex.createView();
    this.placeholder = placeholderFrame();

    const ubuf = (slot: number): GPUBufferBinding => ({
      buffer: this.uniformBuf,
      offset: slot * UNIFORM_SLOT_BYTES,
      size: UNIFORM_SIZE,
    });
    const t = this.single[K_T]!;
    const tt = this.pair[K_T * 3 + K_T]!;
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
      this.textureViews.push(views);
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
      // Static bind groups serve t and tt; every other combination is re-bound per draw.
      const singles: DynDesc[] = [];
      for (let k = 0; k < 3; k++) if (k !== K_T) singles[k] = dyn(this.single[k]!, BINDINGS[k]!);
      const pairs: DynDesc[] = [];
      for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++)
          if (a !== K_T || b !== K_T)
            pairs[a * 3 + b] = dyn(this.pair[a * 3 + b]!, BINDINGS[a]! + BINDINGS[b]!);
      this.dynSingle.push(singles);
      this.dynPair.push(pairs);
      this.uploaded.push(new Int32Array(2).fill(-1));
      this.overTex.push(null);
      this.overViews.push(null);
    }
    this.bgSolidTest = d.createBindGroup({
      layout: this.solid.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: ubuf(TEST_SLOT) }],
    });
  }

  /**
   * The engine's offer hook: the first scene with an over allocates its layer's two over textures (+66 MB
   * at 4K), here rather than on the flip that shows it.
   */
  prepare(layer: number, c: StackContent<ImageBitmap>): void {
    if (c.kind === SRC_SCENE && c.over && layer >= 0 && layer < this.layerCount) this.allocOver(layer);
  }

  private allocOver(l: number): void {
    if (this.overTex[l]) return;
    const texs: GPUTexture[] = [];
    for (let s = 0; s < 2; s++)
      texs.push(
        this.device.createTexture({
          label: `layer${l}-over${s}`,
          size: [this.width, this.height],
          format: 'rgba8unorm',
          // copyExternalImageToTexture needs RENDER_ATTACHMENT on its destination.
          usage:
            GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        }),
      );
    this.overTex[l] = texs;
    this.overViews[l] = texs.map((x) => x.createView());
    this.overBytes += 2 * this.width * this.height * 4;
  }

  /** See Compositor.gpuBytes: two layer textures per layer, plus the over textures allocated. */
  gpuBytes(): number {
    return this.textures.length * 2 * this.width * this.height * 4 + this.overBytes;
  }

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
      const b = TEST_SLOT * UNIFORM_SLOT_FLOATS + U_COLOR;
      this.uniformData[b] = f.testPixel[0]! / 255;
      this.uniformData[b + 1] = f.testPixel[1]! / 255;
      this.uniformData[b + 2] = f.testPixel[2]! / 255;
      this.uniformData[b + 3] = 1;
      pass.setPipeline(this.solid);
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
      const ka = this.kindOf(out, l, f);
      const kb = this.kindOf(live, l, f);
      this.writeRect(out, f, base + U_RECT_A);
      this.writeRect(live, f, base + U_RECT_B);
      if (ka === K_V) this.writePlane(out, f, l, base + U_PLANE_A);
      if (kb === K_V) this.writePlane(live, f, l, base + U_PLANE_B);
      u[base + U_P] = w;
      u[base + U_P + 1] = 1;
      pass.setPipeline(this.pair[ka * 3 + kb]!);
      if (ka === K_T && kb === K_T) pass.setBindGroup(0, this.bgPairTT[l]![outIdx]!);
      else {
        const dd = this.dynPair[l]![ka * 3 + kb]!;
        const next = this.bindSource(dd.entries, 2, out, outIdx, l, f);
        this.bindSource(dd.entries, next, live, liveIdx, l, f);
        pass.setBindGroup(0, this.device.createBindGroup(dd.desc));
      }
      pass.draw(3);
      return;
    }
    const s = liveOn ? live : out;
    const sIdx = liveOn ? liveIdx : outIdx;
    const k = this.kindOf(s, l, f);
    this.writeRect(s, f, base + U_RECT_A);
    if (k === K_V) this.writePlane(s, f, l, base + U_PLANE_A);
    u[base + U_P] = 1;
    u[base + U_P + 1] = liveOn ? w : 1 - w;
    pass.setPipeline(this.single[k]!);
    if (k === K_T) pass.setBindGroup(0, this.bgSingle[l]![sIdx]!);
    else {
      const dd = this.dynSingle[l]![k]!;
      this.bindSource(dd.entries, 2, s, sIdx, l, f);
      pass.setBindGroup(0, this.device.createBindGroup(dd.desc));
    }
    pass.draw(3);
  }

  /** Point the bind group entries of one source, from entry `at`, at its resources; returns the next. */
  private bindSource(
    e: GPUBindGroupEntry[],
    at: number,
    s: Stack<ImageBitmap>,
    idx: number,
    l: number,
    f: FrameInputs,
  ): number {
    /* @hot */
    if (s.kind === SRC_VIDEO) {
      e[at]!.resource = this.extFor(s.videoSlot, f);
      return at + 1;
    }
    if (s.kind === SRC_SCENE) {
      e[at]!.resource = s.bitmap ? this.textureViews[l]![idx]! : this.clearView;
      const ov = this.overViews[l];
      e[at + 1]!.resource = s.over && ov ? ov[idx]! : this.clearView;
      e[at + 2]!.resource = sceneVideoPresent(s, f.video)
        ? this.extFor(s.videoSlot, f)
        : this.importExt(PLACEHOLDER, this.placeholder!);
      return at + 3;
    }
    e[at]!.resource = this.textureViews[l]![idx]!;
    return at + 1;
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

  /**
   * Copy a scene's plane into the uniform and set its flags for this frame: PLANE_VIDEO only while the
   * slot holds a frame of the stack's generation, PLANE_HAS_OVER only when an over texture is bound.
   */
  private writePlane(s: Stack<ImageBitmap>, f: FrameInputs, l: number, o: number): void {
    /* @hot */
    const u = this.uniformData;
    u.set(s.plane, o);
    let flags = 0;
    if (s.over && this.overViews[l]) flags |= PLANE_HAS_OVER;
    if (sceneVideoPresent(s, f.video)) flags |= PLANE_VIDEO;
    u[o + PLANE_FLAGS] = flags;
  }

  /** Import the slot's latest VideoFrame once per frame. */
  private extFor(slot: number, f: FrameInputs): GPUExternalTexture {
    /* @hot */
    return this.importExt(slot, f.video.frames[slot]!);
  }

  private importExt(i: number, frame: VideoFrame): GPUExternalTexture {
    /* @hot */
    if (this.extFrame[i] !== this.frameNo || !this.ext[i]) {
      const desc = this.importDesc[i]!;
      desc.source = frame;
      this.ext[i] = this.device.importExternalTexture(desc);
      this.extFrame[i] = this.frameNo;
    }
    return this.ext[i]!;
  }

  /**
   * Source kind index of a stack this frame (t for bitmaps). A scene that shows only its base (no frame of
   * its generation, no over bound: the poster after onEnd 'black', Clear media, 'Hide while not playing'
   * or while the clip loads) draws as a bitmap: its base is the stack's texture, so the static t bind
   * groups serve it, with no placeholder import and no bind group per frame (design/27 §13).
   */
  private kindOf(s: Stack<ImageBitmap>, l: number, f: FrameInputs): number {
    /* @hot */
    if (s.kind === SRC_VIDEO) return K_E;
    if (s.kind !== SRC_SCENE) return K_T;
    if (s.bitmap === null || sceneVideoPresent(s, f.video)) return K_V;
    return s.over !== null && this.overViews[l] !== null ? K_V : K_T;
  }

  private hasSource(s: Stack<ImageBitmap>, f: FrameInputs): boolean {
    /* @hot */
    if (s.kind === SRC_EMPTY) return false;
    if (s.kind === SRC_BITMAP) return s.bitmap !== null;
    if (s.kind === SRC_SCENE) return s.bitmap !== null || s.over !== null || sceneVideoPresent(s, f.video);
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

  /** Upload a stack's bitmaps into its textures when its content changed (arm time, not every frame). */
  private ensureUploaded(l: number, idx: number, s: Stack<ImageBitmap>): void {
    /* @hot */
    const up = this.uploaded[l]!;
    if (up[idx] === s.version) return;
    up[idx] = s.version;
    if (s.kind !== SRC_BITMAP && s.kind !== SRC_SCENE) return;
    if (s.bitmap) this.upload(this.textures[l]![idx]!, s.bitmap);
    if (s.kind !== SRC_SCENE || !s.over) return;
    // prepare() allocated them when the scene was offered; this only runs for a compositor driven
    // without the engine's hook.
    if (!this.overTex[l]) this.allocOver(l);
    this.upload(this.overTex[l]![idx]!, s.over);
  }

  private upload(texture: GPUTexture, bitmap: ImageBitmap): void {
    this.copySrc.source = bitmap;
    this.copyDst.texture = texture;
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
    for (const l of this.overTex) if (l) for (const t of l) t.destroy();
    this.clearTex?.destroy();
    this.placeholder?.close();
    this.placeholder = null;
    this.uniformBuf.destroy();
    try {
      this.context.unconfigure();
    } catch {
      /* already gone */
    }
    this.device.destroy();
  }
}
