/// <reference lib="webworker" />
import type { Look, Rgba, Slide } from '@ordo/domain';
import { isControl, startHeartbeat } from '@ordo/client';
import { FontResolver, drawImageFit, drawSlide2D, fillColor, installFontEnv } from '@ordo/renderer';
// The outputs' slide prepare steps (geometry files, and what M9 registers): thumbnails draw what outputs draw.
import { jobSlides, prepareSlides } from '../../../output/src/prepare/index.ts';
import '../../../output/src/prepare/tables.ts';
import { setGeometryUnits } from '../../../output/src/prepare/units.ts';

/** Thumbnail worker (design/15): the shared 2D rasterizer on an OffscreenCanvas; the main thread never rasterizes. */

export type ThumbJob = {
  slide: Slide;
  look?: Look;
  isSong: boolean;
  presentationKind?: 'song' | 'slides' | 'loop';
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
export type ThumbFont = {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  /** The file's hash: read from the service-file cache when it is there. */
  hash: string;
  url: string;
};
export type ThumbIn =
  /**
   * The page's input (lib/capabilities.ts): with a fine pointer (a desktop) the worker makes geometry units for
   * shapes past a slide's drawing budget (prepare/units.ts); with a coarse one (a phone, a tablet) it keeps their
   * legacy copies and makes none.
   */
  | { t: 'init'; finePointer: boolean }
  | { t: 'fonts'; fonts: ThumbFont[] }
  | { t: 'render'; id: number; job: ThumbJob }
  | { t: 'decoded'; id: number; hash: string; bmp?: ImageBitmap };
export type ThumbOut =
  | { t: 'done'; id: number; blob?: Blob; error?: string }
  /** A font failed at first and has loaded since: thumbnails drawn before used a fallback for it. */
  | { t: 'fonts'; families: string[] }
  | { t: 'decode'; id: number; hash: string };

const scope = self as unknown as DedicatedWorkerGlobalScope & { fonts?: FontFaceSet };
// No geometry units until the page says its pointer is fine (`init`).
setGeometryUnits(false);
const bitmaps = new Map<string, Promise<ImageBitmap | undefined>>();
let decodeSeq = 1;
const pendingDecodes = new Map<number, (bmp: ImageBitmap | undefined) => void>();

function decodeViaMainThread(hash: string): Promise<ImageBitmap | undefined> {
  const id = decodeSeq++;
  return new Promise((resolve) => {
    pendingDecodes.set(id, resolve);
    scope.postMessage({ t: 'decode', id, hash } satisfies ThumbOut);
  });
}
let fontsReady: Promise<unknown> = Promise.resolve();
/** Where each font file is fetched from when the service-file cache does not have it. */
const fontUrls = new Map<string, string>();

async function fileBlob(hash: string, url = `/api/v1/files/${hash}`): Promise<Blob | undefined> {
  try {
    const c = await caches.open('ordo-files');
    const hit = await c.match(`/__ordo_cache/${hash}`);
    if (hit) return await hit.blob();
  } catch {
    /* no Cache API */
  }
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
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
        // If createImageBitmap failed in the worker (e.g. SVG in worker scope), delegate to main thread
        try {
          const bmp = await decodeViaMainThread(hash);
          if (bmp) return bmp;
        } catch {
          /* fallback */
        }
        bitmaps.delete(hash);
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

// Fonts (design/27 §10): the same resolver as the outputs, so thumbnails break lines like them and a font
// that loads late (a retried failure) is used without restarting this worker.
const fonts = new FontResolver({
  set: scope.fonts,
  async data(f) {
    const b = await fileBlob(f.hash, fontUrls.get(f.hash));
    if (!b) throw new Error('file unavailable');
    return b.arrayBuffer();
  },
});
installFontEnv(fonts);
fonts.onChange((c) => {
  if (c.late) scope.postMessage({ t: 'fonts', families: c.families } satisfies ThumbOut);
});

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
  // The slide prepare steps (geometry files the slides draw, `ShapeGeom.ref`), run as their pictures are read.
  await prepareSlides(
    { slides: jobSlides(job), scale, look: job.look },
    { read: (hash) => fileBlob(hash), slice: async (fn) => fn(), check: () => {} },
  );
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
    presentationKind: job.presentationKind,
    nextSlide: job.nextSlide,
  });
  return job.clear && job.clear.a < 1
    ? canvas.convertToBlob({ type: 'image/png' })
    : canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
}

startHeartbeat(scope);

scope.onmessage = (ev: MessageEvent<ThumbIn>) => {
  const m = ev.data;
  if (!m || isControl(m)) return;
  if (m.t === 'init') {
    setGeometryUnits(m.finePointer === true);
    return;
  }
  if (m.t === 'fonts') {
    for (const f of m.fonts) fontUrls.set(f.hash, f.url);
    fontsReady = Promise.allSettled([fontsReady, fonts.sync(m.fonts)]);
    return;
  }
  if (m.t === 'decoded') {
    const cb = pendingDecodes.get(m.id);
    if (cb) {
      pendingDecodes.delete(m.id);
      cb(m.bmp);
    }
    return;
  }
  render(m.job).then(
    (blob) => scope.postMessage({ t: 'done', id: m.id, blob } satisfies ThumbOut),
    (e) => scope.postMessage({ t: 'done', id: m.id, error: String(e) } satisfies ThumbOut),
  );
};
