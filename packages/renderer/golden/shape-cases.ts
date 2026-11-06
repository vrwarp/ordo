import {
  DEFAULT_LYRIC_STYLE,
  type Gradient,
  LOOK_MAIN,
  type Rgba,
  type Slide,
  type SlideObject,
  type TextStyle,
} from '@ordo/domain';
import { type PictureTarget, preparePicture } from '../src/picture.ts';
import { rasterSlide } from '../src/raster.ts';
import { fillColor } from '../src/text2d.ts';

/**
 * Golden cases of PowerPoint shapes, pictures and gradient text (design/27 §3.1 M6 fields, §14 item 4
 * "presets (M6)"), drawn through `rasterSlide` as the asset worker draws a slide:
 * - 'shape-presets': presets at their default and stored adjust values with solid fills and outlines,
 *   flips, a rotation, the shaded paths of can and cube, a callout's tail past its box, a custGeom's
 *   stored paths in their own space, and the legacy rect, ellipse and line drawn through the new path.
 * - 'shape-gradients': linear gradients at 0°, 90° and 45° (scaled and not, on a wide box), radial ones at
 *   the centre and at a corner, a gradient over the shaded paths of can, translucent stops, flips.
 * - 'shape-lines': every preset dash at two widths, the five arrowheads at small, medium and large sizes on
 *   both ends, a flipped diagonal line, a curved and a bent connector with arrowheads, a dashed outline.
 * - 'shape-effects': outer shadows (sharp, blurred, offset), glows, soft edges, all three together, on a
 *   rotated star, at half opacity.
 * - 'image-mask', 'image-mask-prepared': pictures cut to presets (ellipse, roundRect, star5, smileyFace,
 *   whose eyes are a second filled path, heart) and to stored paths, flipped, rotated and translucent,
 *   from the source and from bitmaps prepared at their targets (the asset worker's lookup).
 * - 'rich-gradient-text': gradient text (`TextStyle.paint`), linear and radial, with a run of its own colour.
 */

const W = 960;
const H = 540;
const SCALE = W / 1920;

type Shape = Extract<SlideObject, { type: 'shape' }>;
type Image = Extract<SlideObject, { type: 'image' }>;

const box = (x: number, y: number, w: number, h: number, rotation = 0) => ({ x, y, w, h, rotation });
const rgba = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
const WHITE = rgba(255, 255, 255);
const NAVY = rgba(20, 40, 90);
const GOLD = rgba(240, 190, 40);
const RED = rgba(210, 60, 50);
const TEAL = rgba(30, 150, 140);

function shape(id: string, b: ReturnType<typeof box>, extra: Partial<Shape> = {}): Shape {
  return { id, type: 'shape', box: b, shape: 'rect', opacity: 1, radius: 0, ...extra };
}

const backdrop = (id: string, color: Rgba): Shape => shape(id, box(0, 0, 1920, 1080), { fill: color });

/** A 4 x 3 grid of cells 480 x 360 px, each box inset by `m`. */
function cell(i: number, m = 50) {
  const col = i % 4;
  const row = Math.floor(i / 4);
  return box(col * 480 + m, row * 360 + m, 480 - 2 * m, 360 - 2 * m);
}

const outline = { width: 6, color: WHITE };

