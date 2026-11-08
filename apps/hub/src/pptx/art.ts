/**
 * Worker side of the `pptx-art` pool task (design/27 §2, §5 step 4; M3 item D): a hybrid slide's
 * transparent art picture from the same page printed twice by LibreOffice, over two forced backgrounds:
 * white and black in the design's terms (`ArtTaskInput.white`, `.black`), which may be any two colours
 * (`colors`; the follow-up uses white and yellow, `@ordo/pptx-scene` `PAGE_BACKGROUNDS`).
 *
 * A pixel of colour c and coverage alpha printed over background B shows alpha·c + (1 − alpha)·B per channel.
 * With W and K the two backgrounds: alpha = 1 − max_c((white_c − black_c)/(W_c − K_c)) over the channels
 * where they differ, and colour_c = (black_c − (1 − alpha)·K_c)/alpha (0 where alpha is 0), clamped to
 * 0-255. Over white and black that is alpha = 1 − max(white − black)/255 and colour = black/alpha. Only
 * `input.box` is considered; the result is cropped to the bounding box of the pixels whose alpha is not 0
 * (or keeps the whole box with `whole`). Pure arithmetic over the two rasters; the PNG is encoded here when
 * asked (`encode`), so a large picture never crosses back to the event loop as pixels.
 *
 * Also here, for the job: `readPpm` (pdftoppm's raw output) and `encodePng`.
 */
import { crc32, deflateSync } from 'node:zlib';
import type { ArtTaskInput, ArtTaskOutput, RasterImage } from './shared.ts';

/** Largest page side the task accepts (pdftoppm pages are 2 px per logical px: 3840 at 16:9). */
export const ART_MAX_SIDE = 16_384;
/** Largest page area the task accepts, in pixels. */
export const ART_MAX_PIXELS = 64 * 1024 * 1024;

function check(img: RasterImage, what: string): void {
  const { width: w, height: h, channels: c } = img;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > ART_MAX_SIDE || h > ART_MAX_SIDE)
    throw new Error(`the ${what} page has an invalid size`);
  if (w * h > ART_MAX_PIXELS) throw new Error(`the ${what} page is too large`);
  if (c !== 3 && c !== 4) throw new Error(`the ${what} page has ${c} channels`);
  if (!(img.data instanceof Uint8Array) || img.data.length < w * h * c)
    throw new Error(`the ${what} page has too few pixels`);
}

export function artTask(input: ArtTaskInput): ArtTaskOutput {
  const { white, black } = input;
  check(white, 'white');
  check(black, 'black');
  if (white.width !== black.width || white.height !== black.height)
    throw new Error('the white and black pages differ in size');
  const W = white.width;
  const H = white.height;
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);
  const x0 = Math.max(0, Math.min(W, Math.floor(fin(input.box.x))));
  const y0 = Math.max(0, Math.min(H, Math.floor(fin(input.box.y))));
  const x1 = Math.max(x0, Math.min(W, Math.ceil(fin(input.box.x) + Math.max(0, fin(input.box.w)))));
  const y1 = Math.max(y0, Math.min(H, Math.ceil(fin(input.box.y) + Math.max(0, fin(input.box.h)))));
  const wc = white.channels;
  const bc = black.channels;
  const wd = white.data;
  const bd = black.data;
  const W0 = input.colors?.white ?? [255, 255, 255];
  const K0 = input.colors?.black ?? [0, 0, 0];
  /** Channels where the backgrounds differ, with 255 / (W − K): they carry the alpha. */
  const span: [number, number][] = [];
  for (let c = 0; c < 3; c++) {
    const d = (W0[c] ?? 0) - (K0[c] ?? 0);
    if (Math.abs(d) >= 32) span.push([c, 255 / d]);
  }
  if (!span.length) throw new Error('the two backgrounds are too alike to tell alpha');
  /** 255 − max((white − black)·255/(W − K)), clamped: the pixel's alpha in 0-255. */
  const alphaAt = (x: number, y: number) => {
    const wi = (y * W + x) * wc;
    const bi = (y * W + x) * bc;
    let d = 0;
    for (const [c, k] of span) {
      const v = (wd[wi + c]! - bd[bi + c]!) * k;
      if (v > d) d = v;
    }
    return 255 - Math.min(255, Math.round(d));
  };
  // The visible pixels' bounding box inside the box.
  let bx0 = x1;
  let by0 = y1;
  let bx1 = x0;
  let by1 = y0;
  if (input.whole) {
    bx0 = x0;
    by0 = y0;
    bx1 = x1;
    by1 = y1;
  } else
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        if (alphaAt(x, y) > 0) {
          if (x < bx0) bx0 = x;
          if (x >= bx1) bx1 = x + 1;
          if (y < by0) by0 = y;
          if (y >= by1) by1 = y + 1;
        }
  const empty = !(bx1 > bx0 && by1 > by0);
  if (empty)
    return {
      image: { width: 0, height: 0, channels: 4, data: new Uint8Array(0) },
      at: { x: x0, y: y0 },
      empty,
    };
  const w = bx1 - bx0;
  const h = by1 - by0;
  const out = new Uint8Array(w * h * 4);
  let visible = false;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = alphaAt(bx0 + x, by0 + y);
      if (a === 0) continue;
      visible = true;
      const bi = ((by0 + y) * W + bx0 + x) * bc;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = (bd[bi + c]! * 255 - (255 - a) * (K0[c] ?? 0)) / a;
        out[o + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
      out[o + 3] = a;
    }
  const image: RasterImage = { width: w, height: h, channels: 4, data: out };
  if (!input.encode) return { image, at: { x: bx0, y: by0 }, empty: !visible };
  return {
    image: { width: w, height: h, channels: 4, data: new Uint8Array(0) },
    at: { x: bx0, y: by0 },
    empty: !visible,
    png: encodePng(image),
  };
}

