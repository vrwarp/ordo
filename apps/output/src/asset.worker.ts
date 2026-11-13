import { OpfsStore } from '@ordo/cache';
import { isControl, startHeartbeat } from '@ordo/client';
import {
  type AssetJob,
  type AssetToMain,
  type AssetToRender,
  BitmapCache,
  DEFAULT_BITMAP_BUDGET,
  type DrawnSprite,
  FALLBACK_FAMILIES,
  type FontLoad,
  FontResolver,
  type FromAsset,
  GlyphCoverage,
  type ImageLookup,
  type JobRole,
  SRC_BITMAP,
  SRC_SCENE,
  type SlidePicture,
  type Reach,
  type ToAsset,
  type WarmJob,
  contextMetrics,
  coversFrame,
  drawSprite,
  effectsMade,
  effectWork,
  heavySlide,
  imageReach,
  installFontEnv,
  jobFontFamilies,
  lowerThirdReach,
  opaqueColor,
  propsReach,
  registerBlankFace,
  rasterImage,
  rasterLowerThird,
  rasterProps,
  rasterSceneSprites,
  rasterSlide,
  slideJobCost,
  slidePictures,
  slideReach,
  spriteRect,
} from '@ordo/renderer';
import { LOGICAL_WIDTH, type Look, type Slide } from '@ordo/domain';
import { DecodeError, createDecoder } from './decode.ts';
import { Cancelled, Lanes, RANK, type Steps } from './lanes.ts';
import { OpaqueFiles } from './opaque.ts';
import { PICTURE_LIMITS, preloadPictures, sourcePicture } from './pictures.ts';
import { jobSlides, type PrepareHost, prepareSlides } from './prepare/index.ts';
import './prepare/tables.ts';

/**
 * Asset worker: OPFS reads, image decoding, font loading and text rasterization at output resolution.
 * Each job produces one ImageBitmap that goes straight to the render worker (a slide whose video plays in
 * its box: a scene, a base and an optional over bitmap with the video's plane): a tight sprite of what it
 * draws at its offset in the frame, or full-frame where that saves nothing (design/27 §7.3, `drawSprite`).
 * A full-frame bitmap known to be opaque (a cover-fitted JPEG, the props logo) says so. Jobs arrive from
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

// Font coverage (design/27 §10): the characters a job drew that no face of this worker covers, so the
// machine's own fallback face drew them. The drawing surface's text calls are noted (`measuring`) and probed
// on a 1x1 canvas of their own after the job's picture is sent; verdicts are kept until the faces change.
// The probe measures each character with the stack's faces before ordo's blank face, which every code point
// lands on as nothing, so its verdict never depends on the fonts this computer has (blankface.ts). It is
// registered once here, beside the resolver's faces and under a name no font string holds.
const blank = registerBlankFace(scope.fonts);
let probe: ((font: string, text: string) => ArrayLike<number>) | null = null;
const coverage = new GlyphCoverage((font, text) => {
  if (!probe) {
    const c = new OffscreenCanvas(1, 1).getContext('2d');
    if (!c) throw new Error('2D context unavailable'); // the probe fails: no miss is reported
    probe = contextMetrics(c);
  }
  return probe(font, text);
}, blank);
fonts.onChange(() => coverage.reset());

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
  // Each file's opacity is noted from its first bytes as it is read for decoding (opaque.ts).
  read: async (hash) => {
    const r = await readFile(hash);
    await opaqueFiles.note(hash, r.blob);
    return r;
  },
  createImageBitmap: (...a: unknown[]) =>
    (createImageBitmap as (...b: unknown[]) => Promise<ImageBitmap>)(...a),
  ImageDecoder: typeof ImageDecoder === 'undefined' ? undefined : ImageDecoder,
  rasterSvg: svgFromWindow,
});

/** How long the window may take to draw an SVG for this worker before the decode fails. */
const SVG_WINDOW_MS = 15_000;
let svgSeq = 0;
const svgWaits = new Map<
  number,
  { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

/**
 * Ask the output's window to draw an SVG (decode.ts `rasterSvg`, design/14 "Pictures"): this worker cannot
 * decode one. The answer arrives as a `svgRaster` message on this worker's own port from the window.
 */
function svgFromWindow(hash: string, blob: Blob): Promise<ImageBitmap> {
  const id = ++svgSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      svgWaits.delete(id);
      reject(new Error('the window did not draw it in time'));
    }, SVG_WINDOW_MS);
    svgWaits.set(id, { resolve, reject, timer });
    scope.postMessage({ t: 'svgRaster', id, hash, blob } satisfies AssetToMain);
  });
}

