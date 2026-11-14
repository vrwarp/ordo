import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CoverageReport } from './coverage.page.test-util.ts';
import { findChromium } from '../../../../tools/find-chromium.ts';

/**
 * Font coverage misses in headless Chromium (design/27 §10, M7): slides drawn in a worker through the font
 * resolver with DejaVu Sans, legacy and rich text, report exactly the characters DejaVu Sans lacks, whatever
 * fonts the machine itself has. Skipped when no Chromium or no DejaVu Sans is found.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

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

describe.skipIf(!executablePath || !existsSync(FONT))('font coverage in headless Chromium', () => {
  it('reports the characters no shipped face has, legacy and rich, and nothing for an unloaded family', async () => {
    const esbuild = await loadEsbuild();
    const built = await esbuild.build({
      entryPoints: [join(here, 'coverage.page.test-util.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2022',
      absWorkingDir: root,
      logLevel: 'silent',
    });
    const script = built.outputFiles[0]!.text;
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, executablePath });
    let report: CoverageReport;
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: script });
      report = await page.evaluate(
        ([src, font]) =>
          (window as unknown as { __coverage: (s: string, f: string) => Promise<CoverageReport> }).__coverage(
            src!,
            font!,
          ),
        [script, readFileSync(FONT).toString('base64')] as const,
      );
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
    for (const c of report.cases) expect(c.uncovered, c.name).toBe(c.expected);
    expect(report.reprobedAfterReset).toBe(true);
  }, 120_000);
});
