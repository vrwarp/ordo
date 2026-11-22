/**
 * The hub's switch for the release's pictures, ORDO_PRERENDER (store-2, design/29 §1.11), as the routes and the
 * parts of the hub honour it. PR* cases of step 1 are about what is TOLD (capabilities, health, the log); PS1-PS8 of step 2 are
 * about what it DOES (the picture route, the keys job, goLive). One hub per setting: `startHub({ prerender })`.
 * Before the release's switch commit `auto` is the 0.10.0 hub (the store open, operators told off).
 */
import { degradedKind, newId, type Presentation, type ResolvedPlaylist } from '@ordo/domain';
import { PRERENDER_ON } from '@ordo/domain/prerender.ts';
import type { HubCapabilities } from '@ordo/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prerenderConfig } from '../src/config.ts';
import { prepareGoLive } from '../src/golive-worker.ts';
import { HEADER_INTERNAL } from '../src/http.ts';
import { librarySource, LiveService } from '../src/live.ts';
import { cpuPool, type CpuPool } from '../src/pool.ts';
import { PrerenderKeys } from '../src/prerenderkeys.ts';
import { EDIT_PIN, login, sleep, startHub, tempDir, type TestHub } from './helpers.ts';
import { refusal, twoProcesses } from './phones-helpers.ts';
import { bigSlide, fullOf, makePng, presentationOf, uploadSlideFile } from './prerender-helpers.ts';

const hubs: TestHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.cleanup();
});
const start = async (setting: string | undefined, extra: { logLevel?: string } = {}) => {
  const h = await startHub({ prerender: prerenderConfig(setting), ...extra });
  hubs.push(h);
  return h;
};
const health = async (h: TestHub) =>
  (await (await fetch(`${h.url}/api/v1/health`)).json()) as Record<string, unknown>;

describe('what the hub tells about its switch (PR1-PR3)', () => {
  it('PR1: GET /capabilities carries prerender { state, setting } and keeps the tool fields', async () => {
    const want: [string | undefined, unknown][] = [
      ['on', { state: 'on', setting: 'on' }],
      ['off', { state: 'off', setting: 'off' }],
      [undefined, { state: PRERENDER_ON ? 'on' : 'off', setting: 'auto' }],
    ];
    for (const [setting, expected] of want) {
      const h = await start(setting);
      const caps = await (await login(h.url, EDIT_PIN)).json<HubCapabilities>('/capabilities');
      expect(caps.prerender, String(setting)).toEqual(expected);
      expect(caps).toMatchObject({ libreoffice: { state: 'available' }, pdf: true });
    }
  });

  it('PR2: the public GET /health says on or off, and no tool name or version', async () => {
    const want: [string | undefined, string][] = [
      ['on', 'on'],
      ['off', 'off'],
      [undefined, PRERENDER_ON ? 'on' : 'off'],
    ];
    for (const [setting, expected] of want) {
      const h = await start(setting);
      const body = await health(h);
      expect(body.prerender, String(setting)).toBe(expected);
      expect(JSON.stringify(body)).not.toMatch(/libreoffice/i);
    }
  });

  it('PR3: the log says it once, in plain words, for off and for a value it does not understand, and not for auto or on', async () => {
    const lines = (h: TestHub) =>
      h.ring.snapshot().filter((l) => /ORDO_PRERENDER|Pictures of heavy slides/.test(l));
    expect(lines(await start('off', { logLevel: 'info' }))).toHaveLength(1);
    expect(lines(await start('off', { logLevel: 'info' }))[0]).toMatch(
      /Pictures of heavy slides are turned off \(ORDO_PRERENDER=off\): heavy slides are drawn live and whole, and nothing already stored is deleted\./,
    );
    const odd = lines(await start('maybe', { logLevel: 'info' }));
    expect(odd).toHaveLength(1);
    expect(odd[0]).toMatch(/ORDO_PRERENDER is neither auto, on nor off \(\\"maybe\\"\): auto/);
    expect(lines(await start(undefined, { logLevel: 'info' }))).toHaveLength(0);
    expect(lines(await start('on', { logLevel: 'info' }))).toHaveLength(0);
  });
});

