/**
 * The picture listing of a presentation (`PrerenderIndex.listing`, what a baker reads for each presentation at every
 * sweep, C-PS2) against its ORACLE (store-2 step 5, M2(d)): a copy of the function as sub-wave 2 shipped it, a LEFT JOIN of
 * the keys and their pictures, ordered `rev DESC, slide_id, key`, one JS object a row. The levers of step 5 (no unused
 * SUM, two statements, the failures by EXISTS) are kept only while the two answer the same over seeded random libraries:
 * the same keys in the same ORDER, the same `sizes` sorted, `madeBy` and `at`, the same failures. The 5,000-key cap
 * bites in some libraries (the 40,000-joined-row cap of the oracle cannot with at most 6,000 key rows of at most 3 pictures).
 */
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type DB, openDb } from '../src/db.ts';
import { LISTING_KEYS_MAX, PrerenderIndex } from '../src/prerenders.ts';
import { tempDir } from './helpers.ts';

type Listed = {
  keys: { slideId: string; key: string; standbyId: string; sizes: number[]; madeBy?: string; at?: number }[];
  failures: { key: string; reason: string; madeBy?: string; at: number }[];
};

/** The listing exactly as sub-wave 2 shipped it (apps/hub/src/prerenders.ts at the tag r2b3-base). */
function listingOracle(db: DB, presentationId: string): Listed {
  const rows = db
    .prepare(
      `SELECT k.slide_id, k.key, k.standby_id, p.size, p.made_by, p.created_at
         FROM prerender_keys k LEFT JOIN prerenders p ON p.presentation_id = k.presentation_id AND p.key = k.key
         WHERE k.presentation_id = ? ORDER BY k.rev DESC, k.slide_id, k.key LIMIT 40000`,
    )
    .all(presentationId) as {
    slide_id: string;
    key: string;
    standby_id: string;
    size: number | null;
    made_by: string | null;
    created_at: number | null;
  }[];
  const keys = new Map<string, Listed['keys'][number]>();
  for (const r of rows) {
    let k = keys.get(r.key);
    if (!k) {
      if (keys.size >= LISTING_KEYS_MAX) continue;
      keys.set(r.key, (k = { slideId: r.slide_id, key: r.key, standbyId: r.standby_id, sizes: [] }));
    }
    if (r.size !== null && !k.sizes.includes(r.size)) {
      k.sizes.push(r.size);
      if (r.made_by && !k.madeBy) k.madeBy = r.made_by;
      if (r.created_at !== null && (k.at === undefined || r.created_at > k.at)) k.at = r.created_at;
    }
  }
  const failures = (
    db
      .prepare(
        `SELECT f.key, f.reason, f.made_by, f.at FROM prerender_failures f
           WHERE f.key IN (SELECT DISTINCT key FROM prerender_keys WHERE presentation_id = ?) ORDER BY f.at DESC LIMIT 5000`,
      )
      .all(presentationId) as { key: string; reason: string; made_by: string | null; at: number }[]
  ).map((f) => ({ key: f.key, reason: f.reason, ...(f.made_by ? { madeBy: f.made_by } : {}), at: f.at }));
  return { keys: [...keys.values()].map((k) => ({ ...k, sizes: k.sizes.sort((a, b) => a - b) })), failures };
}

