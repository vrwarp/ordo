/**
 * Picture preparation and the media hash index (M3 item C, design/27 §4 "Pictures", §12 "Media", §13):
 * header checks on generated pictures of every accepted format and on corrupt or lying ones, display needs,
 * preparation (a 48 MP photo, conversions, first frames, EXIF orientation), ready storage with dedup across
 * imports, resume pairs, the ProPresenter path through `mediaForFile`, and migration 8 on an existing library.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Slide } from '@ordo/domain';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../src/db.ts';
import { findMedia, MediaHashes, mediaForFile } from '../src/pptx/mediaParts.ts';
import {
  addReadyPicture,
  displayNeeds,
  exifOrientation,
  PICTURE_LIMITS,
  PictureBudget,
  PictureError,
  type PreparedPicture,
  pictureFor,
  pictureHeader,
  preparePicture,
  readPictureHeader,
  storePictures,
  targetSize,
  webpFirstFrame,
} from '../src/pptx/pictures.ts';
import type { PptxDeps } from '../src/pptx/shared.ts';
import { ffmpeg } from './fixtures.ts';
import { startHub, type TestHub, tempDir } from './helpers.ts';

const fx = tempDir('ordo-pictures-');
afterAll(() => rmSync(fx, { recursive: true, force: true }));
const lavfi = (src: string) => ['-f', 'lavfi', '-i', src, '-frames:v', '1'];

/** Generated pictures, cached in `fx`. */
const pic = {
  png: () => ffmpeg(fx, 'opaque.png', lavfi('testsrc=size=64x48')),
  pngAlpha: () => ffmpeg(fx, 'alpha.png', lavfi('color=c=red@0.5:s=640x480,format=rgba')),
  bigPng: () => ffmpeg(fx, 'big.png', lavfi('testsrc2=size=4000x3000')),
  jpg: () => ffmpeg(fx, 'small.jpg', lavfi('testsrc=size=64x48')),
  /** A 48 MP synthetic photo (8000x6000). */
  photo48: () => ffmpeg(fx, 'photo48.jpg', [...lavfi('testsrc2=size=8000x6000'), '-q:v', '3']),
  progressive: () =>
    ffmpeg(fx, 'progressive.jpg', [...lavfi('testsrc=size=320x240'), '-c:v', 'mjpeg', '-q:v', '3']),
  gif: () => ffmpeg(fx, 'anim.gif', ['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=0.5']),
  stillGif: () => ffmpeg(fx, 'one.gif', lavfi('color=c=red:s=32x32')),
  apng: () =>
    ffmpeg(fx, 'anim-apng.png', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x48:rate=5:duration=1',
      '-plays',
      '0',
      '-f',
      'apng',
    ]),
  webp: () => ffmpeg(fx, 'lossy.webp', [...lavfi('testsrc=size=64x48'), '-c:v', 'libwebp']),
  webpAlpha: () =>
    ffmpeg(fx, 'lossless.webp', [
      ...lavfi('color=c=red@0.5:s=64x48,format=rgba'),
      '-c:v',
      'libwebp',
      '-lossless',
      '1',
    ]),
  webpAnim: () =>
    ffmpeg(fx, 'anim.webp', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x48:rate=5:duration=1',
      '-c:v',
      'libwebp',
      '-loop',
      '0',
    ]),
  bmp: () => ffmpeg(fx, 'opaque.bmp', lavfi('testsrc=size=64x48')),
  bmpAlpha: () => ffmpeg(fx, 'alpha.bmp', lavfi('color=c=red@0.5:s=64x48,format=bgra')),
  tiff: () => ffmpeg(fx, 'alpha.tif', lavfi('color=c=red@0.5:s=64x48,format=rgba')),
};

function file(name: string, bytes: Uint8Array): string {
  const p = join(fx, name);
  writeFileSync(p, bytes);
  return p;
}

/** A JPEG with an APP1 Exif segment carrying `orientation`, inserted after SOI. */
function withOrientation(jpg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0,
    0,
    0,
    8,
    0,
    1,
    0x01,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    orientation,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = payload.length + 2;
  return Buffer.concat([
    jpg.subarray(0, 2),
    Buffer.from([0xff, 0xe1, len >> 8, len & 0xff]),
    payload,
    jpg.subarray(2),
  ]);
}

