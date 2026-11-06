import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileGeom, type GuidePairs, newGeomNotes } from './compile.ts';
import {
  applyOp,
  evalGuideLists,
  evalGuides,
  type GuideBox,
  guideSlot,
  guideValue,
  guideValues,
} from './eval.ts';
import { BUILTIN_GUIDES, type CompiledGeom, GEOM_LIMITS, GUIDE_OPS } from './ops.ts';
import { PRESET_GEOMS } from './presets.gen.ts';

/** One guide `x = fmla` evaluated at a box (the custGeom entry). */
function ev(fmla: string, box: GuideBox = { w: 1000, h: 600 }): number {
  return evalGuideLists({ gd: [['x', fmla]] }, box).value('x');
}

/** Guide lists evaluated at a box: name → value, and the notes. */
function run(gd: GuidePairs, box: GuideBox = { w: 1000, h: 600 }, av: GuidePairs = []) {
  return evalGuideLists({ av, gd }, box);
}

// Java's Math.toRadians / toDegrees, as POI's GuideIf uses them.
const rad = (ooxml: number): number => (ooxml / 60000) * 0.017453292519943295;

describe('the 17 operators (POI GuideIf.evaluateGuide)', () => {
  it('has exactly the ECMA-376 operators', () => {
    expect([...GUIDE_OPS].sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  it('*/ multiplies then divides, 0 when dividing by zero', () => {
    expect(ev('*/ 6 4 3')).toBe(8);
    expect(ev('*/ w 1 3')).toBeCloseTo(1000 / 3, 12);
    expect(ev('*/ 7 3 2')).toBe(10.5);
    expect(ev('*/ 5 2 0')).toBe(0);
    expect(ev('*/ w h 0')).toBe(0);
  });

  it('+- adds then subtracts', () => {
    expect(ev('+- 5 3 10')).toBe(-2);
    expect(ev('+- w 0 h')).toBe(400);
  });

  it('+/ adds then divides, 0 when dividing by zero', () => {
    expect(ev('+/ 5 3 4')).toBe(2);
    expect(ev('+/ 5 3 0')).toBe(0);
  });

  it('?: takes y only when x > 0', () => {
    expect(ev('?: 1 7 9')).toBe(7);
    expect(ev('?: 0.001 7 9')).toBe(7);
    expect(ev('?: 0 7 9')).toBe(9);
    expect(ev('?: -1 7 9')).toBe(9);
  });

  it('abs', () => {
    expect(ev('abs -42')).toBe(42);
    expect(ev('abs 42')).toBe(42);
  });

  it('at2 x y is atan2(y, x) in 60000ths of a degree, clockwise with y down', () => {
    expect(ev('at2 1 1')).toBeCloseTo(2_700_000, 6);
    expect(ev('at2 0 1')).toBeCloseTo(5_400_000, 6);
    expect(ev('at2 -1 0')).toBeCloseTo(10_800_000, 6);
    expect(ev('at2 0 -1')).toBeCloseTo(-5_400_000, 6);
    expect(ev('at2 0 0')).toBe(0);
    expect(ev('at2 3 4')).toBe(Math.atan2(4, 3) * 57.29577951308232 * 60000);
  });

  it('cat2 x y z = x·cos(atan2(z, y)), sat2 x y z = x·sin(atan2(z, y))', () => {
    expect(ev('cat2 100 3 4')).toBe(100 * Math.cos(Math.atan2(4, 3)));
    expect(ev('cat2 100 3 4')).toBeCloseTo(60, 12);
    expect(ev('sat2 100 3 4')).toBe(100 * Math.sin(Math.atan2(4, 3)));
    expect(ev('sat2 100 3 4')).toBeCloseTo(80, 12);
    expect(ev('cat2 100 0 0')).toBe(100);
    expect(ev('sat2 100 0 0')).toBe(0);
  });

  it('cos, sin and tan take the angle in 60000ths of a degree', () => {
    expect(ev('cos 100 0')).toBe(100);
    expect(ev('cos 200 3600000')).toBe(200 * Math.cos(rad(3_600_000)));
    expect(ev('cos 200 3600000')).toBeCloseTo(100, 12);
    expect(ev('sin 100 5400000')).toBe(100);
    expect(ev('sin 100 1800000')).toBeCloseTo(50, 12);
    expect(ev('sin 100 -5400000')).toBe(-100);
    expect(ev('tan 100 2700000')).toBe(100 * Math.tan(rad(2_700_000)));
    expect(ev('tan 100 2700000')).toBeCloseTo(100, 12);
  });

  it('max and min', () => {
    expect(ev('max -3 4')).toBe(4);
    expect(ev('min -3 4')).toBe(-3);
  });

  it('mod is the length of (x, y, z)', () => {
    expect(ev('mod 3 4 12')).toBe(13);
    expect(ev('mod 3 4 0')).toBe(5);
  });

  it('pin x y z = max(x, min(y, z))', () => {
    expect(ev('pin 0 5 10')).toBe(5);
    expect(ev('pin 0 -5 10')).toBe(0);
    expect(ev('pin 0 15 10')).toBe(10);
    // An empty range keeps the lower bound, as POI computes it.
    expect(ev('pin 10 5 0')).toBe(10);
  });

  it('sqrt, with a negative operand giving 0 (NaN is never a value)', () => {
    expect(ev('sqrt 16')).toBe(4);
    expect(ev('sqrt 2')).toBe(Math.SQRT2);
    expect(ev('sqrt -4')).toBe(0);
  });

  it('val', () => {
    expect(ev('val -7')).toBe(-7);
    expect(ev('val h')).toBe(600);
  });

  it('applyOp gives 0 for an unknown op code', () => {
    expect(applyOp(17, 1, 2, 3)).toBe(0);
    expect(applyOp(-1, 1, 2, 3)).toBe(0);
  });
});

describe('built-in guides (POI BuiltInGuide, plus wd12, hd10 and cd3)', () => {
  const expected: Record<(typeof BUILTIN_GUIDES)[number], number> = {
    w: 300,
    h: 700,
    l: 10,
    t: 20,
    r: 310,
    b: 720,
    hc: 160,
    vc: 370,
    ss: 300,
    ls: 700,
    hd2: 350,
    hd3: 700 / 3,
    hd4: 175,
    hd5: 140,
    hd6: 700 / 6,
    hd8: 87.5,
    hd10: 70,
    wd2: 150,
    wd3: 100,
    wd4: 75,
    wd5: 60,
    wd6: 50,
    wd8: 37.5,
    wd10: 30,
    wd12: 25,
    wd32: 9.375,
    ssd2: 150,
    ssd4: 75,
    ssd6: 50,
    ssd8: 37.5,
    ssd16: 18.75,
    ssd32: 9.375,
    cd2: 10_800_000,
    cd3: 7_200_000,
    cd4: 5_400_000,
    cd8: 2_700_000,
    '3cd4': 16_200_000,
    '3cd8': 8_100_000,
    '5cd8': 13_500_000,
    '7cd8': 18_900_000,
  };

  it('evaluates every built-in at a box with an origin', () => {
    expect(Object.keys(expected).sort()).toEqual([...BUILTIN_GUIDES].sort());
    const box = { l: 10, t: 20, w: 300, h: 700 };
    for (const name of BUILTIN_GUIDES) {
      expect([name, ev(`val ${name}`, box)]).toEqual([name, expected[name]]);
    }
  });

  it('takes the short and long side from whichever is shorter', () => {
    const box = { w: 800, h: 200 };
    expect(ev('val ss', box)).toBe(200);
    expect(ev('val ls', box)).toBe(800);
    expect(ev('val ssd32', box)).toBe(6.25);
    expect(ev('val l', box)).toBe(0);
    expect(ev('val r', box)).toBe(800);
  });

  it('reads a box that is not finite or negative as an empty one', () => {
    for (const w of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(ev('val w', { w, h: 10 })).toBe(0);
      expect(ev('val wd2', { w, h: 10 })).toBe(0);
    }
    expect(ev('val l', { w: 1, h: 1, l: Number.NaN })).toBe(0);
  });
});

describe('formula tokens and names', () => {
  it('reads plain decimals as numbers', () => {
    expect(ev('val 1e3')).toBe(1000);
    expect(ev('val 2.5E-1')).toBe(0.25);
    expect(ev('val +5')).toBe(5);
    expect(ev('val -5')).toBe(-5);
    expect(ev('val .5')).toBe(0.5);
    expect(ev('val 5.')).toBe(5);
    expect(Object.is(ev('val -0'), 0)).toBe(true);
  });

  it('reads anything else as a name: NaN, Infinity, hex and suffixes are unknown names (0)', () => {
    for (const t of [
      'NaN',
      'Infinity',
      '-Infinity',
      '0x10',
      '1_000',
      '5f',
      '5d',
      '1e',
      '1e+',
      '--5',
      '+',
      '.',
      '٣',
    ]) {
      const s = run([['x', `+- ${t} 7 0`]]);
      expect([t, s.value('x')]).toEqual([t, 7]);
      expect(s.notes.count).toBe(1);
    }
  });

  it('gives a missing operand the value 0 and ignores extra ones', () => {
    expect(ev('+- 5')).toBe(5);
    expect(ev('*/ 6 4')).toBe(0);
    expect(ev('pin 1')).toBe(1);
    expect(ev('val 3 4 5')).toBe(3);
    expect(ev('val')).toBe(0);
  });

  it('splits at any ASCII whitespace and ignores it around the formula', () => {
    expect(ev('  */\t6\n4   3 ')).toBe(8);
    // Other spaces are not separators: the operand is the unknown name '6 4'.
    expect(ev('val 6 4')).toBe(0);
  });

  it('gives an unknown operator, an empty formula or an over-long one the value 0, with a note', () => {
    for (const f of [
      'muldiv 6 4 3',
      'VAL 3',
      'mul 1 2',
      '',
      '   ',
      `val ${'1'.repeat(GEOM_LIMITS.formula)}`,
    ]) {
      const s = run([['x', f]]);
      expect(s.value('x')).toBe(0);
      expect(s.notes.count).toBe(1);
    }
  });

  it('lets a guide see the definitions before it, the latest of a name winning', () => {
    const s = run([
      ['a', 'val 1'],
      ['b', '+- a 0 0'],
      ['a', 'val 2'],
      ['c', '+- a 0 0'],
    ]);
    expect([s.value('b'), s.value('c'), s.value('a')]).toEqual([1, 2, 2]);
  });

  it('lets a defined name shadow a built-in, as POI Context.getValue does', () => {
    const s = run([
      ['x', '*/ w 2 1'],
      ['w', 'val 5'],
      ['y', '*/ w 2 1'],
    ]);
    expect([s.value('x'), s.value('y'), s.value('w')]).toEqual([2000, 10, 5]);
  });

  it('reads a forward reference, a self reference and a cycle as 0: no recursion', () => {
    const fwd = run([
      ['x', '+- y 1 0'],
      ['y', 'val 5'],
    ]);
    expect([fwd.value('x'), fwd.value('y')]).toEqual([1, 5]);
    expect(fwd.notes.messages).toEqual(["unknown name 'y' in guide 'x'"]);
    expect(run([['x', '+- x 1 0']]).value('x')).toBe(1);
    const again = run([
      ['x', 'val 3'],
      ['x', '+- x 1 0'],
    ]);
    expect(again.value('x')).toBe(4);
    const cycle = run([
      ['p', '+- q 1 0'],
      ['q', '+- p 1 0'],
    ]);
    expect([cycle.value('p'), cycle.value('q')]).toEqual([1, 2]);
  });

  it('evaluates a chain as long as the bound in one pass', () => {
    const gd: [string, string][] = [['g0', 'val 0']];
    for (let i = 1; i < GEOM_LIMITS.guides; i++) gd.push([`g${i}`, `+- g${i - 1} 1 0`]);
    const s = run(gd);
    expect(s.value(`g${GEOM_LIMITS.guides - 1}`)).toBe(GEOM_LIMITS.guides - 1);
    expect(s.notes.count).toBe(0);
  });

  it('drops guides over the bound, adjust values counted first', () => {
    const av: [string, string][] = [['adj', 'val 9']];
    const gd: [string, string][] = [];
    for (let i = 0; i < 10_000; i++) gd.push([`g${i}`, `+- adj ${i} 0`]);
    const s = run(gd, undefined, av);
    expect(s.geom.g.length / 4).toBe(GEOM_LIMITS.guides);
    expect(s.value('g254')).toBe(9 + 254);
    expect(s.value('g255')).toBe(0);
    expect(s.notes.messages[0]).toBe('9745 guides over the limit dropped');
  });

  it('binds nothing to an over-long name', () => {
    const long = 'n'.repeat(GEOM_LIMITS.name + 1);
    const s = run([
      [long, 'val 5'],
      ['x', `+- ${long} 1 0`],
    ]);
    expect(s.value('x')).toBe(1);
    expect(s.geom.n[0]).toBe('');
  });

  it('treats prototype-like names as ordinary names', () => {
    const s = run([
      ['__proto__', 'val 3'],
      ['constructor', '+- __proto__ 1 0'],
      ['x', '+- toString hasOwnProperty 0'],
    ]);
    expect([s.value('__proto__'), s.value('constructor'), s.value('x'), s.value('valueOf')]).toEqual([
      3, 4, 0, 0,
    ]);
  });

  it('keeps every value finite and within ±GEOM_LIMITS.value', () => {
    const L = GEOM_LIMITS.value;
    expect(ev('val 1e100')).toBe(L);
    expect(ev('val -1e100')).toBe(-L);
    expect(ev('*/ 1e50 1e50 1')).toBe(L);
    expect(ev('*/ 1 1 1e-300')).toBe(L);
    // What is not a finite double is 0 (design/27 §12): a literal past the double range, an overflow.
    expect(ev('val 1e999')).toBe(0);
    expect(ev('*/ 1e60 1e60 1e-300')).toBe(0);
    expect(ev('tan 1 5400000')).toBe(Math.tan(rad(5_400_000)));
    const s = run([
      ['a', 'val 1e60'],
      ['b', '*/ a a 1'],
      ['c', 'mod b b b'],
      ['d', '+- c c 0'],
    ]);
    for (const n of ['a', 'b', 'c', 'd']) expect(s.value(n)).toBe(L);
  });

  it('reads operands of the custGeom scope as the compiler does', () => {
    const s = run([['x', 'val 4']]);
    expect(s.value(' x ')).toBe(4);
    expect(s.value('12')).toBe(12);
    expect(s.value('hd2')).toBe(300);
    expect(s.value('nope')).toBe(0);
  });
});

describe('adjust values', () => {
  const roundRect = PRESET_GEOMS.get('roundRect')!;
  const box = { w: 1828800, h: 914400 };

  it('defaults to the avLst value', () => {
    const v = evalGuides(roundRect, box);
    expect(guideValue(roundRect, v, 'adj')).toBe(16667);
    expect(guideValue(roundRect, v, 'x1')).toBeCloseTo((914400 * 16667) / 100000, 9);
  });

  it("takes a shape's pair by name, the first of a name winning", () => {
    const v = evalGuides(roundRect, box, [
      ['adj', 30000],
      ['adj', 10000],
    ]);
    expect(guideValue(roundRect, v, 'adj')).toBe(30000);
    expect(guideValue(roundRect, v, 'x1')).toBe(274320);
  });

  it('ignores pairs that name no adjust value, a guide included', () => {
    const plain = evalGuides(roundRect, box);
    const v = evalGuides(roundRect, box, [
      ['x1', 5],
      ['adj9', 5],
      ['', 5],
    ]);
    expect([...v]).toEqual([...plain]);
  });

  it('reads a non-finite pair as 0 and clamps a huge one', () => {
    expect(guideValue(roundRect, evalGuides(roundRect, box, [['adj', Number.NaN]]), 'adj')).toBe(0);
    expect(guideValue(roundRect, evalGuides(roundRect, box, [['adj', 1e300]]), 'adj')).toBe(
      GEOM_LIMITS.value,
    );
  });

  it('reads at most 64 pairs', () => {
    const pairs: [string, number][] = [];
    for (let i = 0; i < 64; i++) pairs.push([`other${i}`, i]);
    pairs.push(['adj', 30000]);
    expect(guideValue(roundRect, evalGuides(roundRect, box, pairs), 'adj')).toBe(16667);
  });

  it('evaluates a custGeom avLst formula like a guide', () => {
    const s = run([['x', '*/ a 2 1']], undefined, [['a', '*/ w 1 4']]);
    expect(s.value('x')).toBe(500);
  });
});

describe('the evaluator on a hand-made geometry', () => {
  it('reads 0 for a slot a guide may not read (its own, a later one, out of range)', () => {
    // Built-ins 0..39, constant 40 = 7, guides 41 and 42.
    const geom: CompiledGeom = {
      k: [7],
      a: [],
      g: [16, 41, 0, 0, 1, 40, 9999, -3],
      n: ['p', 'q'],
      r: [2, 3, 4, 5],
      p: [],
    };
    const v = evalGuides(geom, { w: 1, h: 1 });
    expect([v[41], v[42]]).toEqual([0, 7]);
  });

  it('reuses an output array with room and clears what it does not fill', () => {
    const geom = compileGeom({ gd: [['x', 'val 3']] });
    const out = new Float64Array(100).fill(5);
    const v = evalGuides(geom, { w: 1, h: 1 }, undefined, out);
    expect(v).toBe(out);
    expect(guideValue(geom, v, 'x')).toBe(3);
    expect(evalGuides(geom, { w: 1, h: 1 }, undefined, new Float64Array(2)).length).toBe(42);
  });
});

describe('name lookups', () => {
  it('finds the latest definition, then a built-in, else −1', () => {
    const geom = compileGeom({
      av: [['adj', 'val 1']],
      gd: [
        ['x', 'val 2'],
        ['adj', 'val 3'],
        ['x', 'val 4'],
      ],
    });
    const v = evalGuides(geom, { w: 10, h: 20 });
    expect(guideValue(geom, v, 'adj')).toBe(3);
    expect(guideValue(geom, v, 'x')).toBe(4);
    expect(guideValue(geom, v, 'h')).toBe(20);
    expect(guideSlot(geom, 'nope')).toBe(-1);
    expect(guideValue(geom, v, 'nope')).toBe(0);
    expect([...guideValues(geom, v)]).toEqual([
      ['adj', 3],
      ['x', 4],
    ]);
  });
});

interface PoiCase {
  readonly case: string;
  readonly values: Record<string, number>;
}

describe('POI spot checks: a dozen presets against Apache POI 5.2.5', () => {
  // Every adjust value and guide of each case, as POI's Context computed them (tools/geom-gen/poi/GuideDump.java).
  const data = JSON.parse(readFileSync(new URL('./poi-guides.json', import.meta.url), 'utf8')) as {
    cases: PoiCase[];
  };

  it('covers the dozen presets', () => {
    const names = new Set(data.cases.map((c) => c.case.split(' ')[0]));
    expect([...names].sort()).toEqual(
      [
        'arc',
        'can',
        'chevron',
        'cloud',
        'ellipse',
        'pie',
        'rect',
        'ribbon2',
        'rightArrow',
        'roundRect',
        'star5',
        'triangle',
      ].sort(),
    );
  });

  for (const c of data.cases) {
    it(c.case, () => {
      const [name, l, t, w, h, ...adj] = c.case.split(' ');
      const geom = PRESET_GEOMS.get(name!)!;
      const pairs = adj.map((kv) => {
        const [k, v] = kv.split('=');
        return [k!, Number(v)] as const;
      });
      const ours = guideValues(
        geom,
        evalGuides(geom, { l: Number(l), t: Number(t), w: Number(w), h: Number(h) }, pairs),
      );
      expect([...ours.keys()]).toEqual(Object.keys(c.values));
      for (const [k, v] of Object.entries(c.values)) {
        const got = ours.get(k)!;
        expect(Math.abs(got - v) / Math.max(1, Math.abs(v)), `${k}: ${got} vs POI ${v}`).toBeLessThan(1e-12);
      }
    });
  }

  it('reads the values a path draws, checked by hand', () => {
    const box = { w: 1828800, h: 914400 };
    const at = (name: string, pairs: [string, number][], gd: string) => {
      const geom = PRESET_GEOMS.get(name)!;
      return guideValue(geom, evalGuides(geom, box, pairs), gd);
    };
    // roundRect: the corner is a fraction of the short side, pinned to half of it.
    expect(at('roundRect', [['adj', 80000]], 'x1')).toBe(914400 / 2);
    // triangle: the apex at adj of the width.
    expect(at('triangle', [], 'x1')).toBe(1828800 / 4);
    expect(at('triangle', [['adj', 0]], 'x1')).toBe(0);
    // rightArrow: the shaft is adj1 of the height, the head adj2 of the short side, pinned to the width.
    expect(at('rightArrow', [], 'dy1')).toBe(914400 * 0.25);
    expect(at('rightArrow', [], 'x1')).toBe(1828800 - 914400 * 0.5);
    // chevron: the point is adj of the short side.
    expect(at('chevron', [], 'x2')).toBe(1828800 - 914400 * 0.5);
    // pie: an end angle before the start angle sweeps the long way round.
    expect(at('pie', [], 'swAng')).toBe(16_200_000);
    expect(
      at(
        'pie',
        [
          ['adj1', 5_400_000],
          ['adj2', 0],
        ],
        'swAng',
      ),
    ).toBe(16_200_000);
    expect(
      at(
        'pie',
        [
          ['adj1', 0],
          ['adj2', 5_400_000],
        ],
        'swAng',
      ),
    ).toBe(5_400_000);
    // can: the lid is adj of the short side.
    expect(at('can', [], 'y1')).toBe(914400 * 0.25 * 0.5);
  });
});

describe('the presets', () => {
  it('has the 187 presets of POI 5.2.5', () => {
    expect(PRESET_GEOMS.size).toBe(187);
    for (const n of [
      'rect',
      'roundRect',
      'ellipse',
      'line',
      'straightConnector1',
      'gear9',
      'star32',
      'pie',
    ]) {
      expect(PRESET_GEOMS.has(n), n).toBe(true);
    }
    expect(PRESET_GEOMS.get('__proto__')).toBeUndefined();
    expect(PRESET_GEOMS.get('constructor')).toBeUndefined();
  });

  it('evaluates every preset to finite values at ordinary, degenerate and huge boxes', () => {
    const boxes: GuideBox[] = [
      { w: 1828800, h: 914400 },
      { w: 300, h: 700, l: 10, t: 20 },
      { w: 0, h: 0 },
      { w: 1, h: 1e8 },
      { w: 1.024e8, h: 1.024e8 },
    ];
    for (const [name, geom] of PRESET_GEOMS) {
      expect(geom.g.length / 4, name).toBeLessThanOrEqual(GEOM_LIMITS.guides);
      for (const box of boxes) {
        for (const adj of [
          undefined,
          geom.a.map((a) => [a, 1e7] as const),
          geom.a.map((a) => [a, -1e7] as const),
        ]) {
          const v = evalGuides(geom, box, adj);
          for (const x of v) {
            if (!Number.isFinite(x) || Math.abs(x) >= GEOM_LIMITS.value) throw new Error(`${name}: ${x}`);
          }
        }
      }
    }
  });

  it('uses only slots that exist, and guides read only earlier slots', () => {
    for (const [name, geom] of PRESET_GEOMS) {
      const size = 40 + geom.k.length + geom.g.length / 4;
      const base = 40 + geom.k.length;
      for (let i = 0; i < geom.g.length; i += 4) {
        for (let j = 1; j < 4; j++) expect(geom.g[i + j]!, name).toBeLessThan(base + i / 4);
      }
      for (const s of [...geom.r, ...(geom.c ?? []), ...geom.p.flatMap((p) => p.c.filter((_, i) => i > 0))]) {
        expect(s, name).toBeLessThan(size);
      }
    }
  });

  it('has the fixed pie text rect: the rectangle inscribed at 45°, il, it, ir, ib', () => {
    const pie = PRESET_GEOMS.get('pie')!;
    expect(pie.r).toEqual(['il', 'it', 'ir', 'ib'].map((n) => guideSlot(pie, n)));
    const v = evalGuides(pie, { w: 1000, h: 1000 });
    const [l, t, r, b] = pie.r.map((s) => v[s]!);
    expect(l).toBeLessThan(r!);
    expect(t).toBeLessThan(b!);
    expect(r! - l!).toBeCloseTo(b! - t!, 9);
  });

  it('bounds the star24 and star32 handles at 50000 like star16', () => {
    for (const n of ['star16', 'star24', 'star32']) {
      const geom = PRESET_GEOMS.get(n)!;
      const h = geom.h!;
      expect(h.length, n).toBe(9);
      expect(geom.k[h[6]! - 40], n).toBe(50000);
      expect(geom.k[h[5]! - 40], n).toBe(0);
      expect(geom.a[h[4]!], n).toBe('adj');
    }
  });

  it('knows the four built-ins the presets use beyond ECMA-376', () => {
    const notes = newGeomNotes();
    compileGeom(
      {
        gd: [
          ['x', 'val wd12'],
          ['y', 'val hd10'],
          ['z', 'val cd3'],
          ['u', 'val wd32'],
        ],
      },
      notes,
    );
    expect(notes.count).toBe(0);
  });
});
