import { OpfsStore } from '@ordo/cache';
import { isControl, startHeartbeat } from '@ordo/client';
import {
  type AssetJob,
  type AssetToRender,
  BitmapCache,
  DEFAULT_BITMAP_BUDGET,
  FALLBACK_FAMILIES,
  type FontLoad,
  FontResolver,
  type FromAsset,
  type ImageLookup,
  type JobRole,
  SRC_BITMAP,
  SRC_SCENE,
  type SlidePicture,
  type ToAsset,
  type WarmJob,
  installFontEnv,
  jobFontFamilies,
  rasterImage,
  rasterLowerThird,
  rasterProps,
  rasterScene,
  rasterSlide,
  slidePictures,
} from '@ordo/renderer';
import { LOGICAL_WIDTH } from '@ordo/domain';
import { DecodeError, createDecoder } from './decode.ts';
import { Cancelled, Lanes, RANK, type Steps } from './lanes.ts';
import { PICTURE_LIMITS, preloadPictures, sourcePicture } from './pictures.ts';

/**
 * Asset worker: OPFS reads, image decoding, font loading and text rasterization at output resolution.
 * Each job produces one full-frame ImageBitmap that goes straight to the render worker (a slide whose video
 * plays in its box: a scene, a base and an optional over bitmap with the video's plane). Jobs arrive from
 * the link worker on a port and results go back on it (design/25); the main thread only sends `init` and
 * the channel ends (`ports`). Supervised: heartbeat every 250 ms.
 *
 * Jobs run in raster lanes (lanes.ts, design/27 §7.5): props first, then the live cue's layers, then the
 * armed cue's, and bulk work (the pictures of the cue after the armed one) last. Each layer is a chain of
 * its own; synchronous work runs in short turns (a picture is prepared in bands), so a slide that decodes
 * never holds a props flip up by more than one turn. A job the link cancels stops at its next turn.
 */

const scope = self as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((ev: MessageEvent<ToAsset>) => void) | null;
  fonts?: FontFaceSet;
};

startHeartbeat(scope);

/** Bitmaps go to the render worker here. */
let port: MessagePort | null = null;
/** Jobs arrive and results go back here. */
let linkPort: MessagePort | null = null;
let width = 1920;
let height = 1080;
let token = '';
let apiPrefix = '/api/v1';
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
/** The surface was just taken (`take`): it is transparent, and needs no clear before the next draw. */
let fresh = false;
const store = new OpfsStore();

// Decoded images by hash and target size (`pictureKey`): LRU bounded by bytes (256 MiB) rather than count,
// so a photo-heavy service cannot pin a gigabyte of bitmaps (review item 26). A picture a slide draws
// unrotated is kept at its displayed device size (design/27 §7.1); any other is reduced to the output size.
// What a cue's draw holds is pinned from its preload until the draw is done (pictures.ts).
const images = new BitmapCache<ImageBitmap>(DEFAULT_BITMAP_BUDGET, 64);

// Fonts (design/27 §10): every face under a fresh internal family name, so a face that loads late (a retry,
// a font added during the service) is used by the next draw without restarting this worker. Text of every
// kind resolves families through it.
const fonts = new FontResolver({
  set: scope.fonts,
  data: async (f) => (await readFile(f.hash)).blob.arrayBuffer(),
});
installFontEnv(fonts);
// A retry that loaded a face: tell the link, which draws again the slides that fell back for it.
fonts.onChange((c) => {
  if (!c.late) return;
  const { loaded, failed } = fonts.stats();
  post({ t: 'fonts', loaded, failed, ready: c.families });
});

const lanes = new Lanes();
/**
 * The font loads sent so far, in order: a job waits for those sent before it (text never draws in a fallback
 * for a face that was on its way), a job sent earlier does not.
 */
let fonts$: Promise<unknown> = Promise.resolve();

function post(m: FromAsset): void {
  try {
    linkPort?.postMessage(m);
  } catch {
    /* link gone: it re-arms when it is back */
  }
}

/**
 * A file that could not be read: not cached yet and the hub did not serve it (outage, slow NAS). The link
 * retries it with backoff and never quarantines the cue for it (review 2026-11-04 item 3).
 */
class UnavailableError extends Error {}
/** The hub does not have the file (HTTP 404/410): retried slowly by the link, never a flood of errors. */
class MissingError extends UnavailableError {}

