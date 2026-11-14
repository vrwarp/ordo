/**
 * Picture preparation (design/27 §4 "Pictures", §12 "Media", §13; M3 item C), so no consumer decodes more
 * than it shows:
 * - the bytes are sniffed and the header checked (`pictureHeader`, `readPictureHeader`): PNG, JPEG, GIF and
 *   WebP; BMP and TIFF recognised for conversion; SVG, EMF and WMF recognised as metafiles, which LibreOffice
 *   converts in the follow-up job (item D); anything else, and every malformed or lying header, refused;
 * - the display need of a part is its widest use in the deck: the box width at 3840 px ÷ the visible crop
 *   fraction (with the picture's size known, the box height counts too), at least 128 and at most 8,192 px;
 * - a source more than 1.25× its need is downscaled by ffmpeg (JPEG at the uploads' quality when opaque, PNG
 *   with alpha); TIFF and BMP become PNG; animated GIF, APNG and animated WebP a first-frame picture, a
 *   multi-page TIFF its first page (logged); ≤ 8,192 px a side, ≤ 40 MP. PowerPoint draws a picture's
 *   stored pixels and ignores an EXIF orientation, which browsers apply, so the orientation is removed: set to
 *   1 in a kept JPEG (two bytes of a copy), left out by a conversion;
 * - stored ready through `addReadyPicture` (no media job), deduplicated through the SHA-256 media hash index
 *   (`mediaParts.ts`): by the prepared bytes, and by the source part's hash with a size that fits the need,
 *   so a second import of the same deck prepares nothing. The original stays in the stored deck;
 * - `storePictures` runs a whole import's pictures with resume pairs [part, media id] that the job persists
 *   (`ctx.setPayload`), so a re-queued job neither prepares nor stores a picture twice. What it logs for the
 *   job log and the import log names the part and ordo's own reason only: a tool's or the file system's
 *   message can name a scratch path, so it goes to the hub's log (`PictureError.detail`), as a clip's does.
 *
 * Every picture is untrusted: headers are read with bounded reads (`PICTURE_LIMITS.scanBytes`), ffmpeg reads
 * a picture only through its checked format's demuxer and decodes within the pixels its header claimed.
 */
import { copyFile, link, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Media } from '@ordo/domain';
import { newId } from '@ordo/domain';
import { type PictureInputFormat, pictureFile } from '../media/ffmpeg.ts';
import { errorMessage } from '../errors.ts';
import { hashFile } from '../store.ts';
import { findMedia, MediaHashes } from './mediaParts.ts';
import type { PptxDeps } from './shared.ts';
import {
  ascii,
  clampNeed,
  displayNeeds,
  exifOrientation,
  fourcc,
  isMetafile,
  METAFILE_FORMATS,
  PICTURE_LIMITS,
  type PictureHeader,
  type PixelSize,
  pictureHeader,
  plausibleBytes,
  scanPicture,
  u24le,
  u32le,
  webpBitstream,
} from '@ordo/importers/pptx-pictures.ts';

// The header checks and display needs are the import core's (`@ordo/importers` `pptx-pictures.ts`), shared
// with the client parse; this module prepares and stores what they accept.
export {
  displayNeeds,
  exifOrientation,
  isMetafile,
  METAFILE_FORMATS,
  PICTURE_LIMITS,
  type PictureHeader,
  pictureHeader,
  plausibleBytes,
};

/**
 * A picture that is not prepared: refused (unknown, malformed, over a limit) or a metafile for LibreOffice.
 * `message` is ordo's own reason, which a job log may show; `detail` is the tool's or the file system's
 * message behind it, which can name a scratch path: for the hub's log only.
 */
export class PictureError extends Error {
  readonly route: 'refused' | 'metafile';
  readonly detail: string | undefined;
  constructor(message: string, route: 'refused' | 'metafile' = 'refused', detail?: string) {
    super(message);
    this.route = route;
    this.detail = detail;
  }
}

/** Bytes read per window by `readPictureHeader`. */
const WINDOW_BYTES = 64 * 1024;

