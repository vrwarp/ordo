import type { Slide } from '@ordo/domain';
import { currentFontEnv, type FontFile, FontResolver, installFontEnv } from '@ordo/renderer/text/fonts.ts';
import type { FaceRequest } from '@ordo/renderer/text/types.ts';
import { drawImageFit, drawSlide2D, fillColor } from '@ordo/renderer/text2d.ts';

/**
 * Browser side of the harness's native column (design/27 §14.1). `native.ts` bundles this file with
 * esbuild and loads it in headless Chromium, as `packages/renderer/golden/run.ts` loads its page.
 *
 * Each slide is drawn as the operator's thumbnail worker draws it: black, the slide's background picture
 * cover-fit, then the real `drawSlide2D` of `@ordo/renderer`. The picture is taken at 1920x1080 and cut to
 * the deck's slide rectangle, so a 4:3 deck compares with LibreOffice's 4:3 page like for like. The slide is
 * then drawn again at 1920 and 3840 px for the raster timings.
 *
 * Fonts go through the renderer's `FontResolver`, installed as the page's font environment as the asset and
 * thumbnail workers install theirs (design/27 §10): each family's faces are registered under an internal
 * name never resolved before, and font strings are built from loaded faces only (the exact family, its
 * `fallbackFonts`, the script fallback, ordo's default face, the generic chain). The slides keep the deck's
 * family names. `fonts.ts` decides which faces this machine gives each family.
 *
 * Pictures and fonts come from the harness's own origin (`native.ts` answers every request; nothing else
 * is fetched). Pictures are decoded once per deck, scaled down to what the deck shows of them (the hub's
 * picture preparation does the same, design/27 §4), and kept in a bounded cache.
 */

/** A face to register: the resolver's `FontFile`, read from `url`. */
export type PageFont = FontFile & { url: string };

export type PageMedia = {
  id: string;
  url: string;
  /** The widest and tallest the deck draws this picture, in px at 3840 wide (0: unknown). */
  needW: number;
  needH: number;
};

export type RenderJob = {
  slide: Slide;
  /** The deck's slide area in logical px (1920x1080). */
  rect: { x: number; y: number; w: number; h: number };
  /** Timed draws at each width (the median is reported); 0 skips the timing (both times are then 0). */
  repeats: number;
};

export type RenderResult = {
  /** PNG of the slide area at 1920x1080, base64. */
  png: string;
  width: number;
  height: number;
  /** Median draw time in ms (draw and flush) at 1920 and 3840 px wide. */
  ms1920: number;
  ms3840: number;
  /** Media ids the slide uses that could not be decoded. */
  missing: string[];
};

export type NativePage = {
  /** Register the deck's faces with the page's resolver (`FontResolver.sync`). */
  fonts(list: PageFont[]): Promise<{ loaded: number; failed: string[]; generation: number }>;
  /** The CSS font the installed font environment gives each request (what text is drawn with). */
  font(reqs: FaceRequest[]): string[];
  media(list: PageMedia[]): void;
  render(job: RenderJob): Promise<RenderResult>;
};

/** Decoded pixels kept between slides of a deck (about 512 MB of RGBA). */
const CACHE_PIXELS = 128_000_000;
/** A picture is scaled down when it is more than this much larger than its largest use (as the hub does). */
const OVERSIZE = 1.25;

type Decoded = { bmp: ImageBitmap | undefined; px: number };

const known = new Map<string, PageMedia>();
const cache = new Map<string, Decoded>();
let cached = 0;

function evict(keep: ReadonlySet<string>): void {
  for (const [id, d] of cache) {
    if (cached <= CACHE_PIXELS) return;
    if (keep.has(id)) continue;
    d.bmp?.close();
    cached -= d.px;
    cache.delete(id);
  }
}

async function decode(m: PageMedia): Promise<ImageBitmap | undefined> {
  try {
    const res = await fetch(m.url);
    if (!res.ok) return undefined;
    const full = await createImageBitmap(await res.blob());
    const scale = Math.max(m.needW / full.width, m.needH / full.height);
    if (!(scale > 0) || scale * OVERSIZE >= 1) return full;
    const w = Math.max(1, Math.round(full.width * scale));
    const h = Math.max(1, Math.round(full.height * scale));
    const small = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    full.close();
    return small;
  } catch {
    return undefined;
  }
}

