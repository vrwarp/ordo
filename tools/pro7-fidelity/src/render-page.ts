import type { GeomFile, Slide } from '@ordo/domain';
import { pictureKey } from '@ordo/renderer/bitmap-cache.ts';
import { clearGeomFiles, putGeomFile } from '@ordo/renderer/geom/stored.ts';
import { type PictureTarget, pictureTarget, preparePicture } from '@ordo/renderer/picture.ts';
import { FontResolver, installFontEnv, type FontFile } from '@ordo/renderer/text/fonts.ts';
import {
  type ImageLookup,
  type SlidePicture,
  drawImageFit,
  drawSlide2D,
  slidePictures,
} from '@ordo/renderer/text2d.ts';

/**
 * Browser-side headless Chromium slide renderer for ProPresenter 7 fidelity tests.
 *
 * Distinct from PPTX rendering:
 * - ProPresenter slide canvases start transparent (clearRect) instead of opaque black.
 * - Background media resolution checks slide.backgroundMediaId first, then slide.clearBackground,
 *   falling back to presentationBackgroundMediaId.
 */

export type PageFont = FontFile & { url: string };

export type PageMedia = {
  id: string;
  url: string;
  needW: number;
  needH: number;
};

export type Pro7RenderJob = {
  slide: Slide;
  presentationBackgroundMediaId?: string;
  repeats?: number;
};

export type Pro7RenderResult = {
  pngBase64: string;
  width: number;
  height: number;
  ms1920: number;
  missing: string[];
};

export type Pro7RenderPage = {
  fonts(list: PageFont[]): Promise<{ loaded: number; failed: string[]; generation: number }>;
  media(list: PageMedia[]): void;
  geoms(list: { id: string; file: GeomFile }[]): void;
  render(job: Pro7RenderJob): Promise<Pro7RenderResult>;
};

const CACHE_PIXELS = 128_000_000;
const OVERSIZE = 1.25;
const BACKGROUND = { box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }, fit: 'cover' } as const;

type Decoded = { bmp: ImageBitmap | undefined; px: number };

const known = new Map<string, PageMedia>();
const cache = new Map<string, Decoded>();
let cached = 0;

function evict(keep: ReadonlySet<string>): void {
  for (const [key, d] of cache) {
    if (cached <= CACHE_PIXELS) return;
    if (keep.has(key)) continue;
    drop(key, d);
  }
}

function drop(key: string, d: Decoded): void {
  d.bmp?.close();
  cached -= d.px;
  cache.delete(key);
}

function touch(key: string): Decoded | undefined {
  const d = cache.get(key);
  if (d) {
    cache.delete(key);
    cache.set(key, d);
  }
  return d;
}

function put(key: string, bmp: ImageBitmap | undefined): void {
  const old = cache.get(key);
  if (old) drop(key, old);
  const d = { bmp, px: bmp ? bmp.width * bmp.height : 0 };
  cache.set(key, d);
  cached += d.px;
}

async function decode(m: PageMedia): Promise<ImageBitmap | undefined> {
  try {
    const res = await fetch(m.url);
    if (!res.ok) return undefined;
    const blob = await res.blob();
    return await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  } catch {
    return undefined;
  }
}

async function source(full: ImageBitmap, m: PageMedia): Promise<ImageBitmap | undefined> {
  const scale = Math.max(m.needW / full.width, m.needH / full.height);
  if (!(scale > 0) || scale * OVERSIZE >= 1) return full;
  const w = Math.max(1, Math.round(full.width * scale));
  const h = Math.max(1, Math.round(full.height * scale));
  try {
    return await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  } catch {
    return undefined;
  } finally {
    full.close();
  }
}

function usesOf(
  slide: Slide,
  presentationBackgroundMediaId: string | undefined,
  widths: readonly number[],
): SlidePicture[] {
  const out: SlidePicture[] = [];
  const bgId = slide.backgroundMediaId ?? (slide.clearBackground ? undefined : presentationBackgroundMediaId);
  for (const width of widths) {
    const scale = width / 1920;
    if (bgId) {
      out.push({ mediaId: bgId, target: pictureTarget(BACKGROUND, scale) });
    }
    out.push(...slidePictures(slide, { scale }));
  }
  return out;
}

