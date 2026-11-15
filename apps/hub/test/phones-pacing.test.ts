/**
 * Jobs paced while live (design/28 §3.4, §5.3, §10 items 8 and 11). With Phones on, every heavy job (a video
 * or GIF transcode, a document import, LibreOffice's pictures) waits while a service is live and for the grace
 * after End service, and its media stays 'uploaded'; a heavy job running at goLive is stopped and queued again.
 * With Phones off nothing changes for the venue PC, except that a heavy job queued during a capped (phone)
 * request waits all the same. Before P0 a video uploaded while live started transcoding at once (measured).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import { newId, type Media, type Playlist, type Presentation } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';
import { JobDeferred, JobQueue } from '../src/jobs.ts';
import { createLibraryProcess, type LibraryProcess } from '../src/libproc.ts';
import { withThreads } from '../src/media/ffmpeg.ts';
import { run } from '../src/media/tools.ts';
import { JobPacing, lightToolPace, MAX_TIMER_MS } from '../src/pacing.ts';
import { pacedScope } from '../src/reqctx.ts';
import { ffmpeg, fixtures } from './fixtures.ts';
import {
  type Client,
  EDIT_PIN,
  login,
  OPERATE_PIN,
  sleep,
  song,
  startHub,
  type TestHub,
  TEST_TOOLS,
  tempDir,
} from './helpers.ts';
import { phone, twoProcesses } from './phones-helpers.ts';

const mediaJob = (hub: TestHub, mediaId: string): Job | undefined => {
  const r = hub.db
    .prepare(
      `SELECT id FROM jobs WHERE kind = 'media' AND json_extract(payload, '$.mediaId') = ? ORDER BY created_at DESC`,
    )
    .get(mediaId) as { id: string } | undefined;
  return r ? hub.jobs.get(r.id) : undefined;
};

async function upload(c: Client, path: string, name = 'clip.mov'): Promise<Media> {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(path)]), name);
  return c.json<Media>('/media', { method: 'POST', body: fd });
}

/** A live service of a song (the venue PC's operate session). */
async function goLive(op: Client): Promise<Playlist> {
  const p = await op.json<Presentation>('/presentations', { method: 'POST', json: song() });
  const pl = await op.json<Playlist>('/playlists', {
    method: 'POST',
    json: { name: 'Sunday', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
  });
  await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
  return pl;
}
const endService = (op: Client) =>
  op.json('/live/events', { method: 'POST', json: { k: 'endService', at: Date.now() } });

describe('jobs paced while live', () => {
  let hub: TestHub | undefined;
  let lib: LibraryProcess | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await hub?.cleanup();
    await lib?.close();
    hub = undefined;
    lib = undefined;
  });

  it('Phones on: a video uploaded during a service waits (uploaded, waiting service); a photo is processed', async () => {
    hub = await startHub({ paceGraceMs: 200 });
    const op = await login(hub.url, OPERATE_PIN);
    await op.json('/settings/phones', { method: 'PUT', json: { enabled: true } });
    await goLive(op);
    const v = await upload(op, fixtures.video(hub.dir));
    const img = await upload(op, fixtures.png(hub.dir), 'photo.png');
    await sleep(1000);
    // Before P0 the transcode started at once and finished during the service.
    expect(mediaJob(hub, v.id)).toMatchObject({ state: 'queued', waiting: 'service' });
    expect(hub.lib.media.must(v.id).state).toBe('uploaded');
    await expect.poll(() => hub!.lib.media.must(img.id).state).toBe('ready');
    const t0 = Date.now();
    await endService(op);
    await expect.poll(() => hub!.lib.media.must(v.id).state, { timeout: budgetMs(30_000) }).toBe('ready');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    expect(mediaJob(hub, v.id)).not.toHaveProperty('waiting');
  });

  it('Phones on: a heavy job running at goLive is queued again, its attempt not counted, its media uploaded', async () => {
    hub = await startHub({ paceGraceMs: 200 });
    const op = await login(hub.url, OPERATE_PIN);
    await op.json('/settings/phones', { method: 'PUT', json: { enabled: true } });
    const long = ffmpeg(hub.dir, 'long.mov', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=30:duration=40',
      '-c:v',
      'mpeg4',
      '-q:v',
      '2',
    ]);
    const v = await upload(op, long, 'long.mov');
    await expect
      .poll(() => hub!.lib.media.must(v.id).state, { timeout: budgetMs(10_000) })
      .toBe('processing');
    const job = mediaJob(hub, v.id)!;
    await goLive(op);
    await expect.poll(() => hub!.jobs.get(job.id).state, { timeout: budgetMs(10_000) }).toBe('queued');
    expect(hub.jobs.get(job.id).waiting).toBe('service');
    expect(hub.jobs.attempts(job.id)).toBe(0);
    expect(hub.lib.media.must(v.id).state).toBe('uploaded');
    expect(hub.jobs.get(job.id).log.join('\n')).toMatch(/stopped for the service/);
  });

  it('Phones off: a full session’s video starts at once, a phone’s waits (multipart and resumable)', async () => {
    hub = await startHub({ paceGraceMs: 200 });
    const op = await login(hub.url, OPERATE_PIN);
    const ph = await phone(hub.url);
    await goLive(op);
    const full = await upload(op, fixtures.video(hub.dir));
    const fromPhone = await upload(ph, fixtures.video(hub.dir), 'phone.mov');
    const big = readFileSync(fixtures.video(hub.dir));
    const created = await ph.json<{ id: string }>('/media/uploads', {
      method: 'POST',
      json: { name: 'resumable.mov', size: big.length },
    });
    const done = await ph.fetch(`/media/uploads/${created.id}`, {
      method: 'PATCH',
      headers: { 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' },
      body: big,
    });
    expect(done.status).toBe(201);
    const resumable = (await done.json()) as Media;
    await expect.poll(() => hub!.lib.media.must(full.id).state, { timeout: budgetMs(30_000) }).toBe('ready');
    for (const m of [fromPhone, resumable]) {
      expect(mediaJob(hub, m.id)).toMatchObject({ state: 'queued', waiting: 'service' });
      expect(hub.lib.media.must(m.id).state).toBe('uploaded');
      expect(hub.jobs.paced(mediaJob(hub, m.id)!.id)).toBe(true);
    }
    await endService(op);
    await expect
      .poll(() => hub!.lib.media.must(resumable.id).state, { timeout: budgetMs(30_000) })
      .toBe('ready');
  });

  it('Phones off: a phone’s save of a deck still waiting for LibreOffice leaves its follow-up held while live', async () => {
    hub = await startHub({ paceGraceMs: 200 });
    const op = await login(hub.url, OPERATE_PIN);
    const ph = await phone(hub.url, EDIT_PIN);
    const tmp = join(hub.dir, 'deck.pptx');
    writeFileSync(tmp, Buffer.from('PK\u0003\u0004 not really a deck'));
    const file = await hub.store.put(tmp, {
      ext: 'pptx',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    const s = song('Deck');
    s.kind = 'slides';
    s.source = {
      kind: 'pptx',
      fileId: file.hash,
      native: { version: 1, slides: 1, native: 0, hybrid: 1, picture: 0 },
    };
    s.sections[0]!.slides[0]!.pptx = {
      fileId: file.hash,
      index: 0,
      class: 'hybrid',
      version: 1,
      pending: true,
    };
    // Stored as an import leaves it, without its follow-up queued (it was lost, or finished elsewhere).
    const deck = hub.lib.savePresentation(s, { create: true });
    await goLive(op);
    const res = await ph.fetch(`/presentations/${deck.id}`, {
      method: 'PUT',
      json: { ...deck, title: 'Deck (fixed)' },
    });
    expect(res.status).toBe(200);
    const lo = hub.jobs.list().find((j) => j.kind === 'pptx-lo');
    // Before P0 the follow-up was queued and ran at once, LibreOffice during the service.
    expect(lo).toMatchObject({ state: 'queued', waiting: 'service' });
    await sleep(500);
    expect(hub.jobs.get(lo!.id).state).toBe('queued');
  });

  it('Phones off: a phone’s audio upload while live runs its tools at nice 19 on one thread; the venue PC’s does not', async () => {
    // Before: a light job's tools looked only at the switch, so a phone's long WAV ran ffmpeg at nice 0 with
    // every thread during the service (review of P0: "those a phone queued whatever the switch says").
    hub = await startHub({ paceGraceMs: 200 });
    const op = await login(hub.url, OPERATE_PIN);
    const ph = await phone(hub.url);
    await goLive(op);
    const pacing = hub.jobs.pacing!;
    const nice = vi.spyOn(pacing, 'childNice');
    const threads = vi.spyOn(pacing, 'lightThreads');
    const fromPhone = await upload(ph, fixtures.wav(hub.dir), 'phone.wav');
    await expect
      .poll(() => hub!.lib.media.must(fromPhone.id).state, { timeout: budgetMs(30_000) })
      .toBe('ready');
    expect(nice.mock.results.map((r) => r.value)).toEqual([19]);
    expect(threads.mock.results.map((r) => r.value)).toEqual([1]);
    nice.mockClear();
    threads.mockClear();
    const fromPc = await upload(op, fixtures.wav(hub.dir), 'pc.wav');
    await expect
      .poll(() => hub!.lib.media.must(fromPc.id).state, { timeout: budgetMs(30_000) })
      .toBe('ready');
    expect(nice.mock.results.map((r) => r.value)).toEqual([0]);
    expect(threads.mock.results.map((r) => r.value)).toEqual([undefined]);
  });

  it('a pump started inside a capped request never marks the jobs another session’s job queues', async () => {
    hub = await startHub({ jobs: { heavy: 1, light: 1 } });
    let first = true;
    hub.jobs.register('parent', async () => {
      if (first) {
        first = false;
        throw new JobDeferred(24 * 3600_000, 'later');
      }
      hub!.jobs.enqueue('child', {}, 'heavy');
    });
    hub.jobs.register('child', async () => undefined);
    const parent = hub.jobs.enqueue('parent', {}, 'light');
    await expect.poll(() => hub!.jobs.deferred().length).toBe(1);
    // A capped request's continuation pumps the queue: the full session's job runs in its own scope.
    pacedScope.run(true, () => hub!.jobs.undefer(parent.id));
    await expect.poll(() => hub!.jobs.list().find((j) => j.kind === 'child')?.state).toBe('done');
    const child = hub.jobs.list().find((j) => j.kind === 'child')!;
    expect(hub.jobs.paced(parent.id)).toBe(false);
    expect(hub.db.prepare(`SELECT 1 FROM job_paced WHERE job_id = ?`).get(child.id)).toBeUndefined();
    // A job queued by a capped request passes its flag to the jobs it queues.
    let marked: boolean | undefined;
    hub.jobs.register('capped-parent', async () => {
      const c = hub!.jobs.enqueue('child', {}, 'heavy');
      marked = hub!.jobs.paced(c.id);
    });
    pacedScope.run(true, () => hub!.jobs.enqueue('capped-parent', {}, 'light'));
    await expect.poll(() => marked).toBe(true);
  });

  it('Phones off during a service, 25 held phone jobs do not starve a full session’s heavy job', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    hub.jobs.register('heavy-probe', async () => undefined);
    await goLive(op);
    for (let i = 0; i < 25; i++) pacedScope.run(true, () => hub!.jobs.enqueue('heavy-probe', { i }, 'heavy'));
    const free = hub.jobs.enqueue('heavy-probe', { i: 'venue' }, 'heavy');
    await expect.poll(() => hub!.jobs.get(free.id).state).toBe('done');
    expect(hub.jobs.list().filter((j) => j.kind === 'heavy-probe' && j.state === 'queued')).toHaveLength(25);
  });

  it('while live with held jobs: no timer at all, never one longer than Node keeps, no pump spin', async () => {
    hub = await startHub({ paceGraceMs: 2 ** 40 });
    const op = await login(hub.url, OPERATE_PIN);
    await op.json('/settings/phones', { method: 'PUT', json: { enabled: true } });
    hub.jobs.register('heavy-probe', async () => undefined);
    await goLive(op);
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => {
      delays.push(ms ?? 0);
      return real(fn, ms, ...a);
    }) as typeof setTimeout);
    const pump = vi.spyOn(hub.jobs as unknown as { pump(): void }, 'pump');
    for (let i = 0; i < 3; i++) hub.jobs.enqueue('heavy-probe', { i }, 'heavy');
    await sleep(1000);
    expect(pump.mock.calls.length).toBeLessThan(5);
    expect(delays.every((d) => d <= MAX_TIMER_MS)).toBe(true);
    // After End service the wake is set within what a timer can hold, never Infinity.
    await endService(op);
    await sleep(100);
    expect(delays.every((d) => Number.isFinite(d) && d <= MAX_TIMER_MS)).toBe(true);
    expect(pump.mock.calls.length).toBeLessThan(10);
  });

  it('a library restarted during a service keeps an interrupted heavy job held (initialLocks)', async () => {
    const dir = tempDir();
    const cfg = {
      dataDir: dir,
      logToStdout: false,
      logLevel: 'warn',
      scheduleBackups: false,
      toolProbe: TEST_TOOLS,
      paceGraceMs: 100,
    };
    lib = await createLibraryProcess(cfg, { secret: 's' });
    lib.lib.putSetting('phones', { enabled: true });
    const now = new Date().toISOString();
    lib.db
      .prepare(
        `INSERT INTO jobs (id, kind, class, state, progress, payload, log, created_at, updated_at) VALUES ('j1', 'media', 'heavy', 'running', 0.4, '{"mediaId":"gone"}', '[]', ?, ?)`,
      )
      .run(now, now);
    await lib.close();
    lib = await createLibraryProcess(cfg, {
      secret: 's',
      initialLocks: { t: 'locks', mode: 'live', presentations: [], media: [], fonts: [] },
    });
    await sleep(300);
    // Before P0 the library relaunched it at start (here it finds its media gone and is done).
    expect(lib.db.prepare(`SELECT state FROM jobs WHERE id = 'j1'`).get()).toEqual({ state: 'queued' });
    // What reaches clients: the job waits for the service.
    expect(lib.jobs.get('j1')).toMatchObject({ state: 'queued', waiting: 'service' });
    lib.setLocks({ t: 'locks', mode: 'idle', presentations: [], media: [], fonts: [] });
    await expect
      .poll(
        () => (lib!.db.prepare(`SELECT state FROM jobs WHERE id = 'j1'`).get() as { state: string }).state,
        {
          timeout: budgetMs(10_000),
        },
      )
      .toBe('done');
  });
});