/**
 * pdftoppm's raw output (binary PPM, `P6`, 8 bits) as an RGB raster viewing the same bytes. Throws on
 * anything else.
 */
export function readPpm(buf: Uint8Array): RasterImage {
  let at = 0;
  const token = (): string => {
    for (;;) {
      while (
        at < buf.length &&
        (buf[at] === 0x20 || buf[at] === 0x0a || buf[at] === 0x0d || buf[at] === 0x09)
      )
        at++;
      if (buf[at] === 0x23) {
        while (at < buf.length && buf[at] !== 0x0a) at++;
        continue;
      }
      break;
    }
    const start = at;
    while (at < buf.length && at - start < 16 && buf[at]! > 0x20) at++;
    return String.fromCharCode(...buf.subarray(start, at));
  };
  if (token() !== 'P6') throw new Error('not a binary PPM');
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  at++; // the single whitespace before the pixels
  if (!(width >= 1 && height >= 1 && width <= ART_MAX_SIDE && height <= ART_MAX_SIDE) || max !== 255)
    throw new Error('an unsupported PPM');
  if (buf.length - at < width * height * 3) throw new Error('a truncated PPM');
  return { width, height, channels: 3, data: buf.subarray(at, at + width * height * 3) };
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A PNG of an RGB or RGBA raster (8 bits, straight alpha). Each row takes the filter (none, sub or up) with
 * the smallest sum of magnitudes, the usual heuristic: flat art and transparent margins compress to little.
 */
export function encodePng(img: RasterImage): Uint8Array {
  const { width: w, height: h, channels: c, data } = img;
  const stride = w * c;
  const raw = Buffer.alloc((stride + 1) * h);
  const sub = new Uint8Array(stride);
  const up = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : undefined;
    let sNone = 0;
    let sSub = 0;
    let sUp = 0;
    for (let i = 0; i < stride; i++) {
      const v = row[i]!;
      const s = (v - (i >= c ? row[i - c]! : 0)) & 0xff;
      const u = (v - (prev ? prev[i]! : 0)) & 0xff;
      sub[i] = s;
      up[i] = u;
      sNone += v < 128 ? v : 256 - v;
      sSub += s < 128 ? s : 256 - s;
      sUp += u < 128 ? u : 256 - u;
    }
    const o = y * (stride + 1);
    if (sSub <= sNone && sSub <= sUp) {
      raw[o] = 1;
      raw.set(sub, o + 1);
    } else if (sUp <= sNone) {
      raw[o] = 2;
      raw.set(up, o + 1);
    } else {
      raw[o] = 0;
      raw.set(row, o + 1);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = c === 4 ? 6 : 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
