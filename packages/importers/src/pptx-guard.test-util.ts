/**
 * A deck past the slide budgets' picture guard (M9, `lo-forms`): one slide of `n` distinct pictures, more than
 * the render clamp's 16, for an import that stores no picture sheets (`PPTX_SHEETS`). Each picture a small
 * real PNG of its own colour, so every import step reads it.
 */
import { deflateSync } from 'node:zlib';
import { buildDeck, imageRel, pic } from '@ordo/pptx-scene/test-util.ts';

const IN = 914_400;

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const v of b) c = CRC[(c ^ v) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An opaque `w` x `h` PNG of one colour. */
export function solidPng(w: number, h: number, rgb: readonly [number, number, number]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = new Uint8Array(h * (1 + 3 * w));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set(rgb, y * (1 + 3 * w) + 1 + 3 * x);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(rows))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One slide of `n` distinct one-inch pictures (ids 2..n+1, the last topmost), each its own colour. */
export function pictureGuardDeck(n = 20) {
  let shapes = '';
  const media: Record<string, Uint8Array> = {};
  for (let i = 0; i < n; i++) {
    shapes += pic({
      id: 2 + i,
      x: (i % 6) * 1.6 * IN,
      y: Math.floor(i / 6) * IN,
      cx: IN,
      cy: IN,
      rId: `rId${2 + i}`,
    });
    media[`ppt/media/p${i}.png`] = solidPng(8, 8, [(i * 37) % 256, (i * 91) % 256, (i * 53) % 256]);
  }
  const rels = Array.from({ length: n }, (_, i) => imageRel(`rId${2 + i}`, `../media/p${i}.png`));
  return buildDeck({ slides: [{ rels, shapes }], media });
}
