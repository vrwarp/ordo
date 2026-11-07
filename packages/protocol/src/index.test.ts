import { describe, expect, it } from 'vitest';
import { estimateOffset, parseClientMessage } from './index.ts';

const health = (extra: Record<string, unknown>) =>
  parseClientMessage(
    JSON.stringify({
      t: 'health',
      v: 1,
      health: {
        presented: 1,
        missed: 0,
        longTasks: 0,
        cache: { ready: 0, total: 0 },
        ...extra,
      },
    }),
  );

describe('protocol', () => {
  it('validates client messages', () => {
    const ok = parseClientMessage(
      JSON.stringify({ t: 'live.event', v: 1, id: 'a', event: { k: 'next', at: 5 } }),
    );
    expect('error' in ok).toBe(false);
    const goLive = parseClientMessage(
      JSON.stringify({ t: 'live.event', v: 1, id: 'a', event: { k: 'goLive', playlistId: 'p' } }),
    );
    expect('error' in goLive).toBe(false);
    const bad = parseClientMessage(JSON.stringify({ t: 'live.event', v: 1, id: 'a', event: { k: 'nope' } }));
    expect('error' in bad).toBe(true);
    expect('error' in parseClientMessage('{')).toBe(true);
  });
  it('estimates clock offset from the minimum round trip', () => {
    const r = estimateOffset([
      { c: 0, s: 1010, r: 40 },
      { c: 100, s: 1105, r: 110 },
    ]);
    expect(r).toEqual({ offset: 1105 + 5 - 110, rtt: 10 });
  });
  it('carries the performance figures, budgets, alarms and font coverage of a health report (M7)', () => {
    const perf = {
      gpuMB: 412.4,
      rasterMs: { n: 40, p50: 8, p95: 14, max: 22 },
      uploadMs: 2.5,
      budgets: { rasterP95Ms: 30, uploadMs: 4, gpuMB: 400 },
      // An alarm this hub does not know yet does not fail the report.
      alarms: ['gpuMemory', 'a-newer-alarm'],
      fontCoverage: { chars: '☧中', count: 2, scripts: ['Hani', 'Zyyy'] },
    };
    const m = health(perf);
    expect('error' in m).toBe(false);
    expect('error' in m ? undefined : m.t === 'health' ? m.health : undefined).toMatchObject(perf);
    expect('error' in health({ alarms: ['x'.repeat(41)] })).toBe(true);
    expect('error' in health({ fontCoverage: { chars: 'a', count: 1, scripts: ['toolongscript'] } })).toBe(
      true,
    );
  });
});
