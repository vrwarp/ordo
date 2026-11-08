import type { FileStore } from '@ordo/cache';
import type { ManifestFile } from '@ordo/domain';

/**
 * The output's service cache in the Origin Private File System, filled from the link worker (design/25).
 * Downloads stream straight from the response body into an OPFS writable, so a 2 GB motion background
 * never sits in memory as a Blob. Writes go to `<hash>.part` and are moved into place when complete, so a
 * crash never leaves a truncated file under the real name (the asset worker reads `<hash>`).
 */
export interface StreamStore extends FileStore {
  /** Size in bytes of a complete cached file, undefined when absent. */
  size(hash: string): Promise<number | undefined>;
  remove(hash: string): Promise<void>;
  /** Stream `body` into the cache under `hash`; resolves with the bytes written. */
  putStream(hash: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<number>;
  /** Throws when the storage cannot be used at all. */
  probe(): Promise<void>;
}

type Dir = FileSystemDirectoryHandle & {
  keys(): AsyncIterable<string>;
};
type MovableHandle = FileSystemFileHandle & { move?: (name: string) => Promise<void> };

export class OpfsStreamStore implements StreamStore {
  readonly kind = 'opfs';
  private dir?: Promise<Dir>;
  constructor(private dirName = 'ordo-cache') {}

  private root(): Promise<Dir> {
    if (!this.dir) {
      const p = navigator.storage
        .getDirectory()
        .then((r) => r.getDirectoryHandle(this.dirName, { create: true }) as Promise<Dir>);
      this.dir = p;
      // A failed open is not cached: the next call tries again.
      p.catch(() => {
        if (this.dir === p) this.dir = undefined;
      });
    }
    return this.dir;
  }

  async probe(): Promise<void> {
    await this.root();
  }

  async size(hash: string): Promise<number | undefined> {
    try {
      const f = await (await (await this.root()).getFileHandle(hash)).getFile();
      return f.size;
    } catch {
      return undefined;
    }
  }

  async has(hash: string): Promise<boolean> {
    return ((await this.size(hash)) ?? 0) > 0;
  }

  async get(hash: string): Promise<Blob | undefined> {
    try {
      const f = await (await (await this.root()).getFileHandle(hash)).getFile();
      return f.size > 0 ? f : undefined;
    } catch {
      return undefined;
    }
  }

  async remove(hash: string): Promise<void> {
    const dir = await this.root();
    await dir.removeEntry(hash).catch(() => undefined);
  }

  async put(hash: string, blob: Blob): Promise<void> {
    await this.putStream(hash, blob.stream());
  }

  async putStream(hash: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<number> {
    const dir = await this.root();
    const part = `${hash}.part`;
    const tmp = (await dir.getFileHandle(part, { create: true })) as MovableHandle;
    const w = await tmp.createWritable();
    let bytes = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        bytes += chunk.byteLength;
        ctl.enqueue(chunk);
      },
    });
    try {
      // pipeTo closes the writable (committing the file) when the body ends, aborts it on error.
      await body.pipeThrough(counter).pipeTo(w as unknown as WritableStream<Uint8Array>, { signal });
    } catch (err) {
      await dir.removeEntry(part).catch(() => undefined);
      throw err;
    }
    if (tmp.move) {
      await dir.removeEntry(hash).catch(() => undefined);
      await tmp.move(hash);
    } else {
      // Older engines: copy the finished part file under the real name.
      const file = await tmp.getFile();
      const fh = await dir.getFileHandle(hash, { create: true });
      const w2 = await fh.createWritable();
      await file.stream().pipeTo(w2 as unknown as WritableStream<Uint8Array>);
      await dir.removeEntry(part).catch(() => undefined);
    }
    return bytes;
  }

  async prune(keep: Set<string>): Promise<number> {
    const dir = await this.root();
    const names: string[] = [];
    for await (const name of dir.keys()) names.push(name);
    let n = 0;
    for (const name of names) {
      if (keep.has(name)) continue;
      await dir.removeEntry(name).catch(() => undefined);
      n++;
    }
    return n;
  }
}

