import { Slide, type SlideObject } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { ALL_M9_FIELDS, M9_FIELDS } from './emit.ts';
import { convertDeck } from './index.ts';
import type { PartSource } from './opc.ts';
import { drawingXml, dspSp, smartArtFrame, smartArtRels, withSmartArt } from './smartart.test-util.ts';
import {
  body,
  buildDeck,
  CHART_CONTENT_TYPE,
  chartFrame,
  chartXml,
  custGeom,
  imageRel,
  para,
  pic,
  PNG_1X1,
  run,
  solid,
  sp,
  tableFrame,
  tc,
  withPart,
} from './test-util.ts';

const IN = 914_400;
const BEVEL = '<a:sp3d prstMaterial="plastic"><a:bevelT w="63500" h="25400"/></a:sp3d>';
const SCENE =
  '<a:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d>';
const TURNED = '<a:scene3d><a:camera prst="isometricTopUp"/><a:lightRig rig="threePt" dir="t"/></a:scene3d>';

/** A text box whose `a:bodyPr` has attributes and children. */
const textBox = (id: number, words: string, bodyPr: string, children = '', y = 0) =>
  sp({ id, x: 0, y, cx: 6 * IN, cy: IN, txBox: true, txBody: body(para(run(words)), bodyPr) }).replace(
    `<a:bodyPr${bodyPr ? ` ${bodyPr}` : ''}/>`,
    `<a:bodyPr${bodyPr ? ` ${bodyPr}` : ''}>${children}</a:bodyPr>`,
  );

/** A long traced decoration: its paths go to a geometry file. */
function traced(id: number): string {
  let d = '<a:moveTo><a:pt x="0" y="0"/></a:moveTo>';
  for (let i = 1; i < 400; i++) d += `<a:lnTo><a:pt x="${i * 50}" y="${(i * 37) % 2000}"/></a:lnTo>`;
  return sp({
    id,
    x: 0,
    y: 4 * IN,
    cx: 8 * IN,
    cy: IN,
    geom: 'none',
    fill: custGeom({ paths: `<a:path w="20000" h="2000">${d}<a:close/></a:path>` }) + solid('884422'),
  });
}

/**
 * Fixture decks with every element an M9 field is for: 3-D shapes, pictures and text (front and turned
 * cameras), a table, a chart, SmartArt with bevelled shapes, WordArt warps, vertical and centred text, a
 * metafile, a wide pie and a traced decoration in a geometry file.
 */
