import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEXT_WARPS } from '@ordo/domain';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import { describe, expect, it } from 'vitest';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD } from './ops.ts';
import { buildGeom, COORD_LIMIT, type GeomPath } from './path.ts';
import {
  arcAt,
  clearWarpMemo,
  flattenWarpPath,
  hasTextWarp,
  memoPut,
  TEXT_WARP_NAMES,
  textWarpGeometry,
  WARP_FLATNESS_PX,
  WARP_MAX_POINTS,
  WARP_MEMO_MAX,
  WARP_MEMO_POINTS,
  WARP_PARALLEL_EPS,
  type WarpArc,
  warpAdjustNames,
  warpAreaArcs,
  warpAreas,
  warpArcs,
  warpFollowsPath,
  warpMemoStats,
  warpMode,
} from './textwarp.ts';
import { TEXT_WARP_GEOMS } from './textwarps.gen.ts';

/*
 * The geometry half of WordArt warps (r2b sub-wave 2, warp-geom): the 40 presets of ECMA-376's
 * presetTextWarpDefinitions built at a box through `buildGeom`, the path-following set, the drawing mode decided by
 * the built geometry (not by the preset's name) and the areas. The numbers are what the repository's own compiler
 * and builder measured when this was planned (the default shapes at 360 x 240, the mode sweep over adjust values
 * and boxes), not the design's table, which this file's mode tests contradict for textSlantUp, textSlantDown, the
 * Cascade and the Fade presets.
 */

const BOXES: readonly (readonly [number, number])[] = [
  [360, 240],
  [600, 120],
  [240, 300],
];

/** The compiled path counts: 33 presets have 2 paths, the others as listed. */
const ODD_ONES: Readonly<Record<string, number>> = {
  textArchUp: 1,
  textArchDown: 1,
  textCircle: 1,
  textButton: 3,
  textDeflateInflate: 4,
  textButtonPour: 6,
  textDeflateInflateDeflate: 6,
};
const PATH_COUNT = (name: string): number => ODD_ONES[name] ?? 2;
const FOLLOW = ['textArchUp', 'textArchDown', 'textCircle', 'textButton'];
const AFFINE_DEFAULT = ['textPlain', 'textSlantUp', 'textSlantDown'];

const near = (got: readonly number[], want: readonly number[], eps = 1e-3): void => {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) expect(Math.abs(got[i]! - want[i]!), `[${i}]`).toBeLessThan(eps);
};

const line = (x0: number, y0: number, x1: number, y1: number): GeomPath => ({
  cmds: [CMD_MOVE, CMD_LINE],
  pts: [x0, y0, x1, y1],
  fill: 'norm',
  stroke: true,
});
const curve: GeomPath = {
  cmds: [CMD_MOVE, CMD_CUBIC],
  pts: [0, 0, 10, 0, 20, 10, 30, 10],
  fill: 'norm',
  stroke: true,
};
const shape = (w: number, h: number, paths: GeomPath[]): { w: number; h: number; paths: GeomPath[] } => ({
  w,
  h,
  paths,
});

describe('text warp names', () => {
  it('lists the 40 warps of the domain schema, sorted', () => {
    expect(TEXT_WARP_NAMES.length).toBe(40);
    expect([...TEXT_WARP_NAMES]).toEqual([...TEXT_WARP_NAMES].sort());
    expect(new Set(TEXT_WARP_NAMES)).toEqual(new Set(TEXT_WARPS));
    expect([...TEXT_WARP_NAMES]).toEqual([...TEXT_WARP_GEOMS.keys()].sort());
  });

  it('knows a warp by its name only: a preset shape, a missing name or a non-string is none', () => {
    for (const name of TEXT_WARPS) expect(hasTextWarp(name), name).toBe(true);
    for (const bad of [
      'textNoShape',
      'rect',
      'arc',
      '__proto__',
      'constructor',
      'toString',
      '',
      'TextPlain',
    ]) {
      expect(hasTextWarp(bad), bad).toBe(false);
      expect(textWarpGeometry(bad, 360, 240), bad).toBeUndefined();
      expect(warpAdjustNames(bad), bad).toBeUndefined();
    }
    for (const bad of [undefined, null, 0, 1, {}, [], ['textPlain'], Symbol('x'), () => 'textPlain']) {
      expect(hasTextWarp(bad)).toBe(false);
      expect(textWarpGeometry(bad as unknown as string, 360, 240)).toBeUndefined();
    }
  });
});

