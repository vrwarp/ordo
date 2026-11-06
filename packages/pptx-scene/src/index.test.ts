import { Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { emitSlides, MEDIA_PREFIX, parseDeck } from './index.ts';
import { body, buildDeck, imageRel, para, pic, pictureBg, run, solid, solidBg, sp } from './test-util.ts';

const IN = 914_400;
const PT = 12_700;

/** The simplest deck M1 draws: a solid background, a text box, a rect and a stretched picture. */
function simpleDeck() {
  return buildDeck({
    slides: [
      {
        bg: solidBg('102030'),
        rels: [imageRel('rId2', 'image1.png')],
        shapes:
          sp({ id: 2, name: 'Box', x: IN, y: IN, cx: 2 * IN, cy: IN, fill: solid('FF0000') }) +
          sp({
            id: 3,
            name: 'Text',
            txBox: true,
            x: 0,
            y: 4 * IN,
            cx: 6 * IN,
            cy: IN,
            fill: '<a:noFill/>',
            txBody: body(
              para(
                run('Amazing grace', 'sz="4000" b="1"', `${solid('FFFF00')}<a:latin typeface="Georgia"/>`),
                'algn="ctr"',
              ),
              'anchor="ctr"',
            ),
          }) +
          pic({ id: 4, x: 7 * IN, y: 0, cx: 3 * IN, cy: 2 * IN, rId: 'rId2' }),
      },
    ],
  });
}

describe('parseDeck → emitSlides', () => {
  it('draws the simplest deck as valid ordo objects', () => {
    const scene = parseDeck(simpleDeck());
    expect(scene.slides).toHaveLength(1);
    const s = scene.slides[0]!;
    expect(s.error).toBeUndefined();
    expect(s.background.fill).toEqual({ kind: 'solid', color: { r: 0x10, g: 0x20, b: 0x30, a: 1 } });
    expect(s.elements.map((e) => e.kind)).toEqual(['shape', 'shape', 'picture']);
    expect(s.classification).toEqual({ tier: 'T1', class: 'native', reasons: [] });

    const out = emitSlides(scene);
    expect(out.slideRect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(out.media).toEqual([{ id: `${MEDIA_PREFIX}ppt/media/image1.png`, part: 'ppt/media/image1.png' }]);
    const e = out.slides[0]!;
    expect(e.shown).toBe(0);
    expect(e.hidden).toBe(false);
    expect(e.digest).toMatch(/^[0-9a-f]{16}$/);

    // Every emitted slide is an ordinary ordo slide, unchanged by the schema.
    const parsed = Slide.parse(e.slide);
    expect(parsed).toEqual(e.slide);

    const [bg, box, text, image] = e.slide.objects;
    expect(bg).toMatchObject({
      type: 'shape',
      shape: 'rect',
      box: { x: 0, y: 0, w: 1920, h: 1080 },
      fill: { r: 16, g: 32, b: 48, a: 1 },
    });
    expect(box).toMatchObject({ type: 'shape', shape: 'rect', fill: { r: 255, g: 0, b: 0, a: 1 } });
    expect(box!.box.x).toBeCloseTo(144);
    expect(box!.box.w).toBeCloseTo(288);
    expect(text).toMatchObject({
      type: 'text',
      text: 'Amazing grace',
      style: {
        fontFamily: 'Georgia',
        fontWeight: 700,
        fontSizePx: 80, // 40 pt × 2 px
        color: { r: 255, g: 255, b: 0, a: 1 },
        align: 'center',
        valign: 'middle',
      },
    });
    expect(text!.type === 'text' && text!.style.padding).toBeCloseTo((45_720 / PT) * 2);
    expect(image).toMatchObject({
      type: 'image',
      mediaId: `${MEDIA_PREFIX}ppt/media/image1.png`,
      fit: 'stretch',
    });
    expect(image!.box.x).toBeCloseTo(1008);
    expect(image!.box.h).toBeCloseTo(288);
    expect(e.slide.lyricObjectId).toBe(text!.id);
  });

  it('gives each slide its shown index and quarantines a slide it cannot read', () => {
    const parts = buildDeck({ slides: [{}, { hidden: true }, {}, {}] });
    parts.set('ppt/slides/slide3.xml', new TextEncoder().encode('<!DOCTYPE p:sld><p:sld/>'));
    const scene = parseDeck(parts);
    expect(scene.slides.map((s) => [s.index, s.shown, s.hidden])).toEqual([
      [0, 0, false],
      [1, undefined, true],
      [2, 1, false],
      [3, 2, false],
    ]);
    expect(scene.slides[2]!.error).toMatch(/DOCTYPE/);
    expect(scene.slides[2]!.classification.class).toBe('picture');
    const out = emitSlides(scene);
    expect(out.slides.map((s) => s.slide.objects.length)).toEqual([1, 1, 0, 1]); // the master's bg1 background
    for (const s of out.slides) Slide.parse(s.slide);
  });

  it('uses a stretched 16:9 picture background as the slide background', () => {
    const scene = parseDeck(
      buildDeck({ slides: [{ bg: pictureBg('rId2'), rels: [imageRel('rId2', 'photo.png')] }] }),
    );
    const out = emitSlides(scene, { mediaId: (part) => `m-${part.split('/').pop()}` });
    expect(out.slides[0]!.slide.backgroundMediaId).toBe('m-photo.png');
    expect(out.slides[0]!.slide.objects).toEqual([]);
  });

  it('pillarboxes a 4:3 deck and keeps solid backgrounds on the slide area when asked', () => {
    const scene = parseDeck(
      buildDeck({
        size: { cx: 9_144_000, cy: 6_858_000 },
        slides: [
          { bg: solidBg('FFFFFF'), shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: solid('000000') }) },
        ],
      }),
    );
    const out = emitSlides(scene, { extendBackgrounds: false });
    expect(out.slideRect.x).toBeCloseTo(240);
    const [bg, box] = out.slides[0]!.slide.objects;
    expect(bg!.box.x).toBeCloseTo(240);
    expect(bg!.box.w).toBeCloseTo(1440);
    expect(box!.box.x).toBeCloseTo(240);
    expect(box!.box.w).toBeCloseTo(144);
  });

  it('draws master and layout decorations under the slide, unless showMasterSp="0"', () => {
    const deco = sp({ id: 9, x: 0, y: 0, cx: IN, cy: IN, fill: solid('00FF00') });
    const parts = (attrs?: string) =>
      buildDeck({
        master: { shapes: deco },
        slides: [{ attrs, shapes: sp({ id: 2, x: IN, y: IN, cx: IN, cy: IN, fill: solid('0000FF') }) }],
      });
    expect(parseDeck(parts()).slides[0]!.elements.map((e) => e.from)).toEqual(['master', 'slide']);
    expect(parseDeck(parts('showMasterSp="0"')).slides[0]!.elements.map((e) => e.from)).toEqual(['slide']);
  });

  it('throws only when the deck has no presentation part', () => {
    expect(() => parseDeck(new Map())).toThrow(/presentation/);
  });
});
