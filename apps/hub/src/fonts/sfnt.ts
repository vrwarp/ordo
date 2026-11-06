import { brotliDecompressSync, inflateSync } from 'node:zlib';

export type FontFace = { family: string; weight: number; style: 'normal' | 'italic'; fullName?: string };

const WOFF2_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

/**
 * Decode-time limits for font files (design/25): a table directory with more entries than any real font,
 * or a name/OS/2/head table larger than this, is refused instead of being inflated or walked.
 */
export const FONT_LIMITS = {
  maxTables: 256,
  /** Bytes of one table we read (name tables of large CJK fonts stay well under 1 MiB). */
  maxTableBytes: 4 * 1024 * 1024,
  /** Decompressed WOFF2 table data. */
  maxWoff2Bytes: 64 * 1024 * 1024,
  maxNameRecords: 10_000,
} as const;

function checkCount(num: number): void {
  if (num > FONT_LIMITS.maxTables)
    throw new Error(`font has ${num} tables; the limit is ${FONT_LIMITS.maxTables}`);
}
function checkTable(t: string, len: number): void {
  if (len > FONT_LIMITS.maxTableBytes)
    throw new Error(`font table ${t.trim()} is ${len} bytes; the limit is ${FONT_LIMITS.maxTableBytes}`);
}

function tag(b: Buffer, o: number): string {
  return b.toString('latin1', o, o + 4);
}

/** Extract the `name` and `OS/2` tables from TTF/OTF, WOFF (zlib) or WOFF2 (brotli). */
export function fontTables(buf: Uint8Array): Map<string, Buffer> {
  return tablesOf(buf, new Set(['name', 'OS/2', 'head']));
}

/**
 * The tables text is measured with (`head`, `hhea`, `hmtx`, `cmap`; `@ordo/pptx-scene` `metricsOfTables`,
 * design/27 §15 M6 tables), from the same formats, and when present and within the table limit `OS/2`
 * (LibreOffice's fallback ascent and descent), `GPOS` and `kern` (pair kerning, M6 R1): one of those past
 * the limit is left out, and the face is measured without it. A WOFF2 `hmtx` stored transformed is left out
 * (its advances are not in the table's own layout), so such a face measures as missing.
 */
export function metricTables(buf: Uint8Array): Map<string, Buffer> {
  return tablesOf(
    buf,
    new Set(['head', 'hhea', 'hmtx', 'cmap', 'OS/2', 'GPOS', 'kern']),
    new Set(['hmtx']),
    new Set(['OS/2', 'GPOS', 'kern']),
  );
}

/**
 * The tables of `want` (WOFF2 tables of `plainOnly` only when stored without a transform). A table of
 * `optional` over `FONT_LIMITS.maxTableBytes` is left out; any other one throws.
 */
function tablesOf(
  buf: Uint8Array,
  want: ReadonlySet<string>,
  plainOnly?: ReadonlySet<string>,
  optional?: ReadonlySet<string>,
): Map<string, Buffer> {
  const big = (t: string, len: number) => len > FONT_LIMITS.maxTableBytes && optional?.has(t) === true;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map<string, Buffer>();
  const sig = tag(b, 0);
  if (sig === 'wOFF') {
    const num = b.readUInt16BE(12);
    checkCount(num);
    for (let i = 0; i < num; i++) {
      const e = 44 + i * 20;
      const t = tag(b, e);
      if (!want.has(t)) continue;
      const off = b.readUInt32BE(e + 4);
      const comp = b.readUInt32BE(e + 8);
      const orig = b.readUInt32BE(e + 12);
      if (big(t, Math.max(orig, comp))) continue;
      checkTable(t, Math.max(orig, comp));
      const data = b.subarray(off, off + comp);
      out.set(t, comp < orig ? inflateSync(data, { maxOutputLength: orig }) : Buffer.from(data));
    }
    return out;
  }
  if (sig === 'wOF2') {
    // Collection directories are not supported (single fonts only).
    if (b.readUInt32BE(4) === 0x74746366) throw new Error('font collections are not supported');
    const num = b.readUInt16BE(12);
    checkCount(num);
    const totalCompressed = b.readUInt32BE(20);
    let p = 48;
    const readBase128 = (): number => {
      let v = 0;
      for (let i = 0; i < 5; i++) {
        const byte = b[p++]!;
        v = v * 128 + (byte & 0x7f);
        if (!(byte & 0x80)) return v;
      }
      throw new Error('bad UIntBase128');
    };
    const entries: { tag: string; length: number; transformed: boolean }[] = [];
    for (let i = 0; i < num; i++) {
      const flags = b[p++]!;
      const idx = flags & 0x3f;
      let t: string;
      if (idx === 63) {
        t = tag(b, p);
        p += 4;
      } else t = WOFF2_TAGS[idx] ?? '????';
      const version = (flags >> 6) & 3;
      const origLength = readBase128();
      const transformed = t === 'glyf' || t === 'loca' ? version !== 3 : version !== 0;
      const length = transformed ? readBase128() : origLength;
      entries.push({ tag: t, length, transformed });
    }
    const total = entries.reduce((n, e) => n + e.length, 0);
    if (total > FONT_LIMITS.maxWoff2Bytes)
      throw new Error(`font tables total ${total} bytes; the limit is ${FONT_LIMITS.maxWoff2Bytes}`);
    for (const e of entries) if (want.has(e.tag) && !big(e.tag, e.length)) checkTable(e.tag, e.length);
    const data = brotliDecompressSync(b.subarray(p, p + totalCompressed), {
      maxOutputLength: Math.max(1, total),
    });
    let off = 0;
    for (const e of entries) {
      if (want.has(e.tag) && !(e.transformed && plainOnly?.has(e.tag)) && !big(e.tag, e.length))
        out.set(e.tag, data.subarray(off, off + e.length));
      off += e.length;
    }
    return out;
  }
  if (sig === 'ttcf') throw new Error('font collections (.ttc) are not supported');
  const num = b.readUInt16BE(4);
  checkCount(num);
  for (let i = 0; i < num; i++) {
    const e = 12 + i * 16;
    const t = tag(b, e);
    if (!want.has(t)) continue;
    const off = b.readUInt32BE(e + 8);
    const len = b.readUInt32BE(e + 12);
    if (big(t, len)) continue;
    checkTable(t, len);
    out.set(t, b.subarray(off, off + len));
  }
  return out;
}

