/*
 * One cache for every sprite the drawers make and copy 1:1 later (design/27 §7.5 "effect sprite cache"; M9
 * plan decision 9): effect layers and composites (effects.ts), and in M9 geometry fills, decorations, 3-D
 * faces and charts. One byte budget (`SPRITE_CACHE_BYTES`, 64 MiB) bounds them all, least recently used first,
 * with `bitmap-cache.ts`-style counted pins: a sprite a draw is about to use (a lane's job between its
 * turns) is never evicted while pinned.
 *
 * Keys are the drawers' own (digests of what is drawn and the device transform), kept apart by `SpriteKind`, a
 * closed list: no deck string ever names an entry by itself. Entries are not closed on eviction unless they
 * say how (`close`): an OffscreenCanvas is released by the garbage collector.
 */

/** Bytes of cached sprites, all kinds together (design/27 §7.5: ≤ 64 MiB). */
export const SPRITE_CACHE_BYTES = 64 * 1024 * 1024;

/** Who made a sprite: its cache key's namespace and the bytes reported per kind. */
export type SpriteKind = 'effect' | 'geom' | 'decor' | 'look3d' | 'chart' | 'unit';

/** What the cache holds: anything that says its size in bytes. */
export interface CachedSprite {
  readonly bytes: number;
  /** Releases what the sprite holds (an ImageBitmap's `close`), when eviction must. */
  close?(): void;
}

/**
 * An LRU of sprites by bytes. A sprite larger than half the budget is not kept (it would evict nearly
 * everything else for one draw). Pins are counted per key, and a pinned entry stays past the budget until it
 * is unpinned.
 */
export class SpriteCache<S extends CachedSprite = CachedSprite> {
  private readonly map = new Map<string, { kind: SpriteKind; sprite: S }>();
  private readonly pins = new Map<string, number>();
  private readonly perKind = new Map<SpriteKind, number>();
  private total = 0;
  readonly budgetBytes: number;

  constructor(budgetBytes = SPRITE_CACHE_BYTES) {
    this.budgetBytes = budgetBytes;
  }

  private static key(kind: SpriteKind, key: string): string {
    return `${kind}|${key}`;
  }

  /** The sprite under `key`, made most recently used; undefined when not held. */
  get(kind: SpriteKind, key: string | undefined): S | undefined {
    if (key === undefined) return undefined;
    const k = SpriteCache.key(kind, key);
    const hit = this.map.get(k);
    if (!hit) return undefined;
    this.map.delete(k);
    this.map.set(k, hit);
    return hit.sprite;
  }

  has(kind: SpriteKind, key: string): boolean {
    return this.map.has(SpriteCache.key(kind, key));
  }

  /**
   * Keep `sprite` under `key` (replacing what was there) and evict the least recently used unpinned entries
   * past the budget. False when it is not kept: no key, or larger than half the budget.
   */
  set(kind: SpriteKind, key: string | undefined, sprite: S): boolean {
    if (key === undefined) return false;
    const bytes = Number.isFinite(sprite.bytes) && sprite.bytes > 0 ? sprite.bytes : 0;
    if (bytes > this.budgetBytes / 2) return false;
    const k = SpriteCache.key(kind, key);
    const old = this.map.get(k);
    if (old) this.drop(k, old, old.sprite !== sprite);
    this.map.set(k, { kind, sprite });
    this.total += bytes;
    this.perKind.set(kind, (this.perKind.get(kind) ?? 0) + bytes);
    this.trim(k);
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

  /**
   * Forget every sprite of `kind`, or of every kind (tests, a cold measurement, memory pressure); pinned
   * sprites stay.
   */
  clear(kind?: SpriteKind): void {
    for (const [k, v] of [...this.map])
      if ((kind === undefined || v.kind === kind) && !this.pins.has(k)) this.drop(k, v, true);
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

  private drop(k: string, v: { kind: SpriteKind; sprite: S }, close: boolean): void {
    this.map.delete(k);
    const bytes = Number.isFinite(v.sprite.bytes) && v.sprite.bytes > 0 ? v.sprite.bytes : 0;
    this.total -= bytes;
    this.perKind.set(v.kind, (this.perKind.get(v.kind) ?? 0) - bytes);
    if (close) v.sprite.close?.();
  }

  /** Evict least recently used, unpinned entries (never `newest`) while past the budget. */
  private trim(newest?: string): void {
    if (this.total <= this.budgetBytes) return;
    for (const [k, v] of [...this.map]) {
      if (this.total <= this.budgetBytes) break;
      if (k === newest || this.pins.has(k)) continue;
      this.drop(k, v, true);
    }
  }
}

/** The renderer's sprite cache: every drawer of this thread shares it. */
export const spriteCache = new SpriteCache();

/** Forget every unpinned sprite of every kind (a cold measurement, memory pressure). */
export function clearSpriteCache(): void {
  spriteCache.clear();
}
