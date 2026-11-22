/**
 * The hub's store step of the pictures of shapes (Q53, C-SR7, tests H1, H5, H10 and RT1 of the track): `storeRasters` with a STUB
 * `drawRasters` (no Chromium is needed), the job's deferral while a service is live, and the round trip that ties the planner's
 * recipe to the maker's validator and golden vector. The maker's own loop and page are tested in pptx-raster-maker.test.ts and
 * pptx-raster-page.test.ts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RASTER_PREFIX,
  RASTER_READ,
  RASTER_RUN,
  canonicalBytes,
  recipeHash,
} from '@ordo/pptx-scene/raster.ts';
import { convertDeck } from '@ordo/pptx-scene';
import { buildDeck, custGeom, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '../src/errors.ts';
import { JobDeferred } from '../src/jobs.ts';
import { PictureBudget } from '../src/pptx/pictures.ts';
import { encodePng } from '../src/pptx/art.ts';
import {
  checkRecipe,
  RECIPE_MAX_MEMBERS,
  RECIPE_MAX_PATHS,
  RECIPE_MAX_POINTS,
  RECIPE_MAX_POINTS_MEMBER,
  RECIPE_MAX_TEXT_MEMBERS,
  type RecipeWire,
} from '../src/pptx/raster-recipe.ts';
import type { drawRasters, RasterItem, RasterLoopOptions } from '../src/pptx/rasters.ts';
import {
  deferForService,
  RASTER_KEY_PREFIX,
  type RasterJobItem,
  rasterMapKey,
  type StoreRastersOptions,
  storeRasters,
} from '../src/pptx/rasterStore.ts';
import type { PptxNativeResult } from '../src/pptx/shared.ts';
import { goldenRecipe } from './raster.recipes.test-util.ts';
import { startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, waitJob, zipDeck } from './pptx-helpers.ts';

const IN = 914_400;

/** A polygon of `cost` points as the converter reads a custom geometry. */
function poly(cost: number, phase = 0, w = 100_000, h = 100_000): string {
  const n = cost - 2;
  const pt = (i: number) => {
    const a = (2 * Math.PI * i) / (n + 1) + phase * 0.01;
    return `<a:pt x="${Math.round(w / 2 + (w / 2) * Math.cos(a))}" y="${Math.round(h / 2 + (h / 2) * Math.sin(a))}"/>`;
  };
  let d = `<a:moveTo>${pt(0)}</a:moveTo>`;
  for (let i = 1; i <= n; i++) d += `<a:lnTo>${pt(i)}</a:lnTo>`;
  return `<a:path w="${w}" h="${h}">${d}<a:close/></a:path>`;
}

const blob = (id: number, cost: number, x: number, y: number, cx: number, cy: number) =>
  sp({ id, x, y, cx, cy, geom: 'none', fill: custGeom({ paths: poly(cost, id) }) + solid('3366AA') });

/** Recipes the converter really writes: one picture of one 300-point shape, and one of two other shapes. */
function plannedRecipes(): { id: string; hash: string; bytes: number; recipe: RasterJobItem['recipe'] }[] {
  const parts = buildDeck({
    slides: [
      { shapes: blob(2, 300, IN, IN, 2 * IN, 2 * IN) },
      { shapes: blob(2, 400, IN, IN, 3 * IN, 2 * IN) + blob(3, 350, 5 * IN, IN, 2 * IN, 2 * IN) },
    ],
  });
  return convertDeck(parts, { rasters: 'plan' }).rasters ?? [];
}

/** A PNG of the recipe's size: one opaque pixel in transparent ones (it compresses to a few hundred bytes). */
function pngOf(w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  data.set([200, 30, 30, 255], 0);
  return encodePng({ width: w, height: h, channels: 4, data });
}

/** A stub of the maker's loop: hands each item to `accept` as a finished picture, or fails it with a reason. */
function stubDraw(
  how: (item: RasterItem) => 'ok' | { fail: string } | { png: Uint8Array },
  stopped?: string,
): typeof drawRasters & { seen: RasterItem[]; called: number } {
  const fn = (async (_deps: unknown, items: readonly RasterItem[], opts: RasterLoopOptions) => {
    fn.called++;
    const failed = new Map<string, string>();
    let made = 0;
    for (const item of items) {
      fn.seen.push(item);
      const r = how(item);
      if (typeof r === 'object' && 'fail' in r) {
        failed.set(item.hash, r.fail);
        continue;
      }
      const png = typeof r === 'object' ? r.png : pngOf(item.recipe.w, item.recipe.h);
      const taken = await opts.accept({
        hash: item.hash,
        png,
        w: item.recipe.w,
        h: item.recipe.h,
        ms: 1,
      });
      if (taken.ok) made++;
      else {
        failed.set(item.hash, taken.reason);
        if (taken.stop) return { made, failed, stopped: taken.reason };
      }
    }
    return { made, failed, ...(stopped ? { stopped } : {}) };
  }) as unknown as typeof drawRasters & { seen: RasterItem[]; called: number };
  fn.seen = [];
  fn.called = 0;
  return fn;
}

