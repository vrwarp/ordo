import { describe, expect, it } from 'vitest';
import { MemoryStore, fillCache, verifyCache } from './index.ts';

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
