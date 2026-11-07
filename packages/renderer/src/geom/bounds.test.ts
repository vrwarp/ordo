import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CANVAS_H,
  CANVAS_W,
  canvasArea,
  drawnBounds,
  geomBounds,
  miterFactor,
  outlineReach,
  placedBounds,
} from './bounds.ts';
import { arrowFor, arrowReach } from './ends.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE } from './ops.ts';
import { type Outline, outlineOf } from './outline.ts';
import { type BuiltGeom, type GeomPath, presetGeometry } from './path.ts';

const built = (w: number, h: number, paths: GeomPath[]): BuiltGeom => ({
  w,
  h,
  paths,
  text: { l: 0, t: 0, r: w, b: h },
  sites: [],
});

/** A closed polygon through `pts` (x y pairs). */
const polygon = (pts: number[], stroke = true): GeomPath => ({
  cmds: [CMD_MOVE, ...Array.from({ length: pts.length / 2 - 1 }, () => CMD_LINE), CMD_CLOSE],
  pts,
  fill: 'norm',
  stroke,
});

const miter = (width: number, extra: Partial<Outline> = {}): Outline => ({
  width,
  join: 'miter',
  cap: 'butt',
  miterLimit: 8,
  ...extra,
});

describe('what a shape draws (geom/bounds.ts, design/27 §12 drawing cost)', () => {
  it("takes a custom geometry's points past its box: a 10 px box whose path covers the slide", () => {
    const g = built(10, 10, [polygon([-960, -540, 970, -540, 970, 550, -960, 550])]);
    expect(geomBounds(g)).toEqual({ x0: -960, y0: -540, x1: 970, y1: 550 });
    // Points inside the box keep the box.
    expect(geomBounds(built(10, 10, [polygon([2, 2, 8, 2, 8, 8])]))).toEqual({
      x0: 0,
      y0: 0,
      x1: 10,
      y1: 10,
    });
  });

  it('reaches as far as the sharpest miter Canvas draws, a beveled one half a width', () => {
    // A rect's right angles: the miter tip lies √2 half widths from each corner.
    expect(miterFactor(built(10, 10, [polygon([0, 0, 10, 0, 10, 10, 0, 10])]), 8)).toBeCloseTo(Math.SQRT2, 9);
    // A 20° apex: 1 / sin(10°) ≈ 5.76, within the limit of 8.
    const apex = (deg: number) => {
      const t = Math.tan(((deg / 2) * Math.PI) / 180);
      return built(100, 100, [polygon([0, 0, 100, -100 * t, 100, 100 * t])]);
    };
    expect(miterFactor(apex(20), 8)).toBeCloseTo(1 / Math.sin((10 * Math.PI) / 180), 6);
    // A 5° spike passes the limit (22.9): beveled; its base corners (87.5°) are the sharpest drawn.
    expect(miterFactor(apex(5), 8)).toBeCloseTo(1 / Math.sin((43.75 * Math.PI) / 180), 6);
    expect(miterFactor(apex(5), 30)).toBeCloseTo(1 / Math.sin((2.5 * Math.PI) / 180), 6);
    // An ellipse's curves meet smoothly: no miter past half a width.
    expect(miterFactor(presetGeometry('ellipse', 400, 200)!, 8)).toBeLessThan(1.01);
    // An open polyline turning only at its middle vertex (90°).
    const open: GeomPath = {
      cmds: [CMD_MOVE, CMD_LINE, CMD_LINE],
      pts: [0, 0, 10, 0, 10, 10],
      fill: 'none',
      stroke: true,
    };
    expect(miterFactor(built(10, 10, [open]), 8)).toBeCloseTo(Math.SQRT2, 9);
    // A closed path joins at its start too: a triangle whose sharpest corner is where it starts.
    const t = Math.tan((10 * Math.PI) / 180);
    expect(miterFactor(built(100, 100, [polygon([100, 0, 0, -100 * t, 0, 100 * t])]), 8)).toBeCloseTo(
      1 / Math.sin((10 * Math.PI) / 180),
      6,
    );
    // A path that is not stroked has no join.
    expect(miterFactor(built(100, 100, [polygon([0, 0, 100, -1, 100, 1], false)]), 8)).toBe(1);
  });

  it("joins a curve at its ends by its tangents, not its control points' turns", () => {
    // A cubic whose control polygon turns 90° and 135° inside it, but which leaves the line before it and
    // meets the one after it straight on: no miter is drawn.
    const p: GeomPath = {
      cmds: [CMD_MOVE, CMD_LINE, CMD_CUBIC, CMD_LINE],
      pts: [0, 0, 10, 0, 20, 0, 20, 10, 40, 0, 60, -10],
      fill: 'none',
      stroke: true,
    };
    expect(miterFactor(built(60, 10, [p]), 8)).toBeCloseTo(1, 9);
    // Turned 90° where the line after it starts: that join is drawn.
    const turned: GeomPath = { ...p, pts: [0, 0, 10, 0, 20, 0, 20, 10, 40, 0, 50, 20] };
    expect(miterFactor(built(60, 20, [turned]), 8)).toBeCloseTo(Math.SQRT2, 9);
  });

  it('grows the geometry by the outline as drawn: joins, caps and arrowheads', () => {
    const rect = built(10, 10, [polygon([0, 0, 10, 0, 10, 10, 0, 10])]);
    // The review's 500 px outline on a 10 px rect: 250 √2 past each corner, not 8 x 250.
    expect(outlineReach(rect, miter(500))).toBeCloseTo(250 * Math.SQRT2, 6);
    const b = drawnBounds(rect, miter(500));
    expect(b.x0).toBeCloseTo(-250 * Math.SQRT2, 6);
    expect(b.x1 - b.x0).toBeCloseTo(10 + 500 * Math.SQRT2, 6);
    expect(outlineReach(rect, miter(500, { join: 'round' }))).toBe(250);
    expect(outlineReach(rect, miter(500, { join: 'bevel', cap: 'square' }))).toBeCloseTo(250 * Math.SQRT2, 6);
    expect(outlineReach(rect, undefined)).toBe(0);
    expect(drawnBounds(rect, undefined)).toEqual(geomBounds(rect));
    // Arrowheads reach their size from the end point.
    const o = outlineOf({ stroke: { width: 4 }, ends: { tail: { type: 'triangle', w: 'lg', len: 'lg' } } })!;
    const line: GeomPath = { cmds: [CMD_MOVE, CMD_LINE], pts: [0, 5, 100, 5], fill: 'none', stroke: true };
    expect(outlineReach(built(100, 10, [line]), o)).toBe(arrowReach(arrowFor('triangle', 'lg', 'lg', 4)));
  });

  it('places box-space bounds on the slide: flipped about the centre, rotated about it', () => {
    const box = { x: 100, y: 200, w: 40, h: 20, rotation: 0 };
    expect(placedBounds({ x0: 0, y0: 0, x1: 40, y1: 20 }, { box })).toEqual({
      x0: 100,
      y0: 200,
      x1: 140,
      y1: 220,
    });
    // Past the box on the right: mirrored to the left by a horizontal flip.
    const past = { x0: 0, y0: 0, x1: 100, y1: 20 };
    expect(placedBounds(past, { box, flipH: true })).toEqual({ x0: 40, y0: 200, x1: 140, y1: 220 });
    // A quarter turn swaps the sides about the centre (120, 210).
    const q = placedBounds({ x0: 0, y0: 0, x1: 40, y1: 20 }, { box: { ...box, rotation: 90 } });
    expect(q.x0).toBeCloseTo(110, 9);
    expect(q.x1).toBeCloseTo(130, 9);
    expect(q.y0).toBeCloseTo(190, 9);
    expect(q.y1).toBeCloseTo(230, 9);
  });

  it("cuts an area to the canvas and the reach past it, never past a finite one's", () => {
    expect(canvasArea({ x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 })).toBe(CANVAS_W * CANVAS_H);
    expect(canvasArea({ x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, 10)).toBe((CANVAS_W + 20) * (CANVAS_H + 20));
    expect(canvasArea({ x0: 1900, y0: 0, x1: 2000, y1: 100 })).toBe(20 * 100);
    expect(canvasArea({ x0: 3000, y0: 0, x1: 4000, y1: 100 })).toBe(0);
    fc.assert(
      fc.property(fc.double(), fc.double(), fc.double(), fc.double(), fc.double(), (a, b, c, d, r) => {
        const v = canvasArea({ x0: a, y0: b, x1: c, y1: d }, r);
        return Number.isFinite(v) && v >= 0;
      }),
    );
  });
});
