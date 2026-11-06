import {
  DEFAULT_LYRIC_STYLE,
  LOOK_MAIN,
  type ObjectOrigin,
  type Rgba,
  type Slide,
  type SlideObject,
  type TextStyle,
} from '@ordo/domain';
import { rasterSlide } from '../src/raster.ts';
import { fillColor } from '../src/text2d.ts';

/**
 * Golden cases of the one fallback rule (design/27 §5 "One rule for every drawer", §14 item 4): what
 * `drawSlide2D` draws of PowerPoint slides through `slideContent`, as the asset worker, the thumbnail worker
 * and the editor draw them, with the drawers' font resolver ('Golden' is DejaVu Sans).
 *
 * - 'pptx-hybrid': a hybrid slide. A native background (a full-frame `role:'bg'` shape and a native
 *   picture), a native title under the art, the locked transparent LibreOffice art in the middle of the
 *   z-order (a chart with translucent bars, anti-aliased edges and holes through which what is under it
 *   shows), then a native caption and a shape over the art.
 * - 'pptx-reference': a slide set to show its PowerPoint picture. The reference picture is drawn
 *   contain-fitted, the imported objects (a red panel and its text) are not, and the objects the operator
 *   added in ordo are drawn over it.
 */

const W = 960;
const H = 540;
const SCALE = W / 1920;

const pptx = (role?: string): ObjectOrigin => (role ? { src: 'pptx', role } : { src: 'pptx' });
const box = (x: number, y: number, w: number, h: number, rotation = 0) => ({ x, y, w, h, rotation });

const textStyle = (over: Partial<TextStyle>): TextStyle => ({
  ...DEFAULT_LYRIC_STYLE,
  fontFamily: 'Golden',
  outline: undefined,
  shadow: undefined,
  ...over,
});

function shape(
  id: string,
  b: ReturnType<typeof box>,
  fill: Rgba,
  extra: Partial<Extract<SlideObject, { type: 'shape' }>> = {},
): SlideObject {
  return { id, type: 'shape', box: b, shape: 'rect', fill, opacity: 1, radius: 0, ...extra };
}

