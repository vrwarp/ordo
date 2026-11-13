import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { goLive, json, OP, operatorApi, SONG } from './helpers.ts';
import { login } from './linkhelpers.ts';

/**
 * Service-safety fixes from the 2026-11-13 review, as a volunteer meets them at the venue (the e2e hub runs
 * in domain mode: op./outN. hosts): Escape that closes a dialog leaves the screens alone; entering an item
 * past a hidden first slide clears the song's background and starts the item's countdown; after a reload
 * the operator finds its output windows again; pre-service music that is gone does not stop Go live.
 */

type LiveState = {
  mode: string;
  live?: number;
  layers: { slide: { content: unknown }; background: { content: { mediaId: string } | null } };
  props: { countdownTimerId?: string };
};
const liveState = async (api: APIRequestContext) => (await json<{ state: LiveState }>(api.get('live'))).state;

async function songPlaylist(api: APIRequestContext, name: string): Promise<string> {
  const song = await json<{ id: string }>(api.post('import/songselect', { data: { text: SONG } }));
  const pl = await json<{ id: string }>(
    api.post('playlists', {
      data: {
        name: `${name} ${Date.now()}`,
        items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }],
      },
    }),
  );
  return pl.id;
}

async function liveView(page: Page): Promise<void> {
  await login(page, OP);
  await page.evaluate(() => {
    location.hash = '#/live';
  });
  await expect(page.getByText('First line of verse one').first()).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });

test('Escape closes Diagnostics and a confirmation and leaves the slide on the screens', async ({ page }) => {
  const api = await operatorApi();
  await goLive(api, await songPlaylist(api, 'Escape'));
  await liveView(page);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await liveState(api)).layers.slide.content !== null).toBe(true);

  const dialog = page.getByRole('dialog');
  await page.getByTitle('Diagnostics', { exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: 'End service' }).click();
  await expect(dialog).toContainText('Clear every output');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Long enough for a Clear slide to have reached the hub.
  await page.waitForTimeout(1000);
  const s = await liveState(api);
  expect(s.mode).toBe('live');
  expect(s.layers.slide.content).not.toBeNull();

  // Without a dialog, Escape is Clear slide on this screen, as before.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await liveState(api)).layers.slide.content).toBeNull();
});
