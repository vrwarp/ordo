import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { customPaths } from './geom.ts';
import {
  base64,
  canonicalBytes,
  canonicalJson,
  encodePath,
  encodeRefs,
  hashOfBytes,
  RASTER_CANDIDATES_MAX,
  RASTER_DENSITY,
  RASTER_MAX_PICTURES,
  RASTER_MAY_HOLD,
  RASTER_POINTS,
  RASTER_PREFIX,
  RASTER_READ,
  RASTER_RECIPE_BYTES,
  RASTER_REFS_MAX,
  RASTER_RUN,
  RASTER_SLIDE_PIXELS,
  RASTER_VERSION,
  RASTER_WORDS_MAX,
  type RasterRecipe,
  rasterPlaceholder,
  rawPointCost,
  recipeHash,
  sha256,
} from './raster.ts';
import { custGeom } from './test-util.ts';
import { MAX_PACKED_ELEMENTS_PER_PART, MAX_PACKED_PATH_ITEMS_PER_PART, parseXml, type XNode } from './xml.ts';

/** An `a:custGeom` node from the paths' XML. */
function geom(paths: string, packed = false): XNode {
  const pack = packed
    ? { maxElements: MAX_PACKED_ELEMENTS_PER_PART, maxPathItems: MAX_PACKED_PATH_ITEMS_PER_PART }
    : undefined;
  return parseXml(custGeom({ paths }), 'raster.test', pack ? { pack } : undefined)[0]!;
}

const pt = (x: number, y: number) => `<a:pt x="${x}" y="${y}"/>`;
const move = (x: number, y: number) => `<a:moveTo>${pt(x, y)}</a:moveTo>`;
const line = (x: number, y: number) => `<a:lnTo>${pt(x, y)}</a:lnTo>`;
const quad = `<a:quadBezTo>${pt(60, 0)}${pt(100, 40)}</a:quadBezTo>`;
const cubic = `<a:cubicBezTo>${pt(10, 50)}${pt(50, 90)}${pt(90, 20)}</a:cubicBezTo>`;
const arc = (sw = 21_600_000) => `<a:arcTo wR="40" hR="40" stAng="0" swAng="${sw}"/>`;
const close = '<a:close/>';

/** One `a:path` whose commands cost exactly `cost` (a moveTo, `cost - 2` lnTo, a close), in a 100 x 100 space. */
function polyPath(cost: number): string {
  let d = move(0, 0);
  for (let i = 1; i <= cost - 2; i++) d += line(i % 100, (i * 7) % 100);
  return `<a:path w="100" h="100">${d}${close}</a:path>`;
}

describe('the constants of the shape pictures (C-SR1)', () => {
  it('are the numbers the briefs and the owner name', () => {
    expect(RASTER_POINTS).toBe(128);
    expect(RASTER_VERSION).toBe(1);
    expect(RASTER_MAX_PICTURES).toBe(4);
    expect(RASTER_DENSITY).toBe(2);
    expect(RASTER_READ).toEqual({ pointsShape: 262_144, pointsSlide: 1_048_576 });
    expect(RASTER_WORDS_MAX).toBe(4_000);
    expect(RASTER_SLIDE_PIXELS).toBe(3 * 3840 * 2160);
    expect(RASTER_RECIPE_BYTES).toEqual({ call: 32 * 1024 * 1024, import: 128 * 1024 * 1024 });
    expect(RASTER_CANDIDATES_MAX).toBe(20_000);
    expect(RASTER_PREFIX).toBe('pptxmedia:raster');
  });

  it("keep the capability list frozen with only text on (the owner's Q53.i is still asked: default no)", () => {
    expect(RASTER_MAY_HOLD).toEqual({
      text: true,
      shadow: false,
      glow: false,
      softEdge: false,
      alphaGradient: false,
      pictureFill: false,
      threeD: false,
      pattern: false,
    });
    expect(Object.isFrozen(RASTER_MAY_HOLD)).toBe(true);
  });

  it("keep every run cap at or below the recipe validator's (R9, C-RM1)", () => {
    // The numbers of raster-maker's `checkRecipe`, copied: the planner must never make what it would refuse.
    const VALIDATOR = {
      members: 2_048,
      paths: 64,
      pointsMember: 262_144,
      points: 1_048_576,
      texts: 256,
      pixels: 3840 * 2160,
      bytes: 33_554_432,
    };
    for (const k of Object.keys(VALIDATOR) as (keyof typeof VALIDATOR)[])
      expect(RASTER_RUN[k], k).toBeLessThanOrEqual(VALIDATOR[k]);
    expect(RASTER_READ.pointsShape).toBeLessThanOrEqual(VALIDATOR.pointsMember);
    expect(RASTER_READ.pointsSlide).toBeLessThanOrEqual(VALIDATOR.points);
    expect(RASTER_RUN.pointsMember).toBe(RASTER_READ.pointsShape);
    expect(RASTER_RUN.points).toBe(RASTER_READ.pointsSlide);
  });
});

