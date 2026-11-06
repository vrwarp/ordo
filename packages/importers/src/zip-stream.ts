/**
 * Streaming zip reader for large archives (Node only; the browser build uses `readZip`). Reads the central
 * directory from the file on disk and inflates one entry at a time: documents are returned in memory,
 * anything the caller marks as "spill" (media, very large entries) is streamed to a file under `dir` and
 * never held in memory. Nothing of the archive itself is loaded into memory.
 *
 * Supports stored and deflated entries, zip64 archives (over 4 GB or 65,535 entries) and nested
 * `.proPlaylist` bundles, which are expanded under `<bundle path>/` like `readZip` does (`nested: false`
 * turns that off: a PowerPoint deck never nests a zip that should be read).
 *
 * Callers reading an untrusted document (design/27 §12) also leave out what they never read (`skip`), cap
 * every entry kept in memory (`maxEntryBytes`) and the bytes spilled in all (`maxSpillBytes`): an entry over
 * either cap is listed in `skipped` and never read, so one oversized part cannot fail the whole archive.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { type FileHandle, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { ZIP_MAX_ENTRIES, ZIP_MAX_TOTAL_BYTES, safeEntryPath } from './zip.ts';

/** Documents kept in memory may not exceed this in total; media has to be spilled to disk instead. */
export const ZIP_MAX_IN_MEMORY_BYTES = 256 * 1024 * 1024;

export type ExtractedZip = {
  /** Every content entry by normalized path. Spilled entries hold an empty array; see `onDisk`. */
  files: Map<string, Uint8Array>;
  /** Entry path -> absolute file for entries that were streamed to disk. */
  onDisk: Map<string, string>;
  inMemoryBytes: number;
  entries: number;
  /**
   * Entries left out by `maxEntryBytes` ('size') or `maxSpillBytes` ('budget'), never read; at most
   * `MAX_SKIPPED_LISTED` are listed, `skippedCount` counts them all. Entries `skip` leaves out are not listed.
   */
  skipped: { path: string; bytes: number; reason: 'size' | 'budget' }[];
  skippedCount: number;
};

/** Entries listed in `ExtractedZip.skipped` (the rest are only counted). */
export const MAX_SKIPPED_LISTED = 1_000;

export type ExtractOptions = {
  /** Directory that receives spilled entries (must exist). */
  dir: string;
  /** Return true to stream this entry to disk instead of memory. */
  spill: (path: string, uncompressedSize: number) => boolean;
  maxInMemoryBytes?: number;
  signal?: AbortSignal;
  /**
   * Return true to leave this entry out entirely: it is neither read nor returned, and its compression
   * method and flags do not matter. Called before `spill`, with the normalized path and the declared size.
   */
  skip?: (path: string, uncompressedSize: number) => boolean;
  /** Expand nested `.proPlaylist`/`.probundle` zips (default true); false reads them as ordinary entries. */
  nested?: boolean;
  /**
   * The largest entry kept in memory (its declared size, which inflation never exceeds). A larger entry the
   * caller does not spill is listed in `skipped` ('size') instead of being read.
   */
  maxEntryBytes?: number;
  /**
   * Bytes spilled to disk in all (declared sizes). An entry that would pass the budget is listed in
   * `skipped` ('budget') instead of being written; later, smaller entries may still fit.
   */
  maxSpillBytes?: number;
  /**
   * Refuse a zip whose entries' data overlap (a local header and its compressed data within another
   * entry's): a few KB could otherwise name one large stream many times. Untrusted decks set it.
   */
  distinct?: boolean;
};

