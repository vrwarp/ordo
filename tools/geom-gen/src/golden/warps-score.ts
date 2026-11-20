import type { PxRect } from './probe.ts';

/*
 * STUB (red first): the pure parts of the warp probe golden, doing nothing yet. The tests of warps-score.test.ts and
 * warps-baseline.test.ts fail against it; the next commit builds it.
 */

/** A rectangle as x0, y0, x1, y1 in px relative to a box; the right and bottom edges are exclusive. */
export type Ink = readonly [number, number, number, number];
export type Hull = readonly [number, number, number, number];

/** How far LibreOffice's ink may lie outside a hull, in px. */
export const WARP_TOLERANCE_PX = 2;
/** The most an ink edge of an unlisted preset may drift from the baseline, in px. */
export const WARP_DRIFT_PX = 2;
/** How close two inks that must be equal are, in px. */
export const WARP_PAIR_PX = 1;
/** Ink within this many px of a cell's edge means the cell was too small. */
export const WARP_EDGE_PX = 8;

export function hullOf(_arcs: readonly { readonly xy: ArrayLike<number> }[]): Hull {
  return [0, 0, 0, 0];
}

export function insideHull(_ink: Ink, _hull: Hull, _tol: number = WARP_TOLERANCE_PX): boolean {
  return false;
}

export function fillsHull(_ink: Ink, _hull: Hull, _tol: number = WARP_TOLERANCE_PX): boolean {
  return false;
}

export function inkRelative(_found: PxRect | undefined, _box: PxRect): Ink | undefined {
  return undefined;
}

export function cellClear(_ink: Ink, _cell: PxRect, _box: PxRect, _margin: number = WARP_EDGE_PX): boolean {
  return false;
}

/** One cell as measured: LibreOffice's ink, ordo's hull and first-area hull, and whether the cell was big enough. */
export interface WarpCell {
  readonly ink: Ink | undefined;
  readonly hull: Hull;
  readonly first: Hull;
  readonly clear: boolean;
}

/** Cells by box key, then by preset. */
export type WarpCells = Readonly<Record<string, Readonly<Record<string, WarpCell>>>>;

/** The committed baseline: LibreOffice's ink for every preset at every box. */
export interface WarpBaseline {
  readonly libreoffice: string;
  readonly tolerancePx: number;
  readonly text: string;
  readonly boxes: Readonly<
    Record<string, { readonly w: number; readonly h: number; readonly cols: number; readonly rows: number }>
  >;
  readonly ink: Readonly<Record<string, Readonly<Record<string, Ink>>>>;
}

export interface WarpVerdict {
  readonly failures: string[];
  readonly notes: string[];
}

export function verdictWarps(
  _cells: WarpCells,
  _baseline: WarpBaseline | undefined,
  _exceptions: Readonly<Record<string, string>>,
  _version: string,
  _scope?: { readonly names: readonly string[]; readonly boxes: readonly string[] },
): WarpVerdict {
  return { failures: [], notes: [] };
}
