import { Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { convertDeck, emitSlides, parseDeck } from './index.ts';
import { buildRenderCopy } from './rendercopy.ts';
import type { ShapeElement } from './ir.ts';
import {
  colorsXml,
  drawingXml,
  dspSp,
  smartArtFrame,
  smartArtRels,
  withSmartArt,
} from './smartart.test-util.ts';
import {
  body,
  buildDeck,
  CHART_CONTENT_TYPE,
  chartFrame,
  chartXml,
  para,
  partText,
  run,
  solid,
  sp,
  withPart,
} from './test-util.ts';

const IN = 914_400;
/** The frame: 1 in from the left, 1 in down, 8 x 4 in. */
const FRAME = { id: 7, x: IN, y: IN, cx: 8 * IN, cy: 4 * IN, dmId: 'rIdDm1' };

/** Two nodes: a filled rounded rect with its text in a narrower rectangle, and an ellipse without text. */
const TWO_NODES = drawingXml(
  dspSp({
    x: 0,
    y: 0,
    cx: 4 * IN,
    cy: 2 * IN,
    geom: 'roundRect',
    paras: para(run('Faith', 'sz="2400"')),
    tx: { x: IN / 2, y: IN / 2, cx: 3 * IN, cy: IN },
  }) + dspSp({ x: 5 * IN, y: IN, cx: 2 * IN, cy: 2 * IN, geom: 'ellipse', fill: solid('00FF00') }),
);

function deckWith(
  drawing: string | undefined,
  shapes = '',
  extraRels: { id: string; type: string; target: string }[] = [],
) {
  const parts = buildDeck({
    slides: [
      {
        rels: [...smartArtRels(1, drawing !== undefined), ...extraRels],
        shapes: shapes + smartArtFrame(FRAME),
      },
    ],
  });
  return withSmartArt(parts, 1, drawing);
}

describe('SmartArt from its drawing cache (M6)', () => {
  it('reads the drawing as native shapes placed in the frame, its text in the text rectangle', () => {
    const scene = parseDeck(deckWith(TWO_NODES));
    const s = scene.slides[0]!;
    const els = s.elements;
    expect(els).toHaveLength(3); // the rounded rect, its text, the ellipse
    for (const e of els) {
      expect(e.kind).toBe('shape');
      expect(e.diagram).toBe(1);
      expect(e.shapeId).toBe(7);
      expect(e.support).not.toBe('residual');
    }
    const [shape, text, ellipse] = els as ShapeElement[];
    expect(shape!.geom).toBe('roundRect');
    expect(shape!.text).toBeUndefined();
    expect(shape!.fill.kind).toBe('solid');
    // Relative to the frame at scale 1.
    expect(shape!.xf).toEqual([4 * IN, 0, 0, 2 * IN, IN, IN]);
    expect(text!.geom).toBe('rect');
    expect(text!.fill.kind).toBe('none');
    expect(text!.line).toBeUndefined();
    expect(text!.xf).toEqual([3 * IN, 0, 0, IN, 1.5 * IN, 1.5 * IN]);
    expect(text!.text?.paras[0]?.runs[0]?.text).toBe('Faith');
    // The style's font colour (lt1, white) through the shape's fontRef.
    expect(text!.text?.paras[0]?.runs[0]?.style.fill).toEqual({
      kind: 'solid',
      color: { r: 255, g: 255, b: 255, a: 1 },
    });
    expect(ellipse!.geom).toBe('ellipse');
    expect(s.classification.class).toBe('native');
    // The census still counts SmartArt (the tier measures feature use, not what is drawn).
    expect(s.classification.tier).toBe('fallback');
  });

  it('emits a locked group whose text stays editable, and keeps the text out of the lyric box', () => {
    const parts = deckWith(
      TWO_NODES,
      sp({ id: 2, x: 0, y: 0, cx: 4 * IN, cy: IN, txBody: body(para(run('Title'))) }),
    );
    const out = emitSlides(parseDeck(parts));
    const slide = out.slides[0]!.slide;
    expect(Slide.parse(slide)).toEqual(slide);
    const diagram = slide.objects.filter((o) => o.origin?.role === 'diagram');
    expect(diagram.map((o) => o.type)).toEqual(['shape', 'text', 'shape']);
    for (const o of diagram) {
      expect(o.origin).toMatchObject({ src: 'pptx', shapeId: 7, role: 'diagram' });
      expect(o.origin?.group).toBe(diagram[0]!.origin?.group);
      expect(o.locked).toBe(o.type === 'text' ? undefined : true);
    }
    const text = diagram[1]!;
    // 1.5 in from the slide's corner at 1920/13.333 in px per inch: the text rectangle, not the shape's.
    const px = 1920 / (12_192_000 / IN);
    expect(text.box.x).toBeCloseTo(1.5 * px, 3);
    expect(text.box.w).toBeCloseTo(3 * px, 3);
    expect(text.type === 'text' && text.text).toBe('Faith');
    const lyric = slide.objects.find((o) => o.id === slide.lyricObjectId);
    expect(lyric?.type === 'text' && lyric.text).toBe('Title');
  });

  it("takes the text colour of the colours part's nodes over the fontRef's, as LibreOffice does", () => {
    const drawing = drawingXml(
      dspSp({ x: 0, y: 0, cx: 4 * IN, cy: IN, paras: para(run('Plain')) }) +
        dspSp({ x: 0, y: 2 * IN, cx: 4 * IN, cy: IN, paras: para(run('Own', '', solid('00FF00'))) }),
    );
    const parts = buildDeck({
      slides: [{ rels: smartArtRels(1, true, true), shapes: smartArtFrame(FRAME) }],
    });
    withSmartArt(parts, 1, drawing);
    withPart(
      parts,
      'ppt/diagrams/colors1.xml',
      colorsXml('<a:schemeClr val="accent2"/><a:schemeClr val="dk1"/>'),
    );
    const els = parseDeck(parts).slides[0]!.elements as ShapeElement[];
    const runs = els.filter((e) => e.text).map((e) => e.text!.paras[0]!.runs[0]!.style.fill);
    // The list's last colour (dk1, black) instead of the fontRef's lt1; a run's own colour stays.
    expect(runs).toEqual([
      { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } },
      { kind: 'solid', color: { r: 0, g: 255, b: 0, a: 1 } },
    ]);
  });

  it('stays residual without a drawing cache', () => {
    const s = parseDeck(deckWith(undefined)).slides[0]!;
    expect(s.elements).toHaveLength(1);
    expect(s.elements[0]).toMatchObject({ kind: 'residual', what: 'smartart', support: 'residual' });
    expect(s.classification.class).toBe('hybrid');
  });

  it('turns the text with the shape plus its own rotation, and keeps the shadow of a shape showing nothing', () => {
    const drawing = drawingXml(
      dspSp({
        x: 0,
        y: 0,
        cx: 2 * IN,
        cy: 4 * IN,
        rot: 90,
        fill: '<a:noFill/>',
        ln: '<a:ln><a:noFill/></a:ln>',
        extra:
          '<a:effectLst><a:outerShdw blurRad="38100" dist="38100" dir="2700000"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>',
        paras: para(run('Hope')),
        tx: { x: -IN, y: IN, cx: 4 * IN, cy: 2 * IN, rot: -90 },
      }),
    );
    const els = parseDeck(deckWith(drawing)).slides[0]!.elements as ShapeElement[];
    expect(els).toHaveLength(2);
    const text = els[1]!;
    // Upright (90 − 90), the text rectangle's own box in the frame.
    expect(text.xf[1]).toBeCloseTo(0, 6);
    expect(text.xf[0]).toBeCloseTo(4 * IN, 3);
    expect(text.xf[4]).toBeCloseTo(0, 3);
    expect(text.shadow).toBeDefined();
  });

  it('resolves picture fills through the drawing part and lists them', () => {
    const drawing = drawingXml(
      dspSp({
        x: 0,
        y: 0,
        cx: 2 * IN,
        cy: 2 * IN,
        fill: '<a:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>',
      }),
    );
    const parts = withSmartArt(
      buildDeck({ slides: [{ rels: smartArtRels(1), shapes: smartArtFrame(FRAME) }] }),
      1,
      drawing,
      [
        {
          id: 'rIdImg',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
          target: '../media/node.png',
        },
      ],
    );
    withPart(parts, 'ppt/media/node.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const out = emitSlides(parseDeck(parts));
    expect(out.media.map((m) => m.part)).toEqual(['ppt/media/node.png']);
    const img = out.slides[0]!.slide.objects.find((o) => o.type === 'image');
    expect(img?.locked).toBe(true);
    expect(img?.origin?.role).toBe('diagram');
  });

  it('goes to the art whole when one of its shapes is residual, named once for the render copy', () => {
    const bevel = '<a:sp3d><a:bevelT w="63500" h="25400"/></a:sp3d>';
    const drawing = drawingXml(
      dspSp({ x: 0, y: 0, cx: 2 * IN, cy: 2 * IN, extra: bevel }) +
        dspSp({ x: 3 * IN, y: 0, cx: 2 * IN, cy: 2 * IN, paras: para(run('Love')) }),
    );
    // A slide shape sharing the frame's id comes after it: the render copy must still find it.
    const parts = deckWith(drawing, '', []);
    const out = emitSlides(parseDeck(parts));
    const s = out.slides[0]!;
    expect(s.classification.class).toBe('hybrid');
    expect(s.classification.reasons).toContain('art:smartart');
    expect(s.art?.elements).toEqual([{ from: 'slide', shapeId: 7, nth: 0 }]);
    expect(s.art?.text).toBe('Love');
    // Version 1 draws it natively until the art replaces every one of its objects.
    const ids = s.slide.objects.filter((o) => o.origin?.role === 'diagram').map((o) => o.id);
    expect(ids.length).toBe(3);
    expect(s.art?.replaces).toEqual(ids);
  });

  it('prints the whole frame with its diagram parts in the render copy when it is in the art', () => {
    const bevel = '<a:sp3d><a:bevelT w="63500" h="25400"/></a:sp3d>';
    const drawing = drawingXml(
      dspSp({ x: 0, y: 0, cx: 2 * IN, cy: 2 * IN, extra: bevel }) +
        dspSp({ x: 3 * IN, y: 0, cx: 2 * IN, cy: 2 * IN, paras: para(run('Love')) }),
    );
    const parts = deckWith(drawing, sp({ id: 3, x: 0, y: 6 * IN, cx: IN, cy: IN, fill: solid('0000FF') }));
    const art = convertDeck(parts).slides[0]!.art!;
    const copy = buildRenderCopy(parts, [{ index: 0, mode: 'art', background: 'white', keep: art.elements }]);
    const slide = partText(copy.parts, 'ppt/slides/slide1.xml');
    expect(slide).toContain('<p:cNvPr id="7"');
    expect(slide).not.toContain('<p:cNvPr id="3"');
    const rels = partText(copy.parts, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toContain('diagramData');
    expect(rels).toContain('diagramDrawing');
    // The drawing part travels with the data model (under a name of the copy's own).
    const drawings = [...copy.parts.keys()].filter((k) => partText(copy.parts, k).includes('<dsp:drawing'));
    expect(drawings).toHaveLength(1);
    expect(partText(copy.parts, drawings[0]!)).toContain('Love');
  });

  it('goes to the art whole when a residual above overlaps part of it inside the art range', () => {
    const chart = { id: 'rIdChart', type: 'chart', target: '../charts/chart1.xml' };
    const parts = buildDeck({
      slides: [
        {
          rels: [...smartArtRels(1), chart],
          shapes:
            chartFrame({ id: 8, x: 10 * IN, y: 6 * IN, cx: IN, cy: IN, rId: 'rIdChart' }) +
            smartArtFrame(FRAME) +
            chartFrame({ id: 9, x: IN, y: IN, cx: IN, cy: IN, rId: 'rIdChart' }),
        },
      ],
    });
    withSmartArt(parts, 1, TWO_NODES);
    withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
    const s = parseDeck(parts).slides[0]!;
    // The rounded rect and its text are under the second chart; the ellipse is not, and goes too.
    expect(s.classification.art!.elements).toEqual([0, 1, 2, 3, 4]);
    expect(s.elements.slice(1, 4).every((e) => e.support === 'residual')).toBe(true);
  });

  it('stays native when the art is above it (the range starts above the drawing)', () => {
    const parts = buildDeck({
      slides: [
        {
          rels: [...smartArtRels(1), { id: 'rIdChart', type: 'chart', target: '../charts/chart1.xml' }],
          shapes: smartArtFrame(FRAME) + chartFrame({ id: 9, x: IN, y: IN, cx: IN, cy: IN, rId: 'rIdChart' }),
        },
      ],
    });
    withSmartArt(parts, 1, TWO_NODES);
    withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
    const s = parseDeck(parts).slides[0]!;
    expect(s.classification.art!.elements).toEqual([3]);
    expect(s.elements.slice(0, 3).every((e) => e.support === 'native')).toBe(true);
  });

  it('goes to the art when it would take the slide past the object budget', () => {
    let nodes = '';
    for (let i = 0; i < 160; i++)
      nodes += dspSp({ x: (i % 16) * (IN / 2), y: Math.floor(i / 16) * (IN / 4), cx: IN / 4, cy: IN / 8 });
    const s = parseDeck(deckWith(drawingXml(nodes))).slides[0]!;
    expect(s.classification.class).toBe('hybrid');
    expect(s.classification.reasons).toContain('art:budget:smartart');
  });

  it('rates its shapes by their own XML, not a slide shape that shares an id', () => {
    // The drawing's shapes are cNvPr id 0; a vertical text box with id 0 on the slide must not rate them.
    const vertical = sp({
      id: 0,
      x: 0,
      y: 6 * IN,
      cx: IN,
      cy: IN,
      txBody: body(para(run('v')), 'vert="vert"'),
    });
    const s = parseDeck(deckWith(TWO_NODES, vertical)).slides[0]!;
    const diagram = s.elements.filter((e) => e.diagram !== undefined);
    expect(diagram).toHaveLength(3);
    expect(diagram.every((e) => e.support !== 'residual')).toBe(true);
  });

  it('reads at most 5,000 shapes of a hostile drawing on a slide', () => {
    let many = '';
    for (let i = 0; i < 6_000; i++) many += dspSp({ x: 0, y: 0, cx: IN / 10, cy: IN / 10 });
    const t0 = performance.now();
    const s = parseDeck(deckWith(drawingXml(many))).slides[0]!;
    expect(s.elements.length).toBeLessThanOrEqual(5_000);
    expect(s.notes.join(' ')).toMatch(/more than 5000 shapes/);
    expect(performance.now() - t0).toBeLessThan(process.env.CI ? 15_000 : 5_000);
  });

  it('reads groups of a drawing to a depth of 32 and no further', () => {
    let nested = dspSp({ x: 0, y: 0, cx: IN, cy: IN });
    for (let i = 0; i < 40; i++)
      nested =
        `<dsp:grpSp><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr>` +
        `<dsp:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${IN}" cy="${IN}"/><a:chOff x="0" y="0"/><a:chExt cx="${IN}" cy="${IN}"/></a:xfrm></dsp:grpSpPr>${nested}</dsp:grpSp>`;
    const deep = parseDeck(deckWith(drawingXml(nested))).slides[0]!;
    expect(deep.elements).toHaveLength(0);
    expect(deep.notes.join(' ')).toMatch(/deeper than 32/);
  });

  it('leaves SmartArt to LibreOffice past the drawings a deck may read (one drawing named from 40 slides)', () => {
    let big = '';
    for (let i = 0; i < 4_000; i++)
      big += dspSp({ x: 0, y: 0, cx: IN / 10, cy: IN / 10, paras: para(run('x')) });
    const slides = Array.from({ length: 40 }, () => ({
      rels: smartArtRels(1),
      shapes: smartArtFrame(FRAME),
    }));
    const parts = withSmartArt(buildDeck({ slides }), 1, drawingXml(big));
    const t0 = performance.now();
    const deck = parseDeck(parts);
    const residual = deck.slides.filter((x) => x.elements.some((e) => e.kind === 'residual'));
    expect(residual.length).toBeGreaterThan(0);
    expect(residual[0]!.notes.join(' ')).toMatch(/more SmartArt than an import reads/);
    expect(performance.now() - t0).toBeLessThan(process.env.CI ? 15_000 : 5_000);
  });

  it('reads the drawing of a layout decoration through the layout part', () => {
    const parts = buildDeck({
      slides: [{}],
      layouts: [{ shapes: smartArtFrame(FRAME), rels: smartArtRels(1) }],
    });
    withSmartArt(parts, 1, TWO_NODES);
    const s = parseDeck(parts).slides[0]!;
    expect(s.elements.filter((e) => e.from === 'layout' && e.diagram === 1)).toHaveLength(3);
  });

  it("keeps a layout's drawing and a slide's apart on every slide that shows both", () => {
    const bevel = '<a:sp3d><a:bevelT w="63500" h="25400"/></a:sp3d>';
    const residualDrawing = drawingXml(dspSp({ x: 0, y: 0, cx: IN, cy: IN, extra: bevel }));
    const slide = { rels: smartArtRels(2), shapes: smartArtFrame({ ...FRAME, id: 9, dmId: 'rIdDm2' }) };
    const parts = buildDeck({
      slides: [slide, slide],
      layouts: [{ shapes: smartArtFrame(FRAME), rels: smartArtRels(1) }],
    });
    withSmartArt(parts, 1, TWO_NODES);
    withSmartArt(parts, 2, residualDrawing);
    // The second slide takes the layout's decorations from the cache: still one drawing each.
    for (const s of parseDeck(parts).slides) {
      const layout = s.elements.filter((e) => e.from === 'layout');
      const own = s.elements.filter((e) => e.from === 'slide');
      expect(own.length).toBe(1);
      expect(own[0]!.support).toBe('residual');
      expect(layout.length).toBe(3);
      expect(layout.every((e) => e.support !== 'residual')).toBe(true);
    }
  });
});