/** In-memory StreamStore for tests (and for a window whose OPFS is unusable: holds nothing). */
export class MemoryStreamStore implements StreamStore {
  readonly kind = 'memory';
  map = new Map<string, Blob>();
  constructor(private keepNothing = false) {}
  async probe(): Promise<void> {}
  async size(hash: string) {
    return this.map.get(hash)?.size;
  }
  async has(hash: string) {
    return (this.map.get(hash)?.size ?? 0) > 0;
  }
  async get(hash: string) {
    return this.map.get(hash);
  }
  async remove(hash: string) {
    this.map.delete(hash);
  }
  async put(hash: string, blob: Blob) {
    if (!this.keepNothing) this.map.set(hash, blob);
  }
  async putStream(hash: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<number> {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = body.getReader();
    for (;;) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.byteLength;
    }
    if (!this.keepNothing) this.map.set(hash, new Blob(chunks as BlobPart[]));
    return bytes;
  }
  async prune(keep: Set<string>) {
    let n = 0;
    for (const k of [...this.map.keys()])
      if (!keep.has(k)) {
        this.map.delete(k);
        n++;
      }
    return n;
  }
}

/** Why a file did not get into the cache. */
/** `missing`: the hub answered 404/410 (the file is not on the hub); `size`: every download stored 0 bytes. */
export type FillFailure = 'network' | 'quota' | 'store' | 'size' | 'missing';

export type StreamFillProgress = {
  ready: number;
  total: number;
  bytesReady: number;
  bytesTotal: number;
  failed: string[];
  /** Why each failed file failed. */
  failures: Record<string, FillFailure>;
  /** Files present but of the wrong size, removed and fetched again. */
  repaired: string[];
  /**
   * Files whose every download disagreed with the manifest's size and were kept (the manifest may be
   * wrong): hash -> the size kept. The caller remembers these so the file is not fetched again forever.
   */
  mismatched: Record<string, number>;
};

export type FileBody = ReadableStream<Uint8Array> | Blob;

type Outcome = { ok: boolean; reason?: FillFailure; mismatch?: number };

/**
 * The service cache's downloads in flight, shared across fills (review 2026-11-04 item 11): a manifest
 * change cancels only the downloads whose hash left the manifest; a file still wanted keeps downloading
 * and the next fill joins it instead of starting over.
 */
export class Downloads {
  private map = new Map<string, { ac: AbortController; p: Promise<Outcome> }>();

  get size(): number {
    return this.map.size;
  }

  has(hash: string): boolean {
    return this.map.has(hash);
  }

  /** The download of `hash` in flight, else a new one running `fn` with its own abort signal. */
  run(hash: string, fn: (signal: AbortSignal) => Promise<Outcome>): Promise<Outcome> {
    const have = this.map.get(hash);
    if (have) return have.p;
    const ac = new AbortController();
    const p = fn(ac.signal).finally(() => {
      if (this.map.get(hash)?.p === p) this.map.delete(hash);
    });
    this.map.set(hash, { ac, p });
    return p;
  }

  /** Abort every download whose hash is not in `keep`; returns how many were aborted. */
  retain(keep: ReadonlySet<string>): number {
    let n = 0;
    for (const [h, d] of this.map)
      if (!keep.has(h)) {
        d.ac.abort();
        this.map.delete(h);
        n++;
      }
    return n;
  }
}

/**
 * Fill `store` with every manifest file, `concurrency` downloads at a time, streaming each body into the
 * store. A cached file whose size differs from the manifest is treated as corrupt: removed and fetched
 * again, unless it is the size the caller already accepted for it (`accepted`). A fresh download of the
 * wrong size is retried; if every attempt disagrees with the manifest the file is kept (the manifest may
 * be wrong) and reported in `mismatched`, never fetched in a loop. A full disk (QuotaExceededError) fails
 * the file at once (`failures[hash] = 'quota'`); retrying is the caller's business, with backoff.
 *
 * `signal` stops the fill. With `downloads`, it stops only the queue: downloads in flight belong to the
 * shared set, which the caller trims with `retain` when the manifest changes.
 */
/** Whether a fetch failure says the hub does not have the file (HTTP 404 or 410). */
export function isMissing(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | null;
  const status = e?.status ?? Number(/HTTP (\d+)/.exec(e?.message ?? '')?.[1]);
  return status === 404 || status === 410;
}

