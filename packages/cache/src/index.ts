import type { ManifestFile } from '@ordo/domain';

/** Content-addressed blob store. Keys are sha256 hex hashes. */
export interface FileStore {
  readonly kind: string;
  has(hash: string): Promise<boolean>;
  get(hash: string): Promise<Blob | undefined>;
  put(hash: string, blob: Blob): Promise<void>;
  /** Remove everything not in `keep`. */
  prune?(keep: Set<string>): Promise<number>;
}

/** Origin Private File System store, used by outputs. Files live in /ordo-cache/<hash>. */
export class OpfsStore implements FileStore {
  readonly kind = 'opfs';
  private dir?: Promise<FileSystemDirectoryHandle>;
  private known = new Set<string>();

  private root(): Promise<FileSystemDirectoryHandle> {
    this.dir ??= navigator.storage
      .getDirectory()
      .then((r) => r.getDirectoryHandle('ordo-cache', { create: true }));
    return this.dir;
  }

  async has(hash: string): Promise<boolean> {
    if (this.known.has(hash)) return true;
    try {
      const fh = await (await this.root()).getFileHandle(hash);
      const f = await fh.getFile();
      if (f.size > 0) this.known.add(hash);
      return f.size > 0;
    } catch {
      return false;
    }
  }

  async get(hash: string): Promise<Blob | undefined> {
    try {
      const fh = await (await this.root()).getFileHandle(hash);
      return await fh.getFile();
    } catch {
      return undefined;
    }
  }

  async put(hash: string, blob: Blob): Promise<void> {
    const dir = await this.root();
    // Write to a temp name then move, so a crash never leaves a truncated file under the real name.
    const tmp = await dir.getFileHandle(hash + '.part', { create: true });
    const w = await tmp.createWritable();
    await w.write(blob);
    await w.close();
    const anyTmp = tmp as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
    if (anyTmp.move) {
      try {
        await dir.removeEntry(hash);
      } catch {
        /* absent */
      }
      await anyTmp.move(hash);
    } else {
      const fh = await dir.getFileHandle(hash, { create: true });
      const w2 = await fh.createWritable();
      await w2.write(blob);
      await w2.close();
      await dir.removeEntry(hash + '.part');
    }
    this.known.add(hash);
  }

  async prune(keep: Set<string>): Promise<number> {
    const dir = await this.root();
    let n = 0;
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) {
      if (!keep.has(name)) {
        await dir.removeEntry(name).catch(() => undefined);
        this.known.delete(name);
        n++;
      }
    }
    return n;
  }
}

/** Cache API store, used by the operator and stage (and by service workers). */
export class CacheApiStore implements FileStore {
  readonly kind = 'cache-api';
  constructor(private name = 'ordo-files') {}
  private key(hash: string): string {
    return `/__ordo_cache/${hash}`;
  }
  async has(hash: string): Promise<boolean> {
    const c = await caches.open(this.name);
    return !!(await c.match(this.key(hash)));
  }
  async get(hash: string): Promise<Blob | undefined> {
    const c = await caches.open(this.name);
    const r = await c.match(this.key(hash));
    return r ? await r.blob() : undefined;
  }
  async put(hash: string, blob: Blob): Promise<void> {
    const c = await caches.open(this.name);
    await c.put(
      this.key(hash),
      new Response(blob, { headers: { 'content-type': blob.type || 'application/octet-stream' } }),
    );
  }
  async prune(keep: Set<string>): Promise<number> {
    const c = await caches.open(this.name);
    let n = 0;
    for (const req of await c.keys()) {
      const h = new URL(req.url).pathname.split('/').pop()!;
      if (!keep.has(h)) {
        await c.delete(req);
        n++;
      }
    }
    return n;
  }
}

