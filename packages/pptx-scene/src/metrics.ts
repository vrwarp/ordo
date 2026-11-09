/**
 * Advance widths read from font files, so text can be measured without a browser (design/27 §15 M6 tables:
 * a table row is as tall as its text, measured with sfnt metrics on the hub).
 *
 * - **What is read.** `head` (units per em), `hhea` (the line height and the count of long horizontal
 *   metrics), `hmtx` (advances), `cmap` (code point → glyph: format 12 from a Unicode full-repertoire
 *   subtable, else format 4 from a Unicode BMP one, else a format 4 symbol subtable), `OS/2` (the vertical
 *   metrics LibreOffice falls back to) and pair kerning: `GPOS` PairPos lookups (formats 1 and 2, also
 *   behind Extension lookups) of the 'kern' feature of the Latin or default script, else, in a font with no
 *   `GPOS` at all, the legacy `kern` table (format 0 subtables), which is how HarfBuzz, and so the
 *   browser's `measureText`, chooses. No shaping, no hinting. A glyph's advance is the width the browser
 *   gives a lone character at that size; `kern` is what it adds between two characters of one measured
 *   string (negative: closer).
 * - **Containers.** A TrueType or OpenType file (`0x00010000`, `true`, `OTTO`) or one face of a collection
 *   (`ttcf`, by index). WOFF and WOFF2 need zlib and brotli, which this package does not have: a caller with
 *   them passes the decoded tables to `metricsOfTables`.
 * - **Bounded.** The file is untrusted (an uploaded font): every offset is checked against the buffer, a
 *   table directory holds at most `SFNT_LIMITS.tables` entries, a cmap at most `SFNT_LIMITS.groups` groups
 *   or segments, a collection at most `SFNT_LIMITS.faces` faces, `GPOS` at most `SFNT_LIMITS.lookups`
 *   lookups and `SFNT_LIMITS.subtables` pair subtables (every search in them binary). A face that cannot be
 *   read is undefined, never an exception; kerning that cannot be read is none. Lookups are memoised per
 *   face (at most `SFNT_LIMITS.cached` code points and as many pairs).
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
  /**
   * The ascent and descent LibreOffice sizes a line by, as shares of the font size: `hhea` ascender and
   * descender (both positive), the `OS/2` win metrics when `hhea` has neither, the typo metrics when
   * `OS/2` sets USE_TYPO_METRICS (vcl `FontMetricData::ImplCalcLineSpacing`). Undefined when the font says
   * none.
   */
  ascent?: number;
  descent?: number;
  /**
   * The pair kerning between two code points drawn next to each other in one string, as a share of the
   * font size (negative: closer); 0 when the face has none for them.
   */
  kern?(left: number, right: number): number;
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
  /** Code points (and pairs) memoised per face. */
  cached: 65_536,
  /** `GPOS` lookups looked at, and pair subtables kept in all. */
  lookups: 1_024,
  subtables: 4_096,
  /**
   * Pair subtables tried for one pair (the first that covers it decides): a hostile font whose thousands of
   * subtables all cover a glyph and never match would otherwise make each pair cost two binary searches per
   * subtable. Real fonts have a few per lookup.
   */
  pairTries: 64,
  /** Legacy `kern` subtables read. */
  kernTables: 64,
} as const;

/** A bounds-checked big-endian reader over one table. */
class Reader {
  readonly b: Uint8Array;
  readonly start: number;
  readonly end: number;

