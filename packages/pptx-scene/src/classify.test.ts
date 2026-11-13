import { describe, expect, it } from 'vitest';
import {
  artRange,
  boundsOf,
  FALLBACK_FEATURES,
  MAX_SLIDE_OBJECTS,
  overlaps,
  shapeRuns,
  slideCost,
  TIER_BLOCKERS,
  tierOf,
} from './classify.ts';
import { frameOf } from './frame.ts';
import { emitSlides, parseDeck } from './index.ts';
import type { Affine, Element, ShapeElement, SlideScene } from './ir.ts';
import { drawingXml, dspSp, smartArtFrame, smartArtRels, withSmartArt } from './smartart.test-util.ts';
import {
  body,
  buildDeck,
  type DeckSpec,
  grpSp,
  imageRel,
  type PartSpec,
  para,
  pic,
  run,
  type SlideSpec,
  solid,
  sp,
} from './test-util.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const IN = 914_400;

// ── Crafted shape-tree elements ─────────────────────────────────────────────────────────────────────────

/** A filled rectangle at (x, y) inches, one inch square unless sized; `spPr` children after its fill. */
const box = (id: number, x = 0, y = 0, extra = '', size = 1) =>
  sp({ id, x: x * IN, y: y * IN, cx: size * IN, cy: size * IN, fill: solid('336699') + extra });

/** A text box with the given paragraphs and `a:bodyPr` attributes. */
const textBox = (id: number, paras: string, bodyPr = '', x = 0, y = 0) =>
  sp({ id, x: x * IN, y: y * IN, cx: 4 * IN, cy: IN, txBox: true, txBody: body(paras, bodyPr) });

/** A text box whose `a:bodyPr` has children (warps, 3D text). */
const textBoxWith = (id: number, bodyPrChildren: string, bodyPr = '') =>
  sp({ id, x: 0, y: 0, cx: 4 * IN, cy: IN, txBox: true, txBody: body(para(run('Text'))) }).replace(
    `<a:bodyPr${bodyPr ? ` ${bodyPr}` : ''}/>`,
    `<a:bodyPr${bodyPr ? ` ${bodyPr}` : ''}>${bodyPrChildren}</a:bodyPr>`,
  );

/** A graphic frame holding `graphicData` of `uri` (chart, table, diagram, ole). */
const frame = (id: number, uri: string, inner = '', x = 0, y = 0) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Frame ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
  `<p:xfrm><a:off x="${x * IN}" y="${y * IN}"/><a:ext cx="${2 * IN}" cy="${2 * IN}"/></p:xfrm>` +
  `<a:graphic><a:graphicData uri="${uri}">${inner}</a:graphicData></a:graphic></p:graphicFrame>`;
const CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const DIAGRAM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const TABLE = 'http://schemas.openxmlformats.org/drawingml/2006/table';
const OLE = 'http://schemas.openxmlformats.org/presentationml/2006/ole';

/** A straight connector. */
const connector = (id: number) =>
  `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Connector ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
  `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${IN}" cy="0"/></a:xfrm><a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>` +
  `<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`;

