import { flushSync } from 'react-dom';

/** The Object panel's text field (`ObjectPanel` TextSection, `id="ordo-text-editor"`). */
export const TEXT_FIELD_ID = 'ordo-text-editor';

/**
 * Put a range back on the text field after the editor changed its value itself (an undo, a redo, a cut or a
 * paste it handled), and return the range as set (cut to the new text), or undefined without the field.
 *
 * React's render of the new value moves the field's caret to the end, so the range is set again after that
 * render; it is set in the same task, with the render committed first (`flushSync`), never a frame later. A
 * restore scheduled for the next frame overwrote any selection made in between: the next click, Shift+End,
 * or keys typed within the frame, whose typing then went to the old place (the editor-keys e2e flake).
 */
export function restoreFieldSelection(range: {
  start: number;
  end: number;
}): { start: number; end: number } | undefined {
  flushSync(() => {});
  const f = typeof document === 'undefined' ? null : document.getElementById(TEXT_FIELD_ID);
  const area = f as HTMLTextAreaElement | null;
  if (!area || typeof area.setSelectionRange !== 'function' || typeof area.value !== 'string')
    return undefined;
  const n = area.value.length;
  const r = { start: Math.max(0, Math.min(range.start, n)), end: Math.max(0, Math.min(range.end, n)) };
  area.setSelectionRange(r.start, r.end);
  return r;
}
