/**
 * Soak test (docs/design/23-testing.md): goes live with a playlist, opens every enabled output window on
 * this machine, presses GO every N seconds for M minutes, samples each output's telemetry every second,
 * and writes soak-<date>.json and .md. Exit code 1 on failure.
 *
 *   pnpm soak --hub http://localhost:8080 --pin 123456 --playlist "Sunday" --minutes 60
 *
 * Run it on the presentation PC with a real GPU (headed, the default). --headless is for smoke runs.
 *
 * The rehearsal with phones (design/28 §5.3, §9): `--phones N` signs in N phones as the P0 compact client does
 * (a capped session where the hub grants caps; GET /library/snapshot once; one socket with hello edit, which
 * gets the stripped library delta; GET /live/summary every 8 s); `--upload-video MB` has the first phone upload
 * a generated video of that size by the resumable API during the service, `--upload-photo` a photo. The report
 * says whether the video waited for the service, how many config requests the outputs made meanwhile (none may),
 * and how many phone requests were refused.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, chromium, type Page, request } from 'playwright';
import {
  type PhonesSummary,
  phonesPass,
  type Sample,
  type SoakReport,
  summarize,
  toMarkdown,
  videoWaited,
} from './report.ts';

type Args = {
  hub: string;
  pin: string;
  playlist: string;
  minutes: number;
  interval: number;
  headless: boolean;
  out: string;
  phones: number;
  uploadVideoMb?: number;
  uploadPhoto: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (k: string, d?: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const hub = get('hub', process.env.ORDO_HUB ?? 'http://localhost:8080')!;
  return {
    hub: hub.replace(/\/$/, ''),
    pin: get('pin', process.env.ORDO_PIN ?? '')!,
    playlist: get('playlist', '')!,
    minutes: Number(get('minutes', '60')),
    interval: Number(get('interval', '10')),
    headless: argv.includes('--headless'),
    out: get('out', '.')!,
    phones: Math.max(0, Math.min(200, Math.floor(Number(get('phones', '0')) || 0))),
    uploadVideoMb: get('upload-video')
      ? Math.max(1, Math.min(4096, Number(get('upload-video')) || 0))
      : undefined,
    uploadPhoto: argv.includes('--upload-photo'),
  };
}

/** A generated Matroska rawvideo of about `mb` MB (the hub's sniff reads it as video), in a temp folder. */
function makeVideo(mb: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'ordo-soak-'));
  const out = join(dir, 'soak-video.mkv');
  const frame = 640 * 360 * 1.5;
  const frames = Math.max(1, Math.ceil((mb * 1024 * 1024) / frame));
  execFileSync('ffmpeg', [
    ...['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30'],
    ...['-frames:v', String(frames), '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', out],
  ]);
  return out;
}

function makePhoto(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ordo-soak-'));
  const out = join(dir, 'soak-photo.png');
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=1920x1080',
    '-frames:v',
    '1',
    out,
  ]);
  return out;
}

type Phone = { api: APIRequestContext; ws?: WebSocket; poll?: NodeJS.Timeout };

/**
 * The phones of the rehearsal: each does what the P0 compact client does. Requests and refusals are counted;
 * `stop()` closes them.
 */
async function startPhones(
  hub: string,
  pin: string,
  n: number,
  appVersion: string,
  caps: boolean,
): Promise<{ phones: Phone[]; counts: { requests: number; refused: number }; stop(): Promise<void> }> {
  const counts = { requests: 0, refused: 0 };
  const phones: Phone[] = [];
  const count = (ok: boolean) => {
    counts.requests++;
    if (!ok) counts.refused++;
  };
  for (let i = 0; i < n; i++) {
    const api = await request.newContext({ baseURL: `${hub}/api/v1/`, extraHTTPHeaders: { 'x-ordo': '1' } });
    const signIn = await api.post('auth/pin', { data: caps ? { pin, cap: 'light' } : { pin } });
    count(signIn.ok());
    count((await api.get('library/snapshot')).ok());
    const cookie = (await api.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const Ws = WebSocket as unknown as new (
      url: string,
      init: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new Ws(`${hub.replace(/^http/, 'ws')}/ws`, { headers: { cookie, origin: hub } });
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'edit', appVersion }));
    const phone: Phone = { api, ws };
    // The Live now strip: every 8 s while the page is visible, staggered over the phones.
    setTimeout(
      () => {
        phone.poll = setInterval(() => {
          void api.get('live/summary').then(
            (r) => count(r.ok()),
            () => count(false),
          );
        }, 8000);
      },
      Math.round((i * 8000) / Math.max(1, n)),
    );
    phones.push(phone);
  }
  return {
    phones,
    counts,
    async stop() {
      for (const p of phones) {
        clearInterval(p.poll);
        p.ws?.close();
        await p.api.dispose();
      }
    },
  };
}

