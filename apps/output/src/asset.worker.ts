import { OpfsStore } from '@ordo/cache';
import { isControl, startHeartbeat } from '@ordo/client';
import {
  type AssetJob,
  type AssetToMain,
  type AssetToRender,
  BitmapCache,
  type DrawingSwitches,
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
  type UnderFrame,
  type ToAsset,
  type WarmJob,
  type WarmUnitsJob,
  clampSlide,
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
import {
  type FrameSplit,
  frameKey,
  frameMissing,
  frameStats,
  frameUnit,
  frameWorkBytes,
  setFrames,
  splitFrame,
  underFrame,
  underSlides,
} from '@ordo/renderer/frame.ts';
import {
  setEffectUnits,
  UNIT_CACHE_BYTES,
  unitCache,
  unitsOfSlide,
  unitUnmade,
  unitWork,
} from '@ordo/renderer/units.ts';
import { drawnMediaIds, LOGICAL_WIDTH, type Look, type Slide } from '@ordo/domain';
import { DecodeError, createDecoder } from './decode.ts';
import { LATE_UNIT, REFRESH_FADE_MS } from './late.ts';
import { Cancelled, Lanes, RANK, type Steps } from './lanes.ts';
import { OpaqueFiles } from './opaque.ts';
import { PICTURE_LIMITS, preloadPictures, sourcePicture } from './pictures.ts';
import { jobSlides, type PrepareHost, type PrepareJob, prepareSlides } from './prepare/index.ts';
import './prepare/tables.ts';
import { framePictures } from './prepare/frame.ts';
import { holdInto, holdKeys, holdUnits, type UnitHold, type UnitJob, unitJob } from './prepare/units.ts';

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
 * armed cue's, then late work, and bulk work (the pictures of the cue after the armed one, the live playlist's
 * units warmed ahead) last. Each layer is a chain of its own; synchronous work runs in short turns (a picture
 * is prepared in bands), so a slide that decodes never holds a props flip up by more than one turn. A job the
 * link cancels stops at its next turn.
 *
 * A GO never waits for drawing (design/14 "Late units", owner decision 2026-11-13): a live slide job (a jump to
 * a cue neither armed nor warmed) and a re-draw never wait for geometry units, and an armed or warm job stops
 * waiting the moment the link says its cue went live (`hurry`). The slide is drawn with what is ready, the
 * units not ready as their legacy copies this time; a late job (RANK.late) makes them, pinned with the job's
 * own, and `unitsReady` tells the link, which draws the slide again with a fade (or, with `?late=next`, leaves
 * them to its next draw). When the link sends the live playlist (`warmUnits`), its slides' units are made ahead
 * in bulk work, in cue order from the live cue, until two thirds of the unit cache (`WARM_UNITS_BYTES`);
 * every live job stops that work and it goes on afterwards.
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
/**
 * The output's drawing switches (`init`, `DrawingSwitches`: `?late=next`, `?warm=off`, `?effects=base`, and in
 * test mode `?unitTurnMs=`). `effects: 'base'` turns effect units off in this worker (`setEffectUnits(false)`,
 * C6, in `applyDrawing`): effects and decorations drawn as 62a1c3a drew them.
 */