export async function fillStreaming(
  store: StreamStore,
  files: ManifestFile[],
  fetchBody: (hash: string, signal?: AbortSignal) => Promise<FileBody>,
  onProgress?: (p: StreamFillProgress) => void,
  opts: {
    concurrency?: number;
    retries?: number;
    signal?: AbortSignal;
    onStoreError?: (err: unknown) => void;
    sleep?: (ms: number) => Promise<void>;
    accepted?: ReadonlyMap<string, number>;
    downloads?: Downloads;
  } = {},
): Promise<StreamFillProgress> {
  const unique = [...new Map(files.map((f) => [f.hash, f])).values()];
  const p: StreamFillProgress = {
    ready: 0,
    total: unique.length,
    bytesReady: 0,
    bytesTotal: unique.reduce((a, f) => a + (f.bytes || 0), 0),
    failed: [],
    failures: {},
    repaired: [],
    mismatched: {},
  };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = opts.retries ?? 2;
  const queue = [...unique];
  const download = async (f: ManifestFile, signal?: AbortSignal): Promise<Outcome> => {
    let reason: FillFailure = 'network';
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal?.aborted) return { ok: false };
      let body: FileBody | undefined;
      try {
        body = await fetchBody(f.hash, signal);
      } catch (err) {
        if (signal?.aborted) return { ok: false };
        // A file the hub does not have (404/410) is not fetched again within this fill.
        if (isMissing(err)) return { ok: false, reason: 'missing' };
        reason = 'network';
      }
      if (body) {
        try {
          const n = await store.putStream(f.hash, body instanceof Blob ? body.stream() : body, signal);
          if (!f.bytes || n === f.bytes) return { ok: n > 0 || !f.bytes };
          if (attempt === retries) return n > 0 ? { ok: true, mismatch: n } : { ok: false, reason: 'size' };
          reason = 'size';
          await store.remove(f.hash).catch(() => undefined);
        } catch (err) {
          if (signal?.aborted) return { ok: false };
          // A body that breaks mid-stream is the network's fault (TypeError); anything else is storage.
          const name = (err as { name?: string } | null)?.name;
          if (name !== 'TypeError' && name !== 'AbortError') opts.onStoreError?.(err);
          // A full disk does not get better within this fill: stop here, the caller backs off.
          if (name === 'QuotaExceededError') return { ok: false, reason: 'quota' };
          reason = name === 'TypeError' || name === 'AbortError' ? 'network' : 'store';
        }
      }
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
    return { ok: false, reason };
  };
  const one = async (f: ManifestFile): Promise<Outcome> => {
    // A download of this file in flight (started by an earlier fill) is joined, not repeated.
    if (opts.downloads?.has(f.hash)) return opts.downloads.run(f.hash, (s) => download(f, s));
    const have = await store.size(f.hash).catch((err) => {
      opts.onStoreError?.(err);
      return undefined;
    });
    const accepted = opts.accepted?.get(f.hash);
    if (have !== undefined && have > 0 && (!f.bytes || have === f.bytes || have === accepted))
      return { ok: true };
    if (have !== undefined) {
      if (have > 0 || f.bytes) p.repaired.push(f.hash);
      await store.remove(f.hash).catch(() => undefined);
    }
    if (opts.downloads) return opts.downloads.run(f.hash, (s) => download(f, s));
    return download(f, opts.signal);
  };
  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const f = queue.shift();
      if (!f) return;
      const o = await one(f);
      if (o.ok) {
        p.ready++;
        p.bytesReady += f.bytes || 0;
        if (o.mismatch !== undefined) p.mismatched[f.hash] = o.mismatch;
      } else if (!opts.signal?.aborted && o.reason) {
        p.failed.push(f.hash);
        p.failures[f.hash] = o.reason;
      } else if (!opts.signal?.aborted) {
        // Aborted by the shared set (the file left the manifest of a newer fill): not a failure.
        p.failed.push(f.hash);
        p.failures[f.hash] = 'network';
      }
      onProgress?.({
        ...p,
        failed: [...p.failed],
        failures: { ...p.failures },
        repaired: [...p.repaired],
        mismatched: { ...p.mismatched },
      });
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 3 }, worker));
  return p;
}

/** Cached files whose size disagrees with the manifest (truncated or overwritten). */
export async function findCorrupt(
  store: StreamStore,
  files: ManifestFile[],
  accepted?: ReadonlyMap<string, number>,
): Promise<string[]> {
  const bad: string[] = [];
  for (const f of files) {
    if (!f.bytes) continue;
    const n = await store.size(f.hash).catch(() => undefined);
    // A size accepted after every download disagreed with the manifest is not corruption.
    if (n !== undefined && n !== f.bytes && n !== accepted?.get(f.hash)) bad.push(f.hash);
  }
  return bad;
}
