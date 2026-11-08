import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { Report } from './late-font.page.ts';

/**
 * Late-loaded fonts in headless Chromium (design/27 §10; M2 exit "a late-loaded font takes effect without a
 * worker restart"). Bundles golden/late-font.page.ts and runs it in a dedicated worker, as the outputs' asset
 * worker and the operator's thumbnail worker draw, and on the page, as the editor draws. Each run draws a
 * slide (a legacy and a rich text object) in families whose face has not loaded, lets the FontResolver load
 * them (after a failed first read and a retry; through a later sync) and draws again: the second draw must
 * use the face, with the widths and pixels of the same face registered directly.
 *
 *   pnpm --filter @ordo/renderer late-font
 *
 * The face is a monospaced system font (DejaVu Sans Mono, which Ubuntu and the CI image ship), so it is
 * unmistakable next to the proportional fallback. With none installed the check fails: a skipped check
 * would prove nothing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

const CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeMono.ttf',
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

const close = (a: number, b: number) => Math.abs(a - b) < 0.01;

/** Problems with one report; empty when the late faces took effect. */
function problems(r: Report): string[] {
  const out: string[] = [];
  if (r.scenarios.length !== 2) out.push(`expected 2 scenarios, got ${r.scenarios.length}`);
  for (const s of r.scenarios) {
    const where = `${r.context}, ${s.name}`;
    for (const k of ['legacy', 'rich'] as const) {
      if (!close(s.after[k], s.reference[k]))
        out.push(`${where}: ${k} width ${s.after[k]} after loading, the face gives ${s.reference[k]}`);
      if (Math.abs(s.before[k] - s.after[k]) < 1)
        out.push(`${where}: ${k} width ${s.before[k]} before loading is the face's already (bad probe font)`);
    }
    if (s.offReference) out.push(`${where}: ${s.offReference} pixels differ from the face drawn directly`);
    if (!s.changed) out.push(`${where}: the second draw has the same pixels as the first`);
  }
  return out;
}

async function main(): Promise<number> {
  const file = CANDIDATES.find((p) => existsSync(p));
  if (!file) {
    console.error(`late-font: no probe font found (${CANDIDATES.join(', ')}); apt install fonts-dejavu-core`);
    return 1;
  }
  const font = readFileSync(file).toString('base64');
  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'late-font.page.ts')],
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
  const failures: string[] = [];
  try {
    for (const context of ['worker', 'page'] as const) {
      // A fresh page per context: the page and its worker would otherwise share nothing anyway, but the
      // page context must not see faces the worker run added.
      const page = await browser.newPage();
      page.on('pageerror', (e) => console.error('page error:', e.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: script });
      const report = await page.evaluate(
        ([ctx, src, f]) => {
          const api = (
            window as unknown as {
              __lateFont: {
                page(font: string): Promise<Report>;
                worker(source: string, font: string): Promise<Report>;
              };
            }
          ).__lateFont;
          return ctx === 'worker' ? api.worker(src, f) : api.page(f);
        },
        [context, script, font] as const,
      );
      await page.close();
      const n = report.naive;
      console.log(
        `late-font (${context}, ${file.split('/').pop()}, ${await browser.version()}): a family measured before its face was added: ${n.fallback.toFixed(2)} -> ${n.afterAdd.toFixed(2)} px (${close(n.fallback, n.afterAdd) ? 'kept its fallback' : 'took the face'}); a fresh family: ${n.fresh.toFixed(2)} px`,
      );
      for (const s of report.scenarios)
        console.log(
          `  ${s.name}: legacy ${s.before.legacy.toFixed(2)} -> ${s.after.legacy.toFixed(2)} (face ${s.reference.legacy.toFixed(2)}), rich ${s.before.rich.toFixed(2)} -> ${s.after.rich.toFixed(2)} (face ${s.reference.rich.toFixed(2)}); ${s.changed} pixels changed, ${s.offReference} off the face (max delta ${s.maxDeltaToReference})`,
        );
      for (const l of report.log) console.log(`    ${l}`);
      failures.push(...problems(report));
    }
  } finally {
    await browser.close();
  }
  for (const f of failures) console.error(`late-font: ${f}`);
  if (!failures.length)
    console.log('late-font: ok, late faces take effect on the next draw in a worker and on a page');
  return failures.length ? 1 : 0;
}

process.exit(await main());
