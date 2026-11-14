import { MISSING_KINDS } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { FALLBACK_FEATURES, TIER_BLOCKERS } from './classify.ts';
import { parseDeck } from './index.ts';
import {
  type Decision,
  decidedFeatures,
  decisionOf,
  drawnWithoutArt,
  missingKindOf,
  RESIDUAL_ROWS,
  rowOf,
} from './residual.ts';
import { body, buildDeck, para, run, solid, sp } from './test-util.ts';

/** What the converter did with each reason before M9 (the base, 0d1c081): the table must keep it but for 3-D. */
const BASE: Readonly<Record<string, Decision>> = {
  table: 'residual',
  'budget:table': 'residual',
  chart: 'residual',
  smartart: 'residual',
  'budget:smartart': 'residual',
  ole: 'residual',
  graphicFrame: 'residual',
  '3d': 'residual',
  '3d:camera': 'residual', // the base wrote '3d' for every real 3-D, residual
  'budget:3d': 'residual', // likewise: past the object budget M9 keeps it so
  math: 'residual',
  ink: 'unread',
  reflection: 'approx',
  innerShdw: 'approx',
  softEdge: 'approx',
  warp: 'residual',
  vert: 'residual',
  numCol: 'residual',
  anchorCtr: 'residual',
  metafile: 'approx',
  'pic:tif': 'approx',
  'pic:tiff': 'approx',
  'pic:jxr': 'approx',
  'pic:wdp': 'residual',
  'pic:hdp': 'residual',
  'mask:*': 'approx',
  recolor: 'approx',
  custGeom: 'residual',
  'custGeom:complex': 'residual',
  'geom:complex': 'residual',
  'preset:*': 'approx',
  pattFill: 'approx',
  shear: 'approx',
  tableDiagonal: 'approx',
  'budget:shapes': 'residual',
};

/**
 * M9's policy changes: wave 1 (`conv-seams`), real 3-D is drawn flat; wave 2 (`decor-conv`), nothing is
 * left to the art for being slow to draw (decisions.md "Slow-to-draw elements"), and real 3-D drawn flat in a
 * decoration is a row of its own.
 */
const M9_CHANGES: Readonly<Record<string, Decision>> = {
  '3d': 'approx',
  '3d:camera': 'approx',
  'custGeom:complex': 'native',
  'geom:complex': 'native',
  '3d:flat-in-decoration': 'approx',
  // text-fix (r2a): picture-filled text is drawn in the text colour, a row of its own.
  'textFill:picture': 'approx',
};

const IN = 914_400;
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_OLE = 'http://schemas.openxmlformats.org/presentationml/2006/ole';
const NS_DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';

const frame = (id: number, uri: string) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="F${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
  `<p:xfrm><a:off x="0" y="0"/><a:ext cx="${IN}" cy="${IN}"/></p:xfrm>` +
  `<a:graphic><a:graphicData uri="${uri}"/></a:graphic></p:graphicFrame>`;
const box = (extra: string) => sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: solid('336699') + extra });
const text = (bodyPr: string, children = '', paras = para(run('Text'))) =>
  sp({ id: 2, x: 0, y: 0, cx: 4 * IN, cy: IN, txBox: true, txBody: body(paras, bodyPr) }).replace(
    `<a:bodyPr${bodyPr ? ` ${bodyPr}` : ''}/>`,
    `<a:bodyPr${bodyPr ? ` ${bodyPr}` : ''}>${children}</a:bodyPr>`,
  );

