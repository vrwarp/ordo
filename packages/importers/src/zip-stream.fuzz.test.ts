/**
 * Fuzzing of the streaming zip reader (design/25 "Fuzzing"): truncated, bit-flipped and garbage archives,
 * hand-built zip64 records and absurd declared sizes must be rejected with an Error, without allocating
 * more than the file's own size and without hanging.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import fc from 'fast-check';
import JSZip from 'jszip';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { extractZip } from './zip-stream.ts';

const dir = mkdtempSync(join(tmpdir(), 'ordo-zipfuzz-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let seq = 0;
function file(bytes: Uint8Array): string {
  const p = join(dir, `f${seq++}.zip`);
  writeFileSync(p, bytes);
  return p;
}

/** Largest single Buffer.alloc made while running `fn`. */
async function maxAlloc(fn: () => Promise<unknown>): Promise<number> {
  let max = 0;
  const orig = Buffer.alloc.bind(Buffer);
  vi.spyOn(Buffer, 'alloc').mockImplementation(((n: number, ...rest: unknown[]) => {
    max = Math.max(max, n);
    return (orig as (...a: unknown[]) => Buffer)(n, ...rest);
  }) as typeof Buffer.alloc);
  await fn();
  return max;
}

/** Extract; the result is either a well-formed listing or an Error, never anything else. */
async function attempt(bytes: Uint8Array): Promise<'ok' | 'rejected'> {
  const out = mkdtempSync(join(dir, 'out-'));
  try {
    const r = await extractZip(file(bytes), { dir: out, spill: (p) => p.endsWith('.mp4') });
    for (const [k, v] of r.files) {
      expect(k.startsWith('/')).toBe(false);
      expect(k.split('/')).not.toContain('..');
      expect(v).toBeInstanceOf(Uint8Array);
    }
    return 'ok';
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(RangeError);
    return 'rejected';
  }
}

type Entry = { name: string; data: Uint8Array; method?: 0 | 8 };
type Overrides = {
  /** Values written into the 32-bit size/offset fields (0xffffffff selects the zip64 extra). */
  csize?: number;
  usize?: number;
  offset?: number;
  zip64?: { usize?: bigint; csize?: bigint; offset?: bigint };
  eocd64?: { entries?: bigint; cdLength?: bigint; cdOffset?: bigint; locatorOffset?: bigint };
  entries?: number;
};

/** A hand-built zip (stored or deflated entries) with optional zip64 records and overridden fields. */
function buildZip(entries: Entry[], o: Overrides = {}): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const body = e.method === 8 ? deflateRawSync(e.data) : Buffer.from(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.method ?? 0, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, body);
    const extra: Buffer[] = [];
    if (o.zip64) {
      const fields: bigint[] = [];
      if (o.zip64.usize !== undefined) fields.push(o.zip64.usize);
      if (o.zip64.csize !== undefined) fields.push(o.zip64.csize);
      if (o.zip64.offset !== undefined) fields.push(o.zip64.offset);
      const x = Buffer.alloc(4 + 8 * fields.length);
      x.writeUInt16LE(1, 0);
      x.writeUInt16LE(8 * fields.length, 2);
      fields.forEach((f, i) => {
        x.writeBigUInt64LE(f, 4 + 8 * i);
      });
      extra.push(x);
    }
    const ex = Buffer.concat(extra);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(e.method ?? 0, 10);
    ch.writeUInt32LE(o.csize ?? body.length, 20);
    ch.writeUInt32LE(o.usize ?? e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(ex.length, 30);
    ch.writeUInt32LE(o.offset ?? off, 42);
    central.push(ch, name, ex);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const cdOffset = off;
  const tail: Buffer[] = [];
  if (o.eocd64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(o.eocd64.entries ?? BigInt(entries.length), 32);
    rec.writeBigUInt64LE(o.eocd64.cdLength ?? BigInt(cd.length), 40);
    rec.writeBigUInt64LE(o.eocd64.cdOffset ?? BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(o.eocd64.locatorOffset ?? BigInt(cdOffset + cd.length), 8);
    tail.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const n = o.entries ?? entries.length;
  eocd.writeUInt16LE(o.eocd64 ? 0xffff : n, 8);
  eocd.writeUInt16LE(o.eocd64 ? 0xffff : n, 10);
  eocd.writeUInt32LE(o.eocd64 ? 0xffffffff : cd.length, 12);
  eocd.writeUInt32LE(o.eocd64 ? 0xffffffff : cdOffset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, ...tail, eocd]));
}

