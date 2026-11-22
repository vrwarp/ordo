/**
 * What a slide file draws, whole (store-2 step 3b, the Q54 data-safety items SU1): the head row of a slide of up to
 * 20,000 objects keeps the FULL lists of media ids, shape files and font families (`slideUsesAll`), bounded by
 * `HEAD_USES_MAX` and refused beyond it, never cut; `slideUses` (the stand-in's record) still slices to
 * `PRERENDER_LIMITS`, because a longer list makes `Slide.prerender` fail its schema and the record is dropped.
 */
import { describe, expect, it } from 'vitest';
import { slideUses } from './prerender.ts';
import { PRERENDER_LIMITS, type Slide, type SlideObject } from './schemas.ts';
import { HEAD_USES_MAX, SLIDE_FILE_LIMITS, slideUsesAll } from './slidefile.ts';

const hex = (n: number) => n.toString(16).padStart(64, '0');
const box = { x: 0, y: 0, w: 10, h: 10, rotation: 0 };
const shapeWithFile = (i: number): SlideObject =>
  ({
    id: `g${i}`,
    type: 'shape',
    box,
    shape: 'rect',
    fill: { r: 1, g: 2, b: 3, a: 1 },
    opacity: 1,
    radius: 0,
    geom: { ref: hex(i + 1) },
  }) as SlideObject;
const imageOf = (i: number): SlideObject =>
  ({
    id: `i${i}`,
    type: 'image',
    box,
    mediaId: `media-${i}`,
    fit: 'contain',
    opacity: 1,
    radius: 0,
  }) as SlideObject;
const textIn = (i: number, family: string): SlideObject =>
  ({ id: `t${i}`, type: 'text', box, text: 'x', style: { fontFamily: family }, opacity: 1 }) as SlideObject;
const slide = (objects: SlideObject[]): Slide => ({ id: 's', objects }) as Slide;

describe('slideUsesAll (SU1)', () => {
  it('returns every shape file of a slide with 1,357 distinct ones, where slideUses keeps the first 1,000', () => {
    const s = slide(Array.from({ length: 1357 }, (_, i) => shapeWithFile(i)));
    const all = slideUsesAll(s);
    expect(all.files).toHaveLength(1357);
    expect(new Set(all.files).size).toBe(1357);
    expect(all.files[0]).toBe(hex(1));
    expect(all.files[1356]).toBe(hex(1357));
    expect(slideUses(s).files).toHaveLength(PRERENDER_LIMITS.files);
  });

  it('returns every media id and every font family past their cuts too', () => {
    const objects = [
      ...Array.from({ length: 1100 }, (_, i) => imageOf(i)),
      ...Array.from({ length: 70 }, (_, i) => textIn(i, `Family ${i}`)),
    ];
    const s = slide(objects);
    const all = slideUsesAll(s);
    expect(all.media).toHaveLength(1100);
    expect(all.fonts).toHaveLength(70);
    expect(slideUses(s).media).toHaveLength(PRERENDER_LIMITS.media);
    expect(slideUses(s).fonts).toHaveLength(PRERENDER_LIMITS.fonts);
  });

  it('is slideUses where nothing is cut: the same lists in the same order', () => {
    const s = slide([imageOf(1), shapeWithFile(2), textIn(3, 'Carlito'), imageOf(4), shapeWithFile(5)]);
    expect(slideUsesAll(s)).toEqual(slideUses(s));
  });

  it('HEAD_USES_MAX is what a 20,000-object slide can name, plus its background and imported picture; PRERENDER_LIMITS stay', () => {
    expect(HEAD_USES_MAX).toEqual({ media: 20_002, files: 20_000, fonts: 2_048 });
    expect(HEAD_USES_MAX.files).toBe(SLIDE_FILE_LIMITS.objects);
    expect(HEAD_USES_MAX.media).toBe(SLIDE_FILE_LIMITS.objects + 2);
    expect(PRERENDER_LIMITS).toMatchObject({ media: 1000, files: 1000, fonts: 64 });
  });
});
