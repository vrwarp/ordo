import {
  type Box,
  DEFAULT_LYRIC_STYLE,
  type ImageObject,
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  LOOK_STAGE,
  LOOK_STREAM,
  type Look,
  type Slide,
  type SlideObject,
  type TextObject,
  type TextStyle,
} from '@ordo/domain';
import { type PictureTarget, preparePicture } from '../src/picture.ts';
import { type PropsModel, propBox } from '../src/props.ts';
import { rasterImage, rasterLowerThird, rasterProps, rasterSlide } from '../src/raster.ts';
import {
  type Ctx2D,
  drawImageFit,
  drawObject,
  drawSlide2D,
  drawText,
  drawTextObject,
  fillColor,
} from '../src/text2d.ts';
import { type FontFile, FontResolver, LEGACY_FONT_ENV, installFontEnv } from '../src/text/fonts.ts';
import { isRichText, RICH_STYLE_KEYS } from '../src/text/rich.ts';
import { AREA_CASES } from './areas.ts';
import { CONTENT_CASES } from './content-cases.ts';
import { RICH_CASES, invarianceObjects } from './rich-cases.ts';
import { SHAPE_CASES } from './shape-cases.ts';

/**
 * Browser side of the golden-image test (design/14, design/23, design/27 §14 item 4): renders known slides
 * through the same rasterizer the outputs use, on an OffscreenCanvas in headless Chromium, and compares them
 * to the committed PNGs. Text uses faces the runner injects ('Golden', 'Golden Serif', 'Golden CJK'), so the
 * result does not depend on the fonts installed on the machine.
 *
 * The legacy cases draw with no font resolver installed (`LEGACY_FONT_ENV`, the font strings drawers built
 * before design/27), exactly as when their PNGs were made; `render(name, 'resolver')` draws them again with
 * the resolver, as every drawer now does, against the same PNG. The rich cases (rich-cases.ts) and the
 * PowerPoint slide cases of the one fallback rule (content-cases.ts: a hybrid slide, a slide showing its
 * PowerPoint picture) always draw with the resolver, which registers every face under an internal family
 * name (design/27 §10).
 */

const W = 960;
const H = 540;
const SCALE = W / 1920;
const FONT = 'Golden';

const withFont = (s: TextStyle): TextStyle => ({ ...s, fontFamily: FONT });

function reFont(look: Look): Look {
  const l: Look = JSON.parse(JSON.stringify(look));
  if (l.layers.slide.mode === 'lyricOnly') {
    l.layers.slide.style = withFont(l.layers.slide.style);
    if (l.layers.slide.nextSlide) l.layers.slide.nextSlide.style = withFont(l.layers.slide.nextSlide.style);
  }
  return l;
}

const lyric = (id: string, text: string, style: Partial<TextStyle> = {}): Slide => ({
  id,
  objects: [
    {
      id: `${id}-t`,
      type: 'text',
      box: { x: 160, y: 160, w: 1600, h: 760, rotation: 0 },
      text,
      style: { ...withFont(DEFAULT_LYRIC_STYLE), ...style },
      opacity: 1,
    },
  ],
  lyricObjectId: `${id}-t`,
});

const authored: Slide = {
  id: 'authored',
  objects: [
    {
      id: 'bg',
      type: 'shape',
      box: { x: 120, y: 120, w: 1680, h: 840, rotation: 0 },
      shape: 'rect',
      fill: { r: 30, g: 60, b: 120, a: 1 },
      stroke: { width: 8, color: { r: 255, g: 200, b: 0, a: 1 } },
      opacity: 1,
      radius: 40,
    },
    {
      id: 'circle',
      type: 'shape',
      box: { x: 1400, y: 200, w: 300, h: 300, rotation: 0 },
      shape: 'ellipse',
      fill: { r: 220, g: 40, b: 40, a: 0.8 },
      opacity: 1,
      radius: 0,
    },
    {
      id: 'title',
      type: 'text',
      box: { x: 200, y: 200, w: 1100, h: 200, rotation: 0 },
      text: 'Welcome to the service',
      style: { ...withFont(DEFAULT_LYRIC_STYLE), fontSizePx: 96, align: 'left', valign: 'top' },
      opacity: 1,
    },
    {
      id: 'body',
      type: 'text',
      box: { x: 200, y: 440, w: 1500, h: 400, rotation: 0 },
      text: 'A long line of text that wraps greedily onto several lines, with an outline and a soft shadow, and a very-long-word-that-must-break',
      style: {
        ...withFont(DEFAULT_LYRIC_STYLE),
        fontSizePx: 56,
        fontWeight: 400,
        align: 'center',
        valign: 'middle',
        color: { r: 255, g: 240, b: 200, a: 1 },
        shadow: undefined,
      },
      opacity: 1,
    },
    {
      id: 'rot',
      type: 'text',
      box: { x: 1380, y: 700, w: 400, h: 120, rotation: -12 },
      text: 'Rotated',
      style: {
        ...withFont(DEFAULT_LYRIC_STYLE),
        fontSizePx: 48,
        fontStyle: 'italic',
        outline: undefined,
        fill: { color: { r: 0, g: 0, b: 0, a: 0.6 }, radius: 16 },
        padding: 10,
      },
      opacity: 0.9,
    },
  ],
};