/** A PNG whose IHDR claims `w` x `h`, with a valid CRC (and image data for 1x1). */
function pngClaiming(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A JPEG whose frame header claims `w` x `h` (the scan data is still the small picture's). */
function jpegClaiming(src: Buffer, w: number, h: number): Buffer {
  const b = Buffer.from(src);
  let i = 2;
  while (i < b.length) {
    const mk = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (mk === 0xc0 || mk === 0xc1 || mk === 0xc2) {
      b.writeUInt16BE(h, i + 5);
      b.writeUInt16BE(w, i + 7);
      return b;
    }
    i += 2 + len;
  }
  throw new Error('no frame header');
}

/** An EMF header record (88 bytes): bounds 0,0-99,49. */
function emf(): Buffer {
  const b = Buffer.alloc(88);
  b.writeUInt32LE(1, 0);
  b.writeUInt32LE(88, 4);
  b.writeInt32LE(0, 8);
  b.writeInt32LE(0, 12);
  b.writeInt32LE(99, 16);
  b.writeInt32LE(49, 20);
  b.write(' EMF', 40, 'latin1');
  return b;
}

/** A placeable WMF header (1 x 0.5 inch at 1440 units an inch) and the standard header after it. */
function wmf(): Buffer {
  const b = Buffer.alloc(40);
  b.writeUInt32LE(0x9ac6cdd7, 0);
  b.writeInt16LE(0, 6);
  b.writeInt16LE(0, 8);
  b.writeInt16LE(1440, 10);
  b.writeInt16LE(720, 12);
  b.writeUInt16LE(1440, 14);
  b.writeUInt16LE(1, 22);
  b.writeUInt16LE(9, 24);
  b.writeUInt16LE(0x300, 26);
  return b;
}

/** RGB(A) pixels of a picture, decoded by ffmpeg. */
function pixels(path: string, fmt: 'rgb24' | 'rgba' = 'rgb24'): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', fmt, '-'], {
    maxBuffer: 512 * 1024 * 1024,
  });
}

const head = async (p: string) => readPictureHeader(p);

/** `addReadyPicture` up to its checks (a refused picture never reaches the library). */
const addReadyPictureCheck = (picture: PreparedPicture) =>
  addReadyPicture({} as PptxDeps, picture, { name: 'x', tags: [] });