async function readFile(hash: string): Promise<{ blob: Blob; source: 'opfs' | 'network' }> {
  const b = await store.get(hash).catch(() => undefined);
  if (b && b.size > 0) return { blob: b, source: 'opfs' };
  // Not cached yet (fill still running): read through the hub.
  try {
    const res = await fetch(
      `${apiPrefix}/files/${hash}${token ? `?token=${encodeURIComponent(token)}` : ''}`,
    );
    if (res.status === 404 || res.status === 410)
      throw new MissingError(`file ${hash.slice(0, 8)} missing on the hub (HTTP ${res.status})`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { blob: await res.blob(), source: 'network' };
  } catch (err) {
    if (err instanceof MissingError) throw err;
    throw new UnavailableError(`file ${hash.slice(0, 8)} unavailable (${(err as Error).message})`);
  }
}

/**
 * The worker's picture decoder (decode.ts): a file read from OPFS or the hub and decoded at its own size
 * (colour profile kept), or a large JPEG only at the part and scale its uses show (crop-aware decode); a
 * target resampled once into an sRGB bitmap of its device size, upscaling included, which the slide copies
 * 1:1 (design/27 §7.1: resampling and colour conversion on every draw cost 4-50 ms per full-slide picture);
 * a source reduced with high quality.
 */
const decoder = createDecoder({
  read: readFile,
  createImageBitmap: (...a: unknown[]) =>
    (createImageBitmap as (...b: unknown[]) => Promise<ImageBitmap>)(...a),
  ImageDecoder: typeof ImageDecoder === 'undefined' ? undefined : ImageDecoder,
});

async function loadFonts(list: FontLoad[]): Promise<void> {
  const r = await fonts.sync(list);
  post({ t: 'fonts', loaded: r.loaded, failed: r.failed, ready: r.ready.length ? r.ready : undefined });
}

function surface(w: number, h: number): OffscreenCanvasRenderingContext2D {
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    // A software-backed surface: bitmaps from an accelerated canvas live in this worker's GPU context
    // and turn black on screen the moment this worker dies (found by the chaos e2e). CPU-backed bitmaps
    // belong to whoever holds them, so the render worker keeps its picture through an asset restart.
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    fresh = true;
  }
  if (!ctx) throw new Error('2D context unavailable in the asset worker');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // A surface whose picture was just taken is transparent already; clearing it again cost 0.2 ms at 1080p
  // and 1.1 ms at 4K (Chromium 153, software). Drawing the first opaque layer with 'copy' instead of over
  // the clear surface saved nothing there (it cost 0.4-1.5 ms more), so it is not done.
  if (!fresh) ctx.clearRect(0, 0, w, h);
  fresh = false;
  return ctx;
}

/**
 * Decode and prepare the images one cue draws (pictures.ts): one decode per file, within the cue's bitmap
 * budget (design/25 clamps), every bitmap the draw holds pinned until `release`. `uses` are the pictures
 * the draw asks for (`slidePictures`); without them every image is decoded as its source.
 */
async function preload(
  map: Record<string, string>,
  uses: readonly SlidePicture[] | undefined,
  out: { w: number; h: number },
  steps: Steps,
): Promise<{ lookup: ImageLookup; skipped: number; missing: string[]; release: () => void }> {
  const pre = await preloadPictures(images, decoder, map, uses, out, PICTURE_LIMITS, steps);
  // Drawn without the image. One whose file is not there yet is reported so the link re-draws the slide
  // once the file arrives; a corrupt one is not (it would be missing again every time).
  const missing: string[] = [];
  for (const f of pre.failed)
    if (f.error instanceof UnavailableError && !missing.includes(f.hash)) missing.push(f.hash);
  return { lookup: pre.lookup, skipped: pre.skipped, missing, release: pre.release };
}

/** Missing families a 'done' message reports: as many as the link keeps (FromAsset, protocol health). */
const MAX_FONT_FALLBACKS = 20;

function fontFallbacks(job: AssetJob): string[] | undefined {
  const missing = jobFontFamilies(job, { fallbacks: false }).filter(
    (f) => !fonts.isLoaded(f) && !FALLBACK_FAMILIES.has(f),
  );
  return missing.length ? missing.slice(0, MAX_FONT_FALLBACKS) : undefined;
}

/** What an SRC_SCENE answer carries besides its base bitmap (design/27 §7.2). */
type SceneParts = { over: ImageBitmap | null; plane: Float32Array; videoSlot: number; videoGen: number };

/** The surface's picture; the surface is left transparent for the next draw. */
function take(): ImageBitmap {
  const b = canvas!.transferToImageBitmap();
  fresh = true;
  return b;
}

