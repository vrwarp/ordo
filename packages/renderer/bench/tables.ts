import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { TableTiming } from '../src/table/table.page.test-util.ts';

/**
 * Table task bench (design/27 M9 tables, §13: no asset-worker task over 50 ms). Runs the page of
 * table.browser.test.ts (`src/table/table.page.test-util.ts`) in headless Chromium with DejaVu Sans: the
 * corpus's largest table kinds (the 13,782-character chart, the 96-cell bulletin, the 640-cell master grid)
 * two tables at `TABLE_LIMITS` (60,000 characters in 4,096 cells, or in 6 cells of 10,000) and one of hostile
 * imported text (a slash in every word, one word a line: LibreOffice's slash rule at every line end) are prepared
 * as the asset worker prepares them, in 8 ms slices, then drawn at 3840.
 *
 *   pnpm --filter @ordo/renderer bench:tables [--runs 5]
 *
 * Each run uses a fresh page (cold caches). The gate is the median over the runs of each table's longest
 * slice and of its draw: both must stay under 50 ms, or the bench exits 1 (a row in `NAMED` prints OVER
 * with the work that bounds it instead). A single run on a loaded machine
 * can spike; the median is what the machine does. This gate lives here, not in vitest (design/23 "Timing
 * bounds"): table.browser.test.ts bounds only a runaway.
 */

const TASK_MS = 50;
/**
 * Rows over the task that are named, with the work that bounds them, instead of failing the bench: a hostile
 * table at the clamp's limits, past anything in the corpus (its table slides draw in at most 43.5 ms at 3840).
 */
const NAMED: Record<string, string> = {
  'table at TABLE_LIMITS (6 cells of 10,000 characters)':
    "60,000 characters drawn live in one raster; design/29's 20,000-character bound and speed-based heavy-slide rule (render-bounds, sub-wave 3) and pre-rendered big slides (sub-wave 4) take it off the GO path",
};
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const FACE = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const runs = Math.max(1, Math.min(50, Number(arg('--runs') ?? 5) || 5));

async function loadEsbuild(): Promise<typeof import('esbuild')> {
  try {
    return await import('esbuild');
  } catch {
    const fromOutput = createRequire(join(root, 'apps/output/package.json'));
    const vitePath = fromOutput.resolve('vite');
    const esbuildPath = createRequire(vitePath).resolve('esbuild');
    return (await import(esbuildPath)) as typeof import('esbuild');
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const ms = (x: number) => x.toFixed(1);

async function main(): Promise<number> {
  if (!existsSync(FACE)) {
    console.error('bench:tables: DejaVu Sans not installed (apt install fonts-dejavu-core)');
    return 1;
  }
  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(root, 'packages/renderer/src/table/table.page.test-util.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    absWorkingDir: root,
    logLevel: 'silent',
  });
  const script = built.outputFiles[0]!.text;
  const face = readFileSync(FACE).toString('base64');
  const browser = await chromium
    .launch({ headless: true })
    .catch(() => chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' }));
  const all: TableTiming[][] = [];
  try {
    for (let r = 0; r < runs; r++) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: script });
      const timings = await page.evaluate(
        (f) =>
          (
            window as unknown as { __tables: (f: string, limits: boolean) => Promise<TableTiming[]> }
          ).__tables(f, true),
        face,
      );
      await page.close();
      if (errors.length) {
        console.error(`bench:tables: page errors: ${errors.join('; ')}`);
        return 1;
      }
      all.push(timings);
    }
    console.log(
      `bench:tables: ${await browser.version()}, ${runs} runs, DejaVu Sans, 8 ms slices, drawn at 3840`,
    );
  } finally {
    await browser.close();
  }
  let failed = 0;
  for (const [i, first] of all[0]!.entries()) {
    const per = all.map((timings) => timings[i]!);
    const slice = median(per.map((t) => t.maxSliceMs));
    const draw = median(per.map((t) => t.drawMs));
    const over = slice >= TASK_MS || draw >= TASK_MS;
    const named = over ? NAMED[first.name] : undefined;
    if (over && !named) failed++;
    console.log(
      `  ${named ? 'OVER' : over ? 'FAIL' : 'ok  '} ${first.name}: ${first.cells} cells, ${first.slices} slices; longest slice ` +
        `median ${ms(slice)} (max ${ms(Math.max(...per.map((t) => t.maxSliceMs)))}) ms; draw median ${ms(draw)} ` +
        `(max ${ms(Math.max(...per.map((t) => t.drawMs)))}) ms; prepared in ${ms(median(per.map((t) => t.prepareMs)))} ms, ` +
        `one cold layout ${ms(median(per.map((t) => t.coldMs)))} ms${named ? ` (named: ${named})` : ''}`,
    );
  }
  if (failed) console.error(`bench:tables: ${failed} table(s) over the ${TASK_MS} ms task`);
  return failed ? 1 : 0;
}

process.exit(await main());
