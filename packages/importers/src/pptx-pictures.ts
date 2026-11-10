/**
 * Picture header scanning and display needs calculation.
 * Pure TypeScript: runs in Node.js, browsers, and Web Workers alike.
 */
import { LOGICAL_HEIGHT, LOGICAL_WIDTH, type Slide } from '@ordo/domain';

export type PictureHeader = {
  format: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'svg' | 'emf' | 'wmf' | 'other';
  width: number;
  height: number;
  animated: boolean;
  alpha?: boolean;
  orientation?: number;
  orientationAt?: number;
  partial?: boolean;
  convert?: boolean;
};

export const METAFILE_FORMATS: ReadonlySet<PictureHeader['format']> = new Set(['svg', 'emf', 'wmf']);

export function isMetafile(h: PictureHeader): boolean {
  return METAFILE_FORMATS.has(h.format);
}

export const PICTURE_LIMITS = {
  side: 8_192,
  megapixels: 40,
  displayWidth: 3_840,
  downscaleOver: 1.25,
  minNeed: 128,
  sourceSide: 16_384,
  sourceMegapixels: 100,
  importMegapixels: 6_000,
  animatedBytes: 64 * 1024 * 1024,
  scanBytes: 16 * 1024 * 1024,
  slackBytes: 1024 * 1024,
  maxBytes: 64 * 1024 * 1024,
} as const;

type Scan = Generator<readonly [number, number], PictureHeader | undefined, Uint8Array | undefined>;

const b8 = (b: Uint8Array, i: number): number => b[i] ?? 0;
const u16le = (b: Uint8Array, i: number): number => b8(b, i) | (b8(b, i + 1) << 8);
const u16be = (b: Uint8Array, i: number): number => (b8(b, i) << 8) | b8(b, i + 1);
const u24le = (b: Uint8Array, i: number): number => u16le(b, i) | (b8(b, i + 2) << 16);
const u32le = (b: Uint8Array, i: number): number => u24le(b, i) + b8(b, i + 3) * 0x1000000;
const u32be = (b: Uint8Array, i: number): number =>
  b8(b, i) * 0x1000000 + ((b8(b, i + 1) << 16) | (b8(b, i + 2) << 8) | b8(b, i + 3));
const i32le = (b: Uint8Array, i: number): number => u32le(b, i) | 0;
const i16le = (b: Uint8Array, i: number): number => (u16le(b, i) << 16) >> 16;
const ascii = (b: Uint8Array, i: number, s: string): boolean =>
  b.length >= i + s.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
const fourcc = (b: Uint8Array, i: number): string =>
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

const PNG_DEPTHS: { readonly [ct: number]: readonly number[] } = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
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

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const MAX_JPEG_SEGMENTS = 4_096;

export function exifOrientation(seg: Uint8Array): number | undefined {
  return exifOrientationEntry(seg)?.value;
}

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
      pos += 1;
      continue;
    }
    if (mk === 0x00 || (mk >= 0xd0 && mk <= 0xd7) || mk === 0x01) {
      pos += 2;
      continue;
    }
    if (mk === 0xd9 || mk === 0xda) return undefined;
    if (m.length < 4) return undefined;
    const len = u16be(m, 2);
    if (len < 2) return undefined;
    if (SOF.has(mk)) {
      const f = yield [pos + 4, 6];
      if (!f || f.length < 6) return undefined;
      const precision = b8(f, 0);
      const height = u16be(f, 1);
      const width = u16be(f, 3);
      const convert = precision !== 8 || mk === 0xc3 || mk === 0xc7 || mk === 0xcb || mk === 0xcf;
      return {
        format: 'jpeg',
        width,
        height,
        animated: false,
        alpha: false,
        ...(convert ? { convert: true } : {}),
        ...(orientation && orientation.value !== 1
          ? { orientation: orientation.value, orientationAt: orientation.at }
          : {}),
      };
    }
    if (mk === 0xe1 && orientation === undefined && len > 8) {
      const seg = yield [pos + 4, Math.min(len - 2, 64 * 1024)];
      if (seg) {
        const o = exifOrientationEntry(seg);
        orientation = o ? { value: o.value, at: pos + 4 + o.at } : { value: 1, at: 0 };
      }
    }
    pos += 2 + len;
  }
  return undefined;
}

const gifTable = (fields: number): number => ((fields & 0x80) !== 0 ? 3 * (1 << ((fields & 7) + 1)) : 0);

function* skipGifBlocks(start: number): Generator<readonly [number, number], number, Uint8Array | undefined> {
  let pos = start;
  for (let i = 0; i < 4096; i++) {
    const b = yield [pos, 1];
    if (!b || !b.length) return -1;
    const len = b[0]!;
    if (len === 0) return pos + 1;
    pos += 1 + len;
  }
  return -2;
}

function* scanGif(): Scan {
  const h = yield [0, 13];
  if (!h || h.length < 13 || !ascii(h, 0, 'GIF8') || (h[4] !== 0x37 && h[4] !== 0x39) || h[5] !== 0x61)
    return undefined;
  const width = u16le(h, 6);
  const height = u16le(h, 8);
  if (!width || !height) return undefined;
  let pos = 13 + gifTable(b8(h, 10));
  let frames = 0;
  let alpha: boolean | undefined;
  const partial = (): PictureHeader => ({
    format: 'gif',
    width,
    height,
    animated: frames > 1,
    alpha: alpha ?? false,
    partial: true,
  });
  for (let i = 0; i < 4096; i++) {
    const intro = yield [pos, 1];
    if (!intro || !intro.length) return frames ? partial() : undefined;
    const b = intro[0]!;
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = yield [pos + 1, 1];
      if (!label || !label.length) return partial();
      if (label[0] === 0xf9) {
        const gce = yield [pos + 2, 6];
        if (gce && gce.length >= 6 && gce[0] === 4 && (gce[1]! & 1) !== 0) alpha = true;
      }
      const next = yield* skipGifBlocks(pos + 2);
      if (next === -1) return partial();
      if (next < 0) break;
      pos = next;
    } else if (b === 0x2c) {
      frames++;
      if (frames > 1) return { format: 'gif', width, height, animated: true, alpha: alpha ?? false };
      const d = yield [pos, 10];
      if (!d || d.length < 10) return partial();
      const next = yield* skipGifBlocks(pos + 10 + gifTable(b8(d, 9)) + 1);
      if (next === -1) return partial();
      if (next < 0) break;
      pos = next;
    } else break;
  }
  if (!frames) return undefined;
  return { format: 'gif', width, height, animated: false, alpha: alpha ?? false };
}

