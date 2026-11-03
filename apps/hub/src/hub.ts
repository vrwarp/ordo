import { mkdirSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { API_PREFIX, COOKIE_SESSION, HEADER_TOKEN } from '@ordo/protocol';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import type { Logger } from 'pino';
import { type Access, Auth, allowed, type Principal } from './auth.ts';
import { Backups } from './backup.ts';
import { type HubConfig, loadConfig } from './config.ts';
import { type DB, openDb } from './db.ts';
import { errorMessage, forbidden, HttpError, unauthorized } from './errors.ts';
import { FontService } from './fonts/service.ts';
import { ImportService } from './imports.ts';
import { JobQueue } from './jobs.ts';
import { Library } from './library.ts';
import { LiveService } from './live.ts';
import { createLogger, LogRing, redactUrl } from './log.ts';
import { MediaService } from './media/service.ts';
import { hostAllowed, hostnameOf, ipInAny, normaliseIp } from './net.ts';
import { cleanupStaleUploads, registerApi } from './routes.ts';
import { appFor, securityHeaders, StaticApps } from './static.ts';
import { MAX_UPLOAD_BYTES, Store } from './store.ts';
import { SocketHub } from './ws.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export type RouteInfo = { method: string; url: string; access: Access };

/** Throws when a route does not declare its access role. */
export function checkRouteAccess(opts: {
  method: string | string[];
  url: string;
  config?: unknown;
}): RouteInfo {
  const access = (opts.config as { access?: Access } | undefined)?.access;
  const method = String(opts.method);
  if (!access) throw new Error(`Route ${method} ${opts.url} does not declare an access role`);
  return { method, url: opts.url, access };
}

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

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      onTimeout?.();
      resolve(undefined);
    }, ms);
    t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