describe('picture headers', () => {
  it('reads every accepted format from its header', async () => {
    expect(await head(pic.png())).toEqual({
      format: 'png',
      width: 64,
      height: 48,
      animated: false,
      alpha: false,
    });
    expect(await head(pic.pngAlpha())).toMatchObject({ format: 'png', width: 640, height: 480, alpha: true });
    expect(await head(pic.jpg())).toEqual({
      format: 'jpeg',
      width: 64,
      height: 48,
      animated: false,
      alpha: false,
    });
    expect(await head(pic.photo48())).toMatchObject({ format: 'jpeg', width: 8000, height: 6000 });
    expect(await head(pic.gif())).toMatchObject({ format: 'gif', width: 64, height: 48, animated: true });
    expect(await head(pic.stillGif())).toEqual({
      format: 'gif',
      width: 32,
      height: 32,
      animated: false,
      alpha: false,
    });
    expect(await head(pic.apng())).toMatchObject({ format: 'png', width: 64, height: 48, animated: true });
    expect(await head(pic.webp())).toEqual({
      format: 'webp',
      width: 64,
      height: 48,
      animated: false,
      alpha: false,
    });
    expect(await head(pic.webpAlpha())).toMatchObject({ format: 'webp', width: 64, height: 48, alpha: true });
    expect(await head(pic.webpAnim())).toMatchObject({
      format: 'webp',
      width: 64,
      height: 48,
      animated: true,
    });
    expect(await head(pic.bmp())).toEqual({
      format: 'bmp',
      width: 64,
      height: 48,
      animated: false,
      alpha: false,
    });
    expect(await head(pic.bmpAlpha())).toMatchObject({ format: 'bmp', width: 64, height: 48 });
    expect(await head(pic.tiff())).toEqual({
      format: 'tiff',
      width: 64,
      height: 48,
      animated: false,
      alpha: true,
    });
  });

  it('recognises metafiles for LibreOffice', async () => {
    expect(await head(file('m.emf', emf()))).toEqual({
      format: 'emf',
      width: 100,
      height: 50,
      animated: false,
    });
    expect(await head(file('m.wmf', wmf()))).toEqual({
      format: 'wmf',
      width: 96,
      height: 48,
      animated: false,
    });
    const svg = '﻿<?xml version="1.0"?>\n<!-- art -->\n<svg xmlns="http://www.w3.org/2000/svg" width="10"/>';
    expect(await head(file('m.svg', Buffer.from(svg)))).toMatchObject({ format: 'svg' });
  });

  it('reads EXIF orientation and keeps scanning past a large segment', async () => {
    const turned = withOrientation(readFileSync(pic.jpg()), 6);
    expect(await head(file('turned.jpg', turned))).toMatchObject({
      format: 'jpeg',
      width: 64,
      height: 48,
      orientation: 6,
    });
    expect(exifOrientation(Buffer.from('Exif\0\0MM\0\x2a\0\0\0\x08\0\0', 'latin1'))).toBeUndefined();
    // A 60 KB comment before the frame header: past a 4 KB head the size is unknown, a file read finds it.
    const com = Buffer.alloc(60_000, 0x20);
    const jpg = readFileSync(pic.jpg());
    const big = Buffer.concat([
      jpg.subarray(0, 2),
      Buffer.from([0xff, 0xfe, 0xea, 0x62]),
      com,
      jpg.subarray(2),
    ]);
    expect(pictureHeader(big.subarray(0, 4096))).toMatchObject({ format: 'jpeg', width: 0, partial: true });
    expect(await head(file('comment.jpg', big))).toMatchObject({ format: 'jpeg', width: 64, height: 48 });
    expect(await head(file('comment.jpg', big))).not.toHaveProperty('partial');
  });

  it('refuses corrupt and lying headers', async () => {
    const png = readFileSync(pic.png());
    const badCrc = Buffer.from(png);
    badCrc[20] = badCrc[20]! ^ 0xff;
    const sosFirst = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0xff, 0xd9]);
    const webpLie = Buffer.from(readFileSync(pic.webp()));
    const vp8x = Buffer.alloc(18);
    vp8x.write('VP8X', 0, 'latin1');
    vp8x.writeUInt32LE(10, 4);
    vp8x.writeUIntLE(999, 12, 3); // a canvas of 1000x1000 over a 64x48 bitstream
    vp8x.writeUIntLE(999, 15, 3);
    const lying = Buffer.concat([webpLie.subarray(0, 12), vp8x, webpLie.subarray(12)]);
    lying.writeUInt32LE(lying.length - 8, 4);
    for (const [name, bytes] of [
      ['empty.png', Buffer.alloc(0)],
      ['short.png', png.subarray(0, 20)],
      ['crc.png', badCrc],
      ['sos.jpg', sosFirst],
      ['noise.bin', Buffer.from('MZ\x90\0 this is not a picture at all', 'latin1')],
      ['zero.gif', Buffer.from('GIF89a\0\0\0\0\0\0\0;', 'latin1')],
      ['lie.webp', lying],
      ['bigtiff.tif', Buffer.from([0x49, 0x49, 0x2b, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
      ['cut.png', png.subarray(0, png.indexOf('IDAT') - 4)],
    ] as const)
      expect(await head(file(name, bytes)), name).toBeUndefined();
    expect(pictureHeader(new Uint8Array(0))).toBeUndefined();
    // Within a short head the same PNG is only partial: the rest of the file may still hold its data.
    expect(pictureHeader(png.subarray(0, png.indexOf('IDAT') - 4))).toMatchObject({ partial: true });
    expect(pictureHeader(png.subarray(0, png.indexOf('IDAT') - 4), { complete: true })).toBeUndefined();
  });
});

describe('display needs', () => {
  const slide = (objects: unknown[], extra: Partial<Slide> = {}) => ({ id: 's', objects, ...extra }) as Slide;
  const img = (id: string, w: number, h: number, more: Record<string, unknown> = {}) => ({
    id: `o-${id}-${w}`,
    type: 'image',
    box: { x: 0, y: 0, w, h, rotation: 0 },
    mediaId: id,
    fit: 'stretch',
    opacity: 1,
    radius: 0,
    ...more,
  });
  const media = [
    { id: 'pptxmedia:1', part: 'ppt/media/image1.jpg' },
    { id: 'pptxmedia:2', part: 'ppt/media/image2.png' },
  ];

  it('is the widest box at 3840 divided by the visible crop', () => {
    const needs = displayNeeds(
      [
        slide([img('pptxmedia:1', 480, 270)]),
        slide([
          img('pptxmedia:1', 960, 540),
          img('pptxmedia:2', 400, 300, { crop: { l: 0.25, t: 0, r: 0.25, b: 0 } }),
        ]),
        slide([img('unknown', 1920, 1080)]),
      ],
      media,
    );
    expect(needs).toEqual(
      new Map([
        ['ppt/media/image1.jpg', 1920],
        ['ppt/media/image2.png', 1600],
      ]),
    );
  });

  it('caps, floors and counts negative crops, backgrounds and the box height', () => {
    const needs = displayNeeds(
      [
        slide([img('pptxmedia:1', 1920, 1080, { crop: { l: 0.45, t: 0, r: 0.45, b: 0 } })]),
        slide([img('pptxmedia:2', 10, 10, { crop: { l: -0.5, t: 0, r: -0.5, b: 0 } })]),
      ],
      media,
    );
    expect(needs.get('ppt/media/image1.jpg')).toBe(PICTURE_LIMITS.side);
    expect(needs.get('ppt/media/image2.png')).toBe(PICTURE_LIMITS.minNeed);
    const bg = displayNeeds([slide([], { backgroundMediaId: 'pptxmedia:1' })], media, () => ({
      w: 1000,
      h: 1000,
    }));
    expect(bg.get('ppt/media/image1.jpg')).toBe(3840); // cover: a square fills 3840 wide
    // A square picture stretched into a tall box: the height asks for more than the width.
    const tall = displayNeeds([slide([img('pptxmedia:2', 100, 800)])], media, () => ({ w: 500, h: 500 }));
    expect(tall.get('ppt/media/image2.png')).toBe(1600);
    expect(displayNeeds([slide([img('pptxmedia:2', 100, 800)])], media).get('ppt/media/image2.png')).toBe(
      200,
    );
  });

  it('target sizes keep pictures within 1.25x of the need and the prepared limits', () => {
    expect(targetSize(1920, 1080, 1600)).toEqual({ width: 1920, height: 1080, scaled: false });
    expect(targetSize(8000, 6000, 1920)).toEqual({ width: 1920, height: 1440, scaled: true });
    const capped = targetSize(8000, 6000, 8192);
    expect(capped.scaled).toBe(true);
    expect(capped.width * capped.height).toBeLessThanOrEqual(40e6);
    expect(capped.width).toBeGreaterThan(7290);
    expect(targetSize(12000, 900, 20_000)).toMatchObject({ width: 8192, height: 614 });
    expect(targetSize(100, 100, Number.NaN)).toEqual({ width: 100, height: 100, scaled: false });
  });
});

describe('picture preparation', () => {
  const dir = join(fx, 'work');
  mkdirSync(dir, { recursive: true });
  const opts = () => ({ dir, timeoutMs: 120_000, signal: new AbortController().signal });

  it('prepares a 48 MP photo to its display need', async () => {
    const t0 = performance.now();
    const p = await preparePicture(pic.photo48(), 1920, opts());
    const ms = performance.now() - t0;
    expect(p).toMatchObject({ ext: 'jpg', mime: 'image/jpeg', width: 1920, height: 1440, hasAlpha: false });
    expect(await head(p.path)).toMatchObject({ format: 'jpeg', width: 1920, height: 1440 });
    expect(p.notes.join(' ')).toMatch(/8000x6000 downscaled to 1920x1440 \(display need 1920 px\)/);
    expect(p.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ms).toBeLessThan(20_000);
    // At the widest need it is still held to 40 MP.
    const wide = await preparePicture(pic.photo48(), 8192, opts());
    expect(wide.width * wide.height).toBeLessThanOrEqual(40e6);
    expect(await head(wide.path)).toMatchObject({ width: wide.width, height: wide.height });
  }, 60_000);

  it('keeps a picture that fits its need as it is, without copying it', async () => {
    const src = pic.pngAlpha();
    const p = await preparePicture(src, 3840, opts());
    expect(p).toMatchObject({ ext: 'png', width: 640, height: 480, hasAlpha: true, notes: [] });
    expect(statSync(p.path).ino).toBe(statSync(src).ino);
    expect(readFileSync(p.path).equals(readFileSync(src))).toBe(true);
  });

  it('converts BMP, TIFF, GIF, APNG and animated WebP to a first-frame PNG', async () => {
    const bmp = await preparePicture(pic.bmp(), 3840, opts());
    expect(bmp).toMatchObject({ ext: 'png', width: 64, height: 48, hasAlpha: false });
    expect(bmp.notes).toContain('BMP converted to PNG');
    const tif = await preparePicture(pic.tiff(), 3840, opts());
    expect(tif).toMatchObject({ ext: 'png', hasAlpha: true });
    expect(await head(tif.path)).toMatchObject({ format: 'png', alpha: true });
    const gif = await preparePicture(pic.gif(), 3840, opts());
    expect(gif).toMatchObject({ ext: 'png', width: 64, height: 48 });
    expect(gif.notes).toContain('animated GIF: the first frame is kept');
    const apng = await preparePicture(pic.apng(), 3840, opts());
    expect(apng.notes).toContain('animated PNG: its still image is kept');
    expect(await head(apng.path)).toMatchObject({ format: 'png', animated: false });
    const webp = await preparePicture(pic.webpAnim(), 3840, opts());
    expect(webp).toMatchObject({ ext: 'png', width: 64, height: 48 });
    expect(webp.notes).toContain('animated WebP: the first frame is kept');
    const still = await preparePicture(pic.webp(), 3840, opts());
    expect(still).toMatchObject({ ext: 'webp', width: 64, height: 48, notes: [] });
  });

  it('places an animated WebP first frame on its canvas', async () => {
    // A 32x24 lossless frame at (16, 12) on a 64x48 canvas.
    const frame = readFileSync(
      ffmpeg(fx, 'frame.webp', [
        ...lavfi('color=c=red:s=32x24,format=rgba'),
        '-c:v',
        'libwebp',
        '-lossless',
        '1',
      ]),
    );
    const vp8l = frame.subarray(12);
    const chunk = (fcc: string, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.write(fcc, 0, 'latin1');
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, Buffer.alloc(data.length & 1)]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x12; // animation and alpha
    vp8x.writeUIntLE(63, 4, 3);
    vp8x.writeUIntLE(47, 7, 3);
    const anmf = Buffer.alloc(16);
    anmf.writeUIntLE(8, 0, 3);
    anmf.writeUIntLE(6, 3, 3);
    anmf.writeUIntLE(31, 6, 3);
    anmf.writeUIntLE(23, 9, 3);
    anmf.writeUIntLE(100, 12, 3);
    const body = Buffer.concat([
      Buffer.from('WEBP', 'latin1'),
      chunk('VP8X', vp8x),
      chunk('ANIM', Buffer.alloc(6)),
      chunk('ANMF', Buffer.concat([anmf, vp8l])),
    ]);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0, 'latin1');
    riff.writeUInt32LE(body.length, 4);
    const bytes = Buffer.concat([riff, body]);
    const f = webpFirstFrame(bytes);
    expect(f).toMatchObject({ x: 16, y: 12, width: 32, height: 24, canvas: { w: 64, h: 48 } });
    const p = await preparePicture(file('offset.webp', bytes), 3840, opts());
    expect(p).toMatchObject({ ext: 'png', width: 64, height: 48, hasAlpha: true });
    const px = pixels(p.path, 'rgba');
    const at = (x: number, y: number) => [...px.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
    expect(at(2, 2)[3]).toBe(0);
    expect(at(32, 24)).toEqual([255, 0, 0, 255]);
  });

  it('draws pictures as stored: an EXIF orientation is removed, as PowerPoint ignores it', async () => {
    // 400x200 blue with a red block at the top left, tagged with orientation 6 (browsers would turn it).
    const src = ffmpeg(fx, 'block.jpg', [
      ...lavfi('color=c=blue:s=400x200,drawbox=x=0:y=0:w=100:h=50:color=red:t=fill'),
      '-q:v',
      '2',
    ]);
    const tagged = withOrientation(readFileSync(src), 6);
    const turned = file('block-turned.jpg', tagged);
    const removed = 'EXIF orientation 6 removed (PowerPoint draws it as stored)';
    // Downscaled: the stored pixels, the block still at the top left, no orientation left.
    const p = await preparePicture(turned, 128, opts());
    expect(p).toMatchObject({ ext: 'jpg', width: 128, height: 64 });
    expect(p.notes).toContain(removed);
    expect(await head(p.path)).not.toHaveProperty('orientation');
    const px = pixels(p.path);
    const at = (x: number, y: number) => [...px.subarray((y * 128 + x) * 3, (y * 128 + x) * 3 + 3)];
    expect(at(5, 5)[0]).toBeGreaterThan(200);
    expect(at(120, 5)[2]).toBeGreaterThan(200);
    // Kept: a copy with the orientation set to 1, two bytes apart from the source, which is unchanged.
    const kept = await preparePicture(turned, 3840, opts());
    expect(kept).toMatchObject({ ext: 'jpg', width: 400, height: 200, notes: [removed] });
    expect(statSync(kept.path).ino).not.toBe(statSync(turned).ino);
    expect(await head(kept.path)).not.toHaveProperty('orientation');
    expect(await head(turned)).toMatchObject({ orientation: 6 });
    const a = readFileSync(kept.path);
    expect(a.length).toBe(tagged.length);
    expect([...a].filter((x, i) => x !== tagged[i])).toEqual([1]);
    // A stored picture must not carry an orientation clients would apply.
    await expect(addReadyPictureCheck({ ...kept, path: file('tagged-again.jpg', tagged) })).rejects.toThrow(
      /decodes as stored/,
    );
  });

  it('converts a PNG with EXIF metadata, which browsers would turn by', async () => {
    const png = readFileSync(pic.png());
    const idat = png.indexOf('IDAT') - 4;
    const exif = Buffer.concat([
      Buffer.from([0, 0, 0, 4]),
      Buffer.from('eXIfMM\0*', 'latin1'),
      Buffer.alloc(4),
    ]);
    const p = await preparePicture(
      file('exif.png', Buffer.concat([png.subarray(0, idat), exif, png.subarray(idat)])),
      3840,
      opts(),
    );
    expect(p).toMatchObject({ ext: 'png', width: 64, height: 48 });
    expect(await head(p.path)).toEqual({
      format: 'png',
      width: 64,
      height: 48,
      animated: false,
      alpha: false,
    });
  });

  it('refuses metafiles, oversized sources and lying headers', async () => {
    await expect(preparePicture(file('p.emf', emf()), 1000, opts())).rejects.toMatchObject({
      route: 'metafile',
    });
    await expect(preparePicture(file('p.wmf', wmf()), 1000, opts())).rejects.toMatchObject({
      route: 'metafile',
    });
    await expect(
      preparePicture(file('p.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 1000, opts()),
    ).rejects.toMatchObject({ route: 'metafile' });
    await expect(preparePicture(file('huge.png', pngClaiming(20_000, 20_000)), 1000, opts())).rejects.toThrow(
      /limit is 16384 px a side/,
    );
    await expect(preparePicture(file('mp.png', pngClaiming(12_000, 12_000)), 1000, opts())).rejects.toThrow(
      /limit is 100 MP/,
    );
    // Headers that claim more than their data holds fail to decode, and are refused, not stored.
    const lieJpg = file('lie.jpg', jpegClaiming(readFileSync(pic.jpg()), 8000, 6000));
    await expect(preparePicture(lieJpg, 1920, opts())).rejects.toBeInstanceOf(PictureError);
    await expect(
      preparePicture(file('lie.png', pngClaiming(9000, 4000)), 1920, opts()),
    ).rejects.toBeInstanceOf(PictureError);
    await expect(
      preparePicture(file('junk.png', Buffer.from('not a picture')), 1920, opts()),
    ).rejects.toThrow(/not a picture/);
  });

  it('keeps a picture as it is when the import budget is spent, and refuses one that must be converted', async () => {
    const budget = new PictureBudget(1);
    const p = await preparePicture(pic.bigPng(), 1000, { ...opts(), budget });
    expect(p).toMatchObject({ ext: 'png', width: 4000, height: 3000 });
    expect(p.notes.join(' ')).toMatch(/kept as it is: the import's picture budget is spent/);
    await expect(
      preparePicture(pic.bmp(), 1000, { ...opts(), budget: new PictureBudget(0) }),
    ).rejects.toThrow(/budget/);
  });

  it('cleans its scratch files', async () => {
    const before = await readdir(dir);
    await preparePicture(pic.webpAnim(), 3840, opts()).then((p) => before.push(p.path.split('/').pop()!));
    expect((await readdir(dir)).sort()).toEqual(before.sort());
  });
});

describe('ready pictures and the media hash index', () => {
  let hub: TestHub;
  let deps: PptxDeps;
  let dir: string;
  const opts = () => ({ dir, timeoutMs: 120_000, signal: new AbortController().signal });

  beforeAll(async () => {
    hub = await startHub();
    deps = hub.imports.pptx.deps;
    dir = await hub.store.tmpDir();
  });
  afterAll(async () => {
    await hub.cleanup();
  });

  const mediaJobs = () => hub.jobs.list(1000).filter((j) => j.kind === 'media').length;

  it('stores a prepared picture ready, without a media job, and dedups by its bytes', async () => {
    const jobs = mediaJobs();
    const p1 = await preparePicture(pic.photo48(), 1920, opts());
    const m = await addReadyPicture(deps, p1, { name: 'Sunday – photo', tags: ['pptx'] });
    expect(m).toMatchObject({
      kind: 'image',
      state: 'ready',
      width: 1920,
      height: 1440,
      hasAlpha: false,
      tags: ['pptx'],
    });
    expect(m.original.mime).toBe('image/jpeg');
    expect(hub.store.abs(m.original.path)).toMatch(/\.jpg$/);
    expect(mediaJobs()).toBe(jobs);
    const index = new MediaHashes(hub.lib.db);
    expect(index.ids(m.original.hash, 'content')).toEqual([m.id]);
    expect(index.ids(p1.sourceHash, 'source')).toEqual([m.id]);
    // The same picture prepared again (another import): the same item, the scratch file gone.
    const p2 = await preparePicture(pic.photo48(), 1920, opts());
    expect((await addReadyPicture(deps, p2, { name: 'again', tags: ['pptx'] })).id).toBe(m.id);
    expect(() => statSync(p2.path)).toThrow();
  });

  it('finds a picture prepared by an earlier import before preparing it', async () => {
    const first = await pictureFor(deps, pic.bigPng(), 1600, { ...opts(), name: 'big', tags: ['pptx'] });
    expect(first).toMatchObject({ reused: false });
    expect(first.media).toMatchObject({ width: 1600, height: 1200 });
    const count = hub.lib.media.list().length;
    // A need within 1.25x of what is stored reuses it; a much smaller one prepares another size.
    const again = await pictureFor(deps, pic.bigPng(), 1400, { ...opts(), name: 'big', tags: ['pptx'] });
    expect(again).toMatchObject({ reused: true, notes: [] });
    expect(again.media.id).toBe(first.media.id);
    expect(hub.lib.media.list().length).toBe(count);
    const small = await pictureFor(deps, pic.bigPng(), 400, { ...opts(), name: 'big', tags: ['pptx'] });
    expect(small.media.id).not.toBe(first.media.id);
    expect(small.media.width).toBe(400);
    // A deleted item is no longer found, and the triggers dropped its rows.
    hub.lib.media.delete(small.media.id);
    expect(new MediaHashes(hub.lib.db).ids(small.media.original.hash, 'content')).toEqual([]);
    const redo = await pictureFor(deps, pic.bigPng(), 400, { ...opts(), name: 'big', tags: ['pptx'] });
    expect(redo.reused).toBe(false);
  });

  it('refuses a prepared picture whose file is not what it claims', async () => {
    const p = await preparePicture(pic.png(), 3840, opts());
    const lie: PreparedPicture = { ...p, width: 640 };
    await expect(addReadyPicture(deps, lie, { name: 'x', tags: [] })).rejects.toThrow(
      /not the 640x48 it claims/,
    );
    const q = await preparePicture(pic.jpg(), 3840, opts());
    await expect(
      addReadyPicture(deps, { ...q, ext: 'png', mime: 'image/png' }, { name: 'x', tags: [] }),
    ).rejects.toThrow(/JPEG file named \.png/);
    const gif = join(dir, 'anim.gif');
    writeFileSync(gif, readFileSync(pic.gif()));
    await expect(
      addReadyPicture(
        deps,
        {
          path: gif,
          ext: 'gif',
          mime: 'image/gif',
          width: 64,
          height: 48,
          hasAlpha: false,
          sourceHash: '',
          notes: [],
        },
        { name: 'x', tags: [] },
      ),
    ).rejects.toThrow(/not a still picture/);
  });

  it('storePictures resumes from its pairs and never stores a picture twice', async () => {
    const sources = [pic.webp(), pic.stillGif(), pic.bmpAlpha(), file('s.emf', emf())];
    const items = sources.map((f, i) => ({ part: `ppt/media/image${i + 1}`, file: f, need: 3840 }));
    const ctrl = new AbortController();
    let saved: [string, string][] = [];
    const done: [string, string][] = [];
    const base = {
      ...opts(),
      signal: ctrl.signal,
      done,
      saveEveryMs: 0,
      name: (part: string) => part,
      tags: ['pptx'],
      log: () => {},
    };
    // The first run stops after two pictures (as a restart would): its pairs were saved.
    await expect(
      storePictures(deps, items, {
        ...base,
        save: () => {
          saved = done.map((p) => [...p] as [string, string]);
        },
        progress: (n) => {
          if (n === 3) ctrl.abort();
        },
      }),
    ).rejects.toThrow(/cancelled/);
    expect(saved.map(([part]) => part)).toEqual(['ppt/media/image1', 'ppt/media/image2']);
    const count = hub.lib.media.list().length;
    const second = await storePictures(deps, items, {
      ...base,
      signal: new AbortController().signal,
      done: saved,
      save: () => {},
    });
    expect(second).toMatchObject({
      resumed: 2,
      prepared: 1,
      reused: 0,
      metafiles: ['ppt/media/image4'],
      failed: [],
    });
    expect(hub.lib.media.list().length).toBe(count + 1);
    expect(saved).toHaveLength(3);
    // A crash after storing but before saving: the pair is lost, the index still finds the picture.
    const third = await storePictures(deps, items, {
      ...base,
      signal: new AbortController().signal,
      done: saved.slice(0, 1),
      save: () => {},
    });
    expect(third).toMatchObject({ resumed: 1, reused: 2, prepared: 0 });
    expect(hub.lib.media.list().length).toBe(count + 1);
    expect([...third.media.values()]).toEqual([...second.media.values()]);
  });

  it("logs a picture that fails by its part and ordo's own reason; the message behind it goes to the hub's log", async () => {
    // Sources made first, with the real ffmpeg; then an ffmpeg that fails naming every path it was given,
    // as a real one does for a file it cannot open.
    const bmp = pic.bmp();
    const big = ffmpeg(fx, 'unscaled.png', lavfi('color=c=teal:s=3000x2000'));
    const bin = join(fx, 'failing-bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\necho "Error opening input file $*" >&2\nexit 1\n');
    chmodSync(join(bin, 'ffmpeg'), 0o755);
    const hubLog: { err: string; msg: string }[] = [];
    const log = { warn: (o: { err: string }, msg: string) => hubLog.push({ err: o.err, msg }) };
    const lines: string[] = [];
    const items = [
      { part: 'ppt/media/gone.png', file: join(dir, 'never-spilled.png'), need: 3840 },
      { part: 'ppt/media/image1.bmp', file: bmp, need: 3840 },
      { part: 'ppt/media/image2.png', file: big, need: 400 },
    ];
    await hub.jobs.idle();
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    let res: Awaited<ReturnType<typeof storePictures>>;
    try {
      res = await storePictures({ ...deps, log: log as unknown as PptxDeps['log'] }, items, {
        ...opts(),
        done: [],
        save: () => {},
        name: (part) => part,
        tags: ['pptx'],
        log: (msg) => lines.push(msg),
      });
    } finally {
      process.env.PATH = path;
    }
    expect(res.failed).toEqual([
      ['ppt/media/gone.png', 'it could not be stored'],
      ['ppt/media/image1.bmp', 'BMP picture could not be converted'],
    ]);
    // The picture clients read as it is stays, unscaled, with a note that names no file.
    expect([...res.media.keys()]).toEqual(['ppt/media/image2.png']);
    expect(lines).toEqual([
      '[warn] ppt/media/gone.png: it could not be stored',
      '[warn] ppt/media/image1.bmp: BMP picture could not be converted',
      'ppt/media/image2.png: kept as it is: it could not be downscaled',
    ]);
    for (const l of lines) for (const scratch of [dir, fx]) expect(l).not.toContain(scratch);
    // The hub's log has what happened, paths and all.
    expect(hubLog.map((h) => h.msg)).toEqual([
      'pptx picture not stored',
      'pptx picture not stored',
      'pptx picture kept unscaled',
    ]);
    expect(hubLog[0]!.err).toContain('never-spilled.png');
    expect(hubLog[1]!.err).toMatch(/ffmpeg exited with 1: Error opening input file .*opaque\.bmp/);
    expect(hubLog[2]!.err).toContain('unscaled.png');
  });

  it('mediaForFile reuses an item with the same content and ingests anything else', async () => {
    const copy = (name: string) => {
      const p = join(dir, name);
      writeFileSync(p, readFileSync(pic.png()));
      return p;
    };
    const jobs = mediaJobs();
    const id = await mediaForFile(deps, copy('a.png'), { name: 'Library/a.png', tags: ['pro7'] });
    expect(mediaJobs()).toBe(jobs + 1);
    const again = copy('b.png');
    expect(await mediaForFile(deps, again, { name: 'b.png', tags: ['pro7'], background: true })).toBe(id);
    expect(() => statSync(again)).toThrow();
    expect(hub.lib.media.must(id).isBackground).toBe(true);
    expect(findMedia(deps, hub.lib.media.must(id).original.hash, 'content').map((m) => m.id)).toEqual([id]);
    await hub.jobs.idle();
  });
});

describe('migration 8 (media-hashes)', () => {
  const row = (id: string, json: string) => [id, 1, id, 'image', 'ready', json, '2026-01-01', '2026-01-01'];
  const insert = (db: Database.Database, id: string, json: string) =>
    db
      .prepare(
        `INSERT INTO media (id, rev, name, kind, state, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...row(id, json));
  const rows = (db: Database.Database) =>
    db.prepare(`SELECT hash, role, media_id FROM media_hashes ORDER BY media_id, hash`).all();

  it('backfills an existing library and keeps the index with triggers', () => {
    const db = new Database(':memory:');
    for (const m of MIGRATIONS.filter((x) => x.version <= 7)) db.exec(m.sql);
    db.pragma('user_version = 7');
    insert(db, 'a', JSON.stringify({ original: { hash: 'h-a' } }));
    insert(db, 'b', '{not json');
    insert(db, 'c', JSON.stringify({ original: {} }));
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(rows(db)).toEqual([{ hash: 'h-a', role: 'content', media_id: 'a' }]);
    insert(db, 'd', JSON.stringify({ original: { hash: 'h-d' } }));
    insert(db, 'e', 'garbage');
    db.prepare(`UPDATE media SET json = ? WHERE id = ?`).run(
      JSON.stringify({ original: { hash: 'h-a2' } }),
      'a',
    );
    db.prepare(
      `INSERT INTO media_hashes (hash, role, media_id, created_at) VALUES ('src', 'source', 'd', 'x')`,
    ).run();
    expect(rows(db)).toEqual([
      { hash: 'h-a2', role: 'content', media_id: 'a' },
      { hash: 'h-d', role: 'content', media_id: 'd' },
      { hash: 'src', role: 'source', media_id: 'd' },
    ]);
    db.prepare(`DELETE FROM media WHERE id = ?`).run('d');
    expect(rows(db)).toEqual([{ hash: 'h-a2', role: 'content', media_id: 'a' }]);
    // Idempotent: running every migration again changes nothing.
    for (const m of MIGRATIONS) db.exec(m.sql);
    expect(rows(db)).toEqual([{ hash: 'h-a2', role: 'content', media_id: 'a' }]);
    db.close();
  });
});
