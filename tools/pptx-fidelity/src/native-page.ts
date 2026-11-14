import type { Slide } from '@ordo/domain';
import { currentFontEnv, type FontFile, FontResolver, installFontEnv } from '@ordo/renderer/text/fonts.ts';
import type { FaceRequest } from '@ordo/renderer/text/types.ts';
import { pictureKey } from '@ordo/renderer/bitmap-cache.ts';
import { clampSlide } from '@ordo/renderer/clamp.ts';
import { drawableContent } from '@ordo/renderer/content.ts';
import { clearEffectCache } from '@ordo/renderer/effects.ts';
import { withinDrawBudget } from '@ordo/renderer/geombudget.ts';
import { clearGeomFiles, putGeomFile } from '@ordo/renderer/geom/stored.ts';
import { clearDecorFiles, putDecorFile } from '@ordo/renderer/decor/files.ts';
import { withoutExifOrientation } from './exif.ts';
import { timeEach } from './objecttime.ts';
import { type PictureTarget, pictureTarget, preparePicture } from '@ordo/renderer/picture.ts';
import {
  type ImageLookup,
  type SlidePicture,
  drawImageFit,
  drawObject,
  drawSlide2D,
  fillColor,
  slidePictures,
} from '@ordo/renderer/text2d.ts';
// The table and decoration drawers, registered at once: the outputs load them per kind before they draw
// (`loadShapeDrawers`).
import '@ordo/renderer/table/index.ts';
import '@ordo/renderer/decor/index.ts';

/**
 * Browser side of the harness's native column (design/27 §14.1). `native.ts` bundles this file with
 * esbuild and loads it in headless Chromium, as `packages/renderer/golden/run.ts` loads its page.
 *
 * Each slide is drawn as the operator's thumbnail worker draws it: black, the slide's background picture
 * cover-fit, then the real `drawSlide2D` of `@ordo/renderer`. The picture is taken at 1920x1080 and cut to
 * the deck's slide rectangle, so a 4:3 deck compares with LibreOffice's 4:3 page like for like. The slide is
 * then drawn again at 1920 and 3840 px for the raster timings: warm (the median of repeated draws, pictures
 * prepared) and cold (preparing the pictures the cache lacks plus the first draw, as an output pays it on a
 * slide change).
 *
 * Fonts go through the renderer's `FontResolver`, installed as the page's font environment as the asset and
 * thumbnail workers install theirs (design/27 §10): each family's faces are registered under an internal
 * name never resolved before, and font strings are built from loaded faces only (the exact family, its
 * `fallbackFonts`, the script fallback, ordo's default face, the generic chain). The slides keep the deck's
 * family names. `fonts.ts` decides which faces this machine gives each family.
 *
 * Pictures and fonts come from the harness's own origin (`native.ts` answers every request; nothing else
 * is fetched). Each picture a slide draws unrotated is prepared as the output's asset worker prepares it
 * (design/27 §7.1): resampled once from the decoded file into an sRGB bitmap of its device rectangle (cut
 * to the canvas), at 1920 and then at 3840 wide, before the slide is drawn at that width, so the warm draws
 * copy it 1:1; the cold time includes that preparation. A picture
 * drawn from its source (rotated, round corners) is decoded scaled down to what the deck shows of it (the
 * hub's picture preparation does the same, design/27 §4). Both are kept in a bounded cache.
 *
 * `objects` times each object of a slide on its own (`maxObjectMs`, design/27 §13's 50 ms task): the slide
 * is drawn again on a canvas of its own, object by object as `drawSlide2D` draws them, each `drawObject`
 * timed with its flush. Each object is drawn cold: a copy of the slide (nothing cached for its objects
 * applies) with the effect sprites cleared and the deck's geometry files read again (`putGeomFile` builds a
 * new geometry, so its paths, Path2D and union tracing are built inside the times, as on an output that has
 * just read the files); its pictures are prepared first, outside the times, as an output's lanes prepare
 * them before the draw. `native.ts` asks for it once every slide's own draws are
 * done, so clearing the sprites changes none of the other timings.
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
  /** Median draw time in ms (draw and flush) at 1920 and 3840 px wide: pictures prepared (warm). */
  ms1920: number;
  ms3840: number;
  /**
   * The cold time at each width, in ms: preparing the pictures the deck's cache lacks (decode and resample,
   * what the output's asset worker pays inside the slide job on a cache miss) plus the first draw and flush.
   */
  cold1920: number;
  cold3840: number;
  /** Media ids the slide uses that could not be decoded. */
  missing: string[];
};

export type ObjectsJob = Omit<RenderJob, 'repeats'>;

export type ObjectsResult = {
  /** The largest single object's draw and flush, cold, at 1920 and 3840 px wide, in ms. */
  ms1920: number;
  ms3840: number;
  /** The id of that object at each width (none for a slide without objects). */
  id1920?: string;
  id3840?: string;
};

