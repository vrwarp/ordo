import { describe, expect, it } from 'vitest';
import { OpaqueFiles, opaqueImage } from './opaque.ts';

/** Image headers: which files decode without transparency (design/27 §7.1 opaque-first, M7). */

function chunk(type: string, data: number[] = []): number[] {
  const n = data.length;
  return [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

function png(colourType: number, chunks: number[][] = [chunk('IDAT', [1, 2, 3])]): Uint8Array {
  const ihdr = chunk('IHDR', [0, 0, 1, 0, 0, 0, 0, 200, 8, colourType, 0, 0, 0]);
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...chunks.flat()]);
}

describe('opaqueImage', () => {
  it('takes JPEG as opaque', () => {
    expect(opaqueImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0]))).toBe(true);
  });

  it('takes greyscale, truecolour and palette PNG without tRNS as opaque', () => {
    for (const t of [0, 2, 3]) expect(opaqueImage(png(t))).toBe(true);
    expect(
      opaqueImage(
        png(2, [chunk('gAMA', [0, 0, 0, 1]), chunk('iCCP', new Array(300).fill(7)), chunk('IDAT')]),
      ),
    ).toBe(true);
  });

  it('takes PNG with an alpha channel or a tRNS chunk as transparent', () => {
    expect(opaqueImage(png(6))).toBe(false);
    expect(opaqueImage(png(4))).toBe(false);
    expect(opaqueImage(png(3, [chunk('PLTE', [0, 0, 0]), chunk('tRNS', [0]), chunk('IDAT')]))).toBe(false);
    expect(opaqueImage(png(2, [chunk('tRNS', [0, 0, 0, 0, 0, 0]), chunk('IDAT')]))).toBe(false);
  });

  it('takes anything undecided as transparent: a cut header, WebP, GIF, nothing', () => {
    expect(opaqueImage(png(2).slice(0, 40))).toBe(false);
    expect(opaqueImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe(false);
    expect(opaqueImage(new TextEncoder().encode('GIF89a'))).toBe(false);
    expect(opaqueImage(new Uint8Array(0))).toBe(false);
  });
});

describe('OpaqueFiles', () => {
  const blob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>]);

  it('notes files by hash, keeps a bounded number and fails closed', async () => {
    const f = new OpaqueFiles(2);
    await f.note('a', blob(new Uint8Array([0xff, 0xd8, 0xff])));
    await f.note('b', blob(png(6)));
    expect([f.opaque('a'), f.opaque('b'), f.opaque('never')]).toEqual([true, false, false]);
    await f.note('c', blob(png(2)));
    expect(f.opaque('a')).toBe(false); // dropped: the oldest of three
    expect(f.opaque('c')).toBe(true);
    await f.note('d', {
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error('gone')) }),
    } as unknown as Blob);
    expect(f.opaque('d')).toBe(false);
  });
});
