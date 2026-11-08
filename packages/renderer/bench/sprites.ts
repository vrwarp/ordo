import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { SpriteReport, Stats } from './sprites.page.ts';

/**
 * Sprite bench (design/27 §7.3, §13, M7): the CPU side of tight sprites in a dedicated worker of headless
 * Chromium (sprites.page.ts): per layer, the asset worker's raster drawn full-frame against the same layer
 * as a tight sprite, at 1920 and 3840, with the bytes each hands to the upload; and one Canvas 2D frame of
 * five full-frame transparent layers against the same five as sprites (the fallback compositor).
 *
 *   pnpm --filter @ordo/renderer bench:sprites [--iterations 60]
 *
 * GPU upload and compositing times are measured on venue hardware by gpu-venue.ts, not here (this
 * container's WebGPU is SwiftShader, which measures correctness, not GPU speed). The face is DejaVu Sans
 * (fonts-dejavu-core). Timings depend on the machine and its load.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const iterations = Math.max(10, Number(arg('--iterations') ?? 60));

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

const ms = (s: Stats) => `p50 ${s.p50.toFixed(2)} p95 ${s.p95.toFixed(2)} ms`;
const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

async function main(): Promise<number> {
  const regular = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  if (!existsSync(regular)) {
    console.error('bench: DejaVu Sans not installed (apt install fonts-dejavu-core)');
    return 1;
  }
  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'sprites.page.ts')],
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
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: script });
    const r: SpriteReport = await page.evaluate(
      ([src, f, n]) =>
        (
          window as unknown as { __sprites(s: string, f: string, n: number): Promise<SpriteReport> }
        ).__sprites(src as string, f as string, n as number),
      [script, readFileSync(regular).toString('base64'), iterations] as const,
    );
    console.log(
      `bench:sprites: ${await browser.version()}, ${iterations} iterations, DejaVu Sans, CPU canvas`,
    );
    for (const x of r.raster)
      console.log(
        `  ${x.name} @${x.width}: full-frame ${ms(x.full)}; sprite ${ms(x.sprite)} (${(x.share * 100).toFixed(1)}% of the frame; upload ${mb(x.bytes[0])} -> ${mb(x.bytes[1])})` +
          (x.reach && x.drawOnly
            ? `\n      of which the reach ${ms(x.reach)}; the tight draw and transfer alone ${ms(x.drawOnly)}`
            : ''),
      );
    for (const c of r.compose)
      console.log(
        `  Canvas 2D frame, 5 layers @${c.width}: full-frame ${ms(c.full)}; sprites ${ms(c.sprite)}`,
      );
  } finally {
    await browser.close();
  }
  return 0;
}

process.exit(await main());
