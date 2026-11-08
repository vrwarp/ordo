import { describe, expect, it } from 'vitest';
import { elementRefs, noteWithoutLibreOffice } from './hybrid.ts';
import { drawingXml, dspSp, smartArtFrame, smartArtRels, withSmartArt } from './smartart.test-util.ts';
import { convertDeck } from './index.ts';
import type { Element } from './ir.ts';
import {
  body,
  buildDeck,
  CHART_CONTENT_TYPE,
  chartFrame,
  chartXml,
  imageRel,
  para,
  pic,
  pngHeader,
  run,
  solid,
  sp,
  withPart,
} from './test-util.ts';

/** A table frame (residual until M6). */
function tableFrame(o: { id: number; x: number; y: number; cx: number; cy: number }): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${o.id}" name="Table ${o.id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${o.x}" y="${o.y}"/><a:ext cx="${o.cx}" cy="${o.cy}"/></p:xfrm>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl/></a:graphicData></a:graphic></p:graphicFrame>'
  );
}

const EMU = 914_400 / 2; // half an inch

/**
 * Bottom to top: a title (below the art range), a chart (Rmin), a captioned rect overlapping the table above
 * it (baked into the art), a rect clear of everything above it (native, just above the art), the table
 * (Rmax), a footer text (above the range).
 */
function deck() {
  const parts = buildDeck({
    slides: [
      {
        rels: [{ id: 'rId3', type: 'chart', target: '../charts/chart1.xml' }],
        shapes:
          sp({ id: 2, x: EMU, y: 0, cx: 10 * EMU, cy: EMU, txBody: body(para(run('Giving'))) }) +
          chartFrame({ id: 4, x: 2 * EMU, y: 2 * EMU, cx: 8 * EMU, cy: 6 * EMU, rId: 'rId3' }) +
          sp({
            id: 5,
            x: 11 * EMU,
            y: 9 * EMU,
            cx: 4 * EMU,
            cy: 2 * EMU,
            fill: solid('FF0000'),
            txBody: body(para(run('Total'))),
          }) +
          sp({ id: 7, x: 20 * EMU, y: 2 * EMU, cx: 2 * EMU, cy: 2 * EMU, fill: solid('0000FF') }) +
          tableFrame({ id: 6, x: 12 * EMU, y: 10 * EMU, cx: 8 * EMU, cy: 4 * EMU }) +
          sp({ id: 8, x: EMU, y: 13 * EMU, cx: 6 * EMU, cy: EMU, txBody: body(para(run('Thank you'))) }),
      },
    ],
  });
  return withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
}

describe('hybrid art (EmittedSlide.art)', () => {
  it('names the art elements, the objects it replaces and its place', () => {
    const out = convertDeck(deck());
    const s = out.slides[0]!;
    expect(s.classification.class).toBe('hybrid');
    const art = s.art!;
    expect(art.elements).toEqual([
      { from: 'slide', shapeId: 4, nth: 0 },
      { from: 'slide', shapeId: 5, nth: 0 },
      { from: 'slide', shapeId: 6, nth: 0 },
    ]);
    const objs = s.slide.objects;
    // background, title, the captioned rect (shape + text), the clear rect, the footer
    expect(objs.map((o) => o.type)).toEqual(['shape', 'text', 'shape', 'text', 'shape', 'text']);
    expect(art.at).toBe(2);
    expect(art.replaces).toEqual([objs[2]!.id, objs[3]!.id]);
    expect(art.before).toBe(objs[4]!.id);
    expect(art.text).toBe('Total');
    // The box spans the chart, the rect and the table, in logical px (1 in = 144 px on a 16:9 slide).
    expect(art.box.x).toBeCloseTo(144, 6);
    expect(art.box.y).toBeCloseTo(144, 6);
    expect(art.box.x + art.box.w).toBeCloseTo(20 * 72, 6);
    expect(art.box.y + art.box.h).toBeCloseTo(14 * 72, 6);
  });

  it('puts the art on top when nothing is above its range', () => {
    const parts = buildDeck({
      slides: [
        {
          rels: [{ id: 'rId3', type: 'chart', target: '../charts/chart1.xml' }],
          shapes: chartFrame({ id: 4, x: 0, y: 0, cx: 4 * EMU, cy: 4 * EMU, rId: 'rId3' }),
        },
      ],
    });
    withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
    const s = convertDeck(parts).slides[0]!;
    expect(s.art).toMatchObject({ at: 1, replaces: [], text: '' });
    expect(s.art!.before).toBeUndefined();
  });

  it('gives native slides no art', () => {
    const parts = buildDeck({
      slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: EMU, cy: EMU, fill: solid('00FF00') }) }],
    });
    expect(convertDeck(parts).slides[0]!.art).toBeUndefined();
  });

  it('keeps repeated ids apart by their place', () => {
    const e = (from: Element['from'], shapeId: number) => ({ from, shapeId }) as Element;
    const els = [e('master', 4), e('slide', 4), e('slide', 9), e('slide', 4), e('layout', 4)];
    expect(elementRefs(els, [1, 3, 4, 0])).toEqual([
      { from: 'slide', shapeId: 4, nth: 0 },
      { from: 'slide', shapeId: 4, nth: 1 },
      { from: 'layout', shapeId: 4, nth: 0 },
      { from: 'master', shapeId: 4, nth: 0 },
    ]);
  });
});

