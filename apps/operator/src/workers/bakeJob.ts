import { drawnMediaIds, type Slide } from '@ordo/domain';
import { pictureSource, prerenderKey } from '@ordo/domain/prerender.ts';
import { SLIDE_FILE_LIMITS, SlideFileHead, SlideFilePage, slideFromFile } from '@ordo/domain/slidefile.ts';
import type { BakeReason } from '@ordo/renderer';
import type {
  bakeSlide as RendererBakeSlide,
  bakeSlides as RendererBakeSlides,
  encodePicture as RendererEncodePicture,
  failureText as RendererFailureText,
} from '@ordo/renderer/bake.ts';
import { BAKE_MAX_PICTURE_BYTES, FILE_READ_DEADLINE_MS } from '../services/bakeConsts.ts';

/**
 * The job runner of the bake worker (design/29 section 1.4): one picture of one slide, from a slide the library
 * holds (for a slide kept in a slide file, from the FULL slide rebuilt from its file), made with the renderer's own
 * `bakeSlide` and `encodePicture` and handed back as blobs. The main thread never rasterizes.
 *
 * This file has no side effects on import and imports no renderer or output-app CODE (types only): everything
 * that touches the browser is a dependency, so the node tests drive the whole job with fakes. The real
 * dependencies are wired in `workers/bake.worker.ts`, the one file that touches `self`.
 *
 * ORDER OF A JOB (J1): the font list is synced and the blank face awaited before the first `bakeSlide`; the prepare
 * steps (geometry and decoration files, table layouts) run over the slide the renderer names; the pictures are
 * provided by the output app's frame provider over its decoder (a picture must be what the screens draw); then the
 * draw, then the encoders. A bake is COMPLETE OR NOTHING: every failure posts one `failed` with the reason and the
 * renderer's one-line text and nothing else; the made canvas and every bitmap are closed on every path (J2, J3). A
 * bad slide never kills the worker (J4): any throw is a `failed`.
 *
 * Hooks for later releases: the job is a union with one member today (H-W4): an unknown `kind` is refused with the
 * reason `kind` and nothing is drawn (J8), so a plate adds a member and the dispatch grows, not forks.
 */

/** A face of the library as the font resolver takes it (the thumbnail worker's shape). */
export type BakeFont = {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  hash: string;
  /** Where the file is fetched from when the service-file cache does not have it (absolute). */
  url: string;
};

/** One picture to make. */
export type BakeJobIn = {
  kind: 'slide';
  /** The job's id: every answer and a `cancel` carry it. */
  id: number;
  presentationId: string;
  slideId: string;
  /** The key the pictures will be uploaded under (the hub's listed key for a file-form slide). */
  key: string;
  slide: Slide;
  /** The live set above the picture: the record's (H-W1). */
  live: readonly string[];
  /** The file each drawn picture decodes, by media id (empty for a file-form slide: the worker asks). */
  images: Record<string, string>;
  /** The time the bake may take, ms (the renderer's bound; Q38.a). */
  deadlineMs: number;
  standIns: 'allow' | 'abort';
  madeBy: string;
  /** A slide kept in a slide file (Q54): its head, the bytes of its parts and the key the hub listed for it. */
  file?: { ref: string; listedKey: string; bytes: number };
};

export type BakeIn =
  | { t: 'fonts'; fonts: BakeFont[] }
  | { t: 'bake'; job: BakeJobIn }
  | { t: 'cancel'; id: number }
  /** The page's answer to a `decode` (an SVG it drew): the bitmap, or none. */
  | { t: 'decoded'; seq: number; bitmap?: ImageBitmap }
  /** The page's answer to a `media` (the file of each media id the full slide draws). */
  | { t: 'media'; id: number; files: Record<string, string> };

export type BakeOutPicture = { size: number; type: string; blob: Blob; bytes: number };

/** Why a job made nothing: the renderer's reasons, plus the two of this runner (`kind`, and `stale` for a file-form key). */
export type BakeJobReason = BakeReason | 'kind' | 'stale';