describe('light tools while live', () => {
  it.skipIf(process.platform !== 'linux')('run() with nice 19 starts the tool at niceness 19', async () => {
    const r = await run('cat', ['/proc/self/stat'], { timeoutMs: budgetMs(5000), nice: 19 });
    const fields = r.stdout.slice(r.stdout.lastIndexOf(')') + 2).split(' ');
    // Field 19 of /proc/<pid>/stat is the niceness; the slice starts at field 3.
    expect(Number(fields[19 - 3])).toBe(19);
    const plain = await run('cat', ['/proc/self/stat'], { timeoutMs: budgetMs(5000) });
    expect(Number(plain.stdout.slice(plain.stdout.lastIndexOf(')') + 2).split(' ')[16])).toBeLessThan(19);
  });

  it('a light job’s ffmpeg gets one thread and niceness 19 only while live with Phones on', () => {
    const p = new JobPacing({ graceMs: 100 });
    expect(lightToolPace(p)).toEqual({});
    p.onMode('live');
    expect(lightToolPace(p)).toEqual({});
    p.setEnabled(true);
    expect(lightToolPace(p)).toEqual({ nice: 19, threads: 1 });
    expect(lightToolPace(undefined)).toEqual({});
    // A job a phone queued (paced) gets them while live whatever the switch says, and never outside a service.
    p.setEnabled(false);
    expect(lightToolPace(p)).toEqual({});
    expect(lightToolPace(p, true)).toEqual({ nice: 19, threads: 1 });
    p.onMode('idle');
    expect(lightToolPace(p, true)).toEqual({});
    expect(withThreads(['-i', 'in.png', '-vf', 'scale=1', 'out.png'], 1)).toEqual([
      '-i',
      'in.png',
      '-vf',
      'scale=1',
      '-threads',
      '1',
      'out.png',
    ]);
    expect(withThreads(['-i', 'a', 'b'], undefined)).toEqual(['-i', 'a', 'b']);
  });
});

