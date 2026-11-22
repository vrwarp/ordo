import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findChromium } from '../../../../tools/find-chromium.ts';
import type { WideResult } from './wide.page.test-util.ts';

/**
 * drawShapeWide with a real Canvas 2D (RM-W3, RM-W4): bundles wide.page.test-util.ts, runs it in headless Chromium
 * and expects (1) every shape within the stored limits drawn by `drawShapeWide` to be pixel-equal to the same shape
 * drawn by `drawGeomShape` (maximum channel difference 0: the hooks changed no pixel, the wide draw drifts from
 * the screens' by none), and (2) a 45,056-point outline to be drawn whole, with the area of its n-gon, where the
 * same outline cut at 4,096 points paints a sliver. No golden. Skipped, and said, when no Chromium is found
 * (ORDO_TEST_CHROMIUM, Playwright's); under CI a missing Chromium fails (find-chromium.ts).
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

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
if (!executablePath)
  console.warn("wide.browser.test.ts SKIPPED: no Chromium found (ORDO_TEST_CHROMIUM or Playwright's)");

describe.skipIf(!executablePath)('drawShapeWide in headless Chromium', () => {
  it('equals drawGeomShape within the limits and draws a 45,056-point outline whole', async () => {
    const esbuild = await loadEsbuild();
    const built = await esbuild.build({
      entryPoints: [join(here, 'wide.page.test-util.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2022',
      absWorkingDir: root,
      logLevel: 'silent',
    });
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, executablePath });
    let result: WideResult;
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: built.outputFiles[0]!.text });
      result = await page.evaluate(() =>
        (window as unknown as { __wideDraw: () => WideResult }).__wideDraw(),
      );
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }

    // RM-W3: pixel equality on every subject, and each subject really painted something.
    expect(result.equal.length).toBeGreaterThanOrEqual(14);
    expect(result.equal.filter((e) => e.painted < 100).map((e) => e.what)).toEqual([]);
    expect(
      result.equal
        .filter((e) => e.maxDiff !== 0)
        .map((e) => `${e.what}: max ${e.maxDiff}, ${e.differing} px`),
    ).toEqual([]);

    // RM-W4: the whole outline's painted area is the n-gon's (within 0.5 %), and far more than the cut one's.
    const { points, paintedWhole, paintedCut, expected } = result.wide;
    expect(points).toBe(45_056);
    expect(Math.abs(paintedWhole - expected) / expected).toBeLessThan(0.005);
    expect(paintedCut).toBeLessThan(paintedWhole * 0.5);
  }, 180_000);
});
