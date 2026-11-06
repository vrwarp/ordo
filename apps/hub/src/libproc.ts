/**
 * The library process (design/25 "Hub"): HTTP API, SQLite library, media jobs, imports, backups. It
 * listens on loopback only, behind the live process's proxy, and answers only requests carrying the
 * per-boot internal secret. It never serves WebSockets, the live state or the apps: a crash here costs
 * the editor a second, never the service.
 *
 * Internal endpoints for the live process (`/internal/*`, secret required):
 * - GET /internal/context: every setting (with output tokens), fonts, the logo media.
 * - GET /internal/golive/:playlistId: the stored playlist, its stored presentations (unvalidated: the live
 *   process validates and quarantines), the media they reference, fonts, looks and general settings.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import type { Logger } from 'pino';
import { Auth } from './auth.ts';
import { Backups } from './backup.ts';
import { type HubConfig, loadConfig } from './config.ts';
import { type DB, openDb } from './db.ts';
import { errorMessage, notFound } from './errors.ts';
import { FontService } from './fonts/service.ts';
import { venueTimeZone } from './hub.ts';
import { createHttpApp, HEADER_INTERNAL, HEADER_LIBRARY_SEQ, withTimeout } from './http.ts';
import { ImportService } from './imports.ts';
import type { LocksMsg, ProcessStatus } from './ipc.ts';
import { JobQueue } from './jobs.ts';
import { type Change, Library } from './library.ts';
import { type LibraryStats, LibraryStatsCache } from './libstats.ts';
import { createLogger, LogRing } from './log.ts';
import { MediaService } from './media/service.ts';
import { cpuPool } from './pool.ts';
import {
  cleanupStaleUploads,
  type LibraryApiCtx,
  type LiveDiag,
  type LiveView,
  registerApiNotFound,
  registerLibraryApi,
} from './routes.ts';
import { Store } from './store.ts';

/** Every string value under a key ending in `mediaId` (any case), anywhere in a value. Never throws. */
export function mediaIdsIn(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 64 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) mediaIdsIn(v, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v && /mediaid$/i.test(k)) out.add(v);
    else if (typeof v === 'object') mediaIdsIn(v, out, depth + 1);
  }
  return out;
}

/** How long after a library change its size is measured for hub health (changes in between share it). */
const STATS_DELAY_MS = 3000;

export type LibraryProcess = {
  app: FastifyInstance;
  cfg: HubConfig;
  db: DB;
  lib: Library;
  log: Logger;
  url: string;
  /** Apply the live process's locks (relayed by the supervisor). */
  setLocks(m: LocksMsg): void;
  setLiveUrl(url: string | undefined): void;
  setStatus(p: ProcessStatus[]): void;
  close(): Promise<void>;
};

