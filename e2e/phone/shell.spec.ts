import { type APIRequestContext, devices, expect, type Locator, type Page, test } from '@playwright/test';
import { fixtures, uploadMedia } from '../helpers.ts';
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

/** What a phone's screens must never hold (design/28 decision 5, decision 21, §10 item 6). */
const NEVER = [
  '.konvajs-content',
  '.ed-floating-bar',
  '.ed-slideover-drawer',
  '.color-popover',
  '.editor > .props',
  '.editor',
];

/** The compact route's layout checks, plus nothing of the editor and no Edit control. */
async function compactRouteChecks(page: Page, where: string): Promise<void> {
  expect(await layoutChecks(page, where)).toEqual([]);
  for (const sel of NEVER) expect(await page.locator(sel).count(), `${where}: ${sel}`).toBe(0);
  expect(
    await page.getByRole('button', { name: /^edit\b/i }).count(),
    `${where}: an Edit button (§8 "a live plan shows no Edit")`,
  ).toBe(0);
  expect(await page.getByRole('link', { name: /^edit\b/i }).count(), `${where}: an Edit link`).toBe(0);
}

type Seeded = {
  liveSong: string;
  otherSong: string;
  livePlan: string;
  otherPlan: string;
  slides: string[];
  image: string;
};

/**
 * A library with two songs, a picture, the live plan "Sunday Service" (the first song, its first cue taken, so
 * the hub's liveLabel carries the line "Unique live line seventeen") and "Next Sunday" (both songs).
 */
async function seed(api: APIRequestContext): Promise<Seeded> {
  const live = await json<{ id: string }>(
    api.post('import/songselect', {
      data: { text: song('Be Thou My Vision', 'Unique live line seventeen') },
    }),
  );
  const other = await json<{ id: string }>(
    api.post('import/songselect', {
      data: { text: song('Amazing Grace', 'Amazing grace how sweet the sound') },
    }),
  );
  const { png } = fixtures();
  const image = await uploadMedia(api, png, 'image/png', true);
  const livePlan = await json<{ id: string }>(
    api.post('playlists', {
      data: {
        name: 'Sunday Service',
        serviceDate: '2026-11-15',
        items: [{ id: 'i1', kind: 'presentation', presentationId: live.id }],
      },
    }),
  );
  const otherPlan = await json<{ id: string }>(
    api.post('playlists', {
      data: {
        name: 'Next Sunday',
        serviceDate: '2026-11-22',
        items: [
          { id: 'j1', kind: 'presentation', presentationId: other.id },
          { id: 'j2', kind: 'presentation', presentationId: live.id },
        ],
      },
    }),
  );
  await json(
    api.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: livePlan.id } } }),
  );
  await json(
    api.post('live/events', { data: { id: 'g1', event: { k: 'go', cueIndex: 0, at: Date.now() } } }),
  );
  const p = await json<{ sections: { slides: { id: string }[] }[] }>(api.get(`presentations/${other.id}`));
  return {
    liveSong: live.id,
    otherSong: other.id,
    livePlan: livePlan.id,
    otherPlan: otherPlan.id,
    slides: p.sections.flatMap((x) => x.slides.map((sl) => sl.id)),
    image: image.id,
  };
}

/** The compact routes of a seeded hub, by name. */
function routes(s: Seeded): [string, string][] {
  return [
    ['Library', '#/library'],
    ['Media', '#/library/media'],
    ['Plans', '#/playlists'],
    ['a plan', `#/playlists/${s.otherPlan}`],
    ['the live plan', `#/playlists/${s.livePlan}`],
    ['previews', `#/previews/${s.otherSong}`],
    ['a slide', `#/previews/${s.otherSong}/${s.slides[1]}`],
  ];
}

async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
}

