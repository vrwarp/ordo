/**
 * Revision summaries (design/28 P2, the title only): the History list of a deck reads one small row per kept revision and never
 * parses a revision's JSON, because a revision is a full copy of its presentation (up to 8 MiB: 57 of them took 5.4 s and 2.2 GiB
 * of the library process to list). Migration 15, the triggers that keep a summary honest, the reading of a row that has none, the
 * paced backfill and the scanner that finds a title in the first characters of a body.
 */
import { join } from 'node:path';
import { newId, type Playlist, type Presentation } from '@ordo/domain';
import { budgetMs, cpuMs } from '@ordo/domain/timing.test-util.ts';
import type { RevisionInfo } from '@ordo/protocol';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, migrate } from '../src/db.ts';
import type { Library } from '../src/library.ts';
import {
  RevisionTitleBackfill,
  TITLE_PREFIX_CHARS,
  TITLE_WIDE_PREFIX_CHARS,
  titleTokenIn,
} from '../src/revisions.ts';
import {
  type Client,
  EDIT_PIN,
  login,
  OPERATE_PIN,
  song,
  startHub,
  type TestHub,
  tempDir,
} from './helpers.ts';
import { type TwoProcesses, twoProcesses } from './phones-helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await hub?.cleanup();
  hub = undefined;
});

const SUMMARY_MIGRATION = () => MIGRATIONS.find((m) => m.name === 'revision-summaries');
const names = (db: Database.Database, type: string) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(type) as { name: string }[]).map(
    (r) => r.name,
  );
const TRIGGERS = ['revision_summaries_replace', 'revision_summaries_delete', 'revision_summaries_edit'];

/** What the list answered before summaries existed: every revision parsed, its title read. The reading must not change. */
function oracle(lib: Library, id: string): RevisionInfo[] {
  const rows = lib.db
    .prepare(
      `SELECT rev, json, saved_by, saved_at FROM presentation_revisions WHERE presentation_id = ? ORDER BY rev DESC`,
    )
    .all(id) as { rev: number; json: string; saved_by: string | null; saved_at: string }[];
  return rows.map((r) => ({
    rev: r.rev,
    savedAt: r.saved_at,
    savedBy: r.saved_by ?? undefined,
    title: (JSON.parse(r.json) as Presentation).title,
  }));
}

