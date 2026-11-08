import { describe, expect, it } from 'vitest';
import { ImageObject, type Slide } from '@ordo/domain';
import { clampCrop, clampObject, clampSlide } from './clamp.ts';

const image = (extra: Record<string, unknown> = {}) => ({
  id: 'i',
  type: 'image' as const,
  box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
  mediaId: 'm',
  fit: 'stretch' as const,
  opacity: 1,
  radius: 0,
  ...extra,
});

describe('ImageObject.crop clamps (design/27 §3.1)', () => {
  it('keeps every share within -1..1 and reads malformed shares as 0', () => {
    expect(clampCrop({ l: 0.25, t: -0.5, r: 0, b: 0.1 })).toEqual({ l: 0.25, t: -0.5, r: 0, b: 0.1 });
    expect(clampCrop({ l: -7, t: 7, r: Number.NaN, b: '0.5' })).toEqual({ l: -1, t: 1, r: 0, b: 0 });
    expect(clampCrop({ l: Number.NEGATIVE_INFINITY, t: 0.2 })).toEqual({ l: 0, t: 0.2, r: 0, b: 0 });
  });

  it('drops a crop that is absent, not an object, or cuts nothing', () => {
    for (const c of [undefined, null, 4, 'l', [], {}, { l: 0, t: 0, r: 0, b: 0 }, { l: Number.NaN }])
      expect(clampCrop(c)).toBeUndefined();
  });

  it('keeps a crop that leaves nothing visible (it draws nothing)', () => {
    expect(clampCrop({ l: 0.6, t: 0, r: 0.6, b: 0 })).toEqual({ l: 0.6, t: 0, r: 0.6, b: 0 });
  });

  it('whitelists crop on image objects and leaves images without one unchanged', () => {
    expect(clampObject(image())).toEqual(image());
    expect(clampObject(image())).not.toHaveProperty('crop');
    expect(clampObject(image({ crop: { l: 0, t: 0, r: 0, b: 0 } }))).not.toHaveProperty('crop');
    expect(clampObject(image({ crop: { l: -2, t: 0.5, r: 0, b: 0, x: 1 } }))).toEqual(
      image({ crop: { l: -1, t: 0.5, r: 0, b: 0 } }),
    );
    const s = clampSlide({
      id: 's',
      objects: [image({ crop: { l: 0.1, t: 0.2, r: 0.3, b: 0.4 } })],
    } as Slide);
    expect(s.objects[0]).toMatchObject({ crop: { l: 0.1, t: 0.2, r: 0.3, b: 0.4 } });
  });

  it('produces crops the stored schema accepts', () => {
    const o = clampObject(image({ crop: { l: -9, t: Number.NaN, r: 9, b: 0.5 } }));
    expect(ImageObject.parse(o)).toEqual(o);
  });
});
