/**
 * The running service kept by reference (live-by-ref, design/29 §2.3 M2, A16): the resolved copy named by its
 * SHA-256 and kept once in two rows of live.db, the snapshot and the journal naming it instead of holding it,
 * restore joining them, two copies each verified on read, collection of copies nothing names, the legacy
 * whole forms, and the technician switch ORDO_LIVE_BYREF.
 */
import { createHash } from 'node:crypto';
import { type AddressInfo, connect, createServer } from 'node:net';
import { join } from 'node:path';
import type { Media, LiveState } from '@ordo/domain';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { type DB, openLiveDb } from '../src/db.ts';
import { LiveService, SNAPSHOTS_PREV_KEEP } from '../src/live.ts';
import { bigBundle, bundleBytes, bundleSource, field, stringifySpy } from './byref-helpers.ts';
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

const turn = () => new Promise((r) => setImmediate(r));
/** The turns of the loop after which a deferred second copy is written: the poll between them reads what arrived first. */
const later = async () => {
  await turn();
  await turn();
};
/** The goLive applied, and the turns of the loop in which its second copy is written (design/29 M2's measured decision). */
const goLive = async (live: LiveService, playlistId = 'pl') => {
  const seq = await live.submitQueued({ k: 'goLive', playlistId }, OP);
  await later();
  return seq;
};
const next = (live: LiveService, n = 1) => {
  for (let i = 0; i < n; i++) live.submit({ k: 'next', at: Date.now() }, OP);
};
const logo = (live: LiveService) => live.submit({ k: 'logo', at: Date.now() }, OP);

