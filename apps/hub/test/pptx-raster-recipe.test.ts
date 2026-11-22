import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkRecipe,
  RECIPE_MAX_BYTES,
  RECIPE_MAX_MEMBERS,
  RECIPE_MAX_PATHS,
  RECIPE_MAX_POINTS,
  RECIPE_MAX_POINTS_MEMBER,
  RECIPE_MAX_TEXT_MEMBERS,
  type RecipeMemberWire,
  type RecipePathWire,
  type RecipeWire,
} from '../src/pptx/raster-recipe.ts';
import { goldenRecipe } from './raster.recipes.test-util.ts';

/*
 * The recipe's validator and its golden vector (C-RM1; RM-V1 to RM-V8). The wire format is one written contract
 * with two ends: this validator (the hub, here) and the planner's TypeScript type and hash (packages/pptx-scene),
 * tied by the golden vector file and its hash below.
 */

const golden = (): RecipeWire =>
  JSON.parse(readFileSync(new URL('./data/raster-recipe-v1.json', import.meta.url), 'utf8'));

/** The canonical bytes of C-RM1: keys ascending (UTF-16 code units), no whitespace, numbers as JSON.stringify writes them. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(typeof v === 'number' && Object.is(v, -0) ? 0 : v);
}

/** SHA-256 over 'ordo-raster', a line feed, the drawing version, a line feed and the canonical bytes. */
function hashOf(r: unknown): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from('ordo-raster\n1\n', 'ascii'), Buffer.from(canonical(r), 'utf8')]))
    .digest('hex');
}

const b64 = (bytes: number[] | Uint8Array) => Buffer.from(bytes).toString('base64');
const f32 = (...v: number[]) => b64(new Uint8Array(new Float32Array(v).buffer));

/** A path of `n` lines: a move then n - 1 lines, all at (1, 1). */
function lines(n: number, over: Partial<RecipePathWire> = {}): RecipePathWire {
  const cmds = new Uint8Array(n);
  cmds.fill(1);
  cmds[0] = 0;
  return { cmds: b64(cmds), pts: b64(new Uint8Array(n * 8)), fill: 'norm', stroke: true, ...over };
}

function member(paths: RecipePathWire[], extra: Partial<RecipeMemberWire> = {}): RecipeMemberWire {
  return {
    shape: { type: 'shape', box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 }, shape: 'rect', opacity: 1 },
    geom: { paths },
    ...extra,
  };
}

/** A recipe whose box is `w / 2` by `h / 2` logical px. */
function recipeOf(members: RecipeMemberWire[], w = 20, h = 20): RecipeWire {
  return { v: 1, w, h, box: { x: 0, y: 0, w: w / 2, h: h / 2 }, density: 2, members };
}

const refusal = (v: unknown): string => {
  const r = checkRecipe(v);
  if (r.ok) throw new Error('accepted');
  return r.reason;
};

