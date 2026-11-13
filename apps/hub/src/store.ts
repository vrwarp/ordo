import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileRef } from '@ordo/domain';
import { looksLikeSvg, newId } from '@ordo/domain';
import { HttpError } from './errors.ts';
import type { Library } from './library.ts';

export const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;

/** The 413 for an upload past `limit` bytes, in the words of that limit ('the 256 MB upload limit'). */
export function tooLarge(limit: number = MAX_UPLOAD_BYTES): HttpError {
  const gb = 1024 ** 3;
  const mb = 1024 ** 2;
  const size =
    limit >= gb && limit % gb === 0
      ? `${limit / gb} GB`
      : limit >= mb
        ? `${Math.round(limit / mb)} MB`
        : `${Math.max(1, Math.round(limit / 1024))} KB`;
  return new HttpError(413, 'too_large', `File exceeds the ${size} upload limit`);
}

export type Sniffed = {
  ext: string;
  mime: string;
  kind: 'video' | 'image' | 'audio' | 'font' | 'pdf' | 'zip';
};

/*
 * ASF (WMV, WMA) GUIDs as stored, the first three fields little-endian: the header object
 * 75B22630-668E-11CF-A6D9-00AA0062CE6C, and the stream types of a stream properties object,
 * ASF_Video_Media BC19EFC0-5B4D-11CF-A8FD-00805F5C442B and
 * ASF_Audio_Media F8699E40-5B4D-11CF-A8FD-00805F5C442B.
 */
const ASF_HEADER = [
  0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c,
];
const ASF_VIDEO = [
  0xc0, 0xef, 0x19, 0xbc, 0x4d, 0x5b, 0xcf, 0x11, 0xa8, 0xfd, 0x00, 0x80, 0x5f, 0x5c, 0x44, 0x2b,
];
const ASF_AUDIO = [
  0x40, 0x9e, 0x69, 0xf8, 0x4d, 0x5b, 0xcf, 0x11, 0xa8, 0xfd, 0x00, 0x80, 0x5f, 0x5c, 0x44, 0x2b,
];

