import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { Limits, RunResult } from './compositor-page.ts';

/**
 * Compositor golden (design/27 §14.5): the WebGPU compositor against the Canvas 2D compositor and against
 * the CPU reference of scene.ts, pixel by pixel, in headless Chromium (compositor-page.ts runs in a
 * worker, as the render worker does). There are no expected PNGs: the compositors are compared with each
 * other on the same stacks. A case fails when more than 0.4 % of its pixels differ from Canvas 2D by more
 * than 40 in any channel (design/27 §14.5), when it strays from the reference, which does the same maths,
 * by the tighter bound of LIMITS, or when a probe (the poster showing for a stale generation or a slot
 * without a frame) fails.
 *
 *   pnpm --filter @ordo/renderer golden:compositor                 compare
 *   pnpm --filter @ordo/renderer golden:compositor --require-2d    also fail while Canvas 2D draws no scenes
 *   pnpm --filter @ordo/renderer golden:compositor --images        write every case's images
 *
 * WebGPU runs on SwiftShader: `--enable-unsafe-webgpu --use-angle=swiftshader` plus Vulkan SwiftShader
 * (`--use-vulkan=swiftshader --enable-features=Vulkan`, the set of design/23); with the ANGLE flags alone
 * this Chromium loses the device at its first pipeline. Failing cases write their three images to
 * test-results/compositor-golden/ (every case with --images).
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const outDir = join(root, 'test-results/compositor-golden');
const requireCanvas2d = process.argv.includes('--require-2d');
const allImages = process.argv.includes('--images');
const LIMITS: Limits = {
  // WebGPU against Canvas 2D: per channel 0..255, and the fraction of pixels allowed over it (design/27).
  tolerance: 40,
  maxFraction: 0.004,
  // WebGPU against the reference, which does the same maths (it agrees within 1 on SwiftShader).
  refTolerance: 8,
  refMaxFraction: 0.0005,
};
const FLAGS = [
  '--enable-unsafe-webgpu',
  '--use-angle=swiftshader',
  '--use-vulkan=swiftshader',
  '--enable-features=Vulkan',
];

/** esbuild is not a dependency of this package; vite (apps/output) depends on it, so resolve it through vite. */
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

const pct = (n: number, total: number) => `${((n / total) * 100).toFixed(3)}%`;

async function main(): Promise<number> {
  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'compositor-page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    absWorkingDir: root,
    logLevel: 'silent',
  });
  const script = built.outputFiles[0]!.text;

  const launch = async () => {
    try {
      return await chromium.launch({ headless: true, args: FLAGS });
    } catch {
      return await chromium.launch({ headless: true, args: FLAGS, executablePath: '/usr/bin/google-chrome' });
    }
  };
  const browser = await launch();
  let r: RunResult;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.error(`page ${m.type()}:`, m.text());
    });
    // WebGPU needs a secure context: serve a blank page under https.
    await page.route('https://golden.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
    );
    await page.goto('https://golden.test/');
    console.log(`golden:compositor: ${await browser.version()}, flags ${FLAGS.join(' ')}`);
    r = await page.evaluate(
      ([src, limits, images]) =>
        new Promise<RunResult>((res, rej) => {
          const w = new Worker(URL.createObjectURL(new Blob([src as string], { type: 'text/javascript' })));
          const timer = setTimeout(() => rej(new Error('compositor golden timed out')), 240_000);
          w.onmessage = (ev) => {
            clearTimeout(timer);
            res(ev.data as RunResult);
          };
          w.onerror = (ev) => {
            clearTimeout(timer);
            rej(new Error(ev.message));
          };
          w.postMessage({ limits, images });
        }),
      [script, LIMITS, allImages] as const,
    );
  } finally {
    await browser.close();
  }

  if (r.error) console.error(`golden:compositor: ${r.error}`);
  console.log(
    `golden:compositor: compositor ${r.gpuKind}, ${r.size.width}x${r.size.height}, over textures ${(r.overBytes / 1e6).toFixed(2)} MB; ` +
      (r.canvas2dScenes
        ? 'Canvas 2D draws scenes'
        : 'Canvas 2D draws only scene bases (SCENE.md item C): scene cases compared with the reference only'),
  );
  let failures = r.ok ? 0 : r.results.length ? 0 : 1;
  for (const c of r.results) {
    const ref = `ref ${pct(c.gpuVsRef.differing, c.gpuVsRef.total)} (max ${c.gpuVsRef.maxDelta})`;
    const c2d = c.gpuVs2d
      ? `2d ${pct(c.gpuVs2d.differing, c.gpuVs2d.total)} (max ${c.gpuVs2d.maxDelta})`
      : '2d skipped';
    console.log(`  ${c.name}: ${c.ok ? 'ok' : 'MISMATCH'} (${ref}; ${c2d})`);
    for (const p of c.probes)
      if (!p.ok) console.log(`    probe failed: ${p.what}: got ${p.got} want ${p.want}`);
    if (c.error) console.log(`    error: ${c.error}`);
    if (!c.ok) failures++;
    if (c.images) {
      mkdirSync(outDir, { recursive: true });
      for (const [k, b64] of Object.entries(c.images))
        writeFileSync(join(outDir, `${c.name}.${k}.png`), Buffer.from(b64, 'base64'));
    }
  }
  if (requireCanvas2d && !r.canvas2dScenes) {
    console.error('golden:compositor: --require-2d, but the Canvas 2D compositor draws no scene video');
    failures++;
  }
  if (failures) console.error(`golden:compositor: ${failures} failure(s); images in ${outDir}`);
  return failures ? 1 : 0;
}

process.exit(await main());