describe('textWarpGeometry', () => {
  it('builds every warp at three boxes through buildGeom, with the path count of the compiled table', () => {
    for (const name of TEXT_WARPS) {
      for (const [w, h] of BOXES) {
        const g = textWarpGeometry(name, w, h);
        expect(g, `${name} ${w}x${h}`).toBeDefined();
        expect(g!.paths.length, `${name} ${w}x${h}`).toBe(PATH_COUNT(name));
        expect(g!.w).toBe(w);
        expect(g!.h).toBe(h);
        // The file has no text rectangle: the text takes the whole box. No connection sites either.
        expect(g!.text, name).toEqual({ l: 0, t: 0, r: w, b: h });
        expect(g!.sites, name).toEqual([]);
        for (const p of g!.paths)
          for (const v of p.pts) {
            expect(Number.isFinite(v), `${name} ${w}x${h}`).toBe(true);
            expect(Math.abs(v)).toBeLessThanOrEqual(COORD_LIMIT);
          }
        expect(g, `${name} ${w}x${h}`).toEqual(buildGeom(TEXT_WARP_GEOMS.get(name)!, w, h));
      }
    }
  });

  it('passes the shape adjust values on to buildGeom by name', () => {
    for (const name of TEXT_WARPS) {
      const adj: [string, number][] = [[warpAdjustNames(name)![0]!, 12_345]];
      expect(textWarpGeometry(name, 360, 240, adj), name).toEqual(
        buildGeom(TEXT_WARP_GEOMS.get(name)!, 360, 240, adj),
      );
    }
  });

  it('draws textArchUp as the upper half ellipse from (l, vc) over (hc, t), and textArchDown mirrored', () => {
    const up = textWarpGeometry('textArchUp', 360, 240)!.paths[0]!;
    expect(up.cmds).toEqual([CMD_MOVE, CMD_CUBIC, CMD_CUBIC]);
    near(up.pts, [0, 120, 0, 53.726, 80.589, 0, 180, 0, 279.411, 0, 360, 53.726, 360, 120]);
    const down = textWarpGeometry('textArchDown', 360, 240)!.paths[0]!;
    expect(down.cmds).toEqual([CMD_MOVE, CMD_CUBIC, CMD_CUBIC]);
    near(down.pts, [0, 120, 0, 186.274, 80.589, 240, 180, 240, 279.411, 240, 360, 186.274, 360, 120]);
  });

  it('draws textCircle as four cubics of 13 points, starting at (l, vc)', () => {
    const c = textWarpGeometry('textCircle', 360, 240)!.paths[0]!;
    expect(c.cmds).toEqual([CMD_MOVE, CMD_CUBIC, CMD_CUBIC, CMD_CUBIC, CMD_CUBIC]);
    expect(c.pts.length).toBe(26);
    near(c.pts.slice(0, 2), [0, 120]);
    near(c.pts.slice(-2), [0, 120]);
    near(c.pts.slice(0, 14), [0, 120, 0, 53.726, 80.589, 0, 180, 0, 279.411, 0, 360, 53.726, 360, 120]);
  });

  it('draws textPlain as two full-width lines, and pins its adjust value', () => {
    const ends = (adj?: number): number[][] =>
      textWarpGeometry('textPlain', 360, 240, adj === undefined ? undefined : [['adj', adj]])!.paths.map(
        (p) => [...p.pts],
      );
    expect(ends()).toEqual([
      [0, 0, 360, 0],
      [0, 240, 360, 240],
    ]);
    expect(ends(50_000)).toEqual([
      [0, 0, 360, 0],
      [0, 240, 360, 240],
    ]);
    for (const a of [0, -5, -1e9, 10_000, 30_000, Number.NaN]) {
      expect(ends(a), String(a)).toEqual([
        [144, 0, 360, 0],
        [0, 240, 216, 240],
      ]);
    }
    for (const a of [70_000, 100_000, 200_000, 1e12]) {
      expect(ends(a), String(a)).toEqual([
        [0, 0, 216, 0],
        [144, 240, 360, 240],
      ]);
    }
  });

  it('lists the preset’s own adjust names: adj, or adj1 and adj2', () => {
    const two = new Set([
      'textArchDownPour',
      'textArchUpPour',
      'textButtonPour',
      'textCirclePour',
      'textDoubleWave1',
      'textWave1',
      'textWave2',
      'textWave4',
    ]);
    for (const name of TEXT_WARPS)
      expect(warpAdjustNames(name), name).toEqual(two.has(name) ? ['adj1', 'adj2'] : ['adj']);
  });
});

describe('warpFollowsPath', () => {
  it('is true for exactly the four presets with an odd path count', () => {
    expect(TEXT_WARPS.filter((n) => warpFollowsPath(n)).sort()).toEqual([...FOLLOW].sort());
    for (const name of TEXT_WARPS)
      expect(warpFollowsPath(name), name).toBe(TEXT_WARP_GEOMS.get(name)!.p.length % 2 === 1);
    expect(warpFollowsPath('textNoShape')).toBe(false);
    expect(warpFollowsPath('__proto__')).toBe(false);
  });
});