/** A revision row as an older hub (or a test) writes it: no summary is made. */
function rawRevision(
  lib: Library,
  id: string,
  rev: number,
  json: string,
  by: string | null = null,
  at = new Date(Date.UTC(2026, 0, 1, 0, 0, rev)).toISOString(),
): void {
  lib.db
    .prepare(
      `INSERT OR REPLACE INTO presentation_revisions (presentation_id, rev, json, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, rev, json, by, at);
}
const summaryRows = (lib: Library, id?: string) =>
  lib.db
    .prepare(
      `SELECT presentation_id, rev, title_json, saved_by, saved_at FROM revision_summaries ${id ? 'WHERE presentation_id = ?' : ''} ORDER BY presentation_id, rev`,
    )
    .all(...(id ? [id] : [])) as {
    presentation_id: string;
    rev: number;
    title_json: string;
    saved_by: string | null;
    saved_at: string;
  }[];
const body = (title: string, pad = '') =>
  JSON.stringify({ id: 'p', rev: 1, title, kind: 'deck', meta: { tags: [] }, sections: [], pad });

// ── migration 15 ───────────────────────────────────────────────────────────────────────────────────────────────

describe('migration 15: revision summaries', () => {
  it('is the last migration, makes the table and its three triggers once, and re-applying it changes nothing', () => {
    const m = SUMMARY_MIGRATION();
    expect(m, 'a migration named revision-summaries').toBeDefined();
    expect(m!.version).toBe(15);
    expect(MIGRATIONS.at(-1)!.version).toBe(15);
    const db = new Database(join(tempDir(), 'm15.db'));
    expect(migrate(db)).toBe(15);
    expect(names(db, 'table')).toContain('revision_summaries');
    for (const t of TRIGGERS) expect(names(db, 'trigger'), t).toContain(t);
    const before = db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all();
    expect(migrate(db)).toBe(15);
    for (const x of MIGRATIONS) db.exec(x.sql);
    expect(db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all()).toEqual(before);
    db.close();
  });

  it('migrates a database made before it, keeps its revisions, and starts with no summary at all', () => {
    const m = SUMMARY_MIGRATION();
    expect(m).toBeDefined();
    const db = new Database(join(tempDir(), 'before.db'));
    const older = MIGRATIONS.filter((x) => x.version < m!.version);
    migrate(db, older);
    db.prepare(
      `INSERT INTO presentation_revisions (presentation_id, rev, json, saved_by, saved_at) VALUES ('p1', 3, ?, 'edit@1', '2026-01-01T00:00:00.000Z')`,
    ).run(body('Old'));
    expect(names(db, 'table')).not.toContain('revision_summaries');
    expect(migrate(db)).toBe(15);
    expect(
      db.prepare(`SELECT rev, saved_by FROM presentation_revisions WHERE presentation_id = 'p1'`).get(),
    ).toEqual({
      rev: 3,
      saved_by: 'edit@1',
    });
    // nothing is copied by the migration (a backfill that parsed every body at start would be the 5.4 s again)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM revision_summaries`).get()).toEqual({ n: 0 });
    db.close();
  });

  it('is a no-op for an older build, which opens the folder, writes revisions and deletes them without error', () => {
    const m = SUMMARY_MIGRATION();
    expect(m).toBeDefined();
    const db = new Database(join(tempDir(), 'older.db'));
    migrate(db);
    db.pragma('foreign_keys = ON');
    const older = MIGRATIONS.filter((x) => x.version < m!.version);
    expect(migrate(db, older)).toBe(15);
    // what an older hub writes: its own statements, on a database that has the table and the triggers
    db.prepare(
      `INSERT OR REPLACE INTO presentation_revisions (presentation_id, rev, json, saved_by, saved_at) VALUES ('p1', 1, ?, NULL, 'a')`,
    ).run(body('One'));
    db.prepare(
      `INSERT OR REPLACE INTO presentation_revisions (presentation_id, rev, json, saved_by, saved_at) VALUES ('p1', 1, ?, NULL, 'b')`,
    ).run(body('Two'));
    db.prepare(`DELETE FROM presentation_revisions WHERE presentation_id = 'p1'`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM presentation_revisions`).get()).toEqual({ n: 0 });
    db.close();
  });
});

// ── the summary written with the revision ────────────────────────────────────────────────────────────────────────

describe('a revision carries its summary from the save', () => {
  it('writes the title as its JSON string literal with who and when, in the save, and the list says what it always said', async () => {
    hub = await startHub();
    const titles = [
      'Amazing Grace',
      'Quote " backslash \\ newline\n tab\t é 日本語 😀',
      'Lone \ud83d surrogate',
      'Nul \u0000 char',
    ];
    let cur = hub.lib.savePresentation(song(titles[0]), { create: true, by: 'edit@10.0.0.2' });
    for (const t of titles.slice(1))
      cur = hub.lib.savePresentation({ ...cur, title: t }, { expectedRev: cur.rev });
    const rows = summaryRows(hub.lib, cur.id);
    expect(rows.map((r) => r.rev)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.title_json)).toEqual(titles.map((t) => JSON.stringify(t)));
    expect(rows[0]).toMatchObject({ saved_by: 'edit@10.0.0.2' });
    expect(rows[1]!.saved_by).toBeNull();
    const revs = hub.lib.db
      .prepare(`SELECT rev, saved_at FROM presentation_revisions WHERE presentation_id = ? ORDER BY rev`)
      .all(cur.id) as { rev: number; saved_at: string }[];
    expect(rows.map((r) => r.saved_at)).toEqual(revs.map((r) => r.saved_at));
    expect(hub.lib.revisions(cur.id)).toEqual(oracle(hub.lib, cur.id));
    expect(hub.lib.revisions(cur.id).map((r) => r.title)).toEqual([...titles].reverse());
  });

  it('keeps the summary of a restored revision (the restore is a new revision) and restores as before', async () => {
    hub = await startHub();
    const p = hub.lib.savePresentation(song('First'), { create: true });
    const p2 = hub.lib.savePresentation({ ...p, title: 'Second' }, { expectedRev: p.rev });
    expect(p2.rev).toBe(2);
    const restored = hub.lib.restoreRevision(p.id, 1, 'edit@1');
    expect(restored.rev).toBe(3);
    expect(restored.title).toBe('First');
    expect(summaryRows(hub.lib, p.id).map((r) => [r.rev, r.title_json, r.saved_by])).toEqual([
      [1, '"First"', null],
      [2, '"Second"', null],
      [3, '"First"', 'edit@1'],
    ]);
    expect(hub.lib.revisions(p.id).map((r) => [r.rev, r.title, r.savedBy])).toEqual([
      [3, 'First', 'edit@1'],
      [2, 'Second', undefined],
      [1, 'First', undefined],
    ]);
  });

  it('removes the summaries of the revisions it prunes, and prunes the same ones', async () => {
    hub = await startHub();
    const p = hub.lib.savePresentation(song(), { create: true });
    let cur = p;
    for (let i = 0; i < 59; i++)
      cur = hub.lib.savePresentation({ ...cur, title: `t${i}` }, { expectedRev: cur.rev });
    expect(summaryRows(hub.lib, p.id)).toHaveLength(60);
    // forty days on: every revision is older than 30 days, so the newest 50 are what stays
    hub.lib.pruneRevisions(p.id, Date.now() + 40 * 86400_000);
    expect(summaryRows(hub.lib, p.id).map((r) => r.rev)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 11),
    );
    const revs = hub.lib.revisions(p.id);
    expect(revs.map((r) => r.rev)).toEqual(Array.from({ length: 50 }, (_, i) => 60 - i));
    expect(revs).toEqual(oracle(hub.lib, p.id));
  });
});

// ── the list never parses a body ─────────────────────────────────────────────────────────────────────────────────

describe('the list reads summaries, not bodies', () => {
  it('answers from the summaries when no body can be parsed (the bodies are not valid JSON beyond their title)', async () => {
    hub = await startHub();
    for (let rev = 1; rev <= 5; rev++) {
      rawRevision(
        hub.lib,
        'pX',
        rev,
        `{"id":"pX","rev":${rev},"title":"T${rev}" this is not JSON ${'x'.repeat(200)}`,
        rev % 2 ? 'edit@1' : null,
      );
      hub.lib.summaries.record(
        'pX',
        rev,
        `T${rev}`,
        rev % 2 ? 'edit@1' : null,
        new Date(Date.UTC(2026, 0, 1, 0, 0, rev)).toISOString(),
      );
    }
    const list = hub.lib.revisions('pX');
    expect(list.map((r) => [r.rev, r.title, r.savedBy])).toEqual([
      [5, 'T5', 'edit@1'],
      [4, 'T4', undefined],
      [3, 'T3', 'edit@1'],
      [2, 'T2', undefined],
      [1, 'T1', 'edit@1'],
    ]);
  });

  it('parses no body of 3 MiB: JSON.parse sees nothing larger than a title, and the list is quick', async () => {
    hub = await startHub();
    const pad = 'x'.repeat(3 * 1024 * 1024);
    for (let rev = 1; rev <= 6; rev++) {
      rawRevision(hub.lib, 'pBig', rev, body(`Big ${rev}`, pad));
      hub.lib.summaries.record(
        'pBig',
        rev,
        `Big ${rev}`,
        null,
        new Date(Date.UTC(2026, 0, 1, 0, 0, rev)).toISOString(),
      );
    }
    const parse = vi.spyOn(JSON, 'parse');
    const t0 = cpuMs();
    const list = hub.lib.revisions('pBig');
    const ms = cpuMs() - t0;
    const biggest = Math.max(0, ...parse.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0].length : 0)));
    expect(biggest).toBeLessThan(2000);
    expect(list.map((r) => r.title)).toEqual(['Big 6', 'Big 5', 'Big 4', 'Big 3', 'Big 2', 'Big 1']);
    // six 3 MiB bodies took about a second to read and parse; the summaries are read in a few milliseconds
    expect(ms).toBeLessThan(budgetMs(250));
  });

  it('reads the keys of a presentation from the index alone: the plan never visits a revision row', async () => {
    hub = await startHub();
    const plan = hub.lib.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT r.rev AS rev, s.title_json AS title_json, s.saved_by AS saved_by, s.saved_at AS saved_at
         FROM presentation_revisions r
         LEFT JOIN revision_summaries s ON s.presentation_id = r.presentation_id AND s.rev = r.rev
         WHERE r.presentation_id = ? ORDER BY r.rev DESC`,
      )
      .all('p') as { detail: string }[];
    const text = plan.map((r) => r.detail).join(' | ');
    expect(text).toMatch(/COVERING INDEX sqlite_autoindex_presentation_revisions/);
    expect(text).toMatch(/SEARCH s USING (COVERING )?INDEX sqlite_autoindex_revision_summaries/);
    expect(text).not.toMatch(/SCAN r\b(?! USING)/);
  });

  it('lists a presentation with no revision as before', async () => {
    hub = await startHub();
    expect(hub.lib.revisions('nobody')).toEqual([]);
  });
});