type Entry = {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_COMMENT = 65_535;
/**
 * A central directory larger than this is refused before it is read: 20,000 entries with long names and
 * extras fit in a few MB, so anything near this size is corrupt or hostile.
 */
export const ZIP_MAX_CENTRAL_DIR_BYTES = 64 * 1024 * 1024;

function isJunk(path: string): boolean {
  return (
    path.startsWith('__MACOSX/') ||
    path.includes('/__MACOSX/') ||
    /(^|\/)\.DS_Store$/.test(path) ||
    /(^|\/)\._[^/]*$/.test(path) ||
    /(^|\/)Thumbs\.db$/i.test(path)
  );
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) throw new Error('zip is truncated');
    got += bytesRead;
  }
  return buf;
}

function u64(buf: Buffer, off: number): number {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('zip field exceeds 2^53');
  return Number(v);
}

/** Locate the central directory, following the zip64 records when the 32-bit fields are saturated. */
async function centralDirectory(
  fh: FileHandle,
  size: number,
): Promise<{ offset: number; length: number; entries: number }> {
  const tailLen = Math.min(size, 22 + MAX_COMMENT);
  if (tailLen < 22) throw new Error('not a zip file');
  const tail = await readAt(fh, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  let entries: number = tail.readUInt16LE(eocd + 10);
  let length: number = tail.readUInt32LE(eocd + 12);
  let offset: number = tail.readUInt32LE(eocd + 16);
  const needs64 = entries === 0xffff || length === 0xffffffff || offset === 0xffffffff;
  if (needs64 && eocd >= 20 && tail.readUInt32LE(eocd - 20) === SIG_EOCD64_LOCATOR) {
    let recOffset = u64(tail, eocd - 20 + 8);
    let rec = await readAt(fh, recOffset, 56);
    if (rec.readUInt32LE(0) !== SIG_EOCD64) {
      // ProPresenter's exports are reported to write a locator that is some tens of bytes off: look for
      // the record's signature just before the locator.
      const back = Math.min(recOffset, 4096);
      const win = await readAt(fh, recOffset - back, back + 4);
      let found = -1;
      for (let i = win.length - 4; i >= 0; i--) {
        if (win.readUInt32LE(i) === SIG_EOCD64) {
          found = i;
          break;
        }
      }
      if (found < 0) throw new Error('bad zip64 end of central directory');
      recOffset = recOffset - back + found;
      rec = await readAt(fh, recOffset, 56);
    }
    entries = u64(rec, 32);
    length = u64(rec, 40);
    offset = u64(rec, 48);
  } else if (needs64) throw new Error('zip64 archive without a zip64 locator');
  if (offset + length > size) throw new Error('zip central directory is out of range');
  if (length > ZIP_MAX_CENTRAL_DIR_BYTES) throw new Error('zip central directory is too large');
  if (entries > ZIP_MAX_ENTRIES) throw new Error(`zip has more than ${ZIP_MAX_ENTRIES} entries`);
  return { offset, length, entries };
}

function parseCentral(cd: Buffer, expected: number): Entry[] {
  const out: Entry[] = [];
  let p = 0;
  while (p + 46 <= cd.length && out.length < expected) {
    if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('bad central directory entry');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compressedSize: number = cd.readUInt32LE(p + 20);
    let uncompressedSize: number = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localHeaderOffset: number = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen > cd.length) throw new Error('zip central directory entry is truncated');
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // Zip64 extra field (0x0001): the saturated 32-bit fields are replaced in this order.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (e + 4 + len > extraEnd) throw new Error('zip extra field is truncated');
      if (id === 0x0001) {
        let q = e + 4;
        const need =
          8 *
          ((uncompressedSize === 0xffffffff ? 1 : 0) +
            (compressedSize === 0xffffffff ? 1 : 0) +
            (localHeaderOffset === 0xffffffff ? 1 : 0));
        if (need > len) throw new Error('zip64 extra field is too short');
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = u64(cd, q);
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(cd, q);
          q += 8;
        }
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(cd, q);
      }
      e += 4 + len;
    }
    out.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (out.length !== expected)
    throw new Error(`zip central directory lists ${expected} entries, found ${out.length}`);
  return out;
}