const verse = lyric('v1', 'Amazing grace, how sweet the sound\nThat saved a wretch like me');
const chorus = lyric('c1', 'I once was lost, but now am found\nWas blind, but now I see');

function gradient(): OffscreenCanvas {
  const c = new OffscreenCanvas(1200, 400);
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 1200, 400);
  g.addColorStop(0, '#ff8800');
  g.addColorStop(0.5, '#2266ff');
  g.addColorStop(1, '#22cc66');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1200, 400);
  ctx.fillStyle = '#fff';
  ctx.fillRect(560, 160, 80, 80);
  return c;
}

const noImages = () => undefined;

/** A picture whose sides tell apart: four coloured quadrants, a white frame and a white disc in the centre. */
function quadrants(): OffscreenCanvas {
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
  ctx.arc(400, 300, 90, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

/**
 * `ImageObject.crop` (design/27 §3.1): positive shares cut, negative shares pad with transparency (the
 * backdrop shows through), under every `fit`, with rotation, radius and opacity; one crop leaves nothing.
 * Each box is outlined above its picture.
 */
const cropped: Slide = (() => {
  const box = (x: number, y: number, rotation = 0) => ({ x, y, w: 560, h: 420, rotation });
  const frame = (id: string, b: ReturnType<typeof box>) => ({
    id,
    type: 'shape' as const,
    box: b,
    shape: 'rect' as const,
    stroke: { width: 4, color: { r: 255, g: 255, b: 255, a: 0.7 } },
    opacity: 1,
    radius: 0,
  });
  const image = (
    id: string,
    b: ReturnType<typeof box>,
    fit: 'contain' | 'cover' | 'stretch',
    crop: { l: number; t: number; r: number; b: number },
    extra: { opacity?: number; radius?: number } = {},
  ) => ({
    id,
    type: 'image' as const,
    box: b,
    mediaId: 'quadrants',
    fit,
    opacity: extra.opacity ?? 1,
    radius: extra.radius ?? 0,
    crop,
  });
  const boxes = [
    box(60, 60),
    box(680, 60),
    box(1300, 60, 12),
    box(60, 600),
    box(680, 600, -10),
    box(1300, 600),
  ];
  return {
    id: 'crop',
    objects: [
      {
        id: 'backdrop',
        type: 'shape',
        box: { x: 40, y: 40, w: 1840, h: 1000, rotation: 0 },
        shape: 'rect',
        fill: { r: 120, g: 30, b: 120, a: 1 },
        opacity: 1,
        radius: 0,
      },
      // Cut from the left, top and bottom, stretched.
      image('cut', boxes[0]!, 'stretch', { l: 0.25, t: 0.1, r: 0, b: 0.2 }),
      // Padded left, right and top, stretched: the picture is smaller and lower in its box.
      image('pad', boxes[1]!, 'stretch', { l: -0.25, t: -0.2, r: -0.25, b: 0 }),
      // The green quadrant alone, contain-fitted, rotated, with round corners.
      image('quarter', boxes[2]!, 'contain', { l: 0.5, t: 0, r: 0, b: 0.5 }, { radius: 48 }),
      // Padded on the left and cut on the other sides, cover-fitted.
      image('cover', boxes[3]!, 'cover', { l: -0.5, t: 0.25, r: 0.25, b: 0.25 }),
      // Padded on every side, contain-fitted, rotated, translucent.
      image('inset', boxes[4]!, 'contain', { l: -0.5, t: -0.5, r: -0.5, b: -0.5 }, { opacity: 0.8 }),
      // Cuts more than the whole width: nothing is drawn.
      image('none', boxes[5]!, 'stretch', { l: 0.6, t: 0, r: 0.5, b: 0 }),
      ...boxes.map((b, i) => frame(`frame${i}`, b)),
    ],
  };
})();

let quadrantsImage: OffscreenCanvas | undefined;
const cropImages = (id: string) => (id === 'quadrants' ? (quadrantsImage ??= quadrants()) : undefined);

/**
 * Pictures with masks and flips (design/27 §3.1 `ImageObject.mask`, `flipH`, `flipV`; M4 item D), with crops,
 * rotation, radius and opacity: an ellipse, rounded rects (their own corner and the default), mirrors on
 * either axis and both. The quadrants tell the sides apart, so a mirror shows. Each box is outlined.
 */
const shaped: Slide = (() => {
  const box = (x: number, y: number, rotation = 0) => ({ x, y, w: 560, h: 420, rotation });
  const boxes = [
    box(60, 60),
    box(680, 60),
    box(1300, 60, 12),
    box(60, 600, -10),
    box(680, 600),
    box(1300, 600),
  ];
  const image = (id: string, b: Box, fit: 'contain' | 'cover' | 'stretch', extra: Partial<ImageObject>) =>
    ({
      id,
      type: 'image',
      box: b,
      mediaId: 'quadrants',
      fit,
      opacity: 1,
      radius: 0,
      ...extra,
    }) as ImageObject;
  return {
    id: 'shape',
    objects: [
      {
        id: 'backdrop',
        type: 'shape',
        box: { x: 40, y: 40, w: 1840, h: 1000, rotation: 0 },
        shape: 'rect',
        fill: { r: 30, g: 90, b: 110, a: 1 },
        opacity: 1,
        radius: 0,
      },
      // An ellipse, stretched; the radius beside it is the legacy value and is not drawn.
      image('ellipse', boxes[0]!, 'stretch', { mask: { preset: 'ellipse' }, radius: 200 }),
      // A rounded rect with its own corner, cropped, cover-fitted and mirrored left to right.
      image('round', boxes[1]!, 'cover', {
        mask: { preset: 'roundRect', adj: [['adj', 30_000]] },
        crop: { l: 0.1, t: 0, r: 0.2, b: 0.1 },
        flipH: true,
      }),
      // Mirrored top to bottom, rotated, contain-fitted with a crop and round corners (no mask).
      image('upside', boxes[2]!, 'contain', { flipV: true, crop: { l: 0, t: 0.25, r: 0, b: 0 }, radius: 40 }),
      // Both mirrors, an ellipse, padded on two sides, rotated and translucent.
      image('both', boxes[3]!, 'stretch', {
        flipH: true,
        flipV: true,
        mask: { preset: 'ellipse' },
        crop: { l: -0.2, t: 0, r: 0, b: -0.2 },
        opacity: 0.8,
      }),
      // A plain mirror, stretched.
      image('mirror', boxes[4]!, 'stretch', { flipH: true }),
      // The default rounded rect, contain-fitted, padded on the left.
      image('rounddefault', boxes[5]!, 'contain', {
        mask: { preset: 'roundRect' },
        crop: { l: -0.25, t: 0, r: 0, b: 0 },
      }),
      ...boxes.map((b, i) => ({
        id: `frame${i}`,
        type: 'shape' as const,
        box: b,
        shape: 'rect' as const,
        stroke: { width: 4, color: { r: 255, g: 255, b: 255, a: 0.7 } },
        opacity: 1,
        radius: 0,
      })),
    ],
  };
})();

/**
 * The editor's canvas (`SlideCanvas`): each object a Konva node at its box centre, turned by the box's
 * rotation, drawing itself in its unrotated local box at scale 1 inside the stage's scaled layer; a picture
 * through `drawImageFit` with its flips and mask, the others through `drawObject`.
 */
function editorDraw(
  ctx: Ctx2D,
  slide: Slide,
  scale: number,
  images: (id: string) => CanvasImageSource | undefined,
) {
  for (const o of slide.objects) {
    const b = o.box;
    const local = { x: 0, y: 0, w: b.w, h: b.h, rotation: 0 };
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
    ctx.rotate(((b.rotation ?? 0) * Math.PI) / 180);
    ctx.translate(-b.w / 2, -b.h / 2);
    if (o.type === 'image') {
      const img = images(o.mediaId);
      if (img) drawImageFit(ctx, img, local, 1, o.fit, o.opacity, o.radius, o.crop, undefined, o);
    } else drawObject(ctx, { ...o, box: local }, 1);
    ctx.restore();
  }
}

/**
 * The output's asset worker's lookup (design/27 §7.1): each unrotated picture prepared once at its device
 * rectangle and copied 1:1; rotated and round-cornered ones from the source. Drawing the crop slide with it
 * must look like drawing it from the source, so its expected PNG is `image-crop.png`.
 */
const preparedCrop = new Map<string, ImageBitmap>();
const preparedImages = (id: string, target?: PictureTarget) => {
  const src = cropImages(id);
  if (!src || !target) return src;
  let ready = preparedCrop.get(target.key);
  if (!ready) {
    ready = preparePicture(src, target);
    if (ready) preparedCrop.set(target.key, ready);
  }
  return ready ?? src;
};

/**
 * A slide as the M4 editor leaves an imported church slide (design/27 §15 M4 "Also": editor, thumbnail and
 * output pixels agree): a background shape, a rounded box with its text (a shape+text pair), an
 * announcement whose bold red date was retyped in a shrink-to-fit box that keeps PowerPoint's stored fit,
 * John 3:16-17 with raised verse numbers, verses numbered from 17, a right-to-left Hebrew line, a turned
 * caption, and a picture cropped, masked and mirrored beside a plainly cropped one (prepared by the outputs).
 */
const edited: Slide = (() => {
  const st = (over: Partial<TextStyle>): TextStyle => ({
    ...withFont(DEFAULT_LYRIC_STYLE),
    outline: undefined,
    shadow: undefined,
    fontSizePx: 44,
    align: 'left',
    valign: 'top',
    lineHeight: 1.2,
    padding: 10,
    lineModel: 'office',
    ...over,
  });
  const box = (x: number, y: number, w: number, h: number, rotation = 0) => ({ x, y, w, h, rotation });
  const RED = { r: 220, g: 40, b: 40, a: 1 };
  const GOLD = { r: 255, g: 200, b: 60, a: 1 };
  const announcement = 'Potluck lunch on Sunday 19 May in the hall\nBring a dish to share';
  const date = announcement.indexOf('Sunday 19 May');
  const verses =
    '16 For God so loved the world, that he gave his one and only Son\n17 For God did not send his Son into the world to judge the world';
  const second = verses.indexOf('17');
  const numbered = 'Blessed are the poor in spirit\nBlessed are those who mourn\nBlessed are the gentle';
  const hebrew = 'בְּרֵאשִׁית בָּרָא אֱלֹהִים\nIn the beginning God created';
  const text = (
    id: string,
    b: Box,
    body: string,
    style: TextStyle,
    rich: Partial<TextObject> = {},
  ): TextObject => ({
    id,
    type: 'text',
    box: b,
    text: body,
    style,
    opacity: 1,
    ...rich,
  });
  const objects: SlideObject[] = [
    {
      id: 'bg',
      type: 'shape',
      box: box(0, 0, 1920, 1080),
      shape: 'rect',
      fill: { r: 20, g: 32, b: 54, a: 1 },
      opacity: 1,
      radius: 0,
      origin: { src: 'pptx', role: 'bg' },
    },
    {
      id: 'pair-shape',
      type: 'shape',
      box: box(80, 60, 820, 200),
      shape: 'rect',
      fill: { r: 46, g: 110, b: 160, a: 1 },
      stroke: { width: 6, color: GOLD },
      opacity: 1,
      radius: 40,
      origin: { src: 'pptx', shapeId: 4, role: 'shape', group: 9 },
    },
    text(
      'pair-text',
      box(80, 60, 820, 200),
      'Coffee after the service',
      st({ fontSizePx: 56, align: 'center', valign: 'middle', fontWeight: 700 }),
      {
        runs: [{ start: 0, end: 6, fontStyle: 'italic' }],
        origin: { src: 'pptx', shapeId: 4, role: 'text', group: 9 },
      },
    ),
    text(
      'announce',
      box(80, 300, 820, 220),
      announcement,
      st({ fontSizePx: 52, autofit: 'shrink', fitScale: { font: 0.8, spacing: 0.9 } }),
      { runs: [{ start: date, end: date + 'Sunday 19 May'.length, fontWeight: 700, color: RED }] },
    ),
    text('verses', box(80, 560, 820, 300), verses, st({ fontSizePx: 40 }), {
      runs: [
        { start: 0, end: 2, baseline: 0.3, sizeScale: 0.6, color: GOLD },
        { start: second, end: second + 2, baseline: 0.3, sizeScale: 0.6, color: GOLD },
      ],
    }),
    text('numbered', box(960, 560, 880, 240), numbered, st({ fontSizePx: 40 }), {
      paras: [0, 1, 2].map(() => ({
        bullet: { auto: 'arabicPeriod', startAt: 17 },
        indentPx: 70,
        firstLinePx: -70,
      })),
    }),
    text('hebrew', box(960, 820, 880, 180), hebrew, st({ fontSizePx: 44, align: 'right' }), {
      paras: [{ rtl: true, align: 'right' }, { align: 'right' }],
    }),
    text('turned', box(120, 900, 700, 120, -6), 'Our new hall', st({ fontSizePx: 60, fontWeight: 700 }), {
      runs: [{ start: 4, end: 7, underline: true, color: GOLD }],
    }),
    {
      id: 'photo',
      type: 'image',
      box: box(960, 60, 420, 315),
      mediaId: 'quadrants',
      fit: 'stretch',
      opacity: 1,
      radius: 0,
      crop: { l: 0.05, t: 0.1, r: 0.15, b: 0 },
    },
    {
      id: 'masked',
      type: 'image',
      box: box(1420, 60, 420, 420, 8),
      mediaId: 'quadrants',
      fit: 'cover',
      opacity: 1,
      radius: 0,
      crop: { l: 0.1, t: 0, r: 0.1, b: 0 },
      mask: { preset: 'ellipse' },
      flipH: true,
    },
  ];
  return { id: 'edited', objects };
})();

/**
 * The editor's canvas as `SlideCanvas` draws a slide: each object a Konva node at its box centre, turned by
 * the box's rotation, inside the stage's layer scaled by `scale`; a text object through its cached text
 * raster (`textCanvas`: an offscreen canvas `TEXT_MARGIN` px larger on every side, at the screen's density
 * for rich text and 1:1 for legacy text, drawn into the node), a picture through `drawImageFit` with its
 * flips and mask, the others through `drawObject`. The text raster is `textDensity` and `textCanvas` of
 * apps/operator/src/views/editor/textRaster.ts and SlideCanvas.tsx (devicePixelRatio 1).
 */
const TEXT_MARGIN = 80;
function editorCanvasDraw(
  ctx: Ctx2D,
  slide: Slide,
  scale: number,
  images: (id: string) => CanvasImageSource | undefined,
) {
  for (const o of slide.objects) {
    const b = o.box;
    const local = { x: 0, y: 0, w: b.w, h: b.h, rotation: 0 };
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
    ctx.rotate(((b.rotation ?? 0) * Math.PI) / 180);
    ctx.translate(-b.w / 2, -b.h / 2);
    if (o.type === 'text') {
      const rich = isRichText(o);
      const side = (v: number) => Math.abs(v) + 2 * TEXT_MARGIN;
      const density = rich ? Math.max(0.05, Math.min(scale, 8, 8192 / Math.max(side(b.w), side(b.h)))) : 1;
      const c = new OffscreenCanvas(
        Math.max(1, Math.ceil((b.w + 2 * TEXT_MARGIN) * density)),
        Math.max(1, Math.ceil((b.h + 2 * TEXT_MARGIN) * density)),
      );
      const t = c.getContext('2d')!;
      if (rich) {
        t.translate((TEXT_MARGIN - b.x) * density, (TEXT_MARGIN - b.y) * density);
        drawTextObject(t, { ...o, box: { ...b, rotation: 0 } }, density);
      } else
        drawTextObject(t, { ...o, box: { x: TEXT_MARGIN, y: TEXT_MARGIN, w: b.w, h: b.h, rotation: 0 } }, 1);
      ctx.drawImage(c, -TEXT_MARGIN, -TEXT_MARGIN, c.width / density, c.height / density);
    } else if (o.type === 'image') {
      const img = images(o.mediaId);
      if (img) drawImageFit(ctx, img, local, 1, o.fit, o.opacity, o.radius, o.crop, undefined, o);
    } else drawObject(ctx, { ...o, box: local }, 1);
    ctx.restore();
  }
}

export const LEGACY_CASES: Record<string, (ctx: OffscreenCanvasRenderingContext2D) => void> = {
  'main-authored': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, authored, reFont(LOOK_MAIN), SCALE, noImages, { isSong: false });
  },
  'main-lyric': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, verse, reFont(LOOK_MAIN), SCALE, noImages, { isSong: true });
  },
  'stage-lyric-next': (ctx) => {
    fillColor(ctx, LOOK_STAGE.clearColor, W, H);
    rasterSlide(ctx, verse, reFont(LOOK_STAGE), SCALE, noImages, { nextSlide: chorus, isSong: true });
  },
  'lower-third-band': (ctx) => {
    fillColor(ctx, LOOK_LOWER_THIRD.clearColor, W, H);
    rasterSlide(ctx, chorus, reFont(LOOK_LOWER_THIRD), SCALE, noImages, { isSong: true });
  },
  'stream-key': (ctx) => {
    fillColor(ctx, LOOK_STREAM.clearColor, W, H);
    rasterLowerThird(ctx, 'Pastor Sam Jones — Guest speaker', reFont(LOOK_STREAM), SCALE);
  },
  'props-stage': (ctx) => {
    fillColor(ctx, LOOK_STAGE.clearColor, W, H);
    const look = LOOK_STAGE;
    const item = (
      id: 'clock' | 'countdown' | 'countdownLabel' | 'message' | 'elapsed' | 'videoRemaining',
      text: string,
    ) => {
      const { box, ...style } = propBox(id, look);
      return { id, text, style: withFont(style), box };
    };
    const model: PropsModel = {
      key: 'golden',
      empty: false,
      items: [
        item('clock', '10:29'),
        item('elapsed', '12:05'),
        item('countdown', '00:45'),
        item('countdownLabel', 'Service starts'),
        item('message', 'One more time'),
        item('videoRemaining', '02:30'),
      ],
    };
    rasterProps(ctx, model, SCALE, noImages, look.clearColor);
  },
  'image-cover': (ctx) => {
    rasterImage(ctx, gradient(), 'cover', SCALE);
  },
  'image-contain': (ctx) => {
    fillColor(ctx, { r: 40, g: 40, b: 40, a: 1 }, W, H);
    rasterImage(ctx, gradient(), 'contain', SCALE);
  },
  'image-crop': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, cropped, LOOK_MAIN, SCALE, cropImages, { isSong: false });
  },
};

