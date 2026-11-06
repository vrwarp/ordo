import { body, para, run, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import { describe, expect, it } from 'vitest';
import { deckTextFeatures, TEXT_FEATURES, textFeatures } from './features.ts';

const shape = (txBody: string) => sp({ id: 2, x: 0, y: 0, cx: 100, cy: 100, txBody });

describe('textFeatures', () => {
  it("finds the inventory's text features in a slide's XML", () => {
    expect(textFeatures(shape(body(para(run('16', 'baseline="30000"') + run(' For God')))))).toEqual([
      'superSub',
      'mixedRuns',
    ]);
    expect(textFeatures('<a:pPr><a:lnSpc><a:spcPct val="90000"/></a:lnSpc></a:pPr>')).toEqual(['lnSpcPct']);
    expect(textFeatures('<a:lnSpc><a:spcPts val="3600"/></a:lnSpc>')).toEqual([]);
    expect(
      textFeatures('<a:bodyPr><a:normAutofit fontScale="62500" lnSpcReduction="20000"/></a:bodyPr>'),
    ).toEqual(['normAutofitScaled']);
    expect(textFeatures('<a:bodyPr><a:normAutofit/></a:bodyPr>')).toEqual([]);
    expect(textFeatures('<a:pPr algn="r" rtl="1"/>')).toEqual(['rtl']);
    expect(textFeatures('<a:pPr rtl="0"/>')).toEqual([]);
    expect(textFeatures('<a:buAutoNum type="arabicParenBoth" startAt="16"/>')).toEqual(['bulletsAuto']);
    expect(textFeatures(shape(body(para(run('שלום עולם')))))).toEqual(['rtlScriptText']);
    expect(textFeatures(shape(body(para(run('مرحبا')))))).toEqual(['rtlScriptText']);
    expect(textFeatures(shape(body(para(run('Amazing grace', 'baseline="0"')))))).toEqual([]);
    expect(TEXT_FEATURES).toHaveLength(7);
  });

  it('counts runs as mixed by what changes their look, as the census does', () => {
    const one = (rPr: string, children = '') => run('word', rPr, children);
    // Language, spelling and kerning attributes do not make runs look different.
    expect(
      textFeatures(shape(body(para(one('dirty="0"') + one('lang="he-IL" err="1" kern="1200"'))))),
    ).toEqual([]);
    expect(textFeatures(shape(body(para(one('b="1"') + one('b="0"')))))).toEqual(['mixedRuns']);
    expect(textFeatures(shape(body(para(one('', solid('FF0000')) + one('', solid('00FF00'))))))).toEqual([
      'mixedRuns',
    ]);
    // Runs without text are not compared, and neither are runs of different text bodies.
    expect(textFeatures(shape(body(para(one('b="1"') + run('', 'b="0"')))))).toEqual([]);
    expect(textFeatures(shape(body(para(one('b="1"')))) + shape(body(para(one('b="0"')))))).toEqual([]);
  });

  it('stays linear on a part whose elements never close', () => {
    const hostile = '<p:txBody><a:r><a:t>x</a:t>'.repeat(200_000);
    const t0 = performance.now();
    expect(textFeatures(hostile)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('stays linear on unclosed autofit and run property tags (a part of 2 MB each)', () => {
    const cases = [
      '<a:normAutofit '.repeat(140_000),
      `<p:txBody><a:r>${'<a:rPr '.repeat(280_000)}<a:t>x</a:t></a:r><a:r><a:rPr b="1"><a:t>y</a:t></a:r></p:txBody>`,
      `<p:txBody><a:r><a:rPr b="1">${'<a:latin '.repeat(200_000)}<a:t>x</a:t></a:r></p:txBody>`,
    ];
    for (const hostile of cases) {
      const t0 = performance.now();
      textFeatures(hostile);
      expect(performance.now() - t0).toBeLessThan(2000);
    }
    // Still found where a tag is whole, and only on its own attributes.
    expect(textFeatures('<a:normAutofit lnSpcReduction="10000"/><a:t>fontScale=</a:t>')).toEqual([]);
    expect(textFeatures('<a:normAutofit fontScale="90000" lnSpcReduction="10000"/>')).toEqual([
      'normAutofitScaled',
    ]);
    expect(textFeatures('<a:normAutofitX fontScale="1"/>')).toEqual([]);
  });

  it('gives a deck the union of its slides and its presentation part, in order', () => {
    expect(deckTextFeatures([['rtl'], ['superSub'], []], ['bulletsAuto'])).toEqual([
      'superSub',
      'rtl',
      'bulletsAuto',
    ]);
    expect(deckTextFeatures([], [])).toEqual([]);
  });
});