/**
 * The first AsyncLocalStorage.run turns on promise tracking for the whole Node 22 process, for good. Measured in
 * the review of P0: one phone's GET /live/summary made the live process's GO and read cost about 2x (+108 % to
 * +158 % CPU), and a promise-heavy loop 4x slower; the live process queues no jobs, so the scope did nothing
 * there. It now stays out of the live process, and a hub with no phone never enters it.
 */
describe('the paced scope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a phone polling the live process (/live/summary, /auth/me, /health) never enters it; its library request does', async () => {
    const two = await twoProcesses();
    try {
      const ph = await phone(two.base);
      const run = vi.spyOn(pacedScope, 'run');
      for (const path of ['/live/summary', '/auth/me', '/health', '/live/summary'])
        expect((await ph.fetch(path)).status, path).toBe(200);
      expect(run).not.toHaveBeenCalled();
      // The proxied library request is what queues a phone's jobs: it still runs inside the scope.
      expect((await ph.fetch('/library/snapshot')).status).toBe(200);
      expect(run).toHaveBeenCalledWith(true, expect.any(Function));
    } finally {
      await two.close();
    }
  });

  it('a hub with no phone runs its jobs outside it; a phone’s job and what it queues run inside it', async () => {
    const hub = await startHub();
    try {
      const run = vi.spyOn(pacedScope, 'run');
      let childPaced: boolean | undefined;
      hub.jobs.register('probe', async () => undefined);
      hub.jobs.register('parent', async () => {
        childPaced = hub.jobs.paced(hub.jobs.enqueue('probe', {}, 'light').id);
      });
      hub.jobs.enqueue('probe', {}, 'light');
      hub.jobs.enqueue('parent', {}, 'light');
      await expect.poll(() => childPaced).toBe(false);
      await hub.jobs.idle();
      expect(run).not.toHaveBeenCalled();
      childPaced = undefined;
      const queued = pacedScope.run(true, () => hub.jobs.enqueue('parent', {}, 'light'));
      run.mockClear();
      await expect.poll(() => childPaced).toBe(true);
      await hub.jobs.idle();
      expect(hub.jobs.get(queued.id).state).toBe('done');
      expect(run).toHaveBeenCalledWith(true, expect.any(Function));
    } finally {
      await hub.cleanup();
    }
  });
});

