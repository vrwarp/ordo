/**
 * The live process's goLive bundle fetch (design/29 §2.3 M8, A17, A18): the library has FETCH_TIMEOUT_MS to
 * answer with its headers, then the body may take as long as it keeps sending (no bytes for
 * PROGRESS_TIMEOUT_MS ends it) under a BUNDLE_CEILING_MS ceiling; each cached bundle is its own live_kv
 * row, written after the goLive applied.
 */
import { join } from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { type DB, openLiveDb } from '../src/db.ts';
import { FETCH_TIMEOUT_MS, LibraryLink } from '../src/librarylink.ts';
import { LiveRejection, LiveService } from '../src/live.ts';
import { sleep, song, tempDir } from './helpers.ts';

const quiet = pino({ level: 'silent' });

function bundleOf(id: string, title = `Song of ${id}`) {
  const p = song(title);
  return {
    playlist: {
      id,
      rev: 1,
      name: id,
      items: [{ id: `${id}-i1`, kind: 'presentation', presentationId: p.id }],
    },
    presentations: { [p.id]: p },
    media: {},
    fonts: [],
    looks: [],
    general: {},
  };
}

type Mode =
  | { k: 'ok' }
  /** Headers after `headerMs`, then the body in `steps` chunks over `bodyMs`. */
  | { k: 'stream'; headerMs?: number; bodyMs: number; steps?: number; stallAfter?: number }
  /** Never answers (a library stopped with SIGSTOP); honours abort. */
  | { k: 'stall' };

/** A fake library process: its goLive answers follow `ctl.mode`; aborting a request errors it, as fetch does. */
function fakeLibrary() {
  const ctl = { mode: { k: 'ok' } as Mode, calls: 0, titles: new Map<string, string>() };
  const fetcher = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/internal/context'))
      return Response.json({
        settings: { outputs: [], looks: [], general: {}, audio: {}, surfaces: {} },
        fonts: [],
      });
    const m = /\/internal\/golive\/([^/?]+)/.exec(u);
    if (!m) return new Response('{}', { status: 404 });
    ctl.calls++;
    const id = decodeURIComponent(m[1]!);
    const bytes = new TextEncoder().encode(JSON.stringify(bundleOf(id, ctl.titles.get(id))));
    const mode = ctl.mode;
    const aborted = () =>
      new Promise<never>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted'))),
      );
    if (mode.k === 'stall') return aborted();
    if (mode.k === 'ok') return new Response(bytes, { headers: { 'content-type': 'application/json' } });
    if (mode.headerMs) await Promise.race([sleep(mode.headerMs), aborted()]);
    const steps = mode.steps ?? 10;
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        let gone = false;
        init?.signal?.addEventListener('abort', () => {
          gone = true;
          c.error(new Error('This operation was aborted'));
        });
        for (let i = 0; i < steps; i++) {
          if (mode.stallAfter !== undefined && i >= mode.stallAfter) return; // stops sending, never closes
          await sleep(mode.bodyMs / steps);
          if (gone) return;
          c.enqueue(
            bytes.slice(Math.floor((i * bytes.length) / steps), Math.floor(((i + 1) * bytes.length) / steps)),
          );
        }
        c.close();
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) },
    });
  }) as unknown as typeof fetch;
  return { ctl, fetcher };
}

function linked(db: DB = openLiveDb(join(tempDir(), 'live.db'))) {
  const lib = fakeLibrary();
  const link = new LibraryLink(db, quiet, 'secret', lib.fetcher);
  link.setLibrary('http://library', 'up');
  const live = new LiveService(db, link, quiet, { snapshotIntervalMs: 60_000 });
  return { db, link, live, ...lib };
}

const goLive = (live: LiveService, playlistId: string) =>
  live.submitQueued({ k: 'goLive', playlistId }, { role: 'operate' });