// ── a revision without a summary ─────────────────────────────────────────────────────────────────────────────────

describe('a revision with no summary (an older hub saved it) is read one row at a time', () => {
  const shapes: [string, string][] = [
    ['title first', body('Plain')],
    ['escapes and astral characters', body('Q " B \\ N\n T\t é 日本語 😀   {"title":"evil"}')],
    ['a lone surrogate and a NUL', body('S \ud83d N \u0000 end')],
    ['pretty printed', JSON.stringify(JSON.parse(body('Pretty')), null, 2)],
    [
      'a nested title before the real one',
      JSON.stringify({
        id: 'p',
        meta: { title: 'nested', tags: ['title', '"title":"x"'] },
        sections: [{ title: 'section', slides: [] }],
        title: 'Real',
        kind: 'deck',
      }),
    ],
    [
      'the title after 40 KiB of slides',
      JSON.stringify({
        id: 'p',
        rev: 1,
        sections: [{ id: 's', pad: 'y'.repeat(40_000) }],
        title: 'Late',
        kind: 'deck',
      }),
    ],
    [
      'the title after 2 MiB of slides',
      JSON.stringify({
        id: 'p',
        rev: 1,
        sections: [{ id: 's', pad: 'z'.repeat(2 * 1024 * 1024) }],
        title: 'Very late',
        kind: 'deck',
      }),
    ],
    ['a key spelled with an escape (t\\u0069tle)', '{"id":"p","t\\u0069tle":"Escaped key","kind":"deck"}'],
    ['no title at all', JSON.stringify({ id: 'p', rev: 1, kind: 'deck' })],
  ];

  it.each(shapes)('gives the title the old reading gave: %s', async (_name, json) => {
    hub = await startHub();
    rawRevision(hub.lib, 'pS', 1, json, 'edit@9');
    rawRevision(hub.lib, 'pS', 2, body('Decoy: the revision after it'), 'edit@8');
    const before = oracle(hub.lib, 'pS');
    expect(hub.lib.revisions('pS')).toEqual(before);
    // and the next call finds the summary the first one made (a title that exists)
    if (before[1]!.title !== undefined) {
      expect(summaryRows(hub.lib, 'pS')).toHaveLength(2);
      const parse = vi.spyOn(JSON, 'parse');
      expect(hub.lib.revisions('pS')).toEqual(before);
      expect(
        Math.max(0, ...parse.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0].length : 0))),
      ).toBeLessThan(2000);
    }
  });

  it('lists a body that cannot be read with an empty title, and the others as they are', async () => {
    hub = await startHub();
    rawRevision(hub.lib, 'pC', 1, body('Good one'));
    rawRevision(hub.lib, 'pC', 2, '{"id":"pC","title":"Cut off', null);
    rawRevision(hub.lib, 'pC', 3, 'not json at all');
    const list = hub.lib.revisions('pC');
    expect(list.map((r) => [r.rev, r.title])).toEqual([
      [3, ''],
      [2, ''],
      [1, 'Good one'],
    ]);
  });

  it('never reads two revisions into memory at once: every statement that selects a body names one revision', async () => {
    hub = await startHub();
    for (let rev = 1; rev <= 8; rev++) rawRevision(hub.lib, 'pO', rev, body(`T${rev}`, 'p'.repeat(1000)));
    const seen: string[] = [];
    const real = hub.lib.db.prepare.bind(hub.lib.db);
    vi.spyOn(hub.lib.db, 'prepare').mockImplementation(((sql: string) => {
      seen.push(sql);
      return real(sql);
    }) as typeof hub.lib.db.prepare);
    expect(hub.lib.revisions('pO')).toHaveLength(8);
    const readsBody = seen.filter(
      (s) => /\bjson\b/i.test(s.replace(/title_json/gi, '')) && /^\s*SELECT/i.test(s),
    );
    expect(readsBody.length).toBeGreaterThan(0);
    for (const s of readsBody) expect(s, 'a statement that reads a body').toMatch(/rev\s*=\s*\?/);
    // and the first call has recorded them: the second reads none
    seen.length = 0;
    expect(hub.lib.revisions('pO')).toHaveLength(8);
    expect(
      seen.filter((s) => /\bjson\b/i.test(s.replace(/title_json/gi, '')) && /^\s*SELECT/i.test(s)),
    ).toEqual([]);
  });
});

