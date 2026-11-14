import { describe, expect, it } from 'vitest';
import {
  asciiTrim,
  compileGeom,
  formulaTokens,
  type GeomSource,
  newGeomNotes,
  numberToken,
  type PathCmdSource,
} from './compile.ts';
import { evalGuides, guideSlot } from './eval.ts';
import {
  BUILTIN_COUNT,
  CMD_ARC,
  CMD_CLOSE,
  CMD_CUBIC,
  CMD_LINE,
  CMD_MOVE,
  CMD_QUAD,
  GEOM_LIMITS,
  HANDLE_POLAR,
  HANDLE_XY,
  PATH_FILLS,
  SLOT_B,
  SLOT_L,
  SLOT_R,
  SLOT_T,
} from './ops.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const B = BUILTIN_COUNT;
const slotOf = (name: string): number => guideSlot({ k: [], a: [], g: [], n: [], r: [], p: [] }, name);

describe('tokens', () => {
  it('reads plain decimals only', () => {
    expect(numberToken('21600000')).toBe(21_600_000);
    expect(numberToken('-2147483647')).toBe(-2_147_483_647);
    expect(numberToken('1.5e3')).toBe(1500);
    for (const t of ['NaN', 'Infinity', '0x1A', '1f', '', ' 1', '1 ', 'e5', '1e5.5'])
      expect(numberToken(t), t).toBeUndefined();
    expect(numberToken('9'.repeat(65))).toBeUndefined();
  });

  it('splits a formula into at most four tokens', () => {
    expect(formulaTokens('*/ w adj 100000 extra more')).toEqual(['*/', 'w', 'adj', '100000']);
    expect(formulaTokens('\t+-  a\r\nb c ')).toEqual(['+-', 'a', 'b', 'c']);
    expect(formulaTokens('x'.repeat(GEOM_LIMITS.formula + 1))).toEqual([]);
  });
});

describe('guides', () => {
  it('numbers constants after the built-ins and guides after the constants, adjust values first', () => {
    const g = compileGeom({
      av: [['adj', 'val 25000']],
      gd: [
        ['a', 'pin 0 adj 50000'],
        ['x1', '*/ ss a 100000'],
      ],
    });
    expect(g.k).toEqual([25000, 0, 50000, 100000]);
    expect(g.a).toEqual(['adj']);
    expect(g.n).toEqual(['a', 'x1']);
    const adj = B + 4;
    expect(g.g).toEqual([16, B, 0, 0, 11, B + 1, adj, B + 2, 0, slotOf('ss'), adj + 1, B + 3]);
    expect(Array.from(evalGuides(g, { w: 200, h: 100 }).slice(adj))).toEqual([25000, 25000, 25]);
  });

  it('dedupes constants, −0 included', () => {
    const g = compileGeom({
      gd: [
        ['x', '+- 5 -0 0'],
        ['y', '+- 5 5.0 0'],
      ],
    });
    expect(g.k).toEqual([5, 0]);
  });

  it('notes what it replaced by 0, cut and at most 32 distinct messages', () => {
    const notes = newGeomNotes();
    const gd: [string, string][] = [];
    for (let i = 0; i < 100; i++) gd.push([`g${i}`, `val missing${i % 50}`]);
    gd.push(['ctl', 'val a\u0007b'], ['ctl2', `val ${'z'.repeat(100)}`]);
    compileGeom({ gd }, notes);
    expect(notes.count).toBe(102);
    expect(notes.messages.length).toBe(32);
    const n2 = newGeomNotes();
    compileGeom(
      {
        gd: [
          ['x', 'val a\u0007b'],
          ['y', `val ${'z'.repeat(100)}`],
        ],
      },
      n2,
    );
    expect(n2.messages).toEqual([
      `unknown name 'a?b' in guide 'x'`,
      `unknown name '${'z'.repeat(40)}…' in guide 'y'`,
    ]);
  });
});

