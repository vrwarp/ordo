import { type ImageObject, type ShapeObject, Slide, type SlideObject, type TextObject } from '@ordo/domain';
import * as prev from '@ordo/domain/schemas.prev.test-util.ts';
import { charged, EFFECT_COST, GEOM_COST } from '@ordo/renderer/geom/cost.ts';
import { CMD_CLOSE, CMD_MOVE } from '@ordo/renderer/geom/ops.ts';
import { presetGeometry } from '@ordo/renderer/geom/path.ts';
import { storedGeometry } from '@ordo/renderer/geom/stored.ts';
import { drawnCost, drawnEffectArea, overGeomBudget, slideBudget } from '@ordo/renderer/geombudget.ts';
import { describe, expect, it } from 'vitest';
import type { EmitOptions } from './emit.ts';
import { apply } from './frame.ts';
import {
  MAX_PATH_CHARS,
  MAX_SLIDE_PATH_POINTS,
  mergedChars,
  mergedPaths,
  nearestDash,
  replaceEnds,
  shapePiece,
} from './geom.ts';
import { emitSlides, parseDeck } from './index.ts';
import type { ShapeElement } from './ir.ts';
import { drawingXml, dspSp, smartArtFrame, smartArtRels, withSmartArt } from './smartart.test-util.ts';
import {
  body,
  buildDeck,
  custGeom,
  cxnSp,
  type DeckSpec,
  grpSp,
  imageRel,
  para,
  pic,
  run,
  solid,
  sp,
  tableFrame,
  tc,
  themeXml,
  inlineGeoms,
} from './test-util.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const IN = 914_400;
/** Logical px per inch on a standard slide (2 px per point). */
const PX = 144;
const RED = { r: 255, g: 0, b: 0, a: 1 };

/** Emit the first slide of a deck; every emitted slide must be one `Slide.parse` returns unchanged. */
function emitOne(spec: DeckSpec, opts: EmitOptions = {}) {
  const scene = parseDeck(buildDeck(spec));
  const stored = emitSlides(scene, opts);
  for (const s of stored.slides) expect(Slide.parse(s.slide)).toEqual(s.slide);
  // The paths as drawn: a geometry file's in place of its ref.
  const out = inlineGeoms(stored);
  const e = out.slides[0]!;
  return { scene, slide: e.slide, notes: e.notes, objects: e.slide.objects.slice(1), emitted: e };
}

const shapes = (objects: SlideObject[]) => objects.filter((o): o is ShapeObject => o.type === 'shape');
const texts = (objects: SlideObject[]) => objects.filter((o): o is TextObject => o.type === 'text');
const images = (objects: SlideObject[]) => objects.filter((o): o is ImageObject => o.type === 'image');

/** A filled shape with custom geometry and maybe text. */
function custom(
  id: number,
  geom: Parameters<typeof custGeom>[0],
  extra: { cx?: number; cy?: number; text?: string } = {},
) {
  return sp({
    id,
    x: 0,
    y: 0,
    cx: extra.cx ?? 2 * IN,
    cy: extra.cy ?? IN,
    geom: 'none',
    fill: custGeom(geom) + solid('FF0000'),
    ...(extra.text ? { txBody: body(para(run(extra.text))) } : {}),
  });
}

const pt = (x: string | number, y: string | number) => `<a:pt x="${x}" y="${y}"/>`;
const M = (x: string | number, y: string | number) => `<a:moveTo>${pt(x, y)}</a:moveTo>`;
const L = (x: string | number, y: string | number) => `<a:lnTo>${pt(x, y)}</a:lnTo>`;
const Z = '<a:close/>';

/** The numbers of a path string. */
const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number);

/**
 * A traced decoration as Google Slides writes it: one outline with 49 holes inside it (6,582 points), in a
 * space of 7-digit EMU coordinates. Neither a bounding-box split nor one string can hold it, and the outline
 * alone passes 40,000 characters.
 */
const TRACED_W = 2_334_080;
const TRACED_H = 3_165_466;
const TRACED = (() => {
  const W = TRACED_W;
  const H = TRACED_H;
  const r = (v: number) => Math.round(v);
  const cubicRing = (cx: number, cy: number, rx: number, ry: number, n: number) => {
    const at = (i: number): [number, number] => {
      const a = (2 * Math.PI * i) / n;
      return [r(cx + rx * Math.cos(a)), r(cy + ry * Math.sin(a))];
    };
    let out = `<a:moveTo>${pt(...at(0))}</a:moveTo>`;
    for (let i = 0; i < n; i++)
      out += `<a:cubicBezTo>${pt(...at(i + 1 / 3))}${pt(...at(i + 2 / 3))}${pt(...at(i + 1))}</a:cubicBezTo>`;
    return out;
  };
  // The outline: 1,327 cubic segments and 2 lines (3,985 points with its move and close).
  let d = cubicRing(W / 2, H / 2, W * 0.48, H * 0.48, 1_327);
  d += `${L(r(W * 0.98), r(H / 2) + 1)}${L(r(W * 0.98), r(H / 2))}${Z}`;
  // 49 holes of 17 cubic segments (53 points each) on a 7 x 7 grid well inside it.
  for (let i = 0; i < 49; i++)
    d +=
      cubicRing(W * (0.3 + 0.066 * (i % 7)), H * (0.3 + 0.066 * Math.floor(i / 7)), W / 60, H / 60, 17) + Z;
  return `<a:path w="${W}" h="${H}">${d}</a:path>`;
})();

