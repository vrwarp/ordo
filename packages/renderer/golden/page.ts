import {
  DEFAULT_LYRIC_STYLE,
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  LOOK_STAGE,
  LOOK_STREAM,
  type Look,
  type Slide,
  type TextStyle,
} from '@ordo/domain';
import { type PictureTarget, preparePicture } from '../src/picture.ts';
import { type PropsModel, propBox } from '../src/props.ts';
import { rasterImage, rasterLowerThird, rasterProps, rasterSlide } from '../src/raster.ts';
import { type Ctx2D, drawText, fillColor } from '../src/text2d.ts';
import { type FontFile, FontResolver, LEGACY_FONT_ENV, installFontEnv } from '../src/text/fonts.ts';
import { RICH_STYLE_KEYS } from '../src/text/rich.ts';
import { CONTENT_CASES } from './content-cases.ts';
import { RICH_CASES, invarianceObjects } from './rich-cases.ts';
import { SHAPE_CASES } from './shape-cases.ts';

/**
 * Browser side of the golden-image test (design/14, design/23, design/27 §14 item 4): renders known slides
 * through the same rasterizer the outputs use, on an OffscreenCanvas in headless Chromium, and compares them
 * to the committed PNGs. Text uses faces the runner injects ('Golden', 'Golden Serif', 'Golden CJK'), so the
 * result does not depend on the fonts installed on the machine.
 *
 * The legacy cases draw with no font resolver installed (`LEGACY_FONT_ENV`, the font strings drawers built
 * before design/27), exactly as when their PNGs were made; `render(name, 'resolver')` draws them again with
 * the resolver, as every drawer now does, against the same PNG. The rich cases (rich-cases.ts) and the
 * PowerPoint slide cases of the one fallback rule (content-cases.ts: a hybrid slide, a slide showing its
 * PowerPoint picture) always draw with the resolver, which registers every face under an internal family
 * name (design/27 §10).
 */

const W = 960;
const H = 540;
const SCALE = W / 1920;
const FONT = 'Golden';

const withFont = (s: TextStyle): TextStyle => ({ ...s, fontFamily: FONT });

function reFont(look: Look): Look {
  const l: Look = JSON.parse(JSON.stringify(look));
  if (l.layers.slide.mode === 'lyricOnly') {
    l.layers.slide.style = withFont(l.layers.slide.style);
    if (l.layers.slide.nextSlide) l.layers.slide.nextSlide.style = withFont(l.layers.slide.nextSlide.style);
  }
  return l;
}

const lyric = (id: string, text: string, style: Partial<TextStyle> = {}): Slide => ({
  id,
  objects: [
    {
      id: `${id}-t`,
      type: 'text',
      box: { x: 160, y: 160, w: 1600, h: 760, rotation: 0 },
      text,
      style: { ...withFont(DEFAULT_LYRIC_STYLE), ...style },
      opacity: 1,
    },
  ],
  lyricObjectId: `${id}-t`,
});

