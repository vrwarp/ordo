import { readFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import type { RgbaImage } from './types.ts';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit RGB, RGBA, Grayscale, or Grayscale+Alpha non-interlaced PNG into straight RGBA. */
export function decodePng(buf: Uint8Array): RgbaImage {
  if (buf.length < 33) throw new Error('PNG buffer too short');
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIG[i]) throw new Error('Invalid PNG signature');
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idats: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = view.getUint32(pos, false);
    const type = Buffer.from(buf.subarray(pos + 4, pos + 8)).toString('ascii');
    const start = pos + 8;
    const end = start + len;
    if (end + 4 > buf.length) break;
    if (type === 'IHDR') {
      width = view.getUint32(start, false);
      height = view.getUint32(start + 4, false);
      bitDepth = buf[start + 8]!;
      colorType = buf[start + 9]!;
      interlace = buf[start + 12]!;
    } else if (type === 'IDAT') {
      idats.push(buf.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    pos = end + 4;
  }
  if (!width || !height) throw new Error('Missing PNG IHDR');
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG bitDepth=${bitDepth} interlace=${interlace}`);
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (!bpp) throw new Error(`Unsupported PNG colorType=${colorType}`);

  const raw = inflateSync(Buffer.concat(idats));
  const rowBytes = width * bpp;
  const stride = rowBytes + 1;
  if (raw.length < stride * height) throw new Error('Truncated PNG IDAT stream');

  const cur = new Uint8Array(rowBytes);
  const prev = new Uint8Array(rowBytes);
  const out = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride]!;
    const srcOff = y * stride + 1;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[srcOff + i]!;
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = x;
      if (filter === 1) v = (x + a) & 0xff;
      else if (filter === 2) v = (x + b) & 0xff;
      else if (filter === 3) v = (x + ((a + b) >>> 1)) & 0xff;
      else if (filter === 4) v = (x + paeth(a, b, c)) & 0xff;
      cur[i] = v;
    }
    const dstRow = y * width * 4;
    if (colorType === 6) {
      out.set(cur, dstRow);
    } else if (colorType === 2) {
      for (let x = 0; x < width; x++) {
        const si = x * 3;
        const di = dstRow + x * 4;
        out[di] = cur[si]!;
        out[di + 1] = cur[si + 1]!;
        out[di + 2] = cur[si + 2]!;
        out[di + 3] = 255;
      }
    } else if (colorType === 4) {
      for (let x = 0; x < width; x++) {
        const g = cur[x * 2]!;
        const di = dstRow + x * 4;
        out[di] = g;
        out[di + 1] = g;
        out[di + 2] = g;
        out[di + 3] = cur[x * 2 + 1]!;
      }
    } else {
      for (let x = 0; x < width; x++) {
        const g = cur[x]!;
        const di = dstRow + x * 4;
        out[di] = g;
        out[di + 1] = g;
        out[di + 2] = g;
        out[di + 3] = 255;
      }
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

export async function readPng(filePath: string): Promise<RgbaImage> {
  return decodePng(await readFile(filePath));
}

export function encodePng(img: RgbaImage): Buffer {
  const { width: w, height: h, data } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 3 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

export function makePng(
  width: number,
  height: number,
  px: (x: number, y: number) => [number, number, number, number],
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = px(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { width, height, data };
}

/** Composite straight-alpha RGBA image over an opaque RGB plate `[pr, pg, pb]`. */
export function compositeOverPlate(img: RgbaImage, plate: [number, number, number]): RgbaImage {
  const { width, height, data } = img;
  const out = new Uint8Array(data.length);
  const [pr, pg, pb] = plate;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 255) {
      out[i] = data[i]!;
      out[i + 1] = data[i + 1]!;
      out[i + 2] = data[i + 2]!;
    } else if (a === 0) {
      out[i] = pr;
      out[i + 1] = pg;
      out[i + 2] = pb;
    } else {
      const inv = 255 - a;
      out[i] = Math.round((data[i]! * a + pr * inv) / 255);
      out[i + 1] = Math.round((data[i + 1]! * a + pg * inv) / 255);
      out[i + 2] = Math.round((data[i + 2]! * a + pb * inv) / 255);
    }
    out[i + 3] = 255;
  }
  return { width, height, data: out };
}

/** True when any pixel has alpha < 255. */
export function hasTransparency(img: RgbaImage): boolean {
  const { data } = img;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < 255) return true;
  }
  return false;
}
