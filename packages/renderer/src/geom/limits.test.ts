import { readFileSync } from 'node:fs';
import { GeomFile, ShapeGeom } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { BAKE_MAX_OBJECTS, CLAMP } from '../clamp.ts';
import { compileGeom, type GeomSource, newGeomNotes, type PathCmdSource } from './compile.ts';
import { CMD_LINE, CMD_MOVE, GEOM_CLAMP, GEOM_COMPILE, GEOM_LIMITS, GEOM_READ, GEOM_STORE } from './ops.ts';
import { buildGeom } from './path.ts';

/*
 * The geometry limits of the screens and the store, pinned (design/29 section 3, the owner's Q53: no limit is
 * raised). The split of GEOM_LIMITS into one name per use (read, compile, store, clamp) lets a caller that
 * READS a wide outline (the converter, for a picture of it) pass its own numbers to `compileGeom` and
 * `buildGeom` without touching what the store keeps or the screens draw. Every number below is today's.
 */

const WIDE = { points: 262_144, paths: 64 } as const;

/** A path of `n` points: one moveTo and n - 1 lnTo, in a 1000 x 1000 path space. */
function zigzag(n: number): PathCmdSource[] {
  const cmds: PathCmdSource[] = [{ op: 'moveTo', args: ['0', '0'] }];
  for (let i = 1; i < n; i++) cmds.push({ op: 'lnTo', args: [String(i % 1000), String((i * 7) % 1000)] });
  return cmds;
}

function sourceOf(paths: PathCmdSource[][]): GeomSource {
  return {
    paths: paths.map((cmds) => ({ w: '1000', h: '1000', cmds })),
  } as unknown as GeomSource;
}

/** Text of a source file of another package (read only; the renderer does not depend on that package). */
function constant(file: string, name: string): number {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8');
  const hit = new RegExp(`export const ${name} = ([0-9_]+);`).exec(text);
  if (!hit) throw new Error(`${name} not found in ${file}`);
  return Number(hit[1]!.replaceAll('_', ''));
}

describe('geometry limits (RM-L1: the numbers that stay)', () => {
  it("GEOM_LIMITS holds today's numbers", () => {
    expect(GEOM_LIMITS).toEqual({
      guides: 256,
      paths: 8,
      points: 4096,
      handles: 32,
      sites: 64,
      name: 256,
      formula: 1024,
      value: 1e60,
      pathSpace: 1e9,
    });
  });

  it('the stored shape geometry keeps at most 8 paths and a geometry file 64', () => {
    const path = { d: 'M 0 0 L 1 1', w: 1, h: 1 };
    const paths = (n: number) => Array.from({ length: n }, () => path);
    expect(ShapeGeom.safeParse({ paths: paths(8) }).success).toBe(true);
    expect(ShapeGeom.safeParse({ paths: paths(9) }).success).toBe(false);
    expect(GeomFile.safeParse({ paths: paths(64) }).success).toBe(true);
    expect(GeomFile.safeParse({ paths: paths(65) }).success).toBe(false);
  });

  it("the converter's slide total and path text bounds stay", () => {
    expect(constant('../../../pptx-scene/src/geom.ts', 'MAX_SLIDE_PATH_POINTS')).toBe(65_536);
    expect(constant('../../../pptx-scene/src/geom.ts', 'MAX_PATH_CHARS')).toBe(40_000);
  });

  it("the screens' object, picture and cue bounds and the bake bound stay", () => {
    expect(CLAMP.maxObjects).toBe(200);
    expect(CLAMP.maxImagesPerSlide).toBe(16);
    expect(CLAMP.maxCueBitmapBytes).toBe(192 * 1024 * 1024);
    expect(BAKE_MAX_OBJECTS).toBe(20_000);
  });
});

describe('the split of GEOM_LIMITS (RM-L2)', () => {
  it('read, compile, store and clamp each equal GEOM_LIMITS, key by key', () => {
    for (const [name, split] of [
      ['GEOM_READ', GEOM_READ],
      ['GEOM_COMPILE', GEOM_COMPILE],
      ['GEOM_STORE', GEOM_STORE],
      ['GEOM_CLAMP', GEOM_CLAMP],
    ] as const) {
      expect(Object.keys(split).sort(), name).toEqual(Object.keys(GEOM_LIMITS).sort());
      for (const key of Object.keys(GEOM_LIMITS) as (keyof typeof GEOM_LIMITS)[])
        expect(split[key], `${name}.${key}`).toBe(GEOM_LIMITS[key]);
    }
  });
});

