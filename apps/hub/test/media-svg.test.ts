import { readdirSync, readFileSync } from 'node:fs';
import type { Media } from '@ordo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isActiveMime } from '../src/send.ts';
import { securityHeaders } from '../src/static.ts';
import { ffmpeg, fixtures } from './fixtures.ts';
import { type Client, EDIT_PIN, login, startHub, type TestHub, tempDir } from './helpers.ts';

/**
 * SVG media (design/12 "Media pipeline", design/21; review 2026-11-13 R4, R5, R13): an SVG is kept as uploaded
 * with the PNG still the uploading client drew as its delivery (validated here), its size read from its root
 * element, and served as a download from the files route; every API response is a sandboxed document.
 */

let hub: TestHub;
let ed: Client;
const fx = tempDir('ordo-svg-');

beforeAll(async () => {
  hub = await startHub();
  ed = await login(hub.url, EDIT_PIN);
});
afterAll(async () => {
  await hub.cleanup();
});

const svg = (attrs: string, body = '<rect width="100%" height="100%" fill="#f80"/>') =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`);
const png = (w: number, h: number, name = `r-${w}x${h}.png`) =>
  readFileSync(ffmpeg(fx, name, ['-f', 'lavfi', '-i', `color=c=orange:s=${w}x${h}`, '-frames:v', '1']));

async function upload(parts: { field: string; name: string; data: Buffer }[]): Promise<Response> {
  const fd = new FormData();
  for (const p of parts) fd.append(p.field, new Blob([new Uint8Array(p.data)]), p.name);
  return ed.fetch('/media', { method: 'POST', body: fd });
}

async function ready(res: Response): Promise<Media> {
  expect(res.status, await res.clone().text()).toBe(201);
  const m = (await res.json()) as Media;
  await hub.jobs.idle();
  return hub.lib.media.must(m.id);
}

function jobLog(id: string): string {
  const job = hub.jobs.list().find((j) => (j.result as { mediaId?: string } | undefined)?.mediaId === id);
  return job?.log.join('\n') ?? '';
}

const uploadsLeft = () => readdirSync(hub.store.uploads).filter((f) => !f.startsWith('.'));

describe('SVG media', () => {
  it('reads the size from the root element, not a stroke-width, when no still came with it', async () => {
    // Review R13: the old regex read `stroke-width="4"` as the width and `100%` as 100.
    const a = await ready(
      await upload([{ field: 'file', name: 'a.svg', data: svg('stroke-width="4" viewBox="0 0 160 90"') }]),
    );
    expect(a.state).toBe('ready');
    expect(a.delivery).toBeUndefined();
    expect([a.width, a.height]).toEqual([1920, 1080]);
    expect(a.hasAlpha).toBe(true);
    expect(jobLog(a.id)).toMatch(/no still picture/);
    const b = await ready(
      await upload([{ field: 'file', name: 'b.svg', data: svg('width="200" height="80"') }]),
    );
    expect([b.width, b.height]).toEqual([1920, 768]);
    const c = await ready(
      await upload([{ field: 'file', name: 'c.svg', data: svg('width="100%" height="100%"') }]),
    );
    // Nothing declared: a browser draws it 300x150.
    expect([c.width, c.height]).toEqual([1920, 960]);
  });

  it('keeps the still the uploading client drew as the delivery outputs draw', async () => {
    const m = await ready(
      await upload([
        { field: 'file', name: 'wave.svg', data: svg('viewBox="0 0 1600 900"') },
        { field: 'raster', name: 'wave.png', data: png(1920, 1080) },
      ]),
    );
    expect(m.state).toBe('ready');
    expect(m.original.mime).toBe('image/svg+xml');
    expect(m.delivery?.mime).toBe('image/png');
    expect(m.delivery?.path).toMatch(/\.png$/);
    expect([m.width, m.height]).toEqual([1920, 1080]);
    expect(jobLog(m.id)).toMatch(/still picture from the upload/);
    // Deleting the item removes both files.
    const files = [m.original.hash, m.delivery!.hash];
    expect((await ed.fetch(`/media/${m.id}`, { method: 'DELETE' })).status).toBe(204);
    for (const h of files) expect(hub.lib.getFile(h)).toBeUndefined();
  });

  it('refuses a still that is not a PNG of the SVG’s shape within the caps, or not with an SVG', async () => {
    const cases: [string, { field: string; name: string; data: Buffer }[], RegExp][] = [
      [
        'not an SVG',
        [
          { field: 'file', name: 'p.png', data: png(64, 48, 'p.png') },
          { field: 'raster', name: 'r.png', data: png(64, 48, 'r2.png') },
        ],
        /only come with an SVG/,
      ],
      [
        'not a PNG',
        [
          { field: 'file', name: 'n.svg', data: svg('width="10" height="10"') },
          { field: 'raster', name: 'r.png', data: Buffer.from('<svg width="1"/>') },
        ],
        /not a PNG/,
      ],
      [
        'wrong shape',
        [
          { field: 'file', name: 'w.svg', data: svg('viewBox="0 0 16 9"') },
          { field: 'raster', name: 'r.png', data: png(1080, 1920) },
        ],
        /not the shape/,
      ],
      [
        'too wide',
        [
          { field: 'file', name: 'x.svg', data: svg('width="4000" height="100"') },
          { field: 'raster', name: 'r.png', data: png(4000, 100) },
        ],
        /limit/,
      ],
      [
        'two stills',
        [
          { field: 'file', name: 't.svg', data: svg('width="10" height="10"') },
          { field: 'raster', name: 'r.png', data: png(64, 64) },
          { field: 'raster', name: 'r2.png', data: png(64, 64) },
        ],
        /exactly one file/,
      ],
    ];
    const before = hub.lib.media.list().length;
    for (const [what, parts, msg] of cases) {
      const res = await upload(parts);
      expect(res.status, what).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message, what).toMatch(msg);
    }
    expect(hub.lib.media.list().length).toBe(before);
    expect(uploadsLeft()).toEqual([]);
  });

  it('drops a still whose header lies about its pixels, and outputs draw the SVG itself', async () => {
    // A valid PNG header of the right size with no picture after it.
    const head = png(1920, 1080).subarray(0, 33);
    const m = await ready(
      await upload([
        { field: 'file', name: 'lie.svg', data: svg('viewBox="0 0 16 9"') },
        { field: 'raster', name: 'lie.png', data: Buffer.from(head) },
      ]),
    );
    expect(m.state).toBe('ready');
    expect(m.delivery).toBeUndefined();
    expect([m.width, m.height]).toEqual([1920, 1080]);
    expect(jobLog(m.id)).toMatch(/still picture dropped/);
  });

  it('serves an SVG as a download and every API response as a sandboxed document', async () => {
    const m = await ready(
      await upload([
        {
          field: 'file',
          name: 'evil.svg',
          data: svg('width="10" height="10"', '<script>document.title = "xss"</script>'),
        },
      ]),
    );
    const res = await ed.fetch(`/files/${m.original.hash}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^image\/svg\+xml/);
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const still = await ready(
      await upload([{ field: 'file', name: 'still.png', data: readFileSync(fixtures.png(fx)) }]),
    );
    const p = await ed.fetch(`/files/${still.original.hash}`);
    expect(p.headers.get('content-disposition')).toBeNull();
    expect(p.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    const health = await ed.fetch('/health');
    expect(health.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    // Apps keep their own policy.
    expect(securityHeaders('operator', { https: false, host: '' })['Content-Security-Policy']).toMatch(
      /default-src 'self'/,
    );
    expect(isActiveMime('image/svg+xml')).toBe(true);
    expect(isActiveMime('text/html; charset=utf-8')).toBe(true);
    expect(isActiveMime('image/png')).toBe(false);
    expect(isActiveMime(undefined)).toBe(false);
  });
});
