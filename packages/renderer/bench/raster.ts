import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
 *   pnpm --filter @ordo/renderer bench [--iterations 200] [--check] [--only <part of a case's name>]
 *     [--bundle-out <file> | --bundle <file>]
 *
 * --check fails when a rich slide's raster p95 is over the M2 budget: 8 ms at 1920, 30 ms at 3840; a
 * bounded geometry one's (hostile fills and outlines at the slide's drawing budget, M6 repair and finish,
 * design/27 §12 drawing cost; every job draws a fresh copy, so its geometry is built and rated cold) over
 * design/27 §13's 50 ms at either size; a bounded one's (large effects) over 50 ms at 1920 and 120 ms at
 * 3840; or a bounded effects one's (drawn cold, the effect cache emptied before every job: §13's named
 * exception for a slide at its effect budget) over 400 and 500 ms. Each case's geometry units are made before
 * its jobs, as the asset worker's prepare step makes them (`units` lines): --check also fails when one of their
 * slices passes the 50 ms task, or a '(… units' case's passes 16 ms at 3840; when a draw of an '(alternation'
 * case (two slides in turn, rounds 3 on) passes 50 ms or a slide's mean 28 ms; and when a '(second draw' (the
 * draw that makes a slide's decoration sprites) passes 50 ms.
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
/** Only the cases whose name holds this (a quick run of a few rows). */
const only = arg('--only');
/**
 * `--bundle-out <file>`: write the page bundle of this checkout and exit; `--bundle <file>`: run that bundle
 * instead of building one (a timing run of one commit's code while the checkout moves on, under the bench lock).
 */
const bundleOut = arg('--bundle-out');
const bundleIn = arg('--bundle');
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
/**
 * M9 decorations (bench/cases/decor.ts): a decoration drawn as one object against the same shapes drawn one by
 * one, paired by name ('(decoration vs shapes: <pair>' and '(shapes vs decoration: <pair>'): --check fails when
 * the decoration's p95 at a size passes its shapes' by more than this share.
 */
const DECOR_OVER_SHAPES = 0.1;
/**
 * A '(warm task' case (bench/cases/decor.ts, r2a repair): a slide drawn warm, one raster each job, within
 * design/27 §13's 50 ms task at both sizes, its p95 and its slowest draw (r2a must a4); its sprites pass a 64 MiB
 * cache at 3840.
 */
const WARM_TASK: Record<string, number> = { '1920': 50, '3840': 50 };
/**
 * An '(alternation' case (bench/cases/decor.ts, r2b effect units): two decorated slides drawn in turn, rounds 3
 * on: --check fails when a draw passes the task or a slide's mean draw passes `ALTERNATION_MEAN` (r2a land
 * review at 62a1c3a: worst 93.5 ms, the capped slide's mean 27.5 ms at 3840).
 */
const ALTERNATION_WORST = 50;
const ALTERNATION_MEAN = 28;
/**
 * A '(second draw' case: the draw that makes a slide's decoration sprites, held to the task (target 35 ms;
 * r2a land re-review: the wake template's slide 12 took 58-73 ms at 3840).
 */
const SECOND_DRAW: Record<string, number> = { '1920': 50, '3840': 50 };

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
  let script: string;
  if (bundleIn) script = readFileSync(bundleIn, 'utf8');
  else {
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
    script = built.outputFiles[0]!.text;
  }
  if (bundleOut) {
    writeFileSync(bundleOut, script);
    console.log(`bench: page bundle written to ${bundleOut}`);
    return 0;
  }
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
      ([src, f, b, n, o]) =>
        (
          window as unknown as {
            __bench: {
              worker(s: string, f: string, b: string, n: number, o?: string): Promise<BenchReport>;
            };
          }
        ).__bench.worker(src as string, f as string, b as string, n as number, (o as string) || undefined),
      [
        script,
        readFileSync(regular).toString('base64'),
        readFileSync(bold).toString('base64'),
        iterations,
        only ?? '',
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
      const warmTask = s.name.includes('(warm task');
      const second = s.name.includes('(second draw');
      if (rich)
        console.log(
          `  layout: empty width cache ${ms(s.layoutColdMs)} ms (median); warm width cache ${fmt(s.layoutWarmCache)}`,
        );
      else console.log('  layout: drawText lays out while it draws (included in raster)');
      for (const [w, r] of Object.entries(s.raster)) {
        const budget = (
          warmTask
            ? WARM_TASK
            : geometry
              ? BOUNDED_GEOMETRY
              : effects
                ? BOUNDED_EFFECTS
                : bounded
                  ? BOUNDED
                  : BUDGET
        )[w]!;
        const checked = rich || bounded || warmTask;
        // A '(warm task' row holds its slowest draw to the task too (r2a must a4), beside its p95.
        const bad = checked && (r.steady.p95 > budget || (warmTask && r.steady.max > budget));
        if (second) {
          const late = r.steady.max > SECOND_DRAW[w]!;
          if (late) over++;
          console.log(
            `  second draw ${w}: slowest ${ms(r.steady.max)} ms, p50 ${ms(r.steady.p50)} ms (budget ${SECOND_DRAW[w]} ms, target 35${late ? ': OVER' : ''})`,
          );
        }
        if (bad) over++;
        console.log(
          `  raster ${w}: first ${ms(r.first)} ms; per job ${fmt(r.steady)}${checked ? ` (budget p95${warmTask ? ' and max' : ''} ${budget} ms${bad ? ': OVER' : ''})` : ''}${rich ? `; paint only ${fmt(r.paintOnly)}` : ''}`,
        );
        const alt = r.alternation;
        if (alt) {
          // Rounds 3 on (the first two make what both slides draw).
          const of = (xs: number[]) => {
            const kept = xs.slice(2);
            return { worst: Math.max(...kept), mean: kept.reduce((a, b) => a + b, 0) / kept.length };
          };
          const a = of(alt.slide);
          const b = of(alt.other);
          const late =
            Math.max(a.worst, b.worst) > ALTERNATION_WORST || Math.max(a.mean, b.mean) > ALTERNATION_MEAN;
          if (late) over++;
          console.log(
            `  alternation ${w}: rounds 3-${alt.rounds}: this slide worst ${ms(a.worst)} mean ${ms(a.mean)} ms; the other worst ${ms(b.worst)} mean ${ms(b.mean)} ms; ` +
              `rounds 1-2 ${[alt.slide[0], alt.other[0], alt.slide[1], alt.other[1]].map((x) => ms(x ?? 0)).join(' / ')} ms ` +
              `(budget worst ${ALTERNATION_WORST} ms, mean ${ALTERNATION_MEAN} ms${late ? ': OVER' : ''})`,
          );
          console.log(`    this slide: ${alt.slide.map((x) => x.toFixed(1)).join(' ')}`);
          console.log(`    the other:  ${alt.other.map((x) => x.toFixed(1)).join(' ')}`);
        }
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
    over += decorPairs(report);
  } finally {
    await browser.close();
  }
  return check && over ? 1 : 0;
}

/**
 * The decoration-against-shapes pairs (`DECOR_OVER_SHAPES`): prints each pair's p95 per size and counts those
 * whose decoration is over.
 */
function decorPairs(report: BenchReport): number {
  const pairs = new Map<
    string,
    { decor?: BenchReport['slides'][number]; shapes?: BenchReport['slides'][number] }
  >();
  for (const s of report.slides) {
    const m = /\((decoration|shapes) vs (?:shapes|decoration): ([^,)]+)/.exec(s.name);
    if (!m) continue;
    const p = pairs.get(m[2]!) ?? {};
    if (m[1] === 'decoration') p.decor = s;
    else p.shapes = s;
    pairs.set(m[2]!, p);
  }
  let over = 0;
  for (const [pair, p] of pairs) {
    if (!p.decor || !p.shapes) {
      // A run of some cases (`--only`) checks the pairs it drew whole.
      if (only) continue;
      console.log(`decoration vs shapes, ${pair}: one of the pair is missing`);
      over++;
      continue;
    }
    for (const [w, r] of Object.entries(p.decor.raster)) {
      const shapes = p.shapes.raster[w];
      if (!shapes) continue;
      const limit = shapes.steady.p95 * (1 + DECOR_OVER_SHAPES);
      const bad = r.steady.p95 > limit;
      if (bad) over++;
      console.log(
        `decoration vs shapes, ${pair} ${w}: p95 ${ms(r.steady.p95)} ms against ${ms(shapes.steady.p95)} ms (budget ${ms(limit)} ms${bad ? ': OVER' : ''})`,
      );
    }
  }
  return over;
}

process.exit(await main());
