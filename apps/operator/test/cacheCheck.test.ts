import type { OutputHealthEntry } from '@ordo/protocol';
import { describe, expect, it } from 'vitest';
import { CacheCheckTracker, cacheIntegrity, cacheIntegrityMessage, cacheSettled } from '../src/lib/health.ts';

function entry(id: string, ready: number, total: number, connected = true): OutputHealthEntry {
  return {
    outputId: id,
    connected,
    lastSeen: Date.now(),
    presented: 1,
    missed: 0,
    longTasks: 0,
    lateFlips: 0,
    cache: { ready, total },
    gpuLost: 0,
    videoDropped: 0,
  };
}

const outputs = [
  { id: 'a', name: 'Audience 1' },
  { id: 'l', name: 'Lobby' },
];

describe('cache integrity at Launch outputs (prd/08)', () => {
  it('reports missing files per window and windows that do not report', () => {
    const rows = cacheIntegrity(outputs, { a: entry('a', 41, 44) });
    expect(rows).toEqual([
      { outputId: 'a', name: 'Audience 1', ready: 41, total: 44, missing: 3, unknown: false },
      { outputId: 'l', name: 'Lobby', ready: 0, total: 0, missing: 0, unknown: true },
    ]);
    expect(cacheSettled(rows)).toBe(false);
    expect(cacheIntegrityMessage(rows)).toBe(
      'Service cache: 3 missing on Audience 1 (41/44), Lobby not reporting',
    );
  });

  it('is silent when every window holds the whole manifest', () => {
    const rows = cacheIntegrity(outputs, { a: entry('a', 44, 44), l: entry('l', 2, 2) });
    expect(cacheSettled(rows)).toBe(true);
    expect(cacheIntegrityMessage(rows)).toBeNull();
  });

  it('treats a disconnected window as not reporting', () => {
    const rows = cacheIntegrity([outputs[0]!], { a: entry('a', 44, 44, false) });
    expect(rows[0]!.unknown).toBe(true);
  });
});

describe('cache check tracker', () => {
  const opts = { settleMs: 5000, unknownMs: 15_000, timeoutMs: 60_000 };

  it('ends as soon as every window is complete', () => {
    const t = new CacheCheckTracker(0, opts);
    expect(t.update(cacheIntegrity(outputs, { a: entry('a', 1, 4) }), 100)).toBe(false);
    expect(t.update(cacheIntegrity(outputs, { a: entry('a', 4, 4), l: entry('l', 1, 1) }), 200)).toBe(true);
  });

  it('keeps waiting while a fill moves and ends once it stalls', () => {
    const t = new CacheCheckTracker(0, opts);
    const only = [outputs[0]!];
    expect(t.update(cacheIntegrity(only, { a: entry('a', 1, 10) }), 1000)).toBe(false);
    expect(t.update(cacheIntegrity(only, { a: entry('a', 2, 10) }), 4000)).toBe(false);
    expect(t.update(cacheIntegrity(only, { a: entry('a', 2, 10) }), 8000)).toBe(false);
    // 5 s without progress: report what is missing.
    expect(t.update(cacheIntegrity(only, { a: entry('a', 2, 10) }), 9000)).toBe(true);
  });

  it('gives a window that has not reported longer, then reports it', () => {
    const t = new CacheCheckTracker(0, opts);
    const only = [outputs[1]!];
    expect(t.update(cacheIntegrity(only, {}), 1000)).toBe(false);
    expect(t.update(cacheIntegrity(only, {}), 14_000)).toBe(false);
    expect(t.update(cacheIntegrity(only, {}), 16_500)).toBe(true);
  });

  it('ends at the timeout whatever the state', () => {
    const t = new CacheCheckTracker(0, opts);
    let n = 0;
    const moving = () => cacheIntegrity([outputs[0]!], { a: entry('a', n++, 1000) });
    expect(t.update(moving(), 59_000)).toBe(false);
    expect(t.update(moving(), 60_000)).toBe(true);
  });
});
