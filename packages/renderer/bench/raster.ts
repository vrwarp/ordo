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
 * headless Chromium, as the outputs' asset worker does, with the bounded drawing cases of M6 and those the
 * M9 areas list in bench/cases/index.ts. Prints layout (cold and with a warm width cache),
 * raster (clear, draw, transferToImageBitmap) and paint-only times.
 *
 *   pnpm --filter @ordo/renderer bench [--iterations 200] [--check]
 *
 * --check fails when a rich slide's raster p95 is over the M2 budget: 8 ms at 1920, 30 ms at 3840; a
 * bounded geometry one's (hostile fills and outlines at the slide's drawing budget, M6 repair and finish,
 * design/27 §12 drawing cost; every job draws a fresh copy, so its geometry is built and rated cold) over
 * design/27 §13's 50 ms at either size; a bounded one's (large effects) over 50 ms at 1920 and 120 ms at
 * 3840; or a bounded effects one's (drawn cold, the effect cache emptied before every job: §13's named
 * exception for a slide at its effect budget) over 400 and 500 ms. Each case's geometry units are made before
 * its jobs, as the asset worker's prepare step makes them (`units` lines): --check also fails when one of their
 * slices passes the 50 ms task, or a '(… units' case's passes 16 ms at 3840.
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
const BOUNDED: Record<string, number> = { '1920': 50, '3840': 120 };
const BOUNDED_GEOMETRY: Record<string, number> = { '1920': 50, '3840': 50 };
/**
 * A slide at its effect budget (10 slide areas of layers) drawn cold, every layer made again: design/27 §13's
 * named exception (CPU-backed canvases enlarge a reduced layer at about 20 ms a slide area at 4K; the corpus's
 * most effected slides take 120 to 225 ms cold at 3840).
 */
const BOUNDED_EFFECTS: Record<string, number> = { '1920': 400, '3840': 500 };
/**
 * Geometry units (design/27 §13 "Geometry units"): every slice that makes them is a task of the asset worker's
 * lanes (50 ms); a '(… units' case's longest slice at 3840 is held to 16 ms, a turn of the lanes' target.
 */
const UNIT_TASK_MS = 50;
const UNIT_TURN_MS: Record<string, number> = { '3840': 16 };

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
      const bounded = s.name.includes('(bounded');
      const geometry = s.name.includes('(bounded geometry');
      const unitsCase = /\(.*units/.test(s.name);
      const effects = s.name.includes('(bounded effects');
      if (rich)
        console.log(
          `  layout: empty width cache ${ms(s.layoutColdMs)} ms (median); warm width cache ${fmt(s.layoutWarmCache)}`,
        );
      else console.log('  layout: drawText lays out while it draws (included in raster)');
      for (const [w, r] of Object.entries(s.raster)) {
        const budget = (geometry ? BOUNDED_GEOMETRY : effects ? BOUNDED_EFFECTS : bounded ? BOUNDED : BUDGET)[
          w
        ]!;
        const checked = rich || bounded;
        const bad = checked && r.steady.p95 > budget;
        if (bad) over++;
        console.log(
          `  raster ${w}: first ${ms(r.first)} ms; per job ${fmt(r.steady)}${checked ? ` (budget p95 ${budget} ms${bad ? ': OVER' : ''})` : ''}${rich ? `; paint only ${fmt(r.paintOnly)}` : ''}`,
        );
        const u = r.units;
        if (u) {
          const turn = unitsCase ? UNIT_TURN_MS[w] : undefined;
          const late = u.longestTurnMs > (turn ?? UNIT_TASK_MS);
          if (late) over++;
          console.log(
            `  units ${w}: ${u.count} made, ${(u.bytes / 2 ** 20).toFixed(1)} MiB, in ${ms(u.makeMs)} ms over ${u.turns} slices; longest slice ${ms(u.longestTurnMs)} ms (budget ${turn ?? UNIT_TASK_MS} ms${late ? ': OVER' : ''})`,
          );
        }
      }
    }
  } finally {
    await browser.close();
  }
  return check && over ? 1 : 0;
}

process.exit(await main());
