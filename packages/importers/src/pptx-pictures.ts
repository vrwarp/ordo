/**
 * Picture headers and display needs of a PowerPoint import (design/27 §4 "Pictures", §12 "Media"), the one
 * copy the hub's picture preparation (`apps/hub/src/pptx/pictures.ts`) and the client parse share
 * (`pptx-client.ts`). Pure TypeScript: runs in Node.js, browsers and Web Workers alike.
 *
 * - `pictureHeader`: the bytes are sniffed and the header checked: PNG, JPEG, GIF and WebP; BMP and TIFF
 *   recognised for conversion; SVG, EMF and WMF recognised as metafiles; anything else, and every malformed
 *   or lying header, refused. Reads are bounded (`PICTURE_LIMITS.scanBytes`); `scanPicture` is the scan the
 *   hub's positioned file reader drives (`readPictureHeader`).
 * - `displayNeeds`: the display need of a part is its widest use in the deck: the box width at 3840 px ÷ the
 *   visible crop fraction (with the picture's size known, the box height counts too), at least 128 and at
 *   most 8,192 px.
 * - `clearExifOrientation`: PowerPoint draws a picture's stored pixels and ignores an EXIF orientation, which
 *   browsers apply, so a kept JPEG's orientation is set to 1 (two bytes of a copy).
 */
import type { Slide } from '@ordo/domain';

export const PICTURE_LIMITS = {
  /** Largest side of a prepared picture. */
  side: 8_192,
  /** Largest prepared picture, in megapixels. */
  megapixels: 40,
  /** The output width a display need is computed for. */
  displayWidth: 3_840,
  /** A source is downscaled when it is more than this many times its display need. */
  downscaleOver: 1.25,
  /** The smallest display need: a picture stays usable when the editor enlarges its box a little. */
  minNeed: 128,
  /** Largest source side decoded (the media pipeline's limit). */
  sourceSide: 16_384,
  /** Largest source decoded at full size, in megapixels. JPEG decodes at a reduced size and may be larger. */
  sourceMegapixels: 100,
  /** Megapixels the pictures of one import may decode in all; pictures kept as they are cost nothing. */
  importMegapixels: 6_000,
  /** Largest animated WebP read into memory for its first frame. */
  animatedBytes: 64 * 1024 * 1024,
  /** Bytes a header check may read in all (JPEG segments, PNG chunks, GIF blocks before the frame data). */
  scanBytes: 16 * 1024 * 1024,
  /**
   * A picture kept as it is (or stored ready) may hold its pixels at 4 bytes each plus this much (metadata,
   * colour profiles), and never more than `maxBytes`; anything larger is re-encoded, which drops trailing
   * data and metadata, so a deck cannot ship padding to every screen.
   */
  slackBytes: 1024 * 1024,
  maxBytes: 64 * 1024 * 1024,
} as const;

/** The most bytes a stored picture of `width` x `height` px may have (`PICTURE_LIMITS.slackBytes`). */
export function plausibleBytes(width: number, height: number): number {
  return Math.min(PICTURE_LIMITS.maxBytes, width * height * 4 + PICTURE_LIMITS.slackBytes);
}

/** The logical canvas width the slide geometry is in. */
const LOGICAL_WIDTH = 1920;
const LOGICAL_HEIGHT = 1080;

/** What a picture's first bytes say. */
export type PictureHeader = {
  format: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'svg' | 'emf' | 'wmf' | 'other';
  /** As stored (an EXIF orientation is not applied); 0 when the header does not say (SVG, a standard WMF). */
  width: number;
  height: number;
  /** More than one frame or page (animated GIF, APNG, animated WebP, multi-page TIFF): the first is kept. */
  animated: boolean;
  /** Known from the header (PNG colour type, WebP flags); undefined when only decoding can tell. */
  alpha?: boolean;
  /**
   * JPEG EXIF orientation 2-8. PowerPoint ignores it and lays the picture out as stored; browsers would turn
   * it, so preparation removes it.
   */
  orientation?: number;
  /** Where the 2-byte orientation value is in the file (preparation sets it to 1 in a kept copy). */
  orientationAt?: number;
  /**
   * The bytes read ended before the header did (a head too short, or the scan budget spent): animation,
   * alpha or the size may be unknown, so the picture is converted rather than kept as it is.
   */
  partial?: boolean;
  /**
   * Converted rather than kept: a variant clients may not decode (12-bit, lossless, hierarchical or
   * arithmetic JPEG), or EXIF metadata in a PNG or WebP that browsers would turn the picture by.
   */
  convert?: boolean;
};