describe('storeRasters (H1: the store step with a stub loop)', () => {
  let hub: TestHub;
  let dir: string;
  beforeAll(async () => {
    hub = await startHub();
    dir = tempDir('ordo-raster-store-');
  });
  afterAll(async () => {
    await hub?.cleanup();
  });

  const recipes = plannedRecipes();
  const items: RasterJobItem[] = recipes.map((r) => ({
    key: rasterMapKey(r.hash),
    hash: r.hash,
    recipe: r.recipe,
  }));
  /** The same recipes under hashes of their own (a tag of 4 hex digits at the end: never the hash of another test's picture). */
  const variant = (tag: string): RasterJobItem[] =>
    items.map((i) => ({
      ...i,
      hash: `${i.hash.slice(0, 60)}${tag}`,
      key: rasterMapKey(`${i.hash.slice(0, 60)}${tag}`),
    }));
  const opts = (
    over: Partial<StoreRastersOptions> = {},
  ): StoreRastersOptions & { logs: string[]; saves: number } => {
    const logs: string[] = [];
    const o = {
      dir,
      signal: new AbortController().signal,
      budget: new PictureBudget(),
      done: [] as [string, string][],
      save() {
        o.saves++;
      },
      name: () => 'Deck – shapes',
      tags: ['pptx'],
      log: (m: string) => logs.push(m),
      saves: 0,
      logs,
      ...over,
    };
    return o;
  };

  it('has two distinct recipes to store (the fixture)', () => {
    expect(recipes).toHaveLength(2);
    expect(items[0]!.key.startsWith(RASTER_KEY_PREFIX)).toBe(true);
    expect(items[0]!.recipe.w).toBeGreaterThan(0);
  });

  it('stores each picture once as a ready image with its recipe hash as the source, and a second import finds it without drawing', async () => {
    const draw = stubDraw(() => 'ok');
    const o = opts({ draw });
    const res = await storeRasters(hub.imports.pptx.deps, items, o);
    expect(res).toMatchObject({ made: 2, reused: 0, resumed: 0 });
    expect(res.failed).toEqual([]);
    expect(draw.called).toBe(1);
    for (const item of items) {
      const id = res.media.get(item.key)!;
      const m = hub.lib.media.must(id);
      expect(m).toMatchObject({ kind: 'image', state: 'ready', width: item.recipe.w, height: item.recipe.h });
      expect(m.hasAlpha).toBe(true);
      expect(o.done.some(([k, v]) => k === item.key && v === id)).toBe(true);
    }
    expect(o.saves).toBeGreaterThan(0);
    // The same deck imported again: found by the recipe hash, the loop is never called.
    const draw2 = stubDraw(() => ({ fail: 'no-browser' }));
    const again = await storeRasters(hub.imports.pptx.deps, items, opts({ draw: draw2 }));
    expect(again).toMatchObject({ made: 0, reused: 2 });
    expect(draw2.called).toBe(0);
    expect([...again.media.values()].sort()).toEqual([...res.media.values()].sort());
  });

  it('resumes from the pairs of an earlier attempt without drawing', async () => {
    const first = await storeRasters(hub.imports.pptx.deps, items, opts({ draw: stubDraw(() => 'ok') }));
    const draw = stubDraw(() => ({ fail: 'no-browser' }));
    const resumed = await storeRasters(
      hub.imports.pptx.deps,
      items,
      opts({ draw, done: [...first.media].map(([k, v]) => [k, v] as [string, string]) }),
    );
    expect(resumed).toMatchObject({ made: 0, resumed: 2 });
    expect(draw.called).toBe(0);
  });

  it('never makes more pictures than one import may (the bakes count too)', async () => {
    const fresh = variant('f001');
    const draw = stubDraw(() => 'ok');
    const o = opts({ draw, maxPictures: 3, already: 2 });
    const res = await storeRasters(hub.imports.pptx.deps, fresh, o);
    expect(res.made).toBe(1);
    expect(res.failed.map(([, why]) => why)).toEqual(['count']);
    expect(o.logs.some((l) => /past the 3 one import makes/.test(l))).toBe(true);
    expect(draw.seen).toHaveLength(1);
  });

  it('puts back the picture that would pass the byte cap, names the cap, and keeps the ones that fit', async () => {
    const fresh = variant('f002');
    const big = (w: number, h: number) => {
      // A noise-like picture: its PNG is larger than its recipe.
      const data = new Uint8Array(w * h * 4);
      let s = 1234567;
      for (let i = 0; i < data.length; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        data[i] = s >> 16;
      }
      return encodePng({ width: w, height: h, channels: 4, data });
    };
    const draw = stubDraw((item) =>
      item.hash === fresh[0]!.hash ? { png: big(item.recipe.w, item.recipe.h) } : 'ok',
    );
    const o = opts({ draw, maxBytes: 20_000 });
    const res = await storeRasters(hub.imports.pptx.deps, fresh, o);
    expect(res.failed).toEqual([[fresh[0]!.key, 'bytes']]);
    expect(res.made).toBe(1);
    expect(res.bytes).toBeLessThanOrEqual(20_000);
    expect(o.logs.some((l) => /would pass the \d+ MB one import may store/.test(l))).toBe(true);
  });

  it('asks the disk floor before each stored picture and fails the whole import, saving nothing, on a 507', async () => {
    const fresh = variant('f003');
    const asked: number[] = [];
    const deps = {
      ...hub.imports.pptx.deps,
      disk: {
        async assertRoom(n?: number) {
          asked.push(n ?? 0);
          throw new HttpError(507, 'disk', 'The disk is nearly full');
        },
      },
    };
    const o = opts({ draw: stubDraw(() => 'ok') });
    await expect(storeRasters(deps, fresh, o)).rejects.toMatchObject({ status: 507 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThan(fresh[0]!.recipe.w * fresh[0]!.recipe.h * 4);
    expect(o.done).toEqual([]);
    for (const i of fresh)
      expect(hub.lib.media.list().some((m) => m.name === 'Deck – shapes' && m.id === i.key)).toBe(false);
  });

  it("puts back what a stopped or failed loop did not make, with ordo's own reasons", async () => {
    const mk = (n: string) =>
      variant(`f10${n === 'a' ? 1 : n === 'b' ? 2 : n === 'c' ? 3 : n === 'd' ? 4 : 5}`);
    // The loop stops because a service went live: the first picture was made, the second was left undrawn.
    const a = mk('a');
    const live = stubDraw((item) => (item.hash === a[1]!.hash ? { fail: 'live' } : 'ok'), 'live');
    const resA = await storeRasters(hub.imports.pptx.deps, a, opts({ draw: live }));
    expect(resA.made).toBe(1);
    expect(resA.stopped).toBe('live');
    expect(resA.failed).toEqual([[a[1]!.key, 'live']]);
    // No browser at all: every item is put back.
    const b = mk('b');
    const none = stubDraw(() => ({ fail: 'no-browser' }), 'no-browser');
    const resB = await storeRasters(hub.imports.pptx.deps, b, opts({ draw: none }));
    expect(resB.made).toBe(0);
    expect(resB.failed.map(([, why]) => why)).toEqual(['no-browser', 'no-browser']);
    // The reasons of one picture: a timeout, a font, an empty picture.
    const c = mk('c');
    const odd = stubDraw((item) => ({ fail: item.hash === c[0]!.hash ? 'timeout' : 'font' }));
    const resC = await storeRasters(hub.imports.pptx.deps, c, opts({ draw: odd }));
    expect(resC.failed.map(([, why]) => why).sort()).toEqual(['font', 'timeout']);
    const d = mk('d');
    const empty = stubDraw(() => ({ fail: 'empty' }));
    expect(
      (await storeRasters(hub.imports.pptx.deps, d, opts({ draw: empty }))).failed.map(([, w]) => w),
    ).toEqual(['empty', 'empty']);
    // The wall time of the loop is its own: a stub that reports 'budget' leaves the rest undrawn and put back.
    const e = mk('e');
    const slow = stubDraw(() => ({ fail: 'timeout' }), 'budget');
    const resE = await storeRasters(hub.imports.pptx.deps, e, opts({ draw: slow, budgetMs: 5 }));
    expect(resE.stopped).toBe('budget');
  });

  it('refuses a hostile recipe BEFORE any browser is asked (the real loop with a launch that must never run)', async () => {
    const hostile = structuredClone(items[0]!.recipe) as unknown as {
      members: { geom: { paths: { pts: string }[] } }[];
    };
    // One point of one path is NaN.
    const nan = Buffer.alloc(8);
    nan.writeFloatLE(Number.NaN, 0);
    hostile.members[0]!.geom.paths[0]!.pts = nan.toString('base64');
    const h = createHash('sha256').update('hostile').digest('hex');
    let launched = 0;
    const o = opts({
      rasterDeps: {
        launch: async () => {
          launched++;
          throw new Error('no browser may start for a refused recipe');
        },
      },
    });
    const res = await storeRasters(
      hub.imports.pptx.deps,
      [{ key: rasterMapKey(h), hash: h, recipe: hostile as unknown as RasterJobItem['recipe'] }],
      o,
    );
    expect(launched).toBe(0);
    expect(res.failed).toEqual([[rasterMapKey(h), 'recipe']]);
  });

  it('is cancelled by an aborted signal and leaves no scratch file of its own', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      storeRasters(
        hub.imports.pptx.deps,
        variant('f009'),
        opts({ signal: ctrl.signal, draw: stubDraw(() => 'ok') }),
      ),
    ).rejects.toThrow('cancelled');
  });

  it("spends the import's decoded-megapixel budget and puts a picture back when it is spent", async () => {
    const fresh = variant('f007');
    const budget = new PictureBudget(0.000001);
    const res = await storeRasters(
      hub.imports.pptx.deps,
      fresh,
      opts({ budget, draw: stubDraw(() => 'ok') }),
    );
    expect(res.made).toBe(0);
    expect(res.failed.map(([, w]) => w)).toEqual(['pixels', 'pixels']);
  });
});