describe('custom geometry (a:custGeom → ShapeGeom.paths)', () => {
  it('writes each path in its own space with arcs as cubics, fill modes, stroke flags, text rect and sites', () => {
    const geom = {
      paths:
        `<a:path w="200" h="100">${M(0, 50)}<a:arcTo wR="100" hR="50" stAng="10800000" swAng="10800000"/>${Z}</a:path>` +
        `<a:path w="200" h="100" fill="darken" stroke="false">${M(0, 50)}${L(200, 50)}${L(200, 100)}${L(0, 100)}${Z}</a:path>`,
      rect: 'l="wd4" t="t" r="r" b="vc"',
      cxn: '<a:cxn ang="0"><a:pos x="r" y="vc"/></a:cxn>',
    };
    const { objects, scene } = emitOne({ slides: [{ shapes: custom(2, geom, { text: 'Hi' }) }] });
    const [shape] = shapes(objects);
    expect(shape).toMatchObject({ shape: 'rect', fill: RED });
    const [arc, band] = shape!.geom!.paths!;
    expect(arc).toMatchObject({ w: 200, h: 100 });
    expect(arc!.fill).toBeUndefined();
    expect(arc!.d.replace(/[-\d. ]/g, '')).toBe('MCCZ'); // half an ellipse: two cubic segments
    expect(numbers(arc!.d).slice(0, 2)).toEqual([0, 50]);
    expect(numbers(arc!.d).slice(-2)).toEqual([200, 50]);
    // The first segment ends at the top of the ellipse (100, 0).
    expect(numbers(arc!.d)[6]).toBeCloseTo(100, 1);
    expect(numbers(arc!.d)[7]).toBeCloseTo(0, 1);
    expect(band).toEqual({
      d: 'M 0 50 L 200 50 L 200 100 L 0 100 Z',
      w: 200,
      h: 100,
      fill: 'darken',
      stroke: false,
    });
    // The text rectangle is the geometry's a:rect: the right three quarters of the upper half.
    const [t] = texts(objects);
    expect(t!.box.x).toBeCloseTo(0.5 * PX);
    expect(t!.box.y).toBeCloseTo(0);
    expect(t!.box.w).toBeCloseTo(1.5 * PX);
    expect(t!.box.h).toBeCloseTo(0.5 * PX);
    const e = scene.slides[0]!.elements[0] as ShapeElement;
    expect(e.support).toBe('native');
    expect(e.custom!.sites).toEqual([{ x: 1, y: 0.5, angle: 0 }]);
  });

  it('writes a path without its own space in the box, in logical px, guides evaluated at the box', () => {
    const geom = {
      gd: '<a:gd name="mid" fmla="*/ w 1 2"/>',
      paths: `<a:path>${M('l', 't')}${L('w', 'h')}${L('mid', 'h')}${Z}</a:path>`,
    };
    const { objects } = emitOne({ slides: [{ shapes: custom(2, geom, { cx: IN, cy: IN / 2 }) }] });
    expect(shapes(objects)[0]!.geom).toEqual({ paths: [{ d: 'M 0 0 L 144 72 L 72 72 Z', w: 144, h: 72 }] });
  });

  it('notes what the compiler replaced by 0, and still draws the shape natively', () => {
    const geom = { paths: `<a:path w="10" h="10">${M(0, 0)}${L('nope', 10)}${L(10, 10)}${Z}</a:path>` };
    const { objects, notes, scene } = emitOne({ slides: [{ shapes: custom(2, geom) }] });
    expect(shapes(objects)[0]!.geom!.paths![0]!.d).toBe('M 0 0 L 0 10 L 10 10 Z');
    expect(notes.join(' ')).toMatch(/custom geometry: unknown name 'nope'/);
    expect(scene.slides[0]!.elements[0]!.support).toBe('native');
  });

  it('leaves geometry past the bounds to LibreOffice (residual, hybrid slide)', () => {
    let many = M(0, 0);
    for (let i = 0; i < 4_100; i++) many += L(i % 10, (i * 7) % 10);
    const geom = { paths: `<a:path w="10" h="10">${many}${Z}</a:path>` };
    const { scene, emitted, notes } = emitOne({ slides: [{ shapes: custom(2, geom) }] });
    const e = scene.slides[0]!.elements[0] as ShapeElement;
    expect(e).toMatchObject({ support: 'residual', custom: { over: true } });
    expect(e.reasons).toContain('custGeom');
    expect(emitted.classification).toMatchObject({ class: 'hybrid' });
    expect(emitted.classification.reasons).toContain('art:custGeom');
    expect(notes.join(' ')).toMatch(/path points over the limit/);
    // Version 1 shows it as its legacy rect until the art replaces it.
    expect(shapes(emitted.slide.objects.slice(1))[0]!.geom).toBeUndefined();
  });

  it('compiles a long path in pieces at its sub-paths and stores it whole while its real points fit', () => {
    // 400 quarter circles: the compiler counts each arc as a full turn (12 points, 5,200 in all); built,
    // each is one cubic segment (1,600 points).
    let arcs = '';
    for (let i = 0; i < 400; i++) arcs += `${M(i * 10, 0)}<a:arcTo wR="5" hR="5" stAng="0" swAng="5400000"/>`;
    const { scene, objects } = emitOne({
      slides: [{ shapes: custom(2, { paths: `<a:path w="4000" h="10">${arcs}</a:path>` }) }],
    });
    const e = scene.slides[0]!.elements[0] as ShapeElement;
    expect(e.support).toBe('native');
    expect(e.custom!.over).toBeUndefined();
    const [path] = shapes(objects)[0]!.geom!.paths!;
    expect(shapes(objects)[0]!.geom!.paths).toHaveLength(1); // one path: its sub-paths share the fill rule
    expect(path!.d.replace(/[-\d. ]/g, '')).toBe('MC'.repeat(400));
    // Past the render clamp's points once built, with every sub-path overlapping the others, the joined
    // path is a chain of two pieces cut at a sub-path's start, drawn as one path. (A small box: its 1,100
    // sub-paths cross one another, which in a box of 2 x 1 inches passes the drawing budget, geom/cost.ts.)
    let lines = '';
    for (let i = 0; i < 1_100; i++) lines += `${M(i % 10, 0)}${L(1, 1)}${L(2, 2)}${L(3, 3)}`;
    const big = emitOne({
      slides: [
        {
          shapes: custom(2, { paths: `<a:path w="10" h="10">${lines}</a:path>` }, { cx: IN / 8, cy: IN / 8 }),
        },
      ],
    });
    expect(big.scene.slides[0]!.elements[0]!.support).toBe('native');
    const chain = shapes(big.objects)[0]!.geom!.paths!;
    expect(chain.map((p) => p.cont)).toEqual([undefined, true]);
    expect(chain.map((p) => (p.d.match(/[ML]/g) ?? []).length)).toEqual([4_096, 304]);
    expect(chain.every((p) => p.d.startsWith('M '))).toBe(true);
    expect(chain.map((p) => p.d).join(' ')).toBe(
      (lines.match(/<a:pt x="\d+" y="\d+"\/>/g) ?? [])
        .map((t, i) => `${i % 4 ? 'L' : 'M'} ${numbers(t).join(' ')}`)
        .join(' '),
    );
  });

  it('stores a traced outline holding all its holes as a chain: 6,582 points, 49 holes (cont)', () => {
    // The outline alone passes 40,000 characters, so it is cut between two of its commands too.
    const { scene, objects } = emitOne({ slides: [{ shapes: custom(2, { paths: TRACED }) }] });
    const e = scene.slides[0]!.elements[0] as ShapeElement;
    expect(e.support).toBe('native');
    expect(e.custom!.over).toBeUndefined();
    expect(e.custom!.points).toBe(6_582);
    const chain = shapes(objects)[0]!.geom!.paths!;
    expect(chain.length).toBeGreaterThan(2);
    expect(chain.length).toBeLessThanOrEqual(8);
    expect(chain[0]!.cont).toBeUndefined();
    expect(chain.slice(1).every((p) => p.cont === true)).toBe(true);
    const pointsOf = (s: string) => (s.match(/[MLZ]/g) ?? []).length + 3 * (s.match(/C/g) ?? []).length;
    for (const p of chain) {
      expect(p).toMatchObject({ w: TRACED_W, h: TRACED_H });
      expect(p.d.length).toBeLessThanOrEqual(MAX_PATH_CHARS);
      expect(pointsOf(p.d)).toBeLessThanOrEqual(4_096);
    }
    // The outline goes on in the second piece without a move: one sub-path, cut between two commands.
    expect(chain[1]!.d.startsWith('C ')).toBe(true);
    // Joined, the pieces are the path: 50 sub-paths, all its points.
    const whole = chain.map((p) => p.d).join(' ');
    expect((whole.match(/M/g) ?? []).length).toBe(50);
    expect(pointsOf(whole)).toBe(6_582);
    // The renderer draws them as that one path (one even-odd fill: the holes stay holes).
    const built = storedGeometry(shapes(objects)[0]!.geom, 300, 400)!;
    expect(built.paths).toHaveLength(1);
    expect(built.paths[0]!.cmds.filter((c) => c === CMD_MOVE)).toHaveLength(50);
    expect(built.paths[0]!.cmds.filter((c) => c === CMD_CLOSE)).toHaveLength(50);
    // An older M6 build fills each piece on its own; a pre-M6 build draws the legacy rectangle.
    expect(shapes(objects)[0]).toMatchObject({ shape: 'rect', fill: RED });
  });

  it('splits a path past the render clamp at sub-paths that do not overlap', () => {
    let cells = '';
    for (let i = 0; i < 1_100; i++) cells += `${M(i * 10, 0)}${L(i * 10 + 3, 0)}${L(i * 10 + 3, 3)}${Z}`;
    // A box a quarter inch tall: 2,200 edges side by side on every row of a taller one pass the drawing
    // estimate (geom/cost.ts counts edges active at once as if they crossed).
    const { scene, objects } = emitOne({
      slides: [
        { shapes: custom(2, { paths: `<a:path w="11000" h="10">${cells}</a:path>` }, { cy: IN / 4 }) },
      ],
    });
    expect(scene.slides[0]!.elements[0]!.support).toBe('native');
    const paths = shapes(objects)[0]!.geom!.paths!;
    expect(paths).toHaveLength(2);
    const points = (d: string) => (d.match(/[MLZ]/g) ?? []).length;
    expect(points(paths[0]!.d) + points(paths[1]!.d)).toBe(4_400);
    expect(paths.every((p) => points(p.d) <= 4_096)).toBe(true);
  });

  it('chains a path whose string passes the schema bound, and leaves one past 8 pieces to LibreOffice', () => {
    const far = (n: number) => {
      let out = M(0, 0);
      for (let i = 0; i < n; i++) out += L(123_456_789.5 + i, 987_654_321.25 - i);
      return out;
    };
    const space = 'w="1000000000" h="1000000000"';
    // 3,001 points of about 22 characters each: two pieces at every decimal the space keeps.
    const two = emitOne({
      slides: [{ shapes: custom(2, { paths: `<a:path ${space}>${far(3_000)}${Z}</a:path>` }) }],
    });
    expect(two.scene.slides[0]!.elements[0]!.support).toBe('native');
    expect(shapes(two.objects)[0]!.geom!.paths!.map((p) => p.cont)).toEqual([undefined, true]);
    // Four sub-paths of 4,000 points: about 350,000 characters, past 8 pieces of 40,000.
    const many = `<a:path ${space}>${[0, 1, 2, 3].map(() => far(3_999) + Z).join('')}</a:path>`;
    const { scene } = emitOne({ slides: [{ shapes: custom(2, { paths: many }) }] });
    const e = scene.slides[0]!.elements[0] as ShapeElement;
    expect(e.custom!.over).toBe(true);
    expect(e.support).toBe('residual');
    expect(e.custom!.paths.every((p) => p.d.length <= MAX_PATH_CHARS)).toBe(true);
  });

  it('counts path points per slide: past 64k, further custom geometry is LibreOffice’s', () => {
    // 4,001 points round a circle each (cheap to draw: the drawing budget is not what decides here).
    let path = M(100_000, 50_000);
    for (let i = 1; i < 4_000; i++) {
      const a = (i / 4_000) * 2 * Math.PI;
      path += L(Math.round(50_000 + 50_000 * Math.cos(a)), Math.round(50_000 + 50_000 * Math.sin(a)));
    }
    const one = (id: number) => custom(id, { paths: `<a:path w="100000" h="100000">${path}${Z}</a:path>` });
    const count = Math.ceil(MAX_SLIDE_PATH_POINTS / 4_001) + 1;
    let all = '';
    for (let i = 0; i < count; i++) all += one(2 + i);
    const t0 = performance.now();
    const scene = parseDeck(buildDeck({ slides: [{ shapes: all }] }));
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
    const els = scene.slides[0]!.elements as ShapeElement[];
    expect(els.slice(0, count - 2).every((e) => e.support === 'native')).toBe(true);
    expect(els[count - 1]).toMatchObject({ support: 'residual', custom: { over: true } });
    expect(scene.slides[0]!.notes.join(' ')).toMatch(/more than 65536 path points/);
  });

  it('keeps a custGeom too costly to draw whole, for the decoration plate: edges zigzagging across the box (M9)', () => {
    // Within every count (4,000 points, one path), but Canvas would spend seconds filling it at 4K.
    const zigzag = (points: number) => {
      let d = M(10_000, 10_000);
      for (let k = 1; k < points; k++) {
        const a = (k / points) * Math.PI * 2 * 37;
        const r = k % 2 ? 10_000 : 500;
        d += L(Math.round(10_000 + r * Math.cos(a)), Math.round(10_000 + r * Math.sin(a)));
      }
      return `<a:path w="20000" h="20000">${d}${Z}</a:path>`;
    };
    const big = { cx: 12_192_000, cy: 6_858_000 };
    const hostile = emitOne({ slides: [{ shapes: custom(2, { paths: zigzag(4_000) }, big) }] });
    const e = hostile.scene.slides[0]!.elements[0] as ShapeElement;
    // M9 (decisions.md "Slow-to-draw elements"): kept whole, never sent to LibreOffice, and named for the
    // slide's decoration plate; every drawer draws its legacy shape until a plate holds it.
    expect(e).toMatchObject({ support: 'native', custom: { complex: true } });
    expect(e.reasons).toBeUndefined();
    expect(e.custom!.over).toBeUndefined();
    expect(e.custom!.cost).toBeGreaterThan(GEOM_COST.geometry);
    expect(hostile.scene.slides[0]!.notes.join(' ')).toMatch(/too costly to draw at once/);
    const kept = shapes(hostile.objects)[0]!;
    expect(kept.geom?.paths?.length).toBeGreaterThan(0);
    expect(hostile.emitted.plate?.pastBudget).toEqual([kept.id]);
    // The slide's budget: each of these fits on its own; the shapes past the slide's estimate (with
    // GEOM_COST.point a stored point) do not.
    const charge = (e: ShapeElement) => e.custom!.cost! + e.custom!.points * GEOM_COST.point;
    const one = parseDeck(buildDeck({ slides: [{ shapes: custom(2, { paths: zigzag(380) }, big) }] }));
    const first = one.slides[0]!.elements[0] as ShapeElement;
    expect(first.custom!.cost!).toBeLessThan(GEOM_COST.geometry);
    const fit = Math.floor((GEOM_COST.slide * 0.98) / charge(first));
    expect(fit).toBeGreaterThanOrEqual(1);
    let all = '';
    for (let i = 0; i < fit + 2; i++) all += custom(2 + i, { paths: zigzag(380) }, big);
    const many = emitOne({ slides: [{ shapes: all }] });
    const els = many.scene.slides[0]!.elements as ShapeElement[];
    expect(els.every((x) => x.support === 'native')).toBe(true);
    expect(els.map((x) => !!x.custom!.complex)).toEqual([
      ...Array.from({ length: fit }, () => false),
      true,
      true,
    ]);
    // Emitted whole; the renderer draws what passes its budget as legacy shapes: the plate's list.
    expect(shapes(many.objects).every((o) => o.geom?.paths?.length)).toBe(true);
    expect(many.emitted.plate?.pastBudget.length).toBe(slideBudget(many.slide.objects).size);
    expect(slideBudget(many.slide.objects).size).toBeGreaterThan(0);
    // An outline is rated as drawn (renderer geom/cost.ts strokeCost: two offset edges a leg, each join).
    const line = '<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr>';
    const outlinedOne = (id: number) => custom(id, { paths: zigzag(100) }, big).replace('</p:spPr>', line);
    const plain = parseDeck(buildDeck({ slides: [{ shapes: custom(2, { paths: zigzag(100) }, big) }] }));
    const small = parseDeck(buildDeck({ slides: [{ shapes: outlinedOne(2) }] }));
    const lone = small.slides[0]!.elements[0] as ShapeElement;
    expect(lone.custom!.cost!).toBeGreaterThan(
      2 * (plain.slides[0]!.elements[0] as ShapeElement).custom!.cost!,
    );
    const fitOutlined = Math.floor((GEOM_COST.slide * 0.98) / charge(lone));
    expect(fitOutlined).toBeGreaterThanOrEqual(1);
    let outlined = '';
    for (let i = 0; i <= fitOutlined; i++) outlined += outlinedOne(2 + i);
    const lined = parseDeck(buildDeck({ slides: [{ shapes: outlined }] })).slides[0]!
      .elements as ShapeElement[];
    expect(lined.every((x) => x.support === 'native')).toBe(true);
    expect(lined.map((x) => !!x.custom!.complex)).toEqual([
      ...Array.from({ length: fitOutlined }, () => false),
      true,
    ]);
  });

  it("rates a custGeom's outline as drawn: a wide line on a tiny path, and arrowheads on many sub-paths (M6 finish)", () => {
    let seed = 5;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 1_000_000) / 1_000_000;
    };
    const big = { cx: 6_350_000, cy: 6_350_000 };
    // The re-review's: eight paths of 2,000 points within 10 units of a 20000 space (half a pixel), a 400 px
    // line (3.9 s at 3840 for two of them); then 8 x 1,500 open 1 px sub-paths with large triangles at both
    // ends of a 100 px line (24,000 arrowhead fills, 2.6 s at 3840).
    let cloud = '';
    for (let p = 0; p < 8; p++) {
      let d = M(10_000, 10_000);
      for (let k = 1; k < 2_000; k++) {
        const a = rand() * Math.PI * 2;
        const q = Math.sqrt(rand()) * 10;
        d += L(Math.round(10_000 + q * Math.cos(a)), Math.round(10_000 + q * Math.sin(a)));
      }
      cloud += `<a:path w="20000" h="20000">${d}</a:path>`;
    }
    const wide = custom(2, { paths: cloud }, big).replace(
      '</p:spPr>',
      '<a:ln w="2540000"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:round/></a:ln></p:spPr>',
    );
    let bits = '';
    for (let p = 0; p < 8; p++) {
      let d = '';
      for (let k = 0; k < 1_500; k++) {
        const x = Math.round(10_000 + (rand() - 0.5) * 400);
        const y = Math.round(10_000 + (rand() - 0.5) * 400);
        const a = rand() * Math.PI * 2;
        d += M(x, y) + L(Math.round(x + 20 * Math.cos(a)), Math.round(y + 20 * Math.sin(a)));
      }
      bits += `<a:path w="20000" h="20000" fill="none">${d}</a:path>`;
    }
    const ends = custom(3, { paths: bits }, big).replace(
      '</p:spPr>',
      '<a:ln w="635000"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>' +
        '<a:headEnd type="triangle" w="lg" len="lg"/><a:tailEnd type="triangle" w="lg" len="lg"/></a:ln></p:spPr>',
    );
    for (const one of [wide, ends]) {
      const out = emitOne({ slides: [{ shapes: one }] });
      const e = out.scene.slides[0]!.elements[0] as ShapeElement;
      // M9: kept whole for the decoration plate; the renderer draws its legacy shape until then.
      expect(e).toMatchObject({ support: 'native', custom: { complex: true } });
      expect(e.custom!.fillCost!).toBeLessThan(GEOM_COST.geometry);
      expect(e.custom!.cost!).toBeGreaterThan(GEOM_COST.slide);
      expect(out.notes.join(' ')).toMatch(
        /past the slide's drawing budget are drawn from its decoration plate/,
      );
      const o = shapes(out.objects)[0]!;
      expect(o.geom?.paths?.length).toBeGreaterThan(0);
      expect(out.emitted.plate?.pastBudget).toEqual([o.id]);
      expect(slideBudget(out.slide.objects).has(o)).toBe(true);
    }
  });

  it("rates presets' outlines against the slide's budget too, keeping them whole: thin dashes on full-slide rects (M9)", () => {
    // A sysDot line one EMU wide is drawn half a pixel wide: a full-slide rect of 6,000 dots.
    const rect = (id: number) =>
      sp({ id, x: 0, y: 0, cx: 12_192_000, cy: 6_858_000, geom: 'rect' }).replace(
        '</p:spPr>',
        '<a:ln w="1"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="sysDot"/></a:ln></p:spPr>',
      );
    let all = '';
    for (let i = 0; i < 30; i++) all += rect(2 + i);
    const out = emitOne({ slides: [{ shapes: all }] });
    const els = out.scene.slides[0]!.elements as ShapeElement[];
    // M9: none goes to the art; every rect keeps its dash, and those the renderer draws past its budget
    // (plain, until the decoration plate holds them) are the plate's list.
    expect(els.every((e) => e.support === 'native' && !e.reasons)).toBe(true);
    expect(shapes(out.objects)).toHaveLength(30);
    expect(shapes(out.objects).every((o) => o.dash === 'sysDot')).toBe(true);
    const past = overGeomBudget(out.slide.objects);
    expect(past.size).toBeGreaterThan(0);
    expect(past.size).toBeLessThan(30);
    expect(out.emitted.plate?.pastBudget).toEqual([...past].map((o) => o.id));
  });

  it('charges a masked picture with an outline as the renderer does: the mask filled, the outline stroked', () => {
    const star = (n: number, k: number) => {
      let d = '';
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + k;
        const r = 9_000 - k * 900;
        d += (i ? L : M)(Math.round(10_000 + r * Math.cos(a)), Math.round(10_000 + r * Math.sin(a)));
      }
      return `<a:path w="20000" h="20000">${d}${Z}</a:path>`;
    };
    const mask = custGeom({ paths: Array.from({ length: 4 }, (_, k) => star(600, k)).join('') });
    const picture = (id: number, x: number) =>
      pic({ id, x, y: 254_000, cx: 3_000_000, cy: 3_000_000, rId: 'rId2' }).replace(
        /<a:prstGeom prst="rect"><a:avLst\/><\/a:prstGeom><\/p:spPr>/,
        `${mask}<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr>`,
      );
    const one = emitOne({ slides: [{ rels: [imageRel('rId2', 'a.png')], shapes: picture(3, 254_000) }] });
    const el = one.scene.slides[0]!.elements.find((e) => e.kind === 'picture') as {
      custom: { cost: number; points: number };
    };
    // The renderer draws a masked image and a stroke-only shape along the same geometry: both charged.
    const drawn = one.slide.objects.filter(
      (o) => (o.type === 'image' && o.mask) || (o.type === 'shape' && o.geom),
    );
    expect(drawn.map((o) => o.type)).toEqual(['image', 'shape']);
    const renderer = drawn.reduce((n, o) => n + charged(drawnCost(o)), 0);
    const converter = el.custom.cost + 2 * el.custom.points * GEOM_COST.point;
    expect(Math.abs(renderer - converter) / converter).toBeLessThan(0.05);
    // As many as fit after the slide's background (a full-slide white rect, charged first): the converter
    // keeps native what the renderer draws natively.
    const background = charged(drawnCost(one.slide.objects[0]!));
    expect(background).toBeGreaterThan(1920 * 1080 * GEOM_COST.opaqueArea);
    const fit = Math.floor((GEOM_COST.slide * 0.98 - background) / converter);
    let all = '';
    for (let i = 0; i <= fit; i++) all += picture(3 + i, 254_000 + i * 100_000);
    const out = emitOne({ slides: [{ rels: [imageRel('rId2', 'a.png')], shapes: all }] });
    const pics = out.scene.slides[0]!.elements.filter((e) => e.kind === 'picture') as {
      custom?: { over?: boolean };
    }[];
    // M9: every mask is kept; the renderer draws the last one past its budget, which the plate holds.
    expect(pics.every((p) => !p.custom?.over)).toBe(true);
    const past = overGeomBudget(out.slide.objects);
    expect(past.size).toBeGreaterThan(0);
    expect(out.emitted.plate?.pastBudget).toEqual(expect.arrayContaining([...past].map((o) => o.id)));
  });

  it("sizes effects by what the shape draws: a custGeom past its box, a small shape's wide outline (M6 finish review)", () => {
    const EMU = 6_350; // a logical px
    const shadow =
      '<a:effectLst><a:outerShdw blurRad="38100" dist="25400" dir="2700000" algn="tl" rotWithShape="0">' +
      '<a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst>';
    // A 10 px box at the centre whose path (w = h = 10: a unit a px) covers the slide, opaque: its shadow
    // layer covers the canvas. Twelve fit the drawing budget; their effects do not fit the effect budget.
    const outside = (id: number) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="S${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>` +
      `<a:xfrm><a:off x="${955 * EMU}" y="${535 * EMU}"/><a:ext cx="${10 * EMU}" cy="${10 * EMU}"/></a:xfrm>` +
      custGeom({
        paths: `<a:path w="10" h="10">${M(-960, -540)}${L(970, -540)}${L(970, 550)}${L(-960, 550)}${Z}</a:path>`,
      }) +
      `${solid('3366CC')}<a:ln><a:noFill/></a:ln>${shadow}</p:spPr></p:sp>`;
    let all = '';
    for (let i = 0; i < 12; i++) all += outside(2 + i);
    const out = emitOne({ slides: [{ shapes: all }] });
    const drawn = shapes(out.objects);
    expect(drawn.filter((o) => o.geom).length).toBe(12);
    // M9: every shape keeps its shadow; those past the effect budget are drawn without it by every drawer
    // until the slide's decoration plate holds their effect layers.
    expect(drawn.filter((o) => o.shadow)).toHaveLength(12);
    const past = slideBudget(out.slide.objects);
    expect(past.size).toBeGreaterThan(2);
    expect(past.size).toBeLessThanOrEqual(4);
    const drawnWith = drawn.filter((o) => !past.has(o));
    expect(drawnWith.reduce((a, o) => a + drawnEffectArea(o), 0)).toBeLessThanOrEqual(EFFECT_COST.slide);
    expect(out.notes.join(' ')).toMatch(/past the slide's effect budget are drawn from its decoration plate/);
    // No text: all of it is the static decoration stack, the background included.
    expect(out.emitted.plate?.stack).toHaveLength(13);
    expect(out.emitted.plate?.pastBudget).toEqual([...past.keys()].map((o) => o.id));

    // Thirty 10 px rects with a 500 px outline and a shadow (as the editor can make): each layer covers the
    // outline's square, so the drawing budget and the effect budget hold them; the renderer agrees.
    const ln = `<a:ln w="${500 * EMU}"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>`;
    let rects = '';
    for (let i = 0; i < 30; i++)
      rects += sp({
        id: 2 + i,
        x: 955 * EMU,
        y: 535 * EMU,
        cx: 10 * EMU,
        cy: 10 * EMU,
        fill: solid('C04040'),
        ln: ln + shadow,
      });
    const wide = emitOne({ slides: [{ shapes: rects }] });
    const w = shapes(wide.objects).filter((o) => o.shadow);
    expect(w).toHaveLength(30);
    expect(drawnEffectArea(w[0]!)).toBeGreaterThan(0.25);
    // The renderer draws those within the effect budget with their shadow, the rest without (M9: kept).
    const plan = slideBudget(wide.slide.objects);
    const withShadow = w.filter(
      (o) => !plan.has(o) || (plan.get(o)!.type === 'shape' && (plan.get(o) as ShapeObject).shadow),
    );
    expect(withShadow.reduce((a, o) => a + drawnEffectArea(o), 0)).toBeLessThanOrEqual(EFFECT_COST.slide);
    expect(withShadow.length).toBeLessThan(30);
  });

  it('charges the pixels each fill paints: a stack of full-slide gradients is kept whole for the plate (M9)', () => {
    // The review's 140 full-slide rects with a 50 % linear gradient (1.3 s at 3840, all native).
    const grad =
      '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:gs>' +
      '<a:gs pos="100000"><a:srgbClr val="0000FF"><a:alpha val="50000"/></a:srgbClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>';
    let all = '';
    for (let i = 0; i < 140; i++)
      all += sp({
        id: 2 + i,
        x: 0,
        y: 0,
        cx: 12_192_000,
        cy: 6_858_000,
        geom: 'rect',
        fill: grad,
        ln: '<a:ln><a:noFill/></a:ln>',
      });
    const out = emitOne({ slides: [{ shapes: all }] });
    const els = out.scene.slides[0]!.elements as ShapeElement[];
    // M9 (decisions.md "Slow-to-draw elements"): all 140 are kept whole, gradients and all, and the slide is
    // native; nothing goes to LibreOffice. The renderer draws each past its budget in its legacy colour (the
    // first stop) until the slide's decoration plate holds the stack (they lie under its first text).
    expect(els.every((e) => e.support === 'native' && !e.reasons)).toBe(true);
    expect(out.emitted.classification.class).toBe('native');
    const drawn = shapes(out.objects);
    expect(drawn).toHaveLength(140);
    expect(drawn.every((o) => o.gradient?.kind === 'linear' && o.fill?.r === 255 && o.fill.a === 0.5)).toBe(
      true,
    );
    expect(out.notes.join(' ')).toMatch(
      /past the slide's drawing budget are drawn from its decoration plate/,
    );
    const past = slideBudget(out.slide.objects);
    expect(past.size).toBeGreaterThan(130);
    expect(out.emitted.plate?.pastBudget).toEqual(drawn.filter((o) => past.has(o)).map((o) => o.id));
    expect(out.emitted.plate?.stack).toEqual(out.slide.objects.map((o) => o.id));
    // Six full-slide gradients, the review's (78 ms at 3840): all kept, as many drawn with their gradient as
    // fit over every one's legacy copy (one), the others in their first colour, as the renderer draws them.
    let six = '';
    for (let i = 0; i < 6; i++)
      six += sp({
        id: 2 + i,
        x: 0,
        y: 0,
        cx: 12_192_000,
        cy: 6_858_000,
        geom: 'rect',
        fill: grad,
        ln: '<a:ln><a:noFill/></a:ln>',
      });
    const few = emitOne({ slides: [{ shapes: six }] });
    expect(few.emitted.classification.class).toBe('native');
    expect(shapes(few.objects)).toHaveLength(6);
    // Stored whole (the wave 1 re-review: never flattened to the first colour); the renderer draws as many
    // with their gradient as fit over every one's legacy copy (one), the others in their first colour.
    expect(shapes(few.objects).every((o) => o.gradient)).toBe(true);
    const plan = slideBudget(few.slide.objects);
    expect(plan.size).toBe(5);
    expect([...plan.values()].every((o) => o.type === 'shape' && !o.gradient)).toBe(true);
  });

  it('keeps a textless shape only its pixels put past the budget, drawn as the renderer draws it there (M9 wave 1 repair)', () => {
    // An opaque three-stop radial background and a full-slide textless rect with the same radial: an opaque
    // radial off Skia's fast path costs what a translucent one does (render-seams), so the two pass
    // GEOM_COST.slide. The rect keeps its place in its legacy colour (the first stop); the slide stays native.
    const grad = (radial: boolean) =>
      '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="1F3864"/></a:gs><a:gs pos="50000"><a:srgbClr val="2E75B6"/></a:gs>' +
      `<a:gs pos="100000"><a:srgbClr val="DEEBF7"/></a:gs></a:gsLst>${radial ? '<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>' : '<a:lin ang="5400000" scaled="0"/>'}</a:gradFill>`;
    for (const radial of [true, false]) {
      const bg = `<p:bg><p:bgPr>${grad(radial)}<a:effectLst/></p:bgPr></p:bg>`;
      const deck = {
        slides: [
          {
            bg,
            shapes:
              sp({ id: 2, x: 0, y: 0, cx: 12_192_000, cy: 6_858_000, fill: grad(radial) }) +
              sp({
                id: 3,
                x: IN,
                y: IN,
                cx: 6_000_000,
                cy: IN,
                fill: '<a:noFill/>',
                txBox: true,
                txBody: body(para(run('Amazing grace'))),
              }),
          },
        ],
      };
      const out = emitOne(deck);
      expect(out.emitted.classification.class, `radial ${radial}`).toBe('native');
      const rect = out.scene.slides[0]!.elements.find((e) => e.shapeId === 2) as ShapeElement;
      expect(rect.support).toBe('native');
      expect(out.slide.objects.map((o) => o.type)).toEqual(['shape', 'shape', 'text']);
      const [bgObj, rectObj] = shapes(out.slide.objects);
      expect(bgObj!.gradient?.kind).toBe(radial ? 'radial' : 'linear');
      // M9 (the wave 1 re-review): stored whole, its radial kept for the editor and the plate.
      expect(rectObj!.gradient?.kind).toBe(radial ? 'radial' : 'linear');
      expect(rectObj!.fill).toEqual({ r: 0x1f, g: 0x38, b: 0x64, a: 1 });
      const plan = slideBudget(out.slide.objects);
      if (radial) {
        // In its legacy colour (the first stop) as the renderer's budget draws it, until the plate holds it.
        expect(plan.get(rectObj!)).toMatchObject({ fill: { r: 0x1f, g: 0x38, b: 0x64, a: 1 } });
        expect(plan.get(rectObj!)?.type === 'shape' && plan.get(rectObj!)).not.toHaveProperty('gradient');
        expect(out.emitted.plate?.pastBudget).toEqual([rectObj!.id]);
      } else expect(plan.size).toBe(0);
      // Below the slide's text: on the slide's decoration plate with the background.
      expect(out.emitted.plate?.stack).toEqual([bgObj!.id, rectObj!.id]);
      // A hub without LibreOffice misses nothing.
      expect(emitOne(deck, { libreoffice: false }).emitted.missing).toBeUndefined();
    }
    // A plain panel after costly decorations (the worship lyric template: a gradient background and a large
    // translucent 3-stop gradient decoration fill the budget): kept, not left out.
    const deco =
      '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"><a:alpha val="10000"/></a:srgbClr></a:gs>' +
      '<a:gs pos="50000"><a:srgbClr val="FFFFFF"><a:alpha val="8000"/></a:srgbClr></a:gs><a:gs pos="100000"><a:srgbClr val="FFFFFF"><a:alpha val="1000"/></a:srgbClr></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill>';
    const panel = emitOne({
      slides: [
        {
          bg: `<p:bg><p:bgPr>${grad(false)}<a:effectLst/></p:bgPr></p:bg>`,
          shapes:
            sp({ id: 2, x: 0, y: 0, cx: 12_192_000, cy: 6_858_000, geom: 'rtTriangle', fill: deco }) +
            sp({ id: 3, x: 0, y: 0, cx: 12_192_000, cy: 6_858_000, geom: 'rtTriangle', fill: deco }) +
            sp({ id: 4, x: IN, y: IN, cx: 8 * IN, cy: 4 * IN, fill: solid('202020') }) +
            sp({
              id: 5,
              x: IN,
              y: IN,
              cx: 6_000_000,
              cy: IN,
              fill: '<a:noFill/>',
              txBox: true,
              txBody: body(para(run('Amazing grace'))),
            }),
        },
      ],
    });
    const els = panel.scene.slides[0]!.elements as ShapeElement[];
    expect(els.find((e) => e.shapeId === 4)!.support).toBe('native');
    expect(shapes(panel.objects).some((o) => o.fill?.r === 0x20 && !o.gradient)).toBe(true);
    // The decorations keep their gradients; the renderer draws what passes its budget plainly.
    expect(shapes(panel.objects).filter((o) => o.gradient)).toHaveLength(2);
  });

  it('reads hostile geometry within the bounds and quickly (design/27 §12, §14.3)', () => {
    const t0 = performance.now();
    const huge = '+- 1 1 1 '.repeat(500_000); // 4.5M characters: a formula over the bound is 0
    const closes = Z.repeat(150_000);
    const geom = {
      gd: `<a:gd name="${'n'.repeat(300_000)}" fmla="val 1"/><a:gd name="g" fmla="${huge}"/><a:gd name="__proto__" fmla="val 5"/>`,
      paths: `<a:path w="10" h="10">${M('__proto__', 'g')}${L(10, 10)}${closes}</a:path>`,
    };
    const { scene, objects, notes } = emitOne({ slides: [{ shapes: custom(2, geom) }] });
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
    const e = scene.slides[0]!.elements[0] as ShapeElement;
    // __proto__ is an ordinary guide (5); the over-long formula is 0; the closes past 4,096 points are
    // dropped, so LibreOffice draws the shape.
    expect(e.custom!.points).toBeLessThanOrEqual(4_096);
    expect(e.custom!.paths[0]!.d).toBe('M 5 0 L 10 10 Z');
    expect(e.custom!.over).toBe(true);
    expect(shapes(objects)[0]!.geom).toBeUndefined();
    expect(notes.join(' ')).toMatch(/a guide name over the limit binds nothing/);
    expect(notes.join(' ')).toMatch(/over-long formula/);
  });
});

