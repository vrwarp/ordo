/**
 * The library process (design/25 "Hub"): HTTP API, SQLite library, media jobs, imports, backups. It
 * listens on loopback only, behind the live process's proxy, and answers only requests carrying the
 * per-boot internal secret. It never serves WebSockets, the live state or the apps: a crash here costs
 * the editor a second, never the service.
 *
 * Internal endpoints for the live process (`/internal/*`, secret required):
 * - GET /internal/context: every setting (with output tokens), the output-config fonts, the logo media.
 * - GET /internal/golive/:playlistId: the stored playlist, its stored presentations (unvalidated: the live
 *   process validates and quarantines), the media they reference, the geometry files their shapes name
 *   (`ShapeGeom.ref`), fonts, looks and general settings.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isGeomFileRef } from '@ordo/domain';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import type { Logger } from 'pino';
import { Auth } from './auth.ts';
import { Backups } from './backup.ts';
import { type HubConfig, loadConfig } from './config.ts';
import { type DB, openDb } from './db.ts';
import { DISK_MEASURE_MS, DiskFloor } from './diskfloor.ts';
import { errorMessage, notFound } from './errors.ts';
import { outputFonts } from './fonts/bundled.ts';
import { FontService } from './fonts/service.ts';
import { venueTimeZone } from './hub.ts';
import { createHttpApp, HEADER_INTERNAL, HEADER_LIBRARY_SEQ, type RouteInfo, withTimeout } from './http.ts';
import { ImportService } from './imports.ts';
import type { LocksMsg, ProcessStatus } from './ipc.ts';
import { JobQueue } from './jobs.ts';
import { JobPacing } from './pacing.ts';
import { type Change, Library, phonesSwitch } from './library.ts';
import { type LibraryStats, LibraryStatsCache } from './libstats.ts';
import { createLogger, LogRing } from './log.ts';
import { MediaService } from './media/service.ts';
import { cpuPool } from './pool.ts';
import { PrerenderKeys } from './prerenderkeys.ts';
import { goLiveExtras, PrerenderStore } from './prerenders.ts';
import { SlideFiles } from './slidefiles.ts';
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

/**
 * The geometry files a stored value names (`ShapeGeom.ref` of shapes and masks, design/27 §3.1): every
 * string `ref` that is a SHA-256 name, at most `max`.
 */
export function geomRefsIn(value: unknown, out = new Set<string>(), max = 20_000, depth = 0): Set<string> {
  if (depth > 64 || value === null || typeof value !== 'object' || out.size >= max) return out;
  if (Array.isArray(value)) {
    for (const v of value) geomRefsIn(v, out, max, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'ref' && isGeomFileRef(v)) {
      if (out.size < max) out.add(v);
    } else if (typeof v === 'object') geomRefsIn(v, out, max, depth + 1);
  }
  return out;
}

/** How long after a library change its size is measured for hub health (changes in between share it). */
const STATS_DELAY_MS = 3000;

