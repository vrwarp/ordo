import { describe, expect, it } from 'vitest';
import { ImageObject, Slide } from './schemas.ts';

const image = {
  id: 'i',
  type: 'image',
  box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
  mediaId: 'm',
  fit: 'stretch',
  opacity: 1,
  radius: 0,
} as const;

describe('ImageObject.crop (design/27 §3.1)', () => {
  it('is optional: images without it parse as before', () => {
    const o = ImageObject.parse(image);
    expect(o).toEqual(image);
    expect(o).not.toHaveProperty('crop');
  });

  it('keeps shares within -1..1, negative ones included', () => {
    const crop = { l: -0.25, t: 0.1, r: 1, b: -1 };
    expect(ImageObject.parse({ ...image, crop }).crop).toEqual(crop);
    const s = Slide.parse({ id: 's', objects: [{ ...image, crop }] });
    expect(s.objects[0]).toEqual({ ...image, crop });
  });

  it('refuses shares out of range, missing or not finite', () => {
    for (const crop of [
      { l: 1.5, t: 0, r: 0, b: 0 },
      { l: 0, t: -1.01, r: 0, b: 0 },
      { l: 0, t: 0, r: Number.NaN, b: 0 },
      { l: 0, t: 0, r: 0, b: Number.POSITIVE_INFINITY },
      { l: 0, t: 0, r: 0 },
      { l: '0.1', t: 0, r: 0, b: 0 },
    ])
      expect(ImageObject.safeParse({ ...image, crop }).success).toBe(false);
  });

  it('strips unknown keys inside the crop', () => {
    const o = ImageObject.parse({ ...image, crop: { l: 0, t: 0, r: 0.5, b: 0, extra: 1 } });
    expect(o.crop).toEqual({ l: 0, t: 0, r: 0.5, b: 0 });
  });
});