let drawing: DrawingSwitches = {};
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
/** Counts the face changes: a frame's key follows it, so a frame of fallback glyphs is never copied once a face has arrived. */
let fontEpoch = 0;
fonts.onChange((c) => {
  fontEpoch++;
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

/** What a slide's frame is split from: the slide (live-clamped) or the slide before the cut (`AssetJob.full`), and its video. */
type FrameJob = { slide?: Slide; full?: Slide; look?: Look; video?: { objectId: string } };

/**
 * The underlay frame split of a job's slide at `scale` (renderer `frame.ts`), undefined for a slide that fits the
 * counts, a look that does not draw it as authored, or `?frame=off`. One function for every path that prepares a
 * slide (the slide job, the late job, the remake, the warm-up), so they all work out the same split and the same
 * frame key. The slide before the cut when the job carries it (`full`), else the live-clamped slide, whose objects
 * the split then shares with the draw. `area` false leaves rule (e) out, for the draw a GO waits for (a live slide
 * job): its late job works the whole split out (`lateUnits`), off the GO's path.
 */
function frameOf(job: FrameJob, scale: number, area = true): FrameSplit | undefined {
  if (drawing.frame === 'off' || drawing.effects === 'base') return undefined;
  const base = job.full ?? (job.slide ? clampSlide(job.slide) : undefined);
  if (!base) return undefined;
  return splitFrame(base, scale, {
    ...(job.look ? { look: job.look } : {}),
    ...(job.video ? { video: { objectId: job.video.objectId } } : {}),
    ...(area ? {} : { area: false }),
  });
}

/**
 * The prepare job of a slide with its frame: the direct part first (its units), the next slide, then the frame's
 * objects in slides of their own (their files, drawers and table layouts), and the frame as a unit made before the
 * slide's own, its pictures from this worker's cache one at a time (`framePictures`). `images` is the job's
 * mediaId to file hash map.
 */
function prepareJobOf(
  job: FrameJob & { nextSlide?: Slide; images?: Record<string, string> },
  split: FrameSplit | undefined,
  scale: number,
  steps: Steps,
): PrepareJob {
  if (!split)
    return { slides: jobSlides(job as { slide?: Slide; nextSlide?: Slide }), scale, look: job.look };
  const pictures = framePictures({
    cache: images,
    decoder: jobDecoder(steps),
    images: job.images ?? {},
    out: { w: Math.round(LOGICAL_WIDTH * scale), h: Math.round(1080 * scale) },
    steps,
    isMissing: (e) => e instanceof UnavailableError,
    has: async (hash) => {
      const b = await store.get(hash).catch(() => undefined);
      return !!b && b.size > 0;
    },
  });
  return {
    slides: jobSlides({ slide: split.direct, nextSlide: job.nextSlide }, underSlides(split)),
    scale,
    look: job.look,
    frame: frameUnit(split, { pictures, epoch: fontEpoch }),
  };
}

/** `job.images` cut to the pictures the direct part and the next slide draw: the rest are the frame's, made one at a time. */
function directImages(
  all: Record<string, string>,
  direct: Slide,
  nextSlide: Slide | undefined,
): Record<string, string> {
  const want = new Set([...drawnMediaIds(direct), ...(nextSlide ? drawnMediaIds(nextSlide) : [])]);
  const out: Record<string, string> = {};
  for (const [id, hash] of Object.entries(all)) if (want.has(id)) out[id] = hash;
  return out;
}

/**
 * Run the slide prepare steps (prepare/index.ts: the geometry files a slide draws, `ShapeGeom.ref`, design/27
 * §3.1, and those M9 registers) for a slide job, as its pictures are decoded before it is drawn: files read
 * off this thread like a picture's, the synchronous work in the job's turns (`steps`), so a props job never
 * waits for a large file's parse. Returns the hashes not there yet: drawn with their fallback for now, and
 * reported with the missing images, so the link draws the slide again once they are cached.
 */
async function prepare(
  job: FrameJob & { nextSlide?: Slide; images?: Record<string, string> },
  scale: number,
  steps: Steps,
  how?: { key: string; stop(): boolean; area?: boolean },
): Promise<{ missing: string[]; units: UnitHold; made?: UnitJob; split?: FrameSplit }> {
  const host = jobHost(steps);
  // The geometry units it makes or finds stay pinned until the job lets them go (`keepUnits`).
  const units = holdUnits(host);
  // How it waits for units: absent, as long as `UNIT_WAIT_MS` (prepare/units.ts).
  const made = how ? unitJob(host, { stop: how.stop, afterTurn: turnWait(how.key) }) : undefined;
  try {
    const split = await steps.slice(() => frameOf(job, scale, how?.area !== false));
    const pj = prepareJobOf(job, split, scale, steps);
    const missing = await prepareSlides(pj, host);
    // A frame made without a picture whose file was not there: reported with the slide's missing pictures, so the
    // link draws the slide again once it is cached (`frame.ready` then makes the frame again).
    if (pj.frame)
      for (const m of frameMissing(pj.frame.key))
        if (!m.startsWith('media:') && !missing.includes(m)) missing.push(m);
    return { missing, units, made, ...(split ? { split } : {}) };
  } catch (err) {
    units.release();
    throw err;
  }
}

/** A prepare host on a job's lane turns (`steps`). */
function jobHost(steps: Steps): PrepareHost {
  return {
    read: async (hash) => (await readFile(hash)).blob,
    slice: (fn) => steps.slice(fn),
    check: () => steps.check(),
  };
}

/**
 * Keys of the armed and warm jobs a GO hurried (`hurry`): their units step stops waiting at once (the unit it is
 * making is abandoned at its next turn) and they draw with what is ready. Forgotten when the job ends or is
 * cancelled: the same key sent again later (the operator came back to that cue) waits as any job of its role.
 */
const hurried = new Set<string>();
/**
 * Keys of the armed slide jobs a live job of their layer rushed: a jump to another slide while their cue stays
 * armed (click-to-go on a hidden cue before it; a cue selected, then a GO to the one before it). Each layer is one
 * chain, so the jump's live job would start only once the arm had waited its `UNIT_WAIT_MS`. Their units step
 * stops waiting at once, as a hurried job's, and they draw with what is ready, the rest left to their late job;
 * unlike a hurried job's, their cue is not live: their hold stays on the layer's armed chain and the live slide's
 * late job goes on. Forgotten when the job ends or is cancelled.
 */
const rushed = new Set<string>();
/** Armed slide jobs sent, by key: their layer (looked up only while lanes still hold the key). */
const armedSlides = new Map<string, number>();
/** Waits of unit turns (`turnWait`) by job key, ended at once by a hurry, a rush or a cancel. */
const turnWaits = new Map<string, Set<() => void>>();

/**
 * Test mode (`?unitTurnMs=`): each turn of unit making is followed by a wait of that long, so a unit takes a
 * known time to make without holding the thread (the e2e's slow units). Undefined otherwise.
 */
function turnWait(key: string): (() => Promise<void>) | undefined {
  const ms = drawing.unitTurnMs;
  if (!(typeof ms === 'number' && ms > 0)) return undefined;
  return () =>
    new Promise<void>((resolve) => {
      let set = turnWaits.get(key);
      if (!set) turnWaits.set(key, (set = new Set()));
      const waits = set;
      const end = () => {
        clearTimeout(timer);
        waits.delete(end);
        if (!waits.size && turnWaits.get(key) === waits) turnWaits.delete(key);
        resolve();
      };
      const timer = setTimeout(end, ms);
      waits.add(end);
    });
}

function endTurnWaits(keys: Iterable<string>): void {
  for (const k of keys) for (const end of [...(turnWaits.get(k) ?? [])]) end();
}

type SlideJob = Extract<AssetJob, { kind: 'slide' }>;

/**
 * A slide's late job (by slide key, one at a time): the units its draws were made without (a live or hurried job,
 * a re-draw), made in lane jobs of `RANK.late` on one chain. Its layer; the hold it pins what it makes into, the
 * slide's last draw's (`holdInto`: as long as that draw's own units, while the slide is live or armed; a draw of
 * the slide while the late job runs hands its hold on, so a part made after a re-draw is never evicted before the
 * next re-draw copies it); the parts it has still to make (`outstanding`: a draw that leaves more while it runs
 * adds them, `grew`); those made, or found unmakeable, since its last report and when that was; and whether its
 * last report went (`ended`: nothing joins it after). A live job of another slide on the layer drops it: that
 * slide left the screen (shown again, the link draws it again, which starts a new late job).
 *
 * Its hold let go by the layer's chain while it runs (`keepUnits`, repair 4): by the live chain (another slide's
 * hurried arm or fading re-draw, a restart's `units`), its slide left the screen, so it stops at its next turn
 * (`stopped`) and reports its end, the parts it did not make left to the slide's next draw; by the armed chain
 * (the next cue armed), its slide either went live by a GO to its armed cue, which the worker is not told, or left,
 * so it keeps the hold itself (`owns`) until it ends or a draw of the slide takes it over. So what it made is never
 * evicted before a re-draw copies it while it runs, and it never makes a part twice.
 */
type LateJob = {
  layer: number;
  hold: UnitHold;
  /** The prepare host of the lane job running it, whose pins go to `hold`. */
  host?: PrepareHost;
  outstanding: Set<string>;
  grew: boolean;
  fresh: string[];
  last: number;
  ended: boolean;
  /** `hold` is its own (let go by the layer's armed chain): released when it ends or hands it on. */
  owns: boolean;
  /** Its hold was let go by the layer's live chain: its slide left the screen, it makes nothing more. */
  stopped: boolean;
  /** A restart's `units` job not planned yet (`remakeUnits`): a draw of the slide meanwhile replaces it. */
  pending?: boolean;
  /**
   * Its parts are those of a draw cut without rule (e) (a live slide job, `frameOf` `area` false): the job works the
   * whole split out first, off the GO's path, and its parts are that split's (`replan`).
   */
  approx?: Approx;
};
/** What a draw cut without rule (e) was: its direct part, the frame key of its split and whether the draw copied it. */
type Approx = { slide: Slide; frame?: string; copied: boolean };
const lateJobs = new Map<string, LateJob>();
/** The hold of a restart's `units` job until it is planned: pins nothing. */
const NO_HOLD: UnitHold = { keys: new Set<string>(), release: () => undefined };
/** Drop a late job from `lateJobs` (its lane job is cancelled by the caller): the hold it owns is let go. */
function dropLate(slideKey: string, late: LateJob): void {
  if (lateJobs.get(slideKey) === late) lateJobs.delete(slideKey);
  if (late.owns) {
    late.owns = false;
    late.hold.release();
  }
}
/**
 * Rounds of making one lane job of a late job takes at most (each bounded by `UNIT_WAIT_MS`). While its last round
 * made one of its parts (or found one unmakeable, or a draw added some), the late job goes on in a new lane job,
 * after the late work queued meanwhile (the slide's parts are never left unmade because rounds ran out: repair 3);
 * a round that made none of them ends it. Units it makes again that are not its parts (evicted after it made them)
 * never count (repair 4): so it goes on at most once per part, and every round makes one or ends it.
 */
const LATE_ROUNDS = 4;
const lateKey = (slideKey: string) => `lu|${slideKey}`;

/**
 * One lane job of `late` (see `LateJob`): make its parts in rounds, pinned into its hold, reporting them with
 * `unitsReady` at most once per `REFRESH_FADE_MS` while some remain and after each round, a part found unmakeable
 * as one drawn differently now (renderer units.ts `unitUnmade`: a decoration is then drawn directly). Its last
 * report says `ended` (all made, a round that made none of its parts, stopped, or an error; `left` the parts it did
 * not make), so the link never waits for parts no job makes. A cancelled or replaced job reports nothing. None with
 * `?late=next`: the slide's next draw copies them.
 */
async function lateUnits(job: SlideJob, late: LateJob, scale: number, steps: Steps): Promise<void> {
  const host = jobHost(steps);
  late.host = host;
  const fade = (drawing.late ?? LATE_UNIT) === 'fade';
  const { outstanding } = late;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Report the parts ready since the last report; `end`: the late job's last report, also with none. */
  const flush = (end = false) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (late.ended || steps.cancelled) return;
    // Those made meanwhile by another job (an arm, the warm-up) are ready too, and one that could not be made
    // is drawn differently now.
    for (const k of outstanding)
      if (unitCache.has('unit', k) || unitUnmade(k)) {
        outstanding.delete(k);
        late.fresh.push(k);
      }
    const last = end || !outstanding.size;
    if (!late.fresh.length && !last) return;
    late.ended = last;
    if (fade)
      post({
        t: 'unitsReady',
        layer: job.layer,
        slideKey: job.key,
        keys: late.fresh,
        left: outstanding.size,
        ...(last ? { ended: true as const } : {}),
        ...(last && late.stopped && outstanding.size ? { stopped: true as const } : {}),
      });
    late.fresh = [];
    late.last = performance.now();
  };
  unitJob(host, {
    // Stopped (its slide left the screen): the unit it is making is abandoned at its next turn.
    stop: () => late.stopped,
    // A unit whose making failed is not tried again by its late job (one failing slowly would use up each round).
    skip: (k) => unitUnmade(k),
    onUnit: (k) => {
      if (late.ended || !outstanding.delete(k)) return;
      late.fresh.push(k);
      const since = performance.now() - late.last;
      if (!outstanding.size || since >= REFRESH_FADE_MS) flush();
      else timer ??= setTimeout(() => flush(), REFRESH_FADE_MS - since);
    },
    afterTurn: turnWait(lateKey(job.key)),
  });
  /**
   * The parts of the whole split, for a late job whose parts were those of a draw cut without rule (e): the frame
   * and the units of the direct part with it replace those of the cut draw (`late.approx`), the parts left out of
   * the draw for another reason stay. A frame the draw did not copy and that is in the cache is reported now, so
   * the slide is drawn again with it. True when the parts changed. A turn of the lane's of its own (the split is
   * worked out here for the first time: the slide's planning is a turn of the same size).
   */
  const replan = (): Promise<boolean> => steps.slice(replanned);
  const replanned = (): boolean => {
    const was = late.approx;
    late.approx = undefined;
    if (!was) return false;
    const split = frameOf(job, scale);
    const slide = split ? split.direct : job.slide;
    if (!slide) return false;
    const have = (k: string) => unitCache.has('unit', k) || unitUnmade(k);
    const fk = split ? frameKey(split, fontEpoch) : undefined;
    const want = new Set<string>();
    if (fk && !have(fk)) want.add(fk);
    for (const u of unitsOfSlide(slide, scale, job.look))
      if (u.of !== 'prepared' && !have(u.key)) want.add(u.key);
    // Those the cut draw asked for and the whole split does not: the objects below the direct part are the frame's.
    const old = new Set<string>(was.frame ? [was.frame] : []);
    for (const u of unitsOfSlide(was.slide, scale, job.look)) if (u.of !== 'prepared') old.add(u.key);
    let changed = false;
    for (const k of old)
      if (outstanding.has(k) && !want.has(k)) {
        outstanding.delete(k);
        changed = true;
      }
    for (const k of want)
      if (!outstanding.has(k)) {
        outstanding.add(k);
        changed = true;
      }
    if (fk && unitCache.has('unit', fk) && !(was.copied && was.frame === fk)) {
      late.fresh.push(fk);
      changed = true;
    }
    return changed;
  };
  let more = false;
  try {
    let progressed = true;
    const going = () => outstanding.size > 0 && !late.ended && !late.stopped;
    for (
      let round = 0;
      round < LATE_ROUNDS && progressed && !late.ended && !late.stopped && (going() || late.approx);
      round++
    ) {
      // Pinned with the slide's last draw (a draw meanwhile hands its hold on).
      holdInto(host, late.hold);
      late.grew = false;
      // A draw cut without rule (e): its parts are the whole split's first, off the GO's path.
      if (late.approx) {
        late.grew = await replan();
        flush();
        if (!going()) {
          progressed = false;
          break;
        }
      }
      const left0 = outstanding.size;
      await prepareSlides(prepareJobOf(job, frameOf(job, scale), scale, steps), host);
      flush();
      // Only its own parts count: a unit made again after it was evicted is not one (repair 4).
      progressed = outstanding.size < left0 || late.grew;
    }
    more = progressed && going();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const current = lateJobs.get(job.key) === late;
    if (more && !steps.cancelled && current) pushLate(job, late, scale);
    else {
      // Replaced by a newer late job of the slide (this one stopped): only that one reports.
      if (current) {
        lateJobs.delete(job.key);
        flush(true);
      } else late.ended = true;
      if (late.owns) {
        late.owns = false;
        late.hold.release();
      }
    }
  }
}

function pushLate(job: SlideJob, late: LateJob, scale: number): void {
  lanes.push({
    key: lateKey(job.key),
    chain: 'late',
    rank: RANK.late,
    gate: fonts$,
    run: (s) => lateUnits(job, late, scale, s),
  });
}

/**
 * The parts a draw of `job` left (`left`; `hold`, that draw's units, before it is kept and the older hold let go):
 * made by its slide's late job, a new one unless one is running, which they join, its units (those made so far
 * with them) pinned into this draw's hold from now on.
 */
function lateFor(job: SlideJob, left: readonly string[], hold: UnitHold, approx?: Approx): void {
  const running = lateJobs.get(job.key);
  // A restart's `units` job not planned yet: this draw does what it would (its parts left go to a late job).
  if (running?.pending) lateJobs.delete(job.key);
  else if (running && !running.ended && !running.stopped) {
    if (running.hold !== hold) {
      const old = running.hold;
      holdKeys(hold, old.keys);
      running.hold = hold;
      if (running.host) holdInto(running.host, hold);
      if (running.owns) {
        running.owns = false;
        old.release();
      }
    }
    for (const k of left)
      if (!running.outstanding.has(k)) {
        running.outstanding.add(k);
        running.grew = true;
      }
    // The parts of a draw cut without rule (e) are worked out again with it at the job's next round.
    if (approx) {
      running.approx = approx;
      running.grew = true;
    }
    return;
  }
  if (!left.length && !approx) return;
  const late: LateJob = {
    layer: job.layer,
    hold,
    outstanding: new Set(left),
    grew: false,
    fresh: [],
    last: performance.now(),
    ended: false,
    owns: false,
    stopped: false,
    ...(approx ? { approx } : {}),
  };
  lateJobs.set(job.key, late);
  pushLate(job, late, width / LOGICAL_WIDTH);
}

/**
 * `units` (the link, after an asset worker restart, design/14 "Late units"): the renderer holds `job`'s slide,
 * drawn by the worker that went away, with parts left late or made and not drawn in yet. Planned here with what
 * this worker has ready pinned as the layer's hold of `role` (as a draw of it would), the rest made as by a late
 * job and reported; nothing drawn (a re-draw now would draw the parts made before as their stand-ins). Found all
 * made (the warm-up): reported at once, so the link draws it with them.
 *
 * It is the slide's late job (`late`, pending) from the message on, so a live job of another slide on the layer
 * drops it, queued or planning, as any late job (repair 4); a draw of the slide meanwhile replaces it. Planned, it
 * takes the layer's hold of `role` only while no other job took it since the message (`seq`): taken on the live
 * chain, its slide left the screen and nothing is made or kept; on the armed chain, it keeps its hold itself.
 */
async function remakeUnits(
  job: SlideJob,
  role: 'live' | 'armed',
  late: LateJob,
  seq: number,
  steps: Steps,
): Promise<void> {
  const scale = width / LOGICAL_WIDTH;
  const chain = `layer ${job.layer} ${role}`;
  const gone = () => steps.cancelled || lateJobs.get(job.key) !== late;
  if (gone()) return;
  let prep: Awaited<ReturnType<typeof prepare>>;
  try {
    prep = await prepare(job, scale, steps, { key: lateKey(job.key), stop: () => true });
  } catch (err) {
    if (lateJobs.get(job.key) === late) lateJobs.delete(job.key);
    throw err;
  }
  const taken = (heldSeq.get(chain) ?? 0) !== seq;
  if (gone() || (taken && role === 'live')) {
    prep.units.release();
    if (lateJobs.get(job.key) === late) lateJobs.delete(job.key);
    return;
  }
  late.pending = false;
  late.hold = prep.units;
  if (taken) late.owns = true;
  else keepUnits(chain, prep.units);
  const left = prep.made?.left ?? [];
  for (const k of left) late.outstanding.add(k);
  late.fresh = left.length ? [] : [...prep.units.keys];
  late.last = performance.now();
  await lateUnits(job, late, scale, steps);
}

/** The live playlist's units made ahead (`warmUnits`): the list, the next slide, and why it stopped. */
let warmList: { job: WarmUnitsJob; next: number; stopped?: 'full' | 'done' } | undefined;
const WARM_UNITS_KEY = 'warm units';
/** Warm-up stops once the unit cache holds this much (two thirds of it): the rest is the live, armed and late cues'. */
const WARM_UNITS_BYTES = Math.floor((UNIT_CACHE_BYTES * 2) / 3);

/** The warm-up's lane job queued or running and not cancelled (its number), 0 none. */
let warmQueued = 0;
let warmSeq = 0;

/** Queue the warm-up (bulk: it starts once nothing interactive is queued or running). */
function queueWarmUnits(): void {
  const w = warmList;
  if (!w || w.stopped || drawing.warm === false || warmQueued) return;
  const n = ++warmSeq;
  warmQueued = n;
  lanes.push({
    key: WARM_UNITS_KEY,
    chain: WARM_UNITS_KEY,
    rank: RANK.bulk,
    gate: fonts$,
    run: async (s) => {
      try {
        await warmUnits(w, s);
      } finally {
        if (warmQueued === n) warmQueued = 0;
      }
    },
  });
}

/** Stop the warm-up's lane job (it stops at its next turn); `queueWarmUnits` goes on from its slide. */
function stopWarmUnits(): void {
  if (!warmQueued) return;
  warmQueued = 0;
  lanes.cancel([WARM_UNITS_KEY]);
  endTurnWaits([WARM_UNITS_KEY]);
}

/**
 * Make the units of the live playlist's slides, in cue order from the live cue, unpinned, until the unit cache
 * holds `WARM_UNITS_BYTES` (two thirds of it): after each slide, the nearer cues' units are used last, so they
 * are evicted last. A live job cancels this (`onJobMessage`) and it goes on from the slide it was at.
 */
async function warmUnits(w: NonNullable<typeof warmList>, steps: Steps): Promise<void> {
  const scale = width / LOGICAL_WIDTH;
  const full = () => unitCache.bytes('unit') >= WARM_UNITS_BYTES;
  /** Keys warmed so far, nearest cue first. */
  const kept: string[] = [];
  while (w.next < w.job.slides.length && warmList === w) {
    if (full()) {
      w.stopped = 'full';
      break;
    }
    const { cueIndex, slide, images: slideImages } = w.job.slides[w.next]!;
    const host = jobHost(steps);
    unitJob(host, { stop: full, afterTurn: turnWait(WARM_UNITS_KEY) });
    // A raw slide is its own uncut one: a crowded slide is split here as its jobs split it (one key for every path).
    const fj = { slide, full: slide, look: w.job.look, images: slideImages };
    const split = frameOf(fj, scale);
    await prepareSlides(prepareJobOf(fj, split, scale, steps), host);
    const ready = await steps.slice(() => {
      const plan = unitsOfSlide(split ? split.direct : slide, scale, w.job.look);
      const have = plan.filter((u) => unitCache.has('unit', u.key));
      for (const u of have) kept.push(u.key);
      let made = have.length;
      let units = plan.length;
      if (split) {
        units++;
        const k = frameKey(split, fontEpoch);
        if (unitCache.has('unit', k)) {
          made++;
          kept.push(k);
        }
      }
      for (let i = kept.length - 1; i >= 0; i--) unitCache.get('unit', kept[i]!);
      return { units, ready: made };
    });
    w.next++;
    if (w.next >= w.job.slides.length) w.stopped = 'done';
    post({
      t: 'unitsWarmed',
      key: w.job.key,
      cueIndex,
      ...ready,
      ...(w.stopped ? { stopped: w.stopped } : {}),
      unitCacheBytes: unitCache.bytes('unit'),
      unitsMade: unitWork().made,
    });
  }
  if (w.stopped === 'full')
    post({
      t: 'unitsWarmed',
      key: w.job.key,
      cueIndex: w.job.slides[w.next]?.cueIndex ?? -1,
      units: 0,
      ready: 0,
      stopped: 'full',
      unitCacheBytes: unitCache.bytes('unit'),
      unitsMade: unitWork().made,
    });
}

/**
 * The geometry units (prepare/units.ts) held for each layer's last live and armed slide job and for the last warm
 * job: a cue's units stay pinned while it is armed or warmed (made there, so its GO does no unit work), and are
 * let go when the next job of the same kind holds its own.
 */
const heldUnits = new Map<string, UnitHold>();
/** How many holds each chain kept so far (a restart's `units` job takes its chain only while it is unchanged). */
const heldSeq = new Map<string, number>();

/**
 * Keep `hold` as `chain`'s, letting the older one go. A late job still pinning into the older one (`LateJob`): on a
 * layer's live chain it stops (its slide left the screen), on any other it keeps that hold itself until it ends.
 */
function keepUnits(chain: string, hold: UnitHold): void {
  const old = heldUnits.get(chain);
  heldUnits.set(chain, hold);
  heldSeq.set(chain, (heldSeq.get(chain) ?? 0) + 1);
  if (!old || old === hold) return;
  const live = chain.endsWith(' live');
  for (const [k, late] of lateJobs) {
    if (late.hold !== old || late.ended || late.stopped || late.owns) continue;
    if (live) {
      late.stopped = true;
      endTurnWaits([lateKey(k)]);
    } else {
      late.owns = true;
      return;
    }
  }
  old.release();
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
  late: ((key: string) => void) | undefined,
  under?: UnderFrame,
): (SceneParts & { base: DrawnSprite<ImageBitmap> }) | undefined {
  const v = job.video;
  if (!v) return undefined;
  const opts = {
    nextSlide: job.nextSlide,
    isSong: job.isSong,
    presentationKind: job.presentationKind,
    clip: { w: v.w, h: v.h },
    ...(late ? { late } : {}),
    // The underlay frame is below the video: the scene's base takes it, never its over.
    ...(under ? { under } : {}),
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
async function run(job: AssetJob, steps: Steps, role?: JobRole): Promise<void> {
  const t0 = performance.now();
  const w = width;
  const h = height;
  const out = { w, h };
  const scale = w / LOGICAL_WIDTH;
  let skipped = 0;
  let missing: string[] = [];
  let release: (() => void) | undefined;
  let units: UnitHold | undefined;
  let unitsMade: UnitJob | undefined;
  /** The slide a slide job draws: its direct part when the slide has an underlay frame. */
  let drawn: Slide | undefined;
  /** A draw cut without rule (e): its late job works the whole split out (`lateUnits`). */
  let approx: Approx | undefined;
  // Units the raster left out until they are made (C2b, `SlideDrawOptions.late`: a decoration past
  // DECOR_SPRITE drawn at once is one task of up to about 115 ms at 3840): they go to the late job and fade in.
  // With `?late=next` nothing fades in, so nothing is left out: such a decoration is drawn at once (repair 3).
  const leftOut: string[] = [];
  const late =
    (drawing.late ?? LATE_UNIT) === 'fade'
      ? (key: string) => {
          if (!leftOut.includes(key)) leftOut.push(key);
        }
      : undefined;
  try {
    let draw: () => Drawn;
    if (job.kind === 'slide') {
      // Prepare steps first (geometry files): a masked picture is prepared with its mask's paths, and the
      // slide's reach and drawing budget are worked out with them; then its geometry units, pinned. Only an
      // armed job waits for its units, until its cue goes live (`hurry`); a live job and a re-draw never do.
      const waits = (role ?? 'armed') === 'armed';
      // A live job is cut by the counts alone (no rule (e): its late job works the rest out, `lateUnits`).
      const area = role !== 'live';
      const prep = await prepare(job, scale, steps, {
        key: job.key,
        stop: () => !waits || hurried.has(job.key) || rushed.has(job.key),
        area,
      });
      units = prep.units;
      unitsMade = prep.made;
      const geoms = prep.missing;
      // A slide with an underlay frame (`frame.ts`) is drawn as its direct part, the frame copied under it: the
      // frame's pictures are the frame's (one at a time), the preload holds the direct part's.
      const split = prep.split;
      const sj: SlideJob = split
        ? { ...job, slide: split.direct, images: directImages(job.images, split.direct, job.nextSlide) }
        : job;
      drawn = sj.slide;
      const under = split ? underFrame(split, fontEpoch) : undefined;
      if (!area && (split || unitsOfSlide(sj.slide, scale, sj.look).length)) {
        const fk = split ? frameKey(split, fontEpoch) : undefined;
        approx = {
          slide: sj.slide,
          ...(fk ? { frame: fk } : {}),
          copied: !!fk && !(prep.made?.left ?? []).includes(fk),
        };
      }
      const pre = await preload(sj.images, slidePictures(sj.slide, { scale, look: sj.look }), out, steps);
      release = pre.release;
      skipped = pre.skipped;
      missing = geoms.length ? [...pre.missing, ...geoms] : pre.missing;
      draw = () => {
        const scene = sceneParts(sj, out, scale, pre.lookup, late, under);
        if (scene) return { main: scene.base, scene };
        const opts = {
          nextSlide: sj.nextSlide,
          isSong: sj.isSong,
          presentationKind: sj.presentationKind,
          ...(late ? { late } : {}),
          ...(under ? { under } : {}),
        };
        const reach = slideReach(measure(), sj.slide, { scale, look: sj.look, ...opts });
        return {
          main: sprite(reach, scale, out, (c) => rasterSlide(c, sj.slide, sj.look, scale, pre.lookup, opts)),
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
    // Drawn: its units stay pinned while it is its layer's last job of its role (live or armed): a hurried job's
    // cue is live, and a re-draw's is live when it fades in (`refreshFadeMs`), else armed.
    const held =
      role === 'late'
        ? job.kind === 'slide' && job.refreshFadeMs
          ? 'live'
          : 'armed'
        : hurried.has(job.key)
          ? 'live'
          : (role ?? 'armed');
    const hold = units;
    // The units it was drawn without (their legacy copies drawn, or left out by the raster): made by its late
    // job, pinned with its own (handed on before the layer's older hold is let go).
    const left = [...(unitsMade?.left ?? [])];
    for (const k of leftOut) if (!left.includes(k)) left.push(k);
    if (hold && job.kind === 'slide') lateFor(job, left, hold, approx);
    if (units && job.kind === 'slide') keepUnits(`layer ${job.layer} ${held}`, units);
    units = undefined;
    // A slide whose content is past the raster budget by its drawing estimate (memoised by the draw, with the
    // effect sprites it made): health reports its time apart from the alarm's.
    const heavy =
      job.kind === 'slide' &&
      heavySlide({ ...slideJobCost(drawn ?? job.slide, job.look), effectsMade: made }, w, h);
    // The picture is on its way: its text is probed for coverage in slices of their own, so a props job can
    // run between them, and the job is reported done (a cancel meanwhile only skips the probe).
    let uncovered = '';
    try {
      uncovered = await probeCoverage(timing, steps);
    } catch (err) {
      if (!(err instanceof Cancelled)) throw err;
    }
    done(job, ms, timing, steps, skipped, missing, uncovered, heavy, left.length);
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
    units?.release();
    hurried.delete(job.key);
    rushed.delete(job.key);
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
  if (job.kind === 'slide' && job.refresh && job.refreshFadeMs) msg.refreshFadeMs = job.refreshFadeMs;
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
  unitsLeft = 0,
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
    unitsLeft: unitsLeft || undefined,
    unitsMade: unitWork().made,
    unitCacheBytes: unitCache.bytes('unit'),
    ...framesTelemetry(),
  });
}

/** The underlay frames' counts for a `done` message: absent while this worker has made, dropped or held none. */
function framesTelemetry(): { frames?: { made: number; over: number; workBytes: number } } {
  const f = frameStats();
  const workBytes = frameWorkBytes();
  return f.made || f.over || workBytes ? { frames: { made: f.made, over: f.over, workBytes } } : {};
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
    // Its prepare steps first, as its slide job runs them: a masked picture is prepared cut to its mask, and
    // its geometry units are made and stay pinned until the next warm job (arming it then makes none). A GO to
    // its cue meanwhile stops its waiting (`hurry`): the live job draws at once and its late job goes on.
    const prep = await prepare(wj, scale, steps, { key: wj.key, stop: () => hurried.has(wj.key) });
    keepUnits('warm', prep.units);
    // The direct part's pictures are the cue's; a frame's are made one at a time inside the step above.
    const direct = prep.split ? prep.split.direct : wj.slide;
    const pre = await preloadPictures(
      images,
      jobDecoder(steps),
      prep.split ? directImages(wj.images, direct, wj.nextSlide) : wj.images,
      slidePictures(direct, { scale, look: wj.look }),
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

/** A job's rank in the lanes: props first, then the live cue's layers, then the armed cue's, then re-draws. */
function rankOf(job: AssetJob, role: JobRole | undefined): number {
  if (job.kind === 'props') return RANK.props;
  return role === 'live' ? RANK.live : role === 'late' ? RANK.late : RANK.armed;
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
      if (m.role === 'live') {
        // The slides this layer showed before left the screen: their late units are not made now.
        const gone: string[] = [];
        for (const [k, l] of lateJobs)
          if (l.layer === job.layer && k !== job.key) {
            dropLate(k, l);
            gone.push(lateKey(k));
          }
        if (gone.length) {
          lanes.cancel(gone);
          endTurnWaits(gone);
        }
        // A GO stops the warm-up: it goes on once the live work is done (bulk waits for it).
        if (warmQueued) {
          stopWarmUnits();
          queueWarmUnits();
        }
        // A jump while another cue of the layer stays armed: the armed job it would start after stops waiting for
        // units (`rushed`), so the jump is drawn within a unit turn, not after the arm's UNIT_WAIT_MS.
        const pending = new Set(Object.values(lanes.keys()).flat());
        for (const k of armedSlides.keys()) if (!pending.has(k)) armedSlides.delete(k);
        const rush = lanes
          .ahead(`layer ${job.layer}`, RANK.live)
          .filter((k) => k !== job.key && armedSlides.get(k) === job.layer);
        for (const k of rush) rushed.add(k);
        endTurnWaits(rush);
      }
      if (job.kind === 'slide' && (m.role ?? 'armed') === 'armed') armedSlides.set(job.key, job.layer);
      // Each layer is a chain: its content reaches the renderer in the order its stacks expect.
      lanes.push({
        key: job.key,
        chain: `layer ${job.layer}`,
        rank: rankOf(job, m.role),
        gate: fonts$,
        run: (steps) => run(job, steps, m.role),
      });
      return;
    }
    case 'warm': {
      const wj = m.warm;
      lanes.push({
        key: wj.key,
        chain: 'warm',
        rank: RANK.bulk,
        gate: fonts$,
        run: (s) => warmUp(wj, s).finally(() => hurried.delete(wj.key)),
      });
      return;
    }
    case 'warmUnits':
      warmList = { job: m.warm, next: 0 };
      stopWarmUnits();
      queueWarmUnits();
      return;
    case 'units': {
      // After an asset worker restart: a held slide's parts made again before it is drawn again.
      const job = m.job;
      const running = lateJobs.get(job.key);
      if (job.kind !== 'slide' || (running && !running.ended && !running.stopped)) return;
      // Its slide's late job from now on (pending until planned): a live job of another slide drops it.
      const late: LateJob = {
        layer: job.layer,
        hold: NO_HOLD,
        outstanding: new Set(),
        grew: false,
        fresh: [],
        last: performance.now(),
        ended: false,
        owns: false,
        stopped: false,
        pending: true,
      };
      lateJobs.set(job.key, late);
      const role = m.role;
      const seq = heldSeq.get(`layer ${job.layer} ${role}`) ?? 0;
      lanes.push({
        key: lateKey(job.key),
        chain: 'late',
        rank: RANK.late,
        gate: fonts$,
        run: (s) => remakeUnits(job, role, late, seq, s),
      });
      return;
    }
    case 'hurry': {
      // Only jobs still queued or running: a hurry that arrives after its job is forgotten.
      const pending = new Set(Object.values(lanes.keys()).flat());
      const keys = m.keys.filter((k) => pending.has(k));
      for (const k of keys) hurried.add(k);
      endTurnWaits(keys);
      return;
    }
    case 'cancel':
      lanes.cancel(m.keys);
      endTurnWaits(m.keys);
      for (const k of m.keys) {
        hurried.delete(k);
        rushed.delete(k);
      }
      return;
    case 'prune':
      images.prune(new Set(m.keep));
      return;
    default:
      return;
  }
}

/** The output's drawing switches (`init`). */
function applyDrawing(d: DrawingSwitches): void {
  drawing = {
    ...(d.late === 'next' || d.late === 'fade' ? { late: d.late } : {}),
    ...(d.warm === false ? { warm: false } : {}),
    ...(d.effects === 'base' ? { effects: 'base' as const } : {}),
    ...(d.frame === 'off' ? { frame: 'off' as const } : {}),
    ...(typeof d.unitTurnMs === 'number' && d.unitTurnMs > 0
      ? { unitTurnMs: Math.min(d.unitTurnMs, 5000) }
      : {}),
  };
  if (drawing.warm === false) stopWarmUnits();
  // C6: `?effects=base` draws effects and decorations as 62a1c3a did (geometry units only); each init sets it.
  setEffectUnits(drawing.effects !== 'base');
  // `?frame=off` draws a slide past a count cut as before the underlay frame; `?effects=base` promises 62a1c3a's drawing.
  setFrames(drawing.frame !== 'off' && drawing.effects !== 'base');
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
      applyDrawing(m.drawing ?? {});
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
      // The switches this worker draws with, for the link's diagnostics.
      post({ t: 'drawing', switches: drawing });
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
