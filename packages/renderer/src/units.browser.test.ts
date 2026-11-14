import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { runUnits } from './units.page.test-util.ts';
import { findChromium } from '../../../tools/find-chromium.ts';

/**
 * Headless check of geometry units (design/27 §12-13, M9 "Slow-to-draw elements", Runtime): bundles
 * units.page.test-util.ts, runs it in headless Chromium and expects line art past the slide's drawing budget,
 * drawn with its units made in slices, to be the very drawing of every object whole (largest channel difference
 * at most 1 at 1920 and at 3840, on the frame and in a tight sprite at its offset), where the legacy copies are
 * visibly another picture. Chromium is tools/find-chromium.ts's (Playwright's, else ORDO_TEST_CHROMIUM): skipped
 * when none is found, and a failure under CI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

type Esbuild = {
  build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};

/** esbuild is not a dependency of this package; vite (apps/output) depends on it, so resolve it through vite. */
async function loadEsbuild(): Promise<Esbuild> {
  const name = 'esbuild';
  try {
    return (await import(name)) as Esbuild;
  } catch {
    const fromOutput = createRequire(join(root, 'apps/output/package.json'));
    return (await import(createRequire(fromOutput.resolve('vite')).resolve(name))) as Esbuild;
  }
}

const executablePath = await findChromium();

describe.skipIf(!executablePath)('geometry units in headless Chromium', () => {
  it('draws line art past the budget from its units as drawing it whole does, at 1920 and 3840', async () => {
    const esbuild = await loadEsbuild();
    const built = await esbuild.build({
      entryPoints: [join(here, 'units.page.test-util.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2022',
      absWorkingDir: root,
      logLevel: 'silent',
    });
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, executablePath });
    let out: Awaited<ReturnType<typeof runUnits>>;
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: built.outputFiles[0]!.text });
      type Run = { __units: typeof runUnits };
      out = await page.evaluate(() => (window as unknown as Run).__units());
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
    for (const c of out.cases)
      console.log(
        `units, ${c.slide} at ${c.width}: ${c.over} past the budget, ${c.made} units (${(c.bytes / 2 ** 20).toFixed(1)} MiB); ` +
          `unit vs its object ${c.unitMaxDiff}; slide max ${c.maxDiff} (${c.overOne} px over 1), sprite ${c.spriteTight ? c.spriteMaxDiff : 'full-frame'}; ` +
          `legacy copies differ at ${c.legacyPixels} px; longest turn ${c.longestMs.toFixed(1)} ms over ${c.turns} turns ` +
          `(slice ${out.sliceMs} ms); draw ${c.drawMs.toFixed(1)} ms`,
      );
    expect(out.cases.map((c) => `${c.slide} ${c.width}`)).toEqual([
      'line-art 1920',
      'line-art 3840',
      'quarter 1920',
      'quarter 3840',
    ]);
    for (const c of out.cases) {
      const at = `${c.slide} at ${c.width}`;
      expect(c.over, `${at}: the slide is past the budget`).toBeGreaterThanOrEqual(
        c.slide === 'line-art' ? 2 : 1,
      );
      expect(c.made, `${at}: a unit per object past it`).toBe(c.over);
      // Each unit is its object drawn whole, pixel for pixel.
      expect(c.unitMaxDiff, `${at}: units against their objects drawn whole`).toBeLessThanOrEqual(1);
      // Copied over what is under them, a unit's translucent edge pixels round once more: a few levels at a few
      // edge pixels (design/27 §13 "Geometry units").
      expect(c.maxDiff, `${at}: the slide with units against the whole drawing`).toBeLessThanOrEqual(3);
      expect(c.overOne / (c.width * c.width * 0.5625), `${at}: pixels off by more than 1`).toBeLessThan(
        0.001,
      );
      if (c.spriteTight)
        expect(c.spriteMaxDiff, `${at}: a tight sprite at its offset`).toBeLessThanOrEqual(3);
      // The legacy copies are another picture (the test would pass without units otherwise).
      expect(c.legacyPixels, `${at}: legacy copies`).toBeGreaterThan(c.width * 10);
      // Made in several turns: no single task draws the whole object.
      expect(c.turns, `${at}: turns`).toBeGreaterThan(c.made);
    }
    expect(
      out.cases.some((c) => c.spriteTight),
      'a slide drawn as a tight sprite',
    ).toBe(true);
  }, 180_000);
});
