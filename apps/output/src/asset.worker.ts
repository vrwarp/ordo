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
  type FromAsset,
  SRC_BITMAP,
  type ToAsset,
  downscaleFor,
  jobFontFamilies,
  rasterImage,
  rasterLowerThird,
  rasterProps,
  rasterSlide,
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
/** Families of every font file loaded so far (lower-case). */
const loadedFamilies = new Set<string>();
let width = 1920;
let height = 1080;
let token = '';
let apiPrefix = '/api/v1';
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
const store = new OpfsStore();

// Decoded images by hash: LRU bounded by bytes (256 MiB) rather than count, so a photo-heavy service
// cannot pin a gigabyte of bitmaps (review item 26). Each image is reduced to the output size on decode.
const images = new BitmapCache<ImageBitmap>(DEFAULT_BITMAP_BUDGET, 64);
const loadedFonts = new Set<string>();

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

async function readFile(hash: string): Promise<{ blob: Blob; source: 'opfs' | 'network' }> {
  const b = await store.get(hash).catch(() => undefined);
  if (b && b.size > 0) return { blob: b, source: 'opfs' };
  // Not cached yet (fill still running): read through the hub.
  try {
    const res = await fetch(
      `${apiPrefix}/files/${hash}${token ? `?token=${encodeURIComponent(token)}` : ''}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { blob: await res.blob(), source: 'network' };
  } catch (err) {
    throw new UnavailableError(`file ${hash.slice(0, 8)} unavailable (${(err as Error).message})`);
  }
}

async function image(hash: string): Promise<ImageBitmap> {
  const hit = images.get(hash);
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
  images.set(hash, bmp);
  return bmp;
}

async function loadFonts(fonts: FontLoad[]): Promise<void> {
  const failed: string[] = [];
  let loaded = 0;
  const set = scope.fonts;
  for (const f of fonts) {
    if (loadedFonts.has(f.hash)) {
      loaded++;
      continue;
    }
    try {
      const buf = await (await readFile(f.hash)).blob.arrayBuffer();
      const face = new FontFace(f.family, buf, { weight: String(f.weight), style: f.style });
      await face.load();
      set?.add(face);
      loadedFonts.add(f.hash);
      loadedFamilies.add(f.family.trim().toLowerCase());
      loaded++;
    } catch (err) {
      failed.push(`${f.family} ${f.weight}${f.style === 'italic' ? 'i' : ''}: ${(err as Error).message}`);
    }
  }
  post({ t: 'fonts', loaded, failed });
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
 * `maxImagesPerSlide` images and `maxCueBitmapBytes` of decoded pixels; the rest are skipped.
 */
async function preload(
  map: Record<string, string>,
): Promise<{ lookup: (id: string) => ImageBitmap | undefined; skipped: number }> {
  const out = new Map<string, ImageBitmap>();
  let bytes = 0;
  let skipped = 0;
  for (const [mediaId, hash] of Object.entries(map)) {
    if (out.size >= CLAMP.maxImagesPerSlide) {
      skipped++;
      continue;
    }
    try {
      const bmp = await image(hash);
      const b = bmp.width * bmp.height * 4;
      if (bytes + b > CLAMP.maxCueBitmapBytes) {
        skipped++;
        continue;
      }
      bytes += b;
      out.set(mediaId, bmp);
    } catch {
      /* drawn without the image */
    }
  }
  return { lookup: (id) => out.get(id), skipped };
}

function fontFallbacks(job: AssetJob): string[] | undefined {
  const missing = jobFontFamilies(job).filter((f) => !loadedFamilies.has(f) && !FALLBACK_FAMILIES.has(f));
  return missing.length ? missing : undefined;
}

async function run(job: AssetJob): Promise<void> {
  const t0 = performance.now();
  const scale = width / LOGICAL_WIDTH;
  let skipped = 0;
  try {
    if (job.kind === 'slide') {
      const pre = await preload(job.images);
      skipped = pre.skipped;
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
      cause: err instanceof UnavailableError ? 'unavailable' : 'invalid',
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