const authored: Slide = {
  id: 'authored',
  objects: [
    {
      id: 'bg',
      type: 'shape',
      box: { x: 120, y: 120, w: 1680, h: 840, rotation: 0 },
      shape: 'rect',
      fill: { r: 30, g: 60, b: 120, a: 1 },
      stroke: { width: 8, color: { r: 255, g: 200, b: 0, a: 1 } },
      opacity: 1,
      radius: 40,
    },
    {
      id: 'circle',
      type: 'shape',
      box: { x: 1400, y: 200, w: 300, h: 300, rotation: 0 },
      shape: 'ellipse',
      fill: { r: 220, g: 40, b: 40, a: 0.8 },
      opacity: 1,
      radius: 0,
    },
    {
      id: 'title',
      type: 'text',
      box: { x: 200, y: 200, w: 1100, h: 200, rotation: 0 },
      text: 'Welcome to the service',
      style: { ...withFont(DEFAULT_LYRIC_STYLE), fontSizePx: 96, align: 'left', valign: 'top' },
      opacity: 1,
    },
    {
      id: 'body',
      type: 'text',
      box: { x: 200, y: 440, w: 1500, h: 400, rotation: 0 },
      text: 'A long line of text that wraps greedily onto several lines, with an outline and a soft shadow, and a very-long-word-that-must-break',
      style: {
        ...withFont(DEFAULT_LYRIC_STYLE),
        fontSizePx: 56,
        fontWeight: 400,
        align: 'center',
        valign: 'middle',
        color: { r: 255, g: 240, b: 200, a: 1 },
        shadow: undefined,
      },
      opacity: 1,
    },
    {
      id: 'rot',
      type: 'text',
      box: { x: 1380, y: 700, w: 400, h: 120, rotation: -12 },
      text: 'Rotated',
      style: {
        ...withFont(DEFAULT_LYRIC_STYLE),
        fontSizePx: 48,
        fontStyle: 'italic',
        outline: undefined,
        fill: { color: { r: 0, g: 0, b: 0, a: 0.6 }, radius: 16 },
        padding: 10,
      },
      opacity: 0.9,
    },
  ],
};

const verse = lyric('v1', 'Amazing grace, how sweet the sound\nThat saved a wretch like me');
const chorus = lyric('c1', 'I once was lost, but now am found\nWas blind, but now I see');

function gradient(): OffscreenCanvas {
  const c = new OffscreenCanvas(1200, 400);
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 1200, 400);
  g.addColorStop(0, '#ff8800');
  g.addColorStop(0.5, '#2266ff');
  g.addColorStop(1, '#22cc66');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1200, 400);
  ctx.fillStyle = '#fff';
  ctx.fillRect(560, 160, 80, 80);
  return c;
}

const noImages = () => undefined;