const presets: Slide = {
  id: 'shape-presets',
  objects: [
    backdrop('bg', rgba(40, 44, 52)),
    shape('star', cell(0), { geom: { preset: 'star5' }, fill: GOLD, stroke: outline }),
    shape('arrow', cell(1), {
      geom: {
        preset: 'rightArrow',
        adj: [
          ['adj1', 30_000],
          ['adj2', 70_000],
        ],
      },
      fill: TEAL,
      stroke: outline,
      flipH: true,
    }),
    shape('can', cell(2), { geom: { preset: 'can' }, fill: RED, stroke: { width: 4, color: NAVY } }),
    shape('cube', cell(3), { geom: { preset: 'cube' }, fill: TEAL, stroke: { width: 4, color: NAVY } }),
    shape(
      'callout',
      { ...cell(4), h: 180 },
      {
        geom: {
          preset: 'wedgeRoundRectCallout',
          adj: [
            ['adj1', -30_000],
            ['adj2', 110_000],
          ],
        },
        fill: WHITE,
        stroke: { width: 4, color: RED },
      },
    ),
    shape('smiley', cell(5), {
      geom: { preset: 'smileyFace' },
      fill: GOLD,
      stroke: { width: 4, color: NAVY },
    }),
    shape('heart', cell(6, 70), { geom: { preset: 'heart' }, fill: RED }),
    shape('rtri', cell(7), {
      geom: { preset: 'rtTriangle' },
      fill: rgba(120, 90, 200),
      stroke: outline,
      flipV: true,
    }),
    shape(
      'chevron',
      { ...cell(8), rotation: 20 },
      {
        geom: { preset: 'chevron' },
        fill: TEAL,
        stroke: outline,
        flipH: true,
      },
    ),
    // A custGeom's stored paths: a filled diamond in a 100 x 100 space, and an open zigzag over it.
    shape('cust', cell(9), {
      geom: {
        paths: [
          { d: 'M 50 0 L 100 50 L 50 100 L 0 50 Z', w: 100, h: 100 },
          { d: 'M 0 20 L 25 80 L 50 20 L 75 80 L 100 20', w: 100, h: 100, fill: 'none' },
        ],
      },
      fill: rgba(90, 160, 220),
      stroke: { width: 5, color: GOLD },
    }),
    // The legacy shapes through the new path (a flip makes them M6 shapes): a round rect, an ellipse, a line.
    shape('rrect', { ...cell(10), h: 120 }, { radius: 40, fill: GOLD, stroke: outline, flipH: true }),
    shape(
      'ellipse',
      { ...cell(10), y: cell(10).y + 140, h: 120 },
      { shape: 'ellipse', fill: RED, flipV: true },
    ),
    shape('line', cell(11), { shape: 'line', stroke: { width: 8, color: WHITE }, flipH: true }),
  ],
};

const stops = (...colors: [number, Rgba][]): Gradient['stops'] =>
  colors.map(([at, color]) => ({ at, color }));
const sunset = stops([0, rgba(255, 200, 60)], [0.5, rgba(230, 80, 60)], [1, rgba(70, 30, 120)]);

const gradients: Slide = {
  id: 'shape-gradients',
  objects: [
    backdrop('bg', rgba(30, 30, 30)),
    shape('lin0', cell(0), { gradient: { kind: 'linear', angle: 0, stops: sunset }, fill: GOLD }),
    shape('lin90', cell(1), { gradient: { kind: 'linear', angle: 90, stops: sunset }, fill: GOLD }),
    // 45° on a wide box: from corner to corner when scaled, at 45° on the page when not.
    shape(
      'lin45s',
      { ...cell(2), h: 120 },
      {
        gradient: { kind: 'linear', angle: 45, scaled: true, stops: sunset },
        fill: GOLD,
      },
    ),
    shape(
      'lin45',
      { ...cell(2), y: cell(2).y + 140, h: 120 },
      {
        gradient: { kind: 'linear', angle: 45, stops: sunset },
        fill: GOLD,
      },
    ),
    shape('rad', cell(3), {
      geom: { preset: 'ellipse' },
      gradient: { kind: 'radial', stops: sunset },
      fill: GOLD,
    }),
    shape('radCorner', cell(4), {
      gradient: { kind: 'radial', center: { x: 1, y: 0 }, stops: sunset },
      fill: GOLD,
      stroke: outline,
    }),
    shape(
      'radWide',
      { ...cell(5), h: 140 },
      {
        geom: { preset: 'roundRect' },
        gradient: { kind: 'radial', center: { x: 0.3, y: 0.5 }, stops: sunset },
        fill: GOLD,
      },
    ),
    shape('canGrad', cell(6), {
      geom: { preset: 'can' },
      gradient: { kind: 'linear', angle: 0, stops: stops([0, rgba(40, 80, 160)], [1, rgba(140, 200, 255)]) },
      fill: TEAL,
      stroke: { width: 3, color: WHITE },
    }),
    shape('alpha', cell(7), {
      geom: { preset: 'star7' },
      gradient: {
        kind: 'linear',
        angle: 270,
        stops: stops([0, rgba(255, 255, 255, 0)], [1, rgba(255, 255, 255)]),
      },
      fill: WHITE,
    }),
    shape('flipped', cell(8), {
      geom: { preset: 'rightArrow' },
      gradient: { kind: 'linear', angle: 0, stops: sunset },
      fill: GOLD,
      flipH: true,
    }),
    shape(
      'rotated',
      { ...cell(9), rotation: -30 },
      {
        geom: { preset: 'hexagon' },
        gradient: { kind: 'linear', angle: 90, stops: sunset },
        fill: GOLD,
        stroke: outline,
      },
    ),
    shape(
      'many',
      { ...cell(10), w: 860 },
      {
        gradient: {
          kind: 'linear',
          angle: 0,
          stops: stops(
            [0, rgba(255, 0, 0)],
            [0.2, rgba(255, 160, 0)],
            [0.4, rgba(255, 255, 0)],
            [0.6, rgba(0, 200, 0)],
            [0.8, rgba(0, 120, 255)],
            [1, rgba(140, 0, 200)],
          ),
        },
        fill: GOLD,
      },
    ),
  ],
};

