/**
 * Going live prepared beside the running service (design/29 §2.3 M8): the check of a goLive runs in a worker
 * thread of the live process, never on the loop that applies GO, Next and Clear.
 *
 * The worker gets the bundle's JSON bytes as the library sent them (a SharedArrayBuffer view, so nothing is
 * copied on the loop), parses them, checks and quarantines every presentation (`quarantinePresentation`,
 * through `resolvePlaylist`), resolves, serialises the resolved copy once and hashes that buffer: the
 * SHA-256 is the copy's `resolvedId` (M2, live-by-ref). It sends back the buffer (transferred); the live
 * loop then parses it once and applies the goLive.
 *
 * Built as its own bundle entry (dist/golive-worker.js); run from source under tsx in dev and tests. The
 * same module holds the loop's side (`GoLiveWorker`); the worker body runs only in a thread started with
 * GOLIVE_WORKER_TAG.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import {
  type FileRef,
  type Font,
  type GeneralSettings,
  type GoLiveInputs,
  GoLiveRejection,
  type Look,
  type Media,
  type PrerenderRow,
  resolvePlaylist,
} from '@ordo/domain';

/** What the library process sends for one goLive (`GET /internal/golive/<id>`), plus when it was taken. */
export type GoLiveBundle = {
  playlist: unknown;
  presentations: Record<string, unknown>;
  media: Record<string, Media>;
  /** The geometry files the presentations' shapes name (`ShapeGeom.ref`); absent in a copy saved before them. */
  files?: Record<string, FileRef>;
  /**
   * Pre-rendered slides (design/29 §1.7), all absent when nothing is in them (and in a copy saved before them):
   * each head's pages, and per presentation the keys of its current revision and its picture rows.
   */
  slideHeads?: Record<string, { pages: string[] }>;
  prerenders?: Record<string, PrerenderRow[]>;
  prerenderKeys?: Record<string, string[]>;
  fonts: Font[];
  looks: Look[];
  general: GeneralSettings;
  takenAt: number;
};

/** A bundle as goLive inputs (the playlist and presentations still unvalidated). */
export function bundleInputs(
  b: Omit<GoLiveBundle, 'takenAt'>,
  extra: { takenAt?: number; cachedCopy?: string } = {},
): GoLiveInputs {
  const obj = <T>(x: unknown): Record<string, T> =>
    x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, T>) : {};
  const presentations = obj<unknown>(b.presentations);
  const media = obj<Media>(b.media);
  const files = obj<FileRef>(b.files);
  const heads = obj<{ pages?: unknown }>(b.slideHeads);
  const rows = obj<PrerenderRow[]>(b.prerenders);
  const keys = obj<string[]>(b.prerenderKeys);
  return {
    playlist: b.playlist,
    presentation: (id) => (Object.hasOwn(presentations, id) ? presentations[id] : undefined),
    media: (id) => (Object.hasOwn(media, id) ? media[id] : undefined),
    file: (hash) => (Object.hasOwn(files, hash) ? files[hash] : undefined),
    slideHead: (ref) => {
      const pages = Object.hasOwn(heads, ref) ? heads[ref]?.pages : undefined;
      return Array.isArray(pages) ? { pages: pages as string[] } : undefined;
    },
    prerenders: (id) => (Object.hasOwn(rows, id) && Array.isArray(rows[id]) ? rows[id]! : []),
    prerenderKeys: (id) => (Object.hasOwn(keys, id) && Array.isArray(keys[id]) ? keys[id]! : []),
    fonts: () => (Array.isArray(b.fonts) ? b.fonts : []),
    looks: Array.isArray(b.looks) ? b.looks : [],
    general: b.general && typeof b.general === 'object' ? b.general : {},
    ...(extra.takenAt !== undefined ? { takenAt: extra.takenAt } : {}),
    ...(extra.cachedCopy ? { cachedCopy: extra.cachedCopy } : {}),
  };
}

/** The manifest digest the hub has always used: SHA-256 of the identity parts, 24 hex characters. */
export function manifestDigest(parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex').slice(0, 24);
}

export type PrepareInput = {
  playlistId: string;
  /** The bundle's JSON bytes (without `takenAt`). */
  bundle: Uint8Array;
  takenAt: number;
  /** Set when this is a cached copy: the degraded reason naming its time (`cachedCopyReason`). */
  cachedCopy?: string;
};
export type PrepareWarning = { message: string; detail?: Record<string, unknown> };
export type PrepareOutput =
  | {
      ok: true;
      /** The resolved copy, serialised once (UTF-8 JSON). */
      buffer: Uint8Array;
      /** SHA-256 of `buffer` (hex): the copy's identity (design/29 M2). */
      resolvedId: string;
      /** Time in the worker: parse, check and resolve, serialise and hash (ms). */
      ms: { parse: number; resolve: number; serialise: number };
      warnings: PrepareWarning[];
    }
  | { ok: false; reason: string; warnings: PrepareWarning[] };

const utf8 = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Parse, check, resolve, serialise once and hash a goLive bundle. Pure (no I/O): the worker runs it, tests
 * and a hub without worker threads call it inline. A GoLiveRejection becomes `{ ok: false }`.
 */