/** `pictureHeader` over a whole file, with positioned reads within `PICTURE_LIMITS.scanBytes`. */
export async function readPictureHeader(path: string): Promise<PictureHeader | undefined> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    let winPos = 0;
    let win = new Uint8Array(0);
    let spent = 0;
    const read = async (pos: number, n: number): Promise<Uint8Array | undefined> => {
      if (pos < 0 || !Number.isFinite(pos)) return new Uint8Array(0);
      if (pos >= size) return new Uint8Array(0);
      const end = Math.min(size, pos + n);
      if (pos >= winPos && end <= winPos + win.length) return win.subarray(pos - winPos, end - winPos);
      const len = Math.min(size - pos, Math.max(n, WINDOW_BYTES));
      if (spent + len > PICTURE_LIMITS.scanBytes) return undefined;
      spent += len;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      winPos = pos;
      win = buf.subarray(0, bytesRead);
      return win.subarray(0, Math.min(bytesRead, end - pos));
    };
    const scan = scanPicture();
    let step = scan.next();
    while (!step.done) {
      const [pos, n] = step.value;
      step = scan.next(await read(pos, n));
    }
    return step.value;
  } finally {
    await fh.close();
  }
}

// ── Preparation ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The size a picture of `width` x `height` (as stored, which is how it is drawn) is prepared at for a need of
 * `needPx`: unchanged unless it is more than `downscaleOver` times the need or over the prepared limits.
 */
export function targetSize(
  width: number,
  height: number,
  needPx: number,
): { width: number; height: number; scaled: boolean } {
  const L = PICTURE_LIMITS;
  const need = clampNeed(needPx);
  const byNeed = width > need * L.downscaleOver ? need / width : 1;
  const byCap = Math.min(
    1,
    L.side / Math.max(width, height),
    Math.sqrt((L.megapixels * 1e6) / (width * height)),
  );
  if (byNeed >= 1 && byCap >= 1) return { width, height, scaled: false };
  let w: number;
  let h: number;
  if (byNeed <= byCap) {
    w = need;
    h = Math.max(1, Math.round((height * need) / width));
  } else {
    w = Math.max(1, Math.floor(width * byCap));
    h = Math.max(1, Math.floor(height * byCap));
  }
  while (w * h > L.megapixels * 1e6 || Math.max(w, h) > L.side) {
    w = Math.max(1, Math.floor(w * 0.999));
    h = Math.max(1, Math.floor(h * 0.999));
  }
  return { width: w, height: h, scaled: true };
}

export type PreparedPicture = {
  /** The prepared file (a scratch file `addReadyPicture` moves into the store). */
  path: string;
  ext: 'png' | 'jpg' | 'gif' | 'webp';
  mime: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  /** SHA-256 of the source part: with the prepared bytes' hash, the dedup key. */
  sourceHash: string;
  /** What was changed (downscaled, converted, first frame), for the job log. */
  notes: string[];
};

/** Decoded megapixels one import may still spend on preparation (`PICTURE_LIMITS.importMegapixels`). */
export class PictureBudget {
  megapixels: number;
  constructor(megapixels: number = PICTURE_LIMITS.importMegapixels) {
    this.megapixels = megapixels;
  }

  spend(mp: number): void {
    if (mp > this.megapixels)
      throw new PictureError(
        `the import's picture budget is spent (${PICTURE_LIMITS.importMegapixels.toLocaleString('en')} MP decoded)`,
      );
    this.megapixels -= mp;
  }
}

export type PrepareOptions = {
  dir: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Shared by the pictures of one import (default: a budget of its own). */
  budget?: PictureBudget;
  /**
   * Where the message behind a picture kept unscaled goes (the tool's or the file system's: it can name a
   * scratch path, so it is never one of the picture's notes). Default: nowhere.
   */
  detail?: (message: string) => void;
};

const READY_FORMATS: ReadonlySet<PictureHeader['format']> = new Set(['png', 'jpeg', 'webp']);
const EXT_OF = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' } as const;
const MIME_OF = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;
const FORMAT_NAME: { readonly [f: string]: string } = {
  png: 'PNG',
  jpeg: 'JPEG',
  gif: 'GIF',
  webp: 'WebP',
  bmp: 'BMP',
  tiff: 'TIFF',
  svg: 'SVG',
  emf: 'EMF',
  wmf: 'WMF',
};

