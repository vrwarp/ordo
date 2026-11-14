import type { ShapeObject } from '@ordo/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearEffectCache, EFFECT_CACHE_BYTES, effectCacheBytes } from './effects.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import {
  SPRITE_CACHE_BYTES,
  SPRITE_CACHE_FRAMES,
  SPRITE_CACHE_MAX_BYTES,
  SPRITE_MARKS,
  SpriteCache,
  spriteCache,
} from './spritecache.ts';
import { drawShape } from './text2d.ts';
import { traceCtx } from './trace.test-util.ts';

/** The renderer's one sprite cache (M9 plan decision 9; design/27 §7.5). */

const MB = 1024 * 1024;
const sprite = (mb: number, closed?: string[], name = '') => ({
  bytes: mb * MB,
  close: () => closed?.push(name),
});

describe('SpriteCache', () => {
  it('stays within 64 MiB', () => {
    const c = new SpriteCache();
    expect(c.budgetBytes).toBe(SPRITE_CACHE_BYTES);
    expect(SPRITE_CACHE_BYTES).toBe(64 * MB);
    expect(EFFECT_CACHE_BYTES).toBe(SPRITE_CACHE_BYTES);
    const closed: string[] = [];
    const kinds = ['effect', 'geom', 'decor', 'look3d', 'chart'] as const;
    for (let i = 0; i < 100; i++) {
      c.set(kinds[i % kinds.length]!, `k${i}`, sprite(3, closed, `k${i}`));
      expect(c.bytes()).toBeLessThanOrEqual(64 * MB);
    }
    // 21 sprites of 3 MiB fit; the least recently used went first, and were closed.
    expect(c.count()).toBe(21);
    expect(closed.slice(0, 3)).toEqual(['k0', 'k1', 'k2']);
    expect(c.get('effect', 'k0')).toBeUndefined();
    expect(c.get('effect', 'k95')).toBeDefined();
    // Bytes are reported per kind and add up.
    expect(kinds.reduce((n, k) => n + c.bytes(k), 0)).toBe(c.bytes());
    // A use makes an entry the most recently used: it outlives later inserts.
    c.get('chart', 'k79');
    for (let i = 100; i < 120; i++) c.set('geom', `k${i}`, sprite(3));
    expect(c.has('chart', 'k79')).toBe(true);
    expect(c.has('effect', 'k80')).toBe(false);
    // Kinds keep keys apart; a sprite over half the budget is not kept.
    expect(c.has('geom', 'k79')).toBe(false);
    expect(c.set('effect', 'huge', sprite(33))).toBe(false);
    expect(c.set('effect', undefined, sprite(1))).toBe(false);
  });

  it('a pinned sprite is never evicted', () => {
    const c = new SpriteCache(16 * MB);
    const closed: string[] = [];
    c.set('effect', 'kept', sprite(4, closed, 'kept'));
    c.pin('effect', 'kept');
    c.pin('effect', 'kept');
    for (let i = 0; i < 20; i++) c.set('decor', `d${i}`, sprite(4, closed, `d${i}`));
    expect(c.has('effect', 'kept')).toBe(true);
    expect(closed).not.toContain('kept');
    // Nor cleared: a draw is about to use it.
    c.clear();
    expect(c.has('effect', 'kept')).toBe(true);
    expect(c.pinned).toBe(1);
    // Pins are counted: one unpin leaves it pinned; the last lets the cache trim back.
    c.unpin('effect', 'kept');
    for (let i = 0; i < 5; i++) c.set('decor', `e${i}`, sprite(4));
    expect(c.has('effect', 'kept')).toBe(true);
    c.unpin('effect', 'kept');
    for (let i = 5; i < 10; i++) c.set('decor', `e${i}`, sprite(4));
    expect(c.has('effect', 'kept')).toBe(false);
    expect(closed).toContain('kept');
    expect(c.bytes()).toBeLessThanOrEqual(16 * MB);
    // A pin taken before the sprite is made holds it from its first insert.
    c.pin('chart', 'later');
    c.set('chart', 'later', sprite(4));
    for (let i = 0; i < 8; i++) c.set('geom', `g${i}`, sprite(4));
    expect(c.has('chart', 'later')).toBe(true);
    c.unpin('chart', 'later');
    c.unpin('chart', 'never pinned');
    expect(c.pinned).toBe(0);
  });
});

