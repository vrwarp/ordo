import { mkdirSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';
import { HubProcess } from '../hubproc.ts';

/**
 * iPad editing (design/15): WebKit with the iPad Pro 11 descriptor, path mode (`http://localhost:<port>/`).
 * Each test owns a fresh hub on its own port (e2e/ports.ts, a row per spec).
 */
export const PIN = '246810';
/** The edit PIN the hub derives from ORDO_DEV_PIN=246810: the operate PIN reversed (auth.ts). */
export const EDIT_PIN = '018642';

export async function startHub(
  port: number,
): Promise<{ hub: HubProcess; api: APIRequestContext; url: string }> {
  const hub = HubProcess.fresh(port);
  await hub.start();
  const api = await request.newContext({ baseURL: `http://localhost:${port}/api/v1/` });
  const r = await api.post('auth/pin', { data: { pin: PIN } });
  expect(r.ok(), await r.text()).toBe(true);
  return { hub, api, url: `http://localhost:${port}/` };
}

export async function json<T>(p: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const r = await p;
  if (!r.ok()) throw new Error(`${r.url()} -> ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

/** Sign in by tapping the keypad, as on the iPad. */
export async function signInByTapping(page: Page, url: string, pin = PIN): Promise<void> {
  await page.goto(url);
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).tap();
  await page.getByRole('button', { name: 'OK' }).tap();
  await expect(page.getByRole('link', { name: 'Previews' })).toBeVisible({ timeout: 20_000 });
}

/** Screenshot under ORDO_E2E_SHOTS (when set), named per project so both orientations are kept. */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.ORDO_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${test.info().project.name}-${name}.png` });
}

/** Wait until every slide in the editor's slide list shows its thumbnail (rendered by the worker). */
export async function thumbsRendered(page: Page, count: number): Promise<void> {
  await expect(page.locator('.ed-slide')).toHaveCount(count);
  await expect(page.locator('.ed-slide img')).toHaveCount(count, { timeout: 20_000 });
}

/** The object URLs of the look previews' images, by look kind. */
export async function previewImages(page: Page): Promise<Record<string, string>> {
  return page
    .locator('[data-look-preview]')
    .evaluateAll((els) =>
      Object.fromEntries(
        els.map((e) => [
          e.getAttribute('data-look-preview') ?? '',
          e.querySelector('img')?.getAttribute('src') ?? '',
        ]),
      ),
    );
}

/** Wait until every look preview shows the current rendering. */
export async function previewsSettled(page: Page, count = 4): Promise<void> {
  await expect(page.locator('[data-look-preview]')).toHaveCount(count);
  await expect(page.locator('[data-look-preview][data-rendered="current"]')).toHaveCount(count, {
    timeout: 20_000,
  });
}

export const SONG = `Tablet Test Song

Verse 1
First line of verse one
Second line of verse one

Chorus
Chorus line alpha
Chorus line beta

Verse 2
Verse two line one
Verse two line two
`;
