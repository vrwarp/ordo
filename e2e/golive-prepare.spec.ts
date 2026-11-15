/**
 * Going live prepared beside the running service (design/29 §2.3 M8; W41, W58).
 *
 * Row 0: during a service, Go live again while the library sends its copy slowly (e2e/slow-library.mjs, 12 s):
 * a GO pressed meanwhile applies to the running service at once and flips on time (no late flip), the
 * operator's toast shows the progress, and after 5 s offers the saved copy, which goes live at once and says
 * so. Row 1: a service past the size ceiling (32 MiB) is refused with W58's words.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';
import { SONG, shownSlideCue, waitCacheReady } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { portOf } from './ports.ts';

async function api(port: number): Promise<APIRequestContext> {
  const ctx = await request.newContext({
    baseURL: `http://localhost:${port}/api/v1/`,
    extraHTTPHeaders: { 'x-ordo': '1' },
  });
  expect((await ctx.post('auth/pin', { data: { pin: '246810' } })).ok()).toBe(true);
  return ctx;
}

/** A song and a playlist of it named `name`. */
async function playlistOf(a: APIRequestContext, name: string): Promise<{ id: string; songId: string }> {
  const song = (await (await a.post('import/songselect', { data: { text: SONG } })).json()) as { id: string };
  const pl = (await (
    await a.post('playlists', {
      data: { name, items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
    })
  ).json()) as { id: string };
  return { id: pl.id, songId: song.id };
}

async function event(a: APIRequestContext, ev: Record<string, unknown>): Promise<void> {
  const r = await a.post('live/events', {
    data: { id: `${ev.k}-${Date.now()}-${Math.random()}`, event: ev },
  });
  expect(r.ok(), await r.text()).toBe(true);
}

type HubLive = {
  live?: number;
  resolved?: { playlist: { id: string; name: string }; degraded?: { reason: string }[] };
};
const hubLive = async (a: APIRequestContext) =>
  ((await (await a.get('live')).json()) as { state: HubLive }).state;

async function signIn(page: Page, port: number): Promise<void> {
  await page.goto(`http://op.localhost:${port}/?test=1`);
  await page.locator('input.pin').fill('246810');
  await page.getByRole('button', { name: 'OK' }).click();
}

/** Only Audience 1, so the test stays quick. */
async function oneAudience(a: APIRequestContext): Promise<void> {
  const outs = (await (await a.get('settings/outputs')).json()) as { kind: string; hostIndex: number }[];
  const settings = outs.map((o) => ({ ...o, enabled: o.kind !== 'stage' && o.hostIndex === 1 }));
  expect((await a.put('settings/outputs', { data: settings })).ok()).toBe(true);
}

const lateFlips = (p: Page) =>
  p.evaluate(() =>
    Number(
      (window as unknown as { __ordo: { telemetry(): { lateFlips?: number } } }).__ordo.telemetry()
        .lateFlips ?? 0,
    ),
  );

test('Go live again during a service with a slow library: GO flips on time, the toast shows progress, then the saved copy', async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  const port = portOf('golive-prepare', 0);
  const hub = HubProcess.fresh(port);
  const flag = resolve(`${hub.dataDir}.slow`);
  rmSync(flag, { force: true });
  hub.env.NODE_OPTIONS = `--import ${pathToFileURL(resolve('e2e/slow-library.mjs')).href}`;
  hub.env.ORDO_E2E_SLOW_GOLIVE_FLAG = flag;
  hub.env.ORDO_E2E_SLOW_GOLIVE_MS = '12000';
  await hub.start();
  try {
    const a = await api(port);
    await oneAudience(a);
    const first = await playlistOf(a, 'First service');
    const sunday = await playlistOf(a, 'Sunday service');
    // Sunday service was live before, so the hub has a saved copy of it (the one W41 offers).
    await event(a, { k: 'goLive', playlistId: sunday.id });
    await event(a, { k: 'endService', at: Date.now() });
    await event(a, { k: 'goLive', playlistId: first.id });

    await signIn(page, port);
    const launch = page.getByRole('button', { name: 'Launch outputs' });
    await expect(launch).toBeVisible({ timeout: 20_000 });
    await launch.click();
    const outputs = () =>
      context.pages().filter((p) => !p.isClosed() && /\/\/out\d\.localhost/.test(p.url()));
    await expect.poll(() => outputs().length, { timeout: 20_000 }).toBe(1);
    const out = outputs()[0]!;
    await waitCacheReady(out);
    const cueOn = async () => {
      await out.bringToFront();
      return shownSlideCue(out);
    };
    await page.bringToFront();
    await page.keyboard.press('Space');
    await expect.poll(cueOn, { timeout: 15_000 }).toBe(0);
    const late = await lateFlips(out);

    // From here the library sends goLive copies over 12 s; the operator presses Go live again.
    writeFileSync(flag, '1');
    await page.bringToFront();
    await page.evaluate(
      (id) => (window as unknown as { __ordo: { ctl: { goLive(id: string): void } } }).__ordo.ctl.goLive(id),
      sunday.id,
    );
    await page.waitForTimeout(300);

    // A GO meanwhile applies to the running service at once and flips on time.
    await page.locator('body').focus();
    const t0 = Date.now();
    await page.keyboard.press('Space');
    await expect.poll(async () => (await hubLive(a)).live, { timeout: 5_000, intervals: [20] }).toBe(1);
    const goMs = Date.now() - t0;
    console.log(`GO during the slow Go live: applied on the hub after ${goMs} ms`);
    expect((await hubLive(a)).resolved?.playlist.id).toBe(first.id);
    expect(goMs).toBeLessThan(1000);
    await expect.poll(cueOn, { timeout: 10_000 }).toBe(1);
    expect(await lateFlips(out)).toBe(late);

    // The toast says what is being prepared, while the screens keep the running service.
    await page.bringToFront();
    const toast = page.locator('[data-golive-prepare]');
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(
      /^Getting 'Sunday service' ready to go live \(\d+ %\)\. The screens keep showing the current service until then\./,
    );
    // The progress moves while the copy arrives.
    await expect
      .poll(async () => Number(await toast.getAttribute('data-golive-prepare')), { timeout: 10_000 })
      .toBeGreaterThan(0);
    // After 5 s, while live, the saved copy is offered; it goes live at once and says so.
    const saved = page.locator('[data-golive-saved]');
    await expect(saved).toBeVisible({ timeout: 10_000 });
    await expect(saved).toHaveText(/^Go live from the copy saved \d+ (s|min) ago$/);
    const t1 = Date.now();
    await saved.click();
    await expect
      .poll(async () => (await hubLive(a)).resolved?.playlist.id, { timeout: 5_000, intervals: [50] })
      .toBe(sunday.id);
    console.log(`Go live from the saved copy: live on the hub after ${Date.now() - t1} ms`);
    expect((await hubLive(a)).resolved?.degraded?.[0]?.reason).toMatch(
      /^Went live from the copy of this playlist saved/,
    );
    await expect(toast).toBeHidden({ timeout: 5_000 });
  } finally {
    hub.kill();
    rmSync(flag, { force: true });
  }
});

