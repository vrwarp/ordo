/**
 * Tests for the hub findings of docs/review-2026-11-03.md (items 5, 7, 15-19, 34, 38-40) plus the
 * `preview` relay. Each `describe` names the item it covers.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { type LiveState, newId, type Output, type Playlist, type Presentation } from '@ordo/domain';
import { readZip, remapMediaIds } from '@ordo/importers';
import type { Job, LibrarySnapshot, LibrarySnapshotDelta } from '@ordo/protocol';
import JSZip from 'jszip';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { MIN_SCHEDULE_DELAY_MS, PRE_RESTORE_KEEP } from '../src/backup.ts';
import { venueTimeZone } from '../src/hub.ts';
import { importPro7InWorker, type Importers, type Pro7Result } from '../src/imports.ts';
import { AT_FUTURE_MS, AT_PAST_MS, AT_REPLACE_MS } from '../src/live.ts';
import { hostAllowed, hostnameOf } from '../src/net.ts';
import { assertOneAudioMaster } from '../src/routes.ts';
import { fixtures } from './fixtures.ts';
import {
  byType,
  client,
  connectWs,
  EDIT_PIN,
  login,
  OPERATE_PIN,
  sleep,
  song,
  startHub,
  type TestHub,
  tempDir,
} from './helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

const fx = tempDir('ordo-fx-');

async function livePlaylist(h: TestHub): Promise<Playlist> {
  const p = h.lib.savePresentation(song(), { create: true });
  return h.lib.playlists.insert({
    id: newId(),
    rev: 1,
    name: 'Sunday',
    items: [{ id: newId(), kind: 'presentation', presentationId: p.id }],
  });
}

function raw(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, headers, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('item 5: nightly backup scheduling', () => {
  it('arms strictly after now, never sooner than a minute, and skips a nightly that already exists', async () => {
    hub = await startHub();
    const b = hub.backups;
    // Noon UTC -> 03:00 tomorrow (unchanged).
    expect(new Date(b.schedule(Date.UTC(2026, 0, 1, 12, 0))).toISOString()).toBe('2026-01-02T03:00:00.000Z');
    // Right after the 03:00 run (the review's re-fire loop): tomorrow, not 1 s from now.
    expect(new Date(b.schedule(Date.UTC(2026, 0, 2, 3, 0, 0, 500))).toISOString()).toBe(
      '2026-01-03T03:00:00.000Z',
    );
    expect(new Date(b.schedule(Date.UTC(2026, 0, 2, 3, 0, 1))).toISOString()).toBe(
      '2026-01-03T03:00:00.000Z',
    );
    expect(new Date(b.schedule(Date.UTC(2026, 0, 2, 3, 30))).toISOString()).toBe('2026-01-03T03:00:00.000Z');
    // Shortly before 03:00 the target is today's, but the timer never fires sooner than a minute.
    const now = Date.UTC(2026, 0, 2, 2, 59, 50);
    expect(new Date(b.schedule(now)).toISOString()).toBe('2026-01-02T03:00:00.000Z');
    expect(MIN_SCHEDULE_DELAY_MS).toBe(60_000);
    b.stop();
    // A hub restarted after 03:00 finds today's file and does not write a second copy.
    const first = await b.nightly();
    expect(first).toMatchObject({ skipped: false });
    expect(first.file).toMatch(/^ordo-\d{4}-\d{2}-\d{2}\.db$/);
    const again = await b.nightly();
    expect(again).toEqual({ file: first.file, skipped: true });
    expect((await b.list()).files).toEqual([first.file]);
  });

  it('item 40: one time-zone source, settings.general.timeZone with ORDO_TZ as the fallback', async () => {
    hub = await startHub({ timeZone: 'Europe/Berlin' });
    expect(hub.timeZone()).toBe('Europe/Berlin'); // seeded from the config on first run
    const general = hub.lib.getSetting('general');
    hub.lib.putSetting('general', { ...general, timeZone: 'America/Los_Angeles' });
    expect(hub.timeZone()).toBe('America/Los_Angeles');
    // 03:00 PST is 11:00 UTC: the backup follows the settings zone, the same one countdowns use.
    expect(new Date(hub.backups.schedule(Date.UTC(2026, 0, 1, 12, 0))).toISOString()).toBe(
      '2026-01-02T11:00:00.000Z',
    );
    hub.backups.stop();
    hub.lib.putSetting('general', { ...general, timeZone: 'Mars/Olympus' });
    expect(hub.timeZone()).toBe('Europe/Berlin');
    expect(venueTimeZone('Nope/Nowhere', 'Also/Bad')).toBe('UTC');
  });
});

describe('item 15: operator timestamps are clamped to the hub clock', () => {
  it('replaces at outside [now - 500, now + 2000] by now + 33 and keeps at inside it', async () => {
    hub = await startHub();
    const pl = await livePlaylist(hub);
    const op = await login(hub.url, OPERATE_PIN);
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    for (const offset of [-10_000, -AT_PAST_MS - 1, AT_FUTURE_MS + 1, 60_000]) {
      const before = Date.now();
      await op.json('/live/events', { method: 'POST', json: { k: 'go', cueIndex: 0, at: before + offset } });
      const at = hub.live.state.layers.slide.at;
      expect(at).toBeGreaterThanOrEqual(before + AT_REPLACE_MS);
      expect(at).toBeLessThan(Date.now() + AT_REPLACE_MS + 100);
    }
    const kept = Date.now() + 1500;
    await op.json('/live/events', { method: 'POST', json: { k: 'next', at: kept } });
    expect(hub.live.state.layers.slide.at).toBe(kept);
    const past = Date.now() - 200;
    await op.json('/live/events', { method: 'POST', json: { k: 'prev', at: past } });
    expect(hub.live.state.layers.slide.at).toBe(past);
  });
});

describe('item 16: media.ended is believed only from the audio master', () => {
  it('rejects other outputs and the stage, accepts any output when no master is configured', async () => {
    hub = await startHub();
    const pl = await livePlaylist(hub);
    hub.live.submit({ k: 'goLive', playlistId: pl.id }, { role: 'operate' });
    const outs = hub.lib.getSetting('outputs');
    const master = outs.find((o) => o.audioMaster)!;
    const other = outs.find((o) => !o.audioMaster && o.kind === 'output')!;
    const stage = outs.find((o) => o.kind === 'stage')!;
    const ev = { k: 'media.ended', cueIndex: 0, at: Date.now() } as const;
    expect(() => hub!.live.submit(ev, { role: 'output', outputId: other.id })).toThrow(/audio master/);
    expect(() => hub!.live.submit(ev, { role: 'stage', outputId: stage.id })).toThrow(/stage display/);
    // The master gets past the origin check (and fails only on the stale check: nothing is playing).
    expect(() => hub!.live.submit(ev, { role: 'output', outputId: master.id })).toThrow(/stale/);
    hub.lib.putSetting(
      'outputs',
      outs.map((o) => ({ ...o, audioMaster: false })),
    );
    expect(() => hub!.live.submit(ev, { role: 'output', outputId: other.id })).toThrow(/stale/);
  });

  it('PUT /settings/outputs insists on exactly one enabled audio master', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const outs = hub.lib.getSetting('outputs');
    const put = (value: Output[]) => op.fetch('/settings/outputs', { method: 'PUT', json: value });
    const none = await put(outs.map((o) => ({ ...o, audioMaster: false })));
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: { message: string } }).error.message).toMatch(/none is set/);
    const two = await put(outs.map((o) => ({ ...o, audioMaster: o.kind === 'output' && o.hostIndex <= 2 })));
    expect(two.status).toBe(400);
    expect(((await two.json()) as { error: { message: string } }).error.message).toMatch(/2 are set/);
    const stage = await put(outs.map((o) => ({ ...o, audioMaster: o.kind === 'stage' })));
    expect(stage.status).toBe(400);
    const disabled = await put(outs.map((o) => (o.audioMaster ? { ...o, enabled: false } : o)));
    expect(disabled.status).toBe(400);
    expect((await put(outs.map((o) => ({ ...o, audioMaster: o.hostIndex === 2 })))).status).toBe(200);
    expect(hub.live.audioMasterId()).toBe(outs.find((o) => o.hostIndex === 2)!.id);
    expect(() => assertOneAudioMaster([])).toThrow(/none is set/);
  });
});

/** A WebSocket client that completes the upgrade and then never reads or answers again (a frozen tab). */
async function stuckSocket(base: string, cookie: string): Promise<Socket> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({
      host: u.hostname,
      port: u.port,
      path: '/ws',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        cookie,
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.on('error', () => {});
      // Say hello (a masked text frame), then stop reading: the server's close frame is never answered.
      const payload = Buffer.from(JSON.stringify({ t: 'hello', v: 1, role: 'operate', appVersion: '0.1.0' }));
      const mask = randomBytes(4);
      const frame = Buffer.alloc(2 + 4 + payload.length);
      frame[0] = 0x81;
      frame[1] = 0x80 | payload.length;
      mask.copy(frame, 2);
      for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i]! ^ mask[i % 4]!;
      socket.write(frame);
      socket.pause();
      resolve(socket);
    });
    req.on('error', reject);
    req.on('response', (res) => reject(new Error(`upgrade refused ${res.statusCode}`)));
    req.end();
  });
}

