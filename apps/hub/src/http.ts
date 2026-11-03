/**
 * The Fastify app every hub process serves HTTP with: Host allow-list, HTTPS upgrade behind the proxy,
 * security headers, principal resolution, per-route access check, request log and the JSON error shape.
 * One process (tests, ORDO_SINGLE_PROCESS) builds one app; the live and library processes build one each.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { API_PREFIX, COOKIE_SESSION, HEADER_TOKEN } from '@ordo/protocol';
import Fastify, { type FastifyInstance, type FastifyServerFactory, LogController } from 'fastify';
import type { Logger } from 'pino';
import { type Access, type Auth, allowed, type Principal } from './auth.ts';
import type { HubConfig } from './config.ts';
import { errorMessage, forbidden, HttpError, unauthorized } from './errors.ts';
import { redactUrl } from './log.ts';
import { hostAllowed, hostnameOf, ipInAny, normaliseIp } from './net.ts';
import { appFor, securityHeaders } from './static.ts';
import { MAX_UPLOAD_BYTES } from './store.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export type RouteInfo = { method: string; url: string; access: Access };

/** Header carrying the per-boot secret between the hub processes (set by the supervisor). */
export const HEADER_INTERNAL = 'x-ordo-internal';

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

export function isLoopback(addr: string): boolean {
  const a = normaliseIp(addr);
  return a === '::1' || a.startsWith('127.');
}

export type HttpApp = {
  app: FastifyInstance;
  routes: RouteInfo[];
  /** The host the browser addressed (X-Forwarded-Host from a trusted proxy, else Host). */
  effectiveHost(req: IncomingMessage): string;
  hostOk(host: string): boolean;
  /** Client IP for raw requests (WebSocket upgrade): the right-most untrusted X-Forwarded-For hop. */
  clientIp(req: IncomingMessage): string;
  /** Is this peer a proxy whose X-Forwarded-* headers count? */
  trusted(addr: string): boolean;
};

export async function createHttpApp(opts: {
  cfg: HubConfig;
  log: Logger;
  auth: () => Auth | undefined;
  /**
   * The library process: requests come from the live process's proxy on loopback, carrying the internal
   * secret. Loopback is then a trusted proxy (its X-Forwarded-* headers carry the real client), and a
   * request without the secret is refused, so nothing else on the host can talk to it.
   */
  behindLiveProxy?: { secret: string };
  serverFactory?: FastifyServerFactory;
}): Promise<HttpApp> {
  const { cfg, log } = opts;
  const behind = opts.behindLiveProxy;
  const trusted = (addr: string) =>
    (!!behind && isLoopback(addr)) || (cfg.trustedProxies.length > 0 && ipInAny(addr, cfg.trustedProxies));
  const effectiveHost = (req: IncomingMessage): string => {
    const peer = normaliseIp(req.socket.remoteAddress ?? '');
    const xfh = req.headers['x-forwarded-host'];
    const entries = (Array.isArray(xfh) ? xfh.join(',') : (xfh ?? '')).split(',').map((s) => s.trim());
    const forwarded = entries[entries.length - 1];
    return (forwarded && trusted(peer) ? forwarded : (req.headers.host ?? '')).toLowerCase();
  };
  const hostOk = (host: string) => hostAllowed(hostnameOf(host), cfg.domain, cfg.allowedHosts);
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
    ...(opts.serverFactory ? { serverFactory: opts.serverFactory } : {}),
  }) as unknown as FastifyInstance<Server, IncomingMessage, ServerResponse>;
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 50, fields: 30, fieldSize: 1024 * 1024, parts: 100 },
  });
  // Raw chunk bodies for resumable uploads stream straight to disk.
  app.addContentTypeParser('application/offset+octet-stream', (_req, payload, done) => done(null, payload));

  // Every route must declare who may call it (design/21): fail at startup otherwise.
  const routes: RouteInfo[] = [];
  app.addHook('onRoute', (o) => {
    routes.push(checkRouteAccess(o));
  });
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (req, reply) => {
    if (behind && req.headers[HEADER_INTERNAL] !== behind.secret)
      throw forbidden('The library process only answers the hub front door');
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
    req.principal = opts.auth()?.principal({ cookie: req.cookies?.[COOKIE_SESSION], token }) ?? null;
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

  return { app, routes, effectiveHost, hostOk, clientIp, trusted };
}

/** Bounded wait: resolves undefined on timeout or rejection. */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T | undefined> {
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
