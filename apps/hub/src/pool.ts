/**
 * Worker-thread pool for CPU-bound parsing in the library process (design/25 "Hub"): ProPresenter decode
 * (including its RTF), PPTX XML text extraction, the pptx-preview annotation of a deck, font table parsing
 * and the native PowerPoint import's tasks (design/27: parse and emit, render copy, art pixels) never run
 * on the event loop that answers HTTP requests.
 *
 * - Workers start lazily, are `unref`'d (an idle pool never keeps the process alive) and exit after
 *   IDLE_MS without work.
 * - One task per worker at a time; further tasks queue.
 * - Every task has a timeout; a task that times out or is aborted terminates its worker (a parser stuck in
 *   a loop cannot be interrupted any other way) and the slot is re-created for the next task.
 * - A worker that cannot start rejects with WorkerStartError so the caller can decide to run inline.
 * - Each worker has its own small heap (WORKER_LIMITS): a runaway parse (a zip bomb, a 200 MB text node)
 *   fails in seconds inside the worker instead of growing the library process by gigabytes towards the
 *   container's OOM killer. Its task fails with a clear message and the next task gets a fresh worker.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { Annotation } from '@ordo/pptx-render/annotate.ts';
import type { Pro7ImportOptions, Pro7Result, PptxText } from './imports.ts';
import type { FontFace } from './fonts/sfnt.ts';
import type {
  ArtTaskInput,
  ArtTaskOutput,
  RenderCopyTaskInput,
  RenderCopyTaskOutput,
  SceneTaskInput,
  SceneTaskOutput,
} from './pptx/shared.ts';

/** The worker could not be started (no worker file, unsupported flags): the caller may run inline. */
export class WorkerStartError extends Error {}

export type CpuTasks = {
  pro7: { input: { files: Map<string, Uint8Array>; opts?: Pro7ImportOptions }; output: Pro7Result };
  pptx: { input: { buf: Uint8Array }; output: PptxText };
  /** A deck's annotation for pptx-preview (`annotatePptx`: run markers, styles, repaired parts). */
  'pptx-annotate': { input: { buf: Uint8Array }; output: Annotation };
  font: { input: { buf: Uint8Array }; output: FontFace };
  /** One batch of a native PowerPoint import: parse and emit (design/27 §2 step 2, `pptx/sceneTask.ts`). */
  'pptx-scene': { input: SceneTaskInput; output: SceneTaskOutput };
  /** The minimal deck LibreOffice prints for the follow-up (design/27 §5, `pptx/renderCopyTask.ts`). */
  'pptx-render-copy': { input: RenderCopyTaskInput; output: RenderCopyTaskOutput };
  /** One art slide's transparent picture from its white and black pages (design/27 §5, `pptx/art.ts`). */
  'pptx-art': { input: ArtTaskInput; output: ArtTaskOutput };
};
export type CpuTaskKind = keyof CpuTasks;

export const TASK_TIMEOUT_MS: Record<CpuTaskKind, number> = {
  pro7: 15 * 60_000,
  pptx: 2 * 60_000,
  'pptx-annotate': 2 * 60_000,
  font: 15_000,
  'pptx-scene': 2 * 60_000,
  'pptx-render-copy': 2 * 60_000,
  'pptx-art': 60_000,
};
const IDLE_MS = 30_000;
/**
 * Heap limits per worker: generous for any one task (a ProPresenter import is batched, imports.ts
 * PRO7_BATCH_DOCS, so a library of any size fits), small enough to fail fast on a bomb.
 */
export const WORKER_LIMITS = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 };

/** The message for a task whose worker ran out of its heap. */
export function outOfMemoryMessage(kind: string): string {
  return `${kind} import needs more memory than an import may use (${WORKER_LIMITS.maxOldGenerationSizeMb} MB); the file is too large or malformed`;
}

/** Where the worker entry lives: next to this module, `.ts` from source (tsx) or `.js` in the bundle. */
export function cpuWorkerUrl(): URL {
  const here = import.meta.url;
  return new URL(here.endsWith('.ts') ? './cpu.worker.ts' : './cpu.worker.js', here);
}