describe('the goLive bundle fetch (design/29 M8)', () => {
  it('accepts a bundle whose body streams for 4 s with progress', async () => {
    const { live, ctl } = linked();
    ctl.mode = { k: 'stream', bodyMs: 4000, steps: 16 };
    const t0 = Date.now();
    await goLive(live, 'pl');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3900);
    expect(live.state.mode).toBe('live');
    expect(live.state.resolved?.playlist.id).toBe('pl');
    // The fresh copy, not a cached one: no degraded entry.
    expect(live.state.resolved?.degraded).toBeUndefined();
  });

  it('still falls back to the cached copy at 1.5 s when the headers stall', async () => {
    const { live, ctl } = linked();
    await goLive(live, 'pl');
    await live.submitQueued({ k: 'endService', at: Date.now() }, { role: 'operate' });
    ctl.mode = { k: 'stall' };
    const t0 = Date.now();
    await goLive(live, 'pl');
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(FETCH_TIMEOUT_MS - 50);
    expect(ms).toBeLessThan(FETCH_TIMEOUT_MS + 1500);
    expect(live.state.resolved?.degraded?.[0]?.reason).toMatch(/the library did not answer/);
  });

  it('falls back when the body stops arriving for 1.5 s', async () => {
    const { live, ctl } = linked();
    await goLive(live, 'pl');
    await live.submitQueued({ k: 'endService', at: Date.now() }, { role: 'operate' });
    ctl.mode = { k: 'stream', bodyMs: 1000, steps: 10, stallAfter: 3 };
    const t0 = Date.now();
    await goLive(live, 'pl');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
    expect(live.state.resolved?.degraded?.[0]?.reason).toMatch(/the library did not answer/);
  });

  it('refuses with "did not answer" when the body stalls and no copy was saved', async () => {
    const { live, ctl } = linked();
    ctl.mode = { k: 'stream', bodyMs: 1000, steps: 10, stallAfter: 2 };
    const err = await goLive(live, 'pl').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveRejection);
    expect(String((err as Error).message)).toBe('The library did not answer; try Go live again in a moment');
  });
});

