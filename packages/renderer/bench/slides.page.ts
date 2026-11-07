import {
  DEFAULT_LYRIC_STYLE,
  LOOK_MAIN,
  type Rgba,
  type Slide,
  type SlideObject,
  type TextStyle,
} from '@ordo/domain';
import { pictureKey } from '../src/bitmap-cache.ts';
import { preparePicture } from '../src/picture.ts';
import { rasterSlide } from '../src/raster.ts';
import { rasterScene, rasterSceneSprites } from '../src/scene-raster.ts';
import { drawSprite, slideReach, spriteRect } from '../src/sprite.ts';
import { type ImageLookup, slidePictures } from '../src/text2d.ts';
import { FontResolver, installFontEnv } from '../src/text/fonts.ts';

/**
 * Browser side of the slide raster bench (design/27 §13 "Asset worker slide raster p95", §15 M7): four kinds
 * of rich slides drawn as the outputs' asset worker draws them, in a dedicated worker with the font resolver
 * installed, on a CPU-backed OffscreenCanvas of the output's size (`willReadFrequently`, as `surface()` in
 * apps/output/src/asset.worker.ts), at 1920x1080 and 3840x2160:
 * - **sermon over a photo**: a full-frame photo (a 4000x2667 JPEG, decoded and prepared at the slide's device
 *   size once, as the worker's picture cache keeps it), a dimming rectangle, a title and a body with runs,
 *   verse numbers, bullets and a stored autofit;
 * - **lyric with a shadow**: six lines in the default lyric style (outline and shadow) through the rich engine;
 * - **table**: a title and a 5x4 grid of filled and stroked cells, each with its own text, as the converter
 *   writes a table;
 * - **scene**: a slide whose video plays in its box, drawn as base and over (`rasterScene`), with a title
 *   over the video's top edge.
 * A job is what the worker does for a slide whose pictures are cached (`raster`): measure the slide's reach
 * on the surface shrunk to 1x1, size the surface to the tight sprite of what it draws (or the frame, when the
 * sprite would be most of it), draw, `transferToImageBitmap` (which makes Chromium raster the recorded draw
 * calls); a scene draws its base and over that way (`rasterSceneSprites`). `fullFrame` is the same slide drawn
 * full-frame, as before M7's sprites, and `blank` per size a full-frame job that draws nothing: the cost of a
 * fresh bitmap of the frame, which every full-frame job pays. Every job draws a structured clone of the slide,
 * as a job message brings one, so no layout memo hits; the width cache stays warm, as in the worker. The first
 * job of a kind and size is reported apart (`first`: compiling, the width cache, preparing the photo).
 */

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const GOLD: Rgba = { r: 255, g: 200, b: 60, a: 1 };
const INK: Rgba = { r: 20, g: 24, b: 32, a: 1 };

const base: TextStyle = {
  fontFamily: 'Bench',
  fontWeight: 400,
  fontStyle: 'normal',
  fontSizePx: 56,
  color: WHITE,
  align: 'left',
  valign: 'top',
  lineHeight: 1.2,
  letterSpacing: 0,
  transform: 'none',
  padding: 0,
};
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });

const VERSES =
  'Psalm 23:1-4\n1 The Lord is my shepherd; I shall not want. 2 He maketh me to lie down in green pastures: he leadeth me beside the still waters. 3 He restoreth my soul: he leadeth me in the paths of righteousness for his name’s sake. 4 Yea, though I walk through the valley of the shadow of death, I will fear no evil.\nHe restores\nHe leads\nHe is with us';

function runOf(text: string, part: string, extra: Record<string, unknown>) {
  const start = text.indexOf(part);
  return { start, end: start + part.length, ...extra };
}

/** Sermon-like text over a full-frame photo. */
export const SERMON_PHOTO: Slide = {
  id: 'sermon-photo',
  objects: [
    {
      id: 'photo',
      type: 'image',
      box: box(0, 0, 1920, 1080),
      mediaId: 'photo',
      fit: 'cover',
      opacity: 1,
      radius: 0,
    },
    {
      id: 'dim',
      type: 'shape',
      box: box(0, 0, 1920, 1080),
      shape: 'rect',
      fill: { ...INK, a: 0.45 },
      opacity: 1,
      radius: 0,
    },
    {
      id: 'title',
      type: 'text',
      box: box(120, 60, 1680, 160),
      text: 'The Lord Is My Shepherd',
      style: {
        ...base,
        fontSizePx: 88,
        fontWeight: 700,
        lineModel: 'office',
        valign: 'middle',
        insets: { l: 14, t: 7, r: 14, b: 7 },
      },
      opacity: 1,
      runs: [{ start: 15, end: 23, color: GOLD }],
    },
    {
      id: 'body',
      type: 'text',
      box: box(120, 260, 1680, 760),
      text: VERSES,
      style: {
        ...base,
        lineModel: 'office',
        autofit: 'shrink',
        fitScale: { font: 0.85, spacing: 0.9 },
        insets: { l: 14, t: 7, r: 14, b: 7 },
      },
      opacity: 1,
      runs: [
        runOf(VERSES, 'Psalm 23:1-4', { fontWeight: 700, color: GOLD }),
        runOf(VERSES, '1 The', { baseline: 0.3, color: GOLD, end: VERSES.indexOf('1 The') + 1 }),
        runOf(VERSES, 'still waters', { fontStyle: 'italic' }),
      ],
      paras: [
        { spaceAfterPx: 12 },
        { spaceAfterPx: 18, lineSpacing: 0.9 },
        { bullet: { char: '•' }, indentPx: 54, firstLinePx: -54 },
        { bullet: { char: '•' }, indentPx: 54, firstLinePx: -54 },
        { bullet: { char: '•' }, indentPx: 54, firstLinePx: -54 },
      ],
    },
  ] as SlideObject[],
};

