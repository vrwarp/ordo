import { Canvas2DCompositor } from '../src/canvas2d.ts';
import type { FrameInputs } from '../src/compositor.ts';
import { PLANE_FLOATS, type PlaneSource, encodePlane, planeSample } from '../src/scene.ts';
import { LAYERS, LAYER_INDEX, LayerStack, SRC_BITMAP, SRC_SCENE, type StackContent } from '../src/stacks.ts';

/**
 * Browser side of the Canvas 2D scene pixel test (design/27 §7.2 and §14.5; runner: canvas-scene-run.ts).
 * The real Canvas2DCompositor draws scene stacks (a base, a synthetic VideoFrame made from a canvas through
 * its plane, an over) on an OffscreenCanvas, and a CPU reference composes the same stacks with
 * `planeSample` (scene.ts), the shared definition of what a scene draws, with bilinear sampling of the clip.
 * Cases cover rect, elliptical and rounded masks, crops (positive, negative padding, fit contain and
 * cover), rotation and flips, opacity, crossfade midpoints (bitmap to scene, scene to scene), a scene
 * fading in alone, and the poster for a stale generation or a slot without a frame.
 */

const W = 640;
const H = 360;
const SCALE = W / 1920;
const CLEAR = { r: 18, g: 22, b: 30 };
/** The slot generation the frames carry; a stack loaded under another one shows its poster. */
const GEN = 7;

type Px = { w: number; h: number; d: Float32Array };
type Ctx = OffscreenCanvasRenderingContext2D;

function canvas(w: number, h: number, draw: (c: Ctx) => void): OffscreenCanvas {
  const c = new OffscreenCanvas(w, h);
  draw(c.getContext('2d')!);
  return c;
}

/** Premultiplied 0..1 RGBA. */
function pixels(c: OffscreenCanvas): Px {
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

/** A slide base: a gradient, blocks, and the poster (orange) where the video plays. */
function base(hue: number): OffscreenCanvas {
  return canvas(W, H, (c) => {
    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, `hsl(${hue} 55% 25%)`);
    g.addColorStop(1, `hsl(${hue + 60} 50% 45%)`);
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgb(230,160,40)';
    c.fillRect(160, 90, 320, 180);
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.fillRect(24, 20, 200, 26);
  });
}

/** Objects above the video: a translucent band across it and an opaque title block. */
const over = canvas(W, H, (c) => {
  c.fillStyle = 'rgba(20,40,200,0.55)';
  c.fillRect(0, 230, W, 50);
  c.fillStyle = 'rgb(250,250,250)';
  c.fillRect(250, 60, 140, 30);
});