describe('the optional limits of compileGeom and buildGeom (RM-L3 to RM-L5)', () => {
  it('RM-L3: a 45,056-point path is kept whole by compile and build with the wide limits', () => {
    const n = 45_056;
    const notes = newGeomNotes();
    const compiled = compileGeom(sourceOf([zigzag(n)]), notes, WIDE);
    expect(notes.messages).toEqual([]);
    const built = buildGeom(compiled, 1000, 1000, undefined, notes, WIDE);
    expect(notes.messages).toEqual([]);
    expect(built.paths).toHaveLength(1);
    expect(built.paths[0]!.cmds).toHaveLength(n);
    expect(built.paths[0]!.cmds[0]).toBe(CMD_MOVE);
    expect(built.paths[0]!.cmds[n - 1]).toBe(CMD_LINE);
    expect(built.paths[0]!.pts).toHaveLength(2 * n);
  });

  it("RM-L4: with no limits both still note 'path points over the limit dropped' and cut at 4,096", () => {
    const n = 45_056;
    const compileNotes = newGeomNotes();
    const cut = compileGeom(sourceOf([zigzag(n)]), compileNotes);
    expect(compileNotes.messages).toContain('path points over the limit dropped');
    expect(buildGeom(cut, 1000, 1000).paths[0]!.cmds).toHaveLength(4096);

    // A geometry compiled WIDE and built with none: the builder enforces the same number a second time.
    const wide = compileGeom(sourceOf([zigzag(n)]), undefined, WIDE);
    const buildNotes = newGeomNotes();
    const built = buildGeom(wide, 1000, 1000, undefined, buildNotes);
    expect(buildNotes.messages).toContain('path points over the limit dropped');
    expect(built.paths[0]!.cmds).toHaveLength(4096);
    expect(built.paths[0]!.pts).toHaveLength(2 * 4096);
  });

  it('RM-L5: the ninth path is kept with paths 64 and dropped without it, at both', () => {
    const nine = Array.from({ length: 9 }, () => zigzag(5));
    const dropped = newGeomNotes();
    const compiled = compileGeom(sourceOf(nine), dropped);
    expect(dropped.messages).toContain('1 paths over the limit dropped');
    expect(compiled.p).toHaveLength(8);

    const wide = compileGeom(sourceOf(nine), undefined, WIDE);
    expect(wide.p).toHaveLength(9);
    const buildNotes = newGeomNotes();
    expect(buildGeom(wide, 1000, 1000, undefined, buildNotes).paths).toHaveLength(8);
    expect(buildNotes.messages).toContain('1 paths over the limit dropped');
    const keptNotes = newGeomNotes();
    expect(buildGeom(wide, 1000, 1000, undefined, keptNotes, WIDE).paths).toHaveLength(9);
    expect(keptNotes.messages).toEqual([]);
  });

  it('the limits are read only when given: an empty object changes nothing', () => {
    const src = sourceOf([zigzag(5000)]);
    const a = compileGeom(src);
    const b = compileGeom(src, undefined, {});
    expect(b).toEqual(a);
    expect(buildGeom(b, 1000, 1000, undefined, undefined, {})).toEqual(buildGeom(a, 1000, 1000));
  });

  it('a limit that is not a positive whole number is ignored (the default holds)', () => {
    const src = sourceOf([zigzag(5000)]);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const compiled = compileGeom(src, undefined, { points: bad, paths: bad });
      // 4,096 commands of 3 numbers each (an op and its x y).
      expect(compiled.p[0]!.c.length, String(bad)).toBe(4096 * 3);
      const built = buildGeom(compiled, 1000, 1000, undefined, undefined, { points: bad, paths: bad });
      expect(built.paths[0]!.cmds.length, String(bad)).toBe(4096);
    }
  });
});
