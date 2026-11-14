import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';
import { budgetMs } from '../packages/domain/src/timing.test-util.ts';
import { SONG, waitCacheReady } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { portOf } from './ports.ts';

/**
 * A phone's uploads during a service (design/28 §5.3, §8 "Live boundary" and "Hub", §9's P0 exit): with Phones
 * on, a video a phone uploads while a service is live waits for End service (its media 'uploaded', its job
 * waiting 'service') and is processed within the grace after it; a photo is processed at once; and the live
 * output makes no config request for either (before P0 a photo upload sent it three library deltas and three
 * refetches). Missed frames are printed, and asserted only on a real GPU (ORDO_E2E_REAL_GPU=1, as outputs.spec):
 * zero missed vsync cannot be measured headless with SwiftShader, so the gate is the rehearsal service. Every
 * check is a soft expectation, so a run before P0 lists what failed. Its own hub (e2e/ports.ts row
 * 'phones-live-load'), with a 3 s grace.
 */
const PORT = portOf('phones-live-load');
const PIN = '246810';
const GRACE_MS = 3000;
const REAL_GPU = process.env.ORDO_E2E_REAL_GPU === '1';

async function json<T>(r: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await r;
  if (!res.ok()) throw new Error(`${res.url()} -> ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/** A small generated clip (ffmpeg testsrc), quick to transcode once the service has ended. */
function clip(): string {
  const dir = 'test-results/fixtures';
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/phones-load.mov`;
  execFileSync('ffmpeg', [
    ...['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6'],
    ...['-c:v', 'mpeg4', '-q:v', '3', out],
  ]);
  return out;
}
function png(): string {
  const dir = 'test-results/fixtures';
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/phones-load.png`;
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=teal:s=1280x720',
    '-frames:v',
    '1',
    out,
  ]);
  return out;
}

async function apiFor(opts: { cap?: 'light' } = {}): Promise<APIRequestContext> {
  const a = await request.newContext({
    baseURL: `http://localhost:${PORT}/api/v1/`,
    extraHTTPHeaders: { 'x-ordo': '1' },
  });
  const r = await a.post('auth/pin', { data: { pin: PIN, ...(opts.cap ? { cap: opts.cap } : {}) } });
  expect(r.ok(), await r.text()).toBe(true);
  return a;
}

type Media = { id: string; state: string; name: string };
type Job = { id: string; kind: string; state: string; waiting?: string; result?: { mediaId?: string } };

test('a phone uploads a video and a photo during a service: the video waits, the outputs never refetch', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const hub = HubProcess.fresh(PORT);
  hub.env.ORDO_PACE_GRACE_MS = String(GRACE_MS);
  await hub.start();
  const ctx = await browser.newContext();
  try {
    const op = await apiFor();
    const phonesOn = await op.put('settings/phones', { data: { enabled: true } });
    expect.soft(phonesOn.ok(), 'Phones turned on (PUT /settings/phones)').toBe(true);
    const song = await json<{ id: string }>(op.post('import/songselect', { data: { text: SONG } }));
    const pl = await json<{ id: string }>(
      op.post('playlists', {
        data: { name: 'Sunday', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
      }),
    );
    const outs = await json<{ id: string; token: string; hostIndex: number; kind: string }[]>(
      op.get('settings/outputs'),
    );
    const o = outs.find((x) => x.kind !== 'stage')!;
    const out: Page = await ctx.newPage();
    const configFetches: number[] = [];
    out.on('request', (r) => {
      if (r.url().includes('/api/v1/output/config')) configFetches.push(Date.now());
    });
    await json(op.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: pl.id } } }));
    await out.goto(
      `http://out${o.hostIndex}.localhost:${PORT}/?output=${encodeURIComponent(o.id)}&token=${encodeURIComponent(o.token)}&test=1&renderer=2d`,
    );
    await waitCacheReady(out);
    await json(op.post('live/events', { data: { id: 'n1', event: { k: 'next', at: Date.now() } } }));
    // From here to End service no config request may come from the output.
    await out.waitForTimeout(500);
    const liveFrom = Date.now();
    const before = await out.evaluate(
      () => (window as unknown as { __ordo: { telemetry(): { missed: number } } }).__ordo.telemetry().missed,
    );

    // The phone: a capped session when the hub grants caps (an older hub: an edit session, as before P0).
    const me = await json<{ caps?: string[] }>(op.get('auth/me'));
    const ph = await apiFor(me.caps?.includes('light') ? { cap: 'light' } : {});
    const photo = await json<Media>(
      ph.post('media', {
        multipart: { file: { name: 'photo.png', mimeType: 'image/png', buffer: readFileSync(png()) } },
      }),
    );
    const bytes = readFileSync(clip());
    const up = await json<{ id: string }>(
      ph.post('media/uploads', { data: { name: 'offering.mov', size: bytes.length } }),
    );
    const done = await ph.patch(`media/uploads/${up.id}`, {
      headers: { 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' },
      data: bytes,
    });
    expect(done.status()).toBe(201);
    const video = (await done.json()) as Media;

    await expect
      .poll(async () => (await json<Media>(op.get(`media/${photo.id}`))).state, { timeout: budgetMs(30_000) })
      .toBe('ready');
    // The video waits for the service for at least 10 s: uploaded, its job waiting.
    const states: string[] = [];
    for (let i = 0; i < 10; i++) {
      states.push((await json<Media>(op.get(`media/${video.id}`))).state);
      await out.waitForTimeout(1000);
    }
    expect
      .soft(states, 'the video waits for the service (uploaded every second for 10 s)')
      .toEqual(Array(10).fill('uploaded'));
    const jobs = await json<Job[]>(op.get('jobs'));
    const videoJob = jobs.find((j) => j.kind === 'media' && j.state !== 'done' && j.state !== 'failed');
    expect.soft(videoJob?.waiting, "the video's job waits for the service").toBe('service');
    const missed =
      (await out.evaluate(
        () =>
          (window as unknown as { __ordo: { telemetry(): { missed: number } } }).__ordo.telemetry().missed,
      )) - before;
    const during = configFetches.filter((t) => t >= liveFrom).length;
    expect.soft(during, 'config requests from the output during the service').toBe(0);

    const ended = Date.now();
    await json(op.post('live/events', { data: { id: 'end', event: { k: 'endService', at: Date.now() } } }));
    await expect
      .poll(async () => (await json<Media>(op.get(`media/${video.id}`))).state, {
        timeout: GRACE_MS + budgetMs(60_000),
      })
      .toBe('ready');
    const after = Date.now() - ended;
    console.log(
      `phones-live-load: output config requests during the service ${during}; missed frames ${missed}; ` +
        `video ready ${after} ms after End service (grace ${GRACE_MS} ms); states while live ${states.join(',')}`,
    );
    expect.soft(after, 'the video waited for the grace').toBeGreaterThanOrEqual(GRACE_MS);
    if (REAL_GPU) expect(missed, 'missed frames on the output while the phone uploaded').toBe(0);
  } finally {
    await ctx.close();
    hub.kill();
  }
});
