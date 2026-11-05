import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import pptxgen from 'pptxgenjs';
import { HubProcess } from './hubproc.ts';
import { hubApi, login } from './linkhelpers.ts';

/**
 * PowerPoint import drawn by pptx-preview (design/20 "PPTX and PDF"): the operator picks the renderer in the
 * import screen, the hub draws the slides in headless Chromium (Playwright's here, ORDO_CHROMIUM), and the
 * presentation records which renderer drew it. Port 8392.
 */
const PORT = 8392;

test('a PowerPoint dropped with pptx-preview chosen is drawn by pptx-preview', async ({ page }) => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(join(tmpdir(), 'ordo-e2e-pptx-'));
  const deck = join(dir, 'Sermon.pptx');
  const p = new pptxgen();
  p.layout = 'LAYOUT_WIDE';
  const s1 = p.addSlide();
  s1.background = { color: '203864' };
  s1.addText('Morning Worship', {
    x: 0.5,
    y: 2.5,
    w: 12.3,
    h: 2,
    fontSize: 60,
    bold: true,
    color: 'FFFFFF',
    align: 'center',
  });
  p.addSlide().addText(
    [{ text: '16', options: { superscript: true } }, { text: ' For God so loved the world' }],
    {
      x: 0.5,
      y: 2.5,
      w: 12.3,
      h: 2,
      fontSize: 40,
      fontFace: 'Tahoma',
      align: 'center',
    },
  );
  writeFileSync(deck, (await p.write({ outputType: 'nodebuffer' })) as Buffer);

  const before = process.env.ORDO_CHROMIUM;
  process.env.ORDO_CHROMIUM = chromium.executablePath();
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    await login(page, `http://op.localhost:${PORT}`);
    await page.evaluate(() => {
      location.hash = '#/library/import';
    });
    await page.locator('[data-pptx-renderer]').selectOption('pptx-preview');
    await page.locator('input[type=file][accept=".pptx,.pdf"]').setInputFiles(deck);
    await expect(page.getByText('Sermon.pptx').first()).toBeVisible();
    await expect(page.getByText(/^done$/).first()).toBeVisible({ timeout: 60_000 });

    const a = await hubApi(PORT);
    const snap = (await (await a.get('library/snapshot')).json()) as {
      presentations: {
        title: string;
        source?: { kind: string; renderer?: string };
        sections: { slides: unknown[] }[];
      }[];
    };
    const pres = snap.presentations.find((x) => x.title === 'Sermon');
    expect(pres?.source).toEqual(expect.objectContaining({ kind: 'pptx', renderer: 'pptx-preview' }));
    expect(pres?.sections[0]?.slides).toHaveLength(2);
    // The choice is remembered on this device for the next import.
    await page.reload();
    await page.evaluate(() => {
      location.hash = '#/library/import';
    });
    await expect(page.locator('[data-pptx-renderer]')).toHaveValue('pptx-preview');
  } finally {
    hub.kill();
    if (before === undefined) delete process.env.ORDO_CHROMIUM;
    else process.env.ORDO_CHROMIUM = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
