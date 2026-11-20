import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import { TEXT_WARPS } from '@ordo/domain';
import { COORD_LIMIT } from './path.ts';
import {
  arcAt,
  clearWarpMemo,
  TEXT_WARP_NAMES,
  textWarpGeometry,
  WARP_MAX_POINTS,
  WARP_MEMO_MAX,
  WARP_MEMO_POINTS,
  warpAdjustNames,
  warpAreas,
  warpArcs,
  warpFollowsPath,
  warpMemoStats,
  warpMode,
} from './textwarp.ts';

/*
 * The warp geometry on hostile input (warps come from decks, which are untrusted): random names (the 40, junk,
 * '__proto__', long strings), boxes (0, negative, NaN, infinities, tiny and huge) and adjust pairs (the preset's own
 * names and junk names; NaN, infinities, 1e300 and the largest angles). Nothing throws; every number is finite and
 * within COORD_LIMIT; every arc has at most 4,096 points; the mode is one of three words; each property runs well
 * under 5 s.
 */

const name = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...TEXT_WARPS) },
  {
    weight: 1,
    arbitrary: fc.constantFrom('__proto__', 'constructor', 'toString', '', 'rect', 'textNoShape'),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 40 }) },
  { weight: 1, arbitrary: fc.string({ minLength: 200, maxLength: 400 }) },
);
const side = fc.oneof(
  fc.double({ min: 0, max: 4_000, noNaN: true }),
  fc.constantFrom(
    0,
    -5,
    -1e300,
    1e-9,
    1e12,
    1e300,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e9,
  ),
);
const value = fc.oneof(
  fc.double(),
  fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e300,
    -1e300,
    21_599_999,
    21_600_000,
    0,
    -1,
    100_000,
  ),
);
const adjName = fc.oneof(
  fc.constantFrom('adj', 'adj1', 'adj2', '__proto__', 'x'.repeat(17)),
  fc.string({ maxLength: 20 }),
);
const adjPairs = fc.array(fc.tuple(adjName, value), { maxLength: 7 });
const fraction = fc.oneof(
  fc.double({ min: -0.5, max: 1.5 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1, 1e300, -1e300),
);

const within = (run: () => void, ms: number): void => {
  const t0 = performance.now();
  run();
  expect(performance.now() - t0).toBeLessThan(budgetMs(ms));
};

describe('text warp fuzz', () => {
  it('builds geometry, modes and areas for any name, box and adjust pairs without throwing', () => {
    within(
      () =>
        fc.assert(
          fc.property(name, side, side, adjPairs, (n, w, h, adj) => {
            const g = textWarpGeometry(n, w, h, adj as [string, number][]);
            if (g === undefined) {
              expect(TEXT_WARP_NAMES).not.toContain(n);
              expect(warpFollowsPath(n)).toBe(false);
              expect(warpAdjustNames(n)).toBeUndefined();
              return;
            }
            expect(g.paths.length).toBeGreaterThan(0);
            for (const p of g.paths)
              for (const v of p.pts) {
                expect(Number.isFinite(v)).toBe(true);
                expect(Math.abs(v)).toBeLessThanOrEqual(COORD_LIMIT);
              }
            expect(['affine', 'path', 'envelope']).toContain(warpMode(g));
            const areas = warpAreas(g);
            expect(Number.isInteger(areas)).toBe(true);
            expect(areas).toBeGreaterThan(0);
            expect(areas).toBeLessThanOrEqual(g.paths.length);
          }),
          { numRuns: 400 },
        ),
      5_000,
    );
  });

  it('flattens and places along any warp within 4,096 points an arc, finite everywhere', () => {
    clearWarpMemo();
    within(
      () =>
        fc.assert(
          fc.property(
            name,
            side,
            side,
            adjPairs,
            fc.array(fraction, { maxLength: 6 }),
            (n, w, h, adj, us) => {
              const e = warpArcs(n, w, h, adj as [string, number][]);
              if (e === undefined) {
                expect(TEXT_WARP_NAMES).not.toContain(n);
                return;
              }
              expect(['affine', 'path', 'envelope']).toContain(e.mode);
              let points = 0;
              for (const a of e.arcs) {
                const count = a.xy.length / 2;
                points += count;
                expect(count).toBeLessThanOrEqual(WARP_MAX_POINTS);
                expect(a.len.length).toBe(count);
                expect(a.xy.every((v) => Number.isFinite(v) && Math.abs(v) <= COORD_LIMIT)).toBe(true);
                expect(a.len.every(Number.isFinite)).toBe(true);
                expect(a.tol).toBeGreaterThan(0);
                for (const u of us) {
                  const p = arcAt(a, u);
                  expect(Number.isFinite(p.x)).toBe(true);
                  expect(Number.isFinite(p.y)).toBe(true);
                }
              }
              expect(e.points).toBe(points);
              const s = warpMemoStats();
              expect(s.entries).toBeLessThanOrEqual(WARP_MEMO_MAX);
              expect(s.points).toBeLessThanOrEqual(WARP_MEMO_POINTS);
            },
          ),
          { numRuns: 400 },
        ),
      5_000,
    );
    clearWarpMemo();
  });

  it('keeps the memo within both bounds over many hostile calls', () => {
    clearWarpMemo();
    within(
      () =>
        fc.assert(
          fc.property(fc.constantFrom(...TEXT_WARPS), side, side, adjPairs, (n, w, h, adj) => {
            warpArcs(n, w, h, adj as [string, number][]);
            const s = warpMemoStats();
            expect(s.entries).toBeLessThanOrEqual(WARP_MEMO_MAX);
            expect(s.points).toBeLessThanOrEqual(WARP_MEMO_POINTS);
          }),
          { numRuns: 600 },
        ),
      5_000,
    );
    clearWarpMemo();
  });
});
