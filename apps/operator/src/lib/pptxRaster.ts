/**
 * The words of the pictures of shapes (the owner's Q53, Q57.d, Q67, Q68): what the Reset slide card says about a slide
 * whose many-point shapes were drawn into pictures at import, and the test that finds such a slide. Plain English: the
 * owner's words are "picture" and "shape" (no "raster", no "recipe", no "converter").
 */
import type { Slide } from '@ordo/domain';

/** Whether the slide holds a picture of shapes (an object of origin role 'raster'): Reset slide can bring the shapes back. */
export function holdsRaster(slide: Pick<Slide, 'objects'>): boolean {
  return slide.objects.some((o) => o.origin?.role === 'raster');
}

/** The hint under 'Reset slide from PowerPoint' for a slide that holds a picture of shapes. */
export const RASTER_RESET_HINT =
  'Brings the shapes back as shapes. Shapes too large for ordo stay boxes. The changes you made to imported objects are replaced.';

/** The sentence the confirm dialog of Reset slide adds for such a slide. */
export const RASTER_RESET_CONFIRM =
  'Pictures drawn from shapes become shapes again; shapes too large for ordo stay boxes.';

/** The card of the picture of shapes in the slide panel (what it is, what editing it can do). */
export const RASTER_PICTURE_CARD =
  'A picture of shapes made when the file was imported. Move, resize or delete it. It cannot be edited as shapes, and the words in it are no longer text. Reset slide from PowerPoint brings the shapes back as shapes; shapes too large for ordo stay boxes.';

/** The line of the Re-import dialog (Q67): a whole Re-import draws the pictures again. */
export const RASTER_REIMPORT_LINE =
  'Slides you did not edit that have many-point shapes are drawn into pictures again, also the ones you reset to shapes.';
