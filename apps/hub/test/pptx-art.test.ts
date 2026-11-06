/**
 * M3 item D, the parts that need no LibreOffice: the white/black alpha of the art task, its PNG and the
 * pdftoppm reader, the render copy's zip, the version-2 patch, page geometry, soffice's command and the job
 * queue's deferral.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { newId, type Slide, type SlideObject } from '@ordo/domain';
import { digestOf } from '@ordo/pptx-scene/emit.ts';
import JSZip from 'jszip';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { JobDeferred, JobQueue } from '../src/jobs.ts';
import { artTask, encodePng, readPpm } from '../src/pptx/art.ts';
import {
  ART_MARGIN_PX,
  artObject,
  deferDelay,
  fromPage,
  pageSize,
  patchSlide,
  sofficeCommand,
  toPage,
} from '../src/pptx/fallback.ts';
import { digestMatches, importDigest } from '../src/pptx/digest.ts';
import { writeZip } from '../src/pptx/renderCopyTask.ts';
import type { PptxLoSlide, RasterImage } from '../src/pptx/shared.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'ordo-art-'));

/**
 * A synthetic art layer (RGBA, straight alpha) printed over white and over a second colour (black unless
 * given), as 8-bit RGB pages.
 */
function printed(
  art: RasterImage,
  second: readonly [number, number, number] = [0, 0, 0],
): { white: RasterImage; black: RasterImage } {
  const n = art.width * art.height;
  const white = new Uint8Array(n * 3);
  const black = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = art.data[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) {
      const v = art.data[i * 4 + c]!;
      white[i * 3 + c] = Math.round(a * v + (1 - a) * 255);
      black[i * 3 + c] = Math.round(a * v + (1 - a) * second[c]!);
    }
  }
  const page = (data: Uint8Array) => ({ width: art.width, height: art.height, channels: 3 as const, data });
  return { white: page(white), black: page(black) };
}

/** A deterministic art layer: transparent margins, a ramp of alpha, colours everywhere. */
function layer(w: number, h: number, inside: (x: number, y: number) => boolean): RasterImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      const o = (y * w + x) * 4;
      data[o] = (x * 37 + y * 11) % 256;
      data[o + 1] = (x * 5 + y * 53) % 256;
      data[o + 2] = (x * 97 + 31) % 256;
      data[o + 3] = (x * 13 + y * 7) % 256;
    }
  return { width: w, height: h, channels: 4, data };
}

/** Decode one of our PNGs (filters none, sub and up) back to its pixels. */
function decodePng(png: Uint8Array): RasterImage {
  const b = Buffer.from(png);
  let at = 8;
  let w = 0;
  let h = 0;
  let c = 0;
  const idat: Buffer[] = [];
  while (at < b.length) {
    const len = b.readUInt32BE(at);
    const type = b.toString('ascii', at + 4, at + 8);
    const data = b.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      c = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * c;
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i]!;
      const left = i >= c ? out[y * stride + i - c]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + i]! : 0;
      out[y * stride + i] = (v + (f === 1 ? left : f === 2 ? up : 0)) & 0xff;
    }
  }
  return { width: w, height: h, channels: c as 3 | 4, data: out };
}

