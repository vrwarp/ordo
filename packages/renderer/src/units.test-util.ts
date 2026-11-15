import type { ShapeObject, Slide } from '@ordo/domain';

/*
 * Line art past the slide's drawing budget, for the geometry units' tests and bench (design/27 §12-13): one path
 * of an outline holding a grid of holes, as the leaf template's line art is (309 sub-paths, about 17,000 points,
 * even-odd ink about 0.06). Not shipped: vitest only runs *.test.ts files, the bench and the browser tests
 * bundle it.
 */

/**
 * The path data of line art in a `w` x `h` path space (integers): an outer outline, then `cols` x `rows` holes,
 * each an oval of four cubic curves wound against the outline (so it is a hole under either fill rule), a
 * little different in each cell, with walls of `wall` of a cell between them. 13 points a hole: 20 x 15 holes
 * are 3,904 points (within a path's 4,096) and about 31,000 characters (within 40,000). With `sides`, each hole is
 * a polygon of that many corners instead (traced line art: no curve to flatten).
 */
export function lineArtD(o: {
  w: number;
  h: number;
  cols: number;
  rows: number;
  wall?: number;
  sides?: number;
}): string {
  const wall = o.wall ?? 0.14;
  const cw = o.w / o.cols;
  const ch = o.h / o.rows;
  const f = Math.round;
  const k = 0.5523;
  let d = `M0 0L${f(o.w)} 0L${f(o.w)} ${f(o.h)}L0 ${f(o.h)}Z`;
  for (let r = 0; r < o.rows; r++)
    for (let c = 0; c < o.cols; c++) {
      const cx = (c + 0.5) * cw;
      const cy = (r + 0.5) * ch;
      const rx = (cw / 2) * (1 - wall) * (0.9 + 0.1 * Math.sin(r * 7 + c * 3));
      const ry = (ch / 2) * (1 - wall) * (0.9 + 0.1 * Math.cos(r * 5 + c * 11));
      if (o.sides) {
        // Counter-clockwise (against the outline's clockwise turn).
        for (let i = 0; i < o.sides; i++) {
          const a = (-i / o.sides) * Math.PI * 2;
          d += `${i ? 'L' : 'M'}${f(cx + rx * Math.cos(a))} ${f(cy + ry * Math.sin(a))}`;
        }
        d += 'Z';
        continue;
      }
      // Counter-clockwise from the right: up, left, down, right.
      d +=
        `M${f(cx + rx)} ${f(cy)}` +
        `C${f(cx + rx)} ${f(cy - k * ry)} ${f(cx + k * rx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)}` +
        `C${f(cx - k * rx)} ${f(cy - ry)} ${f(cx - rx)} ${f(cy - k * ry)} ${f(cx - rx)} ${f(cy)}` +
        `C${f(cx - rx)} ${f(cy + k * ry)} ${f(cx - k * rx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)}` +
        `C${f(cx + k * rx)} ${f(cy + ry)} ${f(cx + rx)} ${f(cy + k * ry)} ${f(cx + rx)} ${f(cy)}Z`;
    }
  return d;
}

/** The grids of a line-art shape's paths: three overlaid, as dense line art has strokes over strokes. */
const GRIDS = [
  { cols: 20, rows: 15 },
  { cols: 19, rows: 14, wall: 0.2 },
  { cols: 21, rows: 16, wall: 0.1 },
];

/** A shape drawing line art (`paths` of `GRIDS`, polygon holes of `sides` corners if given) over `box` in `fill`. */
export function lineArtShape(
  id: string,
  box: { x: number; y: number; w: number; h: number; rotation?: number },
  fill: { r: number; g: number; b: number; a: number },
  extra: Partial<ShapeObject> = {},
  paths = GRIDS.length,
  sides?: number,
): ShapeObject {
  return {
    id,
    type: 'shape',
    box: { rotation: 0, ...box },
    shape: 'rect',
    fill,
    opacity: 1,
    radius: 0,
    geom: {
      paths: GRIDS.slice(0, paths).map((g) => ({
        d: lineArtD({ w: 4000, h: 3000, ...g, sides }),
        w: 4000,
        h: 3000,
      })),
    },
    ...extra,
  };
}

/**
 * The leaf template's case, harder: five line-art shapes (white, black turned, navy flipped, black turned and
 * flipped, and a turned gradient one below full opacity), together past `GEOM_COST.slide`, so the
 * drawing budget sends the last ones to their legacy copies, and a title (text, never a unit).
 */
export function lineArtSlide(): Slide {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const navy = { r: 31, g: 56, b: 100, a: 1 };
  return {
    id: 'line-art',
    objects: [
      lineArtShape('white', { x: 860, y: 380, w: 1000, h: 650 }, white),
      lineArtShape('black-1', { x: 40, y: 60, w: 1100, h: 700, rotation: 12 }, black),
      lineArtShape('navy', { x: 500, y: 200, w: 900, h: 600 }, navy, { flipH: true }),
      lineArtShape('black-2', { x: 700, y: 120, w: 1150, h: 760, rotation: -8 }, black, {
        flipH: true,
        flipV: true,
      }),
      lineArtShape('gradient', { x: -120, y: 520, w: 1300, h: 700, rotation: 3 }, navy, {
        opacity: 0.8,
        gradient: {
          kind: 'linear',
          angle: 30,
          stops: [
            { at: 0, color: { r: 200, g: 40, b: 40, a: 1 } },
            { at: 1, color: { r: 40, g: 40, b: 200, a: 0.9 } },
          ],
        },
      } as Partial<ShapeObject>),
      {
        id: 'title',
        type: 'text',
        box: { x: 200, y: 860, w: 1500, h: 160, rotation: 0 },
        text: 'Line art past the budget',
        style: {
          fontFamily: 'sans-serif',
          fontSizePx: 72,
          color: { r: 20, g: 20, b: 20, a: 1 },
          align: 'center',
          valign: 'middle',
          lineHeight: 1.1,
          padding: 0,
          weight: 700,
          italic: false,
        },
        opacity: 1,
      } as unknown as Slide['objects'][number],
    ],
  };
}
