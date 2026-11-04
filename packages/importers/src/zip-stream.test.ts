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
