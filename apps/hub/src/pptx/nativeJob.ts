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
 * **A scene parsed on the client** (`PptxNativePayload.sceneHash`, `stepsFromClientScene`), once the pool has
 * checked it (`clientScene.ts`), takes the place of step 2's batches and follows the same rules with the same
 * import core (`@ordo/importers` `pptx-core.ts`): a slide past the client's bound on outline files loses the
 * objects naming the files it was not given, and a slide the client could not read gets the text rescue here.
 * A scene the check refuses makes the job parse the deck itself; the scene file is released once version 1 is
 * saved or the import fails.
 */
import { open, rm, stat } from 'node:fs/promises';
import { type Box, drawnGeomRefs, newId, type Presentation, type Slide } from '@ordo/domain';
import {
  bodyBoxes,
  bodyTexts,
  type Converted,
  type Draft,
  ImportCore,
  missingSlides,
  usedPlaceholders,
} from '@ordo/importers/pptx-core.ts';
import { withoutFiles } from '@ordo/importers/pptx-ladder.ts';
import { ImportLog } from '@ordo/importers/pptx-report.ts';
import { type PictureHeader, pictureSize, type SectionInfo, type SlideRef } from '@ordo/pptx-scene';
import type { PictureBake } from '@ordo/pptx-scene/bake.ts';
import { GEOM_PREFIX } from '@ordo/pptx-scene/emit.ts';
import { relsPartOf } from '@ordo/pptx-scene/opc.ts';
import type { Job } from '@ordo/protocol';
import { errorMessage } from '../errors.ts';
import type { JobCtx, JobHandler } from '../jobs.ts';
import { baseName } from '../media/service.ts';
import { type CpuPool, cpuPool, transferables, WorkerStartError } from '../pool.ts';
import { type BakeItem, bakeMapKey, storeBakes } from './bakes.ts';
import type { ClientSceneTaskOutput } from './clientScene.ts';
import { type ClipFile, ClipImport, spillClips } from './clips.ts';
import { type DeckXml, readDeckXml, spillDeckParts } from './deckParts.ts';
import { sceneFontFiles } from './faces.ts';
import { nameGeoms, storeGeomFiles } from './geoms.ts';
import { displayNeeds, PictureBudget, type PictureItem, storePictures } from './pictures.ts';
import { importResult, logSafe } from './report.ts';
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
  type SceneTaskInput,
  type SceneTaskOutput,
} from './shared.ts';

// Steps 3-5 are the import core's (`@ordo/importers` `pptx-core.ts`), which the client's assembly shares:
// re-exported for the hub's tests and tools.
export { artKinds, NOTES_TOTAL_BYTES } from '@ordo/importers/pptx-core.ts';

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
/** Job log lines of one kind before the rest are only counted (the job log keeps 500 lines). */
const JOB_LOG_LINES = 20;
/** How often the picture resume pairs are written while pictures are stored. */
const SAVE_EVERY_MS = 1_000;

/**
 * Another batch's slide, as a batch sees it: the root alone with its show flag, so every batch lists the deck
 * exactly as the scan did (indexes and shown places), without the other slides' content. No deck bytes.
 */
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const STUB_SHOWN = new TextEncoder().encode(`<p:sld xmlns:p="${P_NS}"/>`);
const STUB_HIDDEN = new TextEncoder().encode(`<p:sld xmlns:p="${P_NS}" show="0"/>`);
/** A picture's display need when it cannot be measured: the widest output (design/27 §4). */
const DEFAULT_NEED_PX = 3_840;

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
      if (saved) {
        const resumed = resumedResult(deps, ctx, saved, done, save);
        await releaseScene(deps, pl.sceneHash);
        return resumed;
      }
    }
    const file = deps.lib.getFile(pl.hash);
    if (!file) throw new Error('The uploaded deck is missing');
    done.presentationId ??= newId();
    save();
    const job = new NativeImport(deps, pool, limits, ctx, done, save);
    const scratch = await deps.store.tmpDir();
    let result: PptxNativeResult;
    try {
      result = await job.run(deps.store.abs(file.path), scratch);
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    await releaseScene(deps, pl.sceneHash);
    return result;
  } catch (e) {
    // Every way a run stops before version 1 (the deck gone, no scratch folder, a failed step, a cancel):
    // the clips an earlier attempt stored (the resume pairs) get their media jobs, never left waiting for
    // one. `MediaService.queue` leaves a clip already queued or processed alone.
    queueStoredClips(deps, done);
    await releaseScene(deps, pl.sceneHash);
    throw e;
  }
}

