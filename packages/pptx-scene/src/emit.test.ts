import { type ImageObject, type ShapeObject, Slide, type SlideObject, type TextObject } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  cutToClamp,
  type EmitOptions,
  insetBox,
  legacyColor,
  MAX_SLIDE_BYTES,
  SLIDE_BUDGET_NOTE,
  marginOf,
  overWhite,
  placePicture,
} from './emit.ts';
import { legacyGeometry, storedGeometry } from '@ordo/renderer/geom/stored.ts';
import { emitSlides, parseDeck } from './index.ts';
import type { DeckScene, ShapeElement } from './ir.ts';
import {
  body,
  br,
  buildDeck,
  type DeckSpec,
  grpSp,
  imageRel,
  para,
  pic,
  pictureBg,
  pngHeader,
  run,
  scheme,
  solid,
  solidBg,
  sp,
  inlineGeoms,
} from './test-util.ts';

const IN = 914_400;
const PT = 12_700;
/** Logical px per inch on a standard 16:9 or 4:3 slide (2 px per point). */
const PX = 144;
const RED = { r: 255, g: 0, b: 0, a: 1 };

/** Emit the first slide of a deck; every emitted slide must be an ordinary ordo slide. */
function emitOne(spec: DeckSpec, opts: EmitOptions = {}) {
  const scene = parseDeck(buildDeck(spec));
  const stored = emitSlides(scene, opts);
  for (const s of stored.slides) expect(Slide.parse(s.slide)).toEqual(s.slide);
  // The paths as drawn: a geometry file's in place of its ref.
  const out = inlineGeoms(stored);
  const e = out.slides[0]!;
  return { scene, out, slide: e.slide, notes: e.notes, objects: e.slide.objects };
}

/** The objects after the background rect. */
const content = (objects: SlideObject[]) => objects.slice(1);
const textIn = (objects: SlideObject[]) => objects.filter((o): o is TextObject => o.type === 'text');
const close = (a: number, b: number, d = 0.01) => Math.abs(a - b) <= d;
/** M1's text in today's fields only (`EmitOptions.richText: false`). */
const LEGACY: EmitOptions = { richText: false };

