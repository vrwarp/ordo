import { describe, expect, it } from 'vitest';
import { type ObjectOrigin, RasterOrigin, Slide } from './schemas.ts';
import * as prev from './schemas.prev.test-util.ts';
import * as prev05 from './schemas.prev05.test-util.ts';

/**
 * Q53, Q66: the provenance of a picture of shapes (`ObjectOrigin.raster`, the owner's named later project Q62). It parses
 * at its bounds and refuses outside them, an older build strips it and still reads the slide, and the largest field is
 * about 1 KB, so a slide at the cap of four such pictures stays far inside the 64 KiB a slide may hold.
 */
const HEX64 = 'a'.repeat(64);
const HEX16 = '0123456789abcdef';
const good = {
  file: HEX64,
  slide: 12,
  from: 'slide' as const,
  cv: 3,
  rv: 1,
  pts: 128,
  h: HEX16,
  n: 40,
  refs: [[5, 0, 4] as [number, number, number]],
};
const image = (raster: unknown) => ({
  id: 'i1',
  type: 'image',
  box: { x: 0, y: 0, w: 100, h: 50, rotation: 0 },
  mediaId: 'm1',
  fit: 'stretch',
  opacity: 1,
  radius: 0,
  locked: true,
  origin: { src: 'pptx', role: 'raster', shapeId: 7, group: 3, raster },
});

describe('ObjectOrigin.raster (C-SR17)', () => {
  it('parses a provenance at its bounds', () => {
    expect(RasterOrigin.parse(good)).toEqual(good);
    const top = {
      file: 'f'.repeat(64),
      slide: 100_000,
      from: 'master' as const,
      cv: 1_000_000,
      rv: 1_000,
      pts: 1_000_000,
      h: 'f'.repeat(16),
      n: 2_048,
      refs: Array.from(
        { length: 32 },
        (_, k) => [2_147_483_647, 100_000 - k, 2_048] as [number, number, number],
      ),
    };
    expect(RasterOrigin.parse(top)).toEqual(top);
  });

  it('refuses outside them: a file that is not 64 hex, an h that is not 16 hex, 33 refs, a count of 0 or 2,049', () => {
    expect(RasterOrigin.safeParse({ ...good, file: 'A'.repeat(64) }).success).toBe(false);
    expect(RasterOrigin.safeParse({ ...good, file: HEX64.slice(1) }).success).toBe(false);
    expect(RasterOrigin.safeParse({ ...good, h: 'xyz' }).success).toBe(false);
    expect(RasterOrigin.safeParse({ ...good, h: HEX16 + '0' }).success).toBe(false);
    expect(
      RasterOrigin.safeParse({ ...good, refs: Array.from({ length: 33 }, (_, k) => [k, 0, 1]) }).success,
    ).toBe(false);
    expect(RasterOrigin.safeParse({ ...good, n: 0 }).success).toBe(false);
    expect(RasterOrigin.safeParse({ ...good, n: 2_049 }).success).toBe(false);
    expect(RasterOrigin.safeParse({ ...good, refs: [[1, 0, 2_049]] }).success).toBe(false);
    expect(RasterOrigin.safeParse({ ...good, cv: 0 }).success).toBe(false);
  });

  it("an unknown 'from' becomes 'slide', and file and slide are the importer's to add", () => {
    expect(RasterOrigin.parse({ ...good, from: 'weird' }).from).toBe('slide');
    const { file: _f, slide: _s, ...bare } = good;
    expect(RasterOrigin.parse(bare)).toEqual(bare);
  });

  it('is part of an image object of role raster, and a slide holding it parses whole', () => {
    const s = Slide.parse({ id: 's1', objects: [image(good)] });
    expect((s.objects[0]!.origin as ObjectOrigin).raster).toEqual(good);
  });

  it('an older build strips the key on a re-save and still reads the slide (the picture draws as an ordinary one)', () => {
    const s = { id: 's1', objects: [image(good)] };
    for (const build of [prev, prev05]) {
      const old = build.Slide.parse(s);
      expect(old.objects).toHaveLength(1);
      const origin = (old.objects[0] as { origin?: { raster?: unknown; role?: string } }).origin;
      expect(origin?.raster).toBeUndefined();
      expect(origin?.role).toBe('raster');
      // and this build reads what the older one re-saved
      expect(Slide.safeParse(old).success).toBe(true);
    }
  });

  it('the largest field is about 1 KB, and a slide with four such pictures stays inside 64 KiB', () => {
    const big = {
      ...good,
      refs: Array.from(
        { length: 32 },
        (_, k) => [2_000_000_000 + k, 99_000 + k, 2_000] as [number, number, number],
      ),
    };
    const one = JSON.stringify(RasterOrigin.parse(big)).length;
    expect(one).toBeLessThanOrEqual(1_200);
    const slide = Slide.parse({
      id: 's1',
      objects: [1, 2, 3, 4].map((i) => ({ ...image(big), id: `i${i}` })),
    });
    expect(JSON.stringify(slide).length).toBeLessThan(64 * 1024);
  });
});
