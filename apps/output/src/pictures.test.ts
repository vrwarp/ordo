import { describe, expect, it } from 'vitest';
import type { ImageObject, Slide } from '@ordo/domain';
import { BitmapCache, DEFAULT_BITMAP_BUDGET, type PictureTarget, slidePictures } from '@ordo/renderer';
import { type PictureDecoder, preloadPictures, sourcePicture } from './pictures.ts';

/*
 * The asset worker's picture preparation (pictures.ts) with the real cache and `slidePictures`, and a mocked
 * decoder whose bitmaps record close(): drawing a closed bitmap throws in Chromium ("The image source is
 * detached") and loses the whole slide.
 */

class Bmp {
  closed = false;
  constructor(
    public width: number,
    public height: number,
    public what: string,
  ) {}
  close(): void {
    this.closed = true;
  }
}

function decoder(sizes: Record<string, [number, number]> = {}) {
  const calls = { decode: [] as string[], prepare: 0, reduce: 0 };
  const made: Bmp[] = [];
  const d: PictureDecoder<Bmp> = {
    async decode(hash) {
      calls.decode.push(hash);
      const [w, h] = sizes[hash] ?? [4000, 3000];
      const b = new Bmp(w, h, `full ${hash}`);
      made.push(b);
      return b;
    },
    prepare(src, t: PictureTarget) {
      if (src.closed) throw new Error('prepared from a closed bitmap');
      calls.prepare++;
      const b = new Bmp(t.w, t.h, `target ${t.key}`);
      made.push(b);
      return b;
    },
    async reduce(src, w, h) {
      if (src.closed) throw new Error('reduced a closed bitmap');
      calls.reduce++;
      const b = new Bmp(w, h, 'reduced');
      made.push(b);
      return b;
    },
  };
  return { d, calls, made };
}

const OUT = { w: 1920, h: 1080 };

function image(i: number, mediaId: string, box: { x: number; y: number; w: number; h: number }): ImageObject {
  return {
    id: `i${i}`,
    type: 'image',
    mediaId,
    box: { ...box, rotation: 0 },
    fit: 'cover',
    opacity: 1,
    radius: 0,
  };
}

/** A slide of `n` image objects over `files` pictures, each at its own size. */
function slide(n: number, files: number): { slide: Slide; map: Record<string, string> } {
  const objects = Array.from({ length: n }, (_, i) =>
    image(i, `m${i % files}`, { x: (i * 7) % 1500, y: (i * 3) % 800, w: 100 + i, h: 80 + i }),
  );
  const map: Record<string, string> = {};
  for (let f = 0; f < files; f++) map[`m${f}`] = `hash${f}`;
  return { slide: { id: 's', objects }, map };
}

/** Every bitmap the draw gets for the slide's uses. */
function drawn(s: Slide, lookup: (id: string, t?: PictureTarget) => Bmp | undefined) {
  return slidePictures(s, { scale: 1 }).map((u) => lookup(u.mediaId, u.target));
}

