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
  htmlToRichText,
  MAX_OBJECTS,
  MAX_SECTION_SLIDES,
  moveObjects,
  newSlideLike,
  type ParaPatch,
  parseObjectsFromHtml,
  pasteObjects,
  pasteRichText,
  type PictureFlip,
  type PictureMask,
  type PictureSize,
  refitText,
  reorderObjects,
  replaceBackground,
  replaceBackgroundOf,
  replacePicture,
  resizeRange,
  type RichTextSlice,
  richTextToHtml,
  type RunPatch,
  runOverrides,
  serializeObjectsToHtml,
  setCrop,
  setFlip,
  setMask,
  setParas,
  sliceRichText,
  textOnSlide,
  transformGroup,
  ungroup,
  useAsBackground,
  withObject,
  withSlide,
} from './ops/index.ts';
import type { ZOrder } from './ops.ts';
// F: the PowerPoint card's slide ops (pure, beside the card's other readers).
import { showObjects, showPicture } from '../../lib/pptxImport.ts';
import { toast } from '../../state/toasts.ts';

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

// ---- Rich clipboard (text & slide objects) ----------------------------------------------------------

let lastRichTextClip: { slice: RichTextSlice; plain: string } | null = null;
let lastObjectClip: {
  objects: SlideObject[];
  sourceSlideId?: string;
  lastSlideId?: string;
  pasteCount: number;
  plain: string;
  html: string;
} | null = null;

/** Paste a `RichTextSlice` into `[start, end)` of `objectId`; returns the new caret offset. */
export function pasteRichSelection(
  objectId: string,
  start: number,
  end: number,
  slice: RichTextSlice,
): number {
  let caret = Math.min(start, end) + slice.text.length;
  const slideId = openSlide();
  if (!slideId) return caret;
  change((p) =>
    withSlide(p, slideId, (s) => {
      const target = s.objects.find((x) => x.id === objectId);
      if (target?.type !== 'text' || target.locked) return s;
      const r = pasteRichText(target, start, end, slice);
      caret = r.caret;
      return textOnSlide(s, objectId, () => r.object, p.themeId ? r.overrides : []);
    }),
  );
  return caret;
}

/** Copy `[start, end)` of `o` as rich text + HTML; returns the copied slice or null if empty. */
export function copyTextSelection(
  o: TextObject,
  start: number,
  end: number,
  clipboardData?: DataTransfer | null,
): RichTextSlice | null {
  const slice = sliceRichText(o, start, end);
  if (!slice.text) return null;
  lastRichTextClip = { slice, plain: slice.text };
  lastObjectClip = null;
  if (clipboardData) {
    try {
      clipboardData.setData('text/plain', slice.text);
      clipboardData.setData('text/html', richTextToHtml(slice, o.style));
    } catch {
      // Ignore synthetic DataTransfer restrictions in tests.
    }
  }
  return slice;
}

/** Cut `[start, end)` of `o` as rich text + HTML; returns the new caret offset or null if empty. */
export function cutTextSelection(
  o: TextObject,
  start: number,
  end: number,
  clipboardData?: DataTransfer | null,
): number | null {
  const slice = copyTextSelection(o, start, end, clipboardData);
  if (!slice) return null;
  return pasteRichSelection(o.id, start, end, { text: '' });
}

/**
 * Paste rich or plain text from `clipboardData` (or in-memory fallback) into `[start, end)` of `o`;
 * returns the new caret offset, or null if nothing was pasted.
 */
export function handleTextPaste(
  o: TextObject,
  start: number,
  end: number,
  clipboardData?: DataTransfer | null,
): number | null {
  const html = clipboardData?.getData('text/html') ?? '';
  const plain = clipboardData?.getData('text/plain') ?? '';
  if (html) {
    const rich = htmlToRichText(html, o.style);
    if (rich) return pasteRichSelection(o.id, start, end, rich);
  }
  if (lastRichTextClip && (!plain || plain === lastRichTextClip.plain)) {
    return pasteRichSelection(o.id, start, end, lastRichTextClip.slice);
  }
  if (plain) {
    return pasteRichSelection(o.id, start, end, { text: plain });
  }
  return null;
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
  let tried = false;
  onSelection((p, slideId, ids) => {
    tried = true;
    const r = duplicateObjects(p, slideId, ids);
    copies = r.ids;
    return r.p;
  });
  if (copies.length) selectObjects(copies, objectId ? copies[objectIds.indexOf(objectId)] : undefined);
  else if (tried && currentObjects().length)
    toast(`A slide holds at most ${MAX_OBJECTS} objects: the copy was not made.`, 'warn');
}

/** Z-order the selection as one block. */
export function reorderSelection(z: ZOrder): void {
  onSelection((p, slideId, ids) => reorderObjects(p, slideId, ids, z));
}

/** 'Ungroup' the selection. */
export function ungroupSelection(): void {
  onSelection((p, slideId, ids) => ungroup(p, slideId, ids));
}

