/**
 * The importer's side of the pictures of shapes (Q53, C-SR6, C-SR11): `putBackRaster` gives a slide the shapes a picture
 * was to draw when the picture could not be made, so a failure never loses a shape, and the counts an import reports.
 *
 * Pure (the hub's job, the harness and the demo call it): values in, a slide out. It reads only the converter's record
 * of a picture (`EmittedRaster`: the picture's object ids and the objects as they are without it).
 */
import type { Slide, SlideObject } from '@ordo/domain';
import type { EmittedRaster } from '@ordo/pptx-scene/raster-emit.ts';

/**
 * `slide` with the picture `raster` stands for replaced by the objects it was drawn from, at the picture's place in z order
 * and with the origin the picture had where theirs is absent (never the picture's `raster` field: they are shapes and
 * text again). Nothing else changes; a slide that holds no such picture (an edit deleted it) comes back as it is.
 */
export function putBackRaster(slide: Slide, raster: Pick<EmittedRaster, 'uses' | 'objects'>): Slide {
  const at = slide.objects.findIndex((o) => raster.uses.includes(o.id));
  if (at < 0) return slide;
  const picture = slide.objects[at]!;
  const { raster: _drop, ...origin } = picture.origin ?? { src: 'pptx' };
  const back: SlideObject[] = raster.objects.map((o) => ({
    ...o,
    ...(o.origin ? {} : { origin: { ...origin } }),
  })) as SlideObject[];
  return { ...slide, objects: [...slide.objects.slice(0, at), ...back, ...slide.objects.slice(at + 1)] };
}

/** What an import's picture step came to (`PptxNativeResult.rasters`, C-SR11), the operator's report reads it. */
export interface RasterCounts {
  /** Many-point shapes (and shapes past a converter limit) the deck holds on slides that may take a picture. */
  candidates: number;
  /** Shapes drawn into pictures (the many-point shapes and the small ones drawn with them). */
  shapes: number;
  /** Pictures planned, stored (made here), reused (found already stored) and put back (not made). */
  pictures: number;
  stored: number;
  reused: number;
  putBack: number;
  /** Pictured shapes that carry words. */
  words: number;
  /** Why this hub made none, when it could not ('no-maker': neither Chromium nor LibreOffice; 'libreoffice': LibreOffice's art, as before). */
  off?: 'no-maker' | 'libreoffice';
  /** Candidates left as they were, by why. */
  skipped: { text: number; effects: number; fill: number; anchored: number; other: number };
  /** Short named reasons the plan or the picture step gave (a few, deduplicated). */
  reasons: string[];
}