// ── an older hub's writes cannot leave a wrong summary ───────────────────────────────────────────────────────────

describe('the triggers keep a summary honest, whoever writes', () => {
  it('forgets the summary of a revision that is replaced, edited or deleted, and lists the new truth', async () => {
    hub = await startHub();
    const p = hub.lib.savePresentation(song('Kept'), { create: true });
    const p2 = hub.lib.savePresentation({ ...p, title: 'Second' }, { expectedRev: p.rev });
    expect(summaryRows(hub.lib, p.id)).toHaveLength(2);
    // an older hub saves over (id, rev 2) with other content: INSERT OR REPLACE, no summary written
    rawRevision(hub.lib, p.id, 2, body('Rewritten'), 'edit@old', '2026-03-03T00:00:00.000Z');
    expect(summaryRows(hub.lib, p.id).map((r) => r.rev)).toEqual([1]);
    expect(hub.lib.revisions(p.id).map((r) => [r.rev, r.title, r.savedBy, r.savedAt])).toEqual([
      [2, 'Rewritten', 'edit@old', '2026-03-03T00:00:00.000Z'],
      [1, 'Kept', undefined, expect.any(String)],
    ]);
    // a change of who or when, in place
    hub.lib.db
      .prepare(`UPDATE presentation_revisions SET saved_by = 'someone' WHERE presentation_id = ? AND rev = 1`)
      .run(p.id);
    expect(hub.lib.revisions(p.id).find((r) => r.rev === 1)!.savedBy).toBe('someone');
    // a delete leaves no summary behind
    hub.lib.db.prepare(`DELETE FROM presentation_revisions WHERE presentation_id = ?`).run(p2.id);
    expect(summaryRows(hub.lib, p.id)).toEqual([]);
    expect(hub.lib.revisions(p.id)).toEqual([]);
  });
});

