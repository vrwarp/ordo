import { LOGICAL_HEIGHT, LOGICAL_WIDTH, type Slide, type SlideObject, slideContent } from '@ordo/domain';
import { BAKE_MAX_OBJECTS, clampSlide } from './clamp.ts';
import {
  awaitedFiles,
  forgetFrame,
  frameKey,
  frameMissing,
  frameStats,
  type FramePictures,
  makeFrame,
  underFrame,
  underSlides,
  type WholeOptions,
  wholeSplit,
} from './frame.ts';
import { loadShapeDrawers, registerShapeDrawerLoader, shapeDrawersWanted } from './shape.ts';
import { drawSlide2D } from './text2d.ts';
import { type BlankFace, registerBlankFace } from './text/blankface.ts';
import { contextMetrics, GlyphCoverage } from './text/coverage.ts';
import {
  currentFontEnv,
  type FontHost,
  FontResolver,
  installFontEnv,
  LEGACY_FONT_ENV,
} from './text/fonts.ts';
import { canvas2d, type UnitRun } from './units.ts';

/*
 * The bake (design 29 sections 1.2 and 1.4, sub-wave 3): the whole slide drawn once as one 3840x2160 picture with
 * the drawing code the screens use, with ordo's own fonts only, encoded exactly and checked before anything is
 * uploaded. It runs in the bake worker on a desktop, never on a GO's path and never in a service (the worker's
 * rule); the screens never call it.
 *
 * COMPLETE OR NOTHING. A picture is made only when every object of the slide was drawn: a character no loaded face
 * covers (also in text inside a shadow, a glow, a gradient or a table cell), a face that failed to load, a family
 * with no face at all, a picture or geometry file that is not there, an object whose draw threw, an animated object
 * (a playing picture, a hidden paragraph), more than `BAKE_MAX_OBJECTS` objects, a font set that changed while it
 * ran, a cancelled or overlong bake and a blank result each end it with a named reason (`BakeReason`) and leave
 * nothing behind (no frame in progress, no work bytes, no unit-cache entry). A bake never throws for a bad slide.
 *
 * What it draws is what the key hashes (`drawnPart`, packages/domain prerender.ts): `wholeSplit`'s under objects
 * (the live set left out), the slide's own picture (a reference picture or an imported page), contain-fitted under
 * them. The slide's own BACKGROUND is a layer of its own and is never drawn here (Q25.c.b). Text is drawn with the
 * bake font profile (text/fonts.ts): the library's and the bundled faces and a blank face last, never a face of
 * the computer that makes the picture.
 *
 * This file is NOT in the barrel: it imports frame.ts, whose import registers the slide objects' drawer, so the
 * operator's main thread must not carry it (the barrel exports its types only). The bake worker imports it by
 * subpath (`@ordo/renderer/bake.ts`).
 */

/** The frame every picture is made at: the domain's `PRERENDER_FRAME` (a test holds them equal). */
export const BAKE_FRAME = { width: 3840, height: 2160, scale: 2 } as const;
/** The picture sizes (widths): the hub's `PICTURE_SIZES` (apps/hub/src/prerenders.ts; a test holds them equal). */
export const BAKE_SIZES = [3840, 1920, 640] as const;
/** The order the pictures are uploaded in (the 1080p copy first: most screens draw it). */
export const BAKE_UPLOAD_ORDER = [1920, 3840, 640] as const;
/** The largest picture file: the hub's `PICTURE_MAX_BYTES` (a test holds them equal). */
export const BAKE_MAX_PICTURE_BYTES = 32 * 1024 * 1024;
/** The time a bake may take (Q38.a: 60 s; a measure of the 300-photo slide may raise it, never above the maximum). */
export const BAKE_DEADLINE_MS = 60_000;
/** The most a `deadlineMs` may ask for (Q38.a). */
export const BAKE_DEADLINE_MAX_MS = 180_000;
/** The quality of the 640 preview, the one picture that is not exact (Q31.a). */
export const BAKE_PREVIEW_QUALITY = 0.8;

/**
 * Why no picture was made (C-BR7). `time`, `cancelled`, `busy` and `fonts` are not faults of the slide (try again);
 * `font`, `coverage`, `media` and `files` name what to fix; `animated` and `cut` mean the slide should not have a
 * record; `draw`, `frame`, `canvas`, `blank`, `verify` and `profile` are faults of ordo and are logged.
 */
export type BakeReason =
  | 'profile'
  | 'busy'
  | 'animated'
  | 'cut'
  | 'files'
  | 'font'
  | 'coverage'
  | 'media'
  | 'draw'
  | 'fonts'
  | 'frame'
  | 'canvas'
  | 'blank'
  | 'time'
  | 'cancelled'
  | 'size'
  | 'verify';