/** A picture that plays a video (`a:videoFile` in its non-visual properties). */
const video = (id: number) =>
  pic({ id, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2' }).replace(
    '<p:nvPr/>',
    '<p:nvPr><a:videoFile r:link="rId3"/></p:nvPr>',
  );

/** Content inside `mc:AlternateContent` (a Choice and a Fallback). */
const alternate = (choice: string, fallback: string) =>
  `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
  `<mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14">${choice}</mc:Choice>` +
  `<mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`;

/** The scene of a one-slide deck (`budgetArt`: the slide budgets of M6, the harness's A/B). */
function slideOf(
  shapes: string,
  more: Partial<SlideSpec> = {},
  deck: Partial<DeckSpec> = {},
  budgetArt = false,
): SlideScene {
  const scene = parseDeck(buildDeck({ ...deck, slides: [{ shapes, ...more }] }), { budgetArt });
  return scene.slides[0]!;
}

/** The tier of a one-slide deck and its tier reasons (the class reasons left out). */
const tierFor = (shapes: string, more: Partial<SlideSpec> = {}, deck: Partial<DeckSpec> = {}) => {
  const { tier, reasons } = slideOf(shapes, more, deck).classification;
  return { tier, reasons: reasons.filter((r) => !r.startsWith('art:') && !r.startsWith('budget:')) };
};

// ── Tiers ───────────────────────────────────────────────────────────────────────────────────────────────

describe('tierOf (the census rules)', () => {
  it('places feature sets in the census tiers with the features that block the tier below', () => {
    expect(tierOf(new Set())).toEqual({ tier: 'T1', reasons: [] });
    expect(tierOf(new Set(['bullet', 'superSub']))).toEqual({ tier: 'T2', reasons: ['bullet', 'superSub'] });
    expect(tierOf(new Set(['deco:group', 'crop']))).toEqual({ tier: 'T3', reasons: ['deco:group'] });
    expect(tierOf(new Set(['video', 'glow']))).toEqual({ tier: 'T4', reasons: ['glow', 'video'] });
    expect(tierOf(new Set(['softEdge']))).toEqual({ tier: 'T5', reasons: ['softEdge'] });
    expect(tierOf(new Set(['deco:chart', 'group']))).toEqual({ tier: 'fallback', reasons: ['deco:chart'] });
    expect(tierOf(new Set(['artistic', 'shadow', 'outline', 'somethingNew']))).toEqual({
      tier: 'T1',
      reasons: [],
    });
  });

  it('has nested blocker sets: each tier allows what the tier below allows', () => {
    for (let i = 1; i < TIER_BLOCKERS.length; i++)
      for (const f of TIER_BLOCKERS[i]![1]) expect(TIER_BLOCKERS[i - 1]![1].has(f)).toBe(true);
    for (const [, set] of TIER_BLOCKERS) for (const f of set) expect(FALLBACK_FEATURES.has(f)).toBe(false);
  });

  it('puts a crafted slide of each tier where the census does', () => {
    expect(tierFor(box(2) + textBox(3, para(run('Amazing grace', 'sz="4000"'))))).toEqual({
      tier: 'T1',
      reasons: [],
    });
    // T2: runs, bullets, superscripts, rtl and crops.
    expect(tierFor(textBox(2, para(run('1', 'baseline="30000"')) + para(run('In the beginning'))))).toEqual({
      tier: 'T2',
      reasons: ['mixedRuns', 'superSub'],
    });
    // T3: groups, alternate content, presets, custom geometry, connectors, gradients.
    expect(tierFor(grpSp({ id: 2, x: 0, y: 0, cx: IN, cy: IN }, box(3)) + connector(4))).toEqual({
      tier: 'T3',
      reasons: ['connector', 'group', 'preset:other'], // straightConnector1 is not a basic preset
    });
    // T4: video, glow, lum.
    expect(
      tierFor(video(2) + box(3, 2, 0, '<a:effectLst><a:glow rad="63500"/></a:effectLst>'), {
        rels: [imageRel('rId2', 'image1.png')],
      }),
    ).toEqual({ tier: 'T4', reasons: ['glow', 'video'] });
    // T5: vertical text, reflection, soft edges, inner shadows, tiles, recolouring.
    expect(tierFor(box(2, 0, 0, '<a:effectLst><a:softEdge rad="63500"/></a:effectLst>'))).toEqual({
      tier: 'T5',
      reasons: ['softEdge'],
    });
    // Fallback: tables, charts, SmartArt, OLE, 3D, warps, maths, ink, metafiles, TIFF and HD Photo.
    expect(tierFor(frame(2, CHART) + box(3))).toEqual({ tier: 'fallback', reasons: ['chart'] });
  });
});

// ── Census features ─────────────────────────────────────────────────────────────────────────────────────

describe('slideFeatures (the census features)', () => {
  /** The tier reasons of a one-slide deck's shape tree. */
  const why = (shapes: string, more: Partial<SlideSpec> = {}) => tierFor(shapes, more).reasons;

  it('reads element features anywhere in the shape tree', () => {
    const fx = (inner: string) => box(2, 0, 0, `<a:effectLst>${inner}</a:effectLst>`);
    expect(why(frame(2, TABLE, '<a:tbl><a:tblPr/><a:tblGrid/></a:tbl>'))).toEqual(['table']);
    expect(why(frame(2, DIAGRAM))).toEqual(['smartart']);
    expect(why(frame(2, OLE, '<p:oleObj r:id="rId9"/>'))).toEqual(['ole']);
    expect(why(alternate(box(2), box(2)))).toEqual(['altcontent']);
    expect(why(sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, geom: 'none', fill: '<a:custGeom/>' }))).toEqual([
      'custGeom',
    ]);
    expect(why(sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: '<a:gradFill/>' }))).toEqual(['gradFill']);
    expect(why(sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: '<a:pattFill/>' }))).toEqual(['pattFill']);
    expect(why(box(2, 0, 0, '<a:scene3d/>'))).toEqual(['3d']);
    expect(why(box(2, 0, 0, '<a:sp3d/>'))).toEqual(['3d']);
    expect(why(fx('<a:reflection/>'))).toEqual(['reflection']);
    expect(why(fx('<a:innerShdw/>'))).toEqual(['innerShdw']);
    expect(why(textBox(2, para(run('x', '', '<a:effectLst><a:glow/></a:effectLst>'))))).toEqual(['glow']);
    expect(why(textBox(2, para(run('x')), '', 0, 0) + textBox(3, para(run('y')), 'vert="horz"'))).toEqual([]);
    const rels = { rels: [imageRel('rId2', 'image1.png')] };
    const picWith = (blip: string) => pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2', blip });
    expect(why(picWith('<a:grayscl/>'), rels)).toEqual(['recolor']);
    expect(why(picWith('<a:duotone/>'), rels)).toEqual(['recolor']);
    expect(why(picWith('<a:lum bright="20000"/>'), rels)).toEqual(['lum']);
    expect(why(picWith(''), rels)).toEqual([]);
    expect(
      why(
        pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2' }).replace(
          /<a:stretch>.*<\/a:stretch>/,
          '<a:tile/>',
        ),
        rels,
      ),
    ).toEqual(['tile']);
    expect(
      why(textBox(2, para(run('a'), '').replace('<a:p>', '<a:p><a:pPr><a:buChar char="•"/></a:pPr>'))),
    ).toEqual(['bullet']);
    expect(
      why(
        textBox(2, para(run('a')).replace('<a:p>', '<a:p><a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>')),
      ),
    ).toEqual(['bullet']);
    expect(why(textBox(2, para('<a14:m><m:oMathPara/></a14:m>')))).toEqual(['math']);
    expect(why(textBox(2, para('<m:oMathPara/>')))).toEqual(['math']);
    expect(why('<p:contentPart r:id="rId5"/>')).toEqual(['ink']);
  });

  it('reads the attribute features: vert, warp, rtl, baseline and presets', () => {
    expect(why(textBox(2, para(run('Text')), 'vert="vert270"'))).toEqual(['vert']);
    expect(why(textBox(2, para(run('Text')), 'vert="eaVert"'))).toEqual(['vert']);
    expect(why(textBoxWith(2, '<a:prstTxWarp prst="textArchUp"><a:avLst/></a:prstTxWarp>'))).toEqual([
      'warp',
    ]);
    expect(why(textBoxWith(2, '<a:prstTxWarp prst="textNoShape"><a:avLst/></a:prstTxWarp>'))).toEqual([]);
    expect(why(textBox(2, para(run('שלום'), 'rtl="1"')))).toEqual(['rtl']);
    expect(why(textBox(2, para(run('Hello'), 'rtl="0"')))).toEqual([]);
    expect(why(textBox(2, para(run('2', 'baseline="30000"'))))).toEqual(['superSub']);
    expect(why(textBox(2, para(run('2', 'baseline="-25000"'))))).toEqual(['superSub']);
    expect(why(textBox(2, para(run('2', 'baseline="0"'))))).toEqual([]);
    for (const geom of ['rect', 'roundRect', 'ellipse', 'line'])
      expect(why(sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, geom, fill: solid('FF0000') }))).toEqual([]);
    expect(why(sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, geom: 'star5', fill: solid('FF0000') }))).toEqual([
      'preset:other',
    ]);
    expect(why(frame(2, `${CHART}`))).toEqual(['chart']);
  });

  it('finds mixed runs: explicit run properties that differ beyond the neutral attributes', () => {
    const two = (a: string, b: string) => why(textBox(2, para(run('One ', a) + run('two', b))));
    expect(two('sz="4000"', 'sz="4000"')).toEqual([]);
    expect(two('sz="4000"', 'sz="3200"')).toEqual(['mixedRuns']);
    expect(two('b="1"', '')).toEqual(['mixedRuns']);
    expect(
      two(
        'sz="4000" dirty="0"',
        'sz="4000" altLang="he-IL" err="1" noProof="1" smtClean="0" kern="1200" bmk="x"',
      ),
    ).toEqual([]);
    // Attribute order does not matter; children do.
    expect(two('sz="4000" b="1"', 'b="1" sz="4000"')).toEqual([]);
    expect(why(textBox(2, para(run('One ', '', solid('FF0000')) + run('two', '', solid('00FF00')))))).toEqual(
      ['mixedRuns'],
    );
    // A run without properties is the same as one with neutral attributes only.
    expect(why(textBox(2, para('<a:r><a:t>One </a:t></a:r>' + run('two', 'dirty="0"'))))).toEqual([]);
    // Runs without text draw nothing.
    expect(
      why(textBox(2, para(run('One', 'sz="4000"') + '<a:r><a:rPr lang="en-US" sz="9600"/><a:t/></a:r>'))),
    ).toEqual([]);
    // Runs are compared within one body, not across bodies.
    expect(
      why(textBox(2, para(run('One', 'sz="4000"'))) + textBox(3, para(run('Two', 'sz="2000"')), '', 0, 2)),
    ).toEqual([]);
  });

  it('reads picture formats through the slide relationships, and crops with a side set', () => {
    const one = (file: string, srcRect?: string) =>
      tierFor(pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2', srcRect }), {
        rels: [imageRel('rId2', file)],
      });
    expect(one('image1.png')).toEqual({ tier: 'T1', reasons: [] });
    expect(one('image1.bmp')).toEqual({ tier: 'T2', reasons: ['pic:bmp'] });
    for (const ext of ['emf', 'wmf', 'tif', 'tiff', 'wdp', 'hdp'])
      expect(one(`image1.${ext.toUpperCase()}`)).toEqual({ tier: 'fallback', reasons: [`pic:${ext}`] });
    expect(one('image1.png', 'l="10000" r="-5000"')).toEqual({ tier: 'T2', reasons: ['crop'] });
    expect(one('image1.png', 'l="0" t="0" r="0" b="0"')).toEqual({ tier: 'T1', reasons: [] });
    expect(one('image1.png', '')).toEqual({ tier: 'T1', reasons: [] });
  });

  it('notes shadows and outlines, which no tier blocks', () => {
    const shadowed = textBox(
      2,
      para(
        run(
          'Glory',
          '',
          `${solid('FFFFFF')}<a:effectLst><a:outerShdw blurRad="38100" dist="38100"/></a:effectLst>`,
        ),
      ),
    );
    const outlined = textBox(
      2,
      para(run('Glory', '', '<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>')),
    );
    expect(tierFor(shadowed + outlined.replace('id="2"', 'id="3"'))).toEqual({ tier: 'T1', reasons: [] });
  });

  it('adds the decorations the slide shows as deco: features, not their placeholders', () => {
    const decoGroup = grpSp({ id: 9, x: 0, y: 0, cx: IN, cy: IN }, box(10));
    const decoStar = sp({ id: 11, x: 0, y: 0, cx: IN, cy: IN, geom: 'star5', fill: solid('FF0000') });
    const layoutPh = sp({
      id: 12,
      ph: 'type="body" idx="1"',
      txBody: body(para(run('a', 'sz="1000"') + run('b'))),
    });
    const deck = (master: PartSpec, layout: PartSpec, slides: SlideSpec[]) =>
      parseDeck(buildDeck({ master, layouts: [layout], slides })).slides.map((s) => s.classification);
    const [shown, noMaster, hidden] = deck({ shapes: decoGroup }, { shapes: decoStar + layoutPh }, [
      {},
      { layout: 1 },
      { attrs: 'showMasterSp="0"' },
    ]);
    expect(shown).toEqual({ tier: 'T3', class: 'native', reasons: ['deco:group', 'deco:preset:other'] });
    expect(noMaster).toEqual(shown);
    expect(hidden).toEqual({ tier: 'T1', class: 'native', reasons: [] });
    // A layout with showMasterSp="0" hides the master's decorations, not its own.
    const [own] = deck({ shapes: decoGroup }, { shapes: decoStar, attrs: 'showMasterSp="0"' }, [{}]);
    expect(own!.reasons).toEqual(['deco:preset:other']);
    // Decorations are checked for the shape-tree features only (no mixed runs, crops or picture formats).
    const decoText = textBox(13, para(run('One', 'sz="1000"') + run('Two', 'sz="2000"')));
    const [plain] = deck({ shapes: decoText }, {}, [{}]);
    expect(plain!.tier).toBe('T1');
    // Shapes inside alternate content are decorations too; a placeholder anywhere in a shape is not.
    const [alt] = deck(
      { shapes: alternate(decoStar, decoStar) },
      { shapes: grpSp({ id: 20, x: 0, y: 0, cx: IN, cy: IN }, layoutPh) },
      [{}],
    );
    expect(alt!.reasons).toEqual(['deco:preset:other']);
  });
});

