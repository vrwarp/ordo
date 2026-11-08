import { describe, expect, it } from 'vitest';
import {
  budgetCost,
  cullElements,
  fitBudgets,
  leftKinds,
  MAX_DRAWN_OBJECTS,
  MAX_SLIDE_OBJECTS_TEXT,
} from './budget.ts';
import { MAX_SLIDE_OBJECTS, MAX_SLIDE_PICTURES, shapeRuns } from './classify.ts';
import { frameOf } from './frame.ts';
import { emitSlides, parseDeck } from './index.ts';
import type { Background, Element, ShapeElement, SlideScene } from './ir.ts';
import { drawingXml, dspSp, smartArtFrame, smartArtRels, withSmartArt } from './smartart.test-util.ts';
import {
  body,
  buildDeck,
  type DeckSpec,
  grpSp,
  imageRel,
  para,
  pic,
  run,
  type SlideSpec,
  solid,
  sp,
} from './test-util.ts';

const IN = 914_400;
const FRAME = frameOf(12_192_000, 6_858_000);
const NONE: Background = { fill: { kind: 'none' }, from: 'none' };

function slideOf(shapes: string, more: Partial<SlideSpec> = {}, deck: Partial<DeckSpec> = {}): SlideScene {
  return parseDeck(buildDeck({ ...deck, slides: [{ shapes, ...more }] })).slides[0]!;
}

/** `n` squares 0.1 in wide in rows of 20 from (x, y) inches, of `colors` in turn, ids from `first`. */
function squares(n: number, first: number, colors = ['336699'], x = 0, y = 0, extra = '') {
  let out = '';
  for (let i = 0; i < n; i++)
    out += sp({
      id: first + i,
      x: (x + (i % 20) * 0.15) * IN,
      y: (y + Math.floor(i / 20) * 0.15) * IN,
      cx: 0.1 * IN,
      cy: 0.1 * IN,
      fill: solid(colors[i % colors.length]!) + extra,
    });
  return out;
}
const group = (id: number, inner: string) => grpSp({ id, x: 0, y: 0, cx: 4 * IN, cy: 4 * IN }, inner);
const TWO = ['336699', '993366'];
const textBox = (id: number, x = 0, y = 0) =>
  sp({ id, x: x * IN, y: y * IN, cx: IN, cy: IN / 4, txBox: true, txBody: body(para(run('Word'))) });

