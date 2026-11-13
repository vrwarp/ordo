import {
  DEFAULT_LYRIC_STYLE,
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  type Look,
  type Slide,
  type SlideObject,
  type TextStyle,
} from '@ordo/domain';
import { m9Slide, m9Table } from '@ordo/domain/m9.test-util.ts';
import { clearGeomFiles, putGeomFile } from './geom/stored.ts';
import type { PropsModel } from './props.ts';
import { rasterLowerThird, rasterProps, rasterSlide } from './raster.ts';
import { rasterScene, rasterSceneSprites } from './scene-raster.ts';
import { type Reach, drawSprite, lowerThirdReach, propsReach, slideReach, spriteRect } from './sprite.ts';
import { LEGACY_FONT_ENV, installFontEnv } from './text/fonts.ts';
import type { FontEnv } from './text/types.ts';
import type { Ctx2D, ImageLookup } from './text2d.ts';
// The table drawer, registered as the outputs register it (M9).
import './table/index.ts';

/**
 * Browser side of sprite.browser.test.ts (design/27 §7.3, M7): draws slides, bands, the lower third and
 * props the way the asset worker does, once full-frame and once as a tight sprite (`slideReach` and the
 * other reaches, `spriteRect`, `drawSprite` on a CPU-backed OffscreenCanvas, `transferToImageBitmap` as the
 * take), places the sprite at its offset on a transparent frame and checks that it is the full-frame
 * picture (a whole-pixel offset rasters the same; Chromium's anti-aliasing of a curve or a glyph edge may
 * differ by a few levels on a few pixels, NOISE), that it is tight where a sprite saves work (and full-frame
 * where it does not: one box over disjoint corners of the frame covers most of it), and that nothing
 * touched its edge ring (no redraw). Glyph parts wholly outside their line box (tone marks stacked over
 * Vietnamese capitals, Thai and Arabic marks, tall scripts, with tight line spacing: `MARK_CASES`) must be
 * in the reach, since the edge ring never sees them. Scenes draw
 * base and over as sprites and are recomposed the same way. Controls: a reach cut short of what is drawn
 * (text that overflows its box, the box alone as its reach) must be caught by the edge ring and drawn
 * full-frame, and recomposing a sprite one pixel off must differ.
 *
 * A slide like the worship decks' (traced outlines read from geometry files, office-model text that shrinks to
 * fit, turned text) is also drawn at 1920 and 3840 and compared in premultiplied levels (getImageData
 * unpremultiplies, so a pixel of alpha 1 carries any colour): a tight sprite's device translation differs from
 * the frame's by its offset, which moves float32 device coordinates by about 1e-4 px and can flip an
 * anti-aliasing sample or a glyph's subpixel bucket on a few edge pixels (`REAL_NOISE`, design/27 §7.3).
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
/**
 * The same for real slides at 1920 and 3840, in premultiplied levels (M6 merge review, 268 converted worship
 * slides drawn as tight sprites: at most 287 pixels of a slide, at most 70 levels on 180 glyph-edge pixels of
 * an autofit text, 55 on 39 edge pixels of a traced outline; nothing outside the sprite's rect).
 */
const REAL_NOISE = { pixels: 400, levels: 72 };

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

/**
 * Glyph parts that are shapes of their own and lie wholly outside their line box with tight line spacing,
 * no padding and no effects: tone marks stacked over a circumflex on Vietnamese capitals (1.11 em above the
 * baseline), Thai marks above a vowel, Arabic vowel marks, and the tall Devanagari and Burmese scripts. The
 * edge ring cannot see a shape that never crosses it, so these must be in the reach (the measured ink).
 */
