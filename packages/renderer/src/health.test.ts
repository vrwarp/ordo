import { describe, expect, it } from 'vitest';
import { DroppedFrames, EMPTY_TELEMETRY, armStatus, buildHealth } from './health.ts';

describe('arm status', () => {
  it('is ok when every required key is held; empty keys are ignored', () => {
    expect(armStatus(['a', '', 'b'], new Set(['a', 'b']), new Map()).ok).toBe(true);
  });

  it('reports pending keys and the first error', () => {
    const s = armStatus(['a', 'b', 'c'], new Set(['a']), new Map([['c', 'file missing']]));
    expect(s.ok).toBe(false);
    expect(s.pending).toEqual(['b', 'c']);
    expect(s.error).toBe('file missing');
  });
});

describe('health aggregation', () => {
  it('sums long tasks of both threads and merges errors', () => {
    const h = buildHealth({
      render: { ...EMPTY_TELEMETRY, presented: 600, missed: 2, longTasks: 1, lateFlips: 1, fps: 59.94, error: 'WebGPU unavailable' },
      mainLongTasks: 3,
      live: 4,
      armed: 5,
      arm: { ok: false, pending: ['x'], error: 'decode failed' },
      cache: { ready: 3, total: 7 },
      videoDropped: 12,
      audio: 'ok',
      meters: [0.12345, 0],
      mediaPositionMs: 1234.6,
      mediaDurationMs: 60000,
      errors: ['decode failed', 'audio blocked'],
      appVersion: '0.1.0',
    });
    expect(h).toMatchObject({
      presented: 600,
      missed: 2,
      longTasks: 4,
      lateFlips: 1,
      live: 4,
      armed: 5,
      armedOk: false,
      armError: 'decode failed',
      cache: { ready: 3, total: 7 },
      videoDropped: 12,
      fps: 59.9,
      audio: 'ok',
      meters: [0.123, 0],
      mediaPositionMs: 1235,
    });
    expect(h.error).toBe('WebGPU unavailable; decode failed; audio blocked');
  });

  it('omits armedOk when nothing is armed', () => {
    const h = buildHealth({
      render: EMPTY_TELEMETRY,
      mainLongTasks: 0,
      arm: { ok: true, pending: [] },
      cache: { ready: 0, total: 0 },
      videoDropped: 0,
      errors: [],
    });
    expect(h.armedOk).toBeUndefined();
    expect(h.error).toBeUndefined();
  });
});

describe('dropped video frames', () => {
  it('carries counts across source changes of a reused element', () => {
    const d = new DroppedFrames();
    d.sample('v0', '1', 3);
    d.sample('v0', '1', 5);
    d.sample('v1', '1', 1);
    expect(d.total).toBe(6);
    d.sample('v0', '2', 0); // new file: the element's counter restarts
    expect(d.total).toBe(6);
    d.sample('v0', '2', 2);
    expect(d.total).toBe(8);
  });
});