// ── the paced backfill ───────────────────────────────────────────────────────────────────────────────────────────

function backfillRig(
  lib: Library,
  over: Partial<ConstructorParameters<typeof RevisionTitleBackfill>[1]> = {},
) {
  let t = 0;
  const lines: Record<string, unknown>[] = [];
  const log = pino({ level: 'info' }, { write: (s: string) => lines.push(JSON.parse(s)) });
  const state = {
    yields: 0,
    sleeps: [] as number[],
    reads: [] as string[],
    live: 'idle' as 'idle' | 'live',
    work: 2,
  };
  const bf = new RevisionTitleBackfill(lib.summaries, {
    live: () => state.live,
    log,
    now: () => t,
    // a macrotask each, so a loop that never ends is a test timeout and not a frozen process
    yield: async () => {
      state.yields++;
      await new Promise<void>((r) => setImmediate(r));
    },
    sleep: async (ms) => {
      state.sleeps.push(ms);
      await new Promise<void>((r) => setImmediate(r));
    },
    onRead: (id, rev) => {
      state.reads.push(`${id}:${rev}`);
      t += state.work; // each revision costs 2 ms on the fake clock
    },
    sliceMs: 5,
    startDelayMs: 0,
    ...over,
  });
  return { bf, state, lines, clock: () => t };
}

function seedRows(lib: Library, perPresentation = 10, presentations = 3): void {
  for (let p = 1; p <= presentations; p++)
    for (let rev = 1; rev <= perPresentation; rev++)
      rawRevision(lib, `p${p}`, rev, body(`P${p} rev ${rev} "q" é`), rev % 3 ? 'edit@1' : null);
}