const LYRIC =
  'Amazing grace, how sweet the sound\nThat saved a wretch like me\nI once was lost, but now am found\nWas blind, but now I see\nTwas grace that taught my heart to fear\nAnd grace my fears relieved';

/** A six-line lyric in the default lyric style: outline and shadow (the slide layer; its photo is the background's). */
export const LYRIC_SHADOW: Slide = {
  id: 'lyric-shadow',
  lyricObjectId: 'lyric',
  objects: [
    {
      id: 'lyric',
      type: 'text',
      box: box(160, 120, 1600, 840),
      text: LYRIC,
      style: { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Bench', fontSizePx: 84, lineModel: 'office' },
      opacity: 1,
      runs: [{ start: 0, end: 13, color: GOLD }],
    },
  ],
};

const ROWS = [
  ['Ministry', 'Day', 'Time', 'Room'],
  ['Prayer meeting', 'Wednesday', '7:00 pm', 'Chapel'],
  ['Youth group', 'Friday', '6:30 pm', 'Hall B'],
  ['Bible study', 'Tuesday', '10:00 am', 'Library'],
  ['Choir rehearsal', 'Thursday', '7:30 pm', 'Sanctuary'],
];

/** A table as the converter writes one: grid shapes and a text object per cell, and a title. */
export const TABLE: Slide = {
  id: 'table',
  objects: [
    {
      id: 'title',
      type: 'text',
      box: box(120, 60, 1680, 120),
      text: 'This week at church',
      style: { ...base, fontSizePx: 72, fontWeight: 700, color: INK, lineModel: 'office' },
      opacity: 1,
    },
    ...ROWS.flatMap((row, r) =>
      row.flatMap((cell, c): SlideObject[] => {
        const b = box(120 + c * 420, 220 + r * 150, 420, 150);
        const head = r === 0;
        return [
          {
            id: `cell-${r}-${c}`,
            type: 'shape',
            box: b,
            shape: 'rect',
            fill: head ? GOLD : r % 2 ? { r: 235, g: 240, b: 248, a: 1 } : WHITE,
            stroke: { width: 2, color: { r: 120, g: 130, b: 150, a: 1 } },
            opacity: 1,
            radius: 0,
          },
          {
            id: `text-${r}-${c}`,
            type: 'text',
            box: b,
            text: cell,
            style: {
              ...base,
              fontSizePx: 40,
              fontWeight: head ? 700 : 400,
              color: INK,
              valign: 'middle',
              lineModel: 'office',
              insets: { l: 18, t: 9, r: 18, b: 9 },
            },
            opacity: 1,
          },
        ];
      }),
    ),
  ] as SlideObject[],
};

/** A slide whose video plays in its box, with a title over the box's top edge (a scene's over). */
export const SCENE: Slide = {
  id: 'scene',
  objects: [
    { id: 'bg', type: 'shape', box: box(0, 0, 1920, 1080), shape: 'rect', fill: INK, opacity: 1, radius: 0 },
    {
      id: 'vid',
      type: 'image',
      box: box(360, 220, 1200, 675),
      mediaId: 'poster',
      fit: 'contain',
      opacity: 1,
      radius: 24,
      play: { mediaId: 'clip' },
    },
    {
      id: 'title',
      type: 'text',
      box: box(360, 120, 1200, 160),
      text: 'Mission trip 2026',
      style: { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Bench', fontSizePx: 96, lineModel: 'office' },
      opacity: 1,
    },
    {
      id: 'footer',
      type: 'text',
      box: box(360, 930, 1200, 100),
      text: 'Thank you for your support',
      style: { ...base, fontSizePx: 48, align: 'center', lineModel: 'office' },
      opacity: 1,
    },
  ] as SlideObject[],
};

export const KINDS = [
  { kind: 'sermon over a photo', slide: SERMON_PHOTO },
  { kind: 'lyric with a shadow', slide: LYRIC_SHADOW },
  { kind: 'table', slide: TABLE },
  { kind: 'scene (video in its box)', slide: SCENE },
] as const;

export type Stats = { n: number; p50: number; p95: number; max: number; mean: number };
export type SlideRow = {
  kind: string;
  width: number;
  height: number;
  /** The first job: compiling, a cold width cache and, for the photo, its preparation. */
  firstMs: number;
  /** Preparing the slide's pictures for this size (decode excluded), once per size as the cache keeps them. */
  prepareMs: number;
  /** As the asset worker draws it now: a tight sprite where that saves pixels. */
  raster: Stats;
  /** The same slide drawn full-frame (before M7's sprites). */
  fullFrame: Stats;
  /** Pixels of the bitmaps drawn, as a share of the frame (a scene: base and over together). */
  share: number;
};
export type SlidesReport = {
  context: string;
  userAgent: string;
  cores: number;
  /** Decoding the 4000x2667 photo JPEG (`createImageBitmap`), once. */
  decodeMs: number;
  rows: SlideRow[];
  /** Per size: a full-frame job that draws nothing (sizing the surface, a fresh backing, the transfer). */
  blank: { width: number; height: number; raster: Stats }[];
};

function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
  return {
    n: s.length,
    p50: q(0.5),
    p95: q(0.95),
    max: s[s.length - 1]!,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

/** A photo-like 4000x2667 JPEG: gradients, soft shapes and grain, so it compresses like a photograph. */
async function photoJpeg(): Promise<Blob> {
  const w = 4000;
  const h = 2667;
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#3b6ea5');
  sky.addColorStop(0.55, '#f2c48d');
  sky.addColorStop(1, '#3d2b1f');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `hsla(${Math.floor(rnd() * 360)}, 40%, ${30 + rnd() * 40}%, ${0.05 + rnd() * 0.2})`;
    g.beginPath();
    g.ellipse(rnd() * w, rnd() * h, 20 + rnd() * 400, 20 + rnd() * 300, rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 18;
    img.data[i] = Math.max(0, Math.min(255, img.data[i]! + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1]! + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2]! + n));
  }
  g.putImageData(img, 0, 0);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

/** A 1920x1080 poster for the scene's video. */
function poster(): ImageBitmap {
  const c = new OffscreenCanvas(1920, 1080);
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 1920, 1080);
  grad.addColorStop(0, '#225');
  grad.addColorStop(1, '#a52');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1920, 1080);
  return c.transferToImageBitmap();
}

