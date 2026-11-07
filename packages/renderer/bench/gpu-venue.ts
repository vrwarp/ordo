import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { Stats, VenueReport } from './gpu-venue.page.ts';

/**
 * Venue GPU measurement (design/27 §13 upload and GPU-time budgets, §15 M7): the WebGPU compositor's
 * uploads (at once against strips), its compositing (full-frame layers against sprites, the opaque replace
 * path) and a live run of the engine, at 1920x1080 and 3840x2160, on the machine's real GPU
 * (gpu-venue.page.ts). `bench:venue` (venue.ts) runs this measurement too, with the machine, the adapter and
 * the slide rasters, and is the one command of the venue procedure (design/14 "Measuring on venue
 * machines"); this script runs the compositor part alone, for tuning the strips.
 *
 * Procedure for the compositor part alone (Windows 11 presentation PC with its iGPU, a discrete GPU, a Mac):
 * 1. Install Node 22 and pnpm, clone the repository, `pnpm install`, and `npx playwright install chrome`
 *    (or use the installed Google Chrome).
 * 2. Plug in the venue display at its native resolution (a 4K display for the 3840 rows), close other
 *    applications, keep the machine on mains power, and let it idle for a minute.
 * 3. Run, from the repository root, with Chrome visible on that display:
 *      pnpm --filter @ordo/renderer bench:gpu -- --channel chrome --out venue-<machine>.json
 *    The window must stay visible and focused for the live runs (rAF is throttled otherwise).
 *    On a laptop with two GPUs, run once as is (high-performance adapter requested) and note in the
 *    results which GPU Chrome's chrome://gpu reports.
 * 4. Record in design/14 (bench:venue prints the table row): the adapter line, per size the upload rows
 *    (CPU ms, and the latency until the queue reports the copies done beside an empty submit's: done minus
 *    empty bounds the GPU time), the compose rows (GPU ms per frame) and the live rows (missed frames, late
 *    flips, frames from late content's arrival to its flip, rAF p95/max, uploadMs). The M7 exit: uploads
 *    <= 4 ms per frame at 4K with the default strips; GPU time per frame <= 4 ms at 4K on the iGPU.
 * 5. If uploads exceed 4 ms per frame, lower UPLOAD_BUDGET_BYTES (gpu.ts) until they do and record both.
 *
 * Options: --channel <chrome|msedge> | --executable <path>; --headless (no live runs unless --live is
 * given: a headless page is not paced by a display, so its live figures only check the script);
 * --live <seconds> (default 8 when visible); --swiftshader (this container: WebGPU on SwiftShader, which
 * checks the script works but measures the CPU, not a GPU); --out <file>.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string) => process.argv.includes(name);
const swiftshader = has('--swiftshader');
const headless = has('--headless') || swiftshader;
// A hidden page's rAF is not paced by a display: live runs by default only with a visible window; --live
// runs them headless too (the figures then check the script, not the display).
const liveSeconds = Math.max(0, Number(arg('--live') ?? (headless ? 0 : 8)));

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

const f = (s: Stats) => `p50 ${s.p50.toFixed(2)} p95 ${s.p95.toFixed(2)} max ${s.max.toFixed(2)} ms`;

async function main(): Promise<number> {
  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'gpu-venue.page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    absWorkingDir: root,
    logLevel: 'silent',
  });
  const script = built.outputFiles[0]!.text;
  const args = swiftshader
    ? [
        '--enable-unsafe-webgpu',
        '--use-angle=swiftshader',
        '--use-vulkan=swiftshader',
        '--enable-features=Vulkan',
      ]
    : ['--enable-unsafe-webgpu', '--start-fullscreen'];
  const channel = arg('--channel');
  const executablePath = arg('--executable');
  const browser = await chromium
    .launch({ headless, args, channel, executablePath })
    .catch(() => chromium.launch({ headless, args, executablePath: '/usr/bin/google-chrome' }));
  let r: VenueReport;
  try {
    const page = await browser.newPage({ viewport: null });
    page.on('pageerror', (e) => console.error('page error:', e.message));
    // WebGPU needs a secure context: serve a blank page under https.
    await page.route('https://venue.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
    );
    await page.goto('https://venue.test/');
    await page.addScriptTag({ content: script });
    r = await page.evaluate(
      ([src, live]) =>
        (window as unknown as { __venue(s: string, n: number): Promise<VenueReport> }).__venue(
          src as string,
          live as number,
        ),
      [script, liveSeconds] as const,
    );
    console.log(
      `bench:gpu: ${await browser.version()}${swiftshader ? ' (SwiftShader: CPU, not a venue GPU)' : ''}`,
    );
  } finally {
    await browser.close();
  }
  console.log(`  adapter ${JSON.stringify(r.adapter)}; timestamp queries ${r.timestamps ? 'yes' : 'no'}`);
  for (const s of r.sizes) {
    console.log(`${s.width}x${s.height}`);
    for (const u of s.uploads)
      console.log(
        `  upload ${u.name}, ${u.budget}: ${u.frames.toFixed(1)} frame(s) each; per frame CPU ${f(u.cpuMs)}; done (latency) ${f(u.doneMs)}; empty submit ${f(u.emptyMs)}`,
      );
    for (const c of s.compose) console.log(`  compose ${c.name}: GPU ${f(c.gpuMs)} (${c.source})`);
    for (const l of s.live)
      console.log(
        `  live ${l.seconds} s, ${l.budget}: presented ${l.presented}, missed ${l.missed}, late flips ${l.lateFlips}, late content flipped after ${l.lateContentFrames.p50} frame(s) p50 (max ${l.lateContentFrames.max}), rAF interval ${f(l.intervalMs)}, uploadMs ${l.uploadMs}`,
      );
  }
  const out = arg('--out');
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
    console.log(`bench:gpu: wrote ${out}`);
  }
  return 0;
}

process.exit(await main());
