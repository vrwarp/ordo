import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pptxgen from 'pptxgenjs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type AskedSlide,
  askedSet,
  BeforeHub,
  boundsOf,
  hubBeforeOf,
  hubSessionOptions,
  keepsPage,
  needsHub,
  noLoAskedSet,
  noLoHubFields,
  pagePx,
  pasteLibreOffice,
  pasteRegions,
  pasteSsim,
} from './beforehub.ts';
import { hubClasses } from './census.ts';
import { findOnPath } from './hub-import.ts';
import { drawWithLibreOffice } from './libreoffice.ts';
import { convertDeck, NativeRenderer } from './native.ts';
import { png } from './png.ts';
import { ssim } from './ssim.ts';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(join(tmpdir(), 'ordo-beforehub-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The RGB of one pixel of a PNG (ffmpeg). */
function rgb(file: string, x: number, y: number): number[] {
  return [
    ...execFileSync('ffmpeg', [
      ...['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y}`],
      ...['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    ]),
  ];
}

const SLIDE = { x: 0, y: 0, w: 1920, h: 1080 };
/** The middle of the slide: 480..1440 x 270..810 logical px. */
const ART = { x: 480, y: 270, w: 960, h: 540, rotation: 0 };

describe('which slides the hub is asked for', () => {
  it('asks for every slide not stored native, one with pending metafiles, and one never converted', () => {
    expect(needsHub({ hub: 'native' })).toBe(false);
    expect(needsHub({ hub: 'native', metafiles: [] })).toBe(false);
    expect(needsHub({ hub: 'native', metafiles: [{ x: 0, y: 0, w: 1, h: 1 }] })).toBe(true);
    expect(needsHub({ hub: 'hybrid', art: ART })).toBe(true);
    expect(needsHub({ hub: 'picture' })).toBe(true);
    // Stored plain by its slide budget: native in the census, LibreOffice's page on a hub with LibreOffice.
    expect(needsHub({ hub: 'native', budget: true })).toBe(true);
    // The converter did not emit it: the hub shows LibreOffice's picture of it.
    expect(needsHub(undefined)).toBe(true);
  });

  it("asks for a slide a hub with LibreOffice keeps as LibreOffice's page (keepsPage, ImportCore.pageForBudget)", () => {
    const stored = { hub: 'native' as const, hubWhy: null, level: 'full', stored: 9_000 };
    // Fitted by leaving something out: the page, as before M9.
    expect(keepsPage({ ...stored, hubWhy: 'slide', level: 'plain' })).toBe(true);
    expect(keepsPage({ ...stored, hubWhy: 'slide', level: 'minimal' })).toBe(true);
    expect(keepsPage({ ...stored, hubWhy: 'slide', level: 'grid' })).toBe(false);
    expect(keepsPage(stored)).toBe(false);
    // A picture slide is LibreOffice's page whatever the rule says (`needsHub` asks for it by its class).
    expect(keepsPage({ ...stored, hub: 'picture', hubWhy: 'slide', level: 'minimal' })).toBe(false);
  });

  it('builds the asked set as main.ts does: never for tables (the interim rule is gone), and the slides --ask-hub names', () => {
    const full = { hub: 'native' as const, hubWhy: null, level: 'full', stored: 9_000 };
    const plain = { ...full, hubWhy: 'slide', level: 'plain' };
    // A scene from a run of the interim rule's build, read back from its slides.json: it still carries what
    // its tables would add as their M6 group (86,079 B: past 64 KB with the slide's 9,000).
    const older = JSON.parse('{"tableGroupBytes":86079}') as AskedSlide;
    const models = [full, plain, full];
    const slides: (AskedSlide | undefined)[] = [older, {}, undefined];
    const before = (i: number) => hubBeforeOf(slides[i], models[i]);
    const lo = ['p1.png', 'p2.png', 'p3.png', undefined];
    // The table slide stays the table object on a hub with LibreOffice: not asked; the plain slide keeps its
    // page; a slide the converter did not emit is LibreOffice's picture; a slide without a page is never asked.
    expect([...askedSet({ n: 4, lo, before })]).toEqual([1, 2]);
    expect(before(0)).toEqual({ hub: 'native' });
    expect([...askedSet({ n: 4, lo, before, only: new Set([0, 1]) })]).toEqual([1]);
    // A table slide the ladder fitted plain keeps the table object, never LibreOffice's page (pageForBudget).
    expect(hubBeforeOf({ table: true }, plain)).toEqual({ hub: 'native' });
    expect(hubBeforeOf({}, plain)).toEqual({ hub: 'native', budget: true });
    // `--ask-hub` adds a slide the hub stores as the native column draws it (never one without a page, nor
    // one `--slides` leaves out).
    const extra = new Set([0, 3]);
    expect([...askedSet({ n: 4, lo, before, extra })]).toEqual([0, 1, 2]);
    expect([...askedSet({ n: 4, lo, before, extra, only: new Set([1, 3]) })]).toEqual([1]);
  });
});

describe('a hub without LibreOffice asked (--ask-hub-nolo, sub-wave 1c)', () => {
  it('starts that hub with the lite tools only on its PATH (no soffice) and LibreOffice off; the other as before', async () => {
    const bin = join(dir, 'nolo-bin');
    mkdirSync(bin, { recursive: true });
    for (const t of ['ffmpeg', 'ffprobe', 'soffice', 'libreoffice', 'pdftoppm', 'pdfinfo', 'prlimit'])
      writeFileSync(join(bin, t), '#!/bin/sh\n', { mode: 0o755 });
    const nolo = await hubSessionOptions({ dir: join(dir, 'nolo-hub'), libreoffice: false, from: bin });
    expect(nolo.path).toBeDefined();
    expect(await findOnPath('soffice', nolo.path)).toBeUndefined();
    expect(await findOnPath('libreoffice', nolo.path)).toBeUndefined();
    expect(await findOnPath('ffmpeg', nolo.path)).toBe(join(nolo.path!, 'ffmpeg'));
    expect(nolo.env).toEqual({ ORDO_LIBREOFFICE: 'off' });
    // With LibreOffice: this process's PATH and the hub's own default, as before.
    expect(await hubSessionOptions({ dir: join(dir, 'lo-hub'), libreoffice: true, from: bin })).toEqual({});
  });

  it('asks it for the slides --ask-hub-nolo names, or every table slide (all-tables), never one without a page', () => {
    const lo = ['p1.png', 'p2.png', 'p3.png', undefined, 'p5.png'];
    const tables = new Set([1, 3, 4]);
    const isTable = (i: number) => tables.has(i);
    expect([...noLoAskedSet({ n: 5, lo, isTable })]).toEqual([]);
    expect([...noLoAskedSet({ n: 5, lo, isTable, extra: new Set([0, 3]) })]).toEqual([0]);
    expect([...noLoAskedSet({ n: 5, lo, isTable, allTables: true })]).toEqual([1, 4]);
    expect([...noLoAskedSet({ n: 5, lo, isTable, allTables: true, only: new Set([0, 1]) })]).toEqual([1]);
    expect([...noLoAskedSet({ n: 5, lo, isTable, allTables: true, extra: new Set([2]) })]).toEqual([1, 2, 4]);
  });

  it("writes its score as noLoHubSsim with noLoHubFrom 'hub' (never beforeHubSsim), or why it has none", () => {
    const got = {
      scores: new Map([[1, 0.6337]]),
      failed: new Set<number>(),
      notes: [],
      why: new Map([[2, 'pending']]),
    };
    const asked = new Set([1, 2, 3]);
    expect(noLoHubFields(1, asked, got)).toEqual({ noLoHubSsim: 0.6337, noLoHubFrom: 'hub' });
    expect(noLoHubFields(2, asked, got)).toEqual({ noLoHubFrom: 'pending' });
    expect(noLoHubFields(3, asked, got)).toEqual({ noLoHubFrom: 'no score' });
    expect(noLoHubFields(0, asked, got)).toEqual({});
    for (const i of [0, 1, 2, 3]) expect(noLoHubFields(i, asked, got)).not.toHaveProperty('beforeHubSsim');
  });
});

describe('regions', () => {
  it('turns a box into its bounds, and pastes only the art of a hybrid slide and the metafiles', () => {
    const b = boundsOf({ x: 0, y: 0, w: 200, h: 100, rotation: 90 });
    expect([b.x, b.y, b.w, b.h].map((v) => Math.round(v))).toEqual([50, -50, 100, 200]);
    const mf = { x: 10, y: 10, w: 20, h: 20, rotation: 0 };
    expect(pasteRegions({ hub: 'picture', art: ART, metafiles: [mf] })).toEqual([]);
    expect(pasteRegions({ hub: 'native', art: ART })).toEqual([]);
    expect(pasteRegions({ hub: 'native', metafiles: [mf] })).toEqual([{ x: 10, y: 10, w: 20, h: 20 }]);
    expect(pasteRegions({ hub: 'hybrid', art: ART, metafiles: [mf] })).toHaveLength(2);
    // Past the cap, one bounding box.
    const many = Array.from({ length: 40 }, (_, i) => ({ x: i * 10, y: 0, w: 5, h: 5 }));
    expect(pasteRegions({ hub: 'native', metafiles: many })).toEqual([{ x: 0, y: 0, w: 395, h: 5 }]);
  });

  it("maps a logical region onto a page's px, grown and cut to the page", () => {
    expect(pagePx(ART, SLIDE, 192, 108)).toEqual({ x: 46, y: 25, w: 147 - 46, h: 84 - 25 });
    // LibreOffice's page one pixel wider than the slide: the same px as the native page's.
    expect(pagePx(ART, SLIDE, 1921, 1080)).toEqual(pagePx(ART, SLIDE, 1920, 1080));
    expect(pagePx({ x: 1900, y: 1000, w: 500, h: 500 }, SLIDE, 1920, 1080)).toEqual({
      x: 1898,
      y: 998,
      w: 22,
      h: 82,
    });
    expect(pagePx({ x: 3000, y: 0, w: 10, h: 10 }, SLIDE, 1920, 1080)).toBeUndefined();
  });
});

describe.skipIf(!hasFfmpeg)('--before hub', () => {
  // LibreOffice's page: blue, with a red rectangle in the art box. The native page: green (art box blank).
  const inArt = (x: number, y: number, s: number) =>
    x >= ART.x * s && x < (ART.x + ART.w) * s && y >= ART.y * s && y < (ART.y + ART.h) * s;
  const lo = join(dir, 'lo.png');
  writeFileSync(
    lo,
    png(192, 108, (x, y) => (inArt(x, y, 0.1) ? [255, 0, 0, 255] : [0, 0, 255, 255])),
  );
  const loBig = join(dir, 'lo-big.png');
  writeFileSync(
    loBig,
    png(384, 216, (x, y) => (inArt(x, y, 0.2) ? [255, 0, 0, 255] : [0, 0, 255, 255])),
  );
  const native = join(dir, 'native.png');
  writeFileSync(
    native,
    png(192, 108, () => [0, 200, 0, 255]),
  );

  it("--before hub pastes LibreOffice's art-box pixels and uses LibreOffice's page for picture slides", async () => {
    const out = join(dir, 'pasted.png');
    expect(await pasteLibreOffice(native, lo, [ART], SLIDE, out)).toBe(true);
    expect(rgb(out, 96, 54)).toEqual([255, 0, 0]); // inside the art: LibreOffice's art
    expect(rgb(out, 46, 25)).toEqual([0, 0, 255]); // the grown edge: LibreOffice's background
    expect(rgb(out, 10, 10)).toEqual([0, 200, 0]); // outside: the native page
    expect(rgb(out, 150, 90)).toEqual([0, 200, 0]);

    const nativeSsim = await ssim(lo, native);
    const page = { lo, native, nativeSsim, rect: SLIDE, scratch: join(dir, 'scratch.png') };
    const hybrid = await pasteSsim({ hub: 'hybrid', art: ART }, page);
    expect(hybrid).toBeGreaterThan(nativeSsim);
    expect(hybrid).toBeCloseTo(await ssim(lo, out), 6);
    // A picture slide is LibreOffice's page; a native slide is what the native column drew.
    expect(await pasteSsim({ hub: 'picture', art: ART }, { ...page, lo: join(dir, 'none.png') })).toBe(1);
    expect(await pasteSsim({ hub: 'native' }, page)).toBe(nativeSsim);
  });

  it("scales LibreOffice's pixels to the native page where the pages differ in size", async () => {
    const out = join(dir, 'pasted-big.png');
    expect(await pasteLibreOffice(native, loBig, [ART], SLIDE, out)).toBe(true);
    expect(rgb(out, 96, 54)).toEqual([255, 0, 0]);
    expect(rgb(out, 10, 10)).toEqual([0, 200, 0]);
    // Several regions in one picture.
    const two = join(dir, 'pasted-two.png');
    const corner = { x: 0, y: 0, w: 200, h: 200 };
    expect(await pasteLibreOffice(native, lo, [ART, corner], SLIDE, two)).toBe(true);
    expect(rgb(two, 5, 5)).toEqual([0, 0, 255]);
    expect(rgb(two, 96, 54)).toEqual([255, 0, 0]);
    expect(rgb(two, 150, 20)).toEqual([0, 200, 0]);
  });
});

/** Chromium for the renderer (as native.test.ts finds it) and LibreOffice for the hub's art. */
async function tools(): Promise<string | undefined> {
  if (!(await findOnPath('soffice')) || !(await findOnPath('ffmpeg'))) return undefined;
  if (process.env.ORDO_TEST_CHROMIUM) return process.env.ORDO_TEST_CHROMIUM;
  try {
    const exe = (await import('@playwright/test')).chromium.executablePath();
    return existsSync(exe) ? exe : undefined;
  } catch {
    return undefined;
  }
}
const chromium = await tools();

describe.skipIf(!chromium)('--before hub through a real hub', () => {
  it("draws the hub's version 2 of a hybrid slide, LibreOffice's art in it, and scores it", async () => {
    const work = mkdtempSync(join(tmpdir(), 'ordo-beforehub-'));
    const p = new pptxgen();
    p.layout = 'LAYOUT_16x9';
    p.addSlide().addText('Amazing grace', { x: 1, y: 1, w: 6, h: 1, fontFace: 'Arial', fontSize: 40 });
    const chart = p.addSlide();
    chart.addText('Offering', { x: 0.5, y: 0.3, w: 6, h: 0.8, fontFace: 'Arial', fontSize: 32 });
    chart.addChart(p.ChartType.bar, [{ name: 'Gifts', labels: ['A', 'B', 'C'], values: [3, 5, 2] }], {
      x: 1,
      y: 1.3,
      w: 8,
      h: 4,
      chartColors: ['C00000'],
    });
    const deck = join(work, 'deck.pptx');
    writeFileSync(deck, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
    const loDir = join(work, 'lo');
    mkdirSync(loDir);
    const lo = await drawWithLibreOffice(deck, loDir);
    const nd = join(work, 'native');
    mkdirSync(nd);
    const conv = await convertDeck(deck, nd);
    const hub = hubClasses(conv.slides, conv.geoms ?? []).map((h) => h.hub);
    expect(hub).toEqual(['native', 'hybrid']);
    const renderer = await NativeRenderer.start(chromium!);
    const before = new BeforeHub({ dir: join(work, 'hub') });
    try {
      const drawn = await renderer.renderDeck(conv, nd, { repeats: 0 });
      const blankArt = await ssim(lo[1]!, join(nd, drawn.slides[1]!.png!));
      const r = await before.score({
        deck,
        shown: new Set([1]),
        lo,
        rect: conv.slideRect,
        renderer,
        work: join(work, 'v2'),
      });
      expect(r.notes.filter((n) => /gave no score|import failed|follow-up failed/.test(n))).toEqual([]);
      // Only the slide asked for, with LibreOffice's chart drawn in: far closer to LibreOffice than the blank box.
      expect([...r.scores.keys()]).toEqual([1]);
      expect(r.scores.get(1)!).toBeGreaterThan(blankArt + 0.02);
      expect(r.scores.get(1)!).toBeGreaterThan(0.9);
      expect(existsSync(join(work, 'v2'))).toBe(false);
    } finally {
      await before.close();
      await renderer.close();
      rmSync(work, { recursive: true, force: true });
    }
    expect(existsSync(join(work, 'hub'))).toBe(false);
  }, 300_000);
});

describe.skipIf(!chromium)('--ask-hub-nolo through a real hub without LibreOffice (sub-wave 1c)', () => {
  it('imports through a hub that has no LibreOffice (capabilities say off), draws what it stores and scores it', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ordo-beforehub-nolo-'));
    const p = new pptxgen();
    p.layout = 'LAYOUT_16x9';
    p.addSlide().addText('Amazing grace', { x: 1, y: 1, w: 6, h: 1, fontFace: 'Arial', fontSize: 40 });
    p.addSlide().addTable(
      [
        [{ text: 'Hymn' }, { text: 'Page' }],
        [{ text: 'Amazing grace' }, { text: '12' }],
      ],
      {
        x: 1,
        y: 1,
        w: 8,
        colW: [6, 2],
        fontFace: 'Arial',
        fontSize: 24,
        border: { type: 'solid', pt: 1, color: '000000' },
      },
    );
    const deck = join(work, 'deck.pptx');
    writeFileSync(deck, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
    const loDir = join(work, 'lo');
    mkdirSync(loDir);
    const lo = await drawWithLibreOffice(deck, loDir);
    const nd = join(work, 'native');
    mkdirSync(nd);
    const conv = await convertDeck(deck, nd);
    expect(conv.slides[1]!.table).toBe(true);
    const renderer = await NativeRenderer.start(chromium!);
    const nolo = new BeforeHub({ dir: join(work, 'hub'), libreoffice: false });
    try {
      const r = await nolo.score({
        deck,
        shown: new Set([1]),
        lo,
        rect: conv.slideRect,
        renderer,
        work: join(work, 'v1'),
      });
      expect(r.notes.filter((n) => /gave no score|import failed|follow-up/.test(n))).toEqual([]);
      expect(nolo.info()).toMatchObject({ libreoffice: false, state: 'off', entry: 'source' });
      expect([...r.scores.keys()]).toEqual([1]);
      expect(r.scores.get(1)!).toBeGreaterThan(0.8);
      expect(noLoHubFields(1, new Set([1]), r)).toEqual({ noLoHubSsim: r.scores.get(1), noLoHubFrom: 'hub' });
    } finally {
      await nolo.close();
      await renderer.close();
      rmSync(work, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('the settings a measure passes to the hub it asks (Q53)', () => {
  it('passes ORDO_PRERENDER and ORDO_CHROMIUM through when the tool has them, and nothing otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordo-hubopts-'));
    try {
      expect(await hubSessionOptions({ dir, libreoffice: true, parent: {} })).toEqual({});
      expect(
        await hubSessionOptions({
          dir,
          libreoffice: true,
          parent: { ORDO_PRERENDER: 'on', ORDO_CHROMIUM: '/x/chrome', OTHER: 'no' },
        }),
      ).toEqual({ env: { ORDO_PRERENDER: 'on', ORDO_CHROMIUM: '/x/chrome' } });
      const lite = await hubSessionOptions({ dir, libreoffice: false, parent: { ORDO_PRERENDER: 'on' } });
      expect(lite.env).toEqual({ ORDO_LIBREOFFICE: 'off', ORDO_PRERENDER: 'on' });
      expect((await hubSessionOptions({ dir, libreoffice: false, parent: {} })).env).toEqual({
        ORDO_LIBREOFFICE: 'off',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