/** Formats LibreOffice converts in the follow-up job (item D): never decoded here. */
export const METAFILE_FORMATS: ReadonlySet<PictureHeader['format']> = new Set(['svg', 'emf', 'wmf']);

export function isMetafile(h: PictureHeader): boolean {
  return METAFILE_FORMATS.has(h.format);
}

// ── Header checks ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A header scan: yields the byte ranges [position, length] it needs and gets them back, shorter at the end
 * of the file, or undefined past the bytes it may read (a short head, the scan budget).
 */
export type Scan = Generator<readonly [number, number], PictureHeader | undefined, Uint8Array | undefined>;

const b8 = (b: Uint8Array, i: number): number => b[i] ?? 0;
const u16le = (b: Uint8Array, i: number): number => b8(b, i) | (b8(b, i + 1) << 8);
const u16be = (b: Uint8Array, i: number): number => (b8(b, i) << 8) | b8(b, i + 1);
export const u24le = (b: Uint8Array, i: number): number => u16le(b, i) | (b8(b, i + 2) << 16);
export const u32le = (b: Uint8Array, i: number): number => u24le(b, i) + b8(b, i + 3) * 0x1000000;
const u32be = (b: Uint8Array, i: number): number =>
  b8(b, i) * 0x1000000 + ((b8(b, i + 1) << 16) | (b8(b, i + 2) << 8) | b8(b, i + 3));
const i32le = (b: Uint8Array, i: number): number => u32le(b, i) | 0;
const i16le = (b: Uint8Array, i: number): number => (u16le(b, i) << 16) >> 16;
export const ascii = (b: Uint8Array, i: number, s: string): boolean =>
  b.length >= i + s.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
export const fourcc = (b: Uint8Array, i: number): string =>
  String.fromCharCode(b8(b, i), b8(b, i + 1), b8(b, i + 2), b8(b, i + 3));

let CRC_TABLE: Uint32Array | undefined;
function crc32(b: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Valid PNG bit depths per colour type. */
const PNG_DEPTHS: { readonly [ct: number]: readonly number[] } = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
/** Header chunks read before the image data (a PNG has a handful). */
const MAX_PNG_CHUNKS = 4_096;

function* scanPng(): Scan {
  const h = yield [0, 33];
  if (!h || h.length < 33 || u32be(h, 8) !== 13 || !ascii(h, 12, 'IHDR')) return undefined;
  if (crc32(h.subarray(12, 29)) !== u32be(h, 29)) return undefined;
  const width = u32be(h, 16);
  const height = u32be(h, 20);
  const depth = b8(h, 24);
  const ct = b8(h, 25);
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) return undefined;
  if (!PNG_DEPTHS[ct]?.includes(depth) || b8(h, 26) !== 0 || b8(h, 27) !== 0 || b8(h, 28) > 1)
    return undefined;
  let alpha = ct === 4 || ct === 6;
  let animated = false;
  let exif = false;
  let pos = 33;
  for (let i = 0; i < MAX_PNG_CHUNKS; i++) {
    const c = yield [pos, 8];
    if (!c) break;
    if (c.length < 8) return undefined;
    const len = u32be(c, 0);
    const type = fourcc(c, 4);
    if (len > 0x7fffffff) return undefined;
    if (type === 'IDAT')
      return { format: 'png', width, height, animated, alpha, ...(exif ? { convert: true } : {}) };
    if (type === 'IEND') return undefined;
    if (type === 'tRNS') alpha = true;
    if (type === 'acTL') animated = true;
    if (type === 'eXIf') exif = true;
    pos += 12 + len;
  }
  return { format: 'png', width, height, animated, ...(alpha ? { alpha } : {}), partial: true };
}

