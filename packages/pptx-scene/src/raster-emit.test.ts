import { createHash } from 'node:crypto';
import type { ImageObject, ShapeObject, SlideObject } from '@ordo/domain';
import { legacyGeometry, storedPath } from '@ordo/renderer/geom/built.ts';
import { compileGeom } from '@ordo/renderer/geom/compile.ts';
import type { CompiledGeom } from '@ordo/renderer/geom/ops.ts';
import { buildGeom, type BuiltGeom } from '@ordo/renderer/geom/path.ts';
import { describe, expect, it } from 'vitest';
import type { EmitOne } from './decor.ts';
import { emitSlides } from './index.ts';
import { customPaths } from './geom.ts';
import type { DeckScene, Element } from './ir.ts';
import { CONVERTER_VERSION } from './version.ts';
import {
  RASTER_POINTS,
  RASTER_READ,
  RASTER_REFS_MAX,
  RASTER_RUN,
  RASTER_VERSION,
  type RasterRecipe,
  canonicalBytes,
  rasterPlaceholder,
  recipeHash,
} from './raster.ts';
import {
  type EmittedRaster,
  emitRaster,
  type RasterEmitCtx,
  type RasterGeometry,
  type RasterProvenance,
  readWide,
} from './raster-emit.ts';
import { type RasterElement, type RasterPlan, planRasters } from './raster-plan.ts';
import { candEl, custNode, FRAME, IN, polyPathXml, resetIds, smallEl, textBody } from './raster.test-util.ts';
import { custGeom } from './test-util.ts';
import { MAX_PACKED_ELEMENTS_PER_PART, MAX_PACKED_PATH_ITEMS_PER_PART, parseXml, type XNode } from './xml.ts';

/**
 * The renderer's own compile and build CALLED AS EVERY CALLER BEFORE THE LIMITS PARAMETER DID (the limits argument is not
 * passed: a path past 4,096 points loses points, and says so). The wide compile (`WIDE_GEOMETRY`, `raster-wide.ts`) is the
 * default of the emitter since step 6-0 and is tested below and in raster-integration.test.ts (E1w).
 */
const TODAY: RasterGeometry = {
  compile: (src, notes) => compileGeom(src, notes),
  build: (geom, w, h, adj, notes) => buildGeom(geom, w, h, adj, notes),
};

/** A scene of one slide holding `els`: what the REAL emitter writes for a member is read from it. */
function sceneOf(els: Element[]): DeckScene {
  return {
    frame: FRAME,
    slides: [
      {
        index: 0,
        shown: 0,
        hidden: false,
        part: 'ppt/slides/slide1.xml',
        background: { fill: { kind: 'none' }, from: 'none' },
        elements: els,
        classification: { tier: 'T1', class: 'native', reasons: [] },
        notes: [],
        ms: 0,
      },
    ],
    sections: [],
    notes: [],
  };
}

interface Rig {
  ctx: RasterEmitCtx & { rasters: EmittedRaster[] };
  recipes: Map<string, RasterRecipe>;
  failed: string[];
  /** The real emitter's objects for one element (its own ids come from the context's counter). */
  emitOne: EmitOne;
  out: SlideObject[];
}

function rig(
  o: { geometry?: RasterGeometry | null; rich?: boolean; strip?: boolean; refuse?: boolean } = {},
): Rig {
  let n = 0;
  let pairs = 0;
  const recipes = new Map<string, RasterRecipe>();
  const failed: string[] = [];
  const newId = () => `o${++n}`;
  const ctx: Rig['ctx'] = {
    frame: FRAME,
    newId,
    rich: o.rich ?? true,
    rasters: [],
    ...(o.geometry === null ? {} : { rasterGeometry: o.geometry ?? TODAY }),
    raster: (recipe, hash) => {
      if (o.refuse) return undefined;
      recipes.set(hash, recipe);
      return rasterPlaceholder(hash);
    },
    pairGroup: () => 500 + ++pairs,
    rasterFailed: (r) => failed.push(r),
  };
  const emitOne: EmitOne = (e, sink) => {
    const slide = emitSlides(sceneOf([e]), { newId }).slides[0]!.slide;
    for (const x of slide.objects) {
      if (x.origin?.role === 'bg') continue;
      // What the single-element emitter writes carries no origin: the run gives them (a hub's `emitElement`).
      if (o.strip !== false) delete x.origin;
      sink.push(x);
    }
  };
  return { ctx, recipes, failed, emitOne, out: [] };
}

