import { MAX_VIDEO_SLOTS, sceneVideoPresent } from '../src/compositor.ts';
import { RenderEngine } from '../src/engine.ts';
import { PLANE_FLOATS, type PlaneSource, encodePlane, planeForward, planeSample } from '../src/scene.ts';
import {
  FIT_CONTAIN,
  FIT_COVER,
  LAYER_INDEX,
  type LayerStack,
  SRC_BITMAP,
  SRC_SCENE,
  SRC_VIDEO,
  type Stack,
  type StackContent,
  fitRect,
} from '../src/stacks.ts';

/**
 * Worker side of the compositor golden (design/27 §14.5; runner: compositor-run.ts). Two real render
 * engines draw the same layer stacks, one with the WebGPU compositor and one with the Canvas 2D
 * compositor, and a CPU reference composes the same stacks with `planeSample` (scene.ts), the shared
 * definition of what a scene draws. Every case is compared pixel by pixel: WebGPU against the reference,
 * and WebGPU against Canvas 2D. Cases cover scene stacks with synthetic VideoFrames made from canvases
 * (masks, crops, rotation, flips, an over), crossfade midpoints of every source pair, a stale generation
 * and a slot without a frame (both show the poster, never black), and the legacy bitmap and video paths.
 * `canvas2dScenes` probes that the Canvas 2D compositor draws a scene's video; the runner fails without it.
 */

const W = 640;
const H = 360;
const SCALE = W / 1920;
const CLEAR = { r: 18, g: 22, b: 30, a: 1 };
const POSTER: [number, number, number] = [230, 160, 40];

type Px = { w: number; h: number; d: Float32Array };
type Canvas = OffscreenCanvas;
type Ctx = OffscreenCanvasRenderingContext2D;

function canvas(w: number, h: number, draw: (c: Ctx) => void): Canvas {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  draw(ctx);
  return c;
}

/** Premultiplied 0..1 RGBA of a canvas (what the GPU holds after a premultiplied upload). */
function pixels(c: Canvas): Px {
  const id = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const d = new Float32Array(id.length);
  for (let i = 0; i < id.length; i += 4) {
    const a = id[i + 3]! / 255;
    d[i] = (id[i]! / 255) * a;
    d[i + 1] = (id[i + 1]! / 255) * a;
    d[i + 2] = (id[i + 2]! / 255) * a;
    d[i + 3] = a;
  }
  return { w: c.width, h: c.height, d };
}

// ---- Sources -------------------------------------------------------------------------------------------

const background = canvas(W, H, (c) => {
  const g = c.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1d2a6b');
  g.addColorStop(1, '#5a1f63');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  const r = c.createRadialGradient(W * 0.8, H * 0.2, 4, W * 0.8, H * 0.2, H * 0.6);
  r.addColorStop(0, 'rgba(120,200,255,0.7)');
  r.addColorStop(1, 'rgba(120,200,255,0)');
  c.fillStyle = r;
  c.fillRect(0, 0, W, H);
});

