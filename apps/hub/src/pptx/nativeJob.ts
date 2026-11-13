/**
 * The light `pptx-native` job (design/27 §2 steps 1-6, §5 "Two-phase save"; M3 item B): an untrusted .pptx
 * into an editable ordo presentation, version 1, before any LibreOffice process starts.
 *
 * 1. `readDeckXml(store.abs(deck))` (`deckParts.ts`) with the skip filter and caps of §12 (`PPTX_LIMITS`): XML and
 *    relationship parts in memory (≤ 8 MB each, ≤ 64 MB in all; a larger part is left out and its slide
 *    becomes picture class); every other part an empty placeholder, so relationships resolve; embeddings,
 *    `vbaProject.bin`, `customXml`, `docProps` and printer settings skipped; no nested zips. Entry names never
 *    become paths.
 * 2. Pool task `pptx-scene` (`sceneTask.ts`): first a scan (deck facts, referenced pictures, metafiles,
 *    notes, the loop flag), then the referenced pictures are spilled (a second pass over the zip, under
 *    generated names, ≤ 1 GiB, ≤ 2,000 pictures) and their pixel sizes read from their first bytes, then
 *    the slides in batches of `PPTX_LIMITS.batchSlides`: a batch's slide parts are transferred, the shared
 *    parts copied (notes parts stay behind: the scan read them). Each batch has the pool's 2-minute timeout.
 *    A batch that fails is converted again slide by slide (`RETRY_SLIDE_MS` each); a slide that still fails,
 *    one the converter could not read, and the slides past `PPTX_LIMITS.importPoolMs` of pool time get the
 *    text rescue (M9 `ladder`: pool task `pptx-scene` with `rescue: true`, `RESCUE_SLIDE_MS` per slide and
 *    `RESCUE_TOTAL_MS` in all): their text bodies as text objects, class hybrid, `missing: ['slide']`, never a
 *    picture. A pool that cannot start fails the import with a clean message: the deck is never
 *    parsed on the event loop, and LibreOffice never sees a deck as uploaded (its render copy needs the pool
 *    too). Every zip read refuses overlapping entries (`deckParts.ts`).
 * 3. Classification and the §3.4 size budgets, the budget ladder of M9 (`ladder.ts`): an object naming an
 *    outline file past the import's budget is left out (`withoutFiles`); a slide over 64 KB as stored takes
 *    the first level of `fitSlideBudget` that fits (its outlines re-gridded, its text formatting dropped, its
 *    decorations left out), and once the presentation passes 3 MiB the slides from there on are stored
 *    minimal (text, pictures, background; `planImportSizes`). None becomes a picture; what a level leaves out
 *    is in `Slide.pptx.missing` (class hybrid), each simplified slide noted, logged and counted (`simplified`).
 * 3b. Clips (`clips.ts`): the scan's clip parts were spilled after the pictures and sniffed (the batches
 *    emit `ImageObject.play`, `Slide.audio` and motion backgrounds with the sniffed kinds); each clip the
 *    slides keep is stored once per part and trim (trims baked), its media job not yet queued, and its
 *    placeholder replaced; a clip that cannot be imported gives a `[warn]` and leaves its poster.
 * 4. Pictures prepared and stored (`pictures.ts`, item C) for the slides that keep their objects, recorded
 *    as resume pairs: a re-queued job never prepares a stored picture again.
 * 5. Placeholders remapped (`remapMediaIds`; an image whose picture could not be stored is dropped), notes,
 *    sections (a Default arrangement in order), hidden slides, transitions and timings, `Slide.pptx`;
 *    a background picture with alpha is laid on white (a bottom image) instead of `backgroundMediaId`; one
 *    background on every slide becomes the presentation's; `sanitizePresentation`, `Slide.parse` (a slide
 *    that fails it is stored minimal, else as its text alone, with a note), `Slide.pptx.digest` over the
 *    objects exactly as stored.
 * 6. `lib.savePresentation` (version 1) and, in the same synchronous step, the heavy `pptx-lo` job for the
 *    slides that wait for LibreOffice (`pptx.pending`: hybrid, picture class, metafiles): it cannot start
 *    before version 1 exists, its digests are version 1's, and it is queued before any clip job of the deck:
 *    the clips' media jobs are queued right after it (`MediaService.queue`), never awaited. The presentation
 *    id is chosen and recorded before the save, so a re-run never saves a second presentation.
 *
 * Version 1 of a picture-class slide (one the converter classes picture: more pictures than a slide may hold)
 * has no objects, `pptx.pending` and its text in `pptx.artText`; a hybrid slide has its native objects
 * (residuals are left out until version 2) and `pptx.artText` from its art. No budget and no failure makes a
 * picture slide (M9, plan decision 3).
 *
 * **Without LibreOffice** (design/27 M9, `HubTools`: the lite image, `ORDO_LIBREOFFICE=off`): nothing waits
 * for it. The converter is told (`SceneTaskInput.libreoffice: false`, `EmitOptions.libreoffice`) and lists what
 * its art or metafile conversion would have drawn (`EmittedSlide.missing`); a converter that still plans them
 * has them dropped here and listed by the kinds of the art's reasons (`artKinds`). Such a slide is class
 * hybrid with no art object and `Slide.pptx.missing`; a picture-class slide keeps its text for search and
 * lists 'slide'. No slide is `pending`, no `pptx-lo` is queued, and the result says `libreoffice: false` and
 * how many slides have something missing. With LibreOffice each follow-up plan records those kinds
 * (`PptxLoSlide.kinds`) for a hub that loses LibreOffice later (`fallback.ts` `withoutLibreOffice`).
 *
 * **A scene parsed on the client** (`PptxNativePayload.sceneHash`, `stepsFromClientScene`) takes the place of
 * step 2's batches and follows the same rules: a slide past the client's bound on outline files loses the
 * objects naming the files it was not given, and a slide the client could not read gets the text rescue here.
 */
import { open, readFile, rm, stat } from 'node:fs/promises';
import {
  type Box,
  drawnGeomRefs,
  formatBytes,
  IMPORT_RESERVE_BYTES,
  type ImageObject,
  MISSING_LIMITS,
  type MissingKind,
  minimalSlide,
  missingEntry,
  missingKind,
  missingLabel,
  newId,
  Presentation,
  type Section,
  type ShapeObject,
  SIZE_BUDGETS,
  Slide,
  type SlideObject,
  type SlidePptx,
  type TextObject,
  utf8Bytes,
} from '@ordo/domain';
import { type PptxClientScene, remapMediaIds } from '@ordo/importers';
import { clampBox, sanitizePresentation } from '@ordo/importers/sanitize.ts';
import {
  addNote,
  type ArtInfo,
  type EmittedClip,
  type EmittedSlide,
  MEDIA_PREFIX,
  type PictureHeader,
  pictureSize,
  rowOf,
  type SectionInfo,
  type SlideClass,
  type SlideRef,
} from '@ordo/pptx-scene';
import type { PictureBake } from '@ordo/pptx-scene/bake.ts';
import { digestOf, SLIDE_BUDGET_NOTE, SLIDE_BYTES_NOTE } from '@ordo/pptx-scene/emit.ts';
import { relsPartOf } from '@ordo/pptx-scene/opc.ts';
import { GEOM_PREFIX } from '@ordo/pptx-scene/emit.ts';
import type { Job } from '@ordo/protocol';
import { errorMessage } from '../errors.ts';
import type { JobCtx, JobHandler } from '../jobs.ts';
import { baseName } from '../media/service.ts';
import { type CpuPool, cpuPool, transferables, WorkerStartError } from '../pool.ts';
import { sceneFontFiles } from './faces.ts';
import { type ClipFile, ClipImport, spillClips } from './clips.ts';
import { type DeckXml, readDeckXml, spillDeckParts } from './deckParts.ts';
import { importDigest } from './digest.ts';
import { type NamedGeomFile, nameGeoms, storeGeomFiles } from './geoms.ts';
import { planLadder, withoutFiles } from './ladder.ts';
import { type BakeItem, bakeMapKey, storeBakes } from './bakes.ts';
import { displayNeeds, PictureBudget, type PictureItem, storePictures } from './pictures.ts';
import { ImportLog, importResult, logSafe, missingFonts } from './report.ts';
import {
  CONVERTER_VERSION,
  enqueuePptx,
  PPTX_JOBS,
  PPTX_LIMITS,
  type PptxDeps,
  type PptxImportOptions,
  type PptxLoSlide,
  type PptxNativeFallback,
  type PptxNativePayload,
  type PptxNativeProgress,
  type PptxNativeResult,
  type SceneScan,
  type SceneSlideExtra,
  type SceneTaskInput,
  type SceneTaskOutput,
} from './shared.ts';

/**
 * What the job may be given besides its deps (tests): a pool, smaller batches, pool-time budget or budget
 * of geometry files.
 */
export type NativeJobEnv = {
  pool?: Pick<CpuPool, 'run'>;
  limits?: Partial<Limits>;
  /**
   * 'Re-import from PowerPoint' (`buildNative`, `reimport.ts`): the deck slides (`SlideRef.index`) to build,
   * decided once the scan has listed the deck; undefined: every slide. Batches without one are not
   * converted, and only those slides' pictures and clips are stored.
   */
  only?: (listed: readonly SlideRef[]) => ReadonlySet<number> | undefined;
  /**
   * A re-import: the bytes of the stored slides it keeps as they are, which share the presentation's size
   * budget with the slides it builds (§3.4): added to `planImportSizes`' reserve, so the new slides go compact
   * where the merged presentation would pass it.
   */
  reserve?: number;
};

/**
 * Steps 1-5 of the job without the save (`buildNative`): version 1 as the job would save it, for the
 * re-import to merge into the stored presentation instead (`reimport.ts`, design/27 §11).
 */
export type NativeBuild = {
  /**
   * The presentation as version 1 is saved (sanitized, parsed, `Slide.pptx.digest` set, `source.native`,
   * `source.log`), under `PptxNativeProgress.presentationId`; only the slides `NativeJobEnv.only` asked for.
   */
  p: Presentation;
  /** The LibreOffice follow-up of its slides that wait (`pptx.pending`), by the built slides' ids. */
  lo: PptxLoSlide[];
  /** Every slide the deck lists, in order (also those `only` left out). */
  listed: SlideRef[];
  /**
   * The text of each converted slide's text bodies (its text objects, then the text baked into its art), by
   * `SlideRef.index`, read before any slide became a picture: what a legacy page's text boxes were made of.
   */
  texts: Map<number, string[]>;
  /**
   * Where those text bodies are, in the 1920x1080 contain frame a legacy page's text boxes used (what the old
   * 'Make editable' laid its text boxes at): a re-import tells a made-editable box the volunteer corrected
   * from one added in ordo by its place.
   */
  textBoxes: Map<number, { text: string; box: Box }[]>;
  /** The clips the built slides play (their media jobs are queued with the save) and every clip stored. */
  clipIds: Set<string>;
  clipsCreated: string[];
  /** Slides made compact pictures for a budget: none since M9's ladder (kept for the result's shape). */
  compact: number;
  /** Slides the budget ladder simplified (formatting or decorations left out, or stored minimal). */
  simplified: number;
  missingFonts: string[];
};

/**
 * Run steps 1-5 of the native import on `ctx.payload`'s stored deck and return what version 1 would be,
 * saving nothing (the re-import, `reimport.ts`). `ctx.payload.done.presentationId` names the presentation;
 * pictures and clips are stored as the job stores them (resume pairs in `done`, through `setPayload`). A clip
 * stored for a run that then fails gets its media job, as the job's does.
 */