export const CASES: Record<string, (ctx: OffscreenCanvasRenderingContext2D) => void> = {
  ...LEGACY_CASES,
  ...RICH_CASES,
  'image-crop-prepared': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, cropped, LOOK_MAIN, SCALE, preparedImages, { isSong: false });
  },
  // Masks and flips as the thumbnails draw them (the source lookup), as the outputs do (prepared pictures)
  // and as the editor does: the three must agree (SAME_AS).
  'image-shape': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, shaped, LOOK_MAIN, SCALE, cropImages, { isSong: false });
  },
  'image-shape-prepared': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, shaped, LOOK_MAIN, SCALE, preparedImages, { isSong: false });
  },
  'image-shape-editor': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    editorDraw(ctx, shaped, SCALE, cropImages);
  },
  // A slide as the M4 editor leaves it, as the thumbnail worker draws it (`drawSlide2D`, pictures from
  // their source), as the outputs do (`rasterSlide`, prepared pictures) and as the editor's canvas does:
  // the three must agree (SAME_AS).
  'edited-slide': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    drawSlide2D(ctx, edited, { scale: SCALE, look: LOOK_MAIN, images: cropImages, isSong: false });
  },
  'edited-slide-output': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    rasterSlide(ctx, edited, LOOK_MAIN, SCALE, preparedImages, { isSong: false });
  },
  'edited-slide-editor': (ctx) => {
    fillColor(ctx, LOOK_MAIN.clearColor, W, H);
    editorCanvasDraw(ctx, edited, SCALE, cropImages);
  },
  ...CONTENT_CASES,
  ...SHAPE_CASES,
  ...Object.assign({}, ...AREA_CASES),
};

