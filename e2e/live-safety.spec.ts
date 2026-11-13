import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import {
  goLive,
  json,
  OP,
  operatorApi,
  SONG,
  fixtures,
  openRoleWindow,
  outputs,
  uploadMedia,
  waitCacheReady,
} from './helpers.ts';
import { login, launchOutputs, outputPages } from './linkhelpers.ts';

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

/** The background an output has actually drawn (its renderer's held background key), '' for none. */
async function backgroundOn(out: Page): Promise<string> {
  await out.bringToFront();
  return out.evaluate(
    () =>
      (window as unknown as { __ordo: { state(): { held: { live: string }[] } } }).__ordo.state().held[0]
        ?.live ?? '',
  );
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

test('Next item past a hidden first slide clears the song background and starts the countdown', async ({
  context,
  page,
}) => {
  const api = await operatorApi();
  const bg = await uploadMedia(api, fixtures().png, 'image/png', true);
  const song = await json<{ id: string }>(api.post('import/songselect', { data: { text: SONG } }));
  const full = await json<Record<string, unknown>>(api.get(`presentations/${song.id}`));
  await json(api.put(`presentations/${song.id}`, { data: { ...full, backgroundMediaId: bg.id } }));
  // A welcome deck whose title slide is hidden (as PowerPoint decks often are), with the service countdown.
  const welcome = await json<{ id: string }>(
    api.post('presentations', {
      data: {
        title: 'Welcome',
        kind: 'slides',
        sections: [
          {
            id: 'main',
            label: 'Main',
            short: 'M',
            slides: [
              { id: 'title', objects: [], hidden: true },
              { id: 'w1', objects: [] },
              { id: 'w2', objects: [] },
            ],
          },
        ],
      },
    }),
  );
  const pl = await json<{ id: string }>(
    api.post('playlists', {
      data: {
        name: `Entry ${Date.now()}`,
        items: [
          { id: 'i-song', kind: 'presentation', presentationId: song.id },
          {
            id: 'i-welcome',
            kind: 'presentation',
            presentationId: welcome.id,
            countdownTimer: { kind: 'countdownTo', timeOfDay: '23:59', label: 'Service starts in' },
          },
        ],
      },
    }),
  );
  await goLive(api, pl.id);
  const a1 = (await outputs(api)).find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
  const out = await openRoleWindow(context, a1);
  await waitCacheReady(out);

  await liveView(page);
  await page.keyboard.press('Space');
  await expect.poll(() => backgroundOn(out), { timeout: 20_000 }).toContain(bg.id);

  await page.bringToFront();
  await page.keyboard.press('PageDown');
  // The song has three slides (cues 0-2), the welcome deck's hidden title is cue 3.
  await expect.poll(async () => (await liveState(api)).live).toBe(4);
  const s = await liveState(api);
  expect(s.layers.background.content).toBeNull();
  expect(s.props.countdownTimerId).toBe('i-welcome-timer');
  await expect.poll(() => backgroundOn(out), { timeout: 20_000 }).toBe('');
  await out.close();
});

test('after a reload at the venue the operator finds its output windows again', async ({ context, page }) => {
  const api = await operatorApi();
  const before = await outputs(api);
  try {
    // Two Audience outputs, as at the venue (each on its own outN. origin).
    await json(
      api.put('settings/outputs', {
        data: before.map((o) => ({ ...o, enabled: o.kind !== 'stage' && o.hostIndex <= 2 })),
      }),
    );
    await goLive(api, await songPlaylist(api, 'Reload'));
    await liveView(page);
    const outs = await launchOutputs(page, context, 2);
    const link = page.locator('[data-fallback-link]');

    // The fallback link button.
    await page.bringToFront();
    await page.reload();
    await liveView(page);
    await expect(link).toHaveText('fallback link 0/2', { timeout: 15_000 });
    await link.click();
    await expect(link).toHaveCount(0);
    await expect(page.getByText('Re-acquired 2 output windows')).toBeVisible();
    // The same windows: none was closed, none opened.
    expect(outs.every((p) => !p.isClosed())).toBe(true);
    expect(outputPages(context)).toHaveLength(2);

    // Diagnostics' Re-acquire button.
    await page.reload();
    await liveView(page);
    await expect(link).toHaveText('fallback link 0/2', { timeout: 15_000 });
    await page.getByTitle('Diagnostics', { exact: true }).click();
    await page.getByRole('button', { name: 'Re-acquire output windows' }).click();
    await expect(page.getByText('Re-acquired 2 output windows.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(link).toHaveCount(0);
    expect(outputPages(context)).toHaveLength(2);
    for (const p of outs) await p.close();
  } finally {
    await json(api.put('settings/outputs', { data: before }));
  }
});