/** The route has rendered its compact body (not the "Getting the library…" wait). */
async function shown(page: Page): Promise<void> {
  await expect(page.locator('.compact-body').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-page-loading]')).toHaveCount(0);
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

test('every compact route passes the layout checks, and none holds the editor or an Edit control', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { hub, api, url } = await hubFor(1);
  try {
    const seeded = await seed(api);
    await signInPhone(page, url);
    const sizes =
      test.info().project.name === 'webkit-iphone'
        ? [
            { width: 390, height: 844 },
            // Safari's visual viewport with its toolbars: the tab bar must stay inside a shorter viewport.
            { width: 390, height: 664 },
          ]
        : [{ width: 360, height: 800 }];
    for (const size of sizes) {
      await page.setViewportSize(size);
      for (const [name, hash] of routes(seeded)) {
        await go(page, hash);
        await shown(page);
        if (hash.startsWith('#/previews'))
          await expect(page.locator('[data-look-preview]').first()).toBeVisible();
        await compactRouteChecks(page, `${name} at ${size.width}x${size.height}`);
      }
    }
  } finally {
    await api.dispose();
    hub.kill();
  }
});

test('the layout checks hold at 844x390 (still compact), 320x568 and 200 % text', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const { hub, api, url } = await hubFor(2);
  try {
    const seeded = await seed(api);
    await signInPhone(page, url);
    const check = async (p: Page, label: string) => {
      expect(
        await p.evaluate(() => (window as unknown as { __ordo: { layout: string } }).__ordo.layout),
      ).toBe('compact');
      for (const [name, hash] of routes(seeded)) {
        await go(p, hash);
        await shown(p);
        await compactRouteChecks(p, `${name} ${label}`);
      }
    };
    await page.setViewportSize({ width: 320, height: 568 });
    await check(page, 'at 320x568');
    await page.setViewportSize(
      test.info().project.name === 'webkit-iphone'
        ? { width: 390, height: 844 }
        : { width: 360, height: 800 },
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await check(page, 'at 200 % text');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '';
    });
    if (test.info().project.name === 'webkit-iphone') {
      // An iPhone in landscape: iOS keeps reporting the portrait screen.
      const ctx = await browser.newContext({
        ...devices['iPhone 13 landscape'],
        viewport: { width: 844, height: 390 },
        storageState: await page.context().storageState(),
      });
      try {
        const p2 = await ctx.newPage();
        await p2.goto(url);
        await shown(p2);
        await check(p2, 'at 844x390');
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await api.dispose();
    hub.kill();
  }
});