/**
 * Cases compared with another case's PNG rather than one of their own: the same slide drawn by another
 * drawer, which must look the same within the tolerance.
 */
export const SAME_AS: Record<string, string> = {
  'image-shape-prepared': 'image-shape',
  'image-shape-editor': 'image-shape',
  'edited-slide-output': 'edited-slide',
  'edited-slide-editor': 'edited-slide',
  'table-vs-group': 'table-basic',
};

/** The faces the runner injects: each family is also registered directly under its own name. */
type GoldenFace = {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  base64: string;
  hash: string;
};

const resolver = new FontResolver({
  set: document.fonts,
  data: async (f) => {
    const b = faceBytes.get(f.hash);
    if (!b) throw new Error(`no face ${f.hash}`);
    return b.slice(0);
  },
});
const faceBytes = new Map<string, ArrayBuffer>();

/** Draw `draw` with the resolver installed, or with no resolver (the legacy font strings). */
function withEnv(env: 'legacy' | 'resolver', draw: () => void): void {
  installFontEnv(env === 'resolver' ? resolver : LEGACY_FONT_ENV);
  try {
    draw();
  } finally {
    installFontEnv(LEGACY_FONT_ENV);
  }
}

/** A 2D context that records every fillText and strokeText call (text and position as drawn). */
function recording(ctx: OffscreenCanvasRenderingContext2D): { ctx: Ctx2D; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(ctx, {
    get(t, k) {
      if (k === 'fillText' || k === 'strokeText')
        return (s: string, x: number, y: number) => {
          calls.push(`${k === 'fillText' ? 'f' : 's'}|${s}|${x}|${y}|${t.font}|${t.direction}`);
          t[k](s, x, y);
        };
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) {
      return Reflect.set(t, k, v, t);
    },
  });
  return { ctx: proxy as unknown as Ctx2D, calls };
}

