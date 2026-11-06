import type { TextObject } from '@ordo/domain';
import type { TextRange } from './ops/text.ts';

/**
 * The format bar over the text field (design/27 §11 item 2; M4 item C): formatting for the selection
 * `range` of the textarea (`TextRange`, the field's selectionStart/selectionEnd, tracked by the Object
 * panel):
 * - font (the FontPicker), Size − / + (`resizeSelection`: `sizeScale`, relative to the box's size), Bold,
 *   Italic, Underline, Strikethrough, colour (swatches of the deck's theme colours first) and highlight,
 *   Superscript and Subscript (verse numbers: `baseline` 0.3 / -0.25), Caps (none, all, small) and Clear
 *   formatting (`CLEAR_FORMATTING`);
 * - each applies `formatSelection` (actions.ts) to the range, one undo step; with an empty range (a caret)
 *   the buttons are disabled;
 * - the pressed states and values come from `selectionStyle` (ops/text.ts): a mixed field shows as such;
 * - advanced controls (letter spacing, outline, shadow, language) behind 'More' (design/27 §17 "Editor
 *   complexity").
 *
 * Accessibility (design/15): a `role="toolbar"` labelled 'Text format', toggle buttons with `aria-pressed`
 * and a text label or `aria-label` each (no meaning by icon or colour alone), reachable by Tab, operated by
 * Enter and Space, Ctrl+B / Ctrl+I / Ctrl+U while the text field has focus; after a button the text field
 * gets its focus and selection back. 44 px controls under a coarse pointer; nothing on hover only.
 *
 * Scaffold: renders nothing. Item C (the ops it calls are item A's).
 */
export function FormatBar(_props: { o: TextObject; range: TextRange; readOnly: boolean }) {
  return null;
}
