/**
 * The running service kept by reference (live-by-ref, design/29 §2.3 M2, A16): the resolved copy named by its
 * SHA-256 and kept once in two rows of live.db, the snapshot and the journal naming it instead of holding it,
 * restore joining them, two copies each verified on read, collection of copies nothing names, the legacy
 * whole forms, and the technician switch ORDO_LIVE_BYREF.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { type Media, type LiveState } from '@ordo/domain';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { type DB, openLiveDb } from '../src/db.ts';
import { LiveService, SNAPSHOTS_PREV_KEEP } from '../src/live.ts';
import { bigBundle, bundleBytes, bundleSource, stringifySpy } from './byref-helpers.ts';
import { song, startHub, tempDir } from './helpers.ts';

const quiet = pino({ level: 'silent' });
const OP = { role: 'operate' as const };

let cache: { bytes: Uint8Array; mib: number } | undefined;
/** The bytes of a bundle of about `mib` MiB, made once per file. */
function bundle(mib = 6): Uint8Array {
  if (cache?.mib !== mib) cache = { mib, bytes: bundleBytes(bigBundle(mib)) };
  return cache.bytes;
}

type Svc = { db: DB; file: string; live: LiveService; bundles: Record<string, Uint8Array> };
const open: LiveService[] = [];
function service(opts: { byRef?: boolean; file?: string; bundles?: Record<string, Uint8Array> } = {}): Svc {
  const file = opts.file ?? join(tempDir(), 'live.db');
  const db = openLiveDb(file);
  const bundles = opts.bundles ?? { pl: bundle() };
  const live = new LiveService(db, bundleSource(bundles), quiet, {
    snapshotIntervalMs: 60_000,
    ...(opts.byRef === undefined ? {} : { byRef: opts.byRef }),
  });
  open.push(live);
  return { db, file, live, bundles };
}
afterEach(() => {
  for (const l of open.splice(0)) l.stop();
});

const goLive = (live: LiveService, playlistId = 'pl') => live.submitQueued({ k: 'goLive', playlistId }, OP);
const next = (live: LiveService, n = 1) => {
  for (let i = 0; i < n; i++) live.submit({ k: 'next', at: Date.now() }, OP);
};
const logo = (live: LiveService) => live.submit({ k: 'logo', at: Date.now() }, OP);

