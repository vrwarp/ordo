import type { ImageObject, SlideObject } from '@ordo/domain';
import { create } from 'zustand';

/**
 * Cropping a picture (design/27 §11 item 6; M4 item D): numeric first, then handles on the canvas.
 *
 * `CropControl` (Object panel, image section): the four crop shares as percentages (Left, Top, Right,
 * Bottom; negative pads transparent), 'Reset crop', and 'Crop on the slide', which turns the canvas handles on
 * (`useCropMode`); also the mask (None, Ellipse, Rounded) and Flip horizontal / vertical. Each applies
 * `cropPicture`, `maskPicture`, `flipPicture` (actions.ts), one undo step (number fields coalesce per object).
 *
 * `CropHandles` (slide canvas, mounted by `SlideCanvas` over the objects): while `useCropMode` names a
 * picture, the whole picture is drawn faintly around its box and eight handles move the crop shares while
 * the box stays (`cropPicture`, coalesced per drag); Enter or Escape, or a click elsewhere, ends it.
 *
 * Accessibility (design/15): labelled number fields with units, the mask as a radio group, flips as toggle
 * buttons with `aria-pressed`; every handle drag has its numeric field, so the keyboard and a screen reader
 * can do everything. 30 px handles under a finger.
 *
 * Scaffold: renders nothing. Item D.
 */
export function CropControl(_props: { o: ImageObject; readOnly: boolean }) {
  return null;
}

/** Which picture the canvas crop handles are on (one at a time; none by default). */
export const useCropMode = create<{ objectId?: string }>(() => ({}));

/**
 * The canvas crop handles for the picture `useCropMode` names, inside the canvas's scaled object layer
 * (`objects` are the ones the canvas draws; `scale` is screen px per logical px).
 *
 * Scaffold: draws nothing. Item D.
 */
export function CropHandles(_props: { objects: readonly SlideObject[]; scale: number; readOnly: boolean }) {
  return null;
}