const DASHES = [
  'dot',
  'dash',
  'dashDot',
  'longDash',
  'longDashDot',
  'longDashDotDot',
  'sysDot',
  'sysDash',
  'sysDashDot',
  'sysDashDotDot',
] as const;
const ARROWS = ['triangle', 'stealth', 'arrow', 'oval', 'diamond'] as const;
const SIZES = ['sm', 'med', 'lg'] as const;

const lines: Slide = {
  id: 'shape-lines',
  objects: [
    backdrop('bg', rgba(245, 245, 240)),
    ...DASHES.flatMap((dash, i) => [
      shape(`d${i}`, box(60, 50 + i * 44, 400, 0), {
        geom: { preset: 'line' },
        stroke: { width: 3, color: NAVY },
        dash,
      }),
      shape(`D${i}`, box(500, 50 + i * 44, 400, 0), {
        geom: { preset: 'line' },
        stroke: { width: 8, color: RED },
        dash,
      }),
    ]),
    ...ARROWS.flatMap((type, i) =>
      SIZES.map((size, j) =>
        shape(`a${i}${j}`, box(1000 + j * 300, 60 + i * 90, 240, 0), {
          geom: { preset: 'straightConnector1' },
          stroke: { width: j === 0 ? 2 : 4, color: NAVY },
          ends: { head: { type, w: size, len: size }, tail: { type, w: size, len: 'lg' } },
        }),
      ),
    ),
    // A diagonal line from bottom-left to top-right (flipV), with an arrow at its end.
    shape('diag', box(80, 560, 360, 260), {
      geom: { preset: 'line' },
      stroke: { width: 6, color: TEAL },
      flipV: true,
      ends: { tail: { type: 'triangle' } },
    }),
    shape('curved', box(520, 560, 400, 260), {
      geom: { preset: 'curvedConnector3' },
      stroke: { width: 5, color: RED },
      ends: { head: { type: 'oval' }, tail: { type: 'stealth', w: 'lg', len: 'lg' } },
    }),
    shape('bent', box(1000, 560, 400, 260), {
      geom: { preset: 'bentConnector3' },
      stroke: { width: 5, color: NAVY },
      dash: 'dash',
      ends: { tail: { type: 'arrow', w: 'lg', len: 'lg' } },
    }),
    shape('dashedRect', box(1480, 560, 360, 260), {
      geom: { preset: 'roundRect' },
      fill: rgba(255, 230, 160),
      stroke: { width: 6, color: NAVY },
      dash: 'sysDash',
    }),
  ],
};