test('a service past the size ceiling is refused with W58', async ({ page }) => {
  test.setTimeout(180_000);
  const port = portOf('golive-prepare', 1);
  const hub = HubProcess.fresh(port);
  await hub.start();
  try {
    const a = await api(port);
    // 12 presentations of about 3 MiB (200 slides of 16,000 characters): a service of about 37 MiB.
    const items: unknown[] = [];
    for (let i = 0; i < 12; i++) {
      const song = (await (await a.post('import/songselect', { data: { text: SONG } })).json()) as {
        id: string;
      };
      const full = (await (await a.get(`presentations/${song.id}`)).json()) as {
        sections: { slides: { id: string; objects: { type: string; text?: string }[] }[] }[];
      } & Record<string, unknown>;
      const slide = full.sections[0]!.slides[0]!;
      const slides = Array.from({ length: 200 }, (_, k) => ({
        ...slide,
        id: `${slide.id}-${k}`,
        objects: slide.objects.map((o) =>
          o.type === 'text' ? { ...o, text: `${k} ${'x'.repeat(16_000)}` } : o,
        ),
      }));
      const big = { ...full, sections: [{ ...full.sections[0]!, slides }], arrangements: [] };
      const r = await a.put(`presentations/${song.id}`, { data: big });
      expect(r.ok(), await r.text()).toBe(true);
      items.push({ id: `i${i}`, kind: 'presentation', presentationId: song.id });
    }
    const pl = (await (await a.post('playlists', { data: { name: 'Too large', items } })).json()) as {
      id: string;
    };

    await signIn(page, port);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __ordo?: { live?: () => { hubConnected: boolean } } }).__ordo?.live?.()
                .hubConnected ?? false,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    await page.evaluate(
      (id) => (window as unknown as { __ordo: { ctl: { goLive(id: string): void } } }).__ordo.ctl.goLive(id),
      pl.id,
    );
    const dialog = page.locator('.dialog', { hasText: 'Could not go live' });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog).toContainText(
      /This service is too large to go live \(3[6-9] MB\)\. Split the longest presentations into smaller ones\./,
    );
    expect((await hubLive(a)).resolved).toBeUndefined();
  } finally {
    hub.kill();
  }
});