/** A picture whose sides tell apart: four coloured quadrants, a white frame and a white disc in the centre. */
function quadrants(): OffscreenCanvas {
  const c = new OffscreenCanvas(800, 600);
  const ctx = c.getContext('2d')!;
  const q: [string, number, number][] = [
    ['#d83a3a', 0, 0],
    ['#2fa84f', 400, 0],
    ['#2f6fd8', 0, 300],
    ['#e8c020', 400, 300],
  ];
  for (const [color, x, y] of q) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 400, 300);
  }
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 24;
  ctx.strokeRect(12, 12, 776, 576);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(400, 300, 90, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

/**
 * `ImageObject.crop` (design/27 §3.1): positive shares cut, negative shares pad with transparency (the
 * backdrop shows through), under every `fit`, with rotation, radius and opacity; one crop leaves nothing.
 * Each box is outlined above its picture.
 */
const cropped: Slide = (() => {
  const box = (x: number, y: number, rotation = 0) => ({ x, y, w: 560, h: 420, rotation });
  const frame = (id: string, b: ReturnType<typeof box>) => ({
    id,
    type: 'shape' as const,
    box: b,
    shape: 'rect' as const,
    stroke: { width: 4, color: { r: 255, g: 255, b: 255, a: 0.7 } },
    opacity: 1,
    radius: 0,
  });
  const image = (
    id: string,
    b: ReturnType<typeof box>,
    fit: 'contain' | 'cover' | 'stretch',
    crop: { l: number; t: number; r: number; b: number },
    extra: { opacity?: number; radius?: number } = {},
  ) => ({
    id,
    type: 'image' as const,
    box: b,
    mediaId: 'quadrants',
    fit,
    opacity: extra.opacity ?? 1,
    radius: extra.radius ?? 0,
    crop,
  });
  const boxes = [
    box(60, 60),
    box(680, 60),
    box(1300, 60, 12),
    box(60, 600),
    box(680, 600, -10),
    box(1300, 600),
  ];
  return {
    id: 'crop',
    objects: [
      {
        id: 'backdrop',
        type: 'shape',
        box: { x: 40, y: 40, w: 1840, h: 1000, rotation: 0 },
        shape: 'rect',
        fill: { r: 120, g: 30, b: 120, a: 1 },
        opacity: 1,
        radius: 0,
      },
      // Cut from the left, top and bottom, stretched.
      image('cut', boxes[0]!, 'stretch', { l: 0.25, t: 0.1, r: 0, b: 0.2 }),
      // Padded left, right and top, stretched: the picture is smaller and lower in its box.
      image('pad', boxes[1]!, 'stretch', { l: -0.25, t: -0.2, r: -0.25, b: 0 }),
      // The green quadrant alone, contain-fitted, rotated, with round corners.
      image('quarter', boxes[2]!, 'contain', { l: 0.5, t: 0, r: 0, b: 0.5 }, { radius: 48 }),
      // Padded on the left and cut on the other sides, cover-fitted.
      image('cover', boxes[3]!, 'cover', { l: -0.5, t: 0.25, r: 0.25, b: 0.25 }),
      // Padded on every side, contain-fitted, rotated, translucent.
      image('inset', boxes[4]!, 'contain', { l: -0.5, t: -0.5, r: -0.5, b: -0.5 }, { opacity: 0.8 }),
      // Cuts more than the whole width: nothing is drawn.
      image('none', boxes[5]!, 'stretch', { l: 0.6, t: 0, r: 0.5, b: 0 }),
      ...boxes.map((b, i) => frame(`frame${i}`, b)),
    ],
  };
})();

let quadrantsImage: OffscreenCanvas | undefined;
const cropImages = (id: string) => (id === 'quadrants' ? (quadrantsImage ??= quadrants()) : undefined);

/**
 * The output's asset worker's lookup (design/27 §7.1): each unrotated picture prepared once at its device
 * rectangle and copied 1:1; rotated and round-cornered ones from the source. Drawing the crop slide with it
 * must look like drawing it from the source, so its expected PNG is `image-crop.png`.
 */
const preparedCrop = new Map<string, ImageBitmap>();
const preparedImages = (id: string, target?: PictureTarget) => {
  const src = cropImages(id);
  if (!src || !target) return src;
  let ready = preparedCrop.get(target.key);
  if (!ready) {
    ready = preparePicture(src, target);
    if (ready) preparedCrop.set(target.key, ready);
  }
  return ready ?? src;
};

export const LEGACY_CASES: Record<string, (ctx: OffscreenCanvasRenderingContext2D) => void> = {
  'main-authored': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, authored, reFont(LOOK_MAIN), SCALE, noImages, { isSong: false });
  },
  'main-lyric': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, verse, reFont(LOOK_MAIN), SCALE, noImages, { isSong: true });
  },
  'stage-lyric-next': (ctx) => {
    fillColor(ctx, LOOK_STAGE.clearColor, W, H);
    rasterSlide(ctx, verse, reFont(LOOK_STAGE), SCALE, noImages, { nextSlide: chorus, isSong: true });
  },
  'lower-third-band': (ctx) => {
    fillColor(ctx, LOOK_LOWER_THIRD.clearColor, W, H);
    rasterSlide(ctx, chorus, reFont(LOOK_LOWER_THIRD), SCALE, noImages, { isSong: true });
  },
  'stream-key': (ctx) => {
    fillColor(ctx, LOOK_STREAM.clearColor, W, H);
    rasterLowerThird(ctx, 'Pastor Sam Jones — Guest speaker', reFont(LOOK_STREAM), SCALE);
  },
  'props-stage': (ctx) => {
    fillColor(ctx, LOOK_STAGE.clearColor, W, H);
    const look = LOOK_STAGE;
    const item = (
      id: 'clock' | 'countdown' | 'countdownLabel' | 'message' | 'elapsed' | 'videoRemaining',
      text: string,
    ) => {
      const { box, ...style } = propBox(id, look);
      return { id, text, style: withFont(style), box };
    };
    const model: PropsModel = {
      key: 'golden',
      empty: false,
      items: [
        item('clock', '10:29'),
        item('elapsed', '12:05'),
        item('countdown', '00:45'),
        item('countdownLabel', 'Service starts'),
        item('message', 'One more time'),
        item('videoRemaining', '02:30'),
      ],
    };
    rasterProps(ctx, model, SCALE, noImages, look.clearColor);
  },
  'image-cover': (ctx) => {
    rasterImage(ctx, gradient(), 'cover', SCALE);
  },
  'image-contain': (ctx) => {
    fillColor(ctx, { r: 40, g: 40, b: 40, a: 1 }, W, H);
    rasterImage(ctx, gradient(), 'contain', SCALE);
  },
  'image-crop': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, cropped, LOOK_MAIN, SCALE, cropImages, { isSong: false });
  },
};

