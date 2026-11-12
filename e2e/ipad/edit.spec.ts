import { devices, expect, request, test } from '@playwright/test';
import {
  BASE,
  EDIT_PIN,
  SONG,
  json,
  previewImages,
  previewsSettled,
  shot,
  signInByTapping,
  startHub,
  thumbsRendered,
} from './ipadhelpers.ts';

/**
 * iPad editing (design/15 "iPad editing", prd/03): the worship lead builds a service from home on an
 * iPad. Runs in WebKit with the iPad Pro 11 descriptor (projects webkit-ipad and webkit-ipad-portrait).
 */

type Pres = {
  id: string;
  rev: number;
  title: string;
  sections: { slides: { id: string; objects: { id: string; type: string; text?: string }[] }[] }[];
};
type Playlist = { id: string; name: string; items: { presentationId?: string; arrangementId?: string }[] };

test('the worship lead builds a service on the iPad: search, new song, edit, previews, playlist', async ({
  page,
}) => {
  const { hub, api, url } = await startHub(BASE + 1);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await json(
      api.post('import/songselect', {
        data: { text: 'Morning Hymn\n\nVerse 1\nWake the dawn\nSing the light\n' },
      }),
    );
    await signInByTapping(page, url);

    // The edit profile: no live view, no Launch outputs, no checklist, no output settings.
    await expect(page.locator('nav[data-profile="edit"]')).toBeVisible();
    const caps = await page.evaluate(
      () => (window as unknown as { __ordo: { capabilities: Record<string, unknown> } }).__ordo.capabilities,
    );
    expect(caps).toMatchObject({
      deviceProfile: 'edit',
      hid: false,
      windowManagement: false,
      coarsePointer: true,
    });
    await expect(page.getByRole('link', { name: /Live/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Checklist' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Launch outputs' })).toHaveCount(0);
    await page.evaluate(() => {
      location.hash = '#/live';
    });
    await expect(page).toHaveURL(/#\/library$/);
    await page.evaluate(() => {
      location.hash = '#/settings/outputs';
    });
    await expect(page).toHaveURL(/#\/library$/);
    await page.getByRole('link', { name: 'Settings' }).tap();
    for (const hidden of ['Outputs', 'Audio', 'Keyboard', 'Stream Deck', 'MIDI', 'Backups', 'Diagnostics'])
      await expect(page.getByRole('link', { name: hidden, exact: true })).toHaveCount(0);
    await shot(page, 'settings');

    // Search the library.
    await page.getByRole('link', { name: 'Library' }).tap();
    const search = page.getByPlaceholder(/Search .*presentations/);
    await search.tap();
    await search.fill('dawn');
    await expect(page.getByText('Morning Hymn').first()).toBeVisible();
    await shot(page, 'library-search');
    await search.fill('');

    // A new song from pasted lyrics, opened in the editor.
    await page.getByRole('button', { name: 'New song' }).tap();
    await page.locator('textarea').fill(SONG);
    await expect(page.getByText('3 sections, 3 slides')).toBeVisible();
    await shot(page, 'new-song');
    await page.getByRole('button', { name: 'Save and edit' }).tap();
    await expect(page).toHaveURL(/#\/edit\//, { timeout: 15_000 });
    const songId = decodeURIComponent(/#\/edit\/([^/?]+)/.exec(page.url())![1]!);

    // Change the first slide's text: tap the lyric on the canvas, then type in the object panel.
    const canvas = page.locator('.page canvas').first();
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    const box = (await canvas.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    const text = page.locator('#ordo-text-editor');
    await expect(text).toBeVisible({ timeout: 10_000 });
    await text.fill('Edited on the iPad\nSecond tablet line');
    await shot(page, 'editor');
    await page.getByRole('button', { name: 'Save', exact: true }).tap();
    await expect
      .poll(async () => {
        const p = await json<Pres>(api.get(`presentations/${songId}`));
        return p.sections[0]?.slides[0]?.objects.find((o) => o.type === 'text')?.text;
      })
      .toBe('Edited on the iPad\nSecond tablet line');

    // The edit shows in the look previews (the strip labels come from the saved text).
    await page.getByRole('link', { name: 'Previews' }).tap();
    await page.getByRole('link', { name: 'Tablet Test Song' }).tap();
    await expect(page.getByRole('button', { name: /Slide 1: Edited on the iPad/ })).toBeVisible();
    await previewsSettled(page);
    await shot(page, 'previews-edited');

    // A new playlist with the song in one of its arrangements; no Go live on this device.
    await page.getByRole('link', { name: 'Playlists' }).tap();
    await page.getByPlaceholder('New playlist name').fill('iPad Sunday');
    await page.getByRole('button', { name: '+', exact: true }).tap();
    await expect(page.locator('[data-go-live-note]')).toHaveText('Go live from the venue PC.');
    await expect(page.getByRole('button', { name: 'Go live' })).toHaveCount(0);
    const songRow = page
      .getByText('Tablet Test Song', { exact: true })
      .locator('xpath=ancestor::*[.//select[@title="Arrangement"]][1]');
    const arrangement = songRow.locator('select[title="Arrangement"]').first();
    await expect(arrangement).toBeVisible({ timeout: 15_000 });
    const song = await json<Pres & { arrangements: { id: string; name: string }[] }>(
      api.get(`presentations/${songId}`),
    );
    expect(song.arrangements.length).toBeGreaterThan(0);
    await arrangement.selectOption(song.arrangements[0]!.id);
    await shot(page, 'playlist');
    await expect
      .poll(
        async () => {
          const all = await json<Playlist[]>(api.get('playlists'));
          const pl = all.find((p) => p.name === 'iPad Sunday');
          return pl?.items.map((it) => `${it.presentationId}:${it.arrangementId}`) ?? [];
        },
        { timeout: 15_000 },
      )
      .toEqual([`${songId}:${song.arrangements[0]!.id}`]);
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
    hub.kill();
  }
});

test('the previews page shows a slide in four looks and follows text changes', async ({ page }) => {
  const { hub, api, url } = await startHub(BASE + 2);
  try {
    const song = await json<{ id: string }>(api.post('import/songselect', { data: { text: SONG } }));
    await signInByTapping(page, url);
    await page.getByRole('link', { name: 'Previews' }).tap();
    await page.getByRole('link', { name: 'Tablet Test Song' }).tap();
    await previewsSettled(page);
    await expect(page.locator('[data-look-preview] figcaption')).toHaveText([
      /Main/,
      /Lobby \/ overflow/,
      /Livestream \(key\)/,
      /Stage/,
    ]);
    const before = await previewImages(page);
    expect(Object.keys(before).sort()).toEqual(['lowerThird', 'main', 'stage', 'stream']);
    for (const src of Object.values(before)) expect(src).toMatch(/^blob:/);

    // The stream look is keyed: its corner is the key green.
    const corner = await page
      .locator('[data-look-preview="stream"] img')
      .evaluate(async (img: HTMLImageElement) => {
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const x = c.getContext('2d')!;
        x.drawImage(img, 0, 0);
        return Array.from(x.getImageData(4, 4, 1, 1).data);
      });
    expect(corner[1]).toBeGreaterThan(200);
    expect(corner[0]).toBeLessThan(60);
    await shot(page, 'previews');

    // The text changes (saved from another device): every look re-renders.
    const full = await json<Pres>(api.get(`presentations/${song.id}`));
    const slide = full.sections[0]!.slides[0]!;
    const textObj = slide.objects.find((o) => o.type === 'text')!;
    textObj.text = 'A brand new first line\nAnd a second';
    await json(api.put(`presentations/${song.id}`, { data: full }));
    await expect(page.getByRole('button', { name: /Slide 1: A brand new first line/ })).toBeVisible({
      timeout: 15_000,
    });
    // Every look re-renders (after the ~150 ms debounce).
    const changed = async (from: Record<string, string>) => {
      await expect
        .poll(async () => {
          const now = await previewImages(page);
          return Object.keys(from)
            .filter((k) => now[k] && now[k] !== from[k])
            .sort();
        })
        .toEqual(Object.keys(from).sort());
      await previewsSettled(page);
      return previewImages(page);
    };
    const after = await changed(before);

    // Another slide from the strip.
    await page.getByRole('button', { name: /Slide 2: Chorus line alpha/ }).tap();
    await expect(page).toHaveURL(/#\/previews\/[^/]+\/[^/]+$/);
    await changed(after);
    await shot(page, 'previews-chorus');
  } finally {
    await api.dispose();
    hub.kill();
  }
});

test('with a service live, an iPad signed in with the EDIT PIN sees the live chip and the lock', async ({
  page,
}) => {
  const { hub, api, url } = await startHub(BASE + 3);
  try {
    const song = await json<{ id: string }>(api.post('import/songselect', { data: { text: SONG } }));
    const pl = await json<{ id: string }>(
      api.post('playlists', {
        data: {
          name: 'Sunday at the venue',
          items: [{ id: 'item-song', kind: 'presentation', presentationId: song.id }],
        },
      }),
    );
    await json(
      api.post('live/events', {
        data: { id: `golive-${Date.now()}`, event: { k: 'goLive', playlistId: pl.id } },
      }),
    );
    // The edit PIN: GET /live is refused, the live summary (GET /live/summary) is not.
    await signInByTapping(page, url, EDIT_PIN);
    await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expect(page.locator('[data-live-chip]')).toContainText('Live now: Sunday at the venue', {
      timeout: 15_000,
    });
    await shot(page, 'live-chip');

    // The editor is locked for the live presentation, before any save is attempted, in the edit wording.
    await page.evaluate((id) => {
      location.hash = `#/edit/${id}`;
    }, song.id);
    await expect(page.locator('[data-locked-banner]')).toHaveText(
      'This presentation is in the playlist that is live at the venue. It can be edited again after the service.',
      { timeout: 15_000 },
    );
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^Add/ })).toBeDisabled();
    // The slide thumbnails render in the worker ~100-200 ms after the editor opens (whether or not it is
    // read-only): wait for all of them before the screenshot.
    await thumbsRendered(page, 3);
    await shot(page, 'editor-locked');

    // The live playlist: no Go live and no operator view on this device.
    await page.getByRole('link', { name: 'Playlists' }).tap();
    await page.getByRole('link', { name: /Sunday at the venue/ }).tap();
    await expect(
      page.getByText(/It and its presentations can be edited again after the service/),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go live' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open operator view' })).toHaveCount(0);

    // The hub still refuses an edit to the live presentation (423), whatever the device.
    const full = await json<Pres>(api.get(`presentations/${song.id}`));
    const r = await api.put(`presentations/${song.id}`, { data: { ...full, title: 'Changed' } });
    expect(r.status()).toBe(423);
  } finally {
    await api.dispose();
    hub.kill();
  }
});

