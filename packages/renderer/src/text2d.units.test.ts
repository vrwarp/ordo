import type { ImageObject, ShapeObject, Slide, SlideObject } from '@ordo/domain';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clampSlide } from './clamp.ts';
import { drawableContent } from './content.ts';
import { charged, GEOM_COST } from './geom/cost.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { drawnCost, legacyOf, slideBudget, withinDrawBudget } from './geombudget.ts';
import { pictureTarget, preparePicture } from './picture.ts';
import { drawSlide2D, slidePictures } from './text2d.ts';
import { type TraceCtx, traceCtx } from './trace.test-util.ts';
import { clearUnits, type GeomUnit, putUnit, setEffectUnits, slideUnits, unitsOfSlide } from './units.ts';

/*
 * Effect units in the slide's drawing (r2a must c(3), c(4); design/14 "Effect units"): on the outputs an
 * object past the budget gets a unit, never a lesser legacy copy: a plain shape keeps its gradient, a masked
 * picture its mask (its prepared bitmap holds it), and a geometry whose effects would put its one call past a task
 * is a whole unit with its effects.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterEach(() => {
  clearUnits();
  setEffectUnits(true);
  vi.unstubAllGlobals();
  vi.stubGlobal('Path2D', RecPath);
});

const objectsOf = (s: Slide) => drawableContent(clampSlide(s)).objects;
const images = (t: TraceCtx) => t.trace.filter((e) => e[0] === 'call' && e[1] === 'drawImage');
const fake = (u: GeomUnit) => ({ width: u.rect.w, height: u.rect.h, id: `unit-${u.object.id}`, close() {} });

/** A full-slide rect filled with a three-stop radial gradient (off Skia's fast path: about 0.9M units). */
const radial = (id: string): ShapeObject => ({
  id,
  type: 'shape',
  box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
  shape: 'rect',
  fill: { r: 255, g: 255, b: 255, a: 1 },
  opacity: 1,
  radius: 0,
  gradient: {
    kind: 'radial',
    stops: [
      { at: 0, color: { r: 255, g: 255, b: 255, a: 1 } },
      { at: 0.4, color: { r: 200, g: 40, b: 40, a: 1 } },
      { at: 1, color: { r: 20, g: 20, b: 120, a: 1 } },
    ],
  },
});

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

