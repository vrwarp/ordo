import { DEFAULT_LYRIC_STYLE, LOOK_MAIN, type Slide, type SlideObject, type TextStyle } from '@ordo/domain';
import { rasterSlide } from './raster.ts';
import {
  PLANE_FLAGS,
  PLANE_FLOATS,
  PLANE_HAS_OVER,
  PLANE_OPACITY,
  type PlaneSource,
  encodePlane,
  planeSample,
  splitScene,
} from './scene.ts';
import { clampSlide } from './clamp.ts';
import { rasterScene, sceneSlides } from './scene-raster.ts';
import type { ImageLookup } from './text2d.ts';

/**
 * Browser side of scene-raster.browser.test.ts (design/27 §7.2, SCENE.md item E): draws scene slides with
 * the asset worker's code (`rasterScene` on an OffscreenCanvas, `transferToImageBitmap` as the take) in
 * headless Chromium and checks the base and over bitmaps by recomposing them:
 * - no frame: base, then over, must be the slide as one bitmap with its poster (without it when the clip
 *   is hidden while stopped);
 * - playing: base, then the clip through the plane (`planeSample`, the compositors' reference), then over,
 *   must be the slide as one bitmap with the clip's picture in place of the poster. Pixels on the plane's
 *   anti-aliased edge are not compared (the compositor golden covers them).
 * Controls show the checks can fail: the playing case recomposed without over (where an object is over
 * the video), and with a plane fitted without the poster's size (a clip that is not stretched).
 */

const W = 960;
const H = 540;
const SCALE = W / 1920;
const TOLERANCE = 40;
/** Fraction of compared pixels allowed over the tolerance (glyph and block edges resampled). */
const MAX_DIFFERING = 0.004;

export type Check = { what: string; ok: boolean; detail: string };
export type CaseResult = { name: string; checks: Check[] };

type Pic = { canvas: OffscreenCanvas; data: ImageData };

/**
 * A picture of 8 x 6 flat cells, each colour from `hue` on, and a marker block near its top left (shows
 * flips and turns): any misplaced or misfitted plane moves many cell edges.
 */
function picture(w: number, h: number, hue: number, marker: string): Pic {
  const canvas = new OffscreenCanvas(w, h);
  const x = canvas.getContext('2d', { willReadFrequently: true })!;
  for (let j = 0; j < 6; j++)
    for (let i = 0; i < 8; i++) {
      x.fillStyle = `hsl(${(hue + i * 45 + j * 75) % 360} 70% ${35 + ((i + j) % 2) * 25}%)`;
      x.fillRect((i * w) / 8, (j * h) / 6, w / 8, h / 6);
    }
  x.fillStyle = marker;
  x.fillRect(w * 0.08, h * 0.1, w * 0.15, h * 0.2);
  return { canvas, data: x.getImageData(0, 0, w, h) };
}

const POSTER = picture(320, 240, 200, '#ffffff');
const CLIP = picture(320, 240, 20, '#101010');
const PAGE = picture(480, 270, 120, '#405060');

const style = (s: Partial<TextStyle>): TextStyle => ({
  ...DEFAULT_LYRIC_STYLE,
  fontSizePx: 64,
  outline: undefined,
  shadow: undefined,
  padding: 10,
  ...s,
});
const box = (x: number, y: number, w: number, h: number, rotation = 0) => ({ x, y, w, h, rotation });
const text = (id: string, t: string, b: ReturnType<typeof box>, s: Partial<TextStyle> = {}): SlideObject => ({
  id,
  type: 'text',
  box: b,
  text: t,
  style: style(s),
  opacity: 1,
});
const rect = (id: string, b: ReturnType<typeof box>, c: [number, number, number]): SlideObject => ({
  id,
  type: 'shape',
  box: b,
  shape: 'rect',
  fill: { r: c[0], g: c[1], b: c[2], a: 1 },
  opacity: 1,
  radius: 12,
});
const clip = (
  b: ReturnType<typeof box>,
  o: Record<string, unknown> = {},
  play: Record<string, unknown> = {},
) =>
  ({
    id: 'vid',
    type: 'image',
    box: b,
    mediaId: 'poster',
    fit: 'contain',
    opacity: 1,
    radius: 0,
    play: { mediaId: 'clip', ...play },
    ...o,
  }) as SlideObject;

type Case = {
  name: string;
  slide: Slide;
  /** Object ids expected in over. */
  over: string[];
  /** Whether the control (no over) must fail: something is over the video. */
  control: boolean;
  /** Whether the control with box bounds (no text measure) must fail: text overflows into the video. */
  measured?: boolean;
};

