/*
 * One cache for every sprite the drawers make and copy 1:1 later (design/27 §7.5 "effect sprite cache"; M9
 * plan decision 9): effect layers and composites (effects.ts), and in M9 geometry fills, decorations, 3-D
 * faces and charts. One byte budget bounds them all, least recently used first, with `bitmap-cache.ts`-style
 * counted pins: a sprite a draw is about to use (a lane's job between its turns) is never evicted while pinned.
 *
 * - **Budget** (`SPRITE_CACHE_BYTES`, `SPRITE_CACHE_FRAMES`, `SPRITE_CACHE_MAX_BYTES`): 64 MiB, raised to
 *   `SPRITE_CACHE_FRAMES` frames of the largest raster drawn on the thread (`raster`'s frame), at most
 *   `SPRITE_CACHE_MAX_BYTES`. A slide's sprites grow with the device pixels it is drawn at: the slide whose
 *   sprites take 29 MB at 1920 takes 114 MB at 3840 (measured, r2a repair: a Slidesmania template's 220
 *   shadowed shapes and four decorations), so a fixed 64 MiB that holds it at 1920 thrashes at 3840.
 * - **Rasters** (`raster`): a slide drawn by `drawSlide2D` (or a scene's parts) is one raster. A raster's own
 *   sprites never evict each other: an entry it used or kept is evicted only by a later raster, and a sprite
 *   that does not fit beside them is not kept (`set` is false; the caller draws with it this once). A slide
 *   whose sprites pass the budget then keeps the ones that fit and makes only the rest again on each draw; a
 *   plain LRU would evict, on every draw, exactly the sprites the rest of that draw (and the next) needs, and
 *   make all of them again every time. `room` says beforehand whether a sprite would be kept, so a drawer
 *   whose sprite only saves time once kept (a decoration's) does not make one to throw away; `fitKind` keeps a
 *   kind within its share by evicting that kind's oldest entries of earlier rasters, never the running one's.
 * - **Marks** (`mark`, `marked`): keys a drawer remembers without a sprite (a decoration drawn once, its sprite
 *   made the second time), in an LRU of their own of at most `SPRITE_MARKS` keys, cleared with their kind.
 *
 * Keys are the drawers' own (digests of what is drawn and the device transform), kept apart by `SpriteKind`, a
 * closed list: no deck string ever names an entry by itself. Entries are not closed on eviction unless they
 * say how (`close`): an OffscreenCanvas is released by the garbage collector.
 */

/** Bytes of cached sprites, all kinds together, at least (design/27 §7.5: 64 MiB). */
export const SPRITE_CACHE_BYTES = 64 * 1024 * 1024;
/** Frames of the largest raster drawn on the thread the budget holds (4 at 3840x2160: 127 MB). */
export const SPRITE_CACHE_FRAMES = 4;
/** Bytes of cached sprites at most, whatever the frame (a 4K output's four frames fit). */
export const SPRITE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
/** Keys remembered without a sprite (`mark`) at most. */
export const SPRITE_MARKS = 512;

/** Who made a sprite: its cache key's namespace and the bytes reported per kind. */
export type SpriteKind = 'effect' | 'geom' | 'decor' | 'look3d' | 'chart' | 'unit';

/** What the cache holds: anything that says its size in bytes. */
export interface CachedSprite {
  readonly bytes: number;
  /** Releases what the sprite holds (an ImageBitmap's `close`), when eviction must. */
  close?(): void;
}

type Entry<S> = { kind: SpriteKind; sprite: S; bytes: number; raster: number };

const sizeOf = (s: CachedSprite) => (Number.isFinite(s.bytes) && s.bytes > 0 ? s.bytes : 0);

/**
 * An LRU of sprites by bytes. A sprite larger than half the budget is not kept (it would evict nearly
 * everything else for one draw). Pins are counted per key, and a pinned entry stays past the budget until it
 * is unpinned. Within a `raster`, the raster's own entries are not evicted for its later ones (see the header).
 */
export class SpriteCache<S extends CachedSprite = CachedSprite> {
  private readonly map = new Map<string, Entry<S>>();
  private readonly pins = new Map<string, number>();
  private readonly perKind = new Map<SpriteKind, number>();
  private readonly marks = new Map<string, SpriteKind>();
  private total = 0;
  private budget: number;
  private readonly maxBudget: number;
  /** Rasters running (nested ones count once), the running one's number (0: none) and its entries' bytes. */
  private depth = 0;
  private current = 0;
  private rasters = 0;
  private rasterBytes = 0;