test('the tab bodies: lists, a plan, the previews, Back, the media sheet; no autofocus', async ({ page }) => {
  test.setTimeout(240_000);
  const { hub, api, url } = await hubFor(4);
  try {
    const seeded = await seed(api);
    await signInPhone(page, url);
    await shown(page);
    // Library: never focused on open (main's search took focus and panned the page by 58 and 100 px).
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    const rows = page.locator('[data-compact-library] .compact-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Be Thou My Vision' })).toContainText('Live · locked');
    await expect(rows.filter({ hasText: 'Amazing Grace' })).not.toContainText('Live · locked');
    const search = page.getByRole('searchbox');
    await search.fill('amazing');
    await expect(rows).toHaveCount(1);
    await search.fill('nothing like this');
    await expect(page.getByText('No presentations match “nothing like this”.')).toBeVisible();
    await search.fill('');
    await expect(rows).toHaveCount(2);
    // A row opens the presentation's previews; Back (the button) returns to the list by the browser's back.
    const before = await page.evaluate(() => history.length);
    await rows.filter({ hasText: 'Amazing Grace' }).tap();
    await expect(page).toHaveURL(new RegExp(`#/previews/${seeded.otherSong}$`));
    await expect(page.locator('[data-compact-header] h1')).toHaveText('Amazing Grace');
    await expect(page.locator('nav.tabbar')).toHaveCount(0);
    await expect(page.locator('[data-slide-position]')).toHaveText(`Slide 1 of ${seeded.slides.length}`);
    await expect(page.locator('[data-look-preview]').first()).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).tap();
    await expect(page.locator('[data-slide-position]')).toHaveText(`Slide 2 of ${seeded.slides.length}`);
    await expect(page).toHaveURL(new RegExp(`#/previews/${seeded.otherSong}/${seeded.slides[1]}$`));
    await page.getByRole('button', { name: 'Previous' }).tap();
    await expect(page.locator('[data-slide-position]')).toHaveText(`Slide 1 of ${seeded.slides.length}`);
    await page.locator('[data-back]').tap();
    await expect(page).toHaveURL(/#\/library$/);
    // Stepping slides replaced the entry: the list is where the row was tapped, history did not grow.
    expect(await page.evaluate(() => history.length)).toBe(before + 1);
    // The browser's own back from the previews returns to the list too.
    await rows.filter({ hasText: 'Amazing Grace' }).tap();
    await expect(page).toHaveURL(new RegExp(`#/previews/${seeded.otherSong}$`));
    await page.goBack();
    await expect(page).toHaveURL(/#\/library$/);
    await expect(page.locator('nav.tabbar')).toBeVisible();

    // Plans: newest first, the live one marked; a plan lists its items; the live plan says it is locked.
    await page.locator('nav.tabbar').getByRole('link', { name: 'Plans' }).tap();
    const plans = page.locator('[data-compact-plans] .compact-row');
    await expect(plans).toHaveCount(2);
    await expect(plans.nth(0)).toContainText('Next Sunday');
    await expect(plans.nth(0)).toContainText('2 items');
    await expect(plans.nth(1)).toContainText('Sunday Service');
    await expect(plans.nth(1)).toContainText('1 item');
    await expect(plans.nth(1).locator('[data-plan-live]')).toHaveText(/Live at the venue/);
    await expect(plans.nth(0).locator('[data-plan-live]')).toHaveCount(0);
    await plans.nth(0).tap();
    await expect(page.locator('[data-compact-header] h1')).toHaveText('Next Sunday');
    const items = page.locator('[data-compact-plan] .compact-items > li');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('Amazing Grace');
    await expect(items.nth(1)).toContainText('Be Thou My Vision');
    await expect(page.locator('[data-compact-plan] [data-plan-live]')).toHaveCount(0);
    // An item opens its previews; Back returns to the plan it came from.
    await items.nth(1).getByRole('link').tap();
    await expect(page).toHaveURL(new RegExp(`#/previews/${seeded.liveSong}$`));
    await page.locator('[data-back]').tap();
    await expect(page).toHaveURL(new RegExp(`#/playlists/${seeded.otherPlan}$`));
    await page.locator('[data-back]').tap();
    await expect(page).toHaveURL(/#\/playlists$/);
    await go(page, `#/playlists/${seeded.livePlan}`);
    await expect(page.locator('[data-compact-plan] [data-plan-live]')).toHaveText(
      /Live at the venue: locked until the service ends/,
    );
    // Back returns to the list.
    await page.locator('[data-back]').tap();
    await expect(page).toHaveURL(/#\/playlists$/);

    // Media: its rows; a tap opens the preview as a sheet.
    await page.locator('nav.tabbar').getByRole('link', { name: 'Media' }).tap();
    const media = page.locator('[data-media-row]');
    await expect(media).toHaveCount(1);
    await expect(media).toContainText('Ready');
    await expect(media).toContainText('Picture');
    await sheetChecks(page, media.first(), 'the media preview');
  } finally {
    await api.dispose();
    hub.kill();
  }
});

test('the empty states on a fresh hub', async ({ page }) => {
  const { hub, api, url } = await hubFor(5);
  try {
    await signInPhone(page, url);
    await shown(page);
    await expect(page.getByText('No songs yet.')).toBeVisible();
    await go(page, '#/library/media');
    await expect(page.getByText('No pictures yet.')).toBeVisible();
    await go(page, '#/playlists');
    await expect(page.getByText('No plans yet. Plans are made on a computer or iPad.')).toBeVisible();
    await compactRouteChecks(page, 'empty plans');
  } finally {
    await api.dispose();
    hub.kill();
  }
});
