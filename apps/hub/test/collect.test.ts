/**
 * What stored presentations and their saved versions name, and when the hub may let a file go (design/29 §1.3
 * "Collection with revisions", A37, M7): RC1-RC5 (the references index and its backfill), CO1-CO12 (collection:
 * mark and sweep, the 30-day rule, report mode) and BU (the picture budget) in the steps that follow. Time is
 * injected, nothing waits.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Presentation } from '@ordo/domain';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RETENTION_DAYS } from '../src/backup.ts';
import { COLLECT_DELAY_DAYS, Collector, type CollectorOptions, RefBackfill, refsIn } from '../src/collect.ts';
import { collectMode, loadConfig } from '../src/config.ts';
import { createLibraryProcess } from '../src/libproc.ts';
import { noSystemFaces } from '../src/pptx/systemFaces.ts';
import { EDIT_PIN, login, song, startHub, TEST_TOOLS, tempDir, type TestHub } from './helpers.ts';
import { bigSlide, fullOf, makePng, presentationOf, rect, uploadSlideFile } from './prerender-helpers.ts';

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

  it('starts two minutes after its start whatever the service reports meanwhile, and resumes when a service that held it ends (RC4)', async () => {
    hub = await startHub();
    legacy(1, 10);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const early = job();
      early.j.start();
      early.j.onLiveMode('idle'); // a state change before the delay is no start
      await vi.advanceTimersByTimeAsync(119_999);
      expect(early.t.reads).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(early.t.reads).toBe(10);

      hub.db.prepare(`DELETE FROM refs_scanned`).run();
      const held = job();
      held.setMode('live');
      held.j.start();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(held.t.reads).toBe(0); // live: nothing read, and it waits for the end of the service
      held.setMode('idle');
      held.j.onLiveMode('idle');
      await vi.advanceTimersByTimeAsync(10);
      expect(held.t.reads).toBe(10);
    } finally {
      vi.useRealTimers();
    }
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

// ── collection (CO1-CO12) ────────────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const T0 = Date.UTC(2031, 0, 1);
const enc = new TextEncoder();
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

type Line = { level: string; obj: Record<string, unknown>; msg: string };
function recorder() {
  const lines: Line[] = [];
  const at = (level: string) => (obj: unknown, msg?: string) => {
    lines.push({
      level,
      obj: typeof obj === 'object' && obj ? (obj as Record<string, unknown>) : {},
      msg: msg ?? (typeof obj === 'string' ? obj : ''),
    });
  };
  const log = {
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    debug: at('debug'),
    trace: at('trace'),
    fatal: at('fatal'),
  } as unknown as Logger;
  Object.assign(log, { child: () => log });
  return { log, lines };
}

/** The paths of the files this test stored, so a blob can be checked after its row is gone. */
const paths = new Map<string, string>();
const onDisk = (h: string) => existsSync(join(hub!.dir, paths.get(h) ?? 'missing'));
const has = (h: string) => !!hub!.lib.getFile(h);
const marks = () =>
  (hub!.db.prepare(`SELECT hash FROM collect_marks ORDER BY hash`).all() as { hash: string }[]).map(
    (r) => r.hash,
  );
const sizeOf = (h: string) => hub!.lib.getFile(h)!.bytes;

async function store(name: string, mime: string, ext: string, dir?: 'media' | 'fonts'): Promise<string> {
  const f = await hub!.store.putBytes(enc.encode(`collect ${name}`), { ext, mime, dir });
  paths.set(f.hash, f.path);
  return f.hash;
}
/** A content file (a shape, a mask, a decoration, a scene, a page, a head: application/json). */
const json = (name: string | number) => store(`json ${name}`, 'application/json', 'json');

/** The collection tests need a database whose references are complete. */
const ready = () => hub!.lib.refs.setBackfillDone(true);

function rig(over: Partial<CollectorOptions> = {}) {
  const t = {
    now: T0,
    steps: 0,
    stepMs: 0,
    slices: [] as number[],
    mode: 'idle' as 'idle' | 'live',
    known: true,
  };
  const rec = recorder();
  const c = new Collector(hub!.lib, hub!.store, {
    mode: 'on',
    live: () => t.mode,
    known: () => t.known,
    timeZone: () => 'UTC',
    log: rec.log,
    now: () => t.now,
    yield: async () => {
      t.slices.push(t.steps);
      t.now += t.stepMs;
    },
    onStep: () => {
      t.steps++;
      t.now += t.stepMs;
    },
    ...over,
  });
  return { c, t, ...rec };
}

