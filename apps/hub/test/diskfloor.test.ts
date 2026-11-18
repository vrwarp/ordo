/**
 * The hub disk's free-space floor (design/29 §1.3, A25, W44): FL1-FL7. The floor is read from an injected
 * statfs, so no test depends on the volume it runs on (a test hub that meets this machine's real volume is the
 * integrator's chore, ORDO_MIN_FREE_GB=0).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computedFloor,
  DiskFloor,
  diskMessage,
  formatGb,
  GIB,
  minFreeConfig,
  type StatFsFn,
} from '../src/diskfloor.ts';
import { loadConfig } from '../src/config.ts';
import { type client, EDIT_PIN, login, OPERATE_PIN, sleep, song, startHub } from './helpers.ts';
import { phone, refusal, twoProcesses } from './phones-helpers.ts';

/** A volume of `total` bytes with `free` bytes free, changeable by the test. */
function volume(free: number, total = 100 * GIB) {
  const v = { free, total, calls: 0, fail: false };
  const statfs: StatFsFn = async () => {
    v.calls++;
    if (v.fail) throw new Error('statfs failed');
    return { bsize: 4096, bavail: Math.floor(v.free / 4096), blocks: Math.floor(v.total / 4096) };
  };
  return Object.assign(v, { statfs });
}

const png = () =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

const form = (name = 'a.png') => {
  const fd = new FormData();
  fd.append('file', new Blob([png()]), name);
  return fd;
};

describe('the formula (FL3)', () => {
  it('is 5 % of the volume, at least 5 GiB and at most 25 GiB', () => {
    // 100 GB: 5 % is 4.7 GiB, the least applies; 200 GB: 9.3 GiB; 1 TB: 5 % is 46 GiB, the most applies.
    expect(computedFloor(100e9)).toBe(5 * GIB);
    expect(computedFloor(200e9)).toBe(10e9);
    expect(computedFloor(200e9) / GIB).toBeCloseTo(9.3, 1);
    expect(computedFloor(1e12)).toBe(25 * GIB);
    expect(computedFloor(4e12)).toBe(25 * GIB);
    expect(computedFloor(16 * GIB)).toBe(5 * GIB);
  });

  it('is replaced by ORDO_MIN_FREE_GB, which reads whole GB from 0 to 10000', () => {
    expect(minFreeConfig(undefined)).toEqual({});
    expect(minFreeConfig('')).toEqual({});
    expect(minFreeConfig('12')).toEqual({ bytes: 12 * GIB });
    expect(minFreeConfig('0')).toEqual({ bytes: 0 });
    expect(minFreeConfig('10000')).toEqual({ bytes: 10_000 * GIB });
    for (const bad of ['10001', '-1', '1.5', 'abc', '5 GB', '1e3', '99999999']) {
      const r = minFreeConfig(bad);
      expect(r.bytes, bad).toBeUndefined();
      expect(r.warning, bad).toMatch(/ORDO_MIN_FREE_GB/);
    }
    const f = new DiskFloor('/x', { statfs: volume(1).statfs, minFreeBytes: 7 * GIB });
    expect(f.floorBytes(200e9)).toBe(7 * GIB);
    expect(loadConfig({ ORDO_MIN_FREE_GB: '9' }).minFreeBytes).toBe(9 * GIB);
    expect(loadConfig({ ORDO_MIN_FREE_GB: 'nine' }).minFreeBytes).toBeUndefined();
    expect(loadConfig({ ORDO_MIN_FREE_GB: 'nine' }).minFreeWarning).toMatch(/ORDO_MIN_FREE_GB/);
    expect(loadConfig({}).minFreeBytes).toBeUndefined();
  });

  it("says design 29's W44 with the free space in GB, one decimal, rounded down", () => {
    expect(formatGb(3.2 * GIB)).toBe('3.2 GB');
    expect(formatGb(3.99 * GIB)).toBe('3.9 GB');
    expect(formatGb(0)).toBe('0.0 GB');
    expect(diskMessage(3.2 * GIB)).toBe(
      "The hub's disk is almost full (3.2 GB free). New uploads and pictures are paused so the service keeps running. Delete old media or presentations.",
    );
  });
});

