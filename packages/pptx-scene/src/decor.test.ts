import {
  DECOR_LIMITS as SCHEMA_DECOR_LIMITS,
  type DecorPart,
  type ShapeObject,
  Slide,
  type SlideObject,
} from '@ordo/domain';
import { parsePathData } from '@ordo/domain/pathdata.ts';
import { boxSide, legacyGeometry, storedPath } from '@ordo/renderer/geom/built.ts';
import { clampDecor } from '@ordo/renderer/clamp/decor.ts';
import { presetGeometry } from '@ordo/renderer/geom/path.ts';
import { describe, expect, it } from 'vitest';
import { DECOR_LIMITS, DECOR_PREFIX, decorable, decorFiles, decorRuns, platePlan } from './decor.ts';
import { ALL_M9_FIELDS } from './emit-ctx.ts';
import { frameOf } from './frame.ts';
import { emitSlides, parseDeck } from './index.ts';
import type { Element, ShapeElement } from './ir.ts';
import { buildDeck, custGeom, grpSp, imageRel, pic, solid, sp } from './test-util.ts';

const IN = 914_400;
const FRAME = frameOf(12_192_000, 6_858_000);

/** An IR square at x inches (0.1 in wide), in group 1 of the slide. */
const sq = (x: number, extra: Partial<ShapeElement> = {}): Element =>
  ({
    kind: 'shape',
    shapeId: 1,
    name: '',
    xf: [IN / 10, 0, 0, IN / 10, x * IN, 0],
    from: 'slide',
    group: 1,
    support: 'native',
    geom: 'rect',
    fill: { kind: 'solid', color: { r: 0, g: 0, b: 255, a: 0.5 } },
    ...extra,
  }) as Element;

const half = (hex: string) => solid(`<a:srgbClr val="${hex}"><a:alpha val="50000"/></a:srgbClr>`);
const GRADIENT =
  '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>' +
  '<a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="2700000" scaled="0"/></a:gradFill>';
const SHADOW =
  '<a:effectLst><a:outerShdw blurRad="38100" dist="25400" dir="2700000" algn="tl" rotWithShape="0">' +
  '<a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst>';
const DARKEN_PATH = custGeom({
  paths:
    '<a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="0"/></a:lnTo><a:lnTo><a:pt x="50" y="100"/></a:lnTo><a:close/></a:path>' +
    '<a:path w="100" h="100" fill="darken" stroke="0"><a:moveTo><a:pt x="25" y="25"/></a:moveTo><a:lnTo><a:pt x="75" y="25"/></a:lnTo><a:lnTo><a:pt x="50" y="75"/></a:lnTo><a:close/></a:path>',
});

/** Kinds of shapes a decoration holds: what each of the six draws (none of them merge by look). */
function kind(i: number, id: number, x: number, y: number): string {
  const at = { id, x, y, cx: IN / 4, cy: IN / 6 };
  switch (i % 6) {
    case 0:
      return sp({ ...at, fill: half('336699') });
    case 1:
      return sp({ ...at, geom: 'ellipse', fill: half('993366'), rot: 30 });
    case 2:
      return sp({ ...at, geom: 'star5', fill: GRADIENT, flipH: true, rot: 10 });
    case 3:
      return sp({
        ...at,
        geom: 'roundRect',
        fill: half('669933'),
        ln: `<a:ln w="12700">${solid('000000')}<a:prstDash val="dash"/></a:ln>${SHADOW}`,
      });
    case 4:
      return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="C${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm rot="${45 * 60_000}" flipV="1"><a:off x="${x}" y="${y}"/><a:ext cx="${IN / 4}" cy="${IN / 6}"/></a:xfrm>${DARKEN_PATH}${half('CC3333')}</p:spPr></p:sp>`;
    default:
      return sp({
        ...at,
        geom: 'rtTriangle',
        fill: half('333333'),
        ln: `<a:ln w="25400">${half('FFFFFF')}</a:ln>`,
      });
  }
}

/** `n` mixed shapes in one group, in rows of 16, ids from 10. */
function mixed(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += kind(i, 10 + i, (i % 16) * (IN / 2), Math.floor(i / 16) * (IN / 4));
  return grpSp({ id: 2, x: 0, y: 0, cx: 8 * IN, cy: 4 * IN }, out);
}