describe('text', () => {
  const tb = (txBody: string, extra: Partial<Parameters<typeof sp>[0]> = {}) =>
    sp({ id: 2, x: IN, y: IN, cx: 4 * IN, cy: 2 * IN, txBody, ...extra });

  it('writes the dominant run style: most characters across runs of the same look', () => {
    const { objects } = emitOne({
      slides: [
        {
          shapes: tb(
            body(
              para(
                run('Verse ', 'sz="1200" b="1"') +
                  run('Amazing ', 'sz="3200"', solid('FF0000')) +
                  run('grace how sweet', 'sz="3200"', solid('FF0000')),
              ) + para(run('1', 'sz="1200" b="1"')),
            ),
          ),
        },
      ],
    });
    const [t] = textIn(objects);
    expect(t!.text).toBe('Verse Amazing grace how sweet\n1');
    expect(t!.style).toMatchObject({
      fontSizePx: 64,
      fontWeight: 400,
      color: RED,
      fontFamily: 'Calibri',
      transform: 'none',
    });
  });

  it('turns tabs into spaces, breaks into new lines, and skips whitespace-only bodies', () => {
    const { objects } = emitOne({
      slides: [
        {
          shapes:
            tb(body(para(run('a\tb') + br + run('c')))) +
            tb(body(para(run('   '))), { id: 3, fill: solid('00FF00') }),
        },
      ],
    });
    const texts = textIn(objects);
    expect(texts.map((t) => t.text)).toEqual(['a b\nc']);
    expect(content(objects).map((o) => o.type)).toEqual(['text', 'shape']);
  });

  it('legacy: pads with the smallest inset and folds the others into the box', () => {
    // Default insets: 0.1 in left/right (14.4 px), 0.05 in top/bottom (7.2 px).
    const { objects } = emitOne({ slides: [{ shapes: tb(body(para(run('x')))) }] }, LEGACY);
    const [t] = textIn(objects);
    expect(t!.style.padding).toBeCloseTo(7.2);
    expect(t!.box.x).toBeCloseTo(PX + 7.2);
    expect(t!.box.w).toBeCloseTo(4 * PX - 14.4);
    expect(t!.box.y).toBeCloseTo(PX);
    expect(t!.box.h).toBeCloseTo(2 * PX);
  });

  it('uses the text rectangles of ellipse and roundRect', () => {
    const ins = 'lIns="0" tIns="0" rIns="0" bIns="0"';
    const { objects } = emitOne({
      slides: [
        {
          shapes:
            tb(body(para(run('e')), ins), { geom: 'ellipse', fill: solid('FF0000') }) +
            tb(body(para(run('r')), ins), { id: 3, geom: 'roundRect', fill: solid('FF0000') }),
        },
      ],
    });
    const [e, r] = textIn(objects);
    const k = 0.5 - 0.5 * Math.SQRT1_2;
    expect(e!.box.x).toBeCloseTo(PX + 4 * PX * k);
    expect(e!.box.h).toBeCloseTo(2 * PX * (1 - 2 * k));
    const d = 2 * PX * 0.16667 * 0.29289;
    expect(r!.box.x).toBeCloseTo(PX + d, 1);
    expect(r!.box.w).toBeCloseTo(4 * PX - 2 * d, 1);
  });

  it('legacy: maps alignment, anchor, line spacing and the stored autofit scale', () => {
    const { objects, notes } = emitOne(
      {
        slides: [
          {
            shapes:
              tb(body(para(run('a', 'sz="4000"'), 'algn="ctr"'), 'anchor="b"')) +
              tb(
                body(
                  `<a:p><a:pPr algn="just"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc></a:pPr>${run('b', 'sz="4000"')}</a:p>`,
                ).replace(
                  '<a:bodyPr/>',
                  '<a:bodyPr><a:normAutofit fontScale="50000" lnSpcReduction="10000"/></a:bodyPr>',
                ),
                { id: 3 },
              ) +
              tb(
                body(
                  `<a:p><a:pPr algn="dist"><a:lnSpc><a:spcPts val="3000"/></a:lnSpc></a:pPr>${run('c', 'sz="2000"')}</a:p>`,
                  'anchor="ctr"',
                ),
                { id: 4 },
              ) +
              tb(body(para(run('d'), 'algn="r"')), { id: 5 }),
          },
        ],
      },
      LEGACY,
    );
    const [a, b, c, d] = textIn(objects);
    expect(a!.style).toMatchObject({ align: 'center', valign: 'bottom', fontSizePx: 80, lineHeight: 1.2 });
    expect(b!.style).toMatchObject({ align: 'left', valign: 'top', fontSizePx: 40 });
    expect(b!.style.lineHeight).toBeCloseTo(1.2 * 0.8);
    expect(c!.style).toMatchObject({ align: 'center', valign: 'middle', fontSizePx: 40 });
    expect(c!.style.lineHeight).toBeCloseTo(60 / 40); // 30 pt exact pitch over a 20 pt font
    expect(d!.style.align).toBe('right');
    expect(notes.join(' ')).toMatch(/justify text is drawn left-aligned/);
  });

  it('writes the outline at half its width, hollow text with alpha 0, caps and letter spacing', () => {
    const { objects } = emitOne({
      slides: [
        {
          shapes:
            tb(
              body(
                para(
                  run(
                    'Hollow',
                    'cap="all" spc="200"',
                    `<a:ln w="25400">${solid('0000FF')}</a:ln><a:noFill/>`,
                  ),
                ),
              ),
            ) + tb(body(para(run('Plain', '', `<a:ln w="25400"><a:gradFill/></a:ln>`))), { id: 3 }),
        },
      ],
    });
    const [h, p] = textIn(objects);
    expect(h!.style.outline).toEqual({ width: 2, color: { r: 0, g: 0, b: 255, a: 1 } });
    expect(h!.style.color.a).toBe(0);
    expect(h!.style.transform).toBe('uppercase');
    expect(h!.style.letterSpacing).toBeCloseTo(4);
    expect(p!.style.outline).toBeUndefined();
  });

  it('casts the run shadow, or the shape shadow when the shape itself draws nothing', () => {
    const shadow =
      '<a:effectLst><a:outerShdw blurRad="38100" dist="38100" dir="0"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>';
    const unfilled = sp({
      id: 2,
      x: 0,
      y: 0,
      cx: IN,
      cy: IN,
      fill: '<a:noFill/>',
      txBody: body(para(run('a'))),
    }).replace('</p:spPr>', `${shadow}</p:spPr>`);
    const filled = sp({
      id: 3,
      x: 0,
      y: 0,
      cx: IN,
      cy: IN,
      fill: solid('FF0000'),
      txBody: body(para(run('b'))),
    }).replace('</p:spPr>', `${shadow}</p:spPr>`);
    const own = sp({
      id: 4,
      x: 0,
      y: 0,
      cx: IN,
      cy: IN,
      txBody: body(
        para(
          run(
            'c',
            '',
            '<a:effectLst><a:outerShdw dist="25400" dir="5400000" blurRad="0"><a:srgbClr val="FF0000"/></a:outerShdw></a:effectLst>',
          ),
        ),
      ),
    });
    const { objects } = emitOne({ slides: [{ shapes: unfilled + filled + own }] });
    const [a, b, c] = textIn(objects);
    expect(a!.style.shadow).toEqual({ dx: 6, dy: 0, blur: 6, color: { r: 0, g: 0, b: 0, a: 1 } });
    expect(b!.style.shadow).toBeUndefined();
    expect(c!.style.shadow!.dx).toBeCloseTo(0);
    expect(c!.style.shadow).toMatchObject({ dy: 4, blur: 0, color: RED });
  });

  it('legacy: folds the common left margin of the paragraphs into the box (bullets are not drawn in M1)', () => {
    const bullet = '<a:buChar char="•"/>';
    const p = (text: string, pPr: string, children = '') =>
      `<a:p><a:pPr ${pPr}>${children}</a:pPr>${run(text)}</a:p>`;
    const one = (paras: string) =>
      textIn(
        emitOne({ slides: [{ shapes: tb(body(paras, 'lIns="0" tIns="0" rIns="0" bIns="0"')) }] }, LEGACY)
          .objects,
      )[0]!;
    // A bulleted level: text at marL (0.5 in); a level below at 1 in: the least is folded.
    const bulleted = one(
      p('a', `marL="${IN / 2}" indent="-${IN / 2}"`, bullet) +
        p('b', `lvl="1" marL="${IN}" indent="-${IN / 2}"`, bullet),
    );
    expect(bulleted.box.x).toBeCloseTo(PX + PX / 2);
    expect(bulleted.box.w).toBeCloseTo(4 * PX - PX / 2);
    // Without a bullet a hanging first line starts at marL + indent; a first-line indent keeps marL.
    expect(one(p('a', `marL="${IN / 2}" indent="-${IN / 4}"`)).box.x).toBeCloseTo(PX + PX / 4);
    expect(one(p('a', `marL="${IN / 2}" indent="${IN / 4}"`)).box.x).toBeCloseTo(PX + PX / 2);
    // Right-to-left paragraphs fold it on the right; mixed directions fold nothing.
    const rtl = one(p('a', `marL="${IN / 2}" rtl="1"`));
    expect(rtl.box.x).toBeCloseTo(PX);
    expect(rtl.box.w).toBeCloseTo(4 * PX - PX / 2);
    expect(one(p('a', `marL="${IN / 2}" rtl="1"`) + p('b', `marL="${IN / 2}"`)).box.w).toBeCloseTo(4 * PX);
    const empty = { l: 0, t: 0, r: 0, b: 0 };
    expect(
      marginOf({ paras: [], insets: empty, anchor: 'top', wrap: true, autofit: { kind: 'none' } }),
    ).toEqual({ l: 0, r: 0 });
  });

  it('legacy: widens a wrap="none" box on the side its alignment grows into', () => {
    const { objects } = emitOne(
      {
        slides: [
          {
            shapes:
              tb(body(para(run('l')), 'wrap="none" lIns="0" tIns="0" rIns="0" bIns="0"')) +
              tb(body(para(run('c'), 'algn="ctr"'), 'wrap="none" lIns="0" tIns="0" rIns="0" bIns="0"'), {
                id: 3,
              }),
          },
        ],
      },
      LEGACY,
    );
    const [l, c] = textIn(objects);
    expect(l!.box.x).toBeCloseTo(PX);
    expect(l!.box.w).toBeCloseTo(4 * PX + 1920);
    expect(c!.box.x + c!.box.w / 2).toBeCloseTo(PX + 2 * PX);
    expect(c!.box.w).toBeCloseTo(4 * PX + 1920);
  });

  it('turns vertical text a quarter about its centre', () => {
    const { objects } = emitOne({
      slides: [
        {
          shapes:
            tb(body(para(run('v')), 'vert="vert" lIns="0" tIns="0" rIns="0" bIns="0"')) +
            tb(body(para(run('w')), 'vert="vert270" lIns="0" tIns="0" rIns="0" bIns="0"'), { id: 3 }),
        },
      ],
    });
    const [v, w] = textIn(objects);
    expect(v!.box).toMatchObject({ w: 2 * PX, h: 4 * PX, rotation: 90 });
    expect(v!.box.x + v!.box.w / 2).toBeCloseTo(3 * PX);
    expect(w!.box.rotation).toBe(-90);
  });

  it('legacy: keeps a rotated box rotated and folds insets along its own axes', () => {
    const { objects } = emitOne(
      {
        slides: [
          { shapes: tb(body(para(run('r')), 'lIns="182880" tIns="0" rIns="0" bIns="0"'), { rot: 90 }) },
        ],
      },
      LEGACY,
    );
    const [t] = textIn(objects);
    expect(t!.box.rotation).toBe(90);
    expect(t!.box.w).toBeCloseTo(4 * PX - 0.2 * PX);
    // The left inset of a box turned 90° clockwise moves its centre down.
    expect(t!.box.y + t!.box.h / 2).toBeCloseTo(2 * PX + 0.1 * PX);
    expect(t!.box.x + t!.box.w / 2).toBeCloseTo(3 * PX);
  });

  it('uses the East Asian typeface for text mostly in East Asian scripts', () => {
    const { objects } = emitOne({
      slides: [
        {
          shapes:
            tb(body(para(run('奇异恩典', '', '<a:latin typeface="Arial"/><a:ea typeface="SimSun"/>')))) +
            tb(body(para(run('Grace 恩', '', '<a:latin typeface="Arial"/><a:ea typeface="SimSun"/>'))), {
              id: 3,
            }),
        },
      ],
    });
    expect(textIn(objects).map((t) => t.style.fontFamily)).toEqual(['SimSun', 'Arial']);
  });

  it('clamps sizes to 4-1,000 px and cuts text at 20,000 characters', () => {
    const { objects, notes } = emitOne({
      slides: [
        { shapes: tb(body(para(run('big', 'sz="400000"')) + para(run('x'.repeat(25_000), 'sz="100"')))) },
      ],
    });
    const [t] = textIn(objects);
    expect(t!.text).toHaveLength(20_000);
    expect(t!.style.fontSizePx).toBe(4); // the long run dominates: 1 pt
    expect(notes.join(' ')).toMatch(/cut to 20000/);
    const big = emitOne({ slides: [{ shapes: tb(body(para(run('big', 'sz="400000"')))) }] });
    expect(textIn(big.objects)[0]!.style.fontSizePx).toBe(1000);
  });
});