/**
 * goLive and End service tell clients only about jobs whose `waiting` changes, in one library change (review of
 * P0: with Phones off and no phone, 29 queued heavy jobs gave 29 notifications at goLive and 29 more at End
 * service, each its own library delta to every session socket; d0f49cb sent none).
 */
describe('job notifications at goLive and End service', () => {
  const queue = (enabled: boolean) => {
    const db = openDb(join(tempDir(), 'ordo.db'));
    const one: string[] = [];
    const batches: Job[][] = [];
    const jobs = new JobQueue(db, pino({ level: 'silent' }), { heavy: 1, light: 1 }, (j) => one.push(j.id), {
      pacing: new JobPacing({ graceMs: 0, enabled }),
      notifyMany: (all) => batches.push(all),
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    jobs.register('heavy-probe', () => gate);
    jobs.start();
    for (let i = 0; i < 30; i++) jobs.enqueue('heavy-probe', { i }, 'heavy');
    return { jobs, one, batches, release, db };
  };

  it('Phones off, no phone: nothing is sent', async () => {
    const q = queue(false);
    await sleep(50);
    const before = q.one.length;
    q.jobs.onLiveMode('live');
    q.jobs.onLiveMode('idle');
    expect(q.one.length - before).toBe(0);
    expect(q.batches).toEqual([]);
    q.release();
    await q.jobs.stop();
    q.db.close();
  });

  it('Phones on: one change at goLive with the 29 queued jobs waiting, one at End service without', async () => {
    const q = queue(true);
    await sleep(50);
    const before = q.one.length;
    // The running job is stopped and queued again by pause(): its own update says it waits.
    q.jobs.onLiveMode('live');
    expect(q.batches).toHaveLength(1);
    expect(q.batches[0]!.length).toBe(29);
    expect(q.batches[0]!.every((j) => j.waiting === 'service')).toBe(true);
    // Nothing changed: nothing sent.
    q.jobs.setPhones(true);
    q.jobs.repump();
    expect(q.batches).toHaveLength(1);
    q.jobs.onLiveMode('idle');
    expect(q.batches).toHaveLength(2);
    expect(q.batches[1]!.every((j) => j.waiting === undefined)).toBe(true);
    expect(q.batches[1]!.length).toBeGreaterThanOrEqual(29);
    expect(q.one.length - before).toBeLessThanOrEqual(4);
    q.release();
    await q.jobs.stop();
    q.db.close();
  });
});
