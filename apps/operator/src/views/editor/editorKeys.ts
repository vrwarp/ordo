/*
 * Where the editor's keyboard shortcuts apply (EditorView's window key handler, design/15 "Accessibility").
 *
 * - 'field': a text field, a select or anything editable has the focus: its keys are its own (Ctrl+S
 *   still saves). The slide's text field routes Ctrl+Z and Ctrl+Y to the editor's undo itself.
 * - 'dialog': a dialog (or any modal backdrop) is open: nothing behind it reacts, so Delete on a dialog's
 *   button never deletes the selected object and Enter presses the dialog's own buttons. A non-modal tool card
 *   (`role="dialog"` marked `data-nonmodal`, such as the floating Find & replace) is not a modal: its fields
 *   are fields, its buttons controls, and the canvas keeps every shortcut while it is open.
 * - 'control': a button, a link, a radio, a menu item or another focusable control outside the canvas has
 *   the focus. Enter and Space press it, the arrow keys are its own (a radio group moves between its
 *   choices), Delete and Backspace do nothing: only the editor's Ctrl commands apply (undo, redo,
 *   duplicate, find).
 * - 'canvas': the focus is on the page itself (after a click on the slide canvas, which takes no focus) or
 *   on an element marked `data-editor-keys`: every shortcut applies (Delete, the arrow nudges, Enter to edit
 *   the text, Escape to drop the selection).
 */

export type KeyPlace = 'field' | 'dialog' | 'control' | 'canvas';

type El = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
  hasAttribute?: (name: string) => boolean;
};

/** A modal dialog, or any backdrop; a non-modal tool card (`data-nonmodal`) is neither. */
const MODAL = '.backdrop, [role="dialog"]:not([data-nonmodal])';

/** A modal is open on the page: a dialog's backdrop or the updating screen. */
function modalOpen(doc: { querySelector?: (s: string) => unknown } | undefined): boolean {
  return !!doc?.querySelector?.(MODAL);
}

/** A text field, a select or an editable element. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as El | null;
  return !!el && (!!el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ''));
}

/** Where a key event's target is, for the editor's shortcuts (see the module comment). */
export function keyPlace(
  t: EventTarget | null,
  doc: { querySelector?: (s: string) => unknown } | undefined = typeof document === 'undefined'
    ? undefined
    : document,
): KeyPlace {
  const el = t as El | null;
  if (el?.closest?.(MODAL) || modalOpen(doc)) return 'dialog';
  if (isTypingTarget(t)) return 'field';
  const tag = el?.tagName ?? '';
  if (!el || tag === 'BODY' || tag === 'HTML' || tag === '' || el.closest?.('[data-editor-keys]'))
    return 'canvas';
  return 'control';
}

/**
 * A key pressed while an input method composes (Chinese, Japanese or Korean candidates): `isComposing`
 * (also on a React event's `nativeEvent`), or the 229 key code browsers give such keys (Safari, Chrome on
 * Windows). Every editor key handler leaves these keys to the input method, so Escape cancels a candidate
 * instead of ending inline editing, Enter confirms it instead of jumping to the next Find match or splitting
 * a Lyric Script slide, and the arrows choose a candidate instead of moving the caret (design/15 "Keys").
 */
export function composing(e: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  return !!(e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229);
}

/** The attribute that marks the canvas-first editor's hidden backing text field (SlideCanvas.tsx). */
export const BACKING_FIELD = 'data-backing-text';

/**
 * When inline editing ends, the hidden backing text field gives the keys back to the slide (b1, design/15
 * "Keys"): if it holds the focus (no visible text field does), it is blurred, so the focus is on the page
 * again and `keyPlace` says 'canvas' (ArrowRight nudges, Delete deletes the box, Escape drops the
 * selection), instead of the keys moving an invisible caret or deleting letters. Whether it blurred.
 */
export function releaseBackingField(
  doc: { activeElement?: unknown } | undefined = typeof document === 'undefined' ? undefined : document,
): boolean {
  const el = doc?.activeElement as (El & { blur?: () => void }) | null | undefined;
  if (!el?.hasAttribute?.(BACKING_FIELD)) return false;
  el.blur?.();
  return true;
}

/** Ctrl/Cmd+Z undoes; Ctrl/Cmd+Y and Ctrl/Cmd+Shift+Z redo (Alt combinations are left alone). */
export function historyKey(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): 'undo' | 'redo' | undefined {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return undefined;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y' && !e.shiftKey) return 'redo';
  return undefined;
}

/**
 * ArrowUp/PageUp and ArrowDown/PageDown navigate to previous / next slide when nothing on the canvas is selected.
 * Returns -1 for previous slide, 1 for next slide, or 0 if this key does not navigate slides.
 */
export function slideNavKey(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
}): -1 | 1 | 0 {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return 0;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'PageUp' && e.key !== 'PageDown') return 0;
  if (isTypingTarget(e.target ?? null)) return 0;
  const el = e.target as El | null;
  if (
    el?.closest?.(
      '[role="radiogroup"], [role="menu"], [role="menuitem"], [role="listbox"], [role="dialog"], .backdrop',
    )
  ) {
    return 0;
  }
  return e.key === 'ArrowUp' || e.key === 'PageUp' ? -1 : 1;
}

/**
 * Returns the target slide ID when moving backward (-1) or forward (1) in a presentation's slide sequence.
 */
export function stepSlide(
  slideIds: readonly string[],
  currentSlideId: string | undefined,
  delta: -1 | 1,
): string | undefined {
  if (!slideIds.length) return undefined;
  const curIdx = currentSlideId ? slideIds.indexOf(currentSlideId) : -1;
  if (delta < 0) {
    if (curIdx > 0) return slideIds[curIdx - 1];
    return slideIds[0];
  }
  if (curIdx >= 0 && curIdx < slideIds.length - 1) return slideIds[curIdx + 1];
  if (curIdx < 0) return slideIds[0];
  return slideIds[slideIds.length - 1];
}
