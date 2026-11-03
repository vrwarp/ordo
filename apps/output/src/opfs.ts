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

export type StreamFillProgress = {
  ready: number;
  total: number;
  bytesReady: number;
  bytesTotal: number;
  failed: string[];
  /** Files present but of the wrong size, removed and fetched again. */
  repaired: string[];
};

export type FileBody = ReadableStream<Uint8Array> | Blob;

/**
 * Fill `store` with every manifest file, `concurrency` downloads at a time, streaming each body into the
 * store. A cached file whose size differs from the manifest is treated as corrupt: removed and fetched
 * again. A fresh download of the wrong size is retried; if every attempt disagrees with the manifest the
 * file is kept (the manifest may be wrong) and reported failed, so it is retried later, never in a loop.
 */
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
  } = {},
): Promise<StreamFillProgress> {
  const unique = [...new Map(files.map((f) => [f.hash, f])).values()];
  const p: StreamFillProgress = {
    ready: 0,
    total: unique.length,
    bytesReady: 0,
    bytesTotal: unique.reduce((a, f) => a + (f.bytes || 0), 0),
    failed: [],
    repaired: [],
  };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const queue = [...unique];
  const one = async (f: ManifestFile): Promise<boolean> => {
    const have = await store.size(f.hash).catch((err) => {
      opts.onStoreError?.(err);
      return undefined;
    });
    if (have !== undefined && have > 0 && (!f.bytes || have === f.bytes)) return true;
    if (have !== undefined) {
      if (have > 0 || f.bytes) p.repaired.push(f.hash);
      await store.remove(f.hash).catch(() => undefined);
    }
    for (let attempt = 0; attempt <= (opts.retries ?? 2); attempt++) {
      if (opts.signal?.aborted) return false;
      let body: FileBody | undefined;
      try {
        body = await fetchBody(f.hash, opts.signal);
      } catch {
        if (opts.signal?.aborted) return false;
      }
      if (body) {
        try {
          const n = await store.putStream(f.hash, body instanceof Blob ? body.stream() : body, opts.signal);
          if (!f.bytes || n === f.bytes || attempt === (opts.retries ?? 2)) return n > 0 || !f.bytes;
          await store.remove(f.hash).catch(() => undefined);
        } catch (err) {
          if (opts.signal?.aborted) return false;
          // A body that breaks mid-stream is the network's fault (TypeError); anything else is storage.
          const name = (err as { name?: string } | null)?.name;
          if (name !== 'TypeError' && name !== 'AbortError') opts.onStoreError?.(err);
        }
      }
      await sleep(500 * (attempt + 1));
    }
    return false;
  };
  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const f = queue.shift();
      if (!f) return;
      if (await one(f)) {
        p.ready++;
        p.bytesReady += f.bytes || 0;
      } else if (!opts.signal?.aborted) p.failed.push(f.hash);
      onProgress?.({ ...p, failed: [...p.failed], repaired: [...p.repaired] });
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 3 }, worker));
  return p;
}

/** Cached files whose size disagrees with the manifest (truncated or overwritten). */
export async function findCorrupt(store: StreamStore, files: ManifestFile[]): Promise<string[]> {
  const bad: string[] = [];
  for (const f of files) {
    if (!f.bytes) continue;
    const n = await store.size(f.hash).catch(() => undefined);
    if (n !== undefined && n !== f.bytes) bad.push(f.hash);
  }
  return bad;
}
