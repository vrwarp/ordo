import {
  DEFAULT_LYRIC_STYLE,
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  type Look,
  type Slide,
  type SlideObject,
  type TextStyle,
} from '@ordo/domain';
import type { PropsModel } from './props.ts';
import { rasterLowerThird, rasterProps, rasterSlide } from './raster.ts';
import { rasterScene, rasterSceneSprites } from './scene-raster.ts';
import { type Reach, drawSprite, lowerThirdReach, propsReach, slideReach, spriteRect } from './sprite.ts';
import { LEGACY_FONT_ENV, installFontEnv } from './text/fonts.ts';
import type { FontEnv } from './text/types.ts';
import type { Ctx2D, ImageLookup } from './text2d.ts';

/**
 * Browser side of sprite.browser.test.ts (design/27 §7.3, M7): draws slides, bands, the lower third and
 * props the way the asset worker does, once full-frame and once as a tight sprite (`slideReach` and the
 * other reaches, `spriteRect`, `drawSprite` on a CPU-backed OffscreenCanvas, `transferToImageBitmap` as the
 * take), places the sprite at its offset on a transparent frame and checks that it is the full-frame
 * picture (a whole-pixel offset rasters the same; Chromium's anti-aliasing of a curve or a glyph edge may
 * differ by a few levels on a few pixels, NOISE), that it is tight where a sprite saves work (and full-frame
 * where it does not: one box over disjoint corners of the frame covers most of it), and that nothing
 * touched its edge ring (no redraw). Scenes draw
 * base and over as sprites and are recomposed the same way. Controls: a reach cut short of what is drawn
 * (text that overflows its box, the box alone as its reach) must be caught by the edge ring and drawn
 * full-frame, and recomposing a sprite one pixel off must differ.
 *
 * Run once as drawers ran before the font resolver (`LEGACY_FONT_ENV`, no layout memo) and once with a
 * resolver-like environment installed (`RESOLVER`: same CSS fonts, but a generation, which turns on the
 * legacy layout memo in text2d.ts), as the asset worker runs. The reference is always drawn on a fresh
 * context, so it never comes from the memo; the reach is measured on the surface shrunk to 1x1 and the
 * sprite drawn after the resize, as the asset worker does; and each layer is drawn a second time on the
 * same context, which must give the same picture (a memo hit draws in the layout's own font).
 */

const W = 960;
const H = 540;
const SCALE = W / 1920;
/** Rasterizer noise allowed between a sprite and the full-frame draw: pixels, and levels per channel. */
const NOISE = { pixels: 24, levels: 8 };
const same = (d: { differing: number; max: number }) => d.differing <= NOISE.pixels && d.max <= NOISE.levels;

export type Check = { what: string; ok: boolean; detail: string };
export type CaseResult = { name: string; checks: Check[] };

const style = (s: Partial<TextStyle> = {}): TextStyle => ({
  ...DEFAULT_LYRIC_STYLE,
  fontSizePx: 64,
  padding: 10,
  ...s,
});
const box = (x: number, y: number, w: number, h: number, rotation = 0) => ({ x, y, w, h, rotation });
const text = (
  id: string,
  t: string,
  b: ReturnType<typeof box>,
  s: Partial<TextStyle> = {},
  extra: Record<string, unknown> = {},
): SlideObject =>
  ({ id, type: 'text', box: b, text: t, style: style(s), opacity: 1, ...extra }) as SlideObject;
const shape = (id: string, kind: 'rect' | 'ellipse' | 'line', b: ReturnType<typeof box>): SlideObject => ({
  id,
  type: 'shape',
  box: b,
  shape: kind,
  fill: { r: 40, g: 160, b: 220, a: 0.8 },
  stroke: { width: 12, color: { r: 250, g: 250, b: 250, a: 1 } },
  opacity: 1,
  radius: 18,
});

/** A small picture for image objects: flat cells, so any misplaced copy moves many edges. */
const PICTURE = (() => {
  const c = new OffscreenCanvas(160, 120);
  const x = c.getContext('2d')!;
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 4; i++) {
      x.fillStyle = `hsl(${(i * 70 + j * 110) % 360} 70% 50%)`;
      x.fillRect(i * 40, j * 40, 40, 40);
    }
  return c;
})();
const images: ImageLookup = (id) => (id === 'pic' ? PICTURE : undefined);

const LYRICS = 'Amazing grace, how sweet the sound\nThat saved a wretch like me';
const LONG =
  'Come, thou fount of every blessing, tune my heart to sing thy grace; streams of mercy, never ceasing, call for songs of loudest praise. Here I raise my Ebenezer; hither by thy help I come.';

type Kind =
  | { kind: 'slide'; slide: Slide; look: Look; isSong?: boolean; nextSlide?: Slide }
  | { kind: 'lowerThird'; text: string; look: Look }
  | { kind: 'props'; items: { text: string; style: TextStyle; box: ReturnType<typeof box> }[] }
  | { kind: 'scene'; slide: Slide };

