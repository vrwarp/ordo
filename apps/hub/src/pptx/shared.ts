/**
 * Contracts shared by the M3 work items of the native PowerPoint import (README.md, design/27 §2): the job
 * kinds with their payloads, results and classes, the CPU-pool task types, the limits of design/27 §12, the
 * dependencies every pptx job receives and the converter version. Shared file: additive changes only.
 *
 * Every map in a payload is an array of pairs (design/27 §12 "Prototype safety"): job payloads are JSON and
 * their keys come from deck strings (part names). Part names are at most `PPTX_LIMITS.partName` characters.
 */
import type { SceneFontFile } from './faces.ts';
import type { ExtractedText, ImageObject } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import type { ArtInfo, ConvertResult, SlideClass } from '@ordo/pptx-scene';
import type { PictureBake } from '@ordo/pptx-scene/bake.ts';
import { MAX_XML_PART_BYTES } from '@ordo/pptx-scene/opc.ts';
import type { RenderCopyPage } from '@ordo/pptx-scene/rendercopy.ts';
import type { Logger } from 'pino';
import type { HubConfig } from '../config.ts';
import type { JobClass, JobQueue } from '../jobs.ts';
import type { Library } from '../library.ts';
import type { MediaService } from '../media/service.ts';
import type { Store } from '../store.ts';

/** The converter version written to `Slide.pptx.version` and `source.native.version`. */
export const CONVERTER_VERSION = 1;

const MiB = 1024 * 1024;

/** design/27 §2 and §12: what one import may read, spill, create and spend. */
export const PPTX_LIMITS = {
  /** Zip entries (central directory). */
  entries: 200_000,
  /** One XML or relationships part in memory. */
  xmlPartBytes: MAX_XML_PART_BYTES,
  /** Every XML part in memory together. */
  xmlTotalBytes: 64 * MiB,
  /** Media and font parts spilled to disk for one import. */
  spillBytes: 1024 * MiB,
  /** Picture, clip and font parts extracted per deck; the rest are logged and keep posters or fallbacks. */
  pictures: 2_000,
  clips: 50,
  fonts: 20,
  /** Slides read per deck. */
  slides: 2_000,
  /** Slides per `pptx-scene` pool task, and that task's timeout. */
  batchSlides: 150,
  batchMs: 2 * 60_000,
  /** Pool time one import may use; past it the remaining slides are picture class (or a clean failure). */
  importPoolMs: 15 * 60_000,
  /** Longest part name in a payload pair. */
  partName: 512,
  /**
   * Bytes of geometry files one import stores (`ShapeGeom.ref`, design/27 §15 M6 round 2; the largest of
   * the worship decks measured needs 0.6 MB); a slide whose new files would pass it is a compact picture.
   */
  geomFileBytes: 32 * MiB,
} as const;

/** The options of a native import: form fields of `POST /import/document`, kept in the job payload. */
export type PptxImportOptions = {
  /** 'Extend plain backgrounds to 16:9' (default on): solid backgrounds cover the whole 1920x1080 frame. */
  extendBackgrounds?: boolean;
  /** 'Import transition sounds' (default off; read by M5's media extraction). */
  transitionSounds?: boolean;
};

/** What every pptx job and service is given (constructed once per library process, `index.ts`). */
export type PptxDeps = {
  lib: Library;
  store: Store;
  jobs: JobQueue;
  media: MediaService;
  cfg: HubConfig;
  log: Logger;
  /** Whether a presentation is frozen in the live session (ADR 0007): no pptx job writes it then. */
  locked(presentationId: string): boolean;
};

// ── Jobs ────────────────────────────────────────────────────────────────────────────────────────────────

export const PPTX_JOBS = {
  /** The light native import: version 1 (item B). */
  native: 'pptx-native',
  /** The heavy LibreOffice follow-up: art, metafiles and page pictures, version 2 (item D). */
  lo: 'pptx-lo',
  /** 'Show PowerPoint picture': reference pictures of every slide (hidden ones too), on demand (item D). */
  reference: 'pptx-reference',
  /** The one-shot repair of legacy `imported.textBoxes` (item G). */
  textRepair: 'pptx-text-repair',
} as const;

/** Resume points of a native import (`ctx.setPayload` after each step), so a re-queued job never repeats one. */
export type PptxNativeProgress = {
  /** Picture parts already stored: [source part, media id] pairs. */
  media: [string, string][];
  /**
   * The presentation's id, chosen before version 1 is saved (it exists once saved): a re-run saves under the
   * same id or finds it saved, never a second presentation.
   */
  presentationId?: string;
  /** The follow-up job, once enqueued. */
  loJobId?: string;
  /** The `document` job the deck went to when the CPU pool could not start (`PptxNativeFallback`). */
  fallbackJobId?: string;
  /**
   * Clips already ingested (their media jobs not yet queued until version 1 is saved): [`clipKey`, media
   * id] pairs (`clips.ts`). A re-run reuses them instead of storing a clip twice.
   */
  clips?: [string, string][];
};

