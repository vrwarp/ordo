import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { compositeOverPlate, decodePng, encodePng, hasTransparency, makePng } from './png.ts';
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

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function encodeWithCustomFilter(img: RgbaImage, filterType: number): Buffer {
  const { width: w, height: h, data } = img;
  const rowBytes = w * 4;
  const filtered = Buffer.alloc((rowBytes + 1) * h);

  const prevRow = new Uint8Array(rowBytes);

  for (let y = 0; y < h; y++) {
    const curRow = data.subarray(y * rowBytes, (y + 1) * rowBytes);
    const rowStart = y * (rowBytes + 1);
    filtered[rowStart] = filterType;

    for (let i = 0; i < rowBytes; i++) {
      const x = curRow[i]!;
      const a = i >= 4 ? curRow[i - 4]! : 0;
      const b = prevRow[i]!;
      const c = i >= 4 ? prevRow[i - 4]! : 0;

      let val = x;
      if (filterType === 1) val = (x - a) & 0xff;
      else if (filterType === 2) val = (x - b) & 0xff;
      else if (filterType === 3) val = (x - ((a + b) >>> 1)) & 0xff;
      else if (filterType === 4) val = (x - paethPredictor(a, b, c)) & 0xff;

      filtered[rowStart + 1 + i] = val;
    }
    prevRow.set(curRow);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered)),
    chunk('IEND', new Uint8Array()),
  ]);
}

describe('encodePng and decodePng', () => {
  it('roundtrips RGBA image cleanly', () => {
    const orig = makePng(16, 16, (x, y) => [x * 16, y * 16, (x + y) * 8, 255]);
    const encoded = encodePng(orig);
    const decoded = decodePng(encoded);

    expect(decoded.width).toBe(16);
    expect(decoded.height).toBe(16);
    expect(decoded.data).toEqual(orig.data);
  });

  it('correctly decodes scanlines with Sub filter (filter 1)', () => {
    const orig = makePng(8, 8, (x, y) => [(x * 30) % 256, (y * 40) % 256, 120, 255]);
    const pngBuf = encodeWithCustomFilter(orig, 1);
    const decoded = decodePng(pngBuf);
    expect(decoded.data).toEqual(orig.data);
  });

  it('correctly decodes scanlines with Up filter (filter 2)', () => {
    const orig = makePng(8, 8, (x, y) => [(x * 25) % 256, (y * 35) % 256, 200, 255]);
    const pngBuf = encodeWithCustomFilter(orig, 2);
    const decoded = decodePng(pngBuf);
    expect(decoded.data).toEqual(orig.data);
  });

  it('correctly decodes scanlines with Average filter (filter 3)', () => {
    const orig = makePng(8, 8, (x, y) => [(x * 17) % 256, (y * 23) % 256, 75, 255]);
    const pngBuf = encodeWithCustomFilter(orig, 3);
    const decoded = decodePng(pngBuf);
    expect(decoded.data).toEqual(orig.data);
  });

  it('correctly decodes scanlines with Paeth filter (filter 4)', () => {
    const orig = makePng(8, 8, (x, y) => [(x * 19) % 256, (y * 29) % 256, 99, 255]);
    const pngBuf = encodeWithCustomFilter(orig, 4);
    const decoded = decodePng(pngBuf);
    expect(decoded.data).toEqual(orig.data);
  });
});

describe('compositeOverPlate', () => {
  it('leaves fully opaque pixels unchanged over any plate', () => {
    const img = makePng(2, 2, () => [120, 130, 140, 255]);
    const compBlack = compositeOverPlate(img, [0, 0, 0]);
    const compWhite = compositeOverPlate(img, [255, 255, 255]);

    expect(compBlack.data[0]).toBe(120);
    expect(compBlack.data[1]).toBe(130);
    expect(compBlack.data[2]).toBe(140);
    expect(compBlack.data[3]).toBe(255);

    expect(compWhite.data[0]).toBe(120);
    expect(compWhite.data[1]).toBe(130);
    expect(compWhite.data[2]).toBe(140);
    expect(compWhite.data[3]).toBe(255);
  });

  it('replaces fully transparent pixels with plate color', () => {
    const img = makePng(2, 2, () => [0, 0, 0, 0]);
    const compBlack = compositeOverPlate(img, [0, 0, 0]);
    const compWhite = compositeOverPlate(img, [255, 255, 255]);

    expect(compBlack.data[0]).toBe(0);
    expect(compBlack.data[1]).toBe(0);
    expect(compBlack.data[2]).toBe(0);
    expect(compBlack.data[3]).toBe(255);

    expect(compWhite.data[0]).toBe(255);
    expect(compWhite.data[1]).toBe(255);
    expect(compWhite.data[2]).toBe(255);
    expect(compWhite.data[3]).toBe(255);
  });

  it('properly blends semi-transparent pixels', () => {
    // 50% alpha (a=128): [255, 0, 0, 128]
    const img = makePng(1, 1, () => [255, 0, 0, 128]);
    const compWhite = compositeOverPlate(img, [255, 255, 255]);

    // Red: round((255*128 + 255*127)/255) = 255
    // Green: round((0*128 + 255*127)/255) = round(32385/255) = 127
    // Blue: round((0*128 + 255*127)/255) = 127
    expect(compWhite.data[0]).toBe(255);
    expect(compWhite.data[1]).toBe(127);
    expect(compWhite.data[2]).toBe(127);
    expect(compWhite.data[3]).toBe(255);
  });
});

describe('hasTransparency', () => {
  it('returns false for fully opaque image', () => {
    const img = makePng(4, 4, () => [10, 20, 30, 255]);
    expect(hasTransparency(img)).toBe(false);
  });

  it('returns true if any pixel has alpha < 255', () => {
    const img = makePng(4, 4, (x, y) => [10, 20, 30, x === 2 && y === 2 ? 254 : 255]);
    expect(hasTransparency(img)).toBe(true);
  });
});
