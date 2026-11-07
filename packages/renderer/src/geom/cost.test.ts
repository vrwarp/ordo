import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CostedObject,
  charged,
  drawCost,
  GEOM_COST,
  geomCost,
  objectCost,
  type Rated,
  slidePlan,
  spanArea,
  strokeCost,
  unitCost,
} from './cost.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE } from './ops.ts';
import { type Outline, outlineOf } from './outline.ts';
import type { GeomPath } from './path.ts';
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
    expect(c.est).toBeLessThan(GEOM_COST.geometry / 40);
    // The bound sits between them: 380 zigzag points (about 26 ms at 4K) are drawn, 600 are not.
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

  it('is 0 for no paths', () => {
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

// ── Outlines (M6 finish: the re-review's blocker) ─────────────────────────────────────────────────────────

/** A deterministic PRNG (xorshift), for the hostile geometries. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** A path of `n` points scattered in a disc of radius `r` round (cx, cy): tiny edges, every turn a join. */
function cloudPath(seed: number, n: number, r: number, cx = 500, cy = 500): GeomPath {
  const rand = rng(seed);
  const cmds = [CMD_MOVE];
  const pts = [cx, cy];
  for (let k = 1; k < n; k++) {
    const a = rand() * Math.PI * 2;
    const q = Math.sqrt(rand()) * r;
    cmds.push(CMD_LINE);
    pts.push(cx + q * Math.cos(a), cy + q * Math.sin(a));
  }
  return { cmds, pts, fill: 'norm', stroke: true };
}

/** `n` open sub-paths of length `len` scattered within `spread` of (500, 500), unfilled. */
function bitsPath(seed: number, n: number, len: number, spread = 20): GeomPath {
  const rand = rng(seed);
  const cmds: number[] = [];
  const pts: number[] = [];
  for (let k = 0; k < n; k++) {
    const x = 500 + (rand() - 0.5) * spread;
    const y = 500 + (rand() - 0.5) * spread;
    const a = rand() * Math.PI * 2;
    cmds.push(CMD_MOVE, CMD_LINE);
    pts.push(x, y, x + len * Math.cos(a), y + len * Math.sin(a));
  }
  return { cmds, pts, fill: 'none', stroke: true };
}

const rectPath: GeomPath = {
  cmds: [CMD_MOVE, CMD_LINE, CMD_LINE, CMD_LINE, CMD_CLOSE],
  pts: [0, 0, 100, 0, 100, 50, 0, 50],
  fill: 'norm',
  stroke: true,
};

const line = (width: number, extra: Parameters<typeof outlineOf>[0] = {}): Outline =>
  outlineOf({ stroke: { width }, ...extra })!;

describe('outline estimate (design/27 §12 drawing cost)', () => {
  it("counts a rect's offset edges and its four joins, and no caps, dashes or arrowheads when closed", () => {
    const c = strokeCost(rectPath.cmds, rectPath.pts, line(4));
    // Two vertical legs of 50, each two offset edges (the horizontal ones run along rows); four right-angle
    // miters (inner lw, outer two edges of lw/2 each).
    expect(c.length).toBeCloseTo(4 * 50 + 4 * (4 + 4), 6);
    expect(c.dashes).toBe(0);
    expect(c.markers).toBe(0);
    const ends = line(4, { ends: { head: { type: 'triangle' }, tail: { type: 'triangle' } } });
    expect(strokeCost(rectPath.cmds, rectPath.pts, ends).markers).toBe(0);
    const none: Outline = { width: 0, join: 'miter', cap: 'butt', miterLimit: 8 };
    expect(strokeCost(rectPath.cmds, rectPath.pts, none).est).toBe(0);
  });

  it('grows with the line width times the vertices: a tiny cloud stroked 400 px wide is past the budget', () => {
    const cloud = cloudPath(1, 2_400, 0.5);
    const fill = unitCost(cloud.cmds, cloud.pts).est;
    expect(fill).toBeLessThan(50_000);
    const thin = strokeCost(cloud.cmds, cloud.pts, line(1)).est;
    const wide = strokeCost(cloud.cmds, cloud.pts, line(400)).est;
    const round = strokeCost(cloud.cmds, cloud.pts, line(400, { lineJoin: 'round' })).est;
    expect(wide).toBeGreaterThan(100 * thin);
    // Chromium took 104 ms (miter) and 245 ms (round) at 3840 for this one path; the review's two shapes of
    // eight such paths, 1.5 s and 3.9 s.
    for (const est of [wide, round]) expect(est).toBeGreaterThan(GEOM_COST.slide * 10);
    expect(round).toBeLessThan(wide); // a round join's arc is shorter than a long miter's two edges
  });

  it('counts the caps of every open sub-path and an arrowhead fill at each end', () => {
    const bits = bitsPath(2, 2_000, 1);
    const flat = strokeCost(bits.cmds, bits.pts, line(200));
    const round = strokeCost(bits.cmds, bits.pts, line(200, { lineCap: 'round' }));
    expect(round.length - flat.length).toBeGreaterThan(2_000 * 2 * (Math.PI * 100 - 200) * 0.99);
    expect(round.est).toBeGreaterThan(GEOM_COST.slide * 10);
    const arrows = strokeCost(
      bits.cmds,
      bits.pts,
      line(20, { ends: { head: { type: 'triangle', w: 'lg', len: 'lg' }, tail: { type: 'oval' } } }),
    );
    expect(arrows.markers).toBe(4_000);
    expect(arrows.est).toBeGreaterThan(4_000 * GEOM_COST.marker);
    // A sub-path ending at its start draws no arrowheads (`withEnds`), but caps all the same.
    const loop = strokeCost(
      [CMD_MOVE, CMD_LINE, CMD_LINE, CMD_LINE],
      [0, 0, 10, 0, 10, 10, 0, 0],
      line(2, { ends: { head: { type: 'triangle' } } }),
    );
    expect(loop.markers).toBe(0);
  });

  it('counts the dashes of a dashed outline: a sysDot rect at 0.01 px is millions of dashes', () => {
    const full: GeomPath = { ...rectPath, pts: [0, 0, 1920, 0, 1920, 1080, 0, 1080] };
    const perimeter = 2 * (1920 + 1080);
    const dots = strokeCost(full.cmds, full.pts, line(0.5, { dash: 'sysDot' }));
    expect(dots.dashes).toBeGreaterThanOrEqual(perimeter / 1);
    expect(dots.dashes).toBeLessThanOrEqual(perimeter / 1 + 8);
    expect(dots.est).toBeGreaterThan(dots.dashes * GEOM_COST.dash);
    const hair = strokeCost(full.cmds, full.pts, line(0.01, { dash: 'sysDot' }));
    expect(hair.dashes).toBeGreaterThan(250_000);
    expect(hair.est).toBeGreaterThan(GEOM_COST.slide);
    // A curve's dashes run along its control polygon, which is at least as long.
    const arc = strokeCost(
      [CMD_MOVE, CMD_CUBIC],
      [0, 0, 0, 100, 100, 100, 100, 0],
      line(1, { dash: 'dash' }),
    );
    expect(arc.dashes).toBeGreaterThanOrEqual(Math.ceil(300 / 7));
  });

  it('is finite for anything finite and past every budget for what is not', () => {
    // `outlineOf` draws no outline for a width that is not a number; a raw one is past every budget.
    expect(outlineOf({ stroke: { width: Number.POSITIVE_INFINITY } })).toBeUndefined();
    const inf: Outline = { width: Number.POSITIVE_INFINITY, join: 'miter', cap: 'butt', miterLimit: 8 };
    expect(strokeCost([CMD_MOVE, CMD_LINE], [0, 0, 10, 10], inf).est).toBe(Number.POSITIVE_INFINITY);
    // A leg to a point that is not a number draws nothing (Canvas skips it; the clamp makes it 0 first): only
    // the stroker's pass over it is counted.
    expect(strokeCost([CMD_MOVE, CMD_LINE], [0, Number.NaN, 10, 10], line(2)).est).toBe(GEOM_COST.leg);
    expect(strokeCost([], [], line(2)).est).toBe(0);
    expect(strokeCost([CMD_LINE, 99, CMD_CLOSE], [1, 2], line(2)).est).toBeGreaterThanOrEqual(0);
  });

  it("rates a shape's effects on its silhouette: a glow strokes it as wide as the glow", () => {
    const g = { w: 1000, h: 1000, paths: [cloudPath(3, 2_000, 0.5)] };
    const plain = drawCost(g, { fill: true });
    const glow = drawCost(g, { fill: true, glow: 40 });
    const soft = drawCost(g, { fill: true, softEdge: 20 });
    expect(plain).toBeLessThan(GEOM_COST.slide / 10);
    expect(glow).toBeGreaterThan(GEOM_COST.slide);
    expect(soft).toBeGreaterThan(GEOM_COST.slide);
    // A shadow redraws the shape at a reduced resolution: at most the shape again.
    expect(drawCost(g, { fill: true, shadow: true, shadowBlur: 12 })).toBeLessThanOrEqual(2 * plain);
  });

  it('rates a slide object as it is drawn: outline fields, line shapes, masks and opacity', () => {
    const g = { w: 1000, h: 1000, paths: [cloudPath(4, 2_000, 0.5)] };
    const base: CostedObject = {
      type: 'shape',
      shape: 'rect',
      opacity: 1,
      fill: { r: 0, g: 0, b: 0, a: 1 },
      geom: { paths: [] },
    };
    const filled = objectCost(base, g);
    const stroked = objectCost({ ...base, stroke: { width: 400 } }, g);
    expect(stroked).toBeGreaterThan(1_000 * filled);
    expect(objectCost({ ...base, stroke: { width: 400 }, opacity: 0 }, g)).toBe(0);
    // A legacy shape (no M6 field) draws through the old path: not rated here.
    expect(objectCost({ type: 'shape', shape: 'rect', opacity: 1, stroke: { width: 400 } }, g)).toBe(0);
    // A mask is its filled paths as one unit (a clip).
    expect(objectCost({ type: 'image', mask: { paths: [] } }, g)).toBe(
      unitCost(g.paths[0]!.cmds, g.paths[0]!.pts).est,
    );
    expect(objectCost({ type: 'image' }, g)).toBe(0);
  });

  it("charges a slide's stored points with its estimates, and counts the legacy copies drawn", () => {
    const rated: Record<string, Rated> = {
      a: { est: GEOM_COST.slide / 2, points: 0 },
      b: { est: 0, points: Math.ceil(GEOM_COST.slide / 2 / GEOM_COST.point) + 1 },
      c: { est: 10, points: 0 },
    };
    expect(charged(rated.b!)).toBeGreaterThan(GEOM_COST.slide / 2);
    const parts = slidePlan(
      ['a', 'b', 'c'],
      (o, part) => (part ? { est: 5, points: 0 } : rated[o]!),
      () => 0,
    );
    expect(parts).toEqual([undefined, 'geom', undefined]);
  });

  it("counts what the self-check found: each path's covered area, the stroker's legs, open arrowheads' strokes", () => {
    // Eight full-box paths of four edges each: few edges, but each fills the box once (GEOM_COST.area).
    const rect = (w: number, h: number): GeomPath => ({
      cmds: [CMD_MOVE, CMD_LINE, CMD_LINE, CMD_LINE, CMD_CLOSE],
      pts: [0, 0, w, 0, w, h, 0, h],
      fill: 'norm',
      stroke: true,
    });
    const full = { w: 1920, h: 1080, paths: Array.from({ length: 8 }, () => rect(1920, 1080)) };
    const one = { ...full, paths: full.paths.slice(0, 1) };
    // Past the widest path (what one fill, and the legacy shape, paint anyway) each paints the box again.
    expect(drawCost(full, { fill: true }) - 8 * drawCost(one, { fill: true })).toBeCloseTo(
      7 * 1920 * 1080 * GEOM_COST.area,
      6,
    );
    expect(spanArea([0, 0, 1e9, 1e9])).toBe(1920 * 1080);
    // A straight line of 2,400 collinear points stroked 500 px wide: no join and no slanted edge, but the
    // stroker walks every leg (eight of them took 15 to 21 ms at 3840).
    const cmds = [CMD_MOVE, ...Array.from({ length: 2_399 }, () => CMD_LINE)];
    const pts = Array.from({ length: 2_400 }, (_, k) => [k * 0.4, 500]).flat();
    const straight = strokeCost(cmds, pts, line(500));
    expect(straight.est).toBeGreaterThanOrEqual(2_399 * GEOM_COST.leg);
    const covered = drawCost(
      { w: 1000, h: 1000, paths: [{ cmds, pts, fill: 'none', stroke: true }] },
      {
        fill: false,
        outline: line(500),
      },
    );
    expect(covered - straight.est).toBeGreaterThan(1000 * 500 * GEOM_COST.area * 0.9);
    // An open arrowhead is a stroke of its own (about 10 µs a call at 4K), a filled one a fill.
    const bits = bitsPath(9, 100, 3, 900);
    const open = strokeCost(
      bits.cmds,
      bits.pts,
      line(4, { ends: { head: { type: 'arrow' }, tail: { type: 'arrow' } } }),
    );
    const filled = strokeCost(
      bits.cmds,
      bits.pts,
      line(4, { ends: { head: { type: 'triangle' }, tail: { type: 'triangle' } } }),
    );
    expect(open.est - filled.est).toBeGreaterThan(200 * (GEOM_COST.markerStroked - GEOM_COST.marker) * 0.99);
  });

  it('property: every outline term is counted, whatever the path (fast-check)', () => {
    const cmdOf = [CMD_MOVE, CMD_LINE, CMD_LINE, CMD_LINE, CMD_CUBIC, CMD_CLOSE];
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.nat(5),
            fc.float({ min: 0, max: 1000, noNaN: true }),
            fc.float({ min: 0, max: 1000, noNaN: true }),
          ),
          {
            minLength: 2,
            maxLength: 400,
          },
        ),
        fc.float({ min: Math.fround(0.5), max: 500, noNaN: true }),
        fc.constantFrom('miter', 'round', 'bevel'),
        fc.constantFrom('flat', 'round', 'square'),
        fc.constantFrom(undefined, 'sysDot', 'dash', 'longDashDotDot'),
        fc.boolean(),
        (ops, width, join, cap, dash, arrows) => {
          const cmds: number[] = [CMD_MOVE];
          const pts: number[] = [ops[0]![1], ops[0]![2]];
          for (const [k, x, y] of ops.slice(1)) {
            const op = cmdOf[k]!;
            cmds.push(op);
            if (op === CMD_CUBIC) pts.push(x, y, y, x, (x + y) / 2, x);
            else if (op !== CMD_CLOSE) pts.push(x, y);
          }
          const o = line(width, {
            lineJoin: join as never,
            lineCap: cap as never,
            ...(dash ? { dash } : {}),
            ...(arrows ? { ends: { head: { type: 'triangle' }, tail: { type: 'stealth' } } } : {}),
          });
          const c = strokeCost(cmds, pts, o);
          expect(Number.isFinite(c.est) && c.est >= 0).toBe(true);
          // Its own terms, each at least once: a lower bound of what Canvas fills and draws.
          expect(c.est).toBeGreaterThanOrEqual(
            c.length + c.dashes * GEOM_COST.dash + c.markers * GEOM_COST.marker - 1e-6,
          );
          // Each open sub-path drawn (a leg of some length) has its two caps in the length (round: half
          // circles; square: three sides; flat: the width).
          let open = 0;
          let legs = 0;
          let sx = pts[0]!;
          let sy = pts[1]!;
          let cx = sx;
          let cy = sy;
          let at = 2;
          for (const op of cmds.slice(1)) {
            if (op === CMD_MOVE) {
              if (legs) open++;
              legs = 0;
              sx = cx = pts[at]!;
              sy = cy = pts[at + 1]!;
              at += 2;
            } else if (op === CMD_CLOSE) {
              legs = 0;
              cx = sx;
              cy = sy;
            } else
              for (let j = 0; j < (op === CMD_CUBIC ? 3 : 1); j++, at += 2) {
                if (pts[at] !== cx || pts[at + 1] !== cy) legs++;
                cx = pts[at]!;
                cy = pts[at + 1]!;
              }
          }
          if (legs) open++;
          const capLength = cap === 'round' ? (Math.PI * width) / 2 : cap === 'square' ? 2 * width : width;
          expect(c.length).toBeGreaterThanOrEqual(open * 2 * capLength * 0.999 - 1e-6);
        },
      ),
      { numRuns: 300, seed: 27 },
    );
  });
});
