import { OpfsStore } from '@ordo/cache';
import { isControl, startHeartbeat } from '@ordo/client';
import {
  type AssetJob,
  type AssetToRender,
  BitmapCache,
  DEFAULT_BITMAP_BUDGET,
  type DrawnSprite,
  FALLBACK_FAMILIES,
  type FontLoad,
  FontResolver,
  type FromAsset,
  type ImageLookup,
  SRC_BITMAP,
  SRC_SCENE,
  type SlidePicture,
  type Reach,
  type ToAsset,
  coversFrame,
  drawSprite,
  imageReach,
  installFontEnv,
  jobFontFamilies,
  lowerThirdReach,
  opaqueColor,
  preparePicture,
  propsReach,
  rasterImage,
  rasterLowerThird,
  rasterProps,
  rasterSceneSprites,
  rasterSlide,
  slidePictures,
  slideReach,
  spriteRect,
} from '@ordo/renderer';
import { LOGICAL_WIDTH } from '@ordo/domain';
import { OpaqueFiles } from './opaque.ts';
import { type PictureDecoder, preloadPictures, sourcePicture } from './pictures.ts';

/**
 * Asset worker: OPFS reads, image decoding, font loading and text rasterization at output resolution.
 * Each job produces one ImageBitmap that goes straight to the render worker (a slide whose video plays in
 * its box: a scene, a base and an optional over bitmap with the video's plane): a tight sprite of what it
 * draws at its offset in the frame, or full-frame where that saves nothing (design/27 §7.3, `drawSprite`).
 * A full-frame bitmap known to be opaque (a cover-fitted JPEG, the props logo) says so. Jobs arrive from
 * the link worker on a port and results go back on it (design/25); the main thread only sends `init` and
 * the channel ends (`ports`). Supervised: heartbeat every 250 ms.
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
const store = new OpfsStore();

// Decoded images by hash and target size (`pictureKey`): LRU bounded by bytes (256 MiB) rather than count,
// so a photo-heavy service cannot pin a gigabyte of bitmaps (review item 26). A picture a slide draws
// unrotated is kept at its displayed device size (design/27 §7.1); any other is reduced to the output size.
// What a cue's draw holds is pinned from its preload until the draw is done (pictures.ts).
const images = new BitmapCache<ImageBitmap>(DEFAULT_BITMAP_BUDGET, 64);
/** Which decoded files have no transparency (opaque.ts): read from their headers when they are decoded. */
const opaqueFiles = new OpaqueFiles();

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

let chain: Promise<void> = Promise.resolve();
function enqueue(fn: () => Promise<void>): void {
  chain = chain.then(fn, fn).catch((err) => console.error('[ordo asset]', err));
}

function post(m: FromAsset): void {
  try {
    linkPort?.postMessage(m);
  } catch {
    /* link gone: it re-arms when it is back */
  }
}

/** A decode failure, with the file and where it was read from (an OPFS copy may be corrupt). */
class DecodeError extends Error {
  constructor(
    message: string,
    readonly hash: string,
    readonly source: 'opfs' | 'network',
  ) {
    super(message);
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
 * The worker's picture decoder (pictures.ts): a file read from OPFS or the hub and decoded at its own size
 * (colour profile kept); a target resampled once into an sRGB bitmap of its device size, upscaling
 * included, which the slide copies 1:1 (design/27 §7.1: resampling and colour conversion on every draw
 * cost 4-50 ms per full-slide picture); a source reduced with high quality.
 */
const decoder: PictureDecoder<ImageBitmap> = {
  async decode(hash) {
    const { blob, source } = await readFile(hash);
    await opaqueFiles.note(hash, blob);
    try {
      return await createImageBitmap(blob);
    } catch (err) {
      throw new DecodeError(
        `image ${hash.slice(0, 8)} could not be decoded: ${(err as Error).message}`,
        hash,
        source,
      );
    }
  },
  prepare: (src, t) => preparePicture(src, t),
  reduce: (src, w, h) => createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }),
};

