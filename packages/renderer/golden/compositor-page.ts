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
 *
 * M7 (design/27 §7.3): tight sprites at offsets (a bitmap, a scene's base and over, cut to the bounding box
 * of their pixels), crossfades between a full-frame and a tight layer, opaque full-frame layers (the
 * replace pipeline and Canvas 2D 'copy', with nothing drawn under them), and strip uploads: with a budget
 * of a few rows per frame, a flip to content still uploading keeps the previous picture whole until the
 * last strip is in (`STRIP_CASES`, compared with Canvas 2D drawing the previous and then the new content).
 * Every other case lets its uploads finish before its flips, as arming a cue ahead does.
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

/** A canvas cut to the bounding box of its non-transparent pixels: a tight sprite and its offset. */
type Sprite = { canvas: Canvas; x: number; y: number };
function tight(src: Canvas): Sprite {
  const d = src.getContext('2d')!.getImageData(0, 0, src.width, src.height).data;
  let x0 = src.width;
  let y0 = src.height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++)
      if (d[(y * src.width + x) * 4 + 3]! > 0) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + 1 > x1) x1 = x + 1;
        if (y + 1 > y1) y1 = y + 1;
      }
  if (x1 <= x0 || y1 <= y0) return { canvas: canvas(1, 1, () => undefined), x: 0, y: 0 };
  const out = canvas(x1 - x0, y1 - y0, (c) => c.drawImage(src, -x0, -y0));
  return { canvas: out, x: x0, y: y0 };
}
const sprites = new Map<Canvas, Sprite>();
const spriteOf = (src: Canvas): Sprite => {
  let s = sprites.get(src);
  if (!s) sprites.set(src, (s = tight(src)));
  return s;
};

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

/** A lyric band in the lower half: what a tight slide sprite usually holds (text over the background). */
const band = canvas(W, H, (c) => {
  c.fillStyle = 'rgba(0,0,0,0.45)';
  c.beginPath();
  c.roundRect(52, 214, 536, 104, 14);
  c.fill();
  c.fillStyle = '#ffffff';
  c.fillRect(80, 232, 470, 26);
  c.fillStyle = 'rgba(255,220,120,0.9)';
  c.fillRect(120, 272, 380, 22);
});