describe('item 17: shutdown with a stuck client', () => {
  it('stops jobs, snapshots the live state and exits within 2 s without a close handshake', async () => {
    hub = await startHub();
    const h = hub;
    const pl = await livePlaylist(h);
    const op = await login(h.url, OPERATE_PIN);
    h.live.submit({ k: 'goLive', playlistId: pl.id }, { role: 'operate' });
    h.live.submit({ k: 'next', at: Date.now() }, { role: 'operate' });
    // A job that only ends when its signal fires (an ffmpeg child is killed the same way).
    let aborted = false;
    h.jobs.register(
      'hang',
      (ctx) =>
        new Promise((_r, rej) =>
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            rej(new Error('cancelled'));
          }),
        ),
    );
    const job = h.jobs.enqueue('hang', {}, 'light');
    await sleep(50);
    expect(h.jobs.get(job.id).state).toBe('running');
    const stuck = await stuckSocket(h.url, op.cookie);
    const fine = await connectWs(h.url, { cookie: op.cookie });
    await fine.next(byType('welcome'));
    await sleep(50);
    expect(h.sockets.size).toBe(2);

    const t0 = Date.now();
    await h.close();
    const took = Date.now() - t0;
    expect(took).toBeLessThan(2000);
    expect(aborted).toBe(true);
    expect(await fine.next(byType('bye'))).toMatchObject({ reason: 'shutdown' });
    expect(stuck.destroyed).toBe(true);
    // The job is left queued for the next start; the live state was snapshotted at its final seq.
    const db = new (await import('better-sqlite3')).default(join(h.dir, 'ordo.db'), { readonly: true });
    expect((db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(job.id) as { state: string }).state).toBe(
      'queued',
    );
    expect((db.prepare(`SELECT seq FROM live_snapshot WHERE id = 1`).get() as { seq: number }).seq).toBe(2);
    db.close();
    hub = undefined;
    const { rmSync } = await import('node:fs');
    rmSync(h.dir, { recursive: true, force: true });
  });
});

