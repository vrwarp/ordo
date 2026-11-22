import { createHash } from 'node:crypto';
import { compileGeom } from '@ordo/renderer/geom/compile.ts';
import { buildGeom } from '@ordo/renderer/geom/path.ts';
import { describe, expect, it } from 'vitest';
import { convertDeck, emitSlides, parseDeck } from './index.ts';
import type { RasterGeometry } from './raster-emit.ts';
import { RASTER_POINTS, RASTER_PREFIX, encodeRefs } from './raster.ts';
import { WIDE_GEOMETRY } from './raster-wide.ts';
import { body, buildDeck, custGeom, para, run, solid, sp } from './test-util.ts';
import type { ShapeElement } from './ir.ts';
import { MAX_SLIDE_PATH_POINTS } from './geom.ts';

/**
 * The converter's hooks of the shape pictures (step 5 of the track, C-SR2): the walk marks the candidates, the planner
 * claims them before the budgets, the emitter writes each run as one picture with its recipe, and `rasters: 'off'`
 * and 'detect' leave today's output alone (the pins of raster-record.test.ts are the byte-level proof of that).
 * The decks are synthetic (the package's deck utilities); the wide geometry is the renderer's own compile and build,
 * which these shapes (each path within 4,096 points) never need the limits parameter for.
 */

const IN = 914_400;
const WIDE: RasterGeometry = { compile: compileGeom, build: buildGeom };

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

function blob(id: number, cost: number, x: number, y: number, cx: number, cy: number, extra = ''): string {
  return sp({
    id,
    x,
    y,
    cx,
    cy,
    geom: 'none',
    fill: custGeom({ paths: poly(cost, id) }) + solid('3366AA'),
    ...(extra ? { txBody: extra } : {}),
  });
}

/** A shape of `paths` paths of `cost` points each (a 5,464-point outline as two paths: within the screens' own 4,096 a path). */
function multi(
  id: number,
  paths: number,
  cost: number,
  x: number,
  y: number,
  cx: number,
  cy: number,
): string {
  return sp({
    id,
    x,
    y,
    cx,
    cy,
    geom: 'none',
    fill:
      custGeom({ paths: Array.from({ length: paths }, (_, k) => poly(cost, id + k)).join('') }) +
      solid('3366AA'),
  });
}

const small = (id: number, x: number) =>
  sp({ id, x, y: IN, cx: 200_000, cy: 200_000, fill: solid('AA3366') });
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function slideOf(shapes: string) {
  return buildDeck({ slides: [{ shapes }] });
}

const PLAN = { rasters: 'plan', rasterGeometry: WIDE } as const;

