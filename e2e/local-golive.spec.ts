import { expect, type Page, test } from '@playwright/test';
import { fixtures, SONG, uploadMedia } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { busOf, cueOn, go, hubApi, login, outputPages } from './linkhelpers.ts';
import { PNG } from './png.ts';

/**
 * Going live without the hub (design/17 "Going live without the hub"): the NAS is down before the service.
 * The volunteer downloaded the playlist for offline use beforehand; with the hub gone, Go live asks and
 * runs the service from the operator PC. The hub coming back mid-service is not given the service and is
 * not followed by the outputs; End service hands the authority back to it.
 * Port 8860 (ORDO_E2E_LOCAL_PORT overrides).
 */
const PORT = Number(process.env.ORDO_E2E_LOCAL_PORT ?? 8860);
const op = `http://op.localhost:${PORT}`;

type Px = { r: number; g: number; b: number };

/** A pixel near the top of the 16:9 picture: the song's background, away from the lyric. */
async function backgroundPixel(p: Page): Promise<Px> {
  await p.bringToFront();
  const [x, y] = await p.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pw = Math.min(w, (h * 16) / 9);
    const ph = (pw * 9) / 16;
    return [Math.floor(w / 2), Math.floor((h - ph) / 2 + ph * 0.06)];
  });
  return PNG.firstPixel(await p.screenshot({ clip: { x: x!, y: y!, width: 4, height: 4 } }));
}

async function hubText(page: Page): Promise<string> {
  return ((await page.locator('[data-hub-status]').first().textContent()) ?? '').trim();
}

