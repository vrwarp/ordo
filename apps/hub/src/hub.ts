import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { Auth } from './auth.ts';
import { Backups } from './backup.ts';
import { type HubConfig, loadConfig } from './config.ts';
import { type DB, openDb } from './db.ts';
import { errorMessage } from './errors.ts';
import { FontService } from './fonts/service.ts';
import { createHttpApp, type RouteInfo, withTimeout } from './http.ts';
import { ImportService } from './imports.ts';
import { JobQueue } from './jobs.ts';
import { Library } from './library.ts';
import { LiveService, librarySource } from './live.ts';
import { affectsContext } from './librarylink.ts';
import { LibraryStatsCache } from './libstats.ts';
import { createLogger, LogRing } from './log.ts';
import { MediaService } from './media/service.ts';
import {
  cleanupStaleUploads,
  type LibraryApiCtx,
  type LiveDiag,
  registerApiNotFound,
  registerLibraryApi,
  registerLiveApi,
} from './routes.ts';
import { StaticApps } from './static.ts';
import { Store } from './store.ts';
import { SocketHub } from './ws.ts';

export { checkRouteAccess, type RouteInfo } from './http.ts';

export type Hub = {
  app: FastifyInstance;
  routes: RouteInfo[];
  cfg: HubConfig;
  db: DB;
  lib: Library;
  store: Store;
  auth: Auth;
  jobs: JobQueue;
  media: MediaService;
  fonts: FontService;
  imports: ImportService;
  live: LiveService;
  sockets: SocketHub;
  backups: Backups;
  log: Logger;
  ring: LogRing;
  /** The venue time zone: settings.general.timeZone, falling back to ORDO_TZ. Backups and countdowns share it. */
  timeZone(): string;
  /** Listen on cfg.host:cfg.port (or the given port); returns the base URL. */
  listen(port?: number): Promise<string>;
  close(): Promise<void>;
};

/** settings.general.timeZone when Intl knows it, else the configured fallback. */
export function venueTimeZone(fromSettings: string | undefined, fallback: string): string {
  for (const tz of [fromSettings, fallback]) {
    if (!tz) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch {
      /* unknown zone */
    }
  }
  return 'UTC';
}

/** The live side's diagnostics, read in-process. */
export function liveDiagOf(live: LiveService, sockets: SocketHub): LiveDiag {
  return {
    journal: live.journalTail(500),
    health: sockets.healthTable(),
    sockets: sockets.size,
    seq: live.state.seq,
    mode: live.state.mode,
    playlist: live.state.resolved?.playlist.name,
    extra: {
      restoreWarnings: live.restoreWarnings,
      degraded: live.state.resolved?.degraded,
      socketLimitClosures: sockets.limitClosures,
    },
  };
}

/**
 * The whole hub in one process: tests, `--single`, and ORDO_SINGLE_PROCESS=1. Production runs the same
 * parts split over two supervised processes (supervisor.ts, liveproc.ts, libproc.ts). Nothing listens
 * until `listen()`.
 */
export async function createHub(overrides: Partial<HubConfig> = {}): Promise<Hub> {
  const cfg: HubConfig = { ...loadConfig(process.env), ...overrides };
  mkdirSync(cfg.dataDir, { recursive: true });
  const ring = new LogRing(2000);
  const log = createLogger({ level: cfg.logLevel, stdout: cfg.logToStdout, ring });

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
    live.locks().presentations.has(id),
  );
  const live = new LiveService(db, librarySource(lib), log, { snapshotIntervalMs: cfg.snapshotIntervalMs });
  const timeZone = () => venueTimeZone(lib.getSetting('general').timeZone, cfg.timeZone);
  const backups = new Backups(db, lib, { dataDir: cfg.dataDir, timeZone }, log);
  const statics = new StaticApps(cfg.appsDir, cfg.domain);

  const http = await createHttpApp({ cfg, log, auth: () => auth });
  const app = http.app;
  const sockets = new SocketHub(auth, live, () => lib.getSetting('outputs'), log, {
    domain: cfg.domain,
    healthIntervalMs: cfg.healthIntervalMs,
    clientIp: http.clientIp,
  });
  // Outputs hear of what their config holds: settings, fonts and the logo media.
  lib.onChange((changes) =>
    sockets.broadcastLibrary(changes, (ch) => affectsContext(ch, lib.getSetting('general').logoMediaId)),
  );

  const hub: Hub = {
    app,
    routes: http.routes,
    cfg,
    db,
    lib,
    store,
    auth,
    jobs,
    media,
    fonts,
    imports,
    live,
    sockets,
    backups,
    log,
    ring,
    timeZone,
    async listen(port?: number) {
      await app.listen({ port: port ?? cfg.port, host: cfg.host });
      const addr = app.server.address();
      const p = typeof addr === 'object' && addr ? addr.port : (port ?? cfg.port);
      log.info({ port: p, domain: cfg.domain, data: cfg.dataDir }, 'ordo hub listening');
      return `http://127.0.0.1:${p}`;
    },
    async close() {
      // Order matters for a restart during a service: stop the timers, abort jobs (their child processes
      // die with the abort signal), snapshot the live state, and only then drop the sockets: the clients
      // get a `bye` and are terminated without waiting for a close handshake a stuck client never sends.
      backups.stop();
      await withTimeout(jobs.stop(), 1500, () => log.warn('jobs did not stop in time'));
      live.stop();
      const closing = sockets.close().catch((e) => log.warn({ err: errorMessage(e) }, 'socket close failed'));
      await withTimeout(closing, 250);
      for (const ws of sockets.wss.clients) ws.terminate();
      await withTimeout(closing, 250, () => log.warn('websocket server did not close in time'));
      await withTimeout(app.close(), 1000, () => log.warn('http server did not close in time'));
      db.close();
    },
  };

  const libCtx: LibraryApiCtx = {
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
    live: { locks: () => live.locks(), mode: () => live.state.mode },
    disconnectOutput: (id, reason) => sockets.disconnectOutput(id, reason),
    liveDiag: async () => liveDiagOf(live, sockets),
  };
  // Hub health reports the library snapshot's size (design/27 §3.4), measured at most every 5 s.
  const libStats = new LibraryStatsCache(lib, log);
  registerLiveApi(app, {
    cfg,
    auth,
    live,
    log,
    healthExtra: () => ({ librarySnapshotBytes: libStats.get().snapshotBytes }),
    outputConfig: (outputId) => {
      const s = lib.getSettings();
      const output = s.outputs.find((o) => o.id === outputId);
      if (!output) return undefined;
      const { token: _t, ...out } = output;
      const logo = s.general.logoMediaId ? lib.media.get(s.general.logoMediaId) : undefined;
      return {
        output: out,
        looks: s.looks,
        audio: s.audio,
        general: s.general,
        logo,
        fonts: lib.listFonts(),
      };
    },
  });
  registerLibraryApi(app, libCtx);
  registerApiNotFound(app);
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
  // A time-zone change in settings re-arms the nightly backup for the new zone.
  lib.onChange((changes) => {
    if (cfg.scheduleBackups && changes.some((c) => c.kind === 'settings' && c.id === 'general'))
      backups.schedule();
  });

  await app.ready();
  await cleanupStaleUploads(hub).catch((e) => log.warn({ err: errorMessage(e) }, 'upload cleanup failed'));
  live.start();
  jobs.start();
  sockets.start();
  if (cfg.scheduleBackups) backups.schedule();
  return hub;
}
