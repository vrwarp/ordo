import { describe, expect, it } from 'vitest';
import {
  DroppedFrames,
  EMPTY_TELEMETRY,
  RASTER_ALARM_MIN,
  TimingWindow,
  armStatus,
  buildHealth,
  perfAlarms,
  perfBudgets,
} from './health.ts';

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
      render: {
        ...EMPTY_TELEMETRY,
        presented: 600,
        missed: 2,
        longTasks: 1,
        lateFlips: 1,
        fps: 59.94,
        error: 'WebGPU unavailable',
      },
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
    expect(h).not.toHaveProperty('gpuMB');
  });

  it("carries the compositor's GPU memory (design/27 §13)", () => {
    const h = buildHealth({
      render: { ...EMPTY_TELEMETRY, compositor: 'webgpu', gpuMB: 398.2 },
      mainLongTasks: 0,
      arm: { ok: true, pending: [] },
      cache: { ready: 0, total: 0 },
      videoDropped: 0,
      errors: [],
    });
    expect(h.gpuMB).toBe(398.2);
  });
});

const quiet = {
  mainLongTasks: 0,
  arm: { ok: true, pending: [] },
  cache: { ready: 0, total: 0 },
  videoDropped: 0,
  errors: [],
};

describe('performance health (design/27 §13, M7)', () => {
  it('keeps the last timings of a window and takes nearest-rank percentiles', () => {
    const w = new TimingWindow(4);
    expect(w.summary()).toBeUndefined();
    for (const ms of [5, 1, 3]) w.add(ms);
    expect(w.summary()).toEqual({ n: 3, p50: 3, p95: 5, max: 5 });
    w.add(2);
    w.add(100); // the 5 leaves the window
    expect(w.summary()).toEqual({ n: 4, p50: 2, p95: 100, max: 100 });
    w.add(Number.NaN);
    w.add(-4);
    expect(w.summary()).toEqual({ n: 4, p50: 0, p95: 100, max: 100 });
    w.clear();
    expect(w.n).toBe(0);
  });

  it('20 values: p95 is the 19th, p50 the 10th', () => {
    const w = new TimingWindow(64);
    for (let i = 1; i <= 20; i++) w.add(i + 0.004);
    expect(w.summary()).toEqual({ n: 20, p50: 10, p95: 19, max: 20 });
  });

  it('scales the budgets with the output size', () => {
    expect(perfBudgets(1920, 1080)).toEqual({ rasterP95Ms: 10, uploadMs: 4, gpuMB: 100 });
    expect(perfBudgets(3840, 2160)).toEqual({ rasterP95Ms: 30, uploadMs: 4, gpuMB: 400 });
    expect(perfBudgets(1280, 720)).toEqual({ rasterP95Ms: 10, uploadMs: 4, gpuMB: 45 });
    // Between 1080p and 4K the raster budget follows the pixel count.
    expect(perfBudgets(2560, 1440).rasterP95Ms).toBeCloseTo(
      10 + (20 * (2560 * 1440 - 1920 * 1080)) / (3840 * 2160 - 1920 * 1080),
      1,
    );
    // What WebGPU takes at a size (12 output-sized RGBA textures) is within that size's budget.
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
    ] as const)
      expect(Math.round((12 * w * h * 4) / 1e5) / 10).toBeLessThanOrEqual(perfBudgets(w, h).gpuMB);
  });

  it('raises an alarm per budget passed; a raster alarm needs enough slides; GPU memory has none', () => {
    const b = perfBudgets(3840, 2160);
    const slow = { n: RASTER_ALARM_MIN, p50: 12, p95: 31, max: 40 };
    expect(perfAlarms(b, { raster: { ...slow, p95: 30 }, uploadMs: 4 })).toEqual([]);
    expect(perfAlarms(b, { raster: slow, uploadMs: 4.5 })).toEqual(['raster', 'upload']);
    expect(perfAlarms(b, { raster: { ...slow, n: RASTER_ALARM_MIN - 1 } })).toEqual([]);
  });

  it('reports the figures, the budgets at its size and the alarms', () => {
    const h = buildHealth({
      ...quiet,
      render: {
        ...EMPTY_TELEMETRY,
        compositor: 'webgpu',
        gpuMB: 465.1,
        uploadMs: 4.345,
        wholeUploads: { count: 2, maxMs: 9.123 },
      },
      raster: { n: 30, p50: 8, p95: 14, max: 22 },
      size: { width: 3840, height: 2160 },
      fontCoverage: { chars: '☧', count: 1, scripts: ['Zyyy'] },
    });
    expect(h.rasterMs).toEqual({ n: 30, p50: 8, p95: 14, max: 22 });
    expect(h.uploadMs).toBe(4.35);
    expect(h.wholeUploads).toEqual({ count: 2, maxMs: 9.12 });
    expect(h.budgets).toEqual({ rasterP95Ms: 30, uploadMs: 4, gpuMB: 400 });
    // gpuMB over its budget is shown, never an alarm (it is ordo's own fixed allocation).
    expect(h.alarms).toEqual(['upload']);
    expect(h.fontCoverage).toEqual({ chars: '☧', count: 1, scripts: ['Zyyy'] });
  });

  it('leaves out what was not measured (Canvas 2D: no GPU memory, no uploads)', () => {
    const h = buildHealth({
      ...quiet,
      render: { ...EMPTY_TELEMETRY, compositor: '2d' },
      size: { width: 1920, height: 1080 },
    });
    expect(h).not.toHaveProperty('rasterMs');
    expect(h).not.toHaveProperty('uploadMs');
    expect(h).not.toHaveProperty('alarms');
    expect(h).not.toHaveProperty('fontCoverage');
    expect(h.budgets).toEqual({ rasterP95Ms: 10, uploadMs: 4, gpuMB: 100 });
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