export async function buildNative(
  deps: PptxDeps,
  ctx: JobCtx<PptxNativePayload>,
  env: NativeJobEnv = {},
): Promise<NativeBuild> {
  const limits = jobLimits(env);
  const pl = ctx.payload;
  const done: PptxNativeProgress = { ...pl.done, media: [...(pl.done?.media ?? [])] };
  const save = () => ctx.setPayload({ ...pl, done: { ...done, media: [...done.media] } });
  try {
    if (!done.presentationId) throw new Error('no presentation to build for');
    const file = deps.lib.getFile(pl.hash);
    if (!file) throw new Error('The PowerPoint file is no longer stored');
    const job = new NativeImport(deps, env.pool ?? cpuPool(), limits, ctx, done, save, env.only, env.reserve);
    const scratch = await deps.store.tmpDir();
    try {
      return await job.buildOnly(deps.store.abs(file.path), scratch);
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  } catch (e) {
    queueStoredClips(deps, done);
    throw e;
  }
}

/**
 * Queue the media jobs of the clips an import stored (its resume pairs, `PptxNativeProgress.clips`), for an
 * import that stops before version 1: a failed or cancelled run, or a job abandoned after repeated crashes
 * (the kind's give-up). `MediaService.queue` only queues an item still waiting for its job, so a clip already
 * queued or processed is left alone.
 */
export function queueStoredClips(deps: Pick<PptxDeps, 'media'>, done: PptxNativeProgress | undefined): void {
  const pairs = Array.isArray(done?.clips) ? done.clips : [];
  for (const pair of pairs.slice(0, PPTX_LIMITS.clips * 2)) {
    const id = Array.isArray(pair) ? pair[1] : undefined;
    if (typeof id === 'string') deps.media.queue(id);
  }
}

export function nativeJob(deps: PptxDeps, env: NativeJobEnv = {}): JobHandler<PptxNativePayload> {
  const limits = jobLimits(env);
  return (ctx) => runNative(deps, env.pool ?? cpuPool(), limits, ctx);
}

/** One converted slide of a batch, with its stored media map and what the job reads beside it. */
type Converted = {
  s: EmittedSlide;
  media: Map<string, string>;
  extra?: SceneSlideExtra;
  /**
   * Objects the batch's bound on outline files left out (`SceneTaskOutput.geomOver`: the slide's new files did
   * not fit), with what they drew.
   */
  geomLeft?: { dropped: number; unmasked: number; missing: MissingKind[] };
  /** Only its text, from the rescue (`SceneTaskInput.rescue`): its conversion failed. */
  rescued?: boolean;
};

/**
 * A slide of a failed batch converted again on its own gets this long before its worker is stopped (the
 * pool's own timeout is 2 minutes for a batch of up to 150 slides).
 */
export const RETRY_SLIDE_MS = 30_000;
/** The text rescue: per slide, and for the whole import (lo-dependencies §4.5). */
export const RESCUE_SLIDE_MS = 2_000;
export const RESCUE_TOTAL_MS = 2 * 60_000;

type Limits = {
  batchSlides: number;
  importPoolMs: number;
  geomFileBytes: number;
  batchGeomBytes: number;
  retrySlideMs: number;
  rescueSlideMs: number;
  rescueTotalMs: number;
};

/** The job's limits: `PPTX_LIMITS` and the rescue's, or the smaller ones the env gives (tests). */
function jobLimits(env: NativeJobEnv): Limits {
  return {
    batchSlides: env.limits?.batchSlides ?? PPTX_LIMITS.batchSlides,
    importPoolMs: env.limits?.importPoolMs ?? PPTX_LIMITS.importPoolMs,
    geomFileBytes: env.limits?.geomFileBytes ?? PPTX_LIMITS.geomFileBytes,
    batchGeomBytes: env.limits?.batchGeomBytes ?? PPTX_LIMITS.batchGeomBytes,
    retrySlideMs: env.limits?.retrySlideMs ?? RETRY_SLIDE_MS,
    rescueSlideMs: env.limits?.rescueSlideMs ?? RESCUE_SLIDE_MS,
    rescueTotalMs: env.limits?.rescueTotalMs ?? RESCUE_TOTAL_MS,
  };
}

/** Parts read once by the scan and never by a batch. */
const NOTES_PART = /^ppt\/(notesSlides|notesMasters)\//i;
/** A spilled picture's first bytes read for its size (a JPEG's frame header can follow large metadata). */
const SIZE_HEAD_BYTES = 64 * 1024;
const SIZE_HEAD_MAX_BYTES = 1024 * 1024;
/** Speaker notes kept for the whole presentation (§3.4: notes travel with every presentation); past it, cut. */
export const NOTES_TOTAL_BYTES = 1024 * 1024;
/** Notes of a slide past `NOTES_TOTAL_BYTES` keep this many characters. */
const NOTES_CUT_CHARS = 200;
/** A slide's `pptx.notes` (the schema's bound). */
const SLIDE_NOTES = 16;
/** Job log lines of one kind before the rest are only counted (the job log keeps 500 lines). */
const JOB_LOG_LINES = 20;
/** The text of a picture-class slide kept for search (`MAX.text` of `@ordo/domain`). */
const ART_TEXT_CHARS = 20_000;
/** That text on a deck too large for its budget even with every slide compact (§3.4). */
const COMPACT_TEXT_CHARS = 200;
/** How often the picture resume pairs are written while pictures are stored. */
const SAVE_EVERY_MS = 1_000;

/**
 * Another batch's slide, as a batch sees it: the root alone with its show flag, so every batch lists the deck
 * exactly as the scan did (indexes and shown places), without the other slides' content. No deck bytes.
 */
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const STUB_SHOWN = new TextEncoder().encode(`<p:sld xmlns:p="${P_NS}"/>`);
const STUB_HIDDEN = new TextEncoder().encode(`<p:sld xmlns:p="${P_NS}" show="0"/>`);
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
/** A picture's display need when it cannot be measured: the widest output (design/27 §4). */
const DEFAULT_NEED_PX = 3_840;

/** One slide on its way to version 1. */
type Draft = {
  ref: SlideRef;
  slide: Slide;
  /** Its batch's placeholder ids → picture parts (`EmitResult.media`). */
  media: Map<string, string>;
  cls: SlideClass;
  /**
   * The converter's notes, then the job's, each added with `addNote` (as the converter adds its own), so the
   * list stays within the schema's 16 with 'and N more' last and a note of the job's is counted, not cut.
   */
  notes: string[];
  /** Hybrid slides: what the art holds (`EmittedSlide.art`, item D). */
  art?: ArtInfo;
  /** Text baked into the art or the page picture (`pptx.artText`). */
  artText?: string;
  /**
   * M9 `ladder`: what the budgets or a failure left out of the slide (`Slide.pptx.missing` entries: decoration,
   * chart, slide), with LibreOffice or without (nothing draws it: LibreOffice draws no budget's art).
   */
  dropped?: string[];
  /** The budget ladder simplified it (`simplified` in the result). */
  simplified?: boolean;
  /**
   * Metafile pictures version 1 leaves out (`EmittedSlide.metafiles`, item D): LibreOffice converts each part
   * and the follow-up puts the object back just under `before`.
   */
  metafiles?: { part: string; object: ImageObject; before?: string }[];
  /** The clips the slide plays or names (`EmittedSlide.clips`, `clips.ts`). */
  clips?: EmittedClip[];
  /**
   * M9, without LibreOffice: what nothing draws on the slide (`Slide.pptx.missing` entries). A picture-class
   * slide lists 'slide' instead (`provenance`).
   */
  missing?: string[];
  /** M9, with LibreOffice: the kinds its art holds (`artKinds`), for `PptxLoSlide.kinds`. */
  artKinds?: MissingKind[];
};

/** A slide's own parts (its XML and relationships part), each in a buffer of its own. */
type SlideParts = Map<string, Uint8Array>;

/** What every `pptx-scene` batch call of one import shares (`NativeImport.batch`). */
type BatchCall = {
  shared: Map<string, Uint8Array>;
  listed: readonly SlideRef[];
  base: Omit<SceneTaskInput, 'parts' | 'range'>;
  out: Map<number, Converted>;
};

/**
 * The own parts of the slides [from, to) taken out of `parts`, by the slide's place in the deck. A part that
 * is a view into a larger inflated buffer gets a buffer of its own, so the larger one is not kept alive.
 */
function takeParts(
  parts: Map<string, Uint8Array>,
  listed: readonly SlideRef[],
  from: number,
  to: number,
): Map<number, SlideParts> {
  const out = new Map<number, SlideParts>();
  for (let i = from; i < to; i++) {
    const part = listed[i]!.part;
    const own: SlideParts = new Map();
    for (const k of [part, relsPartOf(part)]) {
      const v = parts.get(k);
      if (!v) continue;
      parts.delete(k);
      own.set(
        k,
        !v.byteLength || (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength) ? v : new Uint8Array(v),
      );
    }
    out.set(i, own);
  }
  return out;
}

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

async function runNative(
  deps: PptxDeps,
  pool: Pick<CpuPool, 'run'>,
  limits: Limits,
  ctx: JobCtx<PptxNativePayload>,
): Promise<PptxNativeResult | PptxNativeFallback> {
  const pl = ctx.payload;
  const done: PptxNativeProgress = { ...pl.done, media: [...(pl.done?.media ?? [])] };
  const save = () => ctx.setPayload({ ...pl, done: { ...done, media: [...done.media] } });
  if (done.fallbackJobId)
    return { fallback: 'libreoffice', jobId: done.fallbackJobId, reason: 'the CPU pool could not start' };
  try {
    if (done.presentationId) {
      const saved = deps.lib.presentations.get(done.presentationId);
      if (saved) return resumedResult(deps, ctx, saved, done, save);
    }
    const file = deps.lib.getFile(pl.hash);
    if (!file) throw new Error('The uploaded deck is missing');
    done.presentationId ??= newId();
    save();
    const job = new NativeImport(deps, pool, limits, ctx, done, save);
    const scratch = await deps.store.tmpDir();
    try {
      return await job.run(deps.store.abs(file.path), scratch);
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  } catch (e) {
    // Every way a run stops before version 1 (the deck gone, no scratch folder, a failed step, a cancel):
    // the clips an earlier attempt stored (the resume pairs) get their media jobs, never left waiting for
    // one. `MediaService.queue` leaves a clip already queued or processed alone.
    queueStoredClips(deps, done);
    throw e;
  }
}

/** One run of the job (state shared by its steps). */
class NativeImport {
  private readonly log = new ImportLog();
  private readonly options: PptxImportOptions;
  private readonly title: string;
  private poolMs = 0;
  /** The largest worker heap a pool call reported (the §13 budget: ≤ 256 MB). */
  private heapMb = 0;
  private jobLines = new Map<string, number>();
  private scratch = '';
  /** Media ids of the deck's clips: queued after version 1 and its follow-up, never the presentation's background. */
  private clipIds = new Set<string>();
  /** The clips this run created (`ClipImport.created`). */
  private clipsCreated: string[] = [];
  /** Baked pictures by their key in the drafts' part maps (M6, `bakes.ts`): source part and recipe. */
  private readonly bakes = new Map<string, { part: string; bake: PictureBake }>();
  /** The deck's geometry files by name (M6 round 2, `geoms.ts`): what the kept slides' refs name. */
  private readonly geomFiles = new Map<string, NamedGeomFile>();
  /** Bytes of `geomFiles`, and the names of files dropped past the import's budget as batches arrived. */
  private geomBytes = 0;
  private readonly geomDropped = new Set<string>();
  /** LibreOffice can draw what ordo cannot (`HubTools`), decided once the tools are known (`steps`). */
  private lo = true;

  constructor(
    private readonly deps: PptxDeps,
    private readonly pool: Pick<CpuPool, 'run'>,
    private readonly limits: Limits,
    private readonly ctx: JobCtx<PptxNativePayload>,
    private readonly done: PptxNativeProgress,
    private readonly save: () => void,
    private readonly only?: NativeJobEnv['only'],
    private readonly reserve = 0,
  ) {
    this.options = ctx.payload.options ?? {};
    // The upload's file name: one line, like every other string that reaches a list or a log.
    this.title = logSafe(baseName(ctx.payload.name), 300) || 'PowerPoint';
  }

  /** A warning in the job log (at most `JOB_LOG_LINES` per kind) and in `source.log`. */
  private warn(kind: string, msg: string): void {
    this.log.add('warn', msg);
    const n = (this.jobLines.get(kind) ?? 0) + 1;
    this.jobLines.set(kind, n);
    if (n <= JOB_LOG_LINES) this.ctx.log(`[warn] ${logSafe(msg, 400)}`);
    else if (n === JOB_LOG_LINES + 1)
      this.ctx.log(`[warn] more ${kind} warnings are in the presentation's import log`);
  }

  private checkCancelled(): void {
    if (this.ctx.signal.aborted) throw new Cancelled();
  }

  /** A `pptx-scene` pool call; `timeoutMs` stops its worker sooner than the pool's own timeout. */
  private async scene(
    input: SceneTaskInput,
    transfer: ArrayBuffer[] = [],
    timeoutMs?: number,
  ): Promise<SceneTaskOutput> {
    const t0 = performance.now();
    const signal =
      timeoutMs === undefined
        ? this.ctx.signal
        : AbortSignal.any([this.ctx.signal, AbortSignal.timeout(Math.max(1, timeoutMs))]);
    try {
      const out = await this.pool.run('pptx-scene', input, { signal, transfer });
      this.heapMb = Math.max(this.heapMb, out.heapMb);
      return out;
    } finally {
      this.poolMs += performance.now() - t0;
    }
  }

  async run(deck: string, scratch: string): Promise<PptxNativeResult> {
    return this.guard(async () => {
      const t0 = performance.now();
      const result = this.saveVersion1(await this.steps(deck, scratch));
      this.ctx.log(
        `version 1 saved in ${Math.round(performance.now() - t0)} ms: ${result.native} native, ${result.hybrid} hybrid, ` +
          `${result.picture} picture slide(s)${result.pending ? `, ${result.pending} waiting for LibreOffice` : ''}` +
          (result.missing ? `, ${result.missing} with something ordo cannot draw` : ''),
      );
      return result;
    });
  }

  /** Steps 1-5 only (`buildNative`): nothing is saved. */
  buildOnly(deck: string, scratch: string): Promise<NativeBuild> {
    return this.guard(() => this.steps(deck, scratch));
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      // Clips stored without their media job (queued with version 1): never left waiting for it. Those of an
      // earlier attempt (the resume pairs) are queued by `runNative`, whatever stops the run.
      for (const id of this.clipsCreated) this.deps.media.queue(id);
      throw e;
    }
  }

  private async steps(deck: string, scratch: string): Promise<NativeBuild> {
    const { ctx } = this;
    this.scratch = scratch;
    // M9: whether anything will draw what ordo cannot (the probes settle within 30 s of the start). Only a
    // LibreOffice known absent or turned off means nothing will: a 'broken' one (its probe timed out on a slow
    // start) is probed again first, and while it does not answer the art still waits for it, the follow-up
    // probing it again before it gives up (`fallback.ts` `loJob`, `LO_PROBE_RETRIES`).
    const lo = await this.deps.tools.recheck();
    this.lo = lo !== 'absent' && lo !== 'off';
    if (this.lo && lo !== 'available') {
      ctx.log(
        '[warn] LibreOffice does not answer yet: what ordo cannot draw waits for it, tried again later',
      );
      this.log.add('warn', 'LibreOffice does not answer yet: its pictures are tried again later');
    }
    if (!this.lo) {
      ctx.log('this hub has no LibreOffice: ordo draws the slides, and lists what it cannot draw');
      this.log.add('info', 'no LibreOffice on this hub: what ordo cannot draw is listed on its slides');
    }

    if (ctx.payload.sceneHash) {
      const fromClient = await this.stepsFromClientScene(deck, scratch, ctx.payload.sceneHash);
      if (fromClient) return fromClient;
    }

    // 1. XML parts in memory; every other part a placeholder.
    const parts = await this.readXml(deck, scratch);
    ctx.progress(0.05);

    // 2a. The scan: deck facts, referenced pictures, notes.
    let first: SceneTaskOutput;
    try {
      first = await this.scene({
        parts,
        pictureSizes: [],
        range: { from: 0, to: 0 },
        options: this.options,
        scan: true,
      });
    } catch (e) {
      this.checkCancelled();
      if (e instanceof WorkerStartError) this.noPool(e.message);
      throw new Error(`The deck could not be read: ${logSafe(errorMessage(e))}`);
    }
    const scan = first.scan!;
    const listed = first.result.listed;
    if (!listed.length) throw new Error('The deck has no slides');
    for (const n of first.result.notes) this.log.add('info', n);
    ctx.log(`${listed.length} slide(s), ${scan.pictures.length} picture(s) referenced`);
    ctx.progress(0.1);

    // 2b. Referenced pictures spilled, their sizes read; then the clips, within what the pictures left.
    const spilled = await this.spillPictures(deck, scratch, scan);
    const pictureSizes: [string, PictureHeader][] = [];
    let spilledBytes = 0;
    for (const [part, path] of spilled) {
      const px = await spilledSize(path);
      if (px) pictureSizes.push([part, px]);
      spilledBytes += await stat(path).then(
        (s) => s.size,
        () => 0,
      );
    }
    const clipFiles = await this.spillClips(deck, scratch, scan, PPTX_LIMITS.spillBytes - spilledBytes);
    const mediaKinds: [string, 'video' | 'audio'][] = [];
    for (const [part, f] of clipFiles) if (f.kind) mediaKinds.push([part, f.kind]);

    // 2c. The slides, in batches (a re-import: only those it asks for).
    const want = this.only?.(listed);
    const converted = await this.convert(parts, listed, pictureSizes, mediaKinds, want);
    parts.clear();
    ctx.log(
      `converted in ${Math.round(this.poolMs)} ms of pool time, worker heap ${Math.round(this.heapMb)} MB`,
    );
    const texts = new Map([...converted].map(([index, c]) => [index, bodyTexts(c.s)]));
    const textBoxes = new Map([...converted].map(([index, c]) => [index, bodyBoxes(c.s)]));

    // 3. Drafts, classes and the size budgets (M9: the budget ladder, never a picture).
    const drafts = this.drafts(want ? listed.filter((r) => want.has(r.index)) : listed, converted, scan);
    const simplified = this.budget(drafts);

    // 3b. Geometry files the kept slides name (M6 round 2, `geoms.ts`); the objects that name one that could
    // not be stored are left out (they would draw nothing where their outline is).
    await this.storeGeoms(drafts);
    this.checkCancelled();

    // 3c. Clips: stored (their media jobs queued with version 1), placeholders replaced.
    await this.clips(drafts, clipFiles);
    this.checkCancelled();

    // 4. Pictures.
    const stored = await this.pictures(drafts, spilled, new Map(pictureSizes));
    ctx.progress(0.95);

    // 5. Version 1, assembled (`saveVersion1` saves it).
    const built = this.assemble(drafts, stored, first.result.sections, first.result.slideRect, scan);
    return { ...built, listed: [...listed], texts, textBoxes, compact: 0, simplified };
  }

  /**
   * When the client pre-parsed the PowerPoint scene via `importPptxClient`, assemble Version 1 and spill
   * referenced pictures/clips without running `pptx-scene` on the Hub's CPU pool, but for the text rescue of a
   * slide the client could not read (`rescueClientSlides`). Only a scene of this
   * converter (`CONVERTER_VERSION`, M9's fields: `CLIENT_M9_WRITES`) parsed for the LibreOffice this hub has
   * or lacks (`this.lo`, set first by `steps`) is used; undefined otherwise, and the hub parses the deck.
   */
  private async stepsFromClientScene(
    deck: string,
    scratch: string,
    sceneHash: string,
  ): Promise<NativeBuild | undefined> {
    const { ctx } = this;
    const sf = this.deps.lib.getFile(sceneHash);
    if (!sf) return undefined;
    let raw: PptxClientScene;
    try {
      raw = JSON.parse(await readFile(this.deps.store.abs(sf.path), 'utf8')) as PptxClientScene;
    } catch {
      return undefined;
    }
    if (!raw || raw.version !== CONVERTER_VERSION || !Array.isArray(raw.listed) || !raw.scan) {
      return undefined;
    }
    // M9: the converter's plan (art, metafile conversions, the notes, what is listed as missing) depends on
    // whether LibreOffice is there (`EmitOptions.libreoffice`), so a scene parsed for the other case is not
    // used: the deck is parsed here as for any upload.
    const sceneLo = raw.libreoffice !== false;
    if (sceneLo !== this.lo) {
      ctx.log(
        `the deck was parsed on the client for a hub ${sceneLo ? 'with' : 'without'} LibreOffice: parsed again here`,
      );
      return undefined;
    }

    for (const path of raw.oversized ?? [])
      this.warn('part', `${logSafe(path)} is over ${PPTX_LIMITS.xmlPartBytes / 1024 ** 2} MB: not read`);
    if (raw.fonts)
      this.log.add('info', `${raw.fonts} embedded font part(s) not used (embedded fonts come later)`);

    const scan = raw.scan;
    const listed = raw.listed;
    if (!listed.length) throw new Error('The deck has no slides');
    for (const n of raw.notes ?? []) this.log.add('info', n);
    ctx.log(`${listed.length} slide(s), ${scan.pictures.length} picture(s) referenced (parsed on client)`);
    ctx.progress(0.1);

    const spilled = await this.spillPictures(deck, scratch, scan);
    const pictureSizes: [string, PictureHeader][] = [];
    let spilledBytes = 0;
    for (const [part, path] of spilled) {
      const px = await spilledSize(path);
      if (px) pictureSizes.push([part, px]);
      spilledBytes += await stat(path).then(
        (s) => s.size,
        () => 0,
      );
    }
    const clipFiles = await this.spillClips(deck, scratch, scan, PPTX_LIMITS.spillBytes - spilledBytes);

    const want = this.only?.(listed);
    const media = new Map(
      (raw.media ?? []).map((m) => [m.id, m.bake ? this.bakeKeyOf(m.part, m.bake) : m.part]),
    );
    const extras = new Map((raw.extras ?? []).map((e) => [e.index, e]));
    const encoder = new TextEncoder();
    for (const g of raw.geomFiles ?? []) {
      if (this.geomFiles.has(g.hash) || this.geomDropped.has(g.hash)) continue;
      const bytes = encoder.encode(g.json);
      if (this.geomBytes + bytes.length > this.limits.geomFileBytes) {
        this.geomDropped.add(g.hash);
        continue;
      }
      this.geomFiles.set(g.hash, { hash: g.hash, bytes });
      this.geomBytes += bytes.length;
    }
    // A slide the client's bound on outline files left without its new files (`geomOver`: it keeps their
    // placeholders, `PptxClientScene.geomOver`) loses the objects that name them, as a batch's does (`batch`,
    // M9 `ladder`), and says so (`drafts`, `leftOut`).
    const geomOver = new Set(raw.geomOver ?? []);
    const converted = new Map<number, Converted>();
    for (const s of raw.slides ?? []) {
      if (want && !want.has(s.index)) continue;
      let geomLeft: Converted['geomLeft'];
      if (geomOver.has(s.index)) {
        const left = withoutFiles(s.slide, (ref) => !ref.startsWith(GEOM_PREFIX));
        s.slide = left.slide;
        geomLeft = { dropped: left.dropped, unmasked: left.unmasked, missing: left.missing };
      }
      converted.set(s.index, { s, media, extra: extras.get(s.index), ...(geomLeft ? { geomLeft } : {}) });
    }
    // A slide the client's converter could not read (`unreadable`), or one the scene lacks, keeps its text
    // if the rescue can read it, as in the hub's own parse (`convert`): never a picture for a failure.
    const failed: number[] = [];
    listed.forEach((r, i) => {
      if (want && !want.has(r.index)) return;
      const c = converted.get(r.index);
      const reasons = c?.s.classification?.reasons;
      if (c && !(Array.isArray(reasons) && reasons.includes('unreadable'))) return;
      converted.delete(r.index);
      failed.push(i);
    });
    if (failed.length) {
      const mediaKinds: [string, 'video' | 'audio'][] = [];
      for (const [part, f] of clipFiles) if (f.kind) mediaKinds.push([part, f.kind]);
      await this.rescueClientSlides(deck, scratch, listed, failed, pictureSizes, mediaKinds, converted);
    }
    ctx.progress(0.6);

    const texts = new Map([...converted].map(([index, c]) => [index, bodyTexts(c.s)]));
    const textBoxes = new Map([...converted].map(([index, c]) => [index, bodyBoxes(c.s)]));

    // The size budgets as for the hub's own parse (M9: the budget ladder, never a picture).
    const drafts = this.drafts(want ? listed.filter((r) => want.has(r.index)) : listed, converted, scan);
    const simplified = this.budget(drafts);

    await this.storeGeoms(drafts);
    this.checkCancelled();

    await this.clips(drafts, clipFiles);
    this.checkCancelled();

    const stored = await this.pictures(drafts, spilled, new Map(pictureSizes));
    ctx.progress(0.95);

    const built = this.assemble(drafts, stored, raw.sections ?? [], raw.slideRect, scan);
    return { ...built, listed: [...listed], texts, textBoxes, compact: 0, simplified };
  }

  /**
   * A pool that cannot start fails the import (design/27 §12): the deck is never parsed on the event loop,
   * and LibreOffice never sees a deck as uploaded, so there is nothing safe to fall back to (the picture
   * import needs the pool for its render copy too). Nothing was saved; the import can be tried again.
   */
  private noPool(reason: string): never {
    throw new Error(
      `The hub could not start a conversion worker (${logSafe(reason)}): the deck was not imported. Try again in a moment.`,
    );
  }

  /** Step 1: the deck's XML parts within the caps; other parts as empty placeholders (`readDeckXml`). */
  private async readXml(deck: string, scratch: string): Promise<Map<string, Uint8Array>> {
    let xml: DeckXml;
    try {
      xml = await readDeckXml(deck, scratch, this.ctx.signal);
    } catch (e) {
      this.checkCancelled();
      const msg = errorMessage(e);
      if (/of documents/.test(msg))
        throw new Error(
          `The deck holds more than ${PPTX_LIMITS.xmlTotalBytes / 1024 ** 2} MB of slide XML, more than an import may read`,
        );
      throw new Error(`The file is not a readable PowerPoint deck: ${logSafe(msg)}`);
    }
    // Kept as empty parts: a slide that needs one is quarantined (picture class), never dropped.
    for (const path of xml.oversized)
      this.warn('part', `${logSafe(path)} is over ${PPTX_LIMITS.xmlPartBytes / 1024 ** 2} MB: not read`);
    if (xml.fonts)
      this.log.add('info', `${xml.fonts} embedded font part(s) not used (embedded fonts come later)`);
    return xml.parts;
  }

  /** Step 2b: the referenced pictures spilled under generated names, within the spill budget. */
  private async spillPictures(deck: string, scratch: string, scan: SceneScan): Promise<Map<string, string>> {
    if (scan.picturesOver)
      this.warn(
        'picture',
        `${scan.picturesOver} picture(s) past the ${PPTX_LIMITS.pictures} a deck may hold are not imported`,
      );
    if (!scan.pictures.length) return new Map();
    let spilled: Awaited<ReturnType<typeof spillDeckParts>>;
    try {
      spilled = await spillDeckParts(deck, scratch, scan.pictures, this.ctx.signal);
    } catch (e) {
      this.checkCancelled();
      throw new Error(`The deck's pictures could not be read: ${logSafe(errorMessage(e))}`);
    }
    if (spilled.skippedCount)
      this.warn(
        'picture',
        `${spilled.skippedCount} picture(s) past the ${PPTX_LIMITS.spillBytes / 1024 ** 3} GiB an import may extract are not imported`,
      );
    return spilled.files;
  }

  /**
   * Step 2b: the scan's clip parts spilled within `bytesLeft` and sniffed (`clips.ts`); parts past the limits
   * are warned about here, and each slide that uses one warns again when its clips are stored.
   */
  private async spillClips(
    deck: string,
    scratch: string,
    scan: SceneScan,
    bytesLeft: number,
  ): Promise<Map<string, ClipFile>> {
    if (scan.clipsOver)
      this.warn(
        'clip',
        `${scan.clipsOver} clip(s) past the ${PPTX_LIMITS.clips} a deck may hold are not imported: their posters are shown`,
      );
    const parts = scan.clips ?? [];
    if (!parts.length) return new Map();
    try {
      const got = await spillClips(deck, scratch, parts, bytesLeft, this.ctx.signal);
      if (got.skipped)
        this.warn(
          'clip',
          `${got.skipped} clip(s) past the ${PPTX_LIMITS.spillBytes / 1024 ** 3} GiB an import may extract are not imported: their posters are shown`,
        );
      return got.files;
    } catch (e) {
      this.checkCancelled();
      this.warn(
        'clip',
        `the deck's clips could not be read (${logSafe(errorMessage(e))}): their posters are shown`,
      );
      return new Map();
    }
  }

  /** Step 3b: every clip the drafts keep stored and put in place of its placeholder (`ClipImport`). */
  private async clips(drafts: Draft[], files: Map<string, ClipFile>): Promise<void> {
    const slides = drafts
      .filter((d) => d.clips?.length)
      .map((d) => ({
        index: d.ref.index,
        slide: d.slide,
        clips: d.clips!,
        picture: d.cls === 'picture',
        notes: d.notes,
      }));
    if (!slides.length) return;
    this.done.clips ??= [];
    const clips = new ClipImport(this.deps, {
      title: this.title,
      files,
      done: this.done.clips,
      save: this.save,
      warn: (msg) => this.warn('clip', msg),
      info: (msg) => this.log.add('info', msg),
      dir: this.scratch,
      probeMs: this.deps.cfg.timeouts.probe,
      signal: this.ctx.signal,
    });
    this.clipsCreated = clips.created;
    await clips.apply(slides);
    this.clipIds = clips.used;
    if (clips.used.size)
      this.ctx.log(`${clips.used.size} clip(s) stored; their media jobs follow the import`);
  }

  /**
   * Step 2c: every slide through the pool in batches. A batch that fails is converted again slide by slide;
   * a slide that still fails, one the converter could not read, and the slides past the pool-time budget get
   * the text rescue (`rescue`). A slide nothing could read is left out of the map (`drafts`: empty, hybrid).
   */
  private async convert(
    parts: Map<string, Uint8Array>,
    listed: readonly SlideRef[],
    pictureSizes: [string, PictureHeader][],
    mediaKinds: [string, 'video' | 'audio'][] = [],
    want?: ReadonlySet<number>,
  ): Promise<Map<number, Converted>> {
    const out = new Map<number, Converted>();
    const n = listed.length;
    const step = this.limits.batchSlides;
    const call = this.batchCall(parts, listed, pictureSizes, mediaKinds, out);
    /** Slides for the rescue, each with its own parts (kept until then). */
    const failed = new Map<number, SlideParts>();
    for (let from = 0; from < n; from += step) {
      this.checkCancelled();
      const to = Math.min(n, from + step);
      const wanted: number[] = [];
      for (let i = from; i < to; i++) if (!want || want.has(listed[i]!.index)) wanted.push(i);
      if (!wanted.length) continue;
      const mine = takeParts(parts, listed, from, to);
      if (this.poolMs > this.limits.importPoolMs) {
        this.warn(
          'batch',
          `slides ${from + 1}-${to} were not converted: the import used its ${Math.round(this.limits.importPoolMs / 60_000)} minutes of conversion time, so only their text is kept`,
        );
        for (const i of wanted) failed.set(i, mine.get(i)!);
        continue;
      }
      try {
        await this.batch(call, mine, from, to);
      } catch (e) {
        this.checkCancelled();
        const why = logSafe(errorMessage(e));
        if (to - from === 1) {
          this.warn('batch', `slide ${from + 1} could not be converted (${why}): only its text is kept`);
          failed.set(from, mine.get(from)!);
        } else {
          this.warn(
            'batch',
            `slides ${from + 1}-${to} could not be converted together (${why}): each is converted on its own`,
          );
          await this.oneByOne(call, mine, wanted, failed);
        }
      }
      // A slide the converter could not read (`unreadable`): its text, if the rescue can read it.
      for (const i of wanted) {
        const c = out.get(i);
        if (c?.s.classification.reasons.includes('unreadable')) {
          out.delete(i);
          failed.set(i, mine.get(i)!);
        }
      }
      this.ctx.progress(0.1 + (0.5 * to) / n);
    }
    if (failed.size) await this.rescue(call, failed);
    return out;
  }

  /**
   * What every `pptx-scene` call of one import shares (`BatchCall`): the deck's parts but the slides' own and
   * their notes, and the options; the converted slides go to `out`.
   */
  private batchCall(
    parts: Map<string, Uint8Array>,
    listed: readonly SlideRef[],
    pictureSizes: [string, PictureHeader][],
    mediaKinds: [string, 'video' | 'audio'][],
    out: Map<number, Converted>,
  ): BatchCall {
    const own = new Set<string>();
    for (const r of listed) {
      own.add(r.part);
      own.add(relsPartOf(r.part));
    }
    const shared = new Map<string, Uint8Array>();
    for (const [k, v] of parts) if (!own.has(k) && !NOTES_PART.test(k)) shared.set(k, v);
    // Table rows grow to their text, measured with the library's faces (read by the worker as needed).
    const fonts = sceneFontFiles(this.deps.lib.listFonts(), (p) => this.deps.store.abs(p));
    const base = {
      pictureSizes,
      options: this.options,
      mediaKinds,
      fonts,
      geomBytes: this.limits.batchGeomBytes,
      ...(this.lo ? {} : { libreoffice: false }),
    };
    return { shared, listed, base, out };
  }

  /**
   * The text rescue (`rescue`) of the slides `failed` (places in `listed`) of a client scene: those its
   * converter could not read (`unreadable`) or did not send. Their own parts are read from the deck here, as
   * the hub's parse has them (`convert`); what the rescue reads joins `out`, and a slide still unread stays
   * out of it (an empty slide that says so, `drafts`).
   */
  private async rescueClientSlides(
    deck: string,
    scratch: string,
    listed: readonly SlideRef[],
    failed: readonly number[],
    pictureSizes: [string, PictureHeader][],
    mediaKinds: [string, 'video' | 'audio'][],
    out: Map<number, Converted>,
  ): Promise<void> {
    let xml: DeckXml;
    try {
      xml = await readDeckXml(deck, scratch, this.ctx.signal);
    } catch (e) {
      this.checkCancelled();
      this.warn(
        'batch',
        `${failed.length} slide(s) the client could not convert could not be read here (${logSafe(errorMessage(e))}): they are empty, and say so`,
      );
      return;
    }
    const call = this.batchCall(xml.parts, listed, pictureSizes, mediaKinds, out);
    const mine = new Map<number, SlideParts>();
    for (const i of failed) mine.set(i, takeParts(xml.parts, listed, i, i + 1).get(i)!);
    xml.parts.clear();
    await this.rescue(call, mine);
  }

  /** The slides `wanted` of a failed batch, each converted alone; those that fail again go to `failed`. */
  private async oneByOne(
    call: BatchCall,
    mine: Map<number, SlideParts>,
    wanted: readonly number[],
    failed: Map<number, SlideParts>,
  ): Promise<void> {
    for (const i of wanted) {
      this.checkCancelled();
      if (this.poolMs > this.limits.importPoolMs) {
        failed.set(i, mine.get(i)!);
        continue;
      }
      try {
        await this.batch(call, new Map([[i, mine.get(i)!]]), i, i + 1, false, this.limits.retrySlideMs);
      } catch (e) {
        this.checkCancelled();
        this.warn(
          'batch',
          `slide ${i + 1} could not be converted (${logSafe(errorMessage(e))}): only its text is kept`,
        );
        failed.set(i, mine.get(i)!);
      }
    }
  }

  /**
   * The text rescue (M9 `ladder`, `@ordo/pptx-scene` `rescueDeck`): each run of consecutive failed slides in one
   * pool call of `RESCUE_SLIDE_MS` a slide, a run that fails again slide by slide, all within
   * `RESCUE_TOTAL_MS`. A slide still unread stays out of `out` (an empty slide, `drafts`).
   */
  private async rescue(call: BatchCall, failed: Map<number, SlideParts>): Promise<void> {
    const t0 = performance.now();
    const left = () => this.limits.rescueTotalMs - (performance.now() - t0);
    const indexes = [...failed.keys()].sort((a, b) => a - b);
    const runs: number[][] = [];
    for (const i of indexes) {
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1] === i - 1 && last.length < this.limits.batchSlides) last.push(i);
      else runs.push([i]);
    }
    let unread = 0;
    for (const run of runs) {
      this.checkCancelled();
      const ms = Math.min(left(), this.limits.rescueSlideMs * run.length);
      if (ms <= 0) {
        unread += run.length;
        continue;
      }
      const mine = new Map(run.map((i) => [i, failed.get(i)!]));
      try {
        await this.batch(call, mine, run[0]!, run[run.length - 1]! + 1, true, ms);
        continue;
      } catch {
        this.checkCancelled();
        if (run.length === 1) {
          unread++;
          continue;
        }
      }
      for (const i of run) {
        this.checkCancelled();
        const one = Math.min(left(), this.limits.rescueSlideMs);
        if (one <= 0) {
          unread++;
          continue;
        }
        try {
          await this.batch(call, new Map([[i, failed.get(i)!]]), i, i + 1, true, one);
        } catch {
          this.checkCancelled();
          unread++;
        }
      }
    }
    const kept = indexes.length - unread;
    if (kept) this.ctx.log(`${kept} slide(s) that could not be converted keep their text`);
    if (unread) this.warn('batch', `${unread} slide(s) could not be read at all: they are empty, and say so`);
  }

  /**
   * One `pptx-scene` call for the slides [from, to) (`rescue`: their text alone), its slides added to
   * `call.out`. The slides' own parts in `mine` are sent as copies, so a failed call can be tried again.
   * Throws when the call fails or reads the deck's slide list differently.
   */
  private async batch(
    call: BatchCall,
    mine: Map<number, SlideParts>,
    from: number,
    to: number,
    rescue = false,
    timeoutMs?: number,
  ): Promise<void> {
    const { listed } = call;
    const n = listed.length;
    const parts = new Map(call.shared);
    for (const r of listed) parts.set(r.part, r.hidden ? STUB_HIDDEN : STUB_SHOWN);
    const sent: Uint8Array[] = [];
    for (const own of mine.values())
      for (const [k, v] of own) {
        // Placeholders share one empty buffer: never transferred (it would be detached for every batch).
        if (!v.byteLength) {
          parts.set(k, v);
          continue;
        }
        const copy = new Uint8Array(v);
        parts.set(k, copy);
        sent.push(copy);
      }
    const r = await this.scene(
      { ...call.base, parts, range: { from, to }, ...(rescue ? { rescue: true } : {}) },
      transferables(sent),
      timeoutMs,
    );
    // Every batch must list the deck as the scan did, or its indexes would name other slides.
    const same =
      r.result.listed.length === n &&
      r.result.listed.every((x, i) => x.part === listed[i]!.part && x.shown === listed[i]!.shown);
    if (!same) throw new Error('the batch read the slide list differently');
    // A baked picture stands in the part map under its own key (M6, `bakes.ts`).
    const media = new Map(
      r.result.media.map((m) => [m.id, m.bake ? this.bakeKeyOf(m.part, m.bake) : m.part]),
    );
    const extras = new Map((r.extras ?? []).map((e) => [e.index, e]));
    // Geometry files are named by their content in the worker (`sceneTask.ts` `nameGeomFiles`): the batch's
    // placeholders become names. The import's budget applies as batches arrive: a file past it is dropped at
    // once (step 3 leaves out what names it), and a slide the batch's own bound left without its new files
    // (`geomOver`) loses the objects that name them here.
    const names = new Map<string, string>();
    for (const g of r.geomFiles ?? []) {
      names.set(g.id, g.hash);
      if (this.geomFiles.has(g.hash) || this.geomDropped.has(g.hash)) continue;
      if (this.geomBytes + g.bytes.length > this.limits.geomFileBytes) {
        this.geomDropped.add(g.hash);
        continue;
      }
      this.geomFiles.set(g.hash, { hash: g.hash, bytes: g.bytes });
      this.geomBytes += g.bytes.length;
    }
    const geomOver = new Set(r.geomOver ?? []);
    for (const s of r.result.slides) {
      let geomLeft: Converted['geomLeft'];
      if (geomOver.has(s.index)) {
        const left = withoutFiles(s.slide, (ref) => !ref.startsWith(GEOM_PREFIX) || names.has(ref));
        s.slide = left.slide;
        geomLeft = { dropped: left.dropped, unmasked: left.unmasked, missing: left.missing };
      }
      s.slide = nameGeoms(s.slide, names);
      call.out.set(s.index, {
        s,
        media,
        extra: extras.get(s.index),
        ...(geomLeft ? { geomLeft } : {}),
        ...(rescue ? { rescued: true } : {}),
      });
    }
  }

  /** The key a bake stands under in the part maps (`bakes.ts`), recorded with its part and recipe. */
  private bakeKeyOf(part: string, bake: PictureBake): string {
    const key = bakeMapKey(part, bake);
    this.bakes.set(key, { part, bake });
    return key;
  }

  /** Step 3: one draft per listed slide with its class, notes, hidden flag, transition and timing. */
  private drafts(listed: readonly SlideRef[], converted: Map<number, Converted>, scan: SceneScan): Draft[] {
    const notes = new Map(scan.notes);
    let notesBytes = 0;
    let notesCut = 0;
    const drafts = listed.map((ref) => {
      const c = converted.get(ref.index);
      const label = `slide ${ref.index + 1}`;
      // The converter's budget notes: the job notes what its own budget ladder did (step 3).
      const own = c ? c.s.notes.filter((n) => n !== SLIDE_BUDGET_NOTE && n !== SLIDE_BYTES_NOTE) : [];
      const d: Draft = c
        ? {
            ref,
            slide: { ...c.s.slide, objects: c.s.slide.objects.map(imported) },
            media: c.media,
            cls: c.s.classification.class,
            notes: own,
            ...(c.s.art && !c.rescued ? { art: c.s.art, artText: c.s.art.text } : {}),
            ...(c.s.clips?.length && !c.rescued ? { clips: c.s.clips } : {}),
          }
        : {
            // Nothing of it could be read, not even its text (M9: never a picture).
            ref,
            slide: { id: newId(), objects: [] },
            media: new Map(),
            cls: 'hybrid',
            notes: ['not converted: nothing of it could be read'],
            dropped: [missingEntry('slide')],
          };
      if (c?.rescued) {
        d.cls = 'hybrid';
        d.dropped = addMissing(d.dropped, 'slide');
      }
      if (d.cls !== 'picture' && (c?.geomLeft?.dropped || c?.geomLeft?.unmasked))
        this.leftOut(d, c.geomLeft, 'batch');
      for (const n of own) this.log.add('info', `${label}: ${n}`);
      if (c?.s.classification.class === 'picture')
        this.log.add('info', `${label}: picture class (${c.s.classification.reasons.join(', ')})`);
      if (ref.hidden) d.slide.hidden = true;
      let text = notes.get(ref.index);
      if (text) {
        const bytes = utf8Bytes(text);
        if (notesBytes + bytes > NOTES_TOTAL_BYTES) {
          text = text.slice(0, NOTES_CUT_CHARS);
          notesCut++;
        }
        notesBytes += utf8Bytes(text);
        d.slide.notes = text;
      }
      const x = c?.extra;
      if (x?.transition) d.slide.transition = x.transition;
      if (x?.advanceMs !== undefined && x.advanceMs > 0) d.slide.durationMs = x.advanceMs;
      if (x?.note) {
        addNote(d.notes, x.note);
        this.log.add('info', `${label}: ${x.note}`);
      }
      // The metafiles the slide draws, set aside by the converter (item D): LibreOffice converts them.
      const mf = c?.rescued ? undefined : c?.s.metafiles;
      if (mf?.length && d.cls !== 'picture') {
        if (this.lo) {
          d.metafiles = mf.map((m) => ({ ...m, object: imported(m.object) }));
          addNote(d.notes, `${mf.length} metafile picture(s) wait for LibreOffice`);
        } else {
          d.missing = addMissing(d.missing, 'metafile');
          addNote(d.notes, `not drawn: ${mf.length} vector picture(s) (EMF, WMF)`);
        }
      }
      if (c && !c.rescued && d.cls !== 'picture') {
        if (this.lo) {
          if (d.art) d.artKinds = artKinds(c.s.classification.reasons);
        } else this.gaps(d, c.s);
      }
      if (d.cls === 'picture') toPicture(d);
      return d;
    });
    if (notesCut)
      this.warn(
        'notes',
        `the speaker notes of ${notesCut} slide(s) were cut: a presentation keeps at most ${NOTES_TOTAL_BYTES / 1024 ** 2} MB of notes`,
      );
    return drafts;
  }

  /**
   * M9, without LibreOffice: what LibreOffice would have drawn on this slide is listed (`Draft.missing`). A
   * converter told so lists it itself (`EmittedSlide.missing`, its note already in the slide's notes); one
   * that still planned the art has it dropped here, by the kinds of the art's reasons (`artKinds`). The slide
   * is then hybrid with no art object (design/27 M9 decision 8), its art's text kept for search.
   */
  private gaps(d: Draft, e: EmittedSlide): void {
    for (const m of Array.isArray(e.missing) ? e.missing : [])
      if (typeof m === 'string') d.missing = addMissing(d.missing, m);
    if (e.artText && !d.artText) d.artText = e.artText;
    if (d.art) {
      const kinds = artKinds(e.classification.reasons);
      for (const k of kinds) d.missing = addMissing(d.missing, k);
      if (kinds.length) addNote(d.notes, `not drawn: ${kinds.map(missingLabel).join(', ')}`);
      delete d.art;
    }
    if (d.missing?.length && d.cls === 'native') d.cls = 'hybrid';
    // An art that only improved on what version 1 draws (flat 3-D past the object budget): nothing is missing.
    else if (!d.missing?.length && !d.dropped?.length && d.cls === 'hybrid') d.cls = 'native';
  }

  /**
   * Objects of `d` left out for its outline files (M9 `ladder.ts` `withoutFiles`): past the batch's or the
   * import's budget of files, or files the store could not take. What they drew is missing (class hybrid).
   */
  private leftOut(
    d: Draft,
    left: { dropped: number; unmasked: number; missing: MissingKind[] },
    why: 'batch' | 'import' | 'store',
  ): void {
    for (const k of left.missing) d.dropped = addMissing(d.dropped, k);
    if (left.dropped && d.cls === 'native') d.cls = 'hybrid';
    const parts = [
      ...(left.dropped ? [`${left.dropped} shape(s) left out`] : []),
      ...(left.unmasked ? [`${left.unmasked} picture(s) drawn without their outline`] : []),
    ].join(', ');
    const n = d.ref.index + 1;
    if (why === 'store') {
      addNote(d.notes, `its shape outlines could not be stored: ${parts}`);
      return;
    }
    addNote(d.notes, `over the import budget of shape outlines: ${parts}`);
    this.warn(
      'budget',
      why === 'batch'
        ? `slide ${n}'s shape outlines pass what one conversion batch may return: ${parts}`
        : `slide ${n}'s shape outlines pass the import's ${formatBytes(this.limits.geomFileBytes)} of outline files: ${parts}`,
    );
  }

  /**
   * Step 3: the §3.4 budgets, M9's budget ladder (`ladder.ts`): outline files within the import's budget,
   * each slide within 64 KB (`fitSlideBudget`), the presentation within 4 MiB (its tail stored minimal). No
   * slide becomes a picture. Returns how many slides it simplified (formatting or decorations left out).
   */
  private budget(drafts: Draft[]): number {
    // Outline files, admitted one by one in slide order while the import's budget holds; what names one past
    // it (or one dropped as its batch arrived) is left out.
    const admitted = new Set<string>();
    let fileBytes = 0;
    for (const d of drafts) {
      if (d.cls === 'picture') continue;
      const refs = drawnGeomRefs(d.slide);
      if (!refs.length) continue;
      const keep = new Set<string>();
      for (const name of refs) {
        if (admitted.has(name)) {
          keep.add(name);
          continue;
        }
        if (this.geomDropped.has(name)) continue;
        const f = this.geomFiles.get(name);
        // Not this import's file (the store's already, `storeGeomFiles`): it costs nothing here.
        if (!f) {
          keep.add(name);
          continue;
        }
        if (fileBytes + f.bytes.length > this.limits.geomFileBytes) continue;
        admitted.add(name);
        keep.add(name);
        fileBytes += f.bytes.length;
      }
      if (keep.size === refs.length) continue;
      const left = withoutFiles(d.slide, (ref) => keep.has(ref));
      d.slide = left.slide;
      this.leftOut(d, left, 'import');
    }
    // Each slide fitted, then the presentation's tail (a re-import's kept slides take their part, `reserve`).
    const max = SIZE_BUDGETS.slideMax;
    const { slides, plan } = planLadder(
      drafts.map((d) => ({ slide: record(d, DIGEST_STANDIN, this.lo), fixed: d.cls === 'picture' })),
      IMPORT_RESERVE_BYTES + (Number.isFinite(this.reserve) && this.reserve > 0 ? this.reserve : 0),
    );
    let simplified = 0;
    drafts.forEach((d, i) => {
      const r = slides[i]!;
      if (d.cls === 'picture' || r.level === 'full') return;
      const { pptx: _, ...slide } = r.slide;
      d.slide = slide;
      const n = d.ref.index + 1;
      if (r.level === 'grid')
        this.log.add(
          'info',
          `slide ${n}: its outlines were redrawn on a 1/16 px grid to fit the slide budget`,
        );
      // Re-gridded, or over the budget with nothing it may leave out (its text alone): kept whole.
      if (r.level === 'grid' || (!r.tail && !r.dropped && !r.plain)) {
        if (r.bytes > max)
          this.warn(
            'budget',
            `slide ${n} is over ${max / 1024} KB with only its text and pictures (${formatBytes(r.bytes)}): it keeps them all`,
          );
        return;
      }
      d.simplified = true;
      simplified++;
      for (const k of r.missing) d.dropped = addMissing(d.dropped, k);
      if (r.missing.length && d.cls === 'native') d.cls = 'hybrid';
      if (r.tail) {
        addNote(d.notes, 'the presentation reached its size budget: only its text and pictures are kept');
        return;
      }
      const what = [
        ...(r.plain ? [`the formatting of ${r.plain} text box(es)`] : []),
        ...(r.dropped ? [`${r.dropped} decoration shape(s)`] : []),
      ].join(' and ');
      addNote(d.notes, `simplified to fit the slide budget: ${what} left out`);
      this.warn(
        'budget',
        r.bytes > max
          ? `slide ${n} is over ${max / 1024} KB: ${what} left out, and it is still ${formatBytes(r.bytes)} with only its text and pictures`
          : `slide ${n} is over ${max / 1024} KB: ${what} left out to fit`,
      );
    });
    if (plan.tailFrom >= 0)
      this.warn(
        'budget',
        `the presentation reached its size budget (${SIZE_BUDGETS.presentationMax / 1024 ** 2} MiB): slide ${plan.tailFrom + 1} and later keep only their text and pictures`,
      );
    if (!plan.fits) {
      // Even minimal the slides are over the budget (their text alone): the tail's text, and what picture
      // slides keep for search, is cut.
      let cut = 0;
      for (const [i, d] of drafts.entries()) {
        if (d.cls === 'picture') {
          if (!d.artText || d.artText.length <= COMPACT_TEXT_CHARS) continue;
          d.artText = cutText(d.artText, COMPACT_TEXT_CHARS);
          cut++;
          continue;
        }
        if (!slides[i]!.tail) continue;
        let changed = false;
        d.slide = {
          ...d.slide,
          objects: d.slide.objects.map((o) => {
            if (o.type !== 'text' || o.text.length <= COMPACT_TEXT_CHARS) return o;
            changed = true;
            return { ...o, text: cutText(o.text, COMPACT_TEXT_CHARS) } satisfies TextObject;
          }),
        };
        if (changed) {
          cut++;
          addNote(
            d.notes,
            `its text was cut to ${COMPACT_TEXT_CHARS} characters a box: the deck is too large`,
          );
        }
      }
      this.warn(
        'budget',
        `the deck is over ${SIZE_BUDGETS.presentationMax / 1024 ** 2} MiB even with every slide minimal: the text of ${cut} slide(s) was cut to ${COMPACT_TEXT_CHARS} characters a box`,
      );
    }
    return simplified;
  }

  /**
   * Step 3b: the geometry files the kept slides name, stored once each (`storeGeomFiles`). The objects that
   * name a file that could not be stored are left out (a shape whose file never arrives draws nothing,
   * `geom/stored.ts`); the slide keeps the rest.
   */
  private async storeGeoms(drafts: Draft[]): Promise<void> {
    const names: string[] = [];
    for (const d of drafts) if (d.cls !== 'picture') names.push(...drawnGeomRefs(d.slide));
    if (!names.length) return;
    const r = await storeGeomFiles(this.deps.store, this.deps.lib, this.geomFiles, names, (m) =>
      this.warn('geometry', m),
    );
    if (r.written) this.ctx.log(`${r.written} shape outline file(s) stored`);
    if (!r.failed.length) return;
    const failed = new Set(r.failed);
    for (const d of drafts) {
      if (d.cls === 'picture' || !drawnGeomRefs(d.slide).some((x) => failed.has(x))) continue;
      const left = withoutFiles(d.slide, (ref) => !failed.has(ref));
      d.slide = left.slide;
      this.leftOut(d, left, 'store');
    }
  }

  /**
   * Step 4: every picture the kept slides use, prepared to its display need and stored once (`storePictures`,
   * item C: deduplicated through the media hash index, one decode budget per import, resume pairs in
   * `done.media`); part → media id.
   */
  private async pictures(
    drafts: Draft[],
    spilled: Map<string, string>,
    sizes: Map<string, PictureHeader>,
  ): Promise<Map<string, string>> {
    // The display need of each part: its widest use, over every batch (placeholders are per batch).
    const needs = new Map<string, number>();
    const byBatch = new Map<Map<string, string>, Slide[]>();
    for (const d of drafts) {
      const list = byBatch.get(d.media) ?? [];
      list.push(d.slide);
      byBatch.set(d.media, list);
    }
    // A recoloured picture's need is measured with its source's size; a tile fills its box.
    const sizeOf = (key: string) => {
      const b = this.bakes.get(key);
      return b ? (b.bake.tile ? undefined : sizes.get(b.part)) : sizes.get(key);
    };
    for (const [media, slides] of byBatch) {
      if (!media.size) continue;
      const used = usedPlaceholders(slides);
      const list = [...media].filter(([id]) => used.has(id)).map(([id, part]) => ({ id, part }));
      if (!list.length) continue;
      let got: Map<string, number>;
      try {
        got = displayNeeds(slides, list, sizeOf);
      } catch (e) {
        // Without a measured need every picture is prepared for the widest output.
        this.warn('picture', `picture sizes could not be measured (${logSafe(errorMessage(e))})`);
        got = new Map(list.map((m) => [m.part, DEFAULT_NEED_PX]));
      }
      for (const m of list) if (!got.has(m.part)) got.set(m.part, DEFAULT_NEED_PX);
      for (const [part, px] of got) needs.set(part, Math.max(px, needs.get(part) ?? 0));
    }
    const items: PictureItem[] = [];
    const bakeItems: BakeItem[] = [];
    for (const [part, need] of needs) {
      const b = this.bakes.get(part);
      const file = spilled.get(b ? b.part : part);
      if (b && file) bakeItems.push({ key: part, part: b.part, file, bake: b.bake, need });
      else if (file) items.push({ part, file, need });
      else if (!this.done.media.some(([p]) => p === part))
        this.warn('picture', `a picture is missing from the deck (${logSafe(b ? b.part : part)})`);
    }
    // M6: recoloured pictures and tiled fills, baked; one that cannot be shows its source picture as it is.
    const budget = new PictureBudget();
    const baked = await this.storeBakes(bakeItems, budget);
    for (const [key] of baked.failed) {
      const b = bakeItems.find((i) => i.key === key)!;
      const plain = items.find((i) => i.part === b.part);
      if (plain) plain.need = Math.max(plain.need, b.need);
      else items.push({ part: b.part, file: b.file, need: b.need });
    }
    const withBakes = (m: Map<string, string>) => {
      for (const [key, id] of baked.media) m.set(key, id);
      for (const [key] of baked.failed) {
        const id = m.get(bakeItems.find((i) => i.key === key)!.part);
        if (id) m.set(key, id);
      }
      return m;
    };
    if (!items.length)
      return withBakes(new Map(this.done.media.filter(([, id]) => this.deps.lib.media.get(id))));
    const res = await storePictures(this.deps, items, {
      dir: this.scratch,
      timeoutMs: this.deps.cfg.timeouts.light,
      signal: this.ctx.signal,
      budget,
      done: this.done.media,
      save: this.save,
      saveEveryMs: SAVE_EVERY_MS,
      name: (part) =>
        `${this.title} – ${baseName(logSafe(part.slice(part.lastIndexOf('/') + 1), 100))}`.slice(0, 200),
      tags: ['pptx'],
      log: (msg) => {
        if (msg.startsWith('[warn] '))
          this.warn('picture', `a picture could not be imported: ${msg.slice(7)}`);
        else this.log.add('info', msg);
      },
      progress: (n, of) => this.ctx.progress(0.6 + (0.35 * n) / Math.max(1, of)),
    });
    if (this.ctx.signal.aborted) throw new Cancelled();
    for (const part of res.metafiles)
      this.warn('picture', `${logSafe(part)} is a metafile under another name: not imported`);
    this.save();
    this.ctx.log(
      `${res.media.size} of ${items.length} picture(s) stored (${res.prepared} prepared, ${res.reused} found already, ${res.resumed} resumed)`,
    );
    return withBakes(res.media);
  }

  /** Step 4, baked pictures (M6, `bakes.ts`): each stored once, with resume pairs in `done.media`. */
  private async storeBakes(items: BakeItem[], budget: PictureBudget) {
    if (!items.length) return { media: new Map<string, string>(), failed: [] as [string, string][] };
    const res = await storeBakes(this.deps, this.pool, items, {
      dir: this.scratch,
      timeoutMs: this.deps.cfg.timeouts.light,
      signal: this.ctx.signal,
      budget,
      done: this.done.media,
      save: this.save,
      name: (part) =>
        `${this.title} – ${baseName(logSafe(part.slice(part.lastIndexOf('/') + 1), 100))}`.slice(0, 200),
      tags: ['pptx'],
      log: (msg) => {
        if (msg.startsWith('[warn] ')) this.warn('picture', logSafe(msg.slice(7), 400));
        else this.log.add('info', msg);
      },
      // Bakes run on the pool too: their time counts against the import's (§12: 15 minutes).
      poolTime: {
        add: (ms) => {
          this.poolMs += ms;
        },
        spent: () => this.poolMs > this.limits.importPoolMs,
      },
    });
    if (this.ctx.signal.aborted) throw new Cancelled();
    this.ctx.log(
      `${res.media.size} of ${items.length} baked picture(s) stored (${res.baked} baked, ${res.reused} found already)`,
    );
    return res;
  }

  /** Step 5: remap, assemble, sanitize, digest; the follow-up's plan (`saveVersion1` saves them). */
  private assemble(
    drafts: Draft[],
    stored: Map<string, string>,
    sectionInfo: SectionInfo[],
    slideRect: { x: number; y: number; w: number; h: number },
    scan: SceneScan,
  ): Omit<NativeBuild, 'listed' | 'texts' | 'textBoxes' | 'compact' | 'simplified'> {
    const { deps, ctx } = this;
    const hash = ctx.payload.hash;
    // Remap each slide with its own batch's placeholders.
    for (const d of drafts) {
      const map = new Map<string, string>();
      for (const [ph, part] of d.media) {
        const id = stored.get(part);
        if (id) map.set(ph, id);
      }
      const before = d.slide.objects.length;
      d.slide = remapMediaIds(d.slide, map);
      if (d.slide.objects.length < before)
        addNote(d.notes, `${before - d.slide.objects.length} picture(s) could not be imported`);
      if (d.slide.lyricObjectId && !d.slide.objects.some((o) => o.id === d.slide.lyricObjectId))
        delete d.slide.lyricObjectId;
      const bg = d.slide.backgroundMediaId;
      if (bg && deps.lib.media.get(bg)?.hasAlpha) {
        // A picture with alpha is drawn on white, as PowerPoint lays every background (design/27 §4).
        delete d.slide.backgroundMediaId;
        if (d.cls !== 'picture') d.slide.objects.unshift(...backgroundOnWhite(bg, slideRect));
        addNote(d.notes, 'a background picture with transparency is drawn on white');
      }
    }
    const kind = isLoop(drafts, scan.loop) ? 'loop' : 'slides';
    const p: Presentation = {
      id: this.done.presentationId!,
      rev: 1,
      title: this.title,
      kind,
      meta: { tags: [] },
      sections: [],
      arrangements: [],
      source: { kind: 'pptx', fileId: hash },
      archived: false,
    };
    if (kind === 'loop') {
      p.loop = {
        defaultSlideMs: mostCommon(drafts.map((d) => d.slide.durationMs ?? 0).filter((v) => v > 0)),
      };
      this.log.add('info', 'a looping show with every slide timed: imported as a loop');
    }
    // One background on every slide becomes the presentation's, so the pickers swap it (the pro7 pattern). A
    // motion background stays the slides': goLive does not wait for a slide's clip (design/27 §8).
    const bgs = new Set(drafts.map((d) => d.slide.backgroundMediaId));
    const [onlyBg] = bgs;
    if (bgs.size === 1 && onlyBg && !this.clipIds.has(onlyBg)) {
      p.backgroundMediaId = onlyBg;
      for (const d of drafts) delete d.slide.backgroundMediaId;
    }
    // Provenance (the digest is set once the objects are final).
    for (const d of drafts) d.slide.pptx = provenance(d, hash, this.lo);
    p.sections = sectionsOf(drafts, sectionInfo);
    p.arrangements = [{ id: newId(), name: 'Default', sectionIds: p.sections.map((s) => s.id) }];
    sanitizePresentation(p);
    // A slide the schema refuses is stored minimal (its text, pictures and background), else as its text
    // alone, rather than failing the deck (M9: never a picture).
    const byId = new Map(drafts.map((d) => [d.slide.id, d]));
    for (const sec of p.sections)
      sec.slides = sec.slides.map((sl) => {
        const ok = Slide.safeParse(sl);
        if (ok.success) return ok.data;
        const d = byId.get(sl.id);
        this.warn(
          'slide',
          `slide ${(sl.pptx?.index ?? 0) + 1} could not be stored as converted: only its text and pictures are kept`,
        );
        if (!d) return Slide.parse({ id: sl.id, objects: [] });
        const kept = d.slide.objects.length;
        d.slide = minimalSlide(d.slide);
        if (d.slide.objects.length < kept) d.dropped = addMissing(d.dropped, 'decoration');
        if (d.cls === 'native') d.cls = 'hybrid';
        addNote(d.notes, 'not storable as converted: only its text and pictures are kept');
        d.slide.pptx = provenance(d, hash, this.lo);
        const again = Slide.safeParse(d.slide);
        if (again.success) return again.data;
        // The text rescue: each text object rebuilt from its text and box alone.
        d.slide = { ...d.slide, objects: rescuedTexts(d.slide.objects) };
        delete d.slide.lyricObjectId;
        d.dropped = addMissing(d.dropped, 'slide');
        d.slide.pptx = provenance(d, hash, this.lo);
        const text = Slide.safeParse(d.slide);
        return text.success ? text.data : Slide.parse({ id: sl.id, objects: [], pptx: d.slide.pptx });
      });
    const parsed = Presentation.parse(p);
    // The digest of the import's objects (every object here has an origin, `imported`): the "unedited" test
    // of the follow-up and re-import (`digest.ts`).
    const slides = parsed.sections.flatMap((s) => s.slides);
    for (const sl of slides) if (sl.pptx) sl.pptx.digest = importDigest(sl.objects);
    const classes = slides.map((sl) => sl.pptx?.class ?? 'native');
    const counts = {
      native: classes.filter((c) => c === 'native').length,
      hybrid: classes.filter((c) => c === 'hybrid').length,
      picture: classes.filter((c) => c === 'picture').length,
    };
    parsed.source = {
      kind: 'pptx',
      fileId: hash,
      native: { version: CONVERTER_VERSION, slides: slides.length, ...counts, slideRect },
    };
    this.log.add(
      'info',
      `${slides.length} slide(s): ${counts.native} native, ${counts.hybrid} hybrid, ${counts.picture} picture`,
    );
    const lo = loSlides(drafts, slides);
    if (lo.length) this.log.add('info', `${lo.length} slide(s) wait for LibreOffice`);
    const gaps = slides.filter((sl) => sl.pptx?.missing?.length).length;
    if (gaps)
      this.log.add('info', `${gaps} slide(s) have something ordo cannot draw (no LibreOffice on this hub)`);
    const fonts = missingFonts(
      fontFamilies(slides),
      deps.lib.listFonts().map((f) => f.family),
    );
    for (const f of fonts) this.log.add('info', `font not available: ${f}`);
    parsed.source.log = this.log.toString();
    return {
      p: parsed,
      lo,
      clipIds: this.clipIds,
      clipsCreated: this.clipsCreated,
      missingFonts: fonts,
    };
  }

  /** Step 6: save version 1 and queue the LibreOffice follow-up, then the clips' media jobs. */
  private saveVersion1(b: NativeBuild): PptxNativeResult {
    const { deps, ctx } = this;
    const hash = ctx.payload.hash;
    const { p: parsed, lo, compact, simplified, missingFonts: fonts } = b;
    const classes = parsed.sections.flatMap((s) => s.slides).map((sl) => sl.pptx?.class ?? 'native');
    // Version 1, its follow-up and the resume point in one transaction: the follow-up cannot start before
    // the save, and a process that dies in between leaves neither (a re-run imports again), never a version 1
    // whose follow-up lost its art and metafile plans.
    let loJobId: string | undefined;
    const saved = deps.lib.db.transaction(() => {
      const v1 = deps.lib.savePresentation(parsed, { create: true, by: 'pptx-import' });
      let after: Job | undefined;
      // Without LibreOffice nothing is pending (`provenance`), so no follow-up is ever queued.
      if (lo.length && this.lo) {
        const job = enqueuePptx(deps.jobs, PPTX_JOBS.lo, {
          presentationId: v1.id,
          hash,
          version: CONVERTER_VERSION,
          slides: lo,
        });
        loJobId = job.id;
        this.done.loJobId = loJobId;
        after = job;
      }
      // The clips' media jobs, after the follow-up (jobs of a class run in creation order): never awaited.
      for (const id of this.clipIds) after = deps.media.queue(id, after ? { after } : {}) ?? after;
      this.save();
      return v1;
    })();
    deps.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
    return {
      ...importResult({
        presentationId: saved.id,
        classes,
        compact,
        simplified,
        missing: missingSlides(parsed),
        pending: loJobId ? lo.length : 0,
        ...(loJobId ? { loJobId } : {}),
        missingFonts: fonts,
        notes: this.log.warnings(),
      }),
      libreoffice: this.lo,
    };
  }
}

