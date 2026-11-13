/**
 * Fixes from the second review (docs/review-2026-11-04.md), hub side: settings reach outputs fresh (4, 21),
 * goLive from a cached copy is visible and a stalled library is reported as such (12, 13), orphaned
 * multipart temp files go (14), a slow cold boot is not a stall (19), command ids survive a restart (20),
 * a restore resets the live process's library copies (22), backups are written atomically and checked
 * (23), and the CPU pool's workers have a small heap (6).
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { newId } from '@ordo/domain';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { resetLiveCopies, restoreBackup } from '../src/backup.ts';
import type { HubConfig } from '../src/config.ts';
import { openLiveDb } from '../src/db.ts';
import { createLibraryProcess, type LibraryProcess } from '../src/libproc.ts';
import { LibraryLink, UP_WAIT_MS } from '../src/librarylink.ts';
import { LiveRejection, LiveService } from '../src/live.ts';
import { createLiveProcess, type LiveProcess } from '../src/liveproc.ts';
import { CpuPool, WorkerStartError } from '../src/pool.ts';
import { Supervisor } from '../src/supervisor.ts';
import {
  byType,
  client,
  connectWs,
  EDIT_PIN,
  login,
  OPERATE_PIN,
  sleep,
  song,
  startHub,
  type TestHub,
  tempDir,
} from './helpers.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const here = dirname(fileURLToPath(import.meta.url));
const quiet = pino({ level: 'silent' });

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _e, cb) {
      for (const l of String(chunk).split('\n')) if (l) lines.push(l);
      cb();
    },
  });
  return { log: pino({ level: 'info' }, stream), lines, has: (re: RegExp) => lines.some((l) => re.test(l)) };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

// --- items 12 and 13: goLive against a library that is down, restarting or stalled -----------------------

/** A goLive bundle with one song. */
function bundle() {
  const p = song();
  return {
    playlist: {
      id: 'pl',
      rev: 1,
      name: 'Sunday',
      items: [{ id: 'i1', kind: 'presentation', presentationId: p.id }],
    },
    presentations: { [p.id]: p },
    media: {},
    fonts: [],
    looks: [],
    general: {},
  };
}

/** A fetcher whose library can answer, hang (SIGSTOP: never answers, honours abort) or be told to 404. */
function fakeLibrary() {
  const ctl = { mode: 'ok' as 'ok' | 'stall', calls: 0, body: bundle() };
  const fetcher = (async (url: string, init?: RequestInit) => {
    ctl.calls++;
    if (ctl.mode === 'stall')
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      });
    if (String(url).includes('/internal/context'))
      return Response.json({
        settings: { outputs: [], looks: [], general: {}, audio: {}, surfaces: {} },
        fonts: [],
      });
    if (String(url).includes('/internal/golive/pl')) return Response.json(ctl.body);
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { ctl, fetcher };
}

function linkedLive() {
  const db = openLiveDb(join(tempDir(), 'live.db'));
  const lib = fakeLibrary();
  const link = new LibraryLink(db, quiet, 'secret', lib.fetcher);
  const live = new LiveService(db, link, quiet, { snapshotIntervalMs: 60_000 });
  return { link, live, ...lib };
}