describe('cached bundles in live.db (design/29 A18)', () => {
  const bundleRows = (db: DB) =>
    (
      db.prepare(`SELECT key FROM live_kv WHERE key != 'context' ORDER BY key`).all() as { key: string }[]
    ).map((r) => r.key);

  it('keeps one live_kv row per bundle, written after the goLive applied', async () => {
    const { db, live } = linked();
    const seen: { id: string; rows: string[] }[] = [];
    live.onDelta((d) => {
      if (d.event.k === 'goLive') seen.push({ id: d.event.resolved.playlist.id, rows: bundleRows(db) });
    });
    await goLive(live, 'a');
    await goLive(live, 'b');
    await goLive(live, 'c');
    await sleep(50);
    expect(bundleRows(db)).toEqual(['bundle:a', 'bundle:b', 'bundle:c']);
    // When each goLive applied, its own row was not written yet (nothing written on the goLive path).
    expect(seen.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    for (const x of seen) expect(x.rows).not.toContain(`bundle:${x.id}`);
  });

  it('a restarted live process goes live from the rows while the library is down', async () => {
    const { db, live, ctl } = linked();
    ctl.titles.set('a', 'Saved before the restart');
    await goLive(live, 'a');
    await goLive(live, 'b');
    await sleep(50);
    const again = new LibraryLink(db, quiet, 'secret', fakeLibrary().fetcher);
    again.setLibrary(undefined, 'failed');
    const live2 = new LiveService(db, again, quiet, { snapshotIntervalMs: 60_000 });
    await goLive(live2, 'a');
    const r = live2.state.resolved!;
    expect(Object.values(r.presentations)[0]?.title).toBe('Saved before the restart');
    expect(r.degraded?.[0]?.reason).toMatch(/the library is not running/);
  });

  it('reads the single row of copies an older version saved, once', async () => {
    const db = openLiveDb(join(tempDir(), 'live.db'));
    db.prepare(`INSERT INTO live_kv (key, json, saved_at) VALUES ('bundles', ?, ?)`).run(
      JSON.stringify([['old', { ...bundleOf('old', 'An old copy'), takenAt: Date.now() - 3 * 86_400_000 }]]),
      Date.now(),
    );
    const link = new LibraryLink(db, quiet, 'secret', fakeLibrary().fetcher);
    link.setLibrary(undefined, 'failed');
    const live = new LiveService(db, link, quiet, { snapshotIntervalMs: 60_000 });
    await goLive(live, 'old');
    expect(Object.values(live.state.resolved!.presentations)[0]?.title).toBe('An old copy');
    expect(live.state.resolved?.degraded?.[0]?.reason).toMatch(/saved 3 days ago/);
    expect(bundleRows(db)).toEqual(['bundle:old']);
  });
});

describe('POST /live/prepare beside the running service (design/29 M8, W41)', () => {
  it('reports progress while the copy arrives, then ready; the goLive that follows fetches nothing more', async () => {
    const { live, ctl } = linked();
    ctl.mode = { k: 'stream', bodyMs: 1500, steps: 10 };
    const seen: number[] = [];
    let s = await live.prepareWait('pl', { waitMs: 300 });
    while (s.state === 'preparing') {
      seen.push(s.pct);
      s = await live.prepareWait('pl', { seen: s.pct, waitMs: 300 });
    }
    expect(s).toMatchObject({ playlistId: 'pl', state: 'ready', pct: 100 });
    expect(s.bytes).toBeGreaterThan(0);
    // Progress moved through the body (0-90 %) before it was ready.
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(Math.max(...seen)).toBeGreaterThan(40);
    const calls = ctl.calls;
    const t0 = Date.now();
    await goLive(live, 'pl');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(ctl.calls).toBe(calls);
    expect(live.state.resolved?.playlist.id).toBe('pl');
    expect(live.resolvedId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a prepare started again while one is under way joins it', async () => {
    const { live, ctl } = linked();
    ctl.mode = { k: 'stream', bodyMs: 600, steps: 6 };
    const a = live.prepare('pl');
    const b = live.prepare('pl');
    expect(a.state).toBe('preparing');
    expect(b.state).toBe('preparing');
    await goLive(live, 'pl');
    expect(ctl.calls).toBe(1);
  });

  it('offers the saved copy: going live from it abandons the fetch and says so', async () => {
    const { live, ctl } = linked();
    ctl.titles.set('pl', 'Saved on Thursday');
    await goLive(live, 'pl');
    await sleep(20);
    ctl.titles.set('pl', 'Edited since');
    ctl.mode = { k: 'stream', bodyMs: 20_000, steps: 200 };
    const first = await live.prepareWait('pl', { waitMs: 200 });
    expect(first.state).toBe('preparing');
    expect(first.savedAt).toBeGreaterThan(0);
    // The operator presses "Go live from the copy saved ..." (W41).
    let s = await live.prepareWait('pl', { saved: true, waitMs: 2000 });
    while (s.state === 'preparing') s = await live.prepareWait('pl', { seen: s.pct, waitMs: 2000 });
    expect(s.state).toBe('ready');
    const t0 = Date.now();
    await goLive(live, 'pl');
    expect(Date.now() - t0).toBeLessThan(500);
    const r = live.state.resolved!;
    expect(Object.values(r.presentations)[0]?.title).toBe('Saved on Thursday');
    expect(r.degraded?.[0]?.reason).toMatch(/^Went live from the copy of this playlist saved/);
  });

  it('a prepare that fails is the goLive refusal; a prepare after it starts afresh', async () => {
    const { live, ctl } = linked();
    ctl.mode = { k: 'stall' };
    let s = await live.prepareWait('pl', { waitMs: 3000 });
    while (s.state === 'preparing') s = await live.prepareWait('pl', { seen: s.pct, waitMs: 3000 });
    expect(s).toMatchObject({
      state: 'failed',
      reason: 'The library did not answer; try Go live again in a moment',
    });
    await expect(goLive(live, 'pl')).rejects.toThrow(/did not answer/);
    ctl.mode = { k: 'ok' };
    s = await live.prepareWait('pl', { waitMs: 2000 });
    expect(s.state).toBe('ready');
  });
});
