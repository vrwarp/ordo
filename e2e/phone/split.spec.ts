import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';
import type { HubProcess } from '../hubproc.ts';
import { portOf } from '../ports.ts';
import { touchDevice } from '../touchdevice.ts';
import { phoneSlot, signInPhone, startPhoneHub } from './phonehelpers.ts';

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
});

test.afterAll(async () => {
  await api?.dispose();
  hub?.kill();
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
  try {
    const p2 = await ctx.newPage();
    await p2.goto(url);
    await expect(p2.locator('.page')).toBeVisible({ timeout: 20_000 });
    expect(await ordoLayout(p2)).toBe('compact');
    expect(await htmlLayout(p2)).toBe('compact');
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