describe('warpMode', () => {
  it('is decided by the built geometry at the default adjust values and 360 x 240', () => {
    const modes = new Map<string, number>();
    for (const name of TEXT_WARPS) {
      const m = warpMode(textWarpGeometry(name, 360, 240)!);
      modes.set(m, (modes.get(m) ?? 0) + 1);
      const want = FOLLOW.includes(name) ? 'path' : AFFINE_DEFAULT.includes(name) ? 'affine' : 'envelope';
      expect(m, name).toBe(want);
    }
    expect([...modes].sort()).toEqual([
      ['affine', 3],
      ['envelope', 33],
      ['path', 4],
    ]);
  });

  it('rules by pairs of lines: odd count path, equal parallel lines affine, a curve or a different line envelope', () => {
    expect(WARP_PARALLEL_EPS).toBe(1e-6);
    expect(warpMode(shape(100, 100, []))).toBe('affine');
    expect(warpMode(shape(100, 100, [line(0, 0, 100, 0)]))).toBe('path');
    expect(warpMode(shape(100, 100, [line(0, 0, 100, 0), line(0, 50, 100, 50), line(0, 90, 100, 90)]))).toBe(
      'path',
    );
    expect(warpMode(shape(100, 100, [curve]))).toBe('path');
    // Two equal lines, offset: the same direction vector.
    expect(warpMode(shape(100, 100, [line(0, 0, 100, 0), line(0, 50, 100, 50)]))).toBe('affine');
    expect(warpMode(shape(100, 100, [line(0, 0, 100, 10), line(20, 90, 120, 100)]))).toBe('affine');
    // Direction vectors one unit apart, or 2e-4 apart on a box of 100 (tolerance 1e-4): an envelope.
    expect(warpMode(shape(100, 100, [line(0, 0, 100, 0), line(0, 50, 101, 50)]))).toBe('envelope');
    expect(warpMode(shape(100, 100, [line(0, 0, 100, 0), line(0, 50, 100.0002, 50)]))).toBe('envelope');
    // 5e-5 apart is inside the tolerance of 1e-6 of the larger side.
    expect(warpMode(shape(100, 100, [line(0, 0, 100, 0), line(0, 50, 100.00005, 50)]))).toBe('affine');
    // A curve in a pair, in either place.
    expect(warpMode(shape(100, 100, [curve, line(0, 50, 30, 50)]))).toBe('envelope');
    expect(warpMode(shape(100, 100, [line(0, 0, 30, 10), curve]))).toBe('envelope');
    // Several pairs: every one must be affine.
    expect(
      warpMode(
        shape(100, 100, [
          line(0, 0, 50, 0),
          line(0, 90, 50, 90),
          line(50, 0, 100, 10),
          line(50, 90, 100, 100),
        ]),
      ),
    ).toBe('affine');
    expect(
      warpMode(
        shape(100, 100, [
          line(0, 0, 50, 0),
          line(0, 90, 50, 90),
          line(50, 0, 100, 10),
          line(50, 90, 100, 50),
        ]),
      ),
    ).toBe('envelope');
  });

  // The sweep of the planning measure: every adjust value from -20,000 to 130,000 in steps of 2,500, plus angles
  // and out-of-range values; eight boxes, three of them with a zero side.
  const VALUES: number[] = [];
  for (let v = -20_000; v <= 130_000; v += 2_500) VALUES.push(v);
  const OUT_OF_RANGE = [-5, 200_000, 1e12, Number.NaN];
  const SWEEP_BOXES: [number, number][] = [
    [360, 240],
    [1000, 80],
    [50, 500],
    [1, 1],
    [0, 240],
    [360, 0],
    [1e9, 1e9],
    [0, 0],
  ];

  it('does not depend on the preset’s name for textPlain and the slants: affine at every adjust value and box', () => {
    for (const name of AFFINE_DEFAULT)
      for (const [w, h] of SWEEP_BOXES)
        for (const v of [...VALUES, ...OUT_OF_RANGE])
          expect(warpMode(textWarpGeometry(name, w, h, [['adj', v]])!), `${name} ${w}x${h} ${v}`).toBe(
            'affine',
          );
  });

  it('turns textCascadeUp and textCascadeDown affine at adj >= 100,000 and the four Fade presets at adj <= 0', () => {
    for (const name of ['textCascadeUp', 'textCascadeDown']) {
      expect(warpMode(textWarpGeometry(name, 360, 240)!), name).toBe('envelope');
      for (const v of VALUES)
        expect(warpMode(textWarpGeometry(name, 360, 240, [['adj', v]])!), `${name} ${v}`).toBe(
          v >= 100_000 ? 'affine' : 'envelope',
        );
    }
    for (const name of ['textFadeRight', 'textFadeLeft', 'textFadeUp', 'textFadeDown']) {
      expect(warpMode(textWarpGeometry(name, 360, 240)!), name).toBe('envelope');
      for (const v of VALUES)
        expect(warpMode(textWarpGeometry(name, 360, 240, [['adj', v]])!), `${name} ${v}`).toBe(
          v <= 0 ? 'affine' : 'envelope',
        );
    }
  });

  it('keeps the four path presets on the path and every other preset an envelope, in every box and adjust value', () => {
    const special = new Set([
      ...FOLLOW,
      ...AFFINE_DEFAULT,
      'textCascadeUp',
      'textCascadeDown',
      'textFadeRight',
      'textFadeLeft',
      'textFadeUp',
      'textFadeDown',
    ]);
    for (const name of TEXT_WARPS) {
      if (special.has(name) && !FOLLOW.includes(name)) continue;
      const names = warpAdjustNames(name)!;
      for (const [w, h] of SWEEP_BOXES) {
        const want = FOLLOW.includes(name) ? 'path' : 'envelope';
        expect(warpMode(textWarpGeometry(name, w, h)!), `${name} ${w}x${h}`).toBe(want);
        for (const v of [...VALUES.filter((_, i) => i % 6 === 0), ...OUT_OF_RANGE])
          for (const pairs of names.length === 1
            ? [[[names[0]!, v]] as [string, number][]]
            : ([
                [[names[0]!, v]],
                [[names[1]!, v]],
                [
                  [names[0]!, v],
                  [names[1]!, v],
                ],
              ] as [string, number][][]))
            expect(warpMode(textWarpGeometry(name, w, h, pairs)!), `${name} ${w}x${h} ${v}`).toBe(want);
      }
    }
  });

  it('builds finite geometry in a box with a zero side, whose mode is one of the three words', () => {
    for (const [w, h] of [
      [0, 240],
      [360, 0],
      [0, 0],
    ] as const)
      for (const name of TEXT_WARPS) {
        const g = textWarpGeometry(name, w, h)!;
        for (const p of g.paths)
          for (const v of p.pts) expect(Number.isFinite(v), `${name} ${w}x${h}`).toBe(true);
        expect(['affine', 'path', 'envelope']).toContain(warpMode(g));
        if (name === 'textPlain') expect(warpMode(g), `${name} ${w}x${h}`).toBe('affine');
        if (FOLLOW.includes(name)) expect(warpMode(g), `${name} ${w}x${h}`).toBe('path');
      }
  });
});