/** Items 7, 18, 19: a fake importer with two presentations and one media file. */
function twoSongs(): Importers['importPro7'] {
  return () => {
    const mk = (id: string, title: string): Presentation => {
      const sid = newId();
      return {
        ...song(title),
        id,
        sections: [{ id: sid, label: 'Verse 1', short: 'V1', slides: [] }],
        arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid] }],
        backgroundMediaId: 'pro7media:Media/bg.png',
        source: { kind: 'pro7' },
      };
    };
    const a = mk('11111111-1111-4111-8111-111111111111', 'Song A');
    const b = mk('22222222-2222-4222-8222-222222222222', 'Song B');
    const pl: Playlist = {
      id: '33333333-3333-4333-8333-333333333333',
      rev: 1,
      name: 'Imported',
      items: [
        { id: newId(), kind: 'presentation', presentationId: a.id },
        { id: newId(), kind: 'presentation', presentationId: b.id },
      ],
    };
    const r: Pro7Result = {
      presentations: [a, b],
      playlists: [pl],
      media: [{ key: 'pro7media:Media/bg.png', path: 'Media/bg.png' }],
      log: [],
      protoVersion: 'test',
    };
    return r;
  };
}

async function libraryZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('Library/Song A.pro', new Uint8Array([1, 2, 3]));
  zip.file('Library/Song B.pro', new Uint8Array([4, 5, 6]));
  zip.file('Media/bg.png', readFileSync(fixtures.png(fx)));
  zip.file('Media/clip.mp4', Buffer.alloc(2 * 1024 * 1024, 9)); // spilled to disk, never a media item
  return zip.generateAsync({ type: 'uint8array' });
}

