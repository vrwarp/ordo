import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Slide, TextObject } from '@ordo/domain';
import pptxgen from 'pptxgenjs';
import { afterAll, describe, expect, it } from 'vitest';
import { familiesOf, fcFamily, fcMatch, isStandIn } from './fonts.ts';
import {
  caseless,
  convertDeck,
  convertDeckIsolated,
  type NativeDeck,
  NativeRenderer,
  picturesNeeded,
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

/** A deck for text features and policies: outlined text with a verse number, plain text, Hebrew. */
async function textDeck(): Promise<string> {
  const p = new pptxgen();
  p.layout = 'LAYOUT_16x9';
  p.addSlide().addText(
    [
      { text: '16', options: { superscript: true } },
      { text: ' For God so loved the world', options: {} },
    ],
    { x: 0.5, y: 0.5, w: 9, h: 1.5, fontSize: 40, color: 'FFFFFF', outline: { size: 1.5, color: '000000' } },
  );
  p.addSlide().addText('How sweet the sound', { x: 1, y: 1, w: 6, h: 1, fontSize: 32 });
  p.addSlide().addText('שלום עולם', { x: 1, y: 1, w: 6, h: 1, fontSize: 32, rtlMode: true });
  const dir = await work();
  const file = join(dir, 'text.pptx');
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

  it('finds every fontFamily and fallback family, keys like __proto__ staying plain keys', () => {
    const style = { fontFamily: ' Calibri ', fontWeight: 700, fallbackFonts: ['Carlito', ' ', 7] };
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
          } as unknown as Slide['objects'][number],
        ]),
      ).replace('"opacity":1', '"opacity":1,"__proto__":{"fontFamily":"Evil"}'),
    ) as Slide;
    expect([...familiesOf([s])].sort()).toEqual(['Calibri', 'Carlito', 'Evil']);
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

  it("records each slide's text features and the LibreOffice policies that change it", async () => {
    const file = await textDeck();
    const dir = await work();
    const d = await convertDeck(file, dir);
    expect(d.slides.map((s) => s.textFeatures)).toEqual([
      ['superSub', 'mixedRuns'],
      [],
      ['rtl', 'rtlScriptText'],
    ]);
    expect(d.textFeatures).toEqual(['superSub', 'rtl', 'rtlScriptText', 'mixedRuns']);
    expect(d.slides.map((s) => s.compat)).toEqual([['textOutline'], [], []]);
    // Without --lo-compat only the rules are kept.
    expect(d.slides.some((s) => s.compatSlide)).toBe(false);
    const lo = await convertDeck(file, await work(), { loCompat: true });
    const [first, second] = lo.slides;
    const outlined = (s: Slide) => s.objects.some((o) => o.type === 'text' && o.style.outline);
    expect(outlined(first!.slide)).toBe(true);
    expect(outlined(first!.compatSlide!)).toBe(false);
    expect(second!.compatSlide).toBeUndefined();
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

  it('reads the pixel size of a spilled picture from its header, and whether it may be transparent', async () => {
    const dir = await work();
    const file = join(dir, 'p.png');
    await writeFile(file, testPicture(320, 180));
    expect(spilledPictureSize(file)).toMatchObject({ w: 320, h: 180 });
    expect(typeof spilledPictureSize(file)?.alpha).toBe('boolean');
    expect(spilledPictureSize(join(dir, 'missing.png'))).toBeUndefined();
    expect(spilledPictureSize(undefined)).toBeUndefined();
  });

  it('finds spilled parts without case, the first of a clash winning, from an index built once', () => {
    const index = caseless(
      new Map([
        ['ppt/media/Image1.PNG', '/spill/1'],
        ['ppt/media/image1.png', '/spill/2'],
      ]),
    );
    expect(index.get('ppt/media/image1.png')).toBe('/spill/1');
    expect(index.size).toBe(1);
  });

  it('converts a deck in its worker thread', async () => {
    const dir = await work();
    const d = await convertDeckIsolated(await deck('LAYOUT_16x9'), dir, { timeoutMs: 60_000 });
    expect(d.error).toBeUndefined();
    expect(d.slides).toHaveLength(3);
  }, 90_000);

  it.skipIf(process.platform === 'win32')(
    'isolates a conversion: one that never ends times out, is a note, and its spill folder is removed',
    async () => {
      // A named pipe nobody writes: opening the deck blocks for good, so the conversion provably hangs.
      const dir = await work();
      const fifo = join(dir, 'hangs.pptx');
      execFileSync('mkfifo', [fifo]);
      await mkdir(join(dir, '.parts'));
      const d = await convertDeckIsolated(fifo, dir, { timeoutMs: 2_000 });
      expect(d.error).toBe('timed out after 2 s');
      expect(d.slides).toEqual([]);
      expect(d.notes).toEqual(['converter failed: timed out after 2 s']);
      expect(existsSync(join(dir, '.parts'))).toBe(false);
      expect(JSON.parse(await readFile(join(dir, 'slides.json'), 'utf8')).error).toBe(d.error);
      // Release the blocked open (it holds a thread of the process's I/O pool), then the next deck converts
      // in a fresh worker.
      await (await open(fifo, 'w')).close();
      const next = await convertDeckIsolated(await deck('LAYOUT_16x9'), await work(), { timeoutMs: 60_000 });
      expect(next.slides).toHaveLength(3);
    },
    90_000,
  );
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
        const drawn = await r.renderDeck(d, dir, { repeats: 1 });
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
        expect(drawn.fonts!.loaded).toBe(drawn.fonts!.offered);
        expect(drawn.fonts!.loaded).toBeGreaterThan(0);
      }
    } finally {
      await r.close();
    }
  }, 120_000);

  it('draws the slides asked for, both ways under --lo-compat, through the font resolver', async () => {
    const r = await NativeRenderer.start(chromium!);
    try {
      const dir = await work();
      const d = await convertDeck(await textDeck(), dir, { loCompat: true });
      const req = {
        family: 'Calibri',
        fallbacks: [],
        weight: 400,
        italic: false,
        smallCaps: false,
        sizePx: 20,
      };
      const drawn = await r.renderDeck(d, dir, {
        repeats: 0,
        only: new Set([0, 2]),
        loCompat: true,
        standIns: true,
        probe: [
          { ...req, script: '' },
          { ...req, script: 'Hebr' },
        ],
      });
      expect(drawn.notes).toEqual([]);
      expect(drawn.slides.map((s) => [s.shown, s.png, s.policyPng, s.rasterMs])).toEqual([
        [0, 'slide-0001.png', 'slide-0001.policy.png', undefined],
        [2, 'slide-0003.png', undefined, undefined],
      ]);
      expect((await readdir(dir)).filter((f) => f.endsWith('.png')).sort()).toEqual([
        'slide-0001.png',
        'slide-0001.policy.png',
        'slide-0003.png',
      ]);
      // Outlined and plain letters differ: the two pictures of the first slide are not the same.
      expect(
        (await readFile(join(dir, 'slide-0001.png'))).equals(
          await readFile(join(dir, 'slide-0001.policy.png')),
        ),
      ).toBe(false);
      // Calibri resolves to an internal name (fontconfig's face), never to its own name; Hebrew text adds
      // the script fallback (a stand-in where it is not installed) after it.
      const [latin, hebrew] = drawn.probes!;
      expect(latin).toMatch(/^400 20px "o[0-9a-f]{8}", /);
      expect(latin).not.toContain('"Calibri"');
      const stack = (css: string) => css.slice('400 20px '.length).split(', ');
      expect(stack(hebrew!)).toHaveLength(stack(latin!).length + 1);
      expect(stack(hebrew!)[0]).toBe(stack(latin!)[0]);
      expect(r.scriptFallbacks().find((f) => f.family === 'Noto Sans Hebrew')?.served).toMatch(
        /^(installed|stand-in)$/,
      );
    } finally {
      await r.close();
    }
  }, 120_000);

  it("keeps PowerPoint's stored autofit scale only for a family drawn in its own widths", async () => {
    // Each slide is drawn with PowerPoint's stored 50 % (ordo's way) and without it (LibreOffice's way); the
    // short text fits at full size, so the two pictures are the same exactly when the stored scale is
    // dropped, which is when fontconfig's face for the family is a stand-in of other widths.
    const box = (fontFamily: string, fit: boolean, fallbackFonts?: string[]): Slide => {
      const o: TextObject = {
        id: 't',
        type: 'text',
        box: { x: 100, y: 100, w: 1400, h: 600, rotation: 0 },
        text: 'Amazing grace, how sweet the sound',
        style: {
          fontFamily,
          fontWeight: 400,
          fontStyle: 'normal',
          fontSizePx: 80,
          color: { r: 255, g: 255, b: 255, a: 1 },
          align: 'left',
          valign: 'top',
          lineHeight: 1.2,
          letterSpacing: 0,
          padding: 0,
          transform: 'none',
          lineModel: 'office',
          autofit: 'shrink',
          ...(fit ? { fitScale: { font: 0.5, spacing: 1 } } : {}),
          ...(fallbackFonts ? { fallbackFonts } : {}),
        },
        opacity: 1,
      };
      return slide([o]);
    };
    const cases = [
      { family: 'Aptos', fallbacks: undefined },
      { family: 'Calibri', fallbacks: ['Carlito'] },
    ];
    const deck: NativeDeck = {
      slides: cases.map((c, i) => ({
        index: i,
        shown: i,
        hidden: false,
        tier: 'T1',
        class: 'native',
        reasons: [],
        convertMs: 0,
        notes: [],
        slide: box(c.family, true, c.fallbacks),
        compatSlide: box(c.family, false, c.fallbacks),
        textFeatures: [],
        compat: ['refit'],
      })),
      slideRect: { x: 0, y: 0, w: 1920, h: 1080 },
      media: [],
      notes: [],
      embeddedFonts: false,
      textFeatures: [],
      extractMs: 0,
      parseMs: 0,
      emitMs: 0,
    };
    const r = await NativeRenderer.start(chromium!);
    try {
      const dir = await work();
      const drawn = await r.renderDeck(deck, dir, { repeats: 0, loCompat: true });
      expect(drawn.notes).toEqual([]);
      for (const [i, c] of cases.entries()) {
        const host = (await fcMatch(fcFamily(c.family)))!;
        const n = String(i + 1).padStart(4, '0');
        const ordo = await readFile(join(dir, `slide-${n}.png`));
        const lo = await readFile(join(dir, `slide-${n}.policy.png`));
        expect(ordo.equals(lo), `${c.family} drawn with ${host.family}`).toBe(isStandIn(c.family, host));
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