describe('warpAreas', () => {
  it('is the path count when it is odd and half of it when it is even', () => {
    for (const name of TEXT_WARPS) {
      const want =
        name === 'textButton'
          ? 3
          : name === 'textDeflateInflate'
            ? 2
            : name === 'textDeflateInflateDeflate' || name === 'textButtonPour'
              ? 3
              : 1;
      expect(warpAreas(textWarpGeometry(name, 360, 240)!), name).toBe(want);
    }
    expect(warpAreas(shape(1, 1, []))).toBe(0);
    expect(warpAreas(shape(1, 1, [curve]))).toBe(1);
    expect(warpAreas(shape(1, 1, [curve, curve]))).toBe(1);
    expect(warpAreas(shape(1, 1, [curve, curve, curve]))).toBe(3);
    expect(warpAreas(shape(1, 1, [curve, curve, curve, curve]))).toBe(2);
  });
});

// The arc-length tables: a built path flattened to a polyline with its cumulative length, so a painter can place a
// glyph at a fraction of the way along a warp's line, and the bounded memo of the arcs of a warp at a box.

/** A cubic's point at t. */
const cubicAt = (p: readonly number[], t: number): [number, number] => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p[0]! + b * p[2]! + c * p[4]! + d * p[6]!, a * p[1]! + b * p[3]! + c * p[5]! + d * p[7]!];
};
/** A polyline's length and points from sampling `n` equal steps of each cubic of a path of curves. */
const sampled = (path: GeomPath, n = 20_000): { pts: number[]; length: number } => {
  const pts: number[] = [path.pts[0]!, path.pts[1]!];
  let at = 2;
  let cx = path.pts[0]!;
  let cy = path.pts[1]!;
  for (const c of path.cmds.slice(1)) {
    if (c === CMD_CUBIC) {
      const seg = [cx, cy, ...path.pts.slice(at, at + 6)];
      for (let i = 1; i <= n; i++) pts.push(...cubicAt(seg, i / n));
      at += 6;
    } else if (c === CMD_QUAD) {
      const q = path.pts.slice(at, at + 4);
      const seg = [
        cx,
        cy,
        cx + (2 / 3) * (q[0]! - cx),
        cy + (2 / 3) * (q[1]! - cy),
        q[2]! + (2 / 3) * (q[0]! - q[2]!),
        q[3]! + (2 / 3) * (q[1]! - q[3]!),
        q[2]!,
        q[3]!,
      ];
      for (let i = 1; i <= n; i++) pts.push(...cubicAt(seg, i / n));
      at += 4;
    } else if (c === CMD_LINE) {
      pts.push(path.pts[at]!, path.pts[at + 1]!);
      at += 2;
    }
    cx = pts[pts.length - 2]!;
    cy = pts[pts.length - 1]!;
  }
  let length = 0;
  for (let i = 2; i < pts.length; i += 2)
    length += Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!);
  return { pts, length };
};
/** The distance of a point from a polyline. */
const distToPolyline = (x: number, y: number, poly: readonly number[]): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 2; i < poly.length; i += 2) {
    const ax = poly[i - 2]!;
    const ay = poly[i - 1]!;
    const dx = poly[i]! - ax;
    const dy = poly[i + 1]! - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
};
const finiteArc = (a: WarpArc): void => {
  expect(a.xy.length).toBe(2 * a.len.length);
  expect(a.xy.every(Number.isFinite)).toBe(true);
  expect(a.len.every(Number.isFinite)).toBe(true);
  expect(Number.isFinite(a.total) || a.total === Number.POSITIVE_INFINITY).toBe(true);
};