export const CASES: Record<string, (ctx: OffscreenCanvasRenderingContext2D) => void> = {
  ...LEGACY_CASES,
  ...RICH_CASES,
  'image-crop-prepared': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, cropped, LOOK_MAIN, SCALE, preparedImages, { isSong: false });
  },
  ...CONTENT_CASES,
  ...SHAPE_CASES,
};

/** The faces the runner injects: each family is also registered directly under its own name. */
type GoldenFace = {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  base64: string;
  hash: string;
};

const resolver = new FontResolver({
  set: document.fonts,
  data: async (f) => {
    const b = faceBytes.get(f.hash);
    if (!b) throw new Error(`no face ${f.hash}`);
    return b.slice(0);
  },
});
const faceBytes = new Map<string, ArrayBuffer>();

/** Draw `draw` with the resolver installed, or with no resolver (the legacy font strings). */
function withEnv(env: 'legacy' | 'resolver', draw: () => void): void {
  installFontEnv(env === 'resolver' ? resolver : LEGACY_FONT_ENV);
  try {
    draw();
  } finally {
    installFontEnv(LEGACY_FONT_ENV);
  }
}

/** A 2D context that records every fillText and strokeText call (text and position as drawn). */
function recording(ctx: OffscreenCanvasRenderingContext2D): { ctx: Ctx2D; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(ctx, {
    get(t, k) {
      if (k === 'fillText' || k === 'strokeText')
        return (s: string, x: number, y: number) => {
          calls.push(`${k === 'fillText' ? 'f' : 's'}|${s}|${x}|${y}|${t.font}|${t.direction}`);
          t[k](s, x, y);
        };
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) {
      return Reflect.set(t, k, v, t);
    },
  });
  return { ctx: proxy as unknown as Ctx2D, calls };
}

export type Invariance = {
  /** Objects × box widths checked, each drawn at every width in `widths`. */
  configs: number;
  widths: number[];
  /** Rich configurations whose drawn text (strings, logical positions, fonts) differs between the widths. */
  richDiffer: string[];
  /** Legacy `drawText` of the same text and box: configurations whose line breaks differ (for comparison). */
  legacyDiffer: number;
  /** Lines drawn by the rich engine over all configurations at one width. */
  richLines: number;
};

/**
 * The line-break invariance check (design/27 §6 "Determinism", §14 item 4): every rich golden text object,
 * at several box widths, drawn through `rasterSlide` into canvases 960, 1920 and 3840 px wide (and a 320 px
 * thumbnail) must draw the same strings at the same logical positions in the same fonts. Each draw gets a
 * fresh copy of the object, so nothing is reused from the layout memo; the width cache is shared, as it is
 * in a drawer.
 */
