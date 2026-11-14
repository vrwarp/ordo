import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanPathData,
  PATH_DATA_LIMITS,
  parsePathData,
  pathDataPoints,
  type ShapeGeom,
  type SlideObject,
} from '@ordo/domain';
import { clampGeom } from '../clamp.ts';
import { geomBounds } from '../shape.ts';
import { compileGeom, type GeomSource, newGeomNotes } from './compile.ts';
import { evenOddArea, geomFillPath2D, UNION_NESTING_LIMIT } from './draw.ts';
import { withEnds } from './ends.ts';
import { evalGuideLists, evalGuides } from './eval.ts';
import { charged, GEOM_COST } from './cost.ts';
import { drawnCost, slideBudget } from '../geombudget.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD, GEOM_LIMITS, PATH_FILLS } from './ops.ts';
import {
  buildGeom,
  COORD_LIMIT,
  customGeometry,
  type GeomPath,
  PRESET_GEOMS,
  presetGeometry,
} from './index.ts';
import { RecPath } from './path2d.test-util.ts';
import { storedCost, storedGeometry } from './stored.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

/**
 * The geometry engine on hostile input (design/27 §12, §14 item 3 "NaN and huge numbers, 10k path points",
 * §15 M6 "Fuzz covers guide formulas and paths"): random guide lists (every operator, unknown ones, forward
 * references and cycles, names that shadow built-ins, `__proto__`, huge and non-numeric tokens), random paths
 * of every command, random stored path strings and random boxes. Nothing throws; every value, coordinate and
 * point count stays within GEOM_LIMITS, COORD_LIMIT and PATH_DATA_LIMITS, and every stored geometry built is
 * within its drawing budget (`cost.ts`, M6 repair); each property runs well under 5 s.
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

/**
 * Built paths within the bounds: at most GEOM_LIMITS.paths, each of at most `points` points (a stored
 * geometry's `cont` pieces join into one path of all their points), every coordinate finite within
 * COORD_LIMIT.
 */
