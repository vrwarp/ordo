import { describe, expect, it } from 'vitest';
import { blankFont, boxFont, registerBlankFace } from './blankface.ts';
import { shippedStack } from './coverage.ts';

/**
 * The coverage probe's blank face (design/27 §10): its bytes read back as the sfnt they claim to be, and
 * registering it waits for its load. That OTS accepts it and Chromium draws every code point with it as
 * nothing is checked in headless Chromium (coverage.fonts.browser.test.ts).
 */

type Tables = Map<string, DataView>;

/** The table directory of an sfnt, with each table's checksum checked against its bytes. */
function readSfnt(bytes: Uint8Array): Tables {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(v.getUint32(0)).toBe(0x00010000);
  const n = v.getUint16(4);
  const pow = 2 ** Math.floor(Math.log2(n));
  expect([v.getUint16(6), v.getUint16(8), v.getUint16(10)]).toEqual([
    pow * 16,
    Math.log2(pow),
    n * 16 - pow * 16,
  ]);
  const tables: Tables = new Map();
  let last = '';
  for (let i = 0; i < n; i++) {
    const at = 12 + 16 * i;
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    expect(tag > last, `${tag} after ${last}`).toBe(true);
    last = tag;
    const offset = v.getUint32(at + 8);
    const length = v.getUint32(at + 12);
    expect(offset % 4).toBe(0);
    expect(length).toBeGreaterThan(0);
    expect(offset + length).toBeLessThanOrEqual(bytes.length);
    const table = new Uint8Array(bytes.subarray(offset, offset + ((length + 3) & ~3)));
    if (tag === 'head') table.fill(0, 8, 12); // its checksum is taken with checkSumAdjustment at 0
    expect(sum(table), `${tag} checksum`).toBe(v.getUint32(at + 4));
    tables.set(tag, new DataView(bytes.buffer, bytes.byteOffset + offset, length));
  }
  return tables;
}

function sum(b: Uint8Array): number {
  const padded = new Uint8Array((b.length + 3) & ~3);
  padded.set(b);
  const v = new DataView(padded.buffer);
  let s = 0;
  for (let i = 0; i < padded.length; i += 4) s = (s + v.getUint32(i)) >>> 0;
  return s;
}

/** The format 13 groups of the (3, 10) cmap subtable. */
function cmapGroups(cmap: DataView): number[][] {
  expect(cmap.getUint16(2)).toBe(1);
  expect([cmap.getUint16(4), cmap.getUint16(6)]).toEqual([3, 10]);
  const sub = cmap.getUint32(8);
  expect(cmap.getUint16(sub)).toBe(13);
  const n = cmap.getUint32(sub + 12);
  expect(cmap.getUint32(sub + 4)).toBe(16 + 12 * n);
  return Array.from({ length: n }, (_, i) => [0, 4, 8].map((d) => cmap.getUint32(sub + 16 + 12 * i + d)));
}

