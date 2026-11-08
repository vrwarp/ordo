import { describe, expect, it } from 'vitest';
import { ARC_MAX_SEGMENTS, arcParamAngle, arcToCubics } from './arc.ts';

const DEG = 60000;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** The arc from (x, y): its segments (6 numbers each) and its centre as the visual-angle rule puts it. */
function arc(x: number, y: number, rx: number, ry: number, stDeg: number, swDeg: number) {
  const out: number[] = [];
  const n = arcToCubics(x, y, rx, ry, stDeg * DEG, swDeg * DEG, out);
  const t0 = rad(arcParamAngle(stDeg % 360, rx, ry));
  return { n, out, cx: x - rx * Math.cos(t0), cy: y - ry * Math.sin(t0), end: [out.at(-2)!, out.at(-1)!] };
}

/** The direction (degrees in [0, 360)) of a point seen from a centre. */
function direction(px: number, py: number, cx: number, cy: number): number {
  return ((((Math.atan2(py - cy, px - cx) * 180) / Math.PI) % 360) + 360) % 360;
}

const mod360 = (a: number): number => ((a % 360) + 360) % 360;

describe('arcParamAngle (POI convertOoxml2AwtAngle: visual angle to parametric)', () => {
  it('maps every multiple of 90 degrees to itself, whatever the radii', () => {
    for (const theta of [0, 90, 180, 270, 360, 450, -90, -180, -270, -360, 720])
      for (const [rx, ry] of [
        [300, 150],
        [1, 1000],
        [0, 50],
        [50, 0],
      ])
        expect(arcParamAngle(theta, rx!, ry!)).toBe(theta);
  });

  it('is the identity on a circle', () => {
    for (const theta of [-359, -200, -45, 1, 30, 89.5, 135, 181, 300, 539])
      expect(arcParamAngle(theta, 7, 7)).toBeCloseTo(theta, 12);
  });

  it('solves tan t = (rx/ry)·tan θ in the quadrant of θ', () => {
    for (const theta of [10, 45, 80, 100, 135, 170, 190, 225, 260, 280, 315, 350, -30, -120, 400]) {
      const t = arcParamAngle(theta, 300, 150);
      expect(Math.floor(mod360(t) / 90)).toBe(Math.floor(mod360(theta) / 90));
      expect(Math.tan(rad(t))).toBeCloseTo(2 * Math.tan(rad(theta)), 9);
    }
  });

  it('puts the point of parametric angle t in the direction θ from the centre', () => {
    for (const [rx, ry] of [
      [300, 150],
      [40, 400],
    ])
      for (const theta of [5, 60, 95, 150, 200, 250, 300, 355]) {
        const t = rad(arcParamAngle(theta, rx!, ry!));
        expect(direction(rx! * Math.cos(t), ry! * Math.sin(t), 0, 0)).toBeCloseTo(theta, 9);
      }
  });

  it('is continuous across the axes and periodic', () => {
    for (const axis of [90, 180, 270, -90])
      for (const d of [1e-9, -1e-9]) expect(arcParamAngle(axis + d, 300, 150)).toBeCloseTo(axis, 6);
    for (const theta of [17, 123, 250]) {
      expect(arcParamAngle(theta + 360, 300, 150)).toBeCloseTo(arcParamAngle(theta, 300, 150) + 360, 9);
      expect(arcParamAngle(theta - 720, 300, 150)).toBeCloseTo(arcParamAngle(theta, 300, 150) - 720, 9);
    }
  });

  it('takes the limit of a thin ellipse when a radius is 0', () => {
    // rx = 0: every direction off the vertical axis is the centre, a parametric multiple of 180 degrees.
    expect(arcParamAngle(45, 0, 100)).toBe(0);
    expect(arcParamAngle(135, 0, 100)).toBe(180);
    expect(arcParamAngle(-45, 0, 100) + 0).toBe(0);
    // ry = 0: every direction off the horizontal axis is ±90 degrees.
    expect(arcParamAngle(45, 100, 0)).toBe(90);
    expect(arcParamAngle(-45, 100, 0)).toBe(-90);
    expect(arcParamAngle(200, 100, 0)).toBe(270);
  });
});

