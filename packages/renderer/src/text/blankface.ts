import type { FaceLike } from './fonts.ts';

/*
 * The coverage probe's sentinel face (design/27 §10, `GlyphCoverage`): an OpenType font built here, in
 * memory, whose cmap maps every code point, U+0000 to U+10FFFF, to one empty glyph of no advance (a single
 * format 13 group, as Adobe Blank does). The probe ends its stacks with it, so a character no shipped face
 * has lands on it and measures as nothing: no advance, no ink. It never reaches the computer's own fonts,
 * whose answer depends on what the computer has: where no face has the character, Chromium measures the
 * .notdef box of the stack's first family (the shipped face's box is not the serif's); where the generic
 * family resolves to a face that has it, that face's glyph.
 *
 * Registered in the drawer's face set under a name of its own (`o-blank-` and 8 random hex digits): no
 * font string a drawer builds holds it (the resolver's internal names are `o` and 8 hex digits, which
 * `shippedStack` reads, and a deck's family name cannot guess it), so it never draws text.
 *
 * Ten tables, TrueType outlines (OTS, Chromium's font sanitizer, accepts them): head, hhea, maxp, OS/2,
 * hmtx, name, post, cmap, loca and glyf, with a box for .notdef and the empty glyph. `boxFont` builds any
 * face of box glyphs the same way (the coverage tests' stand-ins for CJK and Thai faces).
 */

/** One glyph of a built face: its advance and, for ink, a box [x0, y0, x1, y1] (font units, 1000 per em). */
export type BoxGlyph = { advance: number; box?: readonly [number, number, number, number] };

/** A face of box glyphs. Glyph 0 is .notdef. */
export type BoxFace = {
  /** The family in the face's name table (font strings use the name it is registered under). */
  family: string;
  /** usWeightClass (default 400); 700 and more is the family's bold face. */
  weight?: number;
  glyphs: readonly BoxGlyph[];
  /** Ranges of code points [first, last] each mapped to one glyph (cmap format 13), sorted, disjoint. */
  ranges: readonly (readonly [number, number, number])[];
};

const UPEM = 1000;
const ASCENT = 800;
const DESCENT = 200;

/** Big-endian bytes, written in order. */
class Out {
  readonly b: number[] = [];
  u8(v: number): this {
    this.b.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v >>> 8).u8(v);
  }
  i16(v: number): this {
    return this.u16(v < 0 ? v + 0x10000 : v);
  }
  u32(v: number): this {
    return this.u16(v >>> 16).u16(v & 0xffff);
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.b);
  }
}

/** A box: one clockwise contour of four on-curve points, no instructions. */
function boxGlyph([x0, y0, x1, y1]: readonly [number, number, number, number]): number[] {
  const o = new Out().i16(1).i16(x0).i16(y0).i16(x1).i16(y1).u16(3).u16(0);
  for (let i = 0; i < 4; i++) o.u8(0x01);
  for (const dx of [x0, 0, x1 - x0, 0]) o.i16(dx);
  for (const dy of [y0, y1 - y0, 0, y0 - y1]) o.i16(dy);
  while (o.b.length % 4) o.u8(0);
  return o.b;
}

/** UTF-16BE of `s`. */
function utf16(s: string): number[] {
  const o = new Out();
  for (let i = 0; i < s.length; i++) o.u16(s.charCodeAt(i));
  return o.b;
}

/** The sum of a table's big-endian 32-bit words, zero-padded (the sfnt checksum). */
function checksum(t: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < t.length; i += 4)
    sum =
      (sum + (((t[i]! << 24) | ((t[i + 1] ?? 0) << 16) | ((t[i + 2] ?? 0) << 8) | (t[i + 3] ?? 0)) >>> 0)) >>>
      0;
  return sum;
}

/** The tables into one sfnt (TrueType outlines), with their checksums and head's checkSumAdjustment. */
function sfnt(tables: Record<string, Uint8Array>): Uint8Array {
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const pow = 2 ** Math.floor(Math.log2(n));
  const dir = new Out()
    .u32(0x00010000)
    .u16(n)
    .u16(pow * 16)
    .u16(Math.log2(pow))
    .u16(n * 16 - pow * 16);
  let offset = 12 + 16 * n;
  const at: number[] = [];
  for (const tag of tags) {
    const t = tables[tag]!;
    for (let i = 0; i < 4; i++) dir.u8(tag.charCodeAt(i));
    dir.u32(checksum(t)).u32(offset).u32(t.length);
    at.push(offset);
    offset += (t.length + 3) & ~3;
  }
  const out = new Uint8Array(offset);
  out.set(dir.bytes());
  for (const [i, tag] of tags.entries()) out.set(tables[tag]!, at[i]);
  const head = at[tags.indexOf('head')]!;
  const adjust = (0xb1b0afba - checksum(out)) >>> 0;
  new DataView(out.buffer).setUint32(head + 8, adjust);
  return out;
}