/** The resumable upload a phone makes (8 MB chunks); the media's id. */
async function uploadResumable(api: APIRequestContext, path: string, name: string): Promise<string> {
  const size = statSync(path).size;
  const created = await api.post('media/uploads', { data: { name, size } });
  if (!created.ok()) throw new Error(`media/uploads -> ${created.status()} ${await created.text()}`);
  const { id } = (await created.json()) as { id: string };
  const buf = readFileSync(path);
  const CHUNK = 8 * 1024 * 1024;
  for (let at = 0; at < size; at += CHUNK) {
    const r = await api.patch(`media/uploads/${id}`, {
      headers: { 'upload-offset': String(at), 'content-type': 'application/offset+octet-stream' },
      data: buf.subarray(at, Math.min(size, at + CHUNK)),
    });
    if (r.status() === 201) return ((await r.json()) as { id: string }).id;
    if (r.status() !== 204) throw new Error(`upload chunk -> ${r.status()} ${await r.text()}`);
  }
  throw new Error('the upload never completed');
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!a.pin || !a.playlist) {
    console.error(
      'usage: soak --hub <origin> --pin <operate pin> --playlist <id or name> [--minutes 60] [--interval 10] [--headless] [--phones N] [--upload-video MB] [--upload-photo]',
    );
    process.exit(2);
  }
  const browser = await chromium.launch({
    headless: a.headless,
    args: [
      '--enable-unsafe-webgpu',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  const op = await ctx.newPage();
  await op.goto(a.hub + '/');
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await op.request.fetch(`${a.hub}/api/v1${path}`, {
      method,
      data: body === undefined ? undefined : JSON.stringify(body),
      // x-ordo as every ordo client sends it (design/28 §4; needed on writes once Phones is on).
      headers: { 'x-ordo': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    if (!r.ok()) throw new Error(`${method} ${path} -> ${r.status()} ${await r.text()}`);
    const ct = r.headers()['content-type'] ?? '';
    return (ct.includes('json') ? await r.json() : undefined) as T;
  };

  await api('POST', '/auth/pin', { pin: a.pin });
  const me = await api<{ domain: string; version: string; caps?: string[] }>('GET', '/auth/me');
  const snapshot = await api<{
    playlists: { id: string; name: string }[];
    settings: {
      outputs: {
        id: string;
        name: string;
        kind: string;
        hostIndex: number;
        enabled: boolean;
        token?: string;
      }[];
    };
  }>('GET', '/library/snapshot');
  const pl = snapshot.playlists.find((p) => p.id === a.playlist || p.name === a.playlist);
  if (!pl) throw new Error(`playlist ${a.playlist} not found`);

  const live = await api<{ state: { mode: string } }>('GET', '/live');
  if (live.state.mode === 'live')
    await api('POST', '/live/events', { id: 'soak-end', event: { k: 'endService', at: Date.now() } });
  await api('POST', '/live/events', { id: 'soak-golive', event: { k: 'goLive', playlistId: pl.id } });

  const hubUrl = new URL(a.hub);
  let phonesPhase = false;
  let outputConfigFetches = 0;
  const outputs = snapshot.settings.outputs.filter((o) => o.enabled && o.kind !== 'stage' && o.token);
  const names = Object.fromEntries(outputs.map((o) => [o.id, o.name]));
  const pages: { id: string; page: Page }[] = [];
  for (const o of outputs) {
    const q = `output=${encodeURIComponent(o.id)}&token=${encodeURIComponent(o.token!)}`;
    const url = me.domain
      ? `${hubUrl.protocol}//out${o.hostIndex}.${me.domain}${hubUrl.port ? ':' + hubUrl.port : ''}/?${q}`
      : `${a.hub}/output/?${q}&out=${o.hostIndex}`;
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && console.error(`[${o.name}] ${m.text()}`));
    page.on('request', (r) => {
      if (phonesPhase && r.url().includes('/api/v1/output/config')) outputConfigFetches++;
    });
    await page.goto(url);
    pages.push({ id: o.id, page });
  }
  console.log(`opened ${pages.length} outputs; waiting for service cache…`);
  const deadline = Date.now() + 10 * 60_000;
  for (const { page } of pages) {
    await page.waitForFunction(
      () => {
        const o = (
          window as unknown as {
            __ordo?: { telemetry(): { cache?: { ready: number; total: number } }; state(): { mode: string } };
          }
        ).__ordo;
        const t = o?.telemetry();
        return o?.state().mode === 'live' && !!t?.cache && t.cache.ready >= t.cache.total;
      },
      undefined,
      { timeout: Math.max(1000, deadline - Date.now()), polling: 1000 },
    );
  }

  // The phones phase: from here to End service (design/28 §5.3).
  const caps = Array.isArray(me.caps) && me.caps.includes('light');
  const crowd = a.phones > 0 ? await startPhones(a.hub, a.pin, a.phones, me.version, caps) : undefined;
  phonesPhase = !!crowd;
  let videoId: string | undefined;
  let photoId: string | undefined;
  const videoStates: string[] = [];
  const uploader = crowd?.phones[0]?.api;
  const files: string[] = [];
  if (uploader && a.uploadPhoto) {
    const photo = makePhoto();
    files.push(photo);
    const r = await uploader.post('media', {
      multipart: { file: { name: 'soak-photo.png', mimeType: 'image/png', buffer: readFileSync(photo) } },
    });
    crowd!.counts.requests++;
    if (r.ok()) photoId = ((await r.json()) as { id: string }).id;
    else crowd!.counts.refused++;
  }
  if (uploader && a.uploadVideoMb) {
    const video = makeVideo(a.uploadVideoMb);
    files.push(video);
    console.log(`uploading a ${a.uploadVideoMb} MB video from a phone during the service`);
    videoId = await uploadResumable(uploader, video, 'soak-video.mkv').catch((e) => {
      crowd!.counts.refused++;
      console.error(`video upload failed: ${(e as Error).message}`);
      return undefined;
    });
  }

  const samples: Sample[] = [];
  const startedAt = new Date().toISOString();
  const end = Date.now() + a.minutes * 60_000;
  let gos = 0;
  let nextGo = Date.now();
  console.log(`running for ${a.minutes} minutes, GO every ${a.interval} s`);
  while (Date.now() < end) {
    if (Date.now() >= nextGo) {
      const st = await api<{ state: { live?: number; cues: unknown[] } }>('GET', '/live');
      if (st.state.live !== undefined && st.state.live >= st.state.cues.length - 1)
        await api('POST', '/live/events', {
          id: `soak-wrap-${gos}`,
          event: { k: 'go', cueIndex: 0, at: Date.now() + 50 },
        });
      else await api('POST', '/actions', { id: 'next' });
      gos++;
      nextGo += a.interval * 1000;
    }
    for (const { id, page } of pages) {
      const t = await page
        .evaluate(() =>
          (window as unknown as { __ordo?: { telemetry(): Record<string, unknown> } }).__ordo?.telemetry(),
        )
        .catch(() => undefined);
      if (!t) continue;
      const n = (k: string) => Number(t[k] ?? 0);
      samples.push({
        t: Date.now(),
        outputId: id,
        presented: n('presented'),
        missed: n('missed'),
        longTasks: n('longTasks'),
        lateFlips: n('lateFlips'),
        gpuLost: n('gpuLost'),
        videoDropped: n('videoDropped'),
        error: typeof t.error === 'string' ? t.error : undefined,
      });
    }
    if (videoId && samples.length % Math.max(1, pages.length * 5) === 0)
      videoStates.push((await api<{ state: string }>('GET', `/media/${videoId}`)).state);
    process.stdout.write(`\r${Math.ceil((end - Date.now()) / 1000)} s left, ${gos} GOs   `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('');
  phonesPhase = false;
  let phones: PhonesSummary | undefined;
  if (crowd) {
    if (videoId) videoStates.push((await api<{ state: string }>('GET', `/media/${videoId}`)).state);
    const photoState = photoId ? (await api<{ state: string }>('GET', `/media/${photoId}`)).state : undefined;
    phones = {
      phones: a.phones,
      capped: caps,
      requests: crowd.counts.requests,
      refused: crowd.counts.refused,
      outputConfigFetches,
      ...(a.uploadVideoMb
        ? {
            video: {
              mb: a.uploadVideoMb,
              waited: videoWaited(videoStates),
              states: [...new Set(videoStates)],
            },
          }
        : {}),
      ...(photoState ? { photo: { state: photoState } } : {}),
    };
    await crowd.stop();
  }
  for (const f of files) rmSync(join(f, '..'), { recursive: true, force: true });
  const summary = summarize(samples, names);
  const report: SoakReport = {
    startedAt,
    minutes: a.minutes,
    gos,
    outputs: summary,
    ...(phones ? { phones } : {}),
    pass: summary.length > 0 && summary.every((o) => o.pass) && phonesPass(phones),
  };
  const stamp = startedAt.replace(/[:.]/g, '-');
  writeFileSync(`${a.out}/soak-${stamp}.json`, JSON.stringify({ report, samples }, null, 2));
  writeFileSync(`${a.out}/soak-${stamp}.md`, toMarkdown(report));
  console.log(toMarkdown(report));
  await api('POST', '/live/events', { id: 'soak-end', event: { k: 'endService', at: Date.now() } }).catch(
    () => undefined,
  );
  await browser.close();
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
