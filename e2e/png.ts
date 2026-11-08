import { inflateSync } from 'node:zlib';

/** Minimal PNG decoder for the first pixel of an 8-bit RGB/RGBA screenshot. */
export const PNG = {
  firstPixel(buf: Buffer): { r: number; g: number; b: number } {
    let off = 8;
    let width = 0;
    let colorType = 6;
    const idat: Buffer[] = [];
    while (off < buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        colorType = data[9]!;
      } else if (type === 'IDAT') idat.push(data);
      off += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const bpp = colorType === 6 ? 4 : 3;
    void width;
    // First scanline: filter byte then pixels; filters other than None/Sub/Up on pixel 0 reduce to raw values.
    return { r: raw[1]!, g: raw[2]!, b: raw[3]! + 0 * bpp };
  },
};

/** An 8-bit RGB or RGBA PNG decoded to RGBA (every scanline filter; no interlace, no palette). */
export type Pixels = { width: number; height: number; data: Uint8Array };

export function decodePng(buf: Buffer): Pixels {
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('decodePng: 8-bit, non-interlaced PNGs only');
      colorType = data[9]!;
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (colorType !== 2 && colorType !== 6) throw new Error(`decodePng: colour type ${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at]!;
    for (let i = 0; i < stride; i++) {
      const x = raw[at + 1 + i]!;
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = (x + p) & 255;
    }
    for (let px = 0; px < width; px++) {
      const o = (y * width + px) * 4;
      out[o] = cur[px * bpp]!;
      out[o + 1] = cur[px * bpp + 1]!;
      out[o + 2] = cur[px * bpp + 2]!;
      out[o + 3] = bpp === 4 ? cur[px * bpp + 3]! : 255;
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}
