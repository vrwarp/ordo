import type { Box, ImageCrop, ImageObject, Presentation, SlideObject, TextObject } from '@ordo/domain';
import { change, currentObjects, selectObjects, selectSlide, useEditor } from './editorStore.ts';
import {
  applyStyleToSimilar,
  type BackgroundMedia,
  type BackgroundScope,
  clearSlideBackground,
  deleteObjects,
  duplicateObjects,
  editText,
  type FindOptions,
  findReplace,
  formatRange,
  groupBox,
  hideSlide,
  moveObjects,
  newSlideLike,
  type ParaPatch,
  type PictureFlip,
  type PictureMask,
  type PictureSize,
  refitText,
  reorderObjects,
  replaceBackground,
  replaceBackgroundOf,
  replacePicture,
  resizeRange,
  type RunPatch,
  runOverrides,
  setCrop,
  setFlip,
  setMask,
  setParas,
  textOnSlide,
  transformGroup,
  ungroup,
  useAsBackground,
  withObject,
  withSlide,
} from './ops/index.ts';
import type { ZOrder } from './ops.ts';

/*
 * The M4 ops wired into the editor store (M4.md): each action applies one op to the open presentation through
 * `change()`, so it is one undo step (200 deep; coalesced with the next one of the same key within 800 ms
 * where a key is given), it marks the draft unsaved and saves with the presentation (`save()`: a PUT with
 * the base rev, 409 and 423 handled there), and it records nothing when the op changes nothing (the ops
 * return their input then). Actions read the open slide and the selection from the store. Like `change()`,
 * they do not check the read-only lock: the panels disable their controls when the presentation is locked.
 *
 * Each item owns its block; add actions to your own block only.
 */

/** The open slide's id, or undefined when nothing is open. */
function openSlide(): string | undefined {
  const s = useEditor.getState();
  return s.draft ? s.slideId : undefined;
}

/**
 * Apply an object-level op to one object of the open slide. A locked object (PowerPoint art, SmartArt, table
 * grids) is left alone: its text, geometry and picture are read-only (design/27 §11 "Locked objects").
 */
function onObject(objectId: string, fn: (o: SlideObject) => SlideObject, key?: string): void {
  const slideId = openSlide();
  if (!slideId) return;
  change((p) => withObject(p, slideId, objectId, (o) => (o.locked ? o : fn(o))), key);
}
const onText = (objectId: string, fn: (o: TextObject) => TextObject, key?: string) =>
  onObject(objectId, (o) => (o.type === 'text' ? fn(o) : o), key);
const onImage = (objectId: string, fn: (o: ImageObject) => ImageObject, key?: string) =>
  onObject(objectId, (o) => (o.type === 'image' ? fn(o) : o), key);

// ---- A: text ops -------------------------------------------------------------------------------------

/** The textarea's edit of a text object (typing coalesces per object). */
export function typeText(objectId: string, next: string, caret?: number): void {
  onText(objectId, (o) => editText(o, next, caret), `text:${objectId}`);
}

/**
 * A format op on a text object of the open slide (locked objects left alone). On the lyric object of a
 * presentation with a theme it also marks the theme override paths `overrides` on the slide (`runs.color`,
 * `runs.sizeScale`, ...: ops/text.ts `runOverrides`), so the next theme keeps what the volunteer formatted
 * (design/27 §11 "Themes"), as the Object panel marks `style.*` for the box style.
 */
function onFormat(objectId: string, fn: (o: TextObject) => TextObject, overrides: string[], key?: string) {
  const slideId = openSlide();
  if (!slideId) return;
  change((p) => withSlide(p, slideId, (s) => textOnSlide(s, objectId, fn, p.themeId ? overrides : [])), key);
}

/** The format bar: format the selection `[start, end)` of a text object. */
export function formatSelection(objectId: string, start: number, end: number, patch: RunPatch): void {
  onFormat(objectId, (o) => formatRange(o, start, end, patch), runOverrides(patch));
}

/** The format bar's Size ±: scale the selection's sizes (repeated clicks coalesce). */
export function resizeSelection(objectId: string, start: number, end: number, factor: number): void {
  onFormat(
    objectId,
    (o) => resizeRange(o, start, end, factor),
    runOverrides({ sizeScale: factor }),
    `size:${objectId}`,
  );
}

/**
 * The paragraph strip: style the paragraphs the selection touches. `key` coalesces a field changed step by
 * step (a number field's arrows), e.g. `spaceBeforePx`.
 */
export function setParagraphs(
  objectId: string,
  start: number,
  end: number,
  patch: ParaPatch,
  key?: string,
): void {
  onText(objectId, (o) => setParas(o, start, end, patch), key ? `paras:${objectId}:${key}` : undefined);
}

/** 'Re-fit text'. */
export function refit(objectId: string): void {
  onText(objectId, refitText);
}

// ---- B: group ops (on the store's selection, `objectIds`) -------------------------------------------

function onSelection(
  fn: (p: Presentation, slideId: string, ids: string[]) => Presentation,
  key?: string,
): void {
  const s = useEditor.getState();
  const slideId = openSlide();
  if (!slideId || !s.objectIds.length) return;
  const ids = [...s.objectIds];
  change((p) => fn(p, slideId, ids), key);
}

