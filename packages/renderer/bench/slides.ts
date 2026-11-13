import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { SlideRow, SlidesReport, Stats } from './slides.page.ts';

/**
 * Slide raster bench (design/27 §13 "Asset worker slide raster p95", §15 M7): sermon text over a photo, a
 * lyric with a shadow, a table and a scene slide, drawn at 1920x1080 and 3840x2160 as the outputs' asset
 * worker draws them (slides.page.ts: a tight sprite where that saves pixels), with p50/p95/max per slide
 * kind and size, the same slides drawn full-frame for comparison, and a blank full-frame job.
 *
 *   pnpm --filter @ordo/renderer bench:slides [--iterations 60] [--check] [--json out.json]
 *        [--channel chrome | --executable <path>] [--headed] [--size 1920,3840]
 *
 * --check fails when a p95 is over its budget: 10 ms at 1920 and 30 ms at 3840 for every kind, and 12 ms at
 * 3840 for text over a photo (the M7 exit); 50 ms, the longest asset-worker task, for a kind whose drawing
 * estimate is past the raster budget (`heavySlide`: the traced decorations, design/27 §13's named exception,
 * which health leaves out of the raster alarm); and when a step of preparing a slide's pictures (the raster
 * lanes' steps, a feathered picture's soft edge included) is over that task's 50 ms. These are the asset worker's CPU costs (a software canvas on
 * purpose, design/14), so the figures belong to the machine that runs the bench: in CI (headless, a shared
 * runner) read them as a trend; on a venue machine (`bench/venue.ts`) as that machine's. The face is
 * DejaVu Sans (fonts-dejavu-core; on Windows and macOS pass --font <regular.ttf> --bold <bold.ttf>).
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

export type SlidesOptions = {
  iterations: number;
  sizes: number[];
  regular: string;
  bold: string;
  channel?: string;
  executablePath?: string;
  headless: boolean;
};

/** The longest asset-worker task (design/27 §13), the bound of a slide heavy by its content. */
export const TASK_MS = 50;

/**
 * p95 budgets per width (design/27 §13); text over a photo at 4K has the M7 exit's tighter one, a slide past
 * the raster budget by its drawing estimate (`heavy`) the longest task's.
 */
export function budgetFor(row: Pick<SlideRow, 'kind' | 'width'> & { heavy?: boolean }): number {
  if (row.heavy) return TASK_MS;
  if (row.width >= 3840) return row.kind.startsWith('sermon over a photo') ? 12 : 30;
  if (row.width <= 1920) return 10;
  return 10 + (20 * (row.width - 1920)) / 1920;
}

/** The part of esbuild used here. */
type Esbuild = { build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }> };

/** esbuild is not a dependency of this package; vite (apps/output) depends on it, so resolve it through vite. */
export async function loadEsbuild(): Promise<Esbuild> {
  const name = 'esbuild';
  try {
    return (await import(name)) as Esbuild;
  } catch {
    const fromOutput = createRequire(join(root, 'apps/output/package.json'));
    return (await import(createRequire(fromOutput.resolve('vite')).resolve(name))) as Esbuild;
  }
}

/** Bundle a bench page (`entry` next to this file) as one script for a page or a worker. */
export async function bundle(entry: string): Promise<string> {
  const built = await (await loadEsbuild()).build({
    entryPoints: [join(here, entry)],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    absWorkingDir: root,
    logLevel: 'silent',
  });
  return built.outputFiles[0]!.text;
}