describe('presets (a:prstGeom → ShapeGeom.preset)', () => {
  it('uses the preset’s text rectangle, mirrored with a flipped shape', () => {
    const tri = (id: number, flipH?: boolean) =>
      sp({
        id,
        x: 0,
        y: 0,
        cx: 2 * IN,
        cy: IN,
        geom: 'rtTriangle',
        fill: solid('FF0000'),
        flipH,
        txBody: body(para(run('x'))),
      });
    const g = presetGeometry('rtTriangle', 2 * IN, IN)!;
    const [l, r] = [g.text.l / g.w, g.text.r / g.w];
    expect(r - l).toBeLessThan(1); // the triangle's text rectangle is narrower than its box
    const { objects } = emitOne({ slides: [{ shapes: tri(2) + tri(3, true) }] });
    const [plain, flipped] = shapes(objects);
    const [t1, t2] = texts(objects);
    expect(plain).toMatchObject({ geom: { preset: 'rtTriangle' } });
    expect(plain!.flipH).toBeUndefined();
    expect(flipped).toMatchObject({ geom: { preset: 'rtTriangle' }, flipH: true, box: { rotation: 0 } });
    expect(t1!.box.x).toBeCloseTo(l * 2 * PX);
    expect(t2!.box.x).toBeCloseTo((1 - r) * 2 * PX);
    expect(t2!.box.w).toBeCloseTo(t1!.box.w);
    expect(t2!.box.rotation).toBe(0); // PowerPoint never mirrors the text itself
  });

  it('writes a vertical flip as a horizontal one turned half a turn (text upside down, as PowerPoint)', () => {
    const { objects } = emitOne({
      slides: [
        {
          shapes: sp({
            id: 2,
            x: 0,
            y: 0,
            cx: 2 * IN,
            cy: IN,
            geom: 'rtTriangle',
            fill: solid('FF0000'),
            flipV: true,
            txBody: body(para(run('x'))),
          }),
        },
      ],
    });
    expect(shapes(objects)[0]).toMatchObject({ flipH: true, box: { rotation: 180 } });
    expect(texts(objects)[0]!.box.rotation).toBe(180);
  });

  it('keeps adjust values as pairs', () => {
    const star = sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, geom: 'star5', fill: solid('FF0000') }).replace(
      '<a:avLst/>',
      '<a:avLst><a:gd name="adj" fmla="val 30000"/><a:gd name="hf" fmla="val 105146"/></a:avLst>',
    );
    const { objects } = emitOne({ slides: [{ shapes: star }] });
    expect(shapes(objects)[0]!.geom).toEqual({
      preset: 'star5',
      adj: [
        ['adj', 30_000],
        ['hf', 105_146],
      ],
    });
  });
});

