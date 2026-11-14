import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import pptxgen from 'pptxgenjs';
import { HubProcess } from './hubproc.ts';
import { hubApi, login } from './linkhelpers.ts';
import { portOf } from './ports.ts';

/**
 * PowerPoint import drawn by pptx-preview (design/20 "PPTX and PDF"): the hub draws the slides in headless
 * Chromium (Playwright's here, ORDO_CHROMIUM), and the presentation records which renderer drew it. Since
 * design/27 M3 the import screen offers 'Editable (recommended)' and 'Pictures (LibreOffice)' only; the route
 * still takes `renderer=pptx-preview` until M8 retires it, so the deck goes in through the API. The screen's
 * own choice is checked too: editable by default, and remembered on the device. Its port: e2e/ports.ts row
 * 'pptx-preview', #0.
 */
const PORT = portOf('pptx-preview', 0);

test('a PowerPoint sent with renderer=pptx-preview is drawn by pptx-preview', async ({ page }) => {
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
    // The import screen: editable slides by default; the choice is remembered on this device.
    const editable = page.getByRole('radio', { name: /Editable \(recommended\)/ });
    const pictures = page.getByRole('radio', { name: /Pictures \(LibreOffice\)/ });
    const extend = page.getByRole('checkbox', { name: /Extend plain backgrounds to 16:9/ });
    await expect(editable).toBeChecked();
    await expect(extend).toBeEnabled();
    await pictures.check();
    await expect(extend).toBeDisabled();
    await page.reload();
    await page.evaluate(() => {
      location.hash = '#/library/import';
    });
    await expect(pictures).toBeChecked();

    const a = await hubApi(PORT);
    const res = await a.post('import/document', {
      multipart: {
        renderer: 'pptx-preview',
        file: { name: 'Sermon.pptx', mimeType: 'application/octet-stream', buffer: readFileSync(deck) },
      },
    });
    expect(res.status()).toBe(202);
    const job = (await res.json()) as { id: string; kind: string };
    expect(job.kind).toBe('document');
    await expect
      .poll(async () => ((await (await a.get(`jobs/${job.id}`)).json()) as { state: string }).state, {
        timeout: 60_000,
      })
      .toBe('done');

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
    // The import screen lists the job with the others.
    await expect(page.getByText(/^done$/).first()).toBeVisible({ timeout: 15_000 });
  } finally {
    hub.kill();
    if (before === undefined) delete process.env.ORDO_CHROMIUM;
    else process.env.ORDO_CHROMIUM = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A hub without LibreOffice (design/27 M9, `ORDO_LIBREOFFICE=off`): the import screen has no 'Pictures
 * (LibreOffice)' choice; a choice remembered on this device from a hub that had it imports as editable slides,
 * and the screen says so; the route refuses pictures with 501. Port #1 of its row.
 */
test('without LibreOffice the import screen offers editable slides only', async ({ page }) => {
  test.setTimeout(120_000);
  const before = process.env.ORDO_LIBREOFFICE;
  process.env.ORDO_LIBREOFFICE = 'off';
  const LITE_PORT = portOf('pptx-preview', 1);
  const hub = HubProcess.fresh(LITE_PORT);
  await hub.start();
  try {
    await login(page, `http://op.localhost:${LITE_PORT}`);
    await page.evaluate(() => {
      localStorage.setItem('ordo.pptxImport', 'libreoffice');
      location.hash = '#/library/import';
    });
    await page.reload();
    await page.evaluate(() => {
      location.hash = '#/library/import';
    });
    await expect(page.getByRole('radio', { name: /Editable \(recommended\)/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: /Pictures \(LibreOffice\)/ })).toHaveCount(0);
    await expect(
      page.getByText('This hub has no LibreOffice, so PowerPoint files are imported as editable slides.'),
    ).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Extend plain backgrounds to 16:9/ })).toBeEnabled();
    const a = await hubApi(LITE_PORT);
    const res = await a.post('import/document', {
      multipart: {
        renderer: 'libreoffice',
        file: {
          name: 'Sermon.pptx',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from('PK\x03\x04'),
        },
      },
    });
    expect(res.status()).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('libreoffice_unavailable');
  } finally {
    hub.kill();
    if (before === undefined) delete process.env.ORDO_LIBREOFFICE;
    else process.env.ORDO_LIBREOFFICE = before;
  }
});
