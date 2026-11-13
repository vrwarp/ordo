import type { ImageObject, ShapeObject, Slide, SlideObject } from '@ordo/domain';
import { clearEffectCache, effectWork } from './effects.ts';
import {
  PREPARE_STEP_PIXELS,
  type PictureTarget,
  pictureTarget,
  preparePicture,
  preparePictureSteps,
} from './picture.ts';
import { drawSlide2D, type ImageLookup } from './text2d.ts';

/**
 * Browser side of picture-effects.browser.test.ts: pictures with a shadow and a soft edge (`ImageObject.shadow`,
 * `softEdge`; design/20 "ProPresenter", design/27 §3.1) drawn as the outputs (prepared pictures), the
 * thumbnails and the editor (from the source) draw them, at 1920 x 1080 on a transparent OffscreenCanvas.
 * Each case returns its checks; the runner expects every one to hold.
 */

export type Check = { what: string; ok: boolean; detail: string };
export type CaseResult = { name: string; checks: Check[] };

const W = 1920;
const H = 1080;
const RED = { r: 220, g: 30, b: 30, a: 1 };
const BLACK = (a: number) => ({ r: 0, g: 0, b: 0, a });

function solid(w: number, h: number, css: string): OffscreenCanvas {
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d')!;
  x.fillStyle = css;
  x.fillRect(0, 0, w, h);
  return c;
}

function quadrants(): OffscreenCanvas {
  const c = new OffscreenCanvas(400, 300);
  const x = c.getContext('2d')!;
  const q = [
    ['#d23', 0, 0],
    ['#2b4', 200, 0],
    ['#24d', 0, 150],
    ['#ec2', 200, 150],
  ] as const;
  for (const [css, qx, qy] of q) {
    x.fillStyle = css;
    x.fillRect(qx, qy, 200, 150);
  }
  return c;
}

const SOURCES: Record<string, OffscreenCanvas> = {};
function source(id: string): OffscreenCanvas | undefined {
  if (!SOURCES.red) SOURCES.red = solid(64, 64, 'rgb(220,30,30)');
  if (!SOURCES.quadrants) SOURCES.quadrants = quadrants();
  return SOURCES[id];
}

/** The thumbnails' and the editor's lookup: every picture from its source. */
const fromSource: ImageLookup = (id) => source(id);

/** The outputs' lookup (the asset worker): each picture prepared once for its target and copied 1:1. */
function preparedLookup(): ImageLookup {
  const made = new Map<string, ImageBitmap>();
  return (id, target?: PictureTarget) => {
    const src = source(id);
    if (!src || !target) return src;
    const key = `${id}|${target.key}`;
    let bmp = made.get(key);
    if (!bmp) {
      bmp = preparePicture(src, target);
      if (bmp) made.set(key, bmp);
    }
    return bmp ?? src;
  };
}

function image(
  id: string,
  box: [number, number, number, number],
  extra: Partial<ImageObject> = {},
): ImageObject {
  return {
    id,
    type: 'image',
    box: { x: box[0], y: box[1], w: box[2], h: box[3], rotation: 0 },
    mediaId: 'red',
    fit: 'stretch',
    opacity: 1,
    radius: 0,
    ...extra,
  };
}

function draw(objects: SlideObject[], images: ImageLookup): ImageData {
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const slide: Slide = { id: 's', objects };
  drawSlide2D(ctx, slide, { scale: 1, images, isSong: false });
  return ctx.getImageData(0, 0, W, H);
}

function px(d: ImageData, x: number, y: number): [number, number, number, number] {
  const i = (Math.round(y) * d.width + Math.round(x)) * 4;
  return [d.data[i]!, d.data[i + 1]!, d.data[i + 2]!, d.data[i + 3]!];
}

/** Pixels differing by more than `levels` in a premultiplied channel, and the largest difference. */
function diff(a: ImageData, b: ImageData, levels: number): { differing: number; max: number } {
  let differing = 0;
  let max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const aa = a.data[i + 3]! / 255;
    const ba = b.data[i + 3]! / 255;
    let m = Math.abs(a.data[i + 3]! - b.data[i + 3]!);
    for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(a.data[i + k]! * aa - b.data[i + k]! * ba));
    if (m > levels) differing++;
    max = Math.max(max, m);
  }
  return { differing, max: Math.round(max) };
}

