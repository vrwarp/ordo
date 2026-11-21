import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { FrameBenchCase } from './frame.page.ts';

/**
 * Underlay frame bench (design 29 R1, M2 and M5): the frame of a crowded slide made in turns on a software canvas
 * in headless Chromium (frame.page.ts), each turn a task of its own and timed, at 1920 and 3840, on the renderer's
 * builders: 340 objects and 24 pictures (the e2e deck), 1,000 objects, the 20,000-object bound with 64 pictures of
 * eight sizes, and 20 shadowed panels past one frame of units. Each run on a fresh page. Reported: the turn time
 * summed (what `FRAME_BUDGET_MS` counts), the longest turn and the longest single step, and the final raster (the
 * frame copied under the direct part) against the base's cut draw of the same slide.
 *
 *   pnpm --filter @ordo/renderer bench:frame [--runs 5] [--cases crowded340,objects1000] [--widths 1920,3840]
 *
 * Run it inside the bench lock: its numbers are milliseconds. This machine draws on the CPU: a venue PC confirms the
 * 4K figures. The text boxes use the page's default face.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const runs = Math.max(1, Number(arg('--runs') ?? 5));
const cases = (arg('--cases') ?? 'crowded340,objects1000,objects20000,shadows20').split(',');
const widths = (arg('--widths') ?? '1920,3840').split(',').map(Number);

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

const f = (n: number) => n.toFixed(n < 10 ? 2 : 1);

async function main(): Promise<number> {
  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'frame.page.ts')],
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
  const all: FrameBenchCase[] = [];
  try {
    console.log(
      `bench:frame: ${await browser.version()}, ${runs} fresh run(s) per case, load ${process.env.BENCH_LOAD ?? 'n/a'}`,
    );
    for (const name of cases)
      for (const width of widths)
        for (let run = 1; run <= runs; run++) {
          const page = await browser.newPage();
          page.on('pageerror', (e) => console.error('page error:', e.message));
          try {
            await page.setContent('<!doctype html><html><body></body></html>');
            await page.addScriptTag({ content: script });
            const r: FrameBenchCase = await page.evaluate(
              ([n, w]) =>
                (
                  window as unknown as { __frameBench(n: string, w: number): Promise<FrameBenchCase> }
                ).__frameBench(n as string, w as number),
              [name, width] as const,
            );
            all.push(r);
            console.log(
              `  ${name} @${width} run ${run}: ${r.objects} objects (frame ${r.under}, direct ${r.direct}, ${(r.frameBytes / 1e6).toFixed(0)} MB) ` +
                `turns ${f(r.turnsMs)} ms in ${r.turns} (wall ${f(r.wallMs)}), longest turn ${f(r.longestTurn)} ms, longest step ${f(r.longestStep)} ms, ` +
                `final raster ${f(r.finalMs)} ms (direct alone ${f(r.directMs)}, base cut draw ${f(r.cutMs)})${r.made ? '' : ' NOT MADE'}`,
            );
          } finally {
            await page.close();
          }
        }
  } finally {
    await browser.close();
  }
  // Per case and width: the worst of the runs for each figure the exit criteria read.
  console.log('\nworst of the runs:');
  for (const name of cases)
    for (const width of widths) {
      const rs = all.filter((r) => r.name === name && r.width === width);
      if (!rs.length) continue;
      const max = (k: keyof FrameBenchCase) => Math.max(...rs.map((r) => r[k] as number));
      console.log(
        `  ${name} @${width}: turn time ${f(max('turnsMs'))} ms, longest turn ${f(max('longestTurn'))} ms, longest step ${f(max('longestStep'))} ms, final raster ${f(max('finalMs'))} ms (cut draw ${f(max('cutMs'))})`,
      );
    }
  console.log(`\n${JSON.stringify(all)}`);
  return all.every((r) => r.made) ? 0 : 1;
}

process.exit(await main());
