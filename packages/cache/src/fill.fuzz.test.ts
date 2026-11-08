/**
 * Robustness of fillCache (design/25 "Fuzzing") with a flaky fetcher and a flaky store: the fill always
 * settles, accounts for every file exactly once, never exceeds its concurrency and never stores a file it
 * reported as failed.
 */
import type { ManifestFile } from '@ordo/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type FileStore, fillCache, MemoryStore } from './index.ts';

type Plan = { fails: number; throwsOnPut: boolean; hasThrows: boolean; delay: number };

const fileArb = fc.record({
  hash: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
  bytes: fc.oneof(fc.nat({ max: 1e6 }), fc.constantFrom(Number.NaN, -1, Number.POSITIVE_INFINITY)),
  mime: fc.constant('x'),
});
const planArb = fc.record({
  fails: fc.nat({ max: 4 }),
  throwsOnPut: fc.boolean(),
  hasThrows: fc.boolean(),
  delay: fc.nat({ max: 3 }),
});

class FlakyStore extends MemoryStore {
  constructor(private plans: Map<string, Plan>) {
    super();
  }
  override async has(h: string) {
    if (this.plans.get(h)?.hasThrows) throw new Error('storage lost');
    return super.has(h);
  }
  override async put(h: string, b: Blob) {
    if (this.plans.get(h)?.throwsOnPut) throw new Error('quota');
    return super.put(h, b);
  }
}

describe('fillCache (fuzz)', () => {
  it('always settles and accounts for every unique file once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fileArb, { maxLength: 10 }),
        fc.dictionary(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'), planArb),
        fc.oneof(fc.integer({ min: -2, max: 6 }), fc.constant(Number.NaN)),
        fc.integer({ min: 0, max: 3 }),
        async (files, planObj, concurrency, retries) => {
          const plans = new Map(Object.entries(planObj));
          const store: FileStore = new FlakyStore(plans);
          const attempts = new Map<string, number>();
          let inFlight = 0;
          let peak = 0;
          const fetchFile = async (h: string) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            try {
              const n = (attempts.get(h) ?? 0) + 1;
              attempts.set(h, n);
              const p = plans.get(h);
              await new Promise((r) => setTimeout(r, p?.delay ?? 0));
              if (p && n <= p.fails) throw new Error('flaky');
              return new Blob([h]);
            } finally {
              inFlight--;
            }
          };
          const progress: number[] = [];
          const res = await fillCache(
            store,
            files as ManifestFile[],
            fetchFile,
            (p) => progress.push(p.ready + p.failed.length),
            {
              concurrency,
              retries,
              retryDelayMs: 0,
            },
          );
          const unique = new Set(files.map((f) => f.hash));
          expect(res.total).toBe(unique.size);
          expect(res.ready + res.failed.length).toBe(unique.size);
          expect(new Set(res.failed).size).toBe(res.failed.length);
          expect(Number.isFinite(res.bytesTotal)).toBe(true);
          expect(res.bytesReady).toBeLessThanOrEqual(res.bytesTotal);
          for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThan(progress[i - 1]!);
          const limit = Number.isFinite(concurrency) ? Math.max(1, concurrency) : 3;
          expect(peak).toBeLessThanOrEqual(limit);
          for (const h of unique) {
            const failed = res.failed.includes(h);
            const p = plans.get(h);
            if (!failed && !p?.hasThrows) expect(await store.has(h)).toBe(true);
            expect(attempts.get(h) ?? 0).toBeLessThanOrEqual(retries + 1);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('regressions: a throwing store.has, zero concurrency and NaN sizes', async () => {
    const plans = new Map<string, Plan>([['a', { fails: 0, throwsOnPut: false, hasThrows: true, delay: 0 }]]);
    const res = await fillCache(
      new FlakyStore(plans),
      [
        { hash: 'a', bytes: Number.NaN, mime: 'x' },
        { hash: 'b', bytes: 5, mime: 'x' },
      ],
      async (h) => new Blob([h]),
      undefined,
      { concurrency: 0, retryDelayMs: 0 },
    );
    expect(res.ready + res.failed.length).toBe(2);
    expect(res.bytesTotal).toBe(5);
  });

  it('a fetcher that resolves to something other than a Blob counts as a failure', async () => {
    const res = await fillCache(
      new MemoryStore(),
      [{ hash: 'a', bytes: 1, mime: 'x' }],
      async () => undefined as unknown as Blob,
      undefined,
      { retries: 1, retryDelayMs: 0 },
    );
    expect(res.failed).toEqual(['a']);
  });
});
