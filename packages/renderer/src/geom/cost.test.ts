import { describe, expect, it } from 'vitest';
import { drawWeight, GEOM_COST, geomCost, unitCost } from './cost.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE } from './ops.ts';
import { clearGeomFiles, putGeomFile, storedCost, storedGeometry } from './stored.ts';

/** A path string zigzagging across a 2000 x 2000 space (`turns` times round its centre, radius 1000 ↔ 50). */
function zigzag(points: number, turns = 37): string {
  let d = 'M 1000 1000';
  for (let k = 1; k < points; k++) {
    const a = (k / points) * Math.PI * 2 * turns;
    const r = k % 2 ? 1000 : 50;
    d += ` L ${(1000 + r * Math.cos(a)).toFixed(1)} ${(1000 + r * Math.sin(a)).toFixed(1)}`;
  }
  return `${d} Z`;
}

/** A circle of `points` points in a 2000 x 2000 space. */
function circle(points: number): string {
  let d = 'M 2000 1000';
  for (let k = 1; k < points; k++) {
    const a = (k / points) * Math.PI * 2;
    d += ` L ${(1000 + 1000 * Math.cos(a)).toFixed(2)} ${(1000 + 1000 * Math.sin(a)).toFixed(2)}`;
  }
  return `${d} Z`;
}

describe('drawing estimate (design/27 §12 drawing cost)', () => {
  it('counts the longer axis of every edge with dy ≠ 0, times the edges active at once', () => {
    // A 100 x 50 rect: its two vertical edges (50 each, active together), the horizontal ones skipped.
    const rect = unitCost(
      [CMD_MOVE, CMD_LINE, CMD_LINE, CMD_LINE, CMD_CLOSE],
      [0, 0, 100, 0, 100, 50, 0, 50],
    );
    expect(rect.length).toBe(100);
    expect(rect.peak).toBe(2);
    expect(rect.est).toBeCloseTo(100 * (1 + 2 / GEOM_COST.peakScale));
    // An open sub-path is closed for the count (a fill closes it); a curve counts its control polygon.
    const open = unitCost([CMD_MOVE, CMD_CUBIC], [0, 0, 10, 40, 30, 40, 40, 0]);
    expect(open.length).toBe(40 + 40); // (10,40)→(30,40) and the close run along a row
    // Scaled to logical px.
    expect(
      unitCost([CMD_MOVE, CMD_LINE, CMD_LINE, CMD_LINE, CMD_CLOSE], [0, 0, 100, 0, 100, 50, 0, 50], 2, 2).est,
    ).toBeCloseTo(2 * rect.est);
  });

  it('is 0 for nothing drawable and never throws on garbage', () => {
    expect(unitCost([], []).est).toBe(0);
    expect(unitCost([CMD_MOVE, CMD_LINE], [0, 0, 100, 0]).est).toBe(0); // flat: no row crossed
    // A coordinate that is not a number (the clamp makes it 0 first) is no estimate: over the bound.
    expect(unitCost([CMD_MOVE, CMD_LINE], [0, 0, Number.NaN, 5]).est).toBe(Number.POSITIVE_INFINITY);
    expect(unitCost([CMD_MOVE, CMD_LINE, CMD_LINE], [0, 0], Number.POSITIVE_INFINITY, 1).est).toBe(0);
    expect(unitCost([CMD_LINE, CMD_LINE, 99, CMD_CLOSE], [1, 2, 3, 4, 5, 6]).est).toBeGreaterThanOrEqual(0);
    // Huge coordinates (the clamp keeps them within ±1e9) make a huge estimate: over the bound, not drawn.
    expect(unitCost([CMD_MOVE, CMD_LINE], [0, -1e9, 1e9, 1e9]).est).toBeGreaterThan(GEOM_COST.geometry);
  });

  it('rates a zigzag across its box far above a traced outline of as many points', () => {
    const zig = storedGeometry({ paths: [{ d: zigzag(4_000), w: 2000, h: 2000 }] }, 1920, 1080);
    // The review's hostile custGeom (1.5 s at 1920, 4.6 s at 3840 in Chromium): drawn as its legacy shape.
    expect(zig).toBeUndefined();
    const round = storedGeometry({ paths: [{ d: circle(4_000), w: 2000, h: 2000 }] }, 1920, 1080)!;
    const c = storedCost(round)!;
    expect(c.points).toBe(4_001);
    expect(c.est).toBeLessThan(GEOM_COST.geometry / 50);
    // The bound sits between them: 380 zigzag points (about 40 ms at 4K) are drawn, 600 are not.
    expect(storedGeometry({ paths: [{ d: zigzag(380), w: 2000, h: 2000 }] }, 1920, 1080)).toBeDefined();
    expect(storedGeometry({ paths: [{ d: zigzag(600), w: 2000, h: 2000 }] }, 1920, 1080)).toBeUndefined();
  });

  it('counts a cont chain as the one path it draws, and a geometry file as its paths', () => {
    const d = zigzag(380);
    const cut = d.indexOf(' L', d.length / 2);
    const one = storedGeometry({ paths: [{ d, w: 2000, h: 2000 }] }, 1920, 1080)!;
    const chain = storedGeometry(
      {
        paths: [
          { d: d.slice(0, cut), w: 2000, h: 2000 },
          { d: `M ${d.slice(cut + 3)}`.replace('M  ', 'M '), w: 2000, h: 2000, cont: true },
        ],
      },
      1920,
      1080,
    );
    expect(chain).toBeDefined();
    expect(storedCost(chain)!.est).toBeGreaterThan(0.9 * storedCost(one)!.est);
    clearGeomFiles();
    expect(putGeomFile('zig', { paths: [{ d: zigzag(4_000), w: 2000, h: 2000 }] })).toBe(true);
    expect(storedGeometry({ ref: 'zig' }, 1920, 1080)).toBeUndefined();
    clearGeomFiles();
  });

  it('weighs an outline and each effect by the passes that draw it', () => {
    expect(drawWeight({})).toBe(1);
    expect(drawWeight({ stroked: true })).toBe(3);
    expect(drawWeight({ stroked: true, shadow: true, glow: true, softEdge: true })).toBe(10);
    expect(geomCost([])).toBe(0);
  });

  it('estimates a 32k-point chain quickly (the estimate itself is bounded)', () => {
    const paths = Array.from({ length: 8 }, (_, i) => ({
      d: zigzag(4_090, 37 + i),
      w: 2000,
      h: 2000,
      ...(i ? { cont: true } : {}),
    }));
    const t0 = performance.now();
    expect(storedGeometry({ paths }, 1920, 1080)).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
