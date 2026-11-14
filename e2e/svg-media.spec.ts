import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import {
  OP,
  goLive,
  json,
  makeService,
  openRoleWindow,
  operatorApi,
  outputs,
  shownSlideCue,
  waitCacheReady,
} from './helpers.ts';
import { login } from './linkhelpers.ts';
import { type Pixels, decodePng } from './png.ts';

/**
 * SVG media (design/12 "Media pipeline", design/14 "Pictures", design/21 "Uploads"; review 2026-11-13 R4,
 * R5): an SVG background draws on Audience screens as a still, whether the operator uploaded it (the operator
 * draws it into a PNG the hub keeps as its delivery) or it came from a library made before (the output draws
 * it on its main thread); an animated one shows its first frame there and moves in previews only; and an
 * uploaded SVG opened from its file link runs nothing.
 */

const ORANGE = '#ff8000';
const BLUE = '#0040ff';

/** Orange with a blue box in the middle third, declared by its viewBox only (no width or height). */
const STILL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90">
  <rect width="160" height="90" fill="${ORANGE}"/>
  <rect x="53.33" y="30" width="53.33" height="30" fill="${BLUE}"/>
</svg>`;

/** Orange at its first frame, turning blue over 6 s: a still on screens shows the orange. */
const ANIMATED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <style>@keyframes turn { from { fill: ${ORANGE} } to { fill: ${BLUE} } } rect { animation: turn 6s linear infinite alternate }</style>
  <rect width="960" height="540"/>
</svg>`;

type RGB = [number, number, number];
const isOrange = (p: RGB) => p[0] > 200 && p[1] > 90 && p[1] < 180 && p[2] < 80;
const isBlue = (p: RGB) => p[2] > 200 && p[0] < 60 && p[1] < 110;

type MediaRec = {
  id: string;
  state: string;
  width?: number;
  height?: number;
  original: { hash: string; mime: string };
  delivery?: { hash: string; mime: string };
};

async function postSvg(api: APIRequestContext, name: string, svg: string): Promise<MediaRec> {
  const m = await json<MediaRec | MediaRec[]>(
    api.post('media', {
      multipart: {
        file: { name, mimeType: 'image/svg+xml', buffer: Buffer.from(svg) },
        isBackground: 'true',
      },
    }),
  );
  const media = Array.isArray(m) ? m[0]! : m;
  await expect
    .poll(async () => (await json<MediaRec>(api.get(`media/${media.id}`))).state, { timeout: 30_000 })
    .toBe('ready');
  return json<MediaRec>(api.get(`media/${media.id}`));
}

/** A screenshot of the output (it draws only while in front). */
async function frame(p: Page): Promise<Pixels> {
  await p.bringToFront();
  await p.waitForTimeout(250);
  return decodePng(await p.screenshot());
}

/** The colour at a logical point of the 1920x1080 frame (the output fills the 16:9 viewport). */
function at(img: Pixels, lx: number, ly: number): RGB {
  const x = Math.min(img.width - 1, Math.round((lx * img.width) / 1920));
  const y = Math.min(img.height - 1, Math.round((ly * img.height) / 1080));
  const o = (y * img.width + x) * 4;
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
}

/** Go live with a song on `backgroundId`, open Audience 1 and show the song's first slide. */
async function showOnAudience(
  api: APIRequestContext,
  ctx: import('@playwright/test').BrowserContext,
  bg: string,
) {
  const { playlistId } = await makeService(api, { backgroundId: bg });
  await goLive(api, playlistId);
  const a1 = (await outputs(api)).find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
  const out = await openRoleWindow(ctx, a1);
  await waitCacheReady(out);
  await json(
    api.post('live/events', {
      data: { id: `svg-go-${Date.now()}`, event: { k: 'go', cueIndex: 0, at: Date.now() } },
    }),
  );
  await expect.poll(() => shownSlideCue(out), { timeout: 15_000 }).toBe(0);
  return out;
}