/** JPEG start-of-frame markers (every coding process). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** Segments walked before the frame header. */
const MAX_JPEG_SEGMENTS = 4_096;

/** The orientation (1-8) in an APP1 Exif segment's payload, if it has one. */
export function exifOrientation(seg: Uint8Array): number | undefined {
  return exifOrientationEntry(seg)?.value;
}

/** The orientation in an APP1 Exif payload and the offset of its 2-byte value in `seg`. */
function exifOrientationEntry(seg: Uint8Array): { value: number; at: number } | undefined {
  if (!ascii(seg, 0, 'Exif\0\0')) return undefined;
  const t = seg.subarray(6);
  const le = ascii(t, 0, 'II');
  if (!le && !ascii(t, 0, 'MM')) return undefined;
  const r16 = le ? u16le : u16be;
  const r32 = le ? u32le : u32be;
  if (r16(t, 2) !== 42) return undefined;
  const ifd = r32(t, 4);
  if (ifd < 8 || ifd + 2 > t.length) return undefined;
  const n = Math.min(r16(t, ifd), 1024);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return undefined;
    if (r16(t, e) !== 0x0112) continue;
    if (r16(t, e + 2) !== 3) return undefined;
    const v = r16(t, e + 8);
    return v >= 1 && v <= 8 ? { value: v, at: 6 + e + 8 } : undefined;
  }
  return undefined;
}

function* scanJpeg(): Scan {
  let pos = 2;
  let orientation: { value: number; at: number } | undefined;
  for (let i = 0; i < MAX_JPEG_SEGMENTS; i++) {
    const m = yield [pos, 4];
    if (!m) return { format: 'jpeg', width: 0, height: 0, animated: false, alpha: false, partial: true };
    if (m.length < 2 || m[0] !== 0xff) return undefined;
    const mk = b8(m, 1);
    if (mk === 0xff) {
      pos += 1; // fill byte
      continue;
    }
    if ((mk >= 0xd0 && mk <= 0xd7) || mk === 0x01) {
      pos += 2;
      continue;
    }
    // Another start of image, the end of it or its scan before any frame header: malformed.
    if (mk === 0xd8 || mk === 0xd9 || mk === 0xda || mk === 0x00 || m.length < 4) return undefined;
    const len = u16be(m, 2);
    if (len < 2) return undefined;
    if (SOF.has(mk)) {
      const f = yield [pos + 4, 6];
      if (!f) return { format: 'jpeg', width: 0, height: 0, animated: false, alpha: false, partial: true };
      if (f.length < 6 || len < 8) return undefined;
      const height = u16be(f, 1);
      const width = u16be(f, 3);
      const comps = b8(f, 5);
      // A height of 0 is defined later by a DNL marker: too rare to support, refused.
      if (!width || !height || !comps) return undefined;
      const convert =
        !(mk === 0xc0 || mk === 0xc1 || mk === 0xc2) || b8(f, 0) !== 8 || ![1, 3, 4].includes(comps);
      return {
        format: 'jpeg',
        width,
        height,
        animated: false,
        alpha: false,
        ...(orientation && orientation.value !== 1
          ? { orientation: orientation.value, orientationAt: orientation.at }
          : {}),
        ...(convert ? { convert } : {}),
      };
    }
    if (mk === 0xe1 && orientation === undefined && len > 8) {
      const seg = yield [pos + 4, len - 2];
      if (seg && seg.length === len - 2 && ascii(seg, 0, 'Exif\0\0')) {
        const o = exifOrientationEntry(seg);
        orientation = o ? { value: o.value, at: pos + 4 + o.at } : { value: 1, at: 0 };
      }
    }
    pos += 2 + len;
  }
  return undefined;
}