const plan = (els: readonly Element[], o: Partial<Parameters<typeof planRasters>[3]> = {}): RasterPlan =>
  planRasters(els, undefined, FRAME, { maker: 'page', ...o });

/** Decode the standard base64 of float32 points. */
const floats = (b64: string) => {
  const b = Buffer.from(b64, 'base64');
  return Array.from({ length: b.length / 4 }, (_, i) => b.readFloatLE(i * 4));
};
const bytesOf = (b64: string) => Array.from(Buffer.from(b64, 'base64'));

describe('emitRaster: one picture and its recipe (C-SR4, C-SR5, C-SR6)', () => {
  it("writes ONE locked picture at the run's rectangle and puts the shapes back by the list", () => {
    resetIds();
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], cost: 300 }),
      candEl({ box: [1.6, 1, 0.5, 0.5], cost: 400 }),
    ];
    const p = plan(els);
    const r = rig();
    expect(emitRaster(r.ctx, p.runs[0]!, r.out, r.emitOne)).toBe(true);
    expect(r.out).toHaveLength(1);
    const pic = r.out[0] as ImageObject;
    expect(pic).toMatchObject({
      type: 'image',
      box: { x: 144, y: 144, w: 160, h: 72, rotation: 0 },
      fit: 'stretch',
      opacity: 1,
      radius: 0,
      locked: true,
    });
    expect(pic.mediaId).toMatch(/^pptxmedia:raster[0-9a-f]{16}$/);
    // The list: the picture's id, the objects without it in z order, the members' shape ids.
    expect(r.ctx.rasters).toHaveLength(1);
    const e = r.ctx.rasters[0]!;
    expect(e).toMatchObject({ id: pic.mediaId, uses: [pic.id], members: els.map((x) => x.shapeId) });
    expect(e.objects.map((o) => o.type)).toEqual(['shape', 'shape']);
    const xs = e.objects.map((o) => (o as ShapeObject).box.x);
    expect(xs[0]).toBe(144);
    expect(xs[1]).toBeCloseTo(230.4, 6);
    // The recipe, registered once under its hash, which names the picture.
    expect([...r.recipes.keys()]).toHaveLength(1);
    const [hash, recipe] = [...r.recipes][0]!;
    expect(pic.mediaId).toBe(rasterPlaceholder(hash));
    expect(recipeHash(recipe)).toBe(hash);
    expect(recipe).toMatchObject({
      v: 1,
      w: 320,
      h: 144,
      box: { x: 144, y: 144, w: 160, h: 72 },
      density: 2,
    });
    expect(recipe.members).toHaveLength(2);
  });

  it('a member is the stored shape WITHOUT its geometry, id, origin and locked, then its built paths (the page draws it)', () => {
    resetIds();
    const el = candEl({
      box: [1, 1, 0.5, 0.5],
      cost: 300,
      fill: { kind: 'solid', color: { r: 30, g: 120, b: 200, a: 1 } },
      line: { width: 12_700, fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } }, dash: 'dash' },
    });
    const r = rig();
    expect(emitRaster(r.ctx, plan([el]).runs[0]!, r.out, r.emitOne)).toBe(true);
    const m = [...r.recipes.values()][0]!.members[0]!;
    expect(m.shape).toMatchObject({
      type: 'shape',
      shape: 'rect',
      fill: { r: 30, g: 120, b: 200, a: 1 },
      stroke: { width: expect.any(Number), color: { r: 0, g: 0, b: 0, a: 1 } },
      dash: expect.any(String),
      opacity: 1,
    });
    for (const k of ['id', 'geom', 'origin', 'locked']) expect(m.shape, k).not.toHaveProperty(k);
    expect(m.shape.box).toMatchObject({ x: 144, y: 144, w: 72, h: 72, rotation: 0 });
    expect(m).not.toHaveProperty('text');
    expect(m).not.toHaveProperty('families');
    expect(m.geom.paths).toHaveLength(1);
  });

  it("a shape within today's limits is drawn by the picture as the screens draw it: the same points as its stored paths (R13a)", () => {
    resetIds();
    const node = custNode(300);
    const el = candEl({ box: [1, 1, 0.5, 0.5], cost: 300, node });
    const r = rig();
    expect(emitRaster(r.ctx, plan([el]).runs[0]!, r.out, r.emitOne)).toBe(true);
    const path = [...r.recipes.values()][0]!.members[0]!.geom.paths[0]!;
    // What the converter stores for it (a path string in its own space) built at the box the way a screen builds it.
    const stored = customPaths(node, 0.5 * IN, 0.5 * IN, FRAME.s);
    expect(stored.over).toBeUndefined();
    const want = stored.paths.map((p) => storedPath(p, 72, 72))[0]!;
    expect(bytesOf(path.cmds)).toEqual([...want.cmds]);
    const got = floats(path.pts);
    expect(got).toHaveLength(want.pts.length);
    // Stored paths keep a coordinate to 1/20,000 of the space; the picture is made from the file's own numbers.
    for (let i = 0; i < got.length; i++) expect(Math.abs(got[i]! - want.pts[i]!)).toBeLessThan(0.02);
    expect(path.fill).toBe('norm');
    expect(path.stroke).toBe(true);
  });

  it('a small shape drawn in has the geometry the screens draw for its stored object (a preset at its box)', () => {
    resetIds();
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], cost: 300 }),
      { ...smallEl({ box: [1.6, 1, 0.4, 0.3] }), geom: 'ellipse', custom: undefined },
      candEl({ box: [2.2, 1, 0.5, 0.5], cost: 200 }),
    ];
    delete (els[1] as { custom?: unknown }).custom;
    const r = rig();
    const p = plan(els);
    expect(p.runs[0]!.members.map((m) => m.candidate)).toEqual([true, false, true]);
    expect(emitRaster(r.ctx, p.runs[0]!, r.out, r.emitOne)).toBe(true);
    const recipe = [...r.recipes.values()][0]!;
    const ellipse = recipe.members[1]!;
    const w = 57.6;
    const h = 43.2;
    // What the screens draw for a stored ellipse (no geometry of its own): the legacy ellipse at its box.
    const want = legacyGeometry('ellipse', 0, w, h).paths;
    expect(ellipse.geom.paths).toHaveLength(want.length);
    expect(bytesOf(ellipse.geom.paths[0]!.cmds)).toEqual([...want[0]!.cmds]);
    const ep = floats(ellipse.geom.paths[0]!.pts);
    for (let i = 0; i < ep.length; i++) expect(Math.abs(ep[i]! - want[0]!.pts[i]!)).toBeLessThan(1e-3);
    // The put-back list holds what each member is without the picture, in z order.
    expect(r.ctx.rasters[0]!.objects).toHaveLength(3);
  });

  it('a text-bearing member carries its text object and its families, and is put back with its shape under one group', () => {
    resetIds();
    const words = candEl({ box: [1.7, 1, 0.8, 0.5], cost: 200, text: textBody('Africa') });
    const els = [candEl({ box: [1, 1, 0.5, 0.5], cost: 300 }), words];
    const r = rig();
    const p = plan(els);
    expect(emitRaster(r.ctx, p.runs[0]!, r.out, r.emitOne)).toBe(true);
    const recipe = [...r.recipes.values()][0]!;
    const m = recipe.members[1]!;
    expect(m.text).toMatchObject({ type: 'text', text: 'Africa' });
    for (const k of ['id', 'origin', 'locked']) expect(m.text, k).not.toHaveProperty(k);
    expect(m.families).toEqual(expect.arrayContaining([expect.any(String)]));
    // Put back: the first member's shape, then the second's shape AND its text, the two with ONE group number.
    const back = r.ctx.rasters[0]!.objects;
    expect(back.map((o) => o.type)).toEqual(['shape', 'shape', 'text']);
    expect(back[1]!.origin?.group).toBeDefined();
    expect(back[1]!.origin?.group).toBe(back[2]!.origin?.group);
    expect(back[0]!.origin?.group).toBeUndefined();
    expect(r.ctx.rasters[0]!.words).toBe('Africa');
    // The words in a picture are no longer text: the picture has none.
    expect(r.out.some((o) => o.type === 'text')).toBe(false);
  });

  it('a member with words and nothing to paint has no geometry: the page draws only its text', () => {
    resetIds();
    const label = smallEl({ box: [1.1, 1, 0.5, 0.3], text: textBody('Gulf'), fill: { kind: 'none' } });
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], cost: 300 }),
      label,
      candEl({ box: [1.6, 1, 0.5, 0.5], cost: 200 }),
    ];
    const p = plan(els);
    expect(p.runs[0]!.members).toHaveLength(3);
    const r = rig();
    expect(emitRaster(r.ctx, p.runs[0]!, r.out, r.emitOne)).toBe(true);
    const m = [...r.recipes.values()][0]!.members[1]!;
    expect(m.geom.paths).toEqual([]);
    expect(m.text?.text).toBe('Gulf');
  });
});