export type LibraryProcess = {
  app: FastifyInstance;
  /** Every route with its access role and lowest cap (phones-routes.test.ts). */
  routes: RouteInfo[];
  cfg: HubConfig;
  db: DB;
  lib: Library;
  jobs: JobQueue;
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
    /** A picture accepted for a key of the running service, as the `prerender.add` event the live loop applies (step 7). */
    onPrerenderAdd?: (event: unknown) => void;
    /**
     * The live service's locks as last reported (ORDO_LIVE_LOCKS, set by the supervisor for a restarted
     * library): applied before the job queue starts, so a library restarted during a service holds the
     * heavy jobs it holds (design/28 §5.3) instead of relaunching one that was interrupted.
     */
    initialLocks?: LocksMsg;
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
  // The free-space floor (design/29 A25, W44): only this process stores files, so only this process asks it.
  if (cfg.minFreeWarning) log.warn(cfg.minFreeWarning);
  const disk = new DiskFloor(cfg.dataDir, {
    statfs: cfg.statfs,
    minFreeBytes: cfg.minFreeBytes,
    warn: (m) => log.warn(m),
  });
  const auth = new Auth(db, lib, log);
  if (cfg.devPin) await auth.devSetup(cfg.devPin);
  const phones = phonesSwitch(lib);
  const pacing = new JobPacing({ graceMs: cfg.paceGraceMs, enabled: phones.enabled() });
  const jobs = new JobQueue(
    db,
    log,
    cfg.jobs,
    (job) => lib.emit([{ kind: 'job', id: job.id, entity: job }]),
    {
      pacing,
      notifyMany: (all) => lib.emit(all.map((job) => ({ kind: 'job' as const, id: job.id, entity: job }))),
    },
  );
  phones.onChange((on) => jobs.setPhones(on));
  const media = new MediaService(lib, store, jobs, cfg, log);
  const fonts = new FontService(lib, store, jobs, cfg, log);
  const imports = new ImportService(lib, store, jobs, media, cfg, log, (id) =>
    liveView.locks().presentations.has(id),
  );
  const timeZone = () => venueTimeZone(lib.getSetting('general').timeZone, cfg.timeZone);
  const backups = new Backups(db, lib, { dataDir: cfg.dataDir, timeZone }, log);

  // The live service's locks, as last reported (idle until the live process says otherwise).
  let locks: LocksMsg = opts.initialLocks ?? {
    t: 'locks',
    mode: 'idle',
    presentations: [],
    media: [],
    fonts: [],
  };
  const setsOf = (m: LocksMsg) => ({
    presentations: new Set(m.presentations),
    media: new Set(m.media),
    fonts: new Set(Array.isArray(m.fonts) ? m.fonts : []),
  });
  let lockSets = setsOf(locks);
  const liveView: LiveView = {
    locks: () => ({ playlistId: locks.playlistId, ...lockSets }),
    mode: () => locks.mode,
  };
  let liveUrl: string | undefined;
  const prerenderKeys = new PrerenderKeys(lib, store, cpuPool, { live: () => locks.mode, log });
  const prerenders = new PrerenderStore(lib, store, liveView, { log });
  const libStats = new LibraryStatsCache(lib, log, { minIntervalMs: 0 });
  let status: ProcessStatus[] = [];

  const http = await createHttpApp({
    cfg,
    log,
    auth: () => auth,
    behindLiveProxy: { secret: opts.secret },
    phonesEnabled: phones.enabled,
  });
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
    disk,
    slideFiles: new SlideFiles(lib, store, cpuPool),
    prerenderKeys,
    prerenders,
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
  prerenders.onAccepted((e) =>
    opts.onPrerenderAdd?.({
      k: 'prerender.add',
      presentationId: e.presentationId,
      slideId: e.slideId,
      key: e.key,
      size: e.size,
      file: e.file.hash,
    }),
  );
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
    app.route({ method: 'GET', url, config: { access: 'public', cap: 'full' }, handler });
  route('/internal/context', async () => {
    const settings = lib.getSettings();
    const logoId = settings.general.logoMediaId;
    return {
      settings,
      // What outputs receive through their config: every face but the CJK fallbacks (design/27 §10).
      fonts: outputFonts(lib.listFonts(), settings.looks, (f) => lib.namesFontFamily(f)),
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
    // The geometry files the presentations' shapes name: the live process lists and serves them.
    const files: Record<string, unknown> = {};
    for (const hash of geomRefsIn(presentations)) {
      const f = lib.getFile(hash);
      if (f) files[hash] = f;
    }
    // Pre-rendered slides (design/29 §1.7): their heads, pages, shape files and pictures, the heads' pages, and the
    // keys and picture rows of each presentation: DB-only reads, present only when there is something.
    const extras = goLiveExtras(lib, presentations);
    Object.assign(files, extras.files);
    return {
      playlist,
      presentations,
      media,
      files,
      ...(extras.slideHeads ? { slideHeads: extras.slideHeads } : {}),
      ...(extras.prerenders ? { prerenders: extras.prerenders } : {}),
      ...(extras.prerenderKeys ? { prerenderKeys: extras.prerenderKeys } : {}),
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
      opts.onStats?.({ ...libStats.get(), ...disk.healthFields() });
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

  // The volume's numbers ride the stats message on their own clock: every DISK_MEASURE_MS and after a refusal
  // (at most one report every 2 s), never on the library sequence's.
  let diskReportedAt = 0;
  const reportDisk = async () => {
    await disk.state();
    diskReportedAt = Date.now();
    reportStats();
  };
  disk.onRefused(() => {
    if (Date.now() - diskReportedAt > 2000) void reportDisk();
  });
  const diskTimer = setInterval(() => void reportDisk(), DISK_MEASURE_MS);
  diskTimer.unref();
  await app.ready();
  await cleanupStaleUploads({ lib, store, cfg }).catch((e) =>
    log.warn({ err: errorMessage(e) }, 'upload cleanup failed'),
  );
  jobs.onLiveMode(locks.mode);
  jobs.start();
  prerenderKeys.start();
  if (cfg.scheduleBackups) backups.schedule();
  // Loopback only, on a port of the OS's choosing: the live process is the only way in.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  log.info({ url, data: cfg.dataDir }, 'library process listening');
  reportStats();
  void reportDisk();

  return {
    app,
    routes: http.routes,
    cfg,
    db,
    lib,
    jobs,
    log,
    url,
    setLocks(m) {
      locks = m;
      lockSets = setsOf(m);
      jobs.onLiveMode(m.mode);
      prerenderKeys.onLiveMode(m.mode);
    },
    setLiveUrl(u) {
      liveUrl = u;
    },
    setStatus(p) {
      status = p;
    },
    async close() {
      if (statsTimer) clearTimeout(statsTimer);
      clearInterval(diskTimer);
      prerenderKeys.stop();
      backups.stop();
      await withTimeout(jobs.stop(), 1500, () => log.warn('jobs did not stop in time'));
      await withTimeout(app.close(), 1000, () => log.warn('http server did not close in time'));
      db.close();
    },
  };
}
