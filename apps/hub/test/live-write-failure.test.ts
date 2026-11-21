/**
 * An event whose journal write fails (the data folder's disk is full) is not applied: the service keeps the state
 * it had, nothing is sent, the next event follows the old seq with no gap, and a restart restores the old service
 * (repair 1 of sub-wave 2: `apply` used to assign the new state before the write, so a failed goLive left the new
 * service in memory, unsaved and unannounced, and the screens resynced onto a service whose GO had been reported
 * as failed).
 */
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { openLiveDb } from '../src/db.ts';
import { LiveService } from '../src/live.ts';
import { bigBundle, bundleBytes, bundleSource } from './byref-helpers.ts';
import { tempDir } from './helpers.ts';

const quiet = pino({ level: 'silent' });
const OP = { role: 'operate' as const };
const open: LiveService[] = [];
afterEach(() => {
  for (const l of open.splice(0)) l.stop();
});
const turn = () => new Promise((r) => setImmediate(r));
const later = async () => {
  await turn();
  await turn();
};

function setup(byRef: boolean) {
  const db = openLiveDb(join(tempDir(), 'live.db'));
  const bundles = {
    pl1: bundleBytes(bigBundle(1, 'pl1')),
    pl2: bundleBytes(bigBundle(1, 'pl2')),
  };
  const make = () => {
    const live = new LiveService(db, bundleSource(bundles), quiet, { snapshotIntervalMs: 60_000, byRef });
    open.push(live);
    return live;
  };
  return { db, live: make(), make };
}

/** Every write to the journal fails with the message SQLite gives on a full disk, until `heal` runs. */
function failJournal(db: ReturnType<typeof openLiveDb>): () => void {
  db.exec(
    `CREATE TRIGGER fail_journal BEFORE INSERT ON live_journal BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`,
  );
  return () => db.exec(`DROP TRIGGER fail_journal`);
}

describe('an event whose write fails is not applied', () => {
  for (const byRef of [true, false]) {
    it(`a goLive that cannot be written leaves the old service running (byRef ${byRef})`, async () => {
      const { db, live, make } = setup(byRef);
      await live.submitQueued({ k: 'goLive', playlistId: 'pl1' }, OP);
      await later();
      const before = live.state;
      const copyBefore = live.resolvedCopy()?.id;
      const deltas: number[] = [];
      live.onDelta((d) => deltas.push(d.seq));
      const heal = failJournal(db);
      await expect(live.submitQueued({ k: 'goLive', playlistId: 'pl2' }, OP)).rejects.toThrow(/disk is full/);
      await later();
      expect(live.state === before, `the state advanced from seq ${before.seq} to ${live.state.seq}`).toBe(true);
      expect(live.state.resolved?.playlist.id).toBe('pl1');
      expect(live.resolvedCopy()?.id).toBe(copyBefore);
      expect(deltas).toEqual([]);
      heal();
      // the next key follows the old seq: no gap for a screen to resync over
      const seq = live.submit({ k: 'next', at: Date.now() }, OP);
      expect(seq).toBe(before.seq + 1);
      expect(deltas).toEqual([before.seq + 1]);
      // a restart restores the service that was running, not the one whose GO failed
      const again = make();
      again.restore();
      expect(again.state.resolved?.playlist.id).toBe('pl1');
    });
  }

  it('a key whose journal row cannot be written is not applied either', async () => {
    const { db, live } = setup(true);
    await live.submitQueued({ k: 'goLive', playlistId: 'pl1' }, OP);
    await later();
    const before = live.state;
    const heal = failJournal(db);
    expect(() => live.submit({ k: 'next', at: Date.now() }, OP)).toThrow(/disk is full/);
    expect(live.state === before, `the state advanced from seq ${before.seq} to ${live.state.seq}`).toBe(true);
    heal();
    expect(live.submit({ k: 'next', at: Date.now() }, OP)).toBe(before.seq + 1);
  });

  it('End service that cannot be written leaves the service running, copy kept', async () => {
    const { db, live } = setup(true);
    await live.submitQueued({ k: 'goLive', playlistId: 'pl1' }, OP);
    await later();
    const before = live.state;
    const copyBefore = live.resolvedCopy()?.id;
    const heal = failJournal(db);
    expect(() => live.submit({ k: 'endService', at: Date.now() }, OP)).toThrow(/disk is full/);
    expect(live.state === before, `the state advanced from seq ${before.seq} to ${live.state.seq}`).toBe(true);
    expect(live.resolvedCopy()?.id).toBe(copyBefore);
    heal();
  });

  it('an adopted operator state that cannot be written is refused and the hub keeps its own', async () => {
    const { db, live } = setup(true);
    await live.submitQueued({ k: 'goLive', playlistId: 'pl1' }, OP);
    await later();
    const before = live.state;
    const incoming = JSON.parse(JSON.stringify(before)) as typeof before;
    const heal = failJournal(db);
    const r = live.adopt(incoming, true);
    expect(r.ok).toBe(false);
    expect(live.state === before, `the state advanced from seq ${before.seq} to ${live.state.seq}`).toBe(true);
    heal();
    expect(live.adopt(incoming, true)).toEqual({ ok: true, seq: before.seq + 1 });
  });
});
