/**
 * The live process's pass-through to the library process (design/12 "Processes"). Deliberately small:
 * one request in, one request out, bodies streamed both ways (multi-GB uploads never buffer), no retries,
 * no caching. Failure modes:
 * - library down or restarting: 503 `library_unavailable` with Retry-After: 1 (no body was consumed by
 *   the library, so the client may simply retry);
 * - library dies mid-response: the client connection is destroyed (the browser sees a network error);
 * - library silent for PROXY_IDLE_MS on an open request: 504.
 * Forwarded headers are rebuilt here, so the library sees the real client exactly as the live process did:
 * X-Forwarded-For (the chain from a trusted proxy plus the peer), X-Forwarded-Host (the effective host),
 * X-Forwarded-Proto (only when a trusted proxy said so). The internal secret proves the request came from
 * this process.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { HEADER_INTERNAL } from './http.ts';
import { normaliseIp } from './net.ts';

export const PROXY_IDLE_MS = 120_000;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

export type ProxyOpts = {
  /** Where the library listens, e.g. http://127.0.0.1:41234; undefined while it is down. */
  target(): string | undefined;
  secret: string;
  log: Logger;
  trusted(addr: string): boolean;
  effectiveHost(req: IncomingMessage): string;
};

export type Proxy = ((req: IncomingMessage, res: ServerResponse) => void) & {
  stats: { forwarded: number; unavailable: number; failed: number };
  close(): void;
};

function unavailable(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'retry-after': '1',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Request headers for the library: hop-by-hop removed, forwarding headers rebuilt. */
export function forwardHeaders(
  req: IncomingMessage,
  opts: Pick<ProxyOpts, 'trusted' | 'effectiveHost' | 'secret'>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k)) continue;
    if (
      k === 'x-forwarded-for' ||
      k === 'x-forwarded-host' ||
      k === 'x-forwarded-proto' ||
      k === HEADER_INTERNAL
    )
      continue;
    out[k] = v;
  }
  const peer = normaliseIp(req.socket.remoteAddress ?? '');
  const viaProxy = opts.trusted(peer);
  const xff = String(req.headers['x-forwarded-for'] ?? '').trim();
  out['x-forwarded-for'] = viaProxy && xff ? `${xff}, ${peer}` : peer;
  out['x-forwarded-host'] = opts.effectiveHost(req);
  const xfp = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  if (viaProxy && (xfp === 'http' || xfp === 'https')) out['x-forwarded-proto'] = xfp;
  out[HEADER_INTERNAL] = opts.secret;
  return out;
}

export function createProxy(opts: ProxyOpts): Proxy {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 10_000 });
  const stats = { forwarded: 0, unavailable: 0, failed: 0 };
  const proxy = ((req: IncomingMessage, res: ServerResponse) => {
    const target = opts.target();
    if (!target) {
      stats.unavailable++;
      req.resume();
      return unavailable(res, 503, 'library_unavailable', 'The library is restarting; try again in a moment');
    }
    const url = new URL(target);
    const preq = http.request({
      agent,
      host: url.hostname,
      port: url.port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, opts),
    });
    let responded = false;
    preq.setTimeout(PROXY_IDLE_MS, () => {
      stats.failed++;
      preq.destroy();
      if (!responded) unavailable(res, 504, 'library_timeout', 'The library did not answer in time');
      else res.destroy();
    });
    preq.on('response', (pres) => {
      responded = true;
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(pres.headers))
        if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v;
      if (pres.statusMessage) res.writeHead(pres.statusCode ?? 502, pres.statusMessage, headers);
      else res.writeHead(pres.statusCode ?? 502, headers);
      pres.pipe(res);
      pres.on('error', () => res.destroy());
      pres.on('aborted', () => res.destroy());
    });
    preq.on('error', (e) => {
      if (!responded) {
        stats.unavailable++;
        opts.log.warn({ err: e.message, url: req.url?.split('?')[0] }, 'library unreachable');
        unavailable(res, 503, 'library_unavailable', 'The library is restarting; try again in a moment');
        req.resume();
      } else {
        stats.failed++;
        res.destroy();
      }
    });
    // A client that goes away mid-upload aborts the library request too.
    res.on('close', () => {
      if (!res.writableFinished) preq.destroy();
    });
    stats.forwarded++;
    req.pipe(preq);
  }) as Proxy;
  proxy.stats = stats;
  proxy.close = () => agent.destroy();
  return proxy;
}
