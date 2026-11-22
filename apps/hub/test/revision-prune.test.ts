/**
 * Pruning a presentation's revisions (`Library.pruneRevisions`, run at the end of every save; migration 16): a revision is deleted
 * only when it is older than 30 days AND not among the newest 50 of its presentation, and deciding that must not read a revision's
 * body. A revision is a full copy of the presentation (up to 8 MiB) and in the row `saved_at` is stored after the `json`, so a
 * statement that reads `saved_at` from the table walks the body's overflow pages to reach it: 653 kept revisions of a 2.2 MiB
 * presentation made every save take 295 to 305 ms (half the save) for a DELETE that deleted nothing, and the time grew with every
 * revision kept. The index of migration 16 answers `saved_at` (and `rev`) without a table row.
 */
import { join } from 'node:path';
import Database from 'better-sqlite3';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, migrate } from '../src/db.ts';
import type { Library } from '../src/library.ts';
import { song, startHub, type TestHub, tempDir } from './helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await hub?.cleanup();
  hub = undefined;
});

const DAY = 86_400_000;
const KEEP_NEWEST = 50;
const INDEX = 'presentation_revisions_saved';
const PRUNE_MIGRATION = () => MIGRATIONS.find((m) => m.name === 'revision-saved-at');
const names = (db: Database.Database, type: string) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(type) as { name: string }[]).map(
    (r) => r.name,
  );
const body = (title: string) =>
  JSON.stringify({ id: 'p', rev: 1, title, kind: 'deck', meta: { tags: [] }, sections: [] });

type Row = { rev: number; savedAt: string };

/** The statement an older build ran (before migration 16) to prune: kept here so an older build's writes can be tested. */
const OLD_PRUNE = `DELETE FROM presentation_revisions WHERE presentation_id = ? AND saved_at < ? AND rev NOT IN
  (SELECT rev FROM presentation_revisions WHERE presentation_id = ? ORDER BY rev DESC LIMIT 50)`;

/** Revision rows as a test (or an older hub) writes them, with the dates it chooses. */
function putRevisions(db: Database.Database, id: string, rows: readonly Row[]): void {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO presentation_revisions (presentation_id, rev, json, saved_by, saved_at) VALUES (?, ?, ?, NULL, ?)`,
  );
  db.transaction(() => {
    for (const r of rows) ins.run(id, r.rev, body(`T${r.rev}`), r.savedAt);
  })();
}
const revsOf = (db: Database.Database, id: string): number[] =>
  (
    db.prepare(`SELECT rev FROM presentation_revisions WHERE presentation_id = ? ORDER BY rev`).all(id) as {
      rev: number;
    }[]
  ).map((r) => r.rev);

/** The rule as its words say it, written without SQL: what is left of `rows` when `now` prunes them. */
function kept(rows: readonly Row[], now: number): number[] {
  const cutoff = new Date(now - 30 * DAY).toISOString();
  const newest = new Set(
    [...rows]
      .sort((a, b) => b.rev - a.rev)
      .slice(0, KEEP_NEWEST)
      .map((r) => r.rev),
  );
  return rows
    .filter((r) => !(r.savedAt < cutoff && !newest.has(r.rev)))
    .map((r) => r.rev)
    .sort((a, b) => a - b);
}

/** `n` saves of one presentation through the library (revisions 1..n), all dated now. */
function saveRevisions(lib: Library, n: number): string {
  let cur = lib.savePresentation(song(), { create: true });
  for (let i = 1; i < n; i++)
    cur = lib.savePresentation({ ...cur, title: `t${i}` }, { expectedRev: cur.rev });
  return cur.id;
}
const dateAll = (lib: Library, id: string, iso: string) =>
  lib.db.prepare(`UPDATE presentation_revisions SET saved_at = ? WHERE presentation_id = ?`).run(iso, id);

// ── migration 16 ───────────────────────────────────────────────────────────────────────────────────────────────

describe('migration 16: the index that answers saved_at without a revision row', () => {
  it('is migration 16, makes the index once (presentation_id, saved_at, rev), and re-applying it changes nothing', () => {
    const m = PRUNE_MIGRATION();
    expect(m, 'a migration named revision-saved-at').toBeDefined();
    expect(m!.version).toBe(16);
    const db = new Database(join(tempDir(), 'm16.db'));
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(names(db, 'index')).toContain(INDEX);
    expect(
      (db.prepare(`PRAGMA index_info(${INDEX})`).all() as { seqno: number; name: string }[])
        .sort((a, b) => a.seqno - b.seqno)
        .map((c) => c.name),
    ).toEqual(['presentation_id', 'saved_at', 'rev']);
    const before = db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all();
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    for (const x of MIGRATIONS) db.exec(x.sql);
    expect(db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all()).toEqual(before);
    db.close();
  });

  it('migrates a database made before it, keeps its revisions and indexes them', () => {
    const m = PRUNE_MIGRATION();
    expect(m).toBeDefined();
    const db = new Database(join(tempDir(), 'before.db'));
    migrate(
      db,
      MIGRATIONS.filter((x) => x.version < m!.version),
    );
    const rows = Array.from({ length: 5 }, (_, i) => ({
      rev: i + 1,
      savedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    }));
    putRevisions(db, 'p1', rows);
    expect(names(db, 'index')).not.toContain(INDEX);
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(revsOf(db, 'p1')).toEqual([1, 2, 3, 4, 5]);
    // the index holds every row: the rows it finds are the ones a scan of the table finds
    const byIndex = db
      .prepare(
        `SELECT rev FROM presentation_revisions INDEXED BY ${INDEX} WHERE presentation_id = 'p1' AND saved_at < ?`,
      )
      .all(rows[3]!.savedAt);
    expect(byIndex).toEqual([{ rev: 1 }, { rev: 2 }, { rev: 3 }]);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    db.close();
  });

  it('is a no-op for an older build, which opens the folder and writes, replaces and deletes revisions without error', () => {
    const m = PRUNE_MIGRATION();
    expect(m).toBeDefined();
    const db = new Database(join(tempDir(), 'older.db'));
    migrate(db);
    db.pragma('foreign_keys = ON');
    // an older build's list ends at 15: it skips what it does not know and opens a folder that is at 16
    expect(
      migrate(
        db,
        MIGRATIONS.filter((x) => x.version < m!.version),
      ),
    ).toBe(MIGRATIONS.at(-1)!.version);
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    // what an older hub writes: its own statements, on a database that has the index (the index is kept by the database itself)
    putRevisions(
      db,
      'p1',
      Array.from({ length: 60 }, (_, i) => ({ rev: i + 1, savedAt: old })),
    );
    putRevisions(db, 'p1', [{ rev: 60, savedAt: new Date().toISOString() }]);
    expect(db.prepare(OLD_PRUNE).run('p1', new Date(Date.now() - 30 * DAY).toISOString(), 'p1').changes).toBe(
      10,
    );
    expect(revsOf(db, 'p1')).toEqual(Array.from({ length: 50 }, (_, i) => i + 11));
    db.prepare(`DELETE FROM presentation_revisions WHERE presentation_id = 'p1'`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM presentation_revisions`).get()).toEqual({ n: 0 });
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    db.close();
  });
});