describe("emitRaster: the recipe's canonical form and hash (R13, R7, C-RM1)", () => {
  /** An independent writer of the canonical form: sorted keys, no whitespace, JSON numbers. */
  const canon = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    if (v !== null && typeof v === 'object')
      return `{${Object.keys(v as object)
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
        .join(',')}}`;
    return JSON.stringify(v);
  };

  /** A shape with a hole (an outline and an inner square, filled even-odd) and a text-bearing shape. */
  function holeAndWords(): RasterElement[] {
    const hole = parseXml(
      custGeom({
        paths: `<a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo>${Array.from({ length: 130 }, (_, i) => `<a:lnTo><a:pt x="${(i * 3) % 100}" y="${(i * 7) % 100}"/></a:lnTo>`).join('')}<a:close/><a:moveTo><a:pt x="30" y="30"/></a:moveTo><a:lnTo><a:pt x="70" y="30"/></a:lnTo><a:lnTo><a:pt x="70" y="70"/></a:lnTo><a:lnTo><a:pt x="30" y="70"/></a:lnTo><a:close/></a:path>`,
      }),
      'hole',
    )[0]!;
    return [
      candEl({ box: [1, 1, 1, 1], cost: 140, node: hole }),
      candEl({ box: [2.2, 1, 1, 0.6], cost: 200, text: textBody('Words & "quotes"') }),
    ];
  }

  it('R13: canonicalises exactly as the contract says and hashes to SHA-256 over the stated bytes', () => {
    resetIds();
    const els = holeAndWords();
    const r = rig();
    expect(emitRaster(r.ctx, plan(els).runs[0]!, r.out, r.emitOne)).toBe(true);
    const [hash, recipe] = [...r.recipes][0]!;
    const text = canon(recipe);
    const bytes = Buffer.from(canonicalBytes(recipe));
    expect(bytes.toString('utf8')).toBe(text);
    // Keys ascending, no whitespace, absent optional keys omitted (`cont`, and `text` of the first member).
    expect(canon(JSON.parse(text))).toBe(text);
    expect(text).not.toContain('\n');
    expect(text.startsWith('{"box":{"h":')).toBe(true);
    expect(Object.keys(recipe.members[0]!)).toEqual(expect.not.arrayContaining(['text', 'families']));
    expect(JSON.stringify(recipe.members[0]!.geom.paths[0])).not.toContain('"cont"');
    // The paths: standard base64 with padding.
    for (const m of recipe.members)
      for (const p of m.geom.paths) {
        expect(p.cmds).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
        expect(p.pts).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
        expect(p.cmds.length % 4).toBe(0);
      }
    // The hash: SHA-256 over 'ordo-raster', a line feed, the decimal version, a line feed and the canonical bytes.
    const want = createHash('sha256')
      .update(Buffer.concat([Buffer.from(`ordo-raster\n${RASTER_VERSION}\n`), bytes]))
      .digest('hex');
    expect(hash).toBe(want);
    // The hole: two sub-paths in ONE path (the renderer fills even-odd), more than one move command.
    expect(bytesOf(recipe.members[0]!.geom.paths[0]!.cmds).filter((c) => c === 0).length).toBe(2);
  });

  it('R7: the same shapes give the same bytes, hash and placeholder whatever their ids and the order they were made in', () => {
    const make = (firstId: number) => {
      resetIds(firstId);
      const els = holeAndWords();
      const r = rig();
      emitRaster(r.ctx, plan(els).runs[0]!, r.out, r.emitOne);
      return { hash: [...r.recipes.keys()][0]!, id: (r.out[0] as ImageObject).mediaId };
    };
    const a = make(2);
    const b = make(7_000);
    expect(a).toEqual(b);
  });

  it('R7: the maker is not part of the hash: the same shapes planned for the page and for the PDF route hash alike', () => {
    const make = (maker: 'page' | 'pdf') => {
      resetIds();
      const els = [
        candEl({ box: [1, 1, 0.5, 0.5], cost: 300 }),
        candEl({ box: [1.6, 1, 0.5, 0.5], cost: 200 }),
      ];
      const r = rig();
      emitRaster(r.ctx, plan(els, { maker }).runs[0]!, r.out, r.emitOne);
      return [...r.recipes.keys()][0]!;
    };
    expect(make('page')).toBe(make('pdf'));
  });

  it("R7: a text member's recipe carries its words, so changing them changes the hash", () => {
    const make = (words: string) => {
      resetIds();
      const els = [
        candEl({ box: [1, 1, 0.5, 0.5], cost: 300 }),
        candEl({ box: [1.7, 1, 0.8, 0.5], cost: 200, text: textBody(words) }),
      ];
      const r = rig();
      emitRaster(r.ctx, plan(els).runs[0]!, r.out, r.emitOne);
      return [...r.recipes.keys()][0]!;
    };
    expect(make('Africa')).not.toBe(make('Asia'));
    expect(make('Africa')).toBe(make('Africa'));
  });

  it("the recipe stays under the validator's caps: canvas, members, paths, points", () => {
    resetIds();
    const els = [
      candEl({ box: [-1, -1, 20, 12], cost: 300 }),
      candEl({ box: [1.6, 1, 0.5, 0.5], cost: 200 }),
    ];
    const r = rig();
    expect(emitRaster(r.ctx, plan(els).runs[0]!, r.out, r.emitOne)).toBe(true);
    const recipe = [...r.recipes.values()][0]!;
    expect(recipe.w).toBe(3840);
    expect(recipe.h).toBe(2160);
    expect(recipe.w * recipe.h).toBeLessThanOrEqual(RASTER_RUN.pixels);
    expect(recipe.box.w * recipe.density).toBe(recipe.w);
    expect(recipe.members.length).toBeLessThanOrEqual(RASTER_RUN.members);
  });
});