/** The colour table size a GIF packed field announces. */
const gifTable = (flags: number): number => (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);

/** Skip GIF data sub-blocks from `pos`: the position after their terminator, -1 when unknown, -2 at a cut. */
function* skipGifBlocks(pos: number): Generator<readonly [number, number], number, Uint8Array | undefined> {
  for (;;) {
    const n = yield [pos, 1];
    if (!n) return -1;
    if (n.length < 1) return -2;
    if (n[0] === 0) return pos + 1;
    pos += 1 + b8(n, 0);
  }
}

function* scanGif(): Scan {
  const h = yield [0, 13];
  if (!h || h.length < 13 || !(ascii(h, 0, 'GIF87a') || ascii(h, 0, 'GIF89a'))) return undefined;
  const width = u16le(h, 6);
  const height = u16le(h, 8);
  if (!width || !height) return undefined;
  let pos = 13 + gifTable(b8(h, 10));
  let frames = 0;
  let transparent = false;
  let alpha: boolean | undefined;
  const partial = (): PictureHeader | undefined =>
    frames
      ? {
          format: 'gif',
          width,
          height,
          animated: false,
          ...(alpha !== undefined ? { alpha } : {}),
          partial: true,
        }
      : { format: 'gif', width, height, animated: false, partial: true };
  for (;;) {
    const t = yield [pos, 1];
    if (!t) return partial();
    if (t.length < 1 || t[0] === 0x3b) break; // the trailer (or a cut after the frames)
    if (t[0] === 0x21) {
      // An extension: its label, then (a graphic control extension) the block size 4 and the packed field.
      const x = yield [pos + 1, 3];
      if (!x) return partial();
      if (x.length < 1) break;
      if (x[0] === 0xf9 && frames === 0 && b8(x, 1) === 4) transparent = (b8(x, 2) & 1) === 1;
      const next = yield* skipGifBlocks(pos + 2);
      if (next === -1) return partial();
      if (next < 0) break;
      pos = next;
    } else if (t[0] === 0x2c) {
      frames++;
      if (frames === 1) alpha = transparent;
      else return { format: 'gif', width, height, animated: true, alpha: alpha ?? false };
      const d = yield [pos, 10];
      if (!d) return partial();
      if (d.length < 10) break;
      const next = yield* skipGifBlocks(pos + 10 + gifTable(b8(d, 9)) + 1);
      if (next === -1) return partial();
      if (next < 0) break;
      pos = next;
    } else break;
  }
  if (!frames) return undefined;
  return { format: 'gif', width, height, animated: false, alpha: alpha ?? false };
}

/** Chunks of an extended WebP walked to its image data. */
const MAX_WEBP_CHUNKS = 64;

/** Width and height of a VP8 key frame or a VP8L image at `b[i]` (the chunk payload), with VP8L's alpha hint. */
export function webpBitstream(
  fcc: string,
  b: Uint8Array,
  i: number,
): { w: number; h: number; alpha: boolean } | undefined {
  if (fcc === 'VP8 ') {
    if ((b8(b, i) & 1) !== 0 || b8(b, i + 3) !== 0x9d || b8(b, i + 4) !== 0x01 || b8(b, i + 5) !== 0x2a)
      return undefined;
    const w = u16le(b, i + 6) & 0x3fff;
    const h = u16le(b, i + 8) & 0x3fff;
    return w && h ? { w, h, alpha: false } : undefined;
  }
  if (fcc === 'VP8L') {
    if (b8(b, i) !== 0x2f) return undefined;
    const bits = u32le(b, i + 1);
    if (bits >>> 29 !== 0) return undefined;
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1, alpha: ((bits >>> 28) & 1) === 1 };
  }
  return undefined;
}

