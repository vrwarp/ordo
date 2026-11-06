/**
 * Advance widths read from font files, so text can be measured without a browser (design/27 §15 M6 tables:
 * a table row is as tall as its text, measured with sfnt metrics on the hub).
 *
 * - **What is read.** `head` (units per em), `hhea` (the line height and the count of long horizontal
 *   metrics), `hmtx` (advances) and `cmap` (code point → glyph: format 12 from a Unicode full-repertoire
 *   subtable, else format 4 from a Unicode BMP one, else a format 4 symbol subtable). Nothing else: no shaping, no kerning, no hinting. A
 *   glyph's advance is the width the browser's `measureText` gives a lone character at that size (kerning
 *   aside, which only narrows text), so measured lines are never shorter than the drawn ones.
 * - **Containers.** A TrueType or OpenType file (`0x00010000`, `true`, `OTTO`) or one face of a collection
 *   (`ttcf`, by index). WOFF and WOFF2 need zlib and brotli, which this package does not have: a caller with
 *   them passes the decoded tables to `metricsOfTables`.
 * - **Bounded.** The file is untrusted (an uploaded font): every offset is checked against the buffer, a
 *   table directory holds at most `SFNT_LIMITS.tables` entries, a cmap at most `SFNT_LIMITS.groups` groups
 *   or segments, a collection at most `SFNT_LIMITS.faces` faces. A face that cannot be read is undefined,
 *   never an exception. Lookups are memoised per face (at most `SFNT_LIMITS.cached` code points).
 *
 * Pure: bytes in, numbers out.
 */

/** The advances of one face. */
export interface FaceMetrics {
  /** The advance of a code point as a share of the font size, or undefined when the face has no glyph for it. */
  advance(cp: number): number | undefined;
  /**
   * The face's line height as a share of the font size: `hhea` ascender less descender (Carlito 1.22,
   * Liberation Sans 1.12), what LibreOffice and PowerPoint space a table cell's lines by. Undefined when
   * the font does not say.
   */
  lineHeight?: number;
}

/**
 * The face that draws `family` in a weight and slant, as the caller's font resolver would pick it (the
 * library's own face, else nothing: substitutes are asked for by name), or undefined when there is none.
 */
export type FaceSource = (family: string, bold: boolean, italic: boolean) => FaceMetrics | undefined;

/** A table of an sfnt by its tag, as raw bytes. */
export type SfntTables = (tag: string) => Uint8Array | undefined;

export const SFNT_LIMITS = {
  /** Table directory entries (real fonts have 10-40). */
  tables: 256,
  /** Faces of a collection. */
  faces: 256,
  /** cmap format 12 groups or format 4 segments (a full CJK font has a few thousand). */
  groups: 200_000,
  /** Code points memoised per face. */
  cached: 65_536,
} as const;

/** A bounds-checked big-endian reader over one table. */
class Reader {
  constructor(
    readonly b: Uint8Array,
    readonly start = 0,
    readonly end = b.length,
  ) {}
  ok(off: number, len: number): boolean {
    return off >= 0 && len >= 0 && this.start + off + len <= this.end;
  }
  u16(off: number): number {
    const p = this.start + off;
    return (this.b[p]! << 8) | this.b[p + 1]!;
  }
  i16(off: number): number {
    const v = this.u16(off);
    return v & 0x8000 ? v - 0x10000 : v;
  }
  u32(off: number): number {
    const p = this.start + off;
    return ((this.b[p]! << 24) >>> 0) + ((this.b[p + 1]! << 16) | (this.b[p + 2]! << 8) | this.b[p + 3]!);
  }
  tag(off: number): string {
    const p = this.start + off;
    return String.fromCharCode(this.b[p]!, this.b[p + 1]!, this.b[p + 2]!, this.b[p + 3]!);
  }
}

const SFNT_VERSIONS = new Set([0x00010000, 0x74727565 /* true */, 0x4f54544f /* OTTO */]);

/** The tables of the face at `offset` (an offset table), or undefined when its directory cannot be read. */
function tablesAt(b: Uint8Array, offset: number): SfntTables | undefined {
  const r = new Reader(b);
  if (!r.ok(offset, 12) || !SFNT_VERSIONS.has(r.u32(offset))) return undefined;
  const n = r.u16(offset + 4);
  if (n > SFNT_LIMITS.tables || !r.ok(offset + 12, n * 16)) return undefined;
  const dir = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const e = offset + 12 + i * 16;
    const tag = r.tag(e);
    const off = r.u32(e + 8);
    const len = r.u32(e + 12);
    if (!dir.has(tag) && r.ok(off, len)) dir.set(tag, b.subarray(off, off + len));
  }
  return (tag) => dir.get(tag);
}

