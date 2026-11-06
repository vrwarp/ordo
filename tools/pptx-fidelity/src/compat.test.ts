import type { Slide, TextObject } from '@ordo/domain';
import { type DeckScene, emitSlides, parseDeck, type ShapeElement } from '@ordo/pptx-scene';
import { body, buildDeck, para, run, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import { describe, expect, it } from 'vitest';
import { drawingKey, loCompatScene, refitSlide } from './compat.ts';

const SHADOW =
  '<a:effectLst><a:outerShdw blurRad="38100" dist="38100" dir="2700000"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>';
const OUTLINE = `<a:ln w="25400">${solid('000000')}</a:ln>`;
const box = { x: 914400, y: 914400, cx: 6_000_000, cy: 1_000_000 };

/** One slide per text box. */
function deck(...shapes: string[]): DeckScene {
  return parseDeck(buildDeck({ slides: shapes.map((s) => ({ shapes: s })) }));
}

const texts = (s: Slide) => s.objects.filter((o): o is TextObject => o.type === 'text');
const runStyle = (scene: DeckScene, slide: number) =>
  (scene.slides[slide]!.elements.find((e) => e.kind === 'shape' && e.text) as ShapeElement).text!.paras[0]!
    .runs[0]!.style;

describe('loCompatScene', () => {
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
  );

  it("removes run shadows and outlines on filled text, and says which slides' text they changed", () => {
    const c = loCompatScene(scene);
    expect([...c.hits].map(([i, h]) => [i, [...h]])).toEqual([
      [0, ['runShadow']],
      [1, ['textOutline']],
    ]);
    expect(runStyle(scene, 0).shadow).toBeDefined();
    expect(runStyle(c.scene, 0).shadow).toBeUndefined();
    expect(runStyle(scene, 1).outline).toBeDefined();
    expect(runStyle(c.scene, 1).outline).toBeUndefined();
    expect(runStyle(c.scene, 2).outline).toBeDefined();
    // Untouched slides are the same objects; the input scene is not changed.
    expect(c.scene.slides[2]).toBe(scene.slides[2]);
    expect(c.scene.slides[3]).toBe(scene.slides[3]);
    expect(c.scene.slides[4]).toBe(scene.slides[4]);
    expect(c.scene.frame).toBe(scene.frame);
  });

  it('emits the slides as LibreOffice draws them; a shape-cast shadow stays', () => {
    const ordo = emitSlides(scene).slides.map((s) => s.slide);
    const lo = emitSlides(loCompatScene(scene).scene).slides.map((s) => s.slide);
    expect(texts(ordo[0]!)[0]!.style.shadow).toBeDefined();
    expect(texts(lo[0]!)[0]!.style.shadow).toBeUndefined();
    expect(texts(ordo[1]!)[0]!.style.outline).toBeDefined();
    expect(texts(lo[1]!)[0]!.style.outline).toBeUndefined();
    expect(texts(lo[3]!)[0]!.style.shadow).toBeDefined();
    for (const k of [2, 3, 4]) expect(drawingKey(lo[k]!)).toBe(drawingKey(ordo[k]!));
    expect(drawingKey(lo[0]!)).not.toBe(drawingKey(ordo[0]!));
  });

  it('leaves a scene with nothing to change as it is', () => {
    const plain = deck(sp({ id: 2, ...box, txBody: body(para(run('Plain', 'sz="4000"'))) }));
    const c = loCompatScene(plain);
    expect(c.hits.size).toBe(0);
    expect(c.scene).toBe(plain);
  });
});

describe('refitSlide', () => {
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

  it('drops the stored scale of shrinking text only', () => {
    const shrink = text({ autofit: 'shrink', fitScale: { font: 0.7, spacing: 0.9 } });
    const kept = text({ fitScale: { font: 0.7, spacing: 0.9 } });
    const s: Slide = { id: 's', objects: [shrink, kept, text({ autofit: 'shrink' })] };
    const r = refitSlide(s)!;
    expect(r.objects[0]).toMatchObject({ style: { autofit: 'shrink', fontSizePx: 40 } });
    expect((r.objects[0] as TextObject).style.fitScale).toBeUndefined();
    expect(r.objects[1]).toBe(kept);
    expect(shrink.style.fitScale).toEqual({ font: 0.7, spacing: 0.9 });
    expect(refitSlide({ id: 's', objects: [kept] })).toBeUndefined();
  });

  it('compares drawings without object ids', () => {
    const a: Slide = { id: 'a', objects: [text({})], lyricObjectId: 't' };
    const b: Slide = { ...a, id: 'b', objects: [{ ...text({}), id: 'u' }], lyricObjectId: 'u' };
    expect(drawingKey(a)).toBe(drawingKey(b));
    expect(drawingKey(a)).not.toBe(drawingKey({ ...a, objects: [text({ fontSizePx: 41 })] }));
  });
});
