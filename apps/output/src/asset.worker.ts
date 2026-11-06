import { OpfsStore } from '@ordo/cache';
import { isControl, startHeartbeat } from '@ordo/client';
import {
  type AssetJob,
  type AssetToRender,
  BitmapCache,
  CLAMP,
  DEFAULT_BITMAP_BUDGET,
  FALLBACK_FAMILIES,
  type FontLoad,
  FontResolver,
  type FromAsset,
  type PictureTarget,
  SRC_BITMAP,
  type SlidePicture,
  type ToAsset,
  bitmapBytes,
  downscaleFor,
  installFontEnv,
  jobFontFamilies,
  pictureKey,
  preparePicture,
  rasterImage,
  rasterLowerThird,
  rasterProps,
  rasterSlide,
  slidePictures,
} from '@ordo/renderer';
import { LOGICAL_WIDTH } from '@ordo/domain';

/**
 * Asset worker: OPFS reads, image decoding, font loading and text rasterization at output resolution.
 * Each job produces one full-frame ImageBitmap that goes straight to the render worker. Jobs arrive from
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
 * A decoded picture. With a target (`pictureTarget`), the part of it the box shows resampled once into an
 * sRGB bitmap of the target's device size, upscaling included, which the slide copies 1:1 (design/27 §7.1:
 * resampling and colour conversion on every draw cost 4-50 ms per full-slide picture). Without one, the
 * source, reduced so that it still covers the output without upscaling.
 */
async function image(hash: string, target?: PictureTarget): Promise<ImageBitmap> {
  const key = pictureKey(hash, target);
  const hit = images.get(key);
  if (hit) return hit;
  const { blob, source } = await readFile(hash);
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch (err) {
    throw new DecodeError(
      `image ${hash.slice(0, 8)} could not be decoded: ${(err as Error).message}`,
      hash,
      source,
    );
  }
  if (target) {
    const ready = preparePicture(bmp, target);
    if (ready) {
      bmp.close();
      images.set(key, ready);
      return ready;
    }
    // No canvas to prepare it on: the source below, which the slide draws as before.
  }
  // Large images are reduced so that they still cover the output without upscaling (1x, not 2x).
  const down = downscaleFor(bmp.width, bmp.height, width, height);
  if (down) {
    const scaled = await createImageBitmap(bmp, {
      resizeWidth: down.width,
      resizeHeight: down.height,
      resizeQuality: 'high',
    });
    bmp.close();
    bmp = scaled;
  }
  images.set(key, bmp);
  return bmp;
}

async function loadFonts(list: FontLoad[]): Promise<void> {
  const r = await fonts.sync(list);
  post({ t: 'fonts', loaded: r.loaded, failed: r.failed, ready: r.ready.length ? r.ready : undefined });
}

function surface(): OffscreenCanvasRenderingContext2D {
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    // A software-backed surface: bitmaps from an accelerated canvas live in this worker's GPU context
    // and turn black on screen the moment this worker dies (found by the chaos e2e). CPU-backed bitmaps
    // belong to whoever holds them, so the render worker keeps its picture through an asset restart.
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) throw new Error('2D context unavailable in the asset worker');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

/**
 * Decode the images one cue draws, within the cue's bitmap budget (design/25 clamps): at most
 * `maxImagesPerSlide` images and `maxCueBitmapBytes` of decoded pixels; the rest are skipped. `uses` are the
 * pictures the draw asks for (`slidePictures`): each is prepared at its target, and the source is decoded
 * for a use without one. An image no use names (a next slide's, a logo) is decoded as the source.
 */
async function preload(
  map: Record<string, string>,
  uses?: readonly SlidePicture[],
): Promise<{
  lookup: (id: string, target?: PictureTarget) => ImageBitmap | undefined;
  skipped: number;
  missing: string[];
}> {
  // What the draw asks for, by media id: a target per prepared size, undefined for the source.
  const wanted = new Map<string, Map<string, PictureTarget | undefined>>();
  for (const u of uses ?? []) {
    let w = wanted.get(u.mediaId);
    if (!w) wanted.set(u.mediaId, (w = new Map()));
    w.set(u.target?.key ?? '', u.target);
  }
  // Bitmaps by `pictureKey(mediaId, target)`, and the media ids that have one.
  const out = new Map<string, ImageBitmap>();
  const decoded = new Set<string>();
  let bytes = 0;
  let skipped = 0;
  const missing: string[] = [];
  for (const [mediaId, hash] of Object.entries(map)) {
    if (decoded.size >= CLAMP.maxImagesPerSlide) {
      skipped++;
      continue;
    }
    for (const target of wanted.get(mediaId)?.values() ?? [undefined]) {
      try {
        const bmp = await image(hash, target);
        const b = bitmapBytes(bmp);
        if (bytes + b > CLAMP.maxCueBitmapBytes) {
          skipped++;
          continue;
        }
        bytes += b;
        out.set(pictureKey(mediaId, target), bmp);
        decoded.add(mediaId);
      } catch (err) {
        // Drawn without the image. One whose file is not there yet is reported so the link re-draws the
        // slide once the file arrives; a corrupt one is not (it would be missing again every time).
        if (err instanceof UnavailableError && !missing.includes(hash)) missing.push(hash);
        break;
      }
    }
  }
  // A target nothing prepared falls back to a decoded source, which the drawers draw as before.
  return {
    lookup: (id, target) => (target && out.get(pictureKey(id, target))) || out.get(id),
    skipped,
    missing,
  };
}

/** Missing families a 'done' message reports: as many as the link keeps (FromAsset, protocol health). */
const MAX_FONT_FALLBACKS = 20;

function fontFallbacks(job: AssetJob): string[] | undefined {
  const missing = jobFontFamilies(job, { fallbacks: false }).filter(
    (f) => !fonts.isLoaded(f) && !FALLBACK_FAMILIES.has(f),
  );
  return missing.length ? missing.slice(0, MAX_FONT_FALLBACKS) : undefined;
}

async function run(job: AssetJob): Promise<void> {
  const t0 = performance.now();
  const scale = width / LOGICAL_WIDTH;
  let skipped = 0;
  let missing: string[] = [];
  try {
    if (job.kind === 'slide') {
      const pre = await preload(job.images, slidePictures(job.slide, { scale, look: job.look }));
      skipped = pre.skipped;
      missing = pre.missing;
      const c = surface();
      rasterSlide(c, job.slide, job.look, scale, pre.lookup, {
        nextSlide: job.nextSlide,
        isSong: job.isSong,
      });
    } else if (job.kind === 'image') {
      const img = await image(job.hash);
      const c = surface();
      rasterImage(c, img, job.fit, scale);
    } else if (job.kind === 'lowerThird') {
      const c = surface();
      rasterLowerThird(c, job.text, job.look, scale);
    } else {
      const pre = await preload(job.images);
      const c = surface();
      rasterProps(c, job.model, scale, pre.lookup, job.look.clearColor);
    }
    const bitmap = canvas!.transferToImageBitmap();
    const cueIndex = job.kind === 'slide' ? job.cueIndex : job.kind === 'image' ? job.cueIndex : undefined;
    const msg: AssetToRender = {
      t: 'content',
      layer: job.layer,
      key: job.key,
      kind: SRC_BITMAP,
      bitmap,
      cueIndex,
      refresh: job.kind === 'slide' ? job.refresh : undefined,
    };
    if (!port) {
      bitmap.close();
      throw new UnavailableError('render port not connected');
    }
    port.postMessage(msg, [bitmap]);
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