/** The checks every source passes before anything decodes it; throws a `PictureError`. */
export function checkSource(h: PictureHeader | undefined): asserts h is PictureHeader {
  const L = PICTURE_LIMITS;
  if (!h) throw new PictureError('not a picture ordo reads (unknown or malformed header)');
  if (isMetafile(h))
    throw new PictureError(`${FORMAT_NAME[h.format]} picture: LibreOffice converts it`, 'metafile');
  if (h.format === 'other') throw new PictureError('not a picture ordo reads');
  if (!h.width || !h.height) throw new PictureError(`${FORMAT_NAME[h.format]} picture of unknown size`);
  if (h.width > L.sourceSide || h.height > L.sourceSide)
    throw new PictureError(`picture is ${h.width}x${h.height}; the limit is ${L.sourceSide} px a side`);
  if (h.format !== 'jpeg' && h.width * h.height > L.sourceMegapixels * 1e6)
    throw new PictureError(
      `picture is ${h.width}x${h.height} (${Math.round((h.width * h.height) / 1e6)} MP); the limit is ${L.sourceMegapixels} MP`,
    );
}

/** A still WebP of an animated WebP's first frame, and where that frame sits on the canvas. */
export function webpFirstFrame(
  b: Uint8Array,
): { still: Uint8Array; x: number; y: number; width: number; height: number; canvas: PixelSize } | undefined {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP') || fourcc(b, 12) !== 'VP8X')
    return undefined;
  const canvas = { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
  let pos = 12;
  for (let i = 0; i < 10_000 && pos + 8 <= b.length; i++) {
    const size = u32le(b, pos + 4);
    const data = pos + 8;
    if (data + size > b.length) return undefined;
    if (fourcc(b, pos) === 'ANMF' && size >= 16) {
      const x = u24le(b, data) * 2;
      const y = u24le(b, data + 3) * 2;
      const width = u24le(b, data + 6) + 1;
      const height = u24le(b, data + 9) + 1;
      if (x + width > canvas.w || y + height > canvas.h) return undefined;
      // The frame's own chunks: an optional ALPH, then its VP8 or VP8L bitstream.
      let alph: Uint8Array | undefined;
      let p = data + 16;
      while (p + 8 <= data + size) {
        const fcc = fourcc(b, p);
        const n = u32le(b, p + 4);
        if (p + 8 + n > data + size) return undefined;
        // Copied with its pad byte, so every chunk of the still has an even length.
        const chunk = new Uint8Array(8 + n + (n & 1));
        chunk.set(b.subarray(p, p + 8 + n));
        if (fcc === 'ALPH') alph = chunk;
        else if (fcc === 'VP8 ' || fcc === 'VP8L') {
          const s = webpBitstream(fcc, b, p + 8);
          if (!s || s.w !== width || s.h !== height) return undefined;
          const chunks: Uint8Array[] = [];
          if (fcc === 'VP8 ' && alph) {
            const x8 = new Uint8Array(18);
            x8.set([0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0x10]); // 'VP8X', size 10, alpha
            x8.set([(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, ((width - 1) >> 16) & 0xff], 12);
            x8.set([(height - 1) & 0xff, ((height - 1) >> 8) & 0xff, ((height - 1) >> 16) & 0xff], 15);
            chunks.push(x8, alph);
          }
          chunks.push(chunk);
          const body = chunks.reduce((t, c) => t + c.length, 0);
          const still = new Uint8Array(12 + body);
          still.set([0x52, 0x49, 0x46, 0x46]); // 'RIFF'
          const riff = 4 + body;
          still.set([riff & 0xff, (riff >> 8) & 0xff, (riff >> 16) & 0xff, (riff >>> 24) & 0xff], 4);
          still.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
          let at = 12;
          for (const c of chunks) {
            still.set(c, at);
            at += c.length;
          }
          return { still, x, y, width, height, canvas };
        }
        p += 8 + n + (n & 1);
      }
      return undefined;
    }
    pos = data + size + (size & 1);
  }
  return undefined;
}

/**
 * The source as the prepared file, the source left as it is: a hard link (a copy where links are not
 * possible), or a copy with its EXIF orientation set to 1 so browsers draw the pixels as stored.
 */
async function keepAs(src: string, out: string, h: PictureHeader): Promise<void> {
  if (!h.orientation || h.orientationAt === undefined) {
    await link(src, out).catch(() => copyFile(src, out));
    return;
  }
  await copyFile(src, out);
  const fh = await open(out, 'r+');
  try {
    const v = Buffer.alloc(2);
    await fh.read(v, 0, 2, h.orientationAt);
    // A SHORT of 2-8 in either byte order: big-endian [0, v], little-endian [v, 0].
    await fh.write(Buffer.from(v[0] === 0 ? [0, 1] : [1, 0]), 0, 2, h.orientationAt);
  } finally {
    await fh.close();
  }
}

/** `preparePicture` for a source whose header was checked and whose hash is known. */
async function prepareChecked(
  src: string,
  h: PictureHeader,
  sourceHash: string,
  needPx: number,
  opts: PrepareOptions,
): Promise<PreparedPicture> {
  const L = PICTURE_LIMITS;
  const shown = { width: h.width, height: h.height };
  const target = targetSize(shown.width, shown.height, needPx);
  const notes: string[] = [];
  const name = FORMAT_NAME[h.format] ?? h.format;
  const bytes = (await stat(src)).size;
  // Clients read it as it is, and it is within the prepared limits (pixels and bytes): it may stay unscaled.
  const passable =
    bytes <= plausibleBytes(shown.width, shown.height) &&
    READY_FORMATS.has(h.format) &&
    !h.animated &&
    !h.partial &&
    !h.convert &&
    Math.max(shown.width, shown.height) <= L.side &&
    shown.width * shown.height <= L.megapixels * 1e6;
  const keep = async (why?: string): Promise<PreparedPicture> => {
    const ext = EXT_OF[h.format as 'png' | 'jpeg' | 'webp'];
    const out = join(opts.dir, `${newId()}.${ext}`);
    await keepAs(src, out, h);
    if (why) notes.push(`kept as it is: ${why}`);
    if (h.orientation)
      notes.push(`EXIF orientation ${h.orientation} removed (PowerPoint draws it as stored)`);
    const { width, height } = shown;
    return {
      path: out,
      ext,
      mime: MIME_OF[ext],
      width,
      height,
      hasAlpha: h.alpha === true,
      sourceHash,
      notes,
    };
  };
  if (!target.scaled && passable) return keep();
  if (READY_FORMATS.has(h.format) && bytes > plausibleBytes(shown.width, shown.height))
    notes.push(`re-encoded: ${bytes} bytes is more than a ${shown.width}x${shown.height} picture holds`);

  // JPEG decodes at 1/2, 1/4 or 1/8 when the output is still no larger: less memory and time.
  let lowres = 0;
  if (h.format === 'jpeg') {
    while (
      lowres < 3 &&
      Math.ceil(h.width / 2 ** (lowres + 1)) >= target.width &&
      Math.ceil(h.height / 2 ** (lowres + 1)) >= target.height
    )
      lowres++;
  }
  try {
    (opts.budget ?? new PictureBudget()).spend((h.width * h.height) / 4 ** lowres / 1e6);
  } catch (e) {
    if (passable) return keep((e as Error).message);
    throw e;
  }

  const scratch: string[] = [];
  const out = { path: '' };
  try {
    let input = src;
    let canvas: { width: number; height: number; x: number; y: number } | undefined;
    let decoded = { width: h.width, height: h.height };
    if (h.format === 'webp' && h.animated) {
      // ffmpeg reads no animated WebP: its first frame becomes a still WebP first.
      const bytes = await readFile(src);
      if (bytes.length > L.animatedBytes)
        throw new PictureError(`animated WebP over ${L.animatedBytes / 1024 ** 2} MB`);
      const f = webpFirstFrame(bytes);
      if (!f) throw new PictureError('animated WebP without a readable first frame');
      input = join(opts.dir, `${newId()}.webp`);
      scratch.push(input);
      await writeFile(input, f.still);
      if (f.width !== f.canvas.w || f.height !== f.canvas.h || f.x || f.y)
        canvas = { width: f.canvas.w, height: f.canvas.h, x: f.x, y: f.y };
      decoded = { width: f.width, height: f.height };
    }
    const alpha = h.alpha ?? (h.format === 'gif' || h.format === 'png' || h.format === 'webp');
    const ext: 'png' | 'jpg' = alpha ? 'png' : h.format === 'jpeg' || target.scaled ? 'jpg' : 'png';
    // `run` only hears an abort that happens while the tool runs.
    if (opts.signal.aborted) throw new Error('cancelled');
    out.path = join(opts.dir, `${newId()}.${ext}`);
    await pictureFile(input, out.path, {
      input: h.format as PictureInputFormat,
      width: target.width,
      height: target.height,
      output: ext,
      alpha,
      decoded,
      ...(lowres ? { lowres } : {}),
      ...(canvas ? { canvas } : {}),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const got = await readPictureHeader(out.path);
    if (
      !got ||
      got.format !== (ext === 'png' ? 'png' : 'jpeg') ||
      got.width !== target.width ||
      got.height !== target.height
    )
      throw new PictureError('the converted picture is not the size asked for');
    if (target.scaled)
      notes.push(
        `${shown.width}x${shown.height} downscaled to ${target.width}x${target.height} (display need ${clampNeed(needPx)} px)`,
      );
    if (!((h.format === 'png' && ext === 'png') || (h.format === 'jpeg' && ext === 'jpg')))
      notes.push(`${name} converted to ${ext === 'png' ? 'PNG' : 'JPEG'}`);
    if (h.animated)
      notes.push(
        h.format === 'tiff'
          ? 'multi-page TIFF: the first page is kept'
          : h.format === 'png'
            ? 'animated PNG: its still image is kept'
            : `animated ${name}: the first frame is kept`,
      );
    if (h.orientation)
      notes.push(`EXIF orientation ${h.orientation} removed (PowerPoint draws it as stored)`);
    return {
      path: out.path,
      ext,
      mime: MIME_OF[ext],
      width: target.width,
      height: target.height,
      hasAlpha: alpha,
      sourceHash,
      notes,
    };
  } catch (e) {
    if (out.path) await rm(out.path, { force: true });
    if (opts.signal.aborted) throw e;
    // ordo's own reasons may reach a job log; a tool's or the file system's message, which can name the
    // scratch folder, travels as the detail for the hub's log.
    const own = e instanceof PictureError ? e.message : undefined;
    const detail = e instanceof PictureError ? e.detail : errorMessage(e).slice(0, 300);
    // Only the downscale failed: a picture clients read as it is stays, unscaled.
    if (passable) {
      if (detail) opts.detail?.(detail);
      return keep(`it could not be downscaled${own ? ` (${own})` : ''}`);
    }
    throw e instanceof PictureError
      ? e
      : new PictureError(`${name} picture could not be converted`, 'refused', detail);
  } finally {
    for (const f of scratch) await rm(f, { force: true });
  }
}

/** Prepare the picture at `src` for a display need of `needPx` (ffmpeg through `tools.run`). */
export async function preparePicture(
  src: string,
  needPx: number,
  opts: PrepareOptions,
): Promise<PreparedPicture> {
  const h = await readPictureHeader(src);
  checkSource(h);
  const { hash } = await hashFile(src);
  return prepareChecked(src, h, hash, needPx, opts);
}

// ── Storing ──────────────────────────────────────────────────────────────────────────────────────────────

/** A prepared picture stored ready, or the item already holding it. */
async function storeReady(
  deps: Pick<PptxDeps, 'lib' | 'store'>,
  picture: PreparedPicture,
  opts: { name: string; tags: string[] },
): Promise<{ media: Media; reused: boolean }> {
  const L = PICTURE_LIMITS;
  const h = await readPictureHeader(picture.path).catch(() => undefined);
  const why = !h
    ? 'unknown or malformed header'
    : !(h.format in EXT_OF) || EXT_OF[h.format as keyof typeof EXT_OF] !== picture.ext
      ? `a ${FORMAT_NAME[h.format] ?? h.format} file named .${picture.ext}`
      : h.animated || h.partial || h.convert || h.orientation
        ? 'not a still picture every client decodes as stored'
        : h.width !== picture.width || h.height !== picture.height
          ? `${h.width}x${h.height}, not the ${picture.width}x${picture.height} it claims`
          : Math.max(h.width, h.height) > L.side || h.width * h.height > L.megapixels * 1e6
            ? `${h.width}x${h.height} is over ${L.side} px a side or ${L.megapixels} MP`
            : (await stat(picture.path)).size > plausibleBytes(h.width, h.height)
              ? `more bytes than a ${h.width}x${h.height} picture holds`
              : undefined;
  if (why || !h) {
    await rm(picture.path, { force: true });
    throw new PictureError(`prepared picture refused: ${why}`);
  }
  const index = new MediaHashes(deps.lib.db);
  const source = /^[0-9a-f]{64}$/.test(picture.sourceHash) ? picture.sourceHash : undefined;
  const usable = (m: Media) => m.kind === 'image' && m.state !== 'failed';
  const { hash, bytes } = await hashFile(picture.path);
  const reuse = (m: Media) => {
    if (source) index.add(source, 'source', m.id);
    return { media: m, reused: true };
  };
  const before = findMedia(deps, hash, 'content', usable)[0];
  if (before) {
    await rm(picture.path, { force: true });
    return reuse(before);
  }
  const original = await deps.store.put(picture.path, { ext: picture.ext, mime: picture.mime, hash, bytes });
  // Looked up again with no await before the insert: two imports storing the same picture make one item.
  const raced = findMedia(deps, hash, 'content', usable)[0];
  if (raced) return reuse(raced);
  const media = deps.lib.media.insert({
    id: newId(),
    rev: 1,
    name: opts.name.slice(0, 200) || 'Picture',
    tags: opts.tags,
    kind: 'image',
    original,
    state: 'ready',
    width: picture.width,
    height: picture.height,
    hasAlpha: h.alpha ?? picture.hasAlpha,
    loop: false,
    isBackground: false,
  });
  deps.lib.emit([{ kind: 'media', id: media.id, rev: media.rev, entity: media }]);
  if (source) index.add(source, 'source', media.id);
  return { media, reused: false };
}

/** Store a prepared picture as a ready image media item (no job), or return the one already stored. */
export async function addReadyPicture(
  deps: PptxDeps,
  picture: PreparedPicture,
  opts: { name: string; tags: string[] },
): Promise<Media> {
  return (await storeReady(deps, picture, opts)).media;
}

/**
 * A ready item made from the source with this hash that fits a need of `needPx` for a picture of `shown`
 * px (as stored): at least the prepared width that need asks for, at most what a fresh preparation could give
 * (`downscaleOver` × the need). The closest fit wins.
 */
export function findPrepared(
  deps: Pick<PptxDeps, 'lib'>,
  sourceHash: string,
  shown: { width: number; height: number },
  needPx: number,
): Media | undefined {
  const t = targetSize(shown.width, shown.height, needPx);
  const most = Math.max(t.width, clampNeed(needPx) * PICTURE_LIMITS.downscaleOver);
  const fits = findMedia(
    deps,
    sourceHash,
    'source',
    (m) =>
      m.kind === 'image' &&
      m.state === 'ready' &&
      m.width !== undefined &&
      m.width >= t.width - 1 &&
      m.width <= most + 1,
  );
  return fits.sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0];
}

/**
 * The media item for the picture part at `src` (left in place) shown at a need of `needPx`: an item already
 * prepared from the same source that fits, else the picture prepared and stored (deduplicated by its bytes).
 */
export async function pictureFor(
  deps: PptxDeps,
  src: string,
  needPx: number,
  opts: PrepareOptions & { name: string; tags: string[] },
): Promise<{ media: Media; reused: boolean; notes: string[] }> {
  const h = await readPictureHeader(src);
  checkSource(h);
  const { hash } = await hashFile(src);
  const found = findPrepared(deps, hash, { width: h.width, height: h.height }, needPx);
  if (found) return { media: found, reused: true, notes: [] };
  const prepared = await prepareChecked(src, h, hash, needPx, opts);
  const { media, reused } = await storeReady(deps, prepared, opts);
  return { media, reused, notes: prepared.notes };
}

/** One picture part of an import: its spilled file and display need. */
export type PictureItem = { part: string; file: string; need: number };

export type StorePicturesOptions = PrepareOptions & {
  /**
   * Resume pairs [part, media id] already stored (the job payload's `PptxNativeProgress.media`); each new
   * pair is appended here before `save` is called.
   */
  done: [string, string][];
  /** Persist `done` (`ctx.setPayload` with the payload holding it): at most every `saveEveryMs`, and at the end. */
  save(): void;
  saveEveryMs?: number;
  /** The media item's name for a part. */
  name(part: string): string;
  tags: string[];
  /** A note for the job log (deck strings in it are the caller's to sanitise). */
  log(msg: string): void;
  progress?(done: number, of: number): void;
};

export type StorePicturesResult = {
  /** Part → media id, for every part stored (resumed pairs included). */
  media: Map<string, string>;
  /** Parts that are metafiles: LibreOffice converts them (item D). */
  metafiles: string[];
  /** Parts refused or failed, with why. */
  failed: [string, string][];
  /** Pairs taken from `done`, items found prepared already, and pictures prepared now. */
  resumed: number;
  reused: number;
  prepared: number;
};

/**
 * Store an import's pictures (design/27 §2 step 5): each part once, through `pictureFor`, recording a resume
 * pair per part. A re-queued job passes the pairs it persisted and skips those parts; a part stored after
 * the last save is found again through the hash index, so nothing is prepared or stored twice.
 */
export async function storePictures(
  deps: PptxDeps,
  items: readonly PictureItem[],
  opts: StorePicturesOptions,
): Promise<StorePicturesResult> {
  const res: StorePicturesResult = {
    media: new Map(),
    metafiles: [],
    failed: [],
    resumed: 0,
    reused: 0,
    prepared: 0,
  };
  for (const [part, id] of opts.done) {
    const m = deps.lib.media.get(id);
    if (m && m.kind === 'image' && m.state !== 'failed') res.media.set(part, id);
  }
  const budget = opts.budget ?? new PictureBudget();
  const every = opts.saveEveryMs ?? 2_000;
  const resumed = new Set(res.media.keys());
  let lastSave = Date.now();
  let unsaved = false;
  let n = 0;
  try {
    for (const item of items) {
      opts.progress?.(++n, items.length);
      if (opts.signal.aborted) throw new Error('cancelled');
      if (res.media.has(item.part)) {
        if (resumed.delete(item.part)) res.resumed++;
        continue;
      }
      // The hub's log: a tool's or the file system's message, which can name a scratch path.
      const hubLog = (err: string, msg: string) => deps.log.warn({ part: item.part, err }, msg);
      try {
        const got = await pictureFor(deps, item.file, item.need, {
          ...opts,
          budget,
          name: opts.name(item.part),
          tags: opts.tags,
          detail: (err) => hubLog(err, 'pptx picture kept unscaled'),
        });
        res.media.set(item.part, got.media.id);
        opts.done.push([item.part, got.media.id]);
        unsaved = true;
        if (got.reused) res.reused++;
        else res.prepared++;
        for (const note of got.notes) opts.log(`${item.part}: ${note}`);
      } catch (e) {
        if (opts.signal.aborted) throw e;
        if (e instanceof PictureError && e.route === 'metafile') res.metafiles.push(item.part);
        else {
          // The job log and the import log get the part and ordo's own reason only, as a clip's failure does.
          const detail = e instanceof PictureError ? e.detail : errorMessage(e);
          if (detail) hubLog(detail.slice(0, 2_000), 'pptx picture not stored');
          const why = e instanceof PictureError ? e.message.slice(0, 300) : 'it could not be stored';
          res.failed.push([item.part, why]);
          opts.log(`[warn] ${item.part}: ${why}`);
        }
      }
      if (unsaved && Date.now() - lastSave >= every) {
        opts.save();
        unsaved = false;
        lastSave = Date.now();
      }
    }
  } finally {
    // Cancelled or failed half way: what was stored is still recorded.
    if (unsaved) opts.save();
  }
  return res;
}