describe('shapes', () => {
  it('draws rect, roundRect with its corner, ellipse, other presets by their geometry (M6)', () => {
    const { objects, notes } = emitOne({
      slides: [
        {
          shapes:
            sp({
              id: 2,
              x: 0,
              y: 0,
              cx: 2 * IN,
              cy: IN,
              fill: solid('FF0000'),
              ln: `<a:ln w="25400">${solid('0000FF')}</a:ln>`,
            }) +
            sp({ id: 3, x: 0, y: 0, cx: 2 * IN, cy: IN, geom: 'roundRect', fill: solid('FF0000') }).replace(
              '<a:avLst/>',
              '<a:avLst><a:gd name="adj" fmla="val 50000"/></a:avLst>',
            ) +
            sp({ id: 4, x: 0, y: 0, cx: 2 * IN, cy: IN, geom: 'ellipse', fill: solid('FF0000') }) +
            sp({ id: 5, x: 0, y: 0, cx: 2 * IN, cy: IN, geom: 'star5', fill: solid('FF0000') }) +
            sp({ id: 6, x: 0, y: 0, cx: 2 * IN, cy: IN, geom: 'roundRect', fill: solid('FF0000') }) +
            sp({ id: 7, x: 0, y: 0, cx: 2 * IN, cy: IN, geom: 'noSuchShape', fill: solid('FF0000') }),
        },
      ],
    });
    const [rect, round, ell, star, dflt, unknown] = content(objects) as ShapeObject[];
    expect(rect).toMatchObject({
      shape: 'rect',
      fill: RED,
      stroke: { width: 4, color: { r: 0, g: 0, b: 255, a: 1 } },
      radius: 0,
    });
    expect(rect!.geom).toBeUndefined();
    expect(round).toMatchObject({
      shape: 'rect',
      radius: PX / 2,
      geom: { preset: 'roundRect', adj: [['adj', 50_000]] },
    });
    expect(ell!.shape).toBe('ellipse');
    expect(ell!.geom).toBeUndefined(); // today's ellipse is exact
    // The legacy rect an older build draws, and the preset beside it.
    expect(star).toMatchObject({ shape: 'rect', fill: RED, geom: { preset: 'star5' } });
    expect(dflt!.radius).toBeCloseTo(PX * 0.16667, 2);
    expect(dflt!.geom).toEqual({ preset: 'roundRect' });
    expect(unknown!.geom).toBeUndefined();
    expect(notes.join(' ')).toMatch(/preset:noSuchShape drawn as rect/);
    expect(notes.join(' ')).not.toMatch(/star5/);
  });

  it('draws a line at its angle, through flips and groups', () => {
    const line = (extra: Partial<Parameters<typeof sp>[0]>) =>
      sp({
        id: 2,
        x: 0,
        y: 0,
        cx: IN,
        cy: IN,
        geom: 'line',
        ln: `<a:ln w="12700">${solid('000000')}</a:ln>`,
        ...extra,
      });
    const { objects } = emitOne({
      slides: [{ shapes: line({}) + line({ id: 3, flipH: true }) + line({ id: 4, cy: 0, cx: 2 * IN }) }],
    });
    const [down, up, flat] = content(objects) as ShapeObject[];
    expect(down).toMatchObject({ shape: 'line', stroke: { width: 2 } });
    expect(down!.box.rotation).toBeCloseTo(45);
    expect(down!.box.w).toBeCloseTo(PX * Math.SQRT2);
    expect(down!.box.h).toBe(0);
    expect(down!.box.x + down!.box.w / 2).toBeCloseTo(PX / 2);
    expect(up!.box.rotation).toBeCloseTo(135);
    expect(flat!.box).toMatchObject({ x: 0, y: 0, h: 0, rotation: 0 });
    expect(flat!.box.w).toBeCloseTo(2 * PX);
  });

  it('draws an elbow connector as one route along its chord, with its arrowhead (M6)', () => {
    const cxn =
      '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="5" name="C"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm>' +
      '<a:prstGeom prst="bentConnector3"><a:avLst><a:gd name="adj1" fmla="val 25000"/></a:avLst></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>';
    const { objects, notes } = emitOne({ slides: [{ shapes: cxn }] });
    const [route, ...rest] = content(objects) as ShapeObject[];
    expect(rest).toHaveLength(0);
    // An older build draws the line from the start (0, 0) to the end (2, 1) in, along the box's midline.
    const chord = Math.hypot(2 * PX, PX);
    expect(route).toMatchObject({
      shape: 'line',
      stroke: { width: 2 },
      ends: { tail: { type: 'triangle' } },
    });
    expect(route!.box.w).toBeCloseTo(chord);
    expect(route!.box.rotation).toBeCloseTo((Math.atan2(1, 2) * 180) / Math.PI);
    expect(route!.box.x + route!.box.w / 2).toBeCloseTo(PX);
    expect(route!.box.y + route!.box.h / 2).toBeCloseTo(PX / 2);
    // The route in the chord's frame: (0, 0) → (0.5, 0) → (0.5, 1) → (2, 1) in, as the preset builds it.
    const [path] = route!.geom!.paths!;
    expect(path).toMatchObject({ w: route!.box.w, h: route!.box.h, fill: 'none' });
    const nums = path!.d.match(/-?[\d.]+/g)!.map(Number);
    const u = [2 / Math.sqrt(5), 1 / Math.sqrt(5)];
    const at = (x: number, y: number) => [x * u[0]! + y * u[1]!, -x * u[1]! + y * u[0]! + route!.box.h / 2];
    const want = [at(0, 0), at(0.5 * PX, 0), at(0.5 * PX, PX), at(2 * PX, PX)].flat();
    expect(path!.d.replace(/[-\d. ]/g, '')).toBe('MLLL');
    for (const [i, v] of nums.entries()) expect(v).toBeCloseTo(want[i]!, 1);
    expect(notes.join(' ')).not.toMatch(/arrowheads/);
  });

  it('draws custom geometry as its paths, its legacy rect only when it fills most of its box (M6)', () => {
    const custom = (id: number, pts: string) =>
      sp({
        id,
        x: 0,
        y: 0,
        cx: IN,
        cy: IN,
        geom: 'none',
        fill: solid('FF0000'),
        txBody: body(para(run('t'))),
      }).replace(
        '<p:spPr>',
        `<p:spPr><a:custGeom><a:pathLst><a:path w="10" h="10">${pts}<a:close/></a:path></a:pathLst></a:custGeom>`,
      );
    const full =
      '<a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="10" y="0"/></a:lnTo><a:lnTo><a:pt x="10" y="10"/></a:lnTo><a:lnTo><a:pt x="0" y="10"/></a:lnTo>';
    const thin =
      '<a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="10" y="0"/></a:lnTo><a:lnTo><a:pt x="10" y="1"/></a:lnTo><a:lnTo><a:pt x="0" y="1"/></a:lnTo>';
    const { objects } = emitOne({ slides: [{ shapes: custom(2, full) + custom(3, thin) }] });
    const [fullShape, , thinShape] = content(objects) as ShapeObject[];
    expect(content(objects).map((o) => o.type)).toEqual(['shape', 'text', 'shape', 'text']);
    expect(fullShape).toMatchObject({
      shape: 'rect',
      geom: { paths: [{ d: 'M 0 0 L 10 0 L 10 10 L 0 10 Z', w: 10, h: 10 }] },
    });
    // A thin silhouette's legacy is a line, which draws no fill: an older build draws nothing of it.
    expect(thinShape).toMatchObject({
      shape: 'line',
      fill: RED,
      geom: { paths: [{ d: 'M 0 0 L 10 0 L 10 1 L 0 1 Z', w: 10, h: 10 }] },
    });
  });

  it('draws a shape and its text as two objects, the text above', () => {
    const { objects } = emitOne({
      slides: [
        {
          shapes: sp({
            id: 2,
            x: 0,
            y: 0,
            cx: IN,
            cy: IN,
            fill: solid('FF0000'),
            txBody: body(para(run('x'))),
          }),
        },
      ],
    });
    expect(content(objects).map((o) => o.type)).toEqual(['shape', 'text']);
  });

  it('writes legacy colours: gradients as their first stop, patterns blended', () => {
    expect(
      legacyColor({
        kind: 'gradient',
        stops: [
          { at: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
          { at: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
        ],
      }),
    ).toEqual(RED);
    expect(
      legacyColor({
        kind: 'pattern',
        preset: 'pct25',
        fg: { r: 0, g: 0, b: 0, a: 1 },
        bg: { r: 200, g: 200, b: 200, a: 1 },
      }),
    ).toEqual({ r: 150, g: 150, b: 150, a: 1 });
    expect(legacyColor({ kind: 'none' })).toBeUndefined();
    expect(legacyColor({ kind: 'solid', color: { r: 300, g: Number.NaN, b: -1, a: 2 } })).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 1,
    });
  });

  it('draws a gradient-filled shape as its first stop', () => {
    const scene = parseDeck(
      buildDeck({ slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: solid('FF0000') }) }] }),
    );
    const e = scene.slides[0]!.elements[0] as ShapeElement;
    e.fill = {
      kind: 'gradient',
      stops: [
        { at: 0, color: { r: 0, g: 0, b: 255, a: 1 } },
        { at: 1, color: RED },
      ],
    };
    const out = emitSlides(scene);
    expect((out.slides[0]!.slide.objects[1] as ShapeObject).fill).toEqual({ r: 0, g: 0, b: 255, a: 1 });
  });
});

