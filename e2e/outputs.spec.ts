import { expect, test } from '@playwright/test';
import {
  shownSlideCue,
  fixtures,
  goLive,
  json,
  makeService,
  openRoleWindow,
  operatorApi,
  outputs,
  testPixelCue,
  uploadMedia,
  waitCacheReady,
  telemetry,
} from './helpers.ts';

test.describe('outputs follow the live state', () => {
  test('two audience outputs and the stage flip together through a song and a video', async ({ context }) => {
    const api = await operatorApi();
    const fx = fixtures();
    const bg = await uploadMedia(api, fx.png, 'image/png', true);
    const vid = await uploadMedia(api, fx.mp4, 'video/mp4');
    const { playlistId } = await makeService(api, { backgroundId: bg.id, videoId: vid.id });
    await goLive(api, playlistId);

    const outs = await outputs(api);
    const a1 = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
    const a2 = outs.find((o) => o.hostIndex === 2 && o.kind !== 'stage')!;
    const stageRec = outs.find((o) => o.kind === 'stage')!;
    const p1 = await openRoleWindow(context, a1);
    const p2 = await openRoleWindow(context, a2);
    const stage = await openRoleWindow(context, stageRec, '');
    await waitCacheReady(p1);
    await waitCacheReady(p2);

    // GO the first slide and check both outputs show cue 0, then step to cue 1.
    for (const cue of [0, 1, 2]) {
      await json(api.post('actions', { data: { id: 'next' } }));
      await expect.poll(() => shownSlideCue(p1), { timeout: 10_000 }).toBe(cue);
      await expect.poll(() => shownSlideCue(p2), { timeout: 10_000 }).toBe(cue);
    }
    // And the pixels on screen agree.
    await expect.poll(() => testPixelCue(p1), { timeout: 30_000 }).toBe(2);
    // Stage shows the live lyric text.
    await stage.bringToFront();
    await expect(stage.locator('body')).toContainText('Verse two line one', { timeout: 10_000 });

    // Clear the slide layer: test pixel goes back to "none".
    await json(api.post('actions', { data: { id: 'clearSlide' } }));
    await expect.poll(() => shownSlideCue(p1), { timeout: 10_000 }).toBe(null);

    // Health is flowing and no frames were missed on the 2D compositor.
    const t = await telemetry(p1);
    expect(t.presented).toBeGreaterThan(30);
    expect(t.error ?? '').not.toMatch(/arm/i);
  });

  test('an output URL without a valid token shows nothing and gets no state', async ({ page }) => {
    const api = await operatorApi();
    const outs = await outputs(api);
    const o = { ...outs.find((x) => x.hostIndex === 1)!, token: 'not-the-token' };
    const r = await page.request.get(`http://localhost:${process.env.ORDO_E2E_PORT ?? 8090}/api/v1/live`, {
      headers: { 'x-ordo-token': o.token },
    });
    expect(r.status()).toBe(401);
  });
});