// ── what the switch DOES (step 2: PS1-PS7) ──────────────────────────────────────────────────────────────────

const ENC = new TextEncoder();
const DEC = new TextDecoder();
type Api = Awaited<ReturnType<typeof login>>;
const png = (w: number, h: number, seed = 1) => new Uint8Array(makePng(w, h, { seed }));
const putPicture = (
  c: Api,
  id: string,
  key: string,
  size: number,
  body: Uint8Array<ArrayBuffer>,
  query = '',
) =>
  c.fetch(`/presentations/${id}/prerenders/${key}?size=${size}${query}`, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body,
  });
const keyRows = (h: TestHub, id: string) =>
  h.db.prepare(`SELECT key FROM prerender_keys WHERE presentation_id = ? ORDER BY key`).all(id) as {
    key: string;
  }[];
const countRows = (h: TestHub, table: 'prerenders' | 'files') =>
  (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** A presentation with one pre-rendered slide (its slide file uploaded) saved through the routes. */
async function withPreSlide(h: TestHub, title = 'Pre-rendered') {
  const ed = await login(h.url, EDIT_PIN);
  const f = fullOf();
  await uploadSlideFile(ed, f.pages);
  const p = await ed.json<Presentation>('/presentations', {
    method: 'POST',
    json: presentationOf([f.standIn], title),
  });
  return { ed, f, p };
}

describe('the picture route on an off hub (PS1, PS2)', () => {
  it('PS1: answers 503 prerender_off, with no Retry-After, stores nothing, and the connection serves the next request', async () => {
    const h = await start('off');
    const { ed, f, p } = await withPreSlide(h);
    expect(keyRows(h, p.id)).toEqual([]);
    const files = countRows(h, 'files');
    const r = await putPicture(ed, p.id, f.key, 1920, png(1920, 1080));
    expect(r.status).toBe(503);
    const err = await refusal(r);
    expect(err.code).toBe('prerender_off');
    expect(err.message).toBe('Pictures of heavy slides are turned off on this hub.');
    expect(r.headers.get('retry-after')).toBeNull();
    expect(countRows(h, 'prerenders')).toBe(0);
    expect(countRows(h, 'files')).toBe(files);
    // the body was drained: the same connection answers the next request
    const big = await putPicture(ed, p.id, f.key, 3840, new Uint8Array(2_000_000));
    expect(big.status).toBe(503);
    expect((await fetch(`${h.url}/api/v1/health`)).status).toBe(200);
  });

  it('PS1: the same picture on the default hub and on an on hub is accepted as today', async () => {
    for (const setting of [undefined, 'on']) {
      const h = await start(setting);
      const { ed, p } = await withPreSlide(h);
      const [row] = keyRows(h, p.id);
      expect(row, String(setting)).toBeTruthy();
      expect((await putPicture(ed, p.id, row!.key, 1920, png(1920, 1080))).status, String(setting)).toBe(201);
    }
  });

  it('PS2: the refusal of an off hub comes before every other (an unknown presentation, a bad size, an unknown key)', async () => {
    const h = await start('off');
    const ed = await login(h.url, EDIT_PIN);
    for (const [id, key, size] of [
      ['nope', 'a'.repeat(64), 1920],
      ['nope', 'not-a-key', 1920],
      ['nope', 'a'.repeat(64), 7],
    ] as const) {
      const r = await putPicture(ed, id, key, size, png(8, 8));
      expect(r.status, `${id} ${key} ${size}`).toBe(503);
      expect((await refusal(r)).code).toBe('prerender_off');
    }
    // a kind other than slide: off first
    const k = await putPicture(ed, 'nope', 'a'.repeat(64), 1920, png(8, 8), '&kind=plate');
    expect(k.status).toBe(503);
  });

  it('PS2: the listing, the delete and the failure route keep answering on an off hub', async () => {
    const h = await start('off');
    const { ed, p } = await withPreSlide(h);
    const list = await ed.fetch(`/presentations/${p.id}/prerenders`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ keys: [], failures: [] });
    expect(
      (await ed.fetch(`/presentations/${p.id}/prerenders/${'b'.repeat(64)}`, { method: 'DELETE' })).status,
    ).toBe(204);
    const failed = await ed.fetch(`/presentations/${p.id}/prerenders/${'b'.repeat(64)}/failed`, {
      method: 'POST',
      json: { reason: 'x' },
    });
    expect(failed.status).not.toBe(503);
    expect((await refusal(failed)).code).toBe('unknown_key');
  });
});