/**
 * The asset worker's surface as apps/output/src/asset.worker.ts keeps it (M7): one CPU-backed canvas, shrunk
 * to 1x1 to measure text on, sized to the frame or a sprite's rect to draw on, and not cleared again when a
 * transfer or a resize has just cleared it.
 */
function workerSurface(canvas: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D) {
  let fresh = true;
  const measure = () => {
    if (canvas.width !== 1 || canvas.height !== 1) {
      canvas.width = 1;
      canvas.height = 1;
      fresh = true;
    }
    return ctx;
  };
  const surface = (w: number, h: number) => {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      fresh = true;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!fresh) ctx.clearRect(0, 0, w, h);
    fresh = false;
    return ctx;
  };
  const take = () => {
    const b = canvas.transferToImageBitmap();
    fresh = true;
    return b;
  };
  return { measure, surface, take };
}

export async function bench(
  set: FontFaceSet,
  regular: ArrayBuffer,
  bold: ArrayBuffer,
  iterations: number,
  context: string,
  sizes: readonly number[] = [1920, 3840],
): Promise<SlidesReport> {
  const resolver = new FontResolver({
    set,
    data: async (f) => (f.hash === 'bold' ? bold : regular).slice(0),
  });
  await resolver.sync([
    { family: 'Bench', weight: 400, style: 'normal', hash: 'regular' },
    { family: 'Bench', weight: 700, style: 'normal', hash: 'bold' },
  ]);
  installFontEnv(resolver);
  const jpeg = await photoJpeg();
  const d0 = performance.now();
  const photo = await createImageBitmap(jpeg);
  const decodeMs = performance.now() - d0;
  const sources: Record<string, ImageBitmap> = { photo, poster: poster() };
  const rows: SlideRow[] = [];
  const blank: SlidesReport['blank'] = [];
  for (const width of sizes) {
    const height = Math.round((width * 9) / 16);
    const scale = width / 1920;
    const frame = { width, height };
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const { measure, surface, take } = workerSurface(canvas, ctx);
    const blankJob = () => {
      const t0 = performance.now();
      surface(width, height).fillRect(0, 0, 1, 1);
      take().close();
      measure();
      return performance.now() - t0;
    };
    for (let i = 0; i < 3; i++) blankJob();
    const blankTimes: number[] = [];
    for (let i = 0; i < iterations; i++) blankTimes.push(blankJob());
    blank.push({ width, height, raster: stats(blankTimes) });
    for (const { kind, slide } of KINDS) {
      // The worker's picture cache: each use prepared once for its device target, then copied 1:1.
      const prepared = new Map<string, ImageBitmap>();
      const p0 = performance.now();
      for (const u of slidePictures(slide, { scale, look: LOOK_MAIN })) {
        const src = sources[u.mediaId];
        if (!src || !u.target) continue;
        const bmp = preparePicture(src, u.target);
        if (bmp) prepared.set(pictureKey(u.mediaId, u.target), bmp);
      }
      const prepareMs = performance.now() - p0;
      const lookup: ImageLookup = (id, target) =>
        (target && prepared.get(pictureKey(id, target))) || sources[id];
      const scene = kind.startsWith('scene');
      const opts = { isSong: kind.startsWith('lyric') };
      let share = 1;
      // As the asset worker draws a slide job now (asset.worker.ts `run`).
      const job = () => {
        const s = structuredClone(slide);
        const t0 = performance.now();
        if (scene) {
          const sc = rasterSceneSprites(measure(), surface, take, frame, s, LOOK_MAIN, scale, lookup, 'vid', {
            clip: { w: 1920, h: 1080 },
          });
          const px = (b: ImageBitmap | undefined) => (b ? b.width * b.height : 0);
          share = (px(sc?.base.bitmap) + px(sc?.over?.bitmap)) / (width * height);
          sc?.base.bitmap.close();
          sc?.over?.bitmap.close();
        } else {
          const reach = slideReach(measure(), s, { scale, look: LOOK_MAIN, ...opts });
          const d = drawSprite(surface, take, width, height, spriteRect(reach, scale, width, height), (c) =>
            rasterSlide(c, s, LOOK_MAIN, scale, lookup, opts),
          );
          share = (d.bitmap.width * d.bitmap.height) / (width * height);
          d.bitmap.close();
        }
        return performance.now() - t0;
      };
      // The same slide full-frame, as before M7's sprites.
      const full = () => {
        const s = structuredClone(slide);
        const t0 = performance.now();
        const c = surface(width, height);
        if (scene) {
          const sc = rasterScene(c, take, s, LOOK_MAIN, scale, lookup, 'vid', { clip: { w: 1920, h: 1080 } });
          sc?.base.close();
          sc?.over?.close();
        } else {
          rasterSlide(c, s, LOOK_MAIN, scale, lookup, opts);
          take().close();
        }
        measure();
        return performance.now() - t0;
      };
      const firstMs = job() + prepareMs;
      for (let i = 0; i < 3; i++) {
        job();
        full();
      }
      const times: number[] = [];
      const fullTimes: number[] = [];
      for (let i = 0; i < iterations; i++) {
        times.push(job());
        fullTimes.push(full());
      }
      for (const b of prepared.values()) b.close();
      rows.push({
        kind,
        width,
        height,
        firstMs,
        prepareMs,
        raster: stats(times),
        fullFrame: stats(fullTimes),
        share,
      });
    }
  }
  for (const b of Object.values(sources)) b.close();
  resolver.dispose();
  return {
    context,
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency ?? 0,
    decodeMs,
    rows,
    blank,
  };
}

