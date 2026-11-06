import type { Box, Presentation, Slide, SlideObject } from '@ordo/domain';
import type { ZOrder } from '../ops.ts';

/*
 * Group ops (M4 item B; design/27 §11 item 5 "Groups and shape+text pairs", "Locked objects"). A flattened
 * PowerPoint group, or a shape with its text (a TextObject over a ShapeObject), is a set of objects sharing
 * `origin.group`: a click selects them together, Alt-click (long-press on touch) one member. Every op takes
 * the selected ids, acts on them as one block in one undo step, and returns `p` itself when nothing changes.
 *
 * Locked objects (`locked`: PowerPoint art, SmartArt and table grids) can be moved, resized, deleted and
 * reordered, nothing else; art keeps its aspect when resized.
 */

/**
 * The editor's object selection: `ids` in the slide's z order (bottom first), `primary` one of them, the
 * object the Object panel edits. The store keeps it as `objectIds` and `objectId` (`editorStore.ts`).
 */
export type Selection = { ids: string[]; primary: string };

/** Whether an object is locked: move, resize, delete and z-order only (text and geometry read-only). */
export function isLocked(o: Pick<SlideObject, 'locked'>): boolean {
  return o.locked === true;
}

/**
 * The objects a click on `objectId` selects: every object of the slide sharing its `origin.group`, in z
 * order; just itself when it has none (or with Alt, which the canvas handles by not calling this).
 *
 * Scaffold: `[objectId]`. Item B.
 */
export function groupMembers(_s: Slide, objectId: string): string[] {
  return [objectId];
}

/**
 * Move `ids` by (dx, dy) in slide units (a drag of the selection, arrow-key nudges). Locked objects move too.
 *
 * Scaffold: returns `p`. Item B.
 */
export function moveObjects(
  p: Presentation,
  _slideId: string,
  _ids: readonly string[],
  _dx: number,
  _dy: number,
): Presentation {
  return p;
}

/**
 * The Transformer over a multi-object selection: its box went from `from` (the members' bounding box,
 * unrotated) to `to` (moved, scaled, turned about its centre). Every member's box is scaled about the group
 * box and turned about the group centre; font sizes, insets and stroke widths do not scale. A locked art
 * picture keeps its aspect. A single object goes through the editor's own box update, not this.
 *
 * Scaffold: returns `p`. Item B.
 */
export function transformGroup(
  p: Presentation,
  _slideId: string,
  _ids: readonly string[],
  _from: Box,
  _to: Box,
): Presentation {
  return p;
}

/**
 * Delete `ids` (locked ones too); the slide's `lyricObjectId` is cleared when its lyric object goes.
 *
 * Scaffold: returns `p`. Item B.
 */
export function deleteObjects(p: Presentation, _slideId: string, _ids: readonly string[]): Presentation {
  return p;
}

/**
 * Duplicate `ids` as one block placed right above the topmost of them, offset by 20 px, with fresh ids; the
 * copies of a group share a new `origin.group` number, so the copy is a group of its own. `ids`: the copies,
 * in the order of `ids` (the editor selects them).
 *
 * Scaffold: returns `p` and no copies. Item B.
 */
export function duplicateObjects(
  p: Presentation,
  _slideId: string,
  _ids: readonly string[],
): { p: Presentation; ids: string[] } {
  return { p, ids: [] };
}

/**
 * Bring `ids` to the front or back, or one step forward or backward, as one block that stays contiguous and
 * keeps its own order.
 *
 * Scaffold: returns `p`. Item B.
 */
export function reorderObjects(
  p: Presentation,
  _slideId: string,
  _ids: readonly string[],
  _z: ZOrder,
): Presentation {
  return p;
}

/**
 * 'Ungroup': `origin.group` cleared on every member, so a click selects each alone. The rest of `origin`
 * stays (a re-import still knows them).
 *
 * Scaffold: returns `p`. Item B.
 */
export function ungroup(p: Presentation, _slideId: string, _ids: readonly string[]): Presentation {
  return p;
}
