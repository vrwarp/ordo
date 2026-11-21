/**
 * Pictures of pre-rendered slides on the hub (design/29 §1.3): PP1-PP9, and PA1-PA4 (the announcement to the live
 * loop) and BU2 (the budget) in their own steps. The pictures are real PNGs and WebPs made by a few lines of zlib
 * and RIFF writing; the keys are the hub's own rows.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { newId, type Presentation } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { COLLECT_DELAY_DAYS, Collector } from '../src/collect.ts';
import { GIB } from '../src/diskfloor.ts';
import {
  byType,
  client,
  connectWs,
  EDIT_PIN,
  login,
  OPERATE_PIN,
  sleep,
  startHub,
  type TestHub,
} from './helpers.ts';
import { phone, refusal } from './phones-helpers.ts';
import { bigSlide, fullOf, makePng, makeWebp, presentationOf, uploadSlideFile } from './prerender-helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

type Client = ReturnType<typeof client>;
const keysOf = (id: string, rev?: number) =>
  (
    hub!.db
      .prepare(
        `SELECT DISTINCT key FROM prerender_keys WHERE presentation_id = ? ${rev === undefined ? '' : 'AND rev = ?'} ORDER BY key`,
      )
      .all(...(rev === undefined ? [id] : [id, rev])) as { key: string }[]
  ).map((r) => r.key);
const picRows = (id: string) =>
  hub!.db.prepare(`SELECT * FROM prerenders WHERE presentation_id = ? ORDER BY key, size`).all(id) as Record<
    string,
    unknown
  >[];

/** A hub with one presentation that has one pre-rendered slide and its key. */
async function setup() {
  hub = await startHub();
  const ed = await login(hub.url, EDIT_PIN);
  const op = await login(hub.url, OPERATE_PIN);
  const f = fullOf();
  await uploadSlideFile(ed, f.pages);
  const p = await ed.json<Presentation>('/presentations', {
    method: 'POST',
    json: presentationOf([f.standIn]),
  });
  const [key] = keysOf(p.id);
  if (!key) throw new Error('no key row');
  return { ed, op, f, p, key };
}

const put = (c: Client, id: string, key: string, body: Buffer, size = 640, type = 'image/png', query = '') =>
  c.fetch(`/presentations/${id}/prerenders/${key}?size=${size}${query}`, {
    method: 'PUT',
    headers: { 'content-type': type },
    body: new Uint8Array(body),
  });
const small = () => makePng(640, 360, { seed: 1 });

