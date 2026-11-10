import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

const SITE = resolve('site');
const PORT = 5173;
const BASE = `http://localhost:${PORT}/ordo/`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', BASE);

  if (url.pathname === '/' || url.pathname === '') {
    res.writeHead(302, { Location: '/ordo/' });
    res.end();
    return;
  }

  if (!url.pathname.startsWith('/ordo/')) {
    // Redirect root requests to /ordo/
    res.writeHead(302, { Location: `/ordo${url.pathname}${url.search}` });
    res.end();
    return;
  }

  let rel = decodeURIComponent(url.pathname.slice('/ordo/'.length));
  if (!rel || rel === '/') rel = 'index.html';
  let filePath = join(SITE, rel);

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }

  if (!filePath.startsWith(SITE) || !existsSync(filePath)) {
    // Fallback to index.html for client-side routing if not an asset
    if (!extname(filePath)) {
      filePath = join(SITE, 'index.html');
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
  }

  const ext = extname(filePath);
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'service-worker-allowed': '/ordo/',
    'access-control-allow-origin': '*',
  });
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`Ordo Demo is live at: http://localhost:${PORT}/ordo/`);
  console.log(`========================================\n`);
});