/** Slides of a presentation with something nothing draws (`Slide.pptx.missing`). */
function missingSlides(p: Presentation): number {
  let n = 0;
  for (const sec of p.sections) for (const sl of sec.slides) if (sl.pptx?.missing?.length) n++;
  return n;
}

/**
 * A job re-run after version 1 was saved: its result. Version 1, its follow-up and `done.loJobId` are written
 * in one transaction, so the follow-up exists; a payload from before that (no `loJobId`) gets one planned from
 * the stored slides.
 */
function resumedResult(
  deps: PptxDeps,
  ctx: JobCtx<PptxNativePayload>,
  saved: Presentation,
  done: PptxNativeProgress,
  save: () => void,
): PptxNativeResult {
  const slides = saved.sections.flatMap((s) => s.slides);
  const pending = slides.filter((s) => s.pptx?.pending);
  if (pending.length && !done.loJobId) {
    const lo: PptxLoSlide[] = pending.map((s) => ({
      slideId: s.id,
      index: s.pptx!.index,
      ...(s.pptx!.shown !== undefined ? { shown: s.pptx!.shown } : {}),
      class: s.pptx!.class,
      digest: s.pptx!.digest ?? '',
    }));
    done.loJobId = enqueuePptx(deps.jobs, PPTX_JOBS.lo, {
      presentationId: saved.id,
      hash: ctx.payload.hash,
      version: CONVERTER_VERSION,
      slides: lo,
    }).id;
    save();
  }
  ctx.log('resumed: version 1 was already saved');
  return {
    ...importResult({
      presentationId: saved.id,
      classes: slides.map((s) => s.pptx?.class ?? 'native'),
      compact: 0,
      missing: missingSlides(saved),
      pending: pending.length,
      ...(done.loJobId ? { loJobId: done.loJobId } : {}),
      missingFonts: [],
      notes: ['resumed after a restart: version 1 was already saved'],
    }),
    libreoffice: deps.tools.has('libreoffice'),
  };
}