describe('items 12 and 13: goLive and the library process', () => {
  it('a stalled library with no cached copy refuses with "did not answer", never "not found"', async () => {
    const { link, live, ctl } = linkedLive();
    link.setLibrary('http://library', 'up');
    ctl.mode = 'stall';
    const t0 = Date.now();
    const err = await live
      .submitQueued({ k: 'goLive', playlistId: 'pl' }, { role: 'operate' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LiveRejection);
    expect(String(err.message)).toBe('The library did not answer; try Go live again in a moment');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(live.state.mode).toBe('idle');
  });

  it('a stalled library with a cached copy goes live and says so in a degraded entry', async () => {
    const { link, live, ctl } = linkedLive();
    link.setLibrary('http://library', 'up');
    await live.submitQueued({ k: 'goLive', playlistId: 'pl' }, { role: 'operate' });
    expect(live.state.resolved?.degraded).toBeUndefined();
    await live.submitQueued({ k: 'endService', at: Date.now() }, { role: 'operate' });
    ctl.mode = 'stall';
    await live.submitQueued({ k: 'goLive', playlistId: 'pl' }, { role: 'operate' });
    expect(live.state.mode).toBe('live');
    const d = live.state.resolved?.degraded ?? [];
    expect(d).toHaveLength(1);
    expect(d[0]!.cueIndex).toBe(-1);
    expect(d[0]!.reason).toMatch(/copy of this playlist saved .* UTC\): the library did not answer/);
  });

  it('waits for a library that is merely restarting, then goes live from a fresh copy', async () => {
    const { link, live, ctl } = linkedLive();
    link.setLibrary('http://library', 'up');
    await live.submitQueued({ k: 'goLive', playlistId: 'pl' }, { role: 'operate' });
    await live.submitQueued({ k: 'endService', at: Date.now() }, { role: 'operate' });
    ctl.body.playlist.name = 'Sunday, edited';
    link.setLibrary(undefined, 'down');
    setTimeout(() => link.setLibrary('http://library', 'up'), 300);
    const t0 = Date.now();
    await live.submitQueued({ k: 'goLive', playlistId: 'pl' }, { role: 'operate' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(live.state.resolved?.playlist.name).toBe('Sunday, edited');
    expect(live.state.resolved?.degraded).toBeUndefined();
  });

  it('falls back to the cached copy (named) when the library stays down past the wait', async () => {
    const { link, live } = linkedLive();
    link.setLibrary('http://library', 'up');
    await live.submitQueued({ k: 'goLive', playlistId: 'pl' }, { role: 'operate' });
    await live.submitQueued({ k: 'endService', at: Date.now() }, { role: 'operate' });
    link.setLibrary(undefined, 'down');
    const t0 = Date.now();
    await live.submitQueued({ k: 'goLive', playlistId: 'pl' }, { role: 'operate' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(UP_WAIT_MS - 50);
    expect(live.state.resolved?.degraded?.[0]?.reason).toMatch(/the library is not running/);
    // A playlist never fetched is refused with a reason to retry.
    await expect(
      live.submitQueued({ k: 'goLive', playlistId: 'other' }, { role: 'operate' }),
    ).rejects.toThrow(/restarting; try Go live again/);
    // A library that failed for good is not waited for.
    link.setLibrary(undefined, 'failed');
    const t1 = Date.now();
    await expect(
      live.submitQueued({ k: 'goLive', playlistId: 'other' }, { role: 'operate' }),
    ).rejects.toThrow(/library has stopped/);
    expect(Date.now() - t1).toBeLessThan(200);
  });
});

// --- items 4 and 21: settings reach outputs fresh -------------------------------------------------------

describe('items 4 and 21: the live process applies settings before outputs hear of them', () => {
  let libp: LibraryProcess | undefined;
  let livep: LiveProcess | undefined;
  afterEach(async () => {
    await livep?.close();
    await libp?.close();
    livep = undefined;
    libp = undefined;
  });

  /** Both processes in this test process, wired like the supervisor does, with an IPC-like delay. */
  async function twoProcesses(ipcDelayMs: number) {
    const dir = tempDir();
    const secret = 'test-secret';
    const cfg: Partial<HubConfig> = {
      dataDir: dir,
      domain: 'localhost',
      devPin: `${OPERATE_PIN}:${EDIT_PIN}`,
      logToStdout: false,
      logLevel: 'warn',
      scheduleBackups: false,
      appsDir: join(dir, 'no-apps'),
      importRoots: [join(dir, 'import')],
      host: '127.0.0.1',
      port: 0,
      healthIntervalMs: 100,
    };
    let relay: (changes: never[], seq: number) => void = () => undefined;
    libp = await createLibraryProcess(cfg, {
      secret,
      onChanges: (changes, seq) => setTimeout(() => relay(changes as never[], seq), ipcDelayMs),
    });
    livep = await createLiveProcess(cfg, { secret, libraryUrl: libp.url });
    relay = (changes, seq) => livep?.onLibraryChanges(changes, seq);
    /** A new live process on the same data (a restart): it has seen no relayed change. */
    const restartLive = async () => {
      await livep?.close();
      livep = await createLiveProcess(cfg, { secret, libraryUrl: libp!.url });
      return livep;
    };
    return { base: livep.url, lib: libp, live: livep, restartLive };
  }

  it('PUT /settings/looks then at once GET /output/config returns the new look', async () => {
    // A slow relay: the answer to the PUT must still wait for the live process to apply the change.
    const { base } = await twoProcesses(40);
    const op = await login(base, OPERATE_PIN);
    const outs = await op.json<{ token: string; lookId: string }[]>('/settings/outputs');
    const out = client(base, '', { 'x-ordo-token': outs[0]!.token });
    for (let i = 1; i <= 3; i++) {
      const looks = await op.json<{ id: string; name: string }[]>('/settings/looks');
      const next = looks.map((l) => (l.id === outs[0]!.lookId ? { ...l, name: `Look ${i}` } : l));
      expect((await op.fetch('/settings/looks', { method: 'PUT', json: next })).status).toBe(200);
      const cfg = await out.json<{ looks: { id: string; name: string }[] }>('/output/config');
      expect(cfg.looks.find((l) => l.id === outs[0]!.lookId)?.name).toBe(`Look ${i}`);
    }
  });

  it('does not hold answers for changes made before this live process started', async () => {
    const { lib, restartLive } = await twoProcesses(0);
    lib.lib.putSetting('general', { ...lib.lib.getSetting('general'), venueName: 'Before the restart' });
    const live = await restartLive();
    const base = live.url;
    expect(lib.lib.seq()).toBeGreaterThan(0);
    // A fresh live process (as after a restart) knows the library sequence from its context copy.
    expect(live.link.context?.seq).toBe(lib.lib.seq());
    const t0 = Date.now();
    const op = await login(base, OPERATE_PIN);
    expect((await op.fetch('/auth/logout', { method: 'POST' })).status).toBeLessThan(300);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('an output that refetches on the settings delta gets the new config', async () => {
    const { base, lib } = await twoProcesses(0);
    const op = await login(base, OPERATE_PIN);
    const outs = await op.json<{ token: string; lookId: string }[]>('/settings/outputs');
    const tok = outs[0]!.token;
    const out = client(base, '', { 'x-ordo-token': tok });
    const ws = await connectWs(base, { token: tok, hello: { role: 'output' } });
    await ws.next(byType('welcome'));
    // Write in the library directly (no proxied answer to wait on): only the delta tells the output.
    const looks = lib.lib.getSetting('looks');
    lib.lib.putSetting(
      'looks',
      looks.map((l) => (l.id === outs[0]!.lookId ? { ...l, name: 'Through the delta' } : l)),
    );
    const d = await ws.next((m) => m.t === 'library.delta');
    expect(d.changes).toEqual([expect.objectContaining({ kind: 'settings', id: 'looks' })]);
    const cfg = await out.json<{ looks: { id: string; name: string }[] }>('/output/config');
    expect(cfg.looks.find((l) => l.id === outs[0]!.lookId)?.name).toBe('Through the delta');
    ws.close();
  });

  it('tells outputs to refetch when the context copy changes without a delta (library back)', async () => {
    const { base, live } = await twoProcesses(0);
    const op = await login(base, OPERATE_PIN);
    const outs = await op.json<{ token: string }[]>('/settings/outputs');
    const ws = await connectWs(base, { token: outs[0]!.token, hello: { role: 'output' } });
    await ws.next(byType('welcome'));
    // The relay was lost (the live process was restarting): change the library behind its back.
    const target = live.link.target()!;
    live.setLibrary(undefined, 'down');
    libp!.lib.putSetting('general', { ...libp!.lib.getSetting('general'), venueName: 'Behind the back' });
    live.setLibrary(target, 'up');
    const d = await ws.next((m) => m.t === 'library.delta');
    expect(d.changes).toEqual([{ kind: 'settings', id: 'general' }]);
    expect(live.link.context?.settings.general.venueName).toBe('Behind the back');
    ws.close();
  });
});

// --- item 14: orphaned multipart temp files ------------------------------------------------------------

describe('item 14: uploads/*.part without a row are removed at start', () => {
  it('removes orphans and keeps resumable uploads', async () => {
    const dir = tempDir();
    hub = await startHub({ dataDir: dir });
    const ed = await login(hub.url, EDIT_PIN);
    const up = await ed.json<{ id: string }>('/media/uploads', {
      method: 'POST',
      json: { name: 'big.mp4', size: 1000 },
    });
    await hub.cleanup();
    writeFileSync(join(dir, 'uploads', `${newId()}.part`), Buffer.alloc(4096));
    hub = await startHub({ dataDir: dir });
    expect(readdirSync(join(dir, 'uploads')).sort()).toEqual([`${up.id}.part`]);
  });
});

// --- item 19: start grace ------------------------------------------------------------------------------

describe('item 19: a slow cold boot is not a stall', () => {
  let sup: Supervisor | undefined;
  afterEach(async () => {
    await sup?.shutdown('test');
    sup = undefined;
  });
  const make = (env: Record<string, string>, extra: Partial<ConstructorParameters<typeof Supervisor>[0]>) => {
    const cap = capture();
    sup = new Supervisor({
      entry: join(here, 'fixtures/child.mjs'),
      execArgv: [],
      env: { ...process.env, ...env },
      dataDir: tempDir(),
      log: cap.log,
      restartDelaysMs: [10],
      ...extra,
    });
    return { cap, sup };
  };

  it('allows silence until ready up to the start grace, then applies the stall timeout', async () => {
    const { cap, sup: s } = make(
      { FIXTURE_SLOW_START: 'live:2500' },
      { stallMs: { live: 300 }, startGraceMs: 6000 },
    );
    await s.start();
    await until(() => s.status().every((p) => p.state === 'up'), 8000, 'both up');
    expect(s.status().find((p) => p.name === 'live')!.restarts).toBe(0);
    expect(cap.has(/killing it/)).toBe(false);
  });

  it('kills a child that stays silent past the start grace', async () => {
    const { cap, sup: s } = make(
      { FIXTURE_SLOW_START: 'live:60000' },
      { stallMs: { live: 300 }, startGraceMs: 1500 },
    );
    await s.start();
    await until(() => cap.has(/silent while starting; killing it/), 6000, 'start grace kill');
  });
});

// --- item 20: command ids survive a live restart -------------------------------------------------------

describe('item 20: recent command ids are seeded from the journal', () => {
  it('acknowledges a command re-sent after a restart with its seq instead of applying it twice', async () => {
    const dir = tempDir();
    hub = await startHub({ dataDir: dir });
    const p = hub.lib.savePresentation(song(), { create: true });
    const pl = hub.lib.playlists.insert({
      id: newId(),
      rev: 1,
      name: 'Sunday',
      items: [{ id: newId(), kind: 'presentation', presentationId: p.id }],
    });
    let op = await login(hub.url, OPERATE_PIN);
    let a = await connectWs(hub.url, { cookie: op.cookie });
    await a.next(byType('live.state'));
    a.send({ t: 'live.event', id: 'g', event: { k: 'goLive', playlistId: pl.id } });
    a.send({ t: 'live.event', id: 'n1', event: { k: 'next', at: Date.now() } });
    expect(await a.next((m) => m.t === 'live.ack' && m.id === 'n1')).toMatchObject({ seq: 2 });
    const liveBefore = hub.live.state.live;
    a.close();
    await hub.cleanup();

    hub = await startHub({ dataDir: dir });
    expect(hub.sockets.recentCommandSeq('n1')).toBe(2);
    op = await login(hub.url, OPERATE_PIN);
    a = await connectWs(hub.url, { cookie: op.cookie });
    await a.next(byType('live.state'));
    a.send({ t: 'live.event', id: 'n1', event: { k: 'next', at: Date.now() } });
    expect(await a.next((m) => m.t === 'live.ack' && m.id === 'n1')).toMatchObject({ seq: 2 });
    expect(hub.live.state.seq).toBe(2);
    expect(hub.live.state.live).toBe(liveBefore);
    a.close();
  });
});

// --- items 22 and 23: backups ---------------------------------------------------------------------------

describe('items 22 and 23: backups and restore', () => {
  it('vacuums to a temporary name, and a damaged nightly file is taken again', async () => {
    hub = await startHub({ dataDir: tempDir() });
    const dir = join(hub.dir, 'backups');
    // An interrupted run of an older hub: garbage under the real name, and a leftover partial.
    const nightly = hub.backups.nightlyFile();
    writeFileSync(nightly, 'SQLite format 3\0 but cut short');
    writeFileSync(join(dir, 'ordo-2026-01-01.db.partial'), 'x');
    const r = await hub.backups.nightly();
    expect(r.skipped).toBe(false);
    const db = new Database(nightly, { readonly: true });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
    expect(readdirSync(dir).filter((f) => f.endsWith('.partial'))).toEqual([]);
    // A good file is a done night.
    expect((await hub.backups.nightly()).skipped).toBe(true);
  });

  it('a restore clears the live process copies of the old library in live.db', async () => {
    hub = await startHub({ dataDir: tempDir() });
    const { file } = await hub.backups.run();
    const dir = hub.dir;
    await hub.cleanup();
    hub = undefined;
    const live = openLiveDb(join(dir, 'live.db'));
    const ins = live.prepare(`INSERT OR REPLACE INTO live_kv (key, json, saved_at) VALUES (?, ?, ?)`);
    ins.run('context', '{"settings":{"outputs":[]}}', 1);
    ins.run('bundles', '[]', 1);
    live.close();
    await restoreBackup(dir, file, { print: () => undefined });
    const after = new Database(join(dir, 'live.db'), { readonly: true });
    expect(after.prepare(`SELECT COUNT(*) n FROM live_kv`).get()).toEqual({ n: 0 });
    after.close();
    // No live.db: nothing to do, no error.
    resetLiveCopies(tempDir());
    expect(existsSync(join(dir, 'ordo.db'))).toBe(true);
  });
});

// --- item 6 (hub): CPU pool workers have a small heap --------------------------------------------------

describe('item 6: a runaway parse fails inside its worker', () => {
  it('fails the task with a clear message within seconds and replaces the worker', async () => {
    const pool = new CpuPool(1, pathToFileURL(join(here, 'fixtures/oom.worker.mjs')));
    try {
      const t0 = Date.now();
      const err = await pool.run('pptx', { buf: new Uint8Array(1) }).catch((e: Error) => e);
      const ms = Date.now() - t0;
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(WorkerStartError);
      expect(String(err)).toMatch(/needs more memory than an import may use \(512 MB\)/);
      expect(ms).toBeLessThan(budgetMs(20_000));
      expect(pool.stats().oom).toBe(1);
      expect(await pool.run('font', { n: 7 } as never)).toEqual({ family: 'Echo', n: 7 });
    } finally {
      await pool.close();
    }
  }, 30_000);
});
