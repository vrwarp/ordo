import { readdirSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { budgetMs } from '../packages/domain/src/timing.test-util.ts';
import { operatorAssets } from './bundlefiles.ts';
import { HubProcess } from './hubproc.ts';
import { hubApi, hubLive, liveService, login } from './linkhelpers.ts';
import { portOf } from './ports.ts';

/**
 * Phones P0, the code split, on the venue PC (design/28 §3.1, principle 1: the full profile behaves as today).
 * Its pages come from the registry and are preloaded at startup, so: the live keys work right after sign-in
 * (the operate services are installed synchronously), the editor's first open and the settings' first open
 * show no "Loading…" (no React.lazy fallback), every regular chunk is loaded before the Shell's first paint,
 * and the service worker still precaches every built file. Chromium; its own hub (row 'split-full').
 */
const PORT = portOf('split-full');
const op = `http://op.localhost:${PORT}`;

let hub: HubProcess;
let api: APIRequestContext;
let songId: string;

test.beforeAll(async () => {
  hub = HubProcess.fresh(PORT);
  await hub.start();
  api = await hubApi(PORT);
  await liveService(api, 1);
  const list = (await (await api.get('presentations')).json()) as { id: string }[];
  songId = list[0]!.id;
});

test.afterAll(async () => {
  await api?.dispose();
  hub?.kill();
});

/**
 * Record, from before the first script, every registry "Loading…" ([data-page-loading]) and React.lazy fallback
 * (d0f49cb's `.page > .center.muted`, the direct child) a page shows, and the registry at the Shell's paint. A
 * page's own loading line (the editor's while it opens the presentation) is not the registry's.
 */
async function watchLoading(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __loading?: string[];
      __pagesAtShell?: unknown;
      __ordo?: { pages?: () => unknown };
    };
    w.__loading = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-page-loading], .page > .center.muted')) {
        const t = el.textContent?.trim() ?? '';
        const what = `${el.hasAttribute('data-page-loading') ? 'registry' : 'page'} ${location.hash} ${t}`;
        if (t === 'Loading…' && !w.__loading!.includes(what)) w.__loading!.push(what);
      }
      if (w.__pagesAtShell === undefined && document.querySelector('.app'))
        w.__pagesAtShell = w.__ordo?.pages ? w.__ordo.pages() : null;
    }).observe(document, { childList: true, subtree: true });
  });
}
const loadingSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __loading?: string[] }).__loading ?? []);

test('(a) the live keys work right after sign-in: Space takes the next cue', async ({ page }) => {
  await login(page, op);
  const before = await hubLive(api);
  await page.bringToFront();
  await page.keyboard.press('Space');
  await expect.poll(() => hubLive(api), { timeout: 15_000 }).not.toBe(before);
});

test('(b) the editor opens at once from the live view, with no Loading…', async ({ page }) => {
  await watchLoading(page);
  await login(page, op);
  const ms = await page.evaluate(
    (id) =>
      new Promise<number>((resolve) => {
        const t0 = performance.now();
        const done = () => {
          if (document.querySelector('[aria-label="Presentation title"]')) {
            obs.disconnect();
            resolve(performance.now() - t0);
          }
        };
        const obs = new MutationObserver(done);
        obs.observe(document, { childList: true, subtree: true });
        location.hash = `#/edit/${id}`;
      }),
    songId,
  );
  // The editor's own line while it opens the presentation is today's; the registry's never shows.
  expect((await loadingSeen(page)).filter((l) => l.startsWith('registry'))).toEqual([]);
  expect(ms).toBeLessThan(budgetMs(1_000));
});

test('(c) the first open of the settings shows no Loading…', async ({ page }) => {
  await watchLoading(page);
  await login(page, op);
  await page.evaluate(() => {
    location.hash = '#/settings/general';
  });
  await expect(page.locator('.settings-body')).toBeVisible();
  await page.evaluate(() => {
    location.hash = '#/setup';
  });
  await expect(page.getByRole('heading', { name: 'Setup & Device Permissions' })).toBeVisible();
  await page.waitForTimeout(200);
  expect(await loadingSeen(page)).toEqual([]);
});

test('(d) every regular chunk has loaded before the Shell first paints', async ({ page }) => {
  await watchLoading(page);
  await login(page, op);
  const at = (await page.evaluate(
    () => (window as unknown as { __pagesAtShell?: unknown }).__pagesAtShell,
  )) as { name: string; status: string }[] | null | undefined;
  expect(at, '__ordo.pages() at the Shell’s first paint').toBeTruthy();
  const names = (at ?? []).map((p) => p.name).sort();
  expect(names).toEqual(
    [
      'compact',
      'edit',
      'fonts',
      'import',
      'live',
      'operate',
      'playlists',
      'previews',
      'settings',
      'setup',
      'themes',
    ].sort(),
  );
  // Every regular chunk loaded; the phone's compact chunk never requested on the venue PC.
  expect((at ?? []).filter((p) => p.name !== 'compact' && p.status !== 'loaded')).toEqual([]);
  expect((at ?? []).find((p) => p.name === 'compact')?.status).toBe('idle');
  const now = await page.evaluate(() =>
    (window as unknown as { __ordo: { pages(): { name: string; status: string }[] } }).__ordo.pages(),
  );
  expect(now.find((p) => p.name === 'compact')?.status).toBe('idle');
});

test('(e) the service worker precaches every built file, as before', async ({ page }) => {
  await login(page, op);
  const expected = [
    ...readdirSync(operatorAssets())
      .filter((f) => !f.endsWith('.map'))
      .map((f) => `assets/${f}`),
    'index.html',
  ].sort();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          await navigator.serviceWorker.ready;
          const names = (await caches.keys()).filter((k) => k.startsWith('ordo-shell-'));
          if (!names.length) return [];
          const c = await caches.open(names[0]!);
          return (await c.keys()).map((r) => new URL(r.url).pathname.replace(/^\//, '')).sort();
        }),
      { timeout: 30_000 },
    )
    .toEqual(expected);
  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL ?? '',
    ),
  ).toMatch(/\/sw\.js$/);
});