/** Byte offset of an entry's data (after its local header). */
async function dataOffset(fh: FileHandle, e: Entry): Promise<number> {
  const h = await readAt(fh, e.localHeaderOffset, 30);
  if (h.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`bad local header for ${e.name}`);
  return e.localHeaderOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

type Budget = { entries: number; bytes: number; inMemory: number; nested: number; spilled: number };

async function* limited(src: AsyncIterable<Buffer>, max: number, name: string): AsyncGenerator<Buffer> {
  let n = 0;
  for await (const chunk of src) {
    n += chunk.length;
    if (n > max) throw new Error(`zip entry ${name} is larger than its header declares`);
    yield chunk;
  }
}

async function extractInto(
  zipPath: string,
  prefix: string,
  out: ExtractedZip,
  opts: ExtractOptions,
  budget: Budget,
  depth: number,
): Promise<void> {
  const maxInMemory = opts.maxInMemoryBytes ?? ZIP_MAX_IN_MEMORY_BYTES;
  const fh = await open(zipPath, 'r');
  try {
    const size = (await fh.stat()).size;
    const cd = await centralDirectory(fh, size);
    if (cd.entries > ZIP_MAX_ENTRIES) throw new Error(`zip has more than ${ZIP_MAX_ENTRIES} entries`);
    const entries = parseCentral(await readAt(fh, cd.offset, cd.length), cd.entries);
    if (opts.distinct) assertDistinct(entries);
    for (const e of entries) {
      if (opts.signal?.aborted) throw new Error('cancelled');
      if (e.name.endsWith('/')) continue;
      const path = safeEntryPath(e.name);
      if (!path || isJunk(path)) continue;
      const full = prefix ? `${prefix}/${path}` : path;
      if (opts.skip?.(full, e.uncompressedSize)) {
        budget.entries++;
        if (budget.entries > ZIP_MAX_ENTRIES) throw new Error(`zip has more than ${ZIP_MAX_ENTRIES} entries`);
        continue;
      }
      if (e.flags & 0x1) throw new Error(`zip entry ${e.name} is encrypted`);
      if (e.method !== 0 && e.method !== 8)
        throw new Error(`zip entry ${e.name} uses an unsupported compression method (${e.method})`);
      budget.entries++;
      if (budget.entries > ZIP_MAX_ENTRIES) throw new Error(`zip has more than ${ZIP_MAX_ENTRIES} entries`);
      const nested = (opts.nested ?? true) && depth < 2 && /\.(proplaylist|probundle)$/i.test(path);
      const spill = nested || opts.spill(full, e.uncompressedSize);
      if (spill && !nested && opts.maxSpillBytes !== undefined) {
        if (budget.spilled + e.uncompressedSize > opts.maxSpillBytes) {
          skipEntry(out, full, e.uncompressedSize, 'budget');
          continue;
        }
        budget.spilled += e.uncompressedSize;
      }
      if (!spill && opts.maxEntryBytes !== undefined && e.uncompressedSize > opts.maxEntryBytes) {
        skipEntry(out, full, e.uncompressedSize, 'size');
        continue;
      }
      budget.bytes += e.uncompressedSize;
      if (budget.bytes > ZIP_MAX_TOTAL_BYTES) throw new Error('zip expands beyond 8 GB');
      const start = await dataOffset(fh, e);
      if (start + e.compressedSize > size) throw new Error(`zip entry ${e.name} is out of range`);
      // An error thrown by `limited` reaches pipeline's caller as a bare AbortError when the sink is an
      // async function (pipeline aborts the other stages first); keep it and rethrow it instead.
      let own: unknown;
      const lim = async function* (s: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
        try {
          yield* limited(s, e.uncompressedSize, e.name);
        } catch (err) {
          own ??= err;
          throw err;
        }
      };
      const read = async (sink: NodeJS.WritableStream | ((s: AsyncIterable<Buffer>) => Promise<void>)) => {
        if (e.compressedSize === 0) return;
        const raw = createReadStream(zipPath, { start, end: start + e.compressedSize - 1 });
        try {
          await (e.method === 8
            ? pipeline(raw, createInflateRaw(), lim, sink as NodeJS.WritableStream)
            : pipeline(raw, lim, sink as NodeJS.WritableStream));
        } catch (err) {
          throw own ?? err;
        }
      };
      if (spill) {
        const dest = join(opts.dir, `${nested ? 'bundle' : 'entry'}-${++budget.nested}${extOf(path)}`);
        await read(createWriteStream(dest));
        if (nested && (await isZipFile(dest))) {
          // ProPresenter's exported .proPlaylist bundles are zips: expand them in place.
          await extractInto(dest, full, out, opts, budget, depth + 1);
          await rm(dest, { force: true });
          continue;
        }
        if (nested && !opts.spill(full, e.uncompressedSize)) {
          // A bare .proPlaylist document (not a bundle): keep it in memory like any other document.
          const bytes = await readFile(dest);
          await rm(dest, { force: true });
          budget.inMemory += bytes.length;
          if (budget.inMemory > maxInMemory) throw tooBig(maxInMemory);
          out.files.set(full, bytes);
          continue;
        }
        out.files.set(full, new Uint8Array(0));
        out.onDisk.set(full, dest);
        continue;
      }
      if (budget.inMemory + e.uncompressedSize > maxInMemory) throw tooBig(maxInMemory);
      const chunks: Buffer[] = [];
      await read(async (s: AsyncIterable<Buffer>) => {
        for await (const c of s) chunks.push(c);
      });
      const bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      budget.inMemory += bytes.length;
      if (budget.inMemory > maxInMemory) throw tooBig(maxInMemory);
      out.files.set(full, bytes);
    }
  } finally {
    await fh.close();
  }
  out.inMemoryBytes = budget.inMemory;
  out.entries = budget.entries;
}

/**
 * Throw when two entries' data overlap: each entry takes at least its 30-byte local header and its compressed
 * size from its offset (names, extra fields and data descriptors only add to that).
 */
function assertDistinct(entries: readonly Entry[]): void {
  const spans = entries
    .map((e) => [e.localHeaderOffset, e.localHeaderOffset + 30 + e.compressedSize] as const)
    .sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++)
    if (spans[i]![0] < spans[i - 1]![1]) throw new Error('zip entries overlap: the archive is malformed');
}

