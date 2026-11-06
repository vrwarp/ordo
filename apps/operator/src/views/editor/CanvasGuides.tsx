import type { SlideObject } from '@ordo/domain';

/** The deck's area in the 1920x1080 frame (`Presentation.source.native.slideRect`). */
export type SlideRect = { x: number; y: number; w: number; h: number };

/**
 * Guides the slide canvas draws over the objects (M4 item C; design/27 §11 item 4, §15 M4), inside its
 * scaled object layer, listening to nothing:
 * - the overflow indicator: a dashed red edge on every text box whose text does not fit (the rich engine's
 *   `layoutRich(...).overflow`, laid out as the drawers lay it out; shrink-to-fit boxes overflow only past
 *   the engine's smallest fit). The Object panel says "Text does not fit: turn on Shrink text to fit or
 *   enlarge the box" for the selected one;
 * - the 4:3 slide-rect guide: for a deck that is not 16:9, the deck's area (`slideRect`) outlined and the
 *   bars outside it shaded, so a volunteer keeps text inside what PowerPoint showed.
 *
 * Scaffold: draws nothing. Item C.
 */
export function CanvasGuides(_props: {
  objects: readonly SlideObject[];
  slideRect?: SlideRect;
  /** Screen px per logical px (line widths stay 1-2 screen px). */
  scale: number;
}) {
  return null;
}