export type BakeOut =
  | { t: 'phase'; id: number; phase: 'files' | 'drawing' | 'encoding' }
  /** An SVG this worker cannot decode: the page draws it and answers with `decoded`. */
  | { t: 'decode'; id: number; seq: number; hash: string; blob: Blob }
  /** The media ids of the full slide: the page answers with the file of each. */
  | { t: 'media'; id: number; ids: string[] }
  | {
      t: 'made';
      id: number;
      pictures: BakeOutPicture[];
      opaque: boolean;
      standIns: readonly string[];
      /** Milliseconds by phase of the job (the renderer's stats, then this runner's `read` and `total`). */
      ms: Record<string, number>;
    }
  | { t: 'failed'; id: number; reason: BakeJobReason; detail: string; text: string };

/** How long the page may take to draw an SVG for the worker, or to name the files of a full slide. */
export const PAGE_ANSWER_MS = 15_000;
/** A part of a slide file that is larger than this is refused before it is parsed (a page is at most 256 KiB). */
export const FILE_PART_MAX_BYTES = 300 * 1024;
/** The scale of a picture: 3840 wide. */
const SCALE = 2;
const OUT = { w: 3840, h: 2160 } as const;
const SLICE_MS = 20;

/** What the runner needs; the real ones are in `bake.worker.ts`, fakes in the tests. */
export type BakeJobDeps = {
  env: { fonts: { sync(list: BakeFont[]): Promise<unknown> }; ready(): Promise<boolean> };
  bakeSlides: typeof RendererBakeSlides;
  bakeSlide: typeof RendererBakeSlide;
  encodePicture: typeof RendererEncodePicture;
  failureText: typeof RendererFailureText;
  /** The output app's prepare steps (`prepareSlides`, `jobSlides`) and its geometry-unit switch. */
  prepareSlides: (
    job: { slides: readonly Slide[]; scale: number },
    host: {
      read(hash: string): Promise<Blob | undefined>;
      slice<T>(fn: () => T): Promise<T>;
      check(): void;
    },
  ) => Promise<string[]>;
  jobSlides: (job: { slide?: Slide; nextSlide?: Slide }, under?: readonly Slide[]) => Slide[];
  setGeometryUnits: (on: boolean) => void;
  /** A file's bytes: the service-file cache first, then the hub; undefined when it is not there. */
  fileBlob: (hash: string) => Promise<Blob | undefined>;
  /** The output app's decoder and frame provider, and the bitmap cache they share. */
  createDecoder: (deps: {
    read(hash: string): Promise<{ blob: Blob; source: 'opfs' | 'network' }>;
    createImageBitmap: unknown;
    ImageDecoder?: unknown;
    rasterSvg?: (hash: string, blob: Blob) => Promise<ImageBitmap>;
  }) => unknown;
  framePictures: (deps: {
    cache: unknown;
    decoder: unknown;
    images: Readonly<Record<string, string>>;
    out: { w: number; h: number };
    steps: { slice<T>(fn: () => T): Promise<T>; check(): void };
    isMissing(error: unknown): boolean;
    has(hash: string): Promise<boolean>;
  }) => unknown;
  createBitmapCache: () => { cache: unknown; dispose(): void };
  createImageBitmap: unknown;
  ImageDecoder?: unknown;
  post: (m: BakeOut) => void;
  now: () => number;
  /** Lets the worker's event loop run (a `cancel` message is seen). */
  yieldNow: () => Promise<void>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  /** A line for the worker's console: the fault of a job, never slide text. */
  log?: (line: string) => void;
};

class Cancelled extends Error {
  override name = 'Cancelled';
}
class Unavailable extends Error {
  override name = 'Unavailable';
}
class Stop extends Error {
  readonly reason: BakeJobReason;
  readonly detail: string;
  constructor(reason: BakeJobReason, detail: string) {
    super(detail);
    this.name = 'Stop';
    this.reason = reason;
    this.detail = detail;
  }
}

const cut = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

/**
 * The service-file reader of every worker of this app (thumb.worker.ts has the same one): the Cache API entry
 * `/__ordo_cache/<hash>` of `ordo-files` first, then the hub (`/api/v1/files/<hash>`, or `url`), with the
 * session's cookie. A 404, an error status and a network error are `undefined`: the caller says what a missing
 * file means.
 */
export type FileReaderEnv = {
  caches?: {
    open(name: string): Promise<{ match(request: string): Promise<{ blob(): Promise<Blob> } | undefined> }>;
  };
  fetch(url: string, init: { credentials: 'same-origin' }): Promise<{ ok: boolean; blob(): Promise<Blob> }>;
};