const save = (id: string, refs: readonly string[], rev?: number) =>
  rev === undefined
    ? hub!.lib.savePresentation({ ...naming(id, refs), rev: 1 }, { create: true })
    : hub!.lib.savePresentation({ ...naming(id, refs), rev }, { expectedRev: rev });

/** A synthetic head naming `pages` and `shapes`, recorded as an upload would, and a presentation that names it. */
function headRow(head: string, pages: string[], shapes: string[] = []) {
  hub!.lib.slideFiles.record({
    hash: head,
    bytes: 1,
    objects: 0,
    uses: { media: [], files: shapes, fonts: [] },
    pages,
  });
}
function namingHead(id: string, head: string): Presentation {
  const slide = bigSlide('s', 0, '');
  slide.prerender = { why: ['count'], file: { ref: head, bytes: 1 }, live: [] };
  const base = song('H');
  return { ...base, id, sections: [{ ...base.sections[0]!, slides: [slide] }] };
}

describe('collection: candidates and what names a file (CO1, CO2)', () => {
  it('only ever touches application/json files: originals, deliveries, posters, fonts, decks and pdfs stay (CO1)', async () => {
    hub = await startHub();
    ready();
    const others = [
      await store('original', 'video/mp4', 'mp4'),
      await store('delivery', 'video/mp4', 'mp4'),
      await store('poster', 'image/jpeg', 'jpg'),
      await store('font', 'font/woff2', 'woff2', 'fonts'),
      await store('deck', PPTX_MIME, 'pptx'),
      await store('pdf', 'application/pdf', 'pdf'),
    ];
    const unnamed = await json('unnamed');
    const { c, t } = rig();
    expect(await c.run()).toMatchObject({ ran: true, marked: 1, files: 0 });
    expect(marks()).toEqual([unnamed]);
    t.now = T0 + 31 * DAY;
    const size = sizeOf(unnamed);
    expect(await c.run()).toMatchObject({ ran: true, files: 1, bytes: size });
    expect(has(unnamed)).toBe(false);
    expect(onDisk(unnamed)).toBe(false);
    for (const h of others) {
      expect(has(h), h).toBe(true);
      expect(onDisk(h), h).toBe(true);
    }
    expect(marks()).toEqual([]);
  });

  it('keeps a file every way of being named: the current version, a kept version, a head page, a head use, a picture row, an unfinished job (CO2)', async () => {
    hub = await startHub();
    ready();
    const lib = hub.lib;
    const [current, kept, dropped] = [await json('current'), await json('kept'), await json('dropped')];
    const [head, page, shape] = [await json('head'), await json('page'), await json('shape')];
    const [pictureOwner, queued, running, finished, unnamed] = [
      await json('picture'),
      await json('queued job'),
      await json('running job'),
      await json('finished job'),
      await json('unnamed'),
    ];
    save('cur', [current]);
    // a kept version: the second save no longer names it, the first is still kept
    const k1 = save('kept', [kept, dropped]);
    save('kept', [dropped], k1.rev);
    headRow(head, [page], [shape]);
    lib.savePresentation({ ...namingHead('hp', head), rev: 1 }, { create: true });
    hub.db
      .prepare(
        `INSERT INTO prerender_keys (presentation_id, rev, slide_id, key, standby_id, sig, created_at) VALUES ('gone', 1, 's', ?, 'sb', 'x', 1)`,
      )
      .run('9'.repeat(64));
    hub.db
      .prepare(
        `INSERT INTO prerenders (presentation_id, key, size, slide_id, standby_id, version, kind, hash, mime, bytes, w, h, opaque, made_by, made_role, last_rev, created_at)
         VALUES ('gone', ?, 3840, 's', 'sb', 1, 'slide', ?, 'image/png', 9, 3840, 2160, 1, NULL, 'edit', 1, 1)`,
      )
      .run('9'.repeat(64), pictureOwner);
    const job = (id: string, state: string, h: string) =>
      hub!.db
        .prepare(
          `INSERT INTO jobs (id, kind, class, state, progress, payload, log, created_at, updated_at) VALUES (?, 'pptx.client', 'light', ?, 0, ?, '[]', 'a', 'a')`,
        )
        .run(id, state, JSON.stringify({ scene: h }));
    job('j1', 'queued', queued);
    job('j2', 'running', running);
    job('j3', 'done', finished);

    const { c, t } = rig();
    expect(await c.run()).toMatchObject({ ran: true, marked: 2 });
    expect(marks().sort()).toEqual([finished, unnamed].sort());
    t.now = T0 + 31 * DAY;
    expect(await c.run()).toMatchObject({ ran: true, files: 2 });
    for (const h of [current, kept, dropped, head, page, shape, pictureOwner, queued, running]) {
      expect(has(h), h).toBe(true);
      expect(onDisk(h), h).toBe(true);
    }
    for (const h of [finished, unnamed]) {
      expect(has(h), h).toBe(false);
      expect(onDisk(h), h).toBe(false);
    }
  });
});