const CASES: Case[] = [
  {
    name: 'contain, a title over the video and a tag that meets the title outside it',
    slide: {
      id: 'a',
      imported: { fileId: 'deck', page: 0, imageMediaId: 'page' },
      objects: [
        rect('under', box(300, 250, 1000, 600), [70, 70, 70]),
        clip(box(400, 300, 800, 450)),
        text('title', 'Welcome', box(450, 230, 700, 130), {
          fill: { color: { r: 0, g: 0, b: 0, a: 0.75 }, radius: 16 },
        }),
        rect('tag', box(1100, 180, 300, 90), [240, 240, 240]),
        text('footer', 'Announcements', box(100, 900, 800, 120), { fontSizePx: 48 }),
      ],
    },
    over: ['title', 'tag'],
    control: true,
  },
  {
    name: 'cover, turned 25 degrees with round corners, under text that overflows its box into it',
    slide: {
      id: 'b',
      objects: [
        clip(box(700, 250, 500, 500, 25), { fit: 'cover', radius: 60 }),
        text(
          'overflow',
          'Amazing grace how sweet the sound that saved a wretch like me, I once was lost but now am found',
          box(500, 60, 900, 80),
          { valign: 'top', fontSizePx: 72, color: { r: 255, g: 230, b: 0, a: 1 } },
        ),
        rect('side', box(1500, 750, 300, 200), [30, 90, 200]),
      ],
    },
    over: ['overflow'],
    control: true,
    measured: true,
  },
  {
    name: 'stretch, translucent, hidden while stopped, nothing over it',
    slide: {
      id: 'c',
      objects: [
        clip(box(200, 150, 700, 400), { fit: 'stretch', opacity: 0.6 }, { showWhenStopped: false }),
        text('caption', 'Caption below', box(150, 600, 900, 100), { fontSizePx: 48 }),
      ],
    },
    over: [],
    control: false,
  },
];

function lookup(clipPic: Pic): ImageLookup {
  return (id) => (id === 'poster' ? clipPic.canvas : id === 'page' ? PAGE.canvas : undefined);
}

/** The slide as one bitmap over black, with `pic` as the poster's picture. */
function flat(slide: Slide, pic: Pic): ImageData {
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.fillStyle = '#000';
  x.fillRect(0, 0, W, H);
  rasterSlide(x, slide, LOOK_MAIN, SCALE, lookup(pic));
  return x.getImageData(0, 0, W, H);
}

/** Bilinear sample of a picture at UV (u, v), clamped to its edges. */
function bilinear(p: ImageData, u: number, v: number, out: number[]): void {
  const fx = Math.min(Math.max(u * p.width - 0.5, 0), p.width - 1);
  const fy = Math.min(Math.max(v * p.height - 0.5, 0), p.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, p.width - 1);
  const y1 = Math.min(y0 + 1, p.height - 1);
  const ax = fx - x0;
  const ay = fy - y0;
  for (let k = 0; k < 3; k++) {
    const at = (x: number, y: number) => p.data[(y * p.width + x) * 4 + k]!;
    const top = at(x0, y0) * (1 - ax) + at(x1, y0) * ax;
    const bottom = at(x0, y1) * (1 - ax) + at(x1, y1) * ax;
    out[k] = top * (1 - ay) + bottom * ay;
  }
}

/**
 * Base, then the clip through the plane (when given), then over, composed over black. `edge` marks the
 * pixels on the plane's anti-aliased edge.
 */
function compose(
  base: ImageBitmap,
  over: ImageBitmap | null,
  video?: { plane: Float32Array; pic: Pic },
): { img: ImageData; edge: Uint8Array } {
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.fillStyle = '#000';
  x.fillRect(0, 0, W, H);
  x.drawImage(base, 0, 0);
  const edge = new Uint8Array(W * H);
  if (video) {
    const d = x.getImageData(0, 0, W, H);
    const s = [0, 0, 0];
    const rgb = [0, 0, 0];
    const opacity = video.plane[PLANE_OPACITY]!;
    for (let py = 0; py < H; py++)
      for (let px = 0; px < W; px++) {
        planeSample(video.plane, px + 0.5, py + 0.5, s);
        const w = s[2]!;
        if (!(w > 0)) continue;
        const i = py * W + px;
        if (w < opacity - 1e-6) edge[i] = 1;
        bilinear(video.pic.data, s[0]!, s[1]!, rgb);
        for (let k = 0; k < 3; k++) d.data[i * 4 + k] = d.data[i * 4 + k]! * (1 - w) + rgb[k]! * w;
      }
    x.putImageData(d, 0, 0);
  }
  if (over) x.drawImage(over, 0, 0);
  return { img: x.getImageData(0, 0, W, H), edge };
}