type Case = {
  name: string;
  job: Kind;
  /** Whether the sprite must be tight (false: the layer must stay full-frame). */
  tight: boolean;
};

const lyricLook: Look = LOOK_LOWER_THIRD;

const CASES: Case[] = [
  {
    name: 'lyric-only band (legacy text, outline and shadow)',
    job: {
      kind: 'slide',
      slide: { id: 'l', objects: [text('t', LYRICS, box(100, 100, 1700, 400))] },
      look: lyricLook,
    },
    tight: true,
  },
  {
    name: 'lyric-only band from rich text (runs, office line model)',
    job: {
      kind: 'slide',
      slide: {
        id: 'lr',
        objects: [
          text(
            't',
            LYRICS,
            box(100, 100, 1700, 400),
            { lineModel: 'office' },
            {
              runs: [{ start: 0, end: 13, color: { r: 255, g: 200, b: 60, a: 1 }, fontWeight: 700 }],
            },
          ),
        ],
      },
      look: lyricLook,
    },
    tight: true,
  },
  {
    name: 'lyric-only band, right to left',
    job: {
      kind: 'slide',
      slide: {
        id: 'rtl',
        objects: [text('t', 'שלום עולם, ברוך הבא\nמה שלומך היום', box(100, 100, 1700, 400))],
      },
      look: lyricLook,
    },
    tight: true,
  },
  {
    name: 'authored legacy text turned 15 degrees, with shadow and outline',
    job: {
      kind: 'slide',
      slide: {
        id: 'turn',
        objects: [
          text('t', 'He is risen', box(560, 380, 800, 220, 15), {
            shadow: { dx: 8, dy: 10, blur: 16, color: { r: 0, g: 0, b: 0, a: 0.8 } },
            outline: { width: 6, color: { r: 20, g: 20, b: 60, a: 1 } },
          }),
        ],
      },
      look: LOOK_MAIN,
    },
    tight: true,
  },
  {
    name: 'authored legacy text overflowing its box downwards',
    job: {
      kind: 'slide',
      slide: { id: 'over', objects: [text('t', LONG, box(300, 120, 900, 120), { fontSizePx: 48 })] },
      look: LOOK_MAIN,
    },
    tight: true,
  },
  {
    name: 'authored rich text: runs, superscript verse numbers, bullets, a fill box, overflow',
    job: {
      kind: 'slide',
      slide: {
        id: 'rich',
        objects: [
          text(
            't',
            'John 10:11\n11 I am the good shepherd\nHe knows us by name\nWe follow his voice\nAnd more lines than the box holds',
            box(200, 520, 1100, 260),
            {
              lineModel: 'office',
              fontSizePx: 52,
              fill: { color: { r: 0, g: 0, b: 0, a: 0.5 }, radius: 12 },
              shadow: { dx: 4, dy: 4, blur: 10, color: { r: 0, g: 0, b: 0, a: 0.9 } },
            },
            {
              runs: [
                { start: 0, end: 10, fontWeight: 700, sizeScale: 1.3 },
                { start: 11, end: 13, baseline: 0.3, color: { r: 255, g: 200, b: 60, a: 1 } },
              ],
              paras: [
                null,
                null,
                { bullet: { char: '•' }, indentPx: 54, firstLinePx: -54 },
                { bullet: { char: '•' }, indentPx: 54, firstLinePx: -54 },
                { bullet: { char: '•' }, indentPx: 54, firstLinePx: -54 },
              ],
            },
          ),
        ],
      },
      look: LOOK_MAIN,
    },
    tight: true,
  },
  {
    name: 'shapes with strokes and a cropped picture',
    job: {
      kind: 'slide',
      slide: {
        id: 'shapes',
        objects: [
          shape('r', 'rect', box(200, 600, 500, 260)),
          shape('e', 'ellipse', box(800, 640, 300, 200)),
          shape('l', 'line', box(1200, 700, 500, 0)),
          {
            id: 'p',
            type: 'image',
            box: box(1300, 760, 320, 240, -8),
            mediaId: 'pic',
            fit: 'cover',
            opacity: 1,
            radius: 20,
            crop: { l: 0.1, t: 0, r: 0.05, b: 0.1 },
          } as SlideObject,
        ],
      },
      look: LOOK_MAIN,
    },
    tight: true,
  },
  {
    name: 'lower third',
    job: { kind: 'lowerThird', text: 'Pastor Anna Smith\nWelcome and announcements', look: LOOK_MAIN },
    tight: true,
  },
  {
    name: 'props text in one corner',
    job: {
      kind: 'props',
      items: [
        { text: '10:42', style: style({ fontSizePx: 72 }), box: box(1560, 40, 320, 110) },
        { text: 'starts in 5:00', style: style({ fontSizePx: 36 }), box: box(1500, 150, 380, 70) },
      ],
    },
    tight: true,
  },
  {
    name: 'props text in opposite corners stays full-frame (one box covers most of the frame)',
    job: {
      kind: 'props',
      items: [
        { text: '10:42', style: style({ fontSizePx: 72 }), box: box(1560, 40, 320, 110) },
        { text: 'Service starts in 5 minutes', style: style({ fontSizePx: 40 }), box: box(40, 960, 900, 80) },
      ],
    },
    tight: false,
  },
  {
    name: 'a slide covering the frame stays full-frame',
    job: {
      kind: 'slide',
      slide: {
        id: 'full',
        objects: [
          { ...shape('bg', 'rect', box(0, 0, 1920, 1080)), radius: 0 } as SlideObject,
          text('t', 'Title', box(100, 100, 1000, 200)),
        ],
      },
      look: LOOK_MAIN,
    },
    tight: false,
  },
  {
    name: 'a hidden look draws nothing (1x1 sprite)',
    job: {
      kind: 'slide',
      slide: { id: 'hid', objects: [text('t', 'x', box(0, 0, 400, 100))] },
      look: { ...LOOK_MAIN, layers: { ...LOOK_MAIN.layers, slide: { mode: 'hidden' } } } as Look,
    },
    tight: true,
  },
  {
    name: 'scene: tight base and a tight over (a title over the video)',
    job: {
      kind: 'scene',
      slide: {
        id: 'scene',
        objects: [
          {
            id: 'vid',
            type: 'image',
            box: box(400, 200, 800, 450),
            mediaId: 'pic',
            fit: 'cover',
            opacity: 1,
            radius: 0,
            play: { mediaId: 'clip' },
          } as SlideObject,
          text('title', 'Welcome', box(450, 560, 700, 130), {
            fill: { color: { r: 0, g: 0, b: 0, a: 0.75 }, radius: 16 },
          }),
          text('foot', 'Announcements', box(100, 900, 800, 120), { fontSizePx: 48 }),
        ],
      },
    },
    tight: true,
  },
];

