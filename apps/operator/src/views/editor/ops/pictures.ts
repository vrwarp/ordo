import type { ImageCrop, ImageObject, Media } from '@ordo/domain';

/*
 * Picture ops (M4 item D; design/27 §11 item 6 "Pictures", §3.1 ImageObject). Pure functions over one
 * ImageObject, applied through the actions in `../actions.ts`; each returns `o` itself when it changes
 * nothing. A locked object (art) takes none of them.
 *
 * `ImageObject.crop` is in the schema and drawn everywhere since M1/M3. `flipH`, `flipV` and `mask` (a
 * `ShapeGeom`, design/27 §3.1) are not yet: item D adds them to `packages/domain/src/schemas.ts`, the
 * `clampObject` whitelist, the drawers (`drawImageFit` and the editor's image node; the scene planes already
 * read them, `packages/renderer/src/scene.ts`) and the converter's emission in the same change (design/27
 * §3.2 "Each field is wired everywhere it is read"). The types below are the editor's view of them.
 */

/** A picture's mask, the presets the editor offers ('Mask: none, ellipse, rounded'): design/27's `ShapeGeom`. */
export type PictureMask = {
  preset: 'ellipse' | 'roundRect';
  /** Adjustments as [name, value] pairs, POI's: roundRect's 'adj' is the corner radius (default 16667). */
  adj?: [string, number][];
};

/** A flip change: a key that is present sets it (false removes it). */
export type PictureFlip = { flipH?: boolean; flipV?: boolean };

/** A picture and its pixel size; an unknown size (no `width`/`height`) is treated as the box's aspect. */
export type PictureSize = Pick<Media, 'id' | 'width' | 'height'>;

/**
 * Crop the picture while its box stays (the numeric fields and the canvas crop handles): `crop` is the share
 * cut from each side, -1..1, a negative share padding that side transparent; `l + r` and `t + b` stay below
 * 1. `undefined` removes the crop (the whole picture).
 *
 * Scaffold: returns `o`. Item D.
 */
export function setCrop(o: ImageObject, _crop: ImageCrop | undefined): ImageObject {
  return o;
}

/**
 * Mask the picture with an ellipse or a rounded rectangle, or remove the mask (`undefined`). A legacy
 * `radius` stays what an older build draws.
 *
 * Scaffold: returns `o`. Item D.
 */
export function setMask(o: ImageObject, _mask: PictureMask | undefined): ImageObject {
  return o;
}

/**
 * Flip the picture horizontally or vertically inside its box (the box, crop and mask stay).
 *
 * Scaffold: returns `o`. Item D.
 */
export function setFlip(o: ImageObject, _flip: PictureFlip): ImageObject {
  return o;
}

/**
 * 'Replace' keeps the look, not the crop numbers (design/27 §11 item 6): the new picture is cover-cropped to
 * the box's aspect and centred on the old crop's centre (clamped to the picture), so a picture of another
 * aspect is never distorted. Box, mask, flip, opacity, radius, stroke and shadow are kept. A picture with
 * `fit: 'contain' | 'cover'` keeps its fit and drops the crop. A video's poster (`play`) keeps its clip.
 *
 * Scaffold: returns `o` (the Object panel's 'Replace' still drops the crop itself, as M3 left it). Item D
 * switches the panel and `replaceBackground` (item E) to this rule.
 */
export function replacePicture(o: ImageObject, _next: PictureSize): ImageObject {
  return o;
}