function invariance(): Invariance {
  const widths = [320, 960, 1920, 3840];
  const canvases = widths.map((w) => new OffscreenCanvas(w, Math.round((w * 9) / 16)).getContext('2d')!);
  const richDiffer: string[] = [];
  let legacyDiffer = 0;
  let configs = 0;
  let richLines = 0;
  withEnv('resolver', () => {
    for (const o of invarianceObjects())
      for (const f of [1, 0.85, 0.7, 0.55]) {
        configs++;
        const box = { ...o.box, w: Math.round(o.box.w * f) };
        const drawn = canvases.map((c, i) => {
          const copy = JSON.parse(JSON.stringify({ ...o, box }));
          const rec = recording(c);
          c.clearRect(0, 0, c.canvas.width, c.canvas.height);
          rasterSlide(rec.ctx, { id: 'inv', objects: [copy] }, LOOK_MAIN, widths[i]! / 1920, () => undefined);
          return rec.calls.join('\n');
        });
        if (drawn.some((d) => d !== drawn[0])) richDiffer.push(`${o.id} at ${box.w} px`);
        richLines += new Set(drawn[0]!.split('\n').map((l) => l.split('|')[3])).size;
        // Legacy drawText of the same text and box: its lines are measured at the device size.
        const lines = canvases.map((c, i) => {
          const rec = recording(c);
          const scale = widths[i]! / 1920;
          const st: Record<string, unknown> = { ...o.style, outline: undefined, shadow: undefined };
          for (const k of RICH_STYLE_KEYS) delete st[k];
          drawText(rec.ctx, o.text, st as TextStyle, box, scale);
          return rec.calls.map((l) => l.split('|')[1]).join('\n');
        });
        if (lines.some((l) => l !== lines[0])) legacyDiffer++;
      }
  });
  return { configs, widths, richDiffer, legacyDiffer, richLines };
}

type Golden = {
  size: { width: number; height: number };
  names(): string[];
  legacyNames(): string[];
  fonts(files: GoldenFace[]): Promise<number>;
  render(name: string, env?: 'legacy' | 'resolver'): Promise<string>;
  invariance(): Invariance;
  diff(
    name: string,
    expectedBase64: string,
    tolerance: number,
  ): Promise<{ differing: number; total: number; maxDelta: number }>;
};

const last = new Map<string, ImageData>();

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

const golden: Golden = {
  size: { width: W, height: H },
  names: () => Object.keys(CASES),
  legacyNames: () => Object.keys(LEGACY_CASES),
  async fonts(files) {
    let n = 0;
    const list: FontFile[] = [];
    for (const f of files) {
      const bytes = b64ToBytes(f.base64);
      const face = new FontFace(f.family, bytes, { weight: String(f.weight), style: f.style });
      await face.load();
      document.fonts.add(face);
      faceBytes.set(f.hash, bytes.buffer);
      list.push({ family: f.family, weight: f.weight, style: f.style, hash: f.hash });
      n++;
    }
    const synced = await resolver.sync(list);
    if (synced.failed.length) throw new Error(`resolver: ${synced.failed.join('; ')}`);
    return n;
  },
  async render(name, env) {
    const draw = CASES[name];
    if (!draw) throw new Error(`unknown case ${name}`);
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    withEnv(env ?? (name in LEGACY_CASES ? 'legacy' : 'resolver'), () => draw(ctx));
    last.set(name, ctx.getImageData(0, 0, W, H));
    return blobToBase64(await c.convertToBlob({ type: 'image/png' }));
  },
  async diff(name, expectedBase64, tolerance) {
    const got = last.get(name);
    if (!got) throw new Error(`render ${name} first`);
    const bmp = await createImageBitmap(new Blob([b64ToBytes(expectedBase64)], { type: 'image/png' }));
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const exp = ctx.getImageData(0, 0, W, H).data;
    const act = got.data;
    let differing = 0;
    let maxDelta = 0;
    for (let i = 0; i < act.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(act[i + k]! - exp[i + k]!));
      if (d > maxDelta) maxDelta = d;
      if (d > tolerance) differing++;
    }
    return { differing, total: act.length / 4, maxDelta };
  },
  invariance,
};

(window as unknown as { __golden: Golden }).__golden = golden;
