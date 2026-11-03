import { OpfsStore } from '@ordo/cache';
import {
  type AssetJob,
  type AssetToRender,
  type FontLoad,
  type FromAsset,
  SRC_BITMAP,
  type ToAsset,
  rasterImage,
  rasterLowerThird,
  rasterProps,
  rasterSlide,
} from '@ordo/renderer';
import { LOGICAL_WIDTH } from '@ordo/domain';

/**
 * Asset worker: OPFS reads, image decoding, font loading and text rasterization at output resolution.
 * Each job produces one full-frame ImageBitmap that goes straight to the render worker.
 */

const scope = self as unknown as {
  postMessage(m: FromAsset): void;
  onmessage: ((ev: MessageEvent<ToAsset>) => void) | null;
  fonts?: FontFaceSet;
};

let port: MessagePort | null = null;
let width = 1920;
let height = 1080;
let token = '';
let apiPrefix = '/api/v1';
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
const store = new OpfsStore();

// Decoded images by hash (LRU by insertion order).
const MAX_IMAGES = 48;
const images = new Map<string, ImageBitmap>();
const loadedFonts = new Set<string>();

let chain: Promise<void> = Promise.resolve();
function enqueue(fn: () => Promise<void>): void {
  chain = chain.then(fn, fn).catch((err) => console.error('[ordo asset]', err));
}

function post(m: FromAsset): void {
  scope.postMessage(m);
}

async function readFile(hash: string): Promise<Blob> {
  const b = await store.get(hash).catch(() => undefined);
  if (b && b.size > 0) return b;
  // Not cached yet (fill still running): read through the hub.
  const res = await fetch(`${apiPrefix}/files/${hash}${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  if (!res.ok) throw new Error(`file ${hash.slice(0, 8)} unavailable (${res.status})`);
  return await res.blob();
}

async function image(hash: string): Promise<ImageBitmap> {
  const hit = images.get(hash);
  if (hit) {
    images.delete(hash);
    images.set(hash, hit);
    return hit;
  }
  const blob = await readFile(hash);
  let bmp = await createImageBitmap(blob);
  // Very large images are reduced to twice the output size: plenty for cover/contain, far less memory.
  const maxW = width * 2;
  if (bmp.width > maxW) {
    const scaled = await createImageBitmap(bmp, {
      resizeWidth: maxW,
      resizeHeight: Math.round((bmp.height * maxW) / bmp.width),
      resizeQuality: 'high',
    });
    bmp.close();
    bmp = scaled;
  }
  images.set(hash, bmp);
  while (images.size > MAX_IMAGES) {
    const first = images.keys().next().value as string;
    images.get(first)?.close();
    images.delete(first);
  }
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
      const buf = await (await readFile(f.hash)).arrayBuffer();
      const face = new FontFace(f.family, buf, { weight: String(f.weight), style: f.style });
      await face.load();
      set?.add(face);
      loadedFonts.add(f.hash);
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
    ctx = canvas.getContext('2d');
  }
  if (!ctx) throw new Error('2D context unavailable in the asset worker');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

async function preload(map: Record<string, string>): Promise<(id: string) => ImageBitmap | undefined> {
  const out = new Map<string, ImageBitmap>();
  for (const [mediaId, hash] of Object.entries(map)) {
    try {
      out.set(mediaId, await image(hash));
    } catch {
      /* drawn without the image */
    }
  }
  return (id) => out.get(id);
}

async function run(job: AssetJob): Promise<void> {
  const t0 = performance.now();
  const scale = width / LOGICAL_WIDTH;
  try {
    if (job.kind === 'slide') {
      const lookup = await preload(job.images);
      const c = surface();
      rasterSlide(c, job.slide, job.look, scale, lookup, { nextSlide: job.nextSlide, isSong: job.isSong });
    } else if (job.kind === 'image') {
      const img = await image(job.hash);
      const c = surface();
      rasterImage(c, img, job.fit, scale);
    } else if (job.kind === 'lowerThird') {
      const c = surface();
      rasterLowerThird(c, job.text, job.look, scale);
    } else {
      const lookup = await preload(job.images);
      const c = surface();
      rasterProps(c, job.model, scale, lookup, job.look.clearColor);
    }
    const bitmap = canvas!.transferToImageBitmap();
    const cueIndex = job.kind === 'slide' ? job.cueIndex : job.kind === 'image' ? job.cueIndex : undefined;
    const msg: AssetToRender = { t: 'content', layer: job.layer, key: job.key, kind: SRC_BITMAP, bitmap, cueIndex };
    if (!port) throw new Error('render port not connected');
    port.postMessage(msg, [bitmap]);
    post({ t: 'done', layer: job.layer, key: job.key, ms: performance.now() - t0 });
  } catch (err) {
    post({ t: 'error', layer: job.layer, key: job.key, error: (err as Error).message || String(err) });
  }
}

scope.onmessage = (ev) => {
  const m = ev.data;
  switch (m.t) {
    case 'init':
      port = m.port;
      width = m.width;
      height = m.height;
      token = m.token;
      apiPrefix = m.apiPrefix;
      return;
    case 'resize':
      width = m.width;
      height = m.height;
      return;
    case 'fonts':
      enqueue(() => loadFonts(m.fonts));
      return;
    case 'job':
      // Props jobs (once per second) are cheap; everything runs in order so fonts precede text.
      enqueue(() => run(m.job));
      return;
    case 'prune': {
      const keep = new Set(m.keep);
      for (const [h, b] of images)
        if (!keep.has(h)) {
          b.close();
          images.delete(h);
        }
      return;
    }
  }
};