  constructor(b: Uint8Array, start = 0, end = b.length) {
    this.b = b;
    this.start = start;
    this.end = end;
  }
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
    const vertical = verticalMetrics(hh, table('OS/2'), upm);
    const pairs = kerning(table, upm);
    const kerned = new Map<number, number>();
    return {
      ...(line >= 0.5 && line <= 3 ? { lineHeight: line } : {}),
      ...vertical,
      advance(cp: number): number | undefined {
        if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return undefined;
        if (cache.has(cp)) return cache.get(cp);
        const g = cmap(cp);
        const v = g === 0 ? undefined : mt.u16(Math.min(g, longs - 1) * 4) / upm;
        if (cache.size < SFNT_LIMITS.cached) cache.set(cp, v);
        return v;
      },
      ...(pairs
        ? {
            kern(left: number, right: number): number {
              if (!Number.isInteger(left) || !Number.isInteger(right)) return 0;
              if (left < 0 || left > 0x10ffff || right < 0 || right > 0x10ffff) return 0;
              const key = left * 0x110000 + right;
              const hit = kerned.get(key);
              if (hit !== undefined) return hit;
              const a = cmap(left);
              const b = cmap(right);
              let v = a && b ? pairs(a, b) : 0;
              if (!Number.isFinite(v) || Math.abs(v) > 1) v = 0;
              if (kerned.size < SFNT_LIMITS.cached) kerned.set(key, v);
              return v;
            },
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** LibreOffice's ascent and descent (see `FaceMetrics.ascent`), as shares of the em. */
function verticalMetrics(
  hh: Reader,
  os2: Uint8Array | undefined,
  upm: number,
): Pick<FaceMetrics, 'ascent' | 'descent'> {
  let asc = hh.ok(4, 4) ? Math.abs(hh.i16(4)) : 0;
  let desc = hh.ok(4, 4) ? Math.abs(hh.i16(6)) : 0;
  const o = os2 ? new Reader(os2) : undefined;
  if (o?.ok(0, 78)) {
    const typoAsc = o.i16(68);
    const typoDesc = o.i16(70);
    const winAsc = o.u16(74);
    const winDesc = o.u16(76);
    if (winAsc || winDesc || typoAsc || typoDesc) {
      if (!asc && !desc) {
        asc = winAsc;
        desc = winDesc;
      }
      // USE_TYPO_METRICS (fsSelection bit 7).
      if (o.u16(62) & 0x80 && typoAsc >= 0 && typoDesc <= 0) {
        asc = typoAsc;
        desc = -typoDesc;
      }
    }
  }
  const a = asc / upm;
  const d = desc / upm;
  return a > 0 && a <= 3 && d >= 0 && d <= 3 ? { ascent: a, descent: d } : {};
}

/** Pair kerning by glyph ids, in em: `GPOS` when the font has positioning, else the legacy `kern` table. */
type Pairs = (left: number, right: number) => number;

function kerning(table: SfntTables, upm: number): Pairs | undefined {
  const gpos = table('GPOS');
  if (gpos) {
    // A font with positioning is kerned by it alone, whether or not it has a kern feature (HarfBuzz).
    const k = gposKerning(new Reader(gpos), upm);
    return k === null ? legacyKerning(table('kern'), upm) : k;
  }
  return legacyKerning(table('kern'), upm);
}

/** Bit count of a ValueRecord format's low byte: its size is twice this. */
function valueSize(format: number): number {
  let n = 0;
  for (let f = format & 0xff; f; f >>= 1) n += f & 1;
  return n * 2;
}

/** The x advance a ValueRecord at `off` adds (font units), 0 when its format has none. */
function xAdvance(r: Reader, off: number, format: number): number {
  if (!(format & 0x4)) return 0;
  const at = off + (format & 0x1 ? 2 : 0) + (format & 0x2 ? 2 : 0);
  return r.ok(at, 2) ? r.i16(at) : 0;
}

/** A Coverage table's index of a glyph, or -1. */
function coverageIndex(r: Reader, off: number, g: number): number {
  if (!r.ok(off, 4)) return -1;
  const format = r.u16(off);
  const n = r.u16(off + 2);
  if (format === 1) {
    if (!r.ok(off + 4, n * 2)) return -1;
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = r.u16(off + 4 + mid * 2);
      if (v < g) lo = mid + 1;
      else if (v > g) hi = mid - 1;
      else return mid;
    }
    return -1;
  }
  if (format === 2) {
    if (!r.ok(off + 4, n * 6)) return -1;
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = off + 4 + mid * 6;
      if (g < r.u16(e)) hi = mid - 1;
      else if (g > r.u16(e + 2)) lo = mid + 1;
      else return r.u16(e + 4) + (g - r.u16(e));
    }
  }
  return -1;
}

/** A ClassDef table's class of a glyph (0 when it names none). */
function classOf(r: Reader, off: number, g: number): number {
  if (!r.ok(off, 6)) return 0;
  const format = r.u16(off);
  if (format === 1) {
    const start = r.u16(off + 2);
    const n = r.u16(off + 4);
    if (g < start || g >= start + n || !r.ok(off + 6 + (g - start) * 2, 2)) return 0;
    return r.u16(off + 6 + (g - start) * 2);
  }
  if (format === 2) {
    const n = r.u16(off + 2);
    if (!r.ok(off + 4, n * 6)) return 0;
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = off + 4 + mid * 6;
      if (g < r.u16(e)) hi = mid - 1;
      else if (g > r.u16(e + 2)) lo = mid + 1;
      else return r.u16(e + 4);
    }
  }
  return 0;
}

/**
 * One PairPos subtable's adjustment for a pair (font units), or undefined when it does not apply (the first
 * glyph not covered; format 1: no record for the second; format 2: a class past the counts), so that the
 * lookup's next subtable is tried, as HarfBuzz does.
 */
function pairPos(r: Reader, off: number, a: number, b: number): number | undefined {
  if (!r.ok(off, 10)) return undefined;
  const format = r.u16(off);
  const ci = coverageIndex(r, off + r.u16(off + 2), a);
  if (ci < 0) return undefined;
  const vf1 = r.u16(off + 4);
  const vf2 = r.u16(off + 6);
  const s1 = valueSize(vf1);
  const s2 = valueSize(vf2);
  if (format === 1) {
    const sets = r.u16(off + 8);
    if (ci >= sets || !r.ok(off + 10 + ci * 2, 2)) return undefined;
    const set = off + r.u16(off + 10 + ci * 2);
    if (!r.ok(set, 2)) return undefined;
    const n = r.u16(set);
    const size = 2 + s1 + s2;
    if (!r.ok(set + 2, n * size)) return undefined;
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const rec = set + 2 + mid * size;
      const g = r.u16(rec);
      if (g < b) lo = mid + 1;
      else if (g > b) hi = mid - 1;
      else return xAdvance(r, rec + 2, vf1) + xAdvance(r, rec + 2 + s1, vf2);
    }
    return undefined;
  }
  if (format === 2) {
    if (!r.ok(off, 16)) return undefined;
    const c1 = classOf(r, off + r.u16(off + 8), a);
    const c2 = classOf(r, off + r.u16(off + 10), b);
    const n1 = r.u16(off + 12);
    const n2 = r.u16(off + 14);
    if (c1 >= n1 || c2 >= n2) return undefined;
    const rec = off + 16 + (c1 * n2 + c2) * (s1 + s2);
    return xAdvance(r, rec, vf1) + xAdvance(r, rec + s1, vf2);
  }
  return undefined;
}

