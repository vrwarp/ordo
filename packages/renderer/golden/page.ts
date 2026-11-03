import {
  DEFAULT_LYRIC_STYLE,
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  LOOK_STAGE,
  LOOK_STREAM,
  type Look,
  type Slide,
  type TextStyle,
} from '@ordo/domain';
import { fillColor } from '../src/text2d.ts';
import { type PropsModel, propBox } from '../src/props.ts';
import { rasterImage, rasterLowerThird, rasterProps, rasterSlide } from '../src/raster.ts';

/**
 * Browser side of the golden-image test (design/14, design/23): renders known slides through the same
 * rasterizer the outputs use, on an OffscreenCanvas in headless Chromium, and compares them to the
 * committed PNGs. Text uses a font the runner injects ('Golden'), so the result does not depend on the
 * fonts installed on the machine.
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

export const CASES: Record<string, (ctx: OffscreenCanvasRenderingContext2D) => void> = {
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
};

type Golden = {
  size: { width: number; height: number };
  names(): string[];
  fonts(files: { weight: number; style: 'normal' | 'italic'; base64: string }[]): Promise<number>;
  render(name: string): Promise<string>;
  diff(
    name: string,
    expectedBase64: string,
    tolerance: number,
  ): Promise<{ differing: number; total: number; maxDelta: number }>;
};

const last = new Map<string, ImageData>();

function b64ToBytes(b64: string): Uint8Array {
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
  async fonts(files) {
    let n = 0;
    for (const f of files) {
      const face = new FontFace(FONT, b64ToBytes(f.base64), { weight: String(f.weight), style: f.style });
      await face.load();
      document.fonts.add(face);
      n++;
    }
    return n;
  },
  async render(name) {
    const draw = CASES[name];
    if (!draw) throw new Error(`unknown case ${name}`);
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    draw(ctx);
    last.set(name, ctx.getImageData(0, 0, W, H));
    return blobToBase64(await c.convertToBlob({ type: 'image/png' }));
  },
  async diff(name, expectedBase64, tolerance) {
    const got = last.get(name);
    if (!got) throw new Error(`render ${name} first`);
    const bmp = await createImageBitmap(new Blob([b64ToBytes(expectedBase64)], { type: 'image/png' }));
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const exp = ctx.getImageData(0, 0, W, H).data;
    const act = got.data;
    let differing = 0;
    let maxDelta = 0;
    for (let i = 0; i < act.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(act[i + k]! - exp[i + k]!));
      if (d > maxDelta) maxDelta = d;
      if (d > tolerance) differing++;
    }
    return { differing, total: act.length / 4, maxDelta };
  },
};

(window as unknown as { __golden: Golden }).__golden = golden;