describe('items 18 and 19: resumable, idempotent imports that refuse to run during a service', () => {
  it('records resume points, skips them after a restart and updates earlier copies on re-import', async () => {
    let remaps = 0;
    let stopOnce = true;
    hub = await startHub({
      importers: {
        importPro7: twoSongs(),
        readZip,
        remapMediaIds: <T>(obj: T, map: Map<string, string>): T => {
          remaps++;
          // Shut the queue down while the first presentation is being saved: a restart mid-import.
          if (stopOnce && (obj as { kind?: string }).kind === 'song') {
            stopOnce = false;
            void hub!.jobs.stop();
          }
          return remapMediaIds(obj, map);
        },
      } satisfies Importers,
    });
    const ed = await login(hub.url, EDIT_PIN);
    const fd = new FormData();
    fd.append('file', new Blob([(await libraryZip()) as Uint8Array<ArrayBuffer>]), 'library.zip');
    const job = await ed.json<Job>('/import/pro7', { method: 'POST', body: fd });
    await sleep(100);
    for (let i = 0; i < 100 && hub.jobs.get(job.id).state === 'running'; i++) await sleep(50);
    expect(hub.jobs.get(job.id).state).toBe('queued');
    const payload = JSON.parse(
      (hub.db.prepare(`SELECT payload FROM jobs WHERE id = ?`).get(job.id) as { payload: string }).payload,
    ) as { done: { media: Record<string, string>; presentations: Record<string, string> } };
    expect(Object.keys(payload.done.media)).toEqual(['pro7media:Media/bg.png']);
    expect(Object.keys(payload.done.presentations)).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(remaps).toBe(1);
    // Resume: Song A and the media are skipped; Song B and the playlist are written once.
    hub.jobs.start();
    await hub.jobs.idle();
    const done = hub.jobs.get(job.id);
    expect(done.state).toBe('done');
    expect(done.result).toMatchObject({ presentations: 2, playlists: 1, media: 1 });
    expect(done.log.join('\n')).toMatch(/resuming: 2 item\(s\)/);
    expect(remaps).toBe(3); // Song B + the playlist
    const pro7 = () => hub!.lib.presentations.list().filter((p) => p.source?.kind === 'pro7');
    expect(
      pro7()
        .map((p) => p.title)
        .sort(),
    ).toEqual(['Song A', 'Song B']);
    expect(hub.lib.media.list().filter((m) => m.tags.includes('pro7')).length).toBe(1);
    expect(hub.lib.playlists.list().filter((p) => p.name === 'Imported').length).toBe(1);
    expect(existsSync(hub.jobs.get(job.id).id)).toBe(false);
    // tmp/ holds nothing of the import afterwards (the spilled clip and the inflated documents are gone).
    expect(readdirSync(join(hub.dir, 'tmp'))).toEqual([]);

    // Importing the same library again updates the same ids instead of duplicating them.
    const fd2 = new FormData();
    fd2.append('file', new Blob([(await libraryZip()) as Uint8Array<ArrayBuffer>]), 'library.zip');
    const job2 = await ed.json<Job>('/import/pro7', { method: 'POST', body: fd2 });
    await hub.jobs.idle();
    expect(hub.jobs.get(job2.id).state).toBe('done');
    expect(
      pro7()
        .map((p) => [p.title, p.rev])
        .sort(),
    ).toEqual([
      ['Song A', 2],
      ['Song B', 2],
    ]);
    expect(
      hub.lib.playlists
        .list()
        .filter((p) => p.name === 'Imported')
        .map((p) => p.rev),
    ).toEqual([2]);
    expect(hub.lib.media.list().filter((m) => m.tags.includes('pro7')).length).toBe(1);
  });

  it('answers 423 to imports while a playlist is live', async () => {
    hub = await startHub();
    const pl = await livePlaylist(hub);
    const ed = await login(hub.url, EDIT_PIN);
    hub.live.submit({ k: 'goLive', playlistId: pl.id }, { role: 'operate' });
    const res = await ed.fetch('/import/pro7', { method: 'POST', json: { path: '/etc' } });
    expect(res.status).toBe(423);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/end the service/);
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(fixtures.pdf(fx, 1))]), 'x.pdf');
    expect((await ed.fetch('/import/document', { method: 'POST', body: fd })).status).toBe(423);
    hub.live.submit({ k: 'endService', at: Date.now() }, { role: 'operate' });
    expect((await ed.fetch('/import/pro7', { method: 'POST', json: { path: '/etc' } })).status).toBe(403);
  });

  it('item 19: decodes ProPresenter libraries in a worker thread', async () => {
    const r = await importPro7InWorker(new Map([['Library/Nothing.txt', new Uint8Array([1, 2, 3])]]));
    expect(r.presentations).toEqual([]);
    expect(typeof r.protoVersion).toBe('string');
    expect(r.log[0]?.message).toMatch(/ProPresenter 7 proto/);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(importPro7InWorker(new Map(), ctrl.signal)).rejects.toThrow(/cancelled/);
  });
});

