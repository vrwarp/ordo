import { pro7Type } from '@ordo/importers/proto.ts';
import { encodePng, makePng } from './png.ts';
import type { RgbaImage } from './types.ts';

/*
 * Synthetic decks for what the first corpus left out (2026-11-13 review of #20): text boxes, line masks,
 * rounded pictures and picture shadows and feathers. Font-free like the rest of the corpus: text is drawn in
 * the colour of the box or strap behind it (or is a single dot), so only the box and strap geometry count,
 * whatever face the machine's fontconfig picks; a full-width line mask is made taller than the slide (its
 * height offset), so its strap is a band whatever the line's baseline. The references restate ordo's own
 * drawing conventions (a regression check, not agreement with ProPresenter): a shape's stroke centred on
 * its outline, a line mask's strap the box width plus its width offset and moved by its horizontal offset,
 * a gradient over the object box, and LibreOffice's effect semantics that shapes and pictures share
 * (`effects.ts`): a shadow is the alpha blurred by σ = blur/√6 and offset, a soft edge the silhouette eroded
 * by the soft edge and blurred by it.
 */

/** A synthetic deck: the `.pro`, its media and one reference picture per slide (as `corpus.ts`'s). */
export type EffectsDeck = {
  name: string;
  proFileName: string;
  files: Map<string, Uint8Array>;
  referenceSlides: RgbaImage[];
};

type Rgb = [number, number, number];

const W = 1920;
const H = 1080;
const DARK: Rgb = [15, 20, 30];
const STACK_BLUR_SIGMA = 1 / Math.sqrt(6);

const color = ([r, g, b]: Rgb, alpha = 1) => ({ red: r / 255, green: g / 255, blue: b / 255, alpha });

function encode(obj: Record<string, unknown>): Uint8Array {
  const t = pro7Type('rv.data.Presentation');
  return t.encode(t.fromObject(obj)).finish();
}

function rtf(text: string, rgb: Rgb, sizePt: number): Uint8Array {
  const [r, g, b] = rgb;
  return new TextEncoder().encode(
    `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}{\\colortbl;\\red${r}\\green${g}\\blue${b};}\\f0\\fs${sizePt * 2}\\cf1 ${text}}`,
  );
}

function cue(id: string, elements: Record<string, unknown>[], bg: Rgb = DARK): Record<string, unknown> {
  return {
    uuid: { string: id },
    name: id,
    isEnabled: true,
    actions: [
      {
        type: 'ACTION_TYPE_PRESENTATION_SLIDE',
        isEnabled: true,
        slide: {
          presentation: {
            baseSlide: {
              drawsBackgroundColor: true,
              backgroundColor: color(bg),
              size: { width: W, height: H },
              elements,
            },
          },
        },
      },
    ],
  };
}

type Box = { x: number; y: number; w: number; h: number };

const bounds = (b: Box) => ({ origin: { x: b.x, y: b.y }, size: { width: b.w, height: b.h } });

/** A text element; `extra` adds its fill, stroke or line mask. */
function textElement(id: string, b: Box, text: Uint8Array, extra: Record<string, unknown>) {
  return {
    element: {
      uuid: { string: id },
      name: id,
      bounds: bounds(b),
      opacity: 1,
      text: { rtfData: text },
      ...extra,
    },
  };
}

/** A picture element of `media` stretched over `b`; `extra` adds its path, shadow or feather. */
function pictureElement(id: string, b: Box, media: string, extra: Record<string, unknown>) {
  return {
    element: {
      uuid: { string: id },
      name: id,
      bounds: bounds(b),
      opacity: 1,
      fill: {
        enable: true,
        media: {
          url: { absoluteString: `file:///${media}`, relativePath: media },
          image: { drawing: { scaleBehavior: 'SCALE_BEHAVIOR_STRETCH' } },
        },
      },
      ...extra,
    },
  };
}

// ---- reference drawing ------------------------------------------------------------------------------------