export type NativePage = {
  /** Register the deck's faces with the page's resolver (`FontResolver.sync`). */
  fonts(list: PageFont[]): Promise<{ loaded: number; failed: string[]; generation: number }>;
  /** The CSS font the installed font environment gives each request (what text is drawn with). */
  font(reqs: FaceRequest[]): string[];
  media(list: PageMedia[]): void;
  /**
   * The deck's shape files (`ShapeGeom.ref`, M9 `DecorData.ref`): read before any slide is drawn, as an output
   * reads them.
   */
  geoms(list: { id: string; file: unknown }[]): void;
  render(job: RenderJob): Promise<RenderResult>;
  /** Each object's cold draw on its own, at 1920 and 3840 px: the largest (`maxObjectMs`). */
  objects(job: ObjectsJob): Promise<ObjectsResult>;
};

/** Decoded pixels kept between slides of a deck (about 512 MB of RGBA). */
const CACHE_PIXELS = 128_000_000;
/** A source is scaled down when it is more than this much larger than its largest use (as the hub does). */
const OVERSIZE = 1.25;
/** The slide's background picture: the whole frame, cover-fitted (`thumb.worker.ts`). */
const BACKGROUND = { box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }, fit: 'cover' } as const;

type Decoded = { bmp: ImageBitmap | undefined; px: number };

const known = new Map<string, PageMedia>();
/**
 * The deck's shape files as `geoms` was given them (geometry files, and decoration files: `{ parts }`, under
 * a converter placeholder or the hub's SHA-256 name): read again before each slide's object pass.
 */
let geomList: { id: string; file: unknown }[] = [];

/** Forget every shape file and read the deck's again: what was built from them is built anew. */
function rereadGeoms(): void {
  clearGeomFiles();
  clearDecorFiles();
  for (const g of geomList)
    if (g.file && typeof g.file === 'object' && 'parts' in g.file) putDecorFile(g.id, g.file);
    else putGeomFile(g.id, g.file);
}
/** Sources by media id and prepared pictures by `pictureKey(id, target)`, least recently used first. */
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

/** The cached entry, now the most recently used, so eviction takes the oldest first. */
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

/**
 * The file decoded at its own size (colour profile kept, as `createImageBitmap` keeps it in the output), a
 * JPEG's EXIF orientation removed first (`exif.ts`).
 */
async function decode(m: PageMedia): Promise<ImageBitmap | undefined> {
  try {
    const res = await fetch(m.url);
    if (!res.ok) return undefined;
    // As stored: an EXIF orientation is not applied, as PowerPoint and the hub's preparation lay it out.
    const bytes = withoutExifOrientation(new Uint8Array(await res.arrayBuffer()));
    return await createImageBitmap(new Blob([bytes as BlobPart]));
  } catch {
    return undefined;
  }
}

/** `full` scaled down to what the deck shows of it, or `full` itself; `full` is closed when replaced. */
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

/** The pictures a slide's draws ask for at these widths: the background's, then `slidePictures`. */
function usesOf(slide: Slide, widths: readonly number[]): SlidePicture[] {
  const out: SlidePicture[] = [];
  for (const width of widths) {
    const scale = width / 1920;
    if (slide.backgroundMediaId)
      out.push({ mediaId: slide.backgroundMediaId, target: pictureTarget(BACKGROUND, scale) });
    out.push(...slidePictures(slide, { scale }));
  }
  return out;
}

/**
 * Decode and prepare what a slide draws (outside the timed draws), and the lookup the draws use. Each
 * file is decoded once for all of the slide's targets it lacks; ids that fail are listed in `missing`.
 */
async function picturesOf(slide: Slide, missing: string[], widths: readonly number[]): Promise<ImageLookup> {
  const wants = new Map<string, { targets: Map<string, PictureTarget>; source: boolean }>();
  for (const u of usesOf(slide, widths)) {
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
    // A failed decode is cached too (an entry without a bitmap), so it is not tried again on every slide.
    const todo = [...w.targets.values()].filter((t) => !touch(pictureKey(id, t)));
    let needSource = w.source && !touch(id);
    if (todo.length || needSource) {
      const m = known.get(id);
      const full = m ? await decode(m) : undefined;
      for (const t of todo) {
        const ready = full && preparePicture(full, t);
        if (ready || !full) put(pictureKey(id, t), ready);
        // Not prepared (no canvas): drawn from the source, as before.
        else if (!cache.has(id)) needSource = true;
      }
      if (needSource) put(id, full && m ? await source(full, m) : undefined);
      else full?.close();
      evict(keep);
    }
    const keys = [...w.targets.values()].map((t) => pictureKey(id, t));
    if (w.source) keys.push(id);
    if (keys.some((k) => cache.has(k) && !cache.get(k)!.bmp) && !missing.includes(id)) missing.push(id);
  }
  return (id, t) => (t && cache.get(pictureKey(id, t))?.bmp) || cache.get(id)?.bmp;
}

