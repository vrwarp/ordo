import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Slide } from '@ordo/domain';
import pptxgen from 'pptxgenjs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  convertDeck,
  convertDeckIsolated,
  familiesOf,
  NativeRenderer,
  picturesNeeded,
  renameFamilies,
  sniffPicture,
  spilledPictureSize,
  spillPart,
} from './native.ts';
import { dataUri, testPicture } from './png.ts';
import { beatsBlack, type DeckScore, featureRows, nativeStats } from './report.ts';

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function work(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'ordo-pptx-fidelity-'));
  dirs.push(d);
  return d;
}

/** A deck: a shown slide with a background, text and a picture, a hidden slide, then a shown one. */
async function deck(layout: 'LAYOUT_16x9' | 'LAYOUT_4x3'): Promise<string> {
  const p = new pptxgen();
  p.layout = layout;
  const s1 = p.addSlide();
  s1.background = { color: '1F2937' };
  s1.addText('Amazing grace', {
    x: 0.5,
    y: 0.5,
    w: 6,
    h: 1,
    fontFace: 'Arial',
    fontSize: 40,
    color: 'FFFFFF',
  });
  s1.addImage({ data: dataUri(testPicture(320, 180)), x: 1, y: 2, w: 4, h: 2.25 });
  const hidden = p.addSlide();
  hidden.hidden = true;
  hidden.addText('Hidden', { x: 1, y: 1, w: 4, h: 1, fontSize: 30 });
  p.addSlide().addText('How sweet the sound', { x: 1, y: 1, w: 6, h: 1, fontSize: 32, bold: true });
  const dir = await work();
  const file = join(dir, 'deck.pptx');
  await writeFile(file, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
  return file;
}

const slide = (objects: Slide['objects'], extra: Partial<Slide> = {}): Slide => ({
  id: 's',
  objects,
  ...extra,
});

describe('native column helpers', () => {
  it('keeps XML in memory within the per-part budget and spills everything else', () => {
    expect(spillPart('ppt/slides/slide1.xml', 1000)).toBe(false);
    expect(spillPart('ppt/slides/_rels/slide1.xml.rels', 1000)).toBe(false);
    expect(spillPart('ppt/slides/slide1.xml', 9 * 1024 * 1024)).toBe(true);
    expect(spillPart('ppt/media/image1.png', 10)).toBe(true);
    expect(spillPart('ppt/embeddings/oleObject1.bin', 10)).toBe(true);
  });

  it('draws only the picture types Chromium decodes', () => {
    expect(sniffPicture(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10]))).toBe('png');
    expect(sniffPicture(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffPicture(new TextEncoder().encode('GIF89a'))).toBe('gif');
    expect(sniffPicture(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffPicture(new TextEncoder().encode('BM\0\0'))).toBe('bmp');
    // EMF, TIFF, SVG: not offered to the page.
    expect(sniffPicture(new Uint8Array([1, 0, 0, 0, 0x6c, 0, 0, 0]))).toBeUndefined();
    expect(sniffPicture(new TextEncoder().encode('II*\0'))).toBeUndefined();
    expect(sniffPicture(new TextEncoder().encode('<svg xmlns'))).toBeUndefined();
    expect(sniffPicture(new Uint8Array())).toBeUndefined();
  });

  it('finds and renames every fontFamily, keys like __proto__ staying plain keys', () => {
    const style = { fontFamily: ' Calibri ', fontWeight: 700 };
    const s = JSON.parse(
      JSON.stringify(
        slide([
          {
            id: 't',
            type: 'text',
            box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
            text: 'x',
            style,
            opacity: 1,
          } as Slide['objects'][number],
        ]),
      ).replace('"opacity":1', '"opacity":1,"__proto__":{"fontFamily":"Evil"}'),
    ) as Slide;
    expect([...familiesOf([s])].sort()).toEqual(['Calibri', 'Evil']);
    const renamed = renameFamilies(s, new Map([['Calibri', 'ordo-native-1']]));
    const o = renamed.objects[0] as unknown as Record<string, unknown> & { style: { fontFamily: string } };
    expect(o.style.fontFamily).toBe('ordo-native-1');
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect(Object.hasOwn(o, '__proto__')).toBe(true);
    expect(s.objects[0]!.type === 'text' && s.objects[0]!.style.fontFamily).toBe(' Calibri ');
  });

  it('sizes each picture by its widest and tallest use at 3840 px', () => {
    const img = (id: string, w: number, h: number, crop?: object) =>
      ({
        id,
        type: 'image',
        box: { x: 0, y: 0, w, h, rotation: 0 },
        mediaId: id,
        fit: 'stretch',
        opacity: 1,
        radius: 0,
        ...(crop ? { crop } : {}),
      }) as Slide['objects'][number];
    const need = picturesNeeded([
      slide([img('a', 960, 100), img('b', 400, 300, { l: 0.25, r: 0.25, t: 0, b: 0.5 })], {
        backgroundMediaId: 'bg',
      }),
      slide([img('a', 100, 540)]),
    ]);
    expect(need.get('a')).toEqual({ w: 1920, h: 1080 });
    expect(need.get('b')).toEqual({ w: 1600, h: 1200 });
    expect(need.get('bg')).toEqual({ w: 3840, h: 2160 });
  });
});

describe('convertDeck', () => {
  it('writes slides.json and the pictures, keyed by the shown index', async () => {
    const dir = await work();
    const out = join(dir, 'native');
    await mkdir(out);
    const d = await convertDeck(await deck('LAYOUT_16x9'), out);
    expect(d.error).toBeUndefined();
    expect(d.slides.map((s) => [s.hidden, s.shown])).toEqual([
      [false, 0],
      [true, undefined],
      [false, 1],
    ]);
    for (const s of d.slides) {
      expect(s.tier).toMatch(/^(T[1-5]|fallback)$/);
      expect(s.convertMs).toBeGreaterThanOrEqual(0);
    }
    expect(d.slideRect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(d.media).toHaveLength(1);
    expect(d.media[0]).toMatchObject({ file: 'media/1.png', type: 'png' });
    expect(existsSync(join(out, 'media/1.png'))).toBe(true);
    expect(existsSync(join(out, '.parts'))).toBe(false);
    const json = JSON.parse(await readFile(join(out, 'slides.json'), 'utf8')) as typeof d;
    expect(json.slides).toHaveLength(3);
    expect(
      json.slides[0]!.slide.objects.some((o) => o.type === 'image' && o.mediaId === d.media[0]!.id),
    ).toBe(true);
  });

  it('turns a deck it cannot read into a note', async () => {
    const dir = await work();
    const bad = join(dir, 'bad.pptx');
    await writeFile(bad, 'not a zip');
    const d = await convertDeck(bad, dir);
    expect(d.error).toBeTruthy();
    expect(d.slides).toEqual([]);
    expect(d.notes.join('\n')).toMatch(/converter failed/);
    expect(JSON.parse(await readFile(join(dir, 'slides.json'), 'utf8')).error).toBe(d.error);
  });

  it('reads the pixel size of a spilled picture from its header', async () => {
    const dir = await work();
    const file = join(dir, 'p.png');
    await writeFile(file, testPicture(320, 180));
    expect(spilledPictureSize(file)).toEqual({ w: 320, h: 180 });
    expect(spilledPictureSize(join(dir, 'missing.png'))).toBeUndefined();
    expect(spilledPictureSize(undefined)).toBeUndefined();
  });

  it('isolates a conversion: one that runs out of time is a note, its spill folder removed', async () => {
    const dir = await work();
    await mkdir(join(dir, '.parts'));
    const d = await convertDeckIsolated(await deck('LAYOUT_16x9'), dir, { timeoutMs: 1 });
    expect(d.error).toBeTruthy();
    expect(d.slides).toEqual([]);
    expect(d.notes[0]).toMatch(/^converter failed: /);
    expect(existsSync(join(dir, '.parts'))).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'slides.json'), 'utf8')).error).toBe(d.error);
  });
});