describe('the recipe validator (RM-V1 to RM-V8)', () => {
  it('RM-V1: a valid recipe passes and its hash equals the golden vector', () => {
    const text = readFileSync(new URL('./data/raster-recipe-v1.json', import.meta.url), 'utf8');
    const r = checkRecipe(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.members).toHaveLength(2);
    expect(r.points).toBeGreaterThan(100);
    const want = readFileSync(new URL('./data/raster-recipe-v1.sha256', import.meta.url), 'utf8').trim();
    expect(hashOf(golden())).toBe(want);
    // The file is what the test-util builds today: the vector and its generator cannot drift apart.
    expect(hashOf(goldenRecipe())).toBe(want);
  });

  it('RM-V2: shuffled keys give the same canonical bytes, shuffled members do not', () => {
    const r = golden();
    const reversedKeys = { members: r.members, density: r.density, box: r.box, h: r.h, w: r.w, v: r.v };
    expect(canonical(reversedKeys)).toBe(canonical(r));
    expect(hashOf({ ...r, members: [...r.members].reverse() })).not.toBe(hashOf(r));
    expect(checkRecipe({ ...r, members: [...r.members].reverse() }).ok).toBe(true);
  });

  it('RM-V3: an unknown key at any level is refused', () => {
    const r = golden();
    expect(refusal({ ...r, extra: 1 })).toMatch(/key/);
    expect(refusal({ ...r, box: { ...r.box, z: 1 } })).toMatch(/key/);
    expect(refusal({ ...r, members: [{ ...r.members[0], extra: 1 }] })).toMatch(/key/);
    expect(refusal({ ...r, members: [{ ...r.members[0], geom: { paths: [], extra: 1 } }] })).toMatch(/key/);
    const m0 = r.members[0]!;
    expect(
      refusal({ ...r, members: [{ ...m0, geom: { paths: [{ ...m0.geom.paths[0], extra: 1 }] } }] }),
    ).toMatch(/key/);
    expect(refusal({ ...r, v: 2 })).toMatch(/version/);
    expect(refusal({ ...r, density: 1 })).toMatch(/density/);
  });

  it('RM-V4: every cap is refused one over its number and passes at it', () => {
    // members
    const one = member([lines(2)]);
    expect(checkRecipe(recipeOf(Array.from({ length: RECIPE_MAX_MEMBERS }, () => one))).ok).toBe(true);
    expect(checkRecipe(recipeOf(Array.from({ length: RECIPE_MAX_MEMBERS + 1 }, () => one))).ok).toBe(false);
    expect(checkRecipe(recipeOf([])).ok).toBe(false);
    // paths a member
    expect(checkRecipe(recipeOf([member(Array.from({ length: RECIPE_MAX_PATHS }, () => lines(2)))])).ok).toBe(
      true,
    );
    expect(
      checkRecipe(recipeOf([member(Array.from({ length: RECIPE_MAX_PATHS + 1 }, () => lines(2)))])).ok,
    ).toBe(false);
    // points a member (a quad counts 2, a cubic 3, a close 1: one path of a move and lines to the cap)
    expect(checkRecipe(recipeOf([member([lines(RECIPE_MAX_POINTS_MEMBER)])])).ok).toBe(true);
    expect(checkRecipe(recipeOf([member([lines(RECIPE_MAX_POINTS_MEMBER + 1)])])).ok).toBe(false);
    // points a recipe: four members at their cap, then one more point
    const full = member([lines(RECIPE_MAX_POINTS_MEMBER)]);
    expect(checkRecipe(recipeOf([full, full, full, full])).ok).toBe(true);
    expect(RECIPE_MAX_POINTS).toBe(4 * RECIPE_MAX_POINTS_MEMBER);
    expect(checkRecipe(recipeOf([full, full, full, full, member([lines(1)])])).ok).toBe(false);
    // pixels and side
    const big = (w: number, h: number): RecipeWire => ({
      ...recipeOf([one]),
      w,
      h,
      box: { x: 0, y: 0, w: w / 2, h: h / 2 },
    });
    expect(checkRecipe(big(3840, 2160)).ok).toBe(true);
    expect(checkRecipe(big(3842, 2160)).ok).toBe(false);
    expect(checkRecipe(big(7680, 1080)).ok).toBe(true);
    expect(checkRecipe(big(7682, 1)).ok).toBe(false);
    // text members
    const text = (i: number) =>
      member([lines(2)], { text: { type: 'text', box: { x: 0, y: 0, w: 5, h: 5 }, text: String(i) } });
    expect(checkRecipe(recipeOf(Array.from({ length: RECIPE_MAX_TEXT_MEMBERS }, (_, i) => text(i)))).ok).toBe(
      true,
    );
    expect(
      checkRecipe(recipeOf(Array.from({ length: RECIPE_MAX_TEXT_MEMBERS + 1 }, (_, i) => text(i)))).ok,
    ).toBe(false);
    // one text object's bytes
    const words = (n: number) =>
      member([lines(2)], { text: { type: 'text', box: { x: 0, y: 0, w: 5, h: 5 }, text: 'x'.repeat(n) } });
    const overhead = JSON.stringify({ type: 'text', box: { x: 0, y: 0, w: 5, h: 5 }, text: '' }).length;
    expect(checkRecipe(recipeOf([words(262_144 - overhead)])).ok).toBe(true);
    expect(checkRecipe(recipeOf([words(262_144 - overhead + 1)])).ok).toBe(false);
    // the file's size
    expect(refusal('x'.repeat(RECIPE_MAX_BYTES + 1))).toMatch(/too large/);
    expect(refusal(new Uint8Array(RECIPE_MAX_BYTES + 1))).toMatch(/too large/);
    // families
    expect(
      checkRecipe(recipeOf([member([lines(2)], { families: Array.from({ length: 33 }, () => 'a') })])).ok,
    ).toBe(false);
    expect(checkRecipe(recipeOf([member([lines(2)], { families: ['a'.repeat(257)] })])).ok).toBe(false);
  });

  it('RM-V5: NaN, infinity and out-of-bound numbers are refused', () => {
    const r = golden();
    expect(
      refusal(
        recipeOf([
          member([{ cmds: b64([0, 1]), pts: f32(Number.NaN, 0, 1, 1), fill: 'norm', stroke: true }]),
        ]),
      ),
    ).toMatch(/coordinate/);
    expect(
      refusal(
        recipeOf([
          member([
            { cmds: b64([0, 1]), pts: f32(Number.POSITIVE_INFINITY, 0, 1, 1), fill: 'norm', stroke: true },
          ]),
        ]),
      ),
    ).toMatch(/coordinate/);
    expect(
      refusal(
        recipeOf([member([{ cmds: b64([0, 1]), pts: f32(2e9, 0, 1, 1), fill: 'norm', stroke: true }])]),
      ),
    ).toMatch(/coordinate/);
    expect(
      checkRecipe(
        recipeOf([member([{ cmds: b64([0, 1]), pts: f32(1e9, -1e9, 1, 1), fill: 'norm', stroke: true }])]),
      ).ok,
    ).toBe(true);
    expect(refusal({ ...r, box: { ...r.box, x: 2_000_000 } })).toMatch(/box/);
    expect(refusal({ ...r, box: { ...r.box, w: 1e300, h: 1e300 } })).toMatch(/box/);
    expect(refusal({ ...r, w: r.w + 1 })).toMatch(/box size/);
    expect(refusal({ ...r, w: 20.5 })).toMatch(/whole/);
    expect(refusal({ ...r, w: Number.NaN })).toMatch(/finite/);
    const shape = (box: unknown) => member([lines(2)], { shape: { type: 'shape', box } });
    expect(refusal(recipeOf([shape({ x: Number.NaN, y: 0, w: 1, h: 1 })]))).toMatch(/finite/);
    expect(refusal(recipeOf([shape({ x: 0, y: 0, w: -1, h: 1 })]))).toMatch(/bounds/);
  });

  it('RM-V6: a command byte outside {0, 1, 3, 4, 5} and a pts of the wrong length are refused', () => {
    const bad = (cmds: number[]) =>
      refusal(recipeOf([member([{ cmds: b64(cmds), pts: f32(0, 0, 1, 1), fill: 'norm', stroke: true }])]));
    expect(bad([0, 2])).toMatch(/command/);
    expect(bad([0, 6])).toMatch(/command/);
    expect(bad([0, 255])).toMatch(/command/);
    // two pairs for two commands: fine; a third value too many or too few: refused
    const pts = (values: number[]) =>
      refusal(recipeOf([member([{ cmds: b64([0, 1]), pts: f32(...values), fill: 'norm', stroke: true }])]));
    expect(pts([0, 0, 1])).toMatch(/pts/);
    expect(pts([0, 0, 1, 1, 2, 2])).toMatch(/pts/);
    expect(
      refusal(recipeOf([member([{ cmds: b64([0, 1]), pts: 'AAA', fill: 'norm', stroke: true }])])),
    ).toMatch(/base64/);
    expect(
      refusal(
        recipeOf([member([{ cmds: b64([0, 1]), pts: f32(0, 0, 1, 1), fill: 'mystery', stroke: true }])]),
      ),
    ).toMatch(/fill/);
    // a quad takes two pairs and a cubic three
    expect(
      checkRecipe(
        recipeOf([
          member([
            {
              cmds: b64([0, 3, 4, 5]),
              pts: f32(0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5),
              fill: 'norm',
              stroke: true,
            },
          ]),
        ]),
      ).ok,
    ).toBe(true);
  });

  it('RM-V7: a first path with cont is refused and a later one joins', () => {
    expect(refusal(recipeOf([member([lines(2, { cont: true })])]))).toMatch(/continues/);
    expect(checkRecipe(recipeOf([member([lines(2), lines(2, { cont: true })])])).ok).toBe(true);
    expect(refusal(recipeOf([member([lines(2), lines(2, { cont: false as unknown as true })])]))).toMatch(
      /cont/,
    );
  });

  it('RM-V8: a reason is at most 200 characters and holds no recipe text', () => {
    const secret = 'SECRET-WORDS-FROM-A-DECK';
    const r = golden();
    const reasons = [
      refusal({ ...r, [secret]: 1 }),
      refusal({ ...r, members: [{ ...r.members[0], [secret]: 1 }] }),
      refusal(`{"${secret}":`),
      refusal({ ...r, members: [{ ...r.members[0], families: [secret.repeat(30)] }] }),
      refusal({
        ...r,
        members: [{ ...r.members[0], shape: { type: secret, box: r.members[0]!.shape.box } }],
      }),
    ];
    for (const reason of reasons) {
      expect(reason.length).toBeLessThanOrEqual(200);
      expect(reason).not.toContain(secret);
    }
    expect(refusal(null)).toMatch(/object/);
    expect(refusal([])).toMatch(/object/);
    expect(refusal(42)).toMatch(/object/);
  });

  it('never throws, whatever it is handed', () => {
    for (const v of [
      undefined,
      null,
      1,
      'a',
      [],
      {},
      Symbol.iterator,
      () => 1,
      new Uint8Array([255, 254, 253]),
    ])
      expect(() => checkRecipe(v)).not.toThrow();
    expect(checkRecipe(new Uint8Array([255, 254, 253])).ok).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(checkRecipe(cyclic).ok).toBe(false);
  });
});
