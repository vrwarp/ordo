import { expect, test } from '@playwright/test';
import { portOf } from '../ports.ts';
import { json, SONG, signInByTapping, startHub, tabletSlot } from './ipadhelpers.ts';

/**
 * Phones P0, the code split, on a tablet (design/28 decision 3, principle 1): an iPad (both orientations) and an
 * Android tablet keep the regular layout, with no compact attribute on the document, and the editor's first
 * open shows no "Loading…" (its chunk is preloaded at startup). Row 'ipad-split': 0 webkit-ipad,
 * 1 webkit-ipad-portrait, 2 chromium-tablet.
 */
test('a tablet keeps the regular layout and opens the editor with no Loading…', async ({ page }) => {
  const { hub, api, url } = await startHub(portOf('ipad-split', tabletSlot()));
  try {
    const song = await json<{ id: string }>(api.post('import/songselect', { data: { text: SONG } }));
    await page.addInitScript(() => {
      const w = window as unknown as { __loading?: number };
      w.__loading = 0;
      new MutationObserver(() => {
        if (document.querySelector('[data-page-loading]')) w.__loading = (w.__loading ?? 0) + 1;
      }).observe(document, { childList: true, subtree: true });
    });
    await signInByTapping(page, url);
    expect(
      await page.evaluate(() => (window as unknown as { __ordo: { layout?: string } }).__ordo.layout),
    ).toBe('regular');
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-layout'))).toBe(false);
    await page.evaluate((id) => {
      location.hash = `#/edit/${encodeURIComponent(id)}`;
    }, song.id);
    await expect(page.locator('.konvajs-content').first()).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => (window as unknown as { __loading?: number }).__loading)).toBe(0);
    // A tablet precaches every file, as before (design/28 §3.1: the set is chosen by device class).
    const script = await page.evaluate(
      async () => (await navigator.serviceWorker.ready).active?.scriptURL ?? '',
    );
    expect(script).toMatch(/\/sw\.js$/);
  } finally {
    await api.dispose();
    hub.kill();
  }
});