describe('gradients (a:gradFill → Gradient)', () => {
  const grad = (inner: string, attrs = '') =>
    `<a:gradFill${attrs}><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"><a:alpha val="50000"/></a:srgbClr></a:gs></a:gsLst>${inner}</a:gradFill>`;
  const box = (id: number, fill: string, rot?: number) =>
    sp({ id, x: 0, y: 0, cx: 2 * IN, cy: IN, fill, rot });
  const BLUE_HALF = { r: 0, g: 0, b: 255, a: 0.5 };

  it('writes linear angles: as given, scaled with the box, fixed on the slide', () => {
    const { objects } = emitOne({
      slides: [
        {
          shapes:
            box(2, grad('<a:lin ang="2700000" scaled="0"/>')) +
            box(3, grad('<a:lin ang="2700000" scaled="1"/>')) +
            box(4, grad('<a:lin ang="0" scaled="0"/>', ' rotWithShape="0"'), 30) +
            box(5, grad('<a:lin ang="0" scaled="0"/>'), 30),
        },
      ],
    });
    const [plain, scaled, fixed, turning] = shapes(objects);
    // The legacy fill is the first stop; the gradient is drawn instead of it.
    expect(plain).toMatchObject({
      fill: RED,
      gradient: {
        kind: 'linear',
        angle: 45,
        stops: [
          { at: 0, color: RED },
          { at: 1, color: BLUE_HALF },
        ],
      },
    });
    // Taken in a square and stretched with the box by the drawer.
    expect(scaled!.gradient).toMatchObject({ angle: 45, scaled: true });
    expect(plain!.gradient!.scaled).toBeUndefined();
    expect(fixed!.gradient!.angle).toBeCloseTo(330);
    expect(turning!.gradient!.angle).toBe(0);
  });

  it('keeps a fixed gradient on a mirrored, turned shape where LibreOffice draws it: 180 − θ on the slide', () => {
    // The drawer paints the stored angle in box space, then mirrors (flipH) and turns the box: a box-space
    // angle θb lands at 180 − θb + rotation. LibreOffice mirrors a rotWithShape="0" gradient but does not
    // turn it: 180 − θ, whatever the rotation.
    const flipped = (id: number, rot: number) =>
      sp({
        id,
        x: 0,
        y: 0,
        cx: 2 * IN,
        cy: IN,
        rot,
        flipH: true,
        fill: grad('<a:lin ang="1800000" scaled="0"/>', ' rotWithShape="0"'),
      });
    const { objects } = emitOne({ slides: [{ shapes: flipped(2, 0) + flipped(3, 40) + flipped(4, 90) }] });
    for (const o of shapes(objects)) {
      expect(o.flipH).toBe(true);
      const page = (((180 - o.gradient!.angle! + o.box.rotation) % 360) + 360) % 360;
      expect(page).toBeCloseTo(150);
    }
    // flipV alone is a mirror too (a reflection turned by 180°).
    const v = emitOne({
      slides: [
        {
          shapes: sp({
            id: 2,
            x: 0,
            y: 0,
            cx: 2 * IN,
            cy: IN,
            rot: 40,
            flipV: true,
            fill: grad('<a:lin ang="1800000" scaled="0"/>', ' rotWithShape="0"'),
          }),
        },
      ],
    });
    // flipV is −θ in LibreOffice (330° here), though the same box drawn flipH turned 180° more is 150°.
    const o = shapes(v.objects)[0]!;
    expect(o.flipH).toBe(true);
    const page = (((180 - o.gradient!.angle! + o.box.rotation) % 360) + 360) % 360;
    expect(page).toBeCloseTo(330);
    // Both flips: not a mirror; LibreOffice draws θ + 180.
    const both = emitOne({
      slides: [
        {
          shapes: sp({
            id: 2,
            x: 0,
            y: 0,
            cx: 2 * IN,
            cy: IN,
            rot: 40,
            flipH: true,
            flipV: true,
            fill: grad('<a:lin ang="1800000" scaled="0"/>', ' rotWithShape="0"'),
          }),
        },
      ],
    });
    const b = shapes(both.objects)[0]!;
    expect(b.flipH).toBeUndefined();
    expect((((b.gradient!.angle! + b.box.rotation) % 360) + 360) % 360).toBeCloseTo(210);
  });

  it('writes path gradients radial from the centre of their focus rectangle', () => {
    const { objects, notes } = emitOne({
      slides: [
        {
          shapes:
            box(
              2,
              grad('<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>'),
            ) +
            box(3, grad('<a:path path="circle"><a:fillToRect l="100000" t="0" r="0" b="100000"/></a:path>')) +
            box(
              4,
              grad('<a:path path="rect"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>'),
            ),
        },
      ],
    });
    const [centre, corner, rect] = shapes(objects);
    expect(centre!.gradient).toMatchObject({ kind: 'radial', center: { x: 0.5, y: 0.5 } });
    expect(corner!.gradient).toMatchObject({ kind: 'radial', center: { x: 1, y: 0 } });
    expect(rect!.gradient!.kind).toBe('radial');
    expect(notes.join(' ')).toMatch(/a rectangular gradient is drawn radial/);
  });

  it('draws a pattern fill as its blended colour (approx, noted)', () => {
    const patt =
      '<a:pattFill prst="pct50"><a:fgClr><a:srgbClr val="000000"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>';
    const { objects, notes, scene } = emitOne({ slides: [{ shapes: box(2, patt) }] });
    expect(shapes(objects)[0]).toMatchObject({ fill: { r: 127.5, g: 127.5, b: 127.5, a: 1 } });
    expect(shapes(objects)[0]!.gradient).toBeUndefined();
    expect(scene.slides[0]!.elements[0]).toMatchObject({ support: 'approx', reasons: ['pattFill'] });
    expect(notes.join(' ')).toMatch(/a pattern fill is drawn as its blended colour/);
  });

  it('draws a gradient background, its stops laid on white', () => {
    const { slide } = emitOne({
      slides: [
        { bg: `<p:bg><p:bgPr>${grad('<a:lin ang="5400000" scaled="1"/>')}<a:effectLst/></p:bgPr></p:bg>` },
      ],
    });
    const bg = slide.objects[0] as ShapeObject;
    expect(bg).toMatchObject({ shape: 'rect', fill: RED, box: { x: 0, y: 0, w: 1920, h: 1080 } });
    expect(bg.gradient).toMatchObject({
      kind: 'linear',
      angle: 90,
      stops: [
        { at: 0, color: RED },
        { at: 1, color: { r: 128, g: 128, b: 255, a: 1 } },
      ],
    });
  });
});