const entryArb = fc.record({
  name: fc.oneof(
    fc.constantFrom('a.pro', 'Media/b.mp4', 'x/../../evil', '/abs', 'C:\\win', '__MACOSX/._a', 'd/'),
    fc.string({ minLength: 1, maxLength: 12 }),
  ),
  data: fc.uint8Array({ maxLength: 200 }),
  method: fc.constantFrom<0 | 8>(0, 8),
});

const GOOD = buildZip([
  { name: 'Library/Song.pro', data: new TextEncoder().encode('song'.repeat(50)), method: 8 },
  { name: 'Media/clip.mp4', data: new Uint8Array(300).fill(7) },
]);

describe('extractZip (fuzz)', () => {
  it('a well-formed hand-built archive extracts', async () => {
    expect(await attempt(GOOD)).toBe('ok');
  });

  it('random bytes are rejected', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 400 }), async (b) => {
        await attempt(b);
      }),
      { numRuns: 300 },
    );
  });

  it('random hand-built archives extract or reject; paths never escape', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(entryArb, { maxLength: 5 }), async (es) => {
        await attempt(buildZip(es));
      }),
      { numRuns: 200 },
    );
  });

  it('truncated and bit-flipped archives reject without allocating more than the file', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat(),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 6 }),
        async (cut, flips) => {
          const b = GOOD.slice(0, cut % (GOOD.length + 1));
          for (const [i, v] of flips) if (b.length) b[i % b.length] = v;
          const max = await maxAlloc(() => attempt(b));
          expect(max).toBeLessThanOrEqual(Math.max(GOOD.length, 65_557));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('absurd declared sizes in zip64 records reject without allocating them', async () => {
    const big = fc.oneof(
      fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
      fc.constantFrom(0n, 1n << 32n, 1n << 40n, (1n << 53n) + 1n, (1n << 64n) - 1n),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.record({ usize: big, csize: big, offset: big }, { requiredKeys: [] }),
        fc.record({ entries: big, cdLength: big, cdOffset: big, locatorOffset: big }, { requiredKeys: [] }),
        fc.boolean(),
        async (z64, e64, sat) => {
          const bytes = buildZip([{ name: 'a.pro', data: new Uint8Array(10) }], {
            ...(sat ? { usize: 0xffffffff, csize: 0xffffffff, offset: 0xffffffff } : {}),
            zip64: z64,
            eocd64: e64,
          });
          const max = await maxAlloc(() => attempt(bytes));
          expect(max).toBeLessThanOrEqual(65_557);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('extractZip regressions found by fuzzing', () => {
  it('rejects a deflate bomb larger than its declared size', async () => {
    const bomb = buildZip([{ name: 'a.pro', data: new Uint8Array(5_000_000), method: 8 }], { usize: 100 });
    expect(await attempt(bomb)).toBe('rejected');
  });

  it('rejects a central directory larger than the limit without reading it', async () => {
    const bytes = buildZip([{ name: 'a.pro', data: new Uint8Array(10) }], {
      eocd64: { cdLength: 1n << 40n, cdOffset: 0n },
    });
    const max = await maxAlloc(() => attempt(bytes));
    expect(max).toBeLessThanOrEqual(65_557);
  });

  it('rejects an entry count beyond the limit before parsing entries', async () => {
    const bytes = buildZip([{ name: 'a.pro', data: new Uint8Array(10) }], { eocd64: { entries: 1n << 50n } });
    expect(await attempt(bytes)).toBe('rejected');
  });

  it('rejects a zip64 extra field shorter than the saturated fields it must replace', async () => {
    const bytes = buildZip([{ name: 'a.pro', data: new Uint8Array(10) }], {
      usize: 0xffffffff,
      csize: 0xffffffff,
      zip64: { usize: 10n },
    });
    expect(await attempt(bytes)).toBe('rejected');
  });

  it('a JSZip archive with a corrupted local header offset rejects', async () => {
    const z = new JSZip();
    z.file('a.pro', 'x');
    const b = await z.generateAsync({ type: 'uint8array' });
    const buf = Buffer.from(b);
    const cd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(0x7fffffff, cd + 42);
    expect(await attempt(new Uint8Array(buf))).toBe('rejected');
  });
});
