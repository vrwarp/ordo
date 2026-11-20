import type { ProbeShape } from './probe.ts';

/*
 * STUB (red first): the warp probe's deck writer and layout, doing nothing yet. The tests of warps.test.ts fail
 * against it; the next commit builds it.
 */

/** The text of every box of the probe. */
export const WARP_TEXT = 'WordArt Ag';

/** One box shape of the probe: its size in px and the grid of cells it sits in on a slide. */
export interface WarpBox {
  readonly key: string;
  readonly w: number;
  readonly h: number;
  readonly cols: number;
  readonly rows: number;
}

/** The three boxes. */
export const WARP_BOXES: readonly WarpBox[] = [
  { key: '360x240', w: 360, h: 240, cols: 3, rows: 2 },
  { key: '600x120', w: 600, h: 120, cols: 2, rows: 3 },
  { key: '240x300', w: 240, h: 300, cols: 3, rows: 2 },
];

export function warpLayout(_names: readonly string[], _box: WarpBox): ProbeShape[] {
  return [];
}

export function warpShapeXml(_s: ProbeShape, _id: number): string {
  return '';
}

export function warpDeck(_names: readonly string[], _box: WarpBox): Uint8Array {
  return new Uint8Array();
}