describe('lines (dashes, arrowheads, joins and caps)', () => {
  const line = (id: number, ln: string) =>
    cxnSp({ id, x: 0, y: id * IN, cx: IN, cy: 0, ln: `<a:ln w="12700">${solid('000000')}${ln}</a:ln>` });

  it('maps preset dashes, the nearest for custom ones, and arrowheads', () => {
    const { objects, notes, scene } = emitOne({
      slides: [
        {
          shapes:
            line(
              2,
              '<a:prstDash val="lgDash"/><a:round/><a:headEnd type="oval"/><a:tailEnd type="stealth" w="lg"/>',
            ) +
            line(3, '<a:prstDash val="sysDashDotDot"/>') +
            line(4, '<a:custDash><a:ds d="100000" sp="100000"/></a:custDash>') +
            line(5, '<a:custDash><a:ds d="800000" sp="300000"/></a:custDash>') +
            line(6, '<a:custDash><a:ds d="400000" sp="300000"/><a:ds d="100000" sp="300000"/></a:custDash>') +
            line(7, '<a:prstDash val="solid"/>'),
        },
      ],
    });
    const [a, b, c, d, e, f] = shapes(objects);
    expect(a).toMatchObject({
      shape: 'line',
      dash: 'longDash',
      ends: { head: { type: 'oval' }, tail: { type: 'stealth', w: 'lg' } },
    });
    expect(b!.dash).toBe('sysDashDotDot');
    expect(c!.dash).toBe('sysDot');
    expect(d!.dash).toBe('longDash');
    expect(e!.dash).toBe('dashDot');
    expect(f!.dash).toBeUndefined();
    expect(f!.ends).toBeUndefined();
    const all = notes.join(' ');
    expect(all).toMatch(/a custom dash is drawn as sysDot/);
    expect((scene.slides[0]!.elements[0] as ShapeElement).line).toMatchObject({
      join: 'round',
      tailSize: { w: 'lg', len: 'med' },
    });
  });

  it('reads joins and caps', () => {
    const scene = parseDeck(
      buildDeck({
        slides: [
          {
            shapes: cxnSp({
              id: 2,
              x: 0,
              y: 0,
              cx: IN,
              cy: 0,
              ln: `<a:ln w="12700" cap="rnd">${solid('000000')}<a:bevel/></a:ln>`,
            }),
          },
        ],
      }),
    );
    expect((scene.slides[0]!.elements[0] as ShapeElement).line).toMatchObject({
      join: 'bevel',
      cap: 'round',
    });
  });

  it('writes joins and caps that are not the defaults on the shapes, as LibreOffice draws them', () => {
    const { objects } = emitOne({
      slides: [
        {
          shapes:
            line(2, '<a:prstDash val="sysDot"/>').replace('<a:ln w="12700">', '<a:ln w="12700" cap="rnd">') +
            line(3, '<a:round/>') +
            line(4, '<a:miter lim="800000"/>').replace('<a:ln w="12700">', '<a:ln w="12700" cap="flat">') +
            sp({
              id: 5,
              x: 0,
              y: 0,
              cx: IN,
              cy: IN,
              geom: 'star5',
              ln: `<a:ln w="152400" cap="sq">${solid('000000')}<a:round/></a:ln>`,
            }),
        },
      ],
    });
    const [dots, round, plain, star] = shapes(objects);
    expect(dots).toMatchObject({ dash: 'sysDot', lineCap: 'round' });
    expect(dots!.lineJoin).toBeUndefined();
    expect(round).toMatchObject({ lineJoin: 'round' });
    expect(plain!.lineJoin).toBeUndefined();
    expect(plain!.lineCap).toBeUndefined();
    expect(star).toMatchObject({ geom: { preset: 'star5' }, lineJoin: 'round', lineCap: 'square' });
  });

  it('picks the nearest dash by its lengths', () => {
    expect(nearestDash([3, 1])).toBe('sysDash');
    expect(nearestDash([1, 3])).toBe('dot');
    expect(nearestDash([8, 3, 1, 3])).toBe('longDashDot');
    expect(nearestDash([3, 1, 1, 1, 1, 1])).toBe('sysDashDotDot');
    expect(nearestDash([3, 1, 1, 1, 1, 1, 9, 9])).toBe('sysDashDotDot'); // at most three dashes are read
    expect(nearestDash([])).toBe('solid');
    expect(nearestDash([Number.NaN, 1])).toBe('sysDot');
  });
});