// ── Element support and slide class ─────────────────────────────────────────────────────────────────────

describe('element support (design/27 §5)', () => {
  const support = (shapes: string, more: Partial<SlideSpec> = {}) =>
    slideOf(shapes, more).elements.map((e) => [e.support, e.reasons ?? []]);

  it('keeps what can be drawn native and the reader’s own verdict', () => {
    expect(support(box(2) + textBox(3, para(run('Hello'))))).toEqual([
      ['native', []],
      ['native', []],
    ]);
    // M6: every preset of the table is drawn; one it does not know is drawn as its rect.
    expect(support(sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, geom: 'star5', fill: solid('FF0000') }))).toEqual([
      ['native', []],
    ]);
    expect(
      support(sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, geom: 'noSuchShape', fill: solid('FF0000') })),
    ).toEqual([['approx', ['preset:noSuchShape']]]);
  });

  it('makes charts, tables, SmartArt, OLE, maths, warps and vertical or column text residual', () => {
    expect(support(frame(2, CHART) + frame(3, TABLE) + frame(4, DIAGRAM) + frame(5, OLE))).toEqual([
      ['residual', ['chart']],
      ['residual', ['table']],
      ['residual', ['smartart']],
      ['residual', ['ole']],
    ]);
    expect(support(textBox(2, para(run('Text')), 'vert="vert270"'))).toEqual([['residual', ['vert']]]);
    expect(support(textBox(2, para(run('Text')), 'numCol="2"'))).toEqual([['residual', ['numCol']]]);
    expect(support(textBox(2, para(run('Text')), 'anchorCtr="1"'))).toEqual([['residual', ['anchorCtr']]]);
    // Centring the block of centred lines changes nothing (`text.ts`), so the XML attribute is not consulted.
    expect(support(textBox(2, para(run('Text'), 'algn="ctr"') + para(''), 'anchorCtr="1"'))).toEqual([
      ['native', []],
    ]);
    expect(support(textBoxWith(2, '<a:prstTxWarp prst="textWave1"><a:avLst/></a:prstTxWarp>'))).toEqual([
      ['residual', ['warp']],
    ]);
    expect(support(textBox(2, para(run('x') + '<a14:m><m:oMathPara/></a14:m>')))).toEqual([
      ['residual', ['math']],
    ]);
    // Vertical text matters only where there is text.
    expect(support(textBox(2, '<a:p/>', 'vert="vert"'))).toEqual([['native', []]]);
  });

  it('real 3-D is approx, never residual', () => {
    // M9 (`residual.ts`): drawn flat, as LibreOffice's art draws most of it; `3d:camera` when the camera
    // turns the face.
    expect(support(box(2, 0, 0, '<a:sp3d><a:bevelT w="38100" h="38100"/></a:sp3d>'))).toEqual([
      ['approx', ['3d']],
    ]);
    expect(support(box(2, 0, 0, '<a:sp3d extrusionH="76200"/>'))).toEqual([['approx', ['3d']]]);
    const turned = (camera: string) =>
      support(
        box(
          2,
          0,
          0,
          `<a:scene3d>${camera}<a:lightRig rig="threePt" dir="t"/></a:scene3d><a:sp3d extrusionH="76200"/>`,
        ),
      );
    expect(turned('<a:camera prst="perspectiveRelaxedModerately"/>')).toEqual([['approx', ['3d:camera']]]);
    expect(
      turned('<a:camera prst="orthographicFront"><a:rot lat="1200000" lon="0" rev="0"/></a:camera>'),
    ).toEqual([['approx', ['3d:camera']]]);
    // A front camera, turned in the plane only, is the face seen straight on.
    expect(
      turned('<a:camera prst="orthographicFront"><a:rot lat="0" lon="0" rev="5400000"/></a:camera>'),
    ).toEqual([['approx', ['3d']]]);
    expect(turned('<a:camera prst="perspectiveFront"/>')).toEqual([['approx', ['3d']]]);
    // Text 3-D (in the body) and a picture's 3-D are approx too.
    expect(
      support(
        textBoxWith(
          2,
          '<a:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d><a:sp3d><a:bevelT/></a:sp3d>',
        ),
      ),
    ).toEqual([['approx', ['3d']]]);
    // A no-op scene3d/sp3d, or a flat bevel, is ignored.
    expect(
      support(box(2, 0, 0, '<a:scene3d><a:camera prst="orthographicFront"/></a:scene3d><a:sp3d/>')),
    ).toEqual([['native', []]]);
    expect(support(box(2, 0, 0, '<a:sp3d><a:bevelT w="0" h="0"/></a:sp3d>'))).toEqual([['native', []]]);
    // The slide stays native, with one note; the census feature (and so the tier) is unchanged.
    const s = slideOf(
      box(2, 0, 0, '<a:sp3d><a:bevelT/></a:sp3d>') + box(3, 2, 0, '<a:sp3d extrusionH="1"/>'),
    );
    expect(s.classification).toEqual({ tier: 'fallback', class: 'native', reasons: ['3d'] });
    expect(s.notes.filter((n) => n.startsWith('3-D is drawn flat'))).toHaveLength(1);
    expect(s.classification.art).toBeUndefined();
  });

  it('real 3-D on a slide past the object budget stays out of decorations, drawn flat (M9)', () => {
    let shapes = '';
    for (let i = 0; i < MAX_SLIDE_OBJECTS + 10; i++)
      shapes += box(
        i + 2,
        (i % 12) * 0.5,
        Math.floor(i / 12) * 0.5,
        i < 20 ? '<a:sp3d><a:bevelT/></a:sp3d>' : '',
      );
    const s = slideOf(shapes);
    const three = s.elements.filter((e) => e.reasons?.includes('3d'));
    expect(three).toHaveLength(20);
    expect(three.every((e) => e.support === 'approx' && e.decor === undefined)).toBe(true);
    // The 140 flat shapes are drawn as decorations; the slide is native, nothing in any art.
    expect(s.elements.slice(20).every((e) => e.decor !== undefined)).toBe(true);
    expect(s.classification).toMatchObject({ class: 'native' });
    expect(s.classification.reasons.some((r) => r.startsWith('art:') || r.startsWith('budget:'))).toBe(false);
  });

  it('real 3-D on a slide past the object budget goes to the art first behind budgetArt (the A/B)', () => {
    // As every real 3-D did before M9, so the budget's other steps choose as they did (`budget:3d`).
    let shapes = '';
    for (let i = 0; i < MAX_SLIDE_OBJECTS + 10; i++)
      shapes += box(
        i + 2,
        (i % 12) * 0.5,
        Math.floor(i / 12) * 0.5,
        i < 20 ? '<a:sp3d><a:bevelT/></a:sp3d>' : '',
      );
    const s = slideOf(shapes, {}, {}, true);
    const three = s.elements.filter((e) => e.reasons?.includes('3d'));
    expect(three).toHaveLength(20);
    expect(three.every((e) => e.support === 'residual' && e.reasons!.includes('budget:3d'))).toBe(true);
    expect(s.classification.reasons).toContain('art:budget:3d');
    expect(s.classification.reasons).not.toContain('art:3d');
    expect(s.notes.some((n) => n.includes('3-D shape(s) on a slide past its object budget'))).toBe(true);
    // Version 1 draws them (flat), as it drew every residual shape.
    const out = emitSlides(parseDeck(buildDeck({ slides: [{ shapes }] }), { budgetArt: true })).slides[0]!;
    expect(out.slide.objects.length).toBeGreaterThan(MAX_SLIDE_OBJECTS);
  });

  it('a bevelled SmartArt drawing is native', () => {
    // A 3-D quick style writes real bevels into the drawing cache's shapes (`smartart.md` §3.8); M6 sent such
    // a drawing to the art whole. Since M9 its shapes are approx, drawn flat, and the drawing is native.
    const bevel = '<a:sp3d><a:bevelT w="63500" h="25400"/></a:sp3d>';
    const drawing = drawingXml(
      dspSp({ x: 0, y: 0, cx: 2 * IN, cy: 2 * IN, extra: bevel }) +
        dspSp({ x: 3 * IN, y: 0, cx: 2 * IN, cy: 2 * IN, extra: bevel, paras: para(run('Hope')) }),
    );
    const parts = buildDeck({
      slides: [
        {
          rels: smartArtRels(1),
          shapes: smartArtFrame({ id: 7, x: IN, y: IN, cx: 8 * IN, cy: 4 * IN, dmId: 'rIdDm1' }),
        },
      ],
    });
    withSmartArt(parts, 1, drawing);
    const scene = parseDeck(parts);
    const s = scene.slides[0]!;
    expect(s.elements.length).toBe(2);
    expect(s.elements.every((e) => e.diagram === 1 && e.support === 'approx')).toBe(true);
    expect(s.elements.filter((e) => e.reasons?.includes('3d'))).toHaveLength(2);
    expect(s.classification.class).toBe('native');
    expect(s.classification.art).toBeUndefined();
    const out = emitSlides(scene).slides[0]!;
    expect(out.art).toBeUndefined();
    expect(out.slide.objects.filter((o) => o.origin?.role === 'diagram')).toHaveLength(3);
  });

  it('inherits vertical text from the layout placeholder', () => {
    const layoutPh = sp({
      id: 3,
      ph: 'type="body" idx="1"',
      x: 0,
      y: 0,
      cx: IN,
      cy: IN,
      txBody: body('<a:p/>', 'vert="eaVert"'),
    });
    const scene = parseDeck(
      buildDeck({
        layouts: [{ shapes: layoutPh }],
        slides: [{ shapes: sp({ id: 2, ph: 'type="body" idx="1"', txBody: body(para(run('縦書き'))) }) }],
      }),
    );
    expect(scene.slides[0]!.elements.map((e) => e.support)).toEqual(['residual']);
  });

  it('approximates reflections, inner shadows, soft edges on pictures and metafiles', () => {
    const rels = {
      rels: [imageRel('rId2', 'image1.png'), imageRel('rId3', 'image2.emf'), imageRel('rId4', 'image3.wdp')],
    };
    const picture = (id: number, rId: string, effects = '') =>
      pic({ id, x: 0, y: 0, cx: IN, cy: IN, rId }).replace('</p:spPr>', `${effects}</p:spPr>`);
    expect(
      support(
        picture(2, 'rId2', '<a:effectLst><a:softEdge rad="63500"/></a:effectLst>') +
          box(3, 0, 0, '<a:effectLst><a:softEdge rad="63500"/></a:effectLst>') +
          box(4, 0, 0, '<a:effectLst><a:reflection/></a:effectLst>') +
          box(5, 0, 0, '<a:effectLst><a:innerShdw/></a:effectLst>') +
          picture(6, 'rId3') +
          picture(7, 'rId4'),
        rels,
      ),
    ).toEqual([
      ['approx', ['softEdge']],
      ['native', []],
      ['approx', ['reflection']],
      ['approx', ['innerShdw']],
      ['approx', ['metafile']],
      ['residual', ['pic:wdp']],
    ]);
  });

  it('stays linear when a damaged deck gives thousands of shapes one id', () => {
    const one = sp({
      id: 7,
      x: 0,
      y: 0,
      cx: IN,
      cy: IN,
      txBody: body(para(run('a', 'sz="1000"') + run('b'))),
    });
    const t0 = performance.now();
    const s = slideOf(one.repeat(4_999));
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
    // M9: never a picture for a budget: the guard keeps 200 objects and lists what it left out.
    expect(s.classification).toMatchObject({ tier: 'T2', class: 'hybrid', missing: ['element'] });
    expect(s.elements.filter((e) => !e.hidden)).toHaveLength(199);
  });

  it('rates an element of alternate content by the branch Package.xml keeps', () => {
    const math = textBox(2, para(run('x') + '<a14:m><m:oMathPara/></a14:m>'));
    const plain = textBox(2, para(run('x = 1')));
    expect(support(alternate(math, plain))).toEqual([['residual', ['math']]]);
  });
});

