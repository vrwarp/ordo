import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cleanPathData, PATH_DATA_LIMITS, parsePathData, pathDataPoints, type ShapeGeom } from '@ordo/domain';
import { clampGeom } from '../clamp.ts';
import { geomBounds } from '../shape.ts';
import { compileGeom, type GeomSource, newGeomNotes } from './compile.ts';
import { withEnds } from './ends.ts';
import { evalGuideLists, evalGuides } from './eval.ts';
import { GEOM_LIMITS, PATH_FILLS } from './ops.ts';
import {
  buildGeom,
  COORD_LIMIT,
  customGeometry,
  type GeomPath,
  PRESET_GEOMS,
  presetGeometry,
} from './index.ts';
import { storedGeometry } from './stored.ts';

/**
 * The geometry engine on hostile input (design/27 §12, §14 item 3 "NaN and huge numbers, 10k path points",
 * §15 M6 "Fuzz covers guide formulas and paths"): random guide lists (every operator, unknown ones, forward
 * references and cycles, names that shadow built-ins, `__proto__`, huge and non-numeric tokens), random paths
 * of every command, random stored path strings and random boxes. Nothing throws; every value, coordinate and
 * point count stays within GEOM_LIMITS, COORD_LIMIT and PATH_DATA_LIMITS; each property runs well under 5 s.
 */

const OPS = [
  '*/',
  '+-',
  '+/',
  '?:',
  'abs',
  'at2',
  'cat2',
  'cos',
  'max',
  'min',
  'mod',
  'pin',
  'sat2',
  'sin',
  'sqrt',
  'tan',
  'val',
];
const BUILTINS = [
  'w',
  'h',
  'l',
  't',
  'r',
  'b',
  'hc',
  'vc',
  'ss',
  'ls',
  'wd2',
  'hd4',
  'ssd8',
  'cd4',
  'cd2',
  '3cd4',
];
const huge = ['1e308', '-1e308', '1e999', '9'.repeat(400), 'NaN', 'Infinity', '-0', '0x10', '1f', '1e-400'];

const name = fc.oneof(
  fc.constantFrom('g0', 'g1', 'g2', 'g3', 'adj', 'adj1', '__proto__', 'constructor', ...BUILTINS),
  fc.string({ maxLength: 6 }),
);
const token = fc.oneof(
  { weight: 3, arbitrary: name },
  { weight: 3, arbitrary: fc.integer({ min: -2_000_000, max: 2_000_000 }).map(String) },
  { weight: 1, arbitrary: fc.double().map(String) },
  { weight: 1, arbitrary: fc.constantFrom(...huge) },
);
const formula = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .tuple(fc.constantFrom(...OPS), fc.array(token, { maxLength: 4 }))
      .map(([op, a]) => [op, ...a].join(' ')),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 12 }) },
  { weight: 1, arbitrary: fc.constant(`*/ ${'1e300 '.repeat(3)}`) },
);
const guides = fc.array(fc.tuple(name, formula), { maxLength: 40 });
const cmd = fc.oneof(
  fc.record({ op: fc.constant('moveTo'), args: fc.array(token, { minLength: 2, maxLength: 2 }) }),
  fc.record({ op: fc.constant('lnTo'), args: fc.array(token, { minLength: 2, maxLength: 2 }) }),
  fc.record({ op: fc.constant('arcTo'), args: fc.array(token, { minLength: 4, maxLength: 4 }) }),
  fc.record({ op: fc.constant('quadBezTo'), args: fc.array(token, { minLength: 4, maxLength: 4 }) }),
  fc.record({ op: fc.constant('cubicBezTo'), args: fc.array(token, { minLength: 6, maxLength: 6 }) }),
  fc.record({ op: fc.constant('close'), args: fc.constant([]) }),
  fc.record({ op: fc.string({ maxLength: 6 }), args: fc.array(token, { maxLength: 3 }) }),
);
const path = fc.record({
  w: fc.option(token, { nil: undefined }),
  h: fc.option(token, { nil: undefined }),
  fill: fc.option(fc.constantFrom(...PATH_FILLS, 'bogus'), { nil: undefined }),
  stroke: fc.option(fc.constantFrom('0', '1', 'false', 'x'), { nil: undefined }),
  cmds: fc.array(cmd, { maxLength: 30 }),
});
const source: fc.Arbitrary<GeomSource> = fc.record({
  av: guides,
  gd: guides,
  rect: fc.record({ l: token, t: token, r: token, b: token }),
  paths: fc.array(path, { maxLength: 10 }),
  sites: fc.array(fc.record({ ang: token, x: token, y: token }), { maxLength: 4 }),
});
const side = fc.oneof(
  fc.double({ min: 0, max: 4000, noNaN: true }),
  fc.constantFrom(0, -5, 1e12, Number.NaN, Number.POSITIVE_INFINITY, 1e-300),
);
const adjPairs = fc.array(fc.tuple(name, fc.oneof(fc.double(), fc.constantFrom(Number.NaN, 1e300, -1e300))), {
  maxLength: 4,
});

