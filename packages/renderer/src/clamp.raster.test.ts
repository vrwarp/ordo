import { describe, expect, it } from 'vitest';
import { clampObject } from './clamp.ts';

/*
 * Q53, Q66: the provenance of a picture of shapes (`origin.raster`) survives the screens' clamp at its bounds and is dropped
 * (never clamped into a valid-looking value) when it is not one. The clamp copies a field the screens never draw: a stored slide
 * that carries it must read back the same after `clampSlide`, and a hostile one must not carry anything past a bound.
 */
const image = (raster: unknown) => ({
  id: 'p1',
  type: 'image',
  box: { x: 0, y: 0, w: 100, h: 50, rotation: 0 },
  mediaId: 'm1',
  fit: 'stretch',
  opacity: 1,
  locked: true,
  origin: { role: 'raster', raster },
});
const good = {
  file: 'a'.repeat(64),
  slide: 12,
  from: 'slide',
  cv: 3,
  rv: 1,
  pts: 128,
  h: '0123456789abcdef',
  n: 40,
  refs: [[5, 0, 4]],
};
const rasterOf = (raster: unknown) =>
  (clampObject(image(raster)) as { origin?: { raster?: unknown } })?.origin?.raster;

describe('origin.raster in the screens clamp', () => {
  it('a good provenance reads back as it was written', () => {
    expect(rasterOf(good)).toEqual(good);
  });

  it('a hostile one keeps nothing past a bound', () => {
    expect(rasterOf({ ...good, n: 2_049 })).toMatchObject({ n: 2_048 });
    expect(rasterOf({ ...good, refs: Array.from({ length: 50 }, () => [1, 2, 3]) })).toMatchObject({
      refs: expect.arrayContaining([[1, 2, 3]]),
    });
    const refs = (
      rasterOf({ ...good, refs: Array.from({ length: 50 }, () => [1, 2, 3]) }) as { refs: unknown[] }
    ).refs;
    expect(refs.length).toBe(32);
    expect(rasterOf({ ...good, file: 'zz' })).not.toHaveProperty('file');
  });

  it('what is not a provenance is dropped, the picture itself stays', () => {
    for (const bad of [
      null,
      'x',
      42,
      {},
      { ...good, h: 'not-hex' },
      { ...good, cv: Number.NaN },
      { ...good, pts: Number.POSITIVE_INFINITY },
    ]) {
      const out = clampObject(image(bad)) as { type: string; origin?: { raster?: unknown } };
      expect(out.type).toBe('image');
      expect(out.origin?.raster).toBeUndefined();
    }
  });
});
