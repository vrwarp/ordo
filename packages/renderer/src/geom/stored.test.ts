import { GEOM_FILE_MAX_BYTES } from '@ordo/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { traceUnionPath, UNION_NESTING_LIMIT, UNION_NESTING_WORK } from './draw.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE } from './ops.ts';
import { presetGeometry } from './path.ts';
import { RecPath } from './path2d.test-util.ts';
import {
  clearGeomFiles,
  GEOM_FILE_RETRY_MS,
  GEOM_FILES_CHARS,
  GEOM_FILES_MAX,
  geomFile,
  geomPending,
  legacyGeometry,
  putGeomFile,
  readGeomFiles,
  resolvedGeom,
  storedGeometry,
} from './stored.ts';

/** Stored geometries (design/27 §3.1 ShapeGeom): presets by name, re-tokenised paths, the legacy shapes. */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterAll(() => vi.unstubAllGlobals());

describe('storedGeometry', () => {
  it('evaluates a preset at the box with the stored adjust pairs', () => {
    const g = storedGeometry({ preset: 'roundRect', adj: [['adj', 50_000]] }, 200, 100)!;
    expect(g).toEqual(presetGeometry('roundRect', 200, 100, [['adj', 50_000]]));
  });

  it('scales stored paths from their own space and keeps their fill mode and stroke flag', () => {
    const g = storedGeometry(
      {
        paths: [
          { d: 'M 0 0 L 10 0 L 10 10 Z', w: 10, h: 10, fill: 'darken', stroke: false },
          { d: 'M 1 2 C 3 4 5 6 7 8', w: 0, h: 0 },
        ],
      },
      300,
      200,
    )!;
    expect(g.paths[0]).toEqual({
      cmds: [CMD_MOVE, CMD_LINE, CMD_LINE, CMD_CLOSE],
      pts: [0, 0, 300, 0, 300, 200],
      fill: 'darken',
      stroke: false,
    });
    // A side of 0: the box's own units.
    expect(g.paths[1]).toMatchObject({
      cmds: [CMD_MOVE, CMD_CUBIC],
      pts: [1, 2, 3, 4, 5, 6, 7, 8],
      fill: 'norm',
    });
    expect(g.paths[1]!.stroke).toBe(true);
    expect(g.text).toEqual({ l: 0, t: 0, r: 300, b: 200 });
  });

  it('prefers a known preset over paths, falls back to paths for an unknown one, else undefined', () => {
    const paths = [{ d: 'M 0 0 L 1 1', w: 1, h: 1 }];
    expect(storedGeometry({ preset: 'ellipse', paths }, 10, 10)).toEqual(presetGeometry('ellipse', 10, 10));
    expect(storedGeometry({ preset: 'noSuchPreset', paths }, 10, 10)!.paths[0]!.pts).toEqual([0, 0, 10, 10]);
    expect(storedGeometry({ preset: 'noSuchPreset' }, 10, 10)).toBeUndefined();
    expect(storedGeometry(undefined, 10, 10)).toBeUndefined();
  });

  it('never draws a stored string as it is: only re-tokenised M L Q C Z', () => {
    const g = storedGeometry({ paths: [{ d: 'M 0 0 L 5 5 A 1 1 0 0 1 9 9 L 7 7', w: 0, h: 0 }] }, 10, 10)!;
    expect(g.paths[0]!.cmds).toEqual([CMD_MOVE, CMD_LINE]);
  });

  it('joins a path marked cont to the one before it: one path, in the first piece’s fill and stroke', () => {
    const g = storedGeometry(
      {
        paths: [
          { d: 'M 0 0 L 10 0 L 10 10 L 0 10 Z', w: 10, h: 10, fill: 'darken', stroke: false },
          // A hole, stored in a piece of its own; then the rest of an outline cut between two commands.
          { d: 'M 2 2 L 2 8 L 8 8 Z M 0 20 L 5 20', w: 10, h: 10, fill: 'norm', cont: true },
          { d: 'L 5 25 Z', w: 20, h: 20, cont: true },
          { d: 'M 0 0 L 1 1', w: 1, h: 1 },
        ],
      },
      100,
      100,
    )!;
    expect(g.paths).toHaveLength(2);
    expect(g.paths[0]).toEqual({
      cmds: [
        ...[CMD_MOVE, CMD_LINE, CMD_LINE, CMD_LINE, CMD_CLOSE],
        ...[CMD_MOVE, CMD_LINE, CMD_LINE, CMD_CLOSE, CMD_MOVE, CMD_LINE],
        ...[CMD_LINE, CMD_CLOSE],
      ],
      // Each piece scaled from its own space.
      pts: [0, 0, 100, 0, 100, 100, 0, 100, 20, 20, 20, 80, 80, 80, 0, 200, 50, 200, 25, 125],
      fill: 'darken',
      stroke: false,
    });
    expect(g.paths[1]!.pts).toEqual([0, 0, 100, 100]);
    // cont on the first path means nothing.
    const first = storedGeometry({ paths: [{ d: 'M 0 0 L 1 1', w: 1, h: 1, cont: true }] }, 10, 10)!;
    expect(first.paths).toHaveLength(1);
  });

  it('memoises per geometry object and box', () => {
    const geom = { preset: 'star5' };
    expect(storedGeometry(geom, 100, 100)).toBe(storedGeometry(geom, 100, 100));
    expect(storedGeometry(geom, 100, 50)).not.toBe(storedGeometry(geom, 100, 100));
  });
});