/** The bake's font environment: the bake resolver, the coverage probe, the blank face (`createBakeEnv`). */
export interface BakeEnv {
  readonly fonts: FontResolver;
  readonly coverage: GlyphCoverage;
  readonly blank: BlankFace;
  /** Settles once the blank face has loaded: true when the probe can judge coverage. Await it before a bake. */
  ready(): Promise<boolean>;
  /** Restore the live font environment, stop retries and take the text-call wrap off the contexts. */
  dispose(): void;
}

/** Times and counts of one bake (and of its encode: `encodePicture` adds its phases). Milliseconds. */
export interface BakeStats {
  ms: Record<string, number>;
  /** Objects drawn into the frame. */
  objects: number;
  /** Turns the frame was made in, and the longest turn (ms). */
  turns: number;
  longestTurn: number;
}

/** What a bake is given. */
export interface BakeOptions {
  readonly env: BakeEnv;
  /** Where the pictures come from (the output's `framePictures`; a test provider). One at a time. */
  readonly pictures: FramePictures;
  /** Ids of objects left out (the live set above the picture: Q24.a's hook). Default: the raw slide's record. */
  readonly live?: readonly string[];
  /** Device px per logical px: 2 (3840 wide) unless a test or a bench asks for 1. */
  readonly scale?: number;
  /** The wall limit, ms (default `BAKE_DEADLINE_MS`, at most `BAKE_DEADLINE_MAX_MS`). */
  readonly deadlineMs?: number;
  /** True once the bake is cancelled (Go live pressed, a newer edit): it ends between turns. */
  readonly cancelled?: () => boolean;
  /** `'allow'` (Q31.c, the default): a family with no face of its own is drawn in ordo's default face and listed. */
  readonly standIns?: 'allow' | 'abort';
  /** Turn length before the bake yields to the event loop (default 20 ms). */
  readonly yieldMs?: number;
  /** The clock (tests). */
  readonly now?: () => number;
}

/** A slide drawn: the canvas (hand it to `encodePicture`, which takes it over), whether it is opaque, what was replaced. */
export interface BakeMade {
  readonly ok: true;
  readonly canvas: OffscreenCanvas;
  /** Every pixel is fully opaque: the encoder writes an RGB PNG, so the hub's flag (the header's) agrees. */
  readonly opaque: boolean;
  readonly width: number;
  readonly height: number;
  /** Families (lower-cased) drawn in the default face for want of a face of their own (Q31.c). */
  readonly standIns: readonly string[];
  /** Raw objects the clamp did not keep (unknown or unusable ones; the live draw drops them too). */
  readonly dropped: number;
  readonly stats: BakeStats;
}

/** No picture, and why. */
export interface BakeFailure {
  readonly ok: false;
  readonly reason: BakeReason;
  /** A short plain detail (`failureText` bounds it): families, characters, a file hash, an object id. */
  readonly detail: string;
  readonly standIns?: readonly string[];
  readonly stats: BakeStats;
}

export type BakeResult = BakeMade | BakeFailure;

/** The failure line the hub keeps (`POST .../failed`: at most 200 characters, its own bound). Never slide text. */
export function failureText(f: { reason: BakeReason; detail: string }): string {
  const text = f.detail ? `${f.reason}: ${f.detail}` : f.reason;
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}

// ── The environment ──────────────────────────────────────────────────────────────────────────────────────

type TextProto = { fillText: (...a: unknown[]) => unknown; strokeText: (...a: unknown[]) => unknown };
const sinks = new Set<GlyphCoverage>();
let wrapped: { proto: TextProto; fill: TextProto['fillText']; stroke: TextProto['strokeText'] } | undefined;

/**
 * Note every `fillText` and `strokeText` of every 2D context of this thread for `coverage`: the prototype's, once
 * (a marker on the module makes it idempotent), because a frame draws on scratch canvases made inside `makeFrame`
 * and `makeUnitPicture`, and text inside a shadow, a glow, a gradient or a table layer is drawn on yet other
 * canvases: wrapping one context instance (the asset worker's way) would see none of them. Returns the restore.
 */
function noteTextCalls(coverage: GlyphCoverage): () => void {
  const C = (globalThis as { OffscreenCanvasRenderingContext2D?: { prototype: TextProto } })
    .OffscreenCanvasRenderingContext2D;
  if (!C) return () => undefined;
  sinks.add(coverage);
  if (!wrapped) {
    const proto = C.prototype;
    const fill = proto.fillText;
    const stroke = proto.strokeText;
    proto.fillText = function (this: { font: string }, text: unknown, ...rest: unknown[]) {
      if (typeof text === 'string') for (const s of sinks) s.note(this.font, text);
      return fill.call(this, text, ...rest);
    };
    proto.strokeText = function (this: { font: string }, text: unknown, ...rest: unknown[]) {
      if (typeof text === 'string') for (const s of sinks) s.note(this.font, text);
      return stroke.call(this, text, ...rest);
    };
    wrapped = { proto, fill, stroke };
  }
  return () => {
    sinks.delete(coverage);
    if (sinks.size || !wrapped) return;
    wrapped.proto.fillText = wrapped.fill;
    wrapped.proto.strokeText = wrapped.stroke;
    wrapped = undefined;
  };
}