function expectBuilt(paths: readonly GeomPath[]): void {
  expect(paths.length).toBeLessThanOrEqual(GEOM_LIMITS.paths);
  for (const p of paths) {
    expect(p.pts.length / 2).toBeLessThanOrEqual(GEOM_LIMITS.points);
    for (const v of p.pts) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(COORD_LIMIT);
    }
  }
}

describe('geometry fuzz (design/27 §12, §15 M6)', () => {
  it('compiles and evaluates random guide lists, cycles and huge numbers to bounded finite values', () => {
    fc.assert(
      fc.property(source, side, side, adjPairs, (src, w, h, adj) => {
        const notes = newGeomNotes();
        const g = compileGeom(src, notes);
        expect(g.g.length / 4).toBeLessThanOrEqual(GEOM_LIMITS.guides);
        expect(notes.messages.length).toBeLessThanOrEqual(32);
        const vals = evalGuides(g, { w, h }, adj as [string, number][]);
        for (const v of vals) {
          expect(Number.isFinite(v)).toBe(true);
          expect(Math.abs(v)).toBeLessThanOrEqual(GEOM_LIMITS.value);
        }
        const scope = evalGuideLists({ av: src.av, gd: src.gd }, { w: 100, h: 100 });
        for (const v of scope.vals) expect(Number.isFinite(v)).toBe(true);
        for (const [n] of src.gd ?? []) expect(Number.isFinite(scope.value(n))).toBe(true);
        const built = buildGeom(g, w, h, adj as [string, number][]);
        expectBuilt(built.paths);
        for (const v of Object.values(built.text)) expect(Number.isFinite(v)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('builds every preset at random boxes and adjust values within the bounds', () => {
    const names = [...PRESET_GEOMS.keys()];
    fc.assert(
      fc.property(fc.constantFrom(...names), side, side, adjPairs, (preset, w, h, adj) => {
        const built = presetGeometry(preset, w, h, adj as [string, number][])!;
        expectBuilt(built.paths);
        const b = geomBounds(built);
        for (const v of [b.x0, b.y0, b.x1, b.y1]) expect(Number.isFinite(v)).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('cuts a custGeom at the point and path limits, with arcs counted as 12 points', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ op: 'lnTo', args: [String(i), String(i % 7)] }));
    const arcs = Array.from({ length: 1000 }, () => ({ op: 'arcTo', args: ['50', '50', '0', '21600000'] }));
    const g = customGeometry(
      {
        paths: [
          { cmds: [{ op: 'moveTo', args: ['0', '0'] }, ...many] },
          { cmds: [{ op: 'moveTo', args: ['0', '0'] }, ...arcs] },
        ],
      },
      500,
      500,
    );
    expectBuilt(g.paths);
    expect(g.notes.count).toBeGreaterThan(0);
  });

  const number = fc.oneof(
    fc.integer({ min: -1e6, max: 1e6 }).map(String),
    fc.double().map(String),
    fc.constantFrom(
      '1e999',
      '-1e999',
      '.5',
      '5.',
      '-.5e-3',
      '+7',
      'NaN',
      'Infinity',
      '0x1f',
      '1e',
      '--1',
      '',
    ),
  );
  const piece = fc.oneof(
    { weight: 4, arbitrary: number },
    { weight: 2, arbitrary: fc.constantFrom('M', 'L', 'Q', 'C', 'Z', 'm', 'l', 'A', 'H', 'V') },
    { weight: 2, arbitrary: fc.constantFrom(' ', ',', '\n', '\t', '  ') },
    { weight: 1, arbitrary: fc.string({ maxLength: 4 }) },
  );
  const pathData = fc.array(piece, { maxLength: 200 }).map((a) => a.join(' '));

  it('re-tokenises random path strings to M L Q C Z and bounded numbers, idempotently', () => {
    fc.assert(
      fc.property(pathData, (d) => {
        const p = parsePathData(d);
        expect(p.cmds).toMatch(/^[MLQCZ]*$/);
        expect(pathDataPoints(p)).toBeLessThanOrEqual(PATH_DATA_LIMITS.points);
        for (const v of p.pts) {
          expect(Number.isFinite(v)).toBe(true);
          expect(Math.abs(v)).toBeLessThanOrEqual(PATH_DATA_LIMITS.coord);
        }
        const clean = cleanPathData(d);
        expect(clean.length).toBeLessThanOrEqual(PATH_DATA_LIMITS.chars);
        expect(clean).toMatch(/^[MLQCZ0-9.e+\- ]*$/);
        expect(cleanPathData(clean)).toBe(clean);
        expect(parsePathData(clean)).toEqual(p);
      }),
      { numRuns: 500 },
    );
  });

  const stored: fc.Arbitrary<unknown> = fc.record({
    preset: fc.oneof(
      fc.constantFrom(...[...PRESET_GEOMS.keys()].slice(0, 20), 'nope', '__proto__'),
      fc.string(),
    ),
    adj: fc.oneof(adjPairs, fc.anything()),
    paths: fc.oneof(
      fc.array(
        fc.record({
          d: fc.oneof(pathData, fc.anything()),
          w: fc.oneof(side, fc.anything()),
          h: fc.oneof(side, fc.anything()),
          fill: fc.oneof(fc.constantFrom(...PATH_FILLS), fc.anything()),
          stroke: fc.anything(),
        }),
        { maxLength: 12 },
      ),
      fc.anything(),
    ),
  });

  it('clamps and builds random stored geometries (presets, paths, garbage) within the bounds', () => {
    fc.assert(
      fc.property(stored, side, side, (g, w, h) => {
        const c = clampGeom(g);
        if (c) {
          expect((c.paths ?? []).length).toBeLessThanOrEqual(PATH_DATA_LIMITS.paths);
          for (const p of c.paths ?? []) expect(cleanPathData(p.d)).toBe(p.d);
        }
        const built = storedGeometry(c, w, h) ?? storedGeometry(g as ShapeGeom, w, h);
        if (built) expectBuilt(built.paths);
        for (const p of built?.paths ?? []) {
          const e = withEnds(p, {
            head: { kind: 'triangle', width: 9, length: 9, line: 3 },
            tail: { kind: 'arrow', width: 12, length: 14, line: 3 },
          });
          for (const v of e.shaft.pts) expect(Number.isFinite(v)).toBe(true);
          for (const m of e.markers) for (const v of m) expect(Number.isFinite(v)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('parses a 10,000-point path string to 4,096 points quickly', () => {
    const d = `M 0 0 ${Array.from({ length: 10_000 }, (_, i) => `L ${i} ${i % 13}`).join(' ')}`;
    const t0 = performance.now();
    const p = parsePathData(d);
    expect(pathDataPoints(p)).toBe(PATH_DATA_LIMITS.points);
    expect(cleanPathData(d).length).toBeLessThanOrEqual(PATH_DATA_LIMITS.chars);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