/**
 * A slide job with `video` (design/27 §7.2, SCENE.md item E): the base (objects up to the playing one,
 * with its poster, and the upper ones that stay clear of the video) and the over (upper objects that
 * overlap it), split by `splitScene` with measured text bounds, and the plane from the object's box, crop,
 * flips, rotation, mask and opacity at this output's scale with the clip's size. Base and over draw the
 * pictures `preload` prepared for the whole slide (`slidePictures`), asked for with the same targets as the
 * slide drawn as one bitmap, and pinned until both are drawn; the poster's size, for a clip of unknown size,
 * comes from the source its prepared bitmap was made from (`sourceSize`). Undefined when the slide is not
 * a scene (a lyric-only or hidden look, the object is gone): it is then one bitmap with the poster, as
 * before.
 */
function sceneParts(
  job: Extract<AssetJob, { kind: 'slide' }>,
  c: OffscreenCanvasRenderingContext2D,
  scale: number,
  lookup: ImageLookup,
): (SceneParts & { base: ImageBitmap }) | undefined {
  const v = job.video;
  if (!v) return undefined;
  const opts = { nextSlide: job.nextSlide, isSong: job.isSong, clip: { w: v.w, h: v.h } };
  const s = rasterScene(c, take, job.slide, job.look, scale, lookup, v.objectId, opts);
  return s && { base: s.base, over: s.over, plane: s.plane, videoSlot: v.slot, videoGen: v.gen };
}

/**
 * Draw a job in its lane (`steps`): pictures are read and decoded off this thread and prepared in turns,
 * then the layer is drawn, taken and sent in one turn. Every size is the one the job started with, so a
 * resize arriving meanwhile cannot mix two. A cancelled job (`Cancelled`) sends nothing.
 */
async function run(job: AssetJob, steps: Steps): Promise<void> {
  const t0 = performance.now();
  const w = width;
  const h = height;
  const out = { w, h };
  const scale = w / LOGICAL_WIDTH;
  let skipped = 0;
  let missing: string[] = [];
  let release: (() => void) | undefined;
  try {
    let draw: (c: OffscreenCanvasRenderingContext2D) => (SceneParts & { base: ImageBitmap }) | undefined;
    if (job.kind === 'slide') {
      const pre = await preload(job.images, slidePictures(job.slide, { scale, look: job.look }), out, steps);
      release = pre.release;
      skipped = pre.skipped;
      missing = pre.missing;
      draw = (c) => {
        const scene = sceneParts(job, c, scale, pre.lookup);
        if (!scene)
          rasterSlide(c, job.slide, job.look, scale, pre.lookup, {
            nextSlide: job.nextSlide,
            isSong: job.isSong,
          });
        return scene;
      };
    } else if (job.kind === 'image') {
      const img = await sourcePicture(images, decoder, job.hash, out, steps);
      release = img.release;
      draw = (c) => {
        rasterImage(c, img.bitmap, job.fit, scale);
        return undefined;
      };
    } else if (job.kind === 'lowerThird') {
      draw = (c) => {
        rasterLowerThird(c, job.text, job.look, scale);
        return undefined;
      };
    } else {
      const pre = await preload(job.images, undefined, out, steps);
      release = pre.release;
      draw = (c) => {
        rasterProps(c, job.model, scale, pre.lookup, job.look.clearColor);
        return undefined;
      };
    }
    // Drawn, taken and sent in one turn: nothing can cancel it half-way.
    await steps.slice(() => {
      const scene = draw(surface(w, h));
      release?.();
      release = undefined;
      deliver(job, scene, t0, steps, skipped, missing);
    });
  } catch (err) {
    if (err instanceof Cancelled) return;
    const d = err instanceof DecodeError ? err : undefined;
    post({
      t: 'error',
      layer: job.layer,
      key: job.key,
      error: (err as Error).message || String(err),
      hash: d?.hash,
      source: d?.source,
      cause:
        err instanceof MissingError ? 'missing' : err instanceof UnavailableError ? 'unavailable' : 'invalid',
    });
  } finally {
    release?.();
  }
}

