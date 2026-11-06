import type { Presentation } from '@ordo/domain';
import type { PictureSize } from './pictures.ts';

/*
 * Slide and presentation ops (M4 item E; design/27 §11 items 7-11). Each is one undo step through the
 * actions in `../actions.ts` and returns `p` itself when nothing changes.
 */

/** Find options: `case` matches case; `wholeWord` matches only whole words (Unicode letters and digits). */
export type FindOptions = { case?: boolean; wholeWord?: boolean };

/** One match: a text object of a slide and the offsets of the matched text in its `text`. */
export type TextMatch = { slideId: string; objectId: string; start: number; end: number };

/**
 * Every match of `find` in the presentation's text objects, in authoring order, hidden slides included
 * (the dialog's '3 matches on 2 slides'). Matches are in `TextObject.text`, what the textarea shows, so the
 * automatic numbers `readableText` writes are not matched. Locked objects are not searched (their text is
 * read-only). An empty `find` matches nothing.
 *
 * Scaffold: no matches. Item E.
 */
export function findText(_p: Presentation, _find: string, _opts: FindOptions = {}): TextMatch[] {
  return [];
}

/**
 * Find and replace across the presentation (design/27 §11 item 8): every match of `findText` replaced by
 * `repl` through the text ops' `editText` rule, so formatting stays (the replacement takes the style of the
 * text it replaces: a bold date stays bold). One change, one undo step; `replaced` counts the matches.
 *
 * Scaffold: returns `p`, nothing replaced. Item E.
 */
export function findReplace(
  p: Presentation,
  _find: string,
  _repl: string,
  _opts: FindOptions = {},
): { p: Presentation; replaced: number } {
  return { p, replaced: 0 };
}

/**
 * Hide or unhide a slide (design/27 §9, §11 item 9): `Slide.hidden` set, or removed when false. Its cue is
 * flagged hidden: Next, Prev, auto-advance and onEnd skip it; a click in the slide grid shows it. The editor
 * dims it in the slide list.
 *
 * Scaffold: returns `p`. Item E.
 */
export function hideSlide(p: Presentation, _slideId: string, _hidden: boolean): Presentation {
  return p;
}

/** 'Replace background on this slide' or 'on all slides using it'. */
export type BackgroundScope = 'slide' | 'all';

/**
 * Replace a slide's background with `media` (design/27 §11 item 7), for sermon-series art. The slide's
 * background is its `backgroundMediaId`, else the presentation's, else its bottom ImageObject with
 * `origin.role: 'bg'`. Scope 'all' rewrites every slide using that same background picture, and the
 * presentation's `backgroundMediaId` when it is that picture; 'slide' only this slide (a slide that used the
 * presentation's background gets its own `backgroundMediaId`). `role: 'bg'` pictures are re-cropped by the
 * picture replace rule (`replacePicture`), so a picture of another aspect is never distorted, and the
 * cover-fit `backgroundMediaId` never is. Hybrid slides change too: their backgrounds are never in the art.
 * One undo step.
 *
 * Scaffold: returns `p`. Item E.
 */
export function replaceBackground(
  p: Presentation,
  _slideId: string,
  _media: PictureSize,
  _scope: BackgroundScope,
): Presentation {
  return p;
}

/** An object of another slide that 'Apply to similar boxes' would restyle. */
export type SimilarObject = { slideId: string; objectId: string };

/**
 * The boxes similar to `objectId` (design/27 §11 item 10): text objects of other slides with the same
 * `origin.ph`, else the same `origin.role` and master `shapeId` (PowerPoint's placeholder and layout
 * shapes). Locked objects are left out. For the confirmation ('Apply to 12 boxes on 12 slides?').
 *
 * Scaffold: none. Item E.
 */
export function similarObjects(_p: Presentation, _slideId: string, _objectId: string): SimilarObject[] {
  return [];
}

/**
 * 'Apply this box's style to similar boxes' (design/27 §11 item 10; it replaces master editing): every
 * `similarObjects` box takes this box's style and paragraph styles, keeping its own text and runs. One undo
 * step; `changed` counts the boxes that changed.
 *
 * Scaffold: returns `p`, nothing changed. Item E.
 */
export function applyStyleToSimilar(
  p: Presentation,
  _slideId: string,
  _objectId: string,
): { p: Presentation; changed: number } {
  return { p, changed: 0 };
}

/**
 * 'New slide like this' (design/27 §11 item 11): a copy of the slide right after it (`cloneSlide`: fresh ids,
 * no digest) with the text of its text objects cleared, keeping each box's style and its first paragraph's
 * style and first run's formatting, so a new verse or announcement is typed in the same look. Notes are not
 * copied. `id`: the new slide (the editor selects it).
 *
 * Scaffold: returns `p` and no slide. Item E.
 */
export function newSlideLike(p: Presentation, _slideId: string): { p: Presentation; id?: string } {
  return { p };
}

/**
 * 'Use as background' (design/27 §11 item 6): a full-slide picture moved to the slide's
 * `backgroundMediaId` (the picture object removed), so the background pickers and `replaceBackground` handle
 * it. Only for a picture that covers the whole slide.
 *
 * Scaffold: returns `p`. Item E.
 */
export function useAsBackground(p: Presentation, _slideId: string, _objectId: string): Presentation {
  return p;
}