// ── Helpers (pure) ──────────────────────────────────────────────────────────────────────────────────────

/** The pixel size of a spilled picture from its first bytes (64 KB, or up to 1 MB for a JPEG). */
async function spilledSize(file: string): Promise<{ w: number; h: number } | undefined> {
  try {
    const b = await head(file, SIZE_HEAD_BYTES);
    const px = pictureSize(b);
    if (px || b.length < SIZE_HEAD_BYTES || b[0] !== 0xff || b[1] !== 0xd8) return px;
    return pictureSize(await head(file, SIZE_HEAD_MAX_BYTES));
  } catch {
    return undefined;
  }
}

async function head(file: string, n: number): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const b = new Uint8Array(n);
    const { bytesRead } = await fh.read(b, 0, n, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The text of a slide's text objects, for search and labels (`pptx.artText`). */
function textOfObjects(objects: readonly SlideObject[]): string {
  const out: string[] = [];
  let n = 0;
  for (const o of objects) {
    if (o.type !== 'text' || !o.text.trim()) continue;
    out.push(o.text);
    n += o.text.length + 1;
    if (n > ART_TEXT_CHARS) break;
  }
  return out.join('\n').slice(0, ART_TEXT_CHARS);
}

/** The text of an emitted slide's text bodies: its text objects, then the text baked into its art. */
function bodyTexts(s: Pick<EmittedSlide, 'slide' | 'art'>): string[] {
  const out: string[] = [];
  for (const o of s.slide.objects) if (o.type === 'text' && o.text.trim()) out.push(o.text);
  if (s.art?.text?.trim()) out.push(s.art.text);
  return out;
}

/** `bodyTexts` with where each body is (the art's text at the art's box). */
function bodyBoxes(s: Pick<EmittedSlide, 'slide' | 'art'>): { text: string; box: Box }[] {
  const out: { text: string; box: Box }[] = [];
  for (const o of s.slide.objects)
    if (o.type === 'text' && o.text.trim()) out.push({ text: o.text, box: o.box });
  if (s.art?.text?.trim()) out.push({ text: s.art.text, box: { ...s.art.box, rotation: 0 } });
  return out;
}

/** `s` cut to at most `n` UTF-16 units, never inside a surrogate pair. */
function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/**
 * The text objects of a slide the schema refused even minimal, each rebuilt from its text and box alone in a
 * plain style (the last of M9's rescues: the words stay, editable).
 */
function rescuedTexts(objects: readonly SlideObject[]): TextObject[] {
  const out: TextObject[] = [];
  for (const o of objects) {
    if (o?.type !== 'text' || typeof o.text !== 'string' || !o.text.trim()) continue;
    const size = o.style?.fontSizePx;
    out.push({
      id: newId(),
      type: 'text',
      box: clampBox(o.box),
      text: cutText(o.text, ART_TEXT_CHARS),
      style: {
        fontFamily: 'Calibri',
        fontWeight: 400,
        fontStyle: 'normal',
        fontSizePx: typeof size === 'number' && size >= 4 && size <= 1000 ? size : 40,
        color: { r: 0, g: 0, b: 0, a: 1 },
        align: 'left',
        valign: 'top',
        lineHeight: 1.2,
        letterSpacing: 0,
        padding: 0,
        transform: 'none',
      },
      opacity: 1,
      origin: { src: 'pptx', role: 'text' },
    });
    if (out.length >= 1_000) break;
  }
  return out;
}

/** Make a draft picture class: no objects, its text kept for search (version 2 adds the page picture). */
function toPicture(d: Draft): void {
  const text = textOfObjects(d.slide.objects);
  d.cls = 'picture';
  d.slide.objects = [];
  delete d.slide.lyricObjectId;
  delete d.art;
  delete d.metafiles;
  // The whole slide is what is missing now (`provenance`), and what LibreOffice draws is its page.
  delete d.missing;
  delete d.artKinds;
  // A hybrid slide's art text is part of the page too.
  const all = [text, d.artText].filter(Boolean).join('\n').slice(0, ART_TEXT_CHARS);
  if (all) d.artText = all;
  else delete d.artText;
}

/** A stand-in for `Slide.pptx.digest` in size estimates: as long as `digestOf`'s. */
const DIGEST_STANDIN = 'x'.repeat(16);

/** The slide as it will be stored, with a stand-in digest (for its size). */
function record(d: Draft, digest: string, lo: boolean): Slide {
  return { ...d.slide, pptx: { ...provenance(d, 'x'.repeat(64), lo), digest } };
}

/**
 * `Slide.pptx` of a draft (without its digest). With LibreOffice (`lo`), a hybrid or picture slide and one
 * with metafile pictures waits for it (`pending`); without it nothing waits, and what nothing draws is listed
 * (`missing`: the draft's, or 'slide' for a picture-class slide, design/27 M9).
 */
function provenance(d: Draft, hash: string, lo: boolean): SlidePptx {
  // A hybrid slide waits for its art; one that is hybrid only for what the budgets left out does not.
  const pending = lo && (d.cls === 'picture' || !!d.art || !!d.metafiles?.length);
  let missing = lo ? undefined : d.cls === 'picture' ? [missingEntry('slide')] : d.missing;
  if (d.cls !== 'picture')
    for (const e of d.dropped ?? []) missing = addMissing(missing ? [...missing] : [], e);
  const artText = d.artText;
  return {
    fileId: hash,
    index: d.ref.index,
    ...(d.ref.shown !== undefined ? { shown: d.ref.shown } : {}),
    class: d.cls,
    version: CONVERTER_VERSION,
    ...(pending ? { pending: true } : {}),
    ...(missing?.length ? { missing: missing.slice(0, MISSING_LIMITS.entries) } : {}),
    ...(d.notes.length ? { notes: d.notes.slice(0, SLIDE_NOTES).map((n) => logSafe(n)) } : {}),
    ...(artText ? { artText } : {}),
  };
}

/** The placeholder ids a batch's slides use. */
function usedPlaceholders(slides: readonly Slide[]): Set<string> {
  const used = new Set<string>();
  for (const s of slides) {
    if (s.backgroundMediaId?.startsWith(MEDIA_PREFIX)) used.add(s.backgroundMediaId);
    for (const o of s.objects)
      if (o.type === 'image' && o.mediaId.startsWith(MEDIA_PREFIX)) used.add(o.mediaId);
  }
  return used;
}

/**
 * `o` marked as a PowerPoint import's (`origin`, design/27 §3.1), unless the converter marked it already. A
 * slide set to show its PowerPoint picture draws that picture and only the objects without an origin, the
 * ones the operator added in ordo (`slideContent`, design/27 §5).
 */
function imported<T extends SlideObject>(o: T): T {
  return o.origin ? o : { ...o, origin: { src: 'pptx' } };
}

/** A background picture with alpha as PowerPoint draws it: on a white rect over the slide area. */
function backgroundOnWhite(
  mediaId: string,
  rect: { x: number; y: number; w: number; h: number },
): [ShapeObject, ImageObject] {
  const box = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, rotation: 0 };
  const origin = { src: 'pptx', role: 'bg' };
  return [
    { id: newId(), type: 'shape', box, shape: 'rect', fill: WHITE, opacity: 1, radius: 0, origin },
    {
      id: newId(),
      type: 'image',
      box: { ...box },
      mediaId,
      fit: 'stretch',
      opacity: 1,
      radius: 0,
      origin: { ...origin },
    },
  ];
}