export function createFileReader(
  env: FileReaderEnv,
): (hash: string, url?: string) => Promise<Blob | undefined> {
  return async (hash, url = `/api/v1/files/${hash}`) => {
    try {
      const c = await env.caches?.open('ordo-files');
      const hit = await c?.match(`/__ordo_cache/${hash}`);
      if (hit) return await hit.blob();
    } catch {
      /* no Cache API */
    }
    try {
      const r = await env.fetch(url, { credentials: 'same-origin' });
      if (r.ok) return await r.blob();
    } catch {
      /* offline */
    }
    return undefined;
  };
}

export type BakeRunner = {
  /** The font list of the library (the keys and the bake use this one list); synced before the next job. */
  setFonts(list: BakeFont[]): void;
  /** Stop the job: it ends at its next turn with the reason `cancelled`. */
  cancel(id: number): void;
  /** The page's answer to a `decode`. */
  decoded(seq: number, bitmap?: ImageBitmap): void;
  /** The page's answer to a `media`. */
  media(id: number, files: Record<string, string>): void;
  /** Make one picture (one job at a time: a second call answers `busy` and leaves the first alone). */
  run(job: BakeJobIn): Promise<void>;
  /** A job is running. */
  readonly busy: boolean;
  /** The full slide of a file-form job is held now (false once the bake has ended: the encode holds only the canvas). */
  readonly holdsSlide: boolean;
};