type Row = { resolved_id: string; copy: number; bytes: number; json: Buffer };
function rows(db: DB): Row[] {
  try {
    return db.prepare(`SELECT resolved_id, copy, bytes, json FROM live_resolved ORDER BY resolved_id, copy`).all() as Row[];
  } catch {
    return [];
  }
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const snapshotText = (db: DB) => (db.prepare(`SELECT json FROM live_snapshot WHERE id = 1`).get() as { json: string }).json;
const journalRow = (db: DB, seq: number) =>
  (db.prepare(`SELECT event_json FROM live_journal WHERE seq = ?`).get(seq) as { event_json: string }).event_json;
/** A restore of the same db by a second service (what a restart does). */
function restarted(s: Svc, byRef?: boolean): LiveService {
  const again = new LiveService(s.db, bundleSource(s.bundles), quiet, {
    snapshotIntervalMs: 60_000,
    ...(byRef === undefined ? {} : { byRef }),
  });
  open.push(again);
  again.restore();
  return again;
}
const same = (a: LiveState, b: LiveState) => expect(a).toEqual(b);

describe('rows (step 4)', () => {
  it('a goLive writes the copy twice, names it in the snapshot and the journal, and keeps the snapshot small', async () => {
    const s = service();
    await goLive(s.live);
    const r = rows(s.db);
    expect(r.length).toBe(2);
    expect(new Set(r.map((x) => x.resolved_id)).size).toBe(1);
    expect(r.map((x) => x.copy).sort()).toEqual([0, 1]);
    for (const x of r) {
      expect(sha(x.json)).toBe(x.resolved_id);
      expect(x.bytes).toBe(x.json.byteLength);
    }
    const id = r[0]!.resolved_id;
    expect(s.live.resolvedCopy()?.id).toBe(id);
    const snap = snapshotText(s.db);
    expect(snap).toContain(`"resolvedId":"${id}"`);
    expect(snap).not.toContain('"resolved":');
    const cuesBytes = JSON.stringify(s.live.state.cues).length;
    expect(snap.length).toBeLessThanOrEqual(cuesBytes + 20 * 1024);
    expect(snap.length).toBeLessThan(0.25 * JSON.stringify(s.live.state).length);
    expect(JSON.parse(journalRow(s.db, 1))).toEqual({ k: 'goLive', resolvedId: id });
  });
});

describe('restore (step 4)', () => {
  it('joins the snapshot and the copy: after the goLive alone, after 50 more events, and from the journal alone', async () => {
    const s = service();
    await goLive(s.live);
    same(restarted(s).state, s.live.state);
    next(s.live, 50);
    same(restarted(s).state, s.live.state);
    // a journal-only goLive: the snapshot rows are gone, the journal names the copy
    const t = service();
    await goLive(t.live);
    next(t.live, 3);
    t.db.exec(`DELETE FROM live_snapshot; DELETE FROM live_snapshot_prev`);
    const again = restarted(t);
    same(again.state, t.live.state);
    expect(again.restoreWarnings).toEqual([]);
  });

  it('a torn copy: one byte flipped in copy 0 restores from copy 1 with a warning; both torn start idle', async () => {
    const s = service();
    await goLive(s.live);
    next(s.live, 5);
    s.live.snapshot(true);
    const tear = (copy: number) => {
      const row = s.db.prepare(`SELECT json FROM live_resolved WHERE copy = ?`).get(copy) as { json: Buffer };
      const torn = Buffer.from(row.json);
      torn[torn.length >> 1] = torn[torn.length >> 1]! ^ 0xff;
      s.db.prepare(`UPDATE live_resolved SET json = ? WHERE copy = ?`).run(torn, copy);
    };
    tear(0);
    const one = restarted(s);
    same(one.state, s.live.state);
    expect(one.restoreWarnings.join(' ')).toMatch(/copy 0/);
    tear(1);
    const none = restarted(s);
    expect(none.state.mode).toBe('idle');
    expect(none.restoreWarnings.length).toBeGreaterThan(0);
    expect(none.restoreWarnings.join(' ')).toMatch(/copy/);
  });
});

describe('collection (step 4)', () => {
  it('keeps at most three ids, two rows each; the live id never; an ended service goes once no snapshot names it', async () => {
    const bundles = { a: bigBundleBytes(1, 'a'), b: bigBundleBytes(1, 'b'), c: bigBundleBytes(1, 'c') };
    const s = service({ bundles });
    await goLive(s.live, 'a');
    const idA = rows(s.db)[0]!.resolved_id;
    s.live.submit({ k: 'endService', at: Date.now() }, OP);
    expect(rows(s.db).some((x) => x.resolved_id === idA)).toBe(true); // snapshots still name it
    logo(s.live);
    s.live.snapshot(true);
    logo(s.live);
    s.live.snapshot(true);
    expect(rows(s.db).some((x) => x.resolved_id === idA)).toBe(false);
    await goLive(s.live, 'b');
    await goLive(s.live, 'c');
    const live = s.live.resolvedCopy()!.id;
    for (let i = 0; i < 4; i++) {
      next(s.live);
      s.live.snapshot(true);
      expect(rows(s.db).length).toBeLessThanOrEqual(6);
      expect(rows(s.db).filter((x) => x.resolved_id === live).length).toBe(2);
    }
  });

  it('a journal goLive row newer than the oldest retained snapshot keeps its copy', async () => {
    const bundles = { a: bigBundleBytes(1, 'a'), b: bigBundleBytes(1, 'b') };
    const s = service({ bundles });
    await goLive(s.live, 'a');
    const idA = rows(s.db)[0]!.resolved_id;
    await goLive(s.live, 'b');
    const idB = s.live.resolvedCopy()!.id;
    // the snapshot that named B is lost: only the one that names A (seq 1) is left, the journal names both
    s.db.exec(`DELETE FROM live_snapshot`);
    const fresh = restarted(s);
    void fresh;
    const idle = new LiveService(s.db, bundleSource(bundles), quiet, { snapshotIntervalMs: 60_000 });
    open.push(idle);
    expect([...idle.resolvedIdsInUse()].sort()).toEqual([idA, idB].sort());
  });
});

describe('legacy forms (step 4)', () => {
  it('a live.db written whole (a snapshot, then a journal-only goLive) restores and names the copy at its first snapshot', async () => {
    const donor = service();
    await goLive(donor.live);
    next(donor.live, 2);
    const state = donor.live.state;
    const resolved = state.resolved!;
    // the fixture: the base's own shapes (a whole JSON.stringify(state) snapshot, a whole goLive journal row)
    const fixture = (withSnapshot: boolean) => {
      const f = service();
      f.db.exec(`DELETE FROM live_resolved`);
      if (withSnapshot)
        f.db
          .prepare(`INSERT INTO live_snapshot (id, seq, json, saved_at) VALUES (1, ?, ?, ?)`)
          .run(state.seq, JSON.stringify(state), Date.now());
      const ins = f.db.prepare(
        `INSERT INTO live_journal (seq, at, cmd_id, kind, event_json) VALUES (?, ?, NULL, 'event', ?)`,
      );
      if (!withSnapshot) ins.run(1, Date.now(), JSON.stringify({ k: 'goLive', resolved }));
      if (!withSnapshot) for (let i = 2; i <= state.seq; i++) ins.run(i, Date.now(), JSON.stringify({ k: 'next', at: 1 }));
      return f;
    };
    for (const withSnapshot of [true, false]) {
      const f = fixture(withSnapshot);
      const again = restarted(f);
      expect(again.state.mode).toBe('live');
      expect(again.state.seq).toBe(state.seq);
      expect(again.state.resolved?.playlist.id).toBe(resolved.playlist.id);
      expect(rows(f.db).length).toBe(0);
      again.snapshot(true);
      expect(rows(f.db).length).toBe(2);
      expect(snapshotText(f.db)).toContain('"resolvedId"');
      expect(snapshotText(f.db)).not.toContain('"resolved":');
    }
  });
});

describe('adopt (step 4)', () => {
  it('names the adopted copy: after a restart the state is the same and two rows exist', async () => {
    const donor = service();
    await goLive(donor.live);
    next(donor.live, 4);
    const incoming = JSON.parse(JSON.stringify(donor.live.state)) as LiveState;
    const hubSide = service({ bundles: {} });
    expect(hubSide.live.adopt(incoming)).toMatchObject({ ok: true });
    expect(rows(hubSide.db).length).toBe(2);
    same(restarted(hubSide).state, hubSide.live.state);
    expect(snapshotText(hubSide.db)).not.toContain('"resolved":');
  });
});

describe('the switch (step 4)', () => {
  it('byRef off writes whole forms and no rows, and a db written either way restores either way', async () => {
    const off = service({ byRef: false });
    await goLive(off.live);
    next(off.live, 3);
    expect(rows(off.db).length).toBe(0);
    expect(snapshotText(off.db)).toContain('"resolved":');
    expect(JSON.parse(journalRow(off.db, 1)).resolved).toBeTruthy();
    same(restarted(off, true).state, off.live.state);
    same(restarted(off, false).state, off.live.state);
    const on = service({ byRef: true });
    await goLive(on.live);
    next(on.live, 3);
    expect(rows(on.db).length).toBe(2);
    same(restarted(on, false).state, on.live.state);
    same(restarted(on, true).state, on.live.state);
  });
});

describe('the periodic snapshot (step 4)', () => {
  it('writes the cue list and a name, from a cached encoding, in a few milliseconds', async () => {
    const s = service();
    await goLive(s.live);
    next(s.live, 100);
    const cuesBytes = JSON.stringify(s.live.state.cues).length;
    const cues = s.live.state.cues;
    const spy = stringifySpy((a) => a === cues || a?.resolved !== undefined);
    next(s.live);
    const t0 = performance.now();
    s.live.snapshot();
    const ms = performance.now() - t0;
    spy.restore();
    expect(snapshotText(s.db).length).toBeLessThanOrEqual(cuesBytes + 20 * 1024);
    expect(spy.count()).toBe(0);
    expect(ms).toBeLessThanOrEqual(budgetMs(25));
  });
});

describe('naming (steps 4 and 5)', () => {
  it('two goLives of one playlist that differ in one clip trim have different ids', async () => {
    const clip = (trim?: { startMs: number; endMs: number }): Media => {
      const hash = 'c'.repeat(64);
      return {
        id: 'clip1',
        rev: 1,
        name: 'Welcome loop',
        tags: [],
        kind: 'video',
        original: { hash, bytes: 10, mime: 'video/mp4', path: `media/cc/${hash}.mp4` },
        delivery: { hash: `d${hash.slice(1)}`, bytes: 5, mime: 'video/mp4', path: 'x' },
        state: 'ready',
        loop: false,
        isBackground: false,
        ...(trim ? { trim } : {}),
      };
    };
    const p = song('Trim');
    const make = (trim?: { startMs: number; endMs: number }) =>
      bundleBytes({
        playlist: {
          id: 'pl',
          rev: 1,
          name: 'S',
          items: [
            { id: 'i1', kind: 'presentation', presentationId: p.id },
            { id: 'i2', kind: 'media', mediaId: 'clip1' },
          ],
        },
        presentations: { [p.id]: p },
        media: { clip1: clip(trim) },
        fonts: [],
        looks: [],
        general: {},
      });
    const bundles: Record<string, Uint8Array> = { pl: make() };
    const s = service({ bundles });
    await goLive(s.live);
    const first = s.live.resolvedCopy()!.id;
    bundles.pl = make({ startMs: 1000, endMs: 5000 });
    await goLive(s.live);
    expect(s.live.resolvedCopy()!.id).not.toBe(first);
  });

  it('a goLive resolved in this process names its copy once, and a hello after it serialises nothing', async () => {
    const hub = await startHub();
    try {
      const p = hub.lib.presentations.insert(song('In process'));
      const pl = hub.lib.playlists.insert({
        id: 'pl-ip',
        rev: 1,
        name: 'Sunday',
        items: [{ id: 'i1', kind: 'presentation', presentationId: p.id }],
      } as never);
      hub.live.submit({ k: 'goLive', playlistId: pl.id }, OP);
      // the goLive named the copy (the apply's one serialisation, with its journal row, snapshot and delta by
      // name): nothing after it serialises the copy again, however many sockets ask for it
      const spy = stringifySpy((a) => !!a.presentations && !!a.playlist && !!a.manifestId);
      const first = hub.live.resolvedCopy();
      const second = hub.live.resolvedCopy();
      hub.live.snapshot(true);
      spy.restore();
      expect(first?.id).toMatch(/^[0-9a-f]{64}$/);
      expect(sha(first!.json)).toBe(first!.id);
      expect(second).toBe(first);
      expect(spy.count()).toBe(0);
    } finally {
      await hub.cleanup();
    }
  });
});

describe('the snapshots retained', () => {
  it('SNAPSHOTS_PREV_KEEP stays 2', () => {
    expect(SNAPSHOTS_PREV_KEEP).toBe(2);
  });
});

function bigBundleBytes(mib: number, playlistId: string): Uint8Array {
  return bundleBytes(bigBundle(mib, playlistId));
}