/** The decoded pictures a slide uses, by media id; ids that fail are listed in `missing`. */
async function picturesOf(ids: ReadonlySet<string>, missing: string[]): Promise<Map<string, ImageBitmap>> {
  const out = new Map<string, ImageBitmap>();
  for (const id of ids) {
    let d = cache.get(id);
    if (d) {
      // Most recently used last, so eviction takes the oldest first.
      cache.delete(id);
      cache.set(id, d);
    } else {
      const m = known.get(id);
      const bmp = m ? await decode(m) : undefined;
      d = { bmp, px: bmp ? bmp.width * bmp.height : 0 };
      cache.set(id, d);
      cached += d.px;
      evict(ids);
    }
    if (d.bmp) out.set(id, d.bmp);
    else missing.push(id);
  }
  return out;
}

function mediaIdsOf(slide: Slide): Set<string> {
  const ids = new Set<string>();
  if (slide.backgroundMediaId) ids.add(slide.backgroundMediaId);
  if (slide.imported?.imageMediaId) ids.add(slide.imported.imageMediaId);
  for (const o of slide.objects) if (o.type === 'image') ids.add(o.mediaId);
  return ids;
}

/** The thumbnail worker's drawing: black, background cover-fit, then the slide (`thumb.worker.ts`). */
function draw(
  ctx: OffscreenCanvasRenderingContext2D,
  slide: Slide,
  width: number,
  pictures: Map<string, ImageBitmap>,
): void {
  const scale = width / 1920;
  fillColor(ctx, { r: 0, g: 0, b: 0, a: 1 }, width, Math.round(1080 * scale));
  const bg = slide.backgroundMediaId ? pictures.get(slide.backgroundMediaId) : undefined;
  if (bg) drawImageFit(ctx, bg, { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }, scale, 'cover');
  drawSlide2D(ctx, slide, { scale, images: (id) => pictures.get(id) });
}

/** Draw, then read one pixel back: Chromium records canvas commands and only rasterizes on a read. */
function timed(
  ctx: OffscreenCanvasRenderingContext2D,
  slide: Slide,
  width: number,
  pictures: Map<string, ImageBitmap>,
  repeats: number,
): number {
  const times: number[] = [];
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    draw(ctx, slide, width, pictures);
    ctx.getImageData(0, 0, 1, 1);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times.length ? times[times.length >> 1]! : 0;
}

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

const canvases = new Map<number, OffscreenCanvasRenderingContext2D>();

/** Font files by hash: each is fetched once per sync, and every face made from it gets its own copy. */
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
      // A failed read is not kept: the resolver's retry reads again.
      got.catch(() => fontBytes.delete(f.hash));
      fontBytes.set(f.hash, got);
    }
    return (await got).slice(0);
  },
});
installFontEnv(resolver);

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

const page: NativePage = {
  async fonts(list) {
    for (const f of list) if (!fontUrls.has(f.hash)) fontUrls.set(f.hash, f.url);
    const got = await resolver.sync(list.map(({ url: _, ...f }) => f));
    // The faces hold their own copies; a retry reads its file again.
    fontBytes.clear();
    return { loaded: got.loaded, failed: got.failed, generation: resolver.generation };
  },
  font(reqs) {
    return reqs.map((r) => currentFontEnv().font(r));
  },
  media(list) {
    for (const d of cache.values()) d.bmp?.close();
    cache.clear();
    cached = 0;
    known.clear();
    for (const m of list) known.set(m.id, m);
  },
  async render(job) {
    const missing: string[] = [];
    const pictures = await picturesOf(mediaIdsOf(job.slide), missing);
    const ctx = context(1920);
    draw(ctx, job.slide, 1920, pictures);
    const x = Math.max(0, Math.min(1919, Math.round(job.rect.x)));
    const y = Math.max(0, Math.min(1079, Math.round(job.rect.y)));
    const w = Math.max(1, Math.min(1920 - x, Math.round(job.rect.w)));
    const h = Math.max(1, Math.min(1080 - y, Math.round(job.rect.h)));
    const crop = new OffscreenCanvas(w, h);
    crop.getContext('2d')!.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
    const png = await blobToBase64(await crop.convertToBlob({ type: 'image/png' }));
    const ms1920 = job.repeats ? timed(ctx, job.slide, 1920, pictures, job.repeats) : 0;
    const ms3840 = job.repeats ? timed(context(3840), job.slide, 3840, pictures, job.repeats) : 0;
    return { png, width: w, height: h, ms1920, ms3840, missing };
  },
};

(window as unknown as { __native: NativePage }).__native = page;
