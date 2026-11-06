import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { BenchReport, Stats } from './raster.page.ts';

/**
 * Raster bench of the text engine (design/27 §13 and §14 item 13): a sermon slide (a title and a body with
 * runs, verse numbers, bullets and a stored autofit), a six-line lyric slide through the rich engine and the
 * same lyric slide as a legacy object, rasterized at 1920x1080 and 3840x2160 in a dedicated worker of
 * headless Chromium, as the outputs' asset worker does. Prints layout (cold and with a warm width cache),
 * raster (clear, draw, transferToImageBitmap) and paint-only times.
 *
 *   pnpm --filter @ordo/renderer bench [--iterations 200] [--check]
 *
 * --check fails when a rich slide's raster p95 is over the M2 budget: 8 ms at 1920, 30 ms at 3840.
 * The face is DejaVu Sans (fonts-dejavu-core). Timings depend on the machine and its load.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const iterations = Math.max(10, Number(arg('--iterations') ?? 120));
const check = process.argv.includes('--check');
const BUDGET: Record<string, number> = { '1920': 8, '3840': 30 };

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

const ms = (x: number) => x.toFixed(2);
const fmt = (s: Stats) => `p50 ${ms(s.p50)} p95 ${ms(s.p95)} max ${ms(s.max)} ms`;

async function main(): Promise<number> {
  const regular = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const bold = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  if (!existsSync(regular) || !existsSync(bold)) {
    console.error('bench: DejaVu Sans not installed (apt install fonts-dejavu-core)');
    return 1;
  }
  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'raster.page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    absWorkingDir: root,
    logLevel: 'silent',
  });
  const script = built.outputFiles[0]!.text;
  const browser = await chromium
    .launch({ headless: true })
    .catch(() => chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' }));
  let over = 0;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: script });
    const report: BenchReport = await page.evaluate(
      ([src, f, b, n]) =>
        (
          window as unknown as {
            __bench: { worker(s: string, f: string, b: string, n: number): Promise<BenchReport> };
          }
        ).__bench.worker(src as string, f as string, b as string, n as number),
      [
        script,
        readFileSync(regular).toString('base64'),
        readFileSync(bold).toString('base64'),
        iterations,
      ] as const,
    );
    console.log(
      `bench: ${await browser.version()}, ${report.context}, ${iterations} iterations, DejaVu Sans`,
    );
    for (const s of report.slides) {
      console.log(`${s.name} (${s.chars} characters)`);
      const rich = s.name.includes('(rich');
      if (rich)
        console.log(
          `  layout: empty width cache ${ms(s.layoutColdMs)} ms (median); warm width cache ${fmt(s.layoutWarmCache)}`,
        );
      else console.log('  layout: drawText lays out while it draws (included in raster)');
      for (const [w, r] of Object.entries(s.raster)) {
        const budget = BUDGET[w]!;
        const bad = rich && r.steady.p95 > budget;
        if (bad) over++;
        console.log(
          `  raster ${w}: first ${ms(r.first)} ms; per job ${fmt(r.steady)}${rich ? ` (budget p95 ${budget} ms${bad ? ': OVER' : ''})` : ''}${rich ? `; paint only ${fmt(r.paintOnly)}` : ''}`,
        );
      }
    }
  } finally {
    await browser.close();
  }
  return check && over ? 1 : 0;
}

process.exit(await main());
