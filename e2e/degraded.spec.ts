import { expect, request, test, type Page } from '@playwright/test';
import { HubProcess } from './hubproc.ts';
import { SONG, shownSlideCue, waitCacheReady } from './helpers.ts';

const PORT = 8091;
const op = `http://op.localhost:${PORT}`;

async function api(port: number) {
  const ctx = await request.newContext({ baseURL: `http://localhost:${port}/api/v1/` });
  expect((await ctx.post('auth/pin', { data: { pin: '246810' } })).ok()).toBe(true);
  return ctx;
}

async function cueOn(p: Page): Promise<number | null> {
  await p.bringToFront();
  return shownSlideCue(p);
}

test('the service continues through a hub outage and the hub adopts the state on return', async ({
  context,
  page,
}) => {
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    let a = await api(PORT);
    const song = await (await a.post('import/songselect', { data: { text: SONG } })).json();
    // Only Audience 1 and Audience 2 so the test stays quick.
    const outs = (await (await a.get('settings/outputs')).json()) as {
      id: string;
      hostIndex: number;
      kind: string;
      enabled: boolean;
    }[];
    const settings = outs.map((o) => ({ ...o, enabled: o.kind !== 'stage' && o.hostIndex <= 2 }));
    expect((await a.put('settings/outputs', { data: settings })).ok()).toBe(true);
    const pl = await (
      await a.post('playlists', {
        data: { name: 'Outage', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
      })
    ).json();
    expect(
      (await a.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: pl.id } } })).ok(),
    ).toBe(true);

    // Operator logs in through the UI and launches the outputs.
    await page.goto(op + '/?test=1');
    await page.locator('input.pin').fill('246810');
    await page.getByRole('button', { name: 'OK' }).click();
    const launch = page.getByRole('button', { name: 'Launch outputs' });
    await expect(launch).toBeVisible({ timeout: 20_000 });
    await launch.click();
    const outputPages = () =>
      context.pages().filter((p) => !p.isClosed() && /\/\/out\d\.localhost/.test(p.url()));
    await expect.poll(() => outputPages().length, { timeout: 20_000 }).toBe(2);
    const popups = outputPages();
    for (const p of popups) await waitCacheReady(p);

    // GO through the hub.
    await page.bringToFront();
    await page.keyboard.press('Space');
    for (const p of popups) await expect.poll(() => cueOn(p), { timeout: 15_000 }).toBe(0);

    // The hub dies. After the operator's 5 s grace it becomes the authority over postMessage.
    hub.kill();
    await page.bringToFront();
    await expect(page.locator('body')).toContainText(/fallback|offline|hub/i, { timeout: 20_000 });
    await page.waitForTimeout(7_000);
    await page.keyboard.press('Space');
    for (const p of popups) await expect.poll(() => cueOn(p), { timeout: 15_000 }).toBe(1);

    // The hub returns and adopts the operator's state without a visible change.
    await hub.start();
    a = await api(PORT);
    await expect
      .poll(async () => (await (await a.get('live')).json()).state.live, {
        timeout: 30_000,
        intervals: [100],
      })
      .toBe(1);
    for (const p of popups) expect(await cueOn(p)).toBe(1);

    // And GO works through the hub again: one press, as a volunteer presses it right after the hub has the
    // service back, moves the service exactly one cue (a GO lost in the hand-back, or applied twice, fails
    // here; the press is not repeated until it works).
    await page.bringToFront();
    await page.locator('body').focus();
    await page.keyboard.press('Space');
    const liveOnHub = async () => (await (await a.get('live')).json()).state.live as number;
    try {
      await expect.poll(liveOnHub, { timeout: 15_000 }).toBe(2);
    } finally {
      // What the operator held and logged, for a failure (the hub's own log is test-results/hub-8091.log).
      const diag = await page.evaluate(() => {
        const o = (window as unknown as { __ordo?: { live?: () => unknown; logs?: () => unknown[] } }).__ordo;
        return { live: o?.live?.(), logs: o?.logs?.().slice(-40) };
      });
      console.log(`operator after the press: ${JSON.stringify(diag)}`);
    }
    for (const p of popups) await expect.poll(() => cueOn(p), { timeout: 15_000 }).toBe(2);
    // Never more than one cue for one press.
    await page.waitForTimeout(1_500);
    expect(await liveOnHub()).toBe(2);
    for (const p of popups) expect(await cueOn(p)).toBe(2);
  } finally {
    hub.kill();
  }
});
