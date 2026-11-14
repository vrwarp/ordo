import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CaseResult } from './picture-effects.page.test-util.ts';
import { findChromium } from '../../../tools/find-chromium.ts';

/**
 * Headless check of picture effects (design/20 "ProPresenter", design/27 §3.1 `ImageObject.shadow`,
 * `softEdge`): bundles picture-effects.page.test-util.ts, runs it in headless Chromium and expects every check
 * to hold: round corners kept with a shadow and a soft edge, a prepared picture feathered as the source path
 * feathers it (banded or not), a shape and a picture with the same fields alike, the shadow's σ a shape's, a
 * translucent picture drawn as a group, the layers cached, and no `ctx.filter` (WebKit). Skipped when no
 * Chromium is found (ORDO_TEST_CHROMIUM, Playwright's, or the system's Google Chrome).
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

describe.skipIf(!executablePath)('picture shadows and soft edges in headless Chromium', () => {
  it('draws them as shapes draw theirs, round corners kept, prepared or not', async () => {
    const esbuild = await loadEsbuild();
    const built = await esbuild.build({
      entryPoints: [join(here, 'picture-effects.page.test-util.ts')],
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
      type Run = { __pictureEffects: () => CaseResult[] };
      results = await page.evaluate(() => (window as unknown as Run).__pictureEffects());
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
    expect(results.length).toBeGreaterThan(8);
    // The agreements and the measured blur, for the record (design/20 "ProPresenter").
    for (const r of results)
      for (const c of r.checks) if (/agree|σ/.test(c.what)) console.log(`${r.name}: ${c.what} ${c.detail}`);
    const failed = results.flatMap((r) =>
      r.checks.filter((c) => !c.ok).map((c) => `${r.name}: ${c.what} (${c.detail})`),
    );
    expect(failed).toEqual([]);
  }, 120_000);
});
