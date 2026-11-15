import { LOOK_MAIN } from '@ordo/domain';
import { withDirectDecor } from '../src/decor/index.ts';
import { showcaseSlide } from '../src/decor/test-util.ts';
import { clearEffectCache } from '../src/effects.ts';
import { rasterSlide } from '../src/raster.ts';
import { clearSpriteCache } from '../src/spritecache.ts';
import { fillColor } from '../src/text2d.ts';
import type { GoldenCase } from './areas.ts';

/**
 * Golden cases of decorations (design/27 M9 `ShapeObject.decor`, decor-render), on the 960 x 540 canvas:
 * - 'shape-decor': 60 shapes of every kind a decoration holds (`decor/test-util.ts` `decorShowcase`: presets
 *   with shaded paths, custom paths, a path in pieces, colours and alpha, linear and radial gradients on
 *   turned and mirrored boxes, plain and dashed outlines, 12 shadows) as one decoration, drawn as the outputs
 *   draw it the second time: through its sprite (more than 4 shadowed shapes).
 * - 'shape-decor-equivalence': the same 60 shapes drawn one by one; compared with 'shape-decor' (page.ts
 *   SAME_AS): a decoration draws what its shapes draw (decor/decor.browser.test.ts measures it at 1920 and
 *   3840: at most 2/255 inside shapes).
 * - 'decor-sprite': the decoration drawn shape by shape (`withDirectDecor`), compared with 'shape-decor': its
 *   sprite is a copy of what it draws.
 */

const W = 960;
const H = 540;
const SCALE = W / 1920;

function cold(): void {
  clearEffectCache();
  clearSpriteCache();
}

export const DECOR_CASES: Readonly<Record<string, GoldenCase>> = {
  'shape-decor': (ctx) => {
    cold();
    // Drawn once on a canvas of its own (directly, the first time), then here through the sprite it made.
    const slide = showcaseSlide('decor');
    const first = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
    rasterSlide(first, slide, LOOK_MAIN, SCALE, () => undefined, { isSong: false });
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, slide, LOOK_MAIN, SCALE, () => undefined, { isSong: false });
  },
  'shape-decor-equivalence': (ctx) => {
    cold();
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, showcaseSlide('shapes'), LOOK_MAIN, SCALE, () => undefined, { isSong: false });
  },
  'decor-sprite': (ctx) => {
    cold();
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    withDirectDecor(() =>
      rasterSlide(ctx, showcaseSlide('decor'), LOOK_MAIN, SCALE, () => undefined, { isSong: false }),
    );
  },
};