export type Invariance = {
  /** Objects × box widths checked, each drawn at every width in `widths`. */
  configs: number;
  widths: number[];
  /** Rich configurations whose drawn text (strings, logical positions, fonts) differs between the widths. */
  richDiffer: string[];
  /** Legacy `drawText` of the same text and box: configurations whose line breaks differ (for comparison). */
  legacyDiffer: number;
  /** Lines drawn by the rich engine over all configurations at one width. */
  richLines: number;
};

/**
 * The line-break invariance check (design/27 §6 "Determinism", §14 item 4): every rich golden text object,
 * at several box widths, drawn through `rasterSlide` into canvases 960, 1920 and 3840 px wide (and a 320 px
 * thumbnail) must draw the same strings at the same logical positions in the same fonts. Each draw gets a
 * fresh copy of the object, so nothing is reused from the layout memo; the width cache is shared, as it is
 * in a drawer.
 */
function invariance(): Invariance {
  const widths = [320, 960, 1920, 3840];
  const canvases = widths.map((w) => new OffscreenCanvas(w, Math.round((w * 9) / 16)).getContext('2d')!);
  const richDiffer: string[] = [];
  let legacyDiffer = 0;
  let configs = 0;
  let richLines = 0;
  withEnv('resolver', () => {
    for (const o of invarianceObjects())
      for (const f of [1, 0.85, 0.7, 0.55]) {
        configs++;
        const box = { ...o.box, w: Math.round(o.box.w * f) };
        const drawn = canvases.map((c, i) => {
          const copy = JSON.parse(JSON.stringify({ ...o, box }));
          const rec = recording(c);
          c.clearRect(0, 0, c.canvas.width, c.canvas.height);
          rasterSlide(rec.ctx, { id: 'inv', objects: [copy] }, LOOK_MAIN, widths[i]! / 1920, () => undefined);
          return rec.calls.join('\n');
        });
        if (drawn.some((d) => d !== drawn[0])) richDiffer.push(`${o.id} at ${box.w} px`);
        richLines += new Set(drawn[0]!.split('\n').map((l) => l.split('|')[3])).size;
        // Legacy drawText of the same text and box: its lines are measured at the device size.
        const lines = canvases.map((c, i) => {
          const rec = recording(c);
          const scale = widths[i]! / 1920;
          const st: Record<string, unknown> = { ...o.style, outline: undefined, shadow: undefined };
          for (const k of RICH_STYLE_KEYS) delete st[k];
          drawText(rec.ctx, o.text, st as TextStyle, box, scale);
          return rec.calls.map((l) => l.split('|')[1]).join('\n');
        });
        if (lines.some((l) => l !== lines[0])) legacyDiffer++;
      }
  });
  return { configs, widths, richDiffer, legacyDiffer, richLines };
}