function fixtures(): PartSource[] {
  const shapes =
    sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: solid('336699') + SCENE + BEVEL }) +
    sp({
      id: 3,
      x: 2 * IN,
      y: 0,
      cx: IN,
      cy: IN,
      fill: solid('993366') + TURNED + '<a:sp3d extrusionH="76200"/>',
    }) +
    pic({ id: 4, x: 4 * IN, y: 0, cx: IN, cy: IN, rId: 'rIdPic' }).replace(
      '</p:spPr>',
      `${SCENE}${BEVEL}</p:spPr>`,
    ) +
    textBox(5, 'Bevelled title', '', SCENE + BEVEL, IN) +
    textBox(
      6,
      'Arch',
      '',
      '<a:prstTxWarp prst="textArchUp"><a:avLst><a:gd name="adj" fmla="val 10800000"/></a:avLst></a:prstTxWarp>',
      2 * IN,
    ) +
    textBox(7, '主の祈り', 'vert="eaVert"', '', 3 * IN) +
    textBox(8, 'Centred', 'anchorCtr="1"', '', 5 * IN) +
    sp({ id: 9, x: 6 * IN, y: 0, cx: IN, cy: IN, geom: 'pie', fill: solid('22AA22') }).replace(
      '<a:avLst/>',
      '<a:avLst><a:gd name="adj1" fmla="val 0"/><a:gd name="adj2" fmla="val 16200000"/></a:avLst>',
    ) +
    traced(10) +
    pic({ id: 11, x: 8 * IN, y: 0, cx: IN, cy: IN, rId: 'rIdEmf' });
  const deck = buildDeck({
    slides: [
      { rels: [imageRel('rIdPic', 'photo.png'), imageRel('rIdEmf', 'logo.emf')], shapes },
      {
        rels: [{ id: 'rIdChart', type: 'chart', target: '../charts/chart1.xml' }],
        shapes:
          chartFrame({ id: 2, x: 0, y: 0, cx: 4 * IN, cy: 3 * IN, rId: 'rIdChart' }) +
          tableFrame({
            id: 3,
            x: 5 * IN,
            y: 0,
            cols: [IN, IN],
            rows: [
              { h: IN / 2, cells: [tc('Hymn'), tc('Page')] },
              { h: IN / 2, cells: [tc('Amazing Grace'), tc('378')] },
            ],
          }),
      },
      {
        rels: smartArtRels(1),
        shapes: smartArtFrame({ id: 7, x: IN, y: IN, cx: 8 * IN, cy: 4 * IN, dmId: 'rIdDm1' }),
      },
    ],
  });
  withPart(deck, 'ppt/media/photo.png', PNG_1X1);
  withPart(deck, 'ppt/media/logo.emf', new Uint8Array([1, 0, 0, 0]));
  withPart(deck, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
  withSmartArt(
    deck,
    1,
    drawingXml(
      dspSp({ x: 0, y: 0, cx: 2 * IN, cy: 2 * IN, extra: SCENE + BEVEL, paras: para(run('Faith')) }) +
        dspSp({ x: 3 * IN, y: 0, cx: 2 * IN, cy: 2 * IN, extra: SCENE + BEVEL, paras: para(run('Hope')) }),
    ),
  );
  return [deck];
}

/** The M9 stored fields an object carries (plan §3), by name. */
function m9FieldsOf(o: SlideObject): string[] {
  const has = (k: string) => (o as unknown as Record<string, unknown>)[k] !== undefined;
  const out: string[] = [];
  const keys =
    o.type === 'shape'
      ? ['table', 'chart', 'decor', 'look3d']
      : o.type === 'image'
        ? ['look3d', 'vectorFonts']
        : o.type === 'text'
          ? ['warp', 'writing', 'centerBlock', 'look3d']
          : [];
  for (const k of keys) if (has(k)) out.push(k);
  const g = o.type === 'shape' ? o.geom : o.type === 'image' ? o.mask : undefined;
  if (g?.adjWide !== undefined) out.push('adjWide');
  return out;
}

describe('the M9 field gate (EmitOptions.m9Writes)', () => {
  it('with m9Writes empty no slide of the fixture decks carries an M9 field', () => {
    for (const deck of fixtures()) {
      for (const libreoffice of [true, false]) {
        const out = convertDeck(deck, { m9Writes: new Set(), libreoffice });
        expect(out.slides.length).toBe(3);
        for (const s of out.slides) {
          expect(Slide.safeParse(s.slide).success).toBe(true);
          for (const o of s.slide.objects) expect(m9FieldsOf(o), `${o.type} ${o.id}`).toEqual([]);
        }
        // Geometry files stay within the M6 bound an older build reads.
        expect(out.geoms.length).toBeGreaterThan(0);
        for (const g of out.geoms) expect(g.file.paths.length).toBeLessThanOrEqual(8);
      }
    }
  });

  it('names every field the converter writes, all of them by default', () => {
    expect([...ALL_M9_FIELDS]).toEqual([...M9_FIELDS]);
    expect(M9_FIELDS).toEqual([
      'table',
      'chart',
      'decor',
      'decorFile',
      'look3d',
      'warp',
      'writing',
      'centerBlock',
      'vectorFonts',
      'adjWide',
      'geomFile64',
    ]);
    // The fixtures convert the same way with every field on and with none until the M9 areas write theirs.
    const [deck] = fixtures();
    const on = convertDeck(deck!);
    const off = convertDeck(deck!, { m9Writes: new Set() });
    expect(on.slides.map((s) => s.slide)).toEqual(off.slides.map((s) => s.slide));
  });
});
