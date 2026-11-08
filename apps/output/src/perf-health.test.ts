import { describe, expect, it } from 'vitest';
import { PerfHealth, RASTER_WINDOW, perfDiagnostics } from './perf-health.ts';

describe('performance health in the link (design/27 §13, M7)', () => {
  it('takes slide raster times only, the draw time first', () => {
    const p = new PerfHealth();
    p.done({ key: 'sl|m|sig|0|s1|', ms: 40, rasterMs: 6 });
    p.done({ key: 'sl|m|sig|1|s2|', ms: 9 }); // a worker that does not report the draw time
    p.done({ key: 'lt|sig|text', ms: 500, rasterMs: 400 });
    p.done({ key: 'props|1', ms: 300, rasterMs: 300 });
    expect(p.raster.summary()).toEqual({ n: 2, p50: 6, p95: 9, max: 9 });
    for (let i = 0; i < RASTER_WINDOW + 5; i++) p.done({ key: `sl|${i}`, ms: 1, rasterMs: 1 });
    expect(p.raster.summary()).toEqual({ n: RASTER_WINDOW, p50: 1, p95: 1, max: 1 });
  });

  it('leaves slides heavy by their content out of the alarm window and counts them (M6 merge review)', () => {
    const p = new PerfHealth();
    for (let i = 0; i < 10; i++) p.done({ key: `sl|a${i}`, ms: 50, rasterMs: 5 });
    for (let i = 0; i < 6; i++) p.done({ key: `sl|h${i}`, ms: 60, rasterMs: 45, heavy: true });
    p.done({ key: 'props|1', ms: 300, rasterMs: 300, heavy: true });
    expect(p.raster.summary()).toMatchObject({ n: 16, p95: 45 });
    expect(p.rasterAlarm.summary()).toEqual({ n: 10, p50: 5, p95: 5, max: 5 });
    expect(p.rasterHeavy).toBe(6);
    // The heavy count follows the raster window: heavy slides pushed out of it no longer count.
    for (let i = 0; i < RASTER_WINDOW - 3; i++) p.done({ key: `sl|b${i}`, ms: 1, rasterMs: 1 });
    expect(p.rasterHeavy).toBe(3);
    for (let i = 0; i < 3; i++) p.done({ key: `sl|c${i}`, ms: 1, rasterMs: 1 });
    expect(p.rasterHeavy).toBe(0);
    expect(
      perfDiagnostics({
        rasterMs: { n: 64, p50: 4, p95: 46, max: 48 },
        rasterHeavy: 12,
        budgets: { rasterP95Ms: 30, uploadMs: 4, gpuMB: 400 },
      }).raster,
    ).toBe(
      'slides p50 4 ms, p95 46 ms, max 48 ms over 64 (budget p95 30 ms); 12 past the budget by their content (drawing estimate), left out of the alarm',
    );
  });

  it('keeps uncovered characters per slide for the service and logs each once', () => {
    const p = new PerfHealth();
    const line = p.done({ key: 'sl|a', ms: 1, uncovered: '中☧' });
    expect(line).toMatch(
      /no font on this output has 2 character\(s\) of sl\|a: 中☧ \(U\+4E2D U\+2627; Hani, Zyyy\)/,
    );
    expect(p.done({ key: 'sl|b', ms: 1, uncovered: '☧' })).toBeUndefined(); // logged already
    expect(p.done({ key: 'sl|c', ms: 1, uncovered: 'ก☧' })).toMatch(/1 character\(s\) of sl\|c: ก/);
    expect(p.fontCoverage()).toEqual({ chars: 'ก☧中', count: 3, scripts: ['Hani', 'Thai', 'Zyyy'] });
    // Drawn again with every character covered: that slide no longer counts.
    p.done({ key: 'sl|c', ms: 1 });
    expect(p.fontCoverage()).toEqual({ chars: '☧中', count: 2, scripts: ['Hani', 'Zyyy'] });
    p.newService();
    expect(p.fontCoverage()).toBeUndefined();
    expect(p.done({ key: 'sl|a', ms: 1, uncovered: '中' })).toMatch(/中/); // logged again in a new service
  });

  it('hands back the slides to draw again when faces become available', () => {
    const p = new PerfHealth();
    p.done({ key: 'sl|a', ms: 1, uncovered: '中' });
    p.done({ key: 'sl|b', ms: 1 });
    expect(p.fontsReady()).toEqual(['sl|a']);
    expect(p.fontCoverage()).toBeUndefined();
    expect(p.fontsReady()).toEqual([]);
  });

  it('logs an alarm when it starts and when it ends', () => {
    const p = new PerfHealth();
    const h = { uploadMs: 5.5, budgets: { rasterP95Ms: 30, uploadMs: 4, gpuMB: 400 }, alarms: ['upload'] };
    expect(p.alarmChanges(h, '3840x2160')).toEqual([
      'performance alarm at 3840x2160: texture upload in strips 5.5 ms per frame (last minute) is over the 4 ms budget',
    ]);
    expect(p.alarmChanges(h, '3840x2160')).toEqual([]);
    expect(p.alarmChanges({ ...h, alarms: undefined }, '3840x2160')).toEqual([
      'performance alarm over: upload',
    ]);
    expect(p.alarmChanges({ alarms: ['newer'] }, '1920x1080')).toEqual([
      'performance alarm at 1920x1080: newer',
    ]);
  });

  it('writes diagnostics lines', () => {
    expect(
      perfDiagnostics({
        rasterMs: { n: 30, p50: 4, p95: 9.5, max: 12 },
        uploadMs: 1.2,
        wholeUploads: { count: 2, maxMs: 3.1 },
        budgets: { rasterP95Ms: 10, uploadMs: 4, gpuMB: 100 },
        fontCoverage: { chars: '中', count: 1, scripts: ['Hani'] },
      }),
    ).toEqual({
      raster: 'slides p50 4 ms, p95 9.5 ms, max 12 ms over 30 (budget p95 10 ms)',
      upload:
        '1.2 ms per frame at most in strips, last minute (budget 4 ms); whole by design 2x, up to 3.1 ms',
      gpuBudget: '100 MB',
      alarms: 'none',
      glyphs: '1 without a font: 中 (Hani)',
    });
    expect(perfDiagnostics({})).toEqual({
      raster: '-',
      upload: '-',
      gpuBudget: '-',
      alarms: 'none',
      glyphs: 'ok',
    });
  });
});