/** Build slides.page.ts, run it in a worker of Chromium (or the given Chrome) and return its report. */
export async function runSlides(o: SlidesOptions): Promise<SlidesReport & { browser: string }> {
  const script = await bundle('slides.page.ts');
  const browser = await chromium
    .launch({ headless: o.headless, channel: o.channel, executablePath: o.executablePath })
    .catch((err) => {
      if (o.channel || o.executablePath) throw err;
      return chromium.launch({ headless: o.headless, executablePath: '/usr/bin/google-chrome' });
    });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: script });
    const report: SlidesReport = await page.evaluate(
      ([src, f, b, n, sizes]) =>
        (
          window as unknown as {
            __slides(s: string, f: string, b: string, n: number, sizes: number[]): Promise<SlidesReport>;
          }
        ).__slides(src as string, f as string, b as string, n as number, sizes as number[]),
      [
        script,
        readFileSync(o.regular).toString('base64'),
        readFileSync(o.bold).toString('base64'),
        o.iterations,
        o.sizes,
      ] as const,
    );
    return { ...report, browser: browser.version() };
  } finally {
    await browser.close();
  }
}

const ms = (x: number) => x.toFixed(2);
export const fmtStats = (s: Pick<Stats, 'p50' | 'p95' | 'max'>) =>
  `p50 ${ms(s.p50)}  p95 ${ms(s.p95)}  max ${ms(s.max)} ms`;

/** Print the report; returns how many rows are over their budget. */
export function printSlides(r: SlidesReport & { browser: string }): number {
  console.log(
    `bench:slides: Chromium ${r.browser}, ${r.context}, ${r.cores} cores; photo decode ${ms(r.decodeMs)} ms (4000x2667 JPEG)`,
  );
  let over = 0;
  for (const b of r.blank ?? [])
    console.log(
      `  ${`${b.width}x${b.height}`.padEnd(10)} ${'blank full-frame job'.padEnd(26)} ${fmtStats(b.raster)} (a fresh bitmap of the frame: every full-frame job pays it)`,
    );
  for (const row of r.rows) {
    const budget = budgetFor(row);
    const slowStep = (row.prepareStepMs ?? 0) > TASK_MS;
    const bad = row.raster.p95 > budget || slowStep;
    if (bad) over++;
    const sprite = row.kind.startsWith('scene')
      ? `base and over ${Math.round(row.share * 100)} % of a frame`
      : row.share < 0.999
        ? `sprite ${Math.round(row.share * 100)} % of the frame`
        : 'full-frame';
    const estimate =
      row.estimateMs !== undefined
        ? `; drawing estimate ${ms(row.estimateMs)} ms${row.heavy ? ', past the raster budget by its content' : ''}`
        : '';
    console.log(
      `  ${`${row.width}x${row.height}`.padEnd(10)} ${row.kind.padEnd(26)} ${fmtStats(row.raster)} (budget p95 ${budget} ms${bad ? ': OVER' : ''}); ${sprite}; drawn full-frame p50 ${ms(row.fullFrame.p50)} p95 ${ms(row.fullFrame.p95)} ms; first ${ms(row.firstMs)} ms${row.prepareMs > 0.05 ? `, pictures prepared ${ms(row.prepareMs)} ms (longest step ${ms(row.prepareStepMs ?? 0)} ms${slowStep ? ': OVER the task' : ''})` : ''}${estimate}`,
    );
  }
  return over;
}

export function defaultFonts(): { regular: string; bold: string } {
  return {
    regular: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  };
}

async function main(): Promise<number> {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const fonts = defaultFonts();
  const o: SlidesOptions = {
    iterations: Math.max(5, Number(arg('--iterations') ?? 60)),
    sizes: (arg('--size') ?? '1920,3840')
      .split(',')
      .map(Number)
      .filter((w) => w >= 320 && w <= 7680),
    regular: arg('--font') ?? fonts.regular,
    bold: arg('--bold') ?? fonts.bold,
    channel: arg('--channel'),
    executablePath: arg('--executable'),
    headless: !process.argv.includes('--headed'),
  };
  if (!existsSync(o.regular) || !existsSync(o.bold)) {
    console.error(
      `bench:slides: font not found (${o.regular}); install fonts-dejavu-core or pass --font and --bold`,
    );
    return 1;
  }
  const r = await runSlides(o);
  const over = printSlides(r);
  const out = arg('--json');
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
    console.log(`bench:slides: wrote ${out}`);
  }
  return process.argv.includes('--check') && over ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(await main());