/** A test clip: hue sweep, brightness ramp, a white disc and corner markers (orientation, flips, crop). */
function clip(w: number, h: number, hue: number): OffscreenCanvas {
  return canvas(w, h, (c) => {
    const g = c.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${hue + i * 60} 90% 50%)`);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    const v = c.createLinearGradient(0, 0, 0, h);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.6)');
    c.fillStyle = v;
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(w * 0.6, h * 0.45, Math.min(w, h) * 0.18, 0, 2 * Math.PI);
    c.fill();
    const m = Math.round(Math.min(w, h) * 0.18);
    c.fillStyle = '#000';
    c.fillRect(0, 0, m, m);
    c.fillStyle = '#0f0';
    c.fillRect(w - m, 0, m, m);
    c.fillStyle = '#00f';
    c.fillRect(0, h - m, m, m);
  });
}

const CLIPS = [clip(320, 180, 0), clip(192, 192, 200)];
/** Clip i plays in video slot 2 + i. */
const slotOf = (i: number) => 2 + i;

// ---- Cases ---------------------------------------------------------------------------------------------

type SceneSpec = {
  src: PlaneSource;
  clip: number;
  base?: OffscreenCanvas | null;
  over?: OffscreenCanvas | null;
  /** The generation the stack was armed under (default GEN). */
  gen?: number;
};
type Side = { scene: SceneSpec } | { bitmap: OffscreenCanvas };
type Case = {
  name: string;
  to: Side;
  /** Crossfade from this (a 1 s fade, drawn at `now`); without it the layer only shows `to`. */
  from?: Side;
  /** Fade from nothing (the scene fades in alone). */
  fadeIn?: boolean;
  /** Hub time of the frame; 1500 is the crossfade midpoint. */
  now?: number;
  /** Slots that hold no frame. */
  noFrame?: boolean;
  /** Probes: device px whose colour must equal the base's (the poster shows, never black). */
  poster?: [number, number][];
};

const box = (x: number, y: number, w: number, h: number, rotation = 0) => ({ x, y, w, h, rotation });
const BOX = box(480, 270, 960, 540);
const baseA = base(220);
const baseB = base(300);
const sceneA = (src: Partial<PlaneSource>, more: Partial<SceneSpec> = {}): Side => ({
  scene: { src: { box: BOX, fit: 'stretch', ...src }, clip: 0, base: baseA, over, ...more },
});

const CASES: Case[] = [
  { name: 'rect-stretch', to: sceneA({}) },
  {
    name: 'rect-contain-letterbox',
    to: sceneA({ box: box(300, 140, 1300, 800), fit: 'contain' }, { clip: 1 }),
  },
  { name: 'rect-cover', to: sceneA({ box: box(700, 120, 520, 840), fit: 'cover' }) },
  { name: 'crop', to: sceneA({ crop: { l: 0.2, t: 0.1, r: 0.15, b: 0.25 } }) },
  { name: 'crop-negative-padding', to: sceneA({ crop: { l: -0.3, t: 0.05, r: 0.1, b: -0.2 } }) },
  {
    name: 'crop-contain-shrinks-frame',
    to: sceneA({
      box: box(240, 160, 1400, 760),
      fit: 'contain',
      crop: { l: 0.1, t: 0, r: 0.1, b: 0 },
      radius: 40,
    }),
  },
  {
    name: 'flips-upright-crop',
    to: sceneA({ flipH: true, flipV: true, crop: { l: 0.3, t: 0, r: 0, b: 0.2 } }),
  },
  { name: 'mask-ellipse', to: sceneA({ mask: { preset: 'ellipse' } }) },
  { name: 'mask-round-radius', to: sceneA({ radius: 90 }) },
  { name: 'mask-roundRect-adj', to: sceneA({ mask: { preset: 'roundRect', adj: [['adj', 30_000]] } }) },
  { name: 'rotate-30-round', to: sceneA({ box: box(560, 300, 800, 450, 30), radius: 60 }) },
  {
    name: 'flips-rotate-ellipse',
    to: sceneA({ box: box(520, 240, 900, 600, -15), flipH: true, flipV: true, mask: { preset: 'ellipse' } }),
  },
  { name: 'opacity', to: sceneA({ opacity: 0.6, radius: 30 }) },
  { name: 'no-over', to: sceneA({ radius: 30 }, { over: null }) },
  { name: 'crossfade-bitmap-to-scene', from: { bitmap: baseB }, to: sceneA({ radius: 50 }), now: 1500 },
  { name: 'crossfade-scene-to-bitmap', from: sceneA({ radius: 50 }), to: { bitmap: baseB }, now: 1300 },
  {
    name: 'crossfade-scene-to-scene',
    from: sceneA({ mask: { preset: 'ellipse' } }),
    to: { scene: { src: { box: box(700, 200, 900, 640, 10), fit: 'cover' }, clip: 1, base: baseB, over } },
    now: 1500,
  },
  { name: 'fade-in-alone', to: sceneA({ radius: 50 }), fadeIn: true, now: 1500 },
  { name: 'stale-generation-poster', to: sceneA({}, { gen: GEN - 1 }), poster: [[320, 180]] },
  { name: 'no-frame-poster', to: sceneA({}), noFrame: true, poster: [[320, 180]] },
];

// ---- Stacks --------------------------------------------------------------------------------------------

let bitmapNo = 0;

async function content(side: Side): Promise<StackContent<ImageBitmap>> {
  const key = `k${bitmapNo++}`;
  if ('bitmap' in side) return { key, kind: SRC_BITMAP, bitmap: await createImageBitmap(side.bitmap) };
  const s = side.scene;
  const plane = new Float32Array(PLANE_FLOATS);
  const c = CLIPS[s.clip]!;
  encodePlane(s.src, SCALE, c.width, c.height, plane, !!s.over);
  return {
    key,
    kind: SRC_SCENE,
    bitmap: s.base ? await createImageBitmap(s.base) : null,
    over: s.over ? await createImageBitmap(s.over) : null,
    plane,
    videoSlot: slotOf(s.clip),
    videoGen: s.gen ?? GEN,
  };
}

// ---- Reference -----------------------------------------------------------------------------------------

function sampleBilinear(p: Px, u: number, v: number, out: Float32Array): void {
  const fx = u * p.w - 0.5;
  const fy = v * p.h - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const cx = (x: number) => (x < 0 ? 0 : x >= p.w ? p.w - 1 : x);
  const cy = (y: number) => (y < 0 ? 0 : y >= p.h ? p.h - 1 : y);
  const i00 = (cy(y0) * p.w + cx(x0)) * 4;
  const i10 = (cy(y0) * p.w + cx(x0 + 1)) * 4;
  const i01 = (cy(y0 + 1) * p.w + cx(x0)) * 4;
  const i11 = (cy(y0 + 1) * p.w + cx(x0 + 1)) * 4;
  for (let k = 0; k < 4; k++)
    out[k] =
      (p.d[i00 + k]! * (1 - ax) + p.d[i10 + k]! * ax) * (1 - ay) +
      (p.d[i01 + k]! * (1 - ax) + p.d[i11 + k]! * ax) * ay;
}

/** A side's premultiplied picture as the reference composes it (W x H x 4). */
function refSide(side: Side, c: StackContent<ImageBitmap>, framesOn: boolean): Float32Array {
  const out = new Float32Array(W * H * 4);
  if ('bitmap' in side) {
    out.set(pixels(side.bitmap).d);
    return out;
  }
  const s = side.scene;
  if (s.base) out.set(pixels(s.base).d);
  const video = framesOn && (s.gen ?? GEN) === GEN;
  const clipPx = pixels(CLIPS[s.clip]!);
  const ov = s.over ? pixels(s.over).d : null;
  const smp = new Float32Array(3);
  const col = new Float32Array(4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (video) {
        planeSample(c.plane!, x + 0.5, y + 0.5, smp);
        const wgt = smp[2]!;
        if (wgt > 0) {
          sampleBilinear(clipPx, smp[0]!, smp[1]!, col);
          const k = 1 - wgt * col[3]!;
          for (let j = 0; j < 4; j++) out[i + j] = col[j]! * wgt + out[i + j]! * k;
        }
      }
      if (ov) {
        const k = 1 - ov[i + 3]!;
        for (let j = 0; j < 4; j++) out[i + j] = ov[i + j]! + out[i + j]! * k;
      }
    }
  return out;
}

// ---- Run -----------------------------------------------------------------------------------------------

export type Diff = { differing: number; total: number; maxDelta: number };
export type CaseResult = {
  name: string;
  diff: Diff;
  probes: { at: string; got: string; want: string; ok: boolean }[];
  images?: { actual: string; reference: string; diff: string };
};

async function png(rgba: Uint8ClampedArray): Promise<string> {
  const c = new OffscreenCanvas(W, H);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
  const b = await c.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function runCase(cs: Case, tolerance: number, images: boolean): Promise<CaseResult> {
  const target = new OffscreenCanvas(W, H);
  const comp = new Canvas2DCompositor(target, W, H);
  const layers = LAYERS.map(() => new LayerStack<ImageBitmap>((b) => b.close()));
  const ls = layers[LAYER_INDEX.slide]!;
  const offer = (c: StackContent<ImageBitmap>) => {
    comp.prepare(LAYER_INDEX.slide, c); // the engine's offer hook
    ls.offer(c);
  };
  let fromC: StackContent<ImageBitmap> | null = null;
  if (cs.from) {
    fromC = await content(cs.from);
    offer(fromC);
    ls.requestFlip(fromC.key, 0, 0, 0);
    ls.tick(0, 16);
  }
  const toC = await content(cs.to);
  // The reference reads the planes after the stacks hold copies of them.
  const toPlane = toC.plane ? toC.plane.slice() : undefined;
  const fromPlane = fromC?.plane ? fromC.plane.slice() : undefined;
  offer(toC);
  const fades = !!cs.from || !!cs.fadeIn;
  ls.requestFlip(toC.key, fades ? 1000 : 0, fades ? 1000 : 0, 0);
  ls.tick(fades ? 1000 : 0, 16);
  const now = cs.now ?? 0;

  const frames: (VideoFrame | null)[] = [null, null, null, null];
  const gen = Int32Array.from([-1, -1, -1, -1]);
  if (!cs.noFrame)
    CLIPS.forEach((c, i) => {
      frames[slotOf(i)] = new VideoFrame(c, { timestamp: 0 });
      gen[slotOf(i)] = GEN;
    });
  const f: FrameInputs = {
    layers,
    video: { frames, version: new Int32Array(4), gen },
    now,
    clear: new Float32Array([CLEAR.r / 255, CLEAR.g / 255, CLEAR.b / 255, 1]),
    testPixel: Int32Array.from([-1, 0, 0]),
  };
  comp.draw(f);
  const actual = target.getContext('2d')!.getImageData(0, 0, W, H).data;

  // Reference: the layer over the clear colour.
  const w = ls.weight(now);
  const to = refSide(cs.to, { ...toC, plane: toPlane }, !cs.noFrame);
  const from = cs.from ? refSide(cs.from, { ...fromC!, plane: fromPlane }, !cs.noFrame) : null;
  const ref = new Uint8ClampedArray(W * H * 4);
  const dimg = new Uint8ClampedArray(W * H * 4);
  let differing = 0;
  let maxDelta = 0;
  const clear = [CLEAR.r / 255, CLEAR.g / 255, CLEAR.b / 255];
  for (let i = 0; i < W * H * 4; i += 4) {
    const a = from ? to[i + 3]! * w + from[i + 3]! * (1 - w) : to[i + 3]! * w;
    let worst = 0;
    for (let j = 0; j < 3; j++) {
      const m = from ? to[i + j]! * w + from[i + j]! * (1 - w) : to[i + j]! * w;
      const v = Math.round((m + clear[j]! * (1 - a)) * 255);
      ref[i + j] = v;
      worst = Math.max(worst, Math.abs(v - actual[i + j]!));
    }
    ref[i + 3] = 255;
    if (worst > tolerance) differing++;
    maxDelta = Math.max(maxDelta, worst);
    const g = Math.min(255, worst * 4);
    dimg[i] = g;
    dimg[i + 1] = worst > tolerance ? 0 : g;
    dimg[i + 2] = worst > tolerance ? 0 : g;
    dimg[i + 3] = 255;
  }

  const probes: CaseResult['probes'] = [];
  for (const [x, y] of cs.poster ?? []) {
    const b = pixels((cs.to as { scene: SceneSpec }).scene.base!).d;
    const i = (y * W + x) * 4;
    const want = [0, 1, 2].map((j) => Math.round(b[i + j]! * 255));
    const got = [0, 1, 2].map((j) => actual[i + j]!);
    probes.push({
      at: `${x},${y}`,
      got: got.join(','),
      want: want.join(','),
      ok: got.every((v, j) => Math.abs(v - want[j]!) <= 8),
    });
  }
  for (const fr of frames) fr?.close();
  const diff = { differing, total: W * H, maxDelta };
  const fail = differing / (W * H) > 0.004 || probes.some((p) => !p.ok);
  return {
    name: cs.name,
    diff,
    probes,
    images:
      images || fail
        ? { actual: await png(actual), reference: await png(ref), diff: await png(dimg) }
        : undefined,
  };
}

declare global {
  interface Window {
    __canvasScene: (tolerance: number, images: boolean) => Promise<CaseResult[]>;
  }
}

window.__canvasScene = async (tolerance, images) => {
  const out: CaseResult[] = [];
  for (const cs of CASES) out.push(await runCase(cs, tolerance, images));
  return out;
};
