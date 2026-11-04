/**
 * Pure maths behind `useSortable` (components/Sortable.tsx): when a press becomes a drag, where the
 * dragged item lands, where the drop indicator goes, how fast the list auto-scrolls near its edges.
 * Indices follow `moveItem(list, from, to)`: `to` is the item's index after the move.
 */

/** A touch must be held this long, without moving, before it picks an item up (scrolling stays free). */
export const LONG_PRESS_MS = 300;
/** A touch that moves further than this before the long press completes is a scroll, not a drag. */
export const TOUCH_SLOP = 10;
/** A mouse drag starts after this many pixels (a click stays a click). */
export const MOUSE_SLOP = 4;

export type PressDecision = 'wait' | 'start' | 'abort';

/** Decide what a press in progress is: still undecided, a drag, or not a drag (a scroll or a tap). */
export function pressDecision(pointerType: string, elapsedMs: number, distance: number): PressDecision {
  if (pointerType === 'mouse') return distance >= MOUSE_SLOP ? 'start' : 'wait';
  if (distance > TOUCH_SLOP) return elapsedMs >= LONG_PRESS_MS ? 'start' : 'abort';
  return elapsedMs >= LONG_PRESS_MS ? 'start' : 'wait';
}

export type Rect = { top: number; bottom: number; left: number; right: number };
export type Point = { x: number; y: number };

/** True when the point is past the item in reading order (below it, or beside it to the right on its row). */
function pastItem(r: Rect, p: Point, axis: 'y' | 'xy'): boolean {
  if (axis === 'y') return p.y > (r.top + r.bottom) / 2;
  if (p.y > r.bottom) return true;
  if (p.y < r.top) return false;
  return p.x > (r.left + r.right) / 2;
}

/**
 * The index the dragged item takes when dropped at `p`: the number of other items the point is past.
 * `axis: 'y'` is a vertical list; `'xy'` a wrapping row of chips.
 */
export function targetIndex(rects: Rect[], p: Point, from: number, axis: 'y' | 'xy'): number {
  let to = 0;
  for (let i = 0; i < rects.length; i++) if (i !== from && pastItem(rects[i]!, p, axis)) to++;
  return to;
}

/** Where to draw the drop line for a move: before or after an item at its original index, or nowhere. */
export function indicatorFor(from: number, to: number): { index: number; side: 'before' | 'after' } | null {
  if (from === to) return null;
  return to < from ? { index: to, side: 'before' } : { index: to, side: 'after' };
}

/**
 * Auto-scroll speed (px per frame) for a pointer at `pos` in a scroller spanning `start`..`end`: ramps up
 * linearly over `edge` px at either end (negative scrolls back), zero in the middle, `max` past the edge.
 */
export function autoScrollSpeed(pos: number, start: number, end: number, edge = 56, max = 18): number {
  const e = Math.min(edge, (end - start) / 3);
  if (e <= 0) return 0;
  if (pos < start + e) return -Math.round(max * Math.min(1, (start + e - pos) / e));
  if (pos > end - e) return Math.round(max * Math.min(1, (pos - (end - e)) / e));
  return 0;
}

/** The move to commit when a drag ends, or null for a cancelled drag (Escape, pointercancel) or no move. */
export function finishMove(
  from: number,
  to: number,
  cancelled: boolean,
): { from: number; to: number } | null {
  if (cancelled || from === to || from < 0 || to < 0) return null;
  return { from, to };
}

/** Move one entry of a list (same semantics as lib/arrangement.ts moveItem). */
export function moveEntry<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from === to || from < 0 || from >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, x!);
  return out;
}

export type FlatEntry = { kind: 'section'; id: string } | { kind: 'slide'; id: string };

/**
 * Slides of every section as one flat list (each section's header, then its slides). Moving a slide in
 * that list moves it across sections: it lands in the section whose header precedes it (the first section
 * when dropped above every header). Returns the slide's new section and index, or null when nothing moves.
 */
export function flatSlideMove(
  flat: readonly FlatEntry[],
  from: number,
  to: number,
): { slideId: string; sectionId: string; index: number } | null {
  const moving = flat[from];
  if (moving?.kind !== 'slide') return null;
  const before = placeOf(flat, from);
  const moved = moveEntry(flat, from, to);
  const at = moved.indexOf(moving);
  const after = placeOf(moved, at);
  if (!after) return null;
  if (before && before.sectionId === after.sectionId && before.index === after.index) return null;
  return { slideId: moving.id, ...after };
}

function placeOf(flat: readonly FlatEntry[], at: number): { sectionId: string; index: number } | undefined {
  let index = 0;
  for (let i = at - 1; i >= 0; i--) {
    const e = flat[i]!;
    if (e.kind === 'section') return { sectionId: e.id, index };
    index++;
  }
  const first = flat.find((e) => e.kind === 'section');
  return first ? { sectionId: first.id, index: 0 } : undefined;
}
