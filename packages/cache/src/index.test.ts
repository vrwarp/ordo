import { describe, expect, it } from 'vitest';
import { JsonStore, MemoryStore, fillCache, verifyCache } from './index.ts';

describe('fillCache', () => {
  it('downloads missing files once, retries failures, reports progress', async () => {
    const store = new MemoryStore();
    await store.put('a', new Blob(['x']));
    const calls: string[] = [];
    let flaky = 0;
    const progress: number[] = [];
    const res = await fillCache(
      store,
      [
        { hash: 'a', bytes: 1, mime: 'x' },
        { hash: 'b', bytes: 2, mime: 'x' },
        { hash: 'b', bytes: 2, mime: 'x' },
        { hash: 'c', bytes: 3, mime: 'x' },
      ],
      async (h) => {
        calls.push(h);
        if (h === 'c' && flaky++ < 1) throw new Error('flaky');
        return new Blob([h]);
      },
      (p) => progress.push(p.ready),
      { concurrency: 1 },
    );
    expect(res).toMatchObject({ ready: 3, total: 3, bytesReady: 6, failed: [] });
    expect(calls).toEqual(['b', 'c', 'c']);
    expect(progress).toEqual([1, 2, 3]);
    expect(await verifyCache(store, [{ hash: 'z', bytes: 1, mime: 'x' }])).toEqual(['z']);
  });
});

// ---- A minimal IndexedDB fake: just enough of the open/transaction protocol for JsonStore ----

type Handler = (() => void) | null;
class FakeRequest {
  result!: FakeDb;
  error: Error | null = null;
  onupgradeneeded: Handler = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onblocked: Handler = null;
}
class FakeDb {
  closed = false;
  onversionchange: Handler = null;
  onclose: Handler = null;
  objectStoreNames = { contains: () => true };
  public data: Map<string, unknown>;
  constructor(data: Map<string, unknown>) {
    this.data = data;
  }
  close() {
    this.closed = true;
  }
  transaction(_name: string, _mode?: string) {
    if (this.closed) {
      const e = new Error('closed');
      e.name = 'InvalidStateError';
      throw e;
    }
    const tx = {
      oncomplete: null as Handler,
      onerror: null as Handler,
      onabort: null as Handler,
      error: null,
    };
    const data = this.data;
    return Object.assign(tx, {
      objectStore: () => ({
        get: (key: string) => {
          const r = {
            result: data.get(key),
            error: null,
            onsuccess: null as Handler,
            onerror: null as Handler,
          };
          queueMicrotask(() => r.onsuccess?.());
          return r;
        },
        put: (value: unknown, key: string) => {
          data.set(key, value);
          queueMicrotask(() => tx.oncomplete?.());
        },
      }),
    });
  }
}
class FakeFactory {
  requests: FakeRequest[] = [];
  dbs: FakeDb[] = [];
  data = new Map<string, unknown>();
  /** Outcome of the next opens: 'ok', 'error', 'blocked-then-ok', or 'throw'. */
  script: ('ok' | 'error' | 'blocked-then-ok' | 'throw')[] = [];
  open(_name: string, _version: number): IDBOpenDBRequest {
    const outcome = this.script.shift() ?? 'ok';
    if (outcome === 'throw') throw new Error('SecurityError');
    const req = new FakeRequest();
    this.requests.push(req);
    queueMicrotask(() => {
      if (outcome === 'error') {
        req.error = new Error('QuotaExceededError');
        req.onerror?.();
        return;
      }
      if (outcome === 'blocked-then-ok') req.onblocked?.();
      req.result = new FakeDb(this.data);
      this.dbs.push(req.result);
      req.onsuccess?.();
    });
    return req as unknown as IDBOpenDBRequest;
  }
}

describe('JsonStore', () => {
  it('forgets a failed open so the next call retries (item 35)', async () => {
    const f = new FakeFactory();
    f.script = ['error', 'throw', 'ok'];
    const store = new JsonStore('t', f);
    await expect(store.get('a')).rejects.toThrow('QuotaExceededError');
    await expect(store.get('a')).rejects.toThrow('SecurityError');
    await store.set('a', { v: 1 });
    expect(await store.get('a')).toEqual({ v: 1 });
    expect(f.dbs).toHaveLength(1);
    // The good connection is cached.
    await store.get('a');
    expect(f.requests).toHaveLength(2);
  });

  it('reports a blocked open and still resolves when the blocker goes away', async () => {
    const f = new FakeFactory();
    f.script = ['blocked-then-ok'];
    const store = new JsonStore('t', f);
    const log: string[] = [];
    store.onLog = (m) => log.push(m);
    await store.set('k', 1);
    expect(log.some((m) => /blocked/.test(m))).toBe(true);
  });

  it('reopens after a version change or a closed connection', async () => {
    const f = new FakeFactory();
    const store = new JsonStore('t', f);
    const log: string[] = [];
    store.onLog = (m) => log.push(m);
    await store.set('k', 1);
    // Another tab deletes or upgrades the database: the connection closes itself and is dropped.
    f.dbs[0]!.onversionchange?.();
    expect(f.dbs[0]!.closed).toBe(true);
    expect(await store.get('k')).toBe(1);
    expect(f.dbs).toHaveLength(2);
    // The browser closes the connection without telling us first: the next transaction throws
    // InvalidStateError and the store reopens once.
    f.dbs[1]!.closed = true;
    expect(await store.get('k')).toBe(1);
    expect(f.dbs).toHaveLength(3);
    expect(log.filter((m) => /version change|reopening/.test(m))).toHaveLength(2);
  });

  it('rejects when IndexedDB is unavailable', async () => {
    const store = new JsonStore('t');
    await expect(store.get('x')).rejects.toThrow(/not available/);
  });
});