function* scanWebp(): Scan {
  const h = yield [0, 30];
  if (!h || h.length < 25 || !ascii(h, 0, 'RIFF') || !ascii(h, 8, 'WEBP')) return undefined;
  const first = fourcc(h, 12);
  if (first === 'VP8 ' || first === 'VP8L') {
    if (h.length < (first === 'VP8 ' ? 30 : 25)) return undefined;
    const s = webpBitstream(first, h, 20);
    return s ? { format: 'webp', width: s.w, height: s.h, animated: false, alpha: s.alpha } : undefined;
  }
  if (first !== 'VP8X' || h.length < 30 || u32le(h, 16) < 10) return undefined;
  const flags = b8(h, 20);
  const width = u24le(h, 24) + 1;
  const height = u24le(h, 27) + 1;
  const alpha = (flags & 0x10) !== 0;
  if (flags & 0x02) return { format: 'webp', width, height, animated: true, alpha };
  // EXIF metadata (its chunk follows the image data): browsers may turn the picture by it.
  const exif = (flags & 0x08) !== 0 ? { convert: true } : {};
  // A still extended WebP: its image data must agree with the canvas the header claims.
  let pos = 20 + u32le(h, 16) + (u32le(h, 16) & 1);
  for (let i = 0; i < MAX_WEBP_CHUNKS; i++) {
    const c = yield [pos, 18];
    if (!c) return { format: 'webp', width, height, animated: false, alpha, partial: true };
    if (c.length < 8) return undefined;
    const fcc = fourcc(c, 0);
    const size = u32le(c, 4);
    if (fcc === 'ANIM' || fcc === 'ANMF') return undefined; // frames the header does not announce
    if (fcc === 'VP8 ' || fcc === 'VP8L') {
      const s = webpBitstream(fcc, c, 8);
      if (!s || s.w !== width || s.h !== height) return undefined;
      return { format: 'webp', width, height, animated: false, alpha: alpha || s.alpha, ...exif };
    }
    pos += 8 + size + (size & 1);
  }
  return undefined;
}

function* scanBmp(): Scan {
  const h = yield [0, 58];
  if (!h || h.length < 26 || !ascii(h, 0, 'BM')) return undefined;
  const dib = u32le(h, 14);
  let width: number;
  let height: number;
  let bpp: number;
  let alpha = false;
  if (dib === 12) {
    width = u16le(h, 18);
    height = u16le(h, 20);
    bpp = u16le(h, 24);
  } else if (dib >= 40 && dib <= 124 && h.length >= 34) {
    width = i32le(h, 18);
    height = Math.abs(i32le(h, 22));
    if (u16le(h, 26) !== 1) return undefined;
    bpp = u16le(h, 28);
    const compression = u32le(h, 30);
    // Only a declared alpha mask (BITFIELDS with a V3+ header, or ALPHABITFIELDS) makes the 4th byte alpha.
    if (bpp === 32 && (compression === 3 || compression === 6) && dib >= 56 && h.length >= 58)
      alpha = u32le(h, 54) !== 0;
  } else return undefined;
  if (width <= 0 || height <= 0 || ![1, 4, 8, 16, 24, 32].includes(bpp)) return undefined;
  return { format: 'bmp', width, height, animated: false, alpha };
}

function* scanTiff(): Scan {
  const h = yield [0, 8];
  if (!h || h.length < 8) return undefined;
  const le = ascii(h, 0, 'II');
  const r16 = le ? u16le : u16be;
  const r32 = le ? u32le : u32be;
  if (r16(h, 2) !== 42) return undefined; // BigTIFF (43) is not decoded
  const ifd = r32(h, 4);
  if (ifd < 8) return undefined;
  const c = yield [ifd, 2];
  if (!c) return { format: 'tiff', width: 0, height: 0, animated: false, partial: true };
  const n = c.length < 2 ? 0 : r16(c, 0);
  if (n === 0 || n > 4_096) return undefined;
  const e = yield [ifd + 2, n * 12 + 4];
  if (!e) return { format: 'tiff', width: 0, height: 0, animated: false, partial: true };
  if (e.length < n * 12) return undefined;
  let width = 0;
  let height = 0;
  let alpha = false;
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    const tag = r16(e, o);
    const type = r16(e, o + 2);
    const value = type === 3 ? r16(e, o + 8) : type === 4 ? r32(e, o + 8) : 0;
    if (tag === 256) width = value;
    else if (tag === 257) height = value;
    else if (tag === 338) alpha = r32(e, o + 4) > 1 || value === 1 || value === 2;
  }
  if (!width || !height) return undefined;
  const next = e.length >= n * 12 + 4 ? r32(e, n * 12) : 0;
  return { format: 'tiff', width, height, animated: next !== 0, alpha };
}

