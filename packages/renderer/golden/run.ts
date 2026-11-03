import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

/**
 * Golden-image test of the text rasterizer and looks (design/14, design/23). Bundles golden/page.ts,
 * runs it in headless Chromium, renders every case to a PNG and compares it to golden/expected/<case>.png
 * with a per-pixel tolerance (anti-aliasing differs slightly between Chromium builds).
 *
 *   pnpm --filter @ordo/renderer golden            compare
 *   pnpm --filter @ordo/renderer golden --update   rewrite the expected PNGs
 *
 * Text is drawn with a font the runner injects from the system (DejaVu Sans, which Ubuntu and the CI image
 * ship), recorded in expected/meta.json; when that font is missing the run is skipped, not failed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const expectedDir = join(here, 'expected');
const update = process.argv.includes('--update');
const TOLERANCE = 40; // per channel, 0..255
const MAX_DIFFERING = 0.004; // fraction of pixels allowed over the tolerance

const FONTS = [
  { weight: 700, style: 'normal' as const, paths: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'] },
  { weight: 400, style: 'normal' as const, paths: ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'] },
  {
    weight: 700,
    style: 'italic' as const,
    paths: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf'],
  },
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

async function main(): Promise<number> {
  const fonts: { weight: number; style: 'normal' | 'italic'; base64: string; file: string }[] = [];
  for (const f of FONTS) {
    const p = f.paths.find((x) => existsSync(x));
    if (!p) continue;
    fonts.push({
      weight: f.weight,
      style: f.style,
      base64: readFileSync(p).toString('base64'),
      file: p.split('/').pop()!,
    });
  }
  if (fonts.length < 2) {
    console.log('golden: skipped (DejaVu Sans not installed; apt install fonts-dejavu-core)');
    return 0;
  }
  const metaPath = join(expectedDir, 'meta.json');
  const fontList = fonts.map((f) => f.file).join(',');
  if (!update && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { fonts: string };
    if (meta.fonts !== fontList) {
      console.log(
        `golden: skipped (expected PNGs were made with ${meta.fonts}, this machine has ${fontList})`,
      );
      return 0;
    }
  }

  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'page.ts')],
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
  let failures = 0;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: script });
    const loaded = await page.evaluate(
      (files) => window.__golden.fonts(files),
      fonts.map(({ weight, style, base64 }) => ({ weight, style, base64 })),
    );
    console.log(`golden: ${loaded} font faces loaded (${fontList}); ${await browser.version()}`);
    const names = await page.evaluate(() => window.__golden.names());
    mkdirSync(expectedDir, { recursive: true });
    for (const name of names) {
      const png = await page.evaluate((n) => window.__golden.render(n), name);
      const file = join(expectedDir, `${name}.png`);
      if (update || !existsSync(file)) {
        writeFileSync(file, Buffer.from(png, 'base64'));
        console.log(`  ${name}: ${update ? 'updated' : 'created (no expected image yet)'}`);
        continue;
      }
      const expected = readFileSync(file).toString('base64');
      const d = await page.evaluate(
        ([n, e, t]) => window.__golden.diff(n as string, e as string, t as number),
        [name, expected, TOLERANCE] as const,
      );
      const frac = d.differing / d.total;
      const ok = frac <= MAX_DIFFERING;
      if (!ok) {
        failures++;
        writeFileSync(join(expectedDir, `${name}.actual.png`), Buffer.from(png, 'base64'));
      }
      console.log(
        `  ${name}: ${ok ? 'ok' : 'MISMATCH'} (${d.differing} of ${d.total} pixels over ${TOLERANCE}, ${(frac * 100).toFixed(3)}%, max delta ${d.maxDelta})`,
      );
    }
    if (update || !existsSync(metaPath)) {
      writeFileSync(
        metaPath,
        `${JSON.stringify({ fonts: fontList, chromium: await browser.version(), tolerance: TOLERANCE, maxDifferingFraction: MAX_DIFFERING }, null, 2)}\n`,
      );
    }
  } finally {
    await browser.close();
  }
  if (failures)
    console.error(
      `golden: ${failures} case(s) differ; see expected/*.actual.png, or run with --update if intended`,
    );
  return failures ? 1 : 0;
}

declare global {
  interface Window {
    __golden: {
      names(): string[];
      fonts(files: { weight: number; style: 'normal' | 'italic'; base64: string }[]): Promise<number>;
      render(name: string): Promise<string>;
      diff(
        name: string,
        expectedBase64: string,
        tolerance: number,
      ): Promise<{ differing: number; total: number; maxDelta: number }>;
    };
  }
}

process.exit(await main());