describe("rawPointCost: the converter's point cost over the commands the file holds (R1b, R1)", () => {
  it('R1b: its own copy of the cost table equals what the public customPaths reports when nothing is cut', () => {
    const cases: Record<string, string> = {
      'moveTo and lnTo': `<a:path w="100" h="100">${move(0, 0)}${line(50, 0)}${line(50, 50)}${line(0, 50)}</a:path>`,
      quadBezTo: `<a:path w="100" h="100">${move(0, 0)}${quad}</a:path>`,
      cubicBezTo: `<a:path w="100" h="100">${move(0, 0)}${cubic}</a:path>`,
      'a full-turn arcTo': `<a:path w="100" h="100">${move(50, 10)}${arc()}</a:path>`,
      close: `<a:path w="100" h="100">${move(0, 0)}${line(50, 0)}${line(50, 50)}${close}</a:path>`,
      'a mixture over two paths': `<a:path w="100" h="100">${move(0, 0)}${quad}${cubic}${close}</a:path><a:path w="100" h="100">${move(10, 10)}${line(20, 20)}${arc()}${close}</a:path>`,
    };
    for (const [name, paths] of Object.entries(cases)) {
      const node = geom(paths);
      const own = rawPointCost(node);
      const theirs = customPaths(node, 914_400, 914_400, 1 / 914_400);
      expect(theirs.over, name).toBeUndefined();
      expect(own.points, name).toBe(theirs.points);
    }
    // An arcTo is 12 whatever its sweep (the compiler's bound counts the full turn).
    expect(rawPointCost(geom(`<a:path>${move(0, 0)}${arc(5_400_000)}</a:path>`)).points).toBe(13);
    expect(rawPointCost(geom(`<a:path>${arc()}</a:path>`)).points).toBe(12);
  });

  it('R1: more than 128, strictly: 127, 128, 129 and 130 points; ten arcs are 120 and eleven 132', () => {
    const over = (n: number) => rawPointCost(geom(polyPath(n))).points > RASTER_POINTS;
    expect([127, 128, 129, 130].map((n) => rawPointCost(geom(polyPath(n))).points)).toEqual([
      127, 128, 129, 130,
    ]);
    expect([127, 128, 129, 130].map(over)).toEqual([false, false, true, true]);
    const arcs = (n: number) => geom(`<a:path>${arc().repeat(n)}</a:path>`);
    expect(rawPointCost(arcs(10)).points).toBe(120);
    expect(rawPointCost(arcs(11)).points).toBe(132);
    expect(rawPointCost(arcs(10)).points > RASTER_POINTS).toBe(false);
    expect(rawPointCost(arcs(11)).points > RASTER_POINTS).toBe(true);
  });

  it('R1: counts what the file holds BEFORE the 4,096 cut: a 45,056-point shape reads as over', () => {
    // 11 paths of 4,096 points: the converter's own count after its cuts says 4,114 (a path chain), the raw count 45,056.
    const node = geom(Array.from({ length: 11 }, () => polyPath(4_096)).join(''));
    const raw = rawPointCost(node);
    expect(raw).toEqual({ points: 45_056, capped: false, paths: 11 });
    expect(customPaths(node, 914_400, 914_400, 1 / 914_400).points).toBeLessThan(45_056);
    expect(raw.points > RASTER_POINTS).toBe(true);
  });

  it('R1: a shape of 8,000 sub-paths is counted over every sub-path', () => {
    let d = '';
    for (let i = 0; i < 8_000; i++)
      d += `${move(i % 100, 0)}${line(i % 100, 10)}${line((i + 5) % 100, 10)}${close}`;
    expect(rawPointCost(geom(`<a:path w="100" h="100">${d}</a:path>`)).points).toBe(32_000);
  });

  it('stops at the reading bound and says so (a hostile shape costs one pass to the bound)', () => {
    // Read as a real hub reads a big outline: packed (a node per command would pass the tag bound).
    const node = geom(`<a:path w="100" h="100">${move(0, 0)}${line(1, 1).repeat(300_000)}</a:path>`, true);
    const r = rawPointCost(node);
    expect(r.capped).toBe(true);
    expect(r.points).toBe(RASTER_READ.pointsShape + 1);
    // A small cap of its own stops earlier.
    expect(rawPointCost(node, 1_000)).toMatchObject({ capped: true, points: 1_001 });
    // The same node answers from its memo.
    expect(rawPointCost(node)).toBe(r);
  });

  it('never throws: no node, no path list, odd children and a hostile command name cost 0', () => {
    expect(rawPointCost(undefined)).toEqual({ points: 0, capped: false, paths: 0 });
    expect(rawPointCost(parseXml('<a:custGeom xmlns:a="x"/>', 'x')[0]!)).toEqual({
      points: 0,
      capped: false,
      paths: 0,
    });
    const odd = geom(`<a:path><a:constructor/><a:__proto__/><a:toString/>${move(0, 0)}<a:lnTo/></a:path>`);
    expect(rawPointCost(odd).points).toBe(2);
  });
});

