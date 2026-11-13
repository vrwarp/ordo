import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pptxgen from 'pptxgenjs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BeforeHub,
  boundsOf,
  needsHub,
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