describe('emitRaster: the put-back forms (D5)', () => {
  it("a candidate comes back as its stored shape or as today's box, as the planner worked it out", () => {
    resetIds();
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], cost: 300 }),
      candEl({ box: [1.6, 1, 0.5, 0.5], cost: 9_000, limit: true }),
    ];
    const p = plan(els);
    expect(p.runs[0]!.members.map((m) => m.form)).toEqual(['built', 'box']);
    const r = rig();
    // The over shape's wide geometry needs the real wide compile (the box form is its put-back, never its picture here).
    const geometry: RasterGeometry = { compile: compileGeom, build: buildGeom };
    const ctx = { ...r.ctx, rasterGeometry: geometry };
    expect(emitRaster(ctx, p.runs[0]!, r.out, r.emitOne)).toBe(true);
    const back = r.ctx.rasters[0]!.objects as ShapeObject[];
    expect(back[0]!.geom?.paths?.length).toBe(1);
    expect(back[1]!.geom).toBeUndefined();
    expect(back[1]!.shape).toBe('rect');
  });
});

describe("emitRaster: the provenance of the picture (C-SR17, the owner's Q62)", () => {
  it('records the versions, the rule, the recipe hash, the members and their references in runs', () => {
    resetIds(10);
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], cost: 300, shapeId: 10, group: 4 }),
      candEl({ box: [1.6, 1, 0.5, 0.5], cost: 300, shapeId: 11, group: 4 }),
      candEl({ box: [2.2, 1, 0.5, 0.5], cost: 300, shapeId: 14, group: 4 }),
    ];
    const r = rig();
    const p = plan(els);
    expect(emitRaster(r.ctx, p.runs[0]!, r.out, r.emitOne)).toBe(true);
    const pic = r.out[0] as ImageObject;
    const hash = [...r.recipes.keys()][0]!;
    expect(pic.origin).toMatchObject({ src: 'pptx', role: 'raster', shapeId: 10, group: 4 });
    const raster = (pic.origin as { raster?: RasterProvenance }).raster!;
    expect(raster).toEqual({
      cv: CONVERTER_VERSION,
      rv: RASTER_VERSION,
      pts: RASTER_POINTS,
      h: hash.slice(0, 16),
      n: 3,
      from: 'slide',
      refs: [
        [10, 0, 2],
        [14, 0, 1],
      ],
    });
    expect(`pptxmedia:raster${raster.h}`).toBe(pic.mediaId);
  });

  it('leaves `refs` out when more than 32 runs are needed, and the group out when the members do not share one', () => {
    resetIds();
    const els = Array.from({ length: RASTER_REFS_MAX + 4 }, (_, k) =>
      candEl({
        box: [0.2 + (k % 20) * 0.5, 1 + Math.floor(k / 20) * 0.5, 0.4, 0.4],
        cost: 200,
        shapeId: 100 + k * 5,
        group: k % 2,
      }),
    );
    const r = rig();
    const p = plan(els, { maxPictures: 1 });
    expect(p.runs).toHaveLength(1);
    expect(emitRaster(r.ctx, p.runs[0]!, r.out, r.emitOne)).toBe(true);
    const o = (r.out[0] as ImageObject).origin as { raster?: RasterProvenance; group?: number };
    expect(o.raster).not.toHaveProperty('refs');
    expect(o.raster?.n).toBe(RASTER_REFS_MAX + 4);
    expect(o.group).toBeUndefined();
  });

  it('writes no origin at all in the emission that writes none (the M1 form)', () => {
    resetIds();
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], cost: 300 }),
      candEl({ box: [1.6, 1, 0.5, 0.5], cost: 300 }),
    ];
    const r = rig({ rich: false });
    expect(emitRaster(r.ctx, plan(els).runs[0]!, r.out, r.emitOne)).toBe(true);
    expect((r.out[0] as ImageObject).origin).toBeUndefined();
    expect(r.ctx.rasters[0]!.objects.every((o) => o.origin === undefined)).toBe(true);
  });

  it('gives each put-back object the origin it would have had (its shape id, its role)', () => {
    resetIds(30);
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], cost: 300, shapeId: 31 }),
      candEl({ box: [1.6, 1, 0.5, 0.5], cost: 300, shapeId: 32, from: 'layout' }),
    ];
    const r = rig();
    const p = plan(els, { maxPictures: 8 });
    // The layout shape is its own run: this one is the slide's.
    expect(emitRaster(r.ctx, p.runs[0]!, r.out, r.emitOne)).toBe(true);
    expect(r.ctx.rasters[0]!.objects[0]!.origin).toMatchObject({
      src: 'pptx',
      role: expect.stringMatching(/^(shape|deco)$/),
      shapeId: 31,
    });
  });
});