const SHADOW = rgba(0, 0, 0, 0.6);
const effects: Slide = {
  id: 'shape-effects',
  objects: [
    backdrop('bg', rgba(235, 238, 245)),
    shape('sharp', cell(0), { fill: TEAL, shadow: { dx: 16, dy: 16, blur: 0, color: SHADOW } }),
    shape('soft', cell(1), {
      geom: { preset: 'roundRect' },
      fill: WHITE,
      stroke: { width: 3, color: NAVY },
      shadow: { dx: 10, dy: 14, blur: 30, color: SHADOW },
    }),
    shape('around', cell(2), {
      geom: { preset: 'ellipse' },
      fill: GOLD,
      shadow: { dx: 0, dy: 0, blur: 40, color: rgba(0, 0, 0, 0.8) },
    }),
    shape('glow', cell(3), {
      geom: { preset: 'star5' },
      fill: RED,
      glow: { radius: 30, color: rgba(255, 200, 0, 0.7) },
    }),
    shape('glowLine', cell(4), {
      geom: { preset: 'curvedConnector3' },
      stroke: { width: 6, color: NAVY },
      glow: { radius: 20, color: rgba(0, 160, 255, 0.6) },
    }),
    shape('softEdge', cell(5), { fill: rgba(120, 60, 180), softEdge: 30 }),
    shape('softOutlined', cell(6), {
      geom: { preset: 'hexagon' },
      fill: TEAL,
      stroke: { width: 10, color: NAVY },
      softEdge: 12,
    }),
    shape('all', cell(7), {
      geom: { preset: 'heart' },
      fill: RED,
      shadow: { dx: 12, dy: 12, blur: 20, color: SHADOW },
      glow: { radius: 24, color: rgba(255, 255, 255, 0.9) },
      softEdge: 8,
    }),
    shape(
      'rotated',
      { ...cell(8), rotation: 25 },
      {
        geom: { preset: 'star6' },
        fill: GOLD,
        stroke: { width: 4, color: NAVY },
        shadow: { dx: 14, dy: 10, blur: 16, color: SHADOW },
      },
    ),
    shape('half', cell(9), {
      geom: { preset: 'cloud' },
      fill: NAVY,
      opacity: 0.5,
      shadow: { dx: 10, dy: 10, blur: 10, color: SHADOW },
    }),
    shape('flipShadow', cell(10), {
      geom: { preset: 'rtTriangle' },
      fill: TEAL,
      flipH: true,
      shadow: { dx: -12, dy: 12, blur: 8, color: SHADOW },
    }),
    // Overflowing the slide: the shadow is cut at the canvas, not where the sprite ends.
    shape('edge', box(1700, 760, 400, 400), {
      fill: GOLD,
      shadow: { dx: -20, dy: -20, blur: 30, color: SHADOW },
    }),
  ],
};