describe('bounded work on hostile decks', () => {
  /** A shape with `n` extension elements, all of one `cNvPr id`. */
  const huge = (id: number, n: number) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name=""/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:extLst>` +
    '<a:ext uri="x"/>'.repeat(n) +
    '</a:extLst></p:spPr></p:sp>';
  const frame = (id: number) =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name=""/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></p:xfrm><a:graphic><a:graphicData uri="x"/></a:graphic></p:graphicFrame>`;
  const frames = Array.from({ length: 2_000 }, () => frame(7)).join('');

  it('rates thousands of elements sharing an id with a huge shape once per node, not once per element', () => {
    const t0 = performance.now();
    const deck = parseDeck(buildDeck({ slides: [{ shapes: huge(7, 100_000) + frames }] }));
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
    expect(deck.slides[0]!.error).toBeUndefined();
    expect(deck.slides[0]!.elements).toHaveLength(2_000);
  });

  it('rates layout decorations sharing an id with a huge layout shape once per deck, not once per slide', () => {
    const t0 = performance.now();
    const deck = parseDeck(
      buildDeck({
        layouts: [{ shapes: huge(7, 100_000) + frames }],
        slides: Array.from({ length: 20 }, () => ({})),
      }),
    );
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
    expect(deck.slides.every((s) => s.elements.length === 2_000)).toBe(true);
    expect(deck.slides[19]!.elements[0]).toMatchObject({ support: 'residual', reasons: ['graphicFrame'] });
  });
});