describe('emitRaster: a picture is complete or not made (G6, R9)', () => {
  /** A rig that must have written nothing after a refusal. */
  function refused(reason: string, r: Rig, ok: boolean, before: SlideObject[]) {
    expect(ok).toBe(false);
    expect(r.failed).toEqual([reason]);
    expect(r.out).toEqual(before);
    expect(r.recipes.size).toBe(0);
    expect(r.ctx.rasters).toEqual([]);
  }

  it('a context with no registry makes none', () => {
    resetIds();
    const els = [candEl({ cost: 300 })];
    const r = rig();
    const ctx = { ...r.ctx, raster: undefined };
    expect(emitRaster(ctx, plan(els).runs[0]!, r.out, r.emitOne)).toBe(false);
    expect(r.failed).toEqual(['no-registry']);
    expect(r.out).toEqual([]);
  });

  it('a registry that refuses (a budget) makes none: the shapes stay as they are', () => {
    resetIds();
    const els = [candEl({ cost: 300 })];
    const r = rig({ refuse: true });
    refused('budget', r, emitRaster(r.ctx, plan(els).runs[0]!, r.out, r.emitOne), []);
  });

  it("a registry that answers another id than the hash's makes none (the placeholder is content-derived, D8)", () => {
    resetIds();
    const r = rig();
    const ctx = { ...r.ctx, raster: () => 'pptxmedia:raster0000000000000000' };
    expect(emitRaster(ctx, plan([candEl({ cost: 300 })]).runs[0]!, r.out, r.emitOne)).toBe(false);
    expect(r.failed).toEqual(['placeholder']);
    expect(r.out).toEqual([]);
    expect(r.ctx.rasters).toEqual([]);
  });

  it('a candidate past the reading bound makes the run fail before anything is built', () => {
    resetIds();
    const big = parseXml(
      custGeom({
        paths: `<a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo>${'<a:lnTo><a:pt x="1" y="1"/></a:lnTo>'.repeat(300_000)}</a:path>`,
      }),
      'big',
      { pack: { maxElements: MAX_PACKED_ELEMENTS_PER_PART, maxPathItems: MAX_PACKED_PATH_ITEMS_PER_PART } },
    )[0]!;
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], cost: 200, node: big }),
      candEl({ box: [2, 1, 0.5, 0.5], cost: 300 }),
    ];
    const r = rig();
    let called = 0;
    const geometry: RasterGeometry = {
      compile: (...a) => {
        called++;
        return compileGeom(a[0], a[1]);
      },
      build: (...a) => buildGeom(a[0], a[1], a[2]),
    };
    const ctx = { ...r.ctx, rasterGeometry: geometry };
    // The planner takes the shape by its own `raw` (a lie here: the builder reads the node itself).
    const p = plan(els);
    expect(p.runs).toHaveLength(1);
    refused('read-bound', r, emitRaster(ctx, p.runs[0]!, r.out, r.emitOne), []);
    expect(called).toBe(0);
  });

  it('a geometry of more paths than a recipe holds makes none', () => {
    resetIds();
    const many = parseXml(
      custGeom({ paths: Array.from({ length: RASTER_RUN.paths + 1 }, () => polyPathXml(5)).join('') }),
      'many',
    )[0]!;
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], cost: 200, node: many }),
      candEl({ box: [2, 1, 0.5, 0.5], cost: 300 }),
    ];
    const r = rig();
    refused('paths', r, emitRaster(r.ctx, plan(els).runs[0]!, r.out, r.emitOne), []);
  });

  it('a compiler that throws, or drops points, makes none (a cut outline is never drawn as if whole)', () => {
    resetIds();
    const els = [candEl({ box: [1, 1, 0.5, 0.5], cost: 300 }), candEl({ box: [2, 1, 0.5, 0.5], cost: 200 })];
    const r = rig({
      geometry: {
        compile: () => {
          throw new Error('boom');
        },
        build: buildGeom,
      },
    });
    refused('geometry', r, emitRaster(r.ctx, plan(els).runs[0]!, r.out, r.emitOne), []);
    const els2 = [candEl({ box: [1, 1, 0.5, 0.5], cost: 300 })];
    const r2 = rig({
      geometry: {
        compile: (src, notes) => {
          notes?.messages.push('path points over the limit dropped');
          return compileGeom(src);
        },
        build: buildGeom,
      },
    });
    refused('read-bound', r2, emitRaster(r2.ctx, plan(els2).runs[0]!, r2.out, r2.emitOne), []);
    // Without the injected compile there is no way to read a wide outline.
    const r3 = rig({ geometry: null });
    refused(
      'no-compile',
      r3,
      emitRaster(r3.ctx, plan([candEl({ cost: 300 })]).runs[0]!, r3.out, r3.emitOne),
      [],
    );
  });

  it('a recipe past the points of one recipe makes none, even when every member is within its own cap', () => {
    resetIds();
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], cost: 300 }),
      candEl({ box: [1.6, 1, 0.5, 0.5], cost: 300 }),
    ];
    const fat: RasterGeometry = {
      compile: (src, notes) => compileGeom(src, notes),
      build: (g, w, h) => {
        const b = buildGeom(g, w, h);
        const n = 270_000;
        const cmds = [0, ...Array.from({ length: n }, () => 1)];
        const pts = Array.from({ length: (n + 1) * 2 }, () => 1);
        return { ...b, paths: [{ cmds, pts, fill: 'norm', stroke: true }] } as BuiltGeom;
      },
    };
    const r = rig({ geometry: fat });
    // 270,001 points a member is past the 262,144 of one.
    refused('read-bound', r, emitRaster(r.ctx, plan(els).runs[0]!, r.out, r.emitOne), []);
    const mid: RasterGeometry = {
      compile: fat.compile,
      build: (g, w, h) => {
        const n = 190_000;
        return {
          ...buildGeom(g, w, h),
          paths: [
            {
              cmds: [0, ...Array.from({ length: n }, () => 1)],
              pts: Array.from({ length: (n + 1) * 2 }, () => 1),
              fill: 'norm',
              stroke: true,
            },
          ],
        } as BuiltGeom;
      },
    };
    // Six members of 190,001 points pass 1,048,576 in all.
    resetIds();
    const six = Array.from({ length: 6 }, (_, k) => candEl({ box: [0.3 + k * 0.5, 1, 0.4, 0.4], cost: 300 }));
    const r2 = rig({ geometry: mid });
    refused('recipe-points', r2, emitRaster(r2.ctx, plan(six).runs[0]!, r2.out, r2.emitOne), []);
  });

  it('a built path with a command a recipe cannot hold, or points that do not match, makes none', () => {
    resetIds();
    const els = [candEl({ box: [1, 1, 0.5, 0.5], cost: 300 })];
    const bad = (paths: unknown): RasterGeometry => ({
      compile: (src, notes) => compileGeom(src, notes),
      build: (g, w, h) => ({ ...buildGeom(g, w, h), paths }) as BuiltGeom,
    });
    for (const paths of [
      [{ cmds: [0, 2, 5], pts: [0, 0, 1, 1, 2, 2], fill: 'norm', stroke: true }],
      [{ cmds: [0, 1, 5], pts: [0, 0, 1], fill: 'norm', stroke: true }],
      [{ cmds: [0, 1, 5], pts: [0, 0, Number.NaN, 1], fill: 'norm', stroke: true }],
    ]) {
      const r = rig({ geometry: bad(paths) });
      refused('geometry', r, emitRaster(r.ctx, plan(els).runs[0]!, r.out, r.emitOne), []);
    }
  });

  it("a compile that drops points past the screens' limits cannot draw a picture whole: a 6,000-point path is refused", () => {
    resetIds();
    // The injected functions do not take the limits (a stand-in for a compile without them): a path past 4,096 points loses points, and says so.
    const els = [candEl({ box: [1, 1, 0.5, 0.5], cost: 6_000, node: custNodeOf(6_000) })];
    const r = rig();
    refused('read-bound', r, emitRaster(r.ctx, plan(els).runs[0]!, r.out, r.emitOne), []);
  });
});

