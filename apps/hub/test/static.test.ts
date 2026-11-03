import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appFor, cacheControlFor } from '../src/static.ts';
import { startHub, type TestHub, tempDir } from './helpers.ts';

let hub: TestHub;
const apps = tempDir('ordo-apps-');

function get(path: string, host: string, headers: Record<string, string> = {}) {
  const u = new URL(hub.url);
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, headers: { host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  for (const name of ['operator', 'output']) {
    mkdirSync(join(apps, name, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(apps, name, 'dist', 'index.html'), `<!doctype html><title>${name}</title>`);
    writeFileSync(join(apps, name, 'dist', 'assets', 'main-AbCd1234.js'), `console.log('${name}')`);
    writeFileSync(join(apps, name, 'dist', 'sw.js'), '//sw');
  }
  hub = await startHub({ appsDir: apps, domain: 'venue.example' });
});
afterAll(async () => {
  await hub.cleanup();
});

describe('host routing and static apps', () => {
  it('picks the app by host label, else by path', () => {
    expect(appFor('op.venue.example', '/', 'venue.example').app).toBe('operator');
    expect(appFor('hub.venue.example:8080', '/', 'venue.example').app).toBe('operator');
    expect(appFor('out3.venue.example', '/', 'venue.example').app).toBe('output');
    expect(appFor('stage.venue.example', '/', 'venue.example').app).toBe('stage');
    expect(appFor('localhost:8080', '/output/x', 'localhost')).toMatchObject({
      app: 'output',
      prefix: '/output',
    });
    expect(appFor('out1.localhost:8080', '/', 'localhost')).toMatchObject({ app: 'output', hostMode: true });
    expect(appFor('192.168.1.5', '/stage/', 'venue.example').app).toBe('stage');
    expect(cacheControlFor('assets/main-AbCd1234.js')).toMatch(/immutable/);
    expect(cacheControlFor('index.html')).toBe('no-cache');
    expect(cacheControlFor('sw.js')).toBe('no-cache');
  });

  it('serves each origin its app with SPA fallback, placeholders and per-role headers', async () => {
    const op = await get('/', 'op.venue.example');
    expect(op.body).toContain('<title>operator');
    expect(op.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
    expect(op.headers['origin-agent-cluster']).toBe('?1');
    expect(op.headers['permissions-policy']).toMatch(/hid=\(self\).*midi=\(self\)/);
    expect(op.headers['content-security-policy']).toMatch(/worker-src 'self' blob:/);
    expect(op.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(op.headers['cache-control']).toBe('no-cache');

    const out = await get('/', 'out2.venue.example');
    expect(out.body).toContain('<title>output');
    expect(out.headers['cross-origin-opener-policy']).toBeUndefined();
    expect(out.headers['permissions-policy']).toMatch(/screen-wake-lock=\(self\)/);
    const asset = await get('/assets/main-AbCd1234.js', 'out2.venue.example');
    expect(asset.body).toContain("'output'");
    expect(asset.headers['cache-control']).toMatch(/immutable/);
    expect(asset.headers['content-type']).toMatch(/javascript/);

    const deep = await get('/library/songs', 'op.venue.example', { accept: 'text/html' });
    expect(deep.status).toBe(200);
    expect(deep.body).toContain('<title>operator');
    expect((await get('/assets/missing.js', 'op.venue.example')).status).toBe(404);
    expect((await get('/../../etc/passwd', 'op.venue.example')).body).not.toContain('root:');
    expect((await get('/%2e%2e/%2e%2e/etc/hostname', 'op.venue.example')).body).toContain('<title>operator');

    const stage = await get('/', 'stage.venue.example');
    expect(stage.body).toMatch(/has not been built/);

    // Path mode on other hosts.
    expect((await get('/output', '10.0.0.2:8080')).status).toBe(301);
    expect((await get('/output/', '10.0.0.2:8080')).body).toContain('<title>output');
    expect((await get('/output/sw.js', '10.0.0.2:8080')).headers['cache-control']).toBe('no-cache');

    const api = await get('/api/v1/health', 'out1.venue.example');
    expect(api.headers['origin-agent-cluster']).toBe('?1');
    expect(api.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.parse(api.body)).toMatchObject({ ok: true });
  });
});