/**
 * A client scene is kept only while its import may still need it (a run that a restart resumes): once version
 * 1 is saved, or the import failed, it is released (it holds every slide's text and speaker notes, and no
 * presentation names it). A file that something references is kept (`Store.release`).
 */
async function releaseScene(deps: PptxDeps, sceneHash: string | undefined): Promise<void> {
  if (!sceneHash) return;
  try {
    await deps.store.release(sceneHash);
  } catch (e) {
    deps.log.warn({ err: errorMessage(e) }, 'pptx-native: the client scene could not be released');
  }
}

/** One run of the job (state shared by its steps). */
class NativeImport {
  /** The import core's steps 3-5 and their state (`@ordo/importers` `pptx-core.ts`): `source.log` and outline files. */
  private readonly core: ImportCore;
  private readonly options: PptxImportOptions;
  private readonly title: string;
  private readonly deps: PptxDeps;
  private readonly pool: Pick<CpuPool, 'run'>;
  private readonly limits: Limits;
  private readonly ctx: JobCtx<PptxNativePayload>;
  private readonly done: PptxNativeProgress;
  private readonly save: () => void;
  private readonly only: NativeJobEnv['only'];
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

  constructor(
    deps: PptxDeps,
    pool: Pick<CpuPool, 'run'>,
    limits: Limits,
    ctx: JobCtx<PptxNativePayload>,
    done: PptxNativeProgress,
    save: () => void,
    only?: NativeJobEnv['only'],
    reserve = 0,
  ) {
    this.deps = deps;
    this.pool = pool;
    this.limits = limits;
    this.ctx = ctx;
    this.done = done;
    this.save = save;
    this.only = only;
    this.options = ctx.payload.options ?? {};
    // The upload's file name: one line, like every other string that reaches a list or a log.
    this.title = logSafe(baseName(ctx.payload.name), 300) || 'PowerPoint';
    // LibreOffice can draw what ordo cannot (`HubTools`): decided once the tools are known (`steps`).
    this.core = new ImportCore({
      lo: true,
      log: new ImportLog(),
      warn: (kind, msg) => this.warn(kind, msg),
      geomFileBytes: limits.geomFileBytes,
      reserve,
    });
  }

  /** `source.log` (the core's). */
  private get log(): ImportLog {
    return this.core.log;
  }