/** A Chromium to drive: ORDO_TEST_CHROMIUM, else Playwright's when it is installed. */
async function findChromium(): Promise<string | undefined> {
  if (process.env.ORDO_TEST_CHROMIUM) return process.env.ORDO_TEST_CHROMIUM;
  try {
    const { chromium } = await import('@playwright/test');
    const exe = chromium.executablePath();
    return existsSync(exe) ? exe : undefined;
  } catch {
    return undefined;
  }
}

const chromium = await findChromium();

describe.skipIf(!chromium)('NativeRenderer (headless Chromium)', () => {
  const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

  it('draws every shown slide cut to the slide area, with raster timings', async () => {
    const r = await NativeRenderer.start(chromium!);
    try {
      for (const [layout, size] of [
        ['LAYOUT_16x9', [1920, 1080]],
        ['LAYOUT_4x3', [1440, 1080]],
      ] as const) {
        const dir = await work();
        const d = await convertDeck(await deck(layout), dir);
        const drawn = await r.renderDeck(d, dir, 1);
        expect(drawn.notes).toEqual([]);
        expect(drawn.slides.map((s) => [s.shown, s.png, s.error])).toEqual([
          [0, 'slide-0001.png', undefined],
          [1, 'slide-0002.png', undefined],
        ]);
        expect((await readdir(dir)).filter((f) => f.endsWith('.png')).sort()).toEqual([
          'slide-0001.png',
          'slide-0002.png',
        ]);
        const first = await readFile(join(dir, 'slide-0001.png'));
        expect(pngSize(first)).toEqual(size);
        for (const s of drawn.slides) {
          expect(s.rasterMs!['1920']).toBeGreaterThan(0);
          expect(s.rasterMs!['3840']).toBeGreaterThan(0);
        }
      }
    } finally {
      await r.close();
    }
  }, 120_000);
});