async function loadFonts(list: FontLoad[]): Promise<void> {
  const r = await fonts.sync(list);
  post({ t: 'fonts', loaded: r.loaded, failed: r.failed, ready: r.ready.length ? r.ready : undefined });
}

/**
 * The surface's context, to measure text with before the surface is sized: the layouts it memoises are
 * reused by the draw, which runs on the same context. The surface is 1x1 meanwhile: after a transfer, the
 * first use of a context allocates and clears a new backing of the canvas's size (9 ms at 4K, measured by
 * bench/sprites.ts), which a sprite must not pay for the whole frame.
 */
function measuring(): OffscreenCanvasRenderingContext2D {
  if (!canvas) {
    // A software-backed surface: bitmaps from an accelerated canvas live in this worker's GPU context
    // and turn black on screen the moment this worker dies (found by the chaos e2e). CPU-backed bitmaps
    // belong to whoever holds them, so the render worker keeps its picture through an asset restart.
    canvas = new OffscreenCanvas(1, 1);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) throw new Error('2D context unavailable in the asset worker');
  return ctx;
}

/** `measuring()` with the surface shrunk to 1x1 first (between draws). */
function measure(): OffscreenCanvasRenderingContext2D {
  const c = measuring();
  if (canvas!.width !== 1) canvas!.width = 1;
  if (canvas!.height !== 1) canvas!.height = 1;
  return c;
}

/** The surface at `w` x `h` (the frame, or a tight sprite's rect), cleared and untransformed. */
function surface(w = width, h = height): OffscreenCanvasRenderingContext2D {
  const c = measuring();
  if (canvas!.width !== w) canvas!.width = w;
  if (canvas!.height !== h) canvas!.height = h;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  return c;
}

/** Sprites drawn again full-frame because their reach was short (logged, not expected; sprite.ts). */
let spriteMisses = 0;

/** Draw one layer as a tight sprite of `reach` (logical px; null: full-frame) at this output's size. */
function sprite(
  reach: Reach,
  scale: number,
  draw: (c: OffscreenCanvasRenderingContext2D) => void,
): DrawnSprite<ImageBitmap> {
  const d = drawSprite(surface, take, width, height, spriteRect(reach, scale, width, height), (c) =>
    draw(c as OffscreenCanvasRenderingContext2D),
  );
  noteMiss(d);
  return d;
}

function noteMiss(d: DrawnSprite<ImageBitmap> | null | undefined): void {
  if (d?.missed && spriteMisses++ < 10)
    console.warn('[ordo asset] a sprite reached past its bounds and was drawn full-frame');
}

/**
 * Decode and prepare the images one cue draws (pictures.ts): one decode per file, within the cue's bitmap
 * budget (design/25 clamps), every bitmap the draw holds pinned until `release`. `uses` are the pictures
 * the draw asks for (`slidePictures`); without them every image is decoded as its source.
 */