describe('pictures', () => {
  const rels = [imageRel('rId2', 'photo.png')];

  it('stretches a picture over its box with its alpha', () => {
    const { objects, out } = emitOne({
      slides: [
        {
          rels,
          shapes: pic({
            id: 2,
            x: IN,
            y: 0,
            cx: 2 * IN,
            cy: IN,
            rId: 'rId2',
            blip: '<a:alphaModFix amt="50000"/>',
          }),
        },
      ],
    });
    const [img] = content(objects) as ImageObject[];
    expect(img).toMatchObject({
      type: 'image',
      mediaId: 'pptxmedia:1',
      fit: 'stretch',
      opacity: 0.5,
      radius: 0,
    });
    expect(img!.box).toMatchObject({ x: PX, y: 0, w: 2 * PX, h: PX });
    expect(out.media).toEqual([{ id: 'pptxmedia:1', part: 'ppt/media/photo.png' }]);
  });

  it('numbers media ids, so a long part name still gives a slide Slide.parse accepts', () => {
    const name = `${'x'.repeat(400)}.png`;
    const { slide, out } = emitOne({
      slides: [
        { rels: [imageRel('rId2', name)], shapes: pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2' }) },
      ],
    });
    expect((slide.objects[1] as ImageObject).mediaId).toBe('pptxmedia:1');
    expect(out.media).toEqual([{ id: 'pptxmedia:1', part: `ppt/media/${name}` }]);
    expect(Slide.safeParse(slide).success).toBe(true);
  });

  it('cuts a picture reaching past twice the canvas and folds the cut into its crop', () => {
    // 40 in wide from x = -40 in: -5,760 to 0 px, 1,440 px of it outside the clamp's -3,840.
    const far = pic({ id: 2, x: -40 * IN, y: 0, cx: 40 * IN, cy: IN, rId: 'rId2', srcRect: 'l="10000"' });
    const { objects } = emitOne({ slides: [{ rels, shapes: far }] });
    const img = objects[1] as ImageObject;
    expect(img.box.x).toBeCloseTo(-3_840);
    expect(img.box.w).toBeCloseTo(3_840);
    // A third of the box is cut: the crop's left share grows by a third of the 90 % the box showed.
    expect(img.crop!.l).toBeCloseTo(0.1 + (1_920 / 5_760) * 0.9);
    expect(img.crop!.r).toBeCloseTo(0);
    expect(cutToClamp({ x: 4_000, y: 0, w: 100, h: 100, rotation: 0 }, undefined)).toBeUndefined();
    expect(cutToClamp({ x: -100, y: -2_200, w: 200, h: 4_400, rotation: 0 }, undefined)).toEqual({
      box: { x: -100, y: -2_160, w: 200, h: 4_320, rotation: 0 },
      crop: { l: 0, t: 40 / 4_400, r: 0, b: 40 / 4_400 },
    });
  });

  it('writes no crop with crop: false (the legacy value) and notes it', () => {
    const scene = parseDeck(
      buildDeck({
        slides: [
          { rels, shapes: pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2', srcRect: 'l="10000"' }) },
        ],
      }),
    );
    const out = emitSlides(scene, { crop: false }).slides[0]!;
    expect(out.slide.objects[1]).not.toHaveProperty('crop');
    expect(out.notes.join(' ')).toMatch(/drawn uncropped/);
  });

  it('writes crop from srcRect by default, negative values kept, and Slide.parse keeps it', () => {
    const scene = parseDeck(
      buildDeck({
        slides: [
          {
            rels,
            shapes: pic({
              id: 2,
              x: 0,
              y: 0,
              cx: IN,
              cy: IN,
              rId: 'rId2',
              srcRect: 'l="10000" t="-5000" r="20000" b="0"',
            }),
          },
        ],
      }),
    );
    const slide = emitSlides(scene).slides[0]!.slide;
    const img = slide.objects[1] as ImageObject;
    expect(img.crop).toEqual({ l: 0.1, t: -0.05, r: 0.2, b: 0 });
    expect((Slide.parse(slide).objects[1] as ImageObject).crop).toEqual(img.crop);
  });

  it('folds fillRect into the box, and into the crop where the box clips it', () => {
    expect(placePicture({ part: 'p', fillRect: { l: 0.1, t: 0, r: 0.1, b: 0.5 } })).toEqual({
      rect: [0.1, 0, 0.9, 0.5],
    });
    const out = placePicture({
      part: 'p',
      fillRect: { l: -0.5, t: 0, r: 0.5, b: 0 },
      crop: { l: 0.2, t: 0, r: 0, b: 0 },
    })!;
    expect(out.rect).toEqual([0, 0, 0.5, 1]);
    expect(out.crop!.l).toBeCloseTo(0.2 + 0.5 * 0.8);
    expect(out.crop!.r).toBeCloseTo(0);
    expect(placePicture({ part: 'p', fillRect: { l: 1, t: 0, r: 0, b: 0 } })).toBeUndefined();
  });

  it('rounds roundRect and ellipse clips and strokes an outlined picture above it', () => {
    const outlined = pic({ id: 3, x: 0, y: 0, cx: 2 * IN, cy: IN, rId: 'rId2' }).replace(
      '</a:prstGeom></p:spPr>',
      `</a:prstGeom><a:ln w="25400">${solid('FF0000')}</a:ln></p:spPr>`,
    );
    const { objects } = emitOne({
      slides: [
        {
          rels,
          shapes: pic({ id: 2, x: 0, y: 0, cx: 2 * IN, cy: IN, rId: 'rId2', geom: 'ellipse' }) + outlined,
        },
      ],
    });
    const [ell, img, stroke] = content(objects);
    expect((ell as ImageObject).radius).toBeCloseTo(PX / 2);
    expect(img!.type).toBe('image');
    expect(stroke).toMatchObject({ type: 'shape', shape: 'rect', stroke: { width: 4, color: RED } });
    expect(stroke).not.toHaveProperty('fill');
  });

  it('draws a picture-filled shape as an image', () => {
    const blipFill = '<a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>';
    const { objects } = emitOne({
      slides: [{ rels, shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: blipFill }) }],
    });
    expect(content(objects).map((o) => o.type)).toEqual(['image']);
  });
});

