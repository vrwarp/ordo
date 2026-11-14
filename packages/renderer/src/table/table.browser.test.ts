import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import { describe, expect, it } from 'vitest';
import type { TableTiming } from './table.page.test-util.ts';
import { findChromium } from '../../../../tools/find-chromium.ts';

/**
 * Headless check of the table object's sliced preparation (design/27 M9 tables): bundles
 * table.page.test-util.ts and runs it in headless Chromium with DejaVu Sans. The corpus's largest table kinds
 * (the 13,782-character chart, in words never measured before, the bulletin, the master grid) are prepared in
 * 8 ms slices and drawn at 3840 without a page error. Skipped without Chromium or the face.
 *
 * §13's 50 ms task is a bench gate, not a unit-test bound (design/23 "Timing bounds"): `pnpm --filter
 * @ordo/renderer bench:tables` runs the same page several times and fails when a table's longest slice or its
 * draw takes 50 ms or more. Here a slice or a draw is only bounded against a runaway (ten times the task),
 * which a preparation that stopped slicing would cross on any machine.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const FACE = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
/** Ten times §13's task: a slice or a draw this long means the preparation stopped slicing. */
const RUNAWAY_MS = 500;

type Esbuild = {
  build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};

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

describe.skipIf(!executablePath || !existsSync(FACE))('table preparation in headless Chromium', () => {
  it('prepares the 13,782-character chart, the bulletin and the master grid in slices', async () => {
    const esbuild = await loadEsbuild();
    const built = await esbuild.build({
      entryPoints: [join(here, 'table.page.test-util.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2022',
      absWorkingDir: root,
      logLevel: 'silent',
    });
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, executablePath });
    let timings: TableTiming[];
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: built.outputFiles[0]!.text });
      timings = await page.evaluate(
        (face) => (window as unknown as { __tables: (f: string) => Promise<TableTiming[]> }).__tables(face),
        readFileSync(FACE).toString('base64'),
      );
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
    const report = timings.map(
      (t) =>
        `${t.name}: ${t.cells} cells, ${t.slices} slices, longest ${t.maxSliceMs.toFixed(1)} ms, prepared in ${t.prepareMs.toFixed(1)} ms (one cold layout ${t.coldMs.toFixed(1)} ms), drawn at 3840 in ${t.drawMs.toFixed(1)} ms`,
    );
    console.log(report.join('\n'));
    expect(timings.map((t) => t.cells)).toEqual([48, 96, 640]);
    for (const t of timings) {
      expect(t.slices).toBeGreaterThanOrEqual(1);
      expect(t.maxSliceMs, report.join('\n')).toBeLessThan(budgetMs(RUNAWAY_MS));
      expect(t.drawMs, report.join('\n')).toBeLessThan(budgetMs(RUNAWAY_MS));
    }
  }, 120_000);
});
