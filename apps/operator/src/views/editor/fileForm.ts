import type { Presentation, Slide } from '@ordo/domain';
import { hasFileForm, staleStandIns } from '@ordo/domain/slidefile.ts';

/*
 * A slide kept as a file on the hub (import-files, Q54, Q60) draws its simple copy until its picture exists, and the
 * picture and the key come from the FILE, so a change of that simple copy beside the file would show stale content on
 * the screens. The editor therefore never changes it: `change()` refuses such a change and `save()` refuses to send one
 * (which covers undo, redo, taking over the hub's own saves and merging someone else's, none of which go through
 * `change()`); the hub's `PUT /presentations/:id` refuses it too. What a volunteer CAN change on such a slide is what is
 * not a shape: its notes, timing, transition, hidden flag, MIDI cues, sound and bottom-third words. The pure check is
 * `staleStandIns` (@ordo/domain slidefile.ts); this file is the owner's words and the two calls.
 */

/** The owner's words (E4): one place, in plain words (the editor says "detailed slide", never "stand-in" or "slide file"). */
export const FILE_FORM_REFUSAL =
  'This slide is too detailed to edit shape by shape: it is kept whole on the hub. Its notes, timing and transition can be changed; Reset slide builds it again from the PowerPoint file.';

/** The same words for a change across slides (Find and Replace, Apply to similar) that would also have changed others. */
const MANY = `${FILE_FORM_REFUSAL} Nothing was changed: change the other slides one by one.`;

const slidesById = (p: Presentation): Map<string, Slide> => {
  const out = new Map<string, Slide>();
  for (const sec of p.sections) for (const s of sec.slides) if (!out.has(s.id)) out.set(s.id, s);
  return out;
};

/**
 * The owner's words when `next` changes the simple copy of a slide kept as a file beside `prev`, else undefined. Costs
 * nothing for a presentation without such a slide (no comparison runs). A change that reaches other slides too is refused
 * as a whole, with the words that say to change them one by one.
 */
export function fileFormGuard(prev: Presentation | undefined, next: Presentation): string | undefined {
  if (!prev || !hasFileForm(next)) return undefined;
  const stale = staleStandIns(prev, next);
  if (!stale.length) return undefined;
  const bad = new Set(stale.map((s) => s.slideId));
  const before = slidesById(prev);
  for (const [id, slide] of slidesById(next)) if (!bad.has(id) && before.get(id) !== slide) return MANY;
  return FILE_FORM_REFUSAL;
}
