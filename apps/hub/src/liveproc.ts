/**
 * The live process (design/25 "Hub"): everything the service depends on at 10:00 on Sunday.
 *
 * - The front door on ORDO_PORT: WebSocket (/ws), the live API (live state, events, actions, manifest,
 *   output config, auth/me, health), files that outputs cache (the live playlist's media and fonts, the
 *   logo) straight from the content store, and the built apps (an output or the operator can reload while
 *   the library is down).
 * - Every other request is passed through to the library process (proxy.ts); while it is down they get a
 *   503 `library_unavailable` with Retry-After: 1.
 * - Its own SQLite file (live.db) for journal, snapshots and the cached library copies (librarylink.ts).
 * - Sessions are read from the library's ordo.db (WAL; writes are best effort) so one cookie works for
 *   both processes.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join, resolve, sep } from 'node:path';
import type { Media, ResolvedPlaylist } from '@ordo/domain';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { Auth, type AuthStore } from './auth.ts';
import { type HubConfig, loadConfig } from './config.ts';
import { type DB, openLiveDb, openSharedDb } from './db.ts';
import { forbidden, notFound } from './errors.ts';
import { liveDiagOf } from './hub.ts';
import { createHttpApp, HEADER_INTERNAL, withTimeout } from './http.ts';
import type { ChildState, LocksMsg, ProcessStatus } from './ipc.ts';
import type { Change } from './library.ts';
import { type LiveContext, LibraryLink } from './librarylink.ts';
import { LiveService } from './live.ts';
import { createLogger, LogRing } from './log.ts';
import { createProxy, type Proxy as HubProxy } from './proxy.ts';
import { registerLiveApi } from './routes.ts';
import { sendFile } from './send.ts';
import { StaticApps } from './static.ts';
import { SocketHub } from './ws.ts';

/** API paths (after /api/v1) the live process answers itself; everything else under /api/v1 is proxied. */
export const LIVE_API_PATHS = new Set([
  '/auth/me',
  '/output/config',
  '/live',
  '/live/events',
  '/cache/manifest',
  '/actions',
  '/health',
]);

/** Resolve once `port` can be bound on `host` (or after `ms`; the listen that follows then reports why). */
export async function waitForPort(port: number, host: string, ms: number): Promise<void> {
  if (!port) return;
  const deadline = Date.now() + ms;
  for (;;) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = createNetServer();
      srv.once('error', () => resolve(false));
      srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
    });
    if (free || Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The longest the proxy holds the answer to a library write for the live process to apply it. */
export const LIBRARY_APPLIED_WAIT_MS = 2500;

export type FileEntry = { path: string; mime: string };

/** Content-store files the live process serves itself: the live playlist's media and fonts, fonts, logo. */
export function liveFiles(
  resolved: ResolvedPlaylist | undefined,
  ctx: LiveContext | undefined,
): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  const add = (f: { hash: string; path: string; mime: string } | undefined) => {
    if (f?.hash && f.path) out.set(f.hash, { path: f.path, mime: f.mime });
  };
  const addMedia = (m: Media | undefined) => {
    if (!m) return;
    add(m.original);
    add(m.delivery);
    add(m.poster);
  };
  for (const m of Object.values(resolved?.media ?? {})) addMedia(m);
  for (const f of resolved?.fonts ?? []) add(f.file);
  for (const f of ctx?.fonts ?? []) add(f.file);
  addMedia(ctx?.logo);
  return out;
}

/** Does a request go to the library process? */
export function proxied(
  method: string | undefined,
  url: string | undefined,
  known: (hash: string) => boolean,
): boolean {
  const u = url ?? '/';
  const q = u.indexOf('?');
  const path = q < 0 ? u : u.slice(0, q);
  if (!path.startsWith('/api/v1/')) return false;
  const sub = path.slice('/api/v1'.length);
  if (LIVE_API_PATHS.has(sub)) return false;
  if (sub.startsWith('/files/') && (method === 'GET' || method === 'HEAD'))
    return !known(sub.slice('/files/'.length));
  return true;
}

/**
 * First start after the split: carry the live journal and snapshot over from ordo.db, where the one-process
 * hub kept them, so an upgrade in the middle of a series of services keeps the live state.
 */