describe('the backfill', () => {
  it('summarises every revision that has none, one at a time, in slices of at most 5 ms, resting between them', async () => {
    hub = await startHub();
    seedRows(hub.lib);
    expect(hub.lib.summaries.count()).toBe(30);
    const { bf, state, lines } = backfillRig(hub.lib);
    await bf.run();
    expect(hub.lib.summaries.count()).toBe(0);
    expect(state.reads).toHaveLength(30);
    expect(new Set(state.reads).size).toBe(30);
    // 2 ms a revision on the fake clock: a slice of at most 5 ms is at most 3 revisions, and it yields and rests after each
    expect(state.yields).toBeGreaterThanOrEqual(10);
    expect(state.sleeps.length).toBeGreaterThanOrEqual(10);
    expect(Math.min(...state.sleeps)).toBeGreaterThan(0);
    for (const p of ['p1', 'p2', 'p3']) expect(hub.lib.revisions(p)).toEqual(oracle(hub.lib, p));
    expect(lines.some((l) => /backfill finished/i.test(String(l.msg)))).toBe(true);
  });

  it('resumes where it stopped: a second run reads only what the first did not', async () => {
    hub = await startHub();
    seedRows(hub.lib);
    let stopAt = 7;
    const first = backfillRig(hub.lib, {
      onRead: (id, rev) => {
        first.state.reads.push(`${id}:${rev}`);
        if (first.state.reads.length === stopAt) first.bf.stop();
      },
    });
    await first.bf.run();
    expect(first.state.reads).toHaveLength(7);
    expect(hub.lib.summaries.count()).toBe(23);
    stopAt = 0;
    const second = backfillRig(hub.lib);
    await second.bf.run();
    expect(second.state.reads).toHaveLength(23);
    expect(second.state.reads.filter((r) => first.state.reads.includes(r))).toEqual([]);
    expect(hub.lib.summaries.count()).toBe(0);
  });

  it('reads nothing while a service is live, and carries on when it ends', async () => {
    hub = await startHub();
    seedRows(hub.lib, 4, 2);
    const { bf, state } = backfillRig(hub.lib);
    state.live = 'live';
    await bf.run();
    expect(state.reads).toEqual([]);
    expect(hub.lib.summaries.count()).toBe(8);
    state.live = 'idle';
    bf.onLiveMode('idle');
    await vi.waitFor(() => expect(hub?.lib.summaries.count()).toBe(0));
    expect(state.reads).toHaveLength(8);
  });

  it('goes live between two slices: it stops at the next slice, and a revision saved meanwhile keeps its own summary', async () => {
    hub = await startHub();
    seedRows(hub.lib, 8, 1);
    const p = hub.lib.savePresentation(song('Saved meanwhile'), { create: true });
    const { bf, state } = backfillRig(hub.lib, {
      yield: async () => {
        state.yields++;
        await new Promise<void>((r) => setImmediate(r));
        if (state.yields === 2) {
          hub!.lib.savePresentation({ ...p, title: 'Saved during a yield' }, { expectedRev: p.rev });
          state.live = 'live';
        }
      },
    });
    await bf.run();
    const readSoFar = state.reads.length;
    expect(readSoFar).toBeGreaterThan(0);
    expect(readSoFar).toBeLessThan(8);
    expect(summaryRows(hub.lib, p.id).map((r) => r.title_json)).toEqual([
      '"Saved meanwhile"',
      '"Saved during a yield"',
    ]);
    expect(state.reads.some((r) => r.startsWith(`${p.id}:`))).toBe(false);
  });

  it('skips a body it cannot read, says so once, and fills the rest', async () => {
    hub = await startHub();
    seedRows(hub.lib, 5, 1);
    rawRevision(hub.lib, 'p1', 3, 'this is not json');
    const { bf, state, lines } = backfillRig(hub.lib);
    await bf.run();
    expect(state.reads).toHaveLength(5);
    expect(hub.lib.summaries.count()).toBe(1);
    expect(lines.filter((l) => /could not be read|unreadable/i.test(String(l.msg)))).toHaveLength(1);
    // the one it could not read is still listed, empty, and the others are right
    expect(hub.lib.revisions('p1').map((r) => r.title)).toEqual([
      'P1 rev 5 "q" é',
      'P1 rev 4 "q" é',
      '',
      'P1 rev 2 "q" é',
      'P1 rev 1 "q" é',
    ]);
  });

  it('is part of the hub: one for the library, started with it and stopped with it', async () => {
    hub = await startHub();
    expect(hub.revisionTitles).toBeInstanceOf(RevisionTitleBackfill);
  });
});

// ── the route ────────────────────────────────────────────────────────────────────────────────────────────────

