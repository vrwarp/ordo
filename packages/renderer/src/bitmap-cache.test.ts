import { describe, expect, it } from 'vitest';
import { BitmapCache, bitmapBytes, downscaleFor, pictureKey, pictureKeyHash } from './bitmap-cache.ts';

class Bmp {
  closed = false;
  public width: number;
  public height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  close(): void {
    this.closed = true;
  }
}

const MB = 1024 * 1024;

describe('decoded image cache byte budget (review item 26)', () => {
  it('evicts least recently used bitmaps once the bytes exceed the budget and closes them', () => {
    const c = new BitmapCache<Bmp>(20 * MB);
    const a = new Bmp(1920, 1080); // 8.3 MB
    const b = new Bmp(1920, 1080);
    const d = new Bmp(1920, 1080);
    c.set('a', a);
    c.set('b', b);
    expect(c.bytes).toBe(2 * bitmapBytes(a));
    c.get('a'); // a is now the most recently used
    c.set('d', d); // over budget: b goes
    expect(c.has('b')).toBe(false);
    expect(b.closed).toBe(true);
    expect(c.has('a')).toBe(true);
    expect(c.size).toBe(2);
    expect(c.bytes).toBe(2 * bitmapBytes(a));
  });

  it('never evicts the bitmap just inserted, even when it alone exceeds the budget', () => {
    const c = new BitmapCache<Bmp>(1 * MB);
    const big = new Bmp(4096, 4096);
    c.set('big', big);
    expect(c.has('big')).toBe(true);
    expect(big.closed).toBe(false);
    c.set('next', new Bmp(10, 10));
    expect(c.has('big')).toBe(false);
    expect(big.closed).toBe(true);
  });

  it('replaces an entry without double counting and prunes to a keep set', () => {
    const c = new BitmapCache<Bmp>(100 * MB);
    const a1 = new Bmp(100, 100);
    const a2 = new Bmp(200, 200);
    c.set('a', a1);
    c.set('a', a2);
    expect(a1.closed).toBe(true);
    expect(c.bytes).toBe(bitmapBytes(a2));
    c.set('b', new Bmp(10, 10));
    expect(c.prune(new Set(['b']))).toBe(1);
    expect(c.has('a')).toBe(false);
    expect(a2.closed).toBe(true);
    expect(c.bytes).toBe(bitmapBytes(new Bmp(10, 10)));
  });

  it('keys pictures prepared at a device size by hash and target, and prunes them by hash', () => {
    const t = { key: '1920x1080 stretch' };
    expect(pictureKey('abc', t)).toBe('abc@1920x1080 stretch');
    expect(pictureKey('abc')).toBe('abc');
    expect(pictureKeyHash(pictureKey('abc', t))).toBe('abc');
    expect(pictureKeyHash('abc')).toBe('abc');
    const c = new BitmapCache<Bmp>(100 * MB);
    const source = new Bmp(10, 10);
    const at1080 = new Bmp(1920, 1080);
    const other = new Bmp(10, 10);
    c.set(pictureKey('abc'), source);
    c.set(pictureKey('abc', t), at1080);
    c.set(pictureKey('def', { key: '640x360 cover' }), other);
    expect(c.prune(new Set(['abc']))).toBe(1);
    expect(c.has('abc') && c.has('abc@1920x1080 stretch')).toBe(true);
    expect(other.closed).toBe(true);
    expect(c.bytes).toBe(bitmapBytes(source) + bitmapBytes(at1080));
  });

  it('also bounds the count', () => {
    const c = new BitmapCache<Bmp>(100 * MB, 2);
    c.set('a', new Bmp(1, 1));
    c.set('b', new Bmp(1, 1));
    c.set('d', new Bmp(1, 1));
    expect(c.size).toBe(2);
    expect(c.has('a')).toBe(false);
  });

  it('never evicts or prunes a pinned entry, and trims back to the limits once unpinned', () => {
    const c = new BitmapCache<Bmp>(100 * MB, 2);
    const held = [new Bmp(1, 1), new Bmp(1, 1), new Bmp(1, 1)];
    held.forEach((b, i) => {
      c.set(`k${i}`, b);
      c.pin(`k${i}`);
    });
    // Over the count, but everything is pinned: nothing a draw holds is closed.
    expect(c.size).toBe(3);
    expect(held.some((b) => b.closed)).toBe(false);
    expect(c.prune(new Set())).toBe(0);
    // An unpinned insert evicts only unpinned entries (here: none older than itself).
    const extra = new Bmp(1, 1);
    c.set('x', extra);
    expect(held.some((b) => b.closed)).toBe(false);
    c.unpinAll();
    expect(c.size).toBe(2);
    expect(held[0]!.closed && held[1]!.closed).toBe(true);
    expect(c.has('x')).toBe(true);
  });
});

describe('pins of jobs that run side by side (design/27 §7.5 raster lanes)', () => {
  it('counts pins: one job unpinning leaves what another still draws pinned', () => {
    const c = new BitmapCache<Bmp>(100 * MB, 1);
    const shared = new Bmp(1, 1);
    c.set('shared', shared);
    c.pin('shared'); // job A
    c.pin('shared'); // job B
    c.set('other', new Bmp(1, 1)); // over the count, but `shared` is pinned
    c.unpin('shared'); // A is done
    c.set('third', new Bmp(1, 1));
    expect(shared.closed).toBe(false);
    expect(c.pinnedCount).toBe(1);
    c.unpin('shared'); // B is done: trimmed back to one entry
    expect(shared.closed).toBe(true);
    expect(c.size).toBe(1);
    c.unpin('never-pinned'); // harmless
  });

  it('never replaces a pinned entry: the newcomer is closed and the held bitmap returned', () => {
    const c = new BitmapCache<Bmp>(100 * MB);
    const held = new Bmp(10, 10);
    expect(c.set('k', held)).toBe(held);
    c.pin('k');
    const late = new Bmp(10, 10);
    expect(c.set('k', late)).toBe(held);
    expect(late.closed).toBe(true);
    expect(held.closed).toBe(false);
    expect(c.bytes).toBe(bitmapBytes(held));
    c.unpin('k');
    const next = new Bmp(10, 10);
    expect(c.set('k', next)).toBe(next);
    expect(held.closed).toBe(true);
  });
});

describe('downscale to the output size', () => {
  it('reduces large images so that they still cover the output without upscaling', () => {
    expect(downscaleFor(8000, 4500, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    // A portrait photo: width shrinks to the output width is not enough to cover the height, so the
    // height becomes the output height.
    expect(downscaleFor(3000, 6000, 1920, 1080)).toEqual({ width: 1920, height: 3840 });
    // A very wide panorama: height matches the output, width stays wider than the output.
    expect(downscaleFor(8000, 1000, 1920, 1080)).toBeUndefined();
    expect(downscaleFor(8000, 2000, 1920, 1080)).toEqual({ width: 4320, height: 1080 });
  });

  it('leaves images at or under the output size alone', () => {
    expect(downscaleFor(1920, 1080, 1920, 1080)).toBeUndefined();
    expect(downscaleFor(640, 360, 1920, 1080)).toBeUndefined();
    expect(downscaleFor(0, 0, 1920, 1080)).toBeUndefined();
  });
});
