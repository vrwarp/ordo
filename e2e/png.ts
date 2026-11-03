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
