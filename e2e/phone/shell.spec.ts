import {
  type APIRequestContext,
  devices,
  expect,
  type Locator,
  type Page,
  request,
  test,
} from '@playwright/test';
import { fixtures, uploadMedia } from '../helpers.ts';
import type { HubProcess } from '../hubproc.ts';
import { portOf } from '../ports.ts';
import { touchDevice } from '../touchdevice.ts';
import {
  expectCappedSession,
  layoutChecks,
  PIN,
  phoneSlot,
  pinBodies,
  type Refusal,
  signInPhone,
  simulateInsets,
  startPhoneHub,
  watchRefusals,
} from './phonehelpers.ts';

/**
 * Phones P0, the compact shell (design/28 §2.2, §8 "Layout"): the frame (header with Back, `.page` the one
 * scroller, the tab bar), its sheets, the read-only P0 tab bodies, the Live now strip and the phone's sign-in,
 * in webkit-iphone (390x844) and chromium-android (360x800). One hub per test and project (row 'phone-shell':
 * test k on port 2k in webkit-iphone, 2k+1 in chromium-android), so sign-ins, lockouts and services never meet.
 */

// No refusal on any compact route (composed plan §6 W4): the P0 screens call no route above `light` and write
// nothing, so no answer is 403 `cap`, `x_ordo_required` or `origin`, or 429. The lockout test allows its 429s
// from POST /auth/pin only (`lockoutAllowed`); a second context checks its own (watchRefusals(ctx)).
let refusals: () => Promise<Refusal[]> = async () => [];
let lockoutAllowed = false;
test.beforeEach(({ page }) => {
  refusals = watchRefusals(page);
  lockoutAllowed = false;
});
test.afterEach(async () => {
  const found = (await refusals()).filter(
    (r) => !(lockoutAllowed && r.status === 429 && r.method === 'POST' && r.path === '/api/v1/auth/pin'),
  );
  expect(found, 'refusals on the compact routes').toEqual([]);
});

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

