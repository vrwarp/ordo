/**
 * The cmap of an sfnt (design/27 §15 M9 decision 12; moved here from `@ordo/pptx-scene` `metrics.ts` with the
 * reader, `reader.ts`): code point → glyph id. Format 12 from a Unicode full-repertoire subtable, else format
 * 4 from a Unicode BMP one, else a format 4 symbol subtable (whose characters at U+F0xx are also asked for at
 * U+00xx). Bounded by the caller's limits (`SFNT_LIMITS`: subtables listed, groups or segments); every
 * offset is checked by the `Reader`, every search is binary.
 *
 * Pure: it imports only the reader's type.
 */
import type { Reader } from './reader.ts';

/** A cmap lookup: code point → glyph id (0 = none). */
export type Cmap = (cp: number) => number;

/** What bounds a cmap (`SFNT_LIMITS`): subtables listed (`tables`), format 12 groups or format 4 segments. */
export interface CmapLimits {
  readonly tables: number;
  readonly groups: number;
}

/** The best cmap subtable: format 12 (full Unicode), else format 4 (BMP), else a format 4 symbol table. */
export function readCmap(r: Reader, limits: CmapLimits): Cmap | undefined {
  if (!r.ok(0, 4)) return undefined;
  const n = r.u16(2);
  if (n > limits.tables || !r.ok(4, n * 8)) return undefined;
  let full: number | undefined;
  let bmp: number | undefined;
  let symbol: number | undefined;
  for (let i = 0; i < n; i++) {
    const e = 4 + i * 8;
    const platform = r.u16(e);
    const encoding = r.u16(e + 2);
    const off = r.u32(e + 4);
    if (!r.ok(off, 4)) continue;
    const format = r.u16(off);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (format === 12 && unicode) full ??= off;
    else if (format === 4 && unicode) bmp ??= off;
    else if (format === 4 && platform === 3 && encoding === 0) symbol ??= off;
  }
  if (full !== undefined) {
    const f = format12(r, full, limits);
    if (f) return f;
  }
  if (bmp !== undefined) {
    const f = format4(r, bmp, limits);
    if (f) return f;
  }
  if (symbol !== undefined) {
    // A symbol font maps its characters at U+F0xx; text asks for them at U+00xx too.
    const f = format4(r, symbol, limits);
    if (f) return (cp) => f(cp) || (cp <= 0xff ? f(0xf000 + cp) : 0);
  }
  return undefined;
}

function format12(r: Reader, off: number, limits: CmapLimits): Cmap | undefined {
  if (!r.ok(off, 16)) return undefined;
  const groups = r.u32(off + 12);
  if (groups > limits.groups || !r.ok(off + 16, groups * 12)) return undefined;
  const at = (i: number) => off + 16 + i * 12;
  return (cp) => {
    let lo = 0;
    let hi = groups - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = at(mid);
      const start = r.u32(g);
      const end = r.u32(g + 4);
      if (cp < start) hi = mid - 1;
      else if (cp > end) lo = mid + 1;
      else return r.u32(g + 8) + (cp - start);
    }
    return 0;
  };
}

function format4(r: Reader, off: number, limits: CmapLimits): Cmap | undefined {
  if (!r.ok(off, 14)) return undefined;
  const segs = r.u16(off + 6) >> 1;
  if (segs < 1 || segs > limits.groups || !r.ok(off, 16 + segs * 8)) return undefined;
  const ends = off + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    let lo = 0;
    let hi = segs - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (r.u16(ends + mid * 2) < cp) lo = mid + 1;
      else hi = mid;
    }
    if (r.u16(ends + lo * 2) < cp) return 0;
    const start = r.u16(starts + lo * 2);
    if (cp < start) return 0;
    const delta = r.i16(deltas + lo * 2);
    const rangeAt = ranges + lo * 2;
    const range = r.u16(rangeAt);
    if (range === 0) return (cp + delta) & 0xffff;
    const g = rangeAt + range + (cp - start) * 2;
    if (!r.ok(g, 2)) return 0;
    const v = r.u16(g);
    return v === 0 ? 0 : (v + delta) & 0xffff;
  };
}
