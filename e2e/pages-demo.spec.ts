import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { shownSlideCue } from './helpers.ts';
import { decodePng } from './png.ts';

/**
 * The GitHub Pages demo (apps/demo), served exactly as Pages serves a project site: static files under
 * /ordo/. Needs `pnpm build && pnpm build:pages` (CI runs both); skipped when site/ is missing.
 * Port 8870 (ORDO_E2E_PAGES_PORT overrides).
 */
const SITE = resolve('site');
const PORT = Number(process.env.ORDO_E2E_PAGES_PORT ?? 8870);
const BASE = `http://localhost:${PORT}/ordo/`;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

test.skip(!existsSync(join(SITE, 'hub-sw.js')), 'site/ is not built (pnpm build && pnpm build:pages)');

let server: Server;
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', BASE);
    if (!url.pathname.startsWith('/ordo/')) {
      // Requests outside the project site are what GitHub answers 404 for; the demo hub never lets the
      // API reach here (its service worker answers /api/v1 for every page it controls).
      res.writeHead(404).end('not found');
      return;
    }
    let path = join(SITE, decodeURIComponent(url.pathname.slice('/ordo/'.length)));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    if (!path.startsWith(SITE) || !existsSync(path)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test('the Pages demo runs with no hub: sample service, ProPresenter import, go live, outputs, reset', async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  // The first visit installs the demo hub and reloads under it; no sign-in.
  await expect(page.locator('[data-demo-banner]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    location.hash = '#/library';
  });
  await expect(page.getByText('Amazing Grace', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Welcome loop', { exact: true }).first()).toBeVisible();

  // Open an editor in the demo and verify Revision history loads visual snapshots without error.
  await page.evaluate(async () => {
    const res = await fetch('/api/v1/presentations');
    const list = (await res.json()) as { id: string; title: string }[];
    const grace = list.find((p) => p.title === 'Amazing Grace') ?? list[0]!;
    location.hash = `#/edit/${encodeURIComponent(grace.id)}`;
  });
  await page.getByRole('button', { name: 'History' }).click();
  const revDialog = page.getByRole('dialog');
  await expect(revDialog.getByRole('heading', { name: 'Revision history' })).toBeVisible();
  await expect(revDialog.getByText('Revision #2')).toBeVisible();
  await expect(revDialog.locator('.rev-preview-thumb').first()).toBeVisible();
  await revDialog.getByRole('cell', { name: '#1' }).click();
  await expect(revDialog.getByText('Revision #1')).toBeVisible();
  await revDialog.getByRole('button', { name: 'Close' }).click();
  await expect(revDialog).toBeHidden();

  // ProPresenter import in the browser: a bundle ProPresenter exported, with its background picture.
  await page.evaluate(() => {
    location.hash = '#/library/import';
  });
  await page
    .locator('input[type=file][accept*=".zip"]')
    .setInputFiles(resolve('packages/importers/test-fixtures/pro7/RestBildExportFromPP.probundle'));
  await expect(page.getByText('RestBildExportFromPP.probundle').first()).toBeVisible();
  await expect(page.getByText(/^done$/).first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    location.hash = '#/library';
  });
  await expect(page.getByText('TestBild', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => {
    location.hash = '#/library/media';
  });
  await expect(page.getByText('sample-media', { exact: true }).first()).toBeVisible();
  // The sample's moving background is a video (an SVG would be a still on the screens), and an SVG the
  // visitor adds is drawn into a still for the screens and says so (design/14 "Pictures").
  await expect(page.getByText('Aurora Waves', { exact: true }).first()).toBeVisible();
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'Visitor wave.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#f80"/></svg>',
      ),
    });
  await expect(page.getByText('Visitor wave.svg')).toBeVisible({ timeout: 20_000 });
  // Read back from the demo hub (the search index follows the stored library).
  await page.reload();
  await page.evaluate(() => {
    location.hash = '#/library/media';
  });
  await page.getByPlaceholder('Search media').fill('Visitor');
  await expect(page.getByText('Visitor wave', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/moves in previews only/).first()).toBeVisible();
  await page.getByPlaceholder('Search media').fill('');
  const visitor = await page.evaluate(async () => {
    const all = (await (await fetch('api/v1/media')).json()) as {
      name: string;
      kind: string;
      width?: number;
      delivery?: { mime: string; hash: string };
    }[];
    const aurora = all.find((m) => m.name === 'Aurora Waves');
    const svg = all.find((m) => m.name === 'Visitor wave');
    const file = svg?.delivery ? await fetch(`api/v1/files/${svg.delivery.hash}`) : undefined;
    return {
      aurora: aurora?.kind,
      svg: svg?.delivery?.mime,
      width: svg?.width,
      fileType: file?.headers.get('content-type'),
    };
  });
  expect(visitor).toEqual({ aurora: 'video', svg: 'image/png', width: 1920, fileType: 'image/png' });

  // It survives a reload: the library lives in this browser.
  await page.reload();
  await page.evaluate(() => {
    location.hash = '#/library';
  });
  await expect(page.getByText('TestBild', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  // Go live with the sample service (no dialog: the demo never has a hub), launch the outputs, GO.
  await page.evaluate(() => {
    location.hash = '#/playlists';
  });
  await page.getByText('Sample service').first().click();
  await page.getByRole('button', { name: 'Go live', exact: true }).click();
  await expect(page.locator('[data-hub-status]')).toContainText('Demo: live in this browser', {
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Launch outputs' }).click();
  const outs = () => context.pages().filter((p) => !p.isClosed() && p.url().includes('/ordo/output/'));
  await expect.poll(() => outs().length, { timeout: 30_000 }).toBe(1);
  const out = outs()[0]!;
  await expect
    .poll(
      () =>
        out
          .evaluate(
            () => (window as unknown as { __ordo?: { state(): { bus: string } } }).__ordo?.state().bus,
          )
          .catch(() => undefined),
      { timeout: 30_000 },
    )
    .toBe('fallback');
  await page.bringToFront();
  await page.keyboard.press('Space');
  await expect
    .poll(
      async () => {
        await out.bringToFront();
        return shownSlideCue(out).catch(() => null);
      },
      { timeout: 30_000 },
    )
    .toBe(0);
  // The second song's aurora moves on the Audience screen (a still SVG drew nothing there before).
  const song2 = await page.evaluate(async () => {
    type P = { id: string; title: string; sections: { slides: { id: string }[] }[] };
    const all = (await (await fetch('api/v1/presentations')).json()) as P[];
    return (
      all.find((p) => p.title === 'Holy, Holy, Holy')?.sections.flatMap((s) => s.slides.map((x) => x.id)) ??
      []
    );
  });
  expect(song2.length).toBeGreaterThan(0);
  const onSong2 = (key: string) => song2.some((id) => key.includes(`|${id}|`));
  const showing = () =>
    out
      .evaluate(
        () =>
          (window as unknown as { __ordo: { state(): { held: { live: string }[] } } }).__ordo.state().held[1]
            ?.live ?? '',
      )
      .catch(() => '');
  for (let i = 0; i < 8 && !onSong2(await showing()); i++) {
    await page.bringToFront();
    await page.keyboard.press('Space');
    await expect.poll(async () => (await showing()).length > 0, { timeout: 10_000 }).toBe(true);
    await out.bringToFront();
    await out.waitForTimeout(300);
  }
  expect(onSong2(await showing())).toBe(true);
  // A grid over the lower two thirds, where the ribbons move (their colour inside runs left to right, so
  // only their moving edges change a pixel).
  const sample = async () => {
    await out.bringToFront();
    await out.waitForTimeout(200);
    const img = decodePng(await out.screenshot());
    const pts: number[][] = [];
    for (let gy = 0; gy < 16; gy++)
      for (let gx = 0; gx < 32; gx++) {
        const x = Math.round(((gx + 0.5) / 32) * (img.width - 1));
        const y = Math.round((0.33 + ((gy + 0.5) / 16) * 0.67) * (img.height - 1));
        const o = (y * img.width + x) * 4;
        pts.push([img.data[o]!, img.data[o + 1]!, img.data[o + 2]!]);
      }
    return pts;
  };
  let first: number[][] = [];
  await expect
    .poll(
      async () => {
        first = await sample();
        // The aurora, not the clear colour: most of the lower frame is bright.
        return first.filter((p) => Math.max(...p) > 60).length > first.length * 0.8;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await out.waitForTimeout(2000);
  const later = await sample();
  const changed = later.filter((p, i) => p.some((v, c) => Math.abs(v - first[i]![c]!) > 12)).length;
  expect(changed, 'grid points of the aurora that changed in 2 s').toBeGreaterThan(later.length * 0.03);

  await page.bringToFront();
  await page.getByRole('button', { name: 'End service' }).click();
  await page.locator('.backdrop button', { hasText: 'End service' }).click();

  // Reset: back to the sample service.
  await page.locator('[data-demo-banner]').click();
  await page.getByRole('button', { name: 'Reset demo' }).click();
  await Promise.all([
    page.waitForEvent('load', { timeout: 30_000 }),
    page.locator('.backdrop button', { hasText: 'Reset' }).click(),
  ]);
  await expect(page.locator('[data-demo-banner]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    location.hash = '#/library';
  });
  await expect(page.getByText('Amazing Grace', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('TestBild', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

/**
 * PowerPoint in the Pages demo (design/26, design/27 §2 "Where the deck is parsed"): a public deck of the
 * golden corpus with a chart, imported as editable slides, is parsed in the operator's import worker for a
 * hub without LibreOffice and built by the demo with the import core: the chart's slide is partly drawn and
 * says what is missing, with no "Object Not Available in Demo" overlay; a deck imported as pictures shows
 * the demo's placeholder pages, each with the editor's stage pill.
 */
test('the Pages demo imports PowerPoint without LibreOffice: classes, missing lists, picture pages', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await expect(page.locator('[data-demo-banner]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    location.hash = '#/library/import';
  });
  const pptx = page.locator('input[type=file][accept*=".pptx"]');

  // Editable: the chart's slide is hybrid, its chart listed as not drawn; nothing stands in for it.
  await page.locator('input[name="pptx-import-mode"][value="native"]').check();
  await pptx.setInputFiles(resolve('golden-pptx/challenging-features/charts/chart_2d_basic.pptx'));
  const card = page.locator('[data-pptx-import]').first();
  await expect(card.getByText(/^done$/)).toBeVisible({ timeout: 60_000 });
  await expect(card.locator('[data-class="hybrid"]')).toHaveText(/1/);
  await expect(card.locator('[data-missing]')).toContainText(/chart/i);
  // The operator's import worker parsed it; the demo built version 1 from that scene.
  await card.locator('[data-import-notes] summary').click();
  await expect(card.locator('[data-import-notes]')).toContainText('Parsed in this browser');
  const stored = await page.evaluate(async () => {
    const list = (await (await fetch('/api/v1/presentations')).json()) as { id: string; title: string }[];
    const p = list.find((x) => x.title === 'chart_2d_basic')!;
    const full = await (await fetch(`/api/v1/presentations/${p.id}`)).json();
    const media = (await (await fetch('/api/v1/media')).json()) as { id: string; name: string }[];
    return { p: full, fallback: media.filter((m) => /Demo Fallback/.test(m.name)).map((m) => m.id) };
  });
  const slide = stored.p.sections[0].slides[0];
  expect(slide.pptx).toMatchObject({ class: 'hybrid', missing: ['chart'] });
  expect(slide.pptx.pending).toBeUndefined();
  expect(
    slide.objects.filter((o: { mediaId?: string }) => stored.fallback.includes(o.mediaId ?? '')),
  ).toEqual([]);
  // Canvas-first: the stage pill, and the slide's PowerPoint panel through it says what is missing.
  await card.getByRole('button', { name: 'Open presentation' }).click();
  const pill = page.locator('[data-pptx-stage-pill]');
  await expect(pill).toContainText('Imported PowerPoint slide');
  await pill.getByRole('button', { name: /PowerPoint options/ }).click();
  await expect(page.locator('[data-pptx-card] [data-missing]')).toContainText(/chart/i);

  // Pictures: the demo's placeholder pages, one per slide, each with its stage pill.
  await page.evaluate(() => {
    location.hash = '#/library/import';
  });
  await page.locator('input[name="pptx-import-mode"][value="libreoffice"]').check();
  await pptx.setInputFiles(resolve('golden-pptx/challenging-features/tables/table_styles_and_cells.pptx'));
  const pictures = page.locator('.card', { hasText: 'table_styles_and_cells.pptx' }).first();
  await expect(pictures.getByText(/^done$/)).toBeVisible({ timeout: 60_000 });
  await pictures.getByRole('button', { name: 'Open presentation' }).click();
  await expect(page.locator('[data-pptx-stage-pill]')).toContainText('Imported page 1');
  expect(errors).toEqual([]);
});