describe('collection: the 30 days (CO3, CO4)', () => {
  it('is never shorter than the backups are kept, and deletes at 30 days after the mark, not at 29 (CO3)', async () => {
    expect(COLLECT_DELAY_DAYS).toBeGreaterThanOrEqual(RETENTION_DAYS);
    hub = await startHub();
    ready();
    const u = await json('u');
    const { c, t } = rig();
    await c.run();
    expect(marks()).toEqual([u]);
    t.now = T0 + (COLLECT_DELAY_DAYS - 1) * DAY;
    expect(await c.run()).toMatchObject({ ran: true, files: 0 });
    expect(has(u)).toBe(true);
    expect(marks()).toEqual([u]);
    t.now = T0 + COLLECT_DELAY_DAYS * DAY;
    expect(await c.run()).toMatchObject({ ran: true, files: 1 });
    expect(has(u)).toBe(false);
  });

  it('a save, a head upload or a run that finds the file named clears the mark and the 30 days start again (CO3)', async () => {
    hub = await startHub();
    ready();
    const ed = await login(hub.url, EDIT_PIN);
    const { c, t } = rig();
    // a save that names it
    const u = await json('saved');
    await c.run();
    expect(marks()).toEqual([u]);
    const p = save('p1', [u]);
    expect(marks()).toEqual([]);
    // gone again (the presentation is deleted through the route); the clock restarts at the next run
    t.now = T0 + 12 * DAY;
    expect((await ed.fetch(`/presentations/${p.id}`, { method: 'DELETE' })).status).toBe(204);
    await c.run();
    expect(marks()).toEqual([u]);
    t.now = T0 + (12 + COLLECT_DELAY_DAYS - 1) * DAY;
    await c.run();
    expect(has(u)).toBe(true);
    t.now = T0 + (12 + COLLECT_DELAY_DAYS) * DAY;
    await c.run();
    expect(has(u)).toBe(false);

    // a head upload (record) clears the marks of the head and its pages
    t.now = T0;
    const [h, pg] = [await json('head'), await json('page')];
    await c.run();
    expect(marks().sort()).toEqual([h, pg].sort());
    headRow(h, [pg]);
    expect(marks()).toEqual([]);

    // a run that finds it named clears a mark that was left (written directly)
    const n = await json('named');
    save('p2', [n]);
    hub.db.prepare(`INSERT INTO collect_marks (hash, since) VALUES (?, ?)`).run(n, T0 - 90 * DAY);
    t.now = T0 + 5 * DAY;
    await c.run();
    expect(marks().includes(n)).toBe(false);
    expect(has(n)).toBe(true);
  });

  it('keeps a file a save names between the scan and the delete, and does not mind a missing blob (CO4)', async () => {
    hub = await startHub();
    ready();
    const [raced, plain, noBlob] = [await json('raced'), await json('plain'), await json('noblob')];
    let race = false;
    const { c, t } = rig({
      afterScan: () => {
        if (race) save('late', [raced]);
      },
    });
    await c.run();
    expect(marks().sort()).toEqual([noBlob, plain, raced].sort());
    race = true;
    rmSync(join(hub.dir, paths.get(noBlob)!));
    t.now = T0 + COLLECT_DELAY_DAYS * DAY;
    const r = await c.run();
    expect(r).toMatchObject({ ran: true, files: 2 });
    expect(has(raced)).toBe(true);
    expect(onDisk(raced)).toBe(true);
    expect(marks().includes(raced)).toBe(false);
    expect(has(plain)).toBe(false);
    expect(onDisk(plain)).toBe(false);
    expect(has(noBlob)).toBe(false);
  });
});