/** The points of a path as the renderer builds it, placed as `placeBox` places the shape, in slide px. */
function placed(o: ShapeObject): number[][] {
  const w = boxSide(o.box.w);
  const h = boxSide(o.box.h);
  const built = o.geom?.preset
    ? presetGeometry(o.geom.preset, w, h, o.geom.adj as never)!.paths
    : o.geom?.paths
      ? o.geom.paths.map((p) => storedPath(p, w, h))
      : legacyGeometry(o.shape, o.radius ?? 0, w, h).paths;
  const a = ((o.box.rotation ?? 0) * Math.PI) / 180;
  return built.map((p) => {
    const out: number[] = [];
    for (let i = 0; i < p.pts.length; i += 2) {
      const lx = (o.flipH ? w - p.pts[i]! : p.pts[i]!) - w / 2;
      const ly = (o.flipV ? h - p.pts[i + 1]! : p.pts[i + 1]!) - h / 2;
      out.push(
        o.box.x + w / 2 + lx * Math.cos(a) - ly * Math.sin(a),
        o.box.y + h / 2 + lx * Math.sin(a) + ly * Math.cos(a),
      );
    }
    return out;
  });
}

/** Each source shape's parts of a decoration (runs from one `s: 1` to the next). */
function members(parts: DecorPart[]): DecorPart[][] {
  const out: DecorPart[][] = [];
  for (const p of parts) {
    if (p.s === 1 || !out.length) out.push([]);
    out[out.length - 1]!.push(p);
  }
  return out;
}

const decorsOf = (objects: SlideObject[]) =>
  objects.filter((o): o is ShapeObject => o.type === 'shape' && !!o.decor);

