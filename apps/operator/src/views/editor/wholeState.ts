/**
 * What the editor's whole drawing reports on `window.__ordo.editor().whole` (design/15 "Canvas drawing"): the
 * status of the last plan and the times of the last whole draws. Its own module, with no imports, so the
 * editor's inspect hook (inspect.ts) reads it without the canvas and its imports (as tableKitState.ts does).
 */

/** A plan's counts: `wanted = drawn + pending + blocked + skipped.bound + skipped.cache + skipped.total`. */
export type WholeStatus = {
  /** Objects the slide's drawing budget changes (the candidates). */
  wanted: number;
  /** Candidates drawn whole now. */
  drawn: number;
  /** Candidates allowed and waiting for a turn. */
  pending: number;
  /** Candidates not drawn whole because it is not allowed (a service is live, a coarse pointer, `?editor=light`). */
  blocked: number;
  /** Device px of the whole drawings' caches. */
  px: number;
  /** Candidates kept as the lighter copy, by why: too much to draw, too big to cache here, too much in all. */
  skipped: { bound: number; cache: number; total: number };
  /** Drawn candidates whose cache awaits its turn to be made again at a new zoom (they are in `drawn`). */
  stale: number;
  live: boolean;
  coarse: boolean;
  light: boolean;
  /** The last whole draws (`noteWholeDraw`): object id and milliseconds. */
  lastMs: { id: string; ms: number }[];
};

/** How many whole draws' times `lastMs` keeps. */
export const WHOLE_LAST_KEPT = 64;

const empty = (): WholeStatus => ({
  wanted: 0,
  drawn: 0,
  pending: 0,
  blocked: 0,
  px: 0,
  skipped: { bound: 0, cache: 0, total: 0 },
  stale: 0,
  live: false,
  coarse: false,
  light: false,
  lastMs: [],
});

let status: WholeStatus = empty();

/** The status as the last plan left it (a copy). */
export function wholeStatus(): WholeStatus {
  return { ...status, skipped: { ...status.skipped }, lastMs: status.lastMs.map((m) => ({ ...m })) };
}

/** Record a plan's counts; the times of the whole draws stay. */
export function setWholeStatus(s: Omit<WholeStatus, 'lastMs'>): void {
  status = { ...s, skipped: { ...s.skipped }, lastMs: status.lastMs };
}

/** Record the time of one whole draw (`n.cache` of a whole node), the last `WHOLE_LAST_KEPT` kept. */
export function noteWholeDraw(id: string, ms: number): void {
  status.lastMs.push({ id, ms });
  if (status.lastMs.length > WHOLE_LAST_KEPT) status.lastMs.splice(0, status.lastMs.length - WHOLE_LAST_KEPT);
}

// ---- the note under the Object panel (OQ-LE2) ----------------------------------------------------------

/** The key of a slide for the whole drawing's state and the note: the presentation's id and the slide's. */
export function wholeSlideKey(presentationId: string | undefined, slideId: string): string {
  return `${presentationId ?? ''}/${slideId}`;
}

/** The slide the list below belongs to, and the candidates of it the editor keeps drawing as the lighter copy. */
let lighterSlide: string | undefined;
let lighter: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

/**
 * Whether the editor keeps drawing the lighter copy of this object of this slide, and will go on doing so: the
 * object panel's note reads it (views/editor/WholeNote.tsx). The ids repeat across slides, so it is by slide.
 */
export function wholeKeepsLighter(slide: string, id: string): boolean {
  return slide === lighterSlide && lighter.has(id);
}

/** The canvas publishes the list after every commit; the listeners are told only when it changed. */
export function setWholeLighter(slide: string | undefined, ids: readonly string[]): void {
  if (slide === lighterSlide && ids.length === lighter.size && ids.every((id) => lighter.has(id))) return;
  lighterSlide = slide;
  lighter = new Set(ids);
  for (const l of [...listeners]) l();
}

/** Be told when the list changed (`useSyncExternalStore`'s subscribe); returns the way back out. */
export function subscribeWholeLighter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Start from nothing (a test). */
export function resetWholeStatus(): void {
  status = empty();
  lighterSlide = undefined;
  lighter = new Set();
}