describe('backgrounds', () => {
  const rels = [imageRel('rId2', 'bg.png')];

  it('uses a plain stretched opaque picture of the slide aspect as the 16:9 slide background', () => {
    const { slide } = emitOne({
      slides: [{ rels, bg: pictureBg('rId2') }],
      media: { 'ppt/media/bg.png': pngHeader(1280, 720, true) },
    });
    expect(slide.backgroundMediaId).toBe('pptxmedia:1');
    expect(slide.objects).toEqual([]);
  });

  it('keeps a background picture that may be transparent as a bottom image on white', () => {
    // The slide background is drawn cover-fit on black; PowerPoint lays a transparent background on white.
    const white = { type: 'shape', shape: 'rect', fill: { r: 255, g: 255, b: 255, a: 1 } };
    const tRNS = Uint8Array.from([
      ...pngHeader(1280, 720, true).subarray(0, 33),
      0,
      0,
      0,
      0,
      0x74,
      0x52,
      0x4e,
      0x53,
    ]);
    const unknown = pngHeader(1280, 720, true).subarray(0, 33); // RGB, but the bytes end before the image data
    for (const media of [pngHeader(1280, 720), tRNS, unknown]) {
      const { slide, objects } = emitOne({
        slides: [{ rels, bg: pictureBg('rId2') }],
        media: { 'ppt/media/bg.png': media },
      });
      expect(slide.backgroundMediaId).toBeUndefined();
      expect(objects[0]).toMatchObject({ ...white, box: { x: 0, y: 0, w: 1920, h: 1080 } });
      expect(objects[1]).toMatchObject({
        type: 'image',
        fit: 'stretch',
        box: { x: 0, y: 0, w: 1920, h: 1080 },
      });
    }
  });

  it('draws a picture of another aspect, or on a 4:3 slide, as a bottom image over white on the slide area', () => {
    const white = { type: 'shape', shape: 'rect', fill: { r: 255, g: 255, b: 255, a: 1 } };
    const wrong = emitOne({
      slides: [{ rels, bg: pictureBg('rId2') }],
      media: { 'ppt/media/bg.png': pngHeader(800, 600) },
    });
    expect(wrong.slide.backgroundMediaId).toBeUndefined();
    expect(wrong.objects[0]).toMatchObject({ ...white, box: { x: 0, y: 0, w: 1920, h: 1080 } });
    expect(wrong.objects[1]).toMatchObject({ type: 'image', box: { x: 0, y: 0, w: 1920, h: 1080 } });
    const four = emitOne({
      size: { cx: 9_144_000, cy: 6_858_000 },
      slides: [{ rels, bg: pictureBg('rId2') }],
      media: { 'ppt/media/bg.png': pngHeader(800, 600) },
    });
    for (const o of four.objects.slice(0, 2)) {
      expect(o.box.x).toBeCloseTo(240);
      expect(o.box.w).toBeCloseTo(1440);
    }
  });

  it('does not take a picture of unknown size (spilled, no size given) for the slide background', () => {
    const spilled = { 'ppt/media/bg.png': new Uint8Array(0) }; // extractZip's empty entry for a spilled part
    const { slide, objects } = emitOne({ slides: [{ rels, bg: pictureBg('rId2') }], media: spilled });
    expect(slide.backgroundMediaId).toBeUndefined();
    expect(objects[0]).toMatchObject({ type: 'shape', fill: { r: 255, g: 255, b: 255, a: 1 } });
    expect(objects[1]).toMatchObject({
      type: 'image',
      fit: 'stretch',
      box: { x: 0, y: 0, w: 1920, h: 1080 },
    });
    // The caller can read the size from the spilled file (ParseOptions.pictureSize), asked once per part.
    const parts = buildDeck({
      slides: [
        { rels, bg: pictureBg('rId2') },
        { rels, bg: pictureBg('rId2') },
      ],
      media: spilled,
    });
    const asked: string[] = [];
    const sized = (w: number, h: number, alpha?: boolean) =>
      emitSlides(
        parseDeck(parts, {
          pictureSize: (part) => {
            asked.push(part);
            return { w, h, ...(alpha !== undefined ? { alpha } : {}) };
          },
        }),
      ).slides;
    expect(sized(1920, 1080, false).map((x) => x.slide.backgroundMediaId)).toEqual([
      'pptxmedia:1',
      'pptxmedia:1',
    ]);
    expect(asked).toEqual(['ppt/media/bg.png']);
    expect(sized(1024, 768, false)[0]!.slide.backgroundMediaId).toBeUndefined();
    expect(sized(Number.NaN, 1080, false)[0]!.slide.backgroundMediaId).toBeUndefined();
    // A caller that cannot tell whether the picture is opaque keeps it on white.
    expect(sized(1920, 1080, true)[0]!.slide.backgroundMediaId).toBeUndefined();
    expect(sized(1920, 1080)[0]!.slide.backgroundMediaId).toBeUndefined();
  });

  it('lays a translucent background picture on white, as PowerPoint does', () => {
    const { slide, objects } = emitOne({
      slides: [{ rels, bg: pictureBg('rId2').replace('/>', '><a:alphaModFix amt="45000"/></a:blip>') }],
      media: { 'ppt/media/bg.png': pngHeader(1280, 720, true) },
    });
    expect(slide.backgroundMediaId).toBeUndefined();
    expect(objects[0]).toMatchObject({ type: 'shape', fill: { r: 255, g: 255, b: 255, a: 1 } });
    expect(objects[1]).toMatchObject({ type: 'image', opacity: 0.45 });
  });

  it('lays a translucent colour or gradient background on white as one opaque rect', () => {
    const clear = '<a:srgbClr val="9AB4E4"><a:alpha val="0"/></a:srgbClr>';
    const grad = `<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0">${clear}</a:gs><a:gs pos="100000"><a:srgbClr val="9AB4E4"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>`;
    expect(emitOne({ slides: [{ bg: grad }] }).objects).toEqual([
      expect.objectContaining({ type: 'shape', fill: { r: 255, g: 255, b: 255, a: 1 } }),
    ]);
    const half = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="000000"><a:alpha val="50000"/></a:srgbClr></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
    expect(emitOne({ slides: [{ bg: half }] }).objects[0]).toMatchObject({
      fill: { r: 128, g: 128, b: 128, a: 1 },
    });
    expect(overWhite({ r: 10, g: 20, b: 30, a: 1 })).toEqual({ r: 10, g: 20, b: 30, a: 1 });
  });

  it('extends solid backgrounds to the whole frame unless asked not to', () => {
    const spec = { size: { cx: 9_144_000, cy: 6_858_000 }, slides: [{ bg: solidBg('FF0000') }] };
    expect(emitOne(spec).objects[0]).toMatchObject({ type: 'shape', box: { x: 0, w: 1920 }, fill: RED });
    expect(emitOne(spec, { extendBackgrounds: false }).objects[0]!.box.x).toBeCloseTo(240);
  });

  it('draws no background as white, as PowerPoint shows it', () => {
    const { objects } = emitOne({ master: { bg: '' }, slides: [{}] });
    expect(objects).toEqual([
      expect.objectContaining({ type: 'shape', fill: { r: 255, g: 255, b: 255, a: 1 } }),
    ]);
  });
});