test('the hub is down before the service: go live from the PC, keep it when the hub returns, hand back after End service', async ({
  context,
  page,
}) => {
  test.setTimeout(240_000);
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    // ---- The week before: a song with a picture background in a playlist; one audience output.
    const a = await hubApi(PORT);
    const fx = fixtures();
    const bg = await uploadMedia(a, fx.png, 'image/png', true);
    const song = await (await a.post('import/songselect', { data: { text: SONG } })).json();
    const full = await (await a.get(`presentations/${song.id}`)).json();
    expect(
      (await a.put(`presentations/${song.id}`, { data: { ...full, backgroundMediaId: bg.id } })).ok(),
    ).toBe(true);
    const outs = (await (await a.get('settings/outputs')).json()) as { hostIndex: number; kind: string }[];
    const one = outs.map((o) => ({ ...o, enabled: o.kind !== 'stage' && o.hostIndex === 1 }));
    expect((await a.put('settings/outputs', { data: one })).ok()).toBe(true);
    const pl = await (
      await a.post('playlists', {
        data: { name: 'Sunday', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
      })
    ).json();

    await login(page, op);
    // The output window is open (it was launched on arrival, as every Sunday).
    await page.getByRole('button', { name: 'Launch outputs' }).click();
    await expect.poll(() => outputPages(context).length, { timeout: 20_000 }).toBe(1);
    const out = outputPages(context)[0]!;
    await expect.poll(() => busOf(out), { timeout: 20_000 }).toBe('hub');

    // ---- Download the playlist for offline use, while the hub is up.
    await page.bringToFront();
    await page.evaluate((id) => {
      location.hash = `#/playlists/${id}`;
    }, pl.id);
    const control = page.locator('[data-offline-control]');
    await expect(control).toBeVisible();
    await control.locator('[data-offline-download]').click();
    await expect(control.locator('[data-offline-status="green"]')).toBeVisible({ timeout: 30_000 });
    await expect(control).toContainText('Ready offline');

    // ---- Sunday morning: the hub is gone.
    hub.kill();
    // The download button needs the hub: disabled once the operator notices it is gone.
    await expect(control.locator('[data-offline-download]')).toBeDisabled({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Go live', exact: true }).click();
    const dialog = page.locator('.dialog', { hasText: 'Go live without the hub?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-offline-ready]')).toBeVisible({ timeout: 15_000 });
    await dialog.locator('[data-local-go-live]').click();
    await expect
      .poll(() => hubText(page), { timeout: 15_000 })
      .toMatch(/Live from this PC \(hub unreachable\)/);

    // The output follows the operator over the direct link and draws the downloaded background.
    await expect.poll(() => busOf(out), { timeout: 20_000 }).toBe('fallback');
    await go(page);
    await expect.poll(() => cueOn(out), { timeout: 20_000 }).toBe(0);
    await expect
      .poll(
        async () => {
          const px = await backgroundPixel(out);
          return px.r + px.g + px.b;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(40);
    const ref = await backgroundPixel(out);

    // ---- The hub comes back mid-service: it is not given the service, and the output does not follow it.
    await hub.start();
    await expect
      .poll(() => hubText(page), { timeout: 30_000 })
      .toMatch(/Live from this PC \(hub back; takes over after End service\)/);
    const a2 = await hubApi(PORT);
    const hubState = async () => (await (await a2.get('live')).json()).state as { mode: string };
    expect((await hubState()).mode).toBe('idle');
    await go(page);
    await expect.poll(() => cueOn(out), { timeout: 15_000 }).toBe(1);
    // Give a hub that wanted to take over every chance to: nothing changes.
    await page.waitForTimeout(4000);
    expect(await cueOn(out)).toBe(1);
    expect(await busOf(out)).toBe('fallback');
    expect((await hubState()).mode).toBe('idle');
    const px = await backgroundPixel(out);
    expect(Math.abs(px.r - ref.r) + Math.abs(px.g - ref.g) + Math.abs(px.b - ref.b)).toBeLessThan(40);

    // ---- End service: the authority returns to the hub and the output follows it again.
    await page.bringToFront();
    await page.getByRole('button', { name: 'End service' }).click();
    await page.locator('.backdrop button', { hasText: 'End service' }).click();
    await expect.poll(() => hubText(page), { timeout: 20_000 }).toBe('Hub');
    await expect.poll(() => busOf(out), { timeout: 20_000 }).toBe('hub');
    await expect.poll(() => cueOn(out), { timeout: 15_000 }).toBe(null);
    expect((await hubState()).mode).toBe('idle');

    // The next service goes through the hub as always.
    await page.evaluate((id) => {
      location.hash = `#/playlists/${id}`;
    }, pl.id);
    await page.getByRole('button', { name: 'Go live', exact: true }).click();
    await expect.poll(async () => (await hubState()).mode, { timeout: 20_000 }).toBe('live');
    await expect(page.locator('.dialog', { hasText: 'Go live without the hub?' })).toHaveCount(0);
  } finally {
    hub.kill();
  }
});

test('the PC starts with the hub already down: the pages load from their cache and the service runs from the PC', async ({
  context,
  page,
}) => {
  test.setTimeout(240_000);
  const port = PORT + 1;
  const opUrl = `http://op.localhost:${port}`;
  const hub = HubProcess.fresh(port);
  await hub.start();
  try {
    // ---- Saturday: the playlist is prepared and downloaded; the outputs ran once on this PC.
    const a = await hubApi(port);
    const fx = fixtures();
    const bg = await uploadMedia(a, fx.png, 'image/png', true);
    const song = await (await a.post('import/songselect', { data: { text: SONG } })).json();
    const full = await (await a.get(`presentations/${song.id}`)).json();
    expect(
      (await a.put(`presentations/${song.id}`, { data: { ...full, backgroundMediaId: bg.id } })).ok(),
    ).toBe(true);
    const outs = (await (await a.get('settings/outputs')).json()) as { hostIndex: number; kind: string }[];
    const one = outs.map((o) => ({ ...o, enabled: o.kind !== 'stage' && o.hostIndex === 1 }));
    expect((await a.put('settings/outputs', { data: one })).ok()).toBe(true);
    const pl = await (
      await a.post('playlists', {
        data: { name: 'Sunday', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
      })
    ).json();
    await login(page, opUrl);
    await page.getByRole('button', { name: 'Launch outputs' }).click();
    await expect.poll(() => outputPages(context).length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => busOf(outputPages(context)[0]!), { timeout: 20_000 }).toBe('hub');
    await page.bringToFront();
    await page.evaluate((id) => {
      location.hash = `#/playlists/${id}`;
    }, pl.id);
    await page.locator('[data-offline-download]').click();
    await expect(page.locator('[data-offline-status="green"]')).toBeVisible({ timeout: 30_000 });
    // The service workers have the app shells (they install on first load).
    await expect
      .poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active), {
        timeout: 20_000,
      })
      .toBe(true);
    for (const p of outputPages(context)) await p.close();

    // ---- Sunday: the NAS is dead; the PC is switched on and Chrome opens the operator page.
    hub.kill();
    await page.goto(`${opUrl}/#/playlists/${pl.id}`);
    // Served by the operator's service worker; the library comes from this PC's copy.
    await expect(page.getByRole('button', { name: 'Go live', exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Go live', exact: true }).click();
    const dialog = page.locator('.dialog', { hasText: 'Go live without the hub?' });
    await expect(dialog.locator('[data-offline-ready]')).toBeVisible({ timeout: 20_000 });
    await dialog.locator('[data-local-go-live]').click();
    await expect.poll(() => hubText(page), { timeout: 15_000 }).toMatch(/Live from this PC/);

    // Launch outputs: the windows load from their own cache and follow the operator.
    await page.getByRole('button', { name: 'Launch outputs' }).click();
    await expect.poll(() => outputPages(context).length, { timeout: 30_000 }).toBe(1);
    const out = outputPages(context)[0]!;
    await expect.poll(() => busOf(out).catch(() => ''), { timeout: 30_000 }).toBe('fallback');
    await go(page);
    await expect.poll(() => cueOn(out).catch(() => null), { timeout: 20_000 }).toBe(0);
    await expect
      .poll(
        async () => {
          const px = await backgroundPixel(out);
          return px.r + px.g + px.b;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(40);
  } finally {
    hub.kill();
  }
});