describe('GET /presentations/:id/revisions', () => {
  it('answers without parsing the presentation either: the existence check is one row, not the whole document', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    // a presentation of about 200 KB (the real ones are up to 8 MiB: parsing it was 85 ms and 18 MiB a request)
    const big = song();
    big.sections[0]!.slides = Array.from({ length: 300 }, (_, i) => big.sections[0]!.slides[i % 2]!).map(
      (sl) => ({
        ...sl,
        id: newId(),
      }),
    );
    const p = await ed.json<Presentation>('/presentations', { method: 'POST', json: big });
    await ed.json(`/presentations/${p.id}`, { method: 'PUT', json: { ...p, title: 'Second' } });
    expect(JSON.stringify(p).length).toBeGreaterThan(50_000);
    const parse = vi.spyOn(JSON, 'parse');
    const revs = await ed.json<RevisionInfo[]>(`/presentations/${p.id}/revisions`);
    // JSON.parse is the server's and the test client's: the answer is 2 short rows, so nothing above 2,000 characters
    const biggest = Math.max(0, ...parse.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0].length : 0)));
    expect(biggest).toBeLessThan(2000);
    expect(revs.map((r) => [r.rev, r.title])).toEqual([
      [2, 'Second'],
      [1, 'Amazing Grace'],
    ]);
  });

  it('answers 404 for a presentation that is not there, as before', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const res = await ed.fetch('/presentations/nope/revisions');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'not_found',
      message: 'presentation nope not found',
    });
  });
});

// ── the wiring: one library, one backfill, End service resumes it ─────────────────────────────────────────────────

async function goLiveWith(op: Client): Promise<void> {
  const p = await op.json<Presentation>('/presentations', { method: 'POST', json: song() });
  const pl = await op.json<Playlist>('/playlists', {
    method: 'POST',
    json: { name: 'Sunday', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
  });
  await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
}
const endServiceWith = (op: Client) =>
  op.json('/live/events', { method: 'POST', json: { k: 'endService', at: Date.now() } });

describe('the backfill follows the service', () => {
  let two: TwoProcesses | undefined;
  afterEach(async () => {
    await two?.close();
    two = undefined;
  });

  it('one-process hub: it reads nothing while a service is live and carries on at End service', async () => {
    hub = await startHub();
    seedRows(hub.lib, 5, 2);
    const op = await login(hub.url, OPERATE_PIN);
    await goLiveWith(op);
    await hub.revisionTitles.run();
    expect(hub.lib.summaries.count()).toBe(10);
    await endServiceWith(op);
    await expect.poll(() => hub!.lib.summaries.count(), { timeout: budgetMs(10_000) }).toBe(0);
  });

  it('library process: the live process relays the mode, and the same holds', async () => {
    two = await twoProcesses();
    seedRows(two.lib.lib, 5, 2);
    const op = await login(two.base, OPERATE_PIN);
    await goLiveWith(op);
    await expect.poll(() => two!.live.live.state.mode).toBe('live');
    await two.lib.revisionTitles.run();
    expect(two.lib.lib.summaries.count()).toBe(10);
    await endServiceWith(op);
    await expect.poll(() => two!.lib.lib.summaries.count(), { timeout: budgetMs(10_000) }).toBe(0);
  });
});

// ── the scanner ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A small deterministic generator (mulberry32): the same cases on every run, with the seed in the failure message. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const STRINGS = [
  'plain',
  '',
  'a"b',
  'back\\slash',
  '{"title":"evil"}',
  '}]',
  '[{',
  'é 日本語 😀',
  'line\nbreak\ttab',
  '  ',
  '\ud83d lone',
  'nul \u0000 inside',
  '\\"',
  '"',
  'title',
  'x'.repeat(300),
];
const KEYS = ['id', 'rev', 'kind', 'meta', 'sections', 'arrangements', 'x', 'archived', 'source'];
function value(r: () => number, depth: number): unknown {
  const k = Math.floor(r() * (depth > 3 ? 4 : 7));
  switch (k) {
    case 0:
      return STRINGS[Math.floor(r() * STRINGS.length)];
    case 1:
      return Math.floor(r() * 1e6) / (r() < 0.5 ? 1 : 100);
    case 2:
      return r() < 0.5;
    case 3:
      return null;
    case 4:
      return Array.from({ length: Math.floor(r() * 4) }, () => value(r, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = 0, n = Math.floor(r() * 5); i < n; i++)
        o[r() < 0.2 ? 'title' : KEYS[Math.floor(r() * KEYS.length)]!] = value(r, depth + 1);
      return o;
    }
  }
}
function presentationLike(r: () => number): { obj: Record<string, unknown>; title: string } {
  const title = STRINGS[Math.floor(r() * STRINGS.length)]!;
  const keys = [
    ...new Set(Array.from({ length: 1 + Math.floor(r() * 6) }, () => KEYS[Math.floor(r() * KEYS.length)]!)),
  ];
  const at = Math.floor(r() * (keys.length + 1));
  const obj: Record<string, unknown> = {};
  keys.forEach((k, i) => {
    if (i === at) obj.title = title;
    obj[k] = value(r, 0);
  });
  if (!('title' in obj)) obj.title = title;
  return { obj, title };
}