/** Whether `pat` occurs in `b` at or after `from`. */
function contains(b: Uint8Array, pat: readonly number[], from = 0): boolean {
  outer: for (let i = from; i + pat.length <= b.length; i++) {
    for (let j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

/** Identify a file from its first bytes. Returns undefined for anything ordo does not accept. */
export function sniff(b: Uint8Array): Sniffed | undefined {
  const at = (o: number, s: string) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  const u = (o: number) => b[o] ?? -1;
  if (u(0) === 0xff && u(1) === 0xd8 && u(2) === 0xff)
    return { ext: 'jpg', mime: 'image/jpeg', kind: 'image' };
  if (u(0) === 0x89 && at(1, 'PNG')) return { ext: 'png', mime: 'image/png', kind: 'image' };
  if (at(0, 'GIF8')) return { ext: 'gif', mime: 'image/gif', kind: 'image' };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { ext: 'webp', mime: 'image/webp', kind: 'image' };
  if (at(0, 'RIFF') && at(8, 'WAVE')) return { ext: 'wav', mime: 'audio/wav', kind: 'audio' };
  if (at(0, 'RIFF') && at(8, 'AVI ')) return { ext: 'avi', mime: 'video/x-msvideo', kind: 'video' };
  // ASF (WMV, WMA), MPEG program streams and AIFF: old church clips and PowerPoint media
  // (design/27 §8 "Hub"). ffmpeg decodes them; the delivery is the usual MP4 or m4a.
  if (ASF_HEADER.every((x, i) => b[i] === x)) {
    // The header object lists every stream before any data. A WMA has audio streams only; when the
    // head is too short to tell (large metadata), call it video: transform() makes an audio-only file
    // an audio item.
    if (contains(b, ASF_VIDEO, 30)) return { ext: 'wmv', mime: 'video/x-ms-wmv', kind: 'video' };
    if (contains(b, ASF_AUDIO, 30)) return { ext: 'wma', mime: 'audio/x-ms-wma', kind: 'audio' };
    return { ext: 'asf', mime: 'video/x-ms-asf', kind: 'video' };
  }
  if (u(0) === 0 && u(1) === 0 && u(2) === 1 && u(3) === 0xba)
    return { ext: 'mpg', mime: 'video/mpeg', kind: 'video' }; // MPEG-1/2 program stream pack header
  if (at(0, 'FORM') && (at(8, 'AIFF') || at(8, 'AIFC')))
    return { ext: 'aiff', mime: 'audio/aiff', kind: 'audio' };
  if (at(4, 'ftyp')) {
    const brand = String.fromCharCode(u(8), u(9), u(10), u(11));
    if (brand === 'qt  ') return { ext: 'mov', mime: 'video/quicktime', kind: 'video' };
    if (brand.startsWith('M4A') || brand.startsWith('M4B'))
      return { ext: 'm4a', mime: 'audio/mp4', kind: 'audio' };
    if (brand === 'avif' || brand === 'avis') return { ext: 'avif', mime: 'image/avif', kind: 'image' };
    if (brand === 'heic' || brand === 'mif1') return undefined;
    return { ext: 'mp4', mime: 'video/mp4', kind: 'video' };
  }
  if (u(0) === 0x1a && u(1) === 0x45 && u(2) === 0xdf && u(3) === 0xa3) {
    const head = Buffer.from(b.subarray(0, 64)).toString('latin1');
    return head.includes('webm')
      ? { ext: 'webm', mime: 'video/webm', kind: 'video' }
      : { ext: 'mkv', mime: 'video/x-matroska', kind: 'video' };
  }
  if (at(0, 'fLaC')) return { ext: 'flac', mime: 'audio/flac', kind: 'audio' };
  if (at(0, 'OggS')) return { ext: 'ogg', mime: 'audio/ogg', kind: 'audio' };
  if (at(0, 'ID3')) return { ext: 'mp3', mime: 'audio/mpeg', kind: 'audio' };
  if (u(0) === 0xff && (u(1) & 0xf6) === 0xf0) return { ext: 'aac', mime: 'audio/aac', kind: 'audio' };
  if (u(0) === 0xff && (u(1) & 0xe0) === 0xe0) return { ext: 'mp3', mime: 'audio/mpeg', kind: 'audio' };
  if (at(0, '%PDF')) return { ext: 'pdf', mime: 'application/pdf', kind: 'pdf' };
  if (u(0) === 0x50 && u(1) === 0x4b && u(2) === 0x03 && u(3) === 0x04)
    return { ext: 'zip', mime: 'application/zip', kind: 'zip' };
  if (at(0, 'wOF2')) return { ext: 'woff2', mime: 'font/woff2', kind: 'font' };
  if (at(0, 'wOFF')) return { ext: 'woff', mime: 'font/woff', kind: 'font' };
  if (at(0, 'OTTO')) return { ext: 'otf', mime: 'font/otf', kind: 'font' };
  if ((u(0) === 0 && u(1) === 1 && u(2) === 0 && u(3) === 0) || at(0, 'true'))
    return { ext: 'ttf', mime: 'font/ttf', kind: 'font' };
  // The same rule outputs use to recognise an SVG they cannot decode (domain svg.ts).
  if (looksLikeSvg(b)) return { ext: 'svg', mime: 'image/svg+xml', kind: 'image' };
  return undefined;
}

const EXT_KIND: Record<string, Sniffed['kind']> = {
  svg: 'image',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  wmv: 'video',
  asf: 'video',
  mpg: 'video',
  mpeg: 'video',
  vob: 'video',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  wav: 'audio',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  wma: 'audio',
  aif: 'audio',
  aiff: 'audio',
  aifc: 'audio',
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
  pdf: 'pdf',
  pptx: 'zip',
  zip: 'zip',
  pro: 'zip',
};

/** Extensions of the ASF container (sniffed as wmv, wma or asf). */
const ASF_EXT = new Set(['wmv', 'wma', 'asf']);

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

/**
 * The extension and the sniffed type must agree on the kind of file (an mp4 named .mov is fine;
 * an executable named .png is not). MP4 audio containers sniff as video and are allowed as audio.
 */
export function extensionAgrees(name: string, s: Sniffed): boolean {
  const ext = extOf(name);
  const k = EXT_KIND[ext];
  if (!k) return false;
  if (k === s.kind) return true;
  if (k === 'audio' && s.kind === 'video' && (ext === 'm4a' || ext === 'aac')) return true;
  if (k === 'audio' && s.kind === 'video' && ext === 'ogg') return true;
  if (k === 'video' && s.kind === 'audio' && ext === 'ogg') return true;
  if (k === 'video' && s.kind === 'audio' && (ext === 'mp4' || ext === 'm4v')) return true;
  // One ASF container holds WMV or WMA, and its head may not say which streams it has.
  if (ASF_EXT.has(ext) && ASF_EXT.has(s.ext)) return true;
  return false;
}

/** The most of an ASF header object `readHead` reads: its stream list may follow large metadata. */
export const ASF_HEAD_MAX = 64 * 1024;

/**
 * A file's first `n` bytes, for `sniff`. An ASF file's header object is read whole, up to `ASF_HEAD_MAX`
 * (its size is bytes 16-23): a Header Extension or metadata can push the stream properties, which say
 * whether it is a WMV or a WMA, past `n`.
 */
export async function readHead(path: string, n = 4100): Promise<Uint8Array> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    const head = buf.subarray(0, bytesRead);
    if (bytesRead < 24 || bytesRead < n || !ASF_HEADER.every((x, i) => head[i] === x)) return head;
    const size = Math.min(ASF_HEAD_MAX, Number(head.readBigUInt64LE(16)));
    if (!(size > bytesRead)) return head;
    const more = Buffer.alloc(size);
    const got = await fh.read(more, 0, size, 0);
    return more.subarray(0, got.bytesRead);
  } finally {
    await fh.close();
  }
}

export async function hashFile(path: string): Promise<{ hash: string; bytes: number }> {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    h.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { hash: h.digest('hex'), bytes };
}

/** Content-addressed file store under the data directory. */
export class Store {
  readonly uploads: string;
  constructor(
    readonly dataDir: string,
    private lib: Library,
  ) {
    this.uploads = join(dataDir, 'uploads');
  }

  async init(): Promise<void> {
    for (const d of ['media', 'fonts', 'uploads', 'backups', 'tmp'])
      await mkdir(join(this.dataDir, d), { recursive: true });
  }

  abs(rel: string): string {
    const p = resolve(this.dataDir, rel);
    if (!p.startsWith(resolve(this.dataDir) + sep)) throw new Error('path escapes data dir');
    return p;
  }

  tmpPath(ext = ''): string {
    return join(this.dataDir, 'tmp', `${newId()}${ext ? `.${ext}` : ''}`);
  }
  async tmpDir(): Promise<string> {
    const d = join(this.dataDir, 'tmp', newId());
    await mkdir(d, { recursive: true });
    return d;
  }

  /** Stream into uploads/ while hashing; aborts past `limit` bytes. */
  async receive(
    stream: Readable,
    limit = MAX_UPLOAD_BYTES,
  ): Promise<{ path: string; hash: string; bytes: number }> {
    const path = join(this.uploads, `${newId()}.part`);
    const h = createHash('sha256');
    let bytes = 0;
    const out = createWriteStream(path);
    try {
      await pipeline(
        stream,
        async function* (src: AsyncIterable<Buffer>) {
          for await (const chunk of src) {
            bytes += chunk.length;
            if (bytes > limit) throw tooLarge(limit);
            h.update(chunk);
            yield chunk;
          }
        },
        out,
      );
      if ((stream as { truncated?: boolean }).truncated) throw tooLarge(limit);
    } catch (e) {
      await rm(path, { force: true });
      throw e;
    }
    return { path, hash: h.digest('hex'), bytes };
  }

  /**
   * Move (or copy) a file into the content store and index it. `hash` may be passed when already known.
   * Returns the FileRef with a data-dir-relative path.
   */
  async put(
    src: string,
    opts: {
      ext: string;
      mime: string;
      dir?: 'media' | 'fonts';
      hash?: string;
      bytes?: number;
      copy?: boolean;
    },
  ): Promise<FileRef> {
    const { hash, bytes } =
      opts.hash && opts.bytes !== undefined ? { hash: opts.hash, bytes: opts.bytes } : await hashFile(src);
    const dir = opts.dir ?? 'media';
    const rel =
      dir === 'media' ? `media/${hash.slice(0, 2)}/${hash}.${opts.ext}` : `fonts/${hash}.${opts.ext}`;
    const dest = this.abs(rel);
    const existing = this.lib.getFile(hash);
    const exists = await stat(existing ? this.abs(existing.path) : dest).then(
      () => true,
      () => false,
    );
    if (exists) {
      if (!opts.copy) await rm(src, { force: true });
      if (existing) return { hash, bytes: existing.bytes, mime: existing.mime, path: existing.path };
    } else {
      await mkdir(dirname(dest), { recursive: true });
      if (opts.copy) await copyFile(src, dest);
      else
        await rename(src, dest).catch(async () => {
          await copyFile(src, dest);
          await rm(src, { force: true });
        });
    }
    this.lib.addFile({ hash, bytes, mime: opts.mime, path: rel });
    return { hash, bytes, mime: opts.mime, path: rel };
  }

  /** Store bytes held in memory. */
  async putBytes(
    buf: Uint8Array,
    opts: { ext: string; mime: string; dir?: 'media' | 'fonts' },
  ): Promise<FileRef> {
    const tmp = this.tmpPath(opts.ext);
    await mkdir(dirname(tmp), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tmp, buf);
    const hash = createHash('sha256').update(buf).digest('hex');
    return this.put(tmp, { ...opts, hash, bytes: buf.length });
  }

  /** Remove a stored file when nothing references it any more. */
  async release(hash: string | undefined): Promise<void> {
    if (!hash) return;
    if (this.lib.fileReferenced(hash)) return;
    const f = this.lib.getFile(hash);
    if (!f) return;
    this.lib.deleteFileRow(hash);
    await rm(this.abs(f.path), { force: true });
  }

  rel(abs: string): string {
    return relative(this.dataDir, abs);
  }
}