function importLegacyLiveState(liveDb: DB, ordoDb: string, log: Logger): void {
  try {
    const has = liveDb
      .prepare(`SELECT 1 FROM live_snapshot UNION ALL SELECT 1 FROM live_journal LIMIT 1`)
      .get();
    if (has || !existsSync(ordoDb)) return;
    const old = new Database(ordoDb, { readonly: true, fileMustExist: true });
    try {
      const snap = old.prepare(`SELECT seq, json, saved_at FROM live_snapshot WHERE id = 1`).get() as
        | { seq: number; json: string; saved_at: number }
        | undefined;
      const rows = old
        .prepare(`SELECT seq, at, cmd_id, kind, event_json FROM live_journal ORDER BY seq DESC LIMIT 5000`)
        .all() as { seq: number; at: number; cmd_id: string | null; kind: string; event_json: string }[];
      liveDb.transaction(() => {
        if (snap)
          liveDb
            .prepare(`INSERT INTO live_snapshot (id, seq, json, saved_at) VALUES (1, ?, ?, ?)`)
            .run(snap.seq, snap.json, snap.saved_at);
        const ins = liveDb.prepare(
          `INSERT OR IGNORE INTO live_journal (seq, at, cmd_id, kind, event_json) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const r of rows) ins.run(r.seq, r.at, r.cmd_id, r.kind, r.event_json);
      })();
      if (snap || rows.length)
        log.info({ seq: snap?.seq, journal: rows.length }, 'live state imported from ordo.db');
    } finally {
      old.close();
    }
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'could not import the live state from ordo.db');
  }
}

export type LiveProcess = {
  app: FastifyInstance;
  cfg: HubConfig;
  live: LiveService;
  link: LibraryLink;
  sockets: SocketHub;
  proxy: HubProxy;
  log: Logger;
  url: string;
  setLibrary(url: string | undefined, state: ChildState): void;
  setStatus(p: ProcessStatus[]): void;
  /** Library changes relayed by the supervisor; `seq` is the library sequence after them. */
  onLibraryChanges(changes: Change[], seq?: number): void;
  /** Resolves once changes up to `seq` were applied (context refreshed, delta broadcast), or after a bound. */
  libraryApplied(seq: number): Promise<void>;
  locks(): LocksMsg;
  /** Snapshot now and drop everything without goodbyes (the supervisor vanished). */
  crash(): void;
  close(): Promise<void>;
};

export async function createLiveProcess(
  overrides: Partial<HubConfig>,
  opts: { secret: string; onLocks?: (m: LocksMsg) => void; libraryUrl?: string },
): Promise<LiveProcess> {
  const cfg: HubConfig = { ...loadConfig(process.env), ...overrides };
  mkdirSync(cfg.dataDir, { recursive: true });
  const ring = new LogRing(2000);
  const log = createLogger({ level: cfg.logLevel, stdout: cfg.logToStdout, ring, proc: 'live' });
  const ordoDbPath = join(cfg.dataDir, 'ordo.db');
  const liveDb = openLiveDb(join(cfg.dataDir, 'live.db'));
  importLegacyLiveState(liveDb, ordoDbPath, log);
  const link = new LibraryLink(liveDb, log, opts.secret);

  // ordo.db for sessions and the PIN flag, opened on first use (the library process creates it).
  let shared: DB | undefined;
  let sharedFailedAt = 0;
  const sharedDb = (): DB => {
    if (shared) return shared;
    if (Date.now() - sharedFailedAt < 2000) throw new Error('ordo.db is not available yet');
    try {
      shared = openSharedDb(ordoDbPath);
      return shared;
    } catch (e) {
      sharedFailedAt = Date.now();
      throw e;
    }
  };
  const lazyDb = { prepare: (sql: string) => sharedDb().prepare(sql) } as unknown as DB;
  const authStore: AuthStore = {
    getInternal<T>(key: string) {
      try {
        const r = sharedDb().prepare(`SELECT json FROM settings WHERE key = ?`).get(key) as
          | { json: string }
          | undefined;
        return r ? (JSON.parse(r.json) as T) : undefined;
      } catch {
        return undefined;
      }
    },
    putInternal() {
      throw forbidden('PINs are changed through the library process');
    },
    getSetting: () => link.outputs(),
  };
  const auth = new Auth(lazyDb, authStore, log, { shared: true });

  const live = new LiveService(liveDb, link, log, { snapshotIntervalMs: cfg.snapshotIntervalMs });
  const statics = new StaticApps(cfg.appsDir, cfg.domain);
  let status: ProcessStatus[] = [];

  // Files the live process serves itself, recomputed when the live playlist or the context changes.
  let filesKey: [unknown, unknown] = [undefined, undefined];
  let files = new Map<string, FileEntry>();
  const fileIndex = () => {
    const r = live.state.mode === 'live' ? live.state.resolved : undefined;
    if (filesKey[0] !== r || filesKey[1] !== link.context) {
      files = liveFiles(r, link.context);
      filesKey = [r, link.context];
    }
    return files;
  };

  let proxy!: HubProxy;
  const http = await createHttpApp({
    cfg,
    log,
    auth: () => auth,
    serverFactory: (handler) =>
      createServer((req, res) => {
        if (proxied(req.method, req.url, (h) => fileIndex().has(h))) proxy(req, res);
        else handler(req, res);
      }),
  });
  const app = http.app;
  // Library changes are applied in order: a batch that touches the context (settings, fonts, the logo)
  // first refreshes the copy (bounded by the fetch timeout), THEN is broadcast, so an output that refetches
  // its config on the delta gets the new look (review 2026-11-04 item 4). Batches that arrive meanwhile
  // share that refresh.
  let appliedSeq = 0;
  let pendingChanges: { changes: Change[]; seq?: number }[] = [];
  let draining = false;
  let changeRefresh = false;
  const seqWaiters = new Set<{ seq: number; done: () => void }>();
  const releaseWaiters = () => {
    for (const w of seqWaiters) if (appliedSeq >= w.seq) w.done();
  };
  const drainChanges = async () => {
    if (draining) return;
    draining = true;
    try {
      while (pendingChanges.length) {
        const batch = pendingChanges;
        pendingChanges = [];
        if (batch.some((b) => link.affects(b.changes))) {
          changeRefresh = true;
          try {
            await link.refreshContext();
          } finally {
            changeRefresh = false;
          }
        }
        for (const b of batch) {
          sockets.broadcastLibrary(b.changes, (ch) => link.forOutputs(ch));
          if (b.seq !== undefined && b.seq > appliedSeq) appliedSeq = b.seq;
        }
        releaseWaiters();
      }
    } catch (e) {
      log.error({ err: (e as Error).message }, 'applying library changes failed');
    } finally {
      draining = false;
    }
  };
  const libraryApplied = (seq: number): Promise<void> => {
    if (appliedSeq >= seq) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const w = {
        seq,
        done: () => {
          clearTimeout(t);
          seqWaiters.delete(w);
          resolve();
        },
      };
      // The change may never come (the library died after answering): never hold an answer for long.
      const t = setTimeout(w.done, LIBRARY_APPLIED_WAIT_MS);
      t.unref();
      seqWaiters.add(w);
    });
  };

  proxy = createProxy({
    target: () => link.target(),
    secret: opts.secret,
    log,
    trusted: http.trusted,
    effectiveHost: (req: IncomingMessage) => http.effectiveHost(req),
    barrier: libraryApplied,
  });

  const sockets = new SocketHub(auth, live, () => link.outputs(), log, {
    domain: cfg.domain,
    healthIntervalMs: cfg.healthIntervalMs,
    clientIp: http.clientIp,
    contextReady: () => link.context !== undefined,
  });
  // A context refresh that is not part of applying a library delta (the library came back, or this process
  // restarted and fetched it for the first time) may hold settings the outputs have not seen: tell them to
  // refetch their config. The first successful refresh after start always does.
  let firstContext = true;
  link.onContext((prev, next) => {
    // Everything up to the copy's sequence is in it: answers to writes up to there need not wait (after a
    // restart of this process nothing would ever be relayed for them).
    if (next.seq !== undefined && next.seq > appliedSeq) {
      appliedSeq = next.seq;
      releaseWaiters();
    }
    if (changeRefresh) {
      firstContext = false;
      return;
    }
    const changed =
      !prev ||
      JSON.stringify([prev.settings, prev.fonts, prev.logo]) !==
        JSON.stringify([next.settings, next.fonts, next.logo]);
    if (firstContext || changed) sockets.broadcastConfigRefresh();
    firstContext = false;
  });
  // A rotated or removed output token closes that output's sockets (the library cannot reach them).
  link.onContext((prev, next) => {
    if (!prev) return;
    const now = new Map(next.settings.outputs.map((o) => [o.id, o.token]));
    for (const o of prev.settings.outputs)
      if (now.get(o.id) !== o.token)
        sockets.disconnectOutput(o.id, now.has(o.id) ? 'token-rotated' : 'removed');
  });

  const locks = (): LocksMsg => {
    const l = live.locks();
    return {
      t: 'locks',
      mode: live.state.mode,
      playlistId: l.playlistId,
      presentations: [...l.presentations],
      media: [...l.media],
    };
  };
  const reportLocks = () => opts.onLocks?.(locks());
  live.onDelta((d) => {
    if (d.event.k === 'goLive' || d.event.k === 'endService') reportLocks();
  });
  live.onState(() => reportLocks());

  registerLiveApi(app, {
    cfg,
    auth,
    live,
    log,
    outputConfig: (id) => link.outputConfig(id),
    healthExtra: () => ({
      library: link.state,
      processes: status.map((p) => ({ name: p.name, state: p.state, restarts: p.restarts })),
    }),
  });
  app.route({
    method: 'GET',
    url: '/api/v1/files/:hash',
    config: { access: 'any' },
    handler: async (req, reply) => {
      const hash = (req.params as { hash: string }).hash;
      const f = /^[0-9a-f]{64}$/.test(hash) ? fileIndex().get(hash) : undefined;
      if (!f) throw notFound();
      const root = resolve(cfg.dataDir);
      const abs = resolve(root, f.path);
      if (!abs.startsWith(root + sep)) throw notFound();
      return sendFile(req, reply, abs, {
        mime: f.mime,
        etag: `"${hash}"`,
        cacheControl: 'private, max-age=31536000, immutable',
      });
    },
  });
  app.route({
    method: 'GET',
    url: '/internal/diag',
    config: { access: 'public' },
    handler: async (req) => {
      if (req.headers[HEADER_INTERNAL] !== opts.secret) throw forbidden();
      const d = liveDiagOf(live, sockets);
      return {
        ...d,
        log: ring.snapshot(),
        extra: {
          ...d.extra,
          library: link.state,
          libraryError: link.lastError,
          contextTakenAt: link.context?.takenAt,
          proxy: proxy.stats,
        },
      };
    },
  });
  app.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    config: { access: 'public' },
    handler: (req, reply) => statics.serve(req, reply),
  });
  app.server.on('upgrade', (req, socket, head) => {
    const host = http.effectiveHost(req);
    if (!http.hostOk(host)) {
      log.warn({ host }, 'websocket for an unknown host refused');
      socket.write('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head);
  });

  await app.ready();
  live.start();
  sockets.start();
  // Know the output tokens and settings before taking connections: a fresh live.db has no copy yet.
  if (opts.libraryUrl) {
    link.setLibrary(opts.libraryUrl, 'up');
    await withTimeout(link.refreshContext(), 2000);
  }
  // A previous live process may still be letting go of the port (it was just killed): wait briefly
  // rather than crash and burn a restart from the budget.
  await waitForPort(cfg.port, cfg.host, 5000);
  await app.listen({ port: cfg.port, host: cfg.host });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
  const loopback = cfg.host === '0.0.0.0' || cfg.host === '::' || cfg.host === '' ? '127.0.0.1' : cfg.host;
  const url = `http://${loopback.includes(':') ? `[${loopback}]` : loopback}:${port}`;
  log.info(
    { port, domain: cfg.domain, data: cfg.dataDir, seq: live.state.seq, mode: live.state.mode },
    'ordo hub (live process) listening',
  );
  reportLocks();

  let closed = false;
  return {
    app,
    cfg,
    live,
    link,
    sockets,
    proxy,
    log,
    url,
    setLibrary: (u, state) => link.setLibrary(u, state),
    setStatus(p) {
      status = p;
    },
    onLibraryChanges(changes, seq) {
      pendingChanges.push({ changes, seq });
      void drainChanges();
    },
    libraryApplied,
    locks,
    crash() {
      if (closed) return;
      closed = true;
      live.stop();
    },
    async close() {
      if (closed) return;
      closed = true;
      link.stop();
      for (const w of [...seqWaiters]) w.done();
      live.stop();
      const closing = sockets.close().catch(() => undefined);
      await withTimeout(closing, 250);
      for (const ws of sockets.wss.clients) ws.terminate();
      await withTimeout(app.close(), 1000, () => log.warn('http server did not close in time'));
      proxy.close();
      liveDb.close();
      shared?.close();
    },
  };
}