describe('titleTokenIn', () => {
  it('finds the top-level title and nothing else, in compact and indented JSON', () => {
    expect(titleTokenIn('{"id":"a","rev":1,"title":"Hello","kind":"song"}')).toBe('"Hello"');
    expect(titleTokenIn('{\n  "id": "a",\n  "title" : "Hello",\n  "kind": "song"\n}')).toBe('"Hello"');
    expect(titleTokenIn(' \n{"title":"Hello"}')).toBe('"Hello"');
    expect(titleTokenIn('{"a":{"title":"nested"},"b":["title","x"],"title":"Real"}')).toBe('"Real"');
    expect(titleTokenIn('{"a":"{\\"title\\":\\"inside a string\\"}","title":"Real"}')).toBe('"Real"');
    expect(titleTokenIn('{"a":"back\\\\","title":"Real"}')).toBe('"Real"');
    expect(titleTokenIn('{"t\\u0069tle":"escaped key","title":"Real"}')).toBe('"Real"');
    expect(titleTokenIn('{"title":"q \\" é \\u00e9 \\ud83d\\ude00"}')).toBe(
      '"q \\" é \\u00e9 \\ud83d\\ude00"',
    );
  });

  it('says nothing when the title is not in the text it is given, or is not a string, or the text is not an object', () => {
    expect(titleTokenIn('')).toBeUndefined();
    expect(titleTokenIn('[1,2]')).toBeUndefined();
    expect(titleTokenIn('"title"')).toBeUndefined();
    expect(titleTokenIn('{"id":"a","rev":1}')).toBeUndefined();
    expect(titleTokenIn('{"title":5}')).toBeUndefined();
    expect(titleTokenIn('{"title":null}')).toBeUndefined();
    expect(titleTokenIn('{"title":{"x":1}}')).toBeUndefined();
    expect(titleTokenIn('{"id":"a","sections":[{"id":"s"')).toBeUndefined();
    expect(titleTokenIn('{"title":"cut')).toBeUndefined();
    expect(titleTokenIn('{"title":"cut\\')).toBeUndefined();
    expect(titleTokenIn('{ title: "no quotes" }')).toBeUndefined();
    expect(titleTokenIn('{"a":1 "title":"missing comma"}')).toBeUndefined();
  });

  it('agrees with JSON.parse on 3,000 generated bodies and on every cut of each of 40 of them (seed in the message)', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const { obj, title } = presentationLike(r);
      const text = JSON.stringify(obj, null, r() < 0.3 ? 2 : undefined);
      const got = titleTokenIn(text);
      // the generator puts a top-level title in every object, so it is found, and it is exactly what the serializer wrote
      expect(got, `seed ${seed}`).toBe(JSON.stringify(obj.title));
      expect(JSON.parse(got!), `seed ${seed}`).toBe(obj.title);
      expect(obj.title, `seed ${seed}`).toBe(title);
      if (seed <= 40) {
        // every prefix: the answer is the exact token or nothing, never another string
        for (let k = 0; k <= text.length; k++) {
          const cut = titleTokenIn(text.slice(0, k));
          if (cut !== undefined) expect(cut, `seed ${seed} cut ${k}`).toBe(got);
        }
      }
    }
  });

  it('is linear in the text: a megabyte of nested values with no title is read in well under a second', () => {
    const deep = `{"a":${'['.repeat(20_000)}${']'.repeat(20_000)},"b":"${'x\\"'.repeat(300_000)}","c":[${'{"title":1},'.repeat(50_000)}0]}`;
    const t0 = cpuMs();
    expect(titleTokenIn(deep)).toBeUndefined();
    expect(cpuMs() - t0).toBeLessThan(budgetMs(1000));
  });

  it('has prefixes of 16 KiB, then 1 MiB, in front of the whole-body read', () => {
    expect(TITLE_PREFIX_CHARS).toBe(16 * 1024);
    expect(TITLE_WIDE_PREFIX_CHARS).toBe(1024 * 1024);
  });
});