/**
 * Sections in slide order: each run of consecutive slides of one `p14:section` is an ordo section under its
 * name; slides in none are 'Slides'. Without sections, one 'Slides' section. Empty sections are left out.
 */
function sectionsOf(drafts: readonly Draft[], info: readonly SectionInfo[]): Section[] {
  const of = new Map<number, number>();
  info.forEach((s, i) => {
    for (const idx of s.slides) if (!of.has(idx)) of.set(idx, i);
  });
  const out: Section[] = [];
  let cur: number | undefined | null = null;
  for (const d of drafts) {
    const s = of.get(d.ref.index);
    if (s !== cur || !out.length) {
      const label = s === undefined ? 'Slides' : logSafe(info[s]!.name, 60) || 'Slides';
      out.push({ id: newId(), label, short: '', slides: [] });
      cur = s;
    }
    out[out.length - 1]!.slides.push(d.slide);
  }
  return out;
}

/** Whether a looping show has every shown slide timed: the presentation becomes a loop. */
function isLoop(drafts: readonly Draft[], loops: boolean): boolean {
  if (!loops) return false;
  const shown = drafts.filter((d) => !d.ref.hidden);
  return shown.length > 0 && shown.every((d) => (d.slide.durationMs ?? 0) > 0);
}

function mostCommon(values: readonly number[]): number {
  const n = new Map<number, number>();
  let best = values[0] ?? 5_000;
  for (const v of values) {
    n.set(v, (n.get(v) ?? 0) + 1);
    if (n.get(v)! > (n.get(best) ?? 0)) best = v;
  }
  return Math.max(500, best);
}