describe('slide class and art range', () => {
  it('is native without residual elements, hybrid with them', () => {
    expect(slideOf(box(2)).classification.class).toBe('native');
    const s = slideOf(box(2, 0, 0) + frame(3, CHART, '', 1, 1) + box(4, 2, 2) + box(5, 6, 4) + box(6, 1, 1));
    expect(s.classification).toMatchObject({
      tier: 'fallback',
      class: 'hybrid',
      reasons: ['chart', 'art:chart'],
    });
    // The chart (index 1) is the whole range: the boxes below and above it stay native.
    expect(s.classification.art).toEqual({
      from: 1,
      to: 1,
      elements: [1],
      box: { x: IN, y: IN, cx: 2 * IN, cy: 2 * IN },
    });
  });

  it('bakes into the art the elements of the range that an art element above overlaps', () => {
    const s = slideOf(
      box(2, 0, 0) + // below the range: native
        frame(3, CHART, '', 0, 0) + // Rmin
        box(4, 1, 1) + // overlapped by the table above: art
        box(5, 6, 4) + // in the range, overlapped by nothing above: native
        box(6, 3.5, 3.5) + // overlaps the table's corner region only below it: native
        frame(7, TABLE, '<a:tbl/>', 1.5, 1.5) + // Rmax
        box(8, 1.5, 1.5), // above the range: native
    );
    expect(s.classification.class).toBe('hybrid');
    expect(s.classification.reasons).toEqual(['chart', 'table', 'art:chart', 'art:table']);
    expect(s.classification.art).toEqual({
      from: 1,
      to: 5,
      elements: [1, 2, 5],
      box: { x: 0, y: 0, cx: 3.5 * IN, cy: 3.5 * IN },
    });
  });

  it('names only what made the slide hybrid; approximations alone keep it native', () => {
    const vertical = textBox(2, para(run('Text')), 'vert="vert270"').replace(
      '</p:spPr>',
      '<a:effectLst><a:reflection/></a:effectLst></p:spPr>',
    );
    const s = slideOf(vertical);
    expect(s.elements[0]).toMatchObject({ support: 'residual', reasons: ['vert', 'reflection'] });
    expect(s.classification).toMatchObject({
      tier: 'T5',
      class: 'hybrid',
      reasons: ['reflection', 'vert', 'art:vert'],
    });
    expect(slideOf(box(2, 0, 0, '<a:effectLst><a:reflection/></a:effectLst>')).classification.class).toBe(
      'native',
    );
  });

  it('ignores hidden elements', () => {
    const hiddenChart = frame(3, CHART).replace('name="Frame 3"', 'name="Frame 3" hidden="1"');
    expect(slideOf(box(2) + hiddenChart).classification.class).toBe('native');
  });

  it('keeps a slide of text past the object budget native up to the text ceiling (M9)', () => {
    let shapes = '';
    for (let i = 0; i < MAX_SLIDE_OBJECTS; i++)
      shapes += textBox(i + 2, para(run('Text')), '', (i % 10) * 0.5, Math.floor(i / 10) * 0.3);
    // With the slide's background (one object) that is one past the budget: text is never merged, and up
    // to 190 objects of it stay (`MAX_SLIDE_OBJECTS_TEXT`).
    const s = slideOf(shapes);
    expect(s.classification).toEqual({ tier: 'T1', class: 'native', reasons: [] });
    expect(s.elements.every((e) => e.support === 'native' && !e.reasons && !e.hidden)).toBe(true);
  });

  it('becomes a picture when the objects left exceed the budget behind budgetArt (the A/B)', () => {
    let shapes = '';
    for (let i = 0; i < MAX_SLIDE_OBJECTS; i++)
      shapes += textBox(i + 2, para(run('Text')), '', (i % 10) * 0.5, Math.floor(i / 10) * 0.3);
    // With the slide's background (one object) that is one too many, and text never goes to the art.
    const s = slideOf(shapes, {}, {}, true);
    expect(s.classification).toEqual({ tier: 'T1', class: 'picture', reasons: ['budget:objects'] });
    expect(s.notes.some((n) => n.startsWith('over the slide budgets'))).toBe(true);
    expect(s.elements.every((e) => e.support === 'native' && !e.reasons)).toBe(true);
  });
});

