import { existsSync, readFileSync } from 'node:fs';
import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';
import { assetOf, forbiddenIn } from '../bundlefiles.ts';
import type { HubProcess } from '../hubproc.ts';
import { portOf } from '../ports.ts';
import { touchDevice } from '../touchdevice.ts';
import { phoneSlot, type Refusal, signInPhone, startPhoneHub, watchRefusals } from './phonehelpers.ts';

/**
 * Phones P0, the code split (design/28 §3.1, §7, §8 "Layout"): a phone gets the compact layout from its
 * device class, a forced full profile meets the guard, and (the items below) it never downloads, mounts or
 * precaches the editor, the live view, Setup or the settings pages. Runs in webkit-iphone and chromium-android;
 * one hub per project (row 'phone-split': 0 webkit-iphone, 1 chromium-android) with a song and a live playlist.
 */

const SONG = `Phone Split Song

Verse 1
Amazing grace how sweet the sound
That saved a wretch like me

Chorus
Chorus line alpha
Chorus line beta
`;

let hub: HubProcess;
let api: APIRequestContext;
let url: string;
let songId: string;
/** The library font's file hash (a system face uploaded in beforeAll), when this machine has one. */
let fontHash: string | undefined;

/** A face to upload as a library font: the first of the system faces CI and this machine install. */
const FONT_FILES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];

async function json<T>(p: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const r = await p;
  if (!r.ok()) throw new Error(`${r.url()} -> ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

test.beforeAll(async () => {
  ({ hub, api, url } = await startPhoneHub(portOf('phone-split', phoneSlot())));
  const song = await json<{ id: string }>(api.post('import/songselect', { data: { text: SONG } }));
  songId = song.id;
  const pl = await json<{ id: string }>(
    api.post('playlists', {
      data: { name: 'Sunday Service', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
    }),
  );
  await json(api.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: pl.id } } }));
  const face = FONT_FILES.find((f) => existsSync(f));
  if (face) {
    await json(
      api.post('fonts/upload', {
        multipart: { file: { name: 'Hymnal.ttf', mimeType: 'font/ttf', buffer: readFileSync(face) } },
      }),
    );
    const fonts = await json<{ file: { hash: string } }[]>(api.get('fonts'));
    fontHash = fonts[0]?.file.hash;
  }
});

test.afterAll(async () => {
  await api?.dispose();
  hub?.kill();
});

// No refusal on any compact route (composed plan §6 W4): 403 `cap`, `x_ordo_required`, `origin`, or 429.
let refusals: () => Promise<Refusal[]> = async () => [];
test.beforeEach(({ page }) => {
  refusals = watchRefusals(page);
});
test.afterEach(async () => {
  expect(await refusals(), 'refusals on the phone').toEqual([]);
});

type Ordo = {
  layout?: string;
  capabilities: { deviceProfile: string; hid: boolean; windowManagement: boolean };
};
const ordo = (page: Page) => page.evaluate(() => (window as unknown as { __ordo: Ordo }).__ordo);
const ordoLayout = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ordo: Ordo }).__ordo.layout ?? null);
const htmlLayout = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-layout'));

test('(5) a phone is compact after sign-in', async ({ page }) => {
  await signInPhone(page, url);
  const o = await ordo(page);
  // The Chromium project models Android Chrome (e2e/touchdevice.ts): no WebHID, no Window Management.
  expect(o.capabilities).toMatchObject({ deviceProfile: 'edit', hid: false, windowManagement: false });
  expect(o.layout).toBe('compact');
  expect(await htmlLayout(page)).toBe('compact');
});

test('(5) an iPhone in landscape (844x390) stays compact', async ({ page, browser }) => {
  test.skip(test.info().project.name !== 'webkit-iphone', 'the landscape iPhone is a WebKit context');
  await signInPhone(page, url);
  const state = await page.context().storageState();
  const ctx = await browser.newContext({
    ...devices['iPhone 13 landscape'],
    // iOS keeps reporting the portrait screen (390x844) in landscape, as the descriptor does.
    viewport: { width: 844, height: 390 },
    storageState: state,
  });
  const ctxRefusals = watchRefusals(ctx);
  try {
    const p2 = await ctx.newPage();
    await p2.goto(url);
    await expect(p2.locator('.page')).toBeVisible({ timeout: 20_000 });
    expect(await ordoLayout(p2)).toBe('compact');
    expect(await htmlLayout(p2)).toBe('compact');
    expect(await ctxRefusals(), 'refusals at 844x390').toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('(6) a forced ?profile=full on a phone stays edit and compact', async ({ page }) => {
  await touchDevice(page);
  await page.goto(`${url}?profile=full`);
  // Before the session: main.tsx decided the layout from the device class.
  await expect(page.locator('.keypad')).toBeVisible({ timeout: 20_000 });
  expect((await ordo(page)).capabilities.deviceProfile).toBe('edit');
  expect(await ordoLayout(page)).toBe('compact');
  await signInPhone(page, `${url}?profile=full`);
  expect((await ordo(page)).capabilities.deviceProfile).toBe('edit');
  expect(await ordoLayout(page)).toBe('compact');
  expect(await htmlLayout(page)).toBe('compact');
});

/** The built assets the page requested (its own and its dedicated workers' requests). */
function watchAssets(page: Page): () => string[][] {
  const seen: string[][] = [];
  page.on('request', (req) => {
    const f = assetOf(req.url());
    if (f) seen.push(f.sources);
  });
  return () => seen;
}

/** Record whether Konva's stage ever mounts (before any navigation of the page). */
async function watchKonva(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __sawKonva?: boolean };
    new MutationObserver(() => {
      if (document.querySelector('.konvajs-content')) w.__sawKonva = true;
    }).observe(document, { childList: true, subtree: true });
  });
}
const sawKonva = (page: Page) =>
  page.evaluate(() => (window as unknown as { __sawKonva?: boolean }).__sawKonva === true);
const fetched = (seen: string[][], needle: string) => seen.some((s) => s.some((x) => x.includes(needle)));

test('(2) the canvas editor route opens the presentation’s previews, by replace, with no Konva', async ({
  page,
}) => {
  const assets = watchAssets(page);
  await watchKonva(page);
  await signInPhone(page, url);
  await page.evaluate((id) => {
    location.hash = `#/edit/${id}`;
  }, songId);
  const pushed = await page.evaluate(() => history.length);
  await expect(page).toHaveURL(new RegExp(`#/previews/${songId}$`));
  await expect(page.locator('[data-look-preview]').first()).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => history.length)).toBe(pushed);
  expect(await page.locator('.konvajs-content').count()).toBe(0);
  expect(await sawKonva(page)).toBe(false);
  expect(fetched(assets(), 'views/editor/EditorView.tsx')).toBe(false);
});