describe('DiskFloor', () => {
  it('measures at most once per 2 s under 200 requests (FL4)', async () => {
    const v = volume(50 * GIB);
    let now = 1_000_000;
    const f = new DiskFloor('/x', { statfs: v.statfs, now: () => now });
    await Promise.all(Array.from({ length: 200 }, () => f.assertRoom(1024)));
    expect(v.calls).toBe(1);
    now += 1999;
    await f.assertRoom();
    expect(v.calls).toBe(1);
    now += 2;
    await f.assertRoom();
    expect(v.calls).toBe(2);
  });

  it('refuses when free space less the declared size falls under the floor, with the numbers (FL1)', async () => {
    const v = volume(6 * GIB); // floor 5 GiB
    const f = new DiskFloor('/x', { statfs: v.statfs });
    await f.assertRoom(0);
    await f.assertRoom(GIB);
    await expect(f.assertRoom(1.5 * GIB)).rejects.toMatchObject({
      status: 507,
      code: 'disk',
      extra: { reason: 'disk', freeBytes: 6 * GIB, floorBytes: 5 * GIB },
    });
    expect((await f.state()).low).toBe(false);
  });

  it('fails open: a statfs that fails or reports nothing refuses nothing, warns once and shows no numbers (FL5)', async () => {
    const v = volume(0);
    v.fail = true;
    const warnings: string[] = [];
    let now = 0;
    const f = new DiskFloor('/x', { statfs: v.statfs, now: () => now, warn: (m) => warnings.push(m) });
    await f.assertRoom(10 * GIB);
    now += 5000;
    await f.assertRoom(10 * GIB);
    now += 5000;
    expect(await f.state()).toEqual({ known: false, low: false });
    expect(f.healthFields()).toEqual({});
    expect(warnings).toHaveLength(1);
    // zeros are not a volume either
    const z = new DiskFloor('/x', {
      statfs: async () => ({ bsize: 0, bavail: 0, blocks: 0 }),
      warn: (m) => warnings.push(m),
    });
    await z.assertRoom(1);
    expect(z.healthFields()).toEqual({});
    expect(warnings).toHaveLength(2);
    // and it measures again later: a volume that answers again is judged again
    v.fail = false;
    v.free = GIB;
    now += 5000;
    await f.assertRoom(0).then(
      () => expect.unreachable('the floor applies again'),
      (e) => expect(e).toMatchObject({ status: 507 }),
    );
  });

  it('is off with ORDO_MIN_FREE_GB=0: nothing is refused, the free space still shows with floorBytes 0 (FL7)', async () => {
    const v = volume(GIB);
    const warnings: string[] = [];
    const f = new DiskFloor('/x', { statfs: v.statfs, minFreeBytes: 0, warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/floor is off/);
    await f.assertRoom(50 * GIB);
    expect(await f.state()).toMatchObject({ known: true, freeBytes: GIB, floorBytes: 0, low: false });
    expect(f.healthFields()).toEqual({ diskFreeBytes: GIB, diskFloorBytes: 0 });
  });
});

describe('the routes (FL1, FL2, FL6)', () => {
  /** Every route that stores a user's file, as an edit session sends it. */
  const stores: [string, (c: ReturnType<typeof client>) => Promise<Response>][] = [
    ['POST /media', (c) => c.fetch('/media', { method: 'POST', body: form() })],
    ['PUT /media/:id/still', (c) => c.fetch('/media/m1/still', { method: 'PUT', body: form('still.png') })],
    [
      'POST /media/uploads',
      (c) => c.fetch('/media/uploads', { method: 'POST', json: { name: 'a.png', size: 1000 } }),
    ],
    [
      'PATCH /media/uploads/:id',
      (c) =>
        c.fetch('/media/uploads/u1', {
          method: 'PATCH',
          headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': '0' },
          body: png(),
        }),
    ],
    ['POST /fonts/upload', (c) => c.fetch('/fonts/upload', { method: 'POST', body: form('a.ttf') })],
    ['POST /fonts/google', (c) => c.fetch('/fonts/google', { method: 'POST', json: { family: 'Inter' } })],
    [
      'POST /import/songselect',
      (c) => c.fetch('/import/songselect', { method: 'POST', json: { text: 'Title\n\nVerse' } }),
    ],
    ['POST /import/pro7', (c) => c.fetch('/import/pro7', { method: 'POST', json: { path: '/x.pro' } })],
    ['POST /import/document', (c) => c.fetch('/import/document', { method: 'POST', body: form('a.pptx') })],
    [
      'POST /presentations/:id/pptx-reference',
      (c) => c.fetch('/presentations/p1/pptx-reference', { method: 'POST', body: form('a.pdf') }),
    ],
    [
      'POST /presentations/:id/pptx-reimport',
      (c) => c.fetch('/presentations/p1/pptx-reimport', { method: 'POST', json: {} }),
    ],
  ];

  it('answers 507 with W44, reason disk and both numbers on every route that stores a file (FL1)', async () => {
    const v = volume(GIB, 100 * GIB);
    const hub = await startHub({ statfs: v.statfs });
    const ed = await login(hub.url, EDIT_PIN);
    for (const [name, call] of stores) {
      const res = await call(ed);
      const err = await refusal(res);
      expect(res.status, name).toBe(507);
      expect(err, name).toMatchObject({
        code: 'disk',
        reason: 'disk',
        freeBytes: GIB,
        floorBytes: 5 * GIB,
        message: diskMessage(GIB),
      });
    }
    // a phone (cap light) is refused the same on the routes it may reach
    const ph = await phone(hub.url);
    const res = await ph.fetch('/media', { method: 'POST', body: form() });
    expect(res.status).toBe(507);
  });

  it('keeps the .part and its row of a resumable upload refused for room, and resumes when room is made (FL1)', async () => {
    const v = volume(50 * GIB);
    const hub = await startHub({ statfs: v.statfs });
    const ed = await login(hub.url, EDIT_PIN);
    const bytes = png();
    const created = await ed.json<{ id: string }>('/media/uploads', {
      method: 'POST',
      json: { name: 'a.png', size: bytes.length },
    });
    const part = join(hub.dir, 'uploads', `${created.id}.part`);
    expect(existsSync(part)).toBe(true);
    v.free = GIB;
    await sleep(2100); // the measurement is reused for 2 s
    const patch = () =>
      ed.fetch(`/media/uploads/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': '0' },
        body: bytes,
      });
    expect((await patch()).status).toBe(507);
    expect(existsSync(part)).toBe(true);
    expect(
      (hub.db.prepare(`SELECT offset FROM uploads WHERE id = ?`).get(created.id) as { offset: number })
        .offset,
    ).toBe(0);
    v.free = 50 * GIB;
    await sleep(2100);
    const ok = await patch();
    expect(ok.status).toBe(201);
  }, 20_000);

  it('declares the size of a resumable create against the floor (FL1)', async () => {
    const v = volume(8 * GIB); // 3 GiB over the floor
    const hub = await startHub({ statfs: v.statfs });
    const ed = await login(hub.url, EDIT_PIN);
    const small = await ed.fetch('/media/uploads', {
      method: 'POST',
      json: { name: 'a.mp4', size: 2 * GIB },
    });
    expect(small.status).toBe(201);
    const big = await ed.fetch('/media/uploads', { method: 'POST', json: { name: 'b.mp4', size: 4 * GIB } });
    expect(big.status).toBe(507);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe('disk');
  });

  it('refuses nothing else while the volume is low: saves, deletes, reads, settings, GO (FL2)', async () => {
    const v = volume(GIB);
    const hub = await startHub({ statfs: v.statfs });
    const op = await login(hub.url, OPERATE_PIN);
    const p = await op.json<{ id: string; rev: number }>('/presentations', { method: 'POST', json: song() });
    const saved = await op.json<{ rev: number }>(`/presentations/${p.id}`, {
      method: 'PUT',
      json: { ...song(), id: p.id, rev: p.rev, title: 'Changed' },
    });
    expect(saved.rev).toBe(p.rev + 1);
    const pl = await op.json<{ id: string; rev: number; items: unknown[] }>('/playlists', {
      method: 'POST',
      json: { name: 'Sunday', items: [{ id: 'i1', kind: 'presentation', presentationId: p.id }] },
    });
    await op.json(`/playlists/${pl.id}`, { method: 'PUT', json: { ...pl, name: 'Sunday 2' } });
    const general = await op.json<Record<string, unknown>>('/settings/general');
    await op.json('/settings/general', { method: 'PUT', json: general });
    for (const path of ['/library/snapshot', '/presentations', '/media', '/fonts', '/playlists', '/settings'])
      expect((await op.fetch(path)).status, path).toBe(200);
    expect((await op.fetch('/files/' + '0'.repeat(64))).status).toBe(404);
    expect((await op.fetch('/health')).status).toBe(200);
    const live = await op.json<{ seq: number }>('/live/events', {
      method: 'POST',
      json: { k: 'goLive', playlistId: pl.id },
    });
    expect(live.seq).toBe(1);
    expect(
      (await op.fetch('/live/events', { method: 'POST', json: { k: 'next', at: Date.now() } })).status,
    ).toBe(200);
    await op.fetch('/live/events', { method: 'POST', json: { k: 'endService', at: Date.now() } });
    expect((await op.fetch(`/presentations/${p.id}`, { method: 'DELETE' })).status).toBe(204);
    // and the one upload route is still refused
    expect((await op.fetch('/media', { method: 'POST', body: form() })).status).toBe(507);
  });

  it('carries both numbers in GET /health of a one-process hub, and the floor 0 when it is off (FL6)', async () => {
    const hub = await startHub({ statfs: volume(40 * GIB).statfs });
    const health = async () =>
      (await (await fetch(`${hub.url}/api/v1/health`)).json()) as Record<string, number>;
    const end = Date.now() + 5000;
    let h = await health();
    while (h.diskFreeBytes === undefined && Date.now() < end) {
      await sleep(50);
      h = await health();
    }
    expect(h.diskFreeBytes).toBe(40 * GIB);
    expect(h.diskFloorBytes).toBe(5 * GIB);
    const off = await startHub({ statfs: volume(40 * GIB).statfs, minFreeBytes: 0 });
    let o = (await (await fetch(`${off.url}/api/v1/health`)).json()) as Record<string, number>;
    const end2 = Date.now() + 5000;
    while (o.diskFreeBytes === undefined && Date.now() < end2) {
      await sleep(50);
      o = (await (await fetch(`${off.url}/api/v1/health`)).json()) as Record<string, number>;
    }
    expect(o.diskFreeBytes).toBe(40 * GIB);
    expect(o.diskFloorBytes).toBe(0);
  });

  it('carries both numbers in GET /health of a two-process hub, reported by the library after a refusal (FL6)', async () => {
    const v = volume(GIB);
    let stats: Record<string, unknown> | undefined;
    let liveRef: { setLibraryStats(s: never): void } | undefined;
    const tp = await twoProcesses(
      0,
      { statfs: v.statfs },
      {
        onStats: (s) => {
          stats = s as unknown as Record<string, unknown>;
          liveRef?.setLibraryStats(s as never);
        },
      },
    );
    try {
      liveRef = tp.live as unknown as typeof liveRef;
      if (stats) liveRef?.setLibraryStats(stats as never);
      const ed = await login(tp.base, EDIT_PIN);
      expect((await ed.fetch('/media', { method: 'POST', body: form() })).status).toBe(507);
      const end = Date.now() + 5000;
      let h = (await (await fetch(`${tp.base}/api/v1/health`)).json()) as Record<string, number>;
      while (h.diskFreeBytes === undefined && Date.now() < end) {
        await sleep(50);
        h = (await (await fetch(`${tp.base}/api/v1/health`)).json()) as Record<string, number>;
      }
      expect(h.diskFreeBytes).toBe(GIB);
      expect(h.diskFloorBytes).toBe(5 * GIB);
      // the library alone checked the floor; the live process still serves GO with the disk "full"
      const op = await login(tp.base, OPERATE_PIN);
      const p = await op.json<{ id: string }>('/presentations', { method: 'POST', json: song() });
      const pl = await op.json<{ id: string }>('/playlists', {
        method: 'POST',
        json: { name: 'S', items: [{ id: 'i1', kind: 'presentation', presentationId: p.id }] },
      });
      const go = await op.json<{ seq: number }>('/live/events', {
        method: 'POST',
        json: { k: 'goLive', playlistId: pl.id },
      });
      expect(go.seq).toBe(1);
    } finally {
      await tp.close();
    }
  });
});
