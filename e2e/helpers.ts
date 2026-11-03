import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { type APIRequestContext, type BrowserContext, type Page, expect, request } from '@playwright/test';

export const PORT = Number(process.env.ORDO_E2E_PORT ?? 8090);
export const PIN = '246810';
export const OP = `http://op.localhost:${PORT}`;
export const outUrl = (k: number) => `http://out${k}.localhost:${PORT}`;
export const STAGE = `http://stage.localhost:${PORT}`;

export type OutputRec = {
  id: string;
  name: string;
  kind: string;
  hostIndex: number;
  lookId: string;
  token?: string;
  enabled: boolean;
};

/** An authenticated API client on the operator origin. */
export async function operatorApi(): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL: `http://localhost:${PORT}/api/v1/` });
  const r = await api.post('auth/pin', { data: { pin: PIN } });
  expect(r.ok(), await r.text()).toBe(true);
  return api;
}

export async function json<T>(p: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const r = await p;
  if (!r.ok()) throw new Error(`${r.url()} -> ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

/** Generate small media fixtures once with ffmpeg. */
export function fixtures(): { png: string; mp4: string } {
  const dir = 'test-results/fixtures';
  mkdirSync(dir, { recursive: true });
  const png = `${dir}/bg.png`;
  const mp4 = `${dir}/clip.mp4`;
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=navy:s=1920x1080',
    '-frames:v',
    '1',
    png,
  ]);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    mp4,
  ]);
  return { png, mp4 };
}

export async function uploadMedia(
  api: APIRequestContext,
  path: string,
  mime: string,
  isBackground = false,
): Promise<{ id: string }> {
  const m = await json<{ id: string } | { id: string }[]>(
    api.post('media', {
      multipart: {
        file: { name: path.split('/').pop()!, mimeType: mime, buffer: readFileSync(path) },
        isBackground: String(isBackground),
      },
    }),
  );
  const media = Array.isArray(m) ? m[0]! : m;
  await expect
    .poll(async () => (await json<{ state: string }>(api.get(`media/${media.id}`))).state, {
      timeout: 60_000,
    })
    .toBe('ready');
  return media;
}

export const SONG = `Amazing Test Song

Verse 1
First line of verse one
Second line of verse one

Chorus
Chorus line alpha
Chorus line beta

Verse 2
Verse two line one
Verse two line two
`;

/** Create a song, an optional media item and a playlist; returns ids. */
export async function makeService(
  api: APIRequestContext,
  opts: { backgroundId?: string; videoId?: string } = {},
) {
  const song = await json<{ id: string; rev: number }>(
    api.post('import/songselect', { data: { text: SONG } }),
  );
  if (opts.backgroundId) {
    const full = await json<Record<string, unknown> & { rev: number }>(api.get(`presentations/${song.id}`));
    await json(
      api.put(`presentations/${song.id}`, { data: { ...full, backgroundMediaId: opts.backgroundId } }),
    );
  }
  const items: unknown[] = [{ id: 'item-song', kind: 'presentation', presentationId: song.id }];
  if (opts.videoId) items.push({ id: 'item-video', kind: 'media', mediaId: opts.videoId, onEnd: 'hold' });
  const pl = await json<{ id: string }>(
    api.post('playlists', { data: { name: `E2E ${Date.now()}`, items } }),
  );
  return { songId: song.id, playlistId: pl.id };
}

export async function goLive(api: APIRequestContext, playlistId: string): Promise<void> {
  const live = await json<{ state: { mode: string } }>(api.get('live'));
  if (live.state.mode === 'live')
    await json(
      api.post('live/events', {
        data: { id: `end-${Date.now()}`, event: { k: 'endService', at: Date.now() } },
      }),
    );
  await json(
    api.post('live/events', { data: { id: `golive-${Date.now()}`, event: { k: 'goLive', playlistId } } }),
  );
}

export async function outputs(api: APIRequestContext): Promise<OutputRec[]> {
  return json<OutputRec[]>(api.get('settings/outputs'));
}

export function roleWindowUrl(o: OutputRec, extra = 'test=1&renderer=2d'): string {
  const q = `output=${encodeURIComponent(o.id)}&token=${encodeURIComponent(o.token ?? '')}&${extra}`;
  return o.kind === 'stage' ? `${STAGE}/?${q}` : `${outUrl(o.hostIndex)}/?${q}`;
}

type Telemetry = {
  presented: number;
  missed: number;
  cache?: { ready: number; total: number };
  live?: number;
  armedOk?: boolean;
  error?: string;
};

export async function telemetry(page: Page): Promise<Telemetry> {
  return page.evaluate(() =>
    (window as unknown as { __ordo: { telemetry(): Telemetry } }).__ordo.telemetry(),
  );
}

export async function waitCacheReady(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const t = await telemetry(page).catch(() => undefined);
        const mode = await page
          .evaluate(
            () => (window as unknown as { __ordo: { state(): { mode: string } } }).__ordo.state().mode,
          )
          .catch(() => '');
        return mode === 'live' && !!t?.cache && t.cache.ready >= t.cache.total;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

/** Read the test pixel the output writes at (0,0): r = cue & 255, g = cue >> 8, b = 255; black = none. */
export async function testPixelCue(page: Page): Promise<number | null> {
  // Headless Chromium pauses rAF in pages that are not in front; real outputs are always visible.
  await page.bringToFront();
  await page.waitForTimeout(100);
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  const { PNG } = await import('./png.ts');
  const px = PNG.firstPixel(buf);
  if (px.b < 200) return null;
  return px.r + (px.g << 8);
}

export async function openRoleWindow(ctx: BrowserContext, o: OutputRec, extra?: string): Promise<Page> {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${o.name}] pageerror`, e.message));
  await page.goto(roleWindowUrl(o, extra));
  return page;
}

/** The slide cue an output has actually flipped to (its renderer's held live slide key), or null. */
export async function shownSlideCue(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const st = (window as unknown as { __ordo: { state(): { held: { live: string }[] } } }).__ordo.state();
    const key = st.held[1]?.live ?? '';
    const m = /^sl\|[^|]*\|[^|]*\|(\d+)\|/.exec(key);
    return m ? Number(m[1]) : null;
  });
}
