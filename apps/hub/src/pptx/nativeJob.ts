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
 *    parts copied (notes parts stay behind: the scan read them). Each batch has the pool's 2-minute timeout;
 *    past `PPTX_LIMITS.importPoolMs` of pool time the remaining slides are picture class, as are the slides
 *    of a batch that fails. A pool that cannot start fails the import with a clean message: the deck is never
 *    parsed on the event loop, and LibreOffice never sees a deck as uploaded (its render copy needs the pool
 *    too). Every zip read refuses overlapping entries (`deckParts.ts`).
 * 3. Classification and the §3.4 size budgets (`@ordo/domain` `planImportSizes`): a slide over 64 KB, and
 *    every slide once the presentation passes 3 MiB, becomes compact picture class, logged and counted. A
 *    slide the converter classed picture for its 64 KB budget (`EmittedSlide.overBudget`: its text
 *    formatting alone passed it) is that same 'slide' case: one warning, counted once.
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
 *    that fails it becomes picture class), `Slide.pptx.digest` over the objects exactly as stored.
 * 6. `lib.savePresentation` (version 1) and, in the same synchronous step, the heavy `pptx-lo` job for the
 *    slides that wait for LibreOffice (`pptx.pending`: hybrid, picture class, metafiles): it cannot start
 *    before version 1 exists, its digests are version 1's, and it is queued before any clip job of the deck:
 *    the clips' media jobs are queued right after it (`MediaService.queue`), never awaited. The presentation
 *    id is chosen and recorded before the save, so a re-run never saves a second presentation.
 *
 * Version 1 of a picture-class slide has no objects, `pptx.pending` and its text in `pptx.artText`; a hybrid
 * slide has its native objects (residuals are left out until version 2) and `pptx.artText` from its art.
 */
import { open, rm, stat } from 'node:fs/promises';
import {
  compactSlideBytes,
  drawnGeomRefs,
  formatBytes,
  type ImageObject,
  newId,
  planImportSizes,
  Presentation,
  type Section,
  type ShapeObject,
  SIZE_BUDGETS,
  Slide,
  type SlideObject,
  type SlidePptx,
  slideBytes,
  utf8Bytes,
} from '@ordo/domain';
import { remapMediaIds } from '@ordo/importers';
import { sanitizePresentation } from '@ordo/importers/sanitize.ts';
import {
  type ArtInfo,
  type EmittedClip,
  type EmittedSlide,
  MEDIA_PREFIX,
  type PictureHeader,
  pictureSize,
  type SectionInfo,
  type SlideClass,
  type SlideRef,
} from '@ordo/pptx-scene';
import type { PictureBake } from '@ordo/pptx-scene/bake.ts';
import { digestOf, SLIDE_BUDGET_NOTE, SLIDE_BYTES_NOTE } from '@ordo/pptx-scene/emit.ts';
import { relsPartOf } from '@ordo/pptx-scene/opc.ts';
import type { Job } from '@ordo/protocol';
import { errorMessage } from '../errors.ts';
import type { JobCtx, JobHandler } from '../jobs.ts';
import { baseName } from '../media/service.ts';
import { type CpuPool, cpuPool, transferables, WorkerStartError } from '../pool.ts';
import { sceneFontFiles } from './faces.ts';
import { type ClipFile, ClipImport, spillClips } from './clips.ts';
import { type DeckXml, readDeckXml, spillDeckParts } from './deckParts.ts';
import { geomFileOf, type NamedGeomFile, nameGeoms, storeGeomFiles } from './geoms.ts';
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
  limits?: { batchSlides?: number; importPoolMs?: number; geomFileBytes?: number };
};

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
  const limits = {
    batchSlides: env.limits?.batchSlides ?? PPTX_LIMITS.batchSlides,
    importPoolMs: env.limits?.importPoolMs ?? PPTX_LIMITS.importPoolMs,
    geomFileBytes: env.limits?.geomFileBytes ?? PPTX_LIMITS.geomFileBytes,
  };
  return (ctx) => runNative(deps, env.pool ?? cpuPool(), limits, ctx);
}

