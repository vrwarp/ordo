/*
 * Where the editor's keyboard shortcuts apply (EditorView's window key handler, design/15 "Accessibility").
 *
 * - 'field': a text field, a select or anything editable has the focus: its keys are its own (Ctrl+S
 *   still saves). The slide's text field routes Ctrl+Z and Ctrl+Y to the editor's undo itself.
 * - 'dialog': a dialog (or any modal backdrop) is open: nothing behind it reacts, so Delete on a dialog's
 *   button never deletes the selected object and Enter presses the dialog's own buttons.
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

/** A modal is open on the page: a dialog's backdrop or the updating screen. */
function modalOpen(doc: { querySelector?: (s: string) => unknown } | undefined): boolean {
  return !!doc?.querySelector?.('.backdrop, [role="dialog"]');
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
  if (el?.closest?.('[role="dialog"], .backdrop') || modalOpen(doc)) return 'dialog';
  if (isTypingTarget(t)) return 'field';
  const tag = el?.tagName ?? '';
  if (!el || tag === 'BODY' || tag === 'HTML' || tag === '' || el.closest?.('[data-editor-keys]'))
    return 'canvas';
  return 'control';
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
