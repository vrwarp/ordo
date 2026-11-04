import { describe, expect, it } from 'vitest';
import { Downloads, MemoryStreamStore, fillStreaming, findCorrupt } from './opfs.ts';

const file = (hash: string, bytes: number) => ({ hash, bytes, mime: 'image/png' });
const body = (n: number) => new Blob([new Uint8Array(n)]).stream();
const noSleep = { sleep: async () => undefined };

describe('streaming service-cache fill', () => {
  it('streams bodies into the store and skips files already present', async () => {
    const store = new MemoryStreamStore();
    await store.put('a', new Blob([new Uint8Array(10)]));
    const fetched: string[] = [];
    const p = await fillStreaming(
      store,
      [file('a', 10), file('b', 20)],
      async (h) => {
        fetched.push(h);
        return body(20);
      },
      undefined,
      noSleep,
    );
    expect(fetched).toEqual(['b']);
    expect(p).toMatchObject({ ready: 2, total: 2, failed: [], repaired: [] });
    expect(await store.size('b')).toBe(20);
  });

  it('replaces a cached file whose size disagrees with the manifest (corrupt or truncated)', async () => {
    const store = new MemoryStreamStore();
    await store.put('a', new Blob([new Uint8Array(3)]));
    expect(await findCorrupt(store, [file('a', 10)])).toEqual(['a']);
    const p = await fillStreaming(store, [file('a', 10)], async () => body(10), undefined, noSleep);
    expect(p.repaired).toEqual(['a']);
    expect(await store.size('a')).toBe(10);
  });

  it('retries a short download, then keeps it rather than looping', async () => {
    const store = new MemoryStreamStore();
    let n = 0;
    const p = await fillStreaming(
      store,
      [file('a', 10)],
      async () => {
        n++;
        return body(5);
      },
      undefined,
      { retries: 2, ...noSleep },
    );
    expect(n).toBe(3);
    expect(p.ready).toBe(1);
  });

  it('reports network failures as failed, and storage failures to onStoreError', async () => {
    const store = new MemoryStreamStore();
    store.putStream = async () => {
      throw Object.assign(new Error('disk gone'), { name: 'InvalidStateError' });
    };
    const errors: unknown[] = [];
    const p = await fillStreaming(store, [file('a', 10)], async () => body(10), undefined, {
      retries: 1,
      onStoreError: (e) => errors.push(e),
      ...noSleep,
    });
    expect(p.failed).toEqual(['a']);
    expect(errors).toHaveLength(2);
    const q = await fillStreaming(
      new MemoryStreamStore(),
      [file('b', 1)],
      async () => {
        throw new TypeError('Failed to fetch');
      },
      undefined,
      { retries: 0, ...noSleep },
    );
    expect(q.failed).toEqual(['b']);
  });

  it('fails a file at once on a full disk (no retries within the fill), with the reason', async () => {
    const store = new MemoryStreamStore();
    let fetches = 0;
    store.putStream = async () => {
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    };
    const p = await fillStreaming(
      store,
      [file('a', 10)],
      async () => {
        fetches++;
        return body(10);
      },
      undefined,
      { retries: 2, ...noSleep },
    );
    expect(fetches).toBe(1);
    expect(p.failures).toEqual({ a: 'quota' });
  });

  it('reports a size kept against the manifest, and does not fetch or flag it again once accepted', async () => {
    const store = new MemoryStreamStore();
    let fetches = 0;
    const fetch5 = async () => {
      fetches++;
      return body(5);
    };
    const p = await fillStreaming(store, [file('a', 10)], fetch5, undefined, { retries: 1, ...noSleep });
    expect(p.mismatched).toEqual({ a: 5 });
    expect(fetches).toBe(2);
    const accepted = new Map(Object.entries(p.mismatched));
    expect(await findCorrupt(store, [file('a', 10)])).toEqual(['a']);
    expect(await findCorrupt(store, [file('a', 10)], accepted)).toEqual([]);
    const q = await fillStreaming(store, [file('a', 10)], fetch5, undefined, { accepted, ...noSleep });
    expect(fetches).toBe(2);
    expect(q).toMatchObject({ ready: 1, repaired: [] });
  });

  it('a manifest change cancels only downloads whose file left it; the rest continue and are joined', async () => {
    const store = new MemoryStreamStore();
    const downloads = new Downloads();
    const fetched: string[] = [];
    const gates = new Map<string, () => void>();
    // Each body delivers its bytes only when its gate opens; it errors when the fetch is aborted.
    const slow = async (h: string, signal?: AbortSignal) => {
      fetched.push(h);
      return new ReadableStream<Uint8Array>({
        start(ctl) {
          signal?.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError')));
          gates.set(h, () => {
            ctl.enqueue(new Uint8Array(10));
            ctl.close();
          });
        },
      });
    };
    const ac1 = new AbortController();
    const first = fillStreaming(store, [file('x', 10), file('y', 10)], slow, undefined, {
      signal: ac1.signal,
      downloads,
      ...noSleep,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched.sort()).toEqual(['x', 'y']);
    // The manifest changes: x stays, y leaves, z arrives.
    ac1.abort();
    expect(downloads.retain(new Set(['x', 'z']))).toBe(1);
    const second = fillStreaming(store, [file('x', 10), file('z', 10)], slow, undefined, {
      downloads,
      ...noSleep,
    });
    await new Promise((r) => setTimeout(r, 10));
    gates.get('x')!();
    gates.get('z')!();
    const p = await second;
    await first;
    expect(p).toMatchObject({ ready: 2, failed: [] });
    // x was downloaded once (joined, not restarted); y was cancelled and never stored.
    expect(fetched.filter((h) => h === 'x')).toHaveLength(1);
    expect(await store.size('x')).toBe(10);
    expect(await store.size('y')).toBeUndefined();
  });
});