describe('decorations (M9, decor-conv)', () => {
  it("keeps the schema's limits", () => {
    expect(DECOR_LIMITS).toEqual(SCHEMA_DECOR_LIMITS);
  });

  it('joins shapes without text that a paint can carry, never real 3-D', () => {
    expect(decorable(sq(0), FRAME)).toBeDefined();
    const ends = {
      width: 12_700,
      fill: { kind: 'solid' as const, color: { r: 0, g: 0, b: 0, a: 1 } },
      tail: 'triangle',
    };
    for (const extra of [
      { text: { paras: [] } as never },
      { glow: { radius: 1, color: { r: 0, g: 0, b: 0, a: 1 } } },
      { softEdge: 1 },
      { geom: 'line' },
      { geom: 'nonsense' },
      { fill: { kind: 'picture', picture: { part: 'a' } } as never },
      { line: ends as never },
      { line: { width: 25_400, fill: ends.fill, join: 'round' } as never },
      { hidden: true },
      { support: 'residual' as const },
      { fill: { kind: 'none' as const } },
      { xf: [IN, 0, 0, IN, 1e8, 0] as never },
    ])
      expect(
        decorable(sq(0, extra as Partial<ShapeElement>), FRAME),
        JSON.stringify(Object.keys(extra)),
      ).toBeUndefined();
    const three = sq(0, { support: 'approx', reasons: ['3d'] });
    expect(decorable(three, FRAME)).toBeUndefined();
    expect(decorable(three, FRAME, true)).toMatchObject({ flat3d: true });
    // A thin outline with round joins and caps joins (drawn with miter joins: at most a pixel off), and a
    // straight line with its outline.
    expect(
      decorable(
        sq(0, { line: { width: 9_525, fill: ends.fill, join: 'round', cap: 'round' } as never }),
        FRAME,
      ),
    ).toBeDefined();
    expect(
      decorable(
        sq(0, { geom: 'line', fill: { kind: 'none' }, line: { width: 9_525, fill: ends.fill } as never }),
        FRAME,
      ),
    ).toBeDefined();
    // An approximation of another kind joins (a sheared child, a pattern as its colour).
    expect(decorable(sq(0, { support: 'approx', reasons: ['shear'] }), FRAME)).toBeDefined();
  });

  it('a 3-D shape ends a decoration run', () => {
    const three = sq(2, { support: 'approx', reasons: ['3d'] });
    expect(decorRuns([sq(0), sq(1), three, sq(3), sq(4)], FRAME)).toEqual([
      [0, 1],
      [3, 4],
    ]);
    // Drawn flat in a decoration only when asked (the slide is still over its budget with every other step).
    expect(decorRuns([sq(0), sq(1), three, sq(3), sq(4)], FRAME, { flat3d: true })).toEqual([
      [0, 1, 2, 3, 4],
    ]);
  });

  it('scopes runs: a drawing, a group or a decoration source; the slide own shapes only at the wide step', () => {
    const own = (x: number) => sq(x, { group: undefined });
    expect(decorRuns([own(0), own(1)], FRAME)).toEqual([]);
    expect(decorRuns([own(0), own(1)], FRAME, { wide: true })).toEqual([[0, 1]]);
    expect(decorRuns([sq(0), sq(1), sq(2, { group: 2 }), sq(3, { group: 2 })], FRAME)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    // The wide step joins a source's groups, never a SmartArt drawing to anything else.
    expect(
      decorRuns([sq(0), sq(1), sq(2, { group: 2 }), sq(3, { group: 2 })], FRAME, { wide: true }),
    ).toEqual([[0, 1, 2, 3]]);
    const dgm = (x: number) => sq(x, { diagram: 1 });
    expect(decorRuns([sq(0), dgm(1), dgm(2), sq(3)], FRAME, { wide: true })).toEqual([[1, 2]]);
    const layout = (x: number) => sq(x, { group: undefined, from: 'layout' });
    expect(decorRuns([layout(0), layout(1), sq(2), sq(3)], FRAME)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('caps close the run: parts, points, paints and shadowed shapes', () => {
    const shadow = { dist: 1, blur: 1, dir: 0, color: { r: 0, g: 0, b: 0, a: 1 } };
    const shadowed = Array.from({ length: 30 }, (_, i) => sq(i % 20, { shadow }));
    expect(decorRuns(shadowed, FRAME).map((r) => r.length)).toEqual([DECOR_LIMITS.shadowed, 6]);
    const parts = Array.from({ length: 300 }, (_, i) => sq((i % 20) / 2));
    expect(decorRuns(parts, FRAME).map((r) => r.length)).toEqual([DECOR_LIMITS.parts, 44]);
    const paints = Array.from({ length: 70 }, (_, i) =>
      sq((i % 20) / 2, { fill: { kind: 'solid', color: { r: i, g: 0, b: 0, a: 0.5 } } }),
    );
    expect(decorRuns(paints, FRAME).map((r) => r.length)).toEqual([DECOR_LIMITS.paints, 6]);
    // 4,000 points a shape: four fit 16,384.
    let d = 'M 0 0';
    for (let i = 1; i < 4_000; i++) d += ` L ${i % 100} ${(i * 7) % 100}`;
    const custom = {
      paths: [{ d, w: 100, h: 100 }],
      points: 4_000,
      text: [0, 0, 1, 1] as [number, number, number, number],
      sites: [],
      notes: [],
    };
    const heavy = Array.from({ length: 5 }, (_, i) => sq(i, { geom: 'custom', custom }));
    expect(decorRuns(heavy, FRAME).map((r) => r.length)).toEqual([4]);
  });

  it('a picture beside the run does not end it; one under a member, or a later member over it, does', () => {
    const p = (x: number) =>
      ({
        kind: 'picture',
        shapeId: 9,
        name: '',
        xf: [IN / 10, 0, 0, IN / 10, x * IN, 0],
        from: 'slide',
        support: 'native',
        geom: 'rect',
        picture: { part: 'a' },
      }) as Element;
    expect(decorRuns([sq(0), p(5), sq(1)], FRAME)).toEqual([[0, 2]]);
    expect(decorRuns([sq(0), p(0.05), sq(1)], FRAME)).toEqual([]);
    expect(decorRuns([sq(0), p(5), sq(5.05)], FRAME)).toEqual([]);
  });

  it('draws exactly what the separate shapes draw: their geometry placed, their paint, in z-order', () => {
    const deck = buildDeck({ slides: [{ shapes: mixed(160) }] });
    const scene = parseDeck(deck);
    const s = scene.slides[0]!;
    expect(s.classification.class).toBe('native');
    expect(s.elements.filter((e) => e.decor !== undefined).length).toBeGreaterThanOrEqual(120);
    // Parts inline (no decoration files), to read them here.
    const out = emitSlides(scene, { geomFiles: false }).slides[0]!;
    expect(Slide.safeParse(out.slide).success).toBe(true);
    // The same slide with the field off: every member one by one (`m9Writes`), as older readers write it.
    const off = new Set([...ALL_M9_FIELDS].filter((f) => f !== 'decor'));
    const apart = emitSlides(scene, { m9Writes: off, geomFiles: false }).slides[0]!;
    expect(decorsOf(apart.slide.objects)).toEqual([]);
    const separate = apart.slide.objects.filter((o): o is ShapeObject => o.type === 'shape').slice(1);
    const decors = decorsOf(out.slide.objects);
    expect(decors.length).toBeGreaterThan(0);
    // Members in z-order across the decorations, each against its separate shape.
    const all: { part: DecorPart[]; o: ShapeObject }[] = [];
    for (const o of decors) for (const m of members(o.decor!.parts)) all.push({ part: m, o });
    const drawn = s.elements.filter((e) => e.decor !== undefined && !e.hidden).length;
    expect(all).toHaveLength(drawn);
    const firstDecorated = s.elements.findIndex((e) => e.decor !== undefined);
    const offset = s.elements.slice(0, firstDecorated).filter((e) => !e.hidden).length;
    all.forEach(({ part, o }, k) => {
      const shape = separate[offset + k]!;
      const paint = o.decor!.paints[part[0]!.p]!;
      // The paint is the shape's own look (a gradient mirrored into its frame for a flipped shape).
      expect(paint.fill).toEqual(shape.fill);
      expect(paint.stroke).toEqual(shape.stroke);
      expect(paint.shadow).toEqual(shape.shadow);
      expect(paint.dash).toEqual(shape.dash && shape.dash !== 'solid' ? shape.dash : undefined);
      if (shape.gradient) {
        expect(paint.gradient?.stops).toEqual(shape.gradient.stops);
        expect(part[0]!.frame).toEqual([
          Math.round((shape.box.x - o.box.x) * 100) / 100,
          Math.round((shape.box.y - o.box.y) * 100) / 100,
          Math.round(shape.box.w * 100) / 100,
          Math.round(shape.box.h * 100) / 100,
          shape.box.rotation,
        ]);
        if (shape.flipH)
          expect(paint.gradient!.angle).toBeCloseTo((180 - (shape.gradient.angle ?? 0) + 360) % 360, 6);
      }
      // Its paths, placed as the separate shape is drawn, within the 0.01 px the strings are written at.
      const want = placed(shape);
      const got = part.map((p) => parsePathData(p.d).pts.map((v, i) => v + (i % 2 ? o.box.y : o.box.x)));
      expect(got.map((g) => g.length)).toEqual(want.map((w) => w.length));
      got.forEach((g, i) => {
        g.forEach((v, j) => {
          expect(Math.abs(v - want[i]![j]!)).toBeLessThan(0.011);
        });
      });
      // Fill modes and stroke flags kept.
      const built = shape.geom?.paths?.map((p) => storedPath(p, shape.box.w, shape.box.h));
      if (built)
        part.forEach((p, i) => {
          expect([p.fill ?? 'norm', p.stroke !== false]).toEqual([built[i]!.fill, built[i]!.stroke]);
        });
    });
    // The legacy fields an older build draws: a line without a stroke, nothing. Locked, role 'decor'.
    for (const o of decors) {
      expect(o).toMatchObject({
        shape: 'line',
        locked: true,
        origin: { src: 'pptx', role: 'decor' },
        box: { rotation: 0 },
      });
      expect(o.fill).toBeUndefined();
      expect(o.stroke).toBeUndefined();
      expect(o.decor!.w).toBe(o.box.w);
      // Each member's first part is marked; the renderer's clamp keeps every part.
      expect(o.decor!.parts[0]!.s).toBe(1);
      expect(clampDecor(o.decor)!.parts).toHaveLength(o.decor!.parts.length);
    }
    expect(
      out.notes.some((n) => /shapes are drawn as \d+ decoration\(s\) \(the slide's object budget\)/.test(n)),
    ).toBe(true);
  });

  it('shares equal paints, at most 64 a decoration', () => {
    const out = emitSlides(parseDeck(buildDeck({ slides: [{ shapes: mixed(160) }] })), { geomFiles: false })
      .slides[0]!;
    expect(decorsOf(out.slide.objects).length).toBeGreaterThan(0);
    for (const o of decorsOf(out.slide.objects)) {
      const paints = o.decor!.paints.map((p) => JSON.stringify(p));
      expect(new Set(paints).size).toBe(paints.length);
      expect(paints.length).toBeLessThanOrEqual(DECOR_LIMITS.paints);
    }
  });

  it('keeps a path too long for one part as a chain in one decoration', () => {
    // One path of 3,000 points across a slide-wide box: past 40,000 characters once placed, so cut at its
    // sub-paths into a chain the drawer joins again.
    let d = '';
    for (let i = 0; i < 1_000; i++) {
      const x = (i * 37) % 10_000;
      const y = (i * 91) % 10_000;
      d += `<a:moveTo><a:pt x="${x}" y="${y}"/></a:moveTo><a:lnTo><a:pt x="${x + 13}" y="${y}"/></a:lnTo><a:lnTo><a:pt x="${x}" y="${y + 17}"/></a:lnTo>`;
    }
    const big = (id: number, x: number) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="B${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="0"/><a:ext cx="${6 * IN}" cy="${4 * IN}"/></a:xfrm>${custGeom({ paths: `<a:path w="10000" h="10000">${d}<a:close/></a:path>` })}${half('3366CC')}</p:spPr></p:sp>`;
    let shapes = '';
    for (let i = 0; i < 4; i++) shapes += big(10 + i, i * IN);
    for (let i = 0; i < 150; i++)
      shapes += sp({
        id: 100 + i,
        x: ((i % 20) * IN) / 4,
        y: 5 * IN,
        cx: IN / 8,
        cy: IN / 8,
        fill: half(i % 2 ? '336699' : '993366'),
      });
    const out = emitSlides(
      parseDeck(
        buildDeck({ slides: [{ shapes: grpSp({ id: 2, x: 0, y: 0, cx: 10 * IN, cy: 6 * IN }, shapes) }] }),
      ),
      { geomFiles: false },
    ).slides[0]!;
    const decor = decorsOf(out.slide.objects)[0]!.decor!;
    const first = members(decor.parts)[0]!;
    expect(first.length).toBeGreaterThan(1);
    expect(first.slice(1).every((p) => p.cont === true)).toBe(true);
    expect(first.every((p) => p.d.length <= 40_000)).toBe(true);
  });

  it('writes the members one by one with the field off, or when one is not drawn as a plain shape', () => {
    const scene = parseDeck(buildDeck({ slides: [{ shapes: mixed(160) }] }));
    const off = emitSlides(scene, { m9Writes: new Set() }).slides[0]!;
    expect(decorsOf(off.slide.objects)).toEqual([]);
    expect(off.slide.objects.length).toBe(161);
  });

  it('moves a large decoration into a decoration file, once for the slides sharing it', () => {
    const layout = { shapes: mixed(160) };
    const deck = buildDeck({ layouts: [layout], slides: [{ shapes: '' }, { shapes: '' }] });
    const out = emitSlides(parseDeck(deck));
    const refs = out.slides.map((s) => decorsOf(s.slide.objects).map((o) => o.decor!.ref));
    expect(refs[0]!.length).toBeGreaterThan(0);
    expect(refs[0]).toEqual(refs[1]);
    expect(refs[0]!.every((r) => r?.startsWith(DECOR_PREFIX))).toBe(true);
    expect(out.decors.map((d) => d.id)).toEqual([...new Set(refs[0])]);
    for (const s of out.slides) for (const o of decorsOf(s.slide.objects)) expect(o.decor!.parts).toEqual([]);
    expect(out.decors[0]!.file.parts.length).toBeGreaterThan(0);
    // Without files (`geomFiles: false`) the parts stay in the slide.
    const inline = emitSlides(parseDeck(deck), { geomFiles: false });
    expect(inline.decors).toEqual([]);
    expect(decorsOf(inline.slides[0]!.slide.objects)[0]!.decor!.parts.length).toBeGreaterThan(0);
    // So too without the 'decorFile' field (the importers' `M9_WRITES` until `decor-render` names the files):
    // the same decorations, their parts in the slide, and no placeholder anywhere.
    const noFiles = new Set([...ALL_M9_FIELDS].filter((f) => f !== 'decorFile'));
    const held = emitSlides(parseDeck(deck), { m9Writes: noFiles });
    expect(held.decors).toEqual([]);
    for (const s of held.slides) {
      const ds = decorsOf(s.slide.objects);
      expect(ds.length).toBe(refs[0]!.length);
      for (const o of ds) {
        expect(o.decor!.ref).toBeUndefined();
        expect(o.decor!.parts.length).toBeGreaterThan(0);
      }
      expect(JSON.stringify(s.slide)).not.toContain(DECOR_PREFIX);
      expect(Slide.safeParse(s.slide).success).toBe(true);
    }
    // Small ones stay inline.
    const slide = {
      objects: [
        {
          id: 'a',
          type: 'shape',
          box: { x: 0, y: 0, w: 1, h: 1, rotation: 0 },
          shape: 'line',
          opacity: 1,
          radius: 0,
          decor: {
            w: 1,
            h: 1,
            paints: [{ fill: { r: 0, g: 0, b: 0, a: 1 } }],
            parts: [{ d: 'M 0 0 L 1 1', p: 0, s: 1 }],
          },
        },
      ],
    } as unknown as Slide;
    decorFiles(slide, () => 'x');
    expect((slide.objects[0] as ShapeObject).decor!.ref).toBeUndefined();
  });
});

describe('decoration plates (decisions.md "Slow-to-draw elements")', () => {
  const box = { x: 0, y: 0, w: 10, h: 10, rotation: 0 };
  const shape = (id: string, extra: Partial<ShapeObject> = {}) =>
    ({ id, type: 'shape', box, shape: 'rect', opacity: 1, radius: 0, ...extra }) as ShapeObject;
  const text = (id: string) => ({ id, type: 'text', box, text: 'x', style: {} }) as unknown as SlideObject;
  const image = (id: string, extra = {}) =>
    ({
      id,
      type: 'image',
      box,
      mediaId: 'm',
      fit: 'stretch',
      opacity: 1,
      radius: 0,
      ...extra,
    }) as unknown as SlideObject;

  it('plates the static stack below the first text, a clip or a table, and the effect layers above it', () => {
    const shadow = { dx: 1, dy: 1, blur: 2, color: { r: 0, g: 0, b: 0, a: 1 } };
    expect(
      platePlan({
        objects: [
          shape('bg'),
          image('pic'),
          shape('glow', { glow: { radius: 3, color: shadow.color } }),
          text('t'),
          shape('s', { shadow }),
          image('i'),
          shape('soft', { softEdge: 4 }),
        ],
      }),
    ).toEqual({ stack: ['bg', 'pic', 'glow'], effects: ['s', 'soft'] });
    expect(platePlan({ objects: [shape('bg'), image('clip', { play: {} }), shape('x')] }).stack).toEqual([
      'bg',
    ]);
    expect(
      platePlan({ objects: [shape('bg'), shape('tbl', { table: {} as never }), shape('x')] }).stack,
    ).toEqual(['bg']);
    expect(platePlan({ objects: [] })).toEqual({ stack: [], effects: [] });
    // Text stays live, its own shadow too.
    expect(platePlan({ objects: [text('t'), text('u')] })).toEqual({ stack: [], effects: [] });
  });

  it('names the plate plan on the emitted slide', () => {
    const shapes =
      sp({
        id: 2,
        x: 0,
        y: 0,
        cx: IN,
        cy: IN,
        fill: SHADOW.replace('<a:effectLst>', solid('336699') + '<a:effectLst>'),
      }) +
      pic({ id: 3, x: IN, y: 0, cx: IN, cy: IN, rId: 'rId2' }) +
      sp({
        id: 4,
        x: 0,
        y: 2 * IN,
        cx: 4 * IN,
        cy: IN,
        txBox: true,
        txBody: '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Grace</a:t></a:r></a:p></p:txBody>',
      });
    const out = emitSlides(parseDeck(buildDeck({ slides: [{ rels: [imageRel('rId2', 'a.png')], shapes }] })))
      .slides[0]!;
    const ids = out.slide.objects.map((o) => o.id);
    expect(out.plate).toEqual({ stack: ids.slice(0, 3), effects: [], pastBudget: [] });
  });
});