/** Move the selection (a drag, or nudges, which coalesce). */
export function moveSelection(dx: number, dy: number): void {
  const ids = useEditor.getState().objectIds;
  onSelection((p, slideId, sel) => moveObjects(p, slideId, sel, dx, dy), `nudge:${ids.join(',')}`);
}

/** A drag of the selection on the canvas: one undo step per drag (nudges coalesce, drags do not). */
export function dragSelection(dx: number, dy: number): void {
  onSelection((p, slideId, ids) => moveObjects(p, slideId, ids, dx, dy));
}

/** The Transformer over the selection: its box went from `from` to `to`. */
export function transformSelection(from: Box, to: Box): void {
  onSelection((p, slideId, ids) => transformGroup(p, slideId, ids, from, to));
}

/**
 * The Object panel's box editor on a multi-object selection: the group box (`groupBox`) set to `to`, every
 * member scaled and moved with it (a `to.rotation` turns them about its centre).
 */
export function setSelectionBox(to: Box): void {
  const from = groupBox(currentObjects());
  if (from) transformSelection(from, to);
}

/** Delete the selection. */
export function deleteSelection(): void {
  onSelection((p, slideId, ids) => deleteObjects(p, slideId, ids));
  const s = useEditor.getState();
  if (s.draft) selectObjects(s.objectIds);
}

/** Duplicate the selection; the copies become the selection (the primary's copy the primary). */
export function duplicateSelection(): void {
  const { objectIds, objectId } = useEditor.getState();
  let copies: string[] = [];
  onSelection((p, slideId, ids) => {
    const r = duplicateObjects(p, slideId, ids);
    copies = r.ids;
    return r.p;
  });
  if (copies.length) selectObjects(copies, objectId ? copies[objectIds.indexOf(objectId)] : undefined);
}

/** Z-order the selection as one block. */
export function reorderSelection(z: ZOrder): void {
  onSelection((p, slideId, ids) => reorderObjects(p, slideId, ids, z));
}

/** 'Ungroup' the selection. */
export function ungroupSelection(): void {
  onSelection((p, slideId, ids) => ungroup(p, slideId, ids));
}

// ---- D: picture ops ----------------------------------------------------------------------------------

/** Crop a picture (the crop handles' drags coalesce per object). */
export function cropPicture(objectId: string, crop: ImageCrop | undefined): void {
  onImage(objectId, (o) => setCrop(o, crop), `crop:${objectId}`);
}

export function maskPicture(objectId: string, mask: PictureMask | undefined): void {
  onImage(objectId, (o) => setMask(o, mask));
}

export function flipPicture(objectId: string, flip: PictureFlip): void {
  onImage(objectId, (o) => setFlip(o, flip));
}

/** 'Replace' a picture (aspect-preserving re-crop). */
export function replacePictureWith(objectId: string, media: PictureSize): void {
  onImage(objectId, (o) => replacePicture(o, media));
}

// ---- E: slide and presentation ops -------------------------------------------------------------------

/** Find and replace across the presentation; how many matches were replaced. */
export function findAndReplace(find: string, repl: string, opts: FindOptions = {}): number {
  let replaced = 0;
  change((p) => {
    const r = findReplace(p, find, repl, opts);
    replaced = r.replaced;
    return r.p;
  });
  return replaced;
}

export function setSlideHidden(slideId: string, hidden: boolean): void {
  change((p) => hideSlide(p, slideId, hidden));
}

/** 'Replace background…' on a slide, on it alone or on every slide using the same picture. */
export function replaceBackgroundWith(slideId: string, media: BackgroundMedia, scope: BackgroundScope): void {
  change((p) => replaceBackground(p, slideId, media, scope));
}

/** The slide's own background removed ('None', or 'Use the default' when the presentation has one). */
export function removeSlideBackground(slideId: string): void {
  change((p) => clearSlideBackground(p, slideId));
}

/** The Presentation panel's 'Replace on all slides…': picture `old` (or no picture) replaced everywhere. */
export function replaceDeckBackground(old: string | undefined, media: BackgroundMedia): void {
  change((p) => replaceBackgroundOf(p, old, media));
}

/** 'Apply to similar boxes'; how many boxes changed. */
export function applyToSimilar(objectId: string): number {
  const slideId = openSlide();
  if (!slideId) return 0;
  let changed = 0;
  change((p) => {
    const r = applyStyleToSimilar(p, slideId, objectId);
    changed = r.changed;
    return r.p;
  });
  return changed;
}

/** 'New slide like this'; the new slide is opened. */
export function addSlideLike(slideId: string): void {
  let id: string | undefined;
  change((p) => {
    const r = newSlideLike(p, slideId);
    id = r.id;
    return r.p;
  });
  if (id) selectSlide(id);
}

/** 'Use as background' for a full-slide picture of the open slide; the picture, now gone, is deselected. */
export function pictureToBackground(objectId: string): void {
  const slideId = openSlide();
  if (!slideId) return;
  const before = useEditor.getState().draft;
  change((p) => useAsBackground(p, slideId, objectId));
  const s = useEditor.getState();
  if (s.draft !== before) selectObjects(s.objectIds.filter((id) => id !== objectId));
}