/** The slides the LibreOffice follow-up works on, from version 1 as stored. */
function loSlides(drafts: readonly Draft[], slides: readonly Slide[]): PptxLoSlide[] {
  const byId = new Map(drafts.map((d) => [d.slide.id, d]));
  const out: PptxLoSlide[] = [];
  for (const sl of slides) {
    if (!sl.pptx?.pending) continue;
    const d = byId.get(sl.id);
    out.push({
      slideId: sl.id,
      index: sl.pptx.index,
      ...(sl.pptx.shown !== undefined ? { shown: sl.pptx.shown } : {}),
      class: sl.pptx.class,
      ...(d?.art && sl.pptx.class === 'hybrid' ? { art: d.art } : {}),
      ...(d?.metafiles?.length && sl.pptx.class !== 'picture' ? { metafileObjects: d.metafiles } : {}),
      digest: sl.pptx.digest ?? '',
      ...(d?.art && sl.pptx.class === 'hybrid' ? { replaced: replacedOf(sl, d.art) } : {}),
      kinds: loKinds(sl.pptx.class, d),
    });
  }
  return out;
}

/**
 * What a waiting slide lacks if LibreOffice never draws it (`PptxLoSlide.kinds`, `withoutLibreOffice`): none
 * for an art that only improves on what version 1 draws (`artKinds` empty: flat 3-D past the object budget).
 */