/** A TrueType font of box glyphs (or empty ones), as OTS accepts it. */
export function boxFont(face: BoxFace): Uint8Array {
  const { glyphs, ranges } = face;
  if (!glyphs.length || glyphs.length > 0xffff) throw new Error('a face has 1 to 65535 glyphs');
  const weight = face.weight ?? 400;
  const bold = weight >= 700;
  const inked = glyphs.filter((g) => g.box);
  const xMin = Math.min(0, ...inked.map((g) => g.box![0]));
  const yMin = Math.min(0, ...inked.map((g) => g.box![1]));
  const xMax = Math.max(0, ...inked.map((g) => g.box![2]));
  const yMax = Math.max(0, ...inked.map((g) => g.box![3]));
  const advanceMax = Math.max(0, ...glyphs.map((g) => g.advance));
  const minLsb = inked.length ? Math.min(...inked.map((g) => g.box![0])) : 0;
  const minRsb = inked.length ? Math.min(...inked.map((g) => g.advance - g.box![2])) : 0;

  const glyf = new Out();
  const loca = new Out();
  for (const g of glyphs) {
    loca.u32(glyf.b.length);
    if (g.box) glyf.b.push(...boxGlyph(g.box));
  }
  loca.u32(glyf.b.length);
  // A zero-length table is refused: an all-empty face keeps four bytes no glyph points into.
  if (!glyf.b.length) glyf.u32(0);

  const head = new Out()
    .u16(1)
    .u16(0)
    .u32(0x00010000) // fontRevision
    .u32(0) // checkSumAdjustment, set by sfnt
    .u32(0x5f0f3cf5)
    .u16(0x0003) // baseline at y=0, left side bearing at x=0
    .u16(UPEM)
    .u32(0)
    .u32(0) // created
    .u32(0)
    .u32(0) // modified
    .i16(xMin)
    .i16(yMin)
    .i16(xMax)
    .i16(yMax)
    .u16(bold ? 1 : 0) // macStyle
    .u16(8) // lowestRecPPEM
    .i16(2) // fontDirectionHint
    .i16(1) // indexToLocFormat: long offsets
    .i16(0);
  const hhea = new Out()
    .u16(1)
    .u16(0)
    .i16(ASCENT)
    .i16(-DESCENT)
    .i16(0)
    .u16(advanceMax)
    .i16(minLsb)
    .i16(minRsb)
    .i16(xMax)
    .i16(1) // caretSlopeRise
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0) // metricDataFormat
    .u16(glyphs.length);
  const maxp = new Out()
    .u32(0x00010000)
    .u16(glyphs.length)
    .u16(inked.length ? 4 : 0) // maxPoints
    .u16(inked.length ? 1 : 0) // maxContours
    .u16(0)
    .u16(0)
    .u16(2) // maxZones
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0);
  const advances = glyphs.map((g) => g.advance).filter((a) => a > 0);
  const os2 = new Out()
    .u16(4)
    .i16(advances.length ? Math.round(advances.reduce((a, b) => a + b, 0) / advances.length) : 0)
    .u16(weight)
    .u16(5)
    .u16(0); // fsType: installable
  for (const v of [650, 600, 0, 75, 650, 600, 0, 350, 50, 300, 0]) os2.i16(v); // sub/superscript, strikeout, class
  for (let i = 0; i < 10; i++) os2.u8(0); // PANOSE
  os2.u32(0).u32(0).u32(0).u32(0); // ulUnicodeRange
  for (const c of 'NONE') os2.u8(c.charCodeAt(0));
  os2
    .u16(bold ? 0x00a0 : 0x00c0) // fsSelection: BOLD or REGULAR, USE_TYPO_METRICS
    .u16(0)
    .u16(0xffff)
    .i16(ASCENT)
    .i16(-DESCENT)
    .i16(0)
    .u16(ASCENT)
    .u16(DESCENT)
    .u32(1)
    .u32(0) // ulCodePageRange: Latin 1
    .i16(500)
    .i16(700)
    .u16(0)
    .u16(0x20)
    .u16(0);
  const hmtx = new Out();
  for (const g of glyphs) hmtx.u16(g.advance).i16(g.box ? g.box[0] : 0);
  const sub = bold ? 'Bold' : 'Regular';
  const ps = `${face.family.replace(/[^A-Za-z0-9-]/g, '') || 'Blank'}-${sub}`;
  const names: [number, string][] = [
    [1, face.family],
    [2, sub],
    [3, ps],
    [4, bold ? `${face.family} Bold` : face.family],
    [5, 'Version 1.0'],
    [6, ps],
  ];
  const name = new Out()
    .u16(0)
    .u16(names.length)
    .u16(6 + 12 * names.length);
  const strings: number[] = [];
  for (const [id, text] of names) {
    const s = utf16(text);
    name.u16(3).u16(1).u16(0x409).u16(id).u16(s.length).u16(strings.length);
    strings.push(...s);
  }
  name.b.push(...strings);
  const post = new Out().u32(0x00030000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);
  const cmap = new Out()
    .u16(0)
    .u16(1)
    .u16(3)
    .u16(10)
    .u32(12) // (3, 10): Unicode, full repertoire
    .u16(13)
    .u16(0)
    .u32(16 + 12 * ranges.length)
    .u32(0)
    .u32(ranges.length);
  for (const [first, last, glyph] of ranges) cmap.u32(first).u32(last).u32(glyph);

  return sfnt({
    'OS/2': os2.bytes(),
    cmap: cmap.bytes(),
    glyf: glyf.bytes(),
    head: head.bytes(),
    hhea: hhea.bytes(),
    hmtx: hmtx.bytes(),
    loca: loca.bytes(),
    maxp: maxp.bytes(),
    name: name.bytes(),
    post: post.bytes(),
  });
}