export type PptxNativePayload = {
  /** The stored deck: its SHA-256 (the `files` row), also `Slide.pptx.fileId`. */
  hash: string;
  /** The uploaded file name (the title comes from it). */
  name: string;
  options?: PptxImportOptions;
  done?: PptxNativeProgress;
};

/** The `pptx-native` result, which the import card shows (item H). */
export type PptxNativeResult = {
  presentationId: string;
  slides: number;
  native: number;
  hybrid: number;
  picture: number;
  /** Slides made compact picture class to keep the presentation within its budget (design/27 §3.4). */
  compact: number;
  /** Slides waiting for the LibreOffice follow-up (`Slide.pptx.pending`). */
  pending: number;
  loJobId?: string;
  /** Families the deck uses that no shipped face covers: the card offers an upload (design/27 §10). */
  missingFonts: string[];
  /** The first notes of the import, sanitised; `source.log` keeps them all. */
  notes: string[];
};

/**
 * The `pptx-native` result when the CPU pool cannot start (design/27 §12 "Process"): the deck is never parsed
 * on the event loop; the whole deck went to the LibreOffice picture import (`document` job) instead.
 */
export type PptxNativeFallback = {
  fallback: 'libreoffice';
  /** The `document` job that imports the deck as pictures. */
  jobId: string;
  reason: string;
};

/** One slide of the LibreOffice follow-up, as version 1 left it. */
export type PptxLoSlide = {
  slideId: string;
  /** `SlideRef.index`: the slide in the render copy. */
  index: number;
  shown?: number;
  /** hybrid: art; picture: a page picture; native: only metafiles to convert. */
  class: SlideClass;
  art?: ArtInfo;
  /** Metafile (EMF/WMF) pictures to convert: [part, ids of the objects that show it] pairs. */
  metafiles?: [string, string[]][];
  /** Version 1's `Slide.pptx.digest`: the patch replaces objects only while the slide still matches it. */
  digest: string;
  /**
   * Metafile pictures version 1 left out, as emitted (their `mediaId` any placeholder): once LibreOffice has
   * converted `part`, each goes in just under the object `before` names (on top when absent or gone; on top
   * with a note when the slide was edited). `metafiles` ids that name objects still on the slide get the
   * converted picture as their `mediaId` instead.
   */
  metafileObjects?: { part: string; object: ImageObject; before?: string }[];
  /**
   * Version 1's objects of `ArtInfo.replaces`, each with `digestOf([object])`: [id, digest] pairs. On a slide
   * edited meanwhile the art still replaces those that are exactly as they were.
   */
  replaced?: [string, string][];
};

export type PptxLoPayload = {
  presentationId: string;
  hash: string;
  /** The `CONVERTER_VERSION` that planned it. */
  version: number;
  slides: PptxLoSlide[];
  /** Times the job found the presentation live-locked and deferred itself (the backoff step). */
  deferrals?: number;
  /**
   * Times LibreOffice (or the pool) failed for the whole copy and the job tried again later
   * (`LO_RETRIES`); past them the slides are marked `failed`.
   */
  retries?: number;
  /** Pictures already stored by an earlier attempt: [`<slideId>:<what>`, media id] pairs. */
  done?: [string, string][];
  /**
   * Where each stored art picture goes, in logical px: [`<slideId>:art`, box] pairs (an art picture is cropped
   * to what LibreOffice drew, so its box is known only once it is made). '' as a `done` media id: nothing.
   */
  placed?: [string, { x: number; y: number; w: number; h: number }][];
};

export type PptxReferencePayload = {
  presentationId: string;
  hash: string;
  /** Who asked (logged; the revision is saved by `pptx-reference`, which editors take over). */
  by?: string;
  /**
   * The slides (ids) switched to the picture (`Slide.pptx.show: 'picture'`) once it is stored. Absent: every
   * shown slide ('Show PowerPoint picture' for the presentation). Empty: none; the editor's 'Show original'
   * only compares the slide with the picture (item H).
   */
  showPicture?: string[];
  /** Reference pictures already stored: [`SlideRef.index`, media id] pairs. */
  done?: [number, string][];
  /** Times the job found the presentation live-locked and deferred itself (the backoff step). */
  deferrals?: number;
};