/**
 * The lookup indices of the 'kern' features of the default language system (its required feature too) of
 * the first of `tags` the font has a script for; none when it has none of them.
 */
function kernLookups(
  r: Reader,
  scripts: number,
  features: number,
  tags: readonly string[],
): number[] | undefined {
  if (!r.ok(scripts, 2) || !r.ok(features, 2)) return undefined;
  const nf = r.u16(features);
  if (!r.ok(features + 2, nf * 6)) return undefined;
  const kernFeature = (i: number) => i < nf && r.tag(features + 2 + i * 6) === 'kern';
  const lookupsOf = (i: number, out: Set<number>) => {
    const f = features + r.u16(features + 2 + i * 6 + 4);
    if (!r.ok(f, 4)) return;
    const n = r.u16(f + 2);
    if (!r.ok(f + 4, n * 2)) return;
    for (let k = 0; k < n && out.size < SFNT_LIMITS.lookups; k++) out.add(r.u16(f + 4 + k * 2));
  };
  const ns = r.u16(scripts);
  if (!r.ok(scripts + 2, ns * 6)) return undefined;
  for (const want of tags)
    for (let i = 0; i < ns; i++) {
      if (r.tag(scripts + 2 + i * 6) !== want) continue;
      const script = scripts + r.u16(scripts + 2 + i * 6 + 4);
      if (!r.ok(script, 4)) continue;
      const langSys = r.u16(script);
      if (!langSys) continue;
      const ls = script + langSys;
      if (!r.ok(ls, 6)) continue;
      const out = new Set<number>();
      const required = r.u16(ls + 2);
      if (required !== 0xffff && kernFeature(required)) lookupsOf(required, out);
      const n = r.u16(ls + 4);
      if (!r.ok(ls + 6, n * 2)) continue;
      for (let k = 0; k < n; k++) {
        const fi = r.u16(ls + 6 + k * 2);
        if (kernFeature(fi)) lookupsOf(fi, out);
      }
      return [...out].sort((x, y) => x - y);
    }
  // Neither script: no feature applies (HarfBuzz finds no language system for the text).
  return [];
}

/**
 * `GPOS` pair kerning (in em), or undefined when the font has positioning but no pair kerning for Latin
 * text, or null when the table cannot be read as positioning at all (the legacy table is used then).
 */