describe('the optional kind of the picture route (PS2, hook H4)', () => {
  it('?kind=slide is accepted exactly as no kind, and the row says slide', async () => {
    const h = await start(undefined);
    const { ed, p } = await withPreSlide(h);
    const [row] = keyRows(h, p.id);
    expect((await putPicture(ed, p.id, row!.key, 640, png(640, 360, 2), '&kind=slide')).status).toBe(201);
    expect((await putPicture(ed, p.id, row!.key, 1920, png(1920, 1080, 3))).status).toBe(201);
    const kinds = h.db.prepare(`SELECT DISTINCT kind FROM prerenders WHERE presentation_id = ?`).all(p.id);
    expect(kinds).toEqual([{ kind: 'slide' }]);
  });

  it('any other kind answers 400 bad_kind before the presentation, the size and the key are looked at, with the body drained', async () => {
    const h = await start(undefined);
    const ed = await login(h.url, EDIT_PIN);
    for (const [id, size] of [
      ['nope', 1920],
      ['nope', 7],
    ] as const) {
      const r = await putPicture(ed, id, 'a'.repeat(64), size, new Uint8Array(1_000_000), '&kind=plate');
      expect(r.status).toBe(400);
      const err = await refusal(r);
      expect(err.code).toBe('bad_kind');
      expect(err.message).toBe('Only pictures of slides are made yet');
    }
    expect((await fetch(`${h.url}/api/v1/health`)).status).toBe(200);
    // an empty kind is not slide either
    expect((await putPicture(ed, 'nope', 'a'.repeat(64), 1920, png(8, 8), '&kind=')).status).toBe(400);
  });
});

