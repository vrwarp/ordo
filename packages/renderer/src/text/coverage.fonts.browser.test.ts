import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PROBE_FAMILIES, type ProbeChecks } from './coverage.fonts.page.test-util.ts';
import { ADVANCES, SYSTEM_CONF, fontEnvironments } from './coverage.fonts.test-util.ts';
import type { CoverageReport } from './coverage.page.test-util.ts';
import { findChromium } from '../../../../tools/find-chromium.ts';

/**
 * Font coverage in headless Chromium under two fontconfigs of its own (design/27 §10, M7), so the probe's
 * verdict cannot come to depend on the computer's fonts again:
 * - bare: the computer's fonts without any face for the test's Han, Thai, Hangul, Devanagari and emoji
 *   characters, as on a runner with no CJK or Thai font (Chromium then measures the .notdef box of the
 *   stack's first family, which is not the generic's own);
 * - cjk-thai: the same with three generated faces for those characters, which the generic families
 *   (serif, sans-serif, monospace) and the system fallback each resolve to first, as on a computer with
 *   CJK and Thai fonts (a generic and the fallback answer with different faces).
 * The probe of two generic families let these characters pass for covered in both (the legacy text of
 * coverage.browser.test.ts reported only the dove). Each environment runs the cases of
 * coverage.browser.test.ts and the probe's own checks (coverage.fonts.page.test-util.ts). Linux only
 * (fontconfig); skipped without Chromium or DejaVu Sans, like coverage.browser.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

type Esbuild = { build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }> };

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
const runs = !!executablePath && existsSync(FONT) && process.platform === 'linux' && existsSync(SYSTEM_CONF);
const dir = runs ? mkdtempSync(join(tmpdir(), 'ordo-coverage-fonts-')) : '';
const envs = runs
  ? fontEnvironments(dir)
  : [
      { name: 'bare', conf: '' },
      { name: 'cjk-thai', conf: '' },
    ];

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!runs)('font coverage in headless Chromium under fontconfigs of its own', () => {
  const bundles = (async () => {
    const esbuild = await loadEsbuild();
    const bundle = async (file: string) =>
      (
        await esbuild.build({
          entryPoints: [join(here, file)],
          bundle: true,
          write: false,
          format: 'iife',
          target: 'es2022',
          absWorkingDir: root,
          logLevel: 'silent',
        })
      ).outputFiles[0]!.text;
    return {
      cases: await bundle('coverage.page.test-util.ts'),
      checks: await bundle('coverage.fonts.page.test-util.ts'),
    };
  })();

  /** The cases of coverage.browser.test.ts and the probe's checks, in a Chromium on this fontconfig. */
  async function inChromium(conf: string): Promise<{ report: CoverageReport; checks: ProbeChecks }> {
    const { cases, checks } = await bundles;
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({
      headless: true,
      executablePath,
      env: { ...process.env, FONTCONFIG_FILE: conf },
    });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error' || /OTS/.test(m.text())) errors.push(m.text());
      });
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: cases });
      await page.addScriptTag({ content: checks });
      const font = readFileSync(FONT).toString('base64');
      const out = await page.evaluate(
        async ([a, b, f]) => {
          const w = window as unknown as {
            __coverage: (s: string, f: string) => Promise<CoverageReport>;
            __probeChecks: (s: string, f: string) => Promise<ProbeChecks>;
          };
          return { report: await w.__coverage(a!, f!), checks: await w.__probeChecks(b!, f!) };
        },
        [cases, checks, font] as const,
      );
      expect(errors).toEqual([]);
      return out;
    } finally {
      await browser.close();
    }
  }

  for (const env of envs)
    it(`${env.name}: reports exactly what no shipped face has, whatever the computer's fonts answer`, async () => {
      const { report, checks } = await inChromium(env.conf);
      // The environment is the one named: the generated faces are there (cjk-thai) or not (bare), and in
      // the bare one no face has 中, 文 or ก (each is the serif's .notdef box).
      PROBE_FAMILIES.forEach((family, k) => {
        const width = env.name === 'bare' ? 0 : ADVANCES[k]! / 10;
        expect(checks.named[family]![0], `${family} in ${env.name}`).toBeCloseTo(width, 2);
      });
      if (env.name === 'bare') expect(checks.serif[1]).toEqual(checks.serif[0]);
      if (env.name === 'bare') expect(checks.serif[2]).toEqual(checks.serif[0]);

      // The blank face loaded (OTS accepted it) and draws every code point as nothing (an ascent may be -0,
      // which the probe's comparison takes for 0).
      expect(checks.blankLoaded).toBe(true);
      for (const m of checks.blankAlone) expect(m.map((v) => v + 0)).toEqual([0, 0, 0, 0, 0]);
      // No verdict before it had loaded; the same text reported once it had.
      expect(checks.beforeReady).toBe('');
      expect(checks.afterReady).toBe('中');

      for (const c of checks.cases) expect(c.uncovered, c.name).toBe(c.expected);
      for (const c of report.cases) expect(c.uncovered, c.name).toBe(c.expected);
      expect(report.reprobedAfterReset).toBe(true);
    }, 120_000);
});