describe('collection: gates, modes and the report (CO5, CO12)', () => {
  it('runs nothing while a service is live, before the backfill is done, with the variable off, or before the state is known (CO5)', async () => {
    hub = await startHub();
    const u = await json('u');
    const { c, t } = rig();
    // the backfill has not finished
    expect(await c.run()).toEqual({ ran: false, reason: 'backfill' });
    expect(marks()).toEqual([]);
    ready();
    t.mode = 'live';
    expect(await c.run()).toEqual({ ran: false, reason: 'live' });
    t.mode = 'idle';
    t.known = false;
    expect(await c.run()).toEqual({ ran: false, reason: 'unknown' });
    t.known = true;
    expect(await rig({ mode: 'off' }).c.run()).toEqual({ ran: false, reason: 'off' });
    expect(marks()).toEqual([]);
    expect(await c.run()).toMatchObject({ ran: true, marked: 1 });
    expect(marks()).toEqual([u]);
  });

  it('a library process waits for the first word on the service; the one-process hub always knows it (CO5)', async () => {
    const dir = tempDir();
    const lp = await createLibraryProcess(
      {
        dataDir: dir,
        domain: 'localhost',
        logToStdout: false,
        logLevel: 'warn',
        scheduleBackups: false,
        appsDir: join(dir, 'no-apps'),
        importRoots: [join(dir, 'import')],
        host: '127.0.0.1',
        port: 0,
        toolProbe: TEST_TOOLS,
        systemFaces: noSystemFaces,
      },
      { secret: 'test-secret' },
    );
    try {
      expect(await lp.collector.run()).toEqual({ ran: false, reason: 'unknown' });
      lp.setLocks({ t: 'locks', mode: 'idle', presentations: [], media: [], fonts: [] });
      // known now: the next gate is the backfill, which this fresh database has not run
      expect(await lp.collector.run()).toEqual({ ran: false, reason: 'backfill' });
      lp.setLocks({ t: 'locks', mode: 'live', playlistId: 'x', presentations: [], media: [], fonts: [] });
      lp.lib.refs.setBackfillDone(true);
      expect(await lp.collector.run()).toEqual({ ran: false, reason: 'live' });
    } finally {
      await lp.close();
      rmSync(dir, { recursive: true, force: true });
    }
    hub = await startHub();
    ready();
    expect(await hub.collector.run()).toMatchObject({ ran: true });
  });

  it('is in report mode when the variable is absent, and a day-31 run in report mode deletes nothing (CO12)', async () => {
    expect(collectMode(undefined)).toBe('report');
    expect(collectMode('')).toBe('report');
    expect(collectMode('maybe')).toBe('report');
    expect(collectMode('on')).toBe('on');
    expect(collectMode('off')).toBe('off');
    expect(loadConfig({}).collect).toBe('report');
    expect(loadConfig({ ORDO_COLLECT: 'on' }).collect).toBe('on');
    expect(loadConfig({ ORDO_COLLECT: 'off' }).collect).toBe('off');

    hub = await startHub();
    ready();
    const [a, b] = [await json('a'), await json('b')];
    const named = await json('named');
    save('p', [named]);
    const report = rig({ mode: 'report' });
    await report.c.run();
    expect(marks().sort()).toEqual([a, b].sort());
    report.t.now = T0 + 31 * DAY;
    const r = await report.c.run();
    expect(r).toMatchObject({ ran: true, mode: 'report', files: 2, bytes: sizeOf(a) + sizeOf(b) });
    for (const h of [a, b, named]) expect(has(h) && onDisk(h)).toBe(true);
    const lines = report.lines.filter((l) => l.msg === 'collection run');
    expect(lines).toHaveLength(2);
    expect(lines[1]!.obj).toMatchObject({ mode: 'report', files: 2, bytes: sizeOf(a) + sizeOf(b) });
    expect(marks().sort()).toEqual([a, b].sort());
    // the same database in on mode: the marks survived the mode, exactly those files go
    const on = rig({ mode: 'on' });
    on.t.now = T0 + 31 * DAY;
    expect(await on.c.run()).toMatchObject({ ran: true, mode: 'on', files: 2 });
    expect(has(a) || has(b)).toBe(false);
    expect(has(named)).toBe(true);
  });
});