describe('text rect', () => {
  it('defaults each absent edge to the box edge', () => {
    expect(compileGeom({}).r).toEqual([SLOT_L, SLOT_T, SLOT_R, SLOT_B]);
    const g = compileGeom({ gd: [['il', 'val 3']], rect: { l: 'il', b: '7' } });
    expect(g.r).toEqual([B + 2, SLOT_T, SLOT_R, B + 1]);
  });

  it('resolves to the final definition of a name', () => {
    const g = compileGeom({
      gd: [
        ['x', 'val 1'],
        ['x', 'val 2'],
      ],
      rect: { l: 'x' },
    });
    expect(evalGuides(g, { w: 10, h: 10 })[g.r[0]!]).toBe(2);
  });
});

describe('paths', () => {
  const cmd = (op: string, ...args: string[]): PathCmdSource => ({ op, args });

  it('compiles every command with its operands as slots', () => {
    const g = compileGeom({
      gd: [['x1', 'val 5']],
      paths: [
        {
          cmds: [
            cmd('moveTo', 'l', 't'),
            cmd('lnTo', 'x1', '10'),
            cmd('arcTo', 'wd2', 'hd2', 'cd2', '-5400000'),
            cmd('quadBezTo', '1', '2', '3', '4'),
            cmd('cubicBezTo', 'r', 'b', 'hc', 'vc', 'x1', 'x1'),
            cmd('close'),
          ],
        },
      ],
    });
    const k = (v: number): number => B + g.k.indexOf(v);
    const x1 = B + g.k.length;
    expect(g.p).toEqual([
      {
        c: [
          CMD_MOVE,
          SLOT_L,
          SLOT_T,
          CMD_LINE,
          x1,
          k(10),
          CMD_ARC,
          slotOf('wd2'),
          slotOf('hd2'),
          slotOf('cd2'),
          k(-5_400_000),
          CMD_QUAD,
          k(1),
          k(2),
          k(3),
          k(4),
          CMD_CUBIC,
          SLOT_R,
          SLOT_B,
          slotOf('hc'),
          slotOf('vc'),
          x1,
          x1,
          CMD_CLOSE,
        ],
      },
    ]);
  });

  it('keeps path attributes, defaults omitted', () => {
    const paths = [
      { w: '21600', h: '43200', fill: 'darkenLess', stroke: 'false', extrusionOk: '0', cmds: [] },
      { fill: 'norm', stroke: '1', extrusionOk: 'true', cmds: [] },
      { w: '-5', h: '1e12', fill: 'sparkle', stroke: 'maybe', cmds: [] },
      { w: 'w', h: '0', fill: 'none', cmds: [] },
    ];
    const notes = newGeomNotes();
    const g = compileGeom({ paths }, notes);
    expect(g.p).toEqual([
      { w: 21600, h: 43200, f: PATH_FILLS.indexOf('darkenLess'), s: 0, e: 0, c: [] },
      { c: [] },
      { h: GEOM_LIMITS.pathSpace, c: [] },
      { f: 1, c: [] },
    ]);
    expect(notes.messages).toEqual(["unknown path fill 'sparkle' read as norm"]);
  });

  it('drops unknown commands and gives missing operands 0', () => {
    const notes = newGeomNotes();
    const g = compileGeom(
      { paths: [{ cmds: [cmd('arcTo', 'w'), cmd('lineTo', '1', '2'), cmd('close', 'x')] }] },
      notes,
    );
    const zero = B + g.k.indexOf(0);
    expect(g.p[0]!.c).toEqual([CMD_ARC, slotOf('w'), zero, zero, zero, CMD_CLOSE]);
    expect(notes.messages).toEqual(["unknown path command 'lineTo' dropped"]);
  });

  it('keeps at most 4,096 points per path, an arc counting 12, and at most 8 paths', () => {
    const lines: PathCmdSource[] = [cmd('moveTo', '0', '0')];
    for (let i = 0; i < 10_000; i++) lines.push(cmd('lnTo', String(i), '1'));
    const arcs: PathCmdSource[] = [];
    for (let i = 0; i < 1000; i++) arcs.push(cmd('arcTo', '1', '1', '0', '21600000'));
    const closes: PathCmdSource[] = [];
    for (let i = 0; i < 100_000; i++) closes.push(cmd(i % 2 ? 'close' : 'bogus'));
    const notes = newGeomNotes();
    const src: GeomSource = {
      paths: [{ cmds: lines }, { cmds: arcs }, { cmds: closes }, ...Array(9).fill({ cmds: [] })],
    };
    const g = compileGeom(src, notes);
    expect(g.p.length).toBe(GEOM_LIMITS.paths);
    expect(g.p[0]!.c.length).toBe(GEOM_LIMITS.points * 3);
    expect(g.p[1]!.c.length).toBe(Math.floor(GEOM_LIMITS.points / 12) * 5);
    expect(g.p[2]!.c.length).toBe(GEOM_LIMITS.points / 2);
    expect(notes.messages).toContain('path points over the limit dropped');
    expect(notes.messages).toContain('4 paths over the limit dropped');
    // The constants stay few: each distinct number is one slot.
    expect(g.k.length).toBeLessThan(4200);
  });
});