describe('legacyGeometry', () => {
  it('is the rect, a roundRect of the radius (capped at half the shorter side), the ellipse or a mid line', () => {
    expect(legacyGeometry('rect', 0, 100, 50)).toEqual(presetGeometry('rect', 100, 50));
    expect(legacyGeometry('rect', 10, 100, 50)).toEqual(
      presetGeometry('roundRect', 100, 50, [['adj', 20_000]]),
    );
    expect(legacyGeometry('rect', 999, 100, 50)).toEqual(
      presetGeometry('roundRect', 100, 50, [['adj', 50_000]]),
    );
    expect(legacyGeometry('ellipse', 0, 100, 50)).toEqual(presetGeometry('ellipse', 100, 50));
    const l = legacyGeometry('line', 0, 100, 50);
    expect(l.paths).toEqual([
      { cmds: [CMD_MOVE, CMD_LINE], pts: [0, 25, 100, 25], fill: 'none', stroke: true },
    ]);
  });
});

describe('traceUnionPath', () => {
  const square = (a: number, b: number, reverse = false) =>
    reverse ? [a, a, a, b, b, b, b, a] : [a, a, b, a, b, b, a, b];
  const rings = (...subs: number[][]) => ({
    cmds: subs.flatMap((s) => [CMD_MOVE, ...Array(s.length / 2 - 1).fill(CMD_LINE), CMD_CLOSE]),
    pts: subs.flat(),
    fill: 'norm' as const,
    stroke: true,
  });
  /** Signed area of each traced sub-path (positive: the outline's direction, negative: a hole's). */
  const areas = (p: RecPath) => {
    const out: number[] = [];
    let pts: [number, number][] = [];
    for (const op of p.ops) {
      if (op.startsWith('M')) pts = [];
      if (op === 'Z') {
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
          const [x0, y0] = pts[i]!;
          const [x1, y1] = pts[(i + 1) % pts.length]!;
          a += x0 * y1 - x1 * y0;
        }
        out.push(Math.sign(a));
      } else pts.push(op.split(' ').slice(-2).map(Number) as [number, number]);
    }
    return out;
  };

  it('winds outlines one way and holes the other, whichever way they were traced', () => {
    const p = new RecPath();
    traceUnionPath(p, rings(square(0, 100), square(25, 75), square(40, 60, true)));
    // Depth 0, 1, 2: outline, hole, island.
    expect(areas(p)).toEqual([1, -1, 1]);
    const q = new RecPath();
    traceUnionPath(q, rings(square(0, 100, true), square(25, 75, true)));
    expect(areas(q)).toEqual([1, -1]);
  });

  it('turns a traced-backwards curve into the same curve the other way round', () => {
    const p = new RecPath();
    traceUnionPath(p, {
      cmds: [CMD_MOVE, CMD_CUBIC, CMD_LINE, CMD_CLOSE],
      pts: [0, 0, 0, 50, 100, 50, 100, 0, 50, -50],
      fill: 'norm',
      stroke: true,
    });
    // The sub-path was clockwise in y-down space as given; traced again it ends where it began.
    expect(p.ops[0]).toMatch(/^M /);
    expect(p.ops.at(-1)).toBe('Z');
    expect(p.ops).toHaveLength(4);
  });

  it('works out the nesting of an outline holding hundreds of holes, within a bound of work', () => {
    // An outline with 300 holes (a traced decoration): every hole winds against the outline.
    const holes = Array.from({ length: 300 }, (_, i) => {
      const x = 10 + (i % 20) * 49;
      const y = 10 + Math.floor(i / 20) * 49;
      return square(x, x + 20).map((v, k) => (k % 2 ? v - x + y : v));
    });
    const p = new RecPath();
    traceUnionPath(p, rings(square(0, 1000), ...holes));
    const a = areas(p);
    expect(a[0]).toBe(1);
    expect(a.slice(1).every((v) => v === -1)).toBe(true);
    expect(a).toHaveLength(301);
    // Past UNION_NESTING_WORK edges tested, nesting is not worked out: every sub-path is an outline.
    const big = Array.from({ length: 1 + Math.ceil(UNION_NESTING_WORK / 4_000) }, (_, i) =>
      i === 0
        ? Array.from({ length: 4_000 }, (_, k) => [
            500 + 500 * Math.cos((2 * Math.PI * k) / 4_000),
            500 + 500 * Math.sin((2 * Math.PI * k) / 4_000),
          ]).flat()
        : square(400 + (i % 100), 401 + (i % 100)),
    );
    expect(big.length).toBeLessThanOrEqual(UNION_NESTING_LIMIT);
    const t0 = performance.now();
    const q = new RecPath();
    traceUnionPath(q, rings(...big));
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(new Set(areas(q))).toEqual(new Set([1]));
  });

  it('keeps the overlapping paths of smileyFace a union (its eyes inside its face)', () => {
    const g = presetGeometry('smileyFace', 300, 300)!;
    const filled = g.paths.filter((x) => x.fill !== 'none');
    expect(filled.length).toBe(2);
    const p = new RecPath();
    for (const path of filled) traceUnionPath(p, path);
    // Every closed outline of both paths winds the same way: their non-zero fill is the face, eyes kept.
    expect(new Set(areas(p))).toEqual(new Set([1]));
  });
});

