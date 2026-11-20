import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findChromium } from '../../../tools/find-chromium.ts';
import type { runFrames, runParity } from './frame.page.test-util.ts';

/**
 * Headless check of the underlay frame (design 29 R1): bundles frame.page.test-util.ts, runs it in headless
 * Chromium and expects a frame made in turns to be the very picture of its objects drawn one after the other,
 * at 1920 and at 3840 (exactly, where no unit lies inside it; a few edge pixels where one does). Chromium is
 * tools/find-chromium.ts's: skipped when none is found, and a failure under CI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

type Esbuild = {
  build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};

/** esbuild is not a dependency of this package; vite (apps/output) depends on it, so resolve it through vite. */
async function loadEsbuild(): Promise<Esbuild> {
  const name = 'esbuild';
  try {
    return (await import(name)) as Esbuild;
  } catch {
    const fromOutput = createRequire(join(root, 'apps/output/package.json'));
    return (await import(createRequire(fromOutput.resolve('vite')).resolve(name))) as Esbuild;
  }
}

const executablePath = await findChromium();

describe.skipIf(!executablePath)('the underlay frame in headless Chromium', () => {
  it('is the picture of its objects drawn one after the other, at 1920 and 3840, made in turns', async () => {
    const esbuild = await loadEsbuild();
    const built = await esbuild.build({
      entryPoints: [join(here, 'frame.page.test-util.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2022',
      absWorkingDir: root,
      logLevel: 'silent',
    });
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, executablePath });
    let out: Awaited<ReturnType<typeof runFrames>>;
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: built.outputFiles[0]!.text });
      type Run = { __frames: typeof runFrames };
      out = await page.evaluate(() => (window as unknown as Run).__frames());
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
    for (const c of out.cases)
      console.log(
        `frame, ${c.slide} at ${c.width}: ${c.under} objects, max diff ${c.maxDiff} (${c.overTwo} px over 2), ` +
          `${c.painted} px painted, ${c.turns} turns, longest ${c.longestMs.toFixed(1)} ms (slice ${out.sliceMs} ms)`,
      );
    expect(out.cases.map((c) => `${c.slide} ${c.width}`)).toEqual([
      'plain 1920',
      'plain 3840',
      'units 1920',
      'units 3840',
    ]);
    for (const c of out.cases) {
      const at = `${c.slide} at ${c.width}`;
      expect(c.painted, `${at}: the reference paints something`).toBeGreaterThan(c.width * 5);
      expect(c.turns, `${at}: made in turns`).toBeGreaterThan(0);
      // No unit inside: the same pixels, exactly. A unit inside: its few edge pixels round once more, the bound
      // the units' own browser test holds (design/27 section 13 "Geometry units": under 0.05 % of the frame).
      if (c.slide === 'plain')
        expect(c.maxDiff, `${at}: the frame against its objects drawn directly`).toBe(0);
      else
        expect(c.overTwo / (c.width * c.width * 0.5625), `${at}: pixels off by more than 2`).toBeLessThan(
          0.0005,
        );
    }
  }, 240_000);

  it('plus the direct part is the whole uncut slide, for 200 seeded crowded slides at 1920 and 20 at 3840 (M1)', async () => {
    const esbuild = await loadEsbuild();
    const built = await esbuild.build({
      entryPoints: [join(here, 'frame.page.test-util.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2022',
      absWorkingDir: root,
      logLevel: 'silent',
    });
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, executablePath });
    const out: Awaited<ReturnType<typeof runParity>>[] = [];
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: built.outputFiles[0]!.text });
      type Run = { __parity: typeof runParity };
      for (const [count, width] of [
        [200, 1920],
        [20, 3840],
      ] as const)
        out.push(
          await page.evaluate(([c, w]) => (window as unknown as Run).__parity(c!, w!), [count, width]),
        );
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
    for (const r of out) {
      console.log(
        `parity at ${r.width}: ${r.slides} slides, ${r.split} split, max diff ${r.maxDiff} (${r.worst || 'none'}), ${r.painted} px painted`,
      );
      expect(r.split, `${r.width}: the generator makes crowded slides`).toBeGreaterThan(r.slides * 0.9);
      expect(r.painted, `${r.width}: the slides paint something`).toBeGreaterThan(r.slides * r.width);
      // No unit inside: exactly the whole drawing's pixels.
      expect(r.maxDiff, `${r.width}: the frame and the direct part against the whole slide`).toBe(0);
    }
  }, 600_000);
});
