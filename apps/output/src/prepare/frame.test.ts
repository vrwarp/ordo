import type { ImageObject } from '@ordo/domain';
import { BitmapCache, CLAMP, DEFAULT_BITMAP_BUDGET, type PictureTarget, pictureTarget } from '@ordo/renderer';
import { FRAME_DIRECT_TARGETS } from '@ordo/renderer/frame.ts';
import { describe, expect, it } from 'vitest';
import { FRAME_PICTURE_LIMITS, PICTURE_LIMITS, type PictureDecoder } from '../pictures.ts';
import { framePictures } from './frame.ts';

/*
 * The pictures of an underlay frame (prepare/frame.ts): one decoded picture at a time, released after its draw call,
 * a repeated file and size decoded once, a file that is not there reported by its hash.
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

class Unavailable extends Error {}

function setup(missing: string[] = []) {
  const cache = new BitmapCache<Bmp>(DEFAULT_BITMAP_BUDGET, 64);
  const calls = { decode: [] as string[], prepare: 0 };
  const d: PictureDecoder<Bmp> = {
    async decode(hash) {
      calls.decode.push(hash);
      if (missing.includes(hash)) throw new Unavailable('not cached yet');
      return new Bmp(4000, 3000, `full ${hash}`);
    },
    prepare(_src, t: PictureTarget) {
      calls.prepare++;
      return new Bmp(t.w, t.h, `target ${t.key}`);
    },
    async reduce(_src, w, h) {
      return new Bmp(w, h, 'reduced');
    },
  };
  const have = new Set<string>();
  const images: Record<string, string> = { a: 'hashA', b: 'hashB', c: 'hashC' };
  const pictures = framePictures({
    cache,
    decoder: d,
    images,
    out: { w: 1920, h: 1080 },
    steps: { slice: async (fn) => fn(), check: () => undefined },
    isMissing: (e) => e instanceof Unavailable,
    has: async (h) => have.has(h),
  });
  return { cache, calls, pictures, have, images };
}

const picture = (id: string, mediaId: string, w = 300, h = 200): ImageObject => ({
  id,
  type: 'image',
  mediaId,
  box: { x: 100, y: 100, w, h, rotation: 0 },
  fit: 'cover',
  opacity: 1,
  radius: 0,
});

describe('framePictures', () => {
  it('holds at most one picture: each is pinned until its release', async () => {
    const { cache, pictures } = setup();
    const one = await pictures.acquire(picture('p1', 'a'), 1);
    expect(cache.pinnedCount).toBeGreaterThan(0);
    const during = cache.pinnedCount;
    one.release();
    expect(cache.pinnedCount).toBe(0);
    const two = await pictures.acquire(picture('p2', 'b'), 1);
    expect(cache.pinnedCount).toBeLessThanOrEqual(during);
    two.release();
    expect(cache.pinnedCount).toBe(0);
  });

  it('hands the draw its prepared target, not a closed bitmap', async () => {
    const { pictures } = setup();
    const o = picture('p1', 'a');
    const pic = await pictures.acquire(o, 1);
    const got = pic.lookup('a', pictureTarget(o, 1)) as unknown as Bmp | undefined;
    expect(got).toBeDefined();
    expect(got!.closed).toBe(false);
    pic.release();
  });

  it('decodes a repeated file and size once: the second is a cache hit', async () => {
    const { calls, pictures } = setup();
    const o = picture('p1', 'a');
    (await pictures.acquire(o, 1)).release();
    (await pictures.acquire({ ...o, id: 'p2' }, 1)).release();
    expect(calls.decode).toEqual(['hashA']);
    expect(calls.prepare).toBe(1);
    // another size of the same file is another target, prepared from a new decode of it
    (await pictures.acquire(picture('p3', 'a', 301, 200), 1)).release();
    expect(calls.prepare).toBe(2);
  });

  it('reports a file that is not there by its hash, and the draw gets no picture', async () => {
    const { pictures } = setup(['hashB']);
    const pic = await pictures.acquire(picture('p1', 'b'), 1);
    expect(pic.missing).toBe('hashB');
    expect(pic.lookup('b', undefined)).toBeUndefined();
    pic.release();
  });

  it('reports a media the job has no file for by its media id, and waits for the map to name it', async () => {
    const { pictures, images } = setup();
    const pic = await pictures.acquire(picture('p1', 'zzz'), 1);
    expect(pic.missing).toBe('media:zzz');
    expect(await pictures.arrived!(['media:zzz'])).toBe(false);
    images.zzz = 'hashZ';
    expect(await pictures.arrived!(['media:zzz'])).toBe(true);
  });

  it('says a missing file has arrived once it is cached', async () => {
    const { pictures, have } = setup(['hashB']);
    expect(await pictures.arrived!(['hashB'])).toBe(false);
    have.add('hashB');
    expect(await pictures.arrived!(['hashB'])).toBe(true);
    expect(await pictures.arrived!([])).toBe(false);
  });
});

describe('the frame picture limits', () => {
  it('are one file and one target within a cue budget', () => {
    expect(FRAME_PICTURE_LIMITS).toEqual({
      maxImages: 1,
      maxBytes: CLAMP.maxCueBitmapBytes,
      maxPrepared: 1,
    });
  });

  it("FRAME_DIRECT_TARGETS equals the output's prepared targets and the live clamp's counts", () => {
    expect(FRAME_DIRECT_TARGETS).toBe(PICTURE_LIMITS.maxPrepared);
    expect(PICTURE_LIMITS.maxImages).toBe(CLAMP.maxImagesPerSlide);
    expect(PICTURE_LIMITS.maxBytes).toBe(CLAMP.maxCueBitmapBytes);
  });
});
