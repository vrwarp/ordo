import { describe, expect, it } from 'vitest';
import { FrameClock, crossfadeWeight, flipDue, isLateFlip, msToNextSecond, smoothstep } from './timing.ts';

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
  it('counts missed vsyncs from rAF gaps and tracks the period', () => {
    const c = new FrameClock(8);
    let t = 0;
    for (let i = 0; i < 10; i++) c.tick((t += 16.667));
    expect(c.missed).toBe(0);
    c.tick((t += 50)); // two frames missed
    expect(c.missed).toBe(2);
    c.tick((t += 5000)); // a pause (hidden window) is not counted
    expect(c.missed).toBe(2);
    expect(c.presented).toBe(12);
    expect(c.frameMs).toBeCloseTo(16.667, 1);
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
});