describe('item 34: live event schemas are strict and bounded', () => {
  it('rejects unknown keys, negative or huge indices and a day-long message ttl', async () => {
    hub = await startHub();
    const pl = await livePlaylist(hub);
    const op = await login(hub.url, OPERATE_PIN);
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    const post = (event: unknown) => op.fetch('/live/events', { method: 'POST', json: event });
    const at = Date.now();
    expect((await post({ k: 'go', cueIndex: -1, at })).status).toBe(400);
    expect((await post({ k: 'go', cueIndex: 1.5, at })).status).toBe(400);
    expect((await post({ k: 'go', cueIndex: 10_000_000, at })).status).toBe(400);
    expect((await post({ k: 'go', cueIndex: 0, at, extra: true })).status).toBe(400);
    expect((await post({ k: 'next', at: -5 })).status).toBe(400);
    expect((await post({ k: 'next', at: Number.NaN })).status).toBe(400);
    expect((await post({ k: 'goToSection', sectionIndex: -1, at })).status).toBe(400);
    expect(
      (await post({ k: 'message.send', id: newId(), text: 'hi', ttlMs: 7 * 86_400_000, at })).status,
    ).toBe(400);
    expect((await post({ k: 'message.send', id: newId(), text: 'hi', ttlMs: -1, at })).status).toBe(400);
    expect((await post({ k: 'goLive', playlistId: pl.id, resolved: {} })).status).toBe(400);
    expect((await post({ k: 'message.send', id: newId(), text: 'hi', ttlMs: 60_000, at })).status).toBe(200);
    expect((await post({ k: 'go', cueIndex: 0, at })).status).toBe(200);
  });
});