/** A resolver-like font environment: the legacy CSS fonts, but with a generation (the memo is on). */
const RESOLVER: FontEnv = { generation: 1, font: (req) => LEGACY_FONT_ENV.font(req) };

type Surface = { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D };

function makeSurface(): Surface {
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return { canvas, ctx };
}

function sizer(s: Surface) {
  return (w: number, h: number): Ctx2D => {
    if (s.canvas.width !== w) s.canvas.width = w;
    if (s.canvas.height !== h) s.canvas.height = h;
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.ctx.clearRect(0, 0, w, h);
    return s.ctx;
  };
}

/** A bitmap placed at (x, y) on a transparent frame, as RGBA bytes. */
function placedPixels(parts: { bitmap: ImageBitmap; x: number; y: number }[]): Uint8ClampedArray {
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  for (const p of parts) x.drawImage(p.bitmap, p.x, p.y);
  return x.getImageData(0, 0, W, H).data;
}

function compare(a: Uint8ClampedArray, b: Uint8ClampedArray): { differing: number; max: number } {
  let differing = 0;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > max) max = d;
    if (d > 0) differing++;
  }
  return { differing, max };
}

/** The draw and reach (measured on `measure` when asked) of a non-scene job. */
function drawerOf(
  job: Exclude<Kind, { kind: 'scene' }>,
  measure: Ctx2D,
): { reach: () => Reach; draw: (c: Ctx2D) => void } {
  if (job.kind === 'slide') {
    const opts = { nextSlide: job.nextSlide, isSong: job.isSong ?? true };
    return {
      reach: () => slideReach(measure, job.slide, { scale: SCALE, look: job.look, ...opts }),
      draw: (c) => rasterSlide(c, job.slide, job.look, SCALE, images, opts),
    };
  }
  if (job.kind === 'lowerThird')
    return {
      reach: () => lowerThirdReach(measure, job.text, job.look, SCALE),
      draw: (c) => rasterLowerThird(c, job.text, job.look, SCALE),
    };
  const model = { key: 'props', empty: false, items: job.items } as PropsModel;
  return {
    reach: () => propsReach(measure, model, SCALE),
    draw: (c) => rasterProps(c, model, SCALE, images, { r: 0, g: 0, b: 0, a: 1 }),
  };
}