describe('effects (outer shadow, glow, soft edge)', () => {
  it('reads them from the shape’s effect list', () => {
    const fx =
      '<a:effectLst><a:glow rad="101600"><a:srgbClr val="4472C4"/></a:glow>' +
      '<a:outerShdw blurRad="50800" dist="38100" dir="2700000"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw>' +
      '<a:softEdge rad="63500"/></a:effectLst>';
    const { objects } = emitOne({
      slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: solid('FF0000'), ln: fx }) }],
    });
    const [s] = shapes(objects);
    expect(s!.shadow!.dx).toBeCloseTo(6 * Math.SQRT1_2);
    expect(s!.shadow!.dy).toBeCloseTo(6 * Math.SQRT1_2);
    expect(s!.shadow).toMatchObject({ blur: 8, color: { r: 0, g: 0, b: 0, a: 0.4 } });
    expect(s!.glow).toEqual({ radius: 16, color: { r: 0x44, g: 0x72, b: 0xc4, a: 1 } });
    expect(s!.softEdge).toBe(10);
  });

  it('reads them from the theme’s effect style (effectRef), phClr the reference’s colour', () => {
    const fmt = themeXml()
      .match(/<a:fmtScheme[\s\S]*<\/a:fmtScheme>/)![0]
      .replace(
        '<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>',
        '<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:glow rad="63500"><a:schemeClr val="phClr"><a:alpha val="60000"/></a:schemeClr></a:glow></a:effectLst></a:effectStyle>',
      );
    const style =
      '<p:style><a:lnRef idx="0"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef>' +
      '<a:effectRef idx="2"><a:schemeClr val="accent2"/></a:effectRef><a:fontRef idx="minor"/></p:style>';
    const { objects } = emitOne({
      theme: themeXml({ fmtScheme: fmt }),
      slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: solid('FF0000'), style }) }],
    });
    expect(shapes(objects)[0]!.glow).toEqual({ radius: 10, color: { r: 0xed, g: 0x7d, b: 0x31, a: 0.6 } });
  });
});

describe('groups (full affine: rotation, flips, child space)', () => {
  const tri = (id: number, x: number, y: number, cx: number, cy: number, rot?: number) =>
    sp({ id, x, y, cx, cy, rot, geom: 'rtTriangle', fill: solid('FF0000') });

  it('scales the child space to the group (chOff, chExt)', () => {
    const { objects } = emitOne({
      slides: [
        {
          shapes: grpSp(
            { id: 10, x: IN, y: IN, cx: 2 * IN, cy: IN, chX: 0, chY: 0, chCx: 4 * IN, chCy: 2 * IN },
            tri(2, 0, 0, 2 * IN, 2 * IN),
          ),
        },
      ],
    });
    expect(shapes(objects)[0]!.box).toEqual({ x: PX, y: PX, w: PX, h: PX, rotation: 0 });
  });

  it('mirrors children with a flipped group', () => {
    const { objects } = emitOne({
      slides: [
        { shapes: grpSp({ id: 10, x: 0, y: 0, cx: 2 * IN, cy: IN, flipH: true }, tri(2, 0, 0, IN, IN)) },
      ],
    });
    const [s] = shapes(objects);
    expect(s).toMatchObject({ flipH: true, box: { y: 0, w: PX, h: PX, rotation: 0 } });
    expect(s!.box.x).toBeCloseTo(PX);
  });

  it('composes a group’s rotation and flip with a child’s rotation', () => {
    const child = tri(2, 0, 0, IN, IN, 30);
    const { objects } = emitOne({
      slides: [
        {
          shapes:
            grpSp({ id: 10, x: 0, y: 0, cx: 2 * IN, cy: IN, rot: 90 }, child) +
            grpSp(
              { id: 11, x: 0, y: 0, cx: 2 * IN, cy: IN, rot: 90, flipH: true },
              child.replace('id="2"', 'id="3"'),
            ),
        },
      ],
    });
    const [turned, mirrored] = shapes(objects);
    // R(90)·R(30): turned 120°, centre (−½, 0) in → (0, −½) in about the group's centre (1, ½) in.
    expect(turned!.flipH).toBeUndefined();
    expect(turned!.box.rotation).toBeCloseTo(120);
    expect(turned!.box.x + PX / 2).toBeCloseTo(PX);
    expect(turned!.box.y + PX / 2).toBeCloseTo(0);
    // R(90)·F·R(30) = R(60)·F: mirrored and turned 60°, centre (½, 0) → (0, ½) in about the centre.
    expect(mirrored!.flipH).toBe(true);
    expect(mirrored!.box.rotation).toBeCloseTo(60);
    expect(mirrored!.box.x + PX / 2).toBeCloseTo(PX);
    expect(mirrored!.box.y + PX / 2).toBeCloseTo(PX);
  });

  it('mirrors a picture with its group', () => {
    const p = pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2' });
    const { objects } = emitOne({
      slides: [
        {
          shapes: grpSp({ id: 10, x: 0, y: 0, cx: 2 * IN, cy: IN, flipH: true }, p),
          rels: [imageRel('rId2', 'a.png')],
        },
      ],
    });
    const [img] = images(objects);
    expect(img!.flipH).toBe(true);
    expect(img!.box.x).toBeCloseTo(PX);
  });
});

