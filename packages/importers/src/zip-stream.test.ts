import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterAll, describe, expect, it } from 'vitest';
import { extractZip } from './zip-stream.ts';

const dir = mkdtempSync(join(tmpdir(), 'ordo-zip-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function write(
  name: string,
  build: (z: JSZip) => void,
  opts: JSZip.JSZipGeneratorOptions<'nodebuffer'> = {},
) {
  const z = new JSZip();
  build(z);
  const file = join(dir, name);
  writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', ...opts }));
  return file;
}

describe('extractZip', () => {
  it('keeps documents in memory, spills media to files and expands nested bundles', async () => {
    const video = Buffer.alloc(3 * 1024 * 1024, 7);
    const bundle = new JSZip();
    bundle.file('Inner.pro', Buffer.from('inner-doc'));
    bundle.file('Media/clip.mp4', video);
    const bundleBytes = await bundle.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    const file = await write(
      'lib.zip',
      (z) => {
        z.file('Library/Song.pro', Buffer.from('song-doc'), { compression: 'DEFLATE' });
        z.file('Library/Empty.pro', Buffer.alloc(0));
        z.file('Media/bg.png', Buffer.from('png-bytes'), { compression: 'STORE' });
        z.file('Playlists/Sunday.proPlaylist', bundleBytes, { compression: 'DEFLATE' });
        z.file('__MACOSX/._Song.pro', Buffer.from('junk'));
        z.file('.DS_Store', Buffer.from('junk'));
        z.folder('Media/empty');
      },
      { compression: 'DEFLATE' },
    );
    const out = mkdtempSync(join(dir, 'out-'));
    const r = await extractZip(file, {
      dir: out,
      spill: (p, size) => /\.(png|mp4)$/i.test(p) || size > 1024 * 1024,
    });
    expect([...r.files.keys()].sort()).toEqual([
      'Library/Empty.pro',
      'Library/Song.pro',
      'Media/bg.png',
      'Playlists/Sunday.proPlaylist/Inner.pro',
      'Playlists/Sunday.proPlaylist/Media/clip.mp4',
    ]);
    expect(Buffer.from(r.files.get('Library/Song.pro')!).toString()).toBe('song-doc');
    expect(r.files.get('Library/Empty.pro')!.length).toBe(0);
    expect(Buffer.from(r.files.get('Playlists/Sunday.proPlaylist/Inner.pro')!).toString()).toBe('inner-doc');
    expect(r.files.get('Media/bg.png')!.length).toBe(0);
    expect(readFileSync(r.onDisk.get('Media/bg.png')!).toString()).toBe('png-bytes');
    const clip = readFileSync(r.onDisk.get('Playlists/Sunday.proPlaylist/Media/clip.mp4')!);
    expect(clip.length).toBe(video.length);
    expect(clip.equals(video)).toBe(true);
    expect(r.inMemoryBytes).toBe('song-doc'.length + 'inner-doc'.length);
    expect(r.entries).toBe(6); // the bundle itself counts against the entry budget
  });

  it('enforces the in-memory cap and rejects traversal', async () => {
    const big = await write('big.zip', (z) => {
      z.file('a.pro', Buffer.alloc(600 * 1024, 1));
      z.file('b.pro', Buffer.alloc(600 * 1024, 2));
    });
    const out = mkdtempSync(join(dir, 'out-'));
    await expect(
      extractZip(big, { dir: out, spill: () => false, maxInMemoryBytes: 1024 * 1024 }),
    ).rejects.toThrow(/more than 1 MB of documents/);
    // Spilling the same entries to disk is fine regardless of the cap.
    const r = await extractZip(big, { dir: out, spill: () => true, maxInMemoryBytes: 1024 });
    expect(r.onDisk.size).toBe(2);
    const bad = await write('bad.zip', (z) => {
      z.file('../escape.pro', Buffer.from('x'));
    });
    await expect(extractZip(bad, { dir: out, spill: () => false })).rejects.toThrow(/escapes/);
    writeFileSync(join(dir, 'notzip.bin'), Buffer.alloc(100, 0));
    await expect(extractZip(join(dir, 'notzip.bin'), { dir: out, spill: () => false })).rejects.toThrow(
      /not a zip/,
    );
  });
});

describe('extractZip errors (review 2026-11-04 finding 24)', () => {
  /** A one-entry deflated zip with its declared size (both headers) and optionally its body patched. */
  async function patched(name: string, declare: number, corrupt = false): Promise<string> {
    const z = new JSZip();
    z.file('a.pro', Buffer.alloc(2_000_000, 1), { compression: 'DEFLATE' });
    const buf = await z.generateAsync({ type: 'nodebuffer' });
    buf.writeUInt32LE(declare, 22);
    const cd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(declare, cd + 24);
    if (corrupt) buf.fill(0xff, 30 + 5, 30 + 5 + 64);
    const file = join(dir, name);
    writeFileSync(file, buf);
    return file;
  }

  it('reports an entry larger than declared by name, in memory and spilled, not as an abort', async () => {
    for (const spill of [false, true]) {
      const out = mkdtempSync(join(dir, 'err-'));
      const err = await extractZip(await patched(`lie-${spill}.zip`, 100), {
        dir: out,
        spill: () => spill,
      }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err?.message).toBe('zip entry a.pro is larger than its header declares');
      expect(err?.name).not.toBe('AbortError');
    }
  });

  it('reports a corrupt deflate stream as such, not as an abort', async () => {
    for (const spill of [false, true]) {
      const out = mkdtempSync(join(dir, 'err-'));
      const err = await extractZip(await patched(`bad-${spill}.zip`, 2_000_000, true), {
        dir: out,
        spill: () => spill,
      }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err?.name).not.toBe('AbortError');
      expect(err?.message).not.toMatch(/aborted/);
    }
  });
});

describe('extractZip filters and caps (design/27 §12)', () => {
  it('leaves out skipped entries without reading them, whatever their method or flags', async () => {
    const file = await write('deck.zip', (z) => {
      z.file('ppt/slides/slide1.xml', Buffer.from('<p:sld/>'));
      z.file('ppt/embeddings/oleObject1.bin', Buffer.alloc(4096, 3));
      z.file('ppt/vbaProject.bin', Buffer.alloc(1024, 4));
      z.file('customXml/item1.xml', Buffer.from('<x/>'));
    });
    // Mark the embedding as encrypted with an unknown method: skipped, it does not fail the archive.
    const buf = readFileSync(file);
    const cd = buf.indexOf(Buffer.from('ppt/embeddings/oleObject1.bin')) - 46;
    buf.writeUInt16LE(buf.readUInt16LE(cd + 8) | 1, cd + 8);
    buf.writeUInt16LE(99, cd + 10);
    writeFileSync(file, buf);
    const seen: string[] = [];
    const r = await extractZip(file, {
      dir: mkdtempSync(join(dir, 'skip-')),
      spill: () => false,
      skip: (p, size) => {
        seen.push(`${p}:${size}`);
        return !p.startsWith('ppt/slides/');
      },
    });
    expect([...r.files.keys()]).toEqual(['ppt/slides/slide1.xml']);
    expect(seen).toContain('ppt/embeddings/oleObject1.bin:4096');
    expect(r.entries).toBe(4);
    expect(r.skipped).toEqual([]);
  });

  it('lists entries over the per-entry cap and past the spill budget instead of reading them', async () => {
    const file = await write('caps.zip', (z) => {
      z.file('ppt/slides/slide1.xml', Buffer.alloc(100, 0x41));
      z.file('ppt/slides/slide2.xml', Buffer.alloc(5000, 0x41));
      z.file('ppt/media/image1.png', Buffer.alloc(3000, 1));
      z.file('ppt/media/image2.png', Buffer.alloc(3000, 2));
      z.file('ppt/media/image3.png', Buffer.alloc(1000, 3));
    });
    const out = mkdtempSync(join(dir, 'caps-'));
    const r = await extractZip(file, {
      dir: out,
      spill: (p) => p.startsWith('ppt/media/'),
      maxEntryBytes: 1000,
      maxSpillBytes: 4500,
    });
    expect([...r.files.keys()].sort()).toEqual([
      'ppt/media/image1.png',
      'ppt/media/image3.png',
      'ppt/slides/slide1.xml',
    ]);
    expect(r.skipped).toEqual([
      { path: 'ppt/slides/slide2.xml', bytes: 5000, reason: 'size' },
      { path: 'ppt/media/image2.png', bytes: 3000, reason: 'budget' },
    ]);
    expect(r.skippedCount).toBe(2);
    expect(r.inMemoryBytes).toBe(100);
    // Spilled entries go under generated names: an entry name never becomes a path.
    for (const p of r.onDisk.values()) expect(p.startsWith(out)).toBe(true);
    expect([...r.onDisk.values()].map((p) => p.slice(out.length + 1)).sort()).toEqual([
      'entry-1.png',
      'entry-2.png',
    ]);
  });

  it('refuses entries whose data overlap with distinct: true (one stream named many times)', async () => {
    // A JSZip of one stored entry, then a second central record pointing at the same local header.
    const file = await write('overlap.zip', (z) => z.file('a.xml', Buffer.alloc(4000, 0x41)), {
      compression: 'STORE',
    });
    const buf = readFileSync(file);
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cdStart = buf.readUInt32LE(eocd + 16);
    const record = Buffer.from(buf.subarray(cdStart, eocd));
    const copy = Buffer.from(record);
    copy.write('b', 46, 'latin1');
    const end = Buffer.from(buf.subarray(eocd));
    end.writeUInt16LE(2, 8);
    end.writeUInt16LE(2, 10);
    end.writeUInt32LE(record.length * 2, 12);
    writeFileSync(file, Buffer.concat([buf.subarray(0, cdStart), record, copy, end]));
    const opts = { dir: mkdtempSync(join(dir, 'overlap-')), spill: () => false };
    // Without the flag (ProPresenter libraries) it reads both names.
    expect([...(await extractZip(file, opts)).files.keys()].sort()).toEqual(['a.xml', 'b.xml']);
    await expect(extractZip(file, { ...opts, distinct: true })).rejects.toThrow(/zip entries overlap/);
  });

  it('reads a nested bundle as an ordinary entry with nested: false', async () => {
    const inner = new JSZip();
    inner.file('Inner.pro', Buffer.from('inner-doc'));
    const bundle = await inner.generateAsync({ type: 'nodebuffer' });
    const file = await write('nested.zip', (z) => {
      z.file('Sunday.proPlaylist', bundle);
    });
    const r = await extractZip(file, {
      dir: mkdtempSync(join(dir, 'nested-')),
      spill: () => false,
      nested: false,
    });
    expect([...r.files.keys()]).toEqual(['Sunday.proPlaylist']);
    expect(Buffer.from(r.files.get('Sunday.proPlaylist')!).equals(bundle)).toBe(true);
  });
});