/** The tsx ESM loader as a file URL, for running the worker from TypeScript source (dev and tests). */
function tsxLoaderUrl(): string {
  const pkg = createRequire(import.meta.url).resolve('tsx/package.json');
  return pathToFileURL(join(dirname(pkg), 'dist', 'loader.mjs')).href;
}

type Task = {
  id: number;
  kind: CpuTaskKind;
  input: unknown;
  transfer: ArrayBuffer[];
  signal?: AbortSignal;
  resolve(v: unknown): void;
  reject(e: Error): void;
};

type Slot = { worker: Worker; busy?: Task; idle?: NodeJS.Timeout; started: boolean; timer?: NodeJS.Timeout };

export type PoolStats = {
  workers: number;
  busy: number;
  queued: number;
  completed: number;
  failed: number;
  restarts: number;
  /** Tasks that failed because their worker ran out of heap. */
  oom: number;
};

export class CpuPool {
  private slots: Slot[] = [];
  private queue: Task[] = [];
  private nextId = 1;
  private stats_ = { completed: 0, failed: 0, restarts: 0, oom: 0 };
  private closed = false;

  constructor(
    readonly size = 1,
    private url: URL = cpuWorkerUrl(),
  ) {}

  stats(): PoolStats {
    return {
      workers: this.slots.length,
      busy: this.slots.filter((s) => s.busy).length,
      queued: this.queue.length,
      ...this.stats_,
    };
  }