async function preload(
  map: Record<string, string>,
  uses?: readonly SlidePicture[],
): Promise<{ lookup: ImageLookup; skipped: number; missing: string[]; release: () => void }> {
  const pre = await preloadPictures(images, decoder, map, uses, { w: width, h: height });
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
type SceneParts = {
  over: DrawnSprite<ImageBitmap> | null;
  plane: Float32Array;
  videoSlot: number;
  videoGen: number;
};

/** The surface's picture; the surface is left transparent for the next draw. */
function take(): ImageBitmap {
  return canvas!.transferToImageBitmap();
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
 * before. Base and over are each a tight sprite of what they draw (`rasterSceneSprites`).
 */
function sceneParts(
  job: Extract<AssetJob, { kind: 'slide' }>,
  scale: number,
  lookup: ImageLookup,
): (SceneParts & { base: DrawnSprite<ImageBitmap> }) | undefined {
  const v = job.video;
  if (!v) return undefined;
  const opts = { nextSlide: job.nextSlide, isSong: job.isSong, clip: { w: v.w, h: v.h } };
  const frame = { width, height };
  const s = rasterSceneSprites(
    measure(),
    surface,
    take,
    frame,
    job.slide,
    job.look,
    scale,
    lookup,
    v.objectId,
    opts,
  );
  noteMiss(s?.base);
  noteMiss(s?.over);
  return s && { base: s.base, over: s.over, plane: s.plane, videoSlot: v.slot, videoGen: v.gen };
}

async function run(job: AssetJob): Promise<void> {
  const t0 = performance.now();
  const scale = width / LOGICAL_WIDTH;
  let skipped = 0;
  let missing: string[] = [];
  let scene: (SceneParts & { base: DrawnSprite<ImageBitmap> }) | undefined;
  let drawn: DrawnSprite<ImageBitmap> | undefined;
  let opaque = false;
  try {
    if (job.kind === 'slide') {
      const pre = await preload(job.images, slidePictures(job.slide, { scale, look: job.look }));
      skipped = pre.skipped;
      missing = pre.missing;
      try {
        scene = sceneParts(job, scale, pre.lookup);
        if (!scene) {
          const opts = { nextSlide: job.nextSlide, isSong: job.isSong };
          const reach = slideReach(measure(), job.slide, { scale, look: job.look, ...opts });
          drawn = sprite(reach, scale, (c) => rasterSlide(c, job.slide, job.look, scale, pre.lookup, opts));
        }
      } finally {
        pre.release();
      }
    } else if (job.kind === 'image') {
      const img = await sourcePicture(images, decoder, job.hash, { w: width, h: height });
      drawn = sprite(imageReach(img, job.fit), scale, (c) => rasterImage(c, img, job.fit, scale));
      // A cover or stretch fit of a file without transparency fills the frame opaquely.
      opaque = job.fit !== 'contain' && opaqueFiles.opaque(job.hash) && coversFrame(scale, width, height);
    } else if (job.kind === 'lowerThird') {
      const reach = lowerThirdReach(measure(), job.text, job.look, scale);
      drawn = sprite(reach, scale, (c) => rasterLowerThird(c, job.text, job.look, scale));
    } else {
      const pre = await preload(job.images);
      try {
        const reach = propsReach(measure(), job.model, scale);
        drawn = sprite(reach, scale, (c) =>
          rasterProps(c, job.model, scale, pre.lookup, job.look.clearColor),
        );
        // The logo's backdrop is the clear colour over the whole frame.
        opaque = !!job.model.logo && opaqueColor(job.look.clearColor) && coversFrame(scale, width, height);
      } finally {
        pre.release();
      }
    }
    const main = scene ? scene.base : drawn!;
    const bitmap = main.bitmap;
    const over = scene?.over?.bitmap ?? null;
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
    if (main.tight) {
      msg.x = main.x;
      msg.y = main.y;
    } else if (opaque) msg.opaque = true;
    if (scene) {
      msg.over = over;
      if (scene.over?.tight) {
        msg.overX = scene.over.x;
        msg.overY = scene.over.y;
      }
      msg.plane = scene.plane;
      msg.videoSlot = scene.videoSlot;
      msg.videoGen = scene.videoGen;
    }
    if (!port) {
      bitmap.close();
      over?.close();
      throw new UnavailableError('render port not connected');
    }
    port.postMessage(msg, over ? [bitmap, over] : [bitmap]);
    post({
      t: 'done',
      layer: job.layer,
      key: job.key,
      ms: performance.now() - t0,
      fontFallbacks: fontFallbacks(job),
      skippedImages: skipped || undefined,
      missingImages: missing.length ? missing : undefined,
    });
  } catch (err) {
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
  }
}

function onJobMessage(m: ToAsset): void {
  switch (m.t) {
    case 'fonts':
      enqueue(() => loadFonts(m.fonts));
      return;
    case 'job':
      // Props jobs (once per second) are cheap; everything runs in order so fonts precede text.
      enqueue(() => run(m.job));
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