describe('connectors (cxnSp glued to connection sites)', () => {
  const rect = (id: number, x: number, y: number) => sp({ id, x, y, cx: IN, cy: IN, fill: solid('FF0000') });

  it('moves glued ends to the shapes’ connection sites; others keep the stored geometry', () => {
    const { objects } = emitOne({
      slides: [
        {
          shapes:
            rect(2, 0, 0) +
            rect(3, 3 * IN, 2 * IN) +
            cxnSp({ id: 4, x: 0, y: 0, cx: IN, cy: IN, start: { id: 2, idx: 3 }, end: { id: 3, idx: 1 } }) +
            cxnSp({ id: 5, x: 0, y: 0, cx: IN, cy: IN, start: { id: 99, idx: 0 } }) +
            cxnSp({ id: 6, x: 0, y: 0, cx: IN, cy: IN, end: { id: 3, idx: 0 } }) +
            cxnSp({ id: 7, x: 0, y: 0, cx: IN, cy: IN, start: { id: 2, idx: 40 } }),
        },
      ],
    });
    const [, , glued, missing, half, badSite] = shapes(objects);
    const ends = (o: ShapeObject) => {
      const a = (o.box.rotation * Math.PI) / 180;
      const cx = o.box.x + o.box.w / 2;
      const cy = o.box.y + o.box.h / 2;
      const dx = (Math.cos(a) * o.box.w) / 2;
      const dy = (Math.sin(a) * o.box.w) / 2;
      return [cx - dx, cy - dy, cx + dx, cy + dy].map((v) => Math.round(v * 1000) / 1000 + 0);
    };
    // Rect 2's right side (site 3) to rect 3's left side (site 1).
    expect(ends(glued!)).toEqual([PX, PX / 2, 3 * PX, 2.5 * PX]);
    expect(ends(missing!)).toEqual([0, 0, PX, PX]);
    // Only the end moves: to rect 3's top (site 0).
    expect(ends(half!)).toEqual([0, 0, 3.5 * PX, 2 * PX]);
    expect(ends(badSite!)).toEqual([0, 0, PX, PX]);
  });

  it('routes a glued elbow connector between the sites, keeping its rotation', () => {
    const bent = (id: number, rot?: number) =>
      cxnSp({
        id,
        x: 0,
        y: 0,
        cx: IN,
        cy: IN,
        rot,
        geom: 'bentConnector3',
        av: '<a:gd name="adj1" fmla="val 50000"/>',
        start: { id: 2, idx: 3 },
        end: { id: 3, idx: 0 },
      });
    const { objects } = emitOne({
      slides: [{ shapes: rect(2, 0, 0) + rect(3, 3 * IN, 2 * IN) + bent(4) + bent(5, 90) }],
    });
    const [, , flat, turned] = shapes(objects);
    // Back on the slide: the route's points from its chord frame.
    const slidePoints = (o: ShapeObject) => {
      const p = o.geom!.paths![0]!;
      const a = (o.box.rotation * Math.PI) / 180;
      const n = numbers(p.d);
      const out: [number, number][] = [];
      for (let i = 0; i < n.length; i += 2) {
        const x = n[i]! - o.box.w / 2;
        const y = n[i + 1]! - o.box.h / 2;
        out.push([
          o.box.x + o.box.w / 2 + x * Math.cos(a) - y * Math.sin(a),
          o.box.y + o.box.h / 2 + x * Math.sin(a) + y * Math.cos(a),
        ]);
      }
      return out;
    };
    const f = slidePoints(flat!);
    expect(f[0]![0]).toBeCloseTo(PX, 1);
    expect(f[0]![1]).toBeCloseTo(PX / 2, 1);
    expect(f[1]![0]).toBeCloseTo(2.25 * PX, 1); // across first, at adj1 = half way
    expect(f[1]![1]).toBeCloseTo(PX / 2, 1);
    expect(f[3]![0]).toBeCloseTo(3.5 * PX, 1);
    expect(f[3]![1]).toBeCloseTo(2 * PX, 1);
    const t = slidePoints(turned!);
    expect(t[0]![0]).toBeCloseTo(PX, 1);
    expect(t[1]![0]).toBeCloseTo(PX, 1); // turned a quarter: down first
    expect(t[3]![0]).toBeCloseTo(3.5 * PX, 1);
    expect(t[3]![1]).toBeCloseTo(2 * PX, 1);
  });

  it('keeps a connector whose stored ends are at its sites exactly as stored (a routed elbow keeps its bend)', () => {
    // PowerPoint's own: a bentConnector3 turned a quarter, 1 EMU wide, its bend 247 EMU above both shapes.
    const box = (id: number, x: number) =>
      sp({ id, x, y: 2 * IN, cx: IN, cy: IN / 2, fill: solid('FF0000') });
    const elbow = cxnSp({
      id: 4,
      x: 1.5 * IN + IN - 0.5,
      y: 2 * IN - IN,
      cx: 1,
      cy: 2 * IN,
      rot: 90,
      flipV: true,
      geom: 'bentConnector3',
      av: '<a:gd name="adj1" fmla="val -24700009"/>',
      start: { id: 2, idx: 0 },
      end: { id: 3, idx: 0 },
    });
    const { scene } = emitOne({ slides: [{ shapes: box(2, IN) + box(3, 3 * IN) + elbow }] });
    const e = scene.slides[0]!.elements[2] as ShapeElement;
    // Its ends: the top centres of the boxes, (1.5, 2) in and (3.5, 2) in.
    expect(apply(e.xf, 0, 0)[0]).toBeCloseTo(1.5 * IN);
    expect(apply(e.xf, 1, 1)[0]).toBeCloseTo(3.5 * IN);
    // The stored ends are the shapes' top centres, so nothing moved.
    const [a, b, c, d] = e.xf;
    expect(Math.hypot(a, b)).toBeCloseTo(1);
    expect(Math.hypot(c, d)).toBeCloseTo(2 * IN);
  });

  it('leaves ends glued to a table or a SmartArt graphic as stored (neither is a glue target)', () => {
    // The drawing's shapes carry their frame's id 7; the table's rows may grow past its frame (id 8).
    const parts = buildDeck({
      slides: [
        {
          rels: smartArtRels(1),
          shapes:
            smartArtFrame({ id: 7, x: 0, y: 0, cx: 2 * IN, cy: IN, dmId: 'rIdDm1' }) +
            tableFrame({ id: 8, x: 0, y: 2 * IN, cols: [2 * IN], rows: [{ h: IN, cells: [tc('Cell')] }] }) +
            cxnSp({ id: 4, x: 3 * IN, y: 0, cx: IN, cy: IN, start: { id: 7, idx: 2 } }) +
            cxnSp({ id: 5, x: 3 * IN, y: 2 * IN, cx: IN, cy: IN, end: { id: 8, idx: 0 } }),
        },
      ],
    });
    withSmartArt(parts, 1, drawingXml(dspSp({ x: 0, y: 0, cx: 2 * IN, cy: IN })));
    const els = parseDeck(parts).slides[0]!.elements;
    expect(els.some((e) => e.kind === 'table')).toBe(true);
    expect(els.some((e) => e.diagram === 1 && e.kind === 'shape')).toBe(true);
    const connectors = els.filter((e): e is ShapeElement => e.kind === 'shape' && e.cxn !== undefined);
    expect(connectors.map((e) => [apply(e.xf, 0, 0), apply(e.xf, 1, 1)])).toEqual([
      [
        [3 * IN, 0],
        [4 * IN, IN],
      ],
      [
        [3 * IN, 2 * IN],
        [4 * IN, 3 * IN],
      ],
    ]);
  });

  it('keeps the connector’s frame and flips when its ends move', () => {
    const xf = [-IN, 0, 0, IN, IN, 0] as const; // flipped horizontally: starts at the top right
    const moved = replaceEnds(xf, [0, 0], [2 * IN, IN])!;
    const [x0, y0] = [moved[4], moved[5]];
    expect([x0, y0]).toEqual([0, 0]);
    expect([moved[0] + moved[2] + moved[4], moved[1] + moved[3] + moved[5]]).toEqual([2 * IN, IN]);
    expect(moved[0]).toBe(2 * IN); // the x axis (−1, 0) now runs −2 in: no longer flipped
    expect(replaceEnds([1, 1, 0, 1, 0, 0], [0, 0], [1, 1])).toBeUndefined(); // sheared: stays
  });
});

describe('pictures (ImageObject.mask, flips, outlines)', () => {
  const rels = [imageRel('rId2', 'a.png')];

  it('clips to presets and custom geometry, mirrors, and outlines along the geometry', () => {
    const hex = pic({ id: 2, x: 0, y: 0, cx: 2 * IN, cy: IN, rId: 'rId2', geom: 'hexagon' }).replace(
      '</a:prstGeom></p:spPr>',
      `</a:prstGeom><a:ln w="25400">${solid('0000FF')}<a:prstDash val="dash"/></a:ln></p:spPr>`,
    );
    const cust = pic({ id: 3, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2' }).replace(
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
      custGeom({ paths: `<a:path w="2" h="2">${M(1, 0)}${L(2, 2)}${L(0, 2)}${Z}</a:path>` }),
    );
    const flipped = pic({ id: 4, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2', geom: 'ellipse' }).replace(
      '<a:xfrm>',
      '<a:xfrm flipH="1">',
    );
    const { objects, notes } = emitOne({ slides: [{ shapes: hex + cust + flipped, rels }] });
    const [h, c, e] = images(objects);
    expect(h).toMatchObject({ mask: { preset: 'hexagon' }, radius: 0 });
    expect(h!.flipH).toBeUndefined();
    const [outline] = shapes(objects);
    expect(outline).toMatchObject({
      shape: 'rect',
      geom: { preset: 'hexagon' },
      dash: 'dash',
      stroke: { width: 4 },
    });
    expect(outline!.fill).toBeUndefined();
    expect(c!.mask).toEqual({ paths: [{ d: 'M 1 0 L 2 2 L 0 2 Z', w: 2, h: 2 }] });
    expect(e).toMatchObject({ mask: { preset: 'ellipse' }, flipH: true, radius: PX / 2 });
    expect(notes.join(' ')).not.toMatch(/clipped to|unflipped/);
  });

  it('clips a picture to a traced outline stored as a chain, also when the mask is carried into its box', () => {
    const traced = pic({ id: 3, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2' }).replace(
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
      custGeom({ paths: TRACED }),
    );
    // A shape's picture fill turned 100°: its geometry is carried into the picture's turned box as paths.
    const blip =
      '<a:blipFill rotWithShape="1"><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>';
    const filled = sp({
      id: 4,
      x: 0,
      y: 0,
      cx: 2 * IN,
      cy: IN,
      rot: 100,
      geom: 'none',
      fill: custGeom({ paths: TRACED }) + blip,
    });
    const { objects } = emitOne({ slides: [{ shapes: traced + filled, rels }] });
    const [a, b] = images(objects);
    for (const img of [a, b]) {
      const chain = img!.mask!.paths!;
      expect(chain.length).toBeGreaterThan(2);
      expect(chain[0]!.cont).toBeUndefined();
      expect(chain.slice(1).every((p) => p.cont === true)).toBe(true);
      expect(chain.every((p) => p.d.length <= MAX_PATH_CHARS)).toBe(true);
      expect(
        (
          chain
            .map((p) => p.d)
            .join(' ')
            .match(/M/g) ?? []
        ).length,
      ).toBe(50);
    }
    // Carried into the box: in the box's own px, not the deck's space.
    expect(b!.mask!.paths![0]!.w).toBeCloseTo(b!.box.w, 3);
  });

  it('never mirrors a shape’s picture fill and squares it to the nearest quarter turn, as LibreOffice draws it', () => {
    // Verified with probe decks through LibreOffice 24.2: a flipped shape's picture fill stays unmirrored and
    // upright (a vertical flip does not turn it) while its geometry flips; turned 170° it is turned −10°, turned
    // 90° it is upright in the tall box; rot 180 with flipV in a flipped group is upright; a p:pic flips.
    const blip =
      '<a:blipFill rotWithShape="1"><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>';
    const filled = (id: number, geom: string, o: { flipH?: boolean; flipV?: boolean; rot?: number } = {}) =>
      sp({ id, x: 0, y: 0, cx: 2 * IN, cy: IN, geom, fill: blip, ...o });
    const flippedPic = (id: number, flip: string) =>
      pic({ id, x: 0, y: 0, cx: 2 * IN, cy: IN, rId: 'rId2' }).replace('<a:xfrm>', `<a:xfrm ${flip}>`);
    const { objects } = emitOne({
      slides: [
        {
          shapes:
            filled(2, 'rect', { flipH: true }) +
            filled(3, 'rect', { flipV: true }) +
            filled(4, 'rect', { flipH: true, flipV: true, rot: 30 }) +
            filled(5, 'rtTriangle', { flipH: true }) +
            filled(6, 'rtTriangle', { flipV: true }) +
            grpSp({ id: 20, x: 0, y: 0, cx: 2 * IN, cy: IN, flipH: true }, filled(7, 'rtTriangle')) +
            flippedPic(8, 'flipH="1"') +
            flippedPic(9, 'flipV="1"') +
            filled(10, 'rect', { rot: 170 }) +
            filled(11, 'rect', { rot: 90 }) +
            grpSp(
              { id: 21, x: 0, y: 0, cx: 2 * IN, cy: IN, flipH: true },
              filled(12, 'rect', { rot: 180, flipV: true }),
            ),
          rels,
        },
      ],
    });
    const [h, v, hv, triH, triV, inGroup, picH, picV, r170, r90, oval] = images(objects);
    for (const o of [h, v, triH, triV, inGroup])
      expect(o).toMatchObject({ box: { x: 0, y: 0, w: 2 * PX, h: PX, rotation: 0 } });
    for (const o of [h, v, hv, triH, triV, inGroup]) expect(o!.flipH).toBeUndefined();
    expect(hv!.box.rotation).toBeCloseTo(30); // the rotation still turns it
    expect(h!.mask).toBeUndefined();
    // The triangle's geometry is mirrored around the unmirrored picture.
    const tri = presetGeometry('rtTriangle', 2 * PX, PX)!;
    const corner = (o: ImageObject) => numbers(o.mask!.paths![0]!.d).slice(0, 2);
    expect(corner(triH!)).toEqual([2 * PX - tri.paths[0]!.pts[0]!, tri.paths[0]!.pts[1]!]);
    expect(corner(triV!)).toEqual([tri.paths[0]!.pts[0]!, PX - tri.paths[0]!.pts[1]!]);
    expect(corner(inGroup!)).toEqual(corner(triH!));
    // A picture itself is mirrored: flipH, and a vertical flip as a horizontal one turned half a turn.
    expect(picH).toMatchObject({ flipH: true, box: { rotation: 0 } });
    expect(picV).toMatchObject({ flipH: true, box: { rotation: 180 } });
    expect(r170!.box.rotation).toBeCloseTo(-10);
    expect(r170!.box.w).toBeCloseTo(2 * PX);
    expect(r90).toMatchObject({ box: { rotation: 0 } });
    expect(r90!.box.w).toBeCloseTo(PX);
    expect(r90!.box.h).toBeCloseTo(2 * PX);
    expect(oval).toMatchObject({ box: { rotation: 0, w: 2 * PX, h: PX } });
    expect(oval!.flipH).toBeUndefined();
  });

  it('clips a shape’s picture fill to the shape’s geometry', () => {
    const blip = '<a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>';
    const { objects } = emitOne({
      slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, geom: 'heart', fill: blip }), rels }],
    });
    expect(images(objects)[0]!.mask).toEqual({ preset: 'heart' });
  });
});