describe('the residual decision table (M9)', () => {
  it("every FALLBACK_FEATURES entry has a row; decisions equal today's but for M9's changes", () => {
    const decided = decidedFeatures();
    for (const f of FALLBACK_FEATURES) expect(decided.has(f), f).toBe(true);
    // Every row is pinned, and the base's decisions are kept but for M9's changes.
    expect(RESIDUAL_ROWS.map((r) => r.reason).sort()).toEqual(
      [...new Set([...Object.keys(BASE), ...Object.keys(M9_CHANGES)])].sort(),
    );
    for (const r of RESIDUAL_ROWS) expect(r.decision, r.reason).toBe(M9_CHANGES[r.reason] ?? BASE[r.reason]);
    expect(RESIDUAL_ROWS.filter((r) => r.decision !== BASE[r.reason]).map((r) => r.reason)).toEqual([
      '3d',
      '3d:camera',
      'textFill:picture',
      'custGeom:complex',
      'geom:complex',
      '3d:flat-in-decoration',
    ]);
    // Rows name census features the census has (fallback features or tier blockers).
    const census = new Set([...FALLBACK_FEATURES, ...TIER_BLOCKERS.flatMap(([, s]) => [...s])]);
    for (const f of decided) expect(census.has(f), f).toBe(true);
  });

  it('has one row per reason, a missing kind for every residual and unread one, and family rows by prefix', () => {
    const reasons = RESIDUAL_ROWS.map((r) => r.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    const kinds = new Set<string>(MISSING_KINDS);
    for (const r of RESIDUAL_ROWS) {
      // A residual row version 1 draws as ordo draws it elsewhere (`drawn`) has no missing kind: nothing is.
      if ((r.decision === 'residual' || r.decision === 'unread') && !r.drawn)
        expect(r.missing, r.reason).toBeDefined();
      if (r.drawn) expect([r.decision, r.missing], r.reason).toEqual(['residual', undefined]);
      if (r.missing) expect(kinds.has(r.missing), r.reason).toBe(true);
      expect(r.note.length).toBeGreaterThan(0);
    }
    expect(rowOf('preset:star5')?.reason).toBe('preset:*');
    expect(rowOf('mask:cloud')?.reason).toBe('mask:*');
    expect(rowOf('preset')).toBeUndefined();
    expect(decisionOf('no such reason')).toBe('residual');
    expect(decisionOf('no such reason', 'native')).toBe('native');
    expect(missingKindOf(['shear', 'chart', 'ole'])).toBe('chart');
    expect(missingKindOf(['budget:shapes'])).toBe('decoration');
    expect(missingKindOf(['warp'])).toBe('element');
    expect(missingKindOf(undefined)).toBe('element');
  });

  it('knows which residual elements version 1 draws as ordo draws them (real 3-D past the object budget)', () => {
    expect(RESIDUAL_ROWS.filter((r) => r.drawn).map((r) => r.reason)).toEqual(['budget:3d']);
    expect(drawnWithoutArt(['3d', 'budget:3d'])).toBe(true);
    expect(drawnWithoutArt(['3d:camera', 'shear', 'budget:3d'])).toBe(true);
    // Anything else the art draws is missing without LibreOffice.
    expect(drawnWithoutArt(['3d', 'budget:3d', 'warp'])).toBe(false);
    expect(drawnWithoutArt(['budget:3d', 'something new'])).toBe(false);
    expect(drawnWithoutArt(['budget:shapes'])).toBe(false);
    expect(drawnWithoutArt(['3d'])).toBe(false);
    expect(drawnWithoutArt(undefined)).toBe(false);
  });

  it("the classifier's verdicts are the table's", () => {
    const cases: [string, string][] = [
      ['chart', frame(3, NS_C)],
      ['ole', frame(3, NS_OLE)],
      ['smartart', frame(3, NS_DGM)],
      ['graphicFrame', frame(3, 'urn:none')],
      ['math', text('', '', para(run('x') + '<a14:m><m:oMathPara/></a14:m>'))],
      ['3d', box('<a:sp3d><a:bevelT/></a:sp3d>')],
      ['3d:camera', box('<a:scene3d><a:camera prst="isometricTopUp"/></a:scene3d><a:sp3d extrusionH="9"/>')],
      ['reflection', box('<a:effectLst><a:reflection/></a:effectLst>')],
      ['innerShdw', box('<a:effectLst><a:innerShdw/></a:effectLst>')],
      ['warp', text('', '<a:prstTxWarp prst="textWave1"><a:avLst/></a:prstTxWarp>')],
      ['vert', text('vert="vert"')],
      ['numCol', text('numCol="2"')],
      ['anchorCtr', text('anchorCtr="1"')],
      ['textFill:picture', text('', '', para(run('AMOR', '', '<a:blipFill><a:blip/></a:blipFill>')))],
    ];
    for (const [reason, shapes] of cases) {
      const e = parseDeck(buildDeck({ slides: [{ shapes }] })).slides[0]!.elements[0]!;
      expect(e.reasons, reason).toContain(reason);
      expect(e.support, reason).toBe(decisionOf(reason));
    }
  });
});