describe('collection: manifests and presentations that are deleted (CO6, CO7)', () => {
  it('a collected file is gone from the next nightly manifest and still in the older ones (CO6)', async () => {
    hub = await startHub();
    ready();
    const u = await json('u');
    const real = Date.now();
    await hub.backups.run({ now: real });
    const { c, t } = rig();
    await c.run();
    t.now = T0 + COLLECT_DELAY_DAYS * DAY;
    await c.run();
    await hub.backups.run({ now: real + 5000 });
    const dir = join(hub.dir, 'backups');
    const manifests = readdirSync(dir)
      .filter((f) => /^media-manifest-.*\.json$/.test(f))
      .map(
        (f) =>
          JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
            createdAt: string;
            files: { hash: string }[];
          },
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(manifests).toHaveLength(2);
    expect(manifests[0]!.files.map((f) => f.hash)).toContain(u);
    expect(manifests[1]!.files.map((f) => f.hash)).not.toContain(u);
  });

  it('a geometry file of a deleted presentation goes 30 days after the first run that saw it unnamed, and a re-import clears the mark (CO7)', async () => {
    hub = await startHub();
    ready();
    const ed = await login(hub.url, EDIT_PIN);
    const [g, other] = [await json('geom'), await json('other')];
    const p = save('deck', [g, other]);
    const { c, t } = rig();
    expect(await c.run()).toMatchObject({ ran: true, marked: 0 });
    expect((await ed.fetch(`/presentations/${p.id}`, { method: 'DELETE' })).status).toBe(204);
    t.now = T0 + 2 * DAY;
    await c.run();
    expect(marks().sort()).toEqual([g, other].sort());
    t.now = T0 + (2 + COLLECT_DELAY_DAYS - 1) * DAY;
    await c.run();
    expect(has(g)).toBe(true);
    // the same deck imported again (the same hashes) names them: the marks go
    save('deck-again', [g, other]);
    expect(marks()).toEqual([]);
    // deleted for good: the first run that sees them unnamed starts the clock again
    await ed.fetch('/presentations/deck-again', { method: 'DELETE' });
    t.now = T0 + 60 * DAY;
    await c.run();
    t.now = T0 + (60 + COLLECT_DELAY_DAYS) * DAY;
    expect(await c.run()).toMatchObject({ ran: true, files: 2 });
    expect(has(g) || has(other)).toBe(false);
  });
});

describe('collection: pictures (CO8)', () => {
  it('deletes a picture of a key no kept version has and no current stand-by claims, at the run, and releases its blob when no other row names it (CO8)', async () => {
    hub = await startHub();
    ready();
    const lib = hub.lib;
    const png = async (seed: number) => {
      const f = await hub!.store.putBytes(new Uint8Array(makePng(8, 8, { seed })), {
        ext: 'png',
        mime: 'image/png',
      });
      paths.set(f.hash, f.path);
      return f.hash;
    };
    const p = save('pic', []);
    const keys = (rev: number, slide: string, key: string, standby: string) =>
      hub!.db
        .prepare(
          `INSERT INTO prerender_keys (presentation_id, rev, slide_id, key, standby_id, sig, created_at) VALUES ('pic', ?, ?, ?, ?, 'x', 1)`,
        )
        .run(rev, slide, key, standby);
    const row = (pid: string, key: string, standby: string, hash: string, size = 3840) =>
      hub!.db
        .prepare(
          `INSERT INTO prerenders (presentation_id, key, size, slide_id, standby_id, version, kind, hash, mime, bytes, w, h, opaque, made_by, made_role, last_rev, created_at)
           VALUES (?, ?, ?, 's', ?, 1, 'slide', ?, 'image/png', 9, 3840, 2160, 1, NULL, 'edit', 1, 1)`,
        )
        .run(pid, key, size, standby, hash);
    const K = (n: number) => String(n).repeat(64);
    keys(p.rev, 's', K(1), 'SB1'); // the current version's key
    const [shared, own, mine, standby] = [await png(1), await png(2), await png(3), await png(4)];
    row('pic', K(1), 'SB1', mine); // kept: its key is in the current rows
    row('pic', K(2), 'SB1', standby); // kept: the stand-by of a current slide
    row('pic', K(3), 'SBX', shared); // deleted: no row names the key, no current slide is its stand-by
    row('pic', K(4), 'SBX', own); // deleted, and its blob goes with it
    row('gone', K(5), 'SBY', shared); // a presentation that is not there: deleted
    row('pic', K(6), 'SB1', shared, 1920); // kept (stand-by) and it names `shared`: the blob stays
    const { c } = rig();
    const r = await c.run();
    expect(r).toMatchObject({ ran: true, pictures: 3 });
    const left = (hub.db.prepare(`SELECT key FROM prerenders ORDER BY key`).all() as { key: string }[]).map(
      (x) => x.key,
    );
    expect(left).toEqual([K(1), K(2), K(6)]);
    expect(has(own)).toBe(false);
    expect(onDisk(own)).toBe(false);
    expect(has(shared)).toBe(true);
    expect(onDisk(shared)).toBe(true);
    expect(lib.fileReferenced(shared)).toBe(true);
    for (const h of [mine, standby]) expect(has(h) && onDisk(h)).toBe(true);
    // report mode deletes none of it and says what would go
    const again = rig({ mode: 'report' });
    row('pic', K(7), 'SBX', await png(5));
    expect(await again.c.run()).toMatchObject({ ran: true, mode: 'report', pictures: 1 });
    expect((hub.db.prepare(`SELECT COUNT(*) AS n FROM prerenders`).get() as { n: number }).n).toBe(4);
  });
});