test('(3) Setup, the settings, the live view and the Themes, Fonts and Import tabs land on the Library by replace', async ({
  page,
}) => {
  const assets = watchAssets(page);
  await signInPhone(page, url);
  for (const hash of [
    '#/settings/general',
    '#/settings/pins',
    '#/setup',
    '#/checklist',
    '#/live',
    '#/library/themes',
    '#/library/fonts',
    '#/library/import',
  ]) {
    await page.evaluate(() => {
      location.hash = '#/library';
    });
    await expect(page).toHaveURL(/#\/library$/);
    await page.evaluate((h) => {
      location.hash = h;
    }, hash);
    const pushed = await page.evaluate(() => history.length);
    await expect(page, hash).toHaveURL(/#\/library$/);
    // Give a pushed redirect (d0f49cb's effect) time to show.
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => history.length), `${hash} replaced, not pushed`).toBe(pushed);
  }
  expect(fetched(assets(), 'views/settings/'), 'a settings chunk was fetched').toBe(false);
  expect(fetched(assets(), 'views/setup/'), 'the Setup chunk was fetched').toBe(false);
  expect(fetched(assets(), 'views/live/LiveView.tsx'), 'the live view was fetched').toBe(false);
});

test('(7) Request Desktop Website: a phone on the regular layout still never mounts the editor', async ({
  browser,
}) => {
  test.skip(test.info().project.name !== 'webkit-iphone', 'Safari’s Request Desktop Website');
  const ctx = await browser.newContext({
    ...devices['iPhone 13'],
    viewport: { width: 980, height: 2120 },
    screen: { width: 390, height: 844 },
  });
  const ctxRefusals = watchRefusals(ctx);
  try {
    const page = await ctx.newPage();
    const assets = watchAssets(page);
    await watchKonva(page);
    await signInPhone(page, url);
    const screen = await page.evaluate(() => [window.screen.width, window.screen.height]);
    test.skip(
      screen[0] !== 390 || screen[1] !== 844,
      `Playwright WebKit reports screen ${screen.join('x')}, not the given 390x844 (check RDW on a device)`,
    );
    expect(await ordoLayout(page)).toBe('regular');
    expect(await htmlLayout(page)).toBeNull();
    await page.evaluate((id) => {
      location.hash = `#/edit/${id}`;
    }, songId);
    const pushed = await page.evaluate(() => history.length);
    await expect(page).toHaveURL(new RegExp(`#/previews/${songId}$`));
    await expect(page.locator('[data-look-preview]').first()).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => history.length)).toBe(pushed);
    expect(await sawKonva(page)).toBe(false);
    expect(fetched(assets(), 'views/editor/EditorView.tsx')).toBe(false);
    expect(await ctxRefusals(), 'refusals on the regular layout').toEqual([]);
  } finally {
    await ctx.close();
  }
});