describe('without LibreOffice (EmitOptions.libreoffice: false, M9)', () => {
  it('libreoffice:false leaves the art out, lists missing kinds, class hybrid with reason missing:<kind>, artText kept', () => {
    const withLo = convertDeck(deck()).slides[0]!;
    const out = convertDeck(deck(), { libreoffice: false });
    const s = out.slides[0]!;
    // No art is planned: nothing would draw it.
    expect(s.art).toBeUndefined();
    // The chart and the table (one ordo cannot read) are what nothing draws.
    expect(s.missing).toEqual(['chart', 'element']);
    expect(s.classification.class).toBe('hybrid');
    expect(s.classification.reasons).toEqual([
      ...withLo.classification.reasons,
      'missing:chart',
      'missing:element',
    ]);
    // The art's text stays for search; version 1's objects are those a hub with LibreOffice writes.
    expect(s.artText).toBe('Total');
    expect(s.slide.objects).toEqual(withLo.slide.objects);
    expect(s.digest).toBe(withLo.digest);
    expect(s.notes.some((n) => n === 'not drawn: a chart, an element')).toBe(true);
    // With LibreOffice (the default) nothing of this is written.
    expect(withLo.art).toBeDefined();
    expect(withLo.missing).toBeUndefined();
    expect(withLo.artText).toBeUndefined();
  });

  it('lists metafile pictures as missing instead of setting them aside, and a slide with nothing missing is unchanged', () => {
    const parts = buildDeck({
      slides: [
        {
          rels: [imageRel('rId2', 'logo.emf')],
          shapes:
            sp({ id: 2, x: 0, y: 0, cx: 4 * EMU, cy: EMU, txBody: body(para(run('Welcome'))) }) +
            pic({ id: 3, x: 0, y: 2 * EMU, cx: 2 * EMU, cy: 2 * EMU, rId: 'rId2' }),
        },
        { shapes: sp({ id: 2, x: 0, y: 0, cx: EMU, cy: EMU, fill: solid('00FF00') }) },
      ],
    });
    withPart(parts, 'ppt/media/logo.emf', new Uint8Array([1, 0, 0, 0]));
    const withLo = convertDeck(parts).slides;
    expect(withLo[0]!.metafiles).toHaveLength(1);
    expect(withLo[0]!.classification.class).toBe('native');
    const [s, plain] = convertDeck(parts, { libreoffice: false }).slides;
    expect(s!.metafiles).toBeUndefined();
    expect(s!.missing).toEqual(['metafile']);
    expect(s!.classification).toMatchObject({ class: 'hybrid' });
    expect(s!.classification.reasons.at(-1)).toBe('missing:metafile');
    expect(s!.artText).toBeUndefined();
    expect(plain!.missing).toBeUndefined();
    expect(plain!.classification).toEqual(withLo[1]!.classification);
  });

  it('names the elements of a SmartArt drawing in the art smartart', () => {
    const drawing = drawingXml(
      dspSp({ x: 0, y: 0, cx: 2 * EMU, cy: 2 * EMU, paras: para(run('Rise')), bodyPr: 'vert="vert270"' }) +
        dspSp({ x: 3 * EMU, y: 0, cx: 2 * EMU, cy: 2 * EMU, paras: para(run('Shine')) }),
    );
    const parts = buildDeck({
      slides: [
        {
          rels: smartArtRels(1),
          shapes: smartArtFrame({ id: 7, x: EMU, y: EMU, cx: 8 * EMU, cy: 4 * EMU, dmId: 'rIdDm1' }),
        },
      ],
    });
    withSmartArt(parts, 1, drawing);
    const s = convertDeck(parts, { libreoffice: false }).slides[0]!;
    expect(s.missing).toEqual(['smartart']);
    expect(s.classification.reasons).toContain('missing:smartart');
    expect(s.artText).toBe('Rise\nShine');
  });

  it('leaves picture slides to the budget', () => {
    let shapes = '';
    for (let i = 0; i < 160; i++)
      shapes += sp({ id: i + 2, x: 0, y: 0, cx: EMU, cy: EMU, txBody: body(para(run(`t${i}`))) });
    const big = convertDeck(buildDeck({ slides: [{ shapes }] }), { libreoffice: false }).slides[0]!;
    expect(big.classification.class).toBe('picture');
    expect(big.missing).toBeUndefined();
  });

  it('plans no art on a picture-class slide either (M9 wave 1 repair)', () => {
    // A chart (residual) and 13 distinct pictures, past the slide's 12: the emitted slide is a picture for its
    // budget. (No byte budget makes a picture since M9's ladder: before it, a chart slide past 64 KB of text
    // formatting was a picture with its art still planned.)
    const n = 13;
    const media: Record<string, Uint8Array> = {};
    for (let i = 0; i < n; i++) media[`ppt/media/p${i}.png`] = pngHeader(64 + i, 64, true);
    const parts = buildDeck({
      slides: [
        {
          rels: [
            { id: 'rId3', type: 'chart', target: '../charts/chart1.xml' },
            ...Array.from({ length: n }, (_, i) => imageRel(`rId${10 + i}`, `p${i}.png`)),
          ],
          shapes:
            chartFrame({ id: 4, x: 0, y: 0, cx: 4 * EMU, cy: 3 * EMU, rId: 'rId3' }) +
            Array.from({ length: n }, (_, i) =>
              pic({
                id: 20 + i,
                x: i * EMU * 0.5,
                y: 4 * EMU,
                cx: EMU / 2,
                cy: EMU / 2,
                rId: `rId${10 + i}`,
              }),
            ).join(''),
        },
      ],
      media,
    });
    withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
    const withLo = convertDeck(parts).slides[0]!;
    expect(withLo.classification.class).toBe('picture');
    expect(withLo.classification.reasons).toContain('budget:pictures');
    const s = convertDeck(parts, { libreoffice: false }).slides[0]!;
    expect(s.classification.class).toBe('picture');
    expect(s.art).toBeUndefined();
    expect(s.metafiles).toBeUndefined();
    expect(s.missing).toBeUndefined();
  });

  it('draws real 3-D past the object budget flat without LibreOffice: nothing missing, never named (M9 wave 1 repair)', () => {
    let shapes = '';
    for (let i = 0; i < 170; i++)
      shapes += sp({
        id: i + 2,
        x: (i % 17) * EMU,
        y: Math.floor(i / 17) * EMU,
        cx: EMU / 2,
        cy: EMU / 2,
        fill:
          '<a:solidFill><a:srgbClr val="3366CC"/></a:solidFill><a:scene3d><a:camera prst="orthographicFront"/>' +
          '<a:lightRig rig="threePt" dir="t"/></a:scene3d><a:sp3d><a:bevelT w="38100" h="38100"/></a:sp3d>',
      });
    const parts = buildDeck({ slides: [{ shapes }] });
    const withLo = convertDeck(parts).slides[0]!;
    // With LibreOffice the art draws the bevels (`budget:3d`); version 1 draws them flat meanwhile.
    expect(withLo.classification).toMatchObject({ class: 'hybrid' });
    expect(withLo.classification.reasons).toContain('art:budget:3d');
    expect(withLo.art).toBeDefined();
    const s = convertDeck(parts, { libreoffice: false }).slides[0]!;
    // Without it version 1 is the slide: every shape drawn flat, as approx 3-D within the budget is.
    expect(s.classification.class).toBe('native');
    expect(s.classification.reasons.some((r) => r.startsWith('art:') || r.startsWith('missing:'))).toBe(
      false,
    );
    expect(s.missing).toBeUndefined();
    expect(s.art).toBeUndefined();
    expect(s.slide.objects).toEqual(withLo.slide.objects);
    expect(s.notes).toContain('3-D is drawn flat (an approximation)');
    expect(s.notes.some((n) => /LibreOffice|not drawn/.test(n))).toBe(false);
  });

  it("never names LibreOffice in a slide's notes without it (M9 wave 1 repair)", () => {
    // A chart, a table it cannot read and an EMF: residual, each with its converter note.
    const parts = buildDeck({
      slides: [
        {
          rels: [{ id: 'rId3', type: 'chart', target: '../charts/chart1.xml' }, imageRel('rId2', 'logo.emf')],
          shapes:
            chartFrame({ id: 4, x: 0, y: 0, cx: 4 * EMU, cy: 3 * EMU, rId: 'rId3' }) +
            tableFrame({ id: 5, x: 0, y: 4 * EMU, cx: 4 * EMU, cy: 2 * EMU }) +
            pic({ id: 6, x: 5 * EMU, y: 0, cx: 2 * EMU, cy: 2 * EMU, rId: 'rId2' }),
        },
      ],
    });
    withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
    withPart(parts, 'ppt/media/logo.emf', new Uint8Array([1, 0, 0, 0]));
    const withLo = convertDeck(parts).slides[0]!;
    expect(withLo.notes.some((n) => /LibreOffice/.test(n))).toBe(true);
    const s = convertDeck(parts, { libreoffice: false }).slides[0]!;
    expect(
      s.notes.some((n) => /LibreOffice/.test(n)),
      s.notes.join(' | '),
    ).toBe(false);
    expect(s.notes).toContain('chart not drawn');
    expect(s.notes.some((n) => /^not drawn: /.test(n))).toBe(true);
  });

  it('rewrites every converter note that names LibreOffice', () => {
    const cases: [string, string | undefined][] = [
      ['170 3-D shape(s) on a slide past its object budget: LibreOffice draws them', undefined],
      [
        "a SmartArt graphic of 300 objects passes the slide's budget: LibreOffice draws it",
        "a SmartArt graphic of 300 objects passes the slide's budget: not drawn",
      ],
      [
        "12 shapes and pictures pass the slide's object budget: LibreOffice draws them",
        "12 shapes and pictures pass the slide's object budget: not drawn",
      ],
      [
        'more SmartArt than an import reads natively: LibreOffice draws the rest',
        'more SmartArt than an import reads natively: the rest is not drawn',
      ],
      [
        'a SmartArt drawing holds no shapes: LibreOffice lays the diagram out',
        'a SmartArt drawing holds no shapes: not drawn',
      ],
      [
        "custom geometry past the slide's drawing budget is drawn by LibreOffice",
        "custom geometry past the slide's drawing budget is not drawn",
      ],
      ['chart drawn by LibreOffice as a picture', 'chart not drawn'],
      ['table drawn by LibreOffice as a picture', 'table not drawn'],
      ['a emf picture is converted by LibreOffice', 'a emf picture is not drawn'],
      [
        'a shape turned in an unevenly scaled group is placed as LibreOffice places it',
        'a shape turned in an unevenly scaled group is placed without the shear',
      ],
      ['3-D is drawn flat (an approximation)', '3-D is drawn flat (an approximation)'],
    ];
    for (const [note, want] of cases) expect(noteWithoutLibreOffice(note), note).toBe(want);
  });
});