  /**
   * `budgetBytes`: the budget; a raster's frame raises it to `SPRITE_CACHE_FRAMES` frames, up to `maxBytes`
   * (by default the budget itself: no rise).
   */
  constructor(budgetBytes = SPRITE_CACHE_BYTES, maxBytes = budgetBytes) {
    this.budget = budgetBytes;
    this.maxBudget = Math.max(budgetBytes, maxBytes);
  }

  /** The budget now (raised by the largest raster's frame so far, never lowered). */
  get budgetBytes(): number {
    return this.budget;
  }

  private static key(kind: SpriteKind, key: string): string {
    return `${kind}|${key}`;
  }

  /**
   * Runs `fn` as one raster (see the header): the entries it uses and keeps are not evicted by its later sets.
   * `frameBytes`, the bytes of the frame it draws at its device scale, raises the budget to
   * `SPRITE_CACHE_FRAMES` of them (at most the cache's maximum). Nested calls are part of the outer raster.
   */
  raster<T>(fn: () => T, frameBytes?: number): T {
    if (frameBytes !== undefined && Number.isFinite(frameBytes) && frameBytes > 0)
      this.budget = Math.max(this.budget, Math.min(this.maxBudget, SPRITE_CACHE_FRAMES * frameBytes));
    if (this.depth++ === 0) {
      this.current = ++this.rasters;
      this.rasterBytes = 0;
    }
    try {
      return fn();
    } finally {
      if (--this.depth === 0) {
        this.current = 0;
        this.rasterBytes = 0;
      }
    }
  }

  /** The sprite under `key`, made most recently used (and the running raster's); undefined when not held. */
  get(kind: SpriteKind, key: string | undefined): S | undefined {
    if (key === undefined) return undefined;
    const k = SpriteCache.key(kind, key);
    const hit = this.map.get(k);
    if (!hit) return undefined;
    this.map.delete(k);
    this.map.set(k, hit);
    this.touch(hit);
    return hit.sprite;
  }

  has(kind: SpriteKind, key: string): boolean {
    return this.map.has(SpriteCache.key(kind, key));
  }

  /**
   * Whether a sprite of `bytes` set now would be kept: within half the budget and, during a raster, beside
   * what the raster holds already and what is pinned.
   */
  room(bytes: number): boolean {
    const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    if (b > this.budget / 2) return false;
    if (this.current === 0) return true;
    let held = this.rasterBytes;
    for (const k of this.pins.keys()) {
      const v = this.map.get(k);
      if (v && v.raster !== this.current) held += v.bytes;
    }
    return held + b <= this.budget;
  }

  /**
   * Room for a sprite of `bytes` of `kind` within `cap` bytes of that kind (a kind's share of the budget): the
   * least recently used unpinned entries of `kind` that the running raster has not used are evicted until it fits
   * (another slide's decorations make way for this one's), nothing of another kind. False, evicting nothing, when
   * the raster's own entries of the kind and the pinned ones leave no room.
   */
  fitKind(kind: SpriteKind, bytes: number, cap: number): boolean {
    const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    const evictable = (k: string, v: Entry<S>) =>
      v.kind === kind && !this.pins.has(k) && (this.current === 0 || v.raster !== this.current);
    if (this.bytes(kind) + b <= cap) return true;
    let kept = this.bytes(kind);
    for (const [k, v] of this.map) if (evictable(k, v)) kept -= v.bytes;
    if (kept + b > cap) return false;
    for (const [k, v] of this.map) {
      if (this.bytes(kind) + b <= cap) break;
      if (evictable(k, v)) this.drop(k, v, true);
    }
    return true;
  }

  /**
   * Keep `sprite` under `key` (replacing what was there) and evict the least recently used unpinned entries
   * past the budget (during a raster, only those it has not used). False when it is not kept: no key, larger
   * than half the budget, or, during a raster, no room beside what the raster holds (the caller still has it).
   */
  set(kind: SpriteKind, key: string | undefined, sprite: S): boolean {
    if (key === undefined) return false;
    const bytes = sizeOf(sprite);
    if (bytes > this.budget / 2) return false;
    const k = SpriteCache.key(kind, key);
    const old = this.map.get(k);
    if (old) this.drop(k, old, old.sprite !== sprite);
    const entry: Entry<S> = { kind, sprite, bytes, raster: 0 };
    this.map.set(k, entry);
    this.total += bytes;
    this.perKind.set(kind, (this.perKind.get(kind) ?? 0) + bytes);
    this.touch(entry);
    if (!this.trim(k) && this.current !== 0 && !this.pins.has(k)) {
      this.drop(k, entry, false);
      return false;
    }
    return true;
  }