function expectBuilt(paths: readonly GeomPath[], points: number = GEOM_LIMITS.points): void {
  expect(paths.length).toBeLessThanOrEqual(GEOM_LIMITS.paths);
  let all = 0;
  for (const p of paths) {
    all += p.pts.length / 2;
    expect(p.pts.length / 2).toBeLessThanOrEqual(points);
    for (const v of p.pts) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(COORD_LIMIT);
    }
  }
  expect(all).toBeLessThanOrEqual(GEOM_LIMITS.paths * GEOM_LIMITS.points);
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
          cont: fc.oneof(fc.boolean(), fc.anything()),
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
          for (const p of c.paths ?? []) {
            expect(cleanPathData(p.d)).toBe(p.d);
            expect(p.cont === undefined || p.cont === true).toBe(true);
          }
        }
        const built = storedGeometry(c, w, h) ?? storedGeometry(g as ShapeGeom, w, h);
        if (built) expectBuilt(built.paths, GEOM_LIMITS.paths * GEOM_LIMITS.points);
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

  // A path of whole commands (M L Q C Z with small integers), up to a few hundred of them.
  const command = fc.oneof(
    fc.tuple(
      fc.constantFrom('M', 'L'),
      fc.array(fc.integer({ min: -50, max: 150 }), { minLength: 2, maxLength: 2 }),
    ),
    fc.tuple(fc.constant('Q'), fc.array(fc.integer({ min: -50, max: 150 }), { minLength: 4, maxLength: 4 })),
    fc.tuple(fc.constant('C'), fc.array(fc.integer({ min: -50, max: 150 }), { minLength: 6, maxLength: 6 })),
    fc.tuple(fc.constant('Z'), fc.constant([] as number[])),
  );
  const commands = fc.array(command, { minLength: 1, maxLength: 300 });
  const fillMode = fc.constantFrom(...PATH_FILLS);

  it('never builds a stored geometry over its drawing budget, and rates any of them quickly', () => {
    // Random commands, often crossing each other across the box, at random box sizes: a built geometry is
    // within GEOM_COST.geometry, else the drawer draws the legacy shape; a chain of 8 full pieces is rated
    // fast (the estimate is linear in its points).
    fc.assert(
      fc.property(fc.array(commands, { minLength: 1, maxLength: 8 }), side, side, (paths, w, h) => {
        const g = clampGeom({
          paths: paths.map((cmds, i) => ({
            d: cmds.map(([c, n]) => [c, ...n].join(' ')).join(' '),
            w: 100,
            h: 100,
            ...(i % 2 ? { cont: true } : {}),
          })),
        });
        if (!g) return;
        const built = storedGeometry(g, w, h);
        const cost = storedCost(built);
        if (built && cost) expect(cost.est).toBeLessThanOrEqual(GEOM_COST.geometry);
      }),
      { numRuns: 300 },
    );
    const zig = (k: number) => {
      let d = 'M 0 0';
      for (let i = 1; i < 4_095; i++) d += ` L ${(i * 37 + k) % 100} ${i % 2 ? 100 : 0}`;
      return d;
    };
    const t0 = performance.now();
    const chain = {
      paths: Array.from({ length: 8 }, (_, k) => ({ d: zig(k), w: 100, h: 100, cont: k > 0 })),
    };
    expect(storedGeometry(clampGeom(chain)!, 1920, 1080)).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(budgetMs(1_000));
  });

  it('draws a cont chain as the one path it was cut from, wherever it is cut', () => {
    vi.stubGlobal('Path2D', RecPath);
    try {
      fc.assert(
        fc.property(
          commands,
          fc.array(fc.nat(), { maxLength: 7 }),
          fillMode,
          fc.boolean(),
          side,
          side,
          (cmds, at, fill, stroke, w, h) => {
            const text = cmds.map(([c, n]) => [c, ...n].join(' '));
            // Cut between commands (anywhere: at a sub-path's start or inside one), at most 8 pieces.
            const cuts = [...new Set(at.map((i) => 1 + (i % Math.max(1, text.length - 1))))]
              .filter((i) => i < text.length)
              .sort((a, b) => a - b);
            const bounds = [0, ...cuts, text.length];
            const pieces = bounds.slice(1).map((end, i) => text.slice(bounds[i], end).join(' '));
            const one = { paths: [{ d: text.join(' '), w: 100, h: 100, fill, stroke }] };
            const chain = {
              paths: pieces.map((d, i) => ({
                d,
                w: 100,
                h: 100,
                // A later piece's own fill and stroke are the first's (the converter writes the same).
                ...(i > 0 ? { cont: true, fill: 'none' as const, stroke: !stroke } : { fill, stroke }),
              })),
            };
            const clamped = clampGeom(chain)!;
            expect(clamped.paths!.slice(1).every((p) => p.cont === true)).toBe(true);
            const a = storedGeometry(clampGeom(one)!, w, h);
            const b = storedGeometry(clamped, w, h);
            // Its drawing estimate is the joined path's: both draw, or both are their legacy shape.
            expect(b === undefined).toBe(a === undefined);
            if (!a || !b) return;
            expect(b.paths).toHaveLength(1);
            expect(b.paths[0]).toEqual(a.paths[0]);
            expect((geomFillPath2D(b) as unknown as RecPath).ops).toEqual(
              (geomFillPath2D(a) as unknown as RecPath).ops,
            );
          },
        ),
        { numRuns: 300 },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bounds a chain of 8 full pieces: one path of 32,760 points, its union traced quickly', () => {
    vi.stubGlobal('Path2D', RecPath);
    try {
      // 8 pieces of 819 small squares each (M L L L Z: 4,095 points a piece).
      const piece = (k: number) =>
        Array.from({ length: 819 }, (_, i) => {
          const x = (i % 40) * 10 + k;
          const y = Math.floor(i / 40) * 10;
          return `M ${x} ${y} L ${x + 5} ${y} L ${x + 5} ${y + 5} L ${x} ${y + 5} Z`;
        }).join(' ');
      const g = clampGeom({
        paths: Array.from({ length: 8 }, (_, k) => ({
          d: piece(k),
          w: 0,
          h: 0,
          ...(k ? { cont: true } : {}),
        })),
      })!;
      const t0 = performance.now();
      const built = storedGeometry(g, 500, 500)!;
      expect(built.paths).toHaveLength(1);
      expectBuilt(built.paths, GEOM_LIMITS.paths * GEOM_LIMITS.points);
      const union = geomFillPath2D(built) as unknown as RecPath;
      expect(union.ops.filter((op) => op === 'Z')).toHaveLength(8 * 819);
      expect(performance.now() - t0).toBeLessThan(budgetMs(2_000));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rates the even-odd area of any path (garbage commands and points included) without throwing, quickly', () => {
    // Commands of every kind and unknown ones, with too few points, NaN, infinities and huge values: the area
    // is a finite number >= 0 or unknown, never a throw (the converter rates every custom geometry by it).
    const raw = fc.record({
      cmds: fc.array(fc.constantFrom(CMD_MOVE, CMD_LINE, CMD_QUAD, CMD_CUBIC, CMD_CLOSE, 99, -1), {
        maxLength: 400,
      }),
      pts: fc.array(
        fc.oneof(
          fc.double({ min: -1e4, max: 1e4, noNaN: true }),
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -1e308, 1e308, 0),
        ),
        { maxLength: 1_200 },
      ),
      fill: fillMode,
      stroke: fc.boolean(),
    });
    fc.assert(
      fc.property(raw, (path) => {
        const a = evenOddArea(path as GeomPath);
        if (a !== undefined) {
          expect(Number.isFinite(a)).toBe(true);
          expect(a).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 500 },
    );
    // Stored geometries of random whole commands: what the converter and the census rate.
    fc.assert(
      fc.property(fc.array(commands, { minLength: 1, maxLength: 4 }), side, side, (paths, w, h) => {
        const g = clampGeom({
          paths: paths.map((cmds) => ({
            d: cmds.map(([c, n]) => [c, ...n].join(' ')).join(' '),
            w: 100,
            h: 100,
          })),
        });
        const built = g ? storedGeometry(g, w, h) : undefined;
        for (const p of built?.paths ?? []) {
          const a = evenOddArea(p);
          if (a !== undefined) expect(Number.isFinite(a) && a >= 0).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
    // The worst nesting within the bounds: UNION_NESTING_LIMIT squares, each inside all the others' boxes.
    const nested = Array.from({ length: UNION_NESTING_LIMIT }, (_, i) => [i, i, 4_096 - i, 4_096 - i]);
    const path: GeomPath = {
      cmds: nested.flatMap(() => [CMD_MOVE, CMD_LINE, CMD_LINE, CMD_LINE, CMD_CLOSE]),
      pts: nested.flatMap(([a, b, c, d]) => [a!, b!, c!, b!, c!, d!, a!, d!]),
      fill: 'norm',
      stroke: true,
    };
    const t0 = performance.now();
    expect(evenOddArea(path)).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(budgetMs(1_000));
  });

  it('parses a 10,000-point path string to 4,096 points quickly', () => {
    const d = `M 0 0 ${Array.from({ length: 10_000 }, (_, i) => `L ${i} ${i % 13}`).join(' ')}`;
    const t0 = performance.now();
    const p = parsePathData(d);
    expect(pathDataPoints(p)).toBe(PATH_DATA_LIMITS.points);
    expect(cleanPathData(d).length).toBeLessThanOrEqual(PATH_DATA_LIMITS.chars);
    expect(performance.now() - t0).toBeLessThan(budgetMs(1000));
  });

  it('never draws a slide past its drawing budget: random hostile outlines, caps, arrowheads, dashes, effects', () => {
    // Slides of random shapes: scattered clouds, many short open sub-paths, zigzags and presets, stroked
    // 0.01 to 500 px wide with every join, cap, dash and arrowhead, some with effects (the re-review's
    // blocker and its variations). What a slide draws natively charges its budget at most, its stored points
    // stay within 64k, and a legacy copy costs little; the whole slide is rated quickly.
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const pathOf = (kind: number, seed: number, n: number, r: number) => {
      let x = seed * 7919 + 1;
      const rand = () => {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return ((x >>> 0) % 1_000_000) / 1_000_000;
      };
      let d = '';
      for (let k = 0; k < n; k++) {
        const a = rand() * Math.PI * 2;
        const q = Math.sqrt(rand()) * r;
        const px = (500 + q * Math.cos(a)).toFixed(2);
        const py = (500 + q * Math.sin(a)).toFixed(2);
        if (kind === 0) d += `${k ? 'L' : 'M'} ${px} ${py} `;
        else if (kind === 1)
          d += `M ${px} ${py} L ${(+px + Math.cos(a)).toFixed(2)} ${(+py + Math.sin(a)).toFixed(2)} `;
        else
          d += `${k ? 'L' : 'M'} ${(500 + (k % 2 ? r : -r) * Math.cos(a)).toFixed(1)} ${(500 + (k % 2 ? r : -r) * Math.sin(a)).toFixed(1)} `;
      }
      return { d: d.trim(), w: 1000, h: 1000, ...(kind === 1 ? { fill: 'none' as const } : {}) };
    };
    const shapeArb = fc.record({
      kind: fc.nat(3),
      seed: fc.nat(1000),
      paths: fc.integer({ min: 1, max: 8 }),
      n: fc.integer({ min: 2, max: 1_500 }),
      r: fc.constantFrom(0.5, 3, 50, 480),
      width: fc.constantFrom(0, 0.01, 0.5, 2, 20, 100, 400, 500),
      join: fc.constantFrom(undefined, 'round', 'bevel'),
      cap: fc.constantFrom(undefined, 'round', 'square'),
      dash: fc.constantFrom(undefined, 'sysDot', 'dash', 'longDashDotDot'),
      ends: fc.boolean(),
      fx: fc.nat(3),
      full: fc.boolean(),
    });
    let slowest = 0;
    fc.assert(
      fc.property(fc.array(shapeArb, { minLength: 1, maxLength: 24 }), (specs) => {
        const objects: SlideObject[] = specs.map((t, i) => ({
          id: `s${i}`,
          type: 'shape',
          box: t.full
            ? { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }
            : { x: 460, y: 40, w: 1000, h: 1000, rotation: 0 },
          shape: 'rect',
          ...(t.kind === 1 ? {} : { fill: { r: 1, g: 2, b: 3, a: 1 } }),
          opacity: 1,
          radius: 0,
          geom:
            t.kind === 3
              ? { preset: 'star32' }
              : { paths: Array.from({ length: t.paths }, (_, j) => pathOf(t.kind, t.seed + j, t.n, t.r)) },
          ...(t.width ? { stroke: { width: t.width, color: black } } : {}),
          ...(t.join ? { lineJoin: t.join } : {}),
          ...(t.cap ? { lineCap: t.cap } : {}),
          ...(t.dash ? { dash: t.dash } : {}),
          ...(t.ends
            ? { ends: { head: { type: 'triangle', w: 'lg', len: 'lg' }, tail: { type: 'oval' } } }
            : {}),
          ...(t.fx === 1 ? { shadow: { dx: 4, dy: 4, blur: 12, color: black } } : {}),
          ...(t.fx === 2 ? { glow: { radius: 40, color: black } } : {}),
          ...(t.fx === 3 ? { softEdge: 12 } : {}),
        })) as SlideObject[];
        const t0 = performance.now();
        const plan = slideBudget(objects);
        slowest = Math.max(slowest, performance.now() - t0);
        let native = 0;
        let points = 0;
        for (const o of objects) {
          const copy = plan.get(o);
          const r = drawnCost(copy ?? o);
          points += r.points;
          // A copy without its effects keeps its geometry (charged); one without its geometry is a legacy shape
          // (a rect, its fill and outline over at most a slide: GEOM_COST.area).
          if (copy && (copy as { geom?: unknown }).geom === undefined)
            expect(charged(r)).toBeLessThan(GEOM_COST.slide / 4);
          else native += charged(r);
        }
        expect(native).toBeLessThanOrEqual(GEOM_COST.slide);
        expect(points).toBeLessThanOrEqual(GEOM_COST.slidePoints);
      }),
      { numRuns: 60, seed: 2711 },
    );
    expect(slowest).toBeLessThan(budgetMs(1_000));
  });
});
