import { describe, expect, it } from 'vitest';
import { MemoryStreamStore, fillStreaming, findCorrupt } from './opfs.ts';

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
});
