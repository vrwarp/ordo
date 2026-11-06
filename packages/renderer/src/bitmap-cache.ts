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

/** LRU by last use; eviction closes the bitmap. Keys are `pictureKey`s. */
export class BitmapCache<B extends Sized> {
  private map = new Map<string, B>();
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

  /** Insert (replacing any previous entry) and evict least recently used entries over budget. */
  set(hash: string, bmp: B): void {
    const prev = this.map.get(hash);
    if (prev && prev !== bmp) {
      this.bytes -= bitmapBytes(prev);
      prev.close();
    }
    this.map.delete(hash);
    this.map.set(hash, bmp);
    if (!prev || prev !== bmp) this.bytes += bitmapBytes(bmp);
    for (const [k, b] of this.map) {
      if ((this.bytes <= this.budgetBytes && this.map.size <= this.maxCount) || k === hash) break;
      this.evict(k, b);
    }
  }

  /** Drop every entry whose file hash (`pictureKeyHash`) is not in `keep`. */
  prune(keep: ReadonlySet<string>): number {
    let n = 0;
    for (const [k, b] of [...this.map]) {
      if (keep.has(pictureKeyHash(k))) continue;
      this.evict(k, b);
      n++;
    }
    return n;
  }

  private evict(k: string, b: B): void {
    this.map.delete(k);
    this.bytes -= bitmapBytes(b);
    b.close();
  }
}