// ── the work: no revision row is visited ──────────────────────────────────────────────────────────────────────────

describe('pruning does not read the revisions it keeps', () => {
  it('plans every statement it runs on the revisions through a covering index: no row of the table, so no body, is visited', async () => {
    hub = await startHub();
    // the rows are written directly: a save would prune first, and the references index keeps its statements once prepared
    const id = 'planned';
    putRevisions(
      hub.lib.db,
      id,
      Array.from({ length: 3 }, (_, i) => ({ rev: i + 1, savedAt: new Date().toISOString() })),
    );
    const prepare = vi.spyOn(hub.lib.db, 'prepare');
    hub.lib.pruneRevisions(id);
    const sqls = prepare.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => /\bpresentation_revisions\b/.test(s));
    vi.restoreAllMocks();
    // not vacuous: the pruning's DELETE of revisions is among the statements it prepared
    const del = sqls.filter((s) => /^\s*DELETE\s+FROM\s+presentation_revisions\b/i.test(s));
    expect(del.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      // the plan with every parameter bound to some text: the planner reads no data and has no statistics here
      const args = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 'x');
      const plan = (hub.lib.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map(
        (r) => r.detail,
      );
      const visits = plan.filter((d) => /^(SEARCH|SCAN) presentation_revisions\b/.test(d));
      expect(visits.length, `${sql}\n${plan.join('\n')}`).toBeGreaterThan(0);
      for (const d of visits) expect(d, sql).toMatch(/USING COVERING INDEX/);
    }
    // and the date test is answered by the new index, not by the primary key plus the table row
    const plan = (
      hub.lib.db.prepare(`EXPLAIN QUERY PLAN ${del[0]}`).all(...del[0]!.match(/\?/g)!.map(() => 'x')) as {
        detail: string;
      }[]
    ).map((r) => r.detail);
    expect(plan.join(' | ')).toMatch(
      new RegExp(`USING COVERING INDEX ${INDEX} \\(presentation_id=\\? AND saved_at<\\?\\)`),
    );
  });
});

// ── the rule: older than 30 days AND not among the newest 50 ─────────────────────────────────────────────────────

