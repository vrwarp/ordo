import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEXT_WARPS } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { CMD_CUBIC, CMD_LINE, CMD_MOVE } from './ops.ts';
import { buildGeom, COORD_LIMIT, type GeomPath } from './path.ts';
import {
  hasTextWarp,
  TEXT_WARP_NAMES,
  textWarpGeometry,
  WARP_PARALLEL_EPS,
  warpAdjustNames,
  warpAreas,
  warpFollowsPath,
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
