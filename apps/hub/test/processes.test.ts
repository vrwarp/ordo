/**
 * Phase D (design/25 "Hub"): the supervisor, the proxy between the two processes, the CPU pool, and the
 * real two-process hub started from source (kill the library, kill the live process).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newId } from '@ordo/domain';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { HEADER_INTERNAL } from '../src/http.ts';
import { liveFiles, proxied } from '../src/liveproc.ts';
import { CpuPool, WorkerStartError } from '../src/pool.ts';
import { createProxy, forwardHeaders } from '../src/proxy.ts';
import { Supervisor } from '../src/supervisor.ts';
import { client, login, sleep, song, tempDir } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));

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
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('supervisor', () => {
  let sup: Supervisor | undefined;
  afterEach(async () => {
    await sup?.shutdown('test');
    sup = undefined;
  });
  const make = (
    env: Record<string, string>,
    extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {},
  ) => {
    const cap = capture();
    const dataDir = tempDir();
    sup = new Supervisor({
      entry: join(here, 'fixtures/child.mjs'),
      execArgv: [],
      env: { ...process.env, ...env },
      dataDir,
      log: cap.log,
      restartDelaysMs: [10],
      ...extra,
    });
    return { cap, dataDir, sup };
  };

  it('starts library then live, relays addresses and locks, and writes supervisor.json', async () => {
    const { cap, dataDir, sup: s } = make({ FIXTURE_LOCKS: '1' });
    await s.start();
    await until(() => s.status().every((p) => p.state === 'up'), 5000, 'both up');
    await until(() => cap.has(/"child":"library".*"msg":"locks pl-1"/), 3000, 'locks relayed to library');
    await until(
      () => cap.has(/"child":"live".*"msg":"library up http:\/\/127.0.0.1:1\/library/),
      3000,
      'library url relayed',
    );
    const file = JSON.parse(readFileSync(join(dataDir, 'supervisor.json'), 'utf8')) as {
      pid: number;
      processes: { name: string; pid: number; state: string }[];
    };
    expect(file.pid).toBe(process.pid);
    expect(file.processes.map((p) => [p.name, p.state])).toEqual([
      ['library', 'up'],
      ['live', 'up'],
    ]);
    expect(file.processes.every((p) => typeof p.pid === 'number')).toBe(true);
  });

  it('restarts a crashing child within its budget, then leaves it down and reports', async () => {
    const gaveUp: string[] = [];
    const { cap, sup: s } = make(
      { FIXTURE_CRASH: 'library' },
      { budget: { max: 3, windowMs: 60_000 }, onGiveUp: (n) => gaveUp.push(n) },
    );
    await s.start();
    await until(() => gaveUp.length > 0, 8000, 'give up');
    expect(gaveUp).toEqual(['library']);
    const lib = s.status().find((p) => p.name === 'library')!;
    expect(lib).toMatchObject({ state: 'failed', restarts: 3, recentCrashes: 4 });
    expect(cap.has(/restart budget exhausted/)).toBe(true);
    // The live process keeps running and was told.
    expect(s.status().find((p) => p.name === 'live')!.state).toBe('up');
    await until(() => cap.has(/"child":"live".*"msg":"library failed/), 3000, 'live told');
  });

  it('kills and restarts a child whose heartbeat stops', async () => {
    const { cap, sup: s } = make({ FIXTURE_STALL: 'live' }, { stallMs: { live: 300 } });
    await s.start();
    await until(() => (s.status().find((p) => p.name === 'live')?.restarts ?? 0) >= 1, 6000, 'restart');
    expect(cap.has(/child process stalled; killing it/)).toBe(true);
  });

  it('stops both children on shutdown', async () => {
    const { sup: s } = make({});
    await s.start();
    await until(() => s.status().every((p) => p.state === 'up'), 5000, 'both up');
    const pids = s.status().map((p) => p.pid!);
    await s.shutdown('test');
    expect(s.status().map((p) => p.state)).toEqual(['stopped', 'stopped']);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe('proxy and routing between the processes', () => {
  let upstream: Server | undefined;
  afterEach(() => upstream?.close());

  it('routes the live API, known files and everything else', () => {
    const known = (h: string) => h === 'a'.repeat(64);
    expect(proxied('GET', '/api/v1/live', known)).toBe(false);
    expect(proxied('GET', '/api/v1/live/summary', known)).toBe(false);
    expect(proxied('POST', '/api/v1/live/events', known)).toBe(false);
    expect(proxied('GET', '/api/v1/health?x=1', known)).toBe(false);
    expect(proxied('GET', '/api/v1/output/config', known)).toBe(false);
    expect(proxied('GET', `/api/v1/files/${'a'.repeat(64)}`, known)).toBe(false);
    expect(proxied('GET', `/api/v1/files/${'b'.repeat(64)}`, known)).toBe(true);
    expect(proxied('POST', '/api/v1/presentations', known)).toBe(true);
    expect(proxied('GET', '/api/v1/live/../presentations', known)).toBe(true);
    expect(proxied('GET', '/', known)).toBe(false);
    expect(proxied('GET', '/assets/x.js', known)).toBe(false);
    expect(proxied('GET', '/internal/diag', known)).toBe(false);
  });

  it('rebuilds forwarding headers: trusted proxies keep their chain, direct clients cannot spoof one', () => {
    const req = (peer: string, headers: Record<string, string>) =>
      ({ headers, socket: { remoteAddress: peer } }) as unknown as IncomingMessage;
    const opts = {
      trusted: (a: string) => a === '172.17.0.1',
      effectiveHost: (r: IncomingMessage) => String(r.headers['x-forwarded-host'] ?? r.headers.host),
      secret: 's3cret',
    };
    const direct = forwardHeaders(
      req('192.168.1.9', {
        host: 'op.localhost',
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-proto': 'https',
        connection: 'keep-alive',
        [HEADER_INTERNAL]: 'forged',
      }),
      { ...opts, effectiveHost: (r) => String(r.headers.host) },
    );
    expect(direct['x-forwarded-for']).toBe('192.168.1.9');
    expect(direct['x-forwarded-proto']).toBeUndefined();
    expect(direct[HEADER_INTERNAL]).toBe('s3cret');
    expect(direct.connection).toBeUndefined();
    const viaDsm = forwardHeaders(
      req('172.17.0.1', {
        host: 'x',
        'x-forwarded-for': '8.8.8.8',
        'x-forwarded-host': 'op.venue.org',
        'x-forwarded-proto': 'https',
      }),
      opts,
    );
    expect(viaDsm).toMatchObject({
      'x-forwarded-for': '8.8.8.8, 172.17.0.1',
      'x-forwarded-host': 'op.venue.org',
      'x-forwarded-proto': 'https',
    });
  });

  it('streams bodies both ways and answers 503 while the library is down', async () => {
    let seen: Record<string, unknown> = {};
    upstream = createServer((req, res) => {
      seen = { ...req.headers, url: req.url, method: req.method };
      res.setHeader('set-cookie', ['a=1', 'b=2']);
      res.writeHead(201, { 'content-type': 'text/plain' });
      req.pipe(res);
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    let target: string | undefined = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const proxy = createProxy({
      target: () => target,
      secret: 'k',
      log: pino({ level: 'silent' }),
      trusted: () => false,
      effectiveHost: (r) => String(r.headers.host),
    });
    const front = createServer(proxy);
    await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
    try {
      const body = 'x'.repeat(3 * 1024 * 1024);
      const res = await fetch(`${base}/api/v1/media?q=1`, { method: 'POST', body });
      expect(res.status).toBe(201);
      expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
      expect((await res.text()).length).toBe(body.length);
      expect(seen).toMatchObject({
        url: '/api/v1/media?q=1',
        method: 'POST',
        [HEADER_INTERNAL]: 'k',
        'x-forwarded-for': '127.0.0.1',
      });
      target = undefined;
      const down = await fetch(`${base}/api/v1/presentations`);
      expect(down.status).toBe(503);
      expect(down.headers.get('retry-after')).toBe('1');
      expect(((await down.json()) as { error: { code: string } }).error.code).toBe('library_unavailable');
      // Address known but nobody listening (the library just died).
      upstream.close();
      target = `http://127.0.0.1:${(upstream.address() as AddressInfo | null)?.port ?? 1}`;
      expect((await fetch(`${base}/api/v1/presentations`)).status).toBe(503);
      expect(proxy.stats.unavailable).toBe(2);
    } finally {
      front.close();
      proxy.close();
    }
  });

  it('serves the live playlist media, fonts and logo from the live process', () => {
    const f = (h: string) => ({ hash: h.repeat(64), bytes: 1, mime: 'video/mp4', path: `media/${h}.mp4` });
    const files = liveFiles(
      {
        media: { m: { original: f('a'), delivery: f('b'), poster: f('c') } },
        fonts: [{ file: f('d') }],
      } as never,
      { fonts: [{ file: f('e') }], logo: { original: f('9') } } as never,
    );
    expect([...files.keys()].map((k) => k[0]).sort()).toEqual(['9', 'a', 'b', 'c', 'd', 'e']);
  });
});

describe('CPU worker pool', () => {
  const pool = new CpuPool(1, pathToFileURL(join(here, 'fixtures/hang.worker.mjs')));
  afterAll(() => pool.close());

  it('runs tasks, kills a stuck worker on abort, and recovers with a fresh worker', async () => {
    expect(await pool.run('font', { n: 1 } as never)).toEqual({ family: 'Echo', n: 1 });
    const ctrl = new AbortController();
    const stuck = pool.run('pptx', { buf: new Uint8Array(1) }, { signal: ctrl.signal });
    const queued = pool.run('font', { n: 2 } as never);
    setTimeout(() => ctrl.abort(), 100);
    await expect(stuck).rejects.toThrow(/cancelled/);
    expect(await queued).toEqual({ family: 'Echo', n: 2 });
    expect(pool.stats().restarts).toBe(1);
  });

  it('fails a task whose worker dies, without claiming the pool is unavailable', async () => {
    const err = await pool.run('pro7', { files: new Map() }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WorkerStartError);
    expect(String(err)).toMatch(/exited with code 3/);
    expect(await pool.run('font', { n: 3 } as never)).toEqual({ family: 'Echo', n: 3 });
  });
});

/** The real hub, as deployed: supervisor + live + library, from source under tsx. */
describe('two-process hub', () => {
  const PORT = 8581;
  let proc: ChildProcess | undefined;
  let dir = '';
  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((r) => proc!.once('exit', r));
    }
  });
  const base = `http://localhost:${PORT}`;
  const health = async () => {
    try {
      const r = await fetch(`${base}/api/v1/health`);
      return r.ok ? ((await r.json()) as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const pids = () =>
    Object.fromEntries(
      (
        JSON.parse(readFileSync(join(dir, 'supervisor.json'), 'utf8')).processes as {
          name: string;
          pid: number;
        }[]
      ).map((p) => [p.name, p.pid]),
    ) as { live: number; library: number };

  it('keeps the service running through a library crash and a live-process crash', async () => {
    dir = tempDir();
    const tsx = pathToFileURL(
      join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs'),
    ).href;
    proc = spawn(process.execPath, ['--import', tsx, join(here, '../src/main.ts')], {
      env: {
        ...process.env,
        ORDO_DATA: dir,
        ORDO_DOMAIN: 'localhost',
        ORDO_PORT: String(PORT),
        ORDO_HOST: '127.0.0.1',
        ORDO_DEV_PIN: '111111:222222',
        ORDO_LOG_LEVEL: 'warn',
        ORDO_SINGLE_PROCESS: '',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await until(async () => (await health())?.library === 'up', 30_000, 'hub up');

    // Through the proxy: log in, create a playlist; then go live in the live process.
    const op = await login(base, '111111');
    const p = await op.json<{ id: string }>('/presentations', { method: 'POST', json: song() });
    const pl = await op.json<{ id: string }>('/playlists', {
      method: 'POST',
      json: { name: 'Sunday', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
    });
    expect(
      (
        await op.json<{ seq: number }>('/live/events', {
          method: 'POST',
          json: { k: 'goLive', playlistId: pl.id },
        })
      ).seq,
    ).toBe(1);
    const settings = await op.json<{ outputs: { token: string }[] }>('/settings');
    const out = client(base, '', { 'x-ordo-token': settings.outputs[0]!.token });
    // The live process answers the edit role's summary itself.
    const ed = await login(base, '222222');
    const sum = await ed.json<{ mode: string; playlistId?: string; lockedPresentationIds: string[] }>(
      '/live/summary',
    );
    expect(sum).toMatchObject({ mode: 'live', playlistId: pl.id, lockedPresentationIds: [p.id] });

    // Kill the library: the live API, output config and manifest keep answering; the library returns.
    process.kill(pids().library, 'SIGKILL');
    const t0 = Date.now();
    expect(
      (
        await op.json<{ seq: number }>('/live/events', {
          method: 'POST',
          json: { k: 'next', at: Date.now() },
        })
      ).seq,
    ).toBe(2);
    expect((await out.json<{ output: { id: string } }>('/output/config')).output).toBeTruthy();
    expect((await out.json<{ manifestId: string }>('/cache/manifest')).manifestId).toBeTruthy();
    const before = await op.json<{ state: { live?: number } }>('/live');
    expect(before.state.live).toBe(0);
    await until(async () => (await op.fetch('/playlists')).status === 200, 20_000, 'library back');
    // Under tsx and a loaded test machine startup is slow; the built image restarts in well under a second.
    expect(Date.now() - t0).toBeLessThan(20_000);
    // Locks were replayed to the new library process.
    expect((await op.fetch(`/playlists/${pl.id}`, { method: 'DELETE' })).status).toBe(423);

    // Kill the live process: it comes back with the same live cue from its snapshot and journal.
    process.kill(pids().live, 'SIGKILL');
    await sleep(100);
    await until(async () => (await health())?.mode === 'live', 20_000, 'live process back');
    const st = await op.json<{ seq: number; state: { live: number; mode: string } }>('/live');
    expect(st.seq).toBe(2);
    expect(st.state.live).toBe(before.state.live);

    // Clean shutdown takes both children down.
    const { live, library } = pids();
    proc.kill('SIGTERM');
    await new Promise((r) => proc!.once('exit', r));
    for (const pid of [live, library]) expect(() => process.kill(pid, 0)).toThrow();
  }, 90_000);
});