describe('arcToCubics (POI ArcToCommandIf.execute and Arc2D segments)', () => {
  // The arc in every quadrant and both directions, on an ellipse wider than tall (300 x 150 radii).
  const starts = [0, 45, 90, 135, 180, 225, 270, 315, -45, 400];
  const sweeps = [30, 90, -90, 135, -200, 270, -359];

  it('starts at the current point and ends on the ellipse in the direction stAng + swAng', () => {
    for (const st of starts)
      for (const sw of sweeps) {
        const a = arc(500, 400, 300, 150, st, sw);
        // The centre is where the current point lies at direction stAng.
        expect(direction(500, 400, a.cx, a.cy)).toBeCloseTo(mod360(st), 9);
        const [ex, ey] = a.end;
        expect(((ex! - a.cx) / 300) ** 2 + ((ey! - a.cy) / 150) ** 2).toBeCloseTo(1, 12);
        expect(direction(ex!, ey!, a.cx, a.cy)).toBeCloseTo(mod360(st + sw), 9);
        // The first control point leaves the current point along the tangent: every segment starts where the
        // previous one ended, and the first starts at (500, 400) (its control point is on the tangent line).
        const t0 = rad(arcParamAngle(mod360(st), 300, 150));
        const tangent = [-300 * Math.sin(t0) * Math.sign(sw), 150 * Math.cos(t0) * Math.sign(sw)];
        const lead = [a.out[0]! - 500, a.out[1]! - 400];
        expect(lead[0]! * tangent[1]! - lead[1]! * tangent[0]!).toBeCloseTo(0, 6);
        expect(lead[0]! * tangent[0]! + lead[1]! * tangent[1]!).toBeGreaterThan(0);
      }
  });

  it('uses ceil(|parametric sweep| / 90) segments, each at most a quarter turn', () => {
    expect(arc(0, 0, 300, 150, 0, 90).n).toBe(1);
    expect(arc(0, 0, 300, 150, 0, -90).n).toBe(1);
    expect(arc(0, 0, 300, 150, 10, 30).n).toBe(1);
    expect(arc(0, 0, 300, 150, 0, 135).n).toBe(2);
    expect(arc(0, 0, 300, 150, 180, 270).n).toBe(3);
    expect(arc(0, 0, 300, 150, 0, 359).n).toBe(4);
    // A quarter turn between axes is one segment however flat the ellipse (POI, rounding tan 90°, splits it).
    expect(arc(0, 0, 37.5, 700, 180, 90).n).toBe(1);
  });

  it('runs clockwise for a positive sweep (y down) and anticlockwise for a negative one', () => {
    const cw = arc(300, 150, 300, 150, 0, 90);
    expect(cw.end[0]).toBeCloseTo(0, 9);
    expect(cw.end[1]).toBeCloseTo(300, 9);
    const ccw = arc(300, 150, 300, 150, 0, -90);
    expect(ccw.end[0]).toBeCloseTo(0, 9);
    expect(ccw.end[1]).toBeCloseTo(0, 9);
  });

  it('places quarter-turn control points at 4/3·tan(22.5°) of the radii (a circle within 0.03 %)', () => {
    const out: number[] = [];
    expect(arcToCubics(100, 0, 100, 100, 0, 90 * DEG, out)).toBe(1);
    const k = 0.5522847498307933;
    expect(out[0]).toBeCloseTo(100, 12);
    expect(out[1]).toBeCloseTo(100 * k, 12);
    expect(out[2]).toBeCloseTo(100 * k, 12);
    expect(out[3]).toBeCloseTo(100, 12);
    expect(out[4]).toBeCloseTo(0, 12);
    expect(out[5]).toBeCloseTo(100, 12);
    // The midpoint of the cubic is within 0.03 % of the radius from the circle.
    const bx = (100 + 3 * out[0]! + 3 * out[2]! + out[4]!) / 8;
    const by = (0 + 3 * out[1]! + 3 * out[3]! + out[5]!) / 8;
    expect(Math.abs(Math.hypot(bx, by) - 100)).toBeLessThan(0.03);
  });

  it('clamps the sweep to a full turn (MSO and LibreOffice tdf#122323), ending where it started', () => {
    for (const sw of [360, 720, 1e9, -360, -720, -1e9]) {
      const out: number[] = [];
      expect(arcToCubics(500, 400, 300, 150, 30 * DEG, sw * DEG, out)).toBe(ARC_MAX_SEGMENTS);
      expect(out.at(-2)).toBeCloseTo(500, 9);
      expect(out.at(-1)).toBeCloseTo(400, 9);
    }
  });

  it('reduces a huge start angle modulo a full turn without losing the sweep', () => {
    const a = arc(500, 400, 300, 150, 3600 * 1e6 + 45, 90);
    const b = arc(500, 400, 300, 150, 45, 90);
    expect(a.n).toBe(b.n);
    for (let i = 0; i < a.out.length; i++) expect(a.out[i]).toBeCloseTo(b.out[i]!, 6);
  });

  it('draws nothing for a zero sweep, two zero radii or a negative radius (the current point stays)', () => {
    const out: number[] = [];
    expect(arcToCubics(5, 5, 300, 150, 0, 0, out)).toBe(0);
    expect(arcToCubics(5, 5, 0, 0, 0, 90 * DEG, out)).toBe(0);
    expect(arcToCubics(5, 5, -300, 150, 0, 90 * DEG, out)).toBe(0);
    expect(arcToCubics(5, 5, 300, -150, 0, 90 * DEG, out)).toBe(0);
    expect(out).toEqual([]);
  });

  it('draws a flat ellipse (one radius 0) as its segment', () => {
    // rx = 0: a quarter turn from 0° goes straight down by ry.
    const down = arc(500, 500, 0, 150, 0, 90);
    expect(down.n).toBe(1);
    for (let i = 0; i < down.out.length; i += 2) expect(down.out[i]).toBe(500);
    expect(down.end[1]).toBeCloseTo(650, 9);
    // ry = 0: a half turn from 180° goes right by 2·rx.
    const across = arc(0, 70, 100, 0, 180, 180);
    for (let i = 1; i < across.out.length; i += 2) expect(across.out[i]).toBe(70);
    expect(across.end[0]).toBeCloseTo(200, 9);
  });

  it('keeps every number finite for non-finite and huge operands', () => {
    const cases: [number, number, number, number, number, number][] = [
      [Number.NaN, 0, 100, 100, 0, 90 * DEG],
      [0, 0, Number.NaN, 100, 0, 90 * DEG],
      [0, 0, Number.POSITIVE_INFINITY, 100, 0, 90 * DEG],
      [0, 0, 100, 100, Number.NaN, Number.POSITIVE_INFINITY],
      [0, 0, 1e60, 1e60, 1e60, -1e60],
      [1e60, -1e60, 1e-300, 1e60, 12345, 54321],
    ];
    for (const [x, y, rx, ry, st, sw] of cases) {
      const out: number[] = [];
      const n = arcToCubics(x, y, rx, ry, st, sw, out);
      expect(n).toBeLessThanOrEqual(ARC_MAX_SEGMENTS);
      expect(out.length).toBe(6 * n);
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
