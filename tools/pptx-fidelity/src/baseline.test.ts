import { describe, expect, it } from 'vitest';
import { compareBaseline, ordoScore } from './baseline.ts';

describe('compareBaseline', () => {
  const perSlide = (xs: [number, number, number?][]) =>
    xs.map(([n, nativeSsim, policySsim]) => ({
      n,
      nativeSsim,
      ...(policySsim !== undefined ? { policySsim } : {}),
    }));

  it('compares native scores as ordo draws the slides, whichever way each run drew them', () => {
    const base = [{ name: 'd', nativeSsim: 0.8, ssim: 0.7 }];
    // A --lo-compat run: drawn as LibreOffice would 0.9, as ordo does 0.77.
    const run = [{ name: 'd', nativeSsim: 0.9, nativePolicySsim: 0.77, ssim: 0.7 }];
    const r = compareBaseline(run, base, 0.02, () => true);
    expect(r.failed).toEqual(['d']);
    expect(r.lines[0]).toMatch(/pptx-preview 0\.700 -> 0\.700 .* native 0\.800 -> 0\.770 \(-0\.030\)/);
    expect(compareBaseline(run, base, 0.05, () => true).failed).toEqual([]);
    expect(compareBaseline(run, base, 0.02, () => false).failed).toEqual([]);
    expect(compareBaseline([{ name: 'other', nativeSsim: 0 }], base, 0.02, () => true).lines).toEqual([]);
  });

  it('compares the slides the run scored with the same slides of the baseline', () => {
    const base = [
      {
        name: 'd',
        nativeSsim: 0.5,
        perSlide: perSlide([
          [1, 0.9],
          [2, 0.1],
          [3, 0.5, 0.4],
        ]),
      },
    ];
    const run = [{ name: 'd', nativeSsim: 0.88, perSlide: perSlide([[1, 0.88]]) }];
    const only = () => new Set([1]);
    expect(compareBaseline(run, base, 0.01, () => true, only).failed).toEqual(['d']);
    expect(compareBaseline(run, base, 0.03, () => true, only).failed).toEqual([]);
    expect(ordoScore(base[0]!, new Set([3]))).toBe(0.4);
    expect(ordoScore(base[0]!, new Set([7]))).toBeUndefined();
  });
});