describe('the object budget behind budgetArt: shapes of one look merged, then shapes to the art (M6, the A/B)', () => {
  const FRAME = frameOf(12_192_000, 6_858_000);
  /** `n` squares 0.1 in wide in rows of 20 from (x, y) inches, of `colors` in turn, ids from `first`. */
  const squares = (n: number, first: number, colors = ['336699'], x = 0, y = 0) => {
    let out = '';
    for (let i = 0; i < n; i++)
      out += sp({
        id: first + i,
        x: (x + (i % 20) * 0.1) * IN,
        y: (y + Math.floor(i / 20) * 0.1) * IN,
        cx: 0.1 * IN,
        cy: 0.1 * IN,
        fill: solid(colors[i % colors.length]!),
      });
    return out;
  };
  const group = (id: number, inner: string) => grpSp({ id, x: 0, y: 0, cx: 4 * IN, cy: 4 * IN }, inner);
  const TWO = ['336699', '993366'];

  it('draws z-adjacent shapes of one look in a group as one object per eight paths, over the budget only', () => {
    const scene = parseDeck(buildDeck({ slides: [{ shapes: group(2, squares(160, 10)) }] }));
    const s = scene.slides[0]!;
    // 160 squares and the background: one past the budget apart, 20 objects and the background merged.
    expect(slideCost(s.elements, s.background, undefined).objects).toBe(161);
    expect(slideCost(s.elements, s.background, undefined, scene.frame).objects).toBe(21);
    expect(s.classification).toMatchObject({ class: 'native' });
    expect(s.classification.reasons.filter((r) => r.startsWith('budget:') || r.startsWith('art:'))).toEqual(
      [],
    );
    expect(s.elements.map((e) => (e as ShapeElement).merge)).toEqual(
      s.elements.map((_, i) => Math.floor(i / 8) * 8),
    );
    expect(s.notes).toContain("160 shapes of one look are drawn as 20 objects (the slide's object budget)");
    // Within the budget nothing is merged.
    const small = slideOf(group(2, squares(100, 10)));
    expect(small.elements.some((e) => (e as ShapeElement).merge !== undefined)).toBe(false);
  });

  it('keeps apart what would not draw as it does apart', () => {
    const at = (x: number): Affine => [IN / 10, 0, 0, IN / 10, x * IN, 0];
    const sq = (x: number, extra: Partial<ShapeElement> = {}): Element =>
      ({
        kind: 'shape',
        shapeId: 1,
        name: '',
        xf: at(x),
        from: 'slide',
        group: 1,
        support: 'native',
        geom: 'rect',
        fill: { kind: 'solid', color: { r: 0, g: 0, b: 255, a: 1 } },
        ...extra,
      }) as Element;
    const runs = (list: Element[], inArt?: Set<number>) => shapeRuns(list, FRAME, inArt);
    const red = { kind: 'solid' as const, color: { r: 255, g: 0, b: 0, a: 1 } };
    const line = { width: 12_700, fill: red };
    expect(runs([sq(0), sq(1), sq(2)])).toEqual([[0, 1, 2]]);
    // Another look, a translucent fill, an effect, text, another group: the run ends.
    expect(runs([sq(0), sq(1), sq(2, { fill: red }), sq(3), sq(4)])).toEqual([
      [0, 1],
      [3, 4],
    ]);
    const blue50 = { kind: 'solid' as const, color: { r: 0, g: 0, b: 255, a: 0.5 } };
    expect(runs([sq(0, { fill: blue50 }), sq(1, { fill: blue50 })])).toEqual([]);
    const shadow = { dist: 0, blur: 0, dir: 0, color: { r: 0, g: 0, b: 0, a: 1 } };
    expect(runs([sq(0), sq(1, { shadow }), sq(2)])).toEqual([]);
    expect(runs([sq(0), sq(1, { glow: { radius: 1, color: red.color } }), sq(2, { softEdge: 1 })])).toEqual(
      [],
    );
    expect(runs([sq(0), sq(1, { text: { paras: [] } as never }), sq(2)])).toEqual([]);
    expect(runs([sq(0), sq(1), sq(2, { group: 2 }), sq(3, { group: 2 })])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    // The slide's own shapes outside a group stay apart; a layout's or master's decorations merge.
    expect(runs([sq(0, { group: undefined }), sq(1, { group: undefined })])).toEqual([]);
    expect(
      runs([sq(0, { group: undefined, from: 'layout' }), sq(1, { group: undefined, from: 'layout' })]),
    ).toEqual([[0, 1]]);
    // A hidden shape draws nothing; one in the art, a residual or an approximated one ends the run.
    expect(runs([sq(0), sq(1, { hidden: true }), sq(2)])).toEqual([[0, 2]]);
    expect(runs([sq(0), sq(1), sq(2), sq(3)], new Set([2]))).toEqual([[0, 1]]);
    expect(runs([sq(0), sq(1, { support: 'approx' }), sq(2), sq(3)])).toEqual([[2, 3]]);
    // Lines and connectors are drawn as lines; an unknown preset as its rect.
    expect(runs([sq(0, { geom: 'line' }), sq(1, { geom: 'line' })])).toEqual([]);
    expect(runs([sq(0, { geom: 'nonsense' }), sq(1, { geom: 'nonsense' })])).toEqual([]);
    // Eight paths at most: nine squares are a run of eight and one alone.
    expect(runs(Array.from({ length: 10 }, (_, i) => sq(i)))).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7],
      [8, 9],
    ]);
    // A line of the same look merges; an arrowhead, a translucent line or no paint at all does not.
    expect(runs([sq(0, { line }), sq(1, { line })])).toEqual([[0, 1]]);
    expect(
      runs([sq(0, { line: { ...line, tail: 'triangle' } }), sq(1, { line: { ...line, tail: 'triangle' } })]),
    ).toEqual([]);
    const clear = { ...line, fill: blue50 };
    expect(runs([sq(0, { line: clear }), sq(1, { line: clear })])).toEqual([]);
    expect(runs([sq(0, { fill: { kind: 'none' } }), sq(1, { fill: { kind: 'none' } })])).toEqual([]);
    // An open outline is stroked after every path of a geometry: with a fill it would move above the next
    // shape's fill, so only a fill or a line alone merges.
    const open = {
      paths: [{ d: 'M 0 0 L 100 100 L 0 100', w: 100, h: 100 }],
      points: 3,
      text: [0, 0, 1, 1] as [number, number, number, number],
      sites: [],
      notes: [],
    };
    const custom = (x: number, extra: Partial<ShapeElement> = {}) =>
      sq(x, { geom: 'custom', custom: open, ...extra });
    expect(runs([custom(0, { line }), custom(1, { line })])).toEqual([]);
    expect(runs([custom(0), custom(1)])).toEqual([[0, 1]]);
    expect(
      runs([custom(0, { line, fill: { kind: 'none' } }), custom(1, { line, fill: { kind: 'none' } })]),
    ).toEqual([[0, 1]]);
    const closed = { ...open, paths: [{ d: 'M 0 0 L 100 100 L 0 100 Z', w: 100, h: 100 }] };
    expect(runs([custom(0, { line, custom: closed }), custom(1, { line, custom: closed })])).toEqual([
      [0, 1],
    ]);
    // Custom geometry past the bounds is never merged, nor a shape past the render clamp's bounds.
    expect(
      runs([custom(0, { custom: { ...open, over: true } }), custom(1, { custom: { ...open, over: true } })]),
    ).toEqual([]);
    expect(runs([sq(0), sq(1e4)])).toEqual([]);
  });

  it('ends a run before its path strings would pass 40,000 characters', () => {
    // Paths of 1,500 points each: about 30 characters a point once written in a slide-wide box.
    let d = 'M 0 0';
    for (let i = 1; i < 1_500; i++) d += ` L ${(i * 7919) % 10_000} ${(i * 104_729) % 10_000}`;
    const custom = {
      paths: [{ d, w: 10_000, h: 10_000 }],
      points: 1_500,
      text: [0, 0, 1, 1] as [number, number, number, number],
      sites: [],
      notes: [],
    };
    const piece = (x: number): Element =>
      ({
        kind: 'shape',
        shapeId: 1,
        name: '',
        xf: [IN, 0, 0, IN, x * IN, 0],
        from: 'master',
        support: 'native',
        geom: 'custom',
        custom,
        fill: { kind: 'solid', color: { r: 0, g: 0, b: 255, a: 1 } },
      }) as Element;
    // Side by side the box stays small; one far away makes every coordinate long.
    expect(shapeRuns([piece(0), piece(0.5)], FRAME)).toEqual([[0, 1]]);
    expect(shapeRuns([piece(0), piece(-30)], FRAME)).toEqual([]);
  });

  it('sends the fewest layout decorations without text to the art first, from the bottom', () => {
    const s = slideOf(
      textBox(2, para(run('Words'))),
      {},
      { layouts: [{ shapes: squares(160, 10, TWO) }] },
      true,
    );
    // 160 decorations of two looks in turn (none merge), the text and the background: 162 objects. With
    // the art (one object) the bottom 13 go: 1 + 1 + 147 + 1 = 150.
    expect(s.classification.class).toBe('hybrid');
    expect(s.classification.reasons).toContain('art:budget:shapes');
    expect(s.classification.art?.elements).toEqual(Array.from({ length: 13 }, (_, i) => i));
    expect(s.elements[12]).toMatchObject({ support: 'residual', reasons: ['budget:shapes'] });
    expect(s.elements[13]!.support).toBe('native');
    expect(s.elements[160]).toMatchObject({ kind: 'shape', support: 'native' });
    expect(s.notes).toContain(
      "13 shapes and pictures pass the slide's object budget: LibreOffice draws them",
    );
  });

  it('then the costliest run of elements without text, a top-level group first', () => {
    const s = slideOf(
      group(2, squares(30, 10, TWO)) + // 0-29
        textBox(3, para(run('Words')), '', 0, 5) + // 30
        squares(40, 100, TWO, 0, 1) + // 31-70: ungrouped, costlier than the first group
        grpSp({ id: 4, x: 5 * IN, y: 0, cx: 4 * IN, cy: 4 * IN }, squares(90, 200, TWO, 5)), // 71-160
      {},
      {},
      true,
    );
    expect(s.classification.class).toBe('hybrid');
    expect(s.classification.art?.elements).toEqual(Array.from({ length: 90 }, (_, i) => 71 + i));
    expect(s.elements.slice(0, 71).every((e) => e.support === 'native')).toBe(true);
    // With the costliest group too small, the ungrouped run goes as well.
    const t = slideOf(
      group(2, squares(10, 10, TWO)) + // 0-9
        textBox(3, para(run('Words')), '', 0, 5) + // 10
        squares(150, 100, TWO, 0, 1), // 11-160
      {},
      {},
      true,
    );
    expect(t.classification.class).toBe('hybrid');
    expect(t.classification.art?.elements).toEqual(
      Array.from({ length: 161 }, (_, i) => i).filter((i) => i !== 10),
    );
    expect(t.elements[10]!.support).toBe('native');
  });

  it('marks nothing when even every element without text in the art leaves the slide over the budget', () => {
    let texts = '';
    for (let i = 0; i < MAX_SLIDE_OBJECTS; i++) texts += textBox(1000 + i, para(run('Text')), '', 0, 0);
    const s = slideOf(group(2, squares(20, 10, TWO)) + texts, {}, {}, true);
    expect(s.classification.class).toBe('picture');
    expect(s.classification.reasons).toContain('budget:objects');
    expect(s.elements.some((e) => e.reasons?.includes('budget:shapes'))).toBe(false);
  });
});