test('every dialog is a bottom sheet: More and Live (the media preview: the bodies test)', async ({
  page,
}) => {
  const { hub, api, url } = await hubFor(3);
  try {
    await seed(api);
    await signInPhone(page, url);
    await sheetChecks(page, page.locator('nav.tabbar').getByRole('button', { name: 'More' }), 'More');
    const strip = page.locator('[data-live-strip]');
    await expect(strip).toBeVisible({ timeout: 20_000 });
    await sheetChecks(page, strip, 'Live');
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
      const ctxRefusals = watchRefusals(ctx);
      try {
        const p2 = await ctx.newPage();
        await p2.goto(url);
        await shown(p2);
        await check(p2, 'at 844x390');
        expect(await ctxRefusals(), 'refusals at 844x390').toEqual([]);
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

test('Live now: the plan and its lock count, never the live slide; offline it says so', async ({ page }) => {
  test.setTimeout(180_000);
  const { hub, api, url } = await hubFor(6);
  try {
    await seed(api);
    // The hub's summary carries the live slide's text as liveLabel (today's chip showed it on a phone).
    const summary = await json<{ liveLabel?: string }>(api.get('live/summary'));
    expect(summary.liveLabel ?? '').toContain('Unique live line seventeen');
    await signInPhone(page, url);
    const strip = page.locator('[data-live-strip]');
    await expect(strip).toHaveText('Live at the venue: Sunday Service · 1 locked', { timeout: 20_000 });
    await expect(page.locator('[data-freshness]')).toHaveCount(0);
    expect(await page.locator('body').textContent()).not.toContain('Unique live line seventeen');
    await expect(page.locator('[data-live-chip]')).toHaveCount(0);
    await strip.tap();
    await expect(page.locator('[data-live-sheet]')).toHaveText(
      'A service is running at the venue. Sunday Service and its 1 presentation are locked until it ends. You can still look at everything and change anything else.',
    );
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-live-sheet]')).toHaveCount(0);

    // Offline: the strip cannot know, and the freshness line dates the copy (after its 5 s grace).
    await page.context().setOffline(true);
    await expect(strip).toHaveText('Live status unknown: offline');
    await expect(page.locator('[data-freshness]')).toHaveText(/^Offline · copy from \w{3} \d{1,2}:\d{2}/, {
      timeout: 15_000,
    });
    const stored = await page.evaluate(() => localStorage.getItem('ordo.op.lastContact'));
    expect(Number(stored)).toBeGreaterThan(Date.now() - 120_000);
    await layoutChecks(page, 'offline').then((p) => expect(p).toEqual([]));
    // Online again: the strip asks at once and shows the service; the freshness line goes.
    await page.context().setOffline(false);
    await expect(strip).toHaveText('Live at the venue: Sunday Service · 1 locked', { timeout: 20_000 });
    await expect(page.locator('[data-freshness]')).toHaveCount(0, { timeout: 20_000 });
    // End service: the strip goes.
    await json(api.post('live/events', { data: { id: 'end', event: { k: 'endService', at: Date.now() } } }));
    await expect(strip).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await api.dispose();
    hub.kill();
  }
});

/** Tap a PIN on the keypad and OK (scrolling each key into view: at 844x390 the card scrolls). */
async function tapPin(page: Page, pin: string): Promise<void> {
  for (const d of pin) {
    const key = page.locator('.keypad').getByRole('button', { name: d, exact: true });
    await key.scrollIntoViewIfNeeded();
    await key.tap();
  }
  const ok = page.getByRole('button', { name: 'OK' });
  await ok.scrollIntoViewIfNeeded();
  await ok.tap();
}

const PHONE_LINE =
  'On a phone you can look at everything and make small changes. Services run from the venue PC.';

test('sign-in on a phone: cap light and never remembered, its line and host, the lockout says when', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { hub, api, url } = await hubFor(7);
  try {
    // The hub lists caps (GET /auth/me `caps`), so the phone asks for 'light'.
    const me = await json<{ caps?: unknown }>(api.get('auth/me'));
    expect(me.caps).toEqual(['full', 'light', 'view']);
    const pins = pinBodies(page);
    await touchDevice(page);
    await page.goto(url);
    await expect(page.locator('.keypad')).toBeVisible({ timeout: 20_000 });
    // No Remember (main ticked it: a one-year device cookie and 12-hour sessions on a phone).
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(page.getByText('Remember this device')).toHaveCount(0);
    await expect(page.locator('[data-signin-phone]')).toHaveText(PHONE_LINE);
    await expect(page.locator('[data-signin-host]')).toHaveText(`ordo at ${new URL(url).host}`);
    // Safari only (navigator.standalone): the home-screen app keeps its own copy.
    const safari = await page.evaluate(() => 'standalone' in navigator);
    await expect(page.locator('[data-signin-home]')).toHaveCount(safari ? 1 : 0);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(await layoutChecks(page, 'sign-in', { focusFields: true })).toEqual([]);

    await tapPin(page, PIN);
    await expect(page.locator('.keypad')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('nav.tabbar')).toBeVisible();
    // The body asks for the cap and never for remember; the hub answers with a capped, unremembered session.
    expect(pins).toEqual([{ pin: PIN, cap: 'light' }]);
    await expectCappedSession(page);

    // The whole card is reachable in landscape (main's started at y -55 and could not be scrolled).
    await page.locator('nav.tabbar').getByRole('button', { name: 'More' }).tap();
    await page.getByRole('button', { name: 'Sign out' }).tap();
    await expect(page.locator('.keypad')).toBeVisible({ timeout: 20_000 });
    const land =
      test.info().project.name === 'webkit-iphone'
        ? { width: 844, height: 390 }
        : { width: 800, height: 360 };
    await page.setViewportSize(land);
    expect(
      await page.evaluate(() => (window as unknown as { __ordo: { layout: string } }).__ordo.layout),
    ).toBe('compact');
    const card = await page.locator('[data-phone-signin]').boundingBox();
    expect(card!.y).toBeGreaterThanOrEqual(0);
    expect(await layoutChecks(page, `sign-in at ${land.width}x${land.height}`)).toEqual([]);
    for (const name of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'Backspace', 'OK']) {
      const key = page.locator('.keypad').getByRole('button', { name, exact: true });
      await key.scrollIntoViewIfNeeded();
      const b = (await key.boundingBox())!;
      expect(b.y, name).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height, name).toBeLessThanOrEqual(land.height + 0.5);
    }

    // Five wrong PINs: the next answer is the lockout, with its end in the phone's own time.
    lockoutAllowed = true;
    let text = '';
    for (let i = 0; i < 7 && !text.startsWith('Too many'); i++) {
      await tapPin(page, '135790');
      const banner = page.locator('[data-signin-error]');
      await expect(banner).toBeVisible();
      text = (await banner.textContent()) ?? '';
      if (!text.startsWith('Too many')) expect(text).toBe('Wrong PIN.');
    }
    expect(text).toMatch(
      /^Too many wrong PINs from this network\. Try again at \d{1,2}:\d{2}(\s?[AP]M)?\. Everyone on the same Wi-Fi may share this wait\.$/,
    );
    expect(pins.length).toBeGreaterThan(1);
    expect(pins.slice(1).every((b) => b.cap === 'light' && !('remember' in b))).toBe(true);
  } finally {
    await api.dispose();
    hub.kill();
  }
});