describe('item 38: HEAD /files', () => {
  it('answers the real Content-Length and type without a body', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const png = readFileSync(fixtures.png(fx));
    const fd = new FormData();
    fd.append('file', new Blob([png]), 'logo.png');
    await ed.fetch('/media', { method: 'POST', body: fd });
    await hub.jobs.idle();
    const m = hub.lib.media.list()[0]!;
    const res = await ed.fetch(`/files/${m.original.hash}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(png.length));
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('etag')).toBe(`"${m.original.hash}"`);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    const part = await ed.fetch(`/files/${m.original.hash}`, {
      method: 'HEAD',
      headers: { range: 'bytes=0-9' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-length')).toBe('10');
    expect(part.headers.get('content-range')).toBe(`bytes 0-9/${png.length}`);
    const get = await ed.fetch(`/files/${m.original.hash}`);
    expect((await get.arrayBuffer()).byteLength).toBe(png.length);
  });
});

describe('item 39: scratch files, pre-restore copies and snapshot deltas', () => {
  it('wipes tmp/ at startup and keeps only the newest pre-restore copies', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'tmp', 'job-1'), { recursive: true });
    writeFileSync(join(dir, 'tmp', 'job-1', 'partial.mp4'), 'x');
    writeFileSync(join(dir, 'tmp', 'stray.png'), 'x');
    hub = await startHub({ dataDir: dir });
    expect(readdirSync(join(dir, 'tmp'))).toEqual([]);
    const backups = join(dir, 'backups');
    const now = Date.now();
    for (let i = 0; i < PRE_RESTORE_KEEP + 2; i++) {
      const f = join(backups, `ordo-pre-restore-2026-01-0${i + 1}T00-00-00.db`);
      writeFileSync(f, 'x');
      const t = new Date(now - (PRE_RESTORE_KEEP + 2 - i) * 3600_000);
      utimesSync(f, t, t);
    }
    const old = join(backups, 'ordo-pre-restore-2000-01-01T00-00-00.db');
    writeFileSync(old, 'x');
    utimesSync(old, new Date(now - 40 * 86400_000), new Date(now - 40 * 86400_000));
    const removed = await hub.backups.prune(now);
    expect(removed.sort()).toEqual([
      'ordo-pre-restore-2000-01-01T00-00-00.db',
      'ordo-pre-restore-2026-01-01T00-00-00.db',
      'ordo-pre-restore-2026-01-02T00-00-00.db',
    ]);
    expect(readdirSync(backups).filter((f) => f.startsWith('ordo-pre-restore-')).length).toBe(
      PRE_RESTORE_KEEP,
    );
  });

  it('GET /library/snapshot?since= returns deltas, else the full snapshot', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const op = await login(hub.url, OPERATE_PIN);
    const full = await ed.json<LibrarySnapshot>('/library/snapshot');
    const seq0 = full.seq;
    expect(full.presentations).toEqual([]);
    const p = await ed.json<Presentation>('/presentations', { method: 'POST', json: song('Delta song') });
    await ed
      .json('/presentations', { method: 'POST', json: song('Gone') })
      .then((g) => ed.fetch(`/presentations/${(g as Presentation).id}`, { method: 'DELETE' }));
    const general = hub.lib.getSetting('general');
    await op.json('/settings/general', { method: 'PUT', json: { ...general, venueName: 'Delta' } });
    const d = await ed.json<LibrarySnapshotDelta>(`/library/snapshot?since=${seq0}`);
    expect(d.since).toBe(seq0);
    expect(d.seq).toBe(hub.lib.seq());
    expect(d.changes.map((c) => `${c.kind}:${c.deleted ? 'del' : 'set'}`).sort()).toEqual([
      'presentation:del',
      'presentation:set',
      'settings:set',
    ]);
    const saved = d.changes.find((c) => c.kind === 'presentation' && !c.deleted)!;
    expect(saved).toMatchObject({ id: p.id, rev: 1 });
    expect((saved.entity as Presentation).title).toBe('Delta song');
    expect((d.changes.find((c) => c.kind === 'settings')!.entity as { venueName: string }).venueName).toBe(
      'Delta',
    );
    // Nothing new: an empty delta. Ahead of the hub or malformed: full snapshot / 400.
    expect(await ed.json<LibrarySnapshotDelta>(`/library/snapshot?since=${d.seq}`)).toEqual({
      seq: d.seq,
      since: d.seq,
      changes: [],
    });
    expect('presentations' in ((await ed.json(`/library/snapshot?since=${d.seq + 100}`)) as object)).toBe(
      true,
    );
    expect((await ed.fetch('/library/snapshot?since=abc')).status).toBe(400);
    // Tokens only for the operate role, in deltas as in snapshots.
    const outputs = hub.lib.getSetting('outputs');
    await op.json('/settings/outputs', { method: 'PUT', json: outputs });
    const edDelta = await ed.json<LibrarySnapshotDelta>(`/library/snapshot?since=${d.seq}`);
    const opDelta = await op.json<LibrarySnapshotDelta>(`/library/snapshot?since=${d.seq}`);
    const tokens = (x: LibrarySnapshotDelta) =>
      (x.changes.find((c) => c.kind === 'settings' && c.id === 'outputs')!.entity as Output[]).map(
        (o) => o.token,
      );
    expect(tokens(edDelta).every((t) => t === undefined)).toBe(true);
    expect(tokens(opDelta).every((t) => typeof t === 'string')).toBe(true);
    // A database from before the change log answers full snapshots for old seqs.
    hub.db.prepare(`DELETE FROM library_changes`).run();
    expect('presentations' in ((await ed.json(`/library/snapshot?since=${seq0}`)) as object)).toBe(true);
  });
});

describe('item 40: Host allow-list and X-Forwarded-Host', () => {
  it('allows the domain, its labels, localhost and loopback; refuses anything else with 421', () => {
    expect(hostAllowed('venue.example', 'venue.example')).toBe(true);
    expect(hostAllowed('out3.venue.example', 'venue.example')).toBe(true);
    expect(hostAllowed('localhost', 'venue.example')).toBe(true);
    expect(hostAllowed('op.localhost', 'venue.example')).toBe(true);
    expect(hostAllowed('127.0.0.1', 'venue.example')).toBe(true);
    expect(hostAllowed('::1', 'venue.example')).toBe(true);
    expect(hostAllowed('evil.example', 'venue.example')).toBe(false);
    expect(hostAllowed('venue.example.evil.net', 'venue.example')).toBe(false);
    expect(hostAllowed('', 'venue.example')).toBe(false);
    expect(hostAllowed('10.0.0.5', 'venue.example', ['10.0.0.5'])).toBe(true);
    expect(hostnameOf('Op.Venue.Example:8443')).toBe('op.venue.example');
    expect(hostnameOf('[::1]:8080')).toBe('::1');
  });

  it('serves only allowed hosts, honours X-Forwarded-Host from the trusted proxy only', async () => {
    hub = await startHub({ domain: 'venue.example', trustedProxies: ['127.0.0.1/32'] });
    const ok = await raw(hub.url, '/api/v1/health', { host: 'op.venue.example' });
    expect(ok.status).toBe(200);
    const bad = await raw(hub.url, '/api/v1/health', { host: 'evil.example' });
    expect(bad.status).toBe(421);
    expect(JSON.parse(bad.body)).toMatchObject({ error: { code: 'misdirected' } });
    expect((await raw(hub.url, '/', { host: 'evil.example' })).status).toBe(421);
    // Through the proxy the browser's host arrives in X-Forwarded-Host and drives routing and the CSP.
    const fwd = await raw(hub.url, '/', { host: '127.0.0.1:8080', 'x-forwarded-host': 'out2.venue.example' });
    expect(fwd.status).toBe(200);
    expect(fwd.body).toContain('ordo output');
    expect(fwd.headers['content-security-policy']).toMatch(/wss:\/\/out2\.venue\.example/);
    expect(
      (await raw(hub.url, '/', { host: '127.0.0.1:8080', 'x-forwarded-host': 'evil.example' })).status,
    ).toBe(421);
    // The WebSocket upgrade goes through the same check.
    const ws = new WebSocket(`${hub.url.replace(/^http/, 'ws')}/ws`, { headers: { host: 'evil.example' } });
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
      ws.on('open', () => resolve(101));
    });
    expect(status).toBe(421);
    await hub.cleanup();
    // Without a trusted proxy the header is ignored: a spoofed X-Forwarded-Host cannot pick the app.
    hub = await startHub({ domain: 'venue.example' });
    const spoof = await raw(hub.url, '/', {
      host: '127.0.0.1:8080',
      'x-forwarded-host': 'out2.venue.example',
    });
    expect(spoof.status).toBe(200);
    expect(spoof.body).toContain('ordo operator');
    expect(
      (await raw(hub.url, '/', { host: '127.0.0.1:8080', 'x-forwarded-host': 'evil.example' })).status,
    ).toBe(200);
  });
});

describe('preview relay (prd/03 send to preview)', () => {
  it('relays operator preview messages to the named output with from stamped; outputs and edit cannot send', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const ed = await login(hub.url, EDIT_PIN);
    const outs = hub.lib.getSetting('outputs');
    const out = outs[0]!;
    const other = outs[1]!;
    const a = await connectWs(hub.url, { cookie: op.cookie });
    await a.next(byType('welcome'));
    const e = await connectWs(hub.url, { cookie: ed.cookie, hello: { role: 'edit' } });
    await e.next(byType('welcome'));
    const o = await connectWs(hub.url, { token: out.token, hello: { role: 'output', outputId: out.id } });
    await o.next(byType('welcome'));
    const o2 = await connectWs(hub.url, {
      token: other.token,
      hello: { role: 'output', outputId: other.id },
    });
    await o2.next(byType('welcome'));
    const pres = song('Preview me');
    a.send({ t: 'preview', to: out.id, presentation: pres, slideId: pres.sections[0]!.slides[0]!.id });
    const got = await o.next(byType('preview'));
    expect(got).toMatchObject({ from: 'operator', to: out.id, slideId: pres.sections[0]!.slides[0]!.id });
    expect((got.presentation as Presentation).title).toBe('Preview me');
    a.send({ t: 'preview', to: out.id, clear: true });
    expect(await o.next(byType('preview'))).toMatchObject({ from: 'operator', clear: true });
    // Not from an output, not from the edit role, and never to a different output.
    o2.send({ t: 'preview', to: out.id, clear: true });
    e.send({ t: 'preview', to: out.id, clear: true });
    await sleep(200);
    expect(o.messages.filter((m) => m.t === 'preview').length).toBe(2);
    expect(o2.messages.filter((m) => m.t === 'preview').length).toBe(0);
    expect(a.messages.filter((m) => m.t === 'preview').length).toBe(0);
    for (const c of [a, e, o, o2]) c.close();
  });
});

// Keep the untyped helper import used (the client helper builds token clients in other suites).
void client;
void (null as unknown as LiveState);
