import {
  type PictureFrom,
  type PictureTarget,
  decodePlan,
  preparePicture,
  preparePictureSteps,
} from '@ordo/renderer';
import type { DecodeWant, PictureDecoder } from './pictures.ts';

/**
 * The asset worker's picture decoder (design/27 §7.1 and §7.5): a file read from OPFS or the hub and decoded,
 * a target resampled once into an sRGB bitmap of its device size (`preparePicture`, in bands for the raster
 * lanes), a source reduced with high quality.
 *
 * **Crop-aware decode (M7).** Pictures are prepared on the hub for a 3840 px output (design/27 §4), so a 1080p
 * output decodes four times the pixels it shows, and a photo cut by a crop decodes what nobody sees. When
 * every use of a JPEG in a cue shows it at half its size or less, the decoder asks Chromium's `ImageDecoder`
 * for the picture at the next eighth at or above that size (JPEG decoders scale by 1/8 to 8/8 in the
 * inverse DCT, so this is a cheaper decode, not a resample), keeps only the visible crop of it with a margin
 * when that is at most half of it, and hands the part on with where it lies in the picture (`PictureFrom`),
 * so every target is laid out exactly as from the whole picture.
 *
 * Measured in headless Chromium 153 (software, a loaded 4-core container; `asset.lanes.browser.test.ts`
 * checks the geometry): a 3840x2160 JPEG prepared for a 1080p frame took 58-68 ms with its longest task
 * 28-32 ms the full way, 20-29 ms with its longest task 10-14 ms at 4/8; a 6000x4000 photo 117-123 ms
 * (longest 45-46 ms) against 68-95 ms (longest 33-42 ms) at 4/8 and 36-60 ms at 2/8. The pixels differ
 * from the full decode by a mean 0.5-0.7 of 255 (PSNR 41-46 dB): Chromium's two JPEG paths differ that much
 * even at full size. Chromium picks a scale at or below the size asked for, so the size asked for is the
 * eighth itself, and a frame smaller than the need is refused. At 5/8 to 8/8 the gain is small and the full
 * size frame converts slowly on this thread (70-80 ms for 24 MP), so those decode the whole file as before;
 * so do PNG, GIF and WebP (no scaled decode), JPEGs with an EXIF orientation (the hub resets it; an uploaded
 * photo may keep it) and any failure of the scaled path.
 */

/** A decode failure, with the file and where it was read from (an OPFS copy may be corrupt). */
export class DecodeError extends Error {
  readonly hash: string;
  readonly source: 'opfs' | 'network';
  constructor(message: string, hash: string, source: 'opfs' | 'network') {
    super(message);
    this.hash = hash;
    this.source = source;
  }
}

/** The largest scale, in eighths, decoded through the scaled path (see above). */
export const MAX_SCALED_EIGHTHS = 4;
/** Bytes read to find a JPEG's frame header (APP segments before it are usually far smaller). */
const HEADER_BYTES = 256 * 1024;

export type JpegInfo = { width: number; height: number; orientation?: number };

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * A JPEG's size and EXIF orientation from its first bytes: walks the segments to the frame header. Undefined
 * for anything else, a malformed header or one past the bytes given.
 */
export function jpegInfo(b: Uint8Array): JpegInfo | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  let pos = 2;
  let orientation: number | undefined;
  for (let n = 0; n < 4096 && pos + 4 <= b.length; n++) {
    if (b[pos] !== 0xff) return undefined;
    const mk = b[pos + 1]!;
    if (mk === 0xff) {
      pos++;
      continue;
    }
    if ((mk >= 0xd0 && mk <= 0xd7) || mk === 0x01) {
      pos += 2;
      continue;
    }
    if (mk === 0xd8 || mk === 0xd9 || mk === 0xda || mk === 0x00) return undefined;
    const len = u16(pos + 2);
    if (len < 2) return undefined;
    if (SOF.has(mk)) {
      if (pos + 9 > b.length) return undefined;
      const height = u16(pos + 5);
      const width = u16(pos + 7);
      if (!width || !height) return undefined;
      return orientation === undefined ? { width, height } : { width, height, orientation };
    }
    if (mk === 0xe1 && orientation === undefined && pos + 2 + len <= b.length)
      orientation = exifOrientation(b.subarray(pos + 4, pos + 2 + len));
    pos += 2 + len;
  }
  return undefined;
}