/** The sentinel's bytes: a box for .notdef, and every code point on one empty glyph of no advance. */
export function blankFont(): Uint8Array {
  return boxFont({
    family: 'Ordo Blank',
    glyphs: [{ advance: 500, box: [50, 0, 450, 700] }, { advance: 0 }],
    ranges: [[0, 0x10ffff, 1]],
  });
}

/** The sentinel registered in a drawer's face set (`registerBlankFace`), as `GlyphCoverage` uses it. */
export type BlankFace = {
  /** The family it is registered under, quoted for a CSS font list. */
  readonly family: string;
  /** Loaded and added to the face set: the probe can use it. */
  readonly ready: boolean;
  /** Settles once the face has loaded (true) or could not (false: no face set or FontFace here, refused). */
  readonly loaded: Promise<boolean>;
};

/** 8 random hex digits (the sentinel's name: no deck can name it). */
function randomHex(): string {
  const v = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function')
    crypto.getRandomValues(v);
  else v[0] = Math.floor(Math.random() * 0x1_0000_0000);
  return v[0]!.toString(16).padStart(8, '0');
}

function defaultFace(name: string, data: ArrayBuffer, descriptors: FontFaceDescriptors): FaceLike {
  if (typeof FontFace === 'undefined') throw new Error('FontFace is not available here');
  return new FontFace(name, data, descriptors);
}

/**
 * Load the sentinel and add it to `set` (`self.fonts` in a worker, `document.fonts` on a page), once per
 * drawer. Every weight matches it (1 to 1000), so a bold probe uses it as it is. Until it has loaded the
 * probe gives no verdict; a face set that refuses it leaves the probe without one for good.
 */
export function registerBlankFace(
  set: { add(face: FaceLike): unknown } | undefined,
  create: (name: string, data: ArrayBuffer, descriptors: FontFaceDescriptors) => FaceLike = defaultFace,
): BlankFace {
  const name = `o-blank-${randomHex()}`;
  let ready = false;
  let loaded: Promise<boolean>;
  try {
    if (!set) throw new Error('no font face set here');
    const bytes = blankFont();
    const face = create(name, bytes.buffer as ArrayBuffer, { weight: '1 1000', style: 'normal' });
    loaded = face
      .load()
      .then(() => {
        set.add(face);
        ready = true;
        return true;
      })
      .catch(() => false);
  } catch {
    loaded = Promise.resolve(false);
  }
  return {
    family: `"${name}"`,
    get ready() {
      return ready;
    },
    loaded,
  };
}