describe('flattenWarpPath', () => {
  it('reads a straight line as its two points with its length', () => {
    const a = flattenWarpPath(line(0, 0, 30, 40));
    expect([...a.xy]).toEqual([0, 0, 30, 40]);
    expect([...a.len]).toEqual([0, 50]);
    expect(a.total).toBe(50);
    expect(a.tol).toBe(WARP_FLATNESS_PX);
    expect(WARP_FLATNESS_PX).toBe(0.02);
    expect(WARP_MAX_POINTS).toBe(4096);
  });

  it('flattens textArchUp to the half ellipse’s length, every chord within the flatness of the curve', () => {
    const path = textWarpGeometry('textArchUp', 360, 240)!.paths[0]!;
    const a = flattenWarpPath(path);
    const dense = sampled(path);
    expect(Math.abs(a.total - dense.length)).toBeLessThan(0.05);
    // The polyline starts at the path's first point and ends at its last.
    near([a.xy[0]!, a.xy[1]!], [0, 120], 1e-9);
    near([a.xy[a.xy.length - 2]!, a.xy[a.xy.length - 1]!], [360, 120]);
    // Its vertices lie on the curve and every chord stays within the flatness of it.
    const n = a.xy.length / 2;
    for (let i = 0; i < n; i++)
      expect(distToPolyline(a.xy[2 * i]!, a.xy[2 * i + 1]!, dense.pts)).toBeLessThan(2e-3);
    for (let i = 1; i < n; i++)
      for (const t of [0.25, 0.5, 0.75]) {
        const x = a.xy[2 * i - 2]! + t * (a.xy[2 * i]! - a.xy[2 * i - 2]!);
        const y = a.xy[2 * i - 1]! + t * (a.xy[2 * i + 1]! - a.xy[2 * i - 1]!);
        expect(distToPolyline(x, y, dense.pts)).toBeLessThanOrEqual(WARP_FLATNESS_PX + 2e-3);
      }
    // The cumulative length never decreases, starts at 0 and ends at the total.
    expect(a.len[0]).toBe(0);
    expect(a.len[a.len.length - 1]).toBe(a.total);
    for (let i = 1; i < a.len.length; i++) expect(a.len[i]!).toBeGreaterThanOrEqual(a.len[i - 1]!);
    expect(a.tol).toBe(WARP_FLATNESS_PX);
  });

  it('flattens a quadratic as the cubic it raises to, and a closed path back to its start', () => {
    const quad: GeomPath = {
      cmds: [CMD_MOVE, CMD_QUAD],
      pts: [0, 0, 50, 100, 100, 0],
      fill: 'norm',
      stroke: true,
    };
    const a = flattenWarpPath(quad);
    expect(Math.abs(a.total - sampled(quad).length)).toBeLessThan(0.05);
    near([a.xy[a.xy.length - 2]!, a.xy[a.xy.length - 1]!], [100, 0]);
    const tri: GeomPath = {
      cmds: [CMD_MOVE, CMD_LINE, CMD_LINE, CMD_CLOSE],
      pts: [0, 0, 30, 0, 30, 40],
      fill: 'norm',
      stroke: true,
    };
    const c = flattenWarpPath(tri);
    expect([...c.xy]).toEqual([0, 0, 30, 0, 30, 40, 0, 0]);
    expect(c.total).toBeCloseTo(30 + 40 + 50, 9);
  });

  it('reads only the first sub-path of a path, and no preset has a second', () => {
    const two: GeomPath = {
      cmds: [CMD_MOVE, CMD_LINE, CMD_MOVE, CMD_LINE],
      pts: [0, 0, 10, 0, 50, 50, 90, 90],
      fill: 'norm',
      stroke: true,
    };
    expect([...flattenWarpPath(two).xy]).toEqual([0, 0, 10, 0]);
    for (const name of TEXT_WARPS)
      for (const p of textWarpGeometry(name, 360, 240)!.paths)
        expect(p.cmds.filter((c) => c === CMD_MOVE).length, name).toBe(1);
  });

  it('returns an empty arc for a path with nothing in it, and never a non-finite number', () => {
    const empty = flattenWarpPath({ cmds: [], pts: [], fill: 'norm', stroke: true });
    expect(empty.xy.length).toBe(0);
    expect(empty.total).toBe(0);
    const nan = flattenWarpPath({
      cmds: [CMD_MOVE, CMD_LINE],
      pts: [Number.NaN, 0, Number.POSITIVE_INFINITY, 5],
      fill: 'norm',
      stroke: true,
    });
    finiteArc(nan);
    for (const f of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const a = flattenWarpPath(textWarpGeometry('textArchUp', 360, 240)!.paths[0]!, f);
      expect(a.tol, String(f)).toBe(WARP_FLATNESS_PX);
    }
  });

  it('bounds every path of every warp to 4,096 points at any box, raising the tolerance rather than cutting a path short', () => {
    const counts = new Map<string, { worst: number; total: number }>();
    for (const [w, h] of [
      [360, 240],
      [1920, 1080],
      [8000, 8000],
      [1e9, 1e9],
    ] as const) {
      let worst = 0;
      let total = 0;
      for (const name of TEXT_WARPS)
        for (const p of textWarpGeometry(name, w, h)!.paths) {
          const a = flattenWarpPath(p);
          finiteArc(a);
          const n = a.xy.length / 2;
          expect(n, `${name} ${w}x${h}`).toBeLessThanOrEqual(WARP_MAX_POINTS);
          expect(a.tol, `${name} ${w}x${h}`).toBeGreaterThanOrEqual(WARP_FLATNESS_PX);
          // The polyline ends where the path ends.
          near(
            [a.xy[a.xy.length - 2]!, a.xy[a.xy.length - 1]!],
            [p.pts[p.pts.length - 2]!, p.pts[p.pts.length - 1]!],
            Math.max(1e-3, w * 1e-12),
          );
          worst = Math.max(worst, n);
          total += n;
        }
      counts.set(`${w}x${h}`, { worst, total });
    }
    // The planning measure: at most 513 points a path (textCircle) and 12,049 for all 40 at 1920 x 1080, at most
    // 1,153 at 8000 x 8000; at an ordinary 360 x 240 nothing needs a doubled tolerance.
    expect(counts.get('1920x1080')!.worst).toBeLessThanOrEqual(513);
    expect(counts.get('1920x1080')!.total).toBeLessThanOrEqual(12_049);
    expect(counts.get('8000x8000')!.worst).toBeLessThanOrEqual(1_153);
    for (const name of TEXT_WARPS)
      for (const p of textWarpGeometry(name, 360, 240)!.paths)
        expect(flattenWarpPath(p).tol).toBe(WARP_FLATNESS_PX);
    // A hostile box doubles the tolerance until the path fits.
    const hostile = flattenWarpPath(textWarpGeometry('textCircle', 1e9, 1e9)!.paths[0]!);
    expect(hostile.tol).toBeGreaterThan(WARP_FLATNESS_PX);
    expect(Number.isFinite(hostile.tol)).toBe(true);
  });

  it('keeps a path of the most curves a built path can hold within the cap, cutting no curve short', () => {
    const cmds: number[] = [CMD_MOVE];
    const pts: number[] = [0, 0];
    for (let i = 0; i < 1_300; i++) {
      cmds.push(CMD_CUBIC);
      pts.push(i + 5e8, 5e8, i - 5e8, -5e8, i + 1, 0);
    }
    const path: GeomPath = { cmds, pts, fill: 'norm', stroke: true };
    const a = flattenWarpPath(path);
    finiteArc(a);
    expect(a.xy.length / 2).toBeGreaterThanOrEqual(1_301);
    expect(a.xy.length / 2).toBeLessThanOrEqual(WARP_MAX_POINTS);
    // Past thirty doublings and sixteen steps a curve a chord is the last resort, reported as an infinite tolerance.
    expect(a.tol).toBe(Number.POSITIVE_INFINITY);
    expect([a.xy[0], a.xy[1]]).toEqual([0, 0]);
    expect([a.xy[a.xy.length - 2], a.xy[a.xy.length - 1]]).toEqual([1_300, 0]);
  });

  it('cuts every curve into sixteen equal parameter steps when thirty doublings do not fit it', () => {
    const cmds: number[] = [CMD_MOVE];
    const pts: number[] = [0, 0];
    for (let i = 0; i < 100; i++) {
      cmds.push(CMD_CUBIC);
      pts.push(i + 50, 40, i + 60, -40, i + 100, 0);
    }
    const a = flattenWarpPath({ cmds, pts, fill: 'norm', stroke: true }, 1e-300);
    expect(a.tol).toBe(Number.POSITIVE_INFINITY);
    expect(a.xy.length / 2).toBe(100 * 16 + 1);
    near([a.xy[a.xy.length - 2]!, a.xy[a.xy.length - 1]!], [199, 0]);
  });
});