/** Build the hub in-process (tests) or for main.ts. Nothing listens until `listen()`. */
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
  const imports = new ImportService(lib, store, jobs, media, cfg, log);
  const live = new LiveService(db, lib, log, { snapshotIntervalMs: cfg.snapshotIntervalMs });
  const timeZone = () => venueTimeZone(lib.getSetting('general').timeZone, cfg.timeZone);
  const backups = new Backups(db, lib, { dataDir: cfg.dataDir, timeZone }, log);
  const statics = new StaticApps(cfg.appsDir, cfg.domain);

  const trusted = (addr: string) => cfg.trustedProxies.length > 0 && ipInAny(addr, cfg.trustedProxies);
  /**
   * The host the browser addressed: X-Forwarded-Host from the trusted reverse proxy (DSM sets it), else the
   * Host header. Used for the Host allow-list, app routing and the CSP connect-src.
   */
  const effectiveHost = (req: IncomingMessage): string => {
    const peer = normaliseIp(req.socket.remoteAddress ?? '');
    const xfh = req.headers['x-forwarded-host'];
    const forwarded = (Array.isArray(xfh) ? xfh[0] : xfh)?.split(',')[0]?.trim();
    return (forwarded && trusted(peer) ? forwarded : (req.headers.host ?? '')).toLowerCase();
  };
  const hostOk = (host: string) => hostAllowed(hostnameOf(host), cfg.domain, cfg.allowedHosts);
  /** Client IP for raw requests (WebSocket upgrade): the right-most untrusted X-Forwarded-For hop. */
  const clientIp = (req: IncomingMessage): string => {
    const peer = normaliseIp(req.socket.remoteAddress ?? '');
    if (!trusted(peer)) return peer;
    const xff = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => normaliseIp(s.trim()))
      .filter(Boolean);
    for (let i = xff.length - 1; i >= 0; i--) if (!trusted(xff[i]!)) return xff[i]!;
    return xff[0] ?? peer;
  };

  const app = Fastify({
    loggerInstance: log,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: (addr: string) => trusted(normaliseIp(addr)),
    bodyLimit: 32 * 1024 * 1024,
    routerOptions: { maxParamLength: 300 },
    return503OnClosing: true,
    forceCloseConnections: true,
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 50, fields: 30, fieldSize: 1024 * 1024, parts: 100 },
  });
  // Raw chunk bodies for resumable uploads stream straight to disk.
  app.addContentTypeParser('application/offset+octet-stream', (_req, payload, done) => done(null, payload));

  // Every route must declare who may call it (design/21): fail at startup otherwise.
  const routes: RouteInfo[] = [];
  app.addHook('onRoute', (opts) => {
    routes.push(checkRouteAccess(opts));
  });
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (req, reply) => {
    const isApi = req.url.startsWith(`${API_PREFIX}/`) || req.url === API_PREFIX;
    const peer = normaliseIp(req.socket.remoteAddress ?? '');
    const host = effectiveHost(req.raw);
    // Host allow-list (design/21): the venue domain and its role hosts, localhost and loopback only, so a
    // stray DNS name or an IP scan never gets an app page or a session cookie scoped to it.
    if (!hostOk(host)) {
      log.warn({ host, ip: req.ip }, 'request for an unknown host refused');
      throw new HttpError(421, 'misdirected', `This hub does not serve ${host || 'an empty Host'}`);
    }
    const xfp = String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      ?.trim()
      .toLowerCase();
    // Forwarded plain-HTTP requests from the public proxy are upgraded (design/21).
    if (xfp === 'http' && trusted(peer) && cfg.domain !== 'localhost') {
      if (req.method === 'GET' || req.method === 'HEAD')
        return reply.redirect(`https://${host || cfg.domain}${req.url}`, 308);
      throw forbidden('HTTPS required');
    }
    const sec = securityHeaders(isApi ? 'api' : appFor(host, req.url.split('?')[0]!, cfg.domain).app, {
      https: req.protocol === 'https',
      host,
    });
    for (const [k, v] of Object.entries(sec)) reply.header(k, v);
    const tokenHeader = req.headers[HEADER_TOKEN];
    const q = req.query as Record<string, unknown> | undefined;
    const token =
      typeof tokenHeader === 'string' ? tokenHeader : typeof q?.token === 'string' ? q.token : undefined;
    req.principal = auth.principal({ cookie: req.cookies?.[COOKIE_SESSION], token });
    const access = (req.routeOptions.config as { access?: Access } | undefined)?.access ?? 'public';
    if (!allowed(access, req.principal)) {
      if (token && !req.principal) log.warn({ url: redactUrl(req.url), ip: req.ip }, 'invalid output token');
      throw req.principal ? forbidden(`This needs the ${access} role`) : unauthorized();
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!req.url.startsWith(API_PREFIX)) return;
    const level = req.method === 'GET' || req.method === 'HEAD' ? 'debug' : 'info';
    log[level](
      {
        method: req.method,
        url: redactUrl(req.url),
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        ip: req.ip,
      },
      'request',
    );
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      if (err.status === 429) reply.header('Retry-After', String(err.extra?.retryAfterS ?? 900));
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status >= 500) log.error({ err: errorMessage(err), url: redactUrl(req.url) }, 'request failed');
    return reply.code(status).send({
      error: {
        code: e.code ?? (status >= 500 ? 'internal' : 'bad_request'),
        message: status >= 500 ? 'Internal error' : e.message,
      },
    });
  });

  let sockets!: SocketHub;
  const hub: Hub = {
    app: app as unknown as FastifyInstance,
    routes,
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
    get sockets() {
      return sockets;
    },
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
  sockets = new SocketHub(auth, live, lib, log, {
    domain: cfg.domain,
    healthIntervalMs: cfg.healthIntervalMs,
    clientIp,
  });

  registerApi(hub.app, hub);
  app.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    config: { access: 'public' },
    handler: (req, reply) => statics.serve(req, reply),
  });
  app.server.on('upgrade', (req, socket, head) => {
    const host = effectiveHost(req);
    if (!hostOk(host)) {
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