export function createBakeRunner(deps: BakeJobDeps): BakeRunner {
  let fonts: BakeFont[] = [];
  let fontsKey = '[]';
  let syncedKey: string | undefined;
  let unitsOn = false;
  let running: number | undefined;
  let holds = false;
  let seq = 0;
  const cancelled = new Set<number>();
  const svgWaits = new Map<
    number,
    { resolve(b: ImageBitmap): void; reject(e: Error): void; timer: unknown }
  >();
  const mediaWaits = new Map<number, { resolve(f: Record<string, string>): void; timer: unknown }>();

  const post = (m: BakeOut) => {
    try {
      deps.post(m);
    } catch {
      /* the page is gone: the worker is terminated next */
    }
  };

  function failed(id: number, reason: BakeJobReason, detail: string): void {
    const text =
      reason === 'kind' || reason === 'stale'
        ? cut(`${reason}: ${detail}`, 200)
        : deps.failureText({ reason, detail });
    post({ t: 'failed', id, reason, detail, text });
  }

  async function syncFonts(): Promise<void> {
    if (syncedKey === fontsKey) return;
    const key = fontsKey;
    await deps.env.fonts.sync(fonts);
    syncedKey = key;
  }

  function askPage<T>(
    map: Map<number, { resolve(v: T): void; timer: unknown }>,
    key: number,
    send: () => void,
  ): Promise<T | undefined> {
    return new Promise((resolve) => {
      const timer = deps.setTimer(() => {
        map.delete(key);
        resolve(undefined);
      }, PAGE_ANSWER_MS);
      map.set(key, { resolve: (v) => resolve(v), timer });
      send();
    });
  }

  /** The slide kept in a slide file, rebuilt whole: the head, then each page, one at a time (JF1, JF2, JF6, JF7, JF8). */
  async function rebuild(job: BakeJobIn, isCancelled: () => boolean): Promise<Slide> {
    const file = job.file as NonNullable<BakeJobIn['file']>;
    const started = deps.now();
    const guard = () => {
      if (isCancelled()) throw new Cancelled();
      if (deps.now() - started > FILE_READ_DEADLINE_MS) throw new Stop('time', 'file read');
    };
    if (!(file.bytes >= 0 && file.bytes <= SLIDE_FILE_LIMITS.bytes))
      throw new Stop('size', `file: the slide file is over ${SLIDE_FILE_LIMITS.bytes} bytes`);
    const part = async (hash: string, what: string): Promise<unknown> => {
      guard();
      const blob = await deps.fileBlob(hash);
      if (!blob) throw new Stop('files', 'the full copy of this slide is missing on the hub');
      if (blob.size > FILE_PART_MAX_BYTES) throw new Stop('draw', `file: a ${what} is too large`);
      let text: string | undefined = await blob.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Stop('draw', `file: a ${what} is not JSON`);
      } finally {
        text = undefined;
      }
    };
    const headJson = await part(file.ref, 'head');
    const headParsed = SlideFileHead.safeParse(headJson);
    if (!headParsed.success) throw new Stop('draw', 'file: the head is not a slide file head');
    const head = headParsed.data;
    if (head.pages.length > SLIDE_FILE_LIMITS.pages)
      throw new Stop('size', `file: the head names ${head.pages.length} pages`);
    if (head.count > SLIDE_FILE_LIMITS.objects)
      throw new Stop('size', `file: the slide has ${head.count} objects`);
    const pages: SlideFilePage[] = [];
    for (const name of head.pages) {
      const json = await part(name, 'page');
      const parsed = SlideFilePage.safeParse(json);
      if (!parsed.success) throw new Stop('draw', 'file: a page is not a slide file page');
      pages.push(parsed.data);
    }
    try {
      return slideFromFile(job.slide, head, pages);
    } catch (e) {
      throw new Stop(
        'draw',
        `file: ${cut(e instanceof Error ? e.message : 'the parts do not assemble', 100)}`,
      );
    }
  }

  async function make(job: BakeJobIn): Promise<void> {
    const id = job.id;
    const isCancelled = () => cancelled.has(id);
    const t0 = deps.now();
    const ms: Record<string, number> = {};
    let made: { canvas?: { width: number } } | undefined;
    let bitmaps: { dispose(): void } | undefined;
    try {
      if (job?.kind !== 'slide') return failed(id, 'kind', 'this build does not make that kind of picture');
      if (!job.slide?.prerender) return failed(id, 'kind', 'the slide has no record: nothing to make');
      post({ t: 'phase', id, phase: 'files' });
      let sliceStart = deps.now();
      const steps = {
        slice: async <T>(fn: () => T): Promise<T> => {
          const r = fn();
          if (deps.now() - sliceStart >= SLICE_MS) {
            await deps.yieldNow();
            sliceStart = deps.now();
          }
          return r;
        },
        check: () => {
          if (isCancelled()) throw new Cancelled();
        },
      };
      let images = job.images;
      let slide: Slide | undefined = job.slide;
      if (job.file) {
        const full = await rebuild(job, isCancelled);
        holds = true;
        slide = full;
        // the record's `uses.media` is cut at 1,000: the page names the file of every picture the full slide draws
        const ids = drawnMediaIds(full);
        const answer = await askPage(mediaWaits, id, () => post({ t: 'media', id, ids }));
        if (!answer) throw new Stop('media', 'the library did not name the files of the slide');
        const files = answer;
        images = {};
        for (const m of ids) if (files[m]) images[m] = files[m] as string;
        // the key the picture will be filed under is the hub's: made only if it is also this slide's (JF3)
        const key = prerenderKey(
          pictureSource(full, job.live, {
            mediaFile: (m) => files[m],
            fonts: fonts.map((f) => ({ family: f.family, file: { hash: f.hash } })),
          }),
        );
        if (key !== job.file.listedKey) throw new Stop('stale', 'the hub key is not the key of this slide');
      }
      ms.read = deps.now() - t0;
      await syncFonts();
      await deps.env.ready();
      if (!unitsOn) {
        deps.setGeometryUnits(true);
        unitsOn = true;
      }
      const split = deps.bakeSlides(slide, { live: job.live });
      const missingFiles = await deps.prepareSlides(
        { slides: deps.jobSlides({ slide: split.slide }, split.under), scale: SCALE },
        { read: (hash) => deps.fileBlob(hash), slice: steps.slice, check: steps.check },
      );
      if (missingFiles.length)
        throw new Stop(
          'files',
          `${missingFiles.length} geometry or decoration file(s): ${missingFiles
            .slice(0, 3)
            .map((h) => h.slice(0, 8))
            .join(', ')}`,
        );

      const bm = deps.createBitmapCache();
      bitmaps = bm;
      const decoder = deps.createDecoder({
        read: async (hash) => {
          const blob = await deps.fileBlob(hash);
          if (!blob) throw new Unavailable(`file ${hash.slice(0, 8)} unavailable`);
          return { blob, source: 'network' };
        },
        createImageBitmap: deps.createImageBitmap,
        ImageDecoder: deps.ImageDecoder,
        rasterSvg: (hash, blob) =>
          new Promise<ImageBitmap>((resolve, reject) => {
            const n = ++seq;
            const timer = deps.setTimer(() => {
              svgWaits.delete(n);
              reject(new Error('the page did not draw the SVG in time'));
            }, PAGE_ANSWER_MS);
            svgWaits.set(n, { resolve, reject, timer });
            post({ t: 'decode', id, seq: n, hash, blob });
          }),
      });
      const pictures = deps.framePictures({
        cache: bm.cache,
        decoder,
        images,
        out: OUT,
        steps,
        isMissing: (e) => e instanceof Unavailable,
        has: async (hash) => (await deps.fileBlob(hash)) !== undefined,
      });
      post({ t: 'phase', id, phase: 'drawing' });
      const r = await deps.bakeSlide(slide, {
        env: deps.env as never,
        pictures: pictures as never,
        live: job.live,
        scale: SCALE,
        deadlineMs: job.deadlineMs,
        cancelled: isCancelled,
        standIns: job.standIns,
      });
      // the full slide is not needed any more: the encoders hold the canvas only
      slide = undefined;
      holds = false;
      if (!r.ok) return failed(id, r.reason, r.detail);
      made = r;
      post({ t: 'phase', id, phase: 'encoding' });
      const enc = await deps.encodePicture(r, { maxBytes: BAKE_MAX_PICTURE_BYTES });
      Object.assign(ms, r.stats?.ms, (enc as { stats?: { ms?: Record<string, number> } }).stats?.ms);
      if (!enc.ok) return failed(id, enc.reason, enc.detail);
      ms.total = deps.now() - t0;
      post({
        t: 'made',
        id,
        pictures: enc.pictures.map((p) => ({ size: p.size, type: p.type, blob: p.blob, bytes: p.bytes })),
        opaque: enc.opaque,
        standIns: r.standIns,
        ms,
      });
    } catch (e) {
      if (e instanceof Stop) return failed(id, e.reason, e.detail);
      if (e instanceof Cancelled) return failed(id, 'cancelled', 'the job was stopped');
      if (e instanceof Unavailable) return failed(id, 'files', cut(e.message, 100));
      deps.log?.(`bake job ${id}: ${e instanceof Error ? e.name : 'a throw'}`);
      failed(id, 'draw', e instanceof Error ? e.name : 'a fault');
    } finally {
      holds = false;
      try {
        if (made?.canvas) made.canvas.width = 0;
      } catch {
        /* a canvas that cannot be shrunk is garbage already */
      }
      try {
        bitmaps?.dispose();
      } catch {
        /* nothing left to close */
      }
      for (const [, w] of svgWaits) {
        deps.clearTimer(w.timer);
        w.reject(new Error('the job ended'));
      }
      svgWaits.clear();
      const mw = mediaWaits.get(id);
      if (mw) deps.clearTimer(mw.timer);
      mediaWaits.delete(id);
    }
  }

  return {
    setFonts(list) {
      fonts = Array.isArray(list) ? list : [];
      fontsKey = JSON.stringify(fonts.map((f) => [f.family, f.weight, f.style, f.hash]));
    },
    cancel(id) {
      cancelled.add(id);
    },
    decoded(n, bitmap) {
      const w = svgWaits.get(n);
      if (!w) {
        bitmap?.close();
        return;
      }
      svgWaits.delete(n);
      deps.clearTimer(w.timer);
      if (bitmap) w.resolve(bitmap);
      else w.reject(new Error('the page could not draw the SVG'));
    },
    media(id, files) {
      const w = mediaWaits.get(id);
      if (!w) return;
      mediaWaits.delete(id);
      deps.clearTimer(w.timer);
      w.resolve(files);
    },
    async run(job) {
      const id = job?.id;
      if (running !== undefined) return failed(id, 'busy', 'a picture is being made');
      running = id;
      try {
        await make(job);
      } finally {
        cancelled.delete(id);
        running = undefined;
      }
    },
    get busy() {
      return running !== undefined;
    },
    get holdsSlide() {
      return holds;
    },
  };
}
