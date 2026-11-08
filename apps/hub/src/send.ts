import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { notFound } from './errors.ts';

export const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
};

export function mimeFor(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

/** Parse a single `bytes=` range. Returns null for unsatisfiable, undefined for none/multi. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === '' && b === '') return undefined;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

/** Send a file with ETag/304, Range (206/416) and the given caching headers. */
export async function sendFile(
  req: FastifyRequest,
  reply: FastifyReply,
  path: string,
  opts: { mime?: string; etag?: string; cacheControl: string },
): Promise<FastifyReply> {
  const st = await stat(path).catch(() => undefined);
  if (!st?.isFile()) throw notFound();
  const etag = opts.etag ?? `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  reply.header('ETag', etag);
  reply.header('Cache-Control', opts.cacheControl);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Last-Modified', st.mtime.toUTCString());
  reply.type(opts.mime ?? mimeFor(path));
  const inm = req.headers['if-none-match'];
  if (inm?.split(',').some((t) => t.trim() === etag)) return reply.code(304).send();
  const ifRange = req.headers['if-range'];
  const range = ifRange && ifRange !== etag ? undefined : parseRange(req.headers.range, st.size);
  if (range === null) {
    reply.header('Content-Range', `bytes */${st.size}`);
    return reply.code(416).send();
  }
  if (req.method === 'HEAD') {
    // Fastify replaces Content-Length with the (empty) body's length on HEAD; write the real headers on
    // the raw response so clients can size a download before fetching it.
    if (range) reply.header('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`);
    reply.header('Content-Length', String(range ? range.end - range.start + 1 : st.size));
    reply.hijack();
    reply.raw.writeHead(range ? 206 : 200, reply.getHeaders() as Record<string, string>);
    reply.raw.end();
    return reply;
  }
  if (range) {
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`);
    reply.header('Content-Length', String(range.end - range.start + 1));
    return reply.code(206).send(createReadStream(path, { start: range.start, end: range.end }));
  }
  reply.header('Content-Length', String(st.size));
  return reply.code(200).send(createReadStream(path));
}