/** The orientation (1-8) in an APP1 Exif payload; undefined without one. */
function exifOrientation(seg: Uint8Array): number | undefined {
  const at = (i: number, s: string) => [...s].every((c, k) => seg[i + k] === c.charCodeAt(0));
  if (seg.length < 14 || !at(0, 'Exif\0\0')) return undefined;
  const t = seg.subarray(6);
  const le = at(6, 'II');
  if (!le && !at(6, 'MM')) return undefined;
  const r16 = (i: number) => (le ? t[i]! | (t[i + 1]! << 8) : (t[i]! << 8) | t[i + 1]!);
  const r32 = (i: number) =>
    le
      ? (t[i]! | (t[i + 1]! << 8) | (t[i + 2]! << 16) | (t[i + 3]! << 24)) >>> 0
      : ((t[i]! << 24) | (t[i + 1]! << 16) | (t[i + 2]! << 8) | t[i + 3]!) >>> 0;
  if (r16(2) !== 42) return undefined;
  const ifd = r32(4);
  if (ifd < 8 || ifd + 2 > t.length) return undefined;
  const n = Math.min(r16(ifd), 1024);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return undefined;
    if (r16(e) !== 0x0112) continue;
    const v = r16(e + 8);
    return v >= 1 && v <= 8 ? v : undefined;
  }
  return undefined;
}

/** A scaled decode: the eighths and size asked for, the scale the uses need, and the part they show. */
export type ScaledPlan = {
  eighths: number;
  w: number;
  h: number;
  /** Device pixels per picture pixel the uses need (the decode is at least this). */
  need: number;
  /** The part of the picture the targets show (picture pixels); absent when the whole is needed. */
  region?: { x: number; y: number; w: number; h: number };
};

/**
 * How to decode an `iw` x `ih` JPEG for `want`: undefined when the uses need more than
 * `MAX_SCALED_EIGHTHS` eighths of it (or nothing can be said), so it is decoded whole.
 */
export function scaledPlan(iw: number, ih: number, want: DecodeWant): ScaledPlan | undefined {
  if (!(iw > 0 && ih > 0)) return undefined;
  let need = 0;
  let region: ScaledPlan['region'];
  if (want.targets?.length) {
    const p = decodePlan(want.targets, iw, ih);
    if (!p) return undefined;
    need = p.scale;
    region = { x: p.x, y: p.y, w: p.w, h: p.h };
  }
  if (want.cover) {
    // The source drawn for the output: the whole picture, covering it.
    need = Math.max(need, want.cover.w / iw, want.cover.h / ih);
    region = undefined;
  }
  if (!(need > 0) || !Number.isFinite(need)) return undefined;
  const eighths = Math.max(1, Math.ceil(8 * need - 1e-9));
  if (eighths > MAX_SCALED_EIGHTHS) return undefined;
  return { eighths, w: Math.ceil((iw * eighths) / 8), h: Math.ceil((ih * eighths) / 8), need, region };
}

/**
 * The part of a decoded frame (`fw` x `fh` of an `iw` x `ih` picture) to keep for `region`: whole pixels
 * around it with a margin of twice the resampling footprint plus two pixels, so the edges of what is kept
 * lie outside every box; undefined when that is more than half the frame (the whole frame is kept).
 */