  run<K extends CpuTaskKind>(
    kind: K,
    input: CpuTasks[K]['input'],
    opts: { signal?: AbortSignal; transfer?: ArrayBuffer[] } = {},
  ): Promise<CpuTasks[K]['output']> {
    if (this.closed) return Promise.reject(new WorkerStartError('the worker pool is closed'));
    if (opts.signal?.aborted) return Promise.reject(new Error('cancelled'));
    return new Promise((resolve, reject) => {
      const task: Task = {
        id: this.nextId++,
        kind,
        input,
        transfer: opts.transfer ?? [],
        signal: opts.signal,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      const onAbort = () => {
        const q = this.queue.indexOf(task);
        if (q >= 0) {
          this.queue.splice(q, 1);
          reject(new Error('cancelled'));
          return;
        }
        const slot = this.slots.find((s) => s.busy === task);
        if (slot) this.fail(slot, new Error('cancelled'));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const done =
        <T>(fn: (v: T) => void) =>
        (v: T) => {
          opts.signal?.removeEventListener('abort', onAbort);
          fn(v);
        };
      task.resolve = done(task.resolve);
      task.reject = done(task.reject);
      this.queue.push(task);
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.queue.splice(0)) t.reject(new Error('cancelled'));
    await Promise.all(this.slots.splice(0).map((s) => this.kill(s, new Error('cancelled'))));
  }

  private spawn(): Slot | undefined {
    const fromSource = this.url.pathname.endsWith('.ts');
    let worker: Worker;
    try {
      worker = new Worker(this.url, {
        // From source the worker needs the TypeScript loader; the bundle inherits the process flags.
        ...(fromSource ? { execArgv: ['--import', tsxLoaderUrl()] } : {}),
        resourceLimits: WORKER_LIMITS,
      });
    } catch (e) {
      const err = new WorkerStartError((e as Error).message);
      for (const t of this.queue.splice(0)) t.reject(err);
      return undefined;
    }
    worker.unref();
    const slot: Slot = { worker, started: false };
    worker.on('online', () => {
      slot.started = true;
    });
    worker.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const t = slot.busy;
      if (!t || t.id !== m.id) return;
      clearTimeout(slot.timer);
      slot.busy = undefined;
      if (m.ok) {
        this.stats_.completed++;
        t.resolve(m.result);
      } else {
        this.stats_.failed++;
        t.reject(new Error(m.error ?? 'worker task failed'));
      }
      this.release(slot);
    });
    worker.on('error', (e) => {
      const oom = (e as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY';
      if (oom && slot.busy) this.stats_.oom++;
      this.drop(
        slot,
        oom && slot.busy
          ? new Error(outOfMemoryMessage(slot.busy.kind))
          : slot.started
            ? e
            : new WorkerStartError(e.message),
      );
    });
    worker.on('exit', (code) => {
      // A worker that dies while working (out of memory, a native crash) fails that task: the caller must
      // not retry the same input inline on the event loop. Only a worker that never came up means "no pool".
      this.drop(
        slot,
        slot.started
          ? new Error(`cpu worker exited with code ${code} while working`)
          : new WorkerStartError(`cpu worker exited with code ${code}`),
      );
    });
    this.slots.push(slot);
    return slot;
  }

  /** A worker died or failed: reject its task and forget it. The next task gets a fresh worker. */
  private drop(slot: Slot, err: Error): void {
    const i = this.slots.indexOf(slot);
    if (i < 0) return;
    this.slots.splice(i, 1);
    clearTimeout(slot.timer);
    clearTimeout(slot.idle);
    const t = slot.busy;
    slot.busy = undefined;
    if (t) {
      this.stats_.failed++;
      this.stats_.restarts++;
      t.reject(err);
    } else if (!slot.started) {
      // Never came up and had no task: fail what is waiting rather than spawn in a loop.
      for (const q of this.queue.splice(0))
        q.reject(err instanceof WorkerStartError ? err : new WorkerStartError(err.message));
    }
    this.pump();
  }

  private async kill(slot: Slot, err: Error): Promise<void> {
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    clearTimeout(slot.timer);
    clearTimeout(slot.idle);
    const t = slot.busy;
    slot.busy = undefined;
    if (t) t.reject(err);
    await slot.worker.terminate().catch(() => undefined);
  }

  private fail(slot: Slot, err: Error): void {
    this.stats_.failed++;
    this.stats_.restarts++;
    void this.kill(slot, err).then(() => this.pump());
  }

  private release(slot: Slot): void {
    clearTimeout(slot.idle);
    slot.idle = setTimeout(() => {
      if (!slot.busy) void this.kill(slot, new Error('idle'));
    }, IDLE_MS);
    slot.idle.unref();
    this.pump();
  }

  private pump(): void {
    while (this.queue.length) {
      let slot = this.slots.find((s) => !s.busy);
      if (!slot) {
        if (this.slots.length >= this.size) return;
        slot = this.spawn();
        if (!slot) return;
      }
      const task = this.queue.shift()!;
      clearTimeout(slot.idle);
      slot.busy = task;
      slot.timer = setTimeout(
        () =>
          this.fail(
            slot!,
            new Error(`${task.kind} task timed out after ${TASK_TIMEOUT_MS[task.kind] / 1000} s`),
          ),
        TASK_TIMEOUT_MS[task.kind],
      );
      slot.timer.unref();
      try {
        slot.worker.postMessage({ id: task.id, kind: task.kind, input: task.input }, task.transfer);
      } catch (e) {
        slot.busy = undefined;
        task.reject(e as Error);
        this.release(slot);
      }
    }
  }
}

/** Buffers that own their whole ArrayBuffer can be transferred instead of copied. */
export function transferables(bufs: Iterable<Uint8Array>): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const seen = new Set<ArrayBuffer>();
  for (const b of bufs)
    if (
      b.byteOffset === 0 &&
      b.byteLength === b.buffer.byteLength &&
      b.buffer instanceof ArrayBuffer &&
      !seen.has(b.buffer)
    ) {
      seen.add(b.buffer);
      out.push(b.buffer);
    }
  return out;
}

let shared: CpuPool | undefined;
/** The process-wide pool (size from ORDO_CPU_WORKERS, default 1: the NAS has few cores). */
export function cpuPool(): CpuPool {
  if (!shared) {
    const n = Number(process.env.ORDO_CPU_WORKERS ?? 1);
    shared = new CpuPool(Number.isInteger(n) && n >= 1 && n <= 8 ? n : 1);
  }
  return shared;
}