describe('the picture route (PP1-PP3, PP9)', () => {
  it('accepts a key of the current revision or of a kept one, and refuses any other with 409 (PP1)', async () => {
    const { ed, p, key } = await setup();
    const r = await put(ed, p.id, 'f'.repeat(64), small());
    expect(r.status).toBe(409);
    expect((await refusal(r)).code).toBe('unknown_key');
    // a second revision with another key: the first revision's key is still a kept version's
    const stand = p.sections[0]!.slides[0]!;
    const next = await ed.json<Presentation>(`/presentations/${p.id}`, {
      method: 'PUT',
      json: {
        ...p,
        sections: [
          { ...p.sections[0]!, slides: [{ ...stand, prerender: { ...stand.prerender!, live: [] } }] },
        ],
      },
    });
    const [a, b] = [keysOf(p.id, p.rev)[0]!, keysOf(p.id, next.rev)[0]!];
    expect(a).toBe(key);
    expect(b).not.toBe(a);
    expect((await put(ed, p.id, b, small())).status).toBe(201);
    expect((await put(ed, p.id, a, small())).status).toBe(201);
    expect((await put(ed, 'nope', a, small())).status).toBe(404);
  });

  it('checks the file by its header: PNG or WebP, not animated, exactly the size asked, at most 32 MiB (PP2)', async () => {
    const { ed, p, key } = await setup();
    const bad = async (body: Buffer, size: number, type: string, what: string, status = 400) => {
      const r = await put(ed, p.id, key, body, size, type);
      expect(r.status, what).toBe(status);
      if (status === 400) expect((await refusal(r)).code, what).toBe('bad_picture');
    };
    await bad(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
      640,
      'image/png',
      'a JPEG',
    );
    await bad(makeWebp(640, 360, { animated: true }), 640, 'image/webp', 'an animated WebP');
    await bad(makePng(640, 360, { animated: true }), 640, 'image/png', 'an APNG');
    await bad(makePng(639, 360), 640, 'image/png', '639x360 for 640');
    await bad(makePng(1920, 1080), 3840, 'image/png', 'a 1920 file sent as 3840');
    await bad(makePng(3839, 2160), 3840, 'image/png', '3839x2160');
    await bad(Buffer.from('not a picture at all'), 640, 'image/png', 'garbage');
    await bad(Buffer.alloc(33 * 1024 * 1024, 1), 3840, 'image/png', '33 MiB', 413);
    expect((await put(ed, p.id, key, makePng(3840, 2160), 3840)).status).toBe(201);
    expect((await put(ed, p.id, key, makePng(1920, 1080), 1920)).status).toBe(201);
    expect((await put(ed, p.id, key, makeWebp(640, 360), 640, 'image/webp')).status).toBe(201);
    expect((await put(ed, p.id, key, small(), 999)).status).toBe(400);
    expect(picRows(p.id).map((r) => r.size)).toEqual([640, 1920, 3840]);
  });

  it("lets the first upload of a (key, size) win, an operate session replace an edit session's, never the reverse (PP3)", async () => {
    const { ed, op, p, key } = await setup();
    const a = makePng(640, 360, { seed: 1 });
    const b = makePng(640, 360, { seed: 2 });
    const first = await put(ed, p.id, key, a);
    expect(first.status).toBe(201);
    const second = await put(ed, p.id, key, b);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ dropped: true });
    const [row] = picRows(p.id);
    expect(row!.hash).toBe(((await first.json()) as { hash: string }).hash);
    // an operate session replaces what an edit session made when its pixels differ
    const rep = await put(op, p.id, key, b);
    expect(rep.status).toBe(200);
    expect(await rep.json()).toMatchObject({ replaced: true });
    expect(picRows(p.id)[0]!.hash).not.toBe(row!.hash);
    expect(picRows(p.id)[0]!.made_role).toBe('operate');
    // the same pixels again: dropped; an edit session never replaces
    expect(await (await put(op, p.id, key, b)).json()).toMatchObject({ dropped: true });
    expect(await (await put(ed, p.id, key, a)).json()).toMatchObject({ dropped: true });
    expect(picRows(p.id)).toHaveLength(1);
  });

  it('two replacements of one picture at once leave no picture file that no row names (PP3b)', async () => {
    const { ed, op, p, key } = await setup();
    const op2 = await login(hub!.url, OPERATE_PIN);
    expect((await put(ed, p.id, key, makePng(640, 360, { seed: 1 }))).status).toBe(201);
    for (let round = 0; round < 6; round++) {
      const [a, b] = await Promise.all([
        put(op, p.id, key, makePng(640, 360, { seed: 10 + round * 2 })),
        put(op2, p.id, key, makePng(640, 360, { seed: 11 + round * 2 })),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
    }
    expect(picRows(p.id)).toHaveLength(1);
    // the row names one picture file; a replacement that raced the other released the file the first had made
    const orphans = hub!.db
      .prepare(
        `SELECT hash FROM files WHERE mime IN ('image/png', 'image/webp') AND hash NOT IN (SELECT hash FROM prerenders)`,
      )
      .all();
    expect(orphans).toEqual([]);
  });

  it("records what it knows of a picture: opaque from the header, made by, the session's role (PP9)", async () => {
    const { ed, op, p, key } = await setup();
    await put(ed, p.id, key, makePng(640, 360, { alpha: false }), 640, 'image/png', '&madeBy=Venue%20PC');
    await put(
      ed,
      p.id,
      key,
      makePng(1920, 1080, { alpha: true }),
      1920,
      'image/png',
      `&madeBy=${'x'.repeat(200)}`,
    );
    const rows = picRows(p.id);
    expect(rows[0]).toMatchObject({
      size: 640,
      opaque: 1,
      made_by: 'Venue PC',
      made_role: 'edit',
      w: 640,
      h: 360,
      mime: 'image/png',
      kind: 'slide',
    });
    expect(rows[1]).toMatchObject({ size: 1920, opaque: 0, made_role: 'edit' });
    expect(String(rows[1]!.made_by)).toHaveLength(120);
    expect(rows[0]!.standby_id).toMatch(/^[0-9a-f]{64}$/);
    void op;
  });

  it('answers 507 below the floor before the body is read', async () => {
    const free = { n: 50 * GIB };
    hub = await startHub({
      statfs: async () => ({
        bsize: 4096,
        bavail: Math.floor(free.n / 4096),
        blocks: Math.floor((100 * GIB) / 4096),
      }),
    });
    const ed = await login(hub.url, EDIT_PIN);
    free.n = GIB;
    await sleep(2100); // the measurement is reused for 2 s
    const r = await put(ed, 'p1', 'a'.repeat(64), small());
    expect(r.status).toBe(507);
    expect((await refusal(r)).reason).toBe('disk');
  });
});