test('a phone signed in before caps is signed out once, and its next sign-in asks for the cap', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { hub, api, url } = await hubFor(8);
  try {
    // A real uncapped, remembered session, as a phone held before the upgrade: main's sign-in sent
    // { pin, remember: true } (12 hours, a device cookie for a year). Its cookies are copied into the phone.
    const old = await request.newContext({
      baseURL: `${url}api/v1/`,
      extraHTTPHeaders: { 'x-ordo': '1' },
    });
    const r = await old.post('auth/pin', { data: { pin: PIN, remember: true } });
    expect(r.ok(), await r.text()).toBe(true);
    expect(await r.json()).toEqual({ role: 'operate' });
    const { cookies } = await old.storageState();
    expect(cookies.map((c) => c.name).sort()).toEqual(['ordo_device', 'ordo_session']);
    await old.dispose();
    await page.context().addCookies(cookies);
    const pins = pinBodies(page);
    const logouts: string[] = [];
    page.on('request', (q) => {
      if (q.method() === 'POST' && q.url().endsWith('/api/v1/auth/logout')) logouts.push(q.url());
    });
    await touchDevice(page);
    await page.goto(url);
    await expect(page.locator('[data-signin-again]')).toHaveText(
      'Phones now sign in for an hour at a time. Enter the PIN again.',
      { timeout: 20_000 },
    );
    expect(logouts).toHaveLength(1);
    await tapPin(page, PIN);
    await expect(page.locator('nav.tabbar')).toBeVisible({ timeout: 20_000 });
    expect(pins).toEqual([{ pin: PIN, cap: 'light' }]);
    await expectCappedSession(page, 'after the pre-upgrade session signed in again');
    // Capped now: a reload keeps the session, with no second sign-out and no note.
    await page.reload();
    await expect(page.locator('nav.tabbar')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.keypad')).toHaveCount(0);
    expect(logouts).toHaveLength(1);
  } finally {
    await api.dispose();
    hub.kill();
  }
});

test('an offline start reads the copy with its time; back online the strip and the line catch up', async ({
  page,
}) => {
  test.setTimeout(180_000);
  test.skip(
    test.info().project.name === 'webkit-iphone',
    'Playwright WebKit cannot reload a page while the context is offline ("internal error"); Chromium can',
  );
  const { hub, api, url } = await hubFor(9);
  try {
    await seed(api);
    await signInPhone(page, url);
    const strip = page.locator('[data-live-strip]');
    await expect(strip).toHaveText('Live at the venue: Sunday Service · 1 locked', { timeout: 20_000 });
    // The service worker holds the shell (registered after load and idle on a phone); the copy is in IndexedDB.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect
      .poll(() => page.evaluate(async () => (await caches.keys()).some((k) => k.startsWith('ordo-shell-'))), {
        timeout: 30_000,
      })
      .toBe(true);
    // The page goes away while connected: the last contact is stored on pagehide.
    await page.context().setOffline(true);
    await page.reload();
    await expect(page.locator('nav.tabbar')).toBeVisible({ timeout: 30_000 });
    // At once (no grace on an offline start), with the stored time; the strip cannot know.
    await expect(page.locator('[data-freshness]')).toHaveText(/^Offline · copy from \w{3} \d{1,2}:\d{2}/);
    await expect(strip).toHaveText('Live status unknown: offline');
    // The Library reads the phone's copy when there is one; without one it says so, never "No songs yet."
    // (P1's offline copy, design/28 §3.10, keeps the library on the phone).
    await expect(
      page.locator('[data-compact-library] .compact-row').first().or(page.locator('[data-not-loaded]')),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('No songs yet.')).toHaveCount(0);
    // Back online: the core reconnects and the poll answers, although the session started offline.
    await page.context().setOffline(false);
    await expect(page.locator('[data-freshness]')).toHaveCount(0, { timeout: 30_000 });
    await expect(strip).toHaveText('Live at the venue: Sunday Service · 1 locked', { timeout: 30_000 });
  } finally {
    await api.dispose();
    hub.kill();
  }
});

