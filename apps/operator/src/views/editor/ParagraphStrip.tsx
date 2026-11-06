import type { TextObject } from '@ordo/domain';
import type { TextRange } from './ops/text.ts';

/**
 * The paragraph strip under the text field (design/27 §11 item 3; M4 item C), for the paragraphs the
 * selection `range` touches (`parasTouched`, whole PowerPoint paragraphs):
 * - align left, centre, right, justify;
 * - bullets on/off with the character (•, ●, ■, ▪, ➢, ✓, Unicode only), numbering `1.` / `(1)` / `1)` / `a.` /
 *   `i.` with 'Start at' (verses starting at 17);
 * - level and indent ±, space before and after, line spacing (× single, or exact);
 * - direction Auto / Left to right / Right to left (`rtl`), for a Hebrew or Arabic line;
 * - each applies `setParagraphs` (actions.ts), one undo step (a number field's arrows coalesce per field);
 *   values from `selectionParas` (ops/text.ts), mixed values shown as such.
 *
 * Accessibility (design/15): a `role="group"` labelled 'Paragraph', radio groups with `aria-checked` for
 * the alignment and direction, every field with its visible label, keyboard reachable, 44 px under a coarse
 * pointer.
 *
 * Scaffold: renders nothing. Item C (the ops it calls are item A's).
 */
export function ParagraphStrip(_props: { o: TextObject; range: TextRange; readOnly: boolean }) {
  return null;
}
