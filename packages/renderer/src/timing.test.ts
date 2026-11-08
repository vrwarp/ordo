import { describe, expect, it } from 'vitest';
import {
  FrameClock,
  WARMUP_GAPS,
  crossfadeWeight,
  flipDue,
  isLateFlip,
  msToNextSecond,
  propsEvalTime,
  propsTickDelay,
  smoothstep,
} from './timing.ts';

describe('crossfade weight', () => {
  it('is a clamped smoothstep', () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(2)).toBe(1);
    expect(smoothstep(0.25)).toBeCloseTo(0.15625);
  });

  it('runs from the start time over the duration; a cut is always 1', () => {
    expect(crossfadeWeight(1000, 1000, 300)).toBe(0);
    expect(crossfadeWeight(1150, 1000, 300)).toBe(0.5);
    expect(crossfadeWeight(1300, 1000, 300)).toBe(1);
    expect(crossfadeWeight(900, 1000, 0)).toBe(1);
  });
});

describe('flip scheduling', () => {
  const f = 1000 / 60;
  it('flips on the first frame whose vsync is at or after `at`', () => {
    expect(flipDue(1000 - f, 1000, f)).toBe(false);
    expect(flipDue(1000 - f / 2, 1000, f)).toBe(true);
    expect(flipDue(1000, 1000, f)).toBe(true);
  });

  it('counts late flips only when the request was early enough', () => {
    // Requested 100 ms ahead, flipped 3 frames late.
    expect(isLateFlip(1000 + 3 * f, 1000, 900, f)).toBe(true);
    // On time.
    expect(isLateFlip(1000 + f / 2, 1000, 900, f)).toBe(false);
    // A replayed state (requested after its time) is never late.
    expect(isLateFlip(5000, 1000, 4990, f)).toBe(false);
  });
});

describe('FrameClock', () => {
  /** Ticks `n` frames of `period` ms (with optional jitter) and returns the clock. */
  function run(period: number, n: number, jitter = 0, c = new FrameClock(8), t0 = 0): [FrameClock, number] {
    let t = t0;
    for (let i = 0; i < n; i++) c.tick((t += period + (i % 2 ? jitter : -jitter)));
    return [c, t];
  }

  it('counts missed vsyncs from rAF gaps and tracks the period', () => {
    const [c, t0] = run(16.667, 20);
    let t = t0;
    expect(c.missed).toBe(0);
    c.tick((t += 50)); // two frames missed
    expect(c.missed).toBe(2);
    c.tick((t += 5000)); // a pause (hidden window) is not counted
    expect(c.missed).toBe(2);
    expect(c.presented).toBe(22);
    expect(c.frameMs).toBeCloseTo(16.667, 1);
  });

  it('learns a 30 Hz display from the median of the first gaps and counts no misses (review item 12)', () => {
    const [c] = run(1000 / 30, 300, 0.4);
    expect(c.learned).toBe(true);
    expect(c.frameMs).toBeCloseTo(33.33, 1);
    expect(c.missed).toBe(0);
    expect(c.presented).toBe(300);
    // A 30 Hz flip lands on the first vsync at or after `at`, not a frame late.
    expect(flipDue(1000 - c.frameMs / 2, 1000, c.frameMs)).toBe(true);
    expect(flipDue(1000 - c.frameMs, 1000, c.frameMs)).toBe(false);
  });

  it('learns a 50 Hz display and still counts real misses after warm-up', () => {
    const [c, t0] = run(20, 100, 0.3);
    expect(c.frameMs).toBeCloseTo(20, 0);
    expect(c.missed).toBe(0);
    c.tick(t0 + 60); // two 20 ms frames missed
    expect(c.missed).toBe(2);
  });

  it('is not fooled by a stutter inside the warm-up window', () => {
    const c = new FrameClock(8);
    let t = 0;
    for (let i = 0; i < WARMUP_GAPS; i++) c.tick((t += i === 5 ? 100 : 16.667));
    expect(c.frameMs).toBeCloseTo(16.667, 1);
  });

  it('re-learns when the display rate halves for good and takes back the false misses', () => {
    const [c, t0] = run(16.667, 60);
    expect(c.frameMs).toBeCloseTo(16.667, 1);
    run(33.333, 200, 0, c, t0);
    expect(c.frameMs).toBeCloseTo(33.33, 0);
    expect(c.missed).toBe(0);
  });

  it('counts long gaps as stalls (the worker long-task measure, review item 43)', () => {
    const [c, t0] = run(16.667, 30);
    expect(c.stalls).toBe(0);
    c.tick(t0 + 120); // a 120 ms stall: 6 missed frames and one stall
    expect(c.stalls).toBe(1);
    expect(c.maxStallMs).toBeCloseTo(120, 0);
    expect(c.missed).toBe(6);
    c.tick(t0 + 120 + 3000); // a pause is neither
    expect(c.stalls).toBe(1);
  });

  it('keeps a ring of frame timestamps and an fps estimate', () => {
    const c = new FrameClock(4);
    for (let i = 1; i <= 6; i++) c.tick(i * 20);
    expect(c.frames()).toEqual([60, 80, 100, 120]);
    expect(c.fps()).toBeCloseTo(50);
  });
});

describe('second boundaries', () => {
  it('computes the wait to the next whole second minus a lead', () => {
    expect(msToNextSecond(10_250)).toBe(750);
    expect(msToNextSecond(10_250, 150)).toBe(600);
    expect(msToNextSecond(10_950, 150)).toBe(0);
  });

  it('props tick never waits 0 ms: inside the lead it targets the second after next (review item 23)', () => {
    expect(propsTickDelay(10_250, 150)).toBe(600);
    expect(propsTickDelay(10_850, 150)).toBe(1000);
    expect(propsTickDelay(10_900, 150)).toBe(950);
    expect(propsTickDelay(10_999, 150)).toBe(851);
    expect(propsTickDelay(11_000, 150)).toBe(850);
    for (let t = 10_000; t < 12_000; t += 7) expect(propsTickDelay(t, 150)).toBeGreaterThan(0);
  });

  it('props model is evaluated at the boundary inside the lead, else at now', () => {
    expect(propsEvalTime(10_250, 150)).toBe(10_250);
    expect(propsEvalTime(10_849, 150)).toBe(10_849);
    expect(propsEvalTime(10_850, 150)).toBe(11_000);
    expect(propsEvalTime(10_999, 150)).toBe(11_000);
    expect(propsEvalTime(11_000, 150)).toBe(11_000);
    // The tick wakes `lead` before the boundary and evaluates there; a sync just after agrees with it.
    const wake = 10_250 + propsTickDelay(10_250, 150);
    expect(propsEvalTime(wake, 150)).toBe(11_000);
    expect(propsEvalTime(wake + 40, 150)).toBe(11_000);
  });
});
