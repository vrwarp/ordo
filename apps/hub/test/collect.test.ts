/**
 * What stored presentations and their saved versions name, and when the hub may let a file go (design/29 §1.3
 * "Collection with revisions", A37, M7): RC1-RC5 here (the references index and its backfill), CO1-CO12 and BU in
 * the steps that follow. Time is injected, nothing waits.
 */
import type { Presentation } from '@ordo/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RefBackfill, refsIn } from '../src/collect.ts';
import { EDIT_PIN, login, startHub, type TestHub } from './helpers.ts';
import { bigSlide, rect } from './prerender-helpers.ts';
import { song } from './helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await hub?.cleanup();
  hub = undefined;
});

const hash = (n: number) => n.toString(16).padStart(64, '0');

/** A presentation whose slides (900 shapes at most each) have a shape for each geometry file named. */
function naming(id: string, refs: readonly string[], title = 'T'): Presentation {
  const slides = [];
  for (let at = 0; at === 0 || at < refs.length; at += 900) {
    const slide = bigSlide(`s${at}`, 0, '');
    slide.objects = [
      rect('bg'),
      ...refs
        .slice(at, at + 900)
        .map((r, i) => rect(`o${i}`, { x: i, y: 0, w: 5, h: 5, rotation: 0 }, { geom: { ref: r } } as never)),
    ];
    slides.push(slide);
  }
  const base = song(title);
  return { ...base, id, sections: [{ ...base.sections[0]!, slides }] };
}

type Interval = { hash: string; first_rev: number; last_rev: number };
const intervals = (pid: string): Interval[] =>
  hub!.db
    .prepare(
      `SELECT hash, first_rev, last_rev FROM file_refs WHERE presentation_id = ? ORDER BY hash, first_rev`,
    )
    .all(pid) as Interval[];

describe('the references index (RC1)', () => {
  it('records an interval for every content file a save names, and extends, stops and reopens it (RC1)', async () => {
    hub = await startHub();
    const lib = hub.lib;
    const [a, b, c] = [hash(1), hash(2), hash(3)];
    const p = lib.savePresentation({ ...naming('p1', [a, b]), rev: 1 }, { create: true });
    expect(intervals('p1')).toEqual([
      { hash: a, first_rev: 1, last_rev: 1 },
      { hash: b, first_rev: 1, last_rev: 1 },
    ]);
    // the same refs again extend the intervals: the row count is unchanged
    const p2 = lib.savePresentation({ ...naming('p1', [a, b]), rev: p.rev }, { expectedRev: p.rev });
    expect(intervals('p1')).toEqual([
      { hash: a, first_rev: 1, last_rev: 2 },
      { hash: b, first_rev: 1, last_rev: 2 },
    ]);
    // a ref the new body no longer names stops extending; a new one opens its own
    const p3 = lib.savePresentation({ ...naming('p1', [b, c]), rev: p2.rev }, { expectedRev: p2.rev });
    expect(intervals('p1')).toEqual([
      { hash: a, first_rev: 1, last_rev: 2 },
      { hash: b, first_rev: 1, last_rev: 3 },
      { hash: c, first_rev: 3, last_rev: 3 },
    ]);
    // a ref that returns after a gap opens a new interval
    const p4 = lib.savePresentation({ ...naming('p1', [c]), rev: p3.rev }, { expectedRev: p3.rev });
    lib.savePresentation({ ...naming('p1', [a, c]), rev: p4.rev }, { expectedRev: p4.rev });
    expect(intervals('p1').filter((i) => i.hash === a)).toEqual([
      { hash: a, first_rev: 1, last_rev: 2 },
      { hash: a, first_rev: 5, last_rev: 5 },
    ]);
    // every revision the hub saved is marked scanned: the backfill never reads them
    const scanned = hub.db
      .prepare(`SELECT COUNT(*) AS n FROM refs_scanned WHERE presentation_id = 'p1'`)
      .get() as {
      n: number;
    };
    expect(scanned.n).toBe(5);
  });

  it('keeps one row per file for a presentation of 2,000 refs saved 50 times, and clears the marks of what it names', async () => {
    hub = await startHub();
    const lib = hub.lib;
    const refs = Array.from({ length: 2000 }, (_, i) => hash(i + 100));
    hub.db.prepare(`INSERT INTO collect_marks (hash, since) VALUES (?, 1)`).run(refs[7]!);
    let p = lib.savePresentation({ ...naming('big', refs), rev: 1 }, { create: true });
    for (let i = 0; i < 49; i++)
      p = lib.savePresentation({ ...naming('big', refs, `T${i}`), rev: p.rev }, { expectedRev: p.rev });
    expect(p.rev).toBe(50);
    expect(intervals('big')).toHaveLength(2000);
    expect(intervals('big').every((r) => r.first_rev === 1 && r.last_rev === 50)).toBe(true);
    expect((hub.db.prepare(`SELECT COUNT(*) AS n FROM collect_marks`).get() as { n: number }).n).toBe(0);
  });

  it("records a prerender record's file, its uses.files and a mask and a decoration (RC1)", async () => {
    hub = await startHub();
    const head = hash(900);
    const slide = bigSlide('s', 0, '');
    slide.prerender = {
      why: ['count'],
      file: { ref: head, bytes: 1 },
      live: [],
      uses: { media: [], files: [hash(901), hash(902)], fonts: [] },
    };
    hub.lib.slideFiles.record({
      hash: head,
      bytes: 1,
      objects: 0,
      uses: { media: [], files: [hash(901), hash(902)], fonts: [] },
      pages: [],
    });
    hub.lib.addFile({ hash: head, bytes: 1, mime: 'application/json', path: 'media/x.json' });
    const base = song('P');
    const p = { ...base, id: 'pp', sections: [{ ...base.sections[0]!, slides: [slide] }] };
    hub.lib.savePresentation({ ...p, rev: 1 }, { create: true });
    expect(intervals('pp').map((i) => i.hash)).toEqual([head, hash(901), hash(902)].sort());
  });
});

