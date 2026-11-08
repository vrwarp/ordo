import { describe, expect, it } from 'vitest';
import { SharedDownloads } from '../src/lib/downloads.ts';

function pending<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
}

describe('shared downloads (operator own cache, item 11 rule)', () => {
  it('a second run of the same hash joins the download in flight', async () => {
    const d = new SharedDownloads<string>();
    const a = pending<string>();
    let starts = 0;
    const run = () =>
      d.run('h1', () => {
        starts++;
        return a.p;
      });
    const p1 = run();
    const p2 = run();
    expect(starts).toBe(1);
    expect(d.size).toBe(1);
    a.resolve('blob');
    expect(await p1).toBe('blob');
    expect(await p2).toBe('blob');
    await new Promise((r) => setTimeout(r, 0));
    expect(d.has('h1')).toBe(false);
    // Finished: the next run starts afresh.
    d.run('h1', () => {
      starts++;
      return Promise.resolve('again');
    });
    expect(starts).toBe(2);
  });

  it('retain aborts only the hashes that left; abortAll aborts the rest', async () => {
    const d = new SharedDownloads<string>();
    const signals: Record<string, AbortSignal> = {};
    const start = (h: string) =>
      d.run(h, (signal) => {
        signals[h] = signal;
        return new Promise<string>((_, rej) =>
          signal.addEventListener('abort', () => rej(new Error('aborted'))),
        );
      });
    const p1 = start('h1');
    const p2 = start('h2');
    p1.catch(() => undefined);
    p2.catch(() => undefined);
    expect(d.retain(new Set(['h1', 'h3']))).toBe(1);
    expect(signals.h2!.aborted).toBe(true);
    expect(signals.h1!.aborted).toBe(false);
    expect(d.has('h1')).toBe(true);
    expect(d.has('h2')).toBe(false);
    await expect(p2).rejects.toThrow('aborted');
    expect(d.abortAll()).toBe(1);
    expect(signals.h1!.aborted).toBe(true);
    expect(d.size).toBe(0);
  });

  it('a failed download leaves the set so a retry can start a new one', async () => {
    const d = new SharedDownloads<string>();
    await expect(d.run('h', () => Promise.reject(new Error('net')))).rejects.toThrow('net');
    expect(d.has('h')).toBe(false);
  });
});
