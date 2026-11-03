import { expect, test, type Page } from '@playwright/test';
import { HubProcess } from './hubproc.ts';
import { SONG, shownSlideCue, waitCacheReady } from './helpers.ts';

const PORT = 8092;
const op = `http://op.localhost:${PORT}`;

test('a volunteer builds a service in the UI, goes live, launches outputs and runs it from the keyboard', async ({
  context,
  page,
}) => {
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(op + '/');
    await page.locator('input.pin').fill('246810');
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByRole('button', { name: 'Launch outputs' })).toBeVisible({ timeout: 20_000 });

    // Library: new song from pasted lyrics.
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('button', { name: 'New song' }).click();
    await page.locator('textarea').fill(SONG);
    await expect(page.getByText('3 sections, 3 slides')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Amazing Test Song').first()).toBeVisible();

    // Playlist: create, add the song, go live.
    await page.getByRole('link', { name: 'Playlists' }).click();
    await page.getByPlaceholder('New playlist name').fill('Sunday');
    await page.getByPlaceholder('New playlist name').press('Enter');
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await page.getByRole('button', { name: 'Go live' }).click();
    await expect(page.getByRole('button', { name: 'End service' })).toBeVisible({ timeout: 15_000 });

    // Live view shows the song; launch outputs.
    await page.evaluate(() => {
      location.hash = '#/live';
    });
    await expect(page.getByText('First line of verse one').first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Launch outputs' }).click();
    const outs = () => context.pages().filter((p) => !p.isClosed() && /\/\/out1\.localhost/.test(p.url()));
    await expect.poll(() => outs().length, { timeout: 20_000 }).toBe(1);
    const out1 = outs()[0]!;
    await waitCacheReady(out1);

    const cueOn = async (p: Page) => {
      await p.bringToFront();
      return shownSlideCue(p);
    };
    await page.bringToFront();
    await page.keyboard.press('Space');
    await expect.poll(() => cueOn(out1), { timeout: 15_000 }).toBe(0);
    await page.bringToFront();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => cueOn(out1), { timeout: 15_000 }).toBe(1);
    await page.bringToFront();
    await page.keyboard.press('F1');
    await expect.poll(() => cueOn(out1), { timeout: 15_000 }).toBe(null);

    // Health reaches the operator: the Audience 1 dot appears without errors.
    await page.bringToFront();
    await expect(page.getByText('Audience 1').first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    hub.kill();
  }
});