function loKinds(cls: SlideClass, d: Draft | undefined): string[] {
  if (cls === 'picture' || !d) return [missingEntry('slide')];
  let out: string[] = [];
  if (d.art) for (const k of d.artKinds ?? (['element'] as const)) out = addMissing(out, k);
  if (d.metafiles?.length) out = addMissing(out, 'metafile');
  return d.art || d.metafiles?.length ? out : [missingEntry('element')];
}

/** `list` with `entry` added once (a stored `Slide.pptx.missing` entry, within its bounds). */
function addMissing(list: string[] | undefined, entry: string): string[] {
  const colon = entry.indexOf(':');
  const e = missingEntry(missingKind(entry), colon > 0 ? entry.slice(colon + 1) : undefined);
  const out = list ?? [];
  if (!out.includes(e) && out.length < MISSING_LIMITS.entries) out.push(e);
  return out;
}

/** Reasons of a hybrid slide's art whose element ordo draws as a shape (what a decoration loses). */
const SHAPE_REASONS: ReadonlySet<string> = new Set(['shapes', 'custGeom', 'geom', 'preset', 'path']);

/**
 * The kinds of what a hybrid slide's art holds, read from the converter's `art:<reason>` reasons (design/27
 * M9: what a hub without LibreOffice lists in `Slide.pptx.missing` when the converter does not list it
 * itself, and `PptxLoSlide.kinds` with LibreOffice). A reason the converter's decision table names
 * (`residual.ts` `rowOf`) has the kind the converter records for it without LibreOffice (`missingKindOf`),
 * so both lists agree; for any other reason: a metafile picture (EMF, WMF), decoration shapes for geometry,
 * the reason's own kind when it is one (chart, SmartArt, OLE, an equation, ink), 'element' for the rest. A
 * reason whose element version 1 draws as ordo draws it within the budgets (`ResidualRow.drawn`: flat 3-D
 * past the object budget) has none: an art of only those lacks nothing ([]). Deck strings are only compared.
 */
