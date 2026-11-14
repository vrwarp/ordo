/**
 * A bounded zip reader for an untrusted deck in a browser, a Web Worker or Node (design/27 §12 "Zip"; the
 * client parse's counterpart of the hub's `zip-stream.ts`, whose rules it follows):
 *
 * - **The central directory is read by this module**, never through JSZip: its entries, sizes and offsets
 *   (zip64 included) are checked here, at most `ZIP_MAX_ENTRIES` entries and a directory of at most
 *   `ZIP_MAX_CENTRAL_DIR_BYTES`; a zip whose entries' data overlap is refused (`distinct`: a few KB could
 *   otherwise name one large stream thousands of times); entry names go through `safeEntryPath` and never
 *   become paths.
 * - **Bytes are counted as they inflate** (`DecompressionStream('deflate-raw')`, stored entries as they are):
 *   a read stops at the bound its caller gives and at the size the entry declares, so a part that lies about
 *   its size is refused when its inflated bytes pass the declared size ("larger than its header declares"),
 *   never after it was inflated whole. A caller reads only the first bytes of a picture or a clip (`head`).
 * - **Nothing of the archive is held whole** when the source is a `Blob` (a `File` from a drop): each read is
 *   a slice of it. Encrypted entries and compression methods other than stored and deflate are refused when
 *   read, as the hub refuses them.
 *
 * A runtime without `DecompressionStream('deflate-raw')` (Safari before 16.4) cannot read a deflated entry:
 * the read throws, and the caller falls back (the operator uploads the deck for the hub to parse).
 */
import { isJunk, safeEntryPath, ZIP_MAX_ENTRIES } from './zip-path.ts';

/** A central directory larger than this is refused before it is read (as `zip-stream.ts`). */
export const ZIP_MAX_CENTRAL_DIR_BYTES = 64 * 1024 * 1024;