export async function createLibraryProcess(
  overrides: Partial<HubConfig>,
  opts: {
    secret: string;
    onChanges?: (changes: Change[], seq: number) => void;
    /** The library's size for hub health (design/27 §3.4): at start, then after changes, every few seconds. */
    onStats?: (s: LibraryStats) => void;
  },
): Promise<LibraryProcess> {
  const cfg: HubConfig = { ...loadConfig(process.env), ...overrides };
  mkdirSync(cfg.dataDir, { recursive: true });
  const ring = new LogRing(2000);
  const log = createLogger({ level: cfg.logLevel, stdout: cfg.logToStdout, ring, proc: 'library' });

  const db = openDb(join(cfg.dataDir, 'ordo.db'));
  const lib = new Library(db, { timeZone: cfg.timeZone });
  const store = new Store(cfg.dataDir, lib);
  await store.init();
  const auth = new Auth(db, lib, log);
  if (cfg.devPin) await auth.devSetup(cfg.devPin);
  const jobs = new JobQueue(db, log, cfg.jobs, (job) => lib.emit([{ kind: 'job', id: job.id, entity: job }]));
  const media = new MediaService(lib, store, jobs, cfg, log);
  const fonts = new FontService(lib, store, jobs, cfg, log);
  const imports = new ImportService(lib, store, jobs, media, cfg, log, (id) =>
    liveView.locks().presentations.has(id),
  );
  const timeZone = () => venueTimeZone(lib.getSetting('general').timeZone, cfg.timeZone);
  const backups = new Backups(db, lib, { dataDir: cfg.dataDir, timeZone }, log);

  // The live service's locks, as last reported (idle until the live process says otherwise).
  let locks: LocksMsg = { t: 'locks', mode: 'idle', presentations: [], media: [] };
  let lockSets = { presentations: new Set<string>(), media: new Set<string>() };
  const liveView: LiveView = {
    locks: () => ({ playlistId: locks.playlistId, ...lockSets }),
    mode: () => locks.mode,
  };
  let liveUrl: string | undefined;
  const libStats = new LibraryStatsCache(lib, log, { minIntervalMs: 0 });
  let status: ProcessStatus[] = [];

  const http = await createHttpApp({ cfg, log, auth: () => auth, behindLiveProxy: { secret: opts.secret } });
  const app = http.app;
  const ctx: LibraryApiCtx = {
    cfg,
    lib,
    auth,
    store,
    jobs,
    media,
    fonts,
    imports,
    backups,
    log,
    ring,
    live: liveView,
    // The live process notices token changes in its settings copy and closes those sockets itself.
    disconnectOutput: () => undefined,
    liveDiag: async () => {
      if (!liveUrl) return undefined;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      try {
        const res = await fetch(`${liveUrl}/internal/diag`, {
          headers: { [HEADER_INTERNAL]: opts.secret },
          signal: ctrl.signal,
        });
        return res.ok ? ((await res.json()) as LiveDiag) : undefined;
      } catch {
        return undefined;
      } finally {
        clearTimeout(t);
      }
    },
    diagExtra: () => ({ processes: status, cpuPool: cpuPool().stats(), library: libStats.get() }),
  };
  registerLibraryApi(app, ctx);
  // Read-your-writes through the live process: every answer to a write carries the library sequence after
  // it, and the live proxy holds that answer until the live process has applied the changes up to it
  // (its context copy refreshed, the delta broadcast). A PUT /settings/looks followed at once by an
  // output's GET /output/config then sees the new look.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS')
      reply.header(HEADER_LIBRARY_SEQ, String(lib.seq()));
    return payload;
  });

  const route = (url: string, handler: RouteHandlerMethod) =>
    app.route({ method: 'GET', url, config: { access: 'public' }, handler });
  route('/internal/context', async () => {
    const settings = lib.getSettings();
    const logoId = settings.general.logoMediaId;
    return {
      settings,
      fonts: lib.listFonts(),
      logo: logoId ? lib.media.get(logoId) : undefined,
      // Everything up to this library sequence is in this copy (the live proxy's read-your-writes barrier).
      seq: lib.seq(),
    };
  });
  route('/internal/golive/:playlistId', async (req) => {
    const id = (req.params as { playlistId: string }).playlistId;
    const playlist = lib.playlists.get(id);
    if (!playlist) throw notFound(`Playlist ${id} not found`);
    const presentations: Record<string, unknown> = {};
    const items = Array.isArray(playlist.items) ? playlist.items : [];
    for (const it of items)
      if (it && it.kind === 'presentation' && typeof it.presentationId === 'string') {
        const p = lib.presentations.get(it.presentationId);
        if (p) presentations[it.presentationId] = p;
      }
    const settings = lib.getSettings();
    const ids = mediaIdsIn([playlist, presentations, settings.looks, settings.general]);
    const media: Record<string, unknown> = {};
    for (const mid of ids) {
      const m = lib.media.get(mid);
      if (m) media[mid] = m;
    }
    return {
      playlist,
      presentations,
      media,
      fonts: lib.listFonts(),
      looks: settings.looks,
      general: settings.general,
    };
  });
  registerApiNotFound(app);

  lib.onChange((changes, seq) => opts.onChanges?.(changes, seq));
  // Measured STATS_DELAY_MS after a change that is not only job progress, so an import or an editing session
  // costs one measurement every few seconds (a summed SQL scan of the stored JSON, no parsing).
  let statsTimer: NodeJS.Timeout | undefined;
  const reportStats = () => {
    statsTimer = undefined;
    try {
      opts.onStats?.(libStats.get());
    } catch (e) {
      log.warn({ err: errorMessage(e) }, 'library size measurement failed');
    }
  };
  lib.onChange((changes) => {
    if (!opts.onStats || statsTimer || changes.every((c) => c.kind === 'job')) return;
    statsTimer = setTimeout(reportStats, STATS_DELAY_MS);
    statsTimer.unref();
  });
  lib.onChange((changes) => {
    if (cfg.scheduleBackups && changes.some((c) => c.kind === 'settings' && c.id === 'general'))
      backups.schedule();
  });

  await app.ready();
  await cleanupStaleUploads({ lib, store, cfg }).catch((e) =>
    log.warn({ err: errorMessage(e) }, 'upload cleanup failed'),
  );
  jobs.start();
  if (cfg.scheduleBackups) backups.schedule();
  // Loopback only, on a port of the OS's choosing: the live process is the only way in.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  log.info({ url, data: cfg.dataDir }, 'library process listening');
  reportStats();

  return {
    app,
    cfg,
    db,
    lib,
    log,
    url,
    setLocks(m) {
      locks = m;
      lockSets = { presentations: new Set(m.presentations), media: new Set(m.media) };
    },
    setLiveUrl(u) {
      liveUrl = u;
    },
    setStatus(p) {
      status = p;
    },
    async close() {
      if (statsTimer) clearTimeout(statsTimer);
      backups.stop();
      await withTimeout(jobs.stop(), 1500, () => log.warn('jobs did not stop in time'));
      await withTimeout(app.close(), 1000, () => log.warn('http server did not close in time'));
      db.close();
    },
  };
}