describe('pptx-art: alpha from a white and a black page', () => {
  it.each([
    ['black', undefined],
    ['yellow', [255, 255, 0] as const],
  ])('recovers the art within 2/255 over any background (second page %s)', (_, second) => {
    const art = layer(64, 48, () => true);
    const { white, black } = printed(art, second);
    const out = artTask({
      white,
      black,
      box: { x: 0, y: 0, w: 64, h: 48 },
      ...(second ? { colors: { white: [255, 255, 255] as const, black: second } } : {}),
    });
    expect(out.empty).toBe(false);
    let worst = 0;
    for (let y = out.at.y; y < out.at.y + out.image.height; y++)
      for (let x = out.at.x; x < out.at.x + out.image.width; x++) {
        const i = y * 64 + x;
        const o = ((y - out.at.y) * out.image.width + (x - out.at.x)) * 4;
        const a0 = art.data[i * 4 + 3]! / 255;
        const a1 = out.image.data[o + 3]! / 255;
        worst = Math.max(worst, Math.abs(a0 - a1) * 255);
        for (const bg of [0, 77, 128, 200, 255])
          for (let c = 0; c < 3; c++) {
            const want = a0 * art.data[i * 4 + c]! + (1 - a0) * bg;
            const got = a1 * out.image.data[o + c]! + (1 - a1) * bg;
            worst = Math.max(worst, Math.abs(want - got));
          }
      }
    expect(worst).toBeLessThanOrEqual(2);
  });

  it('crops to the visible pixels inside the box, and only there', () => {
    // Art in x 10..29, y 5..14; a stray mark at (60, 40) outside the box.
    const art = layer(64, 48, (x, y) => (x >= 10 && x < 30 && y >= 5 && y < 15) || (x === 60 && y === 40));
    for (let y = 5; y < 15; y++) for (let x = 10; x < 30; x++) art.data[(y * 64 + x) * 4 + 3] = 200;
    art.data[(40 * 64 + 60) * 4 + 3] = 255;
    const { white, black } = printed(art);
    const out = artTask({ white, black, box: { x: 2, y: 2, w: 40.5, h: 30 } });
    expect(out.at).toEqual({ x: 10, y: 5 });
    expect([out.image.width, out.image.height]).toEqual([20, 10]);
    // `whole` keeps the box itself (a converted metafile keeps its extent).
    const whole = artTask({ white, black, box: { x: 2, y: 2, w: 40, h: 30 }, whole: true });
    expect(whole.at).toEqual({ x: 2, y: 2 });
    expect([whole.image.width, whole.image.height]).toEqual([40, 30]);
  });

  it('refuses two backgrounds that cannot tell alpha', () => {
    const { white, black } = printed(layer(4, 4, () => true));
    const colors = { white: [255, 255, 255] as const, black: [250, 250, 250] as const };
    expect(() => artTask({ white, black, box: { x: 0, y: 0, w: 4, h: 4 }, colors })).toThrow(/too alike/);
  });

  it('says when nothing is visible', () => {
    const { white, black } = printed(layer(8, 8, () => false));
    expect(artTask({ white, black, box: { x: 0, y: 0, w: 8, h: 8 } }).empty).toBe(true);
  });

  it('encodes the PNG in the task and hands back no pixels', () => {
    const art = layer(33, 17, (x) => x > 3);
    const { white, black } = printed(art);
    const plain = artTask({ white, black, box: { x: 0, y: 0, w: 33, h: 17 } });
    const enc = artTask({ white, black, box: { x: 0, y: 0, w: 33, h: 17 }, encode: true });
    expect(enc.image.data.length).toBe(0);
    expect([enc.image.width, enc.image.height]).toEqual([plain.image.width, plain.image.height]);
    const back = decodePng(enc.png!);
    expect(back.channels).toBe(4);
    expect(Buffer.from(back.data).equals(Buffer.from(plain.image.data))).toBe(true);
  });

  it('refuses pages that do not match', () => {
    const p = { width: 2, height: 2, channels: 3 as const, data: new Uint8Array(12) };
    expect(() => artTask({ white: p, black: { ...p, width: 1 }, box: { x: 0, y: 0, w: 1, h: 1 } })).toThrow();
    expect(() =>
      artTask({ white: p, black: { ...p, data: new Uint8Array(3) }, box: { x: 0, y: 0, w: 1, h: 1 } }),
    ).toThrow(/too few pixels/);
  });
});

