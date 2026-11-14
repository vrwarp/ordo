import type { Slide } from '@ordo/domain';
import { lineArtShape } from '../../src/units.test-util.ts';
import type { BenchCase } from './index.ts';

/*
 * Raster bench slide of the geometry units (design/27 §13 "Geometry units", M9 "Slow-to-draw elements",
 * Runtime): traced line art past the slide's drawing budget, as the leaf template's first slide is: white line
 * art, a navy copy and black copies, one turned and flipped, each one geometry of three paths of about 300
 * polygon holes, and a title. The black ones pass `GEOM_COST.slide`: the drawing budget draws them as legacy
 * copies, and the units (made first, as the asset worker's prepare step makes them, each slice timed: `units` in
 * the report, the longest checked against 16 ms at 3840 and every one against the 50 ms task) draw them whole.
 * The slide's draw is reported, not checked: what it draws live is held by the drawing budget, whose estimate
 * rates hole-dense line art at about half its time (1.08M units drew in about 70 ms at 4K on the bench
 * container, the leaf template's own first slide in 43; design/27 §13 "Geometry units").
 */
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const NAVY = { r: 31, g: 56, b: 100, a: 1 };

const LINE_ART: Slide = {
  id: 'line-art-units',
  objects: [
    lineArtShape('white', { x: 860, y: 380, w: 1000, h: 650 }, WHITE, {}, 3, 10),
    lineArtShape('navy', { x: 500, y: 200, w: 900, h: 600 }, NAVY, { flipH: true }, 3, 10),
    lineArtShape('black-1', { x: 40, y: 60, w: 1100, h: 700, rotation: 12 }, BLACK, {}, 3, 10),
    lineArtShape(
      'black-2',
      { x: 700, y: 120, w: 1150, h: 760, rotation: -8 },
      BLACK,
      { flipH: true, flipV: true },
      3,
      10,
    ),
    {
      id: 'title',
      type: 'text',
      box: { x: 200, y: 860, w: 1500, h: 160, rotation: 0 },
      text: 'Line art past the budget',
      style: {
        fontFamily: 'Bench',
        fontWeight: 700,
        fontStyle: 'normal',
        fontSizePx: 72,
        color: { r: 20, g: 20, b: 20, a: 1 },
        align: 'center',
        valign: 'middle',
        lineHeight: 1.1,
        letterSpacing: 0,
        transform: 'none',
        padding: 0,
      },
      opacity: 1,
    },
  ],
};

export const UNITS_BENCH_CASES: readonly BenchCase[] = [['line art past the slide budget (units)', LINE_ART]];
