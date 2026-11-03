import { stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { notFound } from './errors.ts';
import { sendFile } from './send.ts';

export type AppName = 'operator' | 'output' | 'stage';

/** Which app a request is for: by host label under the venue domain, else by path prefix. */
export function appFor(
  hostHeader: string | undefined,
  path: string,
  domain: string,
): { app: AppName; prefix: string; hostMode: boolean } {
  const hostname = (hostHeader ?? '')
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '');
  if (domain && hostname.endsWith(`.${domain}`)) {
    const label = hostname.slice(0, -domain.length - 1);
    if (label === 'op' || label === 'hub') return { app: 'operator', prefix: '', hostMode: true };
    if (/^out\d+$/.test(label)) return { app: 'output', prefix: '', hostMode: true };
    if (label === 'stage') return { app: 'stage', prefix: '', hostMode: true };
  }
  if (path === '/output' || path.startsWith('/output/'))
    return { app: 'output', prefix: '/output', hostMode: false };
  if (path === '/stage' || path.startsWith('/stage/'))
    return { app: 'stage', prefix: '/stage', hostMode: false };
  return { app: 'operator', prefix: '', hostMode: false };
}

const HASHED =
  /[-.][A-Za-z0-9_-]{8,}\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|svg|webp|wasm|gif|avif|json|map)$/;
const NO_CACHE = /(?:^|\/)(?:index\.html|sw\.js|service-worker\.js|manifest\.webmanifest|registerSW\.js)$/;

export function cacheControlFor(rel: string): string {
  if (NO_CACHE.test(rel) || rel.endsWith('.html')) return 'no-cache';
  if (rel.startsWith('assets/') || HASHED.test(rel)) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

/** Security headers per design/21, by the app being served. */
export function securityHeaders(
  app: AppName | 'api',
  opts: { https: boolean; host: string },
): Record<string, string> {
  const h: Record<string, string> = {
    'Origin-Agent-Cluster': '?1',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-site',
  };
  if (opts.https) h['Strict-Transport-Security'] = 'max-age=31536000';
  if (app === 'api') return h;
  const host = opts.host;
  const ws = host ? ` ws://${host} wss://${host}` : '';
  h['Content-Security-Policy'] = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self'${ws}`,
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  h['X-Frame-Options'] = 'DENY';
  if (app === 'operator') {
    h['Cross-Origin-Opener-Policy'] = 'same-origin-allow-popups';
    h['Permissions-Policy'] =
      'hid=(self), midi=(self), window-management=(self), fullscreen=(self), microphone=(self), speaker-selection=(self), camera=(), geolocation=(), payment=(), usb=()';
  } else if (app === 'output') {
    // No COOP on outputs: the opener handle is the fallback bus (ADR 0003).
    h['Permissions-Policy'] =
      'fullscreen=(self), screen-wake-lock=(self), window-management=(self), autoplay=(self), speaker-selection=(self), microphone=(self), camera=(), geolocation=(), payment=(), usb=(), hid=(), midi=()';
  } else {
    h['Permissions-Policy'] =
      'screen-wake-lock=(self), fullscreen=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=(), hid=(), midi=()';
  }
  return h;
}

function placeholder(app: AppName): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ordo ${app}</title>
<style>body{font:16px system-ui,sans-serif;background:#111;color:#ddd;display:grid;place-items:center;height:100vh;margin:0}main{max-width:32rem;padding:1rem}code{color:#9cf}</style></head>
<body><main><h1>ordo ${app}</h1><p>The ${app} app has not been built. Run <code>pnpm build</code> (or <code>pnpm --filter @ordo/${app} build</code>) and reload.</p><p>The hub API is running at <code>/api/v1</code>.</p></main></body></html>`;
}

export class StaticApps {
  constructor(
    private appsDir: string,
    private domain: string,
  ) {}

  distOf(app: AppName): string {
    return join(this.appsDir, app, 'dist');
  }

  async serve(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const { app, prefix } = appFor(req.headers.host, path, this.domain);
    if (prefix && path === prefix) return reply.redirect(`${prefix}/${url.search}`, 301);
    let rel: string;
    try {
      rel = decodeURIComponent(path.slice(prefix.length)).replace(/^\/+/, '');
    } catch {
      throw notFound();
    }
    const dist = this.distOf(app);
    const distOk = await stat(join(dist, 'index.html')).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!distOk) {
      reply.header('Cache-Control', 'no-cache');
      return reply.type('text/html; charset=utf-8').send(placeholder(app));
    }
    const norm = normalize(rel);
    if (norm.startsWith('..') || norm.includes(`${sep}..${sep}`) || norm.includes('\0')) throw notFound();
    const candidate = rel === '' || rel.endsWith('/') ? join(dist, norm, 'index.html') : join(dist, norm);
    const st = await stat(candidate).catch(() => undefined);
    if (st?.isFile()) return sendFile(req, reply, candidate, { cacheControl: cacheControlFor(norm) });
    if (st?.isDirectory()) {
      const idx = join(candidate, 'index.html');
      if (
        await stat(idx).then(
          (s) => s.isFile(),
          () => false,
        )
      )
        return sendFile(req, reply, idx, { cacheControl: 'no-cache' });
    }
    // SPA fallback for navigations; real 404s for missing assets.
    const hasExt = /\.[a-z0-9]{1,8}$/i.test(norm);
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (!hasExt || wantsHtml)
      return sendFile(req, reply, join(dist, 'index.html'), { cacheControl: 'no-cache' });
    throw notFound();
  }
}
