import { expect, test } from '@playwright/test';
import { HubProcess } from './hubproc.ts';
import { fixtures, SONG } from './helpers.ts';
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

test('with Phones on, every venue PC write path sends x-ordo (no 403 x_ordo_required or origin)', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const api = await hubApi(PORT);
  expect((await api.put('settings/phones', { data: { enabled: true } })).ok()).toBe(true);
  const refused: Promise<string | undefined>[] = [];
  page.on('response', (r) => {
    if (r.status() !== 403 || !r.url().includes('/api/')) return;
    refused.push(
      r
        .json()
        .then((b: { error?: { code?: string } }) => `${r.request().method()} ${r.url()} ${b.error?.code}`)
        .catch(() => undefined),
    );
  });
  await login(page, OP);

  // A song with New song.
  await page.getByRole('link', { name: 'Library' }).click();
  await page.getByRole('button', { name: 'New song' }).click();
  await page.locator('textarea').fill(SONG);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Amazing Test Song').first()).toBeVisible();
  type Rec = { id: string; title: string; rev: number };
  const findSong = async () =>
    ((await (await api.get('presentations')).json()) as Rec[]).find((p) => p.title === 'Amazing Test Song');
  await expect.poll(findSong).toBeTruthy();
  const song = (await findSong())!;

  // A line edited and saved in the editor (a song opens in the Lyric Script on the venue PC).
  await page.evaluate((id) => {
    location.hash = `#/edit/${encodeURIComponent(id)}`;
  }, song.id);
  const field = page.locator('textarea[data-reflow-slide]').first();
  await expect(field).toBeVisible({ timeout: 20_000 });
  await field.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' again');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(async () => ((await (await api.get(`presentations/${song.id}`)).json()) as { rev: number }).rev)
    .toBeGreaterThan(song.rev);

  // A plan with the song.
  await page.getByRole('link', { name: 'Playlists' }).click();
  await page.getByPlaceholder('New playlist name').fill('Sunday');
  await page.getByPlaceholder('New playlist name').press('Enter');
  const songRow = page.locator('.add-items .vrow', { hasText: 'Amazing Test Song' }).first();
  await expect(songRow).toBeVisible({ timeout: 15_000 });
  await songRow.getByRole('button', { name: 'Add', exact: true }).click();
  await expect
    .poll(async () => {
      const pls = (await (await api.get('playlists')).json()) as { name: string; items: unknown[] }[];
      return pls.find((p) => p.name === 'Sunday')?.items.length ?? 0;
    })
    .toBe(1);

  // The service, through the live view's chunk: Go live from the plan, Next (Space) on the live view, End
  // service with its confirmation. Its writes go to the live process (POST /live/events or the socket).
  type Summary = { seq: number; mode: string };
  const summary = async () => (await (await api.get('live/summary')).json()) as Summary;
  const plans = (await (await api.get('playlists')).json()) as { id: string; name: string }[];
  const plan = plans.find((p) => p.name === 'Sunday')!;
  await page.evaluate((id) => {
    location.hash = `#/playlists/${encodeURIComponent(id)}`;
  }, plan.id);
  await page.getByRole('button', { name: 'Go live', exact: true }).click();
  await expect(page.getByRole('button', { name: 'End service' })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await summary()).mode).toBe('live');
  await page.evaluate(() => {
    location.hash = '#/live';
  });
  await expect(page.getByRole('button', { name: 'End service' })).toBeVisible({ timeout: 15_000 });
  const seq = (await summary()).seq;
  await page.keyboard.press('Space');
  await expect.poll(async () => (await summary()).seq, { timeout: 15_000 }).toBeGreaterThan(seq);
  await page.getByRole('button', { name: 'End service' }).click();
  await page
    .locator('.dialog', { hasText: 'Clear every output' })
    .getByRole('button', { name: 'End service' })
    .click();
  await expect.poll(async () => (await summary()).mode, { timeout: 15_000 }).not.toBe('live');

  // A PNG uploaded in the Media tab.
  const { png } = fixtures();
  await page.evaluate(() => {
    location.hash = '#/library/media';
  });
  await page.locator('input[type=file]').first().setInputFiles(png);
  await expect
    .poll(
      async () => {
        const all = (await (await api.get('media')).json()) as { name: string; state: string }[];
        return all.find((m) => m.name === 'bg')?.state;
      },
      { timeout: 30_000 },
    )
    .toBe('ready');

  // A General setting.
  await page.evaluate(() => {
    location.hash = '#/settings/general';
  });
  const venue = page.getByLabel('Venue name');
  await expect(venue).toBeVisible({ timeout: 15_000 });
  await venue.fill('Phones on');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(async () => ((await (await api.get('settings/general')).json()) as { venueName: string }).venueName)
    .toBe('Phones on');

  // Sign out.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('input.pin')).toBeVisible({ timeout: 15_000 });

  const codes = (await Promise.all(refused)).filter((c) => c && /x_ordo_required|origin/.test(c));
  expect(codes, 'no venue PC write was refused for a missing x-ordo or its origin').toEqual([]);
  // The switch is what makes the header needed: a write without it is refused now.
  const bare = await fetch(`http://localhost:${PORT}/api/v1/presentations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: (await api.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    },
    body: JSON.stringify({ title: 'x', kind: 'song', sections: [], arrangements: [], meta: { tags: [] } }),
  });
  expect(bare.status).toBe(403);
  expect(((await bare.json()) as { error: { code: string } }).error.code).toBe('x_ordo_required');
});