/** Send a drawn job to the render worker and say so to the link, with its lane timing. */
function deliver(
  job: AssetJob,
  scene: (SceneParts & { base: ImageBitmap }) | undefined,
  t0: number,
  steps: Steps,
  skipped: number,
  missing: string[],
): void {
  const bitmap = scene ? scene.base : take();
  const cueIndex = job.kind === 'slide' ? job.cueIndex : job.kind === 'image' ? job.cueIndex : undefined;
  const msg: AssetToRender = {
    t: 'content',
    layer: job.layer,
    key: job.key,
    kind: scene ? SRC_SCENE : SRC_BITMAP,
    bitmap,
    cueIndex,
    refresh: job.kind === 'slide' ? job.refresh : undefined,
  };
  if (scene) {
    msg.over = scene.over;
    msg.plane = scene.plane;
    msg.videoSlot = scene.videoSlot;
    msg.videoGen = scene.videoGen;
  }
  if (!port) {
    bitmap.close();
    scene?.over?.close();
    throw new UnavailableError('render port not connected');
  }
  port.postMessage(msg, scene?.over ? [bitmap, scene.over] : [bitmap]);
  const t = steps.timing();
  post({
    t: 'done',
    layer: job.layer,
    key: job.key,
    ms: performance.now() - t0,
    fontFallbacks: fontFallbacks(job),
    skippedImages: skipped || undefined,
    missingImages: missing.length ? missing : undefined,
    lane: t.lane,
    waitMs: round(t.waitMs),
    rasterMs: round(t.rasterMs),
    longestMs: round(t.longestMs),
  });
}

const round = (ms: number) => Math.round(ms * 100) / 100;

/**
 * Bulk work (design/27 §7.5): prepare the pictures of the cue after the armed one into the cache, as its
 * slide job will ask for them, so that arming it after the next GO only draws. Failures are left to that
 * job, which reports them.
 */
async function warmUp(wj: WarmJob, steps: Steps): Promise<void> {
  const t0 = performance.now();
  const out = { w: width, h: height };
  const scale = out.w / LOGICAL_WIDTH;
  let decodes = 0;
  if (wj.slide) {
    const pre = await preloadPictures(
      images,
      decoder,
      wj.images,
      slidePictures(wj.slide, { scale, look: wj.look }),
      out,
      PICTURE_LIMITS,
      steps,
    );
    decodes += pre.decodes;
    pre.release();
  }
  for (const hash of wj.sources ?? []) {
    steps.check();
    const cached = images.has(hash);
    try {
      (await sourcePicture(images, decoder, hash, out, steps)).release();
      if (!cached) decodes++;
    } catch (err) {
      if (err instanceof Cancelled) throw err;
    }
  }
  const t = steps.timing();
  post({
    t: 'warmed',
    key: wj.key,
    ms: round(performance.now() - t0),
    waitMs: round(t.waitMs),
    rasterMs: round(t.rasterMs),
    longestMs: round(t.longestMs),
    decodes,
  });
}

/** A job's rank in the lanes: props first, then the live cue's layers, then the armed cue's. */
function rankOf(job: AssetJob, role: JobRole | undefined): number {
  if (job.kind === 'props') return RANK.props;
  return role === 'live' ? RANK.live : RANK.armed;
}

function onJobMessage(m: ToAsset): void {
  switch (m.t) {
    case 'fonts': {
      const list = m.fonts;
      fonts$ = fonts$.then(
        () => loadFonts(list),
        () => loadFonts(list),
      );
      fonts$.catch((err) => console.error('[ordo asset] fonts', err));
      return;
    }
    case 'job': {
      const job = m.job;
      // Each layer is a chain: its content reaches the renderer in the order its stacks expect.
      lanes.push({
        key: job.key,
        chain: `layer ${job.layer}`,
        rank: rankOf(job, m.role),
        gate: fonts$,
        run: (steps) => run(job, steps),
      });
      return;
    }
    case 'warm': {
      const wj = m.warm;
      lanes.push({ key: wj.key, chain: 'warm', rank: RANK.bulk, gate: fonts$, run: (s) => warmUp(wj, s) });
      return;
    }
    case 'cancel':
      lanes.cancel(m.keys);
      return;
    case 'prune':
      images.prune(new Set(m.keep));
      return;
    default:
      return;
  }
}

scope.onmessage = (ev) => {
  const m = ev.data;
  if (isControl(m)) return;
  switch (m.t) {
    case 'init':
      if (m.port) port = m.port;
      width = m.width;
      height = m.height;
      token = m.token;
      apiPrefix = m.apiPrefix;
      return;
    case 'ports':
      try {
        port?.close();
        linkPort?.close();
      } catch {
        /* closed */
      }
      port = m.render;
      linkPort = m.link;
      linkPort.onmessage = (e: MessageEvent<ToAsset>) => onJobMessage(e.data);
      return;
    case 'resize':
      width = m.width;
      height = m.height;
      return;
    default:
      onJobMessage(m);
  }
};
