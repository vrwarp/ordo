import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CaseResult } from './scene-raster.page.test-util.ts';

/**
 * Headless check of the asset worker's scene bitmaps (design/27 §7.2, SCENE.md item E): bundles
 * scene-raster.page.test-util.ts, runs it in headless Chromium and expects every check of every case to
 * hold (see that file). Skipped when no Chromium is found (ORDO_TEST_CHROMIUM, Playwright's, or the
 * system's Google Chrome).
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

async function findChromium(): Promise<string | undefined> {
  if (process.env.ORDO_TEST_CHROMIUM) return process.env.ORDO_TEST_CHROMIUM;
  try {
    const { chromium } = await import('@playwright/test');
    const exe = chromium.executablePath();
    if (existsSync(exe)) return exe;
  } catch {
    /* Playwright not installed */
  }
  return existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
}

/** The part of esbuild used here. */
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

describe.skipIf(!executablePath)('scene bitmaps in headless Chromium', () => {
  it('base, over and plane recompose the slide, with the poster and with the clip playing', async () => {
    const esbuild = await loadEsbuild();
    const built = await esbuild.build({
      entryPoints: [join(here, 'scene-raster.page.test-util.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2022',
      absWorkingDir: root,
      logLevel: 'silent',
    });
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, executablePath });
    let results: CaseResult[];
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: built.outputFiles[0]!.text });
      results = await page.evaluate(() =>
        (window as unknown as { __sceneRaster: () => CaseResult[] }).__sceneRaster(),
      );
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
    expect(results.length).toBeGreaterThan(0);
    const failed = results.flatMap((r) =>
      r.checks.filter((c) => !c.ok).map((c) => `${r.name}: ${c.what} (${c.detail})`),
    );
    expect(failed).toEqual([]);
  }, 120_000);
});
