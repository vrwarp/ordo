import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import type { HubProcess } from '../hubproc.ts';
import { portOf } from '../ports.ts';
import { layoutChecks, phoneSlot, signInPhone, startPhoneHub } from './phonehelpers.ts';

/**
 * Phones P0, the compact shell (design/28 §2.2, §8 "Layout"): the frame (header with Back, `.page` the one
 * scroller, the tab bar), its sheets, the read-only P0 tab bodies, the Live now strip and the phone's sign-in,
 * in webkit-iphone (390x844) and chromium-android (360x800). One hub per test and project (row 'phone-shell':
 * test k on port 2k in webkit-iphone, 2k+1 in chromium-android), so sign-ins, lockouts and services never meet.
 */

/** This test's hub: port 2k + the project's slot of row 'phone-shell'. */
async function hubFor(k: number): Promise<{ hub: HubProcess; api: APIRequestContext; url: string }> {
  return startPhoneHub(portOf('phone-shell', 2 * k + phoneSlot()));
}

async function json<T>(p: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const r = await p;
  if (!r.ok()) throw new Error(`${r.url()} -> ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

const song = (title: string, line: string) => `${title}

Verse 1
${line}
That saved a wretch like me

Chorus
How precious did that grace appear
The hour I first believed
`;

/**
 * A sheet opened from `opener` (design/28 §2.2 "Sheets"): full width from the bottom (today a 380 px dialog at
 * x -10 on 360), the page behind inert, 44 px controls, Escape closes it and focus returns to the opener.
 */
async function sheetChecks(page: Page, opener: Locator, where: string): Promise<void> {
  await opener.tap();
  const sheet = page.locator('.dialog.sheet');
  await expect(sheet, where).toBeVisible();
  await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const g = await page.evaluate(() => {
    const r = document.querySelector('.dialog.sheet')!.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      w: Math.round(r.width),
      bottom: Math.round(r.bottom),
      iw: innerWidth,
      ih: innerHeight,
      inert: document.getElementById('root')!.hasAttribute('inert'),
      inBody: document.querySelector('.dialog.sheet')!.closest('#root') === null,
    };
  });
  expect(g, where).toEqual({ x: 0, w: g.iw, bottom: g.ih, iw: g.iw, ih: g.ih, inert: true, inBody: true });
  expect(await layoutChecks(page, where, { root: '.dialog.sheet' })).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(sheet, where).toHaveCount(0);
  expect(await page.evaluate(() => document.getElementById('root')!.hasAttribute('inert'))).toBe(false);
  await expect(opener, `${where}: focus back on the opener`).toBeFocused();
}

test('the frame: a header, the tab bar instead of the nav, and More', async ({ page }) => {
  const { hub, api, url } = await hubFor(0);
  try {
    await json(api.post('import/songselect', { data: { text: song('Amazing Grace', 'Amazing grace') } }));
    await signInPhone(page, url);
    await expect(page).toHaveURL(/#\/library$/);
    // Main's nav (767 px wide, cut at 390 and 360) is gone; the tab bar is at the bottom.
    await expect(page.locator('nav.nav')).toHaveCount(0);
    const bar = page.locator('nav.tabbar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('a, button')).toHaveText(['Plans', 'Library', 'Media', 'More']);
    await expect(bar.locator('a[aria-current="page"]')).toHaveText('Library');
    await expect(page.locator('[data-compact-header] h1')).toHaveText('Library');
    const geo = await page.evaluate(() => {
      const b = document.querySelector('nav.tabbar')!.getBoundingClientRect();
      return { bottom: b.bottom, ih: innerHeight, w: b.width, iw: innerWidth };
    });
    expect(geo.bottom).toBe(geo.ih);
    expect(geo.w).toBe(geo.iw);
    for (const [name, h1, hash] of [
      ['Plans', 'Plans', /#\/playlists$/],
      ['Media', 'Media', /#\/library\/media$/],
      ['Library', 'Library', /#\/library$/],
    ] as const) {
      await bar.getByRole('link', { name }).tap();
      await expect(page).toHaveURL(hash);
      await expect(bar.locator('a[aria-current="page"]')).toHaveText(name);
      await expect(page.locator('[data-compact-header] h1')).toHaveText(h1);
    }
    await bar.getByRole('button', { name: 'More' }).tap();
    const more = page.getByRole('dialog');
    await expect(more.getByText('Signed in on this phone')).toBeVisible();
    await expect(more.locator('[data-more-venue]')).toHaveText(`ordo at ${new URL(url).host}`);
    await expect(more.locator('[data-more-version]')).toHaveText(/^ordo \d+\.\d+\.\d+$/);
    await expect(more.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The compact chunk is loaded; the regular pages the venue PC preloads are not.
    const pages = await page.evaluate(() =>
      (window as unknown as { __ordo: { pages(): { name: string; status: string }[] } }).__ordo.pages(),
    );
    expect(pages.find((p) => p.name === 'compact')?.status).toBe('loaded');
    for (const name of ['live', 'edit', 'settings', 'setup', 'operate'])
      expect(pages.find((p) => p.name === name)?.status, name).toBe('idle');
  } finally {
    await api.dispose();
    hub.kill();
  }
});

test('every dialog is a bottom sheet: More', async ({ page }) => {
  const { hub, api, url } = await hubFor(3);
  try {
    await signInPhone(page, url);
    await sheetChecks(page, page.locator('nav.tabbar').getByRole('button', { name: 'More' }), 'More');
  } finally {
    await api.dispose();
    hub.kill();
  }
});