describe('report numbers', () => {
  const deckScore = (name: string, extra: Partial<DeckScore>, slides: DeckScore['perSlide']): DeckScore => ({
    name,
    slides: slides.length,
    notes: [],
    perSlide: slides,
    nativeSlides: slides.length,
    ...extra,
  });

  it('shares count every shown slide; means leave decks with embedded fonts out', () => {
    const decks = [
      deckScore('a', { nativeSsim: 0.9, features: ['kern'], worship: true }, [
        { n: 1, tier: 'T1', class: 'native', reasons: [], nativeSsim: 0.9, blackSsim: 0.1, convertMs: 1 },
        { n: 2, tier: 'T2', class: 'native', reasons: ['bullet'], nativeSsim: 0.8, blackSsim: 0.85 },
      ]),
      deckScore('b', { nativeSsim: 0.2, embeddedFonts: true, features: ['kern'] }, [
        { n: 1, tier: 'T1', class: 'native', reasons: [], nativeSsim: 0.2, blackSsim: 0.1 },
      ]),
    ];
    const st = nativeStats(decks);
    expect(st.slides).toBe(3);
    expect(st.scored).toBe(2);
    expect(st.meanNative).toBeCloseTo(0.85);
    expect(st.beatsBlack).toBe(0.5);
    const t1 = st.tiers.find((t) => t.key === 'T1')!;
    expect(t1.count).toBe(2);
    expect(t1.share).toBeCloseTo(2 / 3);
    expect(t1.native).toBeCloseTo(0.9);
    expect(st.tiers.map((t) => t.key)).toEqual(['T1', 'T2']);
    expect(featureRows(decks)).toEqual([{ key: 'kern', count: 1, share: 1, native: 0.9 }]);
  });

  it('counts a native picture that matches the page as beating black, even when black ties it', () => {
    expect(beatsBlack({ n: 1, nativeSsim: 1, blackSsim: 1 })).toBe(true);
    expect(beatsBlack({ n: 1, nativeSsim: 0.6, blackSsim: 0.6 })).toBe(false);
    expect(beatsBlack({ n: 1, nativeSsim: 0.61, blackSsim: 0.6 })).toBe(true);
    expect(beatsBlack({ n: 1, blackSsim: 0.6 })).toBe(false);
  });
});
