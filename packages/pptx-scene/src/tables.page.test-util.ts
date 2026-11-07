import type { ShapeObject } from '@ordo/domain';
import type { Ctx2D } from '@ordo/renderer/ctx.ts';
import { drawShape } from '@ordo/renderer/text2d.ts';

/**
 * Browser side of tables.browser.test.ts: draws two lists of shapes with the renderer's `drawShape` on
 * white OffscreenCanvases (software, `willReadFrequently`) in headless Chromium and compares the pixels.
 */

export interface GridCase {
  readonly what: string;
  readonly w: number;
  readonly h: number;
  readonly scale: number;
  readonly a: readonly ShapeObject[];
  readonly b: readonly ShapeObject[];
}

export interface GridResult {
  readonly what: string;
  /** Pixels where the two drawings differ, and by how much at most (any channel, of 255). */
  readonly differing: number;
  readonly maxDelta: number;
  /** Pixels either drawing changed from white. */
  readonly inked: number;
  /** How much each drawing darkened the canvas: the sum over pixels and channels of 255 less the value. */
  readonly inkA: number;
  readonly inkB: number;
}

function draw(c: GridCase, objects: readonly ShapeObject[]): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(c.w, c.h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.w, c.h);
  for (const o of objects) drawShape(ctx as unknown as Ctx2D, o, c.scale);
  return ctx.getImageData(0, 0, c.w, c.h).data;
}

function compare(c: GridCase): GridResult {
  const a = draw(c, c.a);
  const b = draw(c, c.b);
  let differing = 0;
  let maxDelta = 0;
  let inked = 0;
  let inkA = 0;
  let inkB = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    let ink = false;
    for (let k = 0; k < 3; k++) {
      d = Math.max(d, Math.abs(a[i + k]! - b[i + k]!));
      if (a[i + k] !== 255 || b[i + k] !== 255) ink = true;
      inkA += 255 - a[i + k]!;
      inkB += 255 - b[i + k]!;
    }
    if (d) differing++;
    maxDelta = Math.max(maxDelta, d);
    if (ink) inked++;
  }
  return { what: c.what, differing, maxDelta, inked, inkA, inkB };
}

(globalThis as unknown as { __tableGrid: (cases: GridCase[]) => GridResult[] }).__tableGrid = (cases) =>
  cases.map(compare);