/** EMF (EMR_HEADER with the ' EMF' signature) or WMF (placeable or standard header). */
function* scanMetafile(): Scan {
  const h = yield [0, 44];
  if (!h) return undefined;
  if (u32le(h, 0) === 1 && ascii(h, 40, ' EMF')) {
    const w = i32le(h, 16) - i32le(h, 8);
    const ht = i32le(h, 20) - i32le(h, 12);
    const fit = (v: number) => (v > 0 && v < 1_000_000 ? v + 1 : 0);
    return { format: 'emf', width: fit(w), height: fit(ht), animated: false };
  }
  if (u32le(h, 0) === 0x9ac6cdd7 && h.length >= 22) {
    const inch = u16le(h, 14) || 1440;
    const w = Math.round((Math.abs(i16le(h, 10) - i16le(h, 6)) * 96) / inch);
    const ht = Math.round((Math.abs(i16le(h, 12) - i16le(h, 8)) * 96) / inch);
    return { format: 'wmf', width: w, height: ht, animated: false };
  }
  const type = u16le(h, 0);
  const version = u16le(h, 4);
  if (
    h.length >= 18 &&
    (type === 1 || type === 2) &&
    u16le(h, 2) === 9 &&
    (version === 0x300 || version === 0x100)
  )
    return { format: 'wmf', width: 0, height: 0, animated: false };
  return undefined;
}

/** An SVG document: markup (after a BOM and blanks) with an `<svg` element near the start. */
function* scanSvg(): Scan {
  const h = (yield [0, 4096]) ?? (yield [0, 1024]) ?? (yield [0, 256]);
  if (!h) return undefined;
  let text = Buffer.from(h).toString('latin1');
  if (text.startsWith('\xef\xbb\xbf')) text = text.slice(3);
  text = text.trimStart();
  if (!text.startsWith('<') || !/<svg[\s>/]/.test(text)) return undefined;
  return { format: 'svg', width: 0, height: 0, animated: false };
}

export function* scanPicture(): Scan {
  const m = yield [0, 12];
  if (!m || m.length < 2) return undefined;
  if (m.length >= 8 && u32be(m, 0) === 0x89504e47 && u32be(m, 4) === 0x0d0a1a0a) return yield* scanPng();
  if (m[0] === 0xff && m[1] === 0xd8 && m[2] === 0xff) return yield* scanJpeg();
  if (ascii(m, 0, 'GIF8')) return yield* scanGif();
  if (ascii(m, 0, 'RIFF') && ascii(m, 8, 'WEBP')) return yield* scanWebp();
  if (ascii(m, 0, 'II*\0') || ascii(m, 0, 'MM\0*')) return yield* scanTiff();
  if (ascii(m, 0, 'BM')) return yield* scanBmp();
  return (yield* scanMetafile()) ?? (yield* scanSvg());
}

/**
 * Read a picture header from its first bytes; undefined when it is not a picture ordo accepts. What lies
 * past `head` is unknown, so a result that needed it is `partial`, unless `complete` says `head` is the
 * whole file (`readPictureHeader` reads a file).
 */
export function pictureHeader(
  head: Uint8Array,
  opts: { complete?: boolean } = {},
): PictureHeader | undefined {
  const scan = scanPicture();
  let step = scan.next();
  while (!step.done) {
    const [pos, n] = step.value;
    const known = pos >= 0 && (opts.complete ? pos <= head.length : pos + n <= head.length);
    step = scan.next(known ? head.subarray(pos, pos + n) : undefined);
  }
  return step.value;
}