// The drawers a slide may need are loaded by `bakeSlide` itself (`loadShapeDrawers`): a worker that imports this file
// by subpath, without the barrel, still draws tables and decorations (the barrel registers the same two loaders).
registerShapeDrawerLoader('table', () => import('./table/index.ts'));
registerShapeDrawerLoader('decor', () => import('./decor/index.ts'));

/**
 * The bake's font environment over `host` (the faces of the library and the bundled ones, as file URLs or bytes):
 * a resolver in the bake profile with the blank face last, installed as the thread's font environment
 * (`installFontEnv`); the blank face registered in the host's face set; a coverage probe over a 1x1 context; and the
 * text-call wrap that feeds it. Await `ready()` before the first bake and `fonts.sync(files)` with the face list the
 * key was computed from (the library's and the bundled faces).
 */
export function createBakeEnv(host: FontHost): BakeEnv {
  const blank = registerBlankFace(host.set);
  const fonts = new FontResolver(host, { profile: 'bake', blank: { family: blank.family } });
  const probe =
    typeof OffscreenCanvas === 'undefined' ? undefined : new OffscreenCanvas(1, 1).getContext('2d');
  const coverage = new GlyphCoverage(probe ? contextMetrics(probe) : () => [], blank);
  installFontEnv(fonts);
  const stopFonts = fonts.onChange(() => coverage.reset());
  const restore = noteTextCalls(coverage);
  return {
    fonts,
    coverage,
    blank,
    async ready() {
      await blank.loaded;
      return blank.ready;
    },
    dispose() {
      stopFonts();
      restore();
      fonts.dispose();
      if (currentFontEnv() === fonts) installFontEnv(LEGACY_FONT_ENV);
    },
  };
}

// ── What the prepare steps need ──────────────────────────────────────────────────────────────────────────

/**
 * The slide the bake draws on top of its frame, and the frame's objects cut into slides of the live counts, for the
 * output's prepare steps (`jobSlides({ slide }, under)`: every geometry file, decoration file and drawer is made
 * ready like any slide's): `slide` holds the slide's own picture and no objects.
 */
export function bakeSlides(slide: Slide, opts: WholeOptions = {}): { slide: Slide; under: readonly Slide[] } {
  return { slide: pictureOnly(slide), under: underSlides(wholeSplit(slide, BAKE_FRAME.scale, opts)) };
}

function pictureOnly(slide: Slide): Slide {
  return { ...clampSlide(slide, 'bake'), objects: [] };
}

// ── The bake ─────────────────────────────────────────────────────────────────────────────────────────────

/** Where a stop between turns comes from. */
class BakeStop extends Error {
  readonly reason: BakeReason;
  readonly detail: string;
  constructor(reason: BakeReason, detail: string) {
    super(detail);
    this.reason = reason;
    this.detail = detail;
  }
}

/** The slide's own picture, as an image object the provider can decode (a contain-fit of the whole frame). */
function slidePictureObject(mediaId: string): Extract<SlideObject, { type: 'image' }> {
  return {
    id: 'slide-picture',
    type: 'image',
    box: { x: 0, y: 0, w: LOGICAL_WIDTH, h: LOGICAL_HEIGHT, rotation: 0 },
    mediaId,
    fit: 'contain',
    opacity: 1,
    radius: 0,
  } as Extract<SlideObject, { type: 'image' }>;
}

/** The id of the first object a picture cannot show: a playing picture, or a text with a hidden paragraph. */
function animatedObject(objects: readonly SlideObject[]): { id: string; what: string } | undefined {
  for (const o of objects) {
    if (o.type === 'image' && o.play) return { id: o.id, what: 'a playing picture' };
    if (o.type === 'text' && o.paras?.some((p) => p?.hidden === true))
      return { id: o.id, what: 'a hidden paragraph' };
  }
  return undefined;
}

/** The scale a bake runs at: the option when it is a positive number (at most 4), else the frame's own (2). */
export function bakeScale(scale: number | undefined): number {
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0
    ? Math.min(scale, 4)
    : BAKE_FRAME.scale;
}

/** The wall limit of a bake, ms: the option clamped to 1 ms and `BAKE_DEADLINE_MAX_MS` (Q38.a), default `BAKE_DEADLINE_MS`. */
export function bakeDeadline(ms: number | undefined): number {
  const asked = typeof ms === 'number' && Number.isFinite(ms) ? ms : BAKE_DEADLINE_MS;
  return Math.min(Math.max(1, asked), BAKE_DEADLINE_MAX_MS);
}