/** A picture whose orientation shows: four coloured quadrants, a white frame and an off-centre disc. */
function picture(): OffscreenCanvas {
  const c = new OffscreenCanvas(800, 600);
  const ctx = c.getContext('2d')!;
  const q: [string, number, number][] = [
    ['#d83a3a', 0, 0],
    ['#2fa84f', 400, 0],
    ['#2f6fd8', 0, 300],
    ['#e8c020', 400, 300],
  ];
  for (const [color, x, y] of q) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 400, 300);
  }
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 24;
  ctx.strokeRect(12, 12, 776, 576);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(250, 200, 90, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function image(id: string, b: ReturnType<typeof box>, extra: Partial<Image> = {}): Image {
  return { id, type: 'image', box: b, mediaId: 'pic', fit: 'stretch', opacity: 1, radius: 0, ...extra };
}

const masks: Slide = {
  id: 'image-mask',
  objects: [
    backdrop('bg', rgba(60, 30, 80)),
    image('ellipse', cell(0), { mask: { preset: 'ellipse' } }),
    image('rrect', cell(1), { mask: { preset: 'roundRect', adj: [['adj', 30_000]] } }),
    image('star', cell(2), { mask: { preset: 'star5' } }),
    image('smiley', cell(3), { mask: { preset: 'smileyFace' } }),
    image('heart', cell(4), { mask: { preset: 'heart' }, fit: 'cover' }),
    image('paths', cell(5), {
      mask: {
        paths: [
          { d: 'M 0 0 L 2 0 L 1 2 Z', w: 2, h: 2 },
          { d: 'M 0 2 L 2 2 L 1 0 Z', w: 2, h: 2 },
        ],
      },
    }),
    image('flipH', cell(6), { flipH: true }),
    image('flipV', cell(7), { flipV: true, mask: { preset: 'rtTriangle' } }),
    image('rotated', { ...cell(8), rotation: 15 }, { mask: { preset: 'ellipse' } }),
    image('rotFlip', { ...cell(9), rotation: -20 }, { flipH: true, mask: { preset: 'chevron' } }),
    image('half', cell(10), {
      opacity: 0.5,
      mask: { preset: 'hexagon' },
      crop: { l: 0.25, t: 0, r: 0, b: 0.25 },
    }),
    // Partly off the slide: the prepared bitmap holds only what the canvas shows.
    image('edge', box(1700, 800, 400, 400), { mask: { preset: 'ellipse' } }),
  ],
};

let pictureImage: OffscreenCanvas | undefined;
const pictures = (id: string) => (id === 'pic' ? (pictureImage ??= picture()) : undefined);
const preparedMasks = new Map<string, ImageBitmap>();
/** The asset worker's lookup: every target prepared once (masks and flips baked in), the rest from the source. */
const preparedPictures = (id: string, target?: PictureTarget) => {
  const src = pictures(id);
  if (!src || !target) return src;
  let ready = preparedMasks.get(target.key);
  if (!ready) {
    ready = preparePicture(src, target);
    if (ready) preparedMasks.set(target.key, ready);
  }
  return ready ?? src;
};

const textStyle = (over: Partial<TextStyle>): TextStyle => ({
  ...DEFAULT_LYRIC_STYLE,
  fontFamily: 'Golden',
  fontWeight: 700,
  outline: undefined,
  shadow: undefined,
  ...over,
});

const gradientText: Slide = {
  id: 'rich-gradient-text',
  objects: [
    backdrop('bg', rgba(20, 20, 30)),
    {
      id: 'linear',
      type: 'text',
      box: box(80, 60, 1760, 300),
      text: 'Gradient text across the box',
      style: textStyle({
        fontSizePx: 120,
        color: rgba(255, 200, 60),
        paint: { kind: 'linear', angle: 0, stops: sunset },
      }),
      opacity: 1,
    },
    {
      id: 'vertical',
      type: 'text',
      box: box(80, 380, 1760, 300),
      text: 'Top to bottom, own colour here',
      style: textStyle({
        fontSizePx: 110,
        color: WHITE,
        paint: { kind: 'linear', angle: 90, stops: stops([0, rgba(140, 220, 255)], [1, rgba(30, 60, 200)]) },
      }),
      opacity: 1,
      runs: [{ start: 15, end: 30, color: rgba(255, 120, 120) }],
    },
    {
      id: 'radial',
      type: 'text',
      box: box(80, 720, 1760, 300, -3),
      text: 'Radial from the centre',
      style: textStyle({
        fontSizePx: 120,
        color: GOLD,
        paint: { kind: 'radial', stops: stops([0, WHITE], [0.6, GOLD], [1, RED]) },
        shadow: { dx: 4, dy: 4, blur: 6, color: rgba(0, 0, 0, 0.8) },
      }),
      opacity: 1,
    },
  ],
};

const draw =
  (slide: Slide, images: (id: string, t?: PictureTarget) => CanvasImageSource | undefined) =>
  (ctx: OffscreenCanvasRenderingContext2D) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, slide, LOOK_MAIN, SCALE, images, { isSong: false });
  };
const none = () => undefined;

export const SHAPE_CASES: Record<string, (ctx: OffscreenCanvasRenderingContext2D) => void> = {
  'shape-presets': draw(presets, none),
  'shape-gradients': draw(gradients, none),
  'shape-lines': draw(lines, none),
  'shape-effects': draw(effects, none),
  'image-mask': draw(masks, pictures),
  'image-mask-prepared': draw(masks, preparedPictures),
  'rich-gradient-text': draw(gradientText, none),
};