declare const WorkerGlobalScope: unknown;
const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined';

type Request = { regular: ArrayBuffer; bold: ArrayBuffer; iterations: number; sizes?: number[] };

if (inWorker) {
  const scope = self as unknown as { fonts: FontFaceSet; onmessage: unknown; postMessage(m: unknown): void };
  scope.onmessage = async (e: MessageEvent<Request>) => {
    try {
      const r = await bench(
        scope.fonts,
        e.data.regular,
        e.data.bold,
        e.data.iterations,
        'worker',
        e.data.sizes,
      );
      scope.postMessage({ ok: true, report: r });
    } catch (err) {
      scope.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
    }
  };
} else if (typeof window !== 'undefined') {
  const bytes = (s: string) => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  (window as unknown as { __slides: unknown }).__slides = (
    source: string,
    regular: string,
    bold: string,
    iterations: number,
    sizes?: number[],
  ) =>
    new Promise<SlidesReport>((resolve, reject) => {
      const w = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      w.onmessage = (e: MessageEvent<{ ok: boolean; report?: SlidesReport; error?: string }>) => {
        w.terminate();
        if (e.data.ok) resolve(e.data.report!);
        else reject(new Error(e.data.error));
      };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ regular: bytes(regular), bold: bytes(bold), iterations, sizes } satisfies Request);
    });
}