describe('art range helpers', () => {
  const at = (x: number, y: number, w = 1, h = 1): Affine => [w, 0, 0, h, x, y];
  const el = (xf: Affine, extra: Partial<Element> = {}): Element =>
    ({
      kind: 'shape',
      shapeId: 1,
      name: '',
      xf,
      from: 'slide',
      support: 'native',
      geom: 'rect',
      fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } },
      ...extra,
    }) as Element;
  const residual = (xf: Affine): Element =>
    ({
      kind: 'residual',
      what: 'chart',
      shapeId: 1,
      name: '',
      xf,
      from: 'slide',
      support: 'residual',
    }) as Element;

  it('bounds rotated elements and tests overlap with area (lines touch)', () => {
    const r = Math.SQRT1_2;
    expect(boundsOf(el([r, r, -r, r, 0, 0]))).toMatchObject({ cx: expect.closeTo(Math.SQRT2, 9) });
    expect(overlaps({ x: 0, y: 0, cx: 1, cy: 1 }, { x: 1, y: 0, cx: 1, cy: 1 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, cx: 1, cy: 1 }, { x: 0.5, y: 0.5, cx: 1, cy: 1 })).toBe(true);
    expect(overlaps({ x: 0, y: 0.5, cx: 2, cy: 0 }, { x: 0.5, y: 0, cx: 1, cy: 1 })).toBe(true);
    expect(overlaps({ x: 0, y: 2, cx: 2, cy: 0 }, { x: 0.5, y: 0, cx: 1, cy: 1 })).toBe(false);
  });

  it('never bakes a play video, and decides overlap from the top down', () => {
    const video = el(at(0, 0, 4, 4), {
      kind: 'picture',
      picture: { part: 'ppt/media/poster.png' },
      media: { kind: 'video' },
    } as Partial<Element>);
    const elements = [
      residual(at(0, 0, 2, 2)), // 0: Rmin
      el(at(5, 5)), // 1: overlapped only by 2, which is art → art
      el(at(4.5, 4.5, 1, 1)), // 2: overlaps 3 (art) → art
      residual(at(3, 3, 2, 2)), // 3
      video, // 4: overlapped by 5, but a video
      residual(at(1, 1)), // 5: Rmax
    ];
    expect(artRange(elements)).toEqual({
      from: 0,
      to: 5,
      elements: [0, 1, 2, 3, 5],
      box: { x: 0, y: 0, cx: 6, cy: 6 },
    });
    expect(artRange([el(at(0, 0))])).toBeUndefined();
  });

  it('counts the objects and pictures left after the split', () => {
    const elements = [
      el(at(0, 0)),
      el(at(0, 0), { text: { paras: [] } } as Partial<Element>),
      el(at(0, 0), { kind: 'picture', picture: { part: 'a.png' } } as Partial<Element>),
      el(at(0, 0), { kind: 'picture', picture: { part: 'a.png' } } as Partial<Element>),
      residual(at(0, 0)),
    ];
    const art = artRange(elements);
    expect(art?.elements).toEqual([4]);
    expect(
      slideCost(elements, { fill: { kind: 'picture', picture: { part: 'bg.jpg' } }, from: 'slide' }, art),
    ).toEqual({
      objects: 1 + 1 + 2 + 1 + 1 + 1, // art, background, shape, shape + text, two pictures
      pictures: 3, // a.png, bg.jpg, the art
    });
  });
});