/** The phone's landscape size in this project. */
const landscape = () =>
  test.info().project.name === 'webkit-iphone' ? { width: 844, height: 390 } : { width: 800, height: 360 };

const ENDED_PHONE =
  'Signed out. A phone signs in for an hour at a time, and a PIN change signs it out. Enter the PIN to keep looking.';

/** The sign-in over an ended session, once it shows; its keypad takes the taps (none lands on what is under it). */
async function endedOverlay(page: Page, where: string): Promise<Locator> {
  const overlay = page.locator('[data-session-expired]');
  await expect(overlay, where).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.dialog.sheet'), `${where}: every sheet closed`).toHaveCount(0);
  const st = await page.evaluate(() => {
    const ov = document.querySelector('[data-session-expired]') as HTMLElement;
    const keys = [...ov.querySelectorAll<HTMLElement>('.keypad button')];
    const hits = keys.map((k) => {
      k.scrollIntoView({ block: 'nearest' });
      const r = k.getBoundingClientRect();
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!h && k.contains(h);
    });
    return {
      rootInert: document.getElementById('root')!.hasAttribute('inert'),
      inRoot: ov.closest('#root') !== null,
      keys: keys.length,
      hit: hits.every(Boolean),
    };
  });
  // The page behind is inert; the sign-in is a layer of its own outside it, and every key is what a tap hits.
  expect(st, where).toEqual({ rootInert: true, inRoot: false, keys: 12, hit: true });
  return overlay;
}

/** Type a PIN on the overlay's keypad and OK, each key scrolled into view (at 844x390 the card scrolls). */
async function tapOverlayPin(overlay: Locator, pin: string): Promise<void> {
  for (const d of pin) {
    const key = overlay.locator('.keypad').getByRole('button', { name: d, exact: true });
    await key.scrollIntoViewIfNeeded();
    await key.tap();
  }
  const ok = overlay.getByRole('button', { name: 'OK' });
  await ok.scrollIntoViewIfNeeded();
  await ok.tap();
}

test('the session ends under an open sheet: every sheet closes and the sign-in over it takes the PIN', async ({
  page,
}) => {
  // Review of P0 (R12): a sheet made #root inert and the sign-in, drawn inside #root, took no taps; they landed
  // on the sheet the volunteer could no longer see (six taps gave five digits; at 844x390 none registered, or
  // they pressed the hidden Sign out and the page reloaded).
  test.setTimeout(360_000);
  const { hub, api, url } = await hubFor(10);
  try {
    await seed(api);
    const pins = pinBodies(page);
    await signInPhone(page, url);
    await shown(page);
    const portrait = page.viewportSize()!;
    let n = 0;
    for (const size of [portrait, landscape()]) {
      await page.setViewportSize(size);
      for (const which of ['More', 'Live', 'media preview'] as const) {
        const where = `${which} at ${size.width}x${size.height}`;
        if (which === 'media preview') {
          await go(page, '#/library/media');
          await shown(page);
          await page.locator('[data-media-row]').first().tap();
        } else {
          await go(page, '#/library');
          await shown(page);
          if (which === 'More') await page.locator('nav.tabbar').getByRole('button', { name: 'More' }).tap();
          else await page.locator('[data-live-strip]').tap();
        }
        await expect(page.locator('.dialog.sheet'), where).toBeVisible();
        const hash = await page.evaluate(() => location.hash);
        // The venue PC changes the operate PIN: the phone, signed in with it, is signed out.
        n++;
        const pin = `13579${n}`;
        const r = await api.put('auth/pins', { data: { operatePin: pin } });
        expect(r.ok(), await r.text()).toBe(true);
        const overlay = await endedOverlay(page, where);
        await expect(overlay.locator('[data-session-ended-text]')).toHaveText(ENDED_PHONE);
        await tapOverlayPin(overlay, pin);
        await expect(overlay, where).toHaveCount(0, { timeout: 20_000 });
        expect(pins.at(-1), where).toEqual({ pin, cap: 'light' });
        await expectCappedSession(page, where);
        // Nothing under the sign-in was pressed (no Sign out, no reload) and the page is usable again.
        expect(await page.evaluate(() => location.hash), where).toBe(hash);
        expect(await page.evaluate(() => document.getElementById('root')!.hasAttribute('inert'))).toBe(false);
        await expect(page.locator('nav.tabbar')).toBeVisible();
      }
    }
  } finally {
    await api.dispose();
    hub.kill();
  }
});

