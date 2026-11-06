import type { Slide, TextObject } from '@ordo/domain';
import { type DeckScene, emitSlides, parseDeck } from '@ordo/pptx-scene';
import { body, buildDeck, type DeckSpec, para, run, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import { describe, expect, it } from 'vitest';
import { compatRules, drawingKey } from './compat.ts';

const SHADOW =
  '<a:effectLst><a:outerShdw blurRad="38100" dist="38100" dir="2700000"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>';
const OUTLINE = `<a:ln w="25400">${solid('000000')}</a:ln>`;
const box = { x: 914400, y: 914400, cx: 6_000_000, cy: 1_000_000 };
const fitted = (txBody: string, bodyPr: string) => txBody.replace('<a:bodyPr/>', bodyPr);

/** One slide per text box; slide 7 is a body placeholder inheriting the master's normAutofit. */
function deck(...shapes: string[]): DeckScene {
  const spec: DeckSpec = {
    master: {
      shapes: sp({
        id: 9,
        ph: 'type="body" idx="1"',
        ...box,
        txBody:
          '<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody>',
      }),
    },
    slides: shapes.map((s) => ({ shapes: s })),
  };
  return parseDeck(buildDeck(spec));
}

const texts = (s: Slide) => s.objects.filter((o): o is TextObject => o.type === 'text');

describe('compatRules', () => {
  const scene = deck(
    // 0: a run's own shadow
    sp({ id: 2, ...box, txBody: body(para(run('Shadowed', 'sz="4000"', `${solid('FFFFFF')}${SHADOW}`))) }),
    // 1: an outline on filled text
    sp({ id: 2, ...box, txBody: body(para(run('Outlined', 'sz="4000"', `${OUTLINE}${solid('FFFFFF')}`))) }),
    // 2: hollow text keeps its outline
    sp({ id: 2, ...box, txBody: body(para(run('Hollow', 'sz="4000"', `${OUTLINE}<a:noFill/>`))) }),
    // 3: an unfilled shape casts its shadow on the text: the shape's, not the run's
    sp({
      id: 2,
      ...box,
      fill: '<a:noFill/>',
      ln: SHADOW,
      txBody: body(para(run('Cast', 'sz="4000"', solid('FFFFFF')))),
    }),
    // 4: nothing to change
    sp({ id: 2, ...box, txBody: body(para(run('Plain', 'sz="4000"', solid('FFFFFF')))) }),
    // 5: the shape's own normAutofit with PowerPoint's stored scale
    sp({
      id: 2,
      ...box,
      txBody: fitted(
        body(para(run('Fitted', 'sz="4000"'))),
        '<a:bodyPr><a:normAutofit fontScale="80000" lnSpcReduction="10000"/></a:bodyPr>',
      ),
    }),
    // 6: an own normAutofit without a stored scale changes nothing
    sp({
      id: 2,
      ...box,
      txBody: fitted(body(para(run('Fits', 'sz="4000"'))), '<a:bodyPr><a:normAutofit/></a:bodyPr>'),
    }),
    // 7: normAutofit inherited from the master's body placeholder
    sp({ id: 3, ph: 'type="body" idx="1"', txBody: body(para(run('Inherited', 'sz="4000"'))) }),
  );

  it("names the rules each slide's text hits", () => {
    expect([...compatRules(scene)].map(([i, h]) => [i, [...h]])).toEqual([
      [0, ['runShadow']],
      [1, ['textOutline']],
      [5, ['refit']],
      [7, ['inheritedFit']],
    ]);
  });

  it('matches what the converter writes with loCompat; a shape-cast shadow stays', () => {
    const ordo = emitSlides(scene).slides.map((s) => s.slide);
    const lo = emitSlides(scene, { loCompat: true }).slides.map((s) => s.slide);
    expect(texts(ordo[0]!)[0]!.style.shadow).toBeDefined();
    expect(texts(lo[0]!)[0]!.style.shadow).toBeUndefined();
    expect(texts(ordo[1]!)[0]!.style.outline).toBeDefined();
    expect(texts(lo[1]!)[0]!.style.outline).toBeUndefined();
    expect(texts(lo[2]!)[0]!.style.outline).toBeDefined();
    expect(texts(lo[3]!)[0]!.style.shadow).toBeDefined();
    expect(texts(ordo[5]!)[0]!.style).toMatchObject({ autofit: 'shrink', fitScale: { font: 0.8 } });
    expect(texts(lo[5]!)[0]!.style.autofit).toBe('shrink');
    expect(texts(lo[5]!)[0]!.style.fitScale).toBeUndefined();
    expect(texts(ordo[7]!)[0]!.style.autofit).toBe('shrink');
    expect(texts(lo[7]!)[0]!.style.autofit).toBeUndefined();
    // The slides no rule names draw alike; the others do not.
    const hit = compatRules(scene);
    for (const [k, s] of ordo.entries())
      expect(drawingKey(lo[k]!) !== drawingKey(s), `slide ${k}`).toBe(hit.has(k));
  });

  it('leaves a scene with nothing to change without rules', () => {
    expect(compatRules(deck(sp({ id: 2, ...box, txBody: body(para(run('Plain', 'sz="4000"'))) }))).size).toBe(
      0,
    );
  });
});

describe('drawingKey', () => {
  const text = (style: Partial<TextObject['style']>): TextObject => ({
    id: 't',
    type: 'text',
    box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
    text: 'x',
    style: {
      fontFamily: 'Calibri',
      fontWeight: 400,
      fontStyle: 'normal',
      fontSizePx: 40,
      color: { r: 0, g: 0, b: 0, a: 1 },
      align: 'left',
      valign: 'top',
      lineHeight: 1.2,
      letterSpacing: 0,
      padding: 0,
      transform: 'none',
      ...style,
    },
    opacity: 1,
  });

  it('compares drawings without object ids', () => {
    const a: Slide = { id: 'a', objects: [text({})], lyricObjectId: 't' };
    const b: Slide = { ...a, id: 'b', objects: [{ ...text({}), id: 'u' }], lyricObjectId: 'u' };
    expect(drawingKey(a)).toBe(drawingKey(b));
    expect(drawingKey(a)).not.toBe(drawingKey({ ...a, objects: [text({ fontSizePx: 41 })] }));
  });
});