describe('who may use the picture routes (PP5)', () => {
  it('refuses a phone and a view session 403 cap, an output token and no session, on all four routes', async () => {
    const { p, key } = await setup();
    const calls = (c: Client) => [
      put(c, p.id, key, small()),
      c.fetch(`/presentations/${p.id}/prerenders`),
      c.fetch(`/presentations/${p.id}/prerenders/${key}`, { method: 'DELETE' }),
      c.fetch(`/presentations/${p.id}/prerenders/${key}/failed`, { method: 'POST', json: { reason: 'x' } }),
    ];
    for (const c of [await phone(hub!.url), await phone(hub!.url, EDIT_PIN, 'view')])
      for (const r of await Promise.all(calls(c))) {
        expect(r.status).toBe(403);
        expect((await refusal(r)).code).toBe('cap');
      }
    for (const r of await Promise.all(calls(client(hub!.url)))) expect(r.status).toBe(401);
    const op = await login(hub!.url, OPERATE_PIN);
    const outputs = await op.json<{ token: string }[]>('/settings/outputs');
    const tok = client(hub!.url, '', { 'x-ordo-token': outputs[0]!.token });
    for (const r of await Promise.all(calls(tok))) expect(r.status).toBe(403);
  });
});

describe('failures, listing, sharing (PP6-PP8)', () => {
  it('remembers a failed bake, lists it, and forgets it with the picture on "Make picture again" (PP6)', async () => {
    const { ed, p, key } = await setup();
    await put(ed, p.id, key, small());
    const failed = await ed.fetch(`/presentations/${p.id}/prerenders/${key}/failed`, {
      method: 'POST',
      json: { reason: 'took 60 s', madeBy: 'Venue PC' },
    });
    expect(failed.status).toBe(200);
    const list = await ed.json<{ failures: { key: string; reason: string; madeBy?: string }[] }>(
      `/presentations/${p.id}/prerenders`,
    );
    expect(list.failures).toMatchObject([{ key, reason: 'took 60 s', madeBy: 'Venue PC' }]);
    const bad = await ed.fetch(`/presentations/${p.id}/prerenders/${key}/failed`, {
      method: 'POST',
      json: { reason: 'x'.repeat(201) },
    });
    expect(bad.status).toBe(400);
    const hash = picRows(p.id)[0]!.hash as string;
    const file = hub!.lib.getFile(hash)!;
    expect(existsSync(join(hub!.dir, file.path))).toBe(true);
    expect((await ed.fetch(`/presentations/${p.id}/prerenders/${key}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect(picRows(p.id)).toEqual([]);
    expect(hub!.lib.getFile(hash)).toBeUndefined();
    expect(existsSync(join(hub!.dir, file.path))).toBe(false);
    expect((await ed.json<{ failures: unknown[] }>(`/presentations/${p.id}/prerenders`)).failures).toEqual(
      [],
    );
  });

  it('answers 423 to "Make picture again" while the presentation is live-locked (PP6)', async () => {
    const { ed, op, p, key } = await setup();
    await put(ed, p.id, key, small());
    const pl = await ed.json<{ id: string }>('/playlists', {
      method: 'POST',
      json: { name: 'S', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
    });
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    const r = await ed.fetch(`/presentations/${p.id}/prerenders/${key}`, { method: 'DELETE' });
    expect(r.status).toBe(423);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/service/i);
    expect(picRows(p.id)).toHaveLength(1);
  });

  it('lists keys with their sizes, the failures and the budget in one answer, at most 5,000 keys, and emits no change (PP7)', async () => {
    const { ed, p, key } = await setup();
    await put(ed, p.id, key, small(), 640, 'image/png', '&madeBy=A');
    await put(ed, p.id, key, makePng(1920, 1080), 1920);
    const list = await ed.json<{
      keys: {
        slideId: string;
        key: string;
        standbyId: string;
        sizes: number[];
        madeBy?: string;
        at?: number;
      }[];
      failures: unknown[];
      budget: { usedBytes: number; limitBytes: number };
    }>(`/presentations/${p.id}/prerenders`);
    expect(list.keys).toHaveLength(1);
    expect(list.keys[0]).toMatchObject({ slideId: 'big', key, sizes: [640, 1920], madeBy: 'A' });
    expect(list.keys[0]!.standbyId).toMatch(/^[0-9a-f]{64}$/);
    expect(list.budget.usedBytes).toBeGreaterThan(0);
    expect(list.budget.limitBytes).toBe(1024 ** 3);
    // no library change for a picture upload or delete
    const seq = hub!.lib.seq();
    const changes = (hub!.db.prepare(`SELECT COUNT(*) AS n FROM library_changes`).get() as { n: number }).n;
    await put(ed, p.id, key, makePng(640, 360, { seed: 9 }), 640);
    await ed.fetch(`/presentations/${p.id}/prerenders/${key}?size=1920`, { method: 'DELETE' });
    expect(hub!.lib.seq()).toBe(seq);
    expect((hub!.db.prepare(`SELECT COUNT(*) AS n FROM library_changes`).get() as { n: number }).n).toBe(
      changes,
    );
    // 5,100 more keys: the listing stops at 5,000
    const ins = hub!.db.prepare(
      `INSERT INTO prerender_keys (presentation_id, rev, slide_id, key, standby_id, sig, created_at) VALUES (?, 1, 's', ?, ?, 'x', 0)`,
    );
    hub!.db.transaction(() => {
      for (let i = 0; i < 5100; i++) ins.run(p.id, i.toString(16).padStart(64, '0'), 'a'.repeat(64));
    })();
    const big = await ed.json<{ keys: unknown[] }>(`/presentations/${p.id}/prerenders`);
    expect(big.keys).toHaveLength(5000);
  });

  it('shares one files row between two pictures with the same bytes, and keeps it until both are gone (PP8)', async () => {
    const { ed, p, key } = await setup();
    // a second key: the same presentation saved with another live set
    const stand = p.sections[0]!.slides[0]!;
    const next = await ed.json<Presentation>(`/presentations/${p.id}`, {
      method: 'PUT',
      json: {
        ...p,
        sections: [
          { ...p.sections[0]!, slides: [{ ...stand, prerender: { ...stand.prerender!, live: [] } }] },
        ],
      },
    });
    const key2 = keysOf(p.id, next.rev)[0]!;
    expect(key2).not.toBe(key);
    const png = small();
    await put(ed, p.id, key, png);
    await put(ed, p.id, key2, png);
    const rows = picRows(p.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.hash).toBe(rows[1]!.hash);
    const hash = rows[0]!.hash as string;
    expect(
      (hub!.db.prepare(`SELECT COUNT(*) AS n FROM files WHERE hash = ?`).get(hash) as { n: number }).n,
    ).toBe(1);
    await ed.fetch(`/presentations/${p.id}/prerenders/${key}`, { method: 'DELETE' });
    expect(hub!.lib.getFile(hash)).toBeDefined();
    expect((await ed.fetch(`/files/${hash}`)).status).toBe(200);
    await ed.fetch(`/presentations/${p.id}/prerenders/${key2}`, { method: 'DELETE' });
    expect(hub!.lib.getFile(hash)).toBeUndefined();
  });

  it("releases a deleted presentation's pictures, failures and key rows at once", async () => {
    const { ed, p, key } = await setup();
    await put(ed, p.id, key, small());
    await ed.fetch(`/presentations/${p.id}/prerenders/${key}/failed`, {
      method: 'POST',
      json: { reason: 'x' },
    });
    const hash = picRows(p.id)[0]!.hash as string;
    expect((await ed.fetch(`/presentations/${p.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(picRows(p.id)).toEqual([]);
    expect(keysOf(p.id)).toEqual([]);
    expect(hub!.lib.getFile(hash)).toBeUndefined();
    expect((hub!.db.prepare(`SELECT COUNT(*) AS n FROM prerender_failures`).get() as { n: number }).n).toBe(
      0,
    );
  });
});

describe('while a service is live (PP4)', () => {
  it("accepts a key of the live service's current revision and announces it; refuses any other with 503 until End service", async () => {
    const { ed, op, p, key } = await setup();
    const seen: unknown[] = [];
    hub!.prerenders.onAccepted((e) => seen.push(e));
    const f2 = fullOf(bigSlide('o', 260, 'other'));
    await uploadSlideFile(ed, f2.pages);
    const q = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([f2.standIn], 'Other 2'),
    });
    const keyQ = keysOf(q.id)[0]!;
    const pl = await ed.json<{ id: string }>('/playlists', {
      method: 'POST',
      json: { name: 'S', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
    });
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    // the live presentation is locked, and a picture for its current key is still accepted: a cache, not an edit
    // (only the two sizes a goLive lists are announced: the 640 preview is not a goLive file)
    expect((await put(ed, p.id, key, small(), 640)).status).toBe(201);
    expect(seen).toEqual([]);
    const ok = await put(ed, p.id, key, makePng(1920, 1080), 1920);
    expect(ok.status).toBe(201);
    expect(seen).toMatchObject([{ presentationId: p.id, key, size: 1920 }]);
    // another presentation's key waits for End service
    const paused = await put(ed, q.id, keyQ, small());
    expect(paused.status).toBe(503);
    expect((await refusal(paused)).code).toBe('paused_during_service');
    expect(Number(paused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    await op.json('/live/events', { method: 'POST', json: { k: 'endService', at: Date.now() } });
    expect((await put(ed, q.id, keyQ, small())).status).toBe(201);
    expect(seen).toHaveLength(1);
  });
});

describe('announcing a picture to the live loop (PA1, PA2, PA4)', () => {
  async function live() {
    const s = await setup();
    const pl = await s.ed.json<{ id: string }>('/playlists', {
      method: 'POST',
      json: { name: 'S', items: [{ id: newId(), kind: 'presentation', presentationId: s.p.id }] },
    });
    await s.op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    return s;
  }
  const state = async (op: Client) =>
    await op.json<{ seq: number; state: { prerendered?: unknown[]; mode: string } }>('/live');

  it('applies a picture accepted for a key of the service: live.state.prerendered holds it (PA1)', async () => {
    const { ed, op, p, key } = await live();
    const before = await state(op);
    const r = await put(ed, p.id, key, makePng(1920, 1080), 1920);
    expect(r.status).toBe(201);
    const file = ((await r.json()) as { hash: string }).hash;
    const after = await state(op);
    expect(after.seq).toBe(before.seq + 1);
    expect(after.state.prerendered).toEqual([
      { presentationId: p.id, slideId: 'big', key, size: 1920, file },
    ]);
  });

  it('applies nothing and moves no seq for a key or a slide the service does not have (PA1)', async () => {
    const { op } = await live();
    const { applyHubEvent } = await import('../src/hubevents.ts');
    const before = await state(op);
    const ev = (over: Record<string, unknown>) => ({
      k: 'prerender.add',
      presentationId: 'x',
      slideId: 'big',
      key: 'a'.repeat(64),
      size: 1920,
      file: 'b'.repeat(64),
      ...over,
    });
    expect(applyHubEvent(hub!.live, ev({}))).toBeUndefined();
    expect(applyHubEvent(hub!.live, { k: 'next', at: 1 })).toBeUndefined();
    expect(applyHubEvent(hub!.live, 'junk')).toBeUndefined();
    const after = await state(op);
    expect(after.seq).toBe(before.seq);
    expect(after.state.prerendered).toBeUndefined();
  });

  it('applies nothing and raises nothing when the journal row cannot be written (PA1)', async () => {
    // The live process calls applyHubEvent from the supervisor's message handler: an exception there ends the process.
    const { op, p, key } = await live();
    const { applyHubEvent } = await import('../src/hubevents.ts');
    const before = await state(op);
    const warned: string[] = [];
    hub!.db.exec(
      `CREATE TRIGGER fail_journal BEFORE INSERT ON live_journal BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`,
    );
    const ev = {
      k: 'prerender.add',
      presentationId: p.id,
      slideId: 'big',
      key,
      size: 1920,
      file: 'b'.repeat(64),
    };
    let seq: number | undefined = -1;
    expect(() => {
      seq = applyHubEvent(hub!.live, ev, { warn: (_o: unknown, m?: string) => void warned.push(String(m)) });
    }).not.toThrow();
    expect(seq).toBeUndefined();
    expect(warned).toHaveLength(1);
    hub!.db.exec(`DROP TRIGGER fail_journal`);
    const after = await state(op);
    expect(after.seq).toBe(before.seq);
    expect(after.state.prerendered).toBeUndefined();
    // the same picture applies once the disk is healed
    expect(applyHubEvent(hub!.live, ev)).toBe(before.seq + 1);
  });

  it("still refuses a client's own prerender.add on POST /live/events and a socket (PA2)", async () => {
    const { op, p, key } = await live();
    const before = await state(op);
    const event = {
      k: 'prerender.add',
      presentationId: p.id,
      slideId: 'big',
      key,
      size: 1920,
      file: 'b'.repeat(64),
    };
    const r = await op.fetch('/live/events', { method: 'POST', json: event });
    expect(r.status).toBe(400);
    const ws = await connectWs(hub!.url, { cookie: op.cookie, hello: { role: 'operate' } });
    await ws.next(byType('welcome'));
    ws.send({ t: 'live.event', id: newId(), event });
    await sleep(300);
    ws.ws.close();
    const after = await state(op);
    expect(after.seq).toBe(before.seq);
    expect(after.state.prerendered).toBeUndefined();
  });

  it('clears at End service, and a later picture for a key of that service follows the ordinary rule (PA4)', async () => {
    const { ed, op, p, key } = await live();
    await put(ed, p.id, key, makePng(1920, 1080), 1920);
    expect((await state(op)).state.prerendered).toHaveLength(1);
    await op.json('/live/events', { method: 'POST', json: { k: 'endService', at: Date.now() } });
    const ended = await state(op);
    expect(ended.state.prerendered).toBeUndefined();
    const again = await put(ed, p.id, key, makePng(3840, 2160), 3840);
    expect(again.status).toBe(201);
    expect((await state(op)).seq).toBe(ended.seq);
    expect((await state(op)).state.prerendered).toBeUndefined();
  });
});

describe('the budget (BU2-BU4)', () => {
  const S3840 = makePng(3840, 2160, { seed: 1 }).length;
  type Api = Awaited<ReturnType<typeof login>>;
  const listing = (c: Api, id: string) =>
    c.json<{ budget: { usedBytes: number; limitBytes: number } }>(`/presentations/${id}/prerenders`);
  const keyRows = (id: string) =>
    (
      hub!.db
        .prepare(`SELECT key, size FROM prerenders WHERE presentation_id = ? ORDER BY key, size`)
        .all(id) as { key: string; size: number }[]
    ).map((r) => `${r.key.slice(0, 4)}:${r.size}`);

  /** A slide of the given id and title (the title makes the key: a new title, a new key) with its slide file uploaded. */
  const made = async (ed: Api, id: string, tag: string) => {
    const f = fullOf(bigSlide(id, 260, tag));
    await uploadSlideFile(ed, f.pages);
    return f;
  };

  it("drops the pictures of the oldest versions' keys first, never a current key or a current stand-by, and answers 507 when that is not enough (BU2)", async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const [a1, b1] = [await made(ed, 'sa', 'a1'), await made(ed, 'sb', 'b1')];
    let p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([a1.standIn, b1.standIn]),
    });
    const next = async (...fs: ReturnType<typeof fullOf>[]) => {
      p = await ed.json<Presentation>(`/presentations/${p.id}`, {
        method: 'PUT',
        json: { ...p, sections: [{ ...p.sections[0]!, slides: fs.map((f) => f.standIn) }] },
      });
    };
    const [a2, c] = [await made(ed, 'sa', 'a2'), await made(ed, 'sc', 'c1')];
    await next(a2, c);
    const a3 = await made(ed, 'sa', 'a3');
    await next(a3);
    const pic = (f: { key: string }, size: 3840 | 1920 | 640, seed: number) =>
      put(
        ed,
        p.id,
        f.key,
        size === 3840
          ? makePng(3840, 2160, { seed })
          : size === 1920
            ? makePng(1920, 1080, { seed })
            : makePng(640, 360, { seed }),
        size,
      );
    for (const [f, seed] of [
      [a1, 1],
      [b1, 2],
      [a2, 3],
      [c, 4],
    ] as const)
      expect((await pic(f, 3840, seed)).status).toBe(201);
    // the picture of a2's key is an older drawing of the slide the current version has: its stand-by
    hub.db
      .prepare(`UPDATE prerenders SET standby_id = ? WHERE presentation_id = ? AND key = ?`)
      .run(a3.standbyId, p.id, a2.key);
    const used4 = (await listing(ed, p.id)).budget.usedBytes;
    expect(used4).toBeGreaterThan(4 * S3840); // the slide files count too
    // a little room: pictures of different bytes differ by a byte or two, and one drop must be enough
    const limit = used4 + 100;
    hub.prerenders.budgetBytes = limit;

    const hashOf = (f: { key: string }, size: number) =>
      (
        hub!.db
          .prepare(`SELECT hash FROM prerenders WHERE presentation_id = ? AND key = ? AND size = ?`)
          .get(p.id, f.key, size) as { hash: string }
      ).hash;
    const dropped = [hashOf(a1, 3840), hashOf(b1, 3840)];
    // one more 3840 picture: the oldest version's picture goes (a1's key, then b1's)
    expect((await pic(a3, 3840, 5)).status).toBe(201);
    expect(keyRows(p.id).map((r) => r.slice(0, 4))).not.toContain(a1.key.slice(0, 4));
    expect(keyRows(p.id)).toContain(`${b1.key.slice(0, 4)}:3840`);
    const after = (await listing(ed, p.id)).budget;
    expect(after.limitBytes).toBe(limit);
    expect(after.usedBytes).toBeLessThanOrEqual(limit);
    expect((await pic(a3, 1920, 6)).status).toBe(201);
    expect(keyRows(p.id)).not.toContain(`${b1.key.slice(0, 4)}:3840`);
    expect((await pic(a3, 640, 7)).status).toBe(201);
    // never a current version's key, never a current slide's stand-by, and the dropped pictures' files are gone
    expect(keyRows(p.id).sort()).toEqual(
      [
        `${a2.key.slice(0, 4)}:3840`,
        `${c.key.slice(0, 4)}:3840`,
        `${a3.key.slice(0, 4)}:640`,
        `${a3.key.slice(0, 4)}:1920`,
        `${a3.key.slice(0, 4)}:3840`,
      ].sort(),
    );
    for (const h of dropped) expect(hub.lib.getFile(h), h).toBeUndefined();
    // not enough: the limit under what is used by more than the one droppable picture frees
    const before = (await listing(ed, p.id)).budget.usedBytes;
    hub.prerenders.budgetBytes = before - S3840 + 1000;
    const refused = await pic(c, 640, 8);
    expect(refused.status).toBe(507);
    expect(await refusal(refused)).toMatchObject({
      code: 'budget',
      reason: 'budget',
      usedBytes: before,
      limitBytes: before - S3840 + 1000,
    });
    expect(keyRows(p.id)).toContain(`${c.key.slice(0, 4)}:3840`); // nothing was dropped for nothing
    expect(keyRows(p.id)).not.toContain(`${c.key.slice(0, 4)}:640`);
  });

  it('carries the limit and the largest presentation in the stats and on /health (BU2)', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const f = await made(ed, 'sa', 'h');
    const p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([f.standIn]),
    });
    expect((await put(ed, p.id, f.key, makePng(3840, 2160), 3840)).status).toBe(201);
    const used = (await listing(ed, p.id)).budget.usedBytes;
    expect(hub.prerenders.healthFields()).toEqual({ budgetLimitBytes: GIB, budgetUsedBytes: used });
    const h = (await (await fetch(`${hub.url}/api/v1/health`)).json()) as Record<string, unknown>;
    expect(h).toMatchObject({ budgetLimitBytes: GIB, budgetUsedBytes: used });
  });

  it('never refuses a slide page, a head or a shape file for the budget, counts them, and the picture routes feel it (BU3)', async () => {
    hub = await startHub();
    hub.prerenders.budgetBytes = 1000;
    const ed = await login(hub.url, EDIT_PIN);
    const f = fullOf(bigSlide('big', 300, 'x'));
    await uploadSlideFile(ed, f.pages); // throws on any refusal
    const p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([f.standIn]),
    });
    const names = [f.name, ...f.pages.head.pages];
    const stored = (
      hub.db
        .prepare(
          `SELECT COALESCE(SUM(bytes), 0) AS n FROM files WHERE hash IN (${names.map(() => '?').join(',')})`,
        )
        .get(...names) as { n: number }
    ).n;
    const { budget } = await listing(ed, p.id);
    expect(budget.limitBytes).toBe(1000);
    expect(budget.usedBytes).toBe(stored);
    expect(stored).toBeGreaterThan(1000);
    const r = await put(ed, p.id, f.key, makePng(640, 360), 640);
    expect(r.status).toBe(507);
    expect(await refusal(r)).toMatchObject({ reason: 'budget', usedBytes: stored, limitBytes: 1000 });
    expect(picRows(p.id)).toEqual([]);
    for (const h of names) expect(hub.lib.getFile(h), h).toBeDefined();
  });

  it('leaves both of two presentations with the same pictures under the limit, and frees pictures at once and files after the days (BU4)', async () => {
    hub = await startHub();
    hub.lib.refs.setBackfillDone(true);
    const ed = await login(hub.url, EDIT_PIN);
    const f = await made(ed, 'sa', 'dup');
    const a = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([f.standIn], 'A'),
    });
    const png = makePng(3840, 2160, { seed: 9 });
    expect((await put(ed, a.id, f.key, png, 3840)).status).toBe(201);
    const alone = (await listing(ed, a.id)).budget.usedBytes;
    expect(alone).toBeGreaterThan(S3840);
    hub.prerenders.budgetBytes = alone; // exactly what the first one uses
    const b = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([f.standIn], 'B'),
    });
    expect((await put(ed, b.id, f.key, png, 3840)).status).toBe(201);
    // everything is shared: neither counts any of it
    expect((await listing(ed, a.id)).budget.usedBytes).toBe(0);
    expect((await listing(ed, b.id)).budget.usedBytes).toBe(0);
    // B goes: A has them alone again
    expect((await ed.fetch(`/presentations/${b.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await listing(ed, a.id)).budget.usedBytes).toBe(alone);
    // A goes: its picture at once, its slide files only after the days
    const pictureHash = (
      hub.db.prepare(`SELECT hash FROM prerenders WHERE presentation_id = ?`).get(a.id) as { hash: string }
    ).hash;
    expect((await ed.fetch(`/presentations/${a.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(hub.lib.getFile(pictureHash)).toBeUndefined();
    for (const h of [f.name, ...f.pages.head.pages]) expect(hub.lib.getFile(h), h).toBeDefined();
    const t = { now: Date.UTC(2031, 0, 1) };
    const c = new Collector(hub.lib, hub.store, {
      mode: 'on',
      live: () => 'idle',
      known: () => true,
      timeZone: () => 'UTC',
      log: hub.log,
      now: () => t.now,
    });
    await c.run();
    t.now += COLLECT_DELAY_DAYS * 86_400_000;
    await c.run();
    for (const h of [f.name, ...f.pages.head.pages]) expect(hub.lib.getFile(h), h).toBeUndefined();
  });
});