describe('the retention rule: a revision goes only when it is older than 30 days and not among the newest 50', () => {
  const cases: { n: number; age: 'old' | 'recent'; left: number }[] = [
    { n: 49, age: 'old', left: 49 },
    { n: 50, age: 'old', left: 50 },
    { n: 51, age: 'old', left: 50 },
    { n: 49, age: 'recent', left: 49 },
    { n: 50, age: 'recent', left: 50 },
    { n: 51, age: 'recent', left: 51 },
  ];
  it.each(cases)('$n revisions, all $age: $left are left', async ({ n, age, left }) => {
    hub = await startHub();
    const id = saveRevisions(hub.lib, n);
    const now = Date.now();
    dateAll(hub.lib, id, new Date(now - (age === 'old' ? 31 : 29) * DAY).toISOString());
    hub.lib.pruneRevisions(id, now);
    const revs = revsOf(hub.lib.db, id);
    expect(revs).toHaveLength(left);
    // what is left is the newest of them
    expect(revs.at(-1)).toBe(n);
    expect(revs[0]).toBe(n - left + 1);
  });

  it('every save prunes: sixty old revisions and one more save leave the newest 50', async () => {
    hub = await startHub();
    const id = saveRevisions(hub.lib, 60);
    dateAll(hub.lib, id, new Date(Date.now() - 45 * DAY).toISOString());
    expect(revsOf(hub.lib.db, id)).toHaveLength(60); // nothing pruned them: the dates were changed after
    const cur = hub.lib.presentations.must(id);
    hub.lib.savePresentation({ ...cur, title: 'one more' }, { expectedRev: cur.rev });
    expect(revsOf(hub.lib.db, id)).toEqual(Array.from({ length: 50 }, (_, i) => i + 12)); // 12..61
  });

  it('keeps a revision of exactly 30 days and deletes one of 30 days and a millisecond', async () => {
    hub = await startHub();
    const id = saveRevisions(hub.lib, 60);
    const now = Date.now();
    const at = (rev: number, ms: number) =>
      hub!.lib.db
        .prepare(`UPDATE presentation_revisions SET saved_at = ? WHERE presentation_id = ? AND rev = ?`)
        .run(new Date(now - ms).toISOString(), id, rev);
    at(1, 30 * DAY); // exactly the cutoff: not older than it
    at(2, 30 * DAY + 1); // older
    at(3, 30 * DAY - 1); // newer
    hub.lib.pruneRevisions(id, now);
    expect(revsOf(hub.lib.db, id)).toEqual([1, ...Array.from({ length: 58 }, (_, i) => i + 3)]);
  });

  it('is by rev, not by date: old revisions among the newest 50 stay and recent ones beyond them stay', async () => {
    hub = await startHub();
    const now = Date.now();
    const old = new Date(now - 90 * DAY).toISOString();
    const recent = new Date(now - 1 * DAY).toISOString();
    // a clock that went back: the newest 20 revisions carry the old dates, the 40 before them recent ones
    const rows: Row[] = Array.from({ length: 60 }, (_, i) => ({
      rev: i + 1,
      savedAt: i >= 40 ? old : recent,
    }));
    putRevisions(hub.lib.db, 'clock', rows);
    hub.lib.pruneRevisions('clock', now);
    expect(revsOf(hub.lib.db, 'clock')).toHaveLength(60);
    // the other way: old dates on the oldest 20, recent after: the oldest 10 (beyond the newest 50) go
    putRevisions(
      hub.lib.db,
      'normal',
      Array.from({ length: 60 }, (_, i) => ({ rev: i + 1, savedAt: i < 20 ? old : recent })),
    );
    hub.lib.pruneRevisions('normal', now);
    expect(revsOf(hub.lib.db, 'normal')).toEqual(Array.from({ length: 50 }, (_, i) => i + 11));
  });

  it("touches only its own presentation's revisions", async () => {
    hub = await startHub();
    const now = Date.now();
    const old = new Date(now - 90 * DAY).toISOString();
    const rows = Array.from({ length: 70 }, (_, i) => ({ rev: i + 1, savedAt: old }));
    putRevisions(hub.lib.db, 'a', rows);
    putRevisions(hub.lib.db, 'b', rows);
    hub.lib.pruneRevisions('a', now);
    expect(revsOf(hub.lib.db, 'a')).toHaveLength(50);
    expect(revsOf(hub.lib.db, 'b')).toHaveLength(70);
    hub.lib.pruneRevisions('nobody', now);
    expect(revsOf(hub.lib.db, 'b')).toHaveLength(70);
  });

  it('is what the words say for any revisions, numbered with gaps and dated around the cutoff', async () => {
    hub = await startHub();
    const lib = hub.lib;
    const now = Date.now();
    const AGES = [90 * DAY, 30 * DAY + 1, 30 * DAY, 30 * DAY - 1, 29 * DAY, 0];
    let run = 0;
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ rev: fc.integer({ min: 1, max: 400 }), age: fc.constantFrom(...AGES) }), {
          selector: (r) => r.rev,
          maxLength: 130,
        }),
        (rs) => {
          const id = `prop${run++}`;
          const rows: Row[] = rs.map((r) => ({ rev: r.rev, savedAt: new Date(now - r.age).toISOString() }));
          putRevisions(lib.db, id, rows);
          lib.pruneRevisions(id, now);
          expect(revsOf(lib.db, id)).toEqual(kept(rows, now));
        },
      ),
      { numRuns: 150 },
    );
  });
});