describe('culling (budget step 0, M9)', () => {
  it('culls what lies off the slide area, not the frame (a 4:3 deck), per leaf', () => {
    const four3 = { size: { cx: 9_144_000, cy: 6_858_000 } };
    // In the side bar of a 4:3 deck: inside the 1920 x 1080 frame, off the slide.
    const side = sp({ id: 2, x: -IN, y: 0, cx: IN / 2, cy: IN / 2, fill: solid('FF0000') });
    const straddling = sp({ id: 3, x: -IN / 4, y: 0, cx: IN / 2, cy: IN / 2, fill: solid('00FF00') });
    const s = slideOf(side + straddling, {}, four3);
    expect(s.elements.map((e) => e.culled)).toEqual(['offSlide', undefined]);
    expect(s.elements[0]!.hidden).toBe(true);
    expect(s.notes).toContain('1 element(s) outside the slide are not imported');
    const out = emitSlides(parseDeck(buildDeck({ ...four3, slides: [{ shapes: side + straddling }] })))
      .slides[0]!;
    expect(out.slide.objects.filter((o) => o.type === 'shape')).toHaveLength(2); // the background and one
    // A group straddling the edge keeps its visible members.
    const g = grpSp(
      { id: 4, x: -2 * IN, y: 0, cx: 4 * IN, cy: IN },
      sp({ id: 5, x: -2 * IN, y: 0, cx: IN, cy: IN, fill: solid('FF0000') }) +
        sp({ id: 6, x: IN, y: 0, cx: IN, cy: IN, fill: solid('FF0000') }),
    );
    expect(slideOf(g).elements.map((e) => e.culled)).toEqual(['offSlide', undefined]);
  });

  it('keeps a shape whose shadow or outline reaches the slide, and culls one that shows nothing', () => {
    const shadow =
      '<a:effectLst><a:outerShdw blurRad="0" dist="508000" dir="10800000" algn="tl" rotWithShape="0"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>';
    // 0.25 in past the right edge, its shadow cast 0.55 in to the left.
    const right = 12_192_000 + IN / 4;
    const shadowed = sp({ id: 2, x: right, y: 0, cx: IN / 4, cy: IN / 4, fill: solid('FF0000') + shadow });
    const bare = sp({ id: 3, x: right, y: IN, cx: IN / 4, cy: IN / 4, fill: solid('FF0000') });
    const nothing = sp({
      id: 4,
      x: 0,
      y: 0,
      cx: IN,
      cy: IN,
      fill: '<a:noFill/>',
      ln: '<a:ln><a:noFill/></a:ln>',
    });
    const clear = sp({
      id: 5,
      x: 0,
      y: 0,
      cx: IN,
      cy: IN,
      fill: solid('<a:srgbClr val="FF0000"><a:alpha val="0"/></a:srgbClr>'),
    });
    const lined = sp({
      id: 6,
      x: 0,
      y: 0,
      cx: IN,
      cy: IN,
      fill: '<a:noFill/>',
      ln: `<a:ln w="12700">${solid('000000')}</a:ln>`,
    });
    const s = slideOf(shadowed + bare + nothing + clear + lined + textBox(7));
    expect(s.elements.map((e) => e.culled)).toEqual([
      undefined,
      'offSlide',
      'invisible',
      'invisible',
      undefined,
      undefined,
    ]);
    expect(s.notes).toContain('2 shape(s) that show nothing are not imported');
  });

  it('never culls a clip, a sound or a SmartArt drawing, and keeps culled elements out of the art', () => {
    const off = 20 * IN;
    const video = pic({ id: 2, x: off, y: 0, cx: IN, cy: IN, rId: 'rId2' }).replace(
      '<p:nvPr/>',
      '<p:nvPr><a:videoFile r:link="rId3"/></p:nvPr>',
    );
    const s = slideOf(video, {
      rels: [
        imageRel('rId2', 'poster.png'),
        { id: 'rId3', type: 'video', target: '../media/v.mp4' } as never,
      ],
    });
    expect(s.elements.filter((e) => e.kind === 'picture').map((e) => e.culled)).toEqual([undefined]);
    const elements = [
      {
        kind: 'shape',
        shapeId: 1,
        name: '',
        xf: [IN, 0, 0, IN, off, 0],
        from: 'slide',
        support: 'native',
        geom: 'rect',
        fill: { kind: 'solid', color: { r: 1, g: 2, b: 3, a: 1 } },
        diagram: 1,
      },
    ] as Element[];
    expect(cullElements(FRAME, elements)).toEqual({ offSlide: 0, invisible: 0 });
    // An off-slide chart frame (residual) is not imported: the slide has no art.
    const chart =
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${off}" y="0"/><a:ext cx="${IN}" cy="${IN}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>`;
    const c = slideOf(chart + textBox(3));
    expect(c.classification.class).toBe('native');
    expect(c.classification.art).toBeUndefined();
  });
});

describe('the slide budgets, natively (M9, decor-conv)', () => {
  it('runs the steps in order and stops when the slide fits', () => {
    // Within the budget: nothing merged.
    const within = slideOf(group(2, squares(140, 10, TWO)));
    expect(
      within.elements.some((e) => e.decor !== undefined || (e as ShapeElement).merge !== undefined),
    ).toBe(false);
    // One look: M6's merge alone (step 2).
    const one = slideOf(group(2, squares(160, 10)));
    expect(one.elements.every((e) => (e as ShapeElement).merge !== undefined && e.decor === undefined)).toBe(
      true,
    );
    // Two looks in turn in a group: decorations (step 3), no merge left.
    const two = slideOf(group(2, squares(160, 10, TWO)));
    expect(two.classification).toMatchObject({ class: 'native' });
    expect(two.elements.filter((e) => e.decor !== undefined).length).toBeGreaterThan(10);
    expect(budgetCost(two.elements, two.background, undefined).objects).toBeLessThanOrEqual(
      MAX_SLIDE_OBJECTS,
    );
    // The slide's own ungrouped shapes: only at the wide step (5).
    const own = slideOf(squares(160, 10, TWO));
    expect(own.classification).toMatchObject({ class: 'native' });
    expect(own.elements.filter((e) => e.decor !== undefined).length).toBeGreaterThan(10);
    expect(own.notes.some((n) => /shapes are drawn as \d+ decoration\(s\)/.test(n))).toBe(true);
  });

  it('sends no budget element to the art: decorations of a layout with the slide text above them native', () => {
    const s = slideOf(textBox(2, 0, 5), {}, { layouts: [{ shapes: squares(160, 10, TWO) }] });
    expect(s.classification).toEqual({
      tier: s.classification.tier,
      class: 'native',
      reasons: s.classification.reasons,
    });
    expect(s.classification.reasons.some((r) => r.startsWith('art:') || r.startsWith('budget:'))).toBe(false);
    expect(s.elements.every((e) => e.support !== 'residual')).toBe(true);
    const out = emitSlides(
      parseDeck(
        buildDeck({ layouts: [{ shapes: squares(160, 10, TWO) }], slides: [{ shapes: textBox(2, 0, 5) }] }),
      ),
    ).slides[0]!;
    expect(out.art).toBeUndefined();
    expect(out.slide.objects.length).toBeLessThanOrEqual(MAX_SLIDE_OBJECTS);
    expect(out.slide.objects.at(-1)!.type).toBe('text');
  });

  it('keeps a slide of text up to 190 objects, then leaves the topmost out (the guard)', () => {
    let texts = '';
    for (let i = 0; i < MAX_SLIDE_OBJECTS_TEXT - 2; i++)
      texts += textBox(10 + i, (i % 10) * 1.2, Math.floor(i / 10) * 0.3);
    const s = slideOf(texts);
    expect(s.classification.class).toBe('native');
    expect(s.elements.every((e) => !e.hidden)).toBe(true);
    let more = texts;
    for (let i = 0; i < 20; i++) more += textBox(500 + i, i * 0.2, 6);
    const t = slideOf(more);
    // Text only: 208 text boxes and the background; the topmost past 200 are left out and listed.
    expect(t.classification).toMatchObject({ class: 'hybrid', missing: ['element'] });
    expect(t.classification.reasons).toContain('missing:element');
    expect(t.elements.filter((e) => e.culled === 'budget')).toHaveLength(9);
    expect(t.elements.slice(-9).every((e) => e.culled === 'budget')).toBe(true);
    // Shapes that are not text go first.
    const mixed = slideOf(
      more +
        squares(
          40,
          900,
          ['336699'],
          0,
          6.5,
          '<a:effectLst><a:glow rad="1"><a:srgbClr val="FF0000"/></a:glow></a:effectLst>',
        ),
    );
    expect(leftKinds(mixed.elements)).toContain('decoration');
    expect(
      mixed.elements.filter((e) => e.culled === 'budget' && e.kind === 'shape' && !e.text).length,
    ).toBeGreaterThan(0);
  });

  it('never plans more than 200 objects, nor 190 that are not text (a property over random slides)', () => {
    let seed = 7;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 1_000_000) / 1_000_000;
    };
    const color = () => ({ r: Math.floor(rand() * 4) * 80, g: 0, b: 0, a: rand() < 0.5 ? 1 : 0.5 });
    for (let round = 0; round < 40; round++) {
      const n = Math.floor(rand() * 2_000);
      const elements: Element[] = [];
      for (let i = 0; i < n; i++) {
        const x = rand() * 12_000_000;
        const y = rand() * 6_500_000;
        const base = {
          shapeId: i + 1,
          name: '',
          xf: [IN / 10, 0, 0, IN / 10, x, y],
          from: rand() < 0.3 ? 'layout' : 'slide',
          ...(rand() < 0.5 ? { group: Math.floor(rand() * 4) } : {}),
          support: 'native',
        };
        const r = rand();
        if (r < 0.5)
          elements.push({
            ...base,
            kind: 'shape',
            geom: rand() < 0.5 ? 'rect' : 'ellipse',
            fill: { kind: 'solid', color: color() },
          } as unknown as Element);
        else if (r < 0.7)
          elements.push({
            ...base,
            kind: 'shape',
            geom: 'rect',
            fill: { kind: 'none' },
            text: { paras: [{ runs: [{ kind: 'text', text: 'x' }] }] },
          } as unknown as Element);
        else if (r < 0.95)
          elements.push({
            ...base,
            kind: 'picture',
            geom: 'rect',
            picture: { part: `p${Math.floor(rand() * 30)}` },
          } as unknown as Element);
        else
          elements.push({
            ...base,
            kind: 'table',
            cols: [],
            rows: [],
            cells: [],
            lines: [],
            objects: 40,
          } as unknown as Element);
      }
      const plan = fitBudgets({ frame: FRAME, log: () => {} }, elements, NONE);
      const c = budgetCost(elements, NONE, undefined, plan.atlas);
      expect(c.objects, `round ${round}`).toBeLessThanOrEqual(MAX_DRAWN_OBJECTS);
      const text = elements.filter((e) => !e.hidden && e.kind === 'shape' && e.text).length;
      expect(c.objects - text).toBeLessThanOrEqual(MAX_SLIDE_OBJECTS_TEXT);
      expect(c.pictures).toBeLessThanOrEqual(MAX_SLIDE_PICTURES);
      expect(plan.objects).toBe(c.objects);
      // What is left out is exactly what is culled for the budget.
      expect(elements.filter((e) => e.culled === 'budget').length).toBe(plan.left);
    }
  });
});

describe('hostile elements', () => {
  it('never throws on non-finite or huge placements, and still keeps the slide within the clamp', () => {
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300, -1e300];
    const elements: Element[] = [];
    for (let i = 0; i < 1_500; i++) {
      const v = bad[i % bad.length]!;
      elements.push({
        kind: i % 3 ? 'shape' : 'picture',
        shapeId: i,
        name: '',
        xf: [i % 2 ? v : IN, 0, 0, IN, i % 4 ? 0 : v, 0],
        from: 'slide',
        group: 1,
        support: 'native',
        geom: 'rect',
        fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } },
        picture: { part: `p${i % 40}` },
        ...(i % 7 ? {} : { shadow: { dist: v, blur: v, dir: 0, color: { r: 0, g: 0, b: 0, a: 1 } } }),
      } as unknown as Element);
    }
    expect(() => cullElements(FRAME, elements)).not.toThrow();
    const plan = fitBudgets({ frame: FRAME, log: () => {} }, elements, NONE);
    expect(budgetCost(elements, NONE, undefined, plan.atlas).objects).toBeLessThanOrEqual(MAX_DRAWN_OBJECTS);
  });
});

describe('3-D on a slide past the object budget (plan decision 6)', () => {
  const bevel = (w = 38_100) =>
    `<a:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d><a:sp3d><a:bevelT w="${w}" h="${w}"/></a:sp3d>`;

  it('shapeRuns merges 3-D shapes only with an equal 3-D digest and disjoint boxes', () => {
    // 160 squares of one colour with one bevel, apart: merged by look (the rim on the merged silhouette).
    const apart = slideOf(group(2, squares(160, 10, ['336699'], 0, 0, bevel())));
    expect(
      apart.elements.every((e) => e.support === 'approx' && (e as ShapeElement).merge !== undefined),
    ).toBe(true);
    expect(apart.elements.every((e) => e.decor === undefined)).toBe(true);
    // Two bevels in turn: never merged together.
    let mixed = '';
    for (let i = 0; i < 160; i++)
      mixed += sp({
        id: 10 + i,
        x: (i % 20) * 0.15 * IN,
        y: Math.floor(i / 20) * 0.15 * IN,
        cx: 0.1 * IN,
        cy: 0.1 * IN,
        fill: solid('336699') + bevel(i % 2 ? 38_100 : 12_700),
      });
    const m = slideOf(group(2, mixed));
    const runs = shapeRuns(m.elements, FRAME);
    for (const run of runs) expect(new Set(run.map((i) => i % 2)).size).toBe(1);
    // Overlapping boxes of one bevel: not merged (each keeps its own rim).
    let stacked = '';
    for (let i = 0; i < 10; i++)
      stacked += sp({
        id: 10 + i,
        x: i * 0.05 * IN,
        y: 0,
        cx: 0.1 * IN,
        cy: 0.1 * IN,
        fill: solid('336699') + bevel(),
      });
    const st = slideOf(group(2, stacked));
    expect(shapeRuns(st.elements, FRAME)).toEqual([]);
  });

  it('draws 3-D shapes flat in decorations only when nothing else brings the slide within its budget', () => {
    // 160 overlapping bevelled shapes of two colours on the slide itself: no merge, no 3-D decoration
    // until the last step, which draws them flat (`3d:flat-in-decoration`, approx).
    let shapes = '';
    for (let i = 0; i < 160; i++)
      shapes += sp({
        id: 10 + i,
        x: (i % 40) * 0.05 * IN,
        y: Math.floor(i / 40) * 0.05 * IN,
        cx: 0.1 * IN,
        cy: 0.1 * IN,
        fill: solid(TWO[i % 2]!) + bevel(),
      });
    const s = slideOf(shapes);
    expect(s.classification.class).toBe('native');
    const flat = s.elements.filter((e) => e.reasons?.includes('3d:flat-in-decoration'));
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every((e) => e.decor !== undefined && e.support === 'approx')).toBe(true);
    expect(s.notes.some((n) => /3-D shape\(s\) are drawn flat in decorations/.test(n))).toBe(true);
  });
});

describe('SmartArt drawings past the object budget', () => {
  it('stay whole and native: their shapes in decorations of the drawing, locked together', () => {
    let nodes = '';
    const colors = ['FF0000', '00FF00'];
    for (let i = 0; i < 160; i++)
      nodes += dspSp({
        x: (i % 16) * (IN / 2),
        y: Math.floor(i / 16) * (IN / 4),
        cx: IN / 4,
        cy: IN / 8,
      }).replace(/<a:srgbClr val="[0-9A-F]+"\/>/, `<a:srgbClr val="${colors[i % 2]}"/>`);
    const frame = { id: 7, x: IN, y: IN, cx: 8 * IN, cy: 4 * IN, dmId: 'rIdDm1' };
    const deck = withSmartArt(
      buildDeck({ slides: [{ shapes: smartArtFrame(frame), rels: smartArtRels(1) }] }),
      1,
      drawingXml(nodes),
    );
    const out = emitSlides(parseDeck(deck), { geomFiles: false }).slides[0]!;
    expect(out.classification.class).toBe('native');
    const decor = out.slide.objects.filter((o) => o.type === 'shape' && o.decor);
    expect(decor.length).toBeGreaterThan(0);
    expect(decor.every((o) => o.locked && o.origin?.role === 'diagram')).toBe(true);
  });
});