/** A phone's first load: sign in, the Library, 3 s idle. Returns every request the page made. */
async function firstLoad(page: Page): Promise<{ url: string; sources: string[] | undefined }[]> {
  const reqs: { url: string; sources: string[] | undefined }[] = [];
  page.on('request', (req) => {
    if (req.serviceWorker()) return;
    reqs.push({ url: req.url(), sources: assetOf(req.url())?.sources });
  });
  await signInPhone(page, url);
  await expect(page).toHaveURL(/#\/library$/);
  await page.waitForTimeout(3000);
  return reqs;
}

test('(1a) the first load holds no editor, live, settings, Setup or output code', async ({ page }) => {
  const reqs = await firstLoad(page);
  const bad: string[] = [];
  for (const r of reqs) {
    const f = assetOf(r.url);
    if (f) for (const v of forbiddenIn(f)) bad.push(`${f.file}: ${v}`);
  }
  expect(bad).toEqual([]);
});

test('(1b) the first load starts no thumbnail worker and fetches no font file', async ({ page }) => {
  const reqs = await firstLoad(page);
  const workers = reqs.filter((r) => /thumb\.worker/.test(r.url)).map((r) => r.url);
  expect.soft(workers, 'the thumbnail worker waits for the first preview').toEqual([]);
  test.skip(!fontHash, 'no system face to upload as a library font on this machine');
  const fontFiles = reqs.filter((r) => r.url.includes(`/api/v1/files/${fontHash}`)).map((r) => r.url);
  expect.soft(fontFiles, 'no library font file before a preview draws').toEqual([]);
});

test('(4) the service worker precaches no editor, live, settings, Setup or output code, and no import worker', async ({
  page,
}) => {
  await signInPhone(page, url);
  const cached = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const names = (await caches.keys()).filter((k) => k.startsWith('ordo-shell-'));
    const c = names[0] ? await caches.open(names[0]) : undefined;
    const keys = c ? (await c.keys()).map((r) => new URL(r.url).pathname) : [];
    return { script: reg.active?.scriptURL ?? '', keys };
  });
  expect.soft(cached.script).toMatch(/\/sw\.js\?set=compact$/);
  expect(cached.keys.length).toBeGreaterThan(0);
  const bad: string[] = [];
  for (const k of cached.keys) {
    const f = assetOf(new URL(k, url).href);
    if (f) for (const v of forbiddenIn(f)) bad.push(`${f.file}: ${v}`);
    if (/import\.worker/.test(k)) bad.push(`${k}: the import worker`);
  }
  expect(bad).toEqual([]);
});

test('(1c) the first load’s built assets are at most 300 KB gzip', async ({ page }) => {
  const reqs = await firstLoad(page);
  const files = new Map<string, { raw: number; gzip: number }>();
  let api = 0;
  const fonts: string[] = [];
  for (const r of reqs) {
    const f = assetOf(r.url);
    if (f) files.set(f.file, { raw: f.raw, gzip: f.gzip });
    else if (fontHash && r.url.includes(`/api/v1/files/${fontHash}`)) fonts.push(r.url);
    else if (r.url.includes('/api/')) api++;
  }
  const gzip = [...files.values()].reduce((n, f) => n + f.gzip, 0);
  const raw = [...files.values()].reduce((n, f) => n + f.raw, 0);
  // Not code, and not counted: the API answers and any font file (1b says there is none).
  console.log(
    `${test.info().project.name}: first load ${files.size} built files, ${raw} B raw, ${gzip} B gzip; ${api} API requests; ${fonts.length} font files`,
  );
  for (const [f, s] of files) console.log(`  ${f} ${s.raw} B, ${s.gzip} B gzip`);
  expect(gzip).toBeLessThanOrEqual(300_000);
});