describe('the keys job on an off hub (PS3, PS4)', () => {
  /** A pool that counts the tasks it is given. */
  const counting = () => {
    let n = 0;
    const pool = (): Pick<CpuPool, 'run'> => ({
      run: ((task: never, input: never) => {
        n++;
        return cpuPool().run(task, input);
      }) as CpuPool['run'],
    });
    return { pool, calls: () => n };
  };
  const font = (h: TestHub, family: string, hash: string) => {
    const f = h.lib.upsertFont({
      family,
      weight: 400,
      style: 'normal',
      file: { hash, bytes: 10, mime: 'font/ttf', path: `fonts/${hash}.ttf` },
      source: 'upload',
    });
    h.lib.emit([{ kind: 'font', id: f.id, entity: f }]);
  };

  it('PS3: a save through the routes writes no key row for a slide with a record, and the pool is never asked', async () => {
    const h = await start('off');
    const spy = vi.spyOn(cpuPool(), 'run');
    const { ed, p } = await withPreSlide(h);
    expect(keyRows(h, p.id)).toEqual([]);
    const next = await ed.json<Presentation>(`/presentations/${p.id}`, {
      method: 'PUT',
      json: { ...p, title: 'edited' },
    });
    expect(keyRows(h, p.id)).toEqual([]);
    await ed.json(`/presentations/${p.id}/restore/${p.rev}`, { method: 'POST' });
    expect(keyRows(h, p.id)).toEqual([]);
    expect(next.rev).toBeGreaterThan(p.rev);
    expect(spy.mock.calls.filter((c) => c[0] === 'prerender-keys')).toHaveLength(0);
    spy.mockRestore();
  });

  /** Two instances of the job over the hub's library: one closed, one open (the control). The hub's own is stopped. */
  const jobs = async () => {
    const h = await start(undefined);
    const { p } = await withPreSlide(h);
    expect(keyRows(h, p.id)).toHaveLength(1);
    h.prerenderKeys.stop();
    const make = (c: ReturnType<typeof counting>, open?: boolean) =>
      new PrerenderKeys(h.lib, h.store, c.pool, {
        live: () => 'idle',
        log: h.log,
        startDelayMs: 10,
        ...(open === undefined ? {} : { open: () => open }),
      });
    return { h, p, make };
  };
  const settle = async (k: PrerenderKeys) => {
    await sleep(700); // past the job's 300 ms debounce
    await k.idle();
  };

  it('PS3: keysFor returns no row while closed, without asking the pool, and the open job does', async () => {
    const { h, p, make } = await jobs();
    const closed = counting();
    const shut = make(closed, false);
    expect(await shut.keysFor(h.lib.presentations.must(p.id) as Presentation)).toEqual([]);
    expect(closed.calls()).toBe(0);
    // the control: an open one, given a changed presentation, asks the pool
    const open = counting();
    const edited = structuredClone(h.lib.presentations.must(p.id) as Presentation);
    edited.sections[0]!.slides[0]!.objects.push(...bigSlide('x', 1).objects.slice(1, 2));
    expect((await make(open).keysFor(edited)).length).toBe(1);
    expect(open.calls()).toBe(1);
  });

  it('PS3: a font change queues nothing while closed, and the open job adds the new row', async () => {
    const { h, p, make } = await jobs();
    const closed = counting();
    const shut = make(closed, false);
    shut.start();
    font(h, 'Inter', 'e'.repeat(64));
    await settle(shut);
    expect(closed.calls()).toBe(0);
    expect(keyRows(h, p.id)).toHaveLength(1);
    shut.stop();
    const open = counting();
    const live = make(open);
    live.start();
    font(h, 'Inter', 'd'.repeat(64));
    await settle(live);
    expect(open.calls()).toBeGreaterThan(0);
    expect(keyRows(h, p.id).length).toBeGreaterThan(1);
    live.stop();
  });

  it('PS3: the start-up scan queues nothing while closed, and the open scan fills the rows', async () => {
    const { h, p, make } = await jobs();
    h.db.prepare(`DELETE FROM prerender_keys`).run();
    const closed = counting();
    const shut = make(closed, false);
    shut.start();
    await settle(shut);
    expect(closed.calls()).toBe(0);
    expect(keyRows(h, p.id)).toEqual([]);
    shut.stop();
    const open = counting();
    const live = make(open);
    live.start();
    await settle(live);
    expect(open.calls()).toBeGreaterThan(0);
    expect(keyRows(h, p.id)).toHaveLength(1);
    live.stop();
  });

  it('PS4: a hub restarted from off to on fills the rows of what was saved meanwhile', async () => {
    const dir = tempDir();
    const off = await startHub({ prerender: prerenderConfig('off'), dataDir: dir });
    let id = '';
    try {
      id = (await withPreSlide(off)).p.id;
      expect(keyRows(off, id)).toEqual([]);
    } finally {
      await off.cleanup();
    }
    const on = await startHub({ prerender: prerenderConfig('on'), dataDir: dir });
    hubs.push(on);
    expect(on.cfg.prerender.store).toBe(true);
    const scan = new PrerenderKeys(on.lib, on.store, () => cpuPool(), {
      live: () => 'idle',
      log: on.log,
      startDelayMs: 20,
      open: () => on.cfg.prerender.store,
    });
    scan.start();
    const end = Date.now() + 8000;
    while (keyRows(on, id).length === 0 && Date.now() < end) await sleep(25);
    await scan.idle();
    scan.stop();
    expect(keyRows(on, id)).toHaveLength(1);
  });
});

