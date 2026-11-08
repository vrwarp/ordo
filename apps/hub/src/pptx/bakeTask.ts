/**
 * Worker side of the `pptx-bake` pool task (design/27 §4 "Pictures", §15 M6 "Recolour and tile bakes"): one
 * derived picture, a recoloured picture or a tiled fill, from its decoded source (`@ordo/pptx-scene`
 * `applyBake`), encoded as a PNG here so its pixels never cross back to the event loop. Bounded by
 * `BAKE_LIMITS` (16 MP in, 16 MP out) and the pool's timeout and heap.
 */
import { applyBake, BAKE_LIMITS, checkSize, hasAlpha } from '@ordo/pptx-scene/bake.ts';
import { encodePng } from './art.ts';
import type { BakeTaskInput, BakeTaskOutput, RasterImage } from './shared.ts';

/** The PNG of an RGBA raster: RGB when every pixel is opaque (smaller, and drawn the same). */
function png(img: { width: number; height: number; data: Uint8Array }, alpha: boolean): Uint8Array {
  if (alpha) return encodePng({ ...img, channels: 4 });
  const n = img.width * img.height;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0, o = 0; i < n * 4; i += 4, o += 3) {
    rgb[o] = img.data[i]!;
    rgb[o + 1] = img.data[i + 1]!;
    rgb[o + 2] = img.data[i + 2]!;
  }
  const out: RasterImage = { width: img.width, height: img.height, channels: 3, data: rgb };
  return encodePng(out);
}

export function bakeTask(input: BakeTaskInput): BakeTaskOutput {
  const src = input.source;
  if (src.channels !== 4) throw new Error('a bake source must be RGBA');
  checkSize(src.width, src.height, 'source picture');
  if (input.out) checkSize(input.out.width, input.out.height, 'baked picture');
  if (!(src.data instanceof Uint8Array) || src.data.length !== src.width * src.height * 4)
    throw new Error('the source picture has the wrong number of pixels');
  const recolor = input.bake.recolor?.slice(0, BAKE_LIMITS.effects);
  const bake = { ...(recolor ? { recolor } : {}), ...(input.bake.tile ? { tile: input.bake.tile } : {}) };
  const out = applyBake(
    { width: src.width, height: src.height, data: src.data },
    bake,
    input.out,
    input.format,
  );
  const alpha = hasAlpha(out);
  return { png: png(out, alpha), width: out.width, height: out.height, alpha };
}
