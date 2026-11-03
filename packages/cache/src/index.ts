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
 * one lookup. Reports progress after every file. Failed files are retried up to `retries` times.
 */
export async function fillCache(
  store: FileStore,
  files: ManifestFile[],
  fetchFile: (hash: string) => Promise<Blob>,
  onProgress?: (p: FillProgress) => void,
  opts: { concurrency?: number; retries?: number; signal?: AbortSignal } = {},
): Promise<FillProgress> {
  const unique = [...new Map(files.map((f) => [f.hash, f])).values()];
  const p: FillProgress = {
    ready: 0,
    total: unique.length,
    bytesReady: 0,
    bytesTotal: unique.reduce((a, f) => a + f.bytes, 0),
    failed: [],
  };
  const queue = [...unique];
  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const f = queue.shift();
      if (!f) return;
      let ok = await store.has(f.hash);
      for (let attempt = 0; !ok && attempt <= (opts.retries ?? 2); attempt++) {
        try {
          const blob = await fetchFile(f.hash);
          await store.put(f.hash, blob);
          ok = true;
        } catch {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      if (ok) {
        p.ready++;
        p.bytesReady += f.bytes;
      } else p.failed.push(f.hash);
      onProgress?.({ ...p, failed: [...p.failed] });
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 3 }, worker));
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
 */
export class JsonStore {
  private db?: Promise<IDBDatabase>;
  constructor(private name = 'ordo-json') {}
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }
  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const r = db.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => reject(r.error);
    });
  }
  async set(key: string, value: unknown): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
