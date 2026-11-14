import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DiffResult } from './decor.page.test-util.ts';

/**
 * Decorations in headless Chromium (design/27 M9, decor-render; plan §4 exit `shape-decor-equivalence` and
 * `decor-sprite`; see decor.page.test-util.ts):
 * - 60 shapes drawn separately and as one decoration differ by at most 2/255 at 1920 and 3840 over every
 *   pixel inside a shape or between shapes; with 12 of them shadowed, by at most 3/255 (a shadow's blurred
 *   layer is made over what its shape draws, which the decoration's points place a float's width apart, and
 *   its reduced grid can land a device pixel over: one level more inside a soft shadow). On edges Skia's anti-aliasing can differ more: the converter writes
 *   a shape's points placed in the decoration's space, and a coordinate that moves by 1e-14 (a preset's
 *   71.99999999999999 written as 72) changes how Skia classifies the path, and so its coverage of a few edge
 *   pixels (measured: up to 51 levels on 0.2 % of the pixels at 1920, 0.1 % at 4K). Those are bounded as the
 *   golden test bounds anti-aliasing: at most 0.4 % of the pixels past 2 levels.
 * - The decoration's sprite against the decoration drawn shape by shape: within 3 levels inside shapes and
 *   shadows (Chromium dithers a gradient by its device position, and the sprite is drawn on its own canvas),
 *   at most 0.01 % of the pixels past 2 levels on edges; its cached copy is its first draw exactly (a 1:1
 *   copy).
 * Skipped when no Chromium is found (ORDO_TEST_CHROMIUM, Playwright's, or the system's Google Chrome).
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

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

type Esbuild = { build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }> };

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

describe.skipIf(!executablePath)('decorations in headless Chromium', () => {
  it('draw what their shapes draw one by one, and their sprites are 1:1 copies', {
    timeout: 120_000,
  }, async () => {
    const esbuild = await loadEsbuild();
    const built = await esbuild.build({
      entryPoints: [join(here, 'decor.page.test-util.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2022',
      absWorkingDir: root,
      logLevel: 'silent',
    });
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, executablePath });
    let results: DiffResult[];
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: built.outputFiles[0]!.text });
      results = await page.evaluate(() => (window as unknown as { __decor: () => DiffResult[] }).__decor());
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
    if (process.env.ORDO_DECOR_PRINT) console.log(JSON.stringify(results, null, 1));
    expect(results).toHaveLength(8);
    const bad: string[] = [];
    for (const r of results) {
      const at = `${r.name}: ${JSON.stringify(r)}`;
      if (r.name.startsWith('60 shapes')) {
        const interior = r.name.includes('shadows') ? 3 : 2;
        if (r.interiorMax > interior || r.over / r.pixels > 0.004) bad.push(at);
      } else if (r.name.includes('cached copy')) {
        if (r.max > 0) bad.push(at);
      } else if (r.interiorMax > 3 || r.over / r.pixels > 1e-4) bad.push(at);
    }
    expect(bad).toEqual([]);
  });
});