export type TextRepairPayload = {
  /** Presentations repaired, or skipped for good (deck gone, nothing to repair). */
  done: string[];
  /** Presentations skipped because they were live-locked: retried after End service. */
  deferred?: string[];
};

export type PptxJobPayloads = {
  'pptx-native': PptxNativePayload;
  'pptx-lo': PptxLoPayload;
  'pptx-reference': PptxReferencePayload;
  'pptx-text-repair': TextRepairPayload;
};
export type PptxJobKind = keyof PptxJobPayloads;

/**
 * The queue each job runs on. The import is light (it parses on the pool and stores prepared pictures), so
 * version 1 never waits behind a transcode; LibreOffice runs heavy, enqueued before any of the deck's clips
 * (jobs run FIFO per class, `jobs.ts`).
 */
export const PPTX_JOB_CLASS: { readonly [K in PptxJobKind]: JobClass } = {
  'pptx-native': 'light',
  'pptx-lo': 'heavy',
  'pptx-reference': 'heavy',
  'pptx-text-repair': 'light',
};

/** Enqueue a pptx job on its class with a typed payload. */
export function enqueuePptx<K extends PptxJobKind>(
  jobs: JobQueue,
  kind: K,
  payload: PptxJobPayloads[K],
): Job {
  return jobs.enqueue(kind, payload, PPTX_JOB_CLASS[kind]);
}

// ── CPU-pool tasks (pool.ts `CpuTasks`, cpu.worker.ts) ──────────────────────────────────────────────────

/** `pptx-scene`: one batch of slides through `convertDeck` (item B, `sceneTask.ts`). */
export type SceneTaskInput = {
  /**
   * The deck's XML and relationship parts; spilled media and font parts as empty placeholders, so their
   * relationships resolve. A batch's own slide parts are transferred, the shared parts copied.
   */
  parts: Map<string, Uint8Array>;
  /**
   * Pixel sizes of spilled pictures, read from their first bytes (`@ordo/pptx-scene` `pictureSize`): [part,
   * size] pairs. Keep `alpha`: only a background known to be opaque becomes the slide background.
   */
  pictureSizes: [string, { w: number; h: number; alpha?: boolean }][];
  /** The batch: `SlideRef.index` in [from, to). */
  range: { from: number; to: number };
  options: PptxImportOptions;
  /**
   * The import's first call (`range` empty): also read what the job needs before the batches and no batch
   * reads (`SceneTaskOutput.scan`): referenced pictures, metafiles, notes, the show's loop flag.
   */
  scan?: boolean;
  /**
   * Whether each spilled clip is a video or a sound, sniffed from its bytes: [part, kind] pairs
   * (`ParseOptions.mediaKind`; pptxgenjs writes sounds under `a:videoFile`).
   */
  mediaKinds?: [string, 'video' | 'audio'][];
  /**
   * The library's font faces, read by the worker when a table's text is measured (`faces.ts`; design/27
   * §15 M6: a row grows to its text). Absent: widths are estimated.
   */
  fonts?: SceneFontFile[];
};
export type SceneTaskOutput = {
  result: ConvertResult;
  /** Time in the task, and the worker's heap after it (the §13 budgets). */
  ms: number;
  heapMb: number;
  /** With `SceneTaskInput.scan`. */
  scan?: SceneScan;
  /** Per converted slide, what `convertDeck` does not read (`transition.ts`). */
  extras?: SceneSlideExtra[];
};

/** What the first `pptx-scene` call reads for the whole deck (`sceneTask.ts`). */
export type SceneScan = {
  /**
   * Picture parts (image relationships, metafiles and SVG left out) of the listed slides, their layouts,
   * masters and themes: what the job spills and prepares. Stored part names, at most `PPTX_LIMITS.pictures`.
   */
  pictures: string[];
  /** Picture parts referenced past `PPTX_LIMITS.pictures` (logged, not extracted). */
  picturesOver: number;
  /** Metafile pictures (EMF, WMF) each slide may show (its own, its layout's, its master's): [index, parts]. */
  metafiles: [number, string[]][];
  /** Speaker notes (`notes.ts`): [`SlideRef.index`, text]. */
  notes: [number, string][];
  /** `p:showPr loop`: the show loops until Esc. */
  loop: boolean;
  /**
   * Clip parts (video, sound and PowerPoint 2010 media relationships of the listed slides, those of
   * `p14:media` and the video elements first), at most `PPTX_LIMITS.clips`: what the job spills and sniffs.
   */
  clips?: string[];
  /** Clip parts past `PPTX_LIMITS.clips` (logged; their posters stay). */
  clipsOver?: number;
};