function skipEntry(out: ExtractedZip, path: string, bytes: number, reason: 'size' | 'budget'): void {
  out.skippedCount++;
  if (out.skipped.length < MAX_SKIPPED_LISTED) out.skipped.push({ path, bytes, reason });
}

function tooBig(max: number): Error {
  return new Error(
    `The zip holds more than ${Math.round(max / 1024 ** 2)} MB of documents; import large libraries from a folder instead`,
  );
}

function extOf(path: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(path);
  return m ? `.${m[1]!.toLowerCase()}` : '';
}

async function isZipFile(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const b = Buffer.alloc(4);
    const { bytesRead } = await fh.read(b, 0, 4, 0);
    return bytesRead === 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  } finally {
    await fh.close();
  }
}

/**
 * Extract a zip from disk: entries the caller spills go to files under `opts.dir`, the rest are returned
 * in memory (bounded by `maxInMemoryBytes`, default 256 MB). Same path rules and limits as `readZip`.
 */
export async function extractZip(zipPath: string, opts: ExtractOptions): Promise<ExtractedZip> {
  const out: ExtractedZip = {
    files: new Map(),
    onDisk: new Map(),
    inMemoryBytes: 0,
    entries: 0,
    skipped: [],
    skippedCount: 0,
  };
  await extractInto(zipPath, '', out, opts, { entries: 0, bytes: 0, inMemory: 0, nested: 0, spilled: 0 }, 0);
  return out;
}