describe('arcAt', () => {
  const arc = (path: GeomPath): WarpArc => flattenWarpPath(path);

  it('gives the first point at 0, the last at 1 and the point at half the length at 0.5', () => {
    const up = arc(textWarpGeometry('textArchUp', 360, 240)!.paths[0]!);
    near(Object.values(arcAt(up, 0)), [0, 120], 1e-9);
    near(Object.values(arcAt(up, 1)), [360, 120]);
    const mid = arcAt(up, 0.5);
    expect(Math.abs(mid.x - 180)).toBeLessThan(0.02);
    expect(Math.abs(mid.y - 0)).toBeLessThan(0.02);
    expect(arcAt(arc(line(0, 0, 30, 40)), 0.25)).toEqual({ x: 7.5, y: 10 });
  });

  it('takes u below 0, NaN and -Infinity as 0 and u above 1 and Infinity as 1', () => {
    const l = arc(line(0, 0, 30, 40));
    for (const u of [-0.5, -1e300, Number.NaN, Number.NEGATIVE_INFINITY])
      expect(arcAt(l, u), String(u)).toEqual({ x: 0, y: 0 });
    for (const u of [1.5, 1e300, Number.POSITIVE_INFINITY])
      expect(arcAt(l, u), String(u)).toEqual({ x: 30, y: 40 });
  });

  it('returns the point of an arc of zero length, and of an empty one the origin', () => {
    const dot = arc(line(7, 9, 7, 9));
    expect(dot.total).toBe(0);
    for (const u of [0, 0.3, 1]) expect(arcAt(dot, u)).toEqual({ x: 7, y: 9 });
    expect(arcAt(arc({ cmds: [], pts: [], fill: 'norm', stroke: true }), 0.5)).toEqual({ x: 0, y: 0 });
  });

  it('fills and returns the point it is given, without allocating one', () => {
    const l = arc(line(0, 0, 30, 40));
    const out = { x: -1, y: -1 };
    expect(arcAt(l, 0.5, out)).toBe(out);
    expect(out).toEqual({ x: 15, y: 20 });
    expect(arcAt(l, 0.5)).not.toBe(out);
  });
});