  /** Whether LibreOffice draws what ordo cannot (the core's). */
  private get lo(): boolean {
    return this.core.lo;
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
    this.core.lo = lo !== 'absent' && lo !== 'off';
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
    const drafts = this.core.drafts(want ? listed.filter((r) => want.has(r.index)) : listed, converted, scan);
    const simplified = this.core.budget(drafts);

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
   * A scene parsed in the uploading browser (`parsePptxScene`, `PptxNativePayload.sceneHash`) in place of
   * step 2's batches: read, parsed and checked in the pool (`clientScene.ts`: the schema with its bounds, this
   * hub's converter version, stored fields and LibreOffice, every shape file re-checked and re-hashed), then
   * the pictures and clips spilled from the stored deck as for the hub's own parse, and the import core's
   * steps 3-5. No slide is converted here but for the text rescue of a slide the client could not read
   * (`rescueClientSlides`). A refused scene, a pool that fails on it or one that is gone: undefined, and the
   * hub parses the deck itself, saying why in the job's log.
   */
  private async stepsFromClientScene(
    deck: string,
    scratch: string,
    sceneHash: string,
  ): Promise<NativeBuild | undefined> {
    const { ctx } = this;
    const sf = this.deps.lib.getFile(sceneHash);
    if (!sf) return undefined;
    let checked: ClientSceneTaskOutput;
    try {
      checked = await this.pool.run(
        'pptx-client-scene',
        { file: this.deps.store.abs(sf.path), libreoffice: this.lo },
        { signal: ctx.signal },
      );
    } catch (e) {
      this.checkCancelled();
      checked = { refused: `its check failed (${logSafe(errorMessage(e), 120)})` };
    }
    if ('refused' in checked) {
      ctx.log(`the scene parsed in the browser was not used (${logSafe(checked.refused, 200)}): parsed here`);
      this.log.add('info', 'the scene parsed in the browser was not used: the hub parsed the deck');
      return undefined;
    }
    const raw = checked.scene;
    ctx.log('the deck was parsed in the browser: the hub checked its scene and builds from it');

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
    const media = new Map(raw.media.map((m) => [m.id, m.bake ? this.bakeKeyOf(m.part, m.bake) : m.part]));
    const extras = new Map(raw.extras.map((e) => [e.index, e]));
    // Shape files as the check re-hashed them; a slide's ref to one it dropped is removed (its shape draws
    // its geometry beside it, else its legacy form), as a batch's unusable file.
    const named = new Map<string, string>();
    for (const g of raw.geomFiles) {
      named.set(g.hash, g.hash);
      this.core.addGeomFile(g);
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
      s.slide = nameGeoms(s.slide, named);
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
    const drafts = this.core.drafts(want ? listed.filter((r) => want.has(r.index)) : listed, converted, scan);
    const simplified = this.core.budget(drafts);

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
      this.core.addGeomFile({ hash: g.hash, bytes: g.bytes });
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

  /**
   * Step 3b: the geometry files the kept slides name, stored once each (`storeGeomFiles`). The objects that
   * name a file that could not be stored are left out (a shape whose file never arrives draws nothing,
   * `geom/stored.ts`); the slide keeps the rest.
   */
  private async storeGeoms(drafts: Draft[]): Promise<void> {
    const names: string[] = [];
    for (const d of drafts) if (d.cls !== 'picture') names.push(...drawnGeomRefs(d.slide));
    if (!names.length) return;
    const r = await storeGeomFiles(this.deps.store, this.deps.lib, this.core.geomFiles, names, (m) =>
      this.warn('geometry', m),
    );
    if (r.written) this.ctx.log(`${r.written} shape outline file(s) stored`);
    if (!r.failed.length) return;
    const failed = new Set(r.failed);
    for (const d of drafts) {
      if (d.cls === 'picture' || !drawnGeomRefs(d.slide).some((x) => failed.has(x))) continue;
      const left = withoutFiles(d.slide, (ref) => !failed.has(ref));
      d.slide = left.slide;
      this.core.leftOut(d, left, 'store');
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

  /** Step 5: version 1 assembled by the import core (`ImportCore.assemble`); `saveVersion1` saves it. */
  private assemble(
    drafts: Draft[],
    stored: Map<string, string>,
    sections: readonly SectionInfo[],
    slideRect: { x: number; y: number; w: number; h: number },
    scan: SceneScan,
  ): Omit<NativeBuild, 'listed' | 'texts' | 'textBoxes' | 'compact' | 'simplified'> {
    const { deps } = this;
    const built = this.core.assemble(drafts, stored, {
      id: this.done.presentationId!,
      title: this.title,
      hash: this.ctx.payload.hash,
      sections,
      slideRect,
      scan,
      hasAlpha: (id) => !!deps.lib.media.get(id)?.hasAlpha,
      clipIds: this.clipIds,
      libraryFamilies: deps.lib.listFonts().map((f) => f.family),
    });
    return { ...built, clipIds: this.clipIds, clipsCreated: this.clipsCreated };
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
