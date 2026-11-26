import { expect, test } from '@playwright/test';
import { SONG, json } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { portOf } from './ports.ts';

const PORT = portOf('loop-navigation');
const op = `http://op.localhost:${PORT}`;

const SONG2 = `Second Loop Exit Song

Verse 1
First line of song two
Second line of song two
`;

test('loop items arm the next item, preserve custom armed slides across ticks, exit on Space, and step back to slide 1 on Prev', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    const auth = await page.request.post(`http://localhost:${PORT}/api/v1/auth/pin`, {
      data: { pin: '246810' },
    });
    expect(auth.ok()).toBe(true);

    const textStyle = {
      fontFamily: 'Inter',
      fontWeight: 600,
      fontSizePx: 72,
      color: { r: 255, g: 255, b: 255, a: 1 },
      align: 'left' as const,
      valign: 'middle' as const,
      padding: 24,
    };

    // Create a 2-slide announcement loop with mixed durations (2s default, 3s slide 2)
    const loop = await json<{ id: string }>(
      page.request.post(`http://localhost:${PORT}/api/v1/presentations`, {
        data: {
          title: 'Welcome loop',
          kind: 'loop',
          loop: { defaultSlideMs: 2000 },
          sections: [
            {
              id: 'sec-ann',
              label: 'Announcements',
              short: 'A',
              slides: [
                {
                  id: 'l1',
                  objects: [
                    {
                      id: 't1',
                      type: 'text',
                      box: { x: 100, y: 100, w: 1000, h: 200, rotation: 0 },
                      text: 'Welcome Slide One',
                      style: textStyle,
                    },
                  ],
                },
                {
                  id: 'l2',
                  durationMs: 3000,
                  objects: [
                    {
                      id: 't2',
                      type: 'text',
                      box: { x: 100, y: 100, w: 1000, h: 200, rotation: 0 },
                      text: 'Welcome Slide Two',
                      style: textStyle,
                    },
                  ],
                },
              ],
            },
          ],
          arrangements: [{ id: 'arr-default', name: 'Default', sectionIds: ['sec-ann'] }],
        },
      }),
    );

    const s1 = await json<{ id: string }>(
      page.request.post(`http://localhost:${PORT}/api/v1/import/songselect`, { data: { text: SONG } }),
    );
    const s2 = await json<{ id: string }>(
      page.request.post(`http://localhost:${PORT}/api/v1/import/songselect`, { data: { text: SONG2 } }),
    );

    const pl = await json<{ id: string }>(
      page.request.post(`http://localhost:${PORT}/api/v1/playlists`, {
        data: {
          name: 'Loop Nav Service',
          items: [
            { id: 'it-loop', kind: 'presentation', presentationId: loop.id },
            { id: 'it-s1', kind: 'presentation', presentationId: s1.id },
            { id: 'it-s2', kind: 'presentation', presentationId: s2.id },
          ],
        },
      }),
    );

    // Go live via API so we start directly in the live view
    const goLiveRes = await page.request.post(`http://localhost:${PORT}/api/v1/live/events`, {
      data: { id: `loop-nav-golive-${Date.now()}`, event: { k: 'goLive', playlistId: pl.id } },
    });
    expect(goLiveRes.ok(), await goLiveRes.text()).toBe(true);

    await page.goto(`${op}/`);
    await page.locator('input.pin').fill('246810');
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByRole('button', { name: 'End service' })).toBeVisible({ timeout: 20_000 });

    await page.evaluate(() => {
      location.hash = '#/live';
    });

    const loopItem = page.locator('[data-playlist-item-index="0"]');
    const song1Item = page.locator('[data-playlist-item-index="1"]');
    const song2Item = page.locator('[data-playlist-item-index="2"]');
    await expect(loopItem).toBeVisible({ timeout: 15_000 });

    // Off-air/header cues: range subtitle, per-slide duration tag on slide 2, wrap badge on slide 2
    await expect(loopItem).toContainText('Loop · 2–3s');
    await expect(loopItem.locator('[data-slide-duration]')).toHaveText('3s');
    await expect(loopItem.locator('[data-loop-wrap]')).toHaveCount(1);

    // Before first GO, slide 1 of the loop is armed
    const loopThumbs = loopItem.locator('.thumb');
    const song1Thumbs = song1Item.locator('.thumb');
    const song2Thumbs = song2Item.locator('.thumb');
    await expect(loopThumbs.nth(0)).toHaveClass(/armed/);

    // First Space enters loop slide 1: ON AIR + LOOPING + progress bar, and Song 1 slide 1 is immediately armed
    await page.keyboard.press('Space');
    await expect(loopThumbs.nth(0)).toHaveClass(/live/, { timeout: 10_000 });
    await expect(loopItem.locator('[data-looping-pill]')).toBeVisible();
    await expect(loopThumbs.nth(0).locator('[data-loop-progress]')).toBeVisible();
    await expect(song1Thumbs.nth(0)).toHaveClass(/armed/);

    // Auto-advance moves to loop slide 2 while keeping Song 1 slide 1 armed
    await expect(loopThumbs.nth(1)).toHaveClass(/live/, { timeout: 10_000 });
    await expect(song1Thumbs.nth(0)).toHaveClass(/armed/);

    // Single-clicking Song 2 slide 1 (Click = GO is off) pre-arms Song 2 slide 1,
    // and the next loop wrap (slide 2 -> slide 1) preserves Song 2 slide 1 as armed
    await song2Thumbs.nth(0).click();
    await expect(song2Thumbs.nth(0)).toHaveClass(/armed/, { timeout: 10_000 });
    await expect(loopThumbs.nth(0)).toHaveClass(/live/, { timeout: 10_000 });
    await expect(song2Thumbs.nth(0)).toHaveClass(/armed/);

    // Pressing Space exits the loop straight to the custom-armed Song 2 slide 1
    await page.keyboard.press('Space');
    await expect(song2Thumbs.nth(0)).toHaveClass(/live/, { timeout: 10_000 });
    await expect(loopItem.locator('[data-looping-pill]')).toHaveCount(0);

    // Jump to Song 1 slide 1, then press ArrowLeft (Prev): lands on loop slide 1 (not slide 2)
    await song1Thumbs.nth(0).dblclick();
    await expect(song1Thumbs.nth(0)).toHaveClass(/live/, { timeout: 10_000 });
    await page.keyboard.press('ArrowLeft');
    await expect(loopThumbs.nth(0)).toHaveClass(/live/, { timeout: 10_000 });

    // Pressing F1 clears the slide layer and hides LOOPING + progress bar
    await page.keyboard.press('F1');
    await expect(loopItem.locator('[data-looping-pill]')).toHaveCount(0, { timeout: 10_000 });
    await expect(loopItem.locator('[data-loop-progress]')).toHaveCount(0);

    expect(errors).toEqual([]);
  } finally {
    hub.kill();
  }
});