async function picturesOf(
  slide: Slide,
  presentationBackgroundMediaId: string | undefined,
  missing: string[],
  widths: readonly number[],
): Promise<ImageLookup> {
  const wants = new Map<string, { targets: Map<string, PictureTarget>; source: boolean }>();
  for (const u of usesOf(slide, presentationBackgroundMediaId, widths)) {
    let w = wants.get(u.mediaId);
    if (!w) wants.set(u.mediaId, (w = { targets: new Map(), source: false }));
    if (u.target) w.targets.set(u.target.key, u.target);
    else w.source = true;
  }
  const keep = new Set<string>();
  for (const [id, w] of wants) {
    keep.add(id);
    for (const t of w.targets.values()) keep.add(pictureKey(id, t));
  }
  for (const [id, w] of wants) {
    const todo = [...w.targets.values()].filter((t) => !touch(pictureKey(id, t)));
    let needSource = w.source && !touch(id);
    if (todo.length || needSource) {
      const m = known.get(id);
      const full = m ? await decode(m) : undefined;
      for (const t of todo) {
        const ready = full && preparePicture(full, t);
        if (ready || !full) put(pictureKey(id, t), ready);
        else if (!cache.has(id)) needSource = true;
      }
      if (needSource) put(id, full && m ? await source(full, m) : undefined);
      else full?.close();
      evict(keep);
    }
    const keys = [...w.targets.values()].map((t) => pictureKey(id, t));
    if (w.source) keys.push(id);
    if (keys.some((k) => cache.has(k) && !cache.get(k)!.bmp) && !missing.includes(id)) {
      missing.push(id);
    }
  }
  return (id, t) => (t && cache.get(pictureKey(id, t))?.bmp) || cache.get(id)?.bmp;
}

function draw(
  ctx: OffscreenCanvasRenderingContext2D,
  job: Pro7RenderJob,
  width: number,
  images: ImageLookup,
): void {
  const scale = width / 1920;
  const height = Math.round(1080 * scale);
  // ProPresenter exports cues without backgrounds over transparent RGBA (0, 0, 0, 0)
  ctx.clearRect(0, 0, width, height);

  const bgId =
    job.slide.backgroundMediaId ??
    (job.slide.clearBackground ? undefined : job.presentationBackgroundMediaId);
  if (bgId) {
    const target = pictureTarget(BACKGROUND, scale);
    const bg = images(bgId, target);
    if (bg) {
      drawImageFit(ctx, bg, BACKGROUND.box, scale, 'cover', 1, 0, undefined, target);
    }
  }
  drawSlide2D(ctx, job.slide, { scale, images });
}

function timed(
  ctx: OffscreenCanvasRenderingContext2D,
  job: Pro7RenderJob,
  width: number,
  images: ImageLookup,
  repeats: number,
): number {
  const times: number[] = [];
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    draw(ctx, job, width, images);
    ctx.getImageData(0, 0, 1, 1);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times.length ? times[times.length >> 1]! : 0;
}

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const canvases = new Map<number, OffscreenCanvasRenderingContext2D>();

function context(width: number): OffscreenCanvasRenderingContext2D {
  let ctx = canvases.get(width);
  if (!ctx) {
    const c = new OffscreenCanvas(width, Math.round((width * 1080) / 1920));
    const got = c.getContext('2d');
    if (!got) throw new Error('2D context unavailable');
    ctx = got;
    canvases.set(width, ctx);
  }
  return ctx;
}

const fontUrls = new Map<string, string>();
const fontBytes = new Map<string, Promise<ArrayBuffer>>();

const resolver = new FontResolver({
  set: document.fonts,
  async data(f) {
    let got = fontBytes.get(f.hash);
    if (!got) {
      const url = fontUrls.get(f.hash);
      if (!url) throw new Error('no such font file');
      got = fetch(url).then((r) => {
        if (!r.ok) throw new Error(`font file ${r.status}`);
        return r.arrayBuffer();
      });
      got.catch(() => fontBytes.delete(f.hash));
      fontBytes.set(f.hash, got);
    }
    return (await got).slice(0);
  },
});
installFontEnv(resolver);

const page: Pro7RenderPage = {
  async fonts(list) {
    for (const f of list) {
      if (!fontUrls.has(f.hash)) fontUrls.set(f.hash, f.url);
    }
    const got = await resolver.sync(list.map(({ url: _, ...f }) => f));
    fontBytes.clear();
    return { loaded: got.loaded, failed: got.failed, generation: resolver.generation };
  },
  media(list) {
    for (const d of cache.values()) d.bmp?.close();
    cache.clear();
    cached = 0;
    known.clear();
    for (const m of list) known.set(m.id, m);
  },
  geoms(list) {
    clearGeomFiles();
    for (const g of list) putGeomFile(g.id, g.file);
  },
  async render(job) {
    const missing: string[] = [];
    const t0 = performance.now();
    const images = await picturesOf(job.slide, job.presentationBackgroundMediaId, missing, [1920]);
    const ctx = context(1920);
    draw(ctx, job, 1920, images);
    ctx.getImageData(0, 0, 1, 1);
    const ms1920 = job.repeats ? timed(ctx, job, 1920, images, job.repeats) : performance.now() - t0;
    const blob = await ctx.canvas.convertToBlob({ type: 'image/png' });
    const pngBase64 = await blobToBase64(blob);
    return { pngBase64, width: 1920, height: 1080, ms1920, missing };
  },
};

(window as unknown as { __pro7: Pro7RenderPage }).__pro7 = page;