function decodeName(raw: Buffer, platform: number): string {
  if (platform === 0 || platform === 3) {
    let s = '';
    for (let i = 0; i + 1 < raw.length; i += 2) s += String.fromCharCode(raw.readUInt16BE(i));
    return s;
  }
  return raw.toString('latin1');
}

/** name table: id → best string (Windows English first, then Unicode, then Mac). */
export function readNames(name: Buffer): Map<number, string> {
  const count = name.readUInt16BE(2);
  if (count > FONT_LIMITS.maxNameRecords) throw new Error(`font name table has ${count} records`);
  const strOff = name.readUInt16BE(4);
  const best = new Map<number, { score: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = name.readUInt16BE(r);
    const lang = name.readUInt16BE(r + 4);
    const id = name.readUInt16BE(r + 6);
    const len = name.readUInt16BE(r + 8);
    const off = name.readUInt16BE(r + 10);
    const score =
      platform === 3 && lang === 0x409
        ? 4
        : platform === 3
          ? 3
          : platform === 0
            ? 2
            : platform === 1 && lang === 0
              ? 1
              : 0;
    const cur = best.get(id);
    if (cur && cur.score >= score) continue;
    const raw = name.subarray(strOff + off, strOff + off + len);
    const value = decodeName(raw, platform).replace(/\0/g, '').trim();
    if (value) best.set(id, { score, value });
  }
  return new Map([...best].map(([k, v]) => [k, v.value]));
}

const WEIGHT_WORDS: [RegExp, number][] = [
  [/hairline|thin/i, 100],
  [/extra[- ]?light|ultra[- ]?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi[- ]?bold|demi[- ]?bold/i, 600],
  [/extra[- ]?bold|ultra[- ]?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

export function weightFromName(s: string): number {
  for (const [re, w] of WEIGHT_WORDS) if (re.test(s)) return w;
  return 400;
}

/** Read family, weight and style from a font file. Throws if the tables are unreadable. */
export function readFontFace(buf: Uint8Array): FontFace {
  const tables = fontTables(buf);
  const name = tables.get('name');
  if (!name) throw new Error('font has no name table');
  const names = readNames(name);
  const family = names.get(16) ?? names.get(1);
  if (!family) throw new Error('font has no family name');
  const sub = names.get(17) ?? names.get(2) ?? '';
  let weight = weightFromName(sub);
  let italic = /italic|oblique/i.test(sub);
  const os2 = tables.get('OS/2');
  if (os2 && os2.length >= 64) {
    const w = os2.readUInt16BE(4);
    if (w >= 1 && w <= 1000) weight = w < 10 ? w * 100 : w;
    const fsSel = os2.readUInt16BE(62);
    italic = italic || (fsSel & 1) === 1 || (fsSel & 0x200) === 0x200;
  } else {
    const head = tables.get('head');
    if (head && head.length >= 46) {
      const mac = head.readUInt16BE(44);
      if (mac & 1) weight = Math.max(weight, 700);
      if (mac & 2) italic = true;
    }
  }
  return {
    family,
    weight: Math.round(weight / 100) * 100 || 400,
    style: italic ? 'italic' : 'normal',
    fullName: names.get(4),
  };
}

/** Best-effort family/weight/style from a filename such as `OpenSans-SemiBoldItalic.woff2`. */
export function faceFromFilename(filename: string): FontFace {
  const base = (filename.split(/[\\/]/).pop() ?? filename).replace(/\.[a-z0-9]+$/i, '');
  const [fam, styleRaw = ''] = base.split(/[-_](?=[^-_]*$)/);
  const styleWord = styleRaw || '';
  const family = (fam ?? base)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return {
    family: family || base,
    weight: weightFromName(styleWord),
    style: /italic|oblique/i.test(styleWord) ? 'italic' : 'normal',
  };
}