/** A soft diagonal photo: what a native picture of a deck draws under the art. */
function photo(): OffscreenCanvas {
  const c = new OffscreenCanvas(640, 360);
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 640, 360);
  g.addColorStop(0, '#24496b');
  g.addColorStop(1, '#6b2f5c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.arc(80 + i * 100, 260 - i * 30, 40 + i * 6, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/**
 * The art LibreOffice draws for a chart (design/27 §5): transparent where nothing is drawn, translucent bars
 * and grid lines, opaque axes and labels, anti-aliased edges.
 */
function chart(): OffscreenCanvas {
  const c = new OffscreenCanvas(1200, 600);
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 1200, 600);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 3;
  for (let y = 100; y <= 500; y += 100) {
    ctx.beginPath();
    ctx.moveTo(100, y);
    ctx.lineTo(1150, y);
    ctx.stroke();
  }
  const bars: [number, string][] = [
    [320, 'rgba(255, 196, 64, 0.85)'],
    [210, 'rgba(96, 200, 255, 0.85)'],
    [380, 'rgba(255, 112, 112, 0.85)'],
    [150, 'rgba(140, 230, 140, 0.85)'],
  ];
  bars.forEach(([h, color], i) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(170 + i * 240, 500 - h, 150, h, [18, 18, 0, 0]);
    ctx.fill();
  });
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(100, 40);
  ctx.lineTo(100, 500);
  ctx.lineTo(1150, 500);
  ctx.stroke();
  // A translucent pie of the year, with a hole through it, over the title under the art.
  ctx.fillStyle = 'rgba(255, 150, 60, 0.65)';
  ctx.beginPath();
  ctx.moveTo(300, 130);
  ctx.arc(300, 130, 80, -Math.PI / 2, Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(300, 130, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

/** The LibreOffice picture of a whole slide ('Show PowerPoint picture'), at the slide's 16:9 aspect. */
function reference(): OffscreenCanvas {
  const c = new OffscreenCanvas(960, 540);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#16323f';
  ctx.fillRect(0, 0, 960, 540);
  ctx.fillStyle = '#f2c14e';
  ctx.fillRect(60, 60, 840, 110);
  ctx.fillStyle = '#16323f';
  ctx.fillRect(90, 90, 520, 50);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 8;
  ctx.strokeRect(60, 220, 400, 260);
  ctx.fillStyle = '#7fc8a9';
  ctx.beginPath();
  ctx.arc(700, 350, 120, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

const pictures = new Map<string, OffscreenCanvas>();
const images = (id: string): OffscreenCanvas | undefined => {
  let c = pictures.get(id);
  if (!c) {
    const make = id === 'photo' ? photo : id === 'art' ? chart : id === 'ref' ? reference : undefined;
    if (!make) return undefined;
    c = make();
    pictures.set(id, c);
  }
  return c;
};

const FILE = 'f'.repeat(64);

/** Native objects under and over a locked transparent art picture in the middle of the z-order. */
const hybrid: Slide = {
  id: 'hybrid',
  objects: [
    shape('bg', box(0, 0, 1920, 1080), { r: 14, g: 22, b: 40, a: 1 }, { origin: pptx('bg') }),
    {
      id: 'photo',
      type: 'image',
      box: box(0, 540, 1920, 540),
      mediaId: 'photo',
      fit: 'cover',
      opacity: 0.9,
      radius: 0,
      origin: pptx('picture'),
    },
    {
      id: 'title',
      type: 'text',
      box: box(120, 80, 1680, 200),
      text: 'Giving this year',
      style: textStyle({ fontSizePx: 110, fontWeight: 700, align: 'left', valign: 'top' }),
      opacity: 1,
      origin: pptx('title'),
    },
    {
      id: 'art',
      type: 'image',
      box: box(240, 60, 1440, 720),
      mediaId: 'art',
      fit: 'stretch',
      opacity: 1,
      radius: 0,
      locked: true,
      origin: pptx('art'),
    },
    shape('band', box(0, 620, 1920, 160), { r: 0, g: 0, b: 0, a: 0.55 }, { origin: pptx('shape') }),
    {
      id: 'caption',
      type: 'text',
      box: box(120, 630, 1680, 140),
      text: 'Thank you for every gift',
      style: textStyle({
        fontSizePx: 72,
        align: 'center',
        valign: 'middle',
        color: { r: 255, g: 230, b: 160, a: 1 },
      }),
      opacity: 1,
      origin: pptx('body'),
    },
  ],
  pptx: { fileId: FILE, index: 3, shown: 3, class: 'hybrid', version: 1, artText: 'Giving 2026' },
};

/** A slide set to show its PowerPoint picture: the picture and the operator's own objects only. */
const referenceSlide: Slide = {
  id: 'reference',
  objects: [
    shape(
      'imported-panel',
      box(200, 200, 1520, 680),
      { r: 220, g: 30, b: 30, a: 1 },
      { origin: pptx('shape') },
    ),
    {
      id: 'imported-text',
      type: 'text',
      box: box(200, 200, 1520, 680),
      text: 'Imported text that must not show',
      style: textStyle({ fontSizePx: 90 }),
      opacity: 1,
      origin: pptx('body'),
    },
    shape('added-strip', box(1160, 760, 680, 220), { r: 30, g: 30, b: 30, a: 0.8 }, { radius: 24 }),
    {
      id: 'added-text',
      type: 'text',
      box: box(1180, 770, 640, 200),
      text: 'Added in ordo',
      style: textStyle({ fontSizePx: 64, align: 'center', valign: 'middle' }),
      opacity: 1,
    },
  ],
  pptx: { fileId: FILE, index: 0, shown: 0, class: 'native', version: 1, refMediaId: 'ref', show: 'picture' },
};

export const CONTENT_CASES: Record<string, (ctx: OffscreenCanvasRenderingContext2D) => void> = {
  'pptx-hybrid': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, hybrid, LOOK_MAIN, SCALE, images, { isSong: false });
  },
  'pptx-reference': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, referenceSlide, LOOK_MAIN, SCALE, images, { isSong: false });
  },
};