describe('geometry files (ShapeGeom.ref, M6 round 2)', () => {
  const file = { paths: [{ d: 'M 0 0 L 10 0 L 10 10 Z', w: 10, h: 10 }] };
  const ref = 'a'.repeat(64);
  beforeEach(() => clearGeomFiles());

  it("draws a read file's paths, the geometry beside the ref until then", () => {
    const g = { ref, preset: 'ellipse' };
    expect(geomPending(g)).toBe(true);
    expect(storedGeometry(g, 100, 50)).toEqual(presetGeometry('ellipse', 100, 50));
    expect(storedGeometry({ ref }, 100, 50)).toBeUndefined();
    expect(putGeomFile(ref, file)).toBe(true);
    expect(geomPending(g)).toBe(false);
    expect(resolvedGeom(g)).toEqual(file);
    const built = storedGeometry(g, 100, 50)!;
    expect(built.paths[0]!.pts).toEqual([0, 0, 100, 0, 100, 50]);
    // Every shape naming the file shares its built geometry, per box size.
    expect(storedGeometry({ ref }, 100, 50)).toBe(built);
    const small = storedGeometry({ ref }, 10, 5)!;
    expect(small.paths[0]!.pts).toEqual([0, 0, 10, 0, 10, 5]);
    expect(storedGeometry({ ref, paths: [] }, 100, 50)).toBe(built);
  });

  it('keeps of a file only what inline paths keep (re-tokenised), and nothing of a file that is not one', () => {
    expect(putGeomFile(ref, { paths: [{ d: 'M 0 0 L 1 1 <script>', w: 1, h: 1 }], extra: 1 })).toBe(true);
    expect(geomFile(ref)).toEqual({ paths: [{ d: 'M 0 0 L 1 1', w: 1, h: 1 }] });
    expect(putGeomFile('b'.repeat(64), { paths: 'M 0 0' })).toBe(false);
    expect(putGeomFile('b'.repeat(64), [1, 2])).toBe(false);
    expect(putGeomFile('', file)).toBe(false);
    expect(putGeomFile('x'.repeat(101), file)).toBe(false);
  });

  it('keeps at most GEOM_FILES_MAX files and GEOM_FILES_CHARS of path text, least recently read first out', () => {
    const big = 'M 0 0 '.repeat(4_000).trim();
    for (let i = 0; i < GEOM_FILES_MAX + 10; i++)
      putGeomFile(`f${i}`, { paths: [{ d: 'M 0 0 L 1 1', w: 1, h: 1 }] });
    expect(geomFile('f0')).toBeUndefined();
    expect(geomFile(`f${GEOM_FILES_MAX + 9}`)).toBeDefined();
    clearGeomFiles();
    const n = Math.ceil(GEOM_FILES_CHARS / big.length) + 5;
    for (let i = 0; i < n; i++) putGeomFile(`g${i}`, { paths: [{ d: big, w: 1, h: 1 }] });
    expect(geomFile('g0')).toBeUndefined();
    expect(geomFile(`g${n - 1}`)).toBeDefined();
  });

  it('reads each file once, says which could not be read, and asks again for a failed one only later', async () => {
    let t = 1_000;
    const asked: string[] = [];
    const texts = new Map<string, string | null>([
      ['ok', JSON.stringify(file)],
      ['bad', '{"paths":'],
      ['big', JSON.stringify({ paths: [{ d: 'M 0 0'.padEnd(GEOM_FILE_MAX_BYTES + 10, ' '), w: 1, h: 1 }] })],
      ['null', null],
    ]);
    const read = async (r: string) => {
      asked.push(r);
      if (r === 'gone') throw new Error('404');
      return texts.get(r);
    };
    const r1 = await readGeomFiles(['ok', 'ok', 'bad', 'big', 'null', 'gone', 'none'], read, () => t);
    expect(Object.fromEntries(r1)).toEqual({
      bad: 'invalid',
      big: 'invalid',
      null: 'invalid',
      gone: 'missing',
      none: 'missing',
    });
    expect(asked.filter((a) => a === 'ok')).toHaveLength(1);
    expect(geomFile('ok')).toEqual(file);
    // Read already: not asked again; failed: not asked again within GEOM_FILE_RETRY_MS.
    asked.length = 0;
    expect((await readGeomFiles(['ok', 'gone'], read, () => t)).get('gone')).toBe('missing');
    expect(asked).toEqual([]);
    t += GEOM_FILE_RETRY_MS;
    texts.set('gone', JSON.stringify(file));
    const r3 = await readGeomFiles(
      ['gone'],
      async (r) => texts.get(r),
      () => t,
    );
    expect(r3.size).toBe(0);
    expect(geomFile('gone')).toEqual(file);
  });

  it('shares a read in flight between callers', async () => {
    let calls = 0;
    let release: (s: string) => void = () => {};
    const read = () => {
      calls++;
      return new Promise<string>((res) => {
        release = res;
      });
    };
    const a = readGeomFiles([ref], read);
    const b = readGeomFiles([ref], read);
    release(JSON.stringify(file));
    expect((await a).size).toBe(0);
    expect((await b).size).toBe(0);
    expect(calls).toBe(1);
  });
});
