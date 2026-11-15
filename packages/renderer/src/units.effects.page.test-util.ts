import type { ShapeObject, Slide } from '@ordo/domain';
import { clampSlide } from './clamp.ts';
import { drawableContent } from './content.ts';
import './decor/index.ts';
import { cappedSlide } from './decor/test-util.ts';
import { drawObject, drawSlide2D } from './text2d.ts';
import { effectsSlide, loneChain } from './units.effects.test-util.ts';
import { clearUnits, prepareSlideUnits, slideUnits, unitCacheBytes } from './units.ts';

/**
 * Browser side of units.browser.test.ts's effect units: slides whose objects past the drawing budget are drawn
 * from effect units (layers of shadows, whole units of soft-edged, translucent and gradient shapes and of a
 * geometry with its effects, a sliced lone chain, a capped decoration), at 1920 and 3840 on software canvases as
 * the asset worker's: the slide drawn with its units made in slices against every object drawn whole (no budget),
 * over an opaque ground; the slide drawn without them (the legacy copies), which must be another picture.
 */

export type EffectCase = {
  slide: string;
  width: number;
  kinds: string[];
  /** Largest channel difference with units against the whole drawing, and pixels off by more than 2. */
  maxDiff: number;
  overTwo: number;
  /** Pixels off by more than 8 between the legacy copies' drawing and the whole drawing. */
  legacyPixels: number;
  longestMs: number;
  turns: number;
  /** Each turn's ms. */
  turnMs: number[];
  bytes: number;
  cacheBytes: number;
  drawMs: number;
};

function canvas(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  if (!c) throw new Error('2D context unavailable');
  c.fillStyle = 'rgb(128,128,128)';
  c.fillRect(0, 0, w, h);
  return c;
}

function compare(a: ImageData, b: ImageData, tol: number): { max: number; pixels: number } {
  let max = 0;
  let pixels = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let m = 0;
    for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(a.data[i + k]! - b.data[i + k]!));
    max = Math.max(max, m);
    if (m > tol) pixels++;
  }
  return { max, pixels };
}

/** A path zigzagging across a 2000 x 2000 space (a costly fill within the per-geometry bound). */
function zigzag(points: number): string {
  let d = 'M 1000 1000';
  for (let k = 1; k < points; k++) {
    const a = (k / points) * Math.PI * 2 * 37;
    const r = k % 2 ? 1000 : 50;
    d += ` L ${(1000 + r * Math.cos(a)).toFixed(1)} ${(1000 + r * Math.sin(a)).toFixed(1)}`;
  }
  return `${d} Z`;
}

const radial = (id: string, x: number): ShapeObject => ({
  id,
  type: 'shape',
  box: { x, y: 0, w: 1920, h: 1080, rotation: 0 },
  shape: 'rect',
  fill: { r: 255, g: 255, b: 255, a: 1 },
  opacity: 1,
  radius: 0,
  gradient: {
    kind: 'radial',
    stops: [
      { at: 0, color: { r: 255, g: 255, b: 255, a: 1 } },
      { at: 0.4, color: { r: 200, g: 40, b: 40, a: 0.9 } },
      { at: 1, color: { r: 20, g: 20, b: 120, a: 1 } },
    ],
  },
});

function slides(): Slide[] {
  const translucent = effectsSlide();
  translucent.objects = translucent.objects.map((o, i) => (i >= 10 ? { ...o, opacity: 0.8 } : o));
  return [
    effectsSlide(),
    { ...translucent, id: 'translucent' },
    { id: 'gradients', objects: [radial('a', 0), radial('b', 200)] },
    {
      id: 'geom-shadow',
      objects: [
        {
          id: 'z',
          type: 'shape',
          box: { x: 100, y: 50, w: 1600, h: 900, rotation: 6 },
          shape: 'rect',
          fill: { r: 30, g: 40, b: 120, a: 1 },
          opacity: 1,
          radius: 0,
          geom: { paths: [{ d: zigzag(400), w: 2000, h: 2000 }] },
          shadow: { dx: 8, dy: 8, blur: 1, color: { r: 0, g: 0, b: 0, a: 0.5 } },
        } as ShapeObject,
      ],
    },
    // Rings that never touch: a sliced unit's groups then draw the very pixels of one call.
    { id: 'chain', objects: [loneChain(900, 23, 30)] },
    { ...cappedSlide(), id: 'capped' },
  ];
}

async function runCase(slide: Slide, width: number): Promise<EffectCase> {
  const scale = width / 1920;
  const height = Math.round(1080 * scale);
  const objects = drawableContent(clampSlide(slide)).objects;
  clearUnits();
  const whole = canvas(width, height);
  for (const o of objects) drawObject(whole, o, scale);
  const wholePx = whole.getImageData(0, 0, width, height);
  const legacy = canvas(width, height);
  drawSlide2D(legacy, slide, { scale });
  const legacyPx = legacy.getImageData(0, 0, width, height);
  let longestMs = 0;
  let turns = 0;
  const turnMs: number[] = [];
  const made = await prepareSlideUnits(slide, scale, undefined, {
    slice: async (fn) => {
      await new Promise((r) => setTimeout(r, 0));
      const t = performance.now();
      const out = fn();
      longestMs = Math.max(longestMs, performance.now() - t);
      turnMs.push(+(performance.now() - t).toFixed(1));
      turns++;
      return out;
    },
    check: () => {},
  });
  const t0 = performance.now();
  const withUnits = canvas(width, height);
  drawSlide2D(withUnits, slide, { scale });
  const unitsPx = withUnits.getImageData(0, 0, width, height);
  const drawMs = performance.now() - t0;
  const d = compare(unitsPx, wholePx, 2);
  return {
    slide: slide.id,
    width,
    kinds: slideUnits(objects, scale).map((u) => `${u.kind} ${u.of}`),
    maxDiff: d.max,
    overTwo: d.pixels,
    legacyPixels: compare(legacyPx, wholePx, 8).pixels,
    longestMs,
    turns,
    turnMs,
    bytes: made.bytes,
    cacheBytes: unitCacheBytes(),
    drawMs,
  };
}

export async function runEffectUnits(): Promise<EffectCase[]> {
  const out: EffectCase[] = [];
  for (const slide of slides()) for (const width of [1920, 3840]) out.push(await runCase(slide, width));
  return out;
}

(globalThis as unknown as { __effectUnits: typeof runEffectUnits }).__effectUnits = runEffectUnits;