/**
 * The metrics of a TrueType or OpenType file, or of face `index` of a collection; undefined when the file
 * is something else (WOFF, WOFF2, damaged) or lacks a table it needs.
 */
export function sfntMetrics(bytes: Uint8Array, index = 0): FaceMetrics | undefined {
  try {
    const r = new Reader(bytes);
    if (!r.ok(0, 12)) return undefined;
    if (r.tag(0) === 'ttcf') {
      const n = r.u32(8);
      if (!(index >= 0 && index < n && n <= SFNT_LIMITS.faces) || !r.ok(12, n * 4)) return undefined;
      const t = tablesAt(bytes, r.u32(12 + index * 4));
      return t ? metricsOfTables(t) : undefined;
    }
    const t = tablesAt(bytes, 0);
    return t ? metricsOfTables(t) : undefined;
  } catch {
    return undefined;
  }
}

/** A cmap lookup: code point → glyph id (0 = none). */
type Cmap = (cp: number) => number;

/** The face's metrics from its tables, or undefined when `head`, `hhea`, `hmtx` or a usable `cmap` is missing. */
export function metricsOfTables(table: SfntTables): FaceMetrics | undefined {
  try {
    const head = table('head');
    const hhea = table('hhea');
    const hmtx = table('hmtx');
    const cmapT = table('cmap');
    if (!head || !hhea || !hmtx || !cmapT) return undefined;
    const h = new Reader(head);
    if (!h.ok(18, 2)) return undefined;
    const upm = h.u16(18);
    if (upm < 16 || upm > 16_384) return undefined;
    const hh = new Reader(hhea);
    if (!hh.ok(34, 2)) return undefined;
    const longs = hh.u16(34);
    const mt = new Reader(hmtx);
    if (longs < 1 || !mt.ok(0, longs * 4)) return undefined;
    const cmap = readCmap(new Reader(cmapT));
    if (!cmap) return undefined;
    const cache = new Map<number, number | undefined>();
    const line = hh.ok(4, 4) ? (hh.i16(4) - hh.i16(6)) / upm : Number.NaN;
    return {
      ...(line >= 0.5 && line <= 3 ? { lineHeight: line } : {}),
      advance(cp: number): number | undefined {
        if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return undefined;
        if (cache.has(cp)) return cache.get(cp);
        const g = cmap(cp);
        const v = g === 0 ? undefined : mt.u16(Math.min(g, longs - 1) * 4) / upm;
        if (cache.size < SFNT_LIMITS.cached) cache.set(cp, v);
        return v;
      },
    };
  } catch {
    return undefined;
  }
}

/** The best cmap subtable: format 12 (full Unicode), else format 4 (BMP), else a format 4 symbol table. */
function readCmap(r: Reader): Cmap | undefined {
  if (!r.ok(0, 4)) return undefined;
  const n = r.u16(2);
  if (n > SFNT_LIMITS.tables || !r.ok(4, n * 8)) return undefined;
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
    const f = format12(r, full);
    if (f) return f;
  }
  if (bmp !== undefined) {
    const f = format4(r, bmp);
    if (f) return f;
  }
  if (symbol !== undefined) {
    // A symbol font maps its characters at U+F0xx; text asks for them at U+00xx too.
    const f = format4(r, symbol);
    if (f) return (cp) => f(cp) || (cp <= 0xff ? f(0xf000 + cp) : 0);
  }
  return undefined;
}

function format12(r: Reader, off: number): Cmap | undefined {
  if (!r.ok(off, 16)) return undefined;
  const groups = r.u32(off + 12);
  if (groups > SFNT_LIMITS.groups || !r.ok(off + 16, groups * 12)) return undefined;
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

function format4(r: Reader, off: number): Cmap | undefined {
  if (!r.ok(off, 14)) return undefined;
  const segs = r.u16(off + 6) >> 1;
  if (segs < 1 || segs > SFNT_LIMITS.groups || !r.ok(off, 16 + segs * 8)) return undefined;
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
