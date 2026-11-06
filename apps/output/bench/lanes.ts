import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { DecodeTiming, PropsRun } from '../src/asset.lanes.page.test-util.ts';

/**
 * Raster-lanes bench of the output's asset worker (design/27 §7.5 and §13, M7), for this container and for
 * the venue's machines (design/14 "Measuring on a venue machine"). It runs the real asset worker in Chrome
 * on an HTTPS origin, with its pictures in OPFS:
 *
 * - props under load: a slide with two large photos (6000x4000 and 4000x3000 JPEGs) and text is sent with
 *   nothing cached, and a props job a few milliseconds later, at 1080p and at 4K. The link sends a props job
 *   150 ms before its second, so a props bitmap later than 150 ms plus one frame is a late flip (the M7 exit).
 * - decode paths: a full-frame photo decoded and prepared the whole way and the crop-aware way, with the
 *   longest task on the thread meanwhile (what a props job would wait behind).
 *
 * The asset worker draws on a software canvas on purpose (design/14 "Asset restart"), so these are CPU
 * figures: they depend on the machine's CPU and load, not its GPU. GPU timings (uploads, the frame) are the
 * render worker's and are measured by the renderer's venue procedure, not here.
 *
 *   pnpm --filter @ordo/output bench:lanes [--runs 7] [--chrome <path>] [--headed] [--check]
 *     [--baseline <path to another checkout's apps/output/src/asset.worker.ts>] [--json <file>]
 *
 * --baseline runs another asset worker (an older checkout's) through the same props scenario, for a before
 * and after. --check fails when a props bitmap is more than one frame late.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const runs = Math.max(3, Number(arg('--runs') ?? 7));
const check = process.argv.includes('--check');
const headed = process.argv.includes('--headed');
const PROPS_LEAD_MS = 150;
const FRAME_MS = 1000 / 60;

type Esbuild = { build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }> };

async function loadEsbuild(): Promise<Esbuild> {
  const name = 'esbuild';
  try {
    return (await import(name)) as Esbuild;
  } catch {
    const fromOutput = createRequire(join(root, 'apps/output/package.json'));
    return (await import(createRequire(fromOutput.resolve('vite')).resolve(name))) as Esbuild;
  }
}

async function bundle(esbuild: Esbuild, entry: string): Promise<string> {
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    absWorkingDir: root,
    logLevel: 'silent',
  });
  return built.outputFiles[0]!.text;
}

function chromePath(): string | undefined {
  const given = arg('--chrome') ?? process.env.ORDO_TEST_CHROMIUM;
  if (given) return given;
  if (existsSync(chromium.executablePath())) return undefined;
  return existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
};
const f = (x: number | undefined) => (x === undefined ? '-' : x.toFixed(1));

/** Offsets of the props job after the slide job: spread over the slide's decode and preparation. */
const offsets = (n: number) =>
  Array.from({ length: n }, (_, i) => Math.round(2 + (i * 200) / Math.max(1, n - 1)));

async function main(): Promise<number> {
  const esbuild = await loadEsbuild();
  const workers: [string, string][] = [
    ['this checkout', await bundle(esbuild, join(root, 'apps/output/src/asset.worker.ts'))],
  ];
  const baseline = arg('--baseline');
  if (baseline) workers.push([`baseline ${baseline}`, await bundle(esbuild, resolve(baseline))]);
  const page = await bundle(esbuild, join(root, 'apps/output/src/asset.lanes.page.test-util.ts'));
  const browser = await chromium.launch({ headless: !headed, executablePath: chromePath() });
  const report: Record<string, unknown> = { chrome: await browser.version(), runs };
  let late = 0;
  try {
    console.log(`bench:lanes: ${await browser.version()}, ${runs} runs per size${headed ? ', headed' : ''}`);
    for (const [name, worker] of workers) {
      const p = await browser.newPage();
      p.on('pageerror', (e) => console.error('page error:', e.message));
      await p.route('https://lanes.test/**', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/asset.js')
          return route.fulfill({ contentType: 'text/javascript', body: worker });
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
      });
      await p.goto('https://lanes.test/');
      await p.addScriptTag({ content: page });
      console.log(`asset worker: ${name}`);
      for (const [w, h, label] of [
        [1920, 1080, '1080p'],
        [3840, 2160, '4K'],
      ] as const) {
        const r = await p.evaluate(
          ([w, h, o]) =>
            (
              window as unknown as {
                __lanes: {
                  props(
                    u: string,
                    w: number,
                    h: number,
                    o: number[],
                  ): Promise<{ runs: PropsRun[]; errors: string[] }>;
                };
              }
            ).__lanes.props('https://lanes.test/asset.js', w, h, o),
          [w, h, offsets(runs)] as const,
        );
        const props = r.runs.map((x) => x.propsMs);
        const frames = r.runs.map((x) => Math.max(0, x.propsMs - PROPS_LEAD_MS) / FRAME_MS);
        const lateHere = frames.filter((x) => x > 1).length;
        if (name === 'this checkout') late += lateHere;
        const raster = r.runs.flatMap((x) => (x.slide?.rasterMs !== undefined ? [x.slide.rasterMs] : []));
        const longest = r.runs.flatMap((x) => (x.slide?.longestMs !== undefined ? [x.slide.longestMs] : []));
        console.log(
          `  ${label}: props bitmap ${f(q(props, 0.5))} ms p50, ${f(Math.max(...props))} ms max after sending (lead ${PROPS_LEAD_MS} ms; ${lateHere} of ${r.runs.length} more than a frame late); slide ${f(
            q(
              r.runs.map((x) => x.slideMs),
              0.5,
            ),
          )} ms p50 to the renderer${raster.length ? `, raster ${f(q(raster, 0.5))} ms p50 on the thread, longest slice ${f(Math.max(...longest))} ms` : ''}`,
        );
        if (r.errors.length) console.log(`    worker errors: ${r.errors.join('; ')}`);
        report[`${name} ${label}`] = r.runs;
      }
      if (name === 'this checkout') {
        const d: DecodeTiming[] = await p.evaluate(
          (n) =>
            (
              window as unknown as { __lanes: { decodes(n: number): Promise<DecodeTiming[]> } }
            ).__lanes.decodes(n),
          Math.max(3, Math.min(runs, 5)),
        );
        console.log('  decode and prepare one full-frame cover photo (median; longest task on the thread):');
        for (const x of d)
          console.log(
            `    ${x.source} for ${x.output}, ${x.path}${x.path === 'crop-aware' ? (x.scaled ? ' (scaled)' : ' (whole: needs over 4/8)') : ''}: ${f(x.ms)} ms, longest task ${f(x.longestTaskMs)} ms`,
          );
        report.decodes = d;
      }
      await p.close();
    }
  } finally {
    await browser.close();
  }
  const out = arg('--json');
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  return check && late ? 1 : 0;
}

process.exit(await main());
