import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';
import { HubProcess } from '../hubproc.ts';
import { touchDevice } from '../touchdevice.ts';

/**
 * Phones (design/28 §8): the webkit-iphone (WebKit, iPhone 13, 390x844) and chromium-android (Chromium with
 * touch, Pixel 5 at 360x800, Android Chrome modelled by e2e/touchdevice.ts) projects run e2e/phone/*.spec.ts.
 * Path mode (`http://localhost:<port>/`), each spec on its own hub: a spec takes its ports from its own row of
 * the port table (e2e/ports.ts) and passes them here.
 */
export const PIN = '246810';
/** The edit PIN the hub derives from ORDO_DEV_PIN=246810: the operate PIN reversed (auth.ts). */
export const EDIT_PIN = '018642';

/** This project's index in a phone row: 0 webkit-iphone, 1 chromium-android. */
export function phoneSlot(): number {
  return test.info().project.name === 'chromium-android' ? 1 : 0;
}

/** A fresh hub on `port`, with an operate API context signed in. */
export async function startPhoneHub(
  port: number,
): Promise<{ hub: HubProcess; api: APIRequestContext; url: string }> {
  const hub = HubProcess.fresh(port);
  await hub.start();
  const api = await request.newContext({ baseURL: `http://localhost:${port}/api/v1/` });
  const r = await api.post('auth/pin', { data: { pin: PIN } });
  expect(r.ok(), await r.text()).toBe(true);
  return { hub, api, url: `http://localhost:${port}/` };
}

/**
 * Sign in by tapping the keypad, as on a phone: models Android Chrome first (touchDevice), opens `url`, taps
 * the PIN and OK, then waits until the keypad is gone and the app's page shows (today's frame and the
 * compact shell's both have `.page`).
 */
export async function signInPhone(page: Page, url: string, pin = PIN): Promise<void> {
  await touchDevice(page);
  await page.goto(url);
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).tap();
  await page.getByRole('button', { name: 'OK' }).tap();
  await expect(page.locator('.keypad')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.page')).toBeVisible({ timeout: 20_000 });
}