function webpBitstream(
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
  const exif = (flags & 0x08) !== 0 ? { convert: true } : {};
  let pos = 20 + u32le(h, 16) + (u32le(h, 16) & 1);
  for (let i = 0; i < 64; i++) {
    const c = yield [pos, 18];
    if (!c) return { format: 'webp', width, height, animated: false, alpha, partial: true };
    if (c.length < 8) return undefined;
    const fcc = fourcc(c, 0);
    const size = u32le(c, 4);
    if (fcc === 'ANIM' || fcc === 'ANMF') return undefined;
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
  } else if (dib >= 40) {
    if (h.length < 30) return undefined;
    width = Math.abs(i32le(h, 18));
    height = Math.abs(i32le(h, 22));
    bpp = u16le(h, 28);
    if (dib >= 56 && bpp === 32) alpha = true;
  } else return undefined;
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) return undefined;
  return { format: 'bmp', width, height, animated: false, alpha };
}

function* scanTiff(): Scan {
  const h = yield [0, 8];
  if (!h || h.length < 8) return undefined;
  const le = ascii(h, 0, 'II*\0');
  if (!le && !ascii(h, 0, 'MM\0*')) return undefined;
  const r16 = le ? u16le : u16be;
  const r32 = le ? u32le : u32be;
  const ifd0 = r32(h, 4);
  if (ifd0 < 8) return undefined;
  let pos = ifd0;
  let pages = 0;
  let width = 0;
  let height = 0;
  for (let p = 0; p < 16; p++) {
    const c = yield [pos, 2];
    if (!c || c.length < 2) break;
    const n = r16(c, 0);
    const dir = yield [pos + 2, n * 12 + 4];
    if (!dir || dir.length < n * 12 + 4) break;
    pages++;
    if (pages === 1) {
      for (let i = 0; i < n; i++) {
        const e = i * 12;
        const tag = r16(dir, e);
        const type = r16(dir, e + 2);
        const val = type === 3 ? r16(dir, e + 8) : type === 4 ? r32(dir, e + 8) : 0;
        if (tag === 256) width = val;
        if (tag === 257) height = val;
      }
    }
    const next = r32(dir, n * 12);
    if (!next) break;
    pos = next;
  }
  if (!width || !height) return undefined;
  return { format: 'tiff', width, height, animated: pages > 1 };
}

function* scanMetafile(): Scan {
  const h = yield [0, 88];
  if (!h || h.length < 44) return undefined;
  if (u32le(h, 0) === 1 && h.length >= 88 && u32le(h, 40) === 0x464d4520) {
    const left = i32le(h, 8);
    const top = i32le(h, 12);
    const right = i32le(h, 16);
    const bottom = i32le(h, 20);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    return { format: 'emf', width, height, animated: false };
  }
  if (u32le(h, 0) === 0x9ac6cdd7) {
    const left = i16le(h, 6);
    const top = i16le(h, 8);
    const right = i16le(h, 10);
    const bottom = i16le(h, 12);
    const inch = u16le(h, 14) || 96;
    const w = Math.round((Math.max(0, right - left) * 96) / inch);
    const hPx = Math.round((Math.max(0, bottom - top) * 96) / inch);
    return { format: 'wmf', width: w, height: hPx, animated: false };
  }
  if (u16le(h, 0) === 1 && u16le(h, 2) === 9) return { format: 'wmf', width: 0, height: 0, animated: false };
  return undefined;
}

function* scanSvg(): Scan {
  const h = (yield [0, 4096]) ?? (yield [0, 1024]) ?? (yield [0, 256]);
  if (!h) return undefined;
  let text = '';
  try {
    text = new TextDecoder('latin1').decode(h);
  } catch {
    text = String.fromCharCode(...h);
  }
  if (text.startsWith('\xef\xbb\xbf')) text = text.slice(3);
  text = text.trimStart();
  if (!text.startsWith('<') || !/<svg[\s>/]/.test(text)) return undefined;
  return { format: 'svg', width: 0, height: 0, animated: false };
}

function* scanPicture(): Scan {
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

function clampNeed(px: number): number {
  if (!Number.isFinite(px)) return PICTURE_LIMITS.side;
  return Math.min(PICTURE_LIMITS.side, Math.max(PICTURE_LIMITS.minNeed, Math.ceil(px)));
}

function keptShare(a: number | undefined, b: number | undefined): number {
  const share = 1 - (Number.isFinite(a) ? a! : 0) - (Number.isFinite(b) ? b! : 0);
  return Math.max(share, 1e-4);
}

type PixelSize = { w: number; h: number };

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
  const sw = cw * size.w;
  const sh = ch * size.h;
  let sx = bw / sw;
  let sy = bh / sh;
  if (fit !== 'stretch') sx = sy = fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  return size.w * Math.max(sx, sy);
}

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