/** In-memory store for tests and as a last resort when storage is unavailable. */
export class MemoryStore implements FileStore {
  readonly kind = 'memory';
  map = new Map<string, Blob>();
  async has(hash: string) {
    return this.map.has(hash);
  }
  async get(hash: string) {
    return this.map.get(hash);
  }
  async put(hash: string, blob: Blob) {
    this.map.set(hash, blob);
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

export type FillProgress = {
  ready: number;
  total: number;
  bytesReady: number;
  bytesTotal: number;
  failed: string[];
};

/**
 * Fill `store` with every manifest file, `concurrency` downloads at a time. Already-present files cost
 * one lookup. Reports progress after every file. Failed files are retried up to `retries` times, waiting
 * `retryDelayMs × attempt` between tries (default 500 ms).
 *
 * Never rejects: a store that throws on lookup counts the file as absent, one that throws on write counts
 * the attempt as failed, a fetcher that throws or returns something other than a Blob likewise. Every
 * unique file ends up in exactly one of `ready` or `failed`.
 */
export async function fillCache(
  store: FileStore,
  files: ManifestFile[],
  fetchFile: (hash: string) => Promise<Blob>,
  onProgress?: (p: FillProgress) => void,
  opts: { concurrency?: number; retries?: number; signal?: AbortSignal; retryDelayMs?: number } = {},
): Promise<FillProgress> {
  const unique = [...new Map(files.map((f) => [f.hash, f])).values()];
  const size = (f: ManifestFile) => (Number.isFinite(f.bytes) && f.bytes > 0 ? f.bytes : 0);
  const p: FillProgress = {
    ready: 0,
    total: unique.length,
    bytesReady: 0,
    bytesTotal: unique.reduce((a, f) => a + size(f), 0),
    failed: [],
  };
  const whole = (v: number | undefined, def: number, min: number) =>
    v !== undefined && Number.isFinite(v) ? Math.max(min, Math.floor(v)) : def;
  const concurrency = whole(opts.concurrency, 3, 1);
  const retries = whole(opts.retries, 2, 0);
  const delayMs = whole(opts.retryDelayMs, 500, 0);
  const queue = [...unique];
  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const f = queue.shift();
      if (!f) return;
      let ok = await store.has(f.hash).catch(() => false);
      for (let attempt = 0; !ok && attempt <= retries; attempt++) {
        if (opts.signal?.aborted) break;
        try {
          const blob = await fetchFile(f.hash);
          if (!(blob instanceof Blob)) throw new Error('fetch did not return a file');
          await store.put(f.hash, blob);
          ok = true;
        } catch {
          if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        }
      }
      if (ok) {
        p.ready++;
        p.bytesReady += size(f);
      } else p.failed.push(f.hash);
      onProgress?.({ ...p, failed: [...p.failed] });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return p;
}

/** Which manifest files are missing from the store. */
export async function verifyCache(store: FileStore, files: ManifestFile[]): Promise<string[]> {
  const missing: string[] = [];
  for (const f of files) if (!(await store.has(f.hash))) missing.push(f.hash);
  return missing;
}

/** Best-effort persistent storage so the browser does not evict the service cache. */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Small IndexedDB key-value store for JSON documents (library snapshot, resolved playlist, UI state).
 *
 * The open promise is cached only while it is good: a failed open is forgotten so the next call retries,
 * `onblocked` is reported (the open stays pending until the other tab closes), and a `versionchange` or
 * `close` on the connection drops it so later calls reopen instead of failing forever.
 */
export class JsonStore {
  private db?: Promise<IDBDatabase>;
  /** Diagnostics (blocked opens, reopened connections). */
  onLog?: (msg: string) => void;
  constructor(
    private name = 'ordo-json',
    private factory?: Pick<IDBFactory, 'open'>,
  ) {}

  private log(msg: string) {
    this.onLog?.(`JsonStore ${this.name}: ${msg}`);
  }

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    const factory = this.factory ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
    if (!factory) return Promise.reject(new Error('IndexedDB is not available'));
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(this.name, 1);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onblocked = () => this.log('open blocked by another tab holding the database');
      req.onsuccess = () => {
        const db = req.result;
        const drop = (why: string) => {
          if (this.db === p) this.db = undefined;
          this.log(`connection dropped (${why}); it reopens on the next call`);
        };
        db.onversionchange = () => {
          // Another tab wants to upgrade or delete the database: let it, and reopen lazily.
          drop('version change');
          try {
            db.close();
          } catch {
            // already closed
          }
        };
        db.onclose = () => drop('closed');
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
    this.db = p;
    p.catch(() => {
      if (this.db === p) this.db = undefined;
    });
    return p;
  }

  /** Run `fn` on the open database; a connection that turns out closed is reopened once. */
  private async withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const first = await this.open();
    try {
      return await fn(first);
    } catch (e) {
      if ((e as { name?: string } | null)?.name !== 'InvalidStateError') throw e;
      if (this.db) {
        const current = await this.db.catch(() => undefined);
        if (current === first) this.db = undefined;
      }
      this.log('transaction on a closed connection; reopening');
      return fn(await this.open());
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.withDb(
      (db) =>
        new Promise((resolve, reject) => {
          const r = db.transaction('kv').objectStore('kv').get(key);
          r.onsuccess = () => resolve(r.result as T | undefined);
          r.onerror = () => reject(r.error);
        }),
    );
  }

  async set(key: string, value: unknown): Promise<void> {
    return this.withDb(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        }),
    );
  }
}