/** Signed distance from a pixel centre to a rounded rectangle (negative inside). */
function sdRoundRect(px: number, py: number, b: Box, r: number): number {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const qx = Math.abs(px - cx) - (b.w / 2 - r);
  const qy = Math.abs(py - cy) - (b.h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Anti-aliased coverage of a rounded rectangle (r 0: a rectangle) over the slide, shifted by (dx, dy). */
function coverage(b: Box, r: number, dx = 0, dy = 0): Float32Array {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = sdRoundRect(x + 0.5 - dx, y + 0.5 - dy, b, r);
      out[y * W + x] = Math.max(0, Math.min(1, 0.5 - d));
    }
  return out;
}

/**
 * `a` blurred by a Gaussian of σ px (separable, 3σ each side, edges clamped to zero), over the bounds of
 * what `a` holds grown by the kernel only (a few pictures on a slide, not the whole frame).
 */
function blur(a: Float32Array, sigma: number): Float32Array {
  if (!(sigma > 0.01)) return a;
  const rad = Math.ceil(3 * sigma);
  const k = new Float32Array(2 * rad + 1);
  let sum = 0;
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + rad] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (a[y * W + x]! > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  const out = new Float32Array(W * H);
  if (x1 < 0) return out;
  const bx0 = Math.max(0, x0 - rad);
  const bx1 = Math.min(W - 1, x1 + rad);
  const by0 = Math.max(0, y0 - rad);
  const by1 = Math.min(H - 1, y1 + rad);
  const tmp = new Float32Array(W * H);
  for (let y = y0; y <= y1; y++)
    for (let x = bx0; x <= bx1; x++) {
      let v = 0;
      for (let i = -rad; i <= rad; i++) {
        const xx = x + i;
        if (xx >= x0 && xx <= x1) v += a[y * W + xx]! * k[i + rad]!;
      }
      tmp[y * W + x] = v;
    }
  for (let y = by0; y <= by1; y++)
    for (let x = bx0; x <= bx1; x++) {
      let v = 0;
      for (let i = -rad; i <= rad; i++) {
        const yy = y + i;
        if (yy >= y0 && yy <= y1) v += tmp[yy * W + x]! * k[i + rad]!;
      }
      out[y * W + x] = v;
    }
  return out;
}

/** The sum of `alphas` (pictures apart from each other: a blur of the sum is the sum of the blurs). */
function sum(alphas: Float32Array[]): Float32Array {
  const out = new Float32Array(W * H);
  for (const a of alphas) for (let i = 0; i < out.length; i++) out[i]! += a[i]!;
  return out;
}

/** Layers composited over `base`, bottom first: each a colour and an alpha per pixel. */
function compose(
  base: Rgb,
  layers: { rgb: Rgb; alpha: Float32Array | ((x: number, y: number) => number) }[],
) {
  return makePng(W, H, (x, y) => {
    let [r, g, b] = base;
    for (const l of layers) {
      const a = typeof l.alpha === 'function' ? l.alpha(x, y) : l.alpha[y * W + x]!;
      r = r + (l.rgb[0] - r) * a;
      g = g + (l.rgb[1] - g) * a;
      b = b + (l.rgb[2] - b) * a;
    }
    return [Math.round(r), Math.round(g), Math.round(b), 255];
  });
}

// ---- the decks --------------------------------------------------------------------------------------------

/** Text boxes and line masks: a filled box, a filled and stroked box, a solid and a gradient full-width strap. */
function textAndMasks(): EffectsDeck {
  const CREAM: Rgb = [230, 220, 190];
  const RED: Rgb = [200, 60, 60];
  const BLUE: Rgb = [40, 140, 200];
  const box: Box = { x: 360, y: 300, w: 1200, h: 480 };
  const fill = (rgb: Rgb) => ({ fill: { enable: true, color: color(rgb) } });
  const strokeW = 16;

  const s1 = textElement('EL-TEXT-BOX', box, rtf('Amazing grace', CREAM, 40), fill(CREAM));
  const s2 = textElement('EL-TEXT-BORDER', box, rtf('How sweet the sound', CREAM, 40), {
    ...fill(CREAM),
    stroke: { enable: true, width: strokeW, color: color(RED) },
  });
  const band: Box = { x: 480, y: 440, w: 960, h: 200 };
  const mask = (extra: Record<string, unknown>) => ({
    textLineMask: { enabled: true, maskStyle: 'LINE_MASK_STYLE_FULL_WIDTH', heightOffset: 2000, ...extra },
  });
  const s3 = textElement('EL-MASK-SOLID', band, rtf('That saved a wretch', BLUE, 32), {
    ...fill(BLUE),
    ...mask({ widthOffset: 80, horizontalOffset: 20 }),
  });
  const s4 = textElement('EL-MASK-GRADIENT', band, rtf('.', [140, 60, 140], 8), {
    fill: {
      enable: true,
      gradient: {
        type: 'TYPE_LINEAR',
        angle: 0,
        stops: [
          { color: color([220, 60, 60]), position: 0 },
          { color: color([60, 60, 220]), position: 1 },
        ],
      },
    },
    ...mask({}),
  });
  const name = 'pro7-synth-text-and-masks';
  const proFileName = `${name}.pro`;
  const bytes = encode({
    uuid: { string: 'SYNTH-TEXT-UUID' },
    name,
    cues: [
      cue('CUE-TEXT-1', [s1]),
      cue('CUE-TEXT-2', [s2]),
      cue('CUE-TEXT-3', [s3]),
      cue('CUE-TEXT-4', [s4]),
    ],
  });

  const inBox = coverage(box, 0);
  const ref1 = compose(DARK, [{ rgb: CREAM, alpha: inBox }]);
  // The outline centred on the box's edge, over its fill.
  const outer = coverage(
    { x: box.x - strokeW / 2, y: box.y - strokeW / 2, w: box.w + strokeW, h: box.h + strokeW },
    0,
  );
  const inner = coverage(
    { x: box.x + strokeW / 2, y: box.y + strokeW / 2, w: box.w - strokeW, h: box.h - strokeW },
    0,
  );
  const ring = new Float32Array(W * H);
  for (let i = 0; i < ring.length; i++) ring[i] = Math.max(0, outer[i]! - inner[i]!);
  const ref2 = compose(DARK, [
    { rgb: CREAM, alpha: inBox },
    { rgb: RED, alpha: ring },
  ]);
  // A strap from the box's x less half the width offset, moved by the horizontal offset, over every row.
  const strapX = band.x - 80 / 2 + 20;
  // The share of pixel column [x, x + 1) the strap [x0, x0 + w) covers.
  const strap = (x0: number, w: number) => (x: number) =>
    Math.max(0, Math.min(x + 1, x0 + w) - Math.max(x, x0));
  const solid = strap(strapX, band.w + 80);
  const ref3 = compose(DARK, [{ rgb: BLUE, alpha: (x) => solid(x) }]);
  const plain = strap(band.x, band.w);
  const ref4 = makePng(W, H, (x) => {
    const a = plain(x);
    // The gradient over the object box, left to right.
    const t = Math.max(0, Math.min(1, (x + 0.5 - band.x) / band.w));
    const g: Rgb = [220 + (60 - 220) * t, 60, 60 + (220 - 60) * t];
    return [
      Math.round(DARK[0] + (g[0] - DARK[0]) * a),
      Math.round(DARK[1] + (g[1] - DARK[1]) * a),
      Math.round(DARK[2] + (g[2] - DARK[2]) * a),
      255,
    ];
  });
  return {
    name,
    proFileName,
    files: new Map([[proFileName, bytes]]),
    referenceSlides: [ref1, ref2, ref3, ref4],
  };
}

/**
 * Pictures: round corners, round corners with a shadow, feathered rectangles, round, feathered and shadowed;
 * three a slide on a light background, so a square corner, another blur or a hard cut moves the score past
 * the ratchet's 0.5 % (#20's drawing scored 0.4 % lower on one picture over dark grey). Slide 5: a feathered
 * full-frame photo under a shadowed, feathered photo of 1400 x 800, both kept within the slide's effect budget
 * (`geom/cost.ts` `EFFECT_COST.preparedSoftEdge`: at a shape's soft-edge weight the second lost both effects,
 * the 2026-11-13 review).
 */
function pictureEffects(): EffectsDeck {
  const LIGHT: Rgb = [205, 210, 220];
  const ORANGE: Rgb = [240, 150, 40];
  const boxes: Box[] = [120, 710, 1300].map((x) => ({ x, y: 390, w: 500, h: 300 }));
  const roundness = 0.6;
  const radius = roundness * 300 * 0.5;
  const rounded = {
    path: { closed: true, shape: { type: 'TYPE_ROUNDED_RECTANGLE', roundedRectangle: { roundness } } },
  };
  // ProPresenter's drop shadow: 40 px at 315° (down and to the right on the canvas), radius 40, opaque black.
  const shadow = {
    shadow: { enable: true, angle: 315, offset: 40, radius: 40, opacity: 1, color: color([0, 0, 0]) },
  };
  const feather = { feather: { enable: true, radius: 0.3 } };
  const media = 'Media/orange.png';
  const three = (id: string, extra: Record<string, unknown>) =>
    boxes.map((b, i) => pictureElement(`${id}-${i}`, b, media, extra));
  // ProPresenter lists elements front to back: reversed, the first is drawn first (all three apart anyway).
  // Slide 5: a full-frame photo feathered by 0.1 (54 px), and over it a blue photo feathered by 0.1 (40 px)
  // with the drop shadow.
  const full: Box = { x: 0, y: 0, w: W, h: H };
  const photo: Box = { x: 260, y: 140, w: 1400, h: 800 };
  const thin = { feather: { enable: true, radius: 0.1 } };
  const blueMedia = 'Media/blue.png';
  const BLUE: Rgb = [40, 90, 200];
  const slides = [
    three('EL-PIC-ROUND', rounded),
    three('EL-PIC-SHADOW', { ...rounded, ...shadow }),
    three('EL-PIC-FEATHER', feather),
    three('EL-PIC-ALL', { ...rounded, ...feather, ...shadow }),
    [
      pictureElement('EL-PIC-TWO-0', full, media, thin),
      pictureElement('EL-PIC-TWO-1', photo, blueMedia, { ...thin, ...shadow }),
    ],
  ];
  const name = 'pro7-synth-picture-effects';
  const proFileName = `${name}.pro`;
  const bytes = encode({
    uuid: { string: 'SYNTH-PIC-FX-UUID' },
    name,
    cues: slides.map((els, i) => cue(`CUE-PIC-${i + 1}`, [...els].reverse(), LIGHT)),
  });

  const references = (): RgbaImage[] => {
    const dx = Math.round(Math.cos((315 * Math.PI) / 180) * 40);
    const dy = Math.round(-Math.sin((315 * Math.PI) / 180) * 40);
    const e = 0.3 * 300 * 0.5;
    // The three pictures' shadows apart from each other's pictures: one layer under all three.
    const shadowOf = (alpha: Float32Array) => {
      const shifted = new Float32Array(W * H);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const sx = x - dx;
          const sy = y - dy;
          shifted[y * W + x] = sx >= 0 && sx < W && sy >= 0 && sy < H ? alpha[sy * W + sx]! : 0;
        }
      return blur(shifted, 40 * STACK_BLUR_SIGMA);
    };
    const round = sum(boxes.map((b) => coverage(b, radius)));
    const square = sum(boxes.map((b) => coverage(b, 0)));
    const feathered = (r: number, cut: Float32Array) => {
      const eroded = sum(
        boxes.map((b) =>
          coverage({ x: b.x + e, y: b.y + e, w: b.w - 2 * e, h: b.h - 2 * e }, Math.max(0, r - e)),
        ),
      );
      const f = blur(eroded, e * STACK_BLUR_SIGMA);
      for (let i = 0; i < f.length; i++) f[i] = Math.min(f[i]!, cut[i]!);
      return f;
    };
    const shadowed = (a: Float32Array) => [
      { rgb: [0, 0, 0] as Rgb, alpha: shadowOf(a) },
      { rgb: ORANGE, alpha: a },
    ];
    // One picture feathered by `fe` px: its box eroded by `fe` and blurred by it, never past the box.
    const featherOf = (b: Box, fe: number) => {
      const f = blur(
        coverage({ x: b.x + fe, y: b.y + fe, w: b.w - 2 * fe, h: b.h - 2 * fe }, 0),
        fe * STACK_BLUR_SIGMA,
      );
      const cut = coverage(b, 0);
      for (let i = 0; i < f.length; i++) f[i] = Math.min(f[i]!, cut[i]!);
      return f;
    };
    const top = featherOf(photo, 0.1 * 0.5 * photo.h);
    return [
      compose(LIGHT, [{ rgb: ORANGE, alpha: round }]),
      compose(LIGHT, shadowed(round)),
      compose(LIGHT, [{ rgb: ORANGE, alpha: feathered(0, square) }]),
      compose(LIGHT, shadowed(feathered(radius, round))),
      compose(LIGHT, [
        { rgb: ORANGE, alpha: featherOf(full, 0.1 * 0.5 * full.h) },
        { rgb: [0, 0, 0], alpha: shadowOf(top) },
        { rgb: BLUE, alpha: top },
      ]),
    ];
  };
  let made: RgbaImage[] | undefined;
  return {
    name,
    proFileName,
    files: new Map<string, Uint8Array>([
      [proFileName, bytes],
      [media, encodePng(makePng(64, 64, () => [...ORANGE, 255]))],
      [blueMedia, encodePng(makePng(64, 64, () => [...BLUE, 255]))],
    ]),
    // Made when first read (a few seconds of blurs): the corpus is built often, its pictures scored once.
    get referenceSlides() {
      made ??= references();
      return made;
    },
  };
}

/** The decks of this module, after `corpus.ts`'s three. */
export function buildEffectsCorpus(): EffectsDeck[] {
  return [textAndMasks(), pictureEffects()];
}
