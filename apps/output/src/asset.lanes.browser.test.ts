import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GeometryCase, PropsRun } from './asset.lanes.page.test-util.ts';

/**
 * Headless check of the asset worker's raster lanes and crop-aware decode (design/27 §7.5, M7): bundles
 * the real asset worker and asset.lanes.page.test-util.ts, and runs them in headless Chromium on an HTTPS
 * origin (OPFS and ImageDecoder need a secure context, as the venue's HTTPS outputs have).
 *
 * - The M7 exit: a props job sent while a 4K slide decodes and prepares two large photos is not delayed by
 *   it. Its bitmap reaches the renderer before the slide's (one chain, the asset worker before M7, always
 *   delivered it after), it waited in the lanes for at most the slice running when it arrived, and it
 *   arrives within the link's 150 ms lead plus one frame (checked on the median here, since a test run
 *   shares the machine with others; `pnpm --filter @ordo/output bench:lanes --check` checks every run on
 *   a quiet machine). The slide itself takes longer than the lead, so the check means something.
 * - The crop-aware decode lands every marker where the whole-file decode does, within half a pixel, and
 *   banded preparation is the one-pass bitmap byte for byte.
 *
 * Skipped when no Chromium is found (ORDO_TEST_CHROMIUM, Playwright's, or the system's Google Chrome).
 * Timings are of a software canvas on whatever machine runs it; the bound is the props deadline only.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
/** The link sends each props job this long before its second (link-core.ts PROPS_LEAD_MS). */
const PROPS_LEAD_MS = 150;
const FRAME_MS = 1000 / 60;

async function findChromium(): Promise<string | undefined> {
  if (process.env.ORDO_TEST_CHROMIUM) return process.env.ORDO_TEST_CHROMIUM;
  try {
    const { chromium } = await import('@playwright/test');
    const exe = chromium.executablePath();
    if (existsSync(exe)) return exe;
  } catch {
    /* Playwright not installed */
  }
  return existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
}

type Esbuild = { build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }> };

/** esbuild through vite, which this app depends on. */
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

const executablePath = await findChromium();

describe.skipIf(!executablePath)('asset worker raster lanes in headless Chromium (design/27 §7.5)', () => {
  it('a props flip is never more than one frame late while a 4K slide decodes; crops land exactly', async () => {
    const esbuild = await loadEsbuild();
    const [worker, page] = await Promise.all([
      bundle(esbuild, 'asset.worker.ts'),
      bundle(esbuild, 'asset.lanes.page.test-util.ts'),
    ]);
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, executablePath });
    let props: { runs: PropsRun[]; errors: string[]; failures: unknown[] };
    let geometry: { cases: GeometryCase[]; bands: { name: string; differing: number; steps: number }[] };
    try {
      const p = await browser.newPage();
      const errors: string[] = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.route('https://lanes.test/**', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/asset.js')
          return route.fulfill({ contentType: 'text/javascript', body: worker });
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
      });
      await p.goto('https://lanes.test/');
      await p.addScriptTag({ content: page });
      geometry = await p.evaluate(() =>
        (window as unknown as { __lanes: { geometry(): Promise<never> } }).__lanes.geometry(),
      );
      props = await p.evaluate(
        (offsets) =>
          (
            window as unknown as {
              __lanes: { props(u: string, w: number, h: number, o: number[]): Promise<never> };
            }
          ).__lanes.props('https://lanes.test/asset.js', 3840, 2160, offsets),
        [2, 20, 45, 80, 120],
      );
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }

    // The crop-aware decode: scaled (and cut where that is worth it), every marker in place.
    console.log(
      `crop-aware decode: ${geometry.cases.map((c) => `${c.name}: ${c.scaled ? (c.cropped ? 'scaled, cropped' : 'scaled') : 'whole'}, ${c.markers} markers moved ${c.markerShift.toFixed(3)} px, mean diff ${c.meanDiff.toFixed(2)}, PSNR ${c.psnr.toFixed(1)} dB`).join('; ')}`,
    );
    for (const c of geometry.cases) {
      expect(c.scaled, c.name).toBe(true);
      expect(c.markers, c.name).toBeGreaterThan(0);
      expect(c.markerShift, c.name).toBeLessThanOrEqual(0.5);
      expect(c.meanDiff, c.name).toBeLessThanOrEqual(2.5);
      expect(c.psnr, c.name).toBeGreaterThanOrEqual(32);
    }
    expect(geometry.cases.filter((c) => c.cropped).map((c) => c.name)).toEqual([
      'crop, stretched, sub-pixel box',
      'cover overflowing',
    ]);
    for (const b of geometry.bands) {
      expect(b.steps, b.name).toBeGreaterThan(1);
      expect(b.differing, b.name).toBe(0);
    }

    // The props job is never held up by the slide; the deadline holds, while the slide takes longer.
    expect(props.errors).toEqual([]);
    expect(props.failures).toEqual([]);
    console.log(
      `lanes: props ${props.runs.map((r) => r.propsMs.toFixed(1)).join(', ')} ms after sending (lead ${PROPS_LEAD_MS} ms); slide ${props.runs.map((r) => r.slideMs.toFixed(0)).join(', ')} ms; slide raster ${props.runs.map((r) => r.slide?.rasterMs).join(', ')} ms, longest slice ${props.runs.map((r) => r.slide?.longestMs).join(', ')} ms`,
    );
    for (const r of props.runs) {
      expect(r.propsFirst, `props sent ${r.offsetMs} ms after the slide`).toBe(true);
      // It waited (queue, turns) for at most the longest slice of the slide running meanwhile.
      expect(r.props!.waitMs!).toBeLessThanOrEqual(r.slide!.longestMs! + 5);
      expect(r.slide?.lane).toBe('interactive');
      expect(r.props?.lane).toBe('interactive');
    }
    const sorted = props.runs.map((r) => r.propsMs).sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]! - PROPS_LEAD_MS).toBeLessThanOrEqual(FRAME_MS);
    expect(Math.max(...props.runs.map((r) => r.slideMs - r.offsetMs))).toBeGreaterThan(
      PROPS_LEAD_MS + FRAME_MS,
    );
  }, 180_000);
});