/** One entry of the central directory, by its safe path. */
export type BoundedEntry = {
  path: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

/** Where the archive's bytes come from: a `Blob` (sliced per read) or bytes in memory. */
export type ZipSource = {
  size: number;
  /** `len` bytes from `pos` (fewer at the end). */
  read(pos: number, len: number): Promise<Uint8Array>;
  /** The bytes [pos, pos + len) as a stream. */
  stream(pos: number, len: number): ReadableStream<Uint8Array>;
};

/** A read refused for a bound (`ZipLimitError.kind`): the caller decides whether that fails the deck. */
export class ZipLimitError extends Error {
  readonly kind: 'part' | 'total';
  constructor(message: string, kind: 'part' | 'total') {
    super(message);
    this.kind = kind;
  }
}

/** A `ZipSource` over a `Blob`, an `ArrayBuffer` or bytes. */
export function zipSource(input: Blob | Uint8Array | ArrayBuffer): ZipSource {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return {
      size: bytes.length,
      read: async (pos, len) => bytes.subarray(pos, Math.min(bytes.length, pos + len)),
      stream: (pos, len) => {
        const part = bytes.subarray(pos, Math.min(bytes.length, pos + len));
        return new ReadableStream<Uint8Array>({
          start(c) {
            if (part.length) c.enqueue(part);
            c.close();
          },
        });
      },
    };
  }
  const blob = input;
  return {
    size: blob.size,
    read: async (pos, len) =>
      new Uint8Array(await blob.slice(pos, Math.min(blob.size, pos + len)).arrayBuffer()),
    stream: (pos, len) =>
      blob.slice(pos, Math.min(blob.size, pos + len)).stream() as ReadableStream<Uint8Array>,
  };
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_COMMENT = 65_535;

function u64(v: DataView, off: number): number {
  const n = v.getBigUint64(off, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('zip field exceeds 2^53');
  return Number(n);
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

async function exactly(src: ZipSource, pos: number, len: number): Promise<Uint8Array> {
  if (pos < 0 || pos + len > src.size) throw new Error('zip is truncated');
  const b = await src.read(pos, len);
  if (b.length < len) throw new Error('zip is truncated');
  return b;
}

/** Locate the central directory, following the zip64 records when the 32-bit fields are saturated. */
async function centralDirectory(
  src: ZipSource,
): Promise<{ offset: number; length: number; entries: number }> {
  const size = src.size;
  const tailLen = Math.min(size, 22 + MAX_COMMENT);
  if (tailLen < 22) throw new Error('not a zip file');
  const tail = await exactly(src, size - tailLen, tailLen);
  const t = view(tail);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--)
    if (t.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  let entries: number = t.getUint16(eocd + 10, true);
  let length: number = t.getUint32(eocd + 12, true);
  let offset: number = t.getUint32(eocd + 16, true);
  const needs64 = entries === 0xffff || length === 0xffffffff || offset === 0xffffffff;
  if (needs64 && eocd >= 20 && t.getUint32(eocd - 20, true) === SIG_EOCD64_LOCATOR) {
    let recOffset = u64(t, eocd - 20 + 8);
    let rec = view(await exactly(src, recOffset, 56));
    if (rec.getUint32(0, true) !== SIG_EOCD64) {
      // ProPresenter's exports are reported to write a locator some tens of bytes off (as `zip-stream.ts`).
      const back = Math.min(recOffset, 4096);
      const win = view(await exactly(src, recOffset - back, back + 4));
      let found = -1;
      for (let i = win.byteLength - 4; i >= 0; i--)
        if (win.getUint32(i, true) === SIG_EOCD64) {
          found = i;
          break;
        }
      if (found < 0) throw new Error('bad zip64 end of central directory');
      recOffset = recOffset - back + found;
      rec = view(await exactly(src, recOffset, 56));
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

type RawEntry = Omit<BoundedEntry, 'path'> & { name: string };

function parseCentral(cd: Uint8Array, expected: number): RawEntry[] {
  const v = view(cd);
  const out: RawEntry[] = [];
  const decoder = new TextDecoder();
  let p = 0;
  while (p + 46 <= cd.length && out.length < expected) {
    if (v.getUint32(p, true) !== SIG_CENTRAL) throw new Error('bad central directory entry');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    let compressedSize: number = v.getUint32(p + 20, true);
    let uncompressedSize: number = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    let localHeaderOffset: number = v.getUint32(p + 42, true);
    if (p + 46 + nameLen + extraLen > cd.length) throw new Error('zip central directory entry is truncated');
    const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // Zip64 extra field (0x0001): the saturated 32-bit fields are replaced in this order.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = v.getUint16(e, true);
      const len = v.getUint16(e + 2, true);
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
          uncompressedSize = u64(v, q);
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(v, q);
          q += 8;
        }
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(v, q);
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

/**
 * Throw when two entries' data overlap: each entry takes at least its 30-byte local header and its compressed
 * size from its offset (as `zip-stream.ts`).
 */
function assertDistinct(entries: readonly RawEntry[]): void {
  const spans = entries
    .map((e) => [e.localHeaderOffset, e.localHeaderOffset + 30 + e.compressedSize] as const)
    .sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++)
    if (spans[i]![0] < spans[i - 1]![1]) throw new Error('zip entries overlap: the archive is malformed');
}

/** Concatenate chunks. */
function concat(chunks: readonly Uint8Array[], n: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** An untrusted zip read within bounds (see the module comment). */
export class BoundedZip {
  /** Content entries by safe path (directories and junk left out), in central-directory order. */
  readonly entries: Map<string, BoundedEntry>;
  private readonly src: ZipSource;

  private constructor(src: ZipSource, entries: Map<string, BoundedEntry>) {
    this.src = src;
    this.entries = entries;
  }

  /** Read and check the central directory; throws for a zip that is not one, too large or malformed. */
  static async open(src: ZipSource): Promise<BoundedZip> {
    const cd = await centralDirectory(src);
    const raw = parseCentral(await exactly(src, cd.offset, cd.length), cd.entries);
    assertDistinct(raw);
    const entries = new Map<string, BoundedEntry>();
    for (const e of raw) {
      if (e.name.endsWith('/')) continue;
      const path = safeEntryPath(e.name);
      if (!path || isJunk(path) || entries.has(path)) continue;
      const { name: _n, ...rest } = e;
      entries.set(path, { path, ...rest });
    }
    return new BoundedZip(src, entries);
  }

  /** Whether the archive holds `path`. */
  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** The declared size of `path` (0 when it is not there). */
  declared(path: string): number {
    return this.entries.get(path)?.uncompressedSize ?? 0;
  }

  /**
   * The whole of `path`, at most `max` bytes (else a `ZipLimitError` 'part'), counted as they inflate: an entry
   * that inflates past its declared size is refused as it does.
   */
  async read(path: string, max: number): Promise<Uint8Array> {
    const e = this.entries.get(path);
    if (!e) throw new Error(`zip has no entry ${path}`);
    if (e.uncompressedSize > max)
      throw new ZipLimitError(`zip entry ${path} is larger than ${max} bytes`, 'part');
    return this.inflate(e, e.uncompressedSize, false);
  }

  /** The first `n` bytes of `path` (fewer for a smaller entry): only those are inflated. */
  async head(path: string, n: number): Promise<Uint8Array> {
    const e = this.entries.get(path);
    if (!e) throw new Error(`zip has no entry ${path}`);
    return this.inflate(e, Math.min(n, e.uncompressedSize), true);
  }

  private async inflate(e: BoundedEntry, want: number, prefix: boolean): Promise<Uint8Array> {
    if (e.flags & 0x1) throw new Error(`zip entry ${e.path} is encrypted`);
    if (e.method !== 0 && e.method !== 8)
      throw new Error(`zip entry ${e.path} uses an unsupported compression method (${e.method})`);
    if (want <= 0 || e.compressedSize === 0) return new Uint8Array(0);
    const h = view(await exactly(this.src, e.localHeaderOffset, 30));
    if (h.getUint32(0, true) !== SIG_LOCAL) throw new Error(`bad local header for ${e.path}`);
    const start = e.localHeaderOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    if (start + e.compressedSize > this.src.size) throw new Error(`zip entry ${e.path} is out of range`);
    const raw = this.src.stream(start, e.compressedSize);
    const stream =
      e.method === 8
        ? raw.pipeThrough(
            new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>,
          )
        : raw;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // A head (`want` ≤ the declared size) takes what it asked for and stops there.
        if (prefix && n + value.length >= want) {
          chunks.push(value.subarray(0, want - n));
          n = want;
          break;
        }
        if (n + value.length > e.uncompressedSize)
          throw new Error(`zip entry ${e.path} is larger than its header declares`);
        chunks.push(value);
        n += value.length;
      }
    } finally {
      // A stopped read (a head, a refused entry) cancels the rest: nothing more is inflated.
      await reader.cancel().catch(() => undefined);
    }
    return concat(chunks, n);
  }
}