const MARKS: [string, string][] = [
  ['Vietnamese capitals', 'Ễ Ể Ề Ế Ỗ Ổ'],
  ['Vietnamese lowercase', 'ễ ể ề ế ỗ ổ'],
  ['Thai', 'ปี่ ญ ฐ สวัสดี'],
  ['Arabic marks', 'بِسْمِ ٱللَّٰهِ'],
  ['Devanagari', 'हिन्दी दुनिया'],
  ['Burmese', 'မြန်မာ ဘာသာ'],
];
// 240 logical px is 120 device px at this page's half scale: the size, line height and fractional pen
// position of a 120 px line at 1920x1080, so the full-size picture is drawn here pixel for pixel.
const MARK_PX = 240;
const bare = { fontSizePx: MARK_PX, padding: 0, shadow: undefined, outline: undefined } as Partial<TextStyle>;
const markBox = box(200, 300, 1500, 400);
const MARK_CASES: Case[] = MARKS.flatMap(([name, t], i): Case[] => [
  ...[0.7, 0.35].map(
    (lh): Case => ({
      name: `${name}, line height ${lh}, no padding or effects (legacy text)`,
      job: {
        kind: 'slide',
        slide: { id: `mk${i}-${lh}`, objects: [text('t', t, markBox, { ...bare, lineHeight: lh })] },
        look: LOOK_MAIN,
      },
      tight: true,
    }),
  ),
  // Rich text: the office line model at 0.45 of single spacing, and exact spacing of 0.65 em.
  ...[
    ['spacing 0.45', { lineSpacing: 0.45 }],
    ['exact 0.65 em', { lineSpacingPx: 0.65 * MARK_PX }],
  ].map(
    ([how, para]): Case => ({
      name: `${name}, ${how as string}, no padding or effects (rich text)`,
      job: {
        kind: 'slide',
        slide: {
          id: `mkr${i}-${how as string}`,
          objects: [
            text(
              't',
              t,
              markBox,
              { ...bare, lineModel: 'office' },
              { paras: [para], runs: [{ start: 0, end: 1, fontWeight: 700 }] },
            ),
          ],
        },
        look: LOOK_MAIN,
      },
      tight: true,
    }),
  ),
]);

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
    name: 'PowerPoint shapes (M6): a callout tail past its box, arrowheads, a mitred star, flipped and turned',
    job: {
      kind: 'slide',
      slide: {
        id: 'geom',
        objects: [
          {
            ...shape('c', 'rect', box(200, 520, 400, 200)),
            radius: 0,
            geom: { preset: 'wedgeRectCallout', adj: [['adj2', 95_000]] },
            flipV: true,
          } as SlideObject,
          {
            ...shape('a', 'line', box(700, 640, 400, 120, 12)),
            stroke: { width: 10, color: { r: 250, g: 200, b: 40, a: 1 } },
            ends: { head: { type: 'triangle', w: 'lg', len: 'lg' }, tail: { type: 'stealth' } },
            dash: 'dash',
          } as SlideObject,
          {
            ...shape('s', 'rect', box(1250, 560, 260, 260, 30)),
            radius: 0,
            geom: { preset: 'star5' },
            stroke: { width: 24, color: { r: 250, g: 250, b: 250, a: 1 } },
            flipH: true,
            gradient: {
              kind: 'linear',
              angle: 45,
              stops: [
                { at: 0, color: { r: 200, g: 40, b: 40, a: 1 } },
                { at: 1, color: { r: 40, g: 40, b: 200, a: 1 } },
              ],
            },
          } as SlideObject,
        ],
      },
      look: LOOK_MAIN,
    },
    tight: true,
  },
  {
    name: 'PowerPoint shapes (M6) with effects: an outer shadow, a glow and a soft edge',
    job: {
      kind: 'slide',
      slide: {
        id: 'fx',
        objects: [
          {
            ...shape('sh', 'rect', box(220, 560, 360, 200)),
            geom: { preset: 'roundRect' },
            shadow: { dx: 24, dy: 30, blur: 40, color: { r: 0, g: 0, b: 0, a: 0.7 } },
          } as SlideObject,
          {
            ...shape('gl', 'ellipse', box(760, 600, 260, 180, 20)),
            glow: { radius: 36, color: { r: 255, g: 220, b: 60, a: 0.8 } },
          } as SlideObject,
          {
            ...shape('se', 'rect', box(1200, 580, 360, 220)),
            radius: 0,
            softEdge: 30,
          } as SlideObject,
        ],
      },
      look: LOOK_MAIN,
    },
    tight: true,
  },
  {
    name: 'a picture cut to a star, mirrored and turned (M6 mask, M4 flips), and gradient text',
    job: {
      kind: 'slide',
      slide: {
        id: 'mask',
        objects: [
          {
            id: 'm',
            type: 'image',
            box: box(300, 520, 420, 300, 20),
            mediaId: 'pic',
            fit: 'cover',
            opacity: 1,
            radius: 0,
            flipH: true,
            mask: { preset: 'star5' },
          } as SlideObject,
          text('g', 'Grace', box(900, 600, 700, 220), {
            fontSizePx: 160,
            paint: {
              kind: 'linear',
              angle: 90,
              stops: [
                { at: 0, color: { r: 255, g: 200, b: 0, a: 1 } },
                { at: 1, color: { r: 200, g: 0, b: 120, a: 1 } },
              ],
            },
          }),
        ],
      },
      look: LOOK_MAIN,
    },
    tight: true,
  },
  {
    name: 'M9 table: rows grown past its box by their text, a diagonal, turned 8 degrees',
    job: {
      kind: 'slide',
      slide: {
        id: 'm9-table',
        objects: [
          {
            id: 'tb',
            type: 'shape',
            box: box(360, 300, 1000, 150, 8),
            shape: 'rect',
            fill: { r: 255, g: 255, b: 255, a: 1 },
            opacity: 1,
            radius: 0,
            table: m9Table(),
          } as SlideObject,
        ],
      },
      look: LOOK_MAIN,
    },
    tight: true,
  },
  {
    name: 'M9 looks without their drawers: warped, vertical and centred text, a 3-D pie and picture, a chart',
    job: {
      kind: 'slide',
      slide: {
        id: 'm9-looks',
        objects: [
          ...m9Slide()
            .objects.filter((o) => ['title', 'vertical', 'centred', 'pie', 'emf', 'chart'].includes(o.id))
            .map((o) => {
              // Gathered into the middle of the frame, the picture on the test picture. The pie is not turned:
              // a turned 270° arc moved by the sprite's offset differs by a level on hundreds of edge pixels
              // (float32 device coordinates, the real-like slides' noise), which this case does not test.
              const at: Record<string, ReturnType<typeof box>> = {
                title: box(400, 250, 900, 130),
                vertical: box(1150, 520, 300, 100, 90),
                centred: box(700, 420, 420, 260),
                pie: box(420, 420, 240, 240),
                emf: box(420, 700, 260, 160),
                chart: box(1050, 720, 300, 120),
              };
              return {
                ...o,
                box: at[o.id]!,
                ...(o.type === 'image' ? { mediaId: 'pic' } : {}),
              } as SlideObject;
            }),
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
  ...MARK_CASES,
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

/** A traced outline: a closed wavy blob of `points` points (cubic segments) in a 1000 x 1000 space. */
function traced(points: number, seed: number): string {
  const segs = Math.max(4, Math.floor(points / 3));
  const at = (k: number) => {
    const a = (k / segs) * Math.PI * 2;
    const r = 400 * (1 + 0.2 * Math.sin(5 * a + seed) + 0.08 * Math.sin(23 * a + 2 * seed));
    return [500 + r * Math.cos(a), 500 + r * Math.sin(a)];
  };
  const f = (v: number) => v.toFixed(2);
  const [x0, y0] = at(0);
  let d = `M ${f(x0!)} ${f(y0!)}`;
  for (let k = 0; k < segs; k++) {
    const [ax, ay] = at(k + 1 / 3);
    const [bx, by] = at(k + 2 / 3);
    const [cx, cy] = at(k + 1);
    d += ` C ${f(ax!)} ${f(ay!)} ${f(bx!)} ${f(by!)} ${f(cx!)} ${f(cy!)}`;
  }
  return `${d} Z`;
}

/** Geometry files of the real-like slide (64 hex digits, as the hub names them). */
const FILES = [0, 1, 2].map((i) => ({ ref: `${i}`.repeat(64), d: traced(600 + 400 * i, i) }));

/** A slide like the worship decks': traced outlines in geometry files, office-model autofit text, turned text. */
const REAL_LIKE: Slide = {
  id: 'real-like',
  objects: [
    ...Array.from({ length: 9 }, (_, i): SlideObject => {
      const f = FILES[i % 3]!;
      return {
        id: `deco${i}`,
        type: 'shape',
        box: box(1030.37 + 83.3 * (i % 3), 120.61 + 190.7 * Math.floor(i / 3), 210.4, 180.9, i * 7.5),
        shape: 'rect',
        fill: { r: 90 + 20 * i, g: 140, b: 110, a: i % 2 ? 0.85 : 1 },
        ...(i % 3 === 1 ? { stroke: { width: 2.25, color: { r: 40, g: 50, b: 40, a: 1 } } } : {}),
        opacity: 1,
        radius: 0,
        geom: { ref: f.ref, paths: [{ d: 'M 0 0 L 1000 0 L 1000 1000 Z', w: 1000, h: 1000 }] },
        ...(i === 4 ? { flipH: true } : {}),
      } as SlideObject;
    }),
    text('fit', LONG, box(120.3, 160.45, 820.7, 420.2), {
      fontFamily: 'serif',
      fontSizePx: 64,
      shadow: undefined,
      outline: undefined,
      lineModel: 'office',
      autofit: 'shrink',
      fitScale: { font: 0.775, spacing: 0.9 },
      insets: { l: 14.4, t: 7.2, r: 14.4, b: 7.2 },
    }),
    text('turned', 'He is risen', box(240.5, 640.3, 600, 140), { fontSizePx: 72, shadow: undefined }, {}),
  ].map((o) => (o.id === 'turned' ? { ...o, box: { ...o.box, rotation: -6.5 } } : o)) as SlideObject[],
};

/** Premultiplied difference of two RGBA frames: pixels that differ, and the largest level. */
function comparePremultiplied(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
): { differing: number; max: number } {
  let differing = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = Math.abs(a[i + 3]! - b[i + 3]!);
    for (let c = 0; c < 3; c++)
      d = Math.max(d, Math.round(Math.abs(a[i + c]! * a[i + 3]! - b[i + c]! * b[i + 3]!) / 255));
    if (d > 0) differing++;
    if (d > max) max = d;
  }
  return { differing, max };
}

/** The real-like slide at `width` (16:9) as a tight sprite against its full-frame draw, premultiplied. */
function realLike(width: number): CaseResult {
  const checks: Check[] = [];
  const check = (what: string, ok: boolean, detail = '') => checks.push({ what, ok, detail });
  clearGeomFiles();
  for (const f of FILES) putGeomFile(f.ref, { paths: [{ d: f.d, w: 1000, h: 1000 }] });
  try {
    const w = width;
    const h = Math.round((width * 9) / 16);
    const scale = w / 1920;
    const draw = (c: Ctx2D) => rasterSlide(c, structuredClone(REAL_LIKE), LOOK_MAIN, scale, images, {});
    const fresh = new OffscreenCanvas(w, h);
    const fx = fresh.getContext('2d', { willReadFrequently: true })!;
    draw(fx);
    const want = fx.getImageData(0, 0, w, h).data;
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const surface = (sw: number, sh: number): Ctx2D => {
      canvas.width = sw;
      canvas.height = sh;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return ctx;
    };
    const rect = spriteRect(
      slideReach(ctx, structuredClone(REAL_LIKE), { scale, look: LOOK_MAIN }),
      scale,
      w,
      h,
    );
    const got = drawSprite(surface, () => canvas.transferToImageBitmap(), w, h, rect, draw);
    check('tight', got.tight, `rect ${JSON.stringify(rect)}`);
    check('nothing touched the edge ring', !got.missed);
    const c = new OffscreenCanvas(w, h);
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.drawImage(got.bitmap, got.x, got.y);
    const d = comparePremultiplied(x.getImageData(0, 0, w, h).data, want);
    check(
      "the sprite at its offset is the full-frame picture within the real slides' noise (premultiplied)",
      d.differing <= REAL_NOISE.pixels && d.max <= REAL_NOISE.levels,
      `${d.differing} px, max ${d.max}`,
    );
    got.bitmap.close();
  } finally {
    clearGeomFiles();
  }
  return { name: `real-like slide at ${width}: geometry files, autofit and turned text`, checks };
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
    return [...CASES.map(run), shortReach(), realLike(1920), realLike(3840)];
  } finally {
    installFontEnv(LEGACY_FONT_ENV);
  }
};