describe('handles and connection sites', () => {
  it('encodes xy and polar handles: kind, refs as adjust indices, bounds as slots (−1 absent)', () => {
    const g = compileGeom({
      av: [
        ['adj1', 'val 1'],
        ['adj2', 'val 2'],
      ],
      gd: [['x1', 'val 3']],
      handles: [
        { kind: 'xy', gdRefX: 'adj2', minX: '0', maxX: 'w', x: 'x1', y: 'vc' },
        {
          kind: 'polar',
          gdRefR: 'adj1',
          minR: '0',
          maxR: '50000',
          gdRefAng: 'x1',
          minAng: '0',
          x: 'hc',
          y: 't',
        },
      ],
    });
    const k = (v: number): number => B + g.k.indexOf(v);
    const x1 = B + g.k.length + 2;
    expect(g.h).toEqual([
      HANDLE_XY,
      1,
      k(0),
      slotOf('w'),
      -1,
      -1,
      -1,
      x1,
      slotOf('vc'),
      HANDLE_POLAR,
      0,
      k(0),
      k(50000),
      -1,
      k(0),
      -1,
      slotOf('hc'),
      SLOT_T,
    ]);
  });

  it('bounds handles and sites', () => {
    const notes = newGeomNotes();
    const handles = Array.from({ length: 40 }, () => ({ kind: 'xy' as const, x: 'l', y: 't' }));
    const sites = Array.from({ length: 70 }, () => ({ ang: 'cd4', x: 'hc', y: 'b' }));
    const g = compileGeom({ handles, sites }, notes);
    expect(g.h!.length).toBe(GEOM_LIMITS.handles * 9);
    expect(g.c!.length).toBe(GEOM_LIMITS.sites * 3);
    expect(g.c!.slice(0, 3)).toEqual([slotOf('cd4'), slotOf('hc'), SLOT_B]);
    expect(notes.messages).toEqual([
      '8 handles over the limit dropped',
      '6 connection sites over the limit dropped',
    ]);
  });

  it('omits empty handle and site lists', () => {
    const g = compileGeom({ handles: [], sites: [] });
    expect('h' in g).toBe(false);
    expect('c' in g).toBe(false);
  });
});

describe('untrusted text', () => {
  it('trims and tokenises in linear time', () => {
    const spaces = ' '.repeat(2_000_000);
    const t0 = performance.now();
    expect(asciiTrim(`${spaces}x${spaces}y${spaces}`)).toBe(`x${spaces}y`);
    const g = compileGeom({
      rect: { l: `${spaces}5${spaces}`, t: `${spaces}x${spaces}` },
      paths: [{ w: `${spaces}9`, cmds: [] }],
    });
    expect(g.k).toEqual([5, 0]);
    expect(g.p[0]!.w).toBe(9);
    expect(formulaTokens(`val ${spaces}`)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(budgetMs(2000));
  });
});