describe('placement', () => {
  it('centres a 4:3 deck and scales groups', () => {
    const { objects } = emitOne({
      size: { cx: 9_144_000, cy: 6_858_000 },
      slides: [
        {
          shapes: grpSp(
            { id: 10, x: IN, y: IN, cx: 2 * IN, cy: 2 * IN, chX: 0, chY: 0, chCx: IN, chCy: IN },
            sp({ id: 2, x: 0, y: 0, cx: IN / 2, cy: IN / 2, fill: solid('FF0000') }),
          ),
        },
      ],
    });
    const [box] = content(objects);
    expect(box!.box).toMatchObject({ y: PX, w: PX, h: PX, rotation: 0 });
    expect(box!.box.x).toBeCloseTo(240 + PX);
  });

  it('insets a box along its rotated axes', () => {
    const b = insetBox({ x: 0, y: 0, w: 100, h: 50, rotation: 90 }, 10, 0, 0, 0);
    expect(b.w).toBe(90);
    expect(b.x + b.w / 2).toBeCloseTo(50);
    expect(b.y + b.h / 2).toBeCloseTo(30);
    expect(insetBox({ x: 0, y: 0, w: 10, h: 10, rotation: 0 }, 20, 0, 20, 0).w).toBe(0);
  });

  it('writes formatting within the slide budget, then plain text, and classes the slide picture', () => {
    // 40 boxes of 300 differently coloured runs each: far past 64 KB of formatting.
    const colors = ['FF0000', '00FF00'];
    const runs = Array.from({ length: 300 }, (_, i) => run(`w${i} `, '', solid(colors[i % 2]!))).join('');
    const box = (id: number) => sp({ id, x: 0, y: 0, cx: IN, cy: IN, txBody: body(para(runs)) });
    const boxes = Array.from({ length: 40 }, (_, i) => box(i + 2)).join('');
    const out = emitSlides(parseDeck(buildDeck({ slides: [{ shapes: boxes }] })));
    const s = out.slides[0]!;
    const texts = s.slide.objects.filter((o): o is TextObject => o.type === 'text');
    expect(texts).toHaveLength(40);
    const formatted = texts.filter((t) => t.runs);
    expect(formatted.length).toBeGreaterThan(0);
    expect(formatted.length).toBeLessThan(10);
    // The rest keep their text and box style.
    expect(texts.at(-1)!.text).toBe(texts[0]!.text);
    expect(texts.at(-1)!.runs).toBeUndefined();
    expect(JSON.stringify(s.slide).length).toBeLessThan(MAX_SLIDE_BYTES + 40 * 2_000);
    expect(s.classification.class).toBe('picture');
    expect(s.classification.reasons.join(' ')).toMatch(/KB of text formatting/);
    expect(s.notes).toContain(SLIDE_BUDGET_NOTE);
    // The budget alone made it picture class: an importer counts it as its own slide budget does.
    expect(s.overBudget).toBe(true);
    // A slide within the budget is untouched.
    const small = emitSlides(parseDeck(buildDeck({ slides: [{ shapes: box(2) }] }))).slides[0]!;
    expect(small.classification.class).not.toBe('picture');
    expect(small.overBudget).toBeUndefined();
    // A slide picture class for its object count is not flagged, though its formatting passes the budget too.
    const few = Array.from({ length: 30 }, (_, i) => run(`w${i} `, '', solid(colors[i % 2]!))).join('');
    const many = Array.from({ length: 160 }, (_, i) =>
      sp({ id: i + 2, x: 0, y: 0, cx: IN, cy: IN, txBody: body(para(few)) }),
    ).join('');
    const crowded = emitSlides(parseDeck(buildDeck({ slides: [{ shapes: many }] }))).slides[0]!;
    expect(crowded.classification.class).toBe('picture');
    expect(crowded.classification.reasons.join(' ')).toMatch(/KB of text formatting/);
    expect(crowded.overBudget).toBeUndefined();
  });

  it('caps a slide at 1,000 objects', () => {
    // Text boxes: shapes without text over the budget would go to the art (and emit nothing).
    const many = sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, txBody: body(para(run('x'))) }).repeat(1_100);
    const { objects, notes } = emitOne({ slides: [{ shapes: many }] });
    expect(objects).toHaveLength(1_000);
    expect(notes.join(' ')).toMatch(/more than 1000 objects/);
  });
});