describe('the extractor (RC2)', () => {
  /** A seeded generator: the same 300 bodies every run. */
  const rng = (seed: number) => () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  /** Every string under a key `ref` and every string of an array under `files`, found by walking a parsed value. */
  function walk(v: unknown, out = new Set<string>()): Set<string> {
    const hex = /^[0-9a-f]{64}$/;
    if (Array.isArray(v)) for (const x of v) walk(x, out);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (k === 'ref' && typeof x === 'string' && hex.test(x)) out.add(x);
        if (k === 'files' && Array.isArray(x))
          for (const y of x) if (typeof y === 'string' && hex.test(y)) out.add(y);
        walk(x, out);
      }
    return out;
  }

  it('finds exactly the refs a full parse and walk finds, over 300 random bodies (RC2)', () => {
    const r = rng(7);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const hex = () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
    const tricky = () =>
      pick([
        'ref',
        `"ref":"${hex()}"`,
        `\\"ref\\":\\"${hex()}\\"`,
        `a "files":["${hex()}"] b`,
        `quote " and \\ backslash ${hex()}`,
        'ref ref ref',
        hex(),
        '{"ref":"' + hex() + '"}',
      ]);
    const node = (depth: number): unknown => {
      const n = r();
      if (depth > 4 || n < 0.25) return pick([tricky(), 1, true, null, 'plain']);
      if (n < 0.5) return Array.from({ length: Math.floor(r() * 4) }, () => node(depth + 1));
      const o: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(r() * 5); i++) {
        const k = pick(['ref', 'files', 'text', 'geom', 'mask', 'uses', 'objects', 'ref ', ' ref']);
        o[k] =
          k === 'ref' && r() < 0.6
            ? hex()
            : k === 'files' && r() < 0.6
              ? Array.from({ length: 1 + Math.floor(r() * 3) }, hex)
              : node(depth + 1);
      }
      return o;
    };
    let named = 0;
    for (let i = 0; i < 300; i++) {
      const body = node(0);
      const json = JSON.stringify(body);
      const want = walk(JSON.parse(json));
      named += want.size;
      expect([...refsIn(json)].sort(), json.slice(0, 200)).toEqual([...want].sort());
    }
    expect(named).toBeGreaterThan(200);
  });
});

