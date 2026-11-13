import { deflateRawSync } from 'node:zlib';
import fc from 'fast-check';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parsePptxScene } from './pptx-client.ts';
import { BoundedZip, zipSource } from './zip-bounded.ts';

const CI = process.env.CI ? 3 : 1;

/** A zip written by hand: each entry deflated (or stored), with the sizes and offsets given or true. */
function handZip(
  entries: { name: string; data: Uint8Array; declared?: number; stored?: boolean; at?: number }[],
): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const offsets: number[] = [];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const body = e.stored ? e.data : new Uint8Array(deflateRawSync(e.data));
    const local = new Uint8Array(30 + name.length + body.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(8, e.stored ? 0 : 8, true);
    v.setUint32(18, body.length, true);
    v.setUint32(22, e.declared ?? e.data.length, true);
    v.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    offsets.push(e.at ?? offset);
    locals.push(local);
    offset += local.length;
    const c = new Uint8Array(46 + name.length);
    const w = new DataView(c.buffer);
    w.setUint32(0, 0x02014b50, true);
    w.setUint16(10, e.stored ? 0 : 8, true);
    w.setUint32(20, body.length, true);
    w.setUint32(24, e.declared ?? e.data.length, true);
    w.setUint16(28, name.length, true);
    w.setUint32(42, offsets[offsets.length - 1]!, true);
    c.set(name, 46);
    central.push(c);
  }
  const cdLen = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdLen, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdLen + 22);
  let at = 0;
  for (const l of locals) {
    out.set(l, at);
    at += l.length;
  }
  for (const c of central) {
    out.set(c, at);
    at += c.length;
  }
  out.set(eocd, at);
  return out;
}