test('sheets and the sign-in keep to the safe areas; a long plan name keeps the Live now strip to two lines', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { hub, api, url } = await hubFor(11);
  try {
    // A plan with a 140-character name, live (review of P0, R4: the strip grew to 5 lines, 111 px).
    const songId = (
      await json<{ id: string }>(
        api.post('import/songselect', { data: { text: song('Amazing Grace', 'Grace') } }),
      )
    ).id;
    const name = `Sunday ${'Celebration '.repeat(11)}Service`.slice(0, 140);
    const plan = await json<{ id: string }>(
      api.post('playlists', {
        data: {
          name,
          serviceDate: '2026-11-15',
          items: [{ id: 'i1', kind: 'presentation', presentationId: songId }],
        },
      }),
    );
    await json(api.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: plan.id } } }));
    await signInPhone(page, url);
    await shown(page);
    const strip = page.locator('[data-live-strip]');
    await expect(strip).toBeVisible({ timeout: 20_000 });
    for (const size of [page.viewportSize()!, landscape()]) {
      await page.setViewportSize(size);
      const g = await page.locator('.compact-strip-text').evaluate((el) => {
        const fs = Number.parseFloat(getComputedStyle(el).fontSize);
        return { h: el.getBoundingClientRect().height, fs, text: el.textContent ?? '' };
      });
      // Two lines at most (it was five, 111 px); the text itself is whole (clamped as drawn, not cut).
      expect(g.h, `strip text at ${size.width}x${size.height}`).toBeLessThanOrEqual(g.fs * 2 * 1.5);
      expect(g.text).toContain(name);
      expect(await layoutChecks(page, `long plan name at ${size.width}x${size.height}`)).toEqual([]);
    }
    // The Live sheet has the whole name.
    await strip.tap();
    await expect(page.locator('[data-live-sheet]')).toContainText(name);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog.sheet')).toHaveCount(0);

    // A landscape iPhone in an installed app: about 47 px on both sides, 21 at the bottom (R10: the sheets'
    // title, close and body sat inside them while the frame kept out of them).
    await page.setViewportSize(landscape());
    await simulateInsets(page, { left: 47, right: 47, bottom: 21 });
    expect(await layoutChecks(page, 'frame in the insets', { insets: { x: 47 } })).toEqual([]);
    for (const which of ['More', 'Live'] as const) {
      if (which === 'More') await page.locator('nav.tabbar').getByRole('button', { name: 'More' }).tap();
      else await strip.tap();
      const sheet = page.locator('.dialog.sheet');
      await expect(sheet).toBeVisible();
      expect(
        await layoutChecks(page, `${which} sheet in the insets`, {
          root: '.dialog.sheet',
          insets: { x: 47 },
        }),
      ).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
    }

    // The sign-in over an ended session, under a status bar in portrait and inside the side insets in landscape.
    const pins = pinBodies(page);
    const r = await api.put('auth/pins', { data: { operatePin: '135799' } });
    expect(r.ok(), await r.text()).toBe(true);
    const overlay = await endedOverlay(page, 'the sign-in');
    expect(
      await layoutChecks(page, 'the sign-in in the insets', {
        root: '[data-session-expired]',
        focusFields: false,
        insets: { x: 47 },
      }),
    ).toEqual([]);
    await page.setViewportSize({ width: landscape().height, height: landscape().width });
    await simulateInsets(page, { top: 47, bottom: 34 });
    expect(
      await layoutChecks(page, 'the sign-in under a status bar', {
        root: '[data-session-expired]',
        focusFields: false,
        insets: { x: 0, top: 47 },
      }),
    ).toEqual([]);
    await tapOverlayPin(overlay, '135799');
    await expect(overlay).toHaveCount(0, { timeout: 20_000 });
    expect(pins).toEqual([{ pin: '135799', cap: 'light' }]);
  } finally {
    await api.dispose();
    hub.kill();
  }
});