describe('the object budget (M6)', () => {
  /** `n` shapes 0.1 in wide in rows of 20 of `colors` in turn; `shape` makes each (its id, x and y in EMU). */
  const pieces = (n: number, shape: (id: number, x: number, y: number, i: number) => string) => {
    let out = '';
    for (let i = 0; i < n; i++) out += shape(10 + i, (i % 20) * 0.1 * IN, Math.floor(i / 20) * 0.1 * IN, i);
    return out;
  };
  const square = (color: string) => (id: number, x: number, y: number) =>
    sp({ id, x, y, cx: 0.1 * IN, cy: 0.1 * IN, fill: solid(color) });
  const group = (inner: string) => grpSp({ id: 2, x: 0, y: 0, cx: 4 * IN, cy: 4 * IN }, inner);
  /** Device points (logical px) of a shape as the renderer builds it: box space flipped, turned, placed. */
  const devicePoints = (o: ShapeObject): number[][] => {
    const g = storedGeometry(o.geom, o.box.w, o.box.h) ?? legacyGeometry(o.shape, o.radius, o.box.w, o.box.h);
    const a = (o.box.rotation * Math.PI) / 180;
    const cx = o.box.x + o.box.w / 2;
    const cy = o.box.y + o.box.h / 2;
    return g.paths.map((p) => {
      const out: number[] = [];
      for (let i = 0; i < p.pts.length; i += 2) {
        const u = (p.pts[i]! - o.box.w / 2) * (o.flipH ? -1 : 1);
        const v = (p.pts[i + 1]! - o.box.h / 2) * (o.flipV ? -1 : 1);
        out.push(cx + u * Math.cos(a) - v * Math.sin(a), cy + u * Math.sin(a) + v * Math.cos(a));
      }
      return out;
    });
  };

  it('draws shapes of one look as one object per eight paths that draws as they do apart', () => {
    // Triangles, turned and mirrored in turn, and custom stars: 160 in one group, past the budget apart.
    const star =
      '<a:custGeom><a:pathLst><a:path w="10" h="10"><a:moveTo><a:pt x="5" y="0"/></a:moveTo>' +
      '<a:lnTo><a:pt x="10" y="10"/></a:lnTo><a:lnTo><a:pt x="0" y="4"/></a:lnTo><a:lnTo><a:pt x="10" y="4"/></a:lnTo>' +
      '<a:lnTo><a:pt x="0" y="10"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>';
    const shape = (id: number, x: number, y: number, i: number) =>
      i % 3 === 2
        ? sp({ id, x, y, cx: 0.1 * IN, cy: 0.08 * IN, geom: 'none', fill: solid('FF0000') }).replace(
            '<p:spPr>',
            `<p:spPr>${star}`,
          )
        : sp({
            id,
            x,
            y,
            cx: 0.1 * IN,
            cy: 0.06 * IN,
            geom: 'triangle',
            fill: solid('FF0000'),
            rot: i % 2 ? 30 : 0,
            flipH: i % 4 === 1,
            flipV: i % 5 === 3,
          });
    const scene = parseDeck(buildDeck({ slides: [{ shapes: group(pieces(160, shape)) }] }));
    const merged = inlineGeoms(emitSlides(scene)).slides[0]!;
    expect(Slide.parse(merged.slide)).toEqual(merged.slide);
    expect(merged.classification.class).toBe('native');
    const objects = content(merged.slide.objects) as ShapeObject[];
    expect(objects).toHaveLength(20);
    for (const o of objects) {
      // No legacy fill an older build would draw over the union box: a line, without an outline here.
      expect(o).toMatchObject({ type: 'shape', shape: 'line', fill: RED, opacity: 1 });
      expect(o.box.rotation).toBe(0);
      expect(o.stroke).toBeUndefined();
      expect(o.geom?.paths).toHaveLength(8);
    }
    // The same shapes emitted apart (the marks removed) put every point where the merged object does.
    for (const e of scene.slides[0]!.elements) delete (e as ShapeElement).merge;
    const apart = content(inlineGeoms(emitSlides(scene)).slides[0]!.slide.objects) as ShapeObject[];
    expect(apart).toHaveLength(160);
    const together = objects.flatMap(devicePoints);
    const each = apart.flatMap(devicePoints);
    expect(together).toHaveLength(each.length);
    each.forEach((pts, k) => {
      expect(together[k]).toHaveLength(pts.length);
      for (const [j, v] of pts.entries()) expect(Math.abs(together[k]![j]! - v)).toBeLessThan(0.02);
    });
    expect(merged.notes).toContain(
      "160 shapes of one look are drawn as 20 objects (the slide's object budget)",
    );
  });

  it('keeps a common outline and its dash on the merged object', () => {
    const ln = `<a:ln w="25400">${solid('0000FF')}<a:prstDash val="dash"/></a:ln>`;
    const shape = (id: number, x: number, y: number) =>
      sp({ id, x, y, cx: 0.1 * IN, cy: 0.1 * IN, fill: solid('FF0000'), ln });
    const { objects } = emitOne({ slides: [{ shapes: group(pieces(160, shape)) }] });
    expect(content(objects)).toHaveLength(20);
    expect(content(objects)[0]).toMatchObject({
      shape: 'line',
      fill: RED,
      stroke: { width: 4, color: { r: 0, g: 0, b: 255, a: 1 } },
      dash: 'dash',
    });
  });

  it('leaves out of version 1 what the budget sends to the art, so the slide stays within it', () => {
    // 160 squares of two looks in turn (none merge) under a title: the squares go to the art.
    const shape = (id: number, x: number, y: number, i: number) =>
      square(i % 2 ? '336699' : '993366')(id, x, y);
    const title = sp({ id: 3, x: 0, y: 5 * IN, cx: 4 * IN, cy: IN, txBody: body(para(run('Words'))) });
    const { out, objects } = emitOne({ slides: [{ shapes: group(pieces(160, shape)) + title }] });
    const e = out.slides[0]!;
    expect(e.classification.class).toBe('hybrid');
    expect(e.classification.reasons).toContain('art:budget:shapes');
    expect(objects.map((o) => o.type)).toEqual(['shape', 'text']);
    expect(e.art).toMatchObject({ at: 1, replaces: [], before: objects[1]!.id });
    expect(e.art?.elements).toHaveLength(160);
  });
});