describe('effect units in drawSlide2D', () => {
  it('draws a plain shape past the budget with its gradient, from a whole unit, not in its first colour', () => {
    const slide: Slide = { id: 'gradients', objects: [radial('a'), radial('b')] };
    const objects = objectsOf(slide);
    const copy = slideBudget(objects).get(objects[1]!);
    // 62a1c3a: the second is drawn as its legacy copy, its first stop's colour (no unit draws a plain shape).
    expect(legacyOf(copy!)?.part).toBe('geom');
    expect((copy as ShapeObject).gradient).toBeUndefined();
    const [u] = slideUnits(objects, 1);
    expect(u).toMatchObject({ kind: 'whole', of: 'shape', object: objects[1] });
    expect((u!.drawn as ShapeObject).gradient).toBeDefined();
    putUnit(u!, fake(u!) as unknown as CanvasImageSource);
    const t = traceCtx(1920, 1080);
    drawSlide2D(t, slide, { scale: 1 });
    // The second is its unit's copy; the first is drawn live (its gradient made), once.
    expect(images(t).map((e) => (e[2] as { image: unknown[] }).image[2])).toEqual(['unit-b']);
    expect(t.trace.filter((e) => e[0] === 'call' && e[1] === 'createRadialGradient')).toHaveLength(1);
  });

  it('draws a masked picture past the budget from its prepared bitmap, its mask cut in, not without it', () => {
    const pic: ImageObject = {
      id: 'pic',
      type: 'image',
      mediaId: 'm1',
      box: { x: 300, y: 100, w: 1000, h: 800, rotation: 0 },
      fit: 'cover',
      opacity: 1,
      radius: 0,
      mask: { paths: [{ d: zigzag(400), w: 2000, h: 2000 }] },
    } as ImageObject;
    const slide: Slide = { id: 'masked', objects: [radial('a'), pic] };
    const objects = objectsOf(slide);
    const copy = slideBudget(objects).get(objects[1]!) as ImageObject | undefined;
    expect(legacyOf(copy!)?.part).toBe('geom');
    expect(copy!.mask).toBeUndefined();
    // Without units planned: the picture is asked for without its mask.
    const masked = pictureTarget(objects[1] as ImageObject, 1)!;
    const bare = pictureTarget(copy!, 1)!;
    expect(masked.key).not.toBe(bare.key);
    expect(slidePictures(slide, { scale: 1 }).map((p) => p.target?.key)).toEqual([bare.key]);
    // Planned (the outputs' prepare step): its prepared bitmap is asked for with its mask, and drawn 1:1.
    expect(unitsOfSlide(slide, 1).map((u) => u.of)).toEqual(['prepared']);
    expect(slidePictures(slide, { scale: 1 }).map((p) => p.target?.key)).toEqual([masked.key]);
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const bmp = preparePicture({ width: 1000, height: 800 } as unknown as CanvasImageSource, masked)!;
    const t = traceCtx(1920, 1080);
    drawSlide2D(t, slide, { scale: 1, images: () => bmp });
    expect(images(t)).toEqual([
      ['call', 'drawImage', { image: [masked.w, masked.h, ''] }, masked.x, masked.y],
    ]);
    // Not prepared yet (the lookup has only the source): the legacy copy is drawn this time, never its mask live.
    const src = { width: 1000, height: 800 } as unknown as CanvasImageSource;
    const live = traceCtx(1920, 1080);
    drawSlide2D(live, slide, { scale: 1, images: () => src });
    expect(
      live.trace.some(
        (e) => e[0] === 'set' && e[1] === 'globalCompositeOperation' && e[2] === 'destination-in',
      ),
    ).toBe(false);
  });

  it('makes a geometry whose effects pass a task a whole unit with its effects, not without them', () => {
    const o: ShapeObject = {
      id: 'z',
      type: 'shape',
      box: { x: 100, y: 50, w: 1600, h: 900, rotation: 0 },
      shape: 'rect',
      fill: { r: 0, g: 0, b: 0, a: 1 },
      opacity: 1,
      radius: 0,
      geom: { paths: [{ d: zigzag(400), w: 2000, h: 2000 }] },
      shadow: { dx: 4, dy: 4, blur: 1, color: { r: 0, g: 0, b: 0, a: 0.5 } },
    };
    const objects = objectsOf({ id: 's', objects: [o] });
    const c = objects[0] as ShapeObject;
    const body = charged(drawnCost({ ...c, shadow: undefined } as SlideObject));
    // Within a task alone, past it with its shadow (its layer redraws the shape).
    expect(body).toBeLessThanOrEqual(GEOM_COST.slide);
    expect(charged(drawnCost(c))).toBeGreaterThan(GEOM_COST.slide);
    const copy = slideBudget(objects).get(c) as ShapeObject;
    expect(legacyOf(copy)?.part).toBe('geom');
    expect(copy.shadow).toBeDefined();
    const [u] = slideUnits(objects, 1);
    expect(u?.kind).toBe('whole');
    expect((u!.drawn as ShapeObject).shadow).toEqual(c.shadow);
    // 62a1c3a's units (off): the shape without its shadow.
    setEffectUnits(false);
    const [base] = slideUnits(objects, 1);
    expect((base!.drawn as ShapeObject).shadow).toBeUndefined();
    expect(withinDrawBudget(objects)[0]).toBe(copy);
  });
});

/** An OffscreenCanvas of traces (no pixels): what `preparePicture` and the unit drawers draw on in Node. */
class FakeOffscreenCanvas {
  readonly width: number;
  readonly height: number;
  readonly ctx: TraceCtx;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.ctx = traceCtx(w, h);
    (this.ctx as unknown as { getImageData: unknown }).getImageData = () => ({
      data: new Uint8ClampedArray(4),
    });
  }
  getContext() {
    return this.ctx;
  }
  transferToImageBitmap() {
    return { width: this.width, height: this.height, close() {} };
  }
}
