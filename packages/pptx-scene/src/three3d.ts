/**
 * PowerPoint 3-D of shapes, pictures and text bodies (design/27 §15 M9, `3d.md` §3.3). Wave 1 (`conv-seams`)
 * puts the seams in place and makes real 3-D approx, drawn flat (`residual.ts`); `three-model` fills them:
 *
 * - `read3d`: the nearest `a:scene3d` and `a:sp3d` along an element's chain (own → layout → master
 *   placeholder, as `walk.ts` `effectsOf` reads effects) into `Look3dIR`, bounded (lengths 0-200 pt, angles
 *   mod 21,600,000, names against the closed lists of `@ordo/domain` three-names.ts);
 * - `look3dOf`: `Look3dIR` → the stored `look3d` (EMU → logical px by the frame scale, angles in degrees),
 *   written only when `EmitOptions.m9Writes` has 'look3d'.
 *
 * Stubs until then: nothing is read and nothing written, so every 3-D element is drawn flat, which is what
 * LibreOffice's art showed for 63 of the 68 `art:3d` slides and what an older build draws.
 *
 * Pure.
 */
import type { Look3d } from '@ordo/domain';
import type { SlideCtx } from './context.ts';
import { type Box, type EmitCtx, writes } from './emit-ctx.ts';
import type { Chain } from './inherit.ts';
import type { Look3dIR } from './ir.ts';

/** The 3-D an element's chain gives it, or undefined when it has none ordo reads. Stub: none. */
export function read3d(_ctx: SlideCtx, _chain: Chain): Look3dIR | undefined {
  return undefined;
}

/** The stored `look3d` of an object of `box` (logical px), or undefined. Stub: none. */
export function look3dOf(ctx: EmitCtx, l: Look3dIR | undefined, _box: Box): Look3d | undefined {
  if (!l || !writes(ctx, 'look3d')) return undefined;
  return undefined;
}
