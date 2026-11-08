import type { TextObject } from '@ordo/domain';
import { currentFontEnv, isRichText } from '@ordo/renderer';

/*
 * How the editor's canvas rasterizes a text object into its cached offscreen canvas (design/27 §7.4): with
 * the outputs' own functions, so the editor is WYSIWYG with them.
 */

/** Logical px the cached text canvas extends past the box on every side (outlines, shadows, overflow). */
export const TEXT_MARGIN = 80;
/** Largest side of a cached text canvas, device px. */
export const MAX_TEXT_CANVAS = 8192;

/**
 * Device px per logical px a text object's cached canvas is drawn at. Legacy text: 1, exactly as before
 * the rich engine. Rich text: the screen's density (the stage scale × devicePixelRatio), so it is crisp on
 * HiDPI screens; its layout is in logical px, so the density never moves a line break. Bounded so the
 * canvas stays within MAX_TEXT_CANVAS on each side.
 */
export function textDensity(o: TextObject, screen: number): number {
  if (!isRichText(o)) return 1;
  const d = Number.isFinite(screen) && screen > 0 ? screen : 1;
  const side = (v: number) => (Number.isFinite(v) ? Math.abs(v) : 0) + 2 * TEXT_MARGIN;
  return Math.max(0.05, Math.min(d, 8, MAX_TEXT_CANVAS / Math.max(side(o.box.w), side(o.box.h))));
}

/**
 * The cache key of a text object's raster: its box size, the image and font tick, the density and the font
 * generation (a font that loads later gives the rich engine a new generation and so a new raster).
 */
export function textRasterKey(o: TextObject, tick: number, density: number): string {
  return `${o.box.w}x${o.box.h}:${tick}:${density}:${currentFontEnv().generation}`;
}
