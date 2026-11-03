/**
 * Robustness of the audio maths (design/25 "Fuzzing"): gains, routes and meters are computed from stored
 * settings and media metadata, so NaN, infinite and out-of-range inputs must still give safe outputs
 * (finite, non-negative gains; routes inside the device; meters in 0..1).
 */
import type { AudioPair } from '@ordo/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { masterGain, meterBallistics, peakOf, planRoute, sourceGain } from './math.ts';

const wild = fc.oneof(
  fc.double(),
  fc.integer({ min: -200, max: 200 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0),
);

describe('audio maths (fuzz)', () => {
  it('gains are finite and non-negative for any input', () => {
    fc.assert(
      fc.property(
        fc.option(wild, { nil: undefined }),
        fc.option(wild, { nil: undefined }),
        wild,
        fc.boolean(),
        (g, l, m, muted) => {
          const s = sourceGain({ gainDb: g, loudnessLufs: l });
          expect(Number.isFinite(s)).toBe(true);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(10 ** (24 / 20) + 1e-9);
          const mg = masterGain(m, muted);
          expect(Number.isFinite(mg)).toBe(true);
          expect(mg).toBeGreaterThanOrEqual(0);
          if (muted) expect(mg).toBe(0);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('planRoute stays inside the device for any stored pairs', () => {
    const pair = fc.record({
      id: fc.constantFrom('a', 'b', 'c'),
      name: fc.string(),
      left: wild,
      right: wild,
    });
    fc.assert(
      fc.property(
        fc.array(pair, { maxLength: 5 }),
        fc.option(fc.constantFrom('a', 'b', 'x'), { nil: undefined }),
        fc.option(fc.constantFrom('a', 'b', 'x'), { nil: undefined }),
        fc.integer({ min: 0, max: 64 }),
        (pairs, want, def, channels) => {
          const r = planRoute(pairs as unknown as AudioPair[], want, def, channels);
          for (const c of [r.left, r.right]) {
            expect(Number.isInteger(c)).toBe(true);
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThan(Math.max(1, channels));
          }
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('meters stay within 0..1 whatever the samples and timing', () => {
    fc.assert(
      fc.property(
        fc.float32Array({ maxLength: 64 }),
        wild,
        wild,
        fc.option(wild, { nil: undefined }),
        (samples, prev, dt, rel) => {
          const p = peakOf(samples);
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
          const prevLevel = Number.isFinite(prev) ? Math.max(0, Math.min(1, Math.abs(prev))) : 0;
          const m = meterBallistics(prevLevel, p, dt, rel);
          expect(Number.isFinite(m)).toBe(true);
          expect(m).toBeGreaterThanOrEqual(0);
          expect(m).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('regressions: NaN samples, a zero or NaN release time', () => {
    expect(peakOf(new Float32Array([Number.NaN, 0.5]))).toBe(0.5);
    expect(meterBallistics(0.5, 0, 10, 0)).toBe(0);
    expect(meterBallistics(0.5, 0, Number.NaN)).toBe(0.5);
    expect(meterBallistics(0.5, Number.NaN, 10)).toBeLessThanOrEqual(0.5);
  });
});