/** A small seeded generator (mulberry32): the libraries are the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hex = (n: number) => n.toString(16).padStart(64, '0');

/** A library of `n` presentations of random slides, revisions, keys (some shared by two slides), pictures and failures. */
function seeded(db: DB, seed: number): { ids: string[]; keyRows: number } {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const insK = db.prepare(
    `INSERT OR IGNORE INTO prerender_keys (presentation_id, rev, slide_id, key, standby_id, sig, created_at) VALUES (?, ?, ?, ?, ?, 'x', 1)`,
  );
  const insP = db.prepare(
    `INSERT OR IGNORE INTO prerenders (presentation_id, key, size, slide_id, standby_id, version, kind, hash, mime, bytes, w, h, opaque, made_by, made_role, last_rev, created_at) VALUES (?, ?, ?, ?, ?, 1, 'slide', ?, 'image/png', 1000, ?, ?, 1, ?, 'edit', 1, ?)`,
  );
  const insF = db.prepare(
    `INSERT OR IGNORE INTO prerender_failures (key, reason, made_by, at) VALUES (?, ?, ?, ?)`,
  );
  const ids: string[] = [];
  let total = 0;
  let uniqueAt = 1_000_000;
  const big = seed % 6 === 0; // some libraries are big enough for the 5,000-key cap to bite
  for (let pi = 0; pi < 3; pi++) {
    const id = `pres-${seed}-${pi}`;
    ids.push(id);
    const slides = int(1, big && pi === 0 ? 60 : 30);
    const revs = int(1, big && pi === 0 ? 12 : 8);
    const rows = pi === 0 && big ? int(5200, 6000) : int(0, 400);
    for (let i = 0; i < rows; i++) {
      const rev = int(1, revs);
      const slide = `s${int(1, slides)}`;
      const key = hex(seed * 100_000 + pi * 10_000 + i + 1);
      const standby = hex(9_000_000 + seed * 1000 + (i % 977));
      insK.run(id, rev, slide, key, standby);
      total++;
      if (r() < 0.12) {
        // the same key in another revision or by another slide (a key two slides share)
        insK.run(id, int(1, revs), `s${int(1, slides)}`, key, standby);
        total++;
      }
      const sizes = [3840, 1920, 640].filter(() => r() < 0.55);
      for (const sz of sizes)
        insP.run(
          id,
          key,
          sz,
          slide,
          standby,
          hex(50_000_000 + total * 3 + sz),
          sz,
          Math.round((sz * 9) / 16),
          r() < 0.7 ? `maker ${int(1, 3)}` : null,
          int(1, 50_000),
        );
      if (r() < 0.04) insF.run(key, `reason ${i % 5}`, r() < 0.5 ? 'baker' : null, uniqueAt++);
    }
    // a failure of a key this presentation does not have, and pictures of a key it does not list
    insF.run(hex(777_777_000 + seed), 'foreign', null, uniqueAt++);
    insP.run(id, hex(888_888_000 + seed), 640, 'sx', hex(1), hex(60_000_000 + seed), 640, 360, null, 7);
  }
  return { ids, keyRows: total };
}

describe('the picture listing equals its oracle (PL1)', () => {
  const db = openDb(join(tempDir(), 'listing.db'));
  afterAll(() => db.close());
  const index = new PrerenderIndex(db);

  for (let seed = 1; seed <= 30; seed++)
    it(`library ${seed}: the same keys in the same order, sizes, makers, times and failures`, () => {
      const { ids } = seeded(db, seed);
      for (const id of ids) {
        const got = index.listing(id);
        const want = listingOracle(db, id);
        expect(got.keys.map((k) => k.key)).toEqual(want.keys.map((k) => k.key));
        expect(got.keys).toEqual(want.keys);
        expect(got.failures).toEqual(want.failures);
        expect(got.keys.length).toBeLessThanOrEqual(LISTING_KEYS_MAX);
      }
    });

  it('the 5,000-key cap bites in at least one of the libraries, and a presentation with no keys lists none', () => {
    const capped = db
      .prepare(
        `SELECT presentation_id, COUNT(DISTINCT key) AS n FROM prerender_keys GROUP BY presentation_id HAVING n > ?`,
      )
      .all(LISTING_KEYS_MAX) as { presentation_id: string; n: number }[];
    expect(capped.length).toBeGreaterThan(0);
    for (const c of capped) expect(index.listing(c.presentation_id).keys).toHaveLength(LISTING_KEYS_MAX);
    expect(index.listing('no-such-presentation')).toMatchObject({ keys: [], failures: [] });
  });

  it('reads in three statements (the newest row of each key, the pictures, the failures): no join, no unread sum, no DISTINCT set', () => {
    const { ids } = seeded(db, 31);
    const sqls: string[] = [];
    const real = db.prepare.bind(db);
    const spy = {
      prepare: (sql: string) => {
        sqls.push(sql);
        return real(sql);
      },
    } as unknown as DB;
    const out = new PrerenderIndex(spy).listing(ids[0]!);
    expect(sqls).toHaveLength(3);
    expect(sqls.join('\n')).not.toMatch(/SUM\(|LEFT JOIN|SELECT DISTINCT/i);
    // the picture bytes are asked of the references index by `list`, not computed here and left unread
    expect(Object.keys(out).sort()).toEqual(['failures', 'keys']);
  });
});
