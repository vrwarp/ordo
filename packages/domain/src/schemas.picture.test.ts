import { describe, expect, it } from 'vitest';
import { ImageObject, ShapeGeom, Slide } from './schemas.ts';
import * as prev from './schemas.prev.test-util.ts';

/** ImageObject.flipH, flipV and mask (design/27 §3.1; M4 item D), additive as every design/27 field. */
const image = {
  id: 'i',
  type: 'image',
  box: { x: 0, y: 0, w: 160, h: 90, rotation: 0 },
  mediaId: 'm',
  fit: 'stretch',
  opacity: 1,
  radius: 15,
} as const;

describe('ImageObject flips and mask (design/27 §3.1)', () => {
  it('keeps flips and a mask, and parses pictures without them as before', () => {
    const o = { ...image, flipH: true, flipV: false, mask: { preset: 'roundRect', adj: [['adj', 30_000]] } };
    expect(ImageObject.parse(o)).toEqual(o);
    const plain = ImageObject.parse(image);
    for (const k of ['flipH', 'flipV', 'mask']) expect(plain).not.toHaveProperty(k);
    const s = { id: 's', objects: [{ ...image, mask: { preset: 'ellipse' }, flipV: true }] };
    expect(Slide.parse(s)).toEqual(s);
  });

  it('bounds the geometry: preset and adjust names, values and counts, paths', () => {
    const bad = [
      { preset: 'x'.repeat(41) },
      { adj: [['x'.repeat(17), 1]] },
      { adj: [['adj', 2e7]] },
      { adj: Array.from({ length: 11 }, () => ['adj', 1]) },
      { adj: [['adj', Number.NaN]] },
      { paths: [{ d: 'M0 0', w: -1, h: 1 }] },
      { paths: Array.from({ length: 9 }, () => ({ d: 'M0 0', w: 1, h: 1 })) },
      { paths: [{ d: 'M'.repeat(40_001), w: 1, h: 1 }] },
    ];
    for (const mask of bad)
      expect(ImageObject.safeParse({ ...image, mask }).success, JSON.stringify(mask)).toBe(false);
    expect(ImageObject.safeParse({ ...image, flipH: 'yes' }).success).toBe(false);
    // A path fill mode a later release adds degrades to 'norm' instead of failing the slide.
    expect(ShapeGeom.parse({ paths: [{ d: 'M0 0L1 1Z', w: 1, h: 1, fill: 'glow' }] }).paths![0]!.fill).toBe(
      'norm',
    );
  });

  it('the previous release (0.5.0) keeps them, and the legacy radius an importer writes beside a mask', () => {
    const o = { ...image, flipH: true, mask: { preset: 'ellipse' } };
    const old = prev.ImageObject.parse(o);
    expect(old).toEqual(ImageObject.parse(o));
    expect(old.radius).toBe(15);
    expect(prev.Slide.safeParse({ id: 's', objects: [o] }).success).toBe(true);
  });

  it('the previous release (0.5.0) keeps a picture shadow and soft edge and strips M9 look3d and vectorFonts', () => {
    const shadow = { color: { r: 0, g: 0, b: 0, a: 0.5 }, blur: 12, dx: 4, dy: 6 };
    const o = {
      ...image,
      shadow,
      softEdge: 8,
      look3d: { bevel: { prst: 'circle', w: 12, h: 12 } },
      vectorFonts: ['Arial'],
    };
    const now = ImageObject.parse(o);
    expect(now.look3d).toBeDefined();
    const old = prev.ImageObject.parse(o);
    expect(old).toMatchObject({ shadow, softEdge: 8, radius: 15 });
    expect(old).not.toHaveProperty('look3d');
    expect(old).not.toHaveProperty('vectorFonts');
    expect(ImageObject.safeParse(old).success).toBe(true);
  });
});
