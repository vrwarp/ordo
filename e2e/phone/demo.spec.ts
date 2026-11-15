import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { portOf } from '../ports.ts';
import { touchDevice } from '../touchdevice.ts';
import { layoutChecks, phoneSlot } from './phonehelpers.ts';

/**
 * The GitHub Pages demo on a phone (design/28 §2.2; apps/demo): the demo's hub answers as an operate session
 * with no caps, so a phone gets the compact frame, and More offers the demo's About and Reset (the demo badge
 * of the regular nav is not there). Served as Pages serves a project site (static files under /ordo/), one
 * server per phone project (row 'phone-demo'). Needs `pnpm build && pnpm build:pages`; skipped without site/.
 */
const SITE = resolve('site');
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
let base = '';
test.beforeAll(async () => {
  const port = portOf('phone-demo', phoneSlot());
  base = `http://localhost:${port}/ordo/`;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    if (!url.pathname.startsWith('/ordo/')) {
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
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test('the Pages demo on a phone: the compact frame, and the demo’s About and Reset in More', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await touchDevice(page);
  await page.goto(base);
  // The first visit installs the demo hub and reloads under it; no sign-in.
  await expect(page.locator('nav.tabbar')).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as unknown as { __ordo: { layout: string } }).__ordo.layout)).toBe(
    'compact',
  );
  await expect(page.locator('nav.nav')).toHaveCount(0);
  await expect(page.locator('[data-demo-banner]')).toHaveCount(0);
  await expect(page.getByText('Amazing Grace', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  expect(await layoutChecks(page, 'demo library')).toEqual([]);

  await page.locator('nav.tabbar').getByRole('button', { name: 'More' }).tap();
  const more = page.locator('.dialog.sheet');
  await expect(more.getByRole('button', { name: 'About the demo' })).toBeVisible();
  await expect(more.getByRole('button', { name: 'Reset the demo' })).toBeVisible();
  expect(await layoutChecks(page, 'demo More', { root: '.dialog.sheet' })).toEqual([]);
  await more.getByRole('button', { name: 'About the demo' }).tap();
  const about = page.getByRole('dialog', { name: /demo/ }).last();
  await expect(about.getByRole('link', { name: /Source on GitHub/ })).toBeVisible();
  expect(await layoutChecks(page, 'demo About', { root: '.dialog.sheet' })).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: /Source on GitHub/ })).toHaveCount(0);
  // Reset asks first (a sheet too); Cancel keeps the demo as it is.
  await more.getByRole('button', { name: 'Reset the demo' }).tap();
  const confirm = page.locator('.dialog.sheet').filter({ hasText: 'Remove your songs' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).tap();
  await expect(page.locator('.dialog.sheet')).toHaveCount(0);
  await expect(page.getByText('Amazing Grace', { exact: true }).first()).toBeVisible();
});