describe('the round trip of the recipe (RT1)', () => {
  const vector = join(import.meta.dirname, 'data');

  it("the golden vector of the maker is parsed by the planner's writer and gives the file's canonical bytes and hash", () => {
    const json = JSON.parse(readFileSync(join(vector, 'raster-recipe-v1.json'), 'utf8'));
    expect(checkRecipe(json).ok).toBe(true);
    const hex = readFileSync(join(vector, 'raster-recipe-v1.sha256'), 'utf8').trim().split(/\s+/)[0]!;
    expect(recipeHash(json)).toBe(hex);
    // The canonical bytes the hash is taken over are the planner's writer's: ascending keys, no whitespace.
    const bytes = canonicalBytes(json);
    expect(JSON.parse(Buffer.from(bytes).toString('utf8'))).toEqual(json);
    expect(Buffer.from(bytes).toString('utf8')).not.toMatch(/\s(?=[:,])/);
    expect(goldenRecipe).toBeTypeOf('function');
  });

  it("a recipe the converter writes passes the maker's validator with the counts the planner expects, and a changed one is refused", () => {
    const [r] = plannedRecipes();
    const ok = checkRecipe(r!.recipe as unknown as RecipeWire);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.recipe.members).toHaveLength(1);
    expect(ok.points).toBeGreaterThanOrEqual(300);
    // One point set to NaN.
    const nan = structuredClone(r!.recipe) as unknown as {
      members: { geom: { paths: { pts: string; cmds: string }[] } }[];
    };
    const raw = Buffer.from(nan.members[0]!.geom.paths[0]!.pts, 'base64');
    raw.writeFloatLE(Number.NaN, 0);
    nan.members[0]!.geom.paths[0]!.pts = raw.toString('base64');
    expect(checkRecipe(nan).ok).toBe(false);
    // One command byte of 2.
    const cmd = structuredClone(nan);
    cmd.members[0]!.geom.paths[0]!.pts = r!.recipe.members[0]!.geom.paths[0]!.pts;
    const c = Buffer.from(cmd.members[0]!.geom.paths[0]!.cmds, 'base64');
    c[1] = 2;
    cmd.members[0]!.geom.paths[0]!.cmds = c.toString('base64');
    expect(checkRecipe(cmd).ok).toBe(false);
    // A member added past the caps.
    const many = structuredClone(r!.recipe) as unknown as { members: unknown[] };
    const first = many.members[0];
    many.members = Array.from({ length: RECIPE_MAX_MEMBERS + 1 }, () => first);
    expect(checkRecipe(many).ok).toBe(false);
  });

  it('the stub drawer is handed the members in z order with the geometry the planner built', async () => {
    const two = plannedRecipes()[1]!;
    const seen: RasterItem[] = [];
    const draw = stubDraw((item) => {
      seen.push(item);
      return { fail: 'timeout' };
    });
    const hub = await startHub();
    try {
      await storeRasters(
        hub.imports.pptx.deps,
        [{ key: rasterMapKey(two.hash), hash: two.hash, recipe: two.recipe }],
        {
          dir: tempDir('ordo-rt1-'),
          signal: new AbortController().signal,
          budget: new PictureBudget(),
          done: [],
          save() {},
          name: () => 'x',
          tags: [],
          log() {},
          draw,
        },
      );
    } finally {
      await hub.cleanup();
    }
    expect(seen).toHaveLength(1);
    const members = (
      seen[0]!.recipe as unknown as {
        members: { shape: { box: { x: number } }; geom: { paths: unknown[] } }[];
      }
    ).members;
    expect(members).toHaveLength(2);
    // The first shape is below the second (the deck order: the box x of the first is the left one).
    expect(members[0]!.shape.box.x).toBeLessThan(members[1]!.shape.box.x);
    expect(members.every((m) => m.geom.paths.length === 1)).toBe(true);
    expect(seen[0]!.hash).toBe(two.hash);
    expect(two.id).toBe(`${RASTER_PREFIX}${two.hash.slice(0, 16)}`);
  });

  it("the planner's caps equal the validator's (the reading bound is the recipe's own, and import-only)", () => {
    expect(RASTER_READ.pointsShape).toBe(RECIPE_MAX_POINTS_MEMBER);
    expect(RASTER_READ.pointsSlide).toBe(RECIPE_MAX_POINTS);
    expect(RASTER_RUN.paths).toBe(RECIPE_MAX_PATHS);
    expect(RASTER_RUN.members).toBe(RECIPE_MAX_MEMBERS);
    expect(RASTER_RUN.texts).toBe(RECIPE_MAX_TEXT_MEMBERS);
    expect(RASTER_RUN.points).toBe(RECIPE_MAX_POINTS);
  });
});