/** The thumbnail worker's drawing: black, background cover-fit, then the slide (`thumb.worker.ts`). */
function draw(
  ctx: OffscreenCanvasRenderingContext2D,
  slide: Slide,
  width: number,
  images: ImageLookup,
): void {
  const scale = width / 1920;
  fillColor(ctx, { r: 0, g: 0, b: 0, a: 1 }, width, Math.round(1080 * scale));
  if (slide.backgroundMediaId) {
    const target = pictureTarget(BACKGROUND, scale);
    const bg = images(slide.backgroundMediaId, target);
    if (bg) drawImageFit(ctx, bg, BACKGROUND.box, scale, 'cover', 1, 0, undefined, target);
  }
  drawSlide2D(ctx, slide, { scale, images });
}

/** Draw, then read one pixel back: Chromium records canvas commands and only rasterizes on a read. */
function timed(
  ctx: OffscreenCanvasRenderingContext2D,
  slide: Slide,
  width: number,
  images: ImageLookup,
  repeats: number,
): number {
  const times: number[] = [];
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    draw(ctx, slide, width, images);
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
/** The canvases `objects` draws on, apart from the timed ones. */
const objectCanvases = new Map<number, OffscreenCanvasRenderingContext2D>();

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

function context(width: number, from = canvases): OffscreenCanvasRenderingContext2D {
  let ctx = from.get(width);
  if (!ctx) {
    const c = new OffscreenCanvas(width, Math.round((width * 1080) / 1920));
    const got = c.getContext('2d');
    if (!got) throw new Error('2D context unavailable');
    ctx = got;
    from.set(width, ctx);
  }
  return ctx;
}

/**
 * The largest single object's time at `width`: the background as `draw` lays it, then the slide's objects as
 * `drawSlide2D` draws them (authored, within the slide's drawing budget), each timed with its flush, cold:
 * the effect sprites cleared and the geometry files read again first. A slide drawn as one page picture
 * (`slideContent`) is timed whole.
 */
function largestObject(slide: Slide, width: number, images: ImageLookup): { ms: number; id?: string } {
  clearEffectCache();
  rereadGeoms();
  const copy = structuredClone(slide);
  const ctx = context(width, objectCanvases);
  const scale = width / 1920;
  const flush = () => void ctx.getImageData(0, 0, 1, 1);
  const now = () => performance.now();
  fillColor(ctx, { r: 0, g: 0, b: 0, a: 1 }, width, Math.round(1080 * scale));
  if (copy.backgroundMediaId) {
    const target = pictureTarget(BACKGROUND, scale);
    const bg = images(copy.backgroundMediaId, target);
    if (bg) drawImageFit(ctx, bg, BACKGROUND.box, scale, 'cover', 1, 0, undefined, target);
  }
  flush();
  const drawn = drawableContent(clampSlide(copy));
  if (drawn.pictureMediaId) {
    const t = timeEach([copy], (s) => drawSlide2D(ctx, s, { scale, images }), flush, now);
    return { ms: t.max };
  }
  const objects = withinDrawBudget(drawn.objects);
  const t = timeEach(objects, (o) => drawObject(ctx, o, scale, images), flush, now);
  return { ms: t.max, ...(t.at >= 0 ? { id: objects[t.at]!.id } : {}) };
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
  geoms(list) {
    geomList = list;
    rereadGeoms();
  },
  async render(job) {
    const missing: string[] = [];
    // Cold at 1920: the pictures the cache lacks, then the first draw and flush.
    const t0 = performance.now();
    const images = await picturesOf(job.slide, missing, [1920]);
    const ctx = context(1920);
    draw(ctx, job.slide, 1920, images);
    ctx.getImageData(0, 0, 1, 1);
    const cold1920 = performance.now() - t0;
    const x = Math.max(0, Math.min(1919, Math.round(job.rect.x)));
    const y = Math.max(0, Math.min(1079, Math.round(job.rect.y)));
    const w = Math.max(1, Math.min(1920 - x, Math.round(job.rect.w)));
    const h = Math.max(1, Math.min(1080 - y, Math.round(job.rect.h)));
    const crop = new OffscreenCanvas(w, h);
    crop.getContext('2d')!.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
    const png = await blobToBase64(await crop.convertToBlob({ type: 'image/png' }));
    const ms1920 = job.repeats ? timed(ctx, job.slide, 1920, images, job.repeats) : 0;
    let ms3840 = 0;
    let cold3840 = 0;
    if (job.repeats) {
      const t1 = performance.now();
      const big = await picturesOf(job.slide, missing, [3840]);
      const ctx4 = context(3840);
      draw(ctx4, job.slide, 3840, big);
      ctx4.getImageData(0, 0, 1, 1);
      cold3840 = performance.now() - t1;
      ms3840 = timed(ctx4, job.slide, 3840, big, job.repeats);
    }
    return { png, width: w, height: h, ms1920, ms3840, cold1920, cold3840, missing };
  },
  async objects(job) {
    const missing: string[] = [];
    const small = largestObject(job.slide, 1920, await picturesOf(job.slide, missing, [1920]));
    const big = largestObject(job.slide, 3840, await picturesOf(job.slide, missing, [3840]));
    return {
      ms1920: small.ms,
      ms3840: big.ms,
      ...(small.id !== undefined ? { id1920: small.id } : {}),
      ...(big.id !== undefined ? { id3840: big.id } : {}),
    };
  },
};

(window as unknown as { __native: NativePage }).__native = page;