function diff(a: ImageData, b: ImageData, skip?: Uint8Array): { differing: number; total: number } {
  let differing = 0;
  let total = 0;
  for (let i = 0; i < W * H; i++) {
    if (skip?.[i]) continue;
    total++;
    for (let k = 0; k < 3; k++)
      if (Math.abs(a.data[i * 4 + k]! - b.data[i * 4 + k]!) > TOLERANCE) {
        differing++;
        break;
      }
  }
  return { differing, total };
}

function within(what: string, d: { differing: number; total: number }): Check {
  const frac = d.differing / d.total;
  return {
    what,
    ok: frac <= MAX_DIFFERING,
    detail: `${d.differing} of ${d.total} pixels over ${TOLERANCE} (${(frac * 100).toFixed(3)} %)`,
  };
}

function run(c: Case): CaseResult {
  const checks: Check[] = [];
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const take = () => canvas.transferToImageBitmap();
  const split = sceneSlides(ctx, c.slide, LOOK_MAIN, SCALE, lookup(POSTER), 'vid');
  const scene = rasterScene(ctx, take, c.slide, LOOK_MAIN, SCALE, lookup(POSTER), 'vid');
  if (!split || !scene)
    return { name: c.name, checks: [{ what: 'is a scene', ok: false, detail: 'no scene' }] };
  const overIds = split.over?.objects.map((o) => o.id) ?? [];
  checks.push({
    what: 'over holds the objects over the video',
    ok: JSON.stringify(overIds) === JSON.stringify(c.over) && !!scene.over === c.over.length > 0,
    detail: `over [${overIds.join(', ')}], bitmap ${scene.over ? 'present' : 'null'}`,
  });
  checks.push({
    what: 'the plane says whether there is an over',
    ok: (scene.plane[PLANE_FLAGS]! & PLANE_HAS_OVER) === (scene.over ? PLANE_HAS_OVER : 0),
    detail: `flags ${scene.plane[PLANE_FLAGS]}`,
  });

  // No frame: the poster shows (or nothing, when the clip is hidden while stopped).
  const vid = c.slide.objects.find((o) => o.id === 'vid') as SlideObject & {
    fit: string;
    play?: { showWhenStopped?: boolean };
  };
  const hidden = vid.play?.showWhenStopped === false;
  const still = hidden ? { ...c.slide, objects: c.slide.objects.filter((o) => o.id !== 'vid') } : c.slide;
  checks.push(
    within(
      'no frame: base + over is the slide with its poster',
      diff(compose(scene.base, scene.over).img, flat(still, POSTER)),
    ),
  );

  // Playing: the clip's picture through the plane lands where the slide draws it.
  const playing = compose(scene.base, scene.over, { plane: scene.plane, pic: CLIP });
  const expected = flat(c.slide, CLIP);
  checks.push(
    within(
      'playing: base + clip + over is the slide with the clip in place',
      diff(playing.img, expected, playing.edge),
    ),
  );
  if (c.control) {
    const control = compose(scene.base, null, { plane: scene.plane, pic: CLIP });
    const d = within('control', diff(control.img, expected, control.edge));
    checks.push({ what: 'control: without over the check fails', ok: !d.ok, detail: d.detail });
  }
  if (vid.fit !== 'stretch') {
    const unfitted = new Float32Array(PLANE_FLOATS);
    encodePlane(vid as unknown as PlaneSource, SCALE, 0, 0, unfitted, !!scene.over);
    const control = compose(scene.base, scene.over, { plane: unfitted, pic: CLIP });
    const d = within('control', diff(control.img, expected, control.edge));
    checks.push({ what: "control: a plane without the poster's size fails", ok: !d.ok, detail: d.detail });
  }
  if (c.measured) {
    // The split on box bounds alone leaves the overflowing text in base, under the video.
    const s = clampSlide(c.slide);
    const naive = splitScene(s.objects, s.objects.indexOf(s.objects.find((o) => o.id === 'vid')!));
    const draw = (objects: SlideObject[]) => {
      rasterSlide(ctx, { ...s, objects }, LOOK_MAIN, SCALE, lookup(POSTER));
      return take();
    };
    const base = draw(naive.base);
    const over = naive.over.length ? draw(naive.over) : null;
    const control = compose(base, over, { plane: scene.plane, pic: CLIP });
    const d = within('control', diff(control.img, expected, control.edge));
    checks.push({ what: 'control: a split on box bounds fails', ok: !d.ok, detail: d.detail });
    base.close();
    over?.close();
  }
  scene.base.close();
  scene.over?.close();
  return { name: c.name, checks };
}

(window as unknown as { __sceneRaster: () => CaseResult[] }).__sceneRaster = () => CASES.map(run);