describe('BoundedZip', () => {
  it('reads what JSZip wrote, from bytes and from a Blob, whole and by its first bytes', async () => {
    const z = new JSZip();
    const big = new Uint8Array(300_000).map((_, i) => (i * 7) & 0xff);
    z.file('a.xml', '<a/>');
    z.file('dir/b.bin', big);
    z.file('stored.txt', 'plain', { compression: 'STORE' });
    z.file('__MACOSX/x', 'junk');
    const bytes = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    for (const src of [zipSource(bytes), zipSource(new Blob([bytes as Uint8Array<ArrayBuffer>]))]) {
      const zip = await BoundedZip.open(src);
      expect([...zip.entries.keys()].sort()).toEqual(['a.xml', 'dir/b.bin', 'stored.txt']);
      expect(new TextDecoder().decode(await zip.read('a.xml', 100))).toBe('<a/>');
      expect(await zip.read('dir/b.bin', 1e6)).toEqual(big);
      expect(await zip.head('dir/b.bin', 1000)).toEqual(big.subarray(0, 1000));
      expect(new TextDecoder().decode(await zip.read('stored.txt', 10))).toBe('plain');
      await expect(zip.read('dir/b.bin', 1000)).rejects.toThrow(/larger than 1000/);
    }
  });

  it('stops a part that inflates past its declared size as it does (a zip bomb of 1 KB declared)', async () => {
    // 64 MB of zeros declared as 1,000 bytes: refused after the first inflated chunk, not after 64 MB.
    const bomb = handZip([
      { name: 'ppt/zz-bomb.xml', data: new Uint8Array(64 * 1024 * 1024), declared: 1_000 },
    ]);
    expect(bomb.length).toBeLessThan(200_000);
    const zip = await BoundedZip.open(zipSource(bomb));
    const before = process.memoryUsage().arrayBuffers;
    const t0 = performance.now();
    await expect(zip.read('ppt/zz-bomb.xml', 8 * 1024 * 1024)).rejects.toThrow(
      /larger than its header declares/,
    );
    expect(performance.now() - t0).toBeLessThan(2_000 * CI);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(32 * 1024 * 1024);
    // Its first bytes are fine: only what is asked for is inflated.
    expect((await zip.head('ppt/zz-bomb.xml', 100)).length).toBe(100);
  });

  it('refuses overlapping entries, a short central directory and an encrypted or unknown entry', async () => {
    const data = new TextEncoder().encode('<p:sld/>');
    // Two entries naming the same data (the second's offset points into the first).
    const overlap = handZip([
      { name: 'a.xml', data },
      { name: 'b.xml', data, at: 0 },
    ]);
    await expect(BoundedZip.open(zipSource(overlap))).rejects.toThrow(/overlap/);
    const truncated = handZip([{ name: 'a.xml', data }]).slice(0, 40);
    await expect(BoundedZip.open(zipSource(truncated))).rejects.toThrow();
    await expect(BoundedZip.open(zipSource(new Uint8Array(10)))).rejects.toThrow(/not a zip/);
    const traversal = handZip([{ name: '../evil.xml', data }]);
    await expect(BoundedZip.open(zipSource(traversal))).rejects.toThrow(/escapes/);
    const enc = handZip([{ name: 'a.xml', data }]);
    // Flag bit 0 (encrypted) in the central directory.
    const v = new DataView(enc.buffer);
    const cd = enc.length - 22 - (46 + 5);
    v.setUint16(cd + 8, 1, true);
    const zip = await BoundedZip.open(zipSource(enc));
    await expect(zip.read('a.xml', 100)).rejects.toThrow(/encrypted/);
  });

  it('refuses a directory that claims more entries than a deck may have', async () => {
    const z = handZip([{ name: 'a.xml', data: new Uint8Array(1) }]);
    const v = new DataView(z.buffer);
    v.setUint16(z.length - 22 + 8, 0xfffe, true);
    v.setUint16(z.length - 22 + 10, 0xfffe, true);
    await expect(BoundedZip.open(zipSource(z))).rejects.toThrow(/entries/);
  });

  it('never throws anything but an Error on mutated archives, within time (fuzz)', async () => {
    const z = new JSZip();
    z.file('[Content_Types].xml', '<Types/>');
    z.file('ppt/presentation.xml', '<p:presentation/>');
    z.file('ppt/media/image1.png', new Uint8Array(5000).fill(3));
    const base = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const t0 = performance.now();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.nat(base.length - 1), fc.integer({ min: 0, max: 255 })), { maxLength: 12 }),
        async (edits) => {
          const b = base.slice();
          for (const [i, x] of edits) b[i] = x;
          try {
            const zip = await BoundedZip.open(zipSource(b));
            for (const p of zip.entries.keys()) {
              await zip.head(p, 64).catch((e) => expect(e).toBeInstanceOf(Error));
              await zip.read(p, 1 << 20).catch((e) => expect(e).toBeInstanceOf(Error));
            }
          } catch (e) {
            expect(e).toBeInstanceOf(Error);
          }
        },
      ),
      { numRuns: 300, seed: 23 },
    );
    expect(performance.now() - t0).toBeLessThan(20_000 * CI);
  });
});

describe('parsePptxScene on hostile zips', () => {
  it('fails cleanly on a deck whose XML passes its declared sizes, and on one over the XML budget', async () => {
    const bomb = handZip([
      { name: '[Content_Types].xml', data: new TextEncoder().encode('<Types/>') },
      { name: 'ppt/zz-bomb.xml', data: new Uint8Array(32 * 1024 * 1024), declared: 1_000 },
    ]);
    await expect(parsePptxScene(bomb)).rejects.toThrow(/larger than its header declares/);
    // 9 parts of 7.5 MB: more than 64 MB of XML, refused before the ninth is inflated.
    const part = new Uint8Array(7.5 * 1024 * 1024);
    const many = handZip(Array.from({ length: 9 }, (_, i) => ({ name: `ppt/slides/p${i}.xml`, data: part })));
    await expect(parsePptxScene(many)).rejects.toThrow(/more than 64 MB of slide XML/);
  });
});