export function prepareGoLive(input: PrepareInput): PrepareOutput {
  const warnings: PrepareWarning[] = [];
  const t0 = performance.now();
  let bundle: Omit<GoLiveBundle, 'takenAt'>;
  try {
    bundle = JSON.parse(utf8.decode(input.bundle)) as Omit<GoLiveBundle, 'takenAt'>;
  } catch {
    return {
      ok: false,
      reason: 'The library sent a damaged copy of this playlist; try Go live again',
      warnings,
    };
  }
  if (!bundle || typeof bundle !== 'object')
    return {
      ok: false,
      reason: 'The library sent a damaged copy of this playlist; try Go live again',
      warnings,
    };
  const t1 = performance.now();
  try {
    const resolved = resolvePlaylist(
      bundleInputs(bundle, { takenAt: input.takenAt, cachedCopy: input.cachedCopy }),
      input.playlistId,
      { digest: manifestDigest, warn: (message, detail) => warnings.push({ message, detail }) },
    );
    const t2 = performance.now();
    const buffer = encoder.encode(JSON.stringify(resolved));
    const resolvedId = createHash('sha256').update(buffer).digest('hex');
    const t3 = performance.now();
    return {
      ok: true,
      buffer,
      resolvedId,
      ms: { parse: t1 - t0, resolve: t2 - t1, serialise: t3 - t2 },
      warnings,
    };
  } catch (e) {
    if (e instanceof GoLiveRejection) return { ok: false, reason: e.message, warnings };
    throw e;
  }
}

/** The thread's tag: the worker body runs only where workerData carries it. */
export const GOLIVE_WORKER_TAG = 'ordo-golive-worker';
/** A check that takes longer is abandoned (its worker terminated) and the goLive refused. */
export const PREPARE_TIMEOUT_MS = 60_000;
/** An idle worker exits after this; the next prepare starts a new one. */
const IDLE_MS = 60_000;
/**
 * The worker's heap: a bundle up to the fetch bound (`BUNDLE_MAX_BYTES`) parsed, its presentations checked and
 * the resolved copy serialised, with room to spare; small enough to fail in seconds instead of growing the
 * live process towards the container's limit.
 */
export const GOLIVE_WORKER_LIMITS = { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64 };

/** Where the worker entry lives: next to this module, `.ts` from source (tsx) or `.js` in the bundle. */
export function goLiveWorkerUrl(): URL {
  const here = import.meta.url;
  return new URL(here.endsWith('.ts') ? './golive-worker.ts' : './golive-worker.js', here);
}

function tsxLoaderUrl(): string {
  const pkg = createRequire(import.meta.url).resolve('tsx/package.json');
  return pathToFileURL(join(dirname(pkg), 'dist', 'loader.mjs')).href;
}

type Pending = { resolve(o: PrepareOutput): void; reject(e: Error): void; timer: NodeJS.Timeout };

/**
 * The live loop's side: one worker thread, started on first use, `unref`'d, gone after IDLE_MS idle. One
 * check at a time per message id; a check past its timeout terminates the worker (a stuck parse cannot be
 * interrupted otherwise). When no worker can start, the check runs inline (logged by the caller).
 */
export class GoLiveWorker {
  private worker?: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private idle?: NodeJS.Timeout;
  private url: URL;
  /** The worker could not start: checks run inline from then on. */
  inline = false;
  constructor(url: URL = goLiveWorkerUrl()) {
    this.url = url;
  }

  run(input: PrepareInput, timeoutMs = PREPARE_TIMEOUT_MS): Promise<PrepareOutput> {
    if (this.inline) return Promise.resolve().then(() => prepareGoLive(input));
    const w = this.spawn();
    if (!w) return Promise.resolve().then(() => prepareGoLive(input));
    clearTimeout(this.idle);
    const id = this.nextId++;
    return new Promise<PrepareOutput>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`checking the service took longer than ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        // A SharedArrayBuffer view is shared, never copied; any other buffer is cloned.
        w.postMessage({ id, input });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  async close(): Promise<void> {
    clearTimeout(this.idle);
    const w = this.worker;
    this.worker = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('cancelled'));
      this.pending.delete(id);
    }
    await w?.terminate().catch(() => undefined);
  }

  private spawn(): Worker | undefined {
    if (this.worker) return this.worker;
    const fromSource = this.url.pathname.endsWith('.ts');
    let w: Worker;
    try {
      w = new Worker(this.url, {
        workerData: { ordo: GOLIVE_WORKER_TAG },
        ...(fromSource ? { execArgv: ['--import', tsxLoaderUrl()] } : {}),
        resourceLimits: GOLIVE_WORKER_LIMITS,
      });
    } catch {
      this.inline = true;
      return undefined;
    }
    w.unref();
    w.on('message', (m: { id: number; out?: PrepareOutput; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.out) p.resolve(m.out);
      else p.reject(new Error(m.error ?? 'the check failed'));
      if (!this.pending.size) this.armIdle();
    });
    w.on('error', (e) => this.drop(w, e));
    w.on('exit', (code) => this.drop(w, new Error(`the check's worker exited with code ${code}`)));
    this.worker = w;
    return w;
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (!this.pending.size) void this.close();
    }, IDLE_MS);
    this.idle.unref();
  }

  private drop(w: Worker, e: Error): void {
    if (this.worker !== w) return;
    this.worker = undefined;
    const oom = (e as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY';
    const err = oom ? new Error('this service needs more memory than going live may use') : e;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private fail(e: Error): void {
    const w = this.worker;
    if (w) {
      this.drop(w, e);
      void w.terminate().catch(() => undefined);
    }
  }
}

// ---- the worker thread ----
if (!isMainThread && parentPort && (workerData as { ordo?: string } | null)?.ordo === GOLIVE_WORKER_TAG) {
  const port = parentPort;
  port.on('message', (m: { id: number; input: PrepareInput }) => {
    try {
      const out = prepareGoLive(m.input);
      port.postMessage({ id: m.id, out }, out.ok ? [out.buffer.buffer as ArrayBuffer] : []);
    } catch (e) {
      port.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