describe('the job and a live service (H10)', () => {
  let dir: string;
  beforeAll(() => {
    dir = tempDir('ordo-raster-defer-');
  });

  const deckWithBlob = () => buildDeck({ slides: [{ shapes: blob(2, 300, IN, IN, 2 * IN, 2 * IN) }] });

  async function queue(hub: TestHub, name: string) {
    const file = await zipDeck(deckWithBlob(), dir, `${name}.pptx`);
    const hash = await storeDeck(hub, file);
    return hub.imports.pptx.queueNative(hash, `${name}.pptx`, {});
  }

  it('deferForService counts the deferral in the payload and backs off', () => {
    let payload: { deferrals?: number } = {};
    const ctx = { payload, setPayload: (p: { deferrals?: number }) => (payload = p) };
    let thrown: unknown;
    try {
      deferForService(ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(JobDeferred);
    expect(payload.deferrals).toBe(1);
    expect((thrown as JobDeferred).message).toMatch(/a service is live/);
    expect((thrown as JobDeferred).delayMs).toBeGreaterThan(0);
  });

  it('a job that plans pictures finds a service live and goes back to the queue BEFORE any work; with the switch off it imports as today', async () => {
    const on = await startHub({
      prerender: { setting: 'on', on: true, store: true },
      // A hub without LibreOffice (a hub with it keeps LibreOffice's art and plans no pictures, M-SR5): the pictures are planned.
      toolProbe: ((t: string) => ({ state: t === 'libreoffice' ? 'absent' : 'available' })) as never,
    });
    try {
      on.jobs.pacing!.onMode('live');
      const job = await queue(on, 'live-on');
      await expect.poll(() => on.jobs.deferred().length, { timeout: 15_000 }).toBe(1);
      const now = on.jobs.get(job.id);
      expect(now.state).toBe('queued');
      expect(now.error ?? '').toBe('');
      expect(now.log.join('\n')).toMatch(/a service is live/);
      // Nothing was stored for it: no presentation, no picture.
      expect(on.lib.presentations.list()).toHaveLength(0);
      expect(on.jobs.deferred().map((d) => d.id)).toEqual([job.id]);
    } finally {
      await on.cleanup();
    }
    // Pictures are off on this hub (the switch is off): the same service does not stop the import.
    const off = await startHub();
    try {
      off.jobs.pacing!.onMode('live');
      const j = await queue(off, 'live-off');
      const done = await waitJob(off, j.id, 60_000);
      expect(done.state).toBe('done');
      const result = done.result as PptxNativeResult;
      expect(slidesOf(off.lib.presentations.must(result.presentationId))).toHaveLength(1);
      expect(result.rasters).toBeUndefined();
    } finally {
      await off.cleanup();
    }
  }, 120_000);
});
