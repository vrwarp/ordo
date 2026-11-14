import { describe, expect, it } from 'vitest';
import type { ImageObject, Slide } from '@ordo/domain';
import { BitmapCache, DEFAULT_BITMAP_BUDGET, type PictureTarget, slidePictures } from '@ordo/renderer';
import { Cancelled } from './lanes.ts';
import {
  type DecodeWant,
  type PictureDecoder,
  type PreloadSteps,
  preloadPictures,
  sourcePicture,
} from './pictures.ts';

/*
 * The asset worker's picture preparation (pictures.ts) with the real cache and `slidePictures`, and a mocked
 * decoder whose bitmaps record close(): drawing a closed bitmap throws in Chromium ("The image source is
 * detached") and loses the whole slide.
 */

class Bmp {
  closed = false;
  public width: number;
  public height: number;
  public what: string;
  constructor(width: number, height: number, what: string) {
    this.width = width;
    this.height = height;
    this.what = what;
  }
  close(): void {
    this.closed = true;
  }
}

function decoder(sizes: Record<string, [number, number]> = {}) {
  const calls = { decode: [] as string[], wants: [] as (DecodeWant | undefined)[], prepare: 0, reduce: 0 };
  const made: Bmp[] = [];
  const d: PictureDecoder<Bmp> = {
    async decode(hash, want) {
      calls.decode.push(hash);
      calls.wants.push(want);
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
    const { bitmap: b, release } = await sourcePicture(cache, d, 'photo', OUT);
    expect([b.width, b.height]).toEqual([1920, 1440]);
    expect(made[0]!.closed).toBe(true);
    // Pinned until the draw is done (it runs in a later turn of the job).
    expect(cache.pinnedCount).toBe(1);
    const again = await sourcePicture(cache, d, 'photo', OUT);
    expect(again.bitmap).toBe(b);
    release();
    release(); // once only
    expect(cache.pinnedCount).toBe(1);
    again.release();
    expect(cache.pinnedCount).toBe(0);
  });
});

/** Steps that count slices and cancel once `cancelAt` slices have run (or at the next check after it). */
function counting(cancelAt = Number.POSITIVE_INFINITY) {
  let n = 0;
  let cancelled = false;
  const steps: PreloadSteps = {
    async slice(fn) {
      if (cancelled) throw new Cancelled();
      const r = fn();
      if (++n >= cancelAt) cancelled = true;
      return r;
    },
    check() {
      if (cancelled) throw new Cancelled();
    },
  };
  return { steps, slices: () => n, cancel: () => (cancelled = true) };
}