export function artKinds(reasons: readonly string[]): MissingKind[] {
  const out: MissingKind[] = [];
  let drawn = false;
  for (const r of reasons) {
    if (typeof r !== 'string' || !r.startsWith('art:')) continue;
    const reason = r.slice(4);
    if (rowOf(reason)?.drawn) {
      drawn = true;
      continue;
    }
    let k = reason;
    if (k.startsWith('budget:')) k = k.slice(7);
    const head = k.split(':')[0] ?? '';
    const kind: MissingKind =
      rowOf(reason)?.missing ??
      (k === 'pic:emf' || k === 'pic:wmf'
        ? 'metafile'
        : SHAPE_REASONS.has(head)
          ? 'decoration'
          : missingKind(head));
    if (!out.includes(kind)) out.push(kind);
  }
  return out.length || drawn ? out : ['element'];
}

/** Version 1's objects the art replaces, each with its own digest (`PptxLoSlide.replaced`). */
function replacedOf(slide: Slide, art: ArtInfo): [string, string][] {
  const want = new Set(art.replaces);
  return slide.objects.filter((o) => want.has(o.id)).map((o) => [o.id, digestOf([o])]);
}

/** The families the slides' text asks for, in first-use order. */
function fontFamilies(slides: readonly Slide[]): string[] {
  const out = new Set<string>();
  for (const s of slides) for (const o of s.objects) if (o.type === 'text') out.add(o.style.fontFamily);
  return [...out];
}
