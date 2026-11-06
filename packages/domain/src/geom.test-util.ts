import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import type { Slide } from './schemas.ts';

/*
 * A slide that uses every design/27 M6 drawing field (shape geometry, gradients, dashes, arrowheads, flips,
 * effects, picture masks and flips, gradient text), with the legacy values beside them that an older build
 * draws, for the schema compatibility tests here and in @ordo/renderer.
 */

const gold = { r: 240, g: 190, b: 40, a: 1 };
const navy = { r: 20, g: 40, b: 90, a: 1 };

export function geomSlide(): Slide {
  return {
    id: 'geom',
    objects: [
      {
        id: 'star',
        type: 'shape',
        box: { x: 100, y: 100, w: 400, h: 400, rotation: 15 },
        shape: 'rect',
        fill: gold,
        stroke: { width: 6, color: navy },
        opacity: 1,
        radius: 0,
        geom: { preset: 'star5', adj: [['adj', 19_098]] },
        gradient: {
          kind: 'linear',
          angle: 90,
          scaled: true,
          stops: [
            { at: 0, color: gold },
            { at: 1, color: navy },
          ],
        },
        dash: 'dashDot',
        flipH: true,
        shadow: { dx: 8, dy: 8, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.5 } },
        glow: { radius: 10, color: { r: 255, g: 255, b: 0, a: 0.6 } },
        softEdge: 4,
        origin: { src: 'pptx', shapeId: 4, role: 'shape' },
      },
      {
        id: 'arrow',
        type: 'shape',
        box: { x: 600, y: 300, w: 500, h: 200, rotation: 0 },
        shape: 'line',
        stroke: { width: 4, color: navy },
        opacity: 1,
        radius: 0,
        geom: {
          paths: [
            { d: 'M 0 0 C 30 0 70 100 100 100', w: 100, h: 100, fill: 'none', stroke: true },
            // The same path's second piece (stored apart when one path is too long).
            { d: 'M 0 100 L 40 60', w: 100, h: 100, fill: 'none', stroke: true, cont: true },
          ],
        },
        ends: { head: { type: 'oval', w: 'sm', len: 'sm' }, tail: { type: 'triangle', w: 'lg', len: 'med' } },
        flipV: true,
      },
      {
        id: 'photo',
        type: 'image',
        box: { x: 1200, y: 100, w: 600, h: 400, rotation: 0 },
        mediaId: 'photo-media',
        fit: 'stretch',
        opacity: 1,
        radius: 0,
        flipH: true,
        mask: { preset: 'ellipse' },
      },
      {
        id: 'title',
        type: 'text',
        box: { x: 100, y: 700, w: 1720, h: 250, rotation: 0 },
        text: 'Gradient title',
        style: {
          ...DEFAULT_LYRIC_STYLE,
          color: gold,
          paint: {
            kind: 'radial',
            center: { x: 0.5, y: 0.5 },
            stops: [
              { at: 0, color: gold },
              { at: 1, color: navy },
            ],
          },
        },
        opacity: 1,
      },
    ],
  };
}