function check(checks: Check[], what: string, ok: boolean, detail: unknown): void {
  checks.push({ what, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
}

const SHADOW = { dx: 24, dy: 24, blur: 36, color: BLACK(0.8) };

/** Round corners kept with a shadow, on both paths (with effects, round corners are a mask: prepared too). */
function roundedShadow(): CaseResult {
  const checks: Check[] = [];
  const o = image('p', [400, 300, 600, 400], { radius: 80, shadow: SHADOW });
  const t = pictureTarget(o, 1);
  check(
    checks,
    'a round-cornered picture with effects is prepared, cut to its corners',
    !!t?.shape?.mask,
    t?.key ?? 'none',
  );
  const plain = pictureTarget(image('q', [400, 300, 600, 400], { radius: 80 }), 1);
  check(
    checks,
    'one without effects keeps its clip (not prepared)',
    plain === undefined,
    plain?.key ?? 'none',
  );
  for (const [path, lookup] of [
    ['source', fromSource],
    ['prepared', preparedLookup()],
  ] as const) {
    const d = draw([o], lookup);
    const corner = px(d, 404, 304);
    check(checks, `${path}: the corner outside the round corner is not the picture`, corner[3] < 60, corner);
    const centre = px(d, 700, 500);
    check(checks, `${path}: the centre is the picture`, centre[0] > 200 && centre[3] === 255, centre);
    // The shadow (offset 24, 24) shows past the right edge, where its straight side runs.
    const shadow = px(d, 1012, 600);
    check(checks, `${path}: the shadow shows past the right edge`, shadow[3] > 100 && shadow[0] < 10, shadow);
    const inner = px(d, 990, 600);
    check(
      checks,
      `${path}: the picture's right edge is the picture`,
      inner[0] > 200 && inner[3] > 250,
      inner,
    );
  }
  return { name: 'rounded picture with a shadow', checks };
}

/** Round corners kept with a soft edge: the edges fade, the corners round. */
function roundedFeather(): CaseResult {
  const checks: Check[] = [];
  const o = image('p', [400, 300, 600, 400], { radius: 80, softEdge: 40 });
  const d = draw([o], fromSource);
  const dd = diff(d, draw([o], preparedLookup()), 12);
  check(checks, 'prepared and source pictures agree', dd.differing <= 200 && dd.max <= 24, dd);
  const centre = px(d, 700, 500);
  check(checks, 'the centre is opaque', centre[3] === 255, centre);
  const edge = px(d, 401, 500);
  check(checks, 'the box edge has faded', edge[3] < 30, edge);
  const inside = px(d, 400 + 40, 500);
  check(checks, 'half way in at the erosion line', inside[3] > 80 && inside[3] < 180, inside);
  const corner = px(d, 400 + 40, 300 + 40);
  const side = px(d, 700, 300 + 40);
  check(checks, 'the corner fades more than the side (round)', corner[3] + 20 < side[3], { corner, side });
  return { name: 'rounded picture with a soft edge', checks };
}

/** A prepared picture holds the soft edge (`SOFT_EDGE_STEP`) and looks as the source path draws it. */
function preparedFeather(): CaseResult {
  const checks: Check[] = [];
  const objs = [
    image('rect', [300, 200, 800, 500], { mediaId: 'quadrants', fit: 'cover', softEdge: 50 }),
    image('ellipse', [1200, 150, 500, 500], {
      mediaId: 'quadrants',
      fit: 'cover',
      softEdge: 30,
      mask: { preset: 'ellipse' },
      flipH: true,
    }),
    image('edge', [-200, 700, 900, 500], { mediaId: 'quadrants', fit: 'cover', softEdge: 60 }),
  ];
  const t = pictureTarget(objs[0]!, 1);
  check(checks, 'a soft-edged picture is prepared', !!t && t.key.includes(' e50'), t?.key ?? 'none');
  const a = draw(objs, fromSource);
  const b = draw(objs, preparedLookup());
  const dd = diff(a, b, 12);
  // Measured: at most 12 levels (the soft edge's mask is made over the bitmap's rect, not the sprite's).
  check(checks, 'prepared and source pictures agree', dd.differing <= 200 && dd.max <= 24, dd);
  // The ellipse's feather ends at its outline: eroded, not cut half-opaque.
  const rim = px(b, 1200 + 2, 400);
  check(checks, "the ellipse's rim has faded (eroded mask)", rim[3] < 30, rim);
  // A picture the canvas cuts is not faded at the canvas's edge, only at its own.
  const cut = px(b, 300, 1079);
  check(checks, 'no fade where the canvas cuts the picture', cut[3] > 240, cut);
  const own = px(b, 701, 1000);
  check(checks, 'its own edge fades', own[3] < 40, own);
  return { name: 'prepared soft edge', checks };
}

/** Banded preparation (the raster lanes' steps) gives the one-step bitmap byte for byte, soft edge included. */
function bandedFeather(): CaseResult {
  const checks: Check[] = [];
  const o = image('p', [0, 0, 1920, 1080], { mediaId: 'quadrants', fit: 'cover', softEdge: 54 });
  for (const scale of [1, 2]) {
    const t = pictureTarget(o, scale)!;
    const src = source('quadrants')!;
    const one = preparePicture(src, t)!;
    const steps = preparePictureSteps(src, t, undefined, 1 << 18);
    let n = 0;
    let r = steps.next();
    while (!r.done) {
      n++;
      r = steps.next();
    }
    const banded = r.value!;
    const read = (bmp: ImageBitmap) => {
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const x = c.getContext('2d', { willReadFrequently: true })!;
      x.drawImage(bmp, 0, 0);
      return x.getImageData(0, 0, bmp.width, bmp.height);
    };
    const dd = diff(read(one), read(banded), 0);
    check(checks, `@${scale}: banded (${n + 1} steps) = one step`, dd.differing === 0, dd);
  }
  // As the raster lanes prepare it at 4K (PREPARE_STEP_PIXELS a step): the soft edge's multiply is banded
  // too (its mask a step, then a band a step), so no step holds the whole frame's multiply.
  const t4 = pictureTarget(o, 2)!;
  const g = preparePictureSteps(source('quadrants')!, t4);
  let steps = 1;
  while (!g.next().done) steps++;
  const bands = Math.ceil(t4.h / Math.floor(PREPARE_STEP_PIXELS / t4.w));
  check(checks, `@2: ${steps} steps for ${bands} bands (paint, mask, multiply)`, steps === 2 * bands + 1, {
    steps,
    bands,
  });
  return { name: 'banded preparation of a feathered picture', checks };
}

/**
 * Drawn into a tight sprite, as the outputs' asset worker draws a slide that covers part of the frame: the
 * canvas is the sprite and the drawing is translated to its origin. A prepared picture with a shadow is
 * copied where the full frame has it (it was drawn at the frame's origin, off the sprite).
 */
function intoSprite(): CaseResult {
  const checks: Check[] = [];
  const objs = [
    image('round', [660, 120, 600, 400], { mediaId: 'quadrants', fit: 'cover', radius: 80, shadow: SHADOW }),
    image('soft', [300, 600, 500, 300], { mediaId: 'quadrants', fit: 'cover', softEdge: 30, shadow: SHADOW }),
  ];
  for (const [path, lookup] of [
    ['prepared', preparedLookup()],
    ['source', fromSource],
  ] as const) {
    const full = draw(objs, lookup);
    const ox = 237;
    const oy = 91;
    // Made again for the sprite (the effect cache keeps a composite by its sub-pixel offset only: the
    // frame's would be copied, right, where the outputs make the sprite's first).
    clearEffectCache();
    const c = new OffscreenCanvas(1300, 900);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.translate(-ox, -oy);
    drawSlide2D(ctx, { id: 's', objects: objs }, { scale: 1, images: lookup, isSong: false });
    const part = ctx.getImageData(0, 0, c.width, c.height);
    const fc = new OffscreenCanvas(W, H);
    const fx = fc.getContext('2d', { willReadFrequently: true })!;
    fx.putImageData(full, 0, 0);
    const dd = diff(fx.getImageData(ox, oy, c.width, c.height), part, 12);
    check(checks, `${path}: the sprite holds what the frame holds there`, dd.differing <= 50, dd);
  }
  return { name: 'drawn into a tight sprite', checks };
}

/** A ProPresenter shape and picture with the same fields look the same (one effects path). */
function shapeVsPicture(): CaseResult {
  const checks: Check[] = [];
  const fx = { shadow: { dx: 30, dy: 20, blur: 48, color: BLACK(0.7) }, softEdge: 24 };
  for (const radius of [0, 60]) {
    const shape: ShapeObject = {
      id: 's',
      type: 'shape',
      box: { x: 500, y: 300, w: 700, h: 420, rotation: 0 },
      shape: 'rect',
      fill: RED,
      opacity: 1,
      radius,
      ...fx,
    };
    const pic = image('p', [500, 300, 700, 420], { radius, ...fx });
    const a = draw([shape], fromSource);
    const b = draw([pic], fromSource);
    const dd = diff(a, b, 10);
    // Measured: at most 5 levels (the shape's corner is the geometry engine's arc, the picture's roundRect).
    check(checks, `radius ${radius}: shape and picture agree`, dd.differing <= 200 && dd.max <= 16, dd);
  }
  return { name: 'shape and picture with the same effects', checks };
}

/** The shadow's blur is a shape's: σ = blur/√6 (not a Canvas shadowBlur of `blur`, σ = blur/2). */
function shadowSigma(): CaseResult {
  const checks: Check[] = [];
  const blur = 60;
  const o = image('p', [300, 300, 400, 400], { shadow: { dx: 600, dy: 0, blur, color: BLACK(1) } });
  const d = draw([o], preparedLookup());
  // The shadow's right edge lies at x = 1300; alpha falls as Φ((1300 - x)/σ).
  const y = 500;
  let x50 = 0;
  let x16 = 0;
  for (let x = 1200; x < 1500; x++) {
    const a = px(d, x, y)[3] / 255;
    if (!x50 && a <= 0.5) x50 = x;
    if (!x16 && a <= 0.1587) x16 = x;
  }
  const sigma = x16 - x50;
  const want = blur / Math.sqrt(6);
  check(checks, 'σ = blur/√6 (±25%)', Math.abs(sigma - want) <= want * 0.25, { sigma, want, x50 });
  return { name: 'picture shadow blur', checks };
}

/** Translucent pictures are drawn as a group: the shadow does not show through them. */
function translucent(): CaseResult {
  const checks: Check[] = [];
  const o = image('p', [400, 300, 600, 400], { opacity: 0.5, shadow: SHADOW });
  const d = draw([o], preparedLookup());
  const c = px(d, 700, 500);
  check(
    checks,
    'the centre is the picture at half alpha, no shadow under it',
    Math.abs(c[3] - 128) <= 4 && c[0] > 200,
    c,
  );
  return { name: 'translucent picture with a shadow', checks };
}

/** The effect layers are cached: a slide drawn again makes no effect canvas. */
function cached(): CaseResult {
  const checks: Check[] = [];
  clearEffectCache();
  const objs = [
    image('a', [100, 100, 500, 300], { radius: 40, shadow: SHADOW, softEdge: 20 }),
    image('b', [800, 500, 600, 400], { mediaId: 'quadrants', shadow: SHADOW }),
  ];
  const lookup = preparedLookup();
  draw(objs, lookup);
  const w0 = effectWork();
  draw(objs, lookup);
  const w1 = effectWork();
  check(checks, 'the second draw makes no effect canvas', w1.full === w0.full && w1.reduced === w0.reduced, {
    before: w0,
    after: w1,
  });
  return { name: 'effect sprite cache', checks };
}

/** No `ctx.filter` anywhere (WebKit has none on OffscreenCanvas): Canvas shadows blur instead. */
function noFilter(run: () => void): CaseResult {
  const checks: Check[] = [];
  const proto = OffscreenCanvasRenderingContext2D.prototype as unknown as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(proto, 'filter');
  let set = 0;
  if (desc?.set) {
    Object.defineProperty(proto, 'filter', {
      ...desc,
      set(v: string) {
        if (v && v !== 'none') set++;
        desc.set!.call(this, v);
      },
    });
  }
  try {
    run();
  } finally {
    if (desc) Object.defineProperty(proto, 'filter', desc);
  }
  check(checks, 'no ctx.filter set', set === 0, { set });
  return { name: 'WebKit-safe blur', checks };
}

export function runCases(): CaseResult[] {
  const out: CaseResult[] = [];
  const all = [
    intoSprite,
    roundedShadow,
    roundedFeather,
    preparedFeather,
    bandedFeather,
    shapeVsPicture,
    shadowSigma,
    translucent,
    cached,
  ];
  out.push(
    noFilter(() => {
      clearEffectCache();
      for (const c of all) out.push(c());
    }),
  );
  return out;
}

(globalThis as unknown as { __pictureEffects: typeof runCases }).__pictureEffects = runCases;