describe('lyric box', () => {
  const at = (id: number, chars: string, ph?: string, cx = 4 * IN) =>
    sp({ id, x: 0, y: id * IN, cx, cy: IN, ...(ph ? { ph } : {}), txBody: body(para(run(chars))) });

  it('picks the body placeholder with the most characters', () => {
    const { slide } = emitOne({
      slides: [
        {
          shapes:
            at(1, 'Title text that is long', 'type="title"') +
            at(2, 'short', 'idx="1"') +
            at(3, 'longer body', 'type="body" idx="2"') +
            at(4, 'a free text box with the most'),
        },
      ],
    });
    const lyric = slide.objects.find((o) => o.id === slide.lyricObjectId) as TextObject;
    expect(lyric.text).toBe('longer body');
  });

  it('else the largest other text by characters × area, never a footer; the title only when alone', () => {
    const a = emitOne({
      slides: [
        {
          shapes:
            at(1, 'Title', 'type="title"') +
            at(2, 'aaaa', undefined, IN) +
            at(3, 'bbb', undefined, 4 * IN) +
            at(4, 'footer footer footer', 'type="ftr" idx="11"'),
        },
      ],
    });
    expect((a.slide.objects.find((o) => o.id === a.slide.lyricObjectId) as TextObject).text).toBe('bbb');
    const b = emitOne({
      slides: [{ shapes: at(1, 'Only a title', 'type="ctrTitle"') + at(4, 'footer', 'type="ftr" idx="11"') }],
    });
    expect((b.slide.objects.find((o) => o.id === b.slide.lyricObjectId) as TextObject).text).toBe(
      'Only a title',
    );
  });

  it('on a bilingual slide picks the first of the two language boxes in reading order', () => {
    const lang = (id: number, text: string, l: string, x: number, y: number, ph = 'type="body" idx="1"') =>
      sp({ id, x, y, cx: 5 * IN, cy: 2 * IN, ph, txBody: body(para(run(text, `lang="${l}"`))) });
    const lyric = (shapes: string) => {
      const { slide } = emitOne({ slides: [{ shapes }] });
      return (slide.objects.find((o) => o.id === slide.lyricObjectId) as TextObject).text;
    };
    // Side by side: the left box, even with less text.
    expect(
      lyric(
        lang(2, 'Amazing grace how sweet', 'en-US', 6 * IN, IN) +
          lang(3, 'Sublime gracia del Señor', 'es-ES', 0, IN, 'type="body" idx="2"'),
      ),
    ).toBe('Sublime gracia del Señor');
    // Stacked: the upper box, by script when no language is given.
    expect(
      lyric(
        lang(2, '奇异恩典何等甘甜', '', 0, 4 * IN) +
          lang(3, 'Amazing grace', '', 0, IN, 'type="body" idx="2"'),
      ),
    ).toBe('Amazing grace');
    // One language, or a much shorter second box: the box with the most text.
    expect(
      lyric(
        lang(2, 'Amazing grace how sweet', 'en-US', 6 * IN, IN) +
          lang(3, 'the sound', 'en-GB', 0, IN, 'type="body" idx="2"'),
      ),
    ).toBe('Amazing grace how sweet');
    expect(
      lyric(
        lang(2, 'Amazing grace how sweet the sound', 'en-US', 6 * IN, IN) +
          lang(3, 'Gracia', 'es-ES', 0, IN, 'type="body" idx="2"'),
      ),
    ).toBe('Amazing grace how sweet the sound');
  });

  it('weighs Han, Kana and Hangul against Latin text, so a parallel translation is bilingual', () => {
    const box = (id: number, text: string, rPr: string, y: number) =>
      sp({
        id,
        x: 0,
        y,
        cx: 10 * IN,
        cy: 2 * IN,
        ph: `type="body" idx="${id}"`,
        txBody: body(para(run(text, rPr))),
      });
    const lyric = (shapes: string) => {
      const { slide } = emitOne({ slides: [{ shapes }] });
      return (slide.objects.find((o) => o.id === slide.lyricObjectId) as TextObject).text;
    };
    const en = 'Amazing grace, how sweet the sound that saved a wretch like me';
    // Korean above (16 visible characters) and its English line below (52): the upper box, in reading order.
    const ko = '나 같은 죄인 살리신 주 은혜 놀라워';
    expect(lyric(box(2, ko, 'lang="ko-KR"', IN) + box(3, en, '', 4 * IN))).toBe(ko);
    const zh = '奇异恩典，何等甘甜，我罪已得赦免';
    expect(lyric(box(2, zh, 'lang="zh-CN"', IN) + box(3, en, '', 4 * IN))).toBe(zh);
  });

  it('compares like with like: a box without a language matches one with it in the same script', () => {
    const side = (id: number, x: number, text: string, rPr: string) =>
      sp({
        id,
        x,
        y: IN,
        cx: 5 * IN,
        cy: 2 * IN,
        ph: `type="body" idx="${id}"`,
        txBody: body(para(run(text, rPr))),
      });
    const { slide } = emitOne({
      slides: [
        {
          shapes:
            side(2, 0, 'Amazing grace how sweet', '') +
            side(3, 6 * IN, 'Amazing grace how sweet the sound', 'lang="en-GB"'),
        },
      ],
    });
    // Not a bilingual slide: the larger box, not the left one.
    const lyric = slide.objects.find((o) => o.id === slide.lyricObjectId) as TextObject;
    expect(lyric.text).toBe('Amazing grace how sweet the sound');
  });

  it('ignores decoration text', () => {
    const { slide } = emitOne({ master: { shapes: at(1, 'Church name on every slide') }, slides: [{}] });
    expect(slide.lyricObjectId).toBeUndefined();
  });
});

describe('robustness', () => {
  it('emits an IR with non-finite numbers as a valid slide', () => {
    const scene: DeckScene = parseDeck(
      buildDeck({
        slides: [
          {
            shapes: sp({
              id: 2,
              x: 0,
              y: 0,
              cx: IN,
              cy: IN,
              fill: solid('FF0000'),
              txBody: body(para(run('x'))),
            }),
          },
        ],
      }),
    );
    const e = scene.slides[0]!.elements[0] as ShapeElement;
    e.xf = [Number.NaN, 0, 0, Number.POSITIVE_INFINITY, 1e30, -1e30];
    e.text!.paras[0]!.runs[0]!.style.sizePt = Number.NaN;
    e.text!.insets.l = Number.POSITIVE_INFINITY;
    const out = emitSlides(scene);
    expect(Slide.parse(out.slides[0]!.slide)).toEqual(out.slides[0]!.slide);
  });

  it('keeps ids unique and the media list in first-use order across slides', () => {
    const rels = [imageRel('rId2', 'a.png'), imageRel('rId3', 'b.png')];
    const s = {
      rels,
      shapes:
        pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId3' }) +
        pic({ id: 3, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2' }),
    };
    const { out } = emitOne({ slides: [s, s] });
    const ids = out.slides.flatMap((x) => [x.slide.id, ...x.slide.objects.map((o) => o.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out.media.map((m) => m.part)).toEqual(['ppt/media/b.png', 'ppt/media/a.png']);
    expect(out.slides[0]!.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps control characters of deck strings out of notes, reasons and font families', () => {
    const forged = 'star5&#10;12:00:00 [error] forged&#13;&#27;[31m';
    const shape = sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: solid('FF0000') }).replace(
      'prst="rect"',
      `prst="${forged}"`,
    );
    const text = sp({
      id: 3,
      x: 0,
      y: 0,
      cx: IN,
      cy: IN,
      txBody: body(para(run('x', '', '<a:latin typeface="Arial&#12;"/>'))),
    });
    const scene = parseDeck(buildDeck({ slides: [{ shapes: shape + text }] }));
    const out = emitSlides(scene).slides[0]!;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: looking for them is the point
    const control = /[\u0000-\u001f\u007f-\u009f]/;
    const strings = [
      ...out.notes,
      ...out.classification.reasons,
      ...scene.slides[0]!.elements.flatMap((e) => e.reasons ?? []),
    ];
    expect(strings.some((x) => /preset:other/.test(x))).toBe(true);
    for (const x of strings) expect(x).not.toMatch(control);
    expect(textIn(out.slide.objects)[0]!.style.fontFamily).toBe('Arial');
  });

  it('writes nothing but the slide id for a quarantined slide', () => {
    const parts = buildDeck({ slides: [{ bg: solidBg('FF0000') }] });
    parts.set(
      'ppt/slides/slide1.xml',
      new TextEncoder().encode('<p:sld><p:cSld>'.repeat(1) + '<!-- unterminated'),
    );
    const out = emitSlides(parseDeck(parts));
    expect(out.slides[0]!.slide.objects).toEqual([]);
    expect(out.slides[0]!.classification.class).toBe('picture');
  });

  it('draws master-colour text the slide maps differently (clrMapOvr)', () => {
    const { objects } = emitOne({
      slides: [
        {
          shapes: sp({
            id: 2,
            x: 0,
            y: 0,
            cx: IN,
            cy: IN,
            txBody: body(para(run('x', '', solid(scheme('tx1'))))),
          }),
          after:
            '<p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>',
        },
      ],
    });
    expect(textIn(objects)[0]!.style.color).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });
});

it('reports point sizes at 2 px per point on both standard sizes', () => {
  for (const size of [undefined, { cx: 9_144_000, cy: 6_858_000 }]) {
    const { objects } = emitOne({
      ...(size ? { size } : {}),
      slides: [
        { shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, txBody: body(para(run('x', 'sz="3600"'))) }) },
      ],
    });
    expect(close(textIn(objects)[0]!.style.fontSizePx, 72)).toBe(true);
    expect(PT).toBe(12_700);
  }
});