/** An `a:custGeom` node of one path of `cost` points built here (past `custNode`'s own bound of 2,000). */
function custNodeOf(cost: number): XNode {
  return parseXml(custGeom({ paths: polyPathXml(cost) }), 'big', {
    pack: { maxElements: MAX_PACKED_ELEMENTS_PER_PART, maxPathItems: MAX_PACKED_PATH_ITEMS_PER_PART },
  })[0]!;
}

describe('emitRaster with a wide compile (the injected seam, wired at step 6-0)', () => {
  /** A stand-in for the renderer's wide compile and build: honours the limits it is given, builds what the source holds. */
  function wide(seen: { limits: { points: number; paths: number }[] }): RasterGeometry {
    return {
      compile: (src, _notes, limits) => {
        seen.limits.push(limits);
        // The source's commands, kept in a CompiledGeom-shaped carrier the build below reads back.
        return { carrier: src.paths } as unknown as CompiledGeom;
      },
      build: (g, w, h, _a, _n, limits) => {
        seen.limits.push(limits);
        const paths = (g as unknown as { carrier: { cmds: { op: string; args: string[] }[] }[] }).carrier;
        return {
          w,
          h,
          text: { l: 0, t: 0, r: w, b: h },
          sites: [],
          paths: paths.map((p) => {
            const cmds: number[] = [];
            const pts: number[] = [];
            for (const c of p.cmds) {
              if (c.op === 'moveTo') cmds.push(0);
              else if (c.op === 'lnTo') cmds.push(1);
              else if (c.op === 'close') cmds.push(5);
              else continue;
              if (c.op !== 'close') pts.push(Number(c.args[0]) % w, Number(c.args[1]) % h);
            }
            return { cmds, pts, fill: 'norm', stroke: true };
          }),
        } as unknown as BuiltGeom;
      },
    };
  }

  it('reads a 45,056-point outline whole (the limits are the read bound, never stored) and draws all of it', () => {
    resetIds();
    const node = parseXml(
      custGeom({ paths: Array.from({ length: 11 }, (_, k) => polyPathXml(4_096, k)).join('') }),
      'wide',
      { pack: { maxElements: MAX_PACKED_ELEMENTS_PER_PART, maxPathItems: MAX_PACKED_PATH_ITEMS_PER_PART } },
    )[0]!;
    const els = [candEl({ box: [1, 1, 3, 3], cost: 45_056, node, todayPoints: 4_114, why: 'points' })];
    const seen = { limits: [] as { points: number; paths: number }[] };
    const r = rig({ geometry: wide(seen) });
    expect(emitRaster(r.ctx, plan(els).runs[0]!, r.out, r.emitOne)).toBe(true);
    // The compile and the build were both given the read bound: 262,144 points a path and 64 paths.
    expect(seen.limits).toEqual([
      { points: RASTER_READ.pointsShape, paths: RASTER_RUN.paths },
      { points: RASTER_READ.pointsShape, paths: RASTER_RUN.paths },
    ]);
    const m = [...r.recipes.values()][0]!.members[0]!;
    expect(m.geom.paths).toHaveLength(11);
    const commands = m.geom.paths.reduce((n, p) => n + Buffer.from(p.cmds, 'base64').length, 0);
    expect(commands).toBe(45_056);
    // The put-back is the stored form (4,114 points), not the outline: nothing stored passes its limits.
    expect(r.ctx.rasters[0]!.objects).toHaveLength(1);
  });

  it("the converter's own reader stops at the stored limits; the wide reader keeps every path whole", () => {
    const node = custNodeOf(6_000);
    const src = readWide(node, { points: RASTER_READ.pointsShape, paths: RASTER_RUN.paths })!;
    expect(src.paths).toHaveLength(1);
    expect(src.paths![0]!.cmds).toHaveLength(6_000);
    // Past the paths a recipe holds there is no reading.
    const many = parseXml(
      custGeom({ paths: Array.from({ length: 65 }, () => polyPathXml(5)).join('') }),
      'many',
    )[0]!;
    expect(readWide(many, { points: 100, paths: 64 })).toBeUndefined();
    // The points are cut one past the bound, so the compiler notes that some were dropped.
    const cut = readWide(node, { points: 1_000, paths: 64 })!;
    expect(cut.paths![0]!.cmds).toHaveLength(1_001);
  });
});