describe('preloadPictures', () => {
  it('decodes one file once for 80 uses at 80 sizes, and never hands the draw a closed bitmap', async () => {
    const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
    const { d, calls } = decoder();
    const { slide: s, map } = slide(80, 1);
    const uses = slidePictures(s, { scale: 1 });
    expect(new Set(uses.map((u) => u.target!.key)).size).toBe(80);
    const pre = await preloadPictures(cache, d, map, uses, OUT);
    expect(calls.decode).toEqual(['hash0']);
    const got = drawn(s, pre.lookup);
    expect(got.every((b) => b && !b.closed)).toBe(true);
    // 32 prepared targets (below the cache's 64), the rest drawn from the reduced source.
    expect(calls.prepare).toBe(32);
    expect(got.filter((b) => b!.what === 'reduced')).toHaveLength(48);
    expect(pre.skipped).toBe(0);
    pre.release();
    expect(cache.size).toBeLessThanOrEqual(64);
  });

  it('decodes each of 16 files once over 130 uses, with nothing closed under the draw', async () => {
    const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
    // A cache already full of another cue's pictures, which this cue's inserts evict.
    for (let i = 0; i < 64; i++) cache.set(`old${i}`, new Bmp(10, 10, 'old'));
    const { d, calls } = decoder();
    const { slide: s, map } = slide(130, 16);
    const pre = await preloadPictures(cache, d, map, slidePictures(s, { scale: 1 }), OUT);
    expect([...calls.decode].sort()).toEqual(Object.values(map).sort());
    const got = drawn(s, pre.lookup);
    expect(got.every((b) => b && !b.closed)).toBe(true);
    // A prune arriving during the cue (the link's) leaves the pinned bitmaps alone.
    cache.prune(new Set());
    expect(got.every((b) => !b!.closed)).toBe(true);
    pre.release();
    expect(cache.size).toBeLessThanOrEqual(64);
  });

  it('prepares only the visible part of full-bleed photos, so all eight fit the cue budget', async () => {
    const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
    const { d, calls, made } = decoder();
    const objects = Array.from({ length: 8 }, (_, i) =>
      image(i, `m${i}`, { x: -1000, y: -600, w: 3920, h: 2280 }),
    );
    const s: Slide = { id: 's', objects };
    const map = Object.fromEntries(objects.map((o, i) => [o.mediaId, `hash${i}`]));
    const pre = await preloadPictures(cache, d, map, slidePictures(s, { scale: 1 }), OUT);
    expect(pre.skipped).toBe(0);
    expect(calls.prepare).toBe(8);
    const got = drawn(s, pre.lookup);
    expect(got.every((b) => b && !b.closed && b.width === 1920 && b.height === 1080)).toBe(true);
    // Every full decode is closed once its targets are made.
    expect(made.filter((b) => b.what.startsWith('full')).every((b) => b.closed)).toBe(true);
    pre.release();
  });

  it('checks the budget before preparing, and draws from the source what would not fit', async () => {
    const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
    const { d, calls } = decoder({ hash0: [400, 300] });
    const objects = [image(0, 'm0', { x: 0, y: 0, w: 1920, h: 1080 })];
    const s: Slide = { id: 's', objects };
    // Room for the 0.5 MB source, not for the 8.3 MB prepared frame.
    const limits = { maxImages: 16, maxBytes: 1_000_000, maxPrepared: 32 };
    const pre = await preloadPictures(cache, d, { m0: 'hash0' }, slidePictures(s, { scale: 1 }), OUT, limits);
    expect(calls.prepare).toBe(0);
    const [b] = drawn(s, pre.lookup);
    expect(b!.what).toBe('full hash0'); // small enough to be its own source
    expect(b!.closed).toBe(false);
    expect(pre.skipped).toBe(0);
    pre.release();
  });

  it('reuses cached targets without decoding again, and reports files that cannot be read', async () => {
    const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
    const { d, calls } = decoder();
    const { slide: s, map } = slide(4, 1);
    const uses = slidePictures(s, { scale: 1 });
    (await preloadPictures(cache, d, map, uses, OUT)).release();
    const again = await preloadPictures(cache, d, map, uses, OUT);
    expect(calls.decode).toEqual(['hash0']);
    expect(drawn(s, again.lookup).every((b) => b && !b.closed)).toBe(true);
    again.release();
    const failing: PictureDecoder<Bmp> = {
      ...d,
      decode: async () => {
        throw new Error('unavailable');
      },
    };
    const bad = await preloadPictures(cache, failing, { m9: 'gone' }, undefined, OUT);
    expect(bad.failed.map((f) => f.hash)).toEqual(['gone']);
    expect(bad.lookup('m9')).toBeUndefined();
  });

  it('keeps a full-frame image cue as its source reduced to cover the output', async () => {
    const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
    const { d, made } = decoder();
    const b = await sourcePicture(cache, d, 'photo', OUT);
    expect([b.width, b.height]).toEqual([1920, 1440]);
    expect(made[0]!.closed).toBe(true);
    expect(await sourcePicture(cache, d, 'photo', OUT)).toBe(b);
  });
});
