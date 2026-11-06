/**
 * Baked pictures of the native import (design/27 §4 "Pictures", §15 M6 "Recolour and tile bakes"): the
 * `pptx-bake` pool task on generated rasters, and crafted decks through the real job with generated pictures
 * (ffmpeg): a duotone and a grayscale picture, a tiled shape fill and a SmartArt node filled with a picture
 * become new ready pictures, a re-import finds them, and a picture that cannot be baked shows as it is.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageObject, Slide } from '@ordo/domain';
import {
  drawingXml,
  dspSp,
  smartArtFrame,
  smartArtRels,
  withSmartArt,
} from '@ordo/pptx-scene/smartart.test-util.ts';
import { buildDeck, imageRel, pic, sp } from '@ordo/pptx-scene/test-util.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bakeTask } from '../src/pptx/bakeTask.ts';
import { BAKE_KEY_PREFIX, bakeHash, bakeMapKey, bakeSize } from '../src/pptx/bakes.ts';
import { pictureHeader } from '../src/pptx/pictures.ts';
import type { PptxNativeResult } from '../src/pptx/shared.ts';
import { ffmpeg } from './fixtures.ts';
import { startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, waitJob, zipDeck } from './pptx-helpers.ts';

const IN = 914_400;

describe('pptx-bake (the pool task)', () => {
  const red = (w: number, h: number) => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
    return { width: w, height: h, channels: 4 as const, data };
  };

  it('recolours a raster and encodes an opaque result as an RGB PNG', () => {
    const out = bakeTask({ source: red(4, 2), bake: { recolor: [{ kind: 'grayscale' }] }, format: 'png' });
    expect(out).toMatchObject({ width: 4, height: 2, alpha: false });
    expect(pictureHeader(out.png, { complete: true })).toMatchObject({
      format: 'png',
      width: 4,
      height: 2,
      alpha: false,
    });
  });

  it('tiles over the asked output and keeps alpha from a colour change', () => {
    const out = bakeTask({
      source: red(2, 2),
      bake: {
        recolor: [{ kind: 'clrChange', from: { r: 255, g: 0, b: 0, a: 1 }, to: { r: 0, g: 0, b: 0, a: 0 } }],
        tile: { aspect: 0.5, w: 0.5, h: 1, x: 0, y: 0, flip: 'none' },
      },
      out: { width: 8, height: 4 },
      format: 'png',
    });
    expect(out).toMatchObject({ width: 8, height: 4, alpha: true });
    expect(pictureHeader(out.png, { complete: true })?.alpha).toBe(true);
  });

  it('refuses a source of the wrong shape or size', () => {
    const bad = { ...red(2, 2), data: new Uint8Array(3) };
    expect(() =>
      bakeTask({ source: bad, bake: { recolor: [{ kind: 'grayscale' }] }, format: 'png' }),
    ).toThrow(/pixels/);
    expect(() => bakeTask({ source: { ...red(1, 1), channels: 3 }, bake: {}, format: 'png' })).toThrow(
      /RGBA/,
    );
    expect(() =>
      bakeTask({
        source: red(1, 1),
        bake: { tile: { aspect: 1, w: 1, h: 1, x: 0, y: 0, flip: 'none' } },
        out: { width: 10_000, height: 10_000 },
        format: 'png',
      }),
    ).toThrow(/larger/);
  });

  it('sizes a recoloured picture by its need and a tile by its box, within the bake limits', () => {
    expect(bakeSize({ recolor: [{ kind: 'grayscale' }] }, 4000, 3000, 1000)).toEqual({
      width: 1000,
      height: 750,
    });
    expect(bakeSize({ recolor: [{ kind: 'grayscale' }] }, 300, 200, 1000)).toEqual({
      width: 300,
      height: 200,
    });
    const tile = { aspect: 0.5, w: 0.1, h: 0.2, x: 0, y: 0, flip: 'none' as const };
    expect(bakeSize({ tile }, 16, 16, 1920)).toEqual({ width: 1920, height: 960 });
    expect(bakeHash('a'.repeat(64), { tile })).toMatch(/^[0-9a-f]{64}$/);
    expect(bakeHash('a'.repeat(64), { tile })).not.toBe(bakeHash('b'.repeat(64), { tile }));
    expect(bakeMapKey('ppt/media/a.png', { tile }).startsWith(BAKE_KEY_PREFIX)).toBe(true);
  });
});

describe('baked pictures through the native import', () => {
  let hub: TestHub;
  let dir: string;
  let red: Uint8Array;
  let photo: Uint8Array;
  let checker: Uint8Array;
  let anim: Uint8Array;

  beforeAll(async () => {
    hub = await startHub();
    dir = tempDir('ordo-bakes-');
    mkdirSync(join(dir, 'media'), { recursive: true });
    const m = join(dir, 'media');
    red = await readFile(
      ffmpeg(m, 'red.png', ['-f', 'lavfi', '-i', 'color=c=red:s=320x180', '-frames:v', '1']),
    );
    photo = await readFile(
      ffmpeg(m, 'photo.jpg', ['-f', 'lavfi', '-i', 'testsrc=size=320x240', '-frames:v', '1']),
    );
    // A 16 x 16 checker of red and blue squares of 8 px.
    checker = await readFile(
      ffmpeg(m, 'checker.png', [
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=16x16',
        '-vf',
        "format=rgb24,geq=r='if(lt(X,8),255,0)':g=0:b='if(lt(X,8),0,255)'",
        '-frames:v',
        '1',
      ]),
    );
    anim = await readFile(
      ffmpeg(m, 'anim.webp', [
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=64x48:rate=5:duration=1',
        '-c:v',
        'libwebp',
        '-loop',
        '0',
      ]),
    );
  }, 60_000);
  afterAll(async () => {
    await hub?.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function importDeck(parts: Map<string, Uint8Array>) {
    const file = await zipDeck(parts, dir, `${Math.random().toString(36).slice(2)}.pptx`);
    const hash = await storeDeck(hub, file);
    const job = await waitJob(hub, hub.imports.pptx.queueNative(hash, 'Bakes.pptx', {}).id, 120_000);
    if (job.state !== 'done') throw new Error(`import failed: ${job.error}\n${job.log.join('\n')}`);
    const result = job.result as PptxNativeResult;
    return { job, p: hub.lib.presentations.must(result.presentationId) };
  }

  /** The first pixel's RGB of a stored picture, decoded by ffmpeg. */
  function firstPixel(mediaId: string, x = 0): number[] {
    const m = hub.lib.media.must(mediaId);
    const raw = execFileSync('ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-i', hub.store.abs(m.original.path)],
      ...['-vf', `crop=1:1:${x}:0`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    ]);
    return [...raw.subarray(0, 3)];
  }

  const images = (s: Slide) => s.objects.filter((o): o is ImageObject => o.type === 'image');
  const duotone = '<a:duotone><a:srgbClr val="000000"/><a:srgbClr val="FFFFFF"/></a:duotone>';
  const tiled =
    '<a:blipFill><a:blip r:embed="rId3"/><a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" algn="tl"/></a:blipFill>';

  function deck() {
    const parts = buildDeck({
      slides: [
        {
          rels: [imageRel('rId2', 'red.png'), imageRel('rId3', 'checker.png'), imageRel('rId4', 'photo.jpg')],
          shapes:
            pic({ id: 2, x: 0, y: 0, cx: 2 * IN, cy: IN, rId: 'rId2', blip: duotone }) +
            sp({ id: 3, x: 3 * IN, y: 0, cx: 4 * IN, cy: 2 * IN, fill: tiled }) +
            pic({ id: 4, x: 0, y: 3 * IN, cx: 2 * IN, cy: 1.5 * IN, rId: 'rId4', blip: '<a:grayscl/>' }),
        },
        {
          rels: [imageRel('rId2', 'red.png')],
          shapes: pic({ id: 2, x: 0, y: 0, cx: 2 * IN, cy: IN, rId: 'rId2' }),
        },
        {
          rels: [...smartArtRels(1)],
          shapes: smartArtFrame({ id: 5, x: IN, y: IN, cx: 4 * IN, cy: 2 * IN, dmId: 'rIdDm1' }),
        },
      ],
      media: { 'ppt/media/red.png': red, 'ppt/media/checker.png': checker, 'ppt/media/photo.jpg': photo },
    });
    const node = dspSp({
      x: 0,
      y: 0,
      cx: 2 * IN,
      cy: 2 * IN,
      fill: '<a:blipFill><a:blip r:embed="rIdImg"><a:grayscl/></a:blip><a:stretch><a:fillRect/></a:stretch></a:blipFill>',
    });
    return withSmartArt(parts, 1, drawingXml(node), [
      {
        id: 'rIdImg',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
        target: '../media/photo.jpg',
      },
    ]);
  }

  it('stores each bake as a new ready picture beside the plain one', async () => {
    const before = hub.lib.media.list().length;
    const { p, job } = await importDeck(deck());
    const [s1, s2, s3] = slidesOf(p);
    const [duo, tile, gray] = images(s1!);
    const plain = images(s2!)[0]!;
    expect(new Set([duo!.mediaId, tile!.mediaId, gray!.mediaId, plain.mediaId]).size).toBe(4);
    for (const id of [duo!.mediaId, tile!.mediaId, gray!.mediaId]) {
      const m = hub.lib.media.must(id);
      expect(m).toMatchObject({ kind: 'image', state: 'ready', tags: ['pptx'] });
    }
    // Duotone black → white of red (lavfi's red is 253, 0, 0): its luminance, 75.
    expect(firstPixel(duo!.mediaId)).toEqual([75, 75, 75]);
    const [pr, pg] = firstPixel(plain.mediaId);
    expect(pr).toBeGreaterThan(240);
    expect(pg).toBeLessThan(10);
    // The tile: the box at 3840 px wide, half as tall; its 16 px picture (1/6 in at 96 dpi) repeats.
    const t = hub.lib.media.must(tile!.mediaId);
    expect(t.width).toBe(Math.round((4 * 1920 * 2) / 13.333_333));
    expect(t.height).toBe(Math.round(t.width! / 2));
    const tilePx = t.width! / 24; // 4 in at 6 tiles an inch
    expect(firstPixel(tile!.mediaId, 1)[0]).toBeGreaterThan(200); // red half of the first tile
    expect(firstPixel(tile!.mediaId, Math.round(tilePx * 0.75))[2]).toBeGreaterThan(200); // blue half
    expect(firstPixel(tile!.mediaId, Math.round(tilePx * 1.25))[0]).toBeGreaterThan(200); // the next tile
    // An opaque bake of a photo stays a JPEG.
    expect(hub.lib.media.must(gray!.mediaId).original.mime).toBe('image/jpeg');
    const [r, g, b] = firstPixel(gray!.mediaId);
    expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThanOrEqual(3);
    // The SmartArt node's picture, recoloured through the drawing part's relationships, locked.
    const node = images(s3!)[0]!;
    expect(node.locked).toBe(true);
    // The same part with the same recipe: one baked picture, whatever box it fills.
    expect(node.mediaId).toBe(gray!.mediaId);
    expect(job.log.join('\n')).toMatch(/baked picture\(s\) stored/);
    // red plain + duotone, checker tile, photo grayscale (the SmartArt node shares it): 4 new items.
    expect(hub.lib.media.list().length - before).toBe(4);

    // A second import of the same deck stores nothing new.
    const again = hub.lib.media.list().length;
    const second = await importDeck(deck());
    expect(hub.lib.media.list().length).toBe(again);
    expect(images(slidesOf(second.p)[0]!).map((o) => o.mediaId)).toEqual([
      duo!.mediaId,
      tile!.mediaId,
      gray!.mediaId,
    ]);
  }, 120_000);

  it('shows a picture it cannot bake as it is, with a warning', async () => {
    const parts = buildDeck({
      slides: [
        {
          rels: [imageRel('rId2', 'anim.webp')],
          shapes: pic({ id: 2, x: 0, y: 0, cx: 2 * IN, cy: IN, rId: 'rId2', blip: '<a:grayscl/>' }),
        },
      ],
      media: { 'ppt/media/anim.webp': anim },
    });
    const { p, job } = await importDeck(parts);
    const img = images(slidesOf(p)[0]!)[0]!;
    expect(hub.lib.media.must(img.mediaId).state).toBe('ready');
    expect(job.log.join('\n')).toMatch(/drawn without its effects or tiles/);
    expect(readFileSync(hub.store.abs(hub.lib.media.must(img.mediaId).original.path)).length).toBeGreaterThan(
      0,
    );
  }, 120_000);
});
