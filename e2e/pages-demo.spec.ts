import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { shownSlideCue } from './helpers.ts';

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

  // ProPresenter import in the browser: a bundle ProPresenter exported, with its background picture.
  await page.evaluate(() => {
    location.hash = '#/library/import';
  });
  await page
    .locator('input[type=file][accept=".zip"]')
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
