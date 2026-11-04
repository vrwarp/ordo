/// <reference lib="webworker" />
import type { Look, Rgba, Slide } from '@ordo/domain';
import { isControl, startHeartbeat } from '@ordo/client';
import { drawImageFit, drawSlide2D, fillColor } from '@ordo/renderer';

/** Thumbnail worker (design/15): the shared 2D rasterizer on an OffscreenCanvas; the main thread never rasterizes. */

export type ThumbJob = {
  slide: Slide;
  look?: Look;
  isSong: boolean;
  /** Background image hash (an image, or a video's poster). */
  bg?: string;
  /** mediaId -> file hash for image objects and imported page images. */
  images: Record<string, string>;
  width: number;
  height: number;
  /** Look previews: the look's clear colour (the stream key green) instead of black. */
  clear?: Rgba;
  /** Look previews: the following slide, for a look that shows it (the stage look). */
  nextSlide?: Slide;
};
export type ThumbIn =
  | { t: 'fonts'; fonts: { family: string; weight: number; style: string; url: string }[] }
  | { t: 'render'; id: number; job: ThumbJob };
export type ThumbOut = { t: 'done'; id: number; blob?: Blob; error?: string };

const scope = self as unknown as DedicatedWorkerGlobalScope & { fonts?: FontFaceSet };
const bitmaps = new Map<string, Promise<ImageBitmap | undefined>>();
const loadedFonts = new Set<string>();
let fontsReady: Promise<unknown> = Promise.resolve();

async function fileBlob(hash: string): Promise<Blob | undefined> {
  try {
    const c = await caches.open('ordo-files');
    const hit = await c.match(`/__ordo_cache/${hash}`);
    if (hit) return await hit.blob();
  } catch {
    /* no Cache API */
  }
  try {
    const r = await fetch(`/api/v1/files/${hash}`, { credentials: 'same-origin' });
    if (r.ok) return await r.blob();
  } catch {
    /* offline */
  }
  return undefined;
}

function bitmap(hash: string): Promise<ImageBitmap | undefined> {
  let p = bitmaps.get(hash);
  if (!p) {
    p = fileBlob(hash).then(async (b) => {
      if (!b) {
        bitmaps.delete(hash);
        return undefined;
      }
      try {
        return await createImageBitmap(b, { resizeWidth: 640, resizeQuality: 'medium' });
      } catch {
        return undefined;
      }
    });
    bitmaps.set(hash, p);
    if (bitmaps.size > 120) {
      const first = bitmaps.keys().next().value;
      if (first !== undefined) {
        void bitmaps.get(first)?.then((b) => b?.close());
        bitmaps.delete(first);
      }
    }
  }
  return p;
}

async function render(job: ThumbJob): Promise<Blob> {
  await fontsReady;
  const canvas = new OffscreenCanvas(job.width, job.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  if (job.clear) fillColor(ctx, job.clear, job.width, job.height);
  else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, job.width, job.height);
  }
  const scale = job.width / 1920;
  const ids = Object.entries(job.images);
  const bms = new Map<string, ImageBitmap>();
  await Promise.all(
    ids.map(async ([mediaId, hash]) => {
      const b = await bitmap(hash);
      if (b) bms.set(mediaId, b);
    }),
  );
  if (job.bg) {
    const b = await bitmap(job.bg);
    if (b) drawImageFit(ctx, b, { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }, scale, 'cover');
  }
  drawSlide2D(ctx, job.slide, {
    scale,
    look: job.look,
    images: (id) => bms.get(id),
    isSong: job.isSong,
    nextSlide: job.nextSlide,
  });
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
}

startHeartbeat(scope);

scope.onmessage = (ev: MessageEvent<ThumbIn>) => {
  const m = ev.data;
  if (!m || isControl(m)) return;
  if (m.t === 'fonts') {
    const loads: Promise<unknown>[] = [];
    for (const f of m.fonts) {
      const key = `${f.family}|${f.weight}|${f.style}|${f.url}`;
      if (loadedFonts.has(key) || !scope.fonts) continue;
      loadedFonts.add(key);
      try {
        const face = new FontFace(f.family, `url(${f.url})`, { weight: String(f.weight), style: f.style });
        scope.fonts.add(face);
        loads.push(face.load().catch(() => undefined));
      } catch {
        /* bad font */
      }
    }
    fontsReady = Promise.allSettled([fontsReady, ...loads]);
    return;
  }
  render(m.job).then(
    (blob) => scope.postMessage({ t: 'done', id: m.id, blob } satisfies ThumbOut),
    (e) => scope.postMessage({ t: 'done', id: m.id, error: String(e) } satisfies ThumbOut),
  );
};
