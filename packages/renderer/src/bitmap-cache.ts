/**
 * Decoded-image cache of the asset worker, bounded by bytes rather than count (review item 26), and the
 * downscale rule that keeps a decoded source at or under the output size. Pure, so both are unit tested.
 */

export type Sized = { width: number; height: number; close(): void };

export const bitmapBytes = (b: { width: number; height: number }): number => b.width * b.height * 4;

/** Default budget: 256 MiB of decoded pixels (about 30 full-HD frames, 8 at 4K). */
export const DEFAULT_BITMAP_BUDGET = 256 * 1024 * 1024;

/**
 * The size a decoded image is reduced to so that it still covers an output of `outW` x `outH` without
 * upscaling (cover fit) and fits it (contain fit): the smaller image dimension ratio becomes 1. Returns
 * undefined when the image is already small enough.
 */
export function downscaleFor(
  w: number,
  h: number,
  outW: number,
  outH: number,
): { width: number; height: number } | undefined {
  if (w <= 0 || h <= 0) return undefined;
  const scale = Math.max(outW / w, outH / h);
  if (scale >= 1) return undefined;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * Key of a decoded picture: the file's hash, plus `@` and the target's key for one prepared at a device
 * size (`preparePicture`, design/27 §7.1), so one file prepared for several sizes holds several entries.
 */
export function pictureKey(hash: string, target?: { key: string }): string {
  return target ? `${hash}@${target.key}` : hash;
}

/** The file hash of a `pictureKey`. */
export function pictureKeyHash(key: string): string {
  const at = key.indexOf('@');
  return at < 0 ? key : key.slice(0, at);
}

/**
 * LRU by last use; eviction closes the bitmap. Keys are `pictureKey`s. A pinned key (`pin`) is never
 * evicted or pruned: the asset worker pins what a cue's draw holds from its preload until the draw is done
 * (`unpin`), so neither a later insert nor a prune arriving meanwhile closes a bitmap the draw is about to
 * use. Pins are counted: jobs of the asset worker's raster lanes run side by side (design/27 §7.5), and one
 * job's release must not unpin what another still draws. Pinned entries may hold the cache over its limits
 * until they are unpinned.
 */
export class BitmapCache<B extends Sized> {
  private map = new Map<string, B>();
  /** Pin counts by key. */
  private pinned = new Map<string, number>();
  bytes = 0;

  constructor(
    public budgetBytes = DEFAULT_BITMAP_BUDGET,
    public maxCount = 64,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(hash: string): B | undefined {
    const hit = this.map.get(hash);
    if (!hit) return undefined;
    this.map.delete(hash);
    this.map.set(hash, hit);
    return hit;
  }

  has(hash: string): boolean {
    return this.map.has(hash);
  }

  /**
   * Insert and evict least recently used entries over budget. A previous entry under the key is replaced and
   * closed, unless it is pinned: a draw still holds it, so it stays and `bmp` is closed instead. Returns the
   * bitmap the cache now holds under the key.
   */
  set(hash: string, bmp: B): B {
    const prev = this.map.get(hash);
    if (prev && prev !== bmp && this.pinned.has(hash)) {
      bmp.close();
      this.get(hash);
      return prev;
    }
    if (prev && prev !== bmp) {
      this.bytes -= bitmapBytes(prev);
      prev.close();
    }
    this.map.delete(hash);
    this.map.set(hash, bmp);
    if (!prev || prev !== bmp) this.bytes += bitmapBytes(bmp);
    this.trim(hash);
    return bmp;
  }

  /** Keep `key` (inserted or not yet) from eviction and pruning until it is unpinned as often as pinned. */
  pin(key: string): void {
    this.pinned.set(key, (this.pinned.get(key) ?? 0) + 1);
  }

  /** Undo one `pin` of `key`; once no pin is left the cache trims back to its limits. */
  unpin(key: string): void {
    const n = this.pinned.get(key);
    if (n === undefined) return;
    if (n > 1) this.pinned.set(key, n - 1);
    else {
      this.pinned.delete(key);
      this.trim();
    }
  }

  /** Keys pinned at least once. */
  get pinnedCount(): number {
    return this.pinned.size;
  }

  /** Unpin every key (every job's pins) and evict back to the limits. */
  unpinAll(): void {
    this.pinned.clear();
    this.trim();
  }

  /** Drop every entry whose file hash (`pictureKeyHash`) is not in `keep`; pinned entries stay. */
  prune(keep: ReadonlySet<string>): number {
    let n = 0;
    for (const [k, b] of [...this.map]) {
      if (keep.has(pictureKeyHash(k)) || this.pinned.has(k)) continue;
      this.evict(k, b);
      n++;
    }
    return n;
  }

  /** Evict least recently used, unpinned entries (never `newest`) while over the limits. */
  private trim(newest?: string): void {
    for (const [k, b] of [...this.map]) {
      if ((this.bytes <= this.budgetBytes && this.map.size <= this.maxCount) || k === newest) break;
      if (this.pinned.has(k)) continue;
      this.evict(k, b);
    }
  }

  private evict(k: string, b: B): void {
    this.map.delete(k);
    this.bytes -= bitmapBytes(b);
    b.close();
  }
}