/** An opaque full-frame picture (a cover-fitted photo): drawn without blending, hiding what is under it. */
const photo = canvas(W, H, (c) => {
  const g = c.createLinearGradient(0, H, W, 0);
  g.addColorStop(0, '#2d5016');
  g.addColorStop(1, '#c8a24a');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(255,255,255,0.3)';
  c.beginPath();
  c.arc(W * 0.3, H * 0.4, H * 0.25, 0, Math.PI * 2);
  c.fill();
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

type Scene = {
  plane: Float32Array;
  base: Canvas;
  over: Canvas | null;
  clip: Canvas;
  /** Base and over cut to tight sprites (the asset worker's M7 scene parts). */
  tightBase?: boolean;
  tightOver?: boolean;
};

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
  | { kind: 'bitmap'; src: Canvas; tight?: boolean; opaque?: boolean }
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
const sprite = (src: Canvas): Content => ({ kind: 'bitmap', src, tight: true });
const opaque = (src: Canvas): Content => ({ kind: 'bitmap', src, opaque: true });
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
  // A scene with no frame of its generation and no over draws as a bitmap (t) against a scene showing its
  // clip (v): GO from a slide whose clip still loads, or back to one after onEnd 'black' or Clear media.
  'fade-poster-scene': {
    layers: [bg, slide(sc(S.round, 2, 1), sc(S.stretch, 3, 9))],
    frames: [[2, clipB, 1]],
    progress: 0.5,
  },
  'fade-scene-poster': {
    layers: [bg, slide(sc(S.padded, 3, 4), sc(S.contain, 2, 5))],
    frames: [[2, clipA, 5]],
    progress: 0.5,
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
  // M7: tight sprites at their offsets, crossfades with full-frame layers, scenes with tight parts.
  'sprite-offset': {
    layers: [
      bg,
      slide(sprite(band)),
      { layer: LAYER_INDEX.lowerThird, to: sprite(lowerThird) },
      { layer: LAYER_INDEX.props, to: sprite(slideBitmap) },
    ],
    frames: [],
  },
  'fade-full-to-sprite': {
    layers: [bg, slide(sprite(band), { kind: 'bitmap', src: slideBitmap })],
    frames: [],
    progress: 0.5,
  },
  'fade-sprite-to-full': {
    layers: [bg, slide({ kind: 'bitmap', src: lowerThird }, sprite(band))],
    frames: [],
    progress: 0.35,
  },
  'fade-sprite-sprite': {
    layers: [bg, slide(sprite(lowerThird), sprite(band))],
    frames: [],
    progress: 0.6,
  },
  'scene-tight-over': {
    layers: [bg, slide(sc({ ...S.over, tightOver: true }, 3, 9))],
    frames: [[3, clipB, 9]],
  },
  'scene-tight-base-over': {
    layers: [bg, slide(sc({ ...S.ellipse, tightBase: true, tightOver: true }))],
    frames: [[2, clipA, 1]],
  },
  'fade-sprite-tight-scene': {
    layers: [bg, slide(sc({ ...S.over, tightBase: true, tightOver: true }), sprite(band))],
    frames: [[2, clipB, 1]],
    progress: 0.5,
  },
  'fade-tight-scene-full': {
    layers: [bg, slide({ kind: 'bitmap', src: slideBitmap }, sc({ ...S.ellipse, tightOver: true }))],
    frames: [[2, clipA, 1]],
    progress: 0.4,
  },
  // Opaque full-frame layers: the background written without blending; an opaque props layer (the logo)
  // hides every layer under it; a fade between opaque pictures blends as usual.
  'opaque-background': {
    layers: [{ layer: LAYER_INDEX.background, to: opaque(photo) }, slide(sprite(band))],
    frames: [],
  },
  'opaque-props-hides-below': {
    layers: [bg, slide(sprite(band)), { layer: LAYER_INDEX.props, to: opaque(photo) }],
    frames: [],
  },
  'opaque-fade': {
    layers: [
      { layer: LAYER_INDEX.background, from: opaque(background), to: opaque(photo), fade: true },
      slide(sprite(lowerThird)),
    ],
    frames: [],
    progress: 0.5,
  },
};

/**
 * Strip uploads (design/27 §7.3): the WebGPU side uploads STRIP_ROWS rows per frame. `from` is live; `to`
 * is offered and flipped at once, so the flip waits on its upload: until its last strip the frame must be
 * the previous picture, whole (compared with Canvas 2D drawing `from`), and after it the new one.
 */
const STRIP_ROWS = 24;
export const STRIP_CASES: Record<string, { from: Content; to: Content }> = {
  'strip-full-frame': { from: { kind: 'bitmap', src: slideBitmap }, to: { kind: 'bitmap', src: lowerThird } },
  'strip-sprite': { from: sprite(lowerThird), to: sprite(band) },
  'strip-scene-tight-over': {
    from: { kind: 'bitmap', src: slideBitmap },
    to: sc({ ...S.over, tightOver: true }, 2, 1),
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

  constructor(
    readonly gpu: boolean,
    uploadBudgetBytes?: number,
  ) {
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
        uploadBudgetBytes,
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
    if (c.kind === 'bitmap') {
      if (!c.tight) return { key, kind: SRC_BITMAP, bitmap: await bmp(c.src), opaque: c.opaque };
      const t = spriteOf(c.src);
      return { key, kind: SRC_BITMAP, bitmap: await bmp(t.canvas), x: t.x, y: t.y };
    }
    if (c.kind === 'video') return { key, kind: SRC_VIDEO, videoSlot: c.slot, fit: c.fit };
    const base = c.scene.tightBase ? spriteOf(c.scene.base) : { canvas: c.scene.base, x: 0, y: 0 };
    const over = c.scene.over
      ? c.scene.tightOver
        ? spriteOf(c.scene.over)
        : { canvas: c.scene.over, x: 0, y: 0 }
      : null;
    return {
      key,
      kind: SRC_SCENE,
      bitmap: await bmp(base.canvas),
      x: base.x,
      y: base.y,
      over: over ? await bmp(over.canvas) : null,
      overX: over?.x,
      overY: over?.y,
      plane: c.scene.plane,
      videoSlot: c.slot,
      videoGen: c.gen,
    };
  }

  /** Run frames at hub time `now` until every due flip happened and all armed content is uploaded. */
  settle(now: number): void {
    for (let i = 0; i < 400; i++) {
      let done = true;
      for (const ls of this.engine.layers)
        if (!ls.armedStack.ready || (ls.flipPending && ls.flipAt <= now)) done = false;
      if (done) return;
      this.frame(now);
    }
    throw new Error('uploads did not settle');
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
    this.settle(0);
    for (const l of k.layers) {
      e.offer(l.layer, await this.content(l.to, `B${l.layer}`, cache));
      e.flip(l.layer, `B${l.layer}`, 1000, l.fade ? 1000 : 0);
    }
    // Armed ahead of its flip, as a cue is: its strips are uploaded before the flip is due.
    this.settle(500);
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

/** Pixel (x, y) of the frame from a bitmap placed at (ox, oy), premultiplied; 0 outside it. */
function placed(p: Px | undefined, ox: number, oy: number, x: number, y: number, out: Float32Array): void {
  out.fill(0);
  const sx = x - ox;
  const sy = y - oy;
  if (!p || sx < 0 || sy < 0 || sx >= p.w || sy >= p.h) return;
  const i = (sy * p.w + sx) * 4;
  for (let k = 0; k < 4; k++) out[k] = p.d[i + k]!;
}

/** What a stack draws at pixel (x, y), premultiplied, by the compositor contract. */
function stackColour(side: Side, s: Stack<ImageBitmap>, x: number, y: number, out: Float32Array): void {
  const v = side.engine.video;
  out.fill(0);
  if (s.kind === SRC_BITMAP || s.kind === SRC_SCENE)
    placed(s.bitmap ? side.px.get(s.bitmap) : undefined, s.x, s.y, x, y, out);
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
  if (s.over) {
    const o = new Float32Array(4);
    placed(side.px.get(s.over), s.overX, s.overY, x, y, o);
    const a = o[3]!;
    for (let k = 0; k < 4; k++) out[k] = o[k]! + out[k]! * (1 - a);
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
  await runStrips(lim, images, c2d, cache, result);
  // The over textures were allocated by the engine's offer hook, once (two full-frame textures).
  result.overBytes =
    (gpu.engine as unknown as { compositor: { overBytes?: number } }).compositor.overBytes ?? 0;
  return result;
}

/**
 * STRIP_CASES on a WebGPU engine that uploads STRIP_ROWS rows per frame: every frame while the new content
 * uploads must show the previous picture whole (`:during`, the worst frame against Canvas 2D drawing
 * `from`), the flip must wait for more than one frame, and once it happens the new picture shows
 * (`:after`, against Canvas 2D drawing `to`).
 */
async function runStrips(
  lim: Limits,
  images: boolean,
  c2d: Side,
  cache: Map<Canvas, Px>,
  result: RunResult,
): Promise<void> {
  const strip = new Side(true, STRIP_ROWS * W * 4);
  if ((await strip.start()) !== 'webgpu') {
    result.ok = false;
    result.error = 'WebGPU unavailable for the strip cases';
    return;
  }
  const SLIDE_L = LAYER_INDEX.slide;
  const clipFrames: [number, Canvas, number][] = [[2, clipB, 1]];
  const bad = (d: Diff, max: number) => d.differing / d.total > max;
  for (const [name, k] of Object.entries(STRIP_CASES)) {
    // The pictures before and after, drawn by Canvas 2D.
    await c2d.run({ layers: [bg, slide(k.from)], frames: clipFrames }, cache);
    const before = c2d.read();
    c2d.reset();
    await c2d.run({ layers: [bg, slide(k.to)], frames: clipFrames }, cache);
    const after = c2d.read();
    c2d.reset();
    const e = strip.engine;
    for (const [slot, src, gen] of clipFrames) {
      const f = new VideoFrame(src, { timestamp: 0 });
      let px = cache.get(src);
      if (!px) cache.set(src, (px = pixels(src)));
      strip.px.set(f, px);
      e.setVideoFrame(slot, f, gen);
    }
    e.offer(bg.layer, await strip.content(bg.to, 'BG', cache));
    e.flip(bg.layer, 'BG', 0, 0);
    e.offer(SLIDE_L, await strip.content(k.from, 'A', cache));
    e.flip(SLIDE_L, 'A', 0, 0);
    strip.frame(0);
    strip.settle(0);
    // The new content is offered and flipped at once: the flip waits on its strips.
    e.offer(SLIDE_L, await strip.content(k.to, 'B', cache));
    e.flip(SLIDE_L, 'B', 1000, 0);
    let now = 1000;
    let waited = 0;
    let worst: Diff = { differing: 0, total: W * H, maxDelta: 0 };
    let worstImg: Uint8ClampedArray | null = null;
    let worstRef: Uint8ClampedArray | null = null;
    const ls = e.layers[SLIDE_L]!;
    for (; waited < 400; waited++) {
      strip.frame(now);
      if (ls.liveStack.key === 'B') break;
      const g = strip.read();
      const d = diff(g, before, lim.tolerance);
      if (!worstImg || d.differing > worst.differing) {
        worst = d;
        worstImg = g;
        worstRef = reference(strip, now);
      }
      now += 16;
    }
    const during: CaseResult = {
      name: `${name}:during`,
      ok: true,
      gpuVsRef: worstImg && worstRef ? diff(worstImg, worstRef, lim.refTolerance) : worst,
      gpuVs2d: worst,
      probes: [
        {
          what: 'the flip waits for the strips (frames held)',
          ok: waited > 1 && waited < 400,
          got: [waited],
          want: [2],
        },
      ],
    };
    during.ok = !(
      bad(during.gpuVs2d!, lim.maxFraction) ||
      bad(during.gpuVsRef, lim.refMaxFraction) ||
      during.probes.some((p) => !p.ok)
    );
    const g = strip.read();
    const ref = reference(strip, now);
    const done: CaseResult = {
      name: `${name}:after`,
      ok: true,
      gpuVsRef: diff(g, ref, lim.refTolerance),
      gpuVs2d: diff(g, after, lim.tolerance),
      probes: [],
    };
    done.ok = !(bad(done.gpuVs2d!, lim.maxFraction) || bad(done.gpuVsRef, lim.refMaxFraction));
    const err = e.telemetry().error;
    if (err) done.error = err;
    for (const r of [during, done]) if (!r.ok || r.error) result.ok = false;
    if (!during.ok || images)
      during.images = {
        gpu: await png(worstImg ?? g),
        ref: await png(worstRef ?? ref),
        c2d: await png(before),
      };
    if (!done.ok || images) done.images = { gpu: await png(g), ref: await png(ref), c2d: await png(after) };
    result.results.push(during, done);
    strip.reset();
  }
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