describe('rasters', () => {
  /** One pass over `n` sprites of `mb` MiB, each used or made and kept: the hits. */
  const pass = (c: SpriteCache, n: number, mb: number, closed?: string[]) => {
    let hits = 0;
    for (let i = 0; i < n; i++) {
      if (c.get('effect', `s${i}`)) hits++;
      else c.set('effect', `s${i}`, sprite(mb, closed, `s${i}`));
    }
    return hits;
  };

  it("a raster's own sprites never evict each other: what fits is kept, the rest is not", () => {
    // Eight sprites of 3 MiB drawn again and again in a 16 MiB cache: least recently used first, every pass
    // evicts exactly the sprites the rest of the pass (and the next) needs, and nothing is ever reused.
    const lru = new SpriteCache(16 * MB);
    for (let i = 0; i < 4; i++) expect(pass(lru, 8, 3)).toBe(0);
    // As rasters, the first five are kept and copied from the second pass on; the last three are made each
    // time and not kept (`set` is false: the caller draws with them this once, nothing is closed).
    const c = new SpriteCache(16 * MB);
    const closed: string[] = [];
    expect(c.raster(() => pass(c, 8, 3, closed))).toBe(0);
    for (let i = 0; i < 4; i++) expect(c.raster(() => pass(c, 8, 3, closed))).toBe(5);
    expect(closed).toEqual([]);
    expect(c.count()).toBe(5);
    expect(c.bytes()).toBeLessThanOrEqual(16 * MB);
    // A raster that used the five has no room for a sixth; one that did not would evict them.
    expect(
      c.raster(() => {
        pass(c, 5, 3);
        return c.set('effect', 'late', sprite(3));
      }),
    ).toBe(false);
    expect(c.has('effect', 'late')).toBe(false);
    // Outside a raster the cache is the plain LRU again: a new sprite evicts the oldest.
    expect(c.set('effect', 'late', sprite(3, closed, 'late'))).toBe(true);
    expect(c.has('effect', 'late')).toBe(true);
    expect(closed).toEqual(['s0']);
    // A later raster evicts what an earlier one kept (the slide changed), least recently used first.
    c.raster(() => {
      for (let i = 0; i < 5; i++) expect(c.set('decor', `n${i}`, sprite(3))).toBe(true);
    });
    expect(c.count('decor')).toBe(5);
    expect(c.count('effect')).toBe(0);
  });

  it('room says beforehand whether a sprite would be kept', () => {
    const c = new SpriteCache(16 * MB);
    expect(c.room(8 * MB)).toBe(true);
    expect(c.room(9 * MB)).toBe(false);
    c.set('effect', 'old', sprite(6));
    c.raster(() => {
      // An earlier raster's sprite is evictable; this raster's are not, nor a pinned one.
      expect(c.room(8 * MB)).toBe(true);
      c.set('effect', 'a', sprite(6));
      c.pin('effect', 'old');
      expect(c.room(4 * MB)).toBe(true);
      expect(c.room(5 * MB)).toBe(false);
      c.unpin('effect', 'old');
      expect(c.room(8 * MB)).toBe(true);
      // Nested calls are the same raster.
      c.raster(() => expect(c.room(10 * MB)).toBe(false));
      c.get('effect', 'old');
      expect(c.room(5 * MB)).toBe(false);
    });
    expect(c.room(8 * MB)).toBe(true);
  });

  it("fitKind keeps a kind within its share by evicting that kind's oldest from earlier rasters only", () => {
    const c = new SpriteCache(64 * MB);
    c.set('decor', 'old 1', sprite(8));
    c.set('decor', 'old 2', sprite(8));
    c.set('effect', 'effect', sprite(8));
    c.set('decor', 'old 3', sprite(8));
    expect(c.fitKind('decor', 4 * MB, 32 * MB)).toBe(true);
    expect(c.count('decor')).toBe(3);
    c.raster(() => {
      c.get('decor', 'old 2');
      // 24 of 32 MiB held: 12 more evicts the oldest decoration the raster has not used ('old 1'), nothing else.
      expect(c.fitKind('decor', 12 * MB, 32 * MB)).toBe(true);
      expect(c.has('decor', 'old 1')).toBe(false);
      expect(c.has('decor', 'old 2')).toBe(true);
      expect(c.has('effect', 'effect')).toBe(true);
      c.pin('decor', 'old 3');
      // 'old 2' is this raster's and 'old 3' pinned: no room for 20, and nothing is evicted in vain.
      expect(c.fitKind('decor', 20 * MB, 32 * MB)).toBe(false);
      expect(c.count('decor')).toBe(2);
      c.unpin('decor', 'old 3');
      expect(c.fitKind('decor', 20 * MB, 32 * MB)).toBe(true);
      expect(c.has('decor', 'old 3')).toBe(false);
    });
  });

  it('the budget follows the largest frame drawn, within its bounds', () => {
    expect(SPRITE_CACHE_FRAMES).toBe(4);
    expect(SPRITE_CACHE_MAX_BYTES).toBe(128 * MB);
    const c = new SpriteCache(SPRITE_CACHE_BYTES, SPRITE_CACHE_MAX_BYTES);
    c.raster(() => {}, 1920 * 1080 * 4);
    expect(c.budgetBytes).toBe(64 * MB);
    const k4 = 3840 * 2160 * 4;
    c.raster(() => {}, k4);
    expect(c.budgetBytes).toBe(4 * k4);
    // Never lowered by a smaller frame, never past the maximum, never raised by a hostile size.
    c.raster(() => {}, 1920 * 1080 * 4);
    expect(c.budgetBytes).toBe(4 * k4);
    c.raster(() => {}, 8000 * 8000 * 4);
    expect(c.budgetBytes).toBe(128 * MB);
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) c.raster(() => {}, bad);
    expect(c.budgetBytes).toBe(128 * MB);
    // A cache made with one budget keeps it (the units' cache).
    const fixed = new SpriteCache(16 * MB);
    fixed.raster(() => {}, k4);
    expect(fixed.budgetBytes).toBe(16 * MB);
    // The renderer's cache rises at 4K.
    expect(spriteCache.budgetBytes).toBeGreaterThanOrEqual(SPRITE_CACHE_BYTES);
    expect(spriteCache.budgetBytes).toBeLessThanOrEqual(SPRITE_CACHE_MAX_BYTES);
  });

  it('marks are a bounded LRU of their own, cleared with their kind', () => {
    const c = new SpriteCache(16 * MB);
    for (let i = 0; i < SPRITE_MARKS + 88; i++) c.mark('decor', `m${i}`);
    expect(c.markCount()).toBe(SPRITE_MARKS);
    expect(c.marked('decor', 'm0')).toBe(false);
    expect(c.marked('decor', `m${SPRITE_MARKS + 87}`)).toBe(true);
    // A mark is not an entry: no bytes, no count, never evicted by sprites.
    expect(c.count()).toBe(0);
    for (let i = 0; i < 20; i++) c.set('decor', `d${i}`, sprite(3));
    expect(c.marked('decor', `m${SPRITE_MARKS + 87}`)).toBe(true);
    c.mark('effect', 'e');
    c.clear('decor');
    expect(c.markCount('decor')).toBe(0);
    expect(c.marked('effect', 'e')).toBe(true);
    c.unmark('effect', 'e');
    expect(c.markCount()).toBe(0);
  });
});