type Row = { resolved_id: string; copy: number; bytes: number; json: Buffer };
function rows(db: DB): Row[] {
  try {
    return db
      .prepare(`SELECT resolved_id, copy, bytes, json FROM live_resolved ORDER BY resolved_id, copy`)
      .all() as Row[];
  } catch {
    return [];
  }
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const snapshotText = (db: DB) =>
  (db.prepare(`SELECT json FROM live_snapshot WHERE id = 1`).get() as { json: string }).json;
const journalRow = (db: DB, seq: number) =>
  (db.prepare(`SELECT event_json FROM live_journal WHERE seq = ?`).get(seq) as { event_json: string })
    .event_json;
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
      if (!withSnapshot)
        for (let i = 2; i <= state.seq; i++) ins.run(i, Date.now(), JSON.stringify({ k: 'next', at: 1 }));
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
      await later();
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
    await later();
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
    const spy = stringifySpy((a) => a === cues || field(a, 'resolved') !== undefined);
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
      const spy = stringifySpy(
        (a) => !!field(a, 'presentations') && !!field(a, 'playlist') && !!field(a, 'manifestId'),
      );
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

type CueRow = { cues_id: string; bytes: number; json: Buffer };
/** The rows of the cue lists kept beside the copies (follow-up 1: the snapshot names the cue list, it does not hold it). */
function cueRows(db: DB): CueRow[] {
  try {
    return db.prepare(`SELECT cues_id, bytes, json FROM live_cues ORDER BY cues_id`).all() as CueRow[];
  } catch {
    return [];
  }
}

describe('the cue list beside the copy (follow-up 1: the periodic snapshot stops writing it)', () => {
  it('a goLive saves the cue list once under its own SHA-256; the snapshot names it and stays small', async () => {
    const s = service();
    await goLive(s.live);
    const c = cueRows(s.db);
    expect(c.length).toBe(1);
    const row = c[0]!;
    expect(sha(row.json)).toBe(row.cues_id);
    expect(row.bytes).toBe(row.json.byteLength);
    expect(JSON.parse(row.json.toString('utf8'))).toEqual(s.live.state.cues);
    const snap = snapshotText(s.db);
    const copyId = rows(s.db)[0]!.resolved_id;
    // the ids sit at fixed places at the end: the cue list's, then the copy's
    expect(snap.endsWith(`,"cuesId":"${row.cues_id}","resolvedId":"${copyId}"}`)).toBe(true);
    expect(snap).not.toContain('"cues":');
    expect(snap).not.toContain('"resolved":');
    // the cue list is no part of the snapshot any more: the whole row is the small remainder of the state
    expect(snap.length).toBeLessThanOrEqual(20 * 1024);
    expect(snap.length).toBeLessThan(0.05 * row.bytes + 20 * 1024);
    expect(JSON.parse(journalRow(s.db, 1))).toEqual({ k: 'goLive', resolvedId: copyId });
  });

  it('the periodic snapshot writes no cue list: one write at the goLive, none across 100 events and three snapshots', async () => {
    const s = service();
    s.db.exec(`CREATE TABLE IF NOT EXISTS cue_writes (n INTEGER)`);
    s.db.exec(
      `CREATE TRIGGER IF NOT EXISTS cues_ins AFTER INSERT ON live_cues BEGIN INSERT INTO cue_writes VALUES (1); END;
       CREATE TRIGGER IF NOT EXISTS cues_upd AFTER UPDATE ON live_cues BEGIN INSERT INTO cue_writes VALUES (1); END`,
    );
    const writes = () => (s.db.prepare(`SELECT count(*) AS n FROM cue_writes`).get() as { n: number }).n;
    await goLive(s.live);
    expect(writes()).toBe(1);
    for (let k = 0; k < 3; k++) {
      next(s.live, 100);
      s.live.snapshot(true);
      expect(snapshotText(s.db).length).toBeLessThanOrEqual(20 * 1024);
      const prev = s.db.prepare(`SELECT json FROM live_snapshot_prev`).all() as { json: string }[];
      for (const p of prev) expect(p.json.length).toBeLessThanOrEqual(20 * 1024);
    }
    expect(writes()).toBe(1);
    expect(cueRows(s.db).length).toBe(1);
  });

  it('restores through the cue row: after the goLive alone, after 50 events, and with the snapshot older than the goLive', async () => {
    const s = service();
    await goLive(s.live);
    same(restarted(s).state, s.live.state);
    next(s.live, 50);
    s.live.snapshot(true);
    const again = restarted(s);
    same(again.state, s.live.state);
    expect(again.restoreWarnings).toEqual([]);
    expect(snapshotText(s.db)).toContain('"cuesId":"');
    // the joined cue list is the one the reducer built, content for content
    expect(again.state.cues.length).toBe(s.live.state.cues.length);
    // a snapshot of an earlier seq, the later events from the journal
    const t = service();
    await goLive(t.live);
    t.live.snapshot(true);
    next(t.live, 7);
    same(restarted(t).state, t.live.state);
  });

  it('a restore keeps the verified cue bytes: the first snapshot after it writes no second cue row and encodes nothing', async () => {
    const s = service();
    await goLive(s.live);
    next(s.live, 3);
    s.live.snapshot(true);
    const again = restarted(s);
    const cues = again.state.cues;
    const spy = stringifySpy((a) => a === cues);
    next(again, 2);
    again.snapshot(true);
    spy.restore();
    expect(spy.count()).toBe(0);
    expect(cueRows(s.db).length).toBe(1);
  });

  it('a torn cue row is a warning, not a lost service: the cue list is derived from the copy, and the next snapshot rewrites the row', async () => {
    const s = service();
    await goLive(s.live);
    next(s.live, 5);
    s.live.snapshot(true);
    const id = cueRows(s.db)[0]!.cues_id;
    const torn = Buffer.from(cueRows(s.db)[0]!.json);
    torn[torn.length >> 1] = torn[torn.length >> 1]! ^ 0xff;
    s.db.prepare(`UPDATE live_cues SET json = ? WHERE cues_id = ?`).run(torn, id);
    const again = restarted(s);
    same(again.state, s.live.state);
    expect(again.restoreWarnings.join(' ')).toMatch(/cue list/);
    // the row is made good again by the next snapshot of the restored service
    next(again, 1);
    again.snapshot(true);
    const fixed = cueRows(s.db);
    expect(fixed.length).toBe(1);
    expect(sha(fixed[0]!.json)).toBe(id);
    const third = restarted(s);
    same(third.state, again.state);
    expect(third.restoreWarnings).toEqual([]);
    // a row that is gone is the same case
    s.db.exec(`DELETE FROM live_cues`);
    const fourth = restarted(s);
    same(fourth.state, again.state);
    expect(fourth.restoreWarnings.join(' ')).toMatch(/cue list/);
  });

  it('collection: the cue row of an ended service goes with its copy once no snapshot names it; never the live one; at most three', async () => {
    const bundles = { a: bigBundleBytes(1, 'a'), b: bigBundleBytes(1, 'b'), c: bigBundleBytes(1, 'c') };
    const s = service({ bundles });
    await goLive(s.live, 'a');
    const idA = cueRows(s.db)[0]!.cues_id;
    s.live.submit({ k: 'endService', at: Date.now() }, OP);
    expect(cueRows(s.db).some((x) => x.cues_id === idA)).toBe(true); // retained snapshots still name it
    logo(s.live);
    s.live.snapshot(true);
    logo(s.live);
    s.live.snapshot(true);
    expect(cueRows(s.db).some((x) => x.cues_id === idA)).toBe(false);
    await goLive(s.live, 'b');
    await goLive(s.live, 'c');
    for (let i = 0; i < 4; i++) {
      next(s.live);
      s.live.snapshot(true);
      expect(cueRows(s.db).length).toBeLessThanOrEqual(3);
      expect(sha(cueRows(s.db).find((x) => x.cues_id === snapshotCueId(s.db))!.json)).toBe(
        snapshotCueId(s.db),
      );
    }
    // the copy rows keep their own bound beside them
    expect(rows(s.db).length).toBeLessThanOrEqual(6);
  });

  it('the by-name form with the cue list inside (what the first by-reference build wrote) still restores and turns into the new form', async () => {
    const donor = service();
    await goLive(donor.live);
    next(donor.live, 4);
    const st = donor.live.state;
    const id = rows(donor.db)[0]!.resolved_id;
    const f = service({ bundles: {} });
    // the donor's copy rows, a snapshot with `cues` inside and the id last, the goLive journal row by name
    for (const r of rows(donor.db))
      f.db
        .prepare(
          `INSERT INTO live_resolved (resolved_id, copy, bytes, json, saved_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(r.resolved_id, r.copy, r.bytes, r.json, Date.now());
    const { resolved: _r, cues: _c, ...rest } = st;
    const text = `${JSON.stringify(rest).slice(0, -1)},"cues":${JSON.stringify(st.cues)},"resolvedId":"${id}"}`;
    f.db
      .prepare(`INSERT INTO live_snapshot (id, seq, json, saved_at) VALUES (1, ?, ?, ?)`)
      .run(st.seq, text, Date.now());
    expect(cueRows(f.db).length).toBe(0);
    const again = restarted(f);
    same(again.state, st);
    expect(again.restoreWarnings).toEqual([]);
    again.snapshot(true);
    expect(cueRows(f.db).length).toBe(1);
    expect(snapshotText(f.db)).toContain('"cuesId":"');
    expect(snapshotText(f.db)).not.toContain('"cues":');
    same(restarted(f).state, st);
  });

  it("adopt saves the adopted state's cue list too, and a restart gives the same state", async () => {
    const donor = service();
    await goLive(donor.live);
    next(donor.live, 4);
    const incoming = JSON.parse(JSON.stringify(donor.live.state)) as LiveState;
    const hubSide = service({ bundles: {} });
    expect(hubSide.live.adopt(incoming)).toMatchObject({ ok: true });
    await later();
    expect(cueRows(hubSide.db).length).toBe(1);
    expect(snapshotText(hubSide.db)).not.toContain('"cues":');
    same(restarted(hubSide).state, hubSide.live.state);
  });

  it('with the switch off the snapshot is whole and no cue row is written; either way restores either way', async () => {
    const off = service({ byRef: false });
    await goLive(off.live);
    next(off.live, 3);
    expect(cueRows(off.db).length).toBe(0);
    expect(snapshotText(off.db)).toContain('"cues":');
    same(restarted(off, true).state, off.live.state);
    const on = service({ byRef: true });
    await goLive(on.live);
    next(on.live, 3);
    expect(cueRows(on.db).length).toBe(1);
    same(restarted(on, false).state, on.live.state);
  });

  it('resolvedIdsInUse still names the copies only (the hand-back by name builds on it)', async () => {
    const s = service();
    await goLive(s.live);
    const idCopy = rows(s.db)[0]!.resolved_id;
    expect([...s.live.resolvedIdsInUse()]).toEqual([idCopy]);
  });
});

/** The cue list's id a snapshot names (the fixed place before the copy's id). */
function snapshotCueId(db: DB): string {
  const m = /"cuesId":"([0-9a-f]{64})","resolvedId":"[0-9a-f]{64}"\}$/.exec(snapshotText(db));
  if (!m) throw new Error('the snapshot names no cue list');
  return m[1]!;
}

describe('the take-over leaves the loop to what arrived meanwhile (M2: a GO pressed during the apply)', () => {
  it('a key that reached a socket during the take-over apply is read before the second copy is written', async () => {
    const s = service();
    // A TCP pair stands for a screen or the operator: bytes written from inside the apply are in the kernel when it
    // returns and can only be read by a later poll of the loop, as a GO pressed 10 ms into the take-over is.
    const server = createServer();
    const seen: number[] = [];
    server.on('connection', (c) => c.on('data', () => seen.push(rows(s.db).length)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const client = connect((server.address() as AddressInfo).port, '127.0.0.1');
    await new Promise<void>((r) => client.once('connect', () => r()));
    const real = LiveService.prototype.apply;
    LiveService.prototype.apply = function (this: LiveService, ...a: Parameters<LiveService['apply']>) {
      if (a[0].k === 'goLive') client.write('k');
      return real.apply(this, a);
    };
    try {
      await s.live.submitQueued({ k: 'goLive', playlistId: 'pl' }, OP);
      for (let i = 0; i < 200 && !seen.length; i++) await new Promise((r) => setTimeout(r, 10));
      expect(seen.length).toBeGreaterThan(0);
      // the key was read with the first copy written and the second not yet: it is applied before the write
      expect(seen[0]).toBe(1);
      // and the second copy is written afterwards, in a turn of its own
      for (let i = 0; i < 200 && rows(s.db).length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      expect(rows(s.db).length).toBe(2);
    } finally {
      LiveService.prototype.apply = real;
      client.destroy();
      await new Promise<void>((r) => server.close(() => r()));
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