type Golden = {
  size: { width: number; height: number };
  names(): string[];
  legacyNames(): string[];
  sameAs(): Record<string, string>;
  fonts(files: GoldenFace[]): Promise<number>;
  render(name: string, env?: 'legacy' | 'resolver'): Promise<string>;
  invariance(): Invariance;
  /** With `picture`, also a PNG of the difference: red where a pixel is past the tolerance, the expected faded. */
  diff(
    name: string,
    expectedBase64: string,
    tolerance: number,
    picture?: boolean,
  ): Promise<{ differing: number; total: number; maxDelta: number; picture?: string }>;
};

const last = new Map<string, ImageData>();

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

const golden: Golden = {
  size: { width: W, height: H },
  names: () => Object.keys(CASES),
  legacyNames: () => Object.keys(LEGACY_CASES),
  sameAs: () => SAME_AS,
  async fonts(files) {
    let n = 0;
    const list: FontFile[] = [];
    for (const f of files) {
      const bytes = b64ToBytes(f.base64);
      const face = new FontFace(f.family, bytes, { weight: String(f.weight), style: f.style });
      await face.load();
      document.fonts.add(face);
      faceBytes.set(f.hash, bytes.buffer);
      list.push({ family: f.family, weight: f.weight, style: f.style, hash: f.hash });
      n++;
    }
    const synced = await resolver.sync(list);
    if (synced.failed.length) throw new Error(`resolver: ${synced.failed.join('; ')}`);
    return n;
  },
  async render(name, env) {
    const draw = CASES[name];
    if (!draw) throw new Error(`unknown case ${name}`);
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    withEnv(env ?? (name in LEGACY_CASES ? 'legacy' : 'resolver'), () => draw(ctx));
    last.set(name, ctx.getImageData(0, 0, W, H));
    return blobToBase64(await c.convertToBlob({ type: 'image/png' }));
  },
  async diff(name, expectedBase64, tolerance, picture) {
    const got = last.get(name);
    if (!got) throw new Error(`render ${name} first`);
    const bmp = await createImageBitmap(new Blob([b64ToBytes(expectedBase64)], { type: 'image/png' }));
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const exp = ctx.getImageData(0, 0, W, H).data;
    const act = got.data;
    const out = picture ? new ImageData(W, H) : undefined;
    let differing = 0;
    let maxDelta = 0;
    for (let i = 0; i < act.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(act[i + k]! - exp[i + k]!));
      if (d > maxDelta) maxDelta = d;
      if (d > tolerance) differing++;
      if (!out) continue;
      if (d > tolerance) {
        out.data[i] = 255;
        out.data[i + 3] = 255;
        continue;
      }
      // The expected picture, its luminance faded towards white over its alpha.
      const a = exp[i + 3]! / 255;
      const lum = (0.299 * exp[i]! + 0.587 * exp[i + 1]! + 0.114 * exp[i + 2]!) * a + 255 * (1 - a);
      const v = 255 - (255 - lum) * 0.3;
      out.data[i] = v;
      out.data[i + 1] = v;
      out.data[i + 2] = v;
      out.data[i + 3] = 255;
    }
    if (!out) return { differing, total: act.length / 4, maxDelta };
    ctx.putImageData(out, 0, 0);
    const png = await blobToBase64(await c.convertToBlob({ type: 'image/png' }));
    return { differing, total: act.length / 4, maxDelta, picture: png };
  },
  invariance,
};

(window as unknown as { __golden: Golden }).__golden = golden;
