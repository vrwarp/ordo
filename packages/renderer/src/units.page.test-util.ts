import type { Slide } from '@ordo/domain';
import { clampSlide } from './clamp.ts';
import { drawableContent } from './content.ts';
import { overGeomBudget } from './geombudget.ts';
import { slideReach, spriteRect } from './sprite.ts';
import { drawObject, drawSlide2D } from './text2d.ts';
import { lineArtSlide } from './units.test-util.ts';
import {
  clearUnits,
  prepareSlideUnits,
  SLICE_MS,
  slideUnits,
  unitCache,
  unitReady,
  unitWork,
} from './units.ts';

/**
 * Browser side of units.browser.test.ts: line art past the slide's drawing budget (`lineArtSlide`) at 1920 and
 * 3840 wide, on software canvases as the asset worker's (`willReadFrequently`):
 * - each unit, made in slices (`prepareSlideUnits`, each slice a task of its own, timed), against its object
 *   drawn whole on a transparent frame (no budget): the unit's own pixels;
 * - the slide drawn with its units against every object drawn whole, over an opaque ground (what an output
 *   composites the slide layer on), on the frame and as a tight sprite at its offset (the asset worker's
 *   surface): a unit's translucent edge pixels are rounded to 8 bits once more where they are copied over what is
 *   under them;
 * - the slide drawn without units (the legacy copies), which must be another picture.
 */

export type UnitCase = {
  width: number;
  /** Objects the budget sends to legacy copies. */
  over: number;
  /** Units ready after the making. */
  made: number;
  /** Bytes of the slide's units. */
  bytes: number;
  /** Largest channel difference of a unit against its object drawn whole on the frame (transparent). */
  unitMaxDiff: number;
  /** Largest channel difference of the slide drawn with units against every object drawn whole (on a ground). */
  maxDiff: number;
  /** Pixels of the frame differing by more than 1 there. */
  overOne: number;
  /** The same for a tight sprite of the slide's reach drawn at its offset. */
  spriteMaxDiff: number;
  spriteTight: boolean;
  /** Pixels differing by more than 8 between the legacy copies' drawing and the whole drawing. */
  legacyPixels: number;
  /** The longest lane turn making the units, ms, and the turns. */
  longestMs: number;
  turns: number;
  /** The draw of the slide with its units ready, ms (flushed). */
  drawMs: number;
};

/** A software canvas as the asset worker's; `ground` fills it opaquely first (mid grey: black and white show). */
function canvas(w: number, h: number, ground: boolean): OffscreenCanvasRenderingContext2D {
  const c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  if (!c) throw new Error('2D context unavailable');
  if (ground) {
    c.fillStyle = 'rgb(128,128,128)';
    c.fillRect(0, 0, w, h);
  }
  return c;
}

/** The largest channel difference of two same-size pictures and the pixels differing by more than `tol`. */
function compare(a: ImageData, b: ImageData, tol = 1): { max: number; pixels: number } {
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

async function runCase(slide: Slide, width: number): Promise<UnitCase> {
  const scale = width / 1920;
  const height = Math.round(1080 * scale);
  const objects = drawableContent(clampSlide(slide)).objects;
  const over = overGeomBudget(objects).size;
  clearUnits();

  // Every object whole: the drawing the units must give.
  const whole = canvas(width, height, true);
  for (const o of objects) drawObject(whole, o, scale);
  const wholePx = whole.getImageData(0, 0, width, height);

  // The budget without units: the legacy copies.
  const legacy = canvas(width, height, true);
  drawSlide2D(legacy, slide, { scale });
  const legacyPx = legacy.getImageData(0, 0, width, height);

  // Units made in slices, each slice its own task (as a lane's turn), timed.
  const before = unitWork();
  let longestMs = 0;
  const made = await prepareSlideUnits(slide, scale, undefined, {
    slice: async (fn) => {
      await new Promise((r) => setTimeout(r, 0));
      const t = performance.now();
      const out = fn();
      longestMs = Math.max(longestMs, performance.now() - t);
      return out;
    },
    check: () => {},
  });

  // Each unit against its object drawn whole on a transparent frame.
  let unitMaxDiff = 0;
  for (const u of slideUnits(objects, scale)) {
    const alone = canvas(width, height, false);
    drawObject(alone, u.drawn, scale);
    const copy = canvas(width, height, false);
    const img = unitReady(u);
    if (!img) {
      unitMaxDiff = 255;
      continue;
    }
    copy.drawImage(img.source, u.rect.x, u.rect.y);
    const d = compare(alone.getImageData(0, 0, width, height), copy.getImageData(0, 0, width, height));
    unitMaxDiff = Math.max(unitMaxDiff, d.max);
  }

  const t0 = performance.now();
  const withUnits = canvas(width, height, true);
  drawSlide2D(withUnits, slide, { scale });
  const unitsPx = withUnits.getImageData(0, 0, width, height);
  const drawMs = performance.now() - t0;

  // A tight sprite of the slide's reach, drawn at its offset as the asset worker draws it (the whole drawing
  // limited to the same rect, over the same ground).
  const reach = slideReach(withUnits, slide, { scale });
  const rect = spriteRect(reach, scale, width, height);
  let spriteMaxDiff = 0;
  if (rect) {
    const s = canvas(rect.w, rect.h, true);
    s.translate(-rect.x, -rect.y);
    drawSlide2D(s, slide, { scale });
    spriteMaxDiff = compare(
      s.getImageData(0, 0, rect.w, rect.h),
      whole.getImageData(rect.x, rect.y, rect.w, rect.h),
    ).max;
  }
  const d = compare(unitsPx, wholePx);
  return {
    width,
    over,
    made: made.made + made.ready,
    bytes: made.bytes,
    unitMaxDiff,
    maxDiff: d.max,
    overOne: d.pixels,
    spriteMaxDiff,
    spriteTight: !!rect,
    legacyPixels: compare(legacyPx, wholePx, 8).pixels,
    longestMs,
    turns: unitWork().turns - before.turns,
    drawMs,
  };
}

/** The line-art slide, and the same slide in the upper left quarter (a slide whose reach is a tight sprite). */
function slides(): Slide[] {
  const full = lineArtSlide();
  const quarter: Slide = {
    id: 'quarter',
    objects: full.objects.map((o) => ({
      ...o,
      box: { ...o.box, x: o.box.x / 2, y: o.box.y / 2, w: o.box.w / 2, h: o.box.h / 2 },
    })),
  };
  return [full, quarter];
}

export async function runUnits(): Promise<{ cases: (UnitCase & { slide: string })[]; sliceMs: number }> {
  const cases: (UnitCase & { slide: string })[] = [];
  for (const slide of slides())
    for (const width of [1920, 3840]) cases.push({ slide: slide.id, ...(await runCase(slide, width)) });
  return { cases, sliceMs: SLICE_MS };
}

(globalThis as unknown as { __units: typeof runUnits }).__units = runUnits;
// The cache's bytes, read by the runner's log.
(globalThis as unknown as { __unitBytes: () => number }).__unitBytes = () => unitCache.bytes('unit');