function gposKerning(r: Reader, upm: number): Pairs | undefined | null {
  if (!r.ok(0, 10) || r.u16(0) !== 1) return null;
  const scripts = r.u16(4);
  const features = r.u16(6);
  const lookupList = r.u16(8);
  if (!r.ok(lookupList, 2)) return null;
  const nl = r.u16(lookupList);
  if (!nl || !r.ok(lookupList + 2, nl * 2)) return null;
  const lookups = kernLookups(r, scripts, features, ['latn', 'DFLT', 'dflt']);
  if (!lookups?.length) return undefined;
  // Each lookup's PairPos subtables, in order (Extension lookups unwrapped).
  const tables: number[][] = [];
  let total = 0;
  for (const li of lookups) {
    if (li >= nl || total >= SFNT_LIMITS.subtables) continue;
    const lk = lookupList + r.u16(lookupList + 2 + li * 2);
    if (!r.ok(lk, 6)) continue;
    const type = r.u16(lk);
    const n = r.u16(lk + 4);
    if (!r.ok(lk + 6, n * 2)) continue;
    const subs: number[] = [];
    for (let k = 0; k < n && total < SFNT_LIMITS.subtables; k++) {
      let st = lk + r.u16(lk + 6 + k * 2);
      if (type === 9) {
        if (!r.ok(st, 8) || r.u16(st) !== 1 || r.u16(st + 2) !== 2) continue;
        st += r.u32(st + 4);
      } else if (type !== 2) continue;
      if (!r.ok(st, 10)) continue;
      subs.push(st);
      total++;
    }
    if (subs.length) tables.push(subs);
  }
  if (!tables.length) return undefined;
  return (a, b) => {
    let v = 0;
    let tries = 0;
    for (const subs of tables)
      for (const st of subs) {
        if (++tries > SFNT_LIMITS.pairTries) return v / upm;
        const d = pairPos(r, st, a, b);
        if (d !== undefined) {
          v += d;
          break;
        }
      }
    return v / upm;
  };
}

/** The legacy `kern` table's horizontal format 0 pairs (Microsoft version 0 or Apple version 1), in em. */
function legacyKerning(kern: Uint8Array | undefined, upm: number): Pairs | undefined {
  if (!kern) return undefined;
  const r = new Reader(kern);
  if (!r.ok(0, 4)) return undefined;
  // Format 0 pair arrays (each starts with nPairs) and whether each overrides the sum so far.
  const subs: { at: number; override: boolean }[] = [];
  if (r.u16(0) === 0) {
    const n = r.u16(2);
    let off = 4;
    for (let i = 0; i < n && i < SFNT_LIMITS.kernTables; i++) {
      if (!r.ok(off, 6)) break;
      const len = r.u16(off + 2);
      const coverage = r.u16(off + 4);
      // Horizontal (bit 0), neither minimum (bit 1) nor cross-stream (bit 2), format 0.
      if ((coverage & 0x7) === 0x1 && coverage >> 8 === 0)
        subs.push({ at: off + 6, override: (coverage & 0x8) !== 0 });
      if (len < 6) break;
      off += len;
    }
  } else if (r.u32(0) === 0x00010000) {
    const n = r.u32(4);
    let off = 8;
    for (let i = 0; i < n && i < SFNT_LIMITS.kernTables; i++) {
      if (!r.ok(off, 8)) break;
      const len = r.u32(off);
      const coverage = r.u16(off + 4);
      // Neither vertical, cross-stream nor variation; format 0.
      if ((coverage & 0xe000) === 0 && (coverage & 0xff) === 0) subs.push({ at: off + 8, override: false });
      if (len < 8) break;
      off += len;
    }
  }
  const valid = subs.filter((s) => r.ok(s.at, 8) && r.ok(s.at + 8, r.u16(s.at) * 6));
  if (!valid.length) return undefined;
  return (a, b) => {
    const key = a * 0x10000 + b;
    let v = 0;
    for (const s of valid) {
      let lo = 0;
      let hi = r.u16(s.at) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const e = s.at + 8 + mid * 6;
        const k = r.u16(e) * 0x10000 + r.u16(e + 2);
        if (k < key) lo = mid + 1;
        else if (k > key) hi = mid - 1;
        else {
          v = s.override ? r.i16(e + 4) : v + r.i16(e + 4);
          break;
        }
      }
    }
    return v / upm;
  };
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