describe('pdftoppm pages and PNG', () => {
  it('reads a binary PPM without copying it', () => {
    const head = Buffer.from('P6\n# pdftoppm\n2 1\n255\n');
    const buf = Buffer.concat([head, Buffer.from([1, 2, 3, 4, 5, 6])]);
    const img = readPpm(buf);
    expect(img).toMatchObject({ width: 2, height: 1, channels: 3 });
    expect([...img.data]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(img.data.buffer).toBe(buf.buffer);
    expect(() => readPpm(Buffer.from('P5\n1 1\n255\n\0'))).toThrow(/not a binary PPM/);
    expect(() => readPpm(Buffer.from('P6\n9 9\n255\n\0'))).toThrow(/truncated/);
  });

  it('encodes RGB too', () => {
    const img: RasterImage = {
      width: 3,
      height: 2,
      channels: 3,
      data: Uint8Array.from({ length: 18 }, (_, i) => i * 14),
    };
    expect(Buffer.from(decodePng(encodePng(img)).data).equals(Buffer.from(img.data))).toBe(true);
  });
});

describe('render copy zip', () => {
  it('writes deflated parts and stored files that a zip reader opens', async () => {
    const d = dir();
    const pic = join(d, 'pic.png');
    const bytes = Buffer.alloc(200_000, 7);
    writeFileSync(pic, bytes);
    const xml = new TextEncoder().encode('<?xml version="1.0"?><a>hello</a>');
    const out = join(d, 'copy.pptx');
    const size = await writeZip(out, [
      { name: 'ppt/presentation.xml', bytes: xml },
      { name: 'ppt/media/image1.png', file: pic },
    ]);
    expect(size).toBe(readFileSync(out).length);
    const zip = await JSZip.loadAsync(readFileSync(out));
    expect(await zip.file('ppt/presentation.xml')!.async('string')).toContain('hello');
    expect(Buffer.from(await zip.file('ppt/media/image1.png')!.async('uint8array')).equals(bytes)).toBe(true);
  });
});

describe('pages', () => {
  it('are 2 px per logical px of the slide, unpadded', () => {
    expect(pageSize({ cx: 12_192_000, cy: 6_858_000 })).toMatchObject({ width: 3840, height: 2160 });
    expect(pageSize({ cx: 9_144_000, cy: 6_858_000 })).toMatchObject({ width: 2880, height: 2160 });
    const four3 = { cx: 9_144_000, cy: 6_858_000 };
    const box = { x: 300, y: 100, w: 400, h: 200 };
    const p = toPage(box, four3);
    expect(p).toEqual({ x: 120, y: 200, w: 800, h: 400 }); // the 240 px bars are not on the page
    const back = fromPage(p, four3);
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(back[k]).toBeCloseTo(box[k], 9);
    expect(toPage(box, four3, ART_MARGIN_PX).w).toBe(800 + 4 * ART_MARGIN_PX);
  });
});

describe('version 2 patch', () => {
  const shape = (id: string, x = 0): SlideObject => ({
    id,
    type: 'shape',
    box: { x, y: 0, w: 10, h: 10, rotation: 0 },
    shape: 'rect',
    fill: { r: 255, g: 0, b: 0, a: 1 },
    opacity: 1,
    radius: 0,
  });
  const caption = (id: string): SlideObject => ({
    id,
    type: 'text',
    box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
    text: 'Total',
    style: {
      fontFamily: 'Calibri',
      fontWeight: 400,
      fontStyle: 'normal',
      fontSizePx: 40,
      color: { r: 0, g: 0, b: 0, a: 1 },
      align: 'left',
      valign: 'top',
      lineHeight: 1.2,
      letterSpacing: 0,
      padding: 0,
      transform: 'none',
    },
    opacity: 1,
  });

  function version1(): { slide: Slide; lo: PptxLoSlide } {
    // Every object the native import writes carries an origin (`nativeJob.ts` `imported`).
    const objects = [
      shape('bg'),
      caption('title'),
      shape('rectA'),
      caption('captionA'),
      shape('rectB', 50),
    ].map((o): SlideObject => ({ ...o, origin: { src: 'pptx' } }));
    const slide: Slide = {
      id: 's1',
      objects,
      lyricObjectId: 'captionA',
      pptx: { fileId: 'deck', index: 1, shown: 1, class: 'hybrid', version: 1, pending: true, digest: '' },
    };
    slide.pptx!.digest = digestOf(slide.objects);
    const lo: PptxLoSlide = {
      slideId: 's1',
      index: 1,
      shown: 1,
      class: 'hybrid',
      digest: slide.pptx!.digest!,
      art: {
        elements: [{ from: 'slide', shapeId: 4, nth: 0 }],
        box: { x: 100, y: 100, w: 500, h: 300 },
        at: 2,
        replaces: ['rectA', 'captionA'],
        text: 'Total',
        before: 'rectB',
      },
    };
    return { slide, lo };
  }

  it('replaces the art range of an unedited slide, in place', () => {
    const { slide, lo } = version1();
    const box = { x: 120, y: 110, w: 400, h: 250 };
    const next = patchSlide(slide, lo, { art: { mediaId: 'art1', box } }, 'deck');
    expect(next.objects.map((o) => o.id)).toEqual(['bg', 'title', next.objects[2]!.id, 'rectB']);
    expect(next.objects[2]).toMatchObject({
      type: 'image',
      mediaId: 'art1',
      fit: 'stretch',
      box: { ...box, rotation: 0 },
    });
    expect(next.lyricObjectId).toBeUndefined();
    expect(next.pptx!.pending).toBeUndefined();
    // Still unedited: the digest follows the new objects.
    expect(next.pptx!.digest).toBe(digestOf(next.objects));
  });

  it('an object added in ordo before LibreOffice ran does not make the slide edited', () => {
    const { slide, lo } = version1();
    const withMine: Slide = { ...slide, objects: [...slide.objects, shape('mine', 300)] };
    const next = patchSlide(
      withMine,
      lo,
      { art: { mediaId: 'art1', box: { x: 1, y: 1, w: 9, h: 9 } } },
      'deck',
    );
    // The art replaces its range in place, as on an unedited slide; the volunteer's shape stays.
    expect(next.objects.map((o) => o.id)).toEqual(['bg', 'title', next.objects[2]!.id, 'rectB', 'mine']);
    expect(next.pptx!.notes).toBeUndefined();
    // The digest covers the import's objects only (`digest.ts`): still unedited, for the next re-import too.
    expect(next.pptx!.digest).toBe(importDigest(next.objects));
    expect(digestMatches(next.objects, next.pptx!.digest)).toBe(true);
  });

  it('adds the art on top of an edited slide, keeping every object, with a note', () => {
    const { slide, lo } = version1();
    // The title's text changed (an imported object), and an object added in ordo.
    const objects = slide.objects.map((o) =>
      o.id === 'title' ? { ...o, text: 'Giving' } : o,
    ) as SlideObject[];
    const edited: Slide = { ...slide, objects: [...objects, shape('mine', 300)] };
    const next = patchSlide(
      edited,
      lo,
      { art: { mediaId: 'art1', box: { x: 0, y: 0, w: 1, h: 1 } } },
      'deck',
    );
    expect(next.objects.map((o) => o.id).slice(0, 6)).toEqual([
      'bg',
      'title',
      'rectA',
      'captionA',
      'rectB',
      'mine',
    ]);
    expect(next.objects.at(-1)).toMatchObject({ type: 'image', mediaId: 'art1' });
    expect(next.lyricObjectId).toBe('captionA');
    expect(next.pptx!.notes).toEqual(['edited since the import: the PowerPoint art was added on top']);
    expect(next.pptx!.digest).toBe(lo.digest);
  });

  it('keeps version 1 when LibreOffice drew nothing, and says so', () => {
    const { slide, lo } = version1();
    const next = patchSlide(slide, lo, { art: null, failed: ['LibreOffice could not draw the art'] }, 'deck');
    expect(next.objects.map((o) => o.id)).toEqual(slide.objects.map((o) => o.id));
    expect(next.pptx!.notes).toEqual([
      'LibreOffice drew nothing for the art: the slide stays as it is',
      'LibreOffice could not draw the art',
    ]);
    expect(next.pptx!.pending).toBeUndefined();
  });

  it('gives a picture-class slide its page picture and aligned text boxes', () => {
    const slide: Slide = {
      id: 's2',
      objects: [],
      pptx: {
        fileId: 'deck',
        index: 4,
        shown: 3,
        class: 'picture',
        version: 1,
        pending: true,
        digest: digestOf([]),
      },
    };
    const lo: PptxLoSlide = { slideId: 's2', index: 4, shown: 3, class: 'picture', digest: digestOf([]) };
    const textBoxes = [
      { text: 'Welcome', box: { x: 10, y: 20, w: 300, h: 80, rotation: 0 }, fontSizePx: 48 },
    ];
    const next = patchSlide(slide, lo, { page: { mediaId: 'page1', textBoxes } }, 'deck');
    expect(next.imported).toEqual({
      fileId: 'deck',
      page: 4,
      imageMediaId: 'page1',
      textBoxes,
      textAligned: true,
    });
    expect(next.pptx!.pending).toBeUndefined();
  });

  it('puts converted metafiles back under the object they were drawn under', () => {
    const { slide, lo } = version1();
    const object = {
      id: 'meta1',
      type: 'image' as const,
      box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
      mediaId: 'pptxmedia:3',
      fit: 'stretch' as const,
      opacity: 1,
      radius: 0,
    };
    const next = patchSlide(
      slide,
      {
        ...lo,
        art: undefined,
        class: 'native',
        metafileObjects: [{ part: 'ppt/media/image3.emf', object, before: 'title' }],
      },
      { metafiles: new Map([['ppt/media/image3.emf', 'png1']]) },
      'deck',
    );
    expect(next.objects.map((o) => o.id)).toEqual(['bg', 'meta1', 'title', 'rectA', 'captionA', 'rectB']);
    expect(next.objects[1]).toMatchObject({ mediaId: 'png1' });
  });

  it('builds the art as a locked image any drawer shows', () => {
    const o = artObject('m', { x: Number.NaN, y: 2e6, w: -5, h: 10 }) as unknown as Record<string, unknown>;
    expect(o).toMatchObject({
      type: 'image',
      fit: 'stretch',
      locked: true,
      origin: { src: 'pptx', role: 'art' },
      box: { x: 0, y: 100_000, w: 0, h: 10, rotation: 0 },
    });
  });
});

describe('soffice', () => {
  it('runs capped, and without a network or through a dead proxy', async () => {
    const c = await sofficeCommand(['--version'], '/tmp/home', 1024);
    const all = [c.cmd, ...c.args];
    expect(all).toContain('soffice');
    if (all.includes('prlimit')) expect(all).toContain(`--as=${1024 * 1024 * 1024}`);
    if (c.sandboxed)
      expect(all.slice(all.indexOf('unshare'), all.indexOf('unshare') + 2)).toEqual(['unshare', '-rn']);
    else expect(c.env.https_proxy).toBe('http://127.0.0.1:9');
    expect(c.env.HOME).toBe('/tmp/home');
    expect(
      Object.keys(c.env)
        .filter((k) => !/proxy/i.test(k))
        .sort(),
    ).toEqual(['HOME', 'LANG', 'PATH']);
  });
});

describe('job deferral', () => {
  it('backs off from 30 s to 15 min', () => {
    expect([0, 1, 2, 5, 40].map(deferDelay)).toEqual([30_000, 60_000, 120_000, 900_000, 900_000]);
  });

  it('re-queues a deferred job without counting an attempt, and runs it once its time comes', async () => {
    const db = openDb(join(dir(), 'jobs.db'));
    const jobs = new JobQueue(db, pino({ level: 'silent' }), { heavy: 1, light: 1 }, () => undefined);
    let runs = 0;
    jobs.register('wait', async () => {
      runs++;
      if (runs === 1) throw new JobDeferred(60_000, 'waiting: the presentation is live');
      return { ok: true };
    });
    jobs.start();
    const job = jobs.enqueue('wait', { id: newId() }, 'heavy');
    await jobs.idle();
    expect(runs).toBe(1);
    expect(jobs.get(job.id)).toMatchObject({ state: 'queued' });
    expect(jobs.get(job.id).log.at(-1)).toMatch(/waiting: the presentation is live$/);
    expect(jobs.attempts(job.id)).toBe(0);
    expect(jobs.deferred().map((d) => d.id)).toEqual([job.id]);
    jobs.undefer(job.id);
    await new Promise((r) => setTimeout(r, 20));
    await jobs.idle();
    expect(runs).toBe(2);
    expect(jobs.get(job.id)).toMatchObject({ state: 'done', result: { ok: true } });
    await jobs.stop();
    db.close();
  });
});
