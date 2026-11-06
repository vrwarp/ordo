import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { CaseResult } from './canvas-scene-page.ts';

/**
 * Pixel test of the Canvas 2D scene drawing (design/27 §7.2, SCENE.md item C): canvas-scene-page.ts draws
 * scene stacks with the real Canvas2DCompositor in headless Chromium and compares every pixel with a CPU
 * reference built on `planeSample` (scene.ts). There are no expected PNGs. A case fails when more than
 * 0.4 % of its pixels differ by more than 40 in a channel (the compositor golden's bound, design/27 §14.5),
 * or when a poster probe fails.
 *
 *   npx tsx packages/renderer/golden/canvas-scene-run.ts            compare
 *   npx tsx packages/renderer/golden/canvas-scene-run.ts --images   also write every case's images
 *
 * Failing cases write actual, reference and diff PNGs to test-results/canvas-scene/.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const outDir = join(root, 'test-results/canvas-scene');
const allImages = process.argv.includes('--images');
const TOLERANCE = 40;
const MAX_DIFFERING = 0.004;

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

async function main(): Promise<number> {
  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'canvas-scene-page.ts')],
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
      return await chromium.launch({ headless: true });
    } catch {
      return await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' });
    }
  };
  const browser = await launch();
  let results: CaseResult[];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    // VideoFrame needs a secure context: serve a blank page under https.
    await page.route('https://canvas-scene.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
    );
    await page.goto('https://canvas-scene.test/');
    await page.addScriptTag({ content: script });
    console.log(`canvas-scene: ${await browser.version()}`);
    results = await page.evaluate(([t, i]) => window.__canvasScene(t, i), [TOLERANCE, allImages] as const);
  } finally {
    await browser.close();
  }

  let failures = 0;
  for (const r of results) {
    const frac = r.diff.differing / r.diff.total;
    const ok = frac <= MAX_DIFFERING && r.probes.every((p) => p.ok);
    if (!ok) failures++;
    console.log(
      `  ${r.name}: ${ok ? 'ok' : 'MISMATCH'} (${r.diff.differing} of ${r.diff.total} pixels over ${TOLERANCE}, ${(frac * 100).toFixed(3)}%, max delta ${r.diff.maxDelta})`,
    );
    for (const p of r.probes)
      if (!p.ok) console.log(`    poster probe at ${p.at}: got ${p.got}, want ${p.want}`);
    if (r.images) {
      mkdirSync(outDir, { recursive: true });
      for (const [k, b64] of Object.entries(r.images))
        writeFileSync(join(outDir, `${r.name}.${k}.png`), Buffer.from(b64, 'base64'));
    }
  }
  if (failures) console.error(`canvas-scene: ${failures} case(s) differ; images in ${outDir}`);
  return failures ? 1 : 0;
}

process.exit(await main());
