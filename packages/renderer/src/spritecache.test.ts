import type { ShapeObject } from '@ordo/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearEffectCache, EFFECT_CACHE_BYTES, effectCacheBytes } from './effects.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { SPRITE_CACHE_BYTES, SpriteCache, spriteCache } from './spritecache.ts';
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
