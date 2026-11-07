import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KINDS } from '../bench/slides.page.ts';
import { budgetFor, defaultFonts, runSlides } from '../bench/slides.ts';

/**
 * The slide raster bench still runs (design/27 §13, M7): a short run in headless Chromium draws every slide
 * kind, scene included, and reports a timing for each. Timings are not checked here (CI machines vary);
 * `pnpm --filter @ordo/renderer bench:slides --check` does that on a quiet machine.
 */

const fonts = defaultFonts();
let chromium = false;
try {
  const pw = await import('@playwright/test');
  chromium = existsSync(pw.chromium.executablePath()) || existsSync('/usr/bin/google-chrome');
} catch {
  /* Playwright not installed */
}

describe.skipIf(!chromium || !existsSync(fonts.regular) || !existsSync(fonts.bold))(
  'slide raster bench',
  () => {
    it('draws every kind at the sizes asked for and reports its percentiles', async () => {
      const r = await runSlides({ iterations: 3, sizes: [960], headless: true, ...fonts });
      expect(r.rows.map((x) => x.kind)).toEqual(KINDS.map((k) => k.kind));
      for (const row of r.rows) {
        expect(row.width).toBe(960);
        expect(row.raster.n).toBe(3);
        expect(row.raster.p95).toBeGreaterThanOrEqual(row.raster.p50);
        expect(row.firstMs).toBeGreaterThan(0);
      }
      expect(r.rows[0]!.prepareMs).toBeGreaterThan(0); // the photo is prepared for the slide
    }, 120_000);

    it('holds text over a photo at 4K to the M7 exit, every other slide to the §13 budgets', () => {
      expect(budgetFor({ kind: 'sermon over a photo', width: 3840 })).toBe(12);
      expect(budgetFor({ kind: 'table', width: 3840 })).toBe(30);
      expect(budgetFor({ kind: 'table', width: 1920 })).toBe(10);
      expect(budgetFor({ kind: 'table', width: 2880 })).toBe(20);
    });
  },
);