test('a library Safari cleared reloads from the hub, and the core reconnects after a suspension', async ({
  browser,
  page,
}) => {
  const { hub, api, url } = await startHub(BASE + 4);
  try {
    await json(api.post('import/songselect', { data: { text: SONG } }));
    await signInByTapping(page, url);
    await expect(page.getByText('Tablet Test Song').first()).toBeVisible();
    // The edit profile asked for persistent storage (Safari may refuse; the flag is only kept on a grant).
    await expect
      .poll(() =>
        page.evaluate(
          () => !!(window as unknown as { __ordo: { persistence?: unknown } }).__ordo.persistence,
        ),
      )
      .toBe(true);

    // Suspension: the page is hidden while the hub goes away (the socket dies with it), then shown again.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    hub.kill();
    await page.waitForTimeout(2000);
    await hub.start();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // A song saved elsewhere arrives over the reconnected socket (a library delta), without a reload.
    const api2 = await request.newContext({ baseURL: `${url}api/v1/` });
    await api2.post('auth/pin', { data: { pin: '246810' } });
    await json(api2.post('import/songselect', { data: { text: 'After Resume\n\nVerse 1\nBack again\n' } }));
    await expect(page.getByText('After Resume').first()).toBeVisible({ timeout: 20_000 });
    await api2.dispose();

    // Safari evicted the IndexedDB copy: a fresh context with the same sign-in (cookies) and no IndexedDB.
    const state = await page.context().storageState();
    const portrait = test.info().project.name.includes('portrait');
    const ctx2 = await browser.newContext({
      ...devices[portrait ? 'iPad Pro 11' : 'iPad Pro 11 landscape'],
      storageState: state,
    });
    const page2 = await ctx2.newPage();
    await page2.goto(url);
    await expect(page2.getByText('Tablet Test Song').first()).toBeVisible({ timeout: 20_000 });
    await expect(page2.getByText('After Resume').first()).toBeVisible();
    await ctx2.close();
  } finally {
    await api.dispose();
    hub.kill();
  }
});
