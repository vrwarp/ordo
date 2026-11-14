import { expect, test } from '@playwright/test';
import { HubProcess } from './hubproc.ts';
import { hubApi, login } from './linkhelpers.ts';
import { portOf } from './ports.ts';

/**
 * The venue PC's writes once Phones is on (design/28 P0, design/24 "Feature flags are settings"): the switch in
 * Settings → PINs turns `settings.phones.enabled` on; from then the hub needs the `x-ordo` header on writes from
 * signed-in full sessions, and every write path of the venue PC sends it. Its own hub (e2e/ports.ts row
 * 'phones-writes').
 */
const PORT = portOf('phones-writes');
const OP = `http://op.localhost:${PORT}`;

test.describe.configure({ mode: 'serial' });

let hub: HubProcess;
test.beforeAll(async () => {
  hub = HubProcess.fresh(PORT);
  await hub.start();
});
test.afterAll(() => hub?.kill());

test('the venue PC turns Phones on in Settings → PINs', async ({ page }) => {
  const api = await hubApi(PORT);
  expect(await (await api.get('settings/phones')).json()).toEqual({ enabled: false });
  await login(page, OP);
  await page.evaluate(() => {
    location.hash = '#/settings/pins';
  });
  const box = page.getByRole('checkbox', { name: 'Phones are used during services' });
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(box).not.toBeChecked();
  await box.check();
  await expect.poll(async () => (await (await api.get('settings/phones')).json()).enabled).toBe(true);
  // The store follows the hub's settings delta: the box stays ticked after a reload.
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Phones are used during services' })).toBeChecked({
    timeout: 20_000,
  });
});