let flying = false;

const sleep0 = () => new Promise<void>((r) => setTimeout(r, 0));

/** At most `n` names, joined, for a detail. */
const names = (list: readonly string[], n = 4) =>
  list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} and ${list.length - n} more`;

/**
 * Draw `slide` whole at `scale` (default 2: 3840x2160), complete or not at all (see the header). Resolves
 * `{ ok: true, canvas, opaque, ... }` (hand the canvas to `encodePicture`) or `{ ok: false, reason, detail, stats }`;
 * never throws for a bad slide, and one bake at a time per thread (a second concurrent call resolves `busy`).
 *
 * Preconditions the caller owes (C-BR2): `env.fonts.sync(files)` with the faces the key was computed from, the
 * prepare steps over `bakeSlides` (geometry and decoration files, table layouts), `setGeometryUnits(true)`, and
 * a provider whose `acquire` decodes the picture at the size its draw needs and reports an unreadable file as
 * `missing`.
 */
export async function bakeSlide(slide: Slide, options: BakeOptions): Promise<BakeResult> {
  const now = options.now ?? (() => performance.now());
  const t0 = now();
  const stats: BakeStats = { ms: {}, objects: 0, turns: 0, longestTurn: 0 };
  const done = (): BakeStats => {
    stats.ms.total = Math.round(now() - t0);
    return stats;
  };
  const failure = (reason: BakeReason, detail: string, standIns?: readonly string[]): BakeFailure => ({
    ok: false,
    reason,
    detail,
    ...(standIns?.length ? { standIns } : {}),
    stats: done(),
  });
  if (flying) return failure('busy', 'another bake is running');
  flying = true;
  try {
    return await bake(slide, options, now, t0, stats, done, failure);
  } finally {
    flying = false;
  }
}

async function bake(
  slide: Slide,
  options: BakeOptions,
  now: () => number,
  t0: number,
  stats: BakeStats,
  done: () => BakeStats,
  failure: (reason: BakeReason, detail: string, standIns?: readonly string[]) => BakeFailure,
): Promise<BakeResult> {
  const { env, pictures } = options;
  if (currentFontEnv() !== env.fonts || env.fonts.profile !== 'bake')
    return failure('profile', 'the bake font profile is not the installed one');
  if (!env.blank.ready) return failure('profile', 'the coverage probe is not ready');
  const raw = Array.isArray((slide as { objects?: unknown }).objects) ? slide.objects.length : 0;
  if (raw > BAKE_MAX_OBJECTS)
    return failure('cut', `${raw} objects, the most a picture holds is ${BAKE_MAX_OBJECTS}`);
  const scale = bakeScale(options.scale);
  const deadline = bakeDeadline(options.deadlineMs);
  const whole = wholeSplit(slide, scale, options.live ? { live: options.live } : {});
  // The slide's own picture (a reference picture or an imported page) is the frame's FIRST object: the objects are
  // then drawn over it one after the other, as the whole draw draws them, so the picture equals it exactly. A
  // picture composited under the finished frame would differ in the rounding of every partly transparent edge.
  const ownId = slideContent(whole.slide).pictureMediaId;
  const split = ownId ? { ...whole, under: [slidePictureObject(ownId), ...whole.under] } : whole;
  const odd = animatedObject(split.under);
  if (odd) return failure('animated', `${odd.what} (${odd.id.slice(0, 40)})`);
  await loadShapeDrawers(split.under);
  const missingDrawer = shapeDrawersWanted(split.under);
  if (missingDrawer.length) return failure('profile', `no ${missingDrawer[0]} drawer is registered`);
  const waiting = awaitedFiles(split);
  if (waiting.length)
    return failure('files', `${waiting.length} objects wait for a geometry or decoration file`);
  if (typeof OffscreenCanvas === 'undefined') return failure('canvas', 'no canvas here');

  env.fonts.bakeReset();
  const generation = env.fonts.generation;
  const key = frameKey(split, generation);
  const bare: Slide = { id: whole.slide.id, objects: [] };
  let drawn: { id: string; message: string } | undefined;
  let lastYield = now();
  const yieldMs = options.yieldMs ?? 20;
  const run: UnitRun = {
    now,
    check() {
      if (drawn) throw new BakeStop('draw', `object ${drawn.id.slice(0, 40)}: ${drawn.message}`);
      if (options.cancelled?.()) throw new BakeStop('cancelled', '');
      if (now() - t0 > deadline) throw new BakeStop('time', `more than ${Math.round(deadline / 1000)} s`);
      if (env.fonts.generation !== generation) throw new BakeStop('fonts', 'the font set changed');
    },
    async slice(fn) {
      if (now() - lastYield >= yieldMs) {
        await sleep0();
        lastYield = now();
      }
      stats.turns++;
      const t = now();
      const out = fn();
      stats.longestTurn = Math.max(stats.longestTurn, now() - t);
      return out;
    },
  };
  let made: ReturnType<typeof canvas2d>;
  let lacking: readonly string[] = [];
  let text: ReturnType<GlyphCoverage['end']> | undefined;
  env.coverage.begin();
  forgetFrame(key);
  try {
    const over = frameStats().over;
    const t1 = now();
    const longest = await makeFrame(split, key, run, {
      pictures,
      epoch: generation,
      budgetMs: deadline,
      onError: (o, err) => {
        drawn ??= { id: o.id, message: String((err as Error)?.message ?? err).slice(0, 100) };
      },
    });
    stats.ms.draw = Math.round(now() - t1);
    stats.objects = split.under.length;
    run.check();
    if (longest === undefined) {
      return frameStats().over > over
        ? failure('time', `the frame took more than ${Math.round(deadline / 1000)} s`)
        : failure('frame', 'the frame could not be made');
    }
    const t2 = now();
    made = canvas2d(split.rect.w, split.rect.h);
    if (!made) return failure('canvas', 'no canvas of the picture size');
    drawSlide2D(made.c as never, bare, { scale, under: underFrame(split, generation) });
    stats.ms.compose = Math.round(now() - t2);
    run.check();
  } catch (err) {
    if (made) made.canvas.width = 0;
    if (err instanceof BakeStop) return failure(err.reason, err.detail);
    return failure('draw', String((err as Error)?.message ?? err).slice(0, 100));
  } finally {
    // What the frame was made without, read before it is forgotten; and nothing of it is left behind.
    lacking = frameMissing(key);
    forgetFrame(key);
    text = env.coverage.end();
  }
  const canvas = made.canvas;
  const drop = (f: BakeFailure) => {
    canvas.width = 0;
    return f;
  };
  if (lacking.length) return drop(failure('media', `${lacking.length} files: ${lacking[0]!.slice(0, 16)}`));
  if (env.fonts.generation !== generation) return drop(failure('fonts', 'the font set changed'));
  const missed = env.coverage.misses(text, 32);
  if (missed) return drop(failure('coverage', missed));
  const report = env.fonts.bakeReport();
  if (report.empty.size) return drop(failure('font', `no face for ${names([...report.empty].sort())}`));
  const failed = env.fonts
    .failedFamilies()
    .filter((f) => report.chain.has(f))
    .sort();
  if (failed.length) return drop(failure('font', `a face did not load for ${names(failed)}`));
  if (options.standIns === 'abort' && report.standIns.size)
    return drop(
      failure(
        'font',
        `not in the library: ${names([...report.standIns].sort())}`,
        [...report.standIns].sort(),
      ),
    );
  if ((made.c as { isContextLost?: () => boolean }).isContextLost?.())
    return drop(failure('canvas', 'the canvas was lost'));
  const t3 = now();
  let alpha: { painted: boolean; opaque: boolean };
  try {
    alpha = await scanAlpha(made.c, canvas.width, canvas.height, run);
  } catch (err) {
    // The scan is a turn like the others: cancelled, over time or the font set changed between its bands.
    if (err instanceof BakeStop) return drop(failure(err.reason, err.detail));
    return drop(failure('draw', String((err as Error)?.message ?? err).slice(0, 100)));
  }
  stats.ms.alpha = Math.round(now() - t3);
  if (!alpha.painted) return drop(failure('blank', 'nothing is drawn'));
  const result: BakeMade = {
    ok: true,
    canvas,
    opaque: alpha.opaque,
    width: canvas.width,
    height: canvas.height,
    standIns: [...report.standIns].sort(),
    dropped: Math.max(0, raw - split.slide.objects.length),
    stats: done(),
  };
  return result;
}

/** Whether any pixel is painted and whether every one is fully opaque, read in bands of rows (no whole-frame copy). */
async function scanAlpha(
  c: OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
  run: UnitRun,
): Promise<{ painted: boolean; opaque: boolean }> {
  const rows = 64;
  let painted = false;
  let opaque = true;
  for (let y = 0; y < h; y += rows) {
    run.check();
    const band = c.getImageData(0, y, w, Math.min(rows, h - y)).data;
    for (let i = 3; i < band.length; i += 4) {
      const a = band[i]!;
      if (a !== 0) painted = true;
      if (a !== 255) opaque = false;
    }
    await run.slice(() => undefined);
  }
  return { painted, opaque };
}

// ── The encoders and the round trip ──────────────────────────────────────────────────────────────────────

/** One encoded picture, in the order of upload. */
export interface EncodedPicture {
  /** The width the hub names it by (`?size=`): 1920, 3840 or 640. */
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly type: 'image/png' | 'image/webp';
  readonly blob: Blob;
  readonly bytes: number;
}

export interface EncodeOptions {
  /** Lower the file bound (default and maximum `BAKE_MAX_PICTURE_BYTES`). */
  readonly maxBytes?: number;
  /** Pushed every canvas the encoder made (tests: all of them are zeroed when it returns). */
  readonly canvases?: OffscreenCanvas[];
  readonly now?: () => number;
}

export type EncodeResult =
  | {
      readonly ok: true;
      readonly pictures: readonly EncodedPicture[];
      readonly opaque: boolean;
      readonly stats: { ms: Record<string, number> };
    }
  | {
      readonly ok: false;
      readonly reason: 'size' | 'verify' | 'canvas';
      readonly detail: string;
      readonly stats: { ms: Record<string, number> };
    };

/** What a picture's header says (the hub reads the same bytes: apps/hub/src/prerenders.ts `readPictureHeader`). */
export interface PictureHeader {
  readonly format: 'png' | 'webp';
  readonly width: number;
  readonly height: number;
  /** PNG: colour type 4 or 6 (or a tRNS chunk); WebP: the VP8X alpha flag or a lossless alpha bit. */
  readonly alpha: boolean;
  /** PNG colour type (2: RGB, 6: RGBA), undefined for WebP. */
  readonly colorType?: number;
}

/** The header of a PNG or WebP, or undefined for anything else. */
export function readPictureHeader(b: Uint8Array): PictureHeader | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number, s: string) =>
    b.length >= o + s.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b.length >= 33 && b[0] === 0x89 && tag(1, 'PNG') && tag(12, 'IHDR')) {
    const colorType = b[25]!;
    let trns = false;
    for (let o = 8; o + 8 <= b.length && o < 4096; ) {
      const len = dv.getUint32(o);
      if (tag(o + 4, 'tRNS')) trns = true;
      if (tag(o + 4, 'IDAT') || tag(o + 4, 'IEND')) break;
      o += 12 + len;
    }
    return {
      format: 'png',
      width: dv.getUint32(16),
      height: dv.getUint32(20),
      alpha: colorType === 4 || colorType === 6 || trns,
      colorType,
    };
  }
  if (b.length >= 30 && tag(0, 'RIFF') && tag(8, 'WEBP')) {
    if (tag(12, 'VP8X'))
      return {
        format: 'webp',
        width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)),
        height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)),
        alpha: (b[20]! & 0x10) !== 0,
      };
    if (tag(12, 'VP8 '))
      return {
        format: 'webp',
        width: (b[26]! | (b[27]! << 8)) & 0x3fff,
        height: (b[28]! | (b[29]! << 8)) & 0x3fff,
        alpha: false,
      };
    if (tag(12, 'VP8L'))
      return {
        format: 'webp',
        width: 1 + (b[21]! | ((b[22]! & 0x3f) << 8)),
        height: 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10)),
        alpha: (b[24]! & 0x10) !== 0,
      };
  }
  return undefined;
}

/** The tiles the round trip compares: the four corners, a 9x6 grid and six chosen from the file's own length. */
export function tileOrigins(
  width: number,
  height: number,
  seed: number,
  size = 128,
): { x: number; y: number }[] {
  const t = Math.min(size, width, height);
  const mx = Math.max(0, width - t);
  const my = Math.max(0, height - t);
  const out: { x: number; y: number }[] = [
    { x: 0, y: 0 },
    { x: mx, y: 0 },
    { x: 0, y: my },
    { x: mx, y: my },
  ];
  for (let j = 0; j < 6; j++)
    for (let i = 0; i < 9; i++) out.push({ x: Math.round((mx * i) / 8), y: Math.round((my * j) / 5) });
  let s = seed >>> 0 || 1;
  for (let k = 0; k < 6; k++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const x = Math.floor((s / 4294967296) * (mx + 1));
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push({ x, y: Math.floor((s / 4294967296) * (my + 1)) });
  }
  return out;
}

/**
 * The round trip (D10): decode `blob` (the 3840 PNG just made) and compare 64 sampled tiles of 128x128 with the
 * canvas it was made from: exactly for an opaque picture, within 2 levels where there is alpha. The hub checks only
 * the header (the first upload wins), so this is the only line of defence against a truncated or foreign file. The
 * decoded bitmap is the only extra full-size allocation and is closed.
 */
export async function verifyPicture(
  blob: Blob,
  source: OffscreenCanvas,
  opts: { opaque: boolean },
): Promise<{ ok: true; tiles: number } | { ok: false; detail: string }> {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(blob);
    if (bitmap.width !== source.width || bitmap.height !== source.height)
      return {
        ok: false,
        detail: `decoded ${bitmap.width}x${bitmap.height}, drawn ${source.width}x${source.height}`,
      };
    const tiles = tileOrigins(source.width, source.height, blob.size);
    const t = Math.min(128, source.width, source.height);
    const a = new OffscreenCanvas(t, t).getContext('2d', { willReadFrequently: true });
    const b = new OffscreenCanvas(t, t).getContext('2d', { willReadFrequently: true });
    if (!a || !b) return { ok: false, detail: 'no canvas to compare with' };
    const limit = opts.opaque ? 0 : 2;
    for (const { x, y } of tiles) {
      a.clearRect(0, 0, t, t);
      b.clearRect(0, 0, t, t);
      a.drawImage(bitmap, x, y, t, t, 0, 0, t, t);
      b.drawImage(source, x, y, t, t, 0, 0, t, t);
      const da = a.getImageData(0, 0, t, t).data;
      const db = b.getImageData(0, 0, t, t).data;
      for (let i = 0; i < da.length; i++)
        if (Math.abs(da[i]! - db[i]!) > limit)
          return { ok: false, detail: `the picture differs at ${x},${y}` };
    }
    return { ok: true, tiles: tiles.length };
  } catch (err) {
    return {
      ok: false,
      detail: `could not decode it: ${String((err as Error)?.message ?? err).slice(0, 80)}`,
    };
  } finally {
    bitmap?.close();
  }
}

// The RGB PNG writer. Chromium writes colour type 6 (RGBA) for every canvas, an opaque one included, and the hub
// reads the `opaque` flag from the PNG header (apps/hub/src/prerenders.ts `readPictureHeader`), so an opaque picture
// is written here as colour type 2: IHDR, one IDAT of the zlib stream (the platform's `CompressionStream`) over the
// scanlines read from the canvas in bands, each with the cheapest of the None, Sub and Up filters (libpng's rule of
// the smallest sum of absolute values), and IEND.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: readonly Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32([out.subarray(4, 8), data]));
  return out;
}

/** The scanline `row` of `w` pixels as filter byte + RGB, with the filter that gives the smallest sum. */
function filteredRow(
  rgba: Uint8ClampedArray,
  at: number,
  w: number,
  prev: Uint8Array | undefined,
  out: Uint8Array,
): Uint8Array {
  const n = w * 3;
  const cur = new Uint8Array(n);
  for (let x = 0, i = at, o = 0; x < w; x++, i += 4, o += 3) {
    cur[o] = rgba[i]!;
    cur[o + 1] = rgba[i + 1]!;
    cur[o + 2] = rgba[i + 2]!;
  }
  const cost = (b: number) => (b < 128 ? b : 256 - b);
  let none = 0;
  let sub = 0;
  let up = 0;
  for (let i = 0; i < n; i++) {
    none += cost(cur[i]!);
    sub += cost((cur[i]! - (i >= 3 ? cur[i - 3]! : 0)) & 0xff);
    up += cost((cur[i]! - (prev ? prev[i]! : 0)) & 0xff);
  }
  const type = none <= sub && none <= up ? 0 : sub <= up ? 1 : 2;
  out[0] = type;
  for (let i = 0; i < n; i++)
    out[1 + i] =
      type === 0
        ? cur[i]!
        : type === 1
          ? (cur[i]! - (i >= 3 ? cur[i - 3]! : 0)) & 0xff
          : (cur[i]! - (prev ? prev[i]! : 0)) & 0xff;
  prevRows.set(out, cur);
  return cur;
}
const prevRows = new WeakMap<Uint8Array, Uint8Array>();

/** An opaque canvas as an RGB PNG (colour type 2, 8 bits). */
async function encodeRgbPng(c: OffscreenCanvas): Promise<Blob> {
  const w = c.width;
  const h = c.height;
  const ctx = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('no 2D context');
  const chunks: Uint8Array[] = [];
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const drained = (async () => {
    const reader = cs.readable.getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      chunks.push(r.value);
    }
  })();
  const rows = 64;
  const line = new Uint8Array(1 + w * 3);
  let prev: Uint8Array | undefined;
  for (let y0 = 0; y0 < h; y0 += rows) {
    const n = Math.min(rows, h - y0);
    const band = ctx.getImageData(0, y0, w, n).data;
    const buf = new Uint8Array(n * (1 + w * 3));
    for (let r = 0; r < n; r++) {
      prev = filteredRow(band, r * w * 4, w, prev, line);
      buf.set(line, r * (1 + w * 3));
    }
    await writer.write(buf);
  }
  await writer.close();
  await drained;
  let total = 0;
  for (const k of chunks) total += k.length;
  const idat = new Uint8Array(total);
  for (let o = 0, i = 0; i < chunks.length; o += chunks[i]!.length, i++) idat.set(chunks[i]!, o);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return new Blob(
    [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', idat),
      pngChunk('IEND', new Uint8Array(0)),
    ],
    { type: 'image/png' },
  );
}

/**
 * Encode a bake as the three pictures the hub keeps (Q31.a): an exact PNG at 3840x2160, a 1920x1080 copy made once
 * from the canvas with high-quality smoothing, and a 640x360 WebP preview (the one picture that is slightly
 * compressed, drawn by no screen). An opaque picture is written as an RGB PNG (colour type 2) because the hub's
 * `opaque` flag is read from the PNG header, not from pixels (D7); one with transparency as the browser's RGBA PNG
 * (colour type 6). Every file is at most `BAKE_MAX_PICTURE_BYTES` (`size`), and the 3840 PNG is decoded and compared
 * with the canvas before anything is returned (`verify`). Takes the made canvas over: it and every canvas made here
 * have width 0 when this returns. In upload order.
 */
export async function encodePicture(made: BakeMade, opts: EncodeOptions = {}): Promise<EncodeResult> {
  const now = opts.now ?? (() => performance.now());
  const ms: Record<string, number> = {};
  const canvases: OffscreenCanvas[] = [];
  const track = (c: OffscreenCanvas) => {
    canvases.push(c);
    opts.canvases?.push(c);
    return c;
  };
  const source = track(made.canvas);
  const fail = (reason: 'size' | 'verify' | 'canvas', detail: string): EncodeResult => ({
    ok: false,
    reason,
    detail,
    stats: { ms },
  });
  const maxBytes = Math.min(opts.maxBytes ?? BAKE_MAX_PICTURE_BYTES, BAKE_MAX_PICTURE_BYTES);
  try {
    const w = made.width;
    const h = made.height;
    const make = (
      cw: number,
      ch: number,
    ): { canvas: OffscreenCanvas; c: OffscreenCanvasRenderingContext2D } => {
      const canvas = track(new OffscreenCanvas(cw, ch));
      const c = canvas.getContext('2d', { willReadFrequently: true });
      if (!c) throw new Error('no 2D context');
      return { canvas, c: c as OffscreenCanvasRenderingContext2D };
    };
    const png = (c: OffscreenCanvas) =>
      made.opaque ? encodeRgbPng(c) : c.convertToBlob({ type: 'image/png' });
    const t4 = now();
    const big = await png(source);
    ms.png3840 = Math.round(now() - t4);
    const t5 = now();
    const w1 = Math.round(w / 2);
    const h1 = Math.round(h / 2);
    const half = make(w1, h1);
    half.c.imageSmoothingQuality = 'high';
    half.c.drawImage(source, 0, 0, w1, h1);
    ms.copy1920 = Math.round(now() - t5);
    const t6 = now();
    const mid = await png(half.canvas);
    ms.png1920 = Math.round(now() - t6);
    const t7 = now();
    const w2 = Math.round(w / 6);
    const h2 = Math.round(h / 6);
    const small = make(w2, h2);
    small.c.imageSmoothingQuality = 'high';
    small.c.drawImage(half.canvas, 0, 0, w2, h2);
    const preview = await small.canvas.convertToBlob({ type: 'image/webp', quality: BAKE_PREVIEW_QUALITY });
    ms.webp640 = Math.round(now() - t7);
    for (const [name, blob] of [
      ['3840 PNG', big],
      ['1920 PNG', mid],
      ['640 preview', preview],
    ] as const)
      if (blob.size > maxBytes) return fail('size', `${name} is ${blob.size} bytes, the most is ${maxBytes}`);
    const pictures: EncodedPicture[] = [
      { size: w1, width: w1, height: h1, type: 'image/png', blob: mid, bytes: mid.size },
      { size: w, width: w, height: h, type: 'image/png', blob: big, bytes: big.size },
      { size: w2, width: w2, height: h2, type: 'image/webp', blob: preview, bytes: preview.size },
    ];
    for (const p of pictures) {
      const head = readPictureHeader(new Uint8Array(await p.blob.slice(0, 4096).arrayBuffer()));
      const want = p.type === 'image/png' ? 'png' : 'webp';
      if (!head || head.format !== want || head.width !== p.width || head.height !== p.height)
        return fail(
          'verify',
          `the ${p.size} picture's header is ${head ? `${head.width}x${head.height} ${head.format}` : 'not a picture'}`,
        );
      if (p.type === 'image/png' && made.opaque && head.colorType !== 2)
        return fail('verify', `an opaque picture was written as colour type ${head.colorType}`);
      if (p.type === 'image/png' && !made.opaque && head.colorType !== 6)
        return fail('verify', `a picture with transparency was written as colour type ${head.colorType}`);
    }
    const t8 = now();
    const checked = await verifyPicture(big, source, { opaque: made.opaque });
    ms.verify = Math.round(now() - t8);
    if (!checked.ok) return fail('verify', checked.detail);
    return { ok: true, pictures, opaque: made.opaque, stats: { ms } };
  } catch (err) {
    return fail('canvas', String((err as Error)?.message ?? err).slice(0, 100));
  } finally {
    for (const c of canvases) c.width = 0;
  }
}