test.describe('SVG media', () => {
  test('an SVG background from an older library (no still) draws on Audience screens', async ({
    context,
  }) => {
    test.setTimeout(150_000);
    const api = await operatorApi();
    // Uploaded through the API with no PNG beside it, as every SVG was before: the hub keeps no still.
    const bg = await postSvg(api, 'Legacy wave.svg', STILL_SVG);
    expect(bg.delivery).toBeUndefined();
    const out = await showOnAudience(api, context, bg.id);
    // The output draws it on its main thread: orange around, the blue box in the middle (not the clear
    // colour of a quarantined layer).
    await expect
      .poll(
        async () => {
          const img = await frame(out);
          return [isOrange(at(img, 200, 200)), isOrange(at(img, 1700, 900)), isBlue(at(img, 960, 540))];
        },
        { timeout: 30_000 },
      )
      .toEqual([true, true, true]);
    const t = (await out.evaluate(() =>
      (window as unknown as { __ordo: { telemetry(): Record<string, unknown> } }).__ordo.telemetry(),
    )) as { error?: string };
    expect(t.error ?? '').not.toMatch(/decode|quarantin/i);
    await out.close();
  });

  test('the operator uploads an animated SVG: a still for the screens, moving in previews only', async ({
    context,
    page,
  }) => {
    test.setTimeout(150_000);
    const api = await operatorApi();
    await login(page, OP);
    await page.evaluate(() => {
      location.hash = '#/library/media';
    });
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({
        name: 'Moving wave.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(ANIMATED_SVG),
      });
    let m: MediaRec | undefined;
    await expect
      .poll(
        async () => {
          const all = await json<(MediaRec & { name: string })[]>(api.get('media'));
          m = all.find((x) => x.name === 'Moving wave');
          return m?.state;
        },
        { timeout: 30_000 },
      )
      .toBe('ready');
    // The operator drew it into a PNG at its declared size scaled to 1920 wide; the hub keeps that as the
    // file the screens draw, and the SVG as the original.
    expect(m!.original.mime).toBe('image/svg+xml');
    expect(m!.delivery?.mime).toBe('image/png');
    expect([m!.width, m!.height]).toEqual([1920, 1080]);
    // Where it is picked, the volunteer is told the screens show a still.
    await expect(page.getByText(/moves in previews only/i).first()).toBeVisible({ timeout: 10_000 });
    // The library's tile is the SVG itself (it moves there).
    await expect
      .poll(() =>
        page.evaluate(
          (hash) =>
            [...document.querySelectorAll<HTMLElement>('[style]')].some((e) =>
              e.style.background.includes(hash),
            ),
          m!.original.hash,
        ),
      )
      .toBe(true);

    const out = await showOnAudience(api, context, m!.id);
    // Its first frame (orange) fills the screen.
    await expect
      .poll(
        async () => {
          const img = await frame(out);
          return [isOrange(at(img, 300, 300)), isOrange(at(img, 960, 540)), isOrange(at(img, 1600, 900))];
        },
        { timeout: 30_000 },
      )
      .toEqual([true, true, true]);
    await out.close();
  });

  test('an uploaded SVG with a script runs nothing when its file link is opened', async ({
    context,
    page,
  }) => {
    test.setTimeout(90_000);
    const api = await operatorApi();
    // Anyone with the edit PIN can upload this; a signed-in operator then opens its link.
    const evil = await postSvg(
      api,
      'Evil.svg',
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>localStorage.setItem('ordo-svg-xss', 'ran'); document.title = 'xss';</script><rect width="10" height="10" fill="red"/></svg>`,
    );
    await login(page, OP);
    const url = `${OP}/api/v1/files/${evil.original.hash}`;
    const tab = await context.newPage();
    const download = tab.waitForEvent('download', { timeout: 10_000 }).catch(() => undefined);
    await tab.goto(url).catch(() => undefined);
    await download;
    await tab.waitForTimeout(500);
    expect(await tab.title().catch(() => '')).not.toBe('xss');
    await tab.close();
    expect(await page.evaluate(() => localStorage.getItem('ordo-svg-xss'))).toBeNull();
    // It downloads, and an API response is a sandboxed document with nothing allowed besides.
    const res = await api.get(`files/${evil.original.hash}`);
    expect(res.ok()).toBe(true);
    expect(res.headers()['content-disposition']).toMatch(/^attachment/);
    expect(res.headers()['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers()['content-security-policy']).toMatch(/sandbox/);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');

    // The same file still shows as a picture where the operator uses it.
    const shown = await page.evaluate(async (u) => {
      const img = new Image();
      img.src = u;
      await img.decode();
      return img.naturalWidth;
    }, url);
    expect(shown).toBe(10);
  });
});