describe('goLive on an off hub (PS5, PS6, PS7)', () => {
  /** The service of a presentation with a record, rows and a key set in the DB, resolved in the hub's own loop. */
  async function resolved(setting: string | undefined, absent = false) {
    const h = await start(setting);
    const { ed, p } = await withPreSlide(h);
    if (setting === 'off') {
      // an off hub keeps no rows: give the DB the key a hub that was on would have written
      const f = fullOf();
      h.db
        .prepare(
          `INSERT INTO prerender_keys (presentation_id, rev, slide_id, key, standby_id, sig, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(p.id, p.rev, f.standIn.id, f.key, f.standbyId, 's', Date.now());
    }
    const pl = await ed.json<{ id: string }>('/playlists', {
      method: 'POST',
      json: { name: 'Sunday', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
    });
    const live = absent
      ? new LiveService(h.db, librarySource(h.lib), h.log, { snapshotIntervalMs: 5000 })
      : h.live;
    return { h, pl, r: live.resolve(pl.id), p };
  }
  const pictureLines = (r: ResolvedPlaylist) =>
    (r.degraded ?? []).filter((d) => degradedKind(d.reason) === 'picture');

  it('PS5: an off hub resolves with no picture rows, no key set and no picture line', async () => {
    const { r } = await resolved('off');
    expect(r.prerenders).toBeUndefined();
    expect(r.prerenderKeys).toBeUndefined();
    expect(pictureLines(r)).toEqual([]);
  });

  it('PS5: an on hub lists the key set and says the slide has no picture yet (W33)', async () => {
    const { r } = await resolved('on');
    expect(r.prerenderKeys).toHaveLength(1);
    expect(pictureLines(r)).toHaveLength(1);
  });

  it('PS5: the 0.10.0 hub (auto before the switch commit: store open, operators told off) lists the keys and no line', async () => {
    const h = await startHub({ prerender: prerenderConfig(undefined, false) });
    hubs.push(h);
    const { ed, p } = await withPreSlide(h);
    const pl = await ed.json<{ id: string }>('/playlists', {
      method: 'POST',
      json: { name: 'S', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
    });
    const r = h.live.resolve(pl.id);
    expect(r.prerenderKeys).toHaveLength(1);
    expect(pictureLines(r)).toEqual([]);
  });

  it('PS5: a live service without the option is as it was', async () => {
    const { r } = await resolved(undefined, true);
    expect(r.prerenderKeys).toHaveLength(1);
    expect(pictureLines(r)).toEqual([]);
  });

  it('PS6: the goLive worker lists none of a bundle that carries rows and keys when it is told pictures are off, and all when it is not told', async () => {
    const t = await twoProcesses();
    try {
      const ed = await login(t.base, EDIT_PIN);
      const f = fullOf();
      await uploadSlideFile(ed, f.pages);
      const p = await ed.json<Presentation>('/presentations', {
        method: 'POST',
        json: presentationOf([f.standIn]),
      });
      expect((await putPicture(ed, p.id, f.key, 1920, png(1920, 1080))).status).toBe(201);
      const pl = await ed.json<{ id: string }>('/playlists', {
        method: 'POST',
        json: { name: 'S', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
      });
      const res = await fetch(`${t.lib.url}/internal/golive/${pl.id}`, {
        headers: { [HEADER_INTERNAL]: 'test-secret' },
      });
      const bundle = ENC.encode(JSON.stringify(await res.json()));
      const run = (extra: { pictures?: boolean; prerenderOn?: boolean }) => {
        const out = prepareGoLive({ playlistId: pl.id, bundle, takenAt: 1, ...extra });
        if (!out.ok) throw new Error(out.reason);
        return JSON.parse(DEC.decode(out.buffer)) as ResolvedPlaylist;
      };
      const none = run({ pictures: false, prerenderOn: false });
      expect(none.prerenders).toBeUndefined();
      expect(none.prerenderKeys).toBeUndefined();
      expect(pictureLines(none)).toEqual([]);
      const all = run({});
      expect(all.prerenders).toHaveLength(1);
      expect(all.prerenderKeys).toEqual([f.key]);
    } finally {
      await t.close();
    }
  });
});
