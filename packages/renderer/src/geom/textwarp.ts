import type { BuiltGeom } from './path.ts';

/*
 * STUB (red first): the text-warp geometry module's names and shapes, doing nothing yet. The tests of
 * textwarp.test.ts fail against it; the next commit builds it.
 */

/** How a warp maps text to its shape: one affine map, along one path, or between two curves (an envelope). */
export type WarpMode = 'affine' | 'path' | 'envelope';

/** Tolerance of the affine rule: two lines are parallel and equal when their direction vectors differ by at most this fraction of the larger box side. */
export const WARP_PARALLEL_EPS = 1e-6;

export const TEXT_WARP_NAMES: readonly string[] = [];

export function hasTextWarp(_name: unknown): boolean {
  return false;
}

export function textWarpGeometry(
  _name: string,
  _w: number,
  _h: number,
  _adj?: readonly (readonly [string, number])[],
): BuiltGeom | undefined {
  return undefined;
}

export function warpAdjustNames(_name: string): readonly string[] | undefined {
  return undefined;
}

export function warpFollowsPath(_name: string): boolean {
  return false;
}

export function warpMode(_geom: Pick<BuiltGeom, 'w' | 'h' | 'paths'>): WarpMode {
  return 'envelope';
}

export function warpAreas(_geom: Pick<BuiltGeom, 'paths'>): number {
  return 0;
}
