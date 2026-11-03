import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Media } from '@ordo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gifInfo } from '../src/media/ffmpeg.ts';
import { extensionAgrees, sniff } from '../src/store.ts';
import { fixtures } from './fixtures.ts';
import { type Client, client, EDIT_PIN, login, startHub, type TestHub, tempDir } from './helpers.ts';

let hub: TestHub;
let ed: Client;
const fx = tempDir('ordo-fx-');

beforeAll(async () => {
  hub = await startHub();
  ed = await login(hub.url, EDIT_PIN);
});
afterAll(async () => {
  await hub.cleanup();
});

async function upload(path: string, fields: Record<string, string> = {}, name = basename(path)): Promise<Response> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([readFileSync(path)]), name);
  return ed.fetch('/media', { method: 'POST', body: fd });
}

async function processed(path: string, fields: Record<string, string> = {}): Promise<Media> {
  const res = await upload(path, fields);
  expect(res.status).toBe(201);
  const m = (await res.json()) as Media;
  expect(m.state).toBe('uploaded');
  await hub.jobs.idle();
  return hub.lib.media.must(m.id);
}

describe('media pipeline', () => {
  it('transcodes video to H.264 MP4 with AAC and a poster', async () => {
    const m = await processed(fixtures.video(fx), { isBackground: 'true' });
    expect(m.state).toBe('ready');
    expect(m.kind).toBe('video');
    expect(m.isBackground).toBe(true);
    expect(m.name).toBe('clip');
    expect(m.original.mime).toBe('video/quicktime');
    expect(m.delivery?.mime).toBe('video/mp4');
    expect(m.delivery?.path).toMatch(/^media\/[0-9a-f]{2}\/[0-9a-f]{64}\.mp4$/);
    expect(m.poster?.mime).toBe('image/jpeg');
    expect(m.width).toBe(320);
    expect(m.height).toBe(240);
    expect(m.durationMs).toBeGreaterThan(900);
    expect(m.hasAlpha).toBe(false);
    const job = hub.jobs.list().find((j) => (j.result as { mediaId?: string } | undefined)?.mediaId === m.id);
    expect(job?.state).toBe('done');
    expect(job?.log.join('\n')).toMatch(/video mpeg4 320x240/);
  });

  it('scales to fit 1920x1080 and caps fps at 60', async () => {
    const m = await processed(fixtures.fastVideo(fx));
    expect(m.width).toBe(1920);
    expect(m.height).toBe(1080);
    const { probe } = await import('../src/media/ffmpeg.ts');
    const info = await probe(hub.store.abs(m.delivery!.path), 10_000);
    expect(info.video?.fps).toBeLessThanOrEqual(60.01);
    expect(info.video?.codec_name).toBe('h264');
  });

  it('keeps alpha as VP9 WebM', async () => {
    const m = await processed(fixtures.alpha(fx));
    expect(m.state).toBe('ready');
    expect(m.hasAlpha).toBe(true);
    expect(m.delivery?.mime).toBe('video/webm');
  });

  it('keeps small images, downscales wide ones', async () => {
    const png = await processed(fixtures.png(fx));
    expect(png).toMatchObject({ kind: 'image', state: 'ready', width: 64, height: 48 });
    expect(png.delivery).toBeUndefined();
    const wide = await processed(fixtures.wide(fx));
    expect(wide.width).toBe(3840);
    expect(wide.delivery?.mime).toBe('image/jpeg');
  });

  it('turns animated GIFs into looping video and still GIFs into PNG', async () => {
    const anim = await processed(fixtures.gif(fx));
    expect(anim).toMatchObject({ kind: 'video', state: 'ready', loop: true });
    expect(anim.delivery?.mime).toBe('video/mp4');
    const still = await processed(fixtures.stillGif(fx));
    expect(still).toMatchObject({ kind: 'image', state: 'ready' });
    expect(still.delivery?.mime).toBe('image/png');
  });

  it('normalises audio to AAC and measures loudness', async () => {
    const m = await processed(fixtures.wav(fx));
    expect(m).toMatchObject({ kind: 'audio', state: 'ready' });
    expect(m.delivery?.mime).toBe('audio/mp4');
    expect(typeof m.audio?.loudnessLufs).toBe('number');
    expect(m.audio!.loudnessLufs!).toBeLessThan(0);
    expect(m.durationMs).toBeGreaterThan(900);
  });

  it('rejects mismatched extensions and unknown files', async () => {
    const bad = await upload(fixtures.png(fx), {}, 'evil.mp3');
    expect(bad.status).toBe(415);
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('MZ not media at all')]), 'x.png');
    expect((await ed.fetch('/media', { method: 'POST', body: fd })).status).toBe(415);
    expect(extensionAgrees('clip.png', sniff(readFileSync(fixtures.video(fx)))!)).toBe(false);
    expect(extensionAgrees('clip.mp4', sniff(readFileSync(fixtures.video(fx)))!)).toBe(true);
  });

  it('serves content-addressed files with ranges, ETag and immutable caching', async () => {
    const m = hub.lib.media.list().find((x) => x.kind === 'video' && x.delivery?.mime === 'video/mp4')!;
    const hash = m.delivery!.hash;
    const full = await ed.fetch(`/files/${hash}`);
    expect(full.status).toBe(200);
    expect(full.headers.get('cache-control')).toMatch(/immutable/);
    expect(full.headers.get('etag')).toBe(`"${hash}"`);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    const bytes = Buffer.from(await full.arrayBuffer());
    expect(bytes.length).toBe(m.delivery!.bytes);
    const part = await ed.fetch(`/files/${hash}`, { headers: { range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 10-19/${bytes.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true);
    const tail = await ed.fetch(`/files/${hash}`, { headers: { range: 'bytes=-5' } });
    expect(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(-5))).toBe(true);
    expect((await ed.fetch(`/files/${hash}`, { headers: { range: `bytes=${bytes.length + 5}-` } })).status).toBe(416);
    expect((await ed.fetch(`/files/${hash}`, { headers: { 'if-none-match': `"${hash}"` } })).status).toBe(304);
    // Tokens work via ?token=; anonymous requests do not.
    const tok = hub.lib.getSetting('outputs')[0]!.token!;
    expect((await client(hub.url).fetch(`/files/${hash}?token=${tok}`)).status).toBe(200);
    expect((await client(hub.url).fetch(`/files/${hash}`)).status).toBe(401);
  });

  it('supports resumable chunked uploads', async () => {
    const buf = readFileSync(fixtures.png(fx));
    const created = await ed.json<{ id: string; offset: number }>('/media/uploads', {
      method: 'POST',
      json: { name: 'resumed.png', size: buf.length },
    });
    const half = Math.floor(buf.length / 2);
    const chunk = (from: number, to: number, offset = from) =>
      ed.fetch(`/media/uploads/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': String(offset) },
        body: buf.subarray(from, to),
      });
    expect((await chunk(0, half)).status).toBe(204);
    const st = await ed.json<{ offset: number }>(`/media/uploads/${created.id}`);
    expect(st.offset).toBe(half);
    expect((await chunk(half, buf.length, 0)).status).toBe(409);
    const done = await chunk(half, buf.length);
    expect(done.status).toBe(201);
    const m = (await done.json()) as Media;
    expect(m.name).toBe('resumed');
    await hub.jobs.idle();
    expect(hub.lib.media.must(m.id).state).toBe('ready');
  });

  it('updates metadata and deletes media', async () => {
    const m = hub.lib.media.list().find((x) => x.kind === 'audio')!;
    const u = await ed.json<Media>(`/media/${m.id}`, { method: 'PUT', json: { name: 'Tone', audio: { gainDb: -3 } } });
    expect(u.name).toBe('Tone');
    expect(u.audio?.gainDb).toBe(-3);
    expect(u.audio?.loudnessLufs).toBe(m.audio?.loudnessLufs);
    expect((await ed.fetch(`/media/${m.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await ed.fetch(`/files/${m.delivery!.hash}`)).status).toBe(404);
  });

  it('parses GIF frames and transparency', () => {
    const g = gifInfo(readFileSync(fixtures.gif(fx)));
    expect(g.frames).toBe(5);
    expect(g.width).toBe(64);
    expect(g.transparent).toBe(false);
    const s = gifInfo(readFileSync(fixtures.stillGif(fx)));
    expect(s.frames).toBe(1);
    // Header, logical screen, GCE with the transparency flag, one image descriptor, trailer.
    const t = Buffer.from([
      ...Buffer.from('GIF89a'), 1, 0, 1, 0, 0, 0, 0,
      0x21, 0xf9, 4, 1, 0, 0, 0, 0,
      0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0,
      0x3b,
    ]);
    expect(gifInfo(t)).toMatchObject({ frames: 1, transparent: true, width: 1, height: 1 });
  });
});
