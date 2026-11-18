/**
 * Builders shared by the prerender-store tests (slide files, keys, pictures, goLive, collection): synthetic big
 * slides made by the domain's own `withFullSlide`, their slide files uploaded through the API, presentations
 * that carry their stand-ins, and valid PNG and WebP bytes. Nothing here is a third-party deck's.
 */
import { deflateSync } from 'node:zlib';
import {
  DEFAULT_LYRIC_STYLE,
  newId,
  type Presentation,
  type ShapeObject,
  type Slide,
  type SlideObject,
  type TextObject,
} from '@ordo/domain';
import { type FullSlideResult, type PictureInputs, withFullSlide } from '@ordo/domain/prerender.ts';
import { canonicalJson } from '@ordo/domain/palette.ts';
import type { SlideFile } from '@ordo/domain/slidefile.ts';
import type { Client } from './helpers.ts';
import { song } from './helpers.ts';

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });

export function rect(id: string, b = box(0, 0, 10, 10), extra: Partial<ShapeObject> = {}): ShapeObject {
  return {
    id,
    type: 'shape',
    box: b,
    shape: 'rect',
    fill: { r: 200, g: 0, b: 0, a: 1 },
    opacity: 1,
    radius: 0,
    ...extra,
  } as ShapeObject;
}

export function textObject(id: string, t: string, b = box(0, 0, 400, 100), extra: Partial<TextObject> = {}) {
  return {
    id,
    type: 'text',
    box: b,
    text: t,
    style: { ...DEFAULT_LYRIC_STYLE },
    opacity: 1,
    ...extra,
  } as TextObject;
}

/** A crowded slide: a background, `n` small rectangles (so it passes the live count), a title and the lyric box. */
export function bigSlide(id = 'big', n = 300, tag = ''): Slide {
  const objects: SlideObject[] = [rect('bg', box(0, 0, 1920, 1080), { fill: { r: 10, g: 20, b: 30, a: 1 } })];
  for (let i = 0; i < n; i++) objects.push(rect(`r${i}`, box(i * 6, 200, 5, 5)));
  objects.push(textObject('title', `Title ${tag}`, box(0, 0, 500, 100)));
  objects.push(textObject('lyric', 'Lyric', box(0, 900, 500, 100)));
  return { id, objects, lyricObjectId: 'lyric', notes: 'n' };
}

export const FONTS = [{ family: 'Carlito', file: { hash: 'c'.repeat(64) } }];

export function pictureInputs(
  files: Record<string, string> = {},
  fonts: PictureInputs['fonts'] = FONTS,
): PictureInputs {
  return { mediaFile: (id) => files[id], fonts };
}

/** `withFullSlide` of a big slide: the stand-in, the slide file (head and pages), its head's name and the key. */
export function fullOf(
  slide: Slide = bigSlide(),
  inputs: PictureInputs = pictureInputs(),
): FullSlideResult & { standIn: Slide; pages: SlideFile; key: string; standbyId: string; name: string } {
  const r = withFullSlide(slide, (s) => s, inputs);
  if (!r.pages || !r.key || !r.standbyId) throw new Error('the slide did not get a file');
  return { ...r, standIn: r.standIn, pages: r.pages, key: r.key, standbyId: r.standbyId, name: r.pages.name };
}

/** PUT the pages of a slide file, then its head, as a writer of the editor does. Returns the head's name. */
export async function uploadSlideFile(c: Client, file: SlideFile): Promise<string> {
  for (const p of file.pages) {
    const r = await c.fetch(`/files/slide/${p.name}`, { method: 'PUT', json: p.page });
    if (r.status !== 200 && r.status !== 201)
      throw new Error(`page ${p.name}: ${r.status} ${await r.text()}`);
  }
  const r = await c.fetch(`/files/slide/${file.name}`, { method: 'PUT', json: file.head });
  if (r.status !== 200 && r.status !== 201) throw new Error(`head: ${r.status} ${await r.text()}`);
  return file.name;
}

/** A presentation holding these slides in one section. */
export function presentationOf(slides: Slide[], title = 'Pre-rendered'): Presentation {
  const base = song(title);
  const sid = newId();
  return {
    ...base,
    sections: [{ id: sid, label: 'Slides', short: 'S', slides }],
    arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid] }],
  };
}

/** The canonical bytes of a part, as the hub stores them. */
export const canonicalBytes = (part: unknown): Buffer => Buffer.from(canonicalJson(part), 'utf8');

// ── pictures ──────────────────────────────────────────────────────────────────────────────────────────────

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A valid PNG of `w` x `h`: flat colour (small), or `noise` random bytes at zlib level 0 (`bytes` about that
 * large: a 4K picture of 20 MiB). RGBA (alpha, `opaque` false) or RGB.
 */
export function makePng(
  w: number,
  h: number,
  opts: { alpha?: boolean; noise?: boolean; seed?: number; animated?: boolean } = {},
): Buffer {
  const channels = opts.alpha ? 4 : 3;
  const row = 1 + w * channels;
  const raw = Buffer.alloc(row * h);
  if (opts.noise) {
    let s = (opts.seed ?? 1) >>> 0 || 1;
    for (let i = 0; i < raw.length; i += 4) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      raw.writeUInt32LE(s, i);
    }
    for (let y = 0; y < h; y++) raw[y * row] = 0;
  } else {
    const c = (opts.seed ?? 7) & 0xff;
    for (let y = 0; y < h; y++) raw.fill(c, y * row + 1, (y + 1) * row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = opts.alpha ? 6 : 2;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (opts.animated) {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(2, 0);
    parts.push(chunk('acTL', actl));
  }
  parts.push(chunk('IDAT', deflateSync(raw, { level: opts.noise ? 0 : 1 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/**
 * A WebP of `w` x `h` the hub's header reader accepts: a lossless image chunk whose header says the size (the
 * bytes after it are not pixels), or, animated, an extended file whose header announces the frames.
 */
export function makeWebp(w: number, h: number, opts: { alpha?: boolean; animated?: boolean } = {}): Buffer {
  let body: Buffer;
  if (opts.animated) {
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x02 | (opts.alpha ? 0x10 : 0);
    vp8x.writeUIntLE(w - 1, 4, 3);
    vp8x.writeUIntLE(h - 1, 7, 3);
    body = Buffer.concat([Buffer.from('WEBP', 'ascii'), riff('VP8X', vp8x), riff('ANIM', Buffer.alloc(6))]);
  } else {
    const vp8l = Buffer.alloc(13);
    vp8l[0] = 0x2f;
    vp8l.writeUInt32LE(((w - 1) | ((h - 1) << 14) | ((opts.alpha ? 1 : 0) << 28)) >>> 0, 1);
    body = Buffer.concat([Buffer.from('WEBP', 'ascii'), riff('VP8L', vp8l)]);
  }
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
function riff(tag: string, data: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(tag, 0, 'ascii');
  h.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([h, data, pad]);
}