describe('pruning and deleting (RC3, RC5)', () => {
  async function many(pid: string, revs: number, refsOf: (rev: number) => string[]) {
    let p = hub!.lib.savePresentation({ ...naming(pid, refsOf(1)), rev: 1 }, { create: true });
    for (let r = 2; r <= revs; r++)
      p = hub!.lib.savePresentation(
        { ...naming(pid, refsOf(r), `T${r}`), rev: p.rev },
        { expectedRev: p.rev },
      );
    return p;
  }

  it('deletes the intervals and key rows of pruned revisions, and all of them with the presentation (RC3)', async () => {
    hub = await startHub();
    const [old, kept] = [hash(10), hash(11)];
    await many('pr', 60, (rev) => (rev <= 5 ? [old, kept] : [kept]));
    const ins = hub.db.prepare(
      `INSERT INTO prerender_keys (presentation_id, rev, slide_id, key, standby_id, sig, created_at) VALUES ('pr', ?, 's', ?, 's', 'x', 0)`,
    );
    for (let rev = 1; rev <= 60; rev++) ins.run(rev, hash(5000 + rev));
    expect(intervals('pr')).toEqual([
      { hash: old, first_rev: 1, last_rev: 5 },
      { hash: kept, first_rev: 1, last_rev: 60 },
    ]);
    // 31 days on: the newest 50 are kept, revisions 1-10 are pruned
    hub.lib.pruneRevisions('pr', Date.now() + 31 * 86_400_000);
    expect(intervals('pr')).toEqual([{ hash: kept, first_rev: 1, last_rev: 60 }]);
    const keys = hub.db
      .prepare(`SELECT MIN(rev) AS lo, COUNT(*) AS n FROM prerender_keys WHERE presentation_id = 'pr'`)
      .get() as {
      lo: number;
      n: number;
    };
    expect(keys).toEqual({ lo: 11, n: 50 });
    expect(
      (
        hub.db.prepare(`SELECT MIN(rev) AS lo FROM refs_scanned WHERE presentation_id = 'pr'`).get() as {
          lo: number;
        }
      ).lo,
    ).toBe(11);
    // the DELETE route removes them all
    const ed = await login(hub.url, EDIT_PIN);
    expect((await ed.fetch('/presentations/pr', { method: 'DELETE' })).status).toBe(204);
    expect(intervals('pr')).toEqual([]);
    expect(
      (
        hub.db.prepare(`SELECT COUNT(*) AS n FROM prerender_keys WHERE presentation_id = 'pr'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(
      (
        hub.db.prepare(`SELECT COUNT(*) AS n FROM refs_scanned WHERE presentation_id = 'pr'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it('answers fileReferenced for a hash a kept revision or a head names, and Store.release keeps such a file (RC5)', async () => {
    hub = await startHub();
    const [old, page, shape] = [hash(20), hash(21), hash(22)];
    for (const h of [old, page, shape])
      hub.lib.addFile({ hash: h, bytes: 1, mime: 'application/json', path: `media/${h}.json` });
    expect(hub.lib.fileReferenced(old)).toBe(false);
    // an old version draws `old`; the current one no longer does
    const p1 = hub.lib.savePresentation({ ...naming('rc5', [old]), rev: 1 }, { create: true });
    hub.lib.savePresentation({ ...naming('rc5', []), rev: p1.rev }, { expectedRev: p1.rev });
    expect(hub.lib.fileReferenced(old)).toBe(true);
    await hub.store.release(old);
    expect(hub.lib.getFile(old)).toBeDefined();
    hub.lib.pruneRevisions('rc5', Date.now() + 31 * 86_400_000);
    expect(hub.lib.fileReferenced(old)).toBe(true); // both revisions are still the newest 50
    // a head named by the current presentation names its pages and its shape files
    const head = hash(30);
    hub.lib.addFile({ hash: head, bytes: 1, mime: 'application/json', path: `media/${head}.json` });
    hub.lib.slideFiles.record({
      hash: head,
      bytes: 2,
      objects: 1,
      uses: { media: [], files: [shape], fonts: [] },
      pages: [page],
    });
    const slide = bigSlide('s', 0, '');
    slide.prerender = { why: ['count'], file: { ref: head, bytes: 2 }, live: [] };
    const base = song('H');
    hub.lib.savePresentation(
      { ...base, id: 'withhead', sections: [{ ...base.sections[0]!, slides: [slide] }], rev: 1 },
      { create: true },
    );
    expect(hub.lib.fileReferenced(page)).toBe(true);
    expect(hub.lib.fileReferenced(shape)).toBe(true);
    expect(hub.lib.fileReferenced(hash(23))).toBe(false);
    // media and fonts answer as before
    expect(hub.lib.fileReferenced(hash(24))).toBe(false);
  });
});

describe('the backfill (RC4)', () => {
  /** A database as PR #29's hub left it: presentations with revisions and no reference rows, no marker. */
  function legacy(presentations: number, revs: number) {
    const insP = hub!.db.prepare(
      `INSERT INTO presentations (id, rev, title, kind, json, created_at, updated_at) VALUES (?, ?, 't', 'song', '{}', 'a', 'a')`,
    );
    const insR = hub!.db.prepare(
      `INSERT INTO presentation_revisions (presentation_id, rev, json, saved_by, saved_at) VALUES (?, ?, ?, NULL, 'a')`,
    );
    hub!.db.transaction(() => {
      for (let p = 0; p < presentations; p++) {
        insP.run(`old${p}`, revs);
        for (let r = 1; r <= revs; r++)
          insR.run(
            `old${p}`,
            r,
            // refs 0..9 are named by revision windows of their own, plus one that is always named
            JSON.stringify({
              sections: [
                {
                  slides: [
                    {
                      objects: [hash(p * 100 + Math.floor((r - 1) / 7)), hash(p * 100 + 90)].map((h) => ({
                        geom: { ref: h },
                      })),
                    },
                  ],
                },
              ],
              text: `revision ${r}`,
            }),
          );
      }
    })();
  }
  const fullScan = (): Interval[] => {
    const out: Interval[] = [];
    const rows = hub!.db
      .prepare(
        `SELECT presentation_id AS pid, rev, json FROM presentation_revisions ORDER BY presentation_id, rev`,
      )
      .all() as { pid: string; rev: number; json: string }[];
    const open = new Map<string, Interval>();
    for (const r of rows) {
      const names = [
        ...new Set(
          (JSON.stringify(JSON.parse(r.json)).match(/"ref":"[0-9a-f]{64}"/g) ?? []).map((m) =>
            m.slice(7, 71),
          ),
        ),
      ];
      for (const h of names) {
        const key = `${r.pid}\0${h}`;
        const cur = open.get(key);
        if (cur && cur.last_rev === r.rev - 1) cur.last_rev = r.rev;
        else {
          const i = { hash: `${r.pid}\0${h}`, first_rev: r.rev, last_rev: r.rev };
          open.set(key, i);
          out.push(i);
        }
      }
    }
    return out.sort((a, b) => (a.hash + String(a.first_rev)).localeCompare(b.hash + String(b.first_rev)));
  };
  const stored = () =>
    (
      hub!.db
        .prepare(
          `SELECT presentation_id AS pid, hash, first_rev, last_rev FROM file_refs ORDER BY presentation_id, hash, first_rev`,
        )
        .all() as { pid: string; hash: string; first_rev: number; last_rev: number }[]
    )
      .map((r) => ({ hash: `${r.pid}\0${r.hash}`, first_rev: r.first_rev, last_rev: r.last_rev }))
      .sort((a, b) => (a.hash + String(a.first_rev)).localeCompare(b.hash + String(b.first_rev)));

  function job(over: Partial<ConstructorParameters<typeof RefBackfill>[1]> = {}) {
    const t = {
      now: 0,
      slices: [] as number[],
      sleeps: [] as number[],
      reads: 0,
      hook: undefined as undefined | (() => void),
    };
    let mode: 'idle' | 'live' = 'idle';
    const j = new RefBackfill(hub!.lib, {
      live: () => mode,
      log: hub!.log,
      now: () => t.now,
      yield: async () => {
        t.slices.push(t.reads);
        t.now += 1;
      },
      sleep: async (ms) => {
        t.sleeps.push(ms);
      },
      onRead: () => {
        t.reads++;
        t.now += 1; // a revision costs 1 ms on the fake clock
        t.hook?.();
      },
      ...over,
    });
    return { j, t, setMode: (m: 'idle' | 'live') => (mode = m) };
  }

  it('scans every revision as raw text in slices of at most 20 ms and records what a full scan finds (RC4)', async () => {
    hub = await startHub();
    legacy(3, 60);
    const parse = vi.spyOn(JSON, 'parse');
    const { j, t } = job();
    await j.run();
    expect(parse.mock.calls.filter((c) => String(c[0]).length > 300)).toEqual([]);
    expect(t.reads).toBe(180);
    expect((hub.db.prepare(`SELECT COUNT(*) AS n FROM refs_scanned`).get() as { n: number }).n).toBe(180);
    expect(
      (hub.db.prepare(`SELECT value FROM meta WHERE key = 'refs_backfill_done'`).get() as { value: string })
        .value,
    ).toBe('1');
    expect(stored()).toEqual(fullScan());
    // slices of at most 20 revisions (20 ms on the fake clock), and 100 ms of sleep per 10 revisions
    const sizes = t.slices.map((s, i) => s - (t.slices[i - 1] ?? 0));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
    expect(t.sleeps.every((s) => s === 100)).toBe(true);
    expect(t.sleeps.length).toBeGreaterThanOrEqual(17);
  });

  it('resumes after k revisions when stopped, never runs while live, and leaves a revision saved meanwhile to its save (RC4)', async () => {
    hub = await startHub();
    legacy(2, 60);
    // stopped after 50 revisions
    const stopper = job();
    stopper.t.hook = () => {
      if (stopper.t.reads === 50) stopper.j.stop();
    };
    await stopper.j.run();
    expect(stopper.t.reads).toBe(50);
    expect((hub.db.prepare(`SELECT COUNT(*) AS n FROM refs_scanned`).get() as { n: number }).n).toBe(50);
    expect(
      (
        hub.db
          .prepare(`SELECT COUNT(*) AS n FROM meta WHERE key = 'refs_backfill_done' AND value = '1'`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
    // while a service is live nothing is read
    const live = job();
    live.setMode('live');
    await live.j.run();
    expect(live.t.reads).toBe(0);
    // started again it resumes after the 50 it did, and finishes
    const rest = job();
    await rest.j.run();
    expect(rest.t.reads).toBe(70);
    expect(stored()).toEqual(fullScan());
    // a finished backfill reads nothing more
    const again = job();
    await again.j.run();
    expect(again.t.reads).toBe(0);
  });

  it('does not read a revision whose save recorded it', async () => {
    hub = await startHub();
    legacy(1, 10);
    hub.lib.savePresentation({ ...naming('old0', [hash(99)]), rev: 10 }, {});
    const { j, t } = job();
    await j.run();
    // 10 old revisions plus the one the save made: only the 10 were read
    expect(t.reads).toBe(10);
    expect(
      (
        hub.db.prepare(`SELECT COUNT(*) AS n FROM refs_scanned WHERE presentation_id = 'old0'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(11);
  });
});
