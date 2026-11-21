import { describe, expect, it } from 'vitest';
import {
  APP_VERSION,
  estimateOffset,
  type LiveDeltaMsg,
  type LiveStateMsg,
  parseClientMessage,
} from './index.ts';

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

describe('the running service by reference (live-by-ref)', () => {
  const hello = (extra: Record<string, unknown>) =>
    parseClientMessage(
      JSON.stringify({ t: 'hello', v: 1, role: 'output', appVersion: APP_VERSION, ...extra }),
    );
  const resync = (extra: Record<string, unknown>) =>
    parseClientMessage(JSON.stringify({ t: 'live.resync', v: 1, ...extra }));
  const id = 'a'.repeat(64);
  const held = (m: unknown) => (m as { resolvedId?: unknown }).resolvedId;

  it('a hello and a live.resync carry the id of the copy the client holds', () => {
    const h = hello({ resolvedId: id });
    expect('error' in h).toBe(false);
    expect(h).toMatchObject({ t: 'hello', resolvedId: id });
    const r = resync({ resolvedId: id });
    expect('error' in r).toBe(false);
    expect(r).toMatchObject({ t: 'live.resync', resolvedId: id });
  });
  it('a hello and a resync without it parse as before', () => {
    expect(held(hello({}))).toBeUndefined();
    expect(held(resync({}))).toBeUndefined();
  });
  it('is lenient on purpose: a string of any shape parses as it is, a value that is not a string as absent', () => {
    // A hello that fails its parse is answered with bye 'version' (a window reload): a malformed id must only
    // mean "I hold something else", so it never makes the message fail.
    expect(hello({ resolvedId: 'x'.repeat(500) })).toMatchObject({ resolvedId: 'x'.repeat(500) });
    expect(hello({ resolvedId: 'not hex at all' })).toMatchObject({ resolvedId: 'not hex at all' });
    for (const bad of [5, { a: 1 }, ['x'], null, true]) {
      const h = hello({ resolvedId: bad });
      expect('error' in h).toBe(false);
      expect(held(h)).toBeUndefined();
      const r = resync({ resolvedId: bad });
      expect('error' in r).toBe(false);
      expect(held(r)).toBeUndefined();
    }
  });
  it('a live.state and a live.delta message may carry the id (a compile-time check)', () => {
    const state = { seq: 1 } as unknown as LiveStateMsg['state'];
    const a: LiveStateMsg = { t: 'live.state', v: 1, seq: 1, state };
    const b: LiveStateMsg = { t: 'live.state', v: 1, seq: 1, state, resolvedId: id };
    const event = { k: 'endService', at: 1 } as unknown as LiveDeltaMsg['event'];
    const c: LiveDeltaMsg = { t: 'live.delta', v: 1, seq: 2, fromSeq: 1, event };
    const d: LiveDeltaMsg = { t: 'live.delta', v: 1, seq: 2, fromSeq: 1, event, resolvedId: id };
    expect([a, b, c, d].length).toBe(4);
    expect(b.resolvedId).toBe(id);
    expect(d.resolvedId).toBe(id);
  });
});