export function clearExifOrientation(bytes: Uint8Array, header: PictureHeader): Uint8Array {
  if (!header.orientation || header.orientationAt === undefined) return bytes;
  const copy = bytes.slice();
  const at = header.orientationAt;
  if (at + 1 >= copy.length) return bytes;
  const isBE = copy[at] === 0;
  copy[at] = isBE ? 0 : 1;
  copy[at + 1] = isBE ? 1 : 0;
  return copy;
}

// ── Display needs ────────────────────────────────────────────────────────────────────────────────────────

/** A need within [minNeed, side] px; anything not a number is the widest. */
export function clampNeed(px: number): number {
  if (!Number.isFinite(px)) return PICTURE_LIMITS.side;
  return Math.min(PICTURE_LIMITS.side, Math.max(PICTURE_LIMITS.minNeed, Math.ceil(px)));
}

/** A share kept by a crop, finite and positive (a crop that leaves nothing needs the widest picture). */
function keptShare(a: number | undefined, b: number | undefined): number {
  const share = 1 - (Number.isFinite(a) ? a! : 0) - (Number.isFinite(b) ? b! : 0);
  return Math.max(share, 1e-4);
}

export type PixelSize = { w: number; h: number };

/** The width the whole picture is drawn at, in output px, for one use in a box. */
function boxNeed(
  box: { w: number; h: number },
  fit: 'contain' | 'cover' | 'stretch',
  crop: { l: number; t: number; r: number; b: number } | undefined,
  size: PixelSize | undefined,
): number {
  const k = PICTURE_LIMITS.displayWidth / LOGICAL_WIDTH;
  const bw = Math.abs(box.w) * k;
  const bh = Math.abs(box.h) * k;
  const cw = keptShare(crop?.l, crop?.r);
  const ch = keptShare(crop?.t, crop?.b);
  if (!size || !(size.w > 0 && size.h > 0)) return bw / cw;
  // The visible part of the picture in its own pixels, and the scale it is drawn at (renderer drawImageFit).
  const sw = cw * size.w;
  const sh = ch * size.h;
  let sx = bw / sw;
  let sy = bh / sh;
  if (fit !== 'stretch') sx = sy = fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  // A prepared picture keeps its aspect: the larger scale decides.
  return size.w * Math.max(sx, sy);
}

/**
 * The display need in px of every picture part the slides use (`media` maps their placeholder ids to parts,
 * `EmitResult.media`): its widest box at `displayWidth` ÷ the visible crop fraction, capped at `side`. A
 * slide background counts as the whole frame, cover-fit. With `sizeOf` (the parts' pixel sizes, as given to
 * the converter), the box height counts too, for pictures drawn stretched taller than their aspect and for
 * contain/cover fits.
 */
export function displayNeeds(
  slides: readonly Slide[],
  media: readonly { id: string; part: string }[],
  sizeOf?: (part: string) => PixelSize | undefined,
): Map<string, number> {
  const partOf = new Map<string, string>();
  for (const m of media) partOf.set(m.id, m.part);
  const needs = new Map<string, number>();
  const use = (part: string, px: number) => {
    const n = clampNeed(px);
    if (n > (needs.get(part) ?? 0)) needs.set(part, n);
  };
  for (const s of slides) {
    for (const o of s.objects ?? []) {
      if (o.type !== 'image') continue;
      const part = partOf.get(o.mediaId);
      if (part !== undefined) use(part, boxNeed(o.box, o.fit, o.crop, sizeOf?.(part)));
    }
    const bg = s.backgroundMediaId === undefined ? undefined : partOf.get(s.backgroundMediaId);
    if (bg !== undefined)
      use(bg, boxNeed({ w: LOGICAL_WIDTH, h: LOGICAL_HEIGHT }, 'cover', undefined, sizeOf?.(bg)));
  }
  return needs;
}