/** A slide's transition and timing (`transition.ts`). */
export type SceneSlideExtra = {
  /** `SlideRef.index`. */
  index: number;
  transition?: { kind: 'cut' } | { kind: 'crossfade'; ms: number };
  /** `advTm`. */
  advanceMs?: number;
  /** What was approximated. */
  note?: string;
};

/** `pptx-render-copy`: the minimal deck LibreOffice prints, written to `out` (item D, `renderCopyTask.ts`). */
export type RenderCopyTaskInput = {
  parts: Map<string, Uint8Array>;
  /** Spilled media parts the copy may keep: [part, absolute file] pairs. */
  media: [string, string][];
  pages: RenderCopyPage[];
  /** Where the worker writes the copy (.pptx), inside the job's scratch directory. */
  out: string;
  /** Slides (`SlideRef.index`) whose text boxes to read as well (`RenderCopyTaskOutput.texts`). */
  texts?: number[];
  /** Print every shown slide whole, in order, instead of `pages` (the 'Pictures (LibreOffice)' import). */
  allShown?: boolean;
  /**
   * Only plan the copy: write nothing and answer `need`, the picture parts it keeps, so the job spills only
   * those (`extractDeck`). `media` is ignored; the parts are copied to the worker, not transferred.
   */
  plan?: boolean;
};
export type RenderCopyTaskOutput = {
  pages: RenderCopyPage[];
  bytes: number;
  outlines: number;
  notes: string[];
  /** The deck's slide size in EMU: the pages are printed at 2 px per logical px from it. */
  slideSize?: { cx: number; cy: number };
  /** Text boxes of `RenderCopyTaskInput.texts` (uniform contain mapping, logical px): [index, boxes]. */
  texts?: [number, ExtractedText[]][];
  /** With `RenderCopyTaskInput.plan`: the deck's picture parts the copy keeps, each once. */
  need?: string[];
};

/** Pixels: rows top to bottom, `channels` bytes per pixel (RGB or RGBA, straight alpha). */
export type RasterImage = { width: number; height: number; channels: 3 | 4; data: Uint8Array };

/** `pptx-art`: one art slide's transparent picture from its white and black pages (item D, `art.ts`). */
export type ArtTaskInput = {
  /** The same page printed over a forced white and a forced black background; same size. */
  white: RasterImage;
  black: RasterImage;
  /**
   * The RGB colours the two pages were printed over, when not white and black (the follow-up prints the second
   * page over yellow: `@ordo/pptx-scene` `PAGE_BACKGROUNDS`). Channels where they are equal carry no alpha.
   */
  colors?: { white: readonly [number, number, number]; black: readonly [number, number, number] };
  /** The art's box on the page, in page pixels: nothing outside it is kept. */
  box: { x: number; y: number; w: number; h: number };
  /** Keep the whole box instead of cropping to the visible pixels (a converted metafile keeps its extent). */
  whole?: boolean;
  /** Also encode the PNG (`ArtTaskOutput.png`) and hand back `image` without its pixels. */
  encode?: boolean;
};
export type ArtTaskOutput = {
  /** RGBA, straight alpha, cropped to the bounding box of the pixels that are not fully transparent. */
  image: RasterImage;
  /** Where `image` sits on the page, in page pixels. */
  at: { x: number; y: number };
  /** Nothing visible survived: the art draws nothing. */
  empty: boolean;
  /** With `ArtTaskInput.encode`: `image` as a PNG (RGBA, 8 bits). */
  png?: Uint8Array;
};

/**
 * `pptx-bake` (M6, `bakeTask.ts`): a picture derived at import, a recoloured picture or a tiled fill
 * (`@ordo/pptx-scene` `bake.ts`). The source is decoded by ffmpeg before the task, at the size the bake needs.
 */
export type BakeTaskInput = {
  /** The source picture, RGBA (`channels` 4), straight alpha. */
  source: RasterImage;
  bake: PictureBake;
  /** A tile's output size (the box at its display need); without a tile the output is the source's size. */
  out?: { width: number; height: number };
  /** The source's format (`clrChange`'s tolerance depends on it): png, jpeg, gif, webp, bmp, tiff. */
  format: string;
};
export type BakeTaskOutput = {
  /** The derived picture as a PNG (RGBA, or RGB when every pixel is opaque). */
  png: Uint8Array;
  width: number;
  height: number;
  /** Some pixel is not opaque. */
  alpha: boolean;
};

/** A stub's error: the work item that will implement it (README.md). */
export function notYet(item: string, what: string): Error {
  return new Error(`${what} is not implemented yet (M3 item ${item})`);
}