type Limits = { batchSlides: number; importPoolMs: number; geomFileBytes: number };

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
  /** The converter's notes, then the job's. */
  notes: string[];
  /** Hybrid slides: what the art holds (`EmittedSlide.art`, item D). */
  art?: ArtInfo;
  /** Text baked into the art or the page picture (`pptx.artText`). */
  artText?: string;
  /** Made picture class by the size budgets (§3.4). */
  compact?: boolean;
  /**
   * Classed picture by the converter's slide budget (`EmittedSlide.overBudget`): step 3 counts and logs it as
   * a slide over 64 KB, as it does a slide whose JSON it measures over 64 KB.
   */
  overBudget?: boolean;
  /** Its new geometry files would pass the import's budget (`PPTX_LIMITS.geomFileBytes`): compact. */
  overGeoms?: boolean;
  /**
   * Metafile pictures version 1 leaves out (`EmittedSlide.metafiles`, item D): LibreOffice converts each part
   * and the follow-up puts the object back just under `before`.
   */
  metafiles?: { part: string; object: ImageObject; before?: string }[];
  /** The clips the slide plays or names (`EmittedSlide.clips`, `clips.ts`). */
  clips?: EmittedClip[];
};

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

  constructor(
    private readonly deps: PptxDeps,
    private readonly pool: Pick<CpuPool, 'run'>,
    private readonly limits: Limits,
    private readonly ctx: JobCtx<PptxNativePayload>,
    private readonly done: PptxNativeProgress,
    private readonly save: () => void,
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

  private async scene(input: SceneTaskInput, transfer: ArrayBuffer[] = []): Promise<SceneTaskOutput> {
    const t0 = performance.now();
    try {
      const out = await this.pool.run('pptx-scene', input, { signal: this.ctx.signal, transfer });
      this.heapMb = Math.max(this.heapMb, out.heapMb);
      return out;
    } finally {
      this.poolMs += performance.now() - t0;
    }
  }

  async run(deck: string, scratch: string): Promise<PptxNativeResult> {
    try {
      return await this.steps(deck, scratch);
    } catch (e) {
      // Clips stored without their media job (queued with version 1): never left waiting for it. Those of an
      // earlier attempt (the resume pairs) are queued by `runNative`, whatever stops the run.
      for (const id of this.clipsCreated) this.deps.media.queue(id);
      throw e;
    }
  }

  private async steps(deck: string, scratch: string): Promise<PptxNativeResult> {
    const { ctx } = this;
    const t0 = performance.now();
    this.scratch = scratch;

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

    // 2c. The slides, in batches.
    const converted = await this.convert(parts, listed, pictureSizes, mediaKinds);
    parts.clear();
    ctx.log(
      `converted in ${Math.round(this.poolMs)} ms of pool time, worker heap ${Math.round(this.heapMb)} MB`,
    );

    // 3. Drafts, classes and the size budgets.
    const drafts = this.drafts(listed, converted, scan);
    const compact = this.budget(drafts);

    // 3b. Geometry files the kept slides name (M6 round 2, `geoms.ts`).
    await this.storeGeoms(drafts);
    this.checkCancelled();

    // 3c. Clips: stored (their media jobs queued with version 1), placeholders replaced.
    await this.clips(drafts, clipFiles);
    this.checkCancelled();

    // 4. Pictures.
    const stored = await this.pictures(drafts, spilled, new Map(pictureSizes));
    ctx.progress(0.95);

    // 5-6. Version 1.
    const result = this.saveVersion1(
      drafts,
      stored,
      first.result.sections,
      first.result.slideRect,
      scan,
      compact,
    );
    ctx.log(
      `version 1 saved in ${Math.round(performance.now() - t0)} ms: ${result.native} native, ${result.hybrid} hybrid, ` +
        `${result.picture} picture slide(s)${result.pending ? `, ${result.pending} waiting for LibreOffice` : ''}`,
    );
    return result;
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

  /** Step 2c: every slide through the pool in batches; a failed batch's slides are left out (picture class). */
  private async convert(
    parts: Map<string, Uint8Array>,
    listed: readonly SlideRef[],
    pictureSizes: [string, PictureHeader][],
    mediaKinds: [string, 'video' | 'audio'][] = [],
  ): Promise<Map<number, { s: EmittedSlide; media: Map<string, string>; extra?: SceneSlideExtra }>> {
    const out = new Map<number, { s: EmittedSlide; media: Map<string, string>; extra?: SceneSlideExtra }>();
    const own = new Set<string>();
    for (const r of listed) {
      own.add(r.part);
      own.add(relsPartOf(r.part));
    }
    const shared = new Map<string, Uint8Array>();
    for (const [k, v] of parts) if (!own.has(k) && !NOTES_PART.test(k)) shared.set(k, v);
    const n = listed.length;
    const step = this.limits.batchSlides;
    // Table rows grow to their text, measured with the library's faces (read by the worker as needed).
    const fonts = sceneFontFiles(this.deps.lib.listFonts(), (p) => this.deps.store.abs(p));
    for (let from = 0; from < n; from += step) {
      this.checkCancelled();
      const to = Math.min(n, from + step);
      if (this.poolMs > this.limits.importPoolMs) {
        this.warn(
          'batch',
          `slides ${from + 1}-${to} were not converted: the import used its ${Math.round(this.limits.importPoolMs / 60_000)} minutes of conversion time`,
        );
        continue;
      }
      const batch = new Map(shared);
      for (const r of listed) batch.set(r.part, r.hidden ? STUB_HIDDEN : STUB_SHOWN);
      const mine: Uint8Array[] = [];
      for (let i = from; i < to; i++) {
        const part = listed[i]!.part;
        for (const k of [part, relsPartOf(part)]) {
          const v = parts.get(k);
          if (!v) continue;
          parts.delete(k);
          // Placeholders share one empty buffer: never transferred (it would be detached for every batch).
          if (!v.byteLength) {
            batch.set(k, v);
            continue;
          }
          // Inflated parts are usually views into a larger buffer, which cannot be transferred: the part gets
          // its own (the copy structured cloning would make anyway), and the worker takes it over.
          const owned = v.byteOffset === 0 && v.byteLength === v.buffer.byteLength ? v : new Uint8Array(v);
          batch.set(k, owned);
          mine.push(owned);
        }
      }
      try {
        const r = await this.scene(
          { parts: batch, pictureSizes, range: { from, to }, options: this.options, mediaKinds, fonts },
          transferables(mine),
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
        // Geometry files are named by their content (`geoms.ts`): the batch's placeholders become names.
        const names = new Map<string, string>();
        for (const g of r.result.geoms ?? []) {
          const f = geomFileOf(g.file);
          if (!f) continue;
          names.set(g.id, f.hash);
          if (!this.geomFiles.has(f.hash)) this.geomFiles.set(f.hash, f);
        }
        for (const s of r.result.slides) {
          s.slide = nameGeoms(s.slide, names);
          out.set(s.index, { s, media, extra: extras.get(s.index) });
        }
      } catch (e) {
        this.checkCancelled();
        this.warn(
          'batch',
          `slides ${from + 1}-${to} could not be converted (${logSafe(errorMessage(e))}): they wait for LibreOffice pictures`,
        );
      }
      this.ctx.progress(0.1 + (0.5 * to) / n);
    }
    return out;
  }

  /** The key a bake stands under in the part maps (`bakes.ts`), recorded with its part and recipe. */
  private bakeKeyOf(part: string, bake: PictureBake): string {
    const key = bakeMapKey(part, bake);
    this.bakes.set(key, { part, bake });
    return key;
  }

  /** Step 3: one draft per listed slide with its class, notes, hidden flag, transition and timing. */
  private drafts(
    listed: readonly SlideRef[],
    converted: Map<number, { s: EmittedSlide; media: Map<string, string>; extra?: SceneSlideExtra }>,
    scan: SceneScan,
  ): Draft[] {
    const notes = new Map(scan.notes);
    let notesBytes = 0;
    let notesCut = 0;
    const drafts = listed.map((ref) => {
      const c = converted.get(ref.index);
      const label = `slide ${ref.index + 1}`;
      // The converter's budget notes are about what a picture slide does not keep: step 3 logs the budget.
      const own = c ? c.s.notes.filter((n) => n !== SLIDE_BUDGET_NOTE && n !== SLIDE_BYTES_NOTE) : [];
      const overBudget = c?.s.overBudget === true;
      const d: Draft = c
        ? {
            ref,
            slide: { ...c.s.slide, objects: c.s.slide.objects.map(imported) },
            media: c.media,
            cls: c.s.classification.class,
            notes: own,
            ...(c.s.art ? { art: c.s.art, artText: c.s.art.text } : {}),
            ...(overBudget ? { overBudget } : {}),
            ...(c.s.clips?.length ? { clips: c.s.clips } : {}),
          }
        : {
            ref,
            slide: { id: newId(), objects: [] },
            media: new Map(),
            cls: 'picture',
            notes: ['not converted: a LibreOffice picture is shown instead'],
          };
      for (const n of own) this.log.add('info', `${label}: ${n}`);
      if (c?.s.classification.class === 'picture' && !overBudget)
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
        d.notes.push(x.note);
        this.log.add('info', `${label}: ${x.note}`);
      }
      // The metafiles the slide draws, set aside by the converter (item D): LibreOffice converts them.
      const mf = c?.s.metafiles;
      if (mf?.length && d.cls !== 'picture') {
        d.metafiles = mf.map((m) => ({ ...m, object: imported(m.object) }));
        d.notes.push(`${mf.length} metafile picture(s) wait for LibreOffice`);
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

  /** Step 3: the §3.4 budgets (`planImportSizes`, item F). Returns how many slides were made compact. */
  private budget(drafts: Draft[]): number {
    // The import's geometry files (M6 round 2): a slide whose new files would pass their budget is compact.
    const files = new Set<string>();
    let fileBytes = 0;
    for (const d of drafts) {
      if (d.cls === 'picture') continue;
      const fresh = drawnGeomRefs(d.slide).filter((n) => !files.has(n) && this.geomFiles.has(n));
      const bytes = fresh.reduce((n, name) => n + this.geomFiles.get(name)!.bytes.length, 0);
      if (fileBytes + bytes > this.limits.geomFileBytes) {
        d.overGeoms = true;
        continue;
      }
      for (const n of fresh) files.add(n);
      fileBytes += bytes;
    }
    const stored = drafts.map((d) => record(d, DIGEST_STANDIN));
    const sizes = stored.map((sl) => slideBytes(sl));
    // Each slide's compact size with version 2's page picture and text boxes (`compactSlideBytes`).
    const plan = planImportSizes(
      sizes,
      stored.map((sl) => compactSlideBytes(sl)),
    );
    let compact = 0;
    drafts.forEach((d, i) => {
      // A slide the converter classed picture for its own 64 KB budget is this budget's 'slide' case; one
      // already picture class for any other reason is not made compact.
      const why = d.overBudget
        ? 'slide'
        : d.cls === 'picture'
          ? null
          : d.overGeoms
            ? 'geoms'
            : plan.reasons[i];
      if (!why) return;
      compact++;
      if (why === 'slide')
        this.warn(
          'budget',
          `slide ${i + 1} is over ${SIZE_BUDGETS.slideMax / 1024} KB: shown as a LibreOffice picture`,
        );
      if (why === 'geoms')
        this.warn(
          'budget',
          `slide ${i + 1}'s shape outlines pass the import's ${formatBytes(this.limits.geomFileBytes)} of outline files: shown as a LibreOffice picture`,
        );
      d.compact = true;
      d.notes.push(
        why === 'slide'
          ? 'over the slide size budget: a LibreOffice picture'
          : why === 'geoms'
            ? 'over the import budget of shape outlines: a LibreOffice picture'
            : 'compact: the presentation reached its size budget',
      );
      toPicture(d);
    });
    if (plan.tailFrom >= 0)
      this.warn(
        'budget',
        `the presentation reached its size budget (${SIZE_BUDGETS.presentationMax / 1024 ** 2} MiB): slide ${plan.tailFrom + 1} and later are compact LibreOffice pictures`,
      );
    if (!plan.fits) {
      // Even compact the slides are over the budget (their text): the text kept for search is cut.
      let cut = 0;
      for (const d of drafts) {
        if (d.cls !== 'picture' || !d.artText || d.artText.length <= COMPACT_TEXT_CHARS) continue;
        d.artText = cutText(d.artText, COMPACT_TEXT_CHARS);
        cut++;
      }
      this.warn(
        'budget',
        `the deck is over ${SIZE_BUDGETS.presentationMax / 1024 ** 2} MiB even with every slide compact: the text ${cut} picture slide(s) keep for search was cut to ${COMPACT_TEXT_CHARS} characters`,
      );
    }
    return compact;
  }

  /** Step 3b: the geometry files the kept slides name, stored once each (`storeGeomFiles`). */
  private async storeGeoms(drafts: Draft[]): Promise<void> {
    const names: string[] = [];
    for (const d of drafts) if (d.cls !== 'picture') names.push(...drawnGeomRefs(d.slide));
    if (!names.length) return;
    const r = await storeGeomFiles(this.deps.store, this.deps.lib, this.geomFiles, names, (m) =>
      this.warn('geometry', m),
    );
    if (r.written) this.ctx.log(`${r.written} shape outline file(s) stored`);
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
    });
    if (this.ctx.signal.aborted) throw new Cancelled();
    this.ctx.log(
      `${res.media.size} of ${items.length} baked picture(s) stored (${res.baked} baked, ${res.reused} found already)`,
    );
    return res;
  }

  /** Steps 5-6: remap, assemble, sanitize, digest, save version 1 and queue the LibreOffice follow-up. */
  private saveVersion1(
    drafts: Draft[],
    stored: Map<string, string>,
    sectionInfo: SectionInfo[],
    slideRect: { x: number; y: number; w: number; h: number },
    scan: SceneScan,
    compact: number,
  ): PptxNativeResult {
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
        d.notes.push(`${before - d.slide.objects.length} picture(s) could not be imported`);
      if (d.slide.lyricObjectId && !d.slide.objects.some((o) => o.id === d.slide.lyricObjectId))
        delete d.slide.lyricObjectId;
      const bg = d.slide.backgroundMediaId;
      if (bg && deps.lib.media.get(bg)?.hasAlpha) {
        // A picture with alpha is drawn on white, as PowerPoint lays every background (design/27 §4).
        delete d.slide.backgroundMediaId;
        if (d.cls !== 'picture') d.slide.objects.unshift(...backgroundOnWhite(bg, slideRect));
        d.notes.push('a background picture with transparency is drawn on white');
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
    for (const d of drafts) d.slide.pptx = provenance(d, hash);
    p.sections = sectionsOf(drafts, sectionInfo);
    p.arrangements = [{ id: newId(), name: 'Default', sectionIds: p.sections.map((s) => s.id) }];
    sanitizePresentation(p);
    // A slide the schema refuses becomes picture class rather than failing the deck.
    const byId = new Map(drafts.map((d) => [d.slide.id, d]));
    for (const sec of p.sections)
      sec.slides = sec.slides.map((sl) => {
        const ok = Slide.safeParse(sl);
        if (ok.success) return ok.data;
        const d = byId.get(sl.id);
        this.warn(
          'slide',
          `slide ${(sl.pptx?.index ?? 0) + 1} could not be stored natively: a LibreOffice picture is shown instead`,
        );
        if (!d) return Slide.parse({ id: sl.id, objects: [] });
        toPicture(d);
        d.notes.push('not storable natively: a LibreOffice picture');
        d.slide.pptx = provenance(d, hash);
        const again = Slide.safeParse(d.slide);
        return again.success ? again.data : Slide.parse({ id: sl.id, objects: [], pptx: d.slide.pptx });
      });
    const parsed = Presentation.parse(p);
    // The digest of the objects exactly as stored: the "unedited" test of the follow-up and re-import.
    const slides = parsed.sections.flatMap((s) => s.slides);
    for (const sl of slides) if (sl.pptx) sl.pptx.digest = digestOf(sl.objects);
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
    const fonts = missingFonts(
      fontFamilies(slides),
      deps.lib.listFonts().map((f) => f.family),
    );
    for (const f of fonts) this.log.add('info', `font not available: ${f}`);
    parsed.source.log = this.log.toString();

    // Version 1, its follow-up and the resume point in one transaction: the follow-up cannot start before
    // the save, and a process that dies in between leaves neither (a re-run imports again), never a version 1
    // whose follow-up lost its art and metafile plans.
    let loJobId: string | undefined;
    const saved = deps.lib.db.transaction(() => {
      const v1 = deps.lib.savePresentation(parsed, { create: true, by: 'pptx-import' });
      let after: Job | undefined;
      if (lo.length) {
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
    return importResult({
      presentationId: saved.id,
      classes,
      compact,
      pending: lo.length,
      ...(loJobId ? { loJobId } : {}),
      missingFonts: fonts,
      notes: this.log.warnings(),
    });
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
  return importResult({
    presentationId: saved.id,
    classes: slides.map((s) => s.pptx?.class ?? 'native'),
    compact: 0,
    pending: pending.length,
    ...(done.loJobId ? { loJobId: done.loJobId } : {}),
    missingFonts: [],
    notes: ['resumed after a restart: version 1 was already saved'],
  });
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

/** `s` cut to at most `n` UTF-16 units, never inside a surrogate pair. */
function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/** Make a draft picture class: no objects, its text kept for search (version 2 adds the page picture). */
function toPicture(d: Draft): void {
  const text = textOfObjects(d.slide.objects);
  d.cls = 'picture';
  d.slide.objects = [];
  delete d.slide.lyricObjectId;
  delete d.art;
  delete d.metafiles;
  // A hybrid slide's art text is part of the page too.
  const all = [text, d.artText].filter(Boolean).join('\n').slice(0, ART_TEXT_CHARS);
  if (all) d.artText = all;
  else delete d.artText;
}

/** A stand-in for `Slide.pptx.digest` in size estimates: as long as `digestOf`'s. */
const DIGEST_STANDIN = 'x'.repeat(16);

/** The slide as it will be stored, with a stand-in digest (for its size). */
function record(d: Draft, digest: string): Slide {
  return { ...d.slide, pptx: { ...provenance(d, 'x'.repeat(64)), digest } };
}

/** `Slide.pptx` of a draft (without its digest). */
function provenance(d: Draft, hash: string): SlidePptx {
  const pending = d.cls !== 'native' || !!d.metafiles?.length;
  const artText = d.artText;
  return {
    fileId: hash,
    index: d.ref.index,
    ...(d.ref.shown !== undefined ? { shown: d.ref.shown } : {}),
    class: d.cls,
    version: CONVERTER_VERSION,
    ...(pending ? { pending: true } : {}),
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
    });
  }
  return out;
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