describe('preloadPictures in the raster lanes (design/27 §7.5)', () => {
  const full = image(0, 'm0', { x: 0, y: 0, w: 1920, h: 1080 });

  it('tells the decoder what it decodes for: the missing targets, and the cover when the source is drawn', async () => {
    const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
    const { d, calls } = decoder();
    const s: Slide = { id: 's', objects: [full] };
    (await preloadPictures(cache, d, { m0: 'h0' }, slidePictures(s, { scale: 1 }), OUT)).release();
    expect(calls.wants[0]!.targets!.map((t) => t.key)).toEqual(
      slidePictures(s, { scale: 1 }).map((u) => u.target!.key),
    );
    expect(calls.wants[0]!.cover).toBeUndefined();
    // A logo with no target (props) is its source, covering the output.
    (await preloadPictures(cache, d, { logo: 'h1' }, undefined, OUT)).release();
    expect(calls.wants[1]).toEqual({ cover: OUT });
    // Over the budget: the target is drawn from the source, so the one decode is asked for both.
    const limits = { maxImages: 16, maxBytes: 9_000_000, maxPrepared: 0 };
    const objs: Slide = { id: 's2', objects: [full, image(1, 'm0', { x: 10, y: 10, w: 100, h: 100 })] };
    (await preloadPictures(cache, d, { m0: 'h2' }, slidePictures(objs, { scale: 1 }), OUT, limits)).release();
    expect(calls.wants[2]).toEqual({ cover: OUT });
  });

  it('decodes again for the source when the decode held only part of the picture', async () => {
    const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
    const { d, calls } = decoder({ h0: [8000, 4500] });
    let parts = 0;
    const partialDecoder: PictureDecoder<Bmp> = {
      ...d,
      partial: (b) => b.what === 'full h0' && parts++ === 0,
      // The prepare fails (no canvas): the use falls back to the source after the decode.
      prepare: () => undefined,
    };
    const s: Slide = { id: 's', objects: [full] };
    const pre = await preloadPictures(
      cache,
      partialDecoder,
      { m0: 'h0' },
      slidePictures(s, { scale: 1 }),
      OUT,
    );
    expect(calls.decode).toEqual(['h0', 'h0']);
    expect(calls.wants[1]).toEqual({ cover: OUT });
    expect(drawn(s, pre.lookup)[0]!.what).toBe('reduced');
    pre.release();
  });

  it('prepares in the job’s turns, one slice per band, and unwinds a cancelled job', async () => {
    const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
    const { d, made } = decoder();
    const banded: PictureDecoder<Bmp> = {
      ...d,
      *prepareSteps(src, t) {
        yield;
        yield;
        yield;
        return d.prepare(src, t);
      },
    };
    const s: Slide = { id: 's', objects: [full, image(1, 'm1', { x: 0, y: 0, w: 300, h: 200 })] };
    const map = { m0: 'h0', m1: 'h1' };
    const ok = counting();
    const pre = await preloadPictures(
      cache,
      banded,
      map,
      slidePictures(s, { scale: 1 }),
      OUT,
      undefined,
      ok.steps,
    );
    expect(ok.slices()).toBe(8); // two targets of four bands
    expect(drawn(s, pre.lookup).every((b) => b && !b.closed)).toBe(true);
    pre.release();
    // Cancelled in the middle of the second file's bands: nothing it pinned stays pinned, its decode is closed.
    const fresh = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
    const before = made.length;
    const stop = counting(6);
    await expect(
      preloadPictures(fresh, banded, map, slidePictures(s, { scale: 1 }), OUT, undefined, stop.steps),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(fresh.pinnedCount).toBe(0);
    expect(
      made
        .slice(before)
        .filter((b) => b.what.startsWith('full'))
        .every((b) => b.closed),
    ).toBe(true);
    // The first file's target was made and cached; the second one never was.
    expect(fresh.size).toBe(1);
  });

  it('closes the reduced source when the job is cancelled during the reduce', async () => {
    const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
    const { d, made } = decoder();
    const stop = counting();
    const slow: PictureDecoder<Bmp> = {
      ...d,
      async reduce(src, w, h) {
        const b = await d.reduce(src, w, h);
        stop.cancel(); // cancelled while the reduce ran (a quick Next)
        return b;
      },
    };
    // A logo with no target: drawn from its source, reduced to cover the output.
    await expect(
      preloadPictures(cache, slow, { logo: 'h1' }, undefined, OUT, undefined, stop.steps),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(made.filter((b) => b.what === 'reduced')).toHaveLength(1);
    expect(made.every((b) => b.closed)).toBe(true);
    expect(cache.size).toBe(0);
    expect(cache.pinnedCount).toBe(0);
  });

  it('a cancellation during a decode is not a decode failure', async () => {
    const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
    const { d, made } = decoder();
    const stop = counting();
    const slow: PictureDecoder<Bmp> = {
      ...d,
      async decode(hash, want) {
        const b = await d.decode(hash, want);
        stop.cancel(); // cancelled while the decode ran
        return b;
      },
    };
    const s: Slide = { id: 's', objects: [full] };
    await expect(
      preloadPictures(cache, slow, { m0: 'h0' }, slidePictures(s, { scale: 1 }), OUT, undefined, stop.steps),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(made[0]!.closed).toBe(true);
    expect(cache.size).toBe(0);
  });

  it('two jobs preparing the same slide side by side never close what the other draws', async () => {
    const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 3);
    const { d } = decoder();
    // Decodes resolve when the test says, so both jobs are in flight together.
    const pending: (() => void)[] = [];
    const gated: PictureDecoder<Bmp> = {
      ...d,
      async decode(hash, want) {
        await new Promise<void>((r) => pending.push(r));
        return d.decode(hash, want);
      },
    };
    const { slide: s, map } = slide(3, 3);
    const uses = slidePictures(s, { scale: 1 });
    const both = Promise.all([
      preloadPictures(cache, gated, map, uses, OUT),
      preloadPictures(cache, gated, map, uses, OUT),
    ]);
    let done = false;
    void both.then(() => (done = true));
    // Let the decodes finish one at a time, alternating between the two jobs.
    while (!done) {
      pending.shift()?.();
      await new Promise((r) => setTimeout(r, 1));
    }
    const [pa, pb] = await both;
    const ga = drawn(s, pa.lookup);
    const gb = drawn(s, pb.lookup);
    expect(ga.every((x) => x && !x.closed)).toBe(true);
    expect(gb.every((x) => x && !x.closed)).toBe(true);
    // One job done: the other's bitmaps stay pinned even though the cache is over its count meanwhile.
    pa.release();
    cache.set('other', new Bmp(1, 1, 'other'));
    expect(gb.every((x) => !x!.closed)).toBe(true);
    pb.release();
    expect(cache.pinnedCount).toBe(0);
  });
});