describe('the blank face', () => {
  it('is an sfnt of the ten tables OTS requires for TrueType outlines, with valid checksums', () => {
    const bytes = blankFont();
    const t = readSfnt(bytes);
    expect([...t.keys()]).toEqual([
      'OS/2',
      'cmap',
      'glyf',
      'head',
      'hhea',
      'hmtx',
      'loca',
      'maxp',
      'name',
      'post',
    ]);
    expect(sum(bytes)).toBe(0xb1b0afba); // checkSumAdjustment makes the whole font sum to the magic value
    const head = t.get('head')!;
    expect(head.getUint32(12)).toBe(0x5f0f3cf5);
    expect(head.getUint16(18)).toBe(1000);
    expect(bytes.length).toBeLessThan(1024);
  });

  it('maps every code point, U+0000 to U+10FFFF, to one empty glyph of no advance', () => {
    const t = readSfnt(blankFont());
    expect(cmapGroups(t.get('cmap')!)).toEqual([[0, 0x10ffff, 1]]);
    expect(t.get('maxp')!.getUint16(4)).toBe(2);
    expect(t.get('hhea')!.getUint16(34)).toBe(2); // numberOfHMetrics
    const hmtx = t.get('hmtx')!;
    expect([hmtx.getUint16(0), hmtx.getUint16(4), hmtx.getInt16(6)]).toEqual([500, 0, 0]);
    // indexToLocFormat 1: long offsets. .notdef is a box (one contour); glyph 1 has no outline at all.
    expect(t.get('head')!.getInt16(50)).toBe(1);
    const loca = t.get('loca')!;
    const [o0, o1, o2] = [0, 4, 8].map((d) => loca.getUint32(d));
    expect(o1! - o0!).toBeGreaterThan(0);
    expect(t.get('glyf')!.getInt16(o0!)).toBe(1);
    expect(o2).toBe(o1);
  });

  it('builds faces of box glyphs for the tests, each code point range on its glyph', () => {
    const t = readSfnt(
      boxFont({
        family: 'Ordo Probe Serif',
        glyphs: [
          { advance: 500, box: [50, 0, 450, 700] },
          { advance: 1000, box: [100, -120, 900, 760] },
          { advance: 0 },
        ],
        ranges: [
          [0x0e01, 0x0e01, 1],
          [0x4e2d, 0x4e2d, 2],
        ],
      }),
    );
    expect(cmapGroups(t.get('cmap')!)).toEqual([
      [0x0e01, 0x0e01, 1],
      [0x4e2d, 0x4e2d, 2],
    ]);
    const head = t.get('head')!;
    expect([head.getInt16(36), head.getInt16(38), head.getInt16(40), head.getInt16(42)]).toEqual([
      0, -120, 900, 760,
    ]);
    expect(t.get('hhea')!.getUint16(10)).toBe(1000); // advanceWidthMax
    expect(() => boxFont({ family: 'x', glyphs: [], ranges: [] })).toThrow();
    // A bold face: usWeightClass, macStyle and fsSelection say so.
    const bold = readSfnt(
      boxFont({ family: 'B', weight: 700, glyphs: [{ advance: 500 }], ranges: [[0x41, 0x41, 0]] }),
    );
    expect(bold.get('OS/2')!.getUint16(4)).toBe(700);
    expect(bold.get('head')!.getUint16(44)).toBe(1);
    expect(bold.get('OS/2')!.getUint16(62) & 0x60).toBe(0x20);
  });
});

describe('registering the blank face', () => {
  /** A face set and FontFace stand-in whose load settles when the test says. */
  function host(opts: { fail?: boolean; addThrows?: boolean } = {}) {
    const added: unknown[] = [];
    const made: { name: string; data: ArrayBuffer; descriptors: FontFaceDescriptors }[] = [];
    let settle: () => void = () => undefined;
    const set = {
      add(face: unknown) {
        if (opts.addThrows) throw new Error('not a face of this set');
        added.push(face);
      },
    };
    const create = (name: string, data: ArrayBuffer, descriptors: FontFaceDescriptors) => {
      made.push({ name, data, descriptors });
      return {
        load: () =>
          new Promise<void>((resolve, reject) => {
            settle = () => (opts.fail ? reject(new Error('OTS parsing error')) : resolve());
          }),
      };
    };
    return { set, create, added, made, settle: () => settle() };
  }

  it('is ready only once its face has loaded and been added, under a name no drawn font string holds', async () => {
    const h = host();
    const blank = registerBlankFace(h.set, h.create);
    expect(blank.family).toMatch(/^"o-blank-[0-9a-f]{8}"$/);
    expect(h.made).toHaveLength(1);
    expect(`"${h.made[0]!.name}"`).toBe(blank.family);
    expect(new Uint8Array(h.made[0]!.data)).toEqual(blankFont());
    expect(h.made[0]!.descriptors).toEqual({ weight: '1 1000', style: 'normal' });
    expect(blank.ready).toBe(false);
    expect(h.added).toEqual([]);
    h.settle();
    expect(await blank.loaded).toBe(true);
    expect(blank.ready).toBe(true);
    expect(h.added).toHaveLength(1);
    // Never one of the resolver's internal names: a stack that ends with it holds no shipped face.
    expect(shippedStack(`700 48px ${blank.family}`)).toBeNull();
    expect(registerBlankFace(h.set, h.create).family).not.toBe(blank.family);
  });

  it('is never ready where its face cannot load or be added, or where there is no face set', async () => {
    const failing = host({ fail: true });
    const refused = registerBlankFace(failing.set, failing.create);
    failing.settle();
    expect(await refused.loaded).toBe(false);
    expect(refused.ready).toBe(false);
    expect(failing.added).toEqual([]);

    const throwing = host({ addThrows: true });
    const notAdded = registerBlankFace(throwing.set, throwing.create);
    throwing.settle();
    expect(await notAdded.loaded).toBe(false);
    expect(notAdded.ready).toBe(false);

    const none = registerBlankFace(undefined);
    expect(await none.loaded).toBe(false);
    expect(none.ready).toBe(false);

    // No FontFace in this environment (node): the default factory throws, and nothing is ready.
    const noFontFace = registerBlankFace({ add: () => undefined });
    expect(await noFontFace.loaded).toBe(false);
  });
});