describe('collection: slices and timers (CO9)', () => {
  it('holds the event loop for no more than a slice and a presentation PUT answers normally during a run (CO9)', async () => {
    hub = await startHub();
    ready();
    for (let i = 0; i < 1500; i++)
      hub.lib.addFile({
        hash: hash(10_000 + i),
        bytes: 10,
        mime: 'application/json',
        path: `media/aa/${i}.json`,
      });
    const { c, t } = rig();
    t.stepMs = 1; // every file costs 1 ms on the fake clock
    await c.run();
    t.now = T0 + COLLECT_DELAY_DAYS * DAY;
    t.slices.length = 0;
    t.steps = 0;
    const r = await c.run();
    expect(r).toMatchObject({ ran: true, files: 1500 });
    const sizes = t.slices.map((s, i) => s - (t.slices[i - 1] ?? 0));
    expect(sizes.length).toBeGreaterThan(50);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20);

    // with the real clock and yields, a save in the middle of a run is answered
    for (let i = 0; i < 1500; i++)
      hub.lib.addFile({
        hash: hash(20_000 + i),
        bytes: 10,
        mime: 'application/json',
        path: `media/bb/${i}.json`,
      });
    const live = rig({ now: undefined, yield: undefined, onStep: undefined });
    await live.c.run();
    hub.db.prepare(`UPDATE collect_marks SET since = 0`).run();
    const ed = await login(hub.url, EDIT_PIN);
    const p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([bigSlide('x', 3)]),
    });
    const [done, put] = await Promise.all([
      live.c.run(),
      ed.fetch(`/presentations/${p.id}`, { method: 'PUT', json: { ...p, title: 'during a run' } }),
    ]);
    expect(put.status).toBe(200);
    expect(done).toMatchObject({ ran: true, files: 1500 });
  });

  it('arms one run a day at 04:00 venue time, after the 03:00 backup, and once 10 minutes after the start (CO9)', async () => {
    hub = await startHub();
    const { c } = rig();
    expect(c.nextRunAt(Date.UTC(2031, 0, 1, 0, 0))).toBe(Date.UTC(2031, 0, 1, 4, 0));
    expect(c.nextRunAt(Date.UTC(2031, 0, 1, 4, 0))).toBe(Date.UTC(2031, 0, 2, 4, 0));
    const la = rig({ timeZone: () => 'America/Los_Angeles' });
    expect(la.c.nextRunAt(Date.UTC(2031, 0, 1, 10, 0))).toBe(Date.UTC(2031, 0, 1, 12, 0));
    vi.useFakeTimers({ now: T0 });
    try {
      const t = rig({ now: undefined, schedule: true });
      const run = vi.spyOn(t.c, 'run').mockResolvedValue({ ran: false, reason: 'live' });
      t.c.start();
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4 * 3600_000);
      expect(run).toHaveBeenCalledTimes(2);
      t.c.stop();
      await vi.advanceTimersByTimeAsync(2 * DAY);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('collection: heads, health (CO10, CO11)', () => {
  it('a swept head takes its index rows with it, its pages go, a page a surviving head names stays, and a gone head answers 409 (CO11)', async () => {
    hub = await startHub();
    ready();
    const ed = await login(hub.url, EDIT_PIN);
    // a real slide file nobody names, and one a presentation names
    const unnamed = fullOf(bigSlide('u', 260, 'u'));
    const named = fullOf(bigSlide('n', 270, 'n'));
    await uploadSlideFile(ed, unnamed.pages);
    await uploadSlideFile(ed, named.pages);
    await ed.json<Presentation>('/presentations', { method: 'POST', json: presentationOf([named.standIn]) });
    // a synthetic pair of heads sharing a page: one named, one not
    const [hA, hB, shared, onlyB] = [
      await json('hA'),
      await json('hB'),
      await json('shared'),
      await json('onlyB'),
    ];
    headRow(hA, [shared]);
    headRow(hB, [shared, onlyB]);
    save('uses-a', []);
    hub.lib.savePresentation({ ...namingHead('uses-a', hA), rev: 1 }, { expectedRev: 1 });
    const { c, t } = rig();
    await c.run();
    t.now = T0 + COLLECT_DELAY_DAYS * DAY;
    const r = await c.run();
    const count = (sql: string, ...a: unknown[]) => (hub!.db.prepare(sql).get(...a) as { n: number }).n;
    for (const h of [unnamed.name, ...unnamed.pages.head.pages, hB, onlyB]) {
      expect(has(h), h).toBe(false);
      expect(onDisk(h) || existsSync(join(hub.dir, 'media', h.slice(0, 2), `${h}.json`)), h).toBe(false);
    }
    expect(r).toMatchObject({ ran: true });
    expect(count(`SELECT COUNT(*) AS n FROM slide_heads WHERE hash IN (?, ?)`, unnamed.name, hB)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM slide_head_pages WHERE head IN (?, ?)`, unnamed.name, hB)).toBe(
      0,
    );
    for (const h of [named.name, ...named.pages.head.pages, hA, shared]) expect(has(h), h).toBe(true);
    expect(count(`SELECT COUNT(*) AS n FROM slide_heads WHERE hash IN (?, ?)`, named.name, hA)).toBe(2);
    // a head whose file is gone answers like an unknown one
    const again = await ed.fetch('/presentations', {
      method: 'POST',
      json: presentationOf([unnamed.standIn]),
    });
    expect(again.status).toBe(409);
  });

  it('carries the last run in the stats, in meta and in one log line per run (CO10)', async () => {
    hub = await startHub({ collect: 'on' });
    ready();
    expect(hub.collector.healthFields()).toEqual({});
    const [a, b] = [await json('a'), await json('b')];
    const BYTES = sizeOf(a) + sizeOf(b);
    const { c, t, lines } = rig();
    await c.run();
    t.now = T0 + COLLECT_DELAY_DAYS * DAY;
    await c.run();
    expect(lines.filter((l) => l.msg === 'collection run').map((l) => l.obj)).toMatchObject([
      { mode: 'on', marked: 2, files: 0 },
      { mode: 'on', marked: 0, files: 2, bytes: BYTES, pictures: 0 },
    ]);
    const meta = JSON.parse(
      (hub.db.prepare(`SELECT value FROM meta WHERE key = 'collect_last_run'`).get() as { value: string })
        .value,
    ) as { at: number; files: number };
    expect(meta).toMatchObject({ at: T0 + COLLECT_DELAY_DAYS * DAY, files: 2 });
    expect(c.healthFields()).toEqual({
      collectedFiles: 2,
      collectedBytes: BYTES,
      lastCollectAt: T0 + COLLECT_DELAY_DAYS * DAY,
    });
    // the hub's own collector reports on /health once it has run
    await hub.collector.run();
    const h = (await (await fetch(`${hub.url}/api/v1/health`)).json()) as Record<string, unknown>;
    expect(typeof h.lastCollectAt).toBe('number');
    expect(h.collectedFiles).toBe(0);
  });
});