describe('classification (M6: geometry, gradients and lines are native)', () => {
  it('keeps a T3 slide of presets, gradients, custom geometry and dashed connectors native', () => {
    const geom = { paths: `<a:path w="10" h="10">${M(0, 0)}${L(10, 0)}${L(5, 10)}${Z}</a:path>` };
    const grad =
      '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill>';
    const { emitted, scene } = emitOne({
      slides: [
        {
          shapes:
            sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, geom: 'star5', fill: grad }) +
            custom(3, geom) +
            cxnSp({
              id: 4,
              x: 0,
              y: 0,
              cx: IN,
              cy: IN,
              geom: 'bentConnector2',
              ln: `<a:ln w="12700">${solid('000000')}<a:prstDash val="dash"/><a:tailEnd type="arrow"/></a:ln>`,
            }),
        },
      ],
    });
    expect(emitted.classification).toMatchObject({ tier: 'T3', class: 'native' });
    expect(emitted.classification.reasons).toEqual(['connector', 'custGeom', 'gradFill', 'preset:other']);
    expect(scene.slides[0]!.elements.map((e) => [e.support, e.reasons])).toEqual([
      ['native', undefined],
      ['native', undefined],
      ['native', undefined],
    ]);
  });
});

describe('an older build (design/27 §3.2, §14.7)', () => {
  it('parses the slides with the previous schema, kept, beside the legacy shapes a build without M6 drew', () => {
    const grad =
      '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill>';
    const { slide } = emitOne({
      slides: [
        {
          shapes:
            sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, geom: 'star5', fill: grad, flipH: true }) +
            custom(3, { paths: `<a:path w="10" h="10">${M(0, 0)}${L(10, 0)}${L(5, 10)}${Z}</a:path>` }) +
            cxnSp({
              id: 4,
              x: 0,
              y: 0,
              cx: IN,
              cy: IN,
              geom: 'curvedConnector3',
              ln: `<a:ln w="12700">${solid('000000')}<a:tailEnd type="arrow"/></a:ln>`,
            }) +
            pic({ id: 5, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2', geom: 'hexagon' }),
          rels: [imageRel('rId2', 'a.png')],
        },
      ],
    });
    const old = prev.Slide.parse(slide);
    const [, star, cust, route, image] = old.objects;
    // The previous release (0.5.0) has M6: everything is kept as written.
    expect(star).toEqual(slide.objects[1]);
    expect(old.objects.map((o) => 'geom' in o || 'mask' in o)).toEqual([false, true, true, true, true]);
    // Beside the geometry, the legacy shape a build without it drew.
    expect(star).toMatchObject({ type: 'shape', shape: 'rect', fill: RED });
    expect(cust).toMatchObject({ type: 'shape', shape: 'rect', fill: RED });
    // The curved connector: the straight line between its ends.
    expect(route).toMatchObject({ type: 'shape', shape: 'line', stroke: { width: 2 } });
    expect(route!.box.w).toBeCloseTo(PX * Math.SQRT2);
    expect(image).toMatchObject({ type: 'image', fit: 'stretch' });
  });
});

describe('merged shapes (one object for z-adjacent shapes of one look)', () => {
  const s = 1920 / 12_192_000;
  /** A custom shape of `points` pseudo-random points in a 10,000 space, turned by `rot` degrees. */
  const piece = (seed: number, points: number, x: number, y: number, rot: number): ShapeElement => {
    let d = 'M 0 0';
    let v = seed;
    const next = () => {
      v = (v * 48_271) % 2_147_483_647;
      return (v % 12_000) - 1_000; // a little past the space on both sides
    };
    for (let i = 1; i < points; i++)
      d +=
        i % 3 ? ` L ${next()} ${next()}` : ` C ${next()} ${next()} ${next()} ${next()} ${next()} ${next()}`;
    const a = (rot * Math.PI) / 180;
    const w = 0.7 * IN;
    const h = 0.4 * IN;
    return {
      kind: 'shape',
      shapeId: seed,
      name: '',
      xf: [w * Math.cos(a), w * Math.sin(a), -h * Math.sin(a), h * Math.cos(a), x, y],
      from: 'layout',
      support: 'native',
      geom: 'custom',
      fill: { kind: 'solid', color: RED },
      custom: {
        paths: [{ d: `${d} Z`, w: 10_000, h: 10_000 }],
        points,
        text: [0, 0, 1, 1],
        sites: [],
        notes: [],
      },
    };
  };

  it('writes no path string longer than its bound, and the bound is close', () => {
    for (let k = 1; k < 40; k++) {
      const list = [
        piece(k, 50 + k * 37, (k % 7) * IN, (k % 3) * IN, k * 13),
        piece(k + 99, 20 + k, -k * 0.1 * IN, 0, -k),
      ];
      const ps = list.map((e) => shapePiece(e, s)!);
      const xs = list.flatMap((e) => [
        e.xf[4],
        e.xf[4] + e.xf[0],
        e.xf[4] + e.xf[2],
        e.xf[4] + e.xf[0] + e.xf[2],
      ]);
      const ys = list.flatMap((e) => [
        e.xf[5],
        e.xf[5] + e.xf[1],
        e.xf[5] + e.xf[3],
        e.xf[5] + e.xf[1] + e.xf[3],
      ]);
      const box = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        cx: Math.max(...xs) - Math.min(...xs),
        cy: Math.max(...ys) - Math.min(...ys),
      };
      const x0 = Math.min(...ps.map((p) => p.extent.x));
      const y0 = Math.min(...ps.map((p) => p.extent.y));
      const extent = {
        x: x0,
        y: y0,
        cx: Math.max(...ps.map((p) => p.extent.x + p.extent.cx)) - x0,
        cy: Math.max(...ps.map((p) => p.extent.y + p.extent.cy)) - y0,
      };
      const bound = mergedChars(
        box,
        extent,
        Math.max(...ps.map((p) => p.cmds)),
        Math.max(...ps.map((p) => p.coords)),
        s,
      );
      const paths = mergedPaths(
        list.map((e, i) => ({ xf: e.xf, piece: ps[i]! })),
        box,
        s,
      );
      const longest = Math.max(...paths.map((p) => p.d.length));
      expect(longest).toBeLessThanOrEqual(bound);
      expect(longest).toBeGreaterThan(bound * 0.6);
      // Every point lands where the shape's own affine puts it, in px from the box's corner.
      const first = list[0]!.custom!.paths[0]!.d.split(' ');
      const written = paths[0]!.d.split(' ');
      const [u, v] = [Number(first[1]) / 10_000, Number(first[2]) / 10_000];
      const [X, Y] = apply(list[0]!.xf, u, v);
      expect(Math.abs(Number(written[1]) - (X - box.x) * s)).toBeLessThan(0.01);
      expect(Math.abs(Number(written[2]) - (Y - box.y) * s)).toBeLessThan(0.01);
    }
    expect(mergedChars({ x: 0, y: 0, cx: 1, cy: 1 }, { x: 0, y: 0, cx: 1e30, cy: 1 }, 1, 2, s)).toBe(
      Infinity,
    );
    expect(MAX_PATH_CHARS).toBe(40_000);
  });

  it('keeps a chain one path in the merged object: its pieces carry cont, and it is open only as a whole', () => {
    // A traced outline stored as a chain (r1-custgeom-nest-bound): the outline is cut between two of its
    // commands, so the second piece goes on without a move and holds the outline's close and the hole.
    const chained = (tail: string): ShapeElement => ({
      ...piece(7, 3, 0, 0, 0),
      custom: {
        paths: [
          { d: 'M 0 0 L 10000 0 L 10000 10000', w: 10_000, h: 10_000 },
          {
            d: `L 0 10000 Z M 2000 2000 L 8000 2000 L 8000 8000 L 2000 8000${tail}`,
            w: 10_000,
            h: 10_000,
            cont: true,
          },
        ],
        points: 10,
        text: [0, 0, 1, 1],
        sites: [],
        notes: [],
      },
    });
    const a = shapePiece(chained(' Z'), s)!;
    expect(a.paths.map((p) => p.cont)).toEqual([undefined, true]);
    // The cut is not an open end: the chain closes every sub-path.
    expect(a.open).toBe(false);
    // An unclosed hole at the chain's end is.
    expect(shapePiece(chained(''), s)!.open).toBe(true);
    const b = piece(8, 4, 2 * IN, 0, 0);
    const pb = shapePiece(b, s)!;
    const box = { x: 0, y: 0, cx: 3 * IN, cy: IN };
    const paths = mergedPaths(
      [
        { xf: chained(' Z').xf, piece: a },
        { xf: b.xf, piece: pb },
      ],
      box,
      s,
    );
    expect(paths.map((p) => p.cont)).toEqual([undefined, true, undefined]);
    // The renderer joins the chain back into one path (one even-odd fill: the hole stays a hole).
    const built = storedGeometry({ paths }, box.cx * s, box.cy * s)!;
    expect(built.paths).toHaveLength(2);
    expect(built.paths[0]!.cmds.filter((c) => c === CMD_MOVE)).toHaveLength(2);
  });

  it('reads presets at the box and notes open outlines', () => {
    const shape = (geom: string): ShapeElement => ({
      kind: 'shape',
      shapeId: 1,
      name: '',
      xf: [IN, 0, 0, IN / 2, 0, 0],
      from: 'layout',
      support: 'native',
      geom,
      fill: { kind: 'solid', color: RED },
    });
    const rect = shapePiece(shape('rect'), s)!;
    expect(rect.paths).toEqual([
      { cmds: 'MLLLZ', pts: [0, 0, 1, 0, 1, 1, 0, 1], fill: 'norm', stroke: true },
    ]);
    expect(rect.open).toBe(false);
    expect(rect.extent).toEqual({ x: 0, y: 0, cx: IN, cy: IN / 2 });
    // arc's outline is open; an unknown preset or a custom geometry past the bounds is no piece.
    expect(shapePiece(shape('arc'), s)!.open).toBe(true);
    expect(shapePiece(shape('nonsense'), s)).toBeUndefined();
    expect(
      shapePiece(
        {
          ...shape('custom'),
          custom: { paths: [], points: 0, text: [0, 0, 1, 1], sites: [], notes: [], over: true },
        },
        s,
      ),
    ).toBeUndefined();
  });
});
