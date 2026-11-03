import { type APIRequestContext, type BrowserContext, expect, type Page, request } from '@playwright/test';
import { SONG, shownSlideCue, waitCacheReady } from './helpers.ts';

/** Shared steps for the operator-to-output link specs (items 1, 2 and 13 of the 2026-11-03 review). */

export async function hubApi(port: number): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: `http://localhost:${port}/api/v1/` });
  expect((await ctx.post('auth/pin', { data: { pin: '246810' } })).ok()).toBe(true);
  return ctx;
}

/** A song in a playlist that is live, with only the audience outputs up to `maxHost` enabled. */
export async function liveService(a: APIRequestContext, maxHost: number): Promise<string> {
  const song = await (await a.post('import/songselect', { data: { text: SONG } })).json();
  const outs = (await (await a.get('settings/outputs')).json()) as {
    id: string;
    hostIndex: number;
    kind: string;
    enabled: boolean;
  }[];
  const settings = outs.map((o) => ({ ...o, enabled: o.kind !== 'stage' && o.hostIndex <= maxHost }));
  expect((await a.put('settings/outputs', { data: settings })).ok()).toBe(true);
  const pl = await (
    await a.post('playlists', {
      data: { name: 'Link', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
    })
  ).json();
  expect(
    (await a.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: pl.id } } })).ok(),
  ).toBe(true);
  return pl.id as string;
}

export async function hubLive(a: APIRequestContext): Promise<number | undefined> {
  return (await (await a.get('live')).json()).state.live as number | undefined;
}

export async function login(page: Page, op: string): Promise<void> {
  await page.goto(op + '/');
  const pin = page.locator('input.pin');
  const launch = page.getByRole('button', { name: 'Launch outputs' });
  await expect(pin.or(launch)).toBeVisible({ timeout: 20_000 });
  if (await pin.isVisible()) {
    await pin.fill('246810');
    await page.getByRole('button', { name: 'OK' }).click();
  }
  await expect(launch).toBeVisible({ timeout: 20_000 });
}

export function outputPages(context: BrowserContext): Page[] {
  return context.pages().filter((p) => !p.isClosed() && /\/\/out\d\.localhost/.test(p.url()));
}

/** Click Launch (or Relaunch) and wait for `n` output windows with their caches filled. */
export async function launchOutputs(
  page: Page,
  context: BrowserContext,
  n: number,
  button: 'Launch outputs' | 'Relaunch' = 'Launch outputs',
): Promise<Page[]> {
  const before = new Set(outputPages(context));
  await page.getByRole('button', { name: button }).click();
  await expect
    .poll(() => outputPages(context).filter((p) => !before.has(p)).length, { timeout: 20_000 })
    .toBe(n);
  const pages = outputPages(context).filter((p) => !before.has(p));
  for (const p of pages) await waitCacheReady(p);
  return pages;
}

export async function cueOn(p: Page): Promise<number | null> {
  await p.bringToFront();
  return shownSlideCue(p);
}

export async function expectCue(pages: Page[], cue: number, timeout = 15_000): Promise<void> {
  for (const p of pages) await expect.poll(() => cueOn(p), { timeout }).toBe(cue);
}

export async function busOf(p: Page): Promise<string> {
  return p.evaluate(() => (window as unknown as { __ordo: { state(): { bus: string } } }).__ordo.state().bus);
}

export async function go(page: Page): Promise<void> {
  await page.bringToFront();
  await page.keyboard.press('Space');
}
