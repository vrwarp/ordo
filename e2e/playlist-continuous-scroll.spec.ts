import { expect, test } from '@playwright/test';
import { SONG, json } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { portOf } from './ports.ts';

const PORT = portOf('playlist-continuous-scroll');
const op = `http://op.localhost:${PORT}`;

const SONG2 = `Second Test Song

Verse 1
Line one of song two
Line two of song two

Chorus
Chorus of song two
`;

test('continuous playlist scroll: all playlist items render in order and scroll smoothly', async ({
  page,
}) => {
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    // Authenticate with Hub API
    const api = await page.request.post(`http://localhost:${PORT}/api/v1/auth/pin`, {
      data: { pin: '246810' },
    });
    expect(api.ok()).toBe(true);

    // Create two songs
    const s1 = await json<{ id: string }>(
      page.request.post(`http://localhost:${PORT}/api/v1/import/songselect`, { data: { text: SONG } }),
    );
    const s2 = await json<{ id: string }>(
      page.request.post(`http://localhost:${PORT}/api/v1/import/songselect`, { data: { text: SONG2 } }),
    );

    // Create a playlist with both songs
    const pl = await json<{ id: string }>(
      page.request.post(`http://localhost:${PORT}/api/v1/playlists`, {
        data: {
          name: 'Sunday Continuous',
          items: [
            { id: 'it-1', kind: 'presentation', presentationId: s1.id },
            { id: 'it-2', kind: 'presentation', presentationId: s2.id },
          ],
        },
      }),
    );

    // Open operator in browser and sign in
    await page.goto(`${op}/`);
    await page.locator('input.pin').fill('246810');
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByRole('button', { name: 'Launch outputs' })).toBeVisible({ timeout: 20_000 });

    // Navigate to Live view
    await page.evaluate(() => {
      location.hash = '#/live';
    });

    // Verify playlist selection in dropdown and select our playlist
    const plSelect = page.locator('select.grow');
    await expect(plSelect).toBeVisible({ timeout: 15_000 });
    await plSelect.selectOption(pl.id);

    // Verify both playlist item sections are rendered continuously in the center grid
    const item0 = page.locator('[data-playlist-item-index="0"]');
    const item1 = page.locator('[data-playlist-item-index="1"]');
    await expect(item0).toBeVisible({ timeout: 15_000 });
    await expect(item1).toBeVisible({ timeout: 15_000 });

    // Item titles are rendered in their item headers
    await expect(item0.getByText('Amazing Test Song')).toBeVisible();
    await expect(item1.getByText('Second Test Song')).toBeVisible();

    // Verify Edit links for both presentations exist
    await expect(item0.locator(`a[href="#/edit/${s1.id}"]`)).toBeVisible();
    await expect(item1.locator(`a[href="#/edit/${s2.id}"]`)).toBeVisible();

    // Clicking item 2 in the playlist pane scrolls item 2 into view
    const plItems = page.locator('.pl-item');
    await expect(plItems).toHaveCount(2);

    await plItems.nth(1).click();
    await expect(plItems.nth(1)).toHaveClass(/sel/);

    // Verify item 1 is scrolled near the top of the pane
    await page.waitForTimeout(600);
    const item1Box = await item1.boundingBox();
    expect(item1Box).not.toBeNull();
    // Item 1 top should be within visible range
    expect(item1Box!.y).toBeLessThan(300);

    // Clicking item 1 in playlist pane scrolls back to item 1
    await plItems.nth(0).click();
    await expect(plItems.nth(0)).toHaveClass(/sel/);
    await page.waitForTimeout(600);
    const item0Box = await item0.boundingBox();
    expect(item0Box).not.toBeNull();
    expect(item0Box!.y).toBeLessThan(300);

    // Manual scrolling: scrolling up or down does not snap to section tops
    const scrollPane = page.locator('[data-slide-grid-pane]');
    await scrollPane.evaluate((el) => {
      el.scrollTop = 120;
      el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(300);
    const pos1 = await scrollPane.evaluate((el) => el.scrollTop);
    expect(pos1).toBe(120);

    await scrollPane.evaluate((el) => {
      el.scrollTop = 60;
      el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(300);
    const pos2 = await scrollPane.evaluate((el) => el.scrollTop);
    expect(pos2).toBe(60);
  } finally {
    hub.kill();
  }
});