export function cropRect(
  region: { x: number; y: number; w: number; h: number },
  need: number,
  fw: number,
  fh: number,
  iw: number,
  ih: number,
): { x: number; y: number; w: number; h: number } | undefined {
  const ax = fw / iw;
  const ay = fh / ih;
  const pad = Math.ceil((2 * Math.max(ax, ay)) / need) + 2;
  const x0 = Math.max(0, Math.floor(region.x * ax) - pad);
  const y0 = Math.max(0, Math.floor(region.y * ay) - pad);
  const x1 = Math.min(fw, Math.ceil((region.x + region.w) * ax) + pad);
  const y1 = Math.min(fh, Math.ceil((region.y + region.h) * ay) + pad);
  if (!(x1 > x0 && y1 > y0) || (x1 - x0) * (y1 - y0) > 0.5 * fw * fh) return undefined;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

type ImageDecoderLike = {
  decode(o?: { frameIndex?: number }): Promise<{ image: VideoFrame }>;
  close(): void;
};
export type ImageDecoderCtor = new (init: {
  data: ReadableStream<Uint8Array> | BufferSource;
  type: string;
  desiredWidth?: number;
  desiredHeight?: number;
  preferAnimation?: boolean;
}) => ImageDecoderLike;

export type DecoderDeps = {
  read(hash: string): Promise<{ blob: Blob; source: 'opfs' | 'network' }>;
  createImageBitmap: (
    src: ImageBitmapSource,
    ...args: number[] | [ImageBitmapOptions?]
  ) => Promise<ImageBitmap>;
  /** WebCodecs' ImageDecoder (secure contexts; the venue serves HTTPS), absent where there is none. */
  ImageDecoder?: ImageDecoderCtor;
};

/** Counters of the decodes made (diagnostics): whole files, scaled ones, and those kept as a crop. */
export type DecodeStats = { full: number; scaled: number; cropped: number; refused: number };

export type Decoder = PictureDecoder<ImageBitmap> & { stats: DecodeStats };

export function createDecoder(deps: DecoderDeps): Decoder {
  /** Where a scaled or cropped decode lies in its picture. */
  const fromOf = new WeakMap<object, PictureFrom>();
  const stats: DecodeStats = { full: 0, scaled: 0, cropped: 0, refused: 0 };
  const cib = deps.createImageBitmap as (...a: unknown[]) => Promise<ImageBitmap>;

  async function scaled(blob: Blob, want: DecodeWant): Promise<ImageBitmap | undefined> {
    const Ctor = deps.ImageDecoder;
    if (!Ctor) return undefined;
    const head = new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer());
    const info = jpegInfo(head);
    if (!info || (info.orientation !== undefined && info.orientation !== 1)) return undefined;
    const plan = scaledPlan(info.width, info.height, want);
    if (!plan) return undefined;
    const dec = new Ctor({
      data: blob.stream(),
      type: 'image/jpeg',
      desiredWidth: plan.w,
      desiredHeight: plan.h,
      preferAnimation: false,
    });
    let frame: VideoFrame | undefined;
    try {
      frame = (await dec.decode({ frameIndex: 0 })).image;
    } finally {
      dec.close();
    }
    try {
      const fw = frame.displayWidth;
      const fh = frame.displayHeight;
      // Smaller than the uses need (Chromium picks an eighth at or below the size asked for), or not the
      // picture's shape (an orientation applied after all): decoded whole instead.
      if (
        !(fw > 0 && fh > 0 && fw <= info.width && fh <= info.height) ||
        Math.min(fw / info.width, fh / info.height) < plan.need * (1 - 1e-6) ||
        Math.abs(fw * info.height - fh * info.width) > info.width + info.height
      ) {
        stats.refused++;
        return undefined;
      }
      const c = plan.region && cropRect(plan.region, plan.need, fw, fh, info.width, info.height);
      const bmp = c ? await cib(frame, c.x, c.y, c.w, c.h) : await cib(frame);
      const ax = fw / info.width;
      const ay = fh / info.height;
      fromOf.set(
        bmp,
        c
          ? { iw: info.width, ih: info.height, x: c.x / ax, y: c.y / ay, w: c.w / ax, h: c.h / ay }
          : { iw: info.width, ih: info.height, x: 0, y: 0, w: info.width, h: info.height },
      );
      stats.scaled++;
      if (c) stats.cropped++;
      return bmp;
    } finally {
      frame.close();
    }
  }

  return {
    stats,
    async decode(hash, want) {
      const { blob, source } = await deps.read(hash);
      if (want) {
        try {
          const bmp = await scaled(blob, want);
          if (bmp) return bmp;
        } catch {
          /* the whole file below */
        }
      }
      try {
        const bmp = await cib(blob);
        stats.full++;
        return bmp;
      } catch (err) {
        throw new DecodeError(
          `image ${hash.slice(0, 8)} could not be decoded: ${(err as Error).message}`,
          hash,
          source,
        );
      }
    },
    partial: (src) => {
      const f = fromOf.get(src);
      return !!f && (f.x > 0 || f.y > 0 || f.w < f.iw || f.h < f.ih);
    },
    prepare: (src, t: PictureTarget) => preparePicture(src, t, fromOf.get(src)),
    prepareSteps: (src, t: PictureTarget) => preparePictureSteps(src, t, fromOf.get(src)),
    reduce: (src, w, h) => cib(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }),
  };
}