/** Copy the selected slide objects to the clipboard (in-memory + system `text/html`). */
export function copySelection(clipboardData?: DataTransfer | null): boolean {
  const objs = currentObjects();
  const slideId = openSlide();
  if (!objs.length || !slideId) return false;
  const { html, text } = serializeObjectsToHtml(objs, slideId);
  lastObjectClip = {
    objects: structuredClone(objs) as SlideObject[],
    sourceSlideId: slideId,
    lastSlideId: slideId,
    pasteCount: 0,
    plain: text,
    html,
  };
  lastRichTextClip = null;
  if (clipboardData) {
    try {
      clipboardData.setData('text/plain', text);
      clipboardData.setData('text/html', html);
    } catch {
      // Ignore synthetic DataTransfer restrictions.
    }
  }
  return true;
}

/** Write the most recently copied/cut slide objects into `clipboardData` (used when `cut` fires after `keydown`). */
export function writeLastObjectClip(clipboardData?: DataTransfer | null): boolean {
  if (!lastObjectClip || !clipboardData) return false;
  try {
    clipboardData.setData('text/plain', lastObjectClip.plain);
    clipboardData.setData('text/html', lastObjectClip.html);
    return true;
  } catch {
    return false;
  }
}

/** Cut the selected slide objects (copy + delete in one action). */
export function cutSelection(clipboardData?: DataTransfer | null): boolean {
  if (!copySelection(clipboardData)) return false;
  if (lastObjectClip) lastObjectClip.pasteCount = -1;
  deleteSelection();
  return true;
}

/** Whether there are copied slide objects available in memory. */
export function hasCopiedObjects(): boolean {
  return !!lastObjectClip && lastObjectClip.objects.length > 0;
}

/** Paste `objects` onto the open slide, selecting the newly created copies. */
export function pasteCopiedObjects(
  objects?: readonly SlideObject[],
  sourceSlideId?: string,
  pasteCount?: number,
): string[] {
  const slideId = openSlide();
  if (!slideId) return [];
  const srcObjs = objects ?? lastObjectClip?.objects;
  if (!srcObjs?.length) return [];
  const srcSlide = sourceSlideId ?? lastObjectClip?.sourceSlideId;
  let count = pasteCount;
  if (count === undefined) {
    if (lastObjectClip && srcObjs === lastObjectClip.objects) {
      lastObjectClip.pasteCount++;
      count = lastObjectClip.pasteCount;
    } else {
      count = 1;
    }
  }
  const sameSlide = !srcSlide || srcSlide === slideId;
  const step = !sameSlide && count <= 1 ? 0 : Math.max(0, Math.min(count, 10)) * 20;
  let copies: string[] = [];
  let full = false;
  change((p) => {
    const r = pasteObjects(p, slideId, srcObjs, { dx: step, dy: step });
    copies = r.ids;
    full = !!r.full;
    return r.p;
  });
  if (copies.length) {
    selectObjects(copies, copies[copies.length - 1]);
  } else if (full) {
    toast(`A slide holds at most ${MAX_OBJECTS} objects: the paste was not made.`, 'warn');
  }
  return copies;
}

/**
 * Check `clipboardData` (or in-memory object clipboard) for copied Ordo slide objects and paste them.
 * Returns the pasted object IDs if slide objects were pasted, or null if the clipboard does not hold slide objects.
 */
export function tryPasteObjectsFromClipboard(clipboardData?: DataTransfer | null): string[] | null {
  const slideId = openSlide();
  const html = clipboardData?.getData('text/html') ?? '';
  const plain = clipboardData?.getData('text/plain') ?? '';
  const nextCount = (srcSlideId?: string) => {
    if (!lastObjectClip) return slideId && srcSlideId && slideId !== srcSlideId ? 0 : 1;
    if (slideId && slideId !== lastObjectClip.lastSlideId) {
      lastObjectClip.lastSlideId = slideId;
      lastObjectClip.pasteCount = slideId !== (srcSlideId ?? lastObjectClip.sourceSlideId) ? 0 : 1;
      return lastObjectClip.pasteCount;
    }
    lastObjectClip.pasteCount++;
    return lastObjectClip.pasteCount;
  };
  if (html) {
    const parsed = parseObjectsFromHtml(html);
    if (parsed) {
      const count = lastObjectClip && lastObjectClip.plain === plain ? nextCount(parsed.sourceSlideId) : 1;
      return pasteCopiedObjects(parsed.objects, parsed.sourceSlideId, count);
    }
  }
  if (lastObjectClip && (!plain || plain === lastObjectClip.plain) && !html) {
    const count = nextCount(lastObjectClip.sourceSlideId);
    return pasteCopiedObjects(lastObjectClip.objects, lastObjectClip.sourceSlideId, count);
  }
  return null;
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

// ---- F: the PowerPoint card ---------------------------------------------------------------------------

/**
 * 'Show the PowerPoint picture on the screens' / 'Show the objects instead' (`Slide.pptx.show`; the picture
 * must exist, `refMediaId`). The re-import and the reference pictures are hub jobs (`pptxJobs.ts`).
 */
export function setSlideShows(slideId: string, what: 'picture' | 'objects'): void {
  change((p) => withSlide(p, slideId, what === 'picture' ? showPicture : showObjects));
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
  let full = false;
  change((p) => {
    const r = newSlideLike(p, slideId);
    id = r.id;
    full = !!r.full;
    return r.p;
  });
  if (id) selectSlide(id);
  else if (full)
    toast(`A section holds at most ${MAX_SECTION_SLIDES} slides: the new slide was not added.`, 'warn');
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