/** The window's answer to `svgFromWindow`. */
function onSvgRaster(m: { id: number; bitmap?: ImageBitmap; error?: string }): void {
  const w = svgWaits.get(m.id);
  if (!w) {
    m.bitmap?.close();
    return;
  }
  svgWaits.delete(m.id);
  clearTimeout(w.timer);
  if (m.bitmap) w.resolve(m.bitmap);
  else w.reject(new Error(m.error ?? 'the window could not draw it'));
}

/** The decoder as a job uses it: each whole-file decode within the lanes' bound on decodes at once. */
function jobDecoder(steps: Steps): typeof decoder {
  return { ...decoder, decode: (hash, want) => steps.decode(() => decoder.decode(hash, want)) };
}

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
    if (ctx) coverage.instrument(ctx);
    fresh = true;
  }
  if (!ctx) throw new Error('2D context unavailable in the asset worker');
  return ctx;
}

/** `measuring()` with the surface shrunk to 1x1 first (between draws). */
function measure(): OffscreenCanvasRenderingContext2D {
  const c = measuring();
  if (canvas!.width !== 1 || canvas!.height !== 1) {
    canvas!.width = 1;
    canvas!.height = 1;
    fresh = true;
  }
  return c;
}

/**
 * The surface at `w` x `h` (the frame, or a tight sprite's rect), clear and untransformed. Resizing clears
 * it; so does a transfer (`take`). A surface whose picture was just taken is transparent already, and
 * clearing it again cost 0.2 ms at 1080p and 1.1 ms at 4K (Chromium 153, software), so it is not cleared.
 */
function surface(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const c = measuring();
  if (canvas!.width !== w || canvas!.height !== h) {
    canvas!.width = w;
    canvas!.height = h;
    fresh = true;
  }
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (!fresh) c.clearRect(0, 0, w, h);
  fresh = false;
  return c;
}

/** Sprites drawn again full-frame because their reach was short (logged, not expected; sprite.ts). */
let spriteMisses = 0;

