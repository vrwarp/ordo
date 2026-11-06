import { describe, expect, it } from 'vitest';
import { geomSlide } from './geom.test-util.ts';
import { Gradient, ImageObject, ShapeGeom, ShapeObject, Slide, TextStyle } from './schemas.ts';
import * as prev from './schemas.prev.test-util.ts';

/**
 * The M6 drawing fields (design/27 §3.1, §3.2, §14.7): parsed and kept by the current schema, stripped by the
 * previous release's (which keeps the legacy shape, fill and picture an older build draws), enums inside them
 * degrading to their defaults, and every array and number bounded.
 */

const NEW_SHAPE_KEYS = ['geom', 'gradient', 'dash', 'ends', 'flipH', 'flipV', 'shadow', 'glow', 'softEdge'];

describe('M6 shape, picture and gradient text fields', () => {
  it('the current schema keeps every new field', () => {
    const s = geomSlide();
    expect(Slide.parse(s)).toEqual(s);
  });

  it('the previous release strips them and keeps the legacy shape, fill, picture and colour', () => {
    const old = prev.Slide.parse(geomSlide());
    const [star, arrow, photo, title] = old.objects;
    for (const k of NEW_SHAPE_KEYS) {
      expect(star).not.toHaveProperty(k);
      expect(arrow).not.toHaveProperty(k);
    }
    expect(star).toMatchObject({ shape: 'rect', fill: { r: 240 }, stroke: { width: 6 } });
    expect(arrow).toMatchObject({ shape: 'line' });
    expect(photo).not.toHaveProperty('mask');
    expect(photo).not.toHaveProperty('flipH');
    expect(photo).toMatchObject({ type: 'image', mediaId: 'photo-media' });
    expect((title as prev.TextObject).style).not.toHaveProperty('paint');
    expect((title as prev.TextObject).style.color).toEqual({ r: 240, g: 190, b: 40, a: 1 });
    expect(Slide.safeParse(old).success).toBe(true);
  });

  it('enums inside new fields degrade to their defaults', () => {
    const s = geomSlide();
    const star = s.objects[0] as ShapeObject;
    const odd = {
      ...star,
      dash: 'squiggle',
      ends: { head: { type: 'harpoon', w: 'xl', len: 'huge' } },
      gradient: { ...star.gradient!, kind: 'conic' },
      geom: { paths: [{ d: 'M 0 0 L 1 1', w: 1, h: 1, fill: 'shimmer' }] },
    };
    const r = ShapeObject.safeParse(odd);
    expect(r.success).toBe(true);
    expect(r.data!.dash).toBe('solid');
    expect(r.data!.ends!.head).toEqual({ type: 'none', w: 'med', len: 'med' });
    expect(r.data!.gradient!.kind).toBe('linear');
    expect(r.data!.geom!.paths![0]!.fill).toBe('norm');
  });

  it('refuses unbounded geometry and gradients at the boundary', () => {
    const path = { d: 'M 0 0', w: 1, h: 1 };
    expect(ShapeGeom.safeParse({ paths: Array(9).fill(path) }).success).toBe(false);
    expect(ShapeGeom.safeParse({ paths: [{ ...path, d: 'L 1 1 '.repeat(8000) }] }).success).toBe(false);
    expect(ShapeGeom.safeParse({ adj: Array(11).fill(['adj', 1]) }).success).toBe(false);
    expect(ShapeGeom.safeParse({ adj: [['adj', 1e8]] }).success).toBe(false);
    expect(ShapeGeom.safeParse({ preset: 'x'.repeat(41) }).success).toBe(false);
    expect(ShapeGeom.safeParse({ paths: [{ ...path, w: -1 }] }).success).toBe(false);
    const stop = { at: 0, color: { r: 0, g: 0, b: 0, a: 1 } };
    expect(Gradient.safeParse({ kind: 'linear', stops: [stop] }).success).toBe(false);
    expect(Gradient.safeParse({ kind: 'linear', stops: Array(17).fill(stop) }).success).toBe(false);
    expect(Gradient.safeParse({ kind: 'linear', stops: [stop, { ...stop, at: 2 }] }).success).toBe(false);
    expect(Gradient.safeParse({ kind: 'radial', stops: [stop, stop], center: { x: 3, y: 0 } }).success).toBe(
      false,
    );
    const style = (geomSlide().objects[3] as { style: TextStyle }).style;
    expect(TextStyle.safeParse({ ...style, paint: { kind: 'linear', stops: [] } }).success).toBe(false);
    const photo = geomSlide().objects[2] as ImageObject;
    expect(ImageObject.safeParse({ ...photo, mask: { paths: Array(9).fill(path) } }).success).toBe(false);
    const star = geomSlide().objects[0] as ShapeObject;
    expect(ShapeObject.safeParse({ ...star, softEdge: -1 }).success).toBe(false);
  });
});
