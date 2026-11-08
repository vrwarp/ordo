import { describe, expect, it } from 'vitest';
import { withoutExifOrientation } from './exif.ts';

/** A JPEG's first segments: SOI, an APP1 Exif with IFD0 holding the orientation, then SOS. */
function jpeg(orientation: number, le: boolean): Uint8Array {
  const u16 = (v: number) => (le ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v: number) => (le ? [v & 0xff, (v >> 8) & 0xff, 0, 0] : [0, 0, (v >> 8) & 0xff, v & 0xff]);
  const tiff = [
    ...(le ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(1),
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u32(0),
  ];
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = app1.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...app1, 0xff, 0xda, 0, 2]);
}

describe('withoutExifOrientation (the harness decodes pictures as stored)', () => {
  it('sets an orientation of 2-8 to 1 in a copy, in either byte order', () => {
    for (const le of [true, false]) {
      const src = jpeg(6, le);
      const out = withoutExifOrientation(src);
      expect(out).not.toBe(src);
      expect(out).toEqual(withoutExifOrientation(jpeg(1, le)));
      expect(out).toEqual(jpeg(1, le));
      expect(src).toEqual(jpeg(6, le)); // the source is untouched
    }
  });

  it('gives back other files as they are', () => {
    const one = jpeg(1, true);
    expect(withoutExifOrientation(one)).toBe(one);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    expect(withoutExifOrientation(png)).toBe(png);
    const cut = jpeg(6, true).slice(0, 12);
    expect(withoutExifOrientation(cut)).toBe(cut);
  });
});