/** Draw one layer as a tight sprite of `reach` (logical px; null: full-frame) in a frame of `out`. */
function sprite(
  reach: Reach,
  scale: number,
  out: { w: number; h: number },
  draw: (c: OffscreenCanvasRenderingContext2D) => void,
): DrawnSprite<ImageBitmap> {
  const d = drawSprite(surface, take, out.w, out.h, spriteRect(reach, scale, out.w, out.h), (c) =>
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
  uses: readonly SlidePicture[] | undefined,
  out: { w: number; h: number },
  steps: Steps,
): Promise<{ lookup: ImageLookup; skipped: number; missing: string[]; release: () => void }> {
  const pre = await preloadPictures(images, jobDecoder(steps), map, uses, out, PICTURE_LIMITS, steps);
  // Drawn without the image. One whose file is not there yet is reported so the link re-draws the slide
  // once the file arrives; a corrupt one is not (it would be missing again every time).
  const missing: string[] = [];
  for (const f of pre.failed)
    if (f.error instanceof UnavailableError && !missing.includes(f.hash)) missing.push(f.hash);
  return { lookup: pre.lookup, skipped: pre.skipped, missing, release: pre.release };
}

/**
 * Run the slide prepare steps (prepare/index.ts: the geometry files a slide draws, `ShapeGeom.ref`, design/27
 * §3.1, and those M9 registers) for a slide job, as its pictures are decoded before it is drawn: files read
 * off this thread like a picture's, the synchronous work in the job's turns (`steps`), so a props job never
 * waits for a large file's parse. Returns the hashes not there yet: drawn with their fallback for now, and
 * reported with the missing images, so the link draws the slide again once they are cached.
 */
function prepare(
  job: { slide?: Slide; nextSlide?: Slide; look?: Look },
  scale: number,
  steps: Steps,
): Promise<string[]> {
  const host: PrepareHost = {
    read: async (hash) => (await readFile(hash)).blob,
    slice: (fn) => steps.slice(fn),
    check: () => steps.check(),
  };
  return prepareSlides({ slides: jobSlides(job), scale, look: job.look }, host);
}

/** Missing families a 'done' message reports: as many as the link keeps (FromAsset, protocol health). */
const MAX_FONT_FALLBACKS = 20;
/** Characters without a face a 'done' message reports. */
const MAX_UNCOVERED = 32;

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
 * before. Base and over are each a tight sprite of what they draw (`rasterSceneSprites`).
 */
function sceneParts(
  job: Extract<AssetJob, { kind: 'slide' }>,
  out: { w: number; h: number },
  scale: number,
  lookup: ImageLookup,
): (SceneParts & { base: DrawnSprite<ImageBitmap> }) | undefined {
  const v = job.video;
  if (!v) return undefined;
  const opts = {
    nextSlide: job.nextSlide,
    isSong: job.isSong,
    presentationKind: job.presentationKind,
    clip: { w: v.w, h: v.h },
  };
  const frame = { width: out.w, height: out.h };
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

/**
 * A layer drawn: its picture (a tight sprite or full-frame), whether that full-frame picture is opaque, and
 * for a scene the over and the plane.
 */
type Drawn = {
  main: DrawnSprite<ImageBitmap>;
  opaque?: boolean;
  scene?: SceneParts;
};

/**
 * A job's synchronous draw, from measuring its reach to the picture taken (the draw calls are rastered by
 * `transferToImageBitmap`): its time on the worker's thread, which health reports as `rasterMs`
 * (design/27 §13), and the text it drew, for `coverage`.
 */
type DrawTiming = { ms: number; text: ReturnType<GlyphCoverage['end']> | null };

function timed<T>(d: DrawTiming, fn: () => T): T {
  const t = performance.now();
  coverage.begin();
  try {
    return fn();
  } finally {
    d.text = coverage.end();
    d.ms += performance.now() - t;
  }
}

/**
 * Draw a job in its lane (`steps`): pictures are read and decoded off this thread and prepared in turns,
 * then the layer is measured, drawn as a sprite, taken and sent in one turn. Every size is the one the job
 * started with, so a resize arriving meanwhile cannot mix two. A cancelled job (`Cancelled`) sends nothing.
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
    let draw: () => Drawn;
    if (job.kind === 'slide') {
      // Prepare steps first (geometry files): a masked picture is prepared with its mask's paths, and the
      // slide's reach and drawing budget are worked out with them.
      const geoms = await prepare(job, scale, steps);
      const pre = await preload(job.images, slidePictures(job.slide, { scale, look: job.look }), out, steps);
      release = pre.release;
      skipped = pre.skipped;
      missing = geoms.length ? [...pre.missing, ...geoms] : pre.missing;
      draw = () => {
        const scene = sceneParts(job, out, scale, pre.lookup);
        if (scene) return { main: scene.base, scene };
        const opts = {
          nextSlide: job.nextSlide,
          isSong: job.isSong,
          presentationKind: job.presentationKind,
        };
        const reach = slideReach(measure(), job.slide, { scale, look: job.look, ...opts });
        return {
          main: sprite(reach, scale, out, (c) =>
            rasterSlide(c, job.slide, job.look, scale, pre.lookup, opts),
          ),
        };
      };
    } else if (job.kind === 'image') {
      const img = await sourcePicture(images, jobDecoder(steps), job.hash, out, steps);
      release = img.release;
      draw = () => ({
        main: sprite(imageReach(img.bitmap, job.fit), scale, out, (c) =>
          rasterImage(c, img.bitmap, job.fit, scale),
        ),
        // A cover or stretch fit of a file without transparency fills the frame opaquely.
        opaque: job.fit !== 'contain' && opaqueFiles.opaque(job.hash) && coversFrame(scale, w, h),
      });
    } else if (job.kind === 'lowerThird') {
      draw = () => {
        const reach = lowerThirdReach(measure(), job.text, job.look, scale);
        return { main: sprite(reach, scale, out, (c) => rasterLowerThird(c, job.text, job.look, scale)) };
      };
    } else {
      const pre = await preload(job.images, undefined, out, steps);
      release = pre.release;
      draw = () => {
        const reach = propsReach(measure(), job.model, scale);
        return {
          main: sprite(reach, scale, out, (c) =>
            rasterProps(c, job.model, scale, pre.lookup, job.look.clearColor),
          ),
          // The logo's backdrop is the clear colour over the whole frame.
          opaque: !!job.model.logo && opaqueColor(job.look.clearColor) && coversFrame(scale, w, h),
        };
      };
    }
    // Measured, drawn, taken and sent in one turn: nothing can cancel it half-way.
    const timing: DrawTiming = { ms: 0, text: null };
    let made: ReturnType<typeof effectsMade> | undefined;
    const ms = await steps.slice(() => {
      const before = effectWork();
      const d = timed(timing, draw);
      // The effect sprites this draw had to make (none when they were cached): content, not the computer.
      made = effectsMade(before, effectWork(), scale);
      release?.();
      release = undefined;
      return deliver(job, d, t0);
    });
    // A slide whose content is past the raster budget by its drawing estimate (memoised by the draw, with the
    // effect sprites it made): health reports its time apart from the alarm's.
    const heavy =
      job.kind === 'slide' && heavySlide({ ...slideJobCost(job.slide, job.look), effectsMade: made }, w, h);
    // The picture is on its way: its text is probed for coverage in slices of their own, so a props job can
    // run between them, and the job is reported done (a cancel meanwhile only skips the probe).
    let uncovered = '';
    try {
      uncovered = await probeCoverage(timing, steps);
    } catch (err) {
      if (!(err instanceof Cancelled)) throw err;
    }
    done(job, ms, timing, steps, skipped, missing, uncovered, heavy);
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

/** Characters probed per slice for coverage (about 1.5 ms for new Han characters on this container). */
const PROBE_CHARS = 32;
/** Probe slices per job at most; what is left is probed in the last one. */
const PROBE_SLICES = 256;

/**
 * The characters of a job's text no face covers, probed in slices of PROBE_CHARS after it was sent. Nothing
 * has a verdict before the blank face has loaded (once, as the worker starts): a job drawn before then waits
 * for it, so its characters are still reported; a blank face that could not load reports nothing.
 */
async function probeCoverage(timing: DrawTiming, steps: Steps): Promise<string> {
  const text = timing.text;
  if (!text?.size) return '';
  if (!(await blank.loaded)) return '';
  // Characters seen before have their verdicts: lookups only, no slice.
  if (coverage.probeSome(text, 0)) return coverage.misses(text, MAX_UNCOVERED);
  for (let i = 0; i < PROBE_SLICES; i++)
    if (await steps.slice(() => coverage.probeSome(text, PROBE_CHARS))) break;
  return steps.slice(() => coverage.misses(text, MAX_UNCOVERED));
}

/** Send a drawn job to the render worker; returns the job's time from its start to the send. */
function deliver(job: AssetJob, d: Drawn, t0: number): number {
  const { main, scene } = d;
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
  } else if (d.opaque) msg.opaque = true;
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
  return performance.now() - t0;
}

/** Say to the link that a job was sent, with its lane timing and the characters no face covers. */
function done(
  job: AssetJob,
  ms: number,
  timing: DrawTiming,
  steps: Steps,
  skipped: number,
  missing: string[],
  uncovered: string,
  heavy: boolean,
): void {
  const t = steps.timing();
  post({
    t: 'done',
    layer: job.layer,
    key: job.key,
    ms,
    rasterMs: round(timing.ms),
    heavy: heavy || undefined,
    fontFallbacks: fontFallbacks(job),
    uncovered: uncovered || undefined,
    skippedImages: skipped || undefined,
    missingImages: missing.length ? missing : undefined,
    lane: t.lane,
    waitMs: round(t.waitMs),
    busyMs: round(t.busyMs),
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
    // Its prepare steps first, as its slide job runs them: a masked picture is prepared cut to its mask.
    await prepare(wj, scale, steps);
    const pre = await preloadPictures(
      images,
      jobDecoder(steps),
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
      (await sourcePicture(images, jobDecoder(steps), hash, out, steps)).release();
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
    busyMs: round(t.busyMs),
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
    case 'svgRaster':
      onSvgRaster(m);
      return;
    default:
      onJobMessage(m);
  }
};