describe('base64, SHA-256 and the canonical form (C-RM1)', () => {
  it('base64 is the standard alphabet with padding', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100, 1_000, 10_001]) {
      const b = randomBytes(n);
      expect(base64(new Uint8Array(b))).toBe(b.toString('base64'));
    }
  });

  it('encodePath writes one byte a command and little-endian float32 points', () => {
    const e = encodePath([0, 1, 1, 5], [0, 0, 10.5, 0, 10.5, 20]);
    expect(Buffer.from(e.cmds, 'base64')).toEqual(Buffer.from([0, 1, 1, 5]));
    const pts = Buffer.from(e.pts, 'base64');
    expect(pts.length).toBe(24);
    expect([0, 1, 2, 3, 4, 5].map((i) => pts.readFloatLE(i * 4))).toEqual([0, 0, 10.5, 0, 10.5, 20]);
    // A non-finite point cannot get into a recipe.
    expect(
      Buffer.from(encodePath([0], [Number.NaN, Number.POSITIVE_INFINITY]).pts, 'base64').readFloatLE(0),
    ).toBe(0);
  });

  it('sha256 equals node:crypto on empty, short, block-edge and long input', () => {
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1_000, 100_003]) {
      const b = new Uint8Array(randomBytes(n));
      expect(Buffer.from(sha256(b)).toString('hex'), `${n} bytes`).toBe(
        createHash('sha256').update(b).digest('hex'),
      );
    }
    expect(Buffer.from(sha256(new TextEncoder().encode('abc'))).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('canonicalJson: keys in UTF-16 order, no whitespace, JSON numbers (minus zero is 0), undefined keys omitted, array order kept', () => {
    expect(canonicalJson({ b: 1, a: [3, 2, 1], Z: -0, y: undefined, c: { z: true, A: null } })).toBe(
      '{"Z":0,"a":[3,2,1],"b":1,"c":{"A":null,"z":true}}',
    );
    // The same value, written out: order of code units puts uppercase before lowercase and 'é' (U+00E9) after 'c'.
    expect(canonicalJson({ é: 'x', c: 1, B: 2 })).toBe('{"B":2,"c":1,"é":"x"}');
    expect(canonicalJson({ n: 1.5e-7, big: 1e21, s: 'q"\n ' })).toBe(
      `{"big":1e+21,"n":1.5e-7,"s":${JSON.stringify('q"\n ')}}`,
    );
    expect(canonicalJson([Number.NaN, Number.POSITIVE_INFINITY])).toBe('[null,null]');
  });

  it('canonicalJson refuses a value nested past the bound instead of recursing without one', () => {
    let v: unknown = 1;
    for (let i = 0; i < 100; i++) v = { v };
    expect(() => canonicalJson(v)).toThrow(RangeError);
  });

  it('the hash is SHA-256 over "ordo-raster", a line feed, the decimal version, a line feed and the canonical bytes', () => {
    const bytes = new TextEncoder().encode('{"v":1}');
    const want = createHash('sha256')
      .update(Buffer.concat([Buffer.from(`ordo-raster\n${RASTER_VERSION}\n`), Buffer.from(bytes)]))
      .digest('hex');
    expect(hashOfBytes(bytes)).toBe(want);
    const recipe: RasterRecipe = {
      v: 1,
      w: 4,
      h: 2,
      box: { x: 0, y: 0, w: 2, h: 1 },
      density: 2,
      members: [],
    };
    expect(recipeHash(recipe)).toBe(hashOfBytes(canonicalBytes(recipe)));
    expect(Buffer.from(canonicalBytes(recipe)).toString()).toBe(
      '{"box":{"h":1,"w":2,"x":0,"y":0},"density":2,"h":2,"members":[],"v":1,"w":4}',
    );
  });

  it("the placeholder is the converter's own prefix and the first 16 hex characters of the hash (D8)", () => {
    const h = 'f4642d09e859dcff9b8dabb6f780cbdfdce2c53232aaad82a24afae3c260e0f5';
    expect(rasterPlaceholder(h)).toBe('pptxmedia:rasterf4642d09e859dcff');
    expect(rasterPlaceholder(h).startsWith('pptxmedia:')).toBe(true);
  });
});