function run(k: Case): CaseResult {
  const checks: Check[] = [];
  const check = (what: string, ok: boolean, detail = '') => checks.push({ what, ok, detail });
  const s = makeSurface();
  const surface = sizer(s);
  const take = () => s.canvas.transferToImageBitmap();
  if (k.job.kind === 'scene') {
    const job = k.job;
    // The M5 scene parts (full-frame, on a fresh context) against the tight ones placed at their offsets.
    const fresh = makeSurface();
    const ref = rasterScene(
      fresh.ctx,
      () => fresh.canvas.transferToImageBitmap(),
      job.slide,
      LOOK_MAIN,
      SCALE,
      images,
      'vid',
    );
    s.canvas.width = 1;
    s.canvas.height = 1;
    const tight = rasterSceneSprites(
      s.ctx,
      surface,
      take,
      { width: W, height: H },
      job.slide,
      LOOK_MAIN,
      SCALE,
      images,
      'vid',
    );
    check('the slide is a scene', !!ref && !!tight);
    if (!ref || !tight) return { name: k.name, checks };
    check(
      'base and over are tight',
      tight.base.tight && !!tight.over?.tight,
      `${tight.base.tight} ${tight.over?.tight}`,
    );
    check('no part was drawn again full-frame', !tight.base.missed && !tight.over?.missed);
    const at0 = (b: ImageBitmap) => ({ bitmap: b, x: 0, y: 0 });
    const want = placedPixels([at0(ref.base), ...(ref.over ? [at0(ref.over)] : [])]);
    const got = placedPixels([tight.base, ...(tight.over ? [tight.over] : [])]);
    const d = compare(got, want);
    check('tight base and over recompose the full-frame parts', same(d), `${d.differing} px, max ${d.max}`);
    const planes = ref.plane.every((v, i) => v === tight.plane[i]);
    check('the same plane', planes);
    return { name: k.name, checks };
  }
  // Reference on a fresh context; then, as the asset worker: the reach on the surface shrunk to 1x1, the
  // sprite drawn after the resize.
  const fresh = makeSurface();
  const { reach, draw } = drawerOf(k.job, s.ctx);
  draw(fresh.ctx);
  const want = fresh.ctx.getImageData(0, 0, W, H).data;
  s.canvas.width = 1;
  s.canvas.height = 1;
  const rect = spriteRect(reach(), SCALE, W, H);
  const got = drawSprite(surface, take, W, H, rect, draw);
  check(k.tight ? 'tight' : 'full-frame', got.tight === k.tight, `rect ${JSON.stringify(rect)}`);
  check('nothing touched the edge ring', !got.missed);
  if (got.tight) {
    check(
      'smaller than the frame',
      got.bitmap.width * got.bitmap.height < W * H,
      `${got.bitmap.width}x${got.bitmap.height}`,
    );
    const off = placedPixels([{ ...got, x: got.x + 1 }]);
    const bad = compare(off, want);
    const anyDrawn = want.some((v, i) => i % 4 === 3 && v > 0);
    if (anyDrawn) check('control: one pixel off differs', bad.differing > 0, `${bad.differing}`);
  }
  const d = compare(placedPixels([got]), want);
  check('the sprite at its offset is the full-frame picture', same(d), `${d.differing} px, max ${d.max}`);
  // Drawn again on the same context, full-frame: the same picture (a layout memo hit draws in its font).
  const again = surface(W, H);
  draw(again);
  const twice = compare(again.getImageData(0, 0, W, H).data, want);
  check('drawn again on the same context, the same picture', same(twice), `${twice.differing} px`);
  take().close();
  return { name: k.name, checks };
}

/** Control: text overflowing its box with its box as the reach must be caught and drawn full-frame. */
function shortReach(): CaseResult {
  const checks: Check[] = [];
  const s = makeSurface();
  const surface = sizer(s);
  const take = () => s.canvas.transferToImageBitmap();
  const slide: Slide = {
    id: 'short',
    objects: [text('t', LONG, box(300, 120, 900, 120), { fontSizePx: 48 })],
  };
  const draw = (c: Ctx2D) => rasterSlide(c, slide, LOOK_MAIN, SCALE, images, {});
  const fresh = makeSurface();
  draw(fresh.ctx);
  const want = fresh.ctx.getImageData(0, 0, W, H).data;
  draw(surface(W, H));
  take().close();
  const got = drawSprite(
    surface,
    take,
    W,
    H,
    spriteRect({ x: 300, y: 120, w: 900, h: 120 }, SCALE, W, H),
    draw,
  );
  checks.push({ what: 'a short reach is caught by the edge ring', ok: got.missed && !got.tight, detail: '' });
  const d = compare(placedPixels([got]), want);
  checks.push({ what: 'and drawn full-frame, uncut', ok: same(d), detail: `${d.differing} px` });
  return { name: 'control: a reach cut short', checks };
}

(window as unknown as { __sprites: (env?: 'resolver') => CaseResult[] }).__sprites = (env) => {
  installFontEnv(env === 'resolver' ? RESOLVER : LEGACY_FONT_ENV);
  try {
    return [...CASES.map(run), shortReach()];
  } finally {
    installFontEnv(LEGACY_FONT_ENV);
  }
};