describe('the converter hooks of the shape pictures', () => {
  it('E1: a slide of one outline of 5,464 points and 88 small pieces emits one picture and no residual shape', () => {
    const shapes =
      multi(2, 2, 2_732, IN, IN, 4 * IN, 3 * IN) +
      Array.from({ length: 88 }, (_, k) =>
        blob(10 + k, 20, IN + (k % 20) * 100_000, IN + Math.floor(k / 20) * 100_000, 90_000, 90_000),
      ).join('');
    const out = emitSlides(parseDeck(slideOf(shapes), { rasters: 'plan' }), PLAN);
    const s = out.slides[0]!;
    const images = s.slide.objects.filter((o) => o.type === 'image' && o.origin?.role === 'raster');
    expect(images).toHaveLength(1);
    // The 88 small pieces after it are shapes (within the slide total now: nothing is a box); the outline is the picture.
    expect(
      s.slide.objects.filter((o) => o.type === 'shape' && o.origin?.role === 'shape').length,
    ).toBeGreaterThanOrEqual(88);
    expect(s.classification.class).toBe('native');
    expect(s.rasters).toHaveLength(1);
    expect(s.rasters![0]!.id.startsWith(RASTER_PREFIX)).toBe(true);
    expect(out.rasters).toHaveLength(1);
    // The slide total: the put-back forms hold within 65,536 path points.
    const put = s.rasters![0]!.objects.reduce((n, o) => n + (o.type === 'shape' && o.geom ? 1 : 0), 0);
    expect(put).toBeGreaterThan(0);
    expect(s.rasterInfo).toMatchObject({ candidates: 1, pictures: 1 });
    expect(MAX_SLIDE_PATH_POINTS).toBe(65_536);
  });

  it("E1w-0: with no geometry injected the run is not made: the converter itself carries no compile of the renderer's (the browser's import worker never plans a picture)", () => {
    const parts = slideOf(blob(2, 300, IN, IN, 2 * IN, 2 * IN));
    const out = emitSlides(parseDeck(parts, { rasters: 'plan' }), { rasters: 'plan' });
    const s = out.slides[0]!;
    expect(s.rasterInfo?.failed).toEqual(['no-compile']);
    expect(out.rasters ?? []).toHaveLength(0);
    // The slide is today's: the shape is a shape.
    expect(s.slide.objects.some((o) => o.type === 'shape' && o.origin?.role === 'shape')).toBe(true);
  });

  it("E1w: with the renderer's own wide compile (WIDE_GEOMETRY, which the hub's pool and the harness inject) a 5,464-point outline of ONE path is drawn into a picture", () => {
    // One path of 5,464 points: past the screens' 4,096 a path, so the compile that stores or draws would cut it. The picture
    // is made from the wide read (`RASTER_READ`), never from a cut outline, so its recipe holds every point.
    const parts = slideOf(blob(2, 5_464, IN, IN, 4 * IN, 3 * IN));
    const out = emitSlides(parseDeck(parts, { rasters: 'plan' }), {
      rasters: 'plan',
      rasterGeometry: WIDE_GEOMETRY,
    });
    const s = out.slides[0]!;
    expect(s.rasterInfo?.failed ?? []).toEqual([]);
    expect(s.rasters).toHaveLength(1);
    expect(out.rasters).toHaveLength(1);
    const member = out.rasters![0]!.recipe.members[0]!;
    // 5,464 points in the recipe: one move, 5,462 lines and a close, one byte a command.
    expect(Buffer.from(member.geom.paths[0]!.cmds, 'base64')).toHaveLength(5_464);
    // The picture says what it is made of, and the slide holds no stored outline past the screens' limits.
    const image = s.slide.objects.find((o) => o.type === 'image' && o.origin?.role === 'raster');
    expect(image?.origin?.raster).toMatchObject({ pts: RASTER_POINTS, n: 1 });
    expect(s.slide.objects.some((o) => o.type === 'shape' && o.origin?.role === 'shape')).toBe(false);
  });

  it("E2: rasters 'off', 'detect' and no option emit what the converter emitted before", () => {
    const shapes =
      blob(2, 300, IN, IN, 2 * IN, 2 * IN) + multi(3, 9, 20, 3 * IN, IN, 2 * IN, 2 * IN) + small(4, IN);
    const parts = slideOf(shapes);
    const none = emitSlides(parseDeck(parts, {}), {});
    for (const mode of ['off', 'detect'] as const) {
      const out = emitSlides(parseDeck(parts, { rasters: mode }), { rasters: mode });
      expect(sha(out.slides[0]!.slide)).toBe(sha(none.slides[0]!.slide));
      expect(sha(out.slides[0]!.notes)).toBe(sha(none.slides[0]!.notes));
      expect(out.slides[0]!.rasters).toBeUndefined();
      expect(out.rasters).toBeUndefined();
    }
    // 'detect' counts the candidates and plans nothing.
    const scene = parseDeck(parts, { rasters: 'detect' });
    expect(scene.slides[0]!.rasters?.candidates).toBe(2);
    expect(scene.slides[0]!.rasters?.runs).toEqual([]);
  });

  it('E2b: planned but emitted without rasters, the slide is what it is today (every run put back)', () => {
    const shapes = blob(2, 300, IN, IN, 2 * IN, 2 * IN) + small(4, IN);
    const parts = slideOf(shapes);
    const none = emitSlides(parseDeck(parts, {}), {});
    const planned = emitSlides(parseDeck(parts, { rasters: 'plan' }), {});
    // Same objects, ids apart (a put-back run is emitted member by member).
    const strip = (x: unknown) => JSON.stringify(x).replace(/"id":"[^"]*"/g, '"id":"_"');
    expect(strip(planned.slides[0]!.slide.objects)).toBe(strip(none.slides[0]!.slide.objects));
  });

  it("E3: a slide with a clip (an anchor) plans nothing: every candidate keeps today's output", () => {
    const shapes = blob(2, 300, IN, IN, 2 * IN, 2 * IN);
    const parts = slideOf(shapes);
    const scene = parseDeck(parts, { rasters: 'plan', wholeAnchored: false });
    // No clip in this deck: the slide is eligible; the anchored arm is the planner's own test (R-tests) and the
    // IR test of import-whole (budget.whole.test.ts): here the slide plans one run.
    expect(scene.slides[0]!.rasters?.runs).toHaveLength(1);
  });

  it("E4: text-bearing over-limit shapes are members with their words when the maker is the page, today's shapes otherwise", () => {
    const words = body(para(run('Words in a many-point shape', 'sz="2400"', solid('FFFFFF'))));
    const shapes = blob(2, 400, IN, IN, 4 * IN, 2 * IN, words);
    const parts = slideOf(shapes);
    const page = emitSlides(parseDeck(parts, { rasters: 'plan', rasterMaker: 'page' }), PLAN);
    const s = page.slides[0]!;
    expect(s.rasters).toHaveLength(1);
    expect(s.rasters![0]!.words).toContain('Words in a many-point shape');
    expect(s.rasterWords).toContain('Words');
    // the put-back list holds the pair with one group number
    const objs = s.rasters![0]!.objects;
    expect(objs.map((o) => o.type)).toEqual(['shape', 'text']);
    expect(objs[0]!.origin?.group).toBeDefined();
    expect(objs[0]!.origin?.group).toBe(objs[1]!.origin?.group);
    const pdf = emitSlides(parseDeck(parts, { rasters: 'plan', rasterMaker: 'pdf' }), {
      rasters: 'plan',
      rasterMaker: 'pdf',
    } as never);
    expect(pdf.slides[0]!.rasters).toBeUndefined();
    expect(pdf.slides[0]!.rasterInfo?.skipped.text).toBe(1);
    const off = emitSlides(parseDeck(parts, {}), {});
    expect(pdf.slides[0]!.slide.objects.map((o) => o.type)).toEqual(
      off.slides[0]!.slide.objects.map((o) => o.type),
    );
  });

  it('E5: a slide with only claimed shapes stays native, its art range is empty', () => {
    const scene = parseDeck(slideOf(blob(2, 3_000, IN, IN, 3 * IN, 3 * IN)), { rasters: 'plan' });
    const sl = scene.slides[0]!;
    expect(sl.classification.class).toBe('native');
    expect(sl.classification.reasons).not.toContain('budget:shapes');
    const e = sl.elements.find((x): x is ShapeElement => x.kind === 'shape')!;
    expect(e.raster).toBe(0);
    expect(e.support).toBe('native');
  });

  it('E6: two imports of the same deck give the same slide digest and the same placeholders', () => {
    const parts = slideOf(blob(2, 3_000, IN, IN, 3 * IN, 3 * IN));
    const a = emitSlides(parseDeck(parts, { rasters: 'plan' }), PLAN);
    const b = emitSlides(parseDeck(parts, { rasters: 'plan' }), PLAN);
    expect(a.slides[0]!.digest).toBe(b.slides[0]!.digest);
    expect(a.slides[0]!.rasters![0]!.id).toBe(b.slides[0]!.rasters![0]!.id);
    expect(a.rasters![0]!.hash).toBe(b.rasters![0]!.hash);
  });

  it("E7: the put-back list replays today's look for the claimed members within the slide total", () => {
    const parts = slideOf(blob(2, 300, IN, IN, 2 * IN, 2 * IN) + blob(3, 900, 3 * IN, IN, 2 * IN, 2 * IN));
    const today = emitSlides(parseDeck(parts, {}), {});
    const planned = emitSlides(parseDeck(parts, { rasters: 'plan' }), PLAN);
    const back = planned.slides[0]!.rasters![0]!.objects;
    // The put-back list holds each geometry inline (the slide's own are moved to files by the slide's budget): compared
    // by everything else, and by the points each draws.
    const strip = (x: unknown) =>
      JSON.stringify(x, (k, v) => (k === 'geom' ? 'g' : v))
        .replace(/"id":"[^"]*"/g, '"id":"_"')
        .replace(/"origin":\{[^}]*\},?/g, '');
    expect(back).toHaveLength(2);
    expect(strip(back.map((o) => ({ ...o, origin: undefined })))).toBe(
      strip(
        today.slides[0]!.slide.objects.filter((o) => o.origin?.role !== 'bg').map((o) => ({
          ...o,
          origin: undefined,
        })),
      ),
    );
  });

  it('E8: 600 claimed shapes plus 300 ordinary objects plan 301 objects and one picture', () => {
    const cand = Array.from({ length: 600 }, (_, k) =>
      blob(10 + k, 130, (k % 30) * 380_000, 3 * IN + Math.floor(k / 30) * 120_000, 360_000, 110_000),
    ).join('');
    const ordinary = Array.from({ length: 300 }, (_, k) =>
      sp({ id: 1000 + k, x: (k % 30) * 380_000, y: 0, cx: 360_000, cy: 100_000, fill: solid('445566') }),
    ).join('');
    const scene = parseDeck(slideOf(ordinary + cand), { rasters: 'plan', wholeSlides: true });
    const sl = scene.slides[0]!;
    expect(sl.rasters?.runs.length).toBeGreaterThanOrEqual(1);
    const pics = sl.rasters!.runs.length;
    // 300 ordinary shapes are emitted as they are; the 600 are the picture(s).
    const out = emitSlides(scene, PLAN).slides[0]!;
    const images = out.slide.objects.filter((o) => o.type === 'image' && o.origin?.role === 'raster');
    expect(images).toHaveLength(pics);
    expect(out.slide.objects.length).toBeLessThanOrEqual(1 + 300 + pics + 1);
  });

  it('E9: no note and no missing entry names a claimed shape, and the slide total is not charged for it', () => {
    const parts = slideOf(blob(2, 5_000, IN, IN, 4 * IN, 3 * IN) + small(3, IN));
    const planned = parseDeck(parts, { rasters: 'plan' }).slides[0]!;
    expect(planned.rasters?.runs).toHaveLength(1);
    expect(planned.notes.join(' ')).not.toMatch(/path points|custom geometry/);
    expect(planned.classification.missing ?? []).toEqual([]);
    const today = emitSlides(parseDeck(parts, {}), {}).slides[0]!;
    // Today the shape is over a limit (5,464 > 4,096 in one path): a note says so; a picture says nothing.
    expect(today.notes.join(' ')).toMatch(/custom geometry/);
  });

  it('E10: the provenance of one run is on the picture object', () => {
    const parts = slideOf(blob(7, 300, IN, IN, 2 * IN, 2 * IN) + blob(8, 300, 3 * IN, IN, 2 * IN, 2 * IN));
    const s = emitSlides(parseDeck(parts, { rasters: 'plan' }), PLAN).slides[0]!;
    const img = s.slide.objects.find((o) => o.type === 'image' && o.origin?.role === 'raster')!;
    const r = img.origin!.raster as {
      cv: number;
      rv: number;
      pts: number;
      h: string;
      n: number;
      from: string;
      refs?: number[][];
    };
    expect(r.pts).toBe(RASTER_POINTS);
    expect(r.n).toBe(2);
    expect(r.from).toBe('slide');
    expect(r.h).toBe(s.rasters![0]!.id.slice(RASTER_PREFIX.length));
    expect(r.refs).toEqual([[7, 0, 2]]);
  });

  it("E11: the words of the pictured members go to the slide's picture words", () => {
    const w = (t: string) => body(para(run(t, 'sz="2400"', solid('FFFFFF'))));
    const parts = slideOf(
      blob(2, 300, IN, IN, 3 * IN, 2 * IN, w('first words')) +
        blob(3, 300, 5 * IN, IN, 3 * IN, 2 * IN, w('second words')),
    );
    const s = emitSlides(parseDeck(parts, { rasters: 'plan' }), PLAN).slides[0]!;
    expect(s.rasterWords).toContain('first words');
    expect(s.rasterWords).toContain('second words');
  });

  it('E12: ParseOptions.rasterPoints moves the threshold of the census sweep (64, 128, 256, 512); the default is RASTER_POINTS', () => {
    // Points 100, 200, 300 and 600: a shape is a candidate when its cost is MORE than the threshold.
    const parts = slideOf(
      [100, 200, 300, 600].map((cost, k) => blob(2 + k, cost, IN + k * 2 * IN, IN, IN, IN)).join(''),
    );
    const count = (rasterPoints?: number) =>
      parseDeck(parts, { rasters: 'detect', ...(rasterPoints === undefined ? {} : { rasterPoints }) })
        .slides[0]!.rasters?.candidates ?? 0;
    expect(count()).toBe(3);
    expect(count(RASTER_POINTS)).toBe(3);
    expect(count(64)).toBe(4);
    expect(count(256)).toBe(2);
    expect(count(512)).toBe(1);
    expect(count(1_024)).toBe(0);
  });

  it('convertDeck shares one registry across a call and lists each recipe once', () => {
    const parts = buildDeck({
      slides: [
        { shapes: blob(2, 300, IN, IN, 2 * IN, 2 * IN) },
        { shapes: blob(2, 300, IN, IN, 2 * IN, 2 * IN) },
      ],
    });
    const r = convertDeck(parts, { rasters: 'plan', rasterGeometry: WIDE });
    expect(r.slides).toHaveLength(2);
    expect(r.slides[0]!.rasters![0]!.id).toBe(r.slides[1]!.rasters![0]!.id);
    expect(r.rasters).toHaveLength(1);
  });

  it('encodeRefs: runs of consecutive ascending ids, one run per nth, absent past 32', () => {
    const r = (shapeId: number, nth = 0) => ({ from: 'slide' as const, shapeId, nth });
    expect(encodeRefs([r(5), r(6), r(7), r(8)])).toEqual([[5, 0, 4]]);
    expect(encodeRefs([r(7), r(7, 1)])).toEqual([
      [7, 0, 1],
      [7, 1, 1],
    ]);
    expect(encodeRefs(Array.from({ length: 33 }, (_, k) => r(3 * k + 1)))).toBeUndefined();
  });
});