class FakeCanvas {
  ctx: ReturnType<typeof traceCtx>;
  public width: number;
  public height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.ctx = traceCtx(width, height);
  }
  getContext() {
    return this.ctx;
  }
}

describe('effects in the sprite cache', () => {
  beforeAll(() => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    vi.stubGlobal('Path2D', RecPath);
  });
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => spriteCache.clear());

  const shadowed: ShapeObject = {
    id: 's',
    type: 'shape',
    box: { x: 100, y: 100, w: 400, h: 300, rotation: 0 },
    shape: 'rect',
    fill: { r: 200, g: 0, b: 0, a: 1 },
    opacity: 1,
    radius: 0,
    shadow: { dx: 8, dy: 8, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.5 } },
  };

  it('effects use it', () => {
    const ctx = traceCtx(1920, 1080);
    drawShape(ctx, shadowed, 1);
    expect(spriteCache.count('effect')).toBeGreaterThan(0);
    expect(effectCacheBytes()).toBe(spriteCache.bytes('effect'));
    expect(effectCacheBytes()).toBeGreaterThan(0);
    // Drawn again: copied from the cache (one drawImage of the composite onto the slide, nothing made).
    const made = spriteCache.bytes('effect');
    const again = traceCtx(1920, 1080);
    drawShape(again, structuredClone(shadowed), 1);
    expect(spriteCache.bytes('effect')).toBe(made);
    expect(again.trace.filter((e) => e[1] === 'drawImage')).toHaveLength(1);
    // Clearing the effect sprites leaves the other kinds' sprites.
    spriteCache.set('geom', 'other', { bytes: 100 });
    clearEffectCache();
    expect(effectCacheBytes()).toBe(0);
    expect(spriteCache.has('geom', 'other')).toBe(true);
  });
});
