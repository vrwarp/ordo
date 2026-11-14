import { LOOK_LOWER_THIRD, LOOK_MAIN, type Slide, type SlideObject } from '@ordo/domain';
import { m9Slide } from '@ordo/domain/m9.test-util.ts';
import { describe, expect, it } from 'vitest';
import { slideJobCost } from './geombudget.ts';
import { jobFontFamilies } from './raster.ts';

/*
 * What a slide job draws besides its geometry (M6 merge re-review, design/27 §13): the text and pictures the
 * raster estimate reads (`slideJobCost`), and the font families of M9's objects a job waits for.
 */

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });
const white = { r: 255, g: 255, b: 255, a: 1 };
const style = (fontSizePx: number, extra: object = {}) =>
  ({ fontFamily: 'Inter', fontSizePx, color: white, ...extra }) as never;
const slide = (objects: SlideObject[]): Slide => ({ id: 's', objects }) as Slide;

describe('a slide job’s text and pictures (raster estimate)', () => {
  it('counts the characters drawn, the glyphs drawn blurred and the pictures by how they are drawn', () => {
    const shadow = { dx: 2, dy: 2, blur: 4, color: { r: 0, g: 0, b: 0, a: 0.5 } };
    const s = slide([
      // 13 inked characters (spaces not counted), 2 of them blurred by a run shadow at 100 px.
      {
        id: 't',
        type: 'text',
        box: box(0, 0, 1000, 300),
        text: 'Amazing grace!',
        style: style(50),
        opacity: 1,
        runs: [{ start: 0, end: 2, sizeScale: 2, shadow }],
      } as SlideObject,
      // A box shadow blurs every glyph, but a run's `shadow: null` turns it off.
      {
        id: 'u',
        type: 'text',
        box: box(0, 400, 1000, 300),
        text: 'ab cd',
        style: style(40, { shadow }),
        opacity: 1,
        runs: [{ start: 3, end: 5, shadow: null }],
      } as SlideObject,
      // Invisible text counts nothing.
      {
        id: 'v',
        type: 'text',
        box: box(0, 0, 10, 10),
        text: 'zzz',
        style: style(40),
        opacity: 0,
      } as SlideObject,
      // A prepared picture (copied 1:1) of a quarter slide, cut to the frame; a turned one drawn from its source.
      {
        id: 'p',
        type: 'image',
        box: box(1440, 810, 960, 540),
        mediaId: 'm',
        fit: 'cover',
        opacity: 1,
        radius: 0,
      } as SlideObject,
      {
        id: 'q',
        type: 'image',
        box: { ...box(0, 0, 192, 108), rotation: 10 },
        mediaId: 'm',
        fit: 'cover',
        opacity: 1,
        radius: 0,
      } as SlideObject,
    ]);
    const c = slideJobCost(s, LOOK_MAIN);
    const area = 1920 * 1080;
    expect(c.chars).toBe(13 + 4);
    expect(c.textEffects).toBeCloseTo((2 * 100 * 100 + 2 * 40 * 40) / area, 9);
    expect(c.pictures).toBeCloseTo(0.0625, 9);
    expect(c.sourcePictures).toBeCloseTo(0.01, 9);
    // Memoised with the drawing budget; a look that draws lyric bands draws none of it.
    expect(slideJobCost(s, LOOK_MAIN)).toBe(c);
    expect(slideJobCost(s, LOOK_LOWER_THIRD)).toEqual({ units: 0, effects: 0 });
    // A slide's reference picture (contain-fitted over the frame) is a whole slide's copy.
    const ref = { ...slide([]), imported: { mediaId: 'page' } } as unknown as Slide;
    const r = slideJobCost(ref, LOOK_MAIN);
    expect(r.pictures ?? 0).toBeLessThanOrEqual(1);
  });

  it('never throws on malformed stored text or pictures', () => {
    const bad = slide([
      {
        id: 'x',
        type: 'text',
        box: box(0, 0, 1, 1),
        text: 'abc',
        style: {},
        opacity: 1,
        runs: [{}],
      } as never,
      { id: 'y', type: 'image', box: box(Number.NaN, 0, 1e12, 5), mediaId: 'm', opacity: 1 } as never,
      {
        id: 'z',
        type: 'text',
        box: box(0, 0, 1, 1),
        text: 7,
        style: { fontSizePx: -4 },
        opacity: 1,
      } as never,
    ]);
    const c = slideJobCost(bad, LOOK_MAIN);
    for (const v of [c.chars, c.textEffects, c.pictures, c.sourcePictures])
      expect(Number.isFinite(v ?? 0)).toBe(true);
  });
});

describe('the font families of a slide job', () => {
  it('include the families of tables, charts and vector pictures (M9), as every text style’s', () => {
    const s = m9Slide();
    const families = jobFontFamilies({
      kind: 'slide',
      key: 'k',
      layer: 'slide',
      slide: s,
      look: LOOK_MAIN,
      images: {},
      cueIndex: 0,
      isSong: false,
    } as never);
    // m9.test-util.ts: the table's cell styles, the chart's text and the vector picture's fonts.
    for (const f of ['malgun gothic', 'arial', 'symbol']) expect(families).toContain(f);
  });
});
