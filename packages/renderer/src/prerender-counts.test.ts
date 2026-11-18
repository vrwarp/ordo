import { PICTURE_COUNTS } from '@ordo/domain/prerender.ts';
import { describe, expect, it } from 'vitest';
import { CLAMP } from './clamp.ts';

/*
 * design/29 §1.1: a slide is `count` (pre-rendered) when drawn live it would pass a live-raster bound. The
 * domain decides it (`pictureUnits`) without importing the renderer, so its counts are kept equal to the
 * clamp's here, never copied by hand: when the clamp moves (render-bounds raises the drawn characters to
 * 20,000), the plan moves with it.
 */
describe('pictureUnits counts (design/29 §1.1)', () => {
  it('equal the live clamp', () => {
    expect(PICTURE_COUNTS).toEqual({
      objects: CLAMP.maxObjects,
      pictures: CLAMP.maxImagesPerSlide,
      characters: CLAMP.maxTextChars,
      families: CLAMP.maxRunFamilies,
      sizeScales: CLAMP.maxSizeScales,
    });
  });
});