describe('warpArcs and the memo', () => {
  it('is undefined for a name that is not a warp and holds one arc per path otherwise', () => {
    clearWarpMemo();
    expect(warpArcs('rect', 360, 240)).toBeUndefined();
    expect(warpArcs('__proto__', 360, 240)).toBeUndefined();
    expect(warpMemoStats()).toEqual({ entries: 0, points: 0 });
    for (const name of TEXT_WARPS) {
      const g = textWarpGeometry(name, 360, 240)!;
      const a = warpArcs(name, 360, 240)!;
      expect(a.name).toBe(name);
      expect([a.w, a.h]).toEqual([360, 240]);
      expect(a.arcs.length).toBe(g.paths.length);
      expect(a.mode).toBe(warpMode(g));
      expect(a.areas).toBe(warpAreas(g));
      expect(a.points).toBe(a.arcs.reduce((s, x) => s + x.xy.length / 2, 0));
      for (let i = 0; i < g.paths.length; i++) expect(a.arcs[i], name).toEqual(flattenWarpPath(g.paths[i]!));
    }
  });

  it('returns the same entry for the same arguments and another for another adjust value or box', () => {
    clearWarpMemo();
    const a = warpArcs('textPlain', 360, 240)!;
    expect(warpArcs('textPlain', 360, 240)).toBe(a);
    expect(warpArcs('textPlain', 360, 240, [['adj', 60_000]])).not.toBe(a);
    expect(warpArcs('textPlain', 360, 241)).not.toBe(a);
    expect(warpArcs('textPlain', 361, 240)).not.toBe(a);
    expect(warpArcs('textWave1', 360, 240)).not.toBe(a);
  });

  it('reads adjust pairs by name and value only: a bad pair, a long name or a fifth pair is not part of the key', () => {
    clearWarpMemo();
    const a = warpArcs('textPlain', 360, 240)!;
    expect(warpArcs('textPlain', 360, 240, [['adj', Number.NaN]])).toBe(a);
    expect(warpArcs('textPlain', 360, 240, [['adj', Number.POSITIVE_INFINITY]])).toBe(a);
    expect(warpArcs('textPlain', 360, 240, [['x'.repeat(17), 5]])).toBe(a);
    expect(warpArcs('textPlain', 360, 240, [])).toBe(a);
    const four: [string, number][] = [
      ['adj', 60_000],
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ];
    const b = warpArcs('textPlain', 360, 240, four)!;
    expect(b).not.toBe(a);
    expect(warpArcs('textPlain', 360, 240, [...four, ['d', 4]])).toBe(b);
    expect(
      warpArcs('textPlain', 360, 240, [['adj', Number.NaN], ...four.slice(0, 3)] as [string, number][]),
    ).not.toBe(b);
    // A box is read as buildGeom reads it: NaN and negative sides are 0, huge ones are the largest box.
    expect(warpArcs('textPlain', Number.NaN, 240)).toBe(warpArcs('textPlain', 0, 240));
    expect(warpArcs('textPlain', -5, 240)).toBe(warpArcs('textPlain', 0, 240));
    expect(warpArcs('textPlain', 1e12, 240)).toBe(warpArcs('textPlain', 1e9, 240));
  });

  it('keeps at most 256 entries and 400,000 points, the least recently used out first, a hit refreshing recency', () => {
    expect([WARP_MEMO_MAX, WARP_MEMO_POINTS]).toEqual([256, 400_000]);
    clearWarpMemo();
    const first = Array.from({ length: WARP_MEMO_MAX }, (_, i) => warpArcs('textPlain', 100 + i, 100)!);
    expect(warpMemoStats().entries).toBe(WARP_MEMO_MAX);
    // A hit on the oldest makes the second oldest the next to go.
    expect(warpArcs('textPlain', 100, 100)).toBe(first[0]);
    warpArcs('textPlain', 5_000, 100);
    expect(warpMemoStats().entries).toBe(WARP_MEMO_MAX);
    expect(warpArcs('textPlain', 100, 100)).toBe(first[0]);
    expect(warpArcs('textPlain', 101, 100)).not.toBe(first[1]);
    clearWarpMemo();
    expect(warpMemoStats()).toEqual({ entries: 0, points: 0 });
  });

  it('holds both bounds after 300 distinct hostile boxes', () => {
    clearWarpMemo();
    let most = 0;
    for (let i = 0; i < 300; i++) {
      const e = warpArcs('textButtonPour', 1e9 - 1_000 * i, 1e9 - 3 * i)!;
      expect(e.arcs.length).toBe(6);
      for (const a of e.arcs) expect(a.xy.length / 2).toBeLessThanOrEqual(WARP_MAX_POINTS);
      const s = warpMemoStats();
      expect(s.entries).toBeLessThanOrEqual(WARP_MEMO_MAX);
      expect(s.points).toBeLessThanOrEqual(WARP_MEMO_POINTS);
      most = Math.max(most, s.points);
    }
    expect(warpMemoStats().entries).toBeLessThanOrEqual(WARP_MEMO_MAX);
    expect(most).toBeGreaterThan(0);
    clearWarpMemo();
  });

  it('evicts by entries, then by points, and does not keep an entry larger than the whole points bound', () => {
    const e = (points: number): { points: number } => ({ points });
    const keys = (m: Map<string, unknown>): string[] => [...m.keys()];
    const byEntries = new Map<string, { points: number }>();
    for (const k of ['a', 'b', 'c', 'd']) memoPut(byEntries, k, e(1), 3, 100);
    expect(keys(byEntries)).toEqual(['b', 'c', 'd']);
    const byPoints = new Map<string, { points: number }>();
    for (const k of ['a', 'b', 'c']) memoPut(byPoints, k, e(10), 100, 25);
    expect(keys(byPoints)).toEqual(['b', 'c']);
    memoPut(byPoints, 'big', e(26), 100, 25);
    expect(keys(byPoints)).toEqual(['b', 'c']);
    memoPut(byPoints, 'exact', e(25), 100, 25);
    expect(keys(byPoints)).toEqual(['exact']);
    // A key put again is replaced and becomes the newest.
    const again = new Map<string, { points: number }>();
    memoPut(again, 'a', e(1), 3, 100);
    memoPut(again, 'b', e(1), 3, 100);
    memoPut(again, 'a', e(2), 3, 100);
    expect(keys(again)).toEqual(['b', 'a']);
    expect(again.get('a')).toEqual({ points: 2 });
  });

  it('deals a warp’s arcs out by area: one arc each when the path count is odd, a pair each when it is even', () => {
    const a = [10, 11, 12, 13, 14, 15];
    expect(warpAreaArcs(a, 0)).toEqual([10, 11]);
    expect(warpAreaArcs(a, 1)).toEqual([12, 13]);
    expect(warpAreaArcs(a, 2)).toEqual([14, 15]);
    expect(warpAreaArcs(a, 3)).toEqual([]);
    expect(warpAreaArcs([10, 11, 12], 0)).toEqual([10]);
    expect(warpAreaArcs([10, 11, 12], 2)).toEqual([12]);
    expect(warpAreaArcs([10, 11, 12], 3)).toEqual([]);
    expect(warpAreaArcs([], 0)).toEqual([]);
    expect(warpAreaArcs([10, 11], -1)).toEqual([]);
    // Against the built warps: the first area of Button is its first path, of Button Pour its first two.
    expect(warpAreaArcs(warpArcs('textButton', 360, 240)!.arcs, 0).length).toBe(1);
    expect(warpAreaArcs(warpArcs('textButtonPour', 360, 240)!.arcs, 0).length).toBe(2);
    expect(warpAreaArcs(warpArcs('textArchUp', 360, 240)!.arcs, 0).length).toBe(1);
  });

  it('costs little: all 40 warps cold at 1920 x 1080 and a thousand hits', () => {
    clearWarpMemo();
    const t0 = performance.now();
    for (const name of TEXT_WARPS) warpArcs(name, 1920, 1080);
    expect(performance.now() - t0).toBeLessThan(budgetMs(100));
    const t1 = performance.now();
    for (let i = 0; i < 1_000; i++) warpArcs('textCircle', 1920, 1080);
    expect(performance.now() - t1).toBeLessThan(budgetMs(5));
    clearWarpMemo();
  });

  it('gives the same bytes for the same arguments in a fresh memo', () => {
    for (const name of TEXT_WARPS) {
      clearWarpMemo();
      const a = warpArcs(name, 1920, 1080, [[warpAdjustNames(name)![0]!, 33_333]])!;
      clearWarpMemo();
      const b = warpArcs(name, 1920, 1080, [[warpAdjustNames(name)![0]!, 33_333]])!;
      expect(a).not.toBe(b);
      expect(a.arcs.length).toBe(b.arcs.length);
      for (let i = 0; i < a.arcs.length; i++) {
        expect(Buffer.from(a.arcs[i]!.xy.buffer).equals(Buffer.from(b.arcs[i]!.xy.buffer)), name).toBe(true);
        expect(Buffer.from(a.arcs[i]!.len.buffer).equals(Buffer.from(b.arcs[i]!.len.buffer)), name).toBe(
          true,
        );
        expect(a.arcs[i]!.total).toBe(b.arcs[i]!.total);
        expect(a.arcs[i]!.tol).toBe(b.arcs[i]!.tol);
      }
    }
  });
});

describe('purity', () => {
  // The converter's rule (packages/pptx-scene/src/purity.test.ts, restated: that list is the converter's to edit when
  // text-conv imports these files): imports only pure sibling geometry modules, no DOM, process or network.
  const IMPORT = /^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm;
  const IMPURE = /\brequire\(|\bimport\(|\bprocess\.|\bdocument\.|\bwindow\.|\bfetch\(/;
  const ALLOWED = ['./path.ts', './ops.ts', './eval.ts', './textwarps.gen.ts'];
  const TYPE_ONLY = ['./compile.ts'];
  for (const file of ['textwarp.ts', 'textwarps.gen.ts'])
    it(`${file} imports only pure sibling geometry modules and uses no DOM, process, fetch or dynamic import`, () => {
      const src = readFileSync(join(import.meta.dirname, file), 'utf8');
      let seen = 0;
      for (const m of src.matchAll(IMPORT)) {
        const [, , typeOnly, spec] = m;
        seen++;
        expect(typeOnly ? TYPE_ONLY.concat(ALLOWED) : ALLOWED, `${file}: ${spec}`).toContain(spec);
      }
      expect(seen).toBeGreaterThan(0);
      expect(src).not.toMatch(IMPURE);
    });
});
