/**
 * What the editor's whole drawing reports on `window.__ordo.editor().whole` (design/15 "Canvas drawing"). Its
 * own module, with no imports, so the editor's inspect hook (inspect.ts) reads it without the canvas and its
 * imports (as tableKitState.ts does). A stub: no status is kept yet.
 */

/** A plan's counts: `wanted = drawn + pending + blocked + skipped.bound + skipped.cache + skipped.total`. */
export type WholeStatus = {
  wanted: number;
  drawn: number;
  pending: number;
  blocked: number;
  px: number;
  skipped: { bound: number; cache: number; total: number };
  stale: number;
  live: boolean;
  coarse: boolean;
  light: boolean;
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

export function wholeStatus(): WholeStatus {
  return empty();
}

export function setWholeStatus(_s: Omit<WholeStatus, 'lastMs'>): void {}

export function noteWholeDraw(_id: string, _ms: number): void {}

export function resetWholeStatus(): void {}
