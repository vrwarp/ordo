import { type Browser, expect, type Page, test } from '@playwright/test';
import { OP, PIN } from './helpers.ts';

/**
 * The venue PC never gets the compact layout (design/28 decision 3, principle 1): Chromium with WebHID and
 * Window Management is the full capability profile, so whatever its window (1280x720, 1280x480 under 500 tall,
 * 600x900 under 700 wide) and whatever PIN signs in (the edit PIN gives the session the edit profile, not the
 * device), the layout is regular: no html[data-layout], no tab bar, the compact chunk never loaded, and the
 * operate PIN's nav keeps Setup and Live. The shared web server's hub.
 */
const EDIT_PIN = [...PIN].reverse().join('');

type Ordo = { layout?: string; pages?: () => { name: string; status: string }[] };

async function signIn(browser: Browser, size: { width: number; height: number }, pin: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: size });
  const page = await ctx.newPage();
  await page.goto(`${OP}/`);
  await expect(page.locator('input.pin')).toBeVisible({ timeout: 20_000 });
  // Before the session: the sign-in is the regular one (Remember ticked, as on main).
  expect(await page.evaluate(() => (window as unknown as { __ordo: Ordo }).__ordo.layout)).toBe('regular');
  await expect(page.getByText('Remember this device (12 hours)')).toBeVisible();
  await page.locator('input.pin').fill(pin);
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('nav.nav')).toBeVisible({ timeout: 20_000 });
  return page;
}

async function regular(page: Page, where: string): Promise<void> {
  const o = await page.evaluate(() => {
    const w = (window as unknown as { __ordo: Ordo }).__ordo;
    return {
      layout: w.layout,
      attr: document.documentElement.getAttribute('data-layout'),
      tabbar: document.querySelectorAll('.tabbar').length,
      compact: w.pages?.().find((p) => p.name === 'compact')?.status,
    };
  });
  expect(o, where).toEqual({ layout: 'regular', attr: null, tabbar: 0, compact: 'idle' });
}

for (const size of [
  { width: 1280, height: 720 },
  { width: 1280, height: 480 },
  { width: 600, height: 900 },
]) {
  test(`the venue PC at ${size.width}x${size.height} with the operate PIN: regular, Setup and Live in the nav`, async ({
    browser,
  }) => {
    const page = await signIn(browser, size, PIN);
    try {
      await regular(page, `operate ${size.width}x${size.height}`);
      const nav = page.locator('nav.nav');
      await expect(nav.getByRole('link', { name: 'Setup' })).toBeVisible();
      await expect(nav.getByRole('link', { name: /Live$/ })).toBeVisible();
      // Moving about keeps it regular.
      for (const hash of ['#/library', '#/playlists', '#/library/media'])
        await page.evaluate((h) => {
          location.hash = h;
        }, hash);
      await regular(page, `operate ${size.width}x${size.height} after navigating`);
    } finally {
      await page.context().close();
    }
  });
}

test('the venue PC at 600x900 with the edit PIN: the edit profile, still regular', async ({ browser }) => {
  const page = await signIn(browser, { width: 600, height: 900 }, EDIT_PIN);
  try {
    await expect(page.locator('nav.nav[data-profile="edit"]')).toBeVisible();
    await regular(page, 'edit 600x900');
  } finally {
    await page.context().close();
  }
});