  /** Forget `key` (closing its sprite). */
  delete(kind: SpriteKind, key: string): void {
    const k = SpriteCache.key(kind, key);
    const hit = this.map.get(k);
    if (hit) this.drop(k, hit, true);
  }

  /** Keep `key` from eviction until it is unpinned as often as it was pinned (held or not yet). */
  pin(kind: SpriteKind, key: string): void {
    const k = SpriteCache.key(kind, key);
    this.pins.set(k, (this.pins.get(k) ?? 0) + 1);
  }

  /** Undo one `pin`; once none is left the cache trims back to its budget. */
  unpin(kind: SpriteKind, key: string): void {
    const k = SpriteCache.key(kind, key);
    const n = this.pins.get(k);
    if (n === undefined) return;
    if (n > 1) this.pins.set(k, n - 1);
    else {
      this.pins.delete(k);
      this.trim();
    }
  }

  /** Remember `key` without a sprite (the oldest of `SPRITE_MARKS` marks goes). */
  mark(kind: SpriteKind, key: string): void {
    const k = SpriteCache.key(kind, key);
    this.marks.delete(k);
    this.marks.set(k, kind);
    if (this.marks.size > SPRITE_MARKS) {
      const first = this.marks.keys().next();
      if (!first.done) this.marks.delete(first.value);
    }
  }

  marked(kind: SpriteKind, key: string): boolean {
    return this.marks.has(SpriteCache.key(kind, key));
  }

  unmark(kind: SpriteKind, key: string): void {
    this.marks.delete(SpriteCache.key(kind, key));
  }

  /** Marks held, of one kind or all. */
  markCount(kind?: SpriteKind): number {
    if (kind === undefined) return this.marks.size;
    let n = 0;
    for (const v of this.marks.values()) if (v === kind) n++;
    return n;
  }

  /**
   * Forget every sprite and mark of `kind`, or of every kind (tests, a cold measurement, memory pressure);
   * pinned sprites stay.
   */
  clear(kind?: SpriteKind): void {
    for (const [k, v] of this.map)
      if ((kind === undefined || v.kind === kind) && !this.pins.has(k)) this.drop(k, v, true);
    for (const [k, v] of this.marks) if (kind === undefined || v === kind) this.marks.delete(k);
  }

  /** Bytes held, of one kind or all. */
  bytes(kind?: SpriteKind): number {
    return kind === undefined ? this.total : (this.perKind.get(kind) ?? 0);
  }

  /** Entries held, of one kind or all. */
  count(kind?: SpriteKind): number {
    if (kind === undefined) return this.map.size;
    let n = 0;
    for (const v of this.map.values()) if (v.kind === kind) n++;
    return n;
  }

  /** Keys pinned at least once. */
  get pinned(): number {
    return this.pins.size;
  }

  /** Makes `v` the running raster's (its bytes counted once). */
  private touch(v: Entry<S>): void {
    if (this.current === 0 || v.raster === this.current) return;
    v.raster = this.current;
    this.rasterBytes += v.bytes;
  }

  private drop(k: string, v: Entry<S>, close: boolean): void {
    this.map.delete(k);
    this.total -= v.bytes;
    this.perKind.set(v.kind, (this.perKind.get(v.kind) ?? 0) - v.bytes);
    if (this.current !== 0 && v.raster === this.current) this.rasterBytes -= v.bytes;
    if (close) v.sprite.close?.();
  }

  /**
   * Evict least recently used, unpinned entries (never `newest`, nor during a raster one it used) while past
   * the budget; whether the cache is within it after. Map order is use order, so the running raster's entries
   * are the last ones: the walk stops at the first of them.
   */
  private trim(newest?: string): boolean {
    if (this.total <= this.budget) return true;
    for (const [k, v] of this.map) {
      if (this.total <= this.budget) break;
      if (this.current !== 0 && v.raster === this.current) break;
      if (k === newest || this.pins.has(k)) continue;
      this.drop(k, v, true);
    }
    return this.total <= this.budget;
  }
}

/** The renderer's sprite cache: every drawer of this thread shares it (its budget follows the frame). */
export const spriteCache = new SpriteCache(SPRITE_CACHE_BYTES, SPRITE_CACHE_MAX_BYTES);

/** Forget every unpinned sprite of every kind (a cold measurement, memory pressure). */
export function clearSpriteCache(): void {
  spriteCache.clear();
}