describe('encodeRefs: member references as [shapeId, nth, count] runs (C-SR17, R12)', () => {
  const r = (shapeId: number, nth = 0) => ({ from: 'slide' as const, shapeId, nth });

  it('joins consecutive ascending ids with the same nth into one run, in z order', () => {
    expect(encodeRefs([r(5), r(6), r(7), r(9), r(10)])).toEqual([
      [5, 0, 3],
      [9, 0, 2],
    ]);
    expect(encodeRefs([])).toEqual([]);
  });

  it('ids that repeat get their own runs: a different nth is a different member', () => {
    expect(encodeRefs([r(5, 0), r(6, 0), r(5, 1), r(6, 1)])).toEqual([
      [5, 0, 2],
      [5, 1, 2],
    ]);
    // The same id twice in a row (nth 0, then nth 1) is two runs of one.
    expect(encodeRefs([r(8, 0), r(8, 1)])).toEqual([
      [8, 0, 1],
      [8, 1, 1],
    ]);
  });

  it('is undefined when more than 32 runs are needed (the hash and the converter version are the handle then)', () => {
    const many = Array.from({ length: RASTER_REFS_MAX }, (_, k) => r(k * 10));
    expect(encodeRefs(many)).toHaveLength(RASTER_REFS_MAX);
    expect(encodeRefs([...many, r(1_000)])).toBeUndefined();
  });
});
