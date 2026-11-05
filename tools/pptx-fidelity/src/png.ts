import { deflateSync } from 'node:zlib';

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

/** An RGBA PNG from a pixel function (test pictures for the corpus; no image library needed). */
export function png(
  w: number,
  h: number,
  px: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** A colourful test picture: a diagonal gradient, a grid, and a disc (so crops and fits are visible). */
export function testPicture(w: number, h: number, hue = 0): Buffer {
  return png(w, h, (x, y) => {
    const u = x / w;
    const v = y / h;
    const grid = x % 40 < 2 || y % 40 < 2;
    const dx = u - 0.5;
    const dy = v - 0.5;
    const disc = dx * dx + dy * dy < 0.06;
    const r = Math.round(255 * ((u + hue) % 1));
    const g = Math.round(255 * v);
    const b = Math.round(255 * (1 - u));
    if (grid) return [255, 255, 255, 255];
    if (disc) return [250, 200, 40, 255];
    return [r, g, b, 255];
  });
}

export function dataUri(b: Buffer): string {
  return `image/png;base64,${b.toString('base64')}`;
}