/** A test clip: hue sweep, brightness ramp, a white disc and corner markers (orientation, flips, crop). */
function clip(w: number, h: number, hue: number): Canvas {
  return canvas(w, h, (c) => {
    const g = c.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${hue + i * 50}, 80%, 55%)`);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    const v = c.createLinearGradient(0, 0, 0, h);
    v.addColorStop(0, 'rgba(255,255,255,0.35)');
    v.addColorStop(1, 'rgba(0,0,0,0.45)');
    c.fillStyle = v;
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(w * 0.5, h * 0.5, h * 0.18, 0, Math.PI * 2);
    c.fill();
    const m = Math.round(h * 0.22);
    c.fillStyle = '#e02020';
    c.fillRect(0, 0, m, m);
    c.fillStyle = '#20c040';
    c.fillRect(w - m, 0, m, m);
    c.fillStyle = '#2040e0';
    c.fillRect(0, h - m, m, m);
    c.fillStyle = '#f0e020';
    c.fillRect(w - m, h - m, m, m);
  });
}

const clipA = clip(320, 180, 0);
const clipB = clip(240, 180, 180);
const clipWhite = canvas(64, 36, (c) => {
  c.fillStyle = '#fff';
  c.fillRect(0, 0, 64, 36);
});

/** Panels and text-like bars of a slide, in logical px. */
function panels(c: Ctx, seed: number): void {
  c.save();
  c.scale(SCALE, SCALE);
  c.fillStyle = seed % 2 ? 'rgba(10,10,10,0.55)' : 'rgba(250,250,250,0.25)';
  c.beginPath();
  c.roundRect(80, 760, 1760, 260, 40);
  c.fill();
  c.fillStyle = '#f4f4f4';
  for (let i = 0; i < 3; i++) c.fillRect(140, 800 + i * 70, 900 + ((seed * 137 + i * 211) % 600), 36);
  c.fillStyle = 'rgba(40,200,160,0.8)';
  c.fillRect(1500 - seed * 40, 60, 300, 120);
  c.restore();
}

/** A full-frame slide bitmap (t sources). */
const slideBitmap = canvas(W, H, (c) => {
  panels(c, 1);
  c.fillStyle = 'rgba(200,60,60,0.7)';
  c.fillRect(W * 0.1, H * 0.1, W * 0.4, H * 0.4);
});

const lowerThird = canvas(W, H, (c) => {
  c.fillStyle = 'rgba(0,0,0,0.6)';
  c.fillRect(0, H * 0.72, W, H * 0.18);
  c.fillStyle = '#ffd24a';
  c.fillRect(W * 0.05, H * 0.76, W * 0.5, H * 0.05);
  c.fillStyle = '#fff';
  c.fillRect(W * 0.05, H * 0.83, W * 0.35, H * 0.03);
});

/** Unit-square mask path of a plane's frame (what the poster in base is drawn through). */
function maskPath(c: Ctx, plane: Float32Array): void {
  c.beginPath();
  const kind = plane[10]!;
  if (kind === 1) c.ellipse(0.5, 0.5, 0.5, 0.5, 0, 0, Math.PI * 2);
  else if (kind === 2) c.roundRect(0, 0, 1, 1, [{ x: plane[11]!, y: plane[12]! }]);
  else c.rect(0, 0, 1, 1);
}

type Scene = { plane: Float32Array; base: Canvas; over: Canvas | null; clip: Canvas };

/**
 * A scene as the asset worker would make it: base = panels and the poster at the video's frame (a flat
 * colour, so "the poster shows" is easy to probe), over = a title band crossing the video (optional).
 */
function scene(src: PlaneSource, clipCanvas: Canvas, opts: { over?: boolean; seed?: number } = {}): Scene {
  const plane = new Float32Array(PLANE_FLOATS);
  encodePlane(src, SCALE, clipCanvas.width, clipCanvas.height, plane, !!opts.over);
  const fwd = new Float64Array(6);
  planeForward(plane, fwd);
  const base = canvas(W, H, (c) => {
    panels(c, opts.seed ?? 0);
    c.save();
    c.setTransform(fwd[0]!, fwd[1]!, fwd[2]!, fwd[3]!, fwd[4]!, fwd[5]!);
    maskPath(c, plane);
    c.fillStyle = `rgb(${POSTER.join(',')})`;
    c.fill();
    c.restore();
  });
  const over = opts.over
    ? canvas(W, H, (c) => {
        const b = src.box;
        c.save();
        c.scale(SCALE, SCALE);
        c.fillStyle = 'rgba(0,0,0,0.55)';
        c.fillRect(b.x - 120, b.y + b.h * 0.62, b.w + 240, 150);
        c.fillStyle = '#ffffff';
        c.fillRect(b.x - 60, b.y + b.h * 0.62 + 30, b.w * 0.7, 44);
        c.fillStyle = 'rgba(255,210,74,0.85)';
        c.fillRect(b.x - 60, b.y + b.h * 0.62 + 92, b.w * 0.45, 28);
        c.restore();
      })
    : null;
  return { plane, base, over, clip: clipCanvas };
}

const box = (x: number, y: number, w: number, h: number, rotation = 0) => ({ x, y, w, h, rotation });

const S = {
  stretch: scene({ box: box(240, 200, 960, 540), fit: 'stretch' }, clipA),
  over: scene({ box: box(300, 120, 1100, 620), fit: 'cover' }, clipB, { over: true, seed: 1 }),
  ellipse: scene(
    { box: box(760, 220, 800, 600, 25), fit: 'cover', flipH: true, mask: { preset: 'ellipse' } },
    clipA,
    { over: true, seed: 2 },
  ),
  round: scene(
    {
      box: box(160, 140, 900, 640, -12),
      fit: 'cover',
      radius: 90,
      opacity: 0.8,
      crop: { l: 0.1, t: 0.05, r: 0.2, b: 0.1 },
    },
    clipB,
    { seed: 3 },
  ),
  contain: scene(
    {
      box: box(420, 60, 1080, 900),
      fit: 'contain',
      crop: { l: 0, t: 0.12, r: 0, b: 0.06 },
      mask: { preset: 'roundRect', adj: [['adj', 18_000]] },
    },
    clipA,
    { seed: 4 },
  ),
  padded: scene(
    {
      box: box(560, 260, 900, 506, 90),
      fit: 'stretch',
      flipV: true,
      crop: { l: -0.12, t: -0.1, r: 0.08, b: 0 },
    },
    clipB,
    { seed: 5 },
  ),
};

// ---- Cases ---------------------------------------------------------------------------------------------

type Content =
  | { kind: 'bitmap'; src: Canvas }
  | { kind: 'video'; slot: number; fit: number }
  | { kind: 'scene'; scene: Scene; slot: number; gen: number };

type LayerSpec = { layer: number; to: Content; from?: Content; fade?: boolean };

type Case = {
  layers: LayerSpec[];
  /** Frames in the slots: [slot, clip, generation]. */
  frames: [number, Canvas, number][];
  /** Crossfade progress (0..1) of the layers with `fade`; the weight is smoothstep of it. */
  progress?: number;
  /** Pixels (logical px) that must show a colour, e.g. the poster when the video is not shown. */
  probes?: { x: number; y: number; rgb: [number, number, number]; what: string }[];
};

const centre = (s: Scene) => {
  const m = new Float64Array(6);
  planeForward(s.plane, m);
  return { x: (m[0]! * 0.5 + m[2]! * 0.5 + m[4]!) / SCALE, y: (m[1]! * 0.5 + m[3]! * 0.5 + m[5]!) / SCALE };
};

const bg: LayerSpec = { layer: LAYER_INDEX.background, to: { kind: 'bitmap', src: background } };
const slide = (to: Content, from?: Content, fade = !!from): LayerSpec => ({
  layer: LAYER_INDEX.slide,
  to,
  from,
  fade,
});
const sc = (scene: Scene, slot = 2, gen = 1): Content => ({ kind: 'scene', scene, slot, gen });

export const CASES: Record<string, Case> = {
  'scene-stretch': { layers: [bg, slide(sc(S.stretch))], frames: [[2, clipA, 1]] },
  'scene-over': {
    layers: [bg, slide(sc(S.over, 3, 9))],
    frames: [[3, clipB, 9]],
  },
  'scene-rotate-ellipse-flip': { layers: [bg, slide(sc(S.ellipse))], frames: [[2, clipA, 1]] },
  'scene-round-crop-opacity': { layers: [bg, slide(sc(S.round))], frames: [[2, clipB, 1]] },
  'scene-contain-crop-roundrect': { layers: [bg, slide(sc(S.contain))], frames: [[2, clipA, 1]] },
  'scene-negative-crop-rotate-flip': { layers: [bg, slide(sc(S.padded))], frames: [[2, clipB, 1]] },
  'scene-stale-generation': {
    layers: [bg, slide(sc(S.stretch, 2, 3))],
    frames: [[2, clipA, 4]],
    probes: [{ ...centre(S.stretch), rgb: POSTER, what: 'a frame of another generation shows the poster' }],
  },
  'scene-no-frame': {
    layers: [bg, slide(sc(S.ellipse, 3, 2))],
    frames: [],
    probes: [
      { ...centre(S.ellipse), rgb: POSTER, what: 'a slot without a frame shows the poster, never black' },
    ],
  },
  'fade-scene-scene': {
    layers: [
      bg,
      slide(sc(S.round, 3, 7), sc(S.stretch, 2, 1)),
      { layer: LAYER_INDEX.lowerThird, to: { kind: 'bitmap', src: lowerThird } },
    ],
    frames: [
      [2, clipA, 1],
      [3, clipB, 7],
    ],
    progress: 0.5,
  },
  'fade-bitmap-scene': {
    layers: [bg, slide(sc(S.over), { kind: 'bitmap', src: slideBitmap })],
    frames: [[2, clipB, 1]],
    progress: 0.5,
  },
  'fade-scene-bitmap': {
    layers: [bg, slide({ kind: 'bitmap', src: slideBitmap }, sc(S.ellipse))],
    frames: [[2, clipA, 1]],
    progress: 0.3,
  },
  'fade-video-scene': {
    layers: [bg, slide(sc(S.contain, 2, 5), { kind: 'video', slot: 0, fit: FIT_COVER })],
    frames: [
      [0, clipB, 1],
      [2, clipA, 5],
    ],
    progress: 0.5,
  },
  'fade-scene-video': {
    layers: [bg, slide({ kind: 'video', slot: 3, fit: FIT_CONTAIN }, sc(S.padded, 2, 1))],
    frames: [
      [2, clipB, 1],
      [3, clipB, 1],
    ],
    progress: 0.6,
  },
  'scene-fade-in': {
    layers: [bg, slide(sc(S.over), undefined, true)],
    frames: [[2, clipB, 1]],
    progress: 0.4,
  },
  'legacy-video-contain': {
    layers: [
      bg,
      slide({ kind: 'bitmap', src: slideBitmap }),
      { layer: LAYER_INDEX.media, to: { kind: 'video', slot: 2, fit: FIT_CONTAIN } },
    ],
    frames: [[2, clipB, 1]],
  },
  'legacy-fade-bitmap-video': {
    layers: [
      bg,
      {
        layer: LAYER_INDEX.media,
        from: { kind: 'bitmap', src: lowerThird },
        to: { kind: 'video', slot: 2, fit: FIT_CONTAIN },
        fade: true,
      },
    ],
    frames: [[2, clipA, 1]],
    progress: 0.5,
  },
  'legacy-fade-video-bitmap': {
    layers: [
      bg,
      {
        layer: LAYER_INDEX.media,
        from: { kind: 'video', slot: 2, fit: FIT_COVER },
        to: { kind: 'bitmap', src: lowerThird },
        fade: true,
      },
    ],
    frames: [[2, clipB, 1]],
    progress: 0.5,
  },
  'legacy-fade-video-video': {
    layers: [
      slide({ kind: 'bitmap', src: slideBitmap }),
      {
        layer: LAYER_INDEX.background,
        from: { kind: 'video', slot: 0, fit: FIT_COVER },
        to: { kind: 'video', slot: 1, fit: FIT_COVER },
        fade: true,
      },
    ],
    frames: [
      [0, clipA, 1],
      [1, clipB, 1],
    ],
    progress: 0.5,
  },
  'legacy-fade-bitmap-bitmap': {
    layers: [bg, slide({ kind: 'bitmap', src: lowerThird }, { kind: 'bitmap', src: slideBitmap })],
    frames: [],
    progress: 0.5,
  },
};

// ---- Engines -------------------------------------------------------------------------------------------

/** A render engine driven by hand: frames run when `frame(now)` is called. */
class Side {
  readonly canvas = new OffscreenCanvas(W, H);
  readonly engine: RenderEngine;
  private pending: ((ts: number) => void) | null = null;
  private now = 0;
  private ts = 0;
  /** Source pixels of every bitmap and frame handed to this engine (reference only). */
  readonly px = new WeakMap<object, Px>();

  constructor(readonly gpu: boolean) {
    this.engine = new RenderEngine(
      {
        canvas: this.canvas,
        width: W,
        height: H,
        testPixel: false,
        forceCanvas2d: !gpu,
        // SwiftShader is a fallback adapter, which an output treats as Canvas 2D (design/27 §7.2).
        allowFallbackAdapter: gpu,
        clear: CLEAR,
        clockOffset: 0,
        gpuRetryMs: 0,
      },
      {
        raf: (cb) => {
          this.pending = cb;
          return 1;
        },
        wallNow: () => this.now,
        setTimeout: () => 0,
      },
    );
  }

  async start(): Promise<string> {
    const r = await this.engine.start();
    this.engine.setSnapshot(0, 1, 1);
    return r.kind;
  }

  frame(now: number): void {
    this.now = now;
    const cb = this.pending;
    this.pending = null;
    this.ts += 16;
    cb?.(this.ts);
  }

  async content(c: Content, key: string, cache: Map<Canvas, Px>): Promise<StackContent<ImageBitmap>> {
    const bmp = async (src: Canvas) => {
      const b = await createImageBitmap(src);
      let p = cache.get(src);
      if (!p) cache.set(src, (p = pixels(src)));
      this.px.set(b, p);
      return b;
    };
    if (c.kind === 'bitmap') return { key, kind: SRC_BITMAP, bitmap: await bmp(c.src) };
    if (c.kind === 'video') return { key, kind: SRC_VIDEO, videoSlot: c.slot, fit: c.fit };
    return {
      key,
      kind: SRC_SCENE,
      bitmap: await bmp(c.scene.base),
      over: c.scene.over ? await bmp(c.scene.over) : null,
      plane: c.scene.plane,
      videoSlot: c.slot,
      videoGen: c.gen,
    };
  }

  /** Set the case up: `from` contents cut in at 0, `to` contents flipped at 1000 (fading over 1 s). */
  async run(k: Case, cache: Map<Canvas, Px>): Promise<number> {
    const e = this.engine;
    for (const [slot, src, gen] of k.frames) {
      const f = new VideoFrame(src, { timestamp: 0 });
      let p = cache.get(src);
      if (!p) cache.set(src, (p = pixels(src)));
      this.px.set(f, p);
      e.setVideoFrame(slot, f, gen);
    }
    for (const l of k.layers) {
      if (!l.from) continue;
      e.offer(l.layer, await this.content(l.from, `A${l.layer}`, cache));
      e.flip(l.layer, `A${l.layer}`, 0, 0);
    }
    this.frame(0);
    for (const l of k.layers) {
      e.offer(l.layer, await this.content(l.to, `B${l.layer}`, cache));
      e.flip(l.layer, `B${l.layer}`, 1000, l.fade ? 1000 : 0);
    }
    this.frame(1000);
    const now = 1000 + (k.progress ?? 1) * 1000;
    this.frame(now);
    return now;
  }

  /** The frame just drawn, as 8-bit RGBA. */
  read(): Uint8ClampedArray {
    const b = this.canvas.transferToImageBitmap();
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(b, 0, 0);
    b.close();
    return ctx.getImageData(0, 0, W, H).data;
  }

  reset(): void {
    for (const l of this.engine.layers) l.reset();
    for (let s = 0; s < MAX_VIDEO_SLOTS; s++) this.engine.setVideoFrame(s, null);
  }
}

// ---- Reference -----------------------------------------------------------------------------------------

function bilinear(p: Px, u: number, v: number, out: Float32Array): void {
  const x = Math.min(Math.max(u * p.w - 0.5, 0), p.w - 1);
  const y = Math.min(Math.max(v * p.h - 0.5, 0), p.h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, p.w - 1);
  const y1 = Math.min(y0 + 1, p.h - 1);
  const fx = x - x0;
  const fy = y - y0;
  for (let k = 0; k < 4; k++) {
    const a = p.d[(y0 * p.w + x0) * 4 + k]!;
    const b = p.d[(y0 * p.w + x1) * 4 + k]!;
    const c = p.d[(y1 * p.w + x0) * 4 + k]!;
    const d = p.d[(y1 * p.w + x1) * 4 + k]!;
    out[k] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
}

/** What a stack draws at pixel (x, y), premultiplied, by the compositor contract. */
function stackColour(side: Side, s: Stack<ImageBitmap>, x: number, y: number, out: Float32Array): void {
  const v = side.engine.video;
  const i = (y * W + x) * 4;
  out.fill(0);
  if (s.kind === SRC_BITMAP || s.kind === SRC_SCENE) {
    const b = s.bitmap ? side.px.get(s.bitmap) : undefined;
    if (b) for (let k = 0; k < 4; k++) out[k] = b.d[i + k]!;
  }
  if (s.kind === SRC_VIDEO) {
    const fr = v.frames[s.videoSlot]!;
    const p = side.px.get(fr)!;
    const r = new Float32Array(4);
    fitRect(p.w, p.h, W, H, s.fit, r);
    const u = (x + 0.5 - r[0]!) / Math.max(r[2]!, 1);
    const t = (y + 0.5 - r[1]!) / Math.max(r[3]!, 1);
    if (u < 0 || u > 1 || t < 0 || t > 1) return;
    bilinear(p, u, t, out);
    return;
  }
  if (s.kind !== SRC_SCENE) return;
  if (sceneVideoPresent(s, v)) {
    const ps = new Float64Array(3);
    planeSample(s.plane, x + 0.5, y + 0.5, ps);
    const c = new Float32Array(4);
    bilinear(
      side.px.get(v.frames[s.videoSlot]!)!,
      Math.min(Math.max(ps[0]!, 0), 1),
      Math.min(Math.max(ps[1]!, 0), 1),
      c,
    );
    const w = ps[2]!;
    const a = c[3]! * w;
    for (let k = 0; k < 3; k++) out[k] = c[k]! * w + out[k]! * (1 - a);
    out[3] = a + out[3]! * (1 - a);
  }
  const o = s.over ? side.px.get(s.over) : undefined;
  if (o) {
    const a = o.d[i + 3]!;
    for (let k = 0; k < 4; k++) out[k] = o.d[i + k]! + out[k]! * (1 - a);
  }
}

function has(side: Side, s: Stack<ImageBitmap>): boolean {
  const v = side.engine.video;
  if (s.kind === SRC_BITMAP) return s.bitmap !== null;
  if (s.kind === SRC_SCENE) return s.bitmap !== null || s.over !== null || sceneVideoPresent(s, v);
  if (s.kind === SRC_VIDEO) return s.videoSlot >= 0 && v.frames[s.videoSlot] != null;
  return false;
}

/** The reference frame of what `side` holds at hub time `now`. */
function reference(side: Side, now: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  const a = new Float32Array(4);
  const b = new Float32Array(4);
  const dst = new Float32Array(4);
  const layers = side.engine.layers as LayerStack<ImageBitmap>[];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      dst[0] = CLEAR.r / 255;
      dst[1] = CLEAR.g / 255;
      dst[2] = CLEAR.b / 255;
      dst[3] = 1;
      for (const ls of layers) {
        const live = ls.liveStack;
        const outS = ls.armedStack;
        const liveOn = has(side, live);
        const outOn = ls.fading && has(side, outS);
        if (!liveOn && !outOn) continue;
        const w = ls.weight(now);
        if (liveOn && outOn) {
          stackColour(side, outS, x, y, a);
          stackColour(side, live, x, y, b);
          for (let k = 0; k < 4; k++) a[k] = a[k]! * (1 - w) + b[k]! * w;
        } else {
          stackColour(side, liveOn ? live : outS, x, y, a);
          const o = liveOn ? w : 1 - w;
          for (let k = 0; k < 4; k++) a[k] = a[k]! * o;
        }
        for (let k = 0; k < 4; k++) dst[k] = a[k]! + dst[k]! * (1 - a[3]!);
      }
      const i = (y * W + x) * 4;
      for (let k = 0; k < 4; k++) out[i + k] = Math.round(dst[k]! * 255);
    }
  return out;
}

// ---- Comparison ----------------------------------------------------------------------------------------

export type Diff = { differing: number; total: number; maxDelta: number };

function diff(a: Uint8ClampedArray, b: Uint8ClampedArray, tolerance: number): Diff {
  let differing = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a[i + k]! - b[i + k]!));
    if (d > maxDelta) maxDelta = d;
    if (d > tolerance) differing++;
  }
  return { differing, total: a.length / 4, maxDelta };
}

async function png(data: Uint8ClampedArray): Promise<string> {
  const c = new OffscreenCanvas(W, H);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), W, H), 0, 0);
  const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Pass bounds: WebGPU against Canvas 2D (two rasterizers) within `tolerance` per channel on all but
 * `maxFraction` of the pixels; WebGPU against the reference (the same maths) within the tighter `ref*`
 * bounds, which an anti-aliasing or sampling error exceeds.
 */
export type Limits = { tolerance: number; maxFraction: number; refTolerance: number; refMaxFraction: number };

export type CaseResult = {
  name: string;
  ok: boolean;
  gpuVsRef: Diff;
  /** null: skipped (the Canvas 2D compositor drew no scene video in the `canvas2dScenes` probe). */
  gpuVs2d: Diff | null;
  probes: { what: string; ok: boolean; got: number[]; want: number[] }[];
  error?: string;
  images?: { gpu: string; ref: string; c2d: string };
};

export type RunResult = {
  ok: boolean;
  gpuKind: string;
  adapterFallback?: boolean;
  canvas2dScenes: boolean;
  overBytes: number;
  size: { width: number; height: number };
  results: CaseResult[];
  error?: string;
};

/** Whether a case's final frame needs the scene drawing of a compositor (a video present or an over). */
function needsScene(side: Side): boolean {
  for (const ls of side.engine.layers)
    for (const s of ls.stacks)
      if (s.kind === SRC_SCENE && (s.over !== null || sceneVideoPresent(s, side.engine.video))) return true;
  return false;
}

/** Whether the Canvas 2D compositor draws a scene's video (a white clip over a transparent base). */
async function canvas2dDrawsScenes(c2d: Side, cache: Map<Canvas, Px>): Promise<boolean> {
  const probe = scene({ box: box(0, 0, 1920, 1080), fit: 'stretch' }, clipWhite);
  const base = canvas(W, H, () => undefined);
  await c2d.run({ layers: [slide(sc({ ...probe, base }, 2, 1))], frames: [[2, clipWhite, 1]] }, cache);
  const px = c2d.read();
  c2d.reset();
  const i = ((H >> 1) * W + (W >> 1)) * 4;
  return px[i]! > 200 && px[i + 1]! > 200 && px[i + 2]! > 200;
}

async function run(lim: Limits, images: boolean): Promise<RunResult> {
  const gpu = new Side(true);
  const c2d = new Side(false);
  const gpuKind = await gpu.start();
  await c2d.start();
  const cache = new Map<Canvas, Px>();
  const result: RunResult = {
    ok: true,
    gpuKind,
    canvas2dScenes: await canvas2dDrawsScenes(c2d, cache),
    overBytes: 0,
    size: { width: W, height: H },
    results: [],
  };
  if (gpuKind !== 'webgpu') {
    result.ok = false;
    result.error = `WebGPU unavailable: ${gpu.engine.telemetry().error ?? gpuKind}`;
    return result;
  }
  for (const [name, k] of Object.entries(CASES)) {
    const now = await gpu.run(k, cache);
    await c2d.run(k, cache);
    const g = gpu.read();
    const c = c2d.read();
    const ref = reference(gpu, now);
    const scenes = needsScene(gpu);
    const r: CaseResult = {
      name,
      ok: true,
      gpuVsRef: diff(g, ref, lim.refTolerance),
      gpuVs2d: scenes && !result.canvas2dScenes ? null : diff(g, c, lim.tolerance),
      probes: [],
    };
    for (const p of k.probes ?? []) {
      const x = Math.round(p.x * SCALE);
      const y = Math.round(p.y * SCALE);
      const i = (y * W + x) * 4;
      for (const [img, label] of [
        [g, 'webgpu'],
        [c, 'canvas 2d'],
      ] as const) {
        const got = [img[i]!, img[i + 1]!, img[i + 2]!];
        const ok = got.every((v, j) => Math.abs(v - p.rgb[j]!) <= lim.tolerance);
        r.probes.push({ what: `${p.what} (${label})`, ok, got, want: p.rgb });
      }
    }
    const err = gpu.engine.telemetry().error;
    if (err) r.error = err;
    const bad = (d: Diff | null, max: number) => d !== null && d.differing / d.total > max;
    r.ok = !(
      bad(r.gpuVsRef, lim.refMaxFraction) ||
      bad(r.gpuVs2d, lim.maxFraction) ||
      r.probes.some((p) => !p.ok) ||
      r.error
    );
    if (!r.ok) result.ok = false;
    if (!r.ok || images) r.images = { gpu: await png(g), ref: await png(ref), c2d: await png(c) };
    result.results.push(r);
    gpu.reset();
    c2d.reset();
  }
  // The over textures were allocated by the engine's offer hook, once (two full-frame textures).
  result.overBytes =
    (gpu.engine as unknown as { compositor: { overBytes?: number } }).compositor.overBytes ?? 0;
  return result;
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<{ limits: Limits; images: boolean }>) => void) | null;
  postMessage(m: unknown): void;
};
scope.onmessage = (ev) => {
  run(ev.data.limits, ev.data.images).then(
    (r) => scope.postMessage(r),
    (err: Error) =>
      scope.postMessage({
        ok: false,
        gpuKind: 'none',
        canvas2dScenes: false,
        overBytes: 0,
        size: { width: W, height: H },
        results: [],
        error: String(err?.stack ?? err),
      } satisfies RunResult),
  );
};
