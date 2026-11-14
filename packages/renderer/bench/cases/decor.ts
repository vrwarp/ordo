import type { DecorData, DecorPart, ShapeObject, Slide } from '@ordo/domain';
// Registers the decoration drawer with the shape dispatch.
import '../../src/decor/index.ts';
import { showcaseSlide } from '../../src/decor/test-util.ts';
import type { BenchCase } from './index.ts';

/*
 * Raster bench cases of decorations (design/27 M9 `ShapeObject.decor`, decor-render; plan §4 exit):
 * - One decoration at its caps (`DECOR_LIMITS`: 256 parts, 16,384 points, 24 shadowed shapes), cold (its
 *   effect layers and its sprite made again in every job: the direct draw, in one task) and warm (from its
 *   second job, a 1:1 copy of its sprite). Reported, not checked: in one task the cold decoration takes about
 *   100 ms at 3840 on the shared 4-CPU bench machine (its 116 outlines of 2 device px alone about 27 ms,
 *   1.2 ms at 1920 where Skia strokes them as hairlines), past design/27 §13's 50 ms task. It is an open must
 *   item before release: the outputs' effect units (r2b) draw it in slices of `drawDecorRange`, 32 shapes a
 *   turn, and their bench gates the 50 ms task on that path.
 * - The 60-shape showcase (12 shadows) as one decoration and as its shapes one by one, cold and warm:
 *   checked by pairs ('(decoration vs shapes: <pair>' and '(shapes vs decoration: <pair>', raster.ts): the
 *   decoration's p95 at most its shapes' + 10 % at each size.
 */

/** A ring of `n` points about (cx, cy) as a path string. */
function ring(cx: number, cy: number, r: number, n: number): string {
  const p: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = i % 2 ? 0.55 : 1;
    p.push(
      `${i ? 'L' : 'M'} ${(cx + r * k * Math.cos(a)).toFixed(2)} ${(cy + r * k * Math.sin(a)).toFixed(2)}`,
    );
  }
  return `${p.join(' ')} Z`;
}

/**
 * 256 stars of 64 points over the slide (16,384 points), the first 24 shadowed: a traced ornament layer as the
 * Slidesmania templates hold them (one-colour pieces, some outlined).
 */
function capped(): Slide {
  const parts: DecorPart[] = [];
  for (let i = 0; i < 256; i++) {
    const col = i % 16;
    const row = Math.floor(i / 16);
    parts.push({
      d: ring(60 + col * 120, 34 + row * 67, 22 + (i % 5) * 3, 63),
      p: i < 24 ? 4 + (i % 2) : i % 4,
      s: 1,
    });
  }
  const shadow = { dx: 3, dy: 4, blur: 6, color: { r: 0, g: 0, b: 0, a: 0.5 } };
  const decor: DecorData = {
    w: 1920,
    h: 1080,
    paints: [
      { fill: { r: 240, g: 190, b: 40, a: 1 } },
      {
        fill: { r: 30, g: 150, b: 140, a: 0.8 },
        stroke: { width: 1, color: { r: 255, g: 255, b: 255, a: 1 } },
      },
      { fill: { r: 210, g: 60, b: 50, a: 1 } },
      {
        fill: { r: 255, g: 255, b: 255, a: 0.85 },
        stroke: { width: 0.75, color: { r: 20, g: 40, b: 90, a: 1 } },
      },
      { fill: { r: 255, g: 255, b: 255, a: 1 }, shadow },
      { fill: { r: 20, g: 40, b: 90, a: 1 }, shadow },
    ],
    parts,
  };
  const o: ShapeObject = {
    id: 'decor',
    type: 'shape',
    box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
    shape: 'line',
    opacity: 1,
    radius: 0,
    decor,
    locked: true,
  };
  return { id: 'decor-capped', objects: [o] };
}

export const DECOR_BENCH_CASES: readonly BenchCase[] = [
  ['a decoration at its caps: 16,384 points, 24 shadows in one task, cold (M9 decor-render)', capped()],
  ['a decoration at its caps: 16,384 points, 24 shadows, warm (M9 decor-render)', capped()],
  [
    '60 shapes with 12 shadows as one decoration (decoration vs shapes: showcase, M9 decor-render)',
    showcaseSlide('decor'),
  ],
  [
    'the same 60 shapes one by one (shapes vs decoration: showcase, M9 decor-render)',
    showcaseSlide('shapes'),
  ],
  [
    '60 shapes with 12 shadows as one decoration, cold (decoration vs shapes: showcase cold, M9 decor-render)',
    showcaseSlide('decor'),
  ],
  [
    'the same 60 shapes one by one, cold (shapes vs decoration: showcase cold, M9 decor-render)',
    showcaseSlide('shapes'),
  ],
];
