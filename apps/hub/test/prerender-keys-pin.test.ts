/**
 * KEYS DO NOT MOVE (design/29 §1.2). The key and the stand-by id the hub computes for slides stored whole inline
 * are pinned here as hex literals, taken at the base of sub-wave 3 (0.10.0, before this release's hub changes): a
 * moved key makes every stored picture stale at once, so every change to the code that computes a key (the keys
 * job, the pool task, the hashing) must leave this file green. It pins the VALUES (key, stand-by id) and the
 * PROPERTIES of `sig` (hub-internal, free to change in form): saving the same presentation again copies the rows
 * and asks the pool for nothing, and a changed media file or a changed object makes a different key and a
 * different sig. The slides are synthetic; the library holds no font, so the faces are the empty chain.
 */
import { createHash } from 'node:crypto';
import type { Presentation, Slide } from '@ordo/domain';
import { contentCase } from '@ordo/domain/content.test-util.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { cpuPool, type CpuPool } from '../src/pool.ts';
import { PrerenderKeys } from '../src/prerenderkeys.ts';
import { EDIT_PIN, login, startHub, type TestHub } from './helpers.ts';
import { bigSlide, presentationOf, rect, textObject } from './prerender-helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

/** The pinned values: `{ key, standbyId }` of each slide below, saved as the record `{ why: ['count'], live: [] }`. */
const PINS = {
  plain: {
    key: '41a386550958d2e4ae7819a57a79d1c6c53f83cd2b38361560ac1a4512ead862',
    standbyId: 'a48bf5784c12d32c4616053902c6decbdb5bb4a39d6d6d14d05cc7e52d23e235',
  },
  heavy: {
    key: 'be21865cf97fd3921b5104fd9625a7bddc077ffba90536649ac7a7ef3de593c4',
    standbyId: 'f9dc3a72378c0d9468b3472adddc373931e00f72c46ad73cc55af666e119f89c',
  },
  reference: {
    key: '31adf46433ff06e7895e88c65e47e206811b38a8994ba13c15132d3bb5e2e131',
    standbyId: '4c462f9554c3a55b9cad649a2f63f59f0e370855d4599896a9cc41aa9b13848d',
  },
  // the heavy slide with `live: ['lyric']`: its own key, never the key of the same slide with `live: []`
  heavyLive: {
    key: '70716c7206f13eb325a79da55a4ff7ebdcc4cbe459b830aaac1570302a5d1171',
    standbyId: '7a67dd0fdf2a6bba09cc79a64a0334029cafa6084e97aad78b30b55551c7d066',
  },
} as const;

const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');

/** A ready image in the library: the picture's key reads the file it decodes (`stillFile`). */
function addMedia(h: TestHub, id: string, file: string) {
  h.db
    .prepare(
      `INSERT OR REPLACE INTO media (id, rev, name, kind, state, json, created_at, updated_at) VALUES (?, 1, ?, 'image', 'ready', ?, 'a', 'a')`,
    )
    .run(
      id,
      id,
      JSON.stringify({
        id,
        rev: 1,
        name: id,
        tags: [],
        kind: 'image',
        original: { hash: file, bytes: 1, mime: 'image/png', path: `media/${file.slice(0, 2)}/${id}.png` },
        state: 'ready',
        loop: false,
        isBackground: false,
      }),
    );
}

const RECORD = { why: ['count' as const], live: [] as string[] };
const withRecord = (s: Slide, live: string[] = []): Slide => ({ ...s, prerender: { ...RECORD, live } });

/** (1) a plain 3-object slide. */
function plainSlide(): Slide {
  return {
    id: 'plain',
    objects: [
      rect('bg', { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }, { fill: { r: 10, g: 20, b: 30, a: 1 } }),
      textObject('title', 'Plain title', { x: 0, y: 0, w: 500, h: 100, rotation: 0 }),
      textObject('lyric', 'Plain lyric', { x: 0, y: 900, w: 500, h: 100, rotation: 0 }),
    ],
    lyricObjectId: 'lyric',
  };
}

/** (2) a heavy slide: 300 shapes, 40 images whose media files exist in the library, 2 text boxes. */
function heavySlide(id = 'heavy'): Slide {
  const s = bigSlide(id, 300, 'pin');
  const images = Array.from({ length: 40 }, (_, i) => ({
    id: `img${i}`,
    type: 'image' as const,
    box: { x: (i % 8) * 200, y: 300 + Math.floor(i / 8) * 120, w: 190, h: 110, rotation: 0 },
    mediaId: `m${i}`,
    fit: 'contain' as const,
    opacity: 1,
    radius: 0,
  }));
  s.objects.splice(1, 0, ...(images as never[]));
  return s;
}
const addHeavyMedia = (h: TestHub) => {
  for (let i = 0; i < 40; i++) addMedia(h, `m${i}`, hashOf(`pin-image-${i}`));
};

/** (3) the reference-picture slide: an imported PowerPoint picture shown (content case 'ref'). */
function referenceSlide(): Slide {
  return { ...structuredClone(contentCase('ref').slide), id: 'reference' };
}
const addReferenceMedia = (h: TestHub) => {
  const c = contentCase('ref');
  for (const id of new Set([...c.pictures, ...c.hidden, c.picture ?? 'ref']))
    addMedia(h, id, hashOf(`pin-ref-${id}`));
};

async function save(slides: Slide[], title: string) {
  const ed = await login(hub!.url, EDIT_PIN);
  const p = await ed.json<Presentation>('/presentations', {
    method: 'POST',
    json: presentationOf(slides, title),
  });
  const rows = hub!.lib.prerenderIndex.keysAt(p.id, p.rev);
  const by = new Map(rows.map((r) => [r.slideId, r]));
  return { ed, p, rows, by };
}

/** A pool that counts the tasks it is asked to run (the form of prerender-keys.test.ts). */
function countingPool() {
  let n = 0;
  const pool = (): Pick<CpuPool, 'run'> => ({
    run: ((task: never, input: never) => {
      n++;
      return cpuPool().run(task, input);
    }) as CpuPool['run'],
  });
  return { pool, calls: () => n };
}

describe('the keys the hub computes for inline slides do not move', () => {
  it('pins the key and the stand-by id of four slides (hex literals taken at the base)', async () => {
    hub = await startHub();
    addHeavyMedia(hub);
    addReferenceMedia(hub);
    const a = await save(
      [withRecord(plainSlide()), withRecord(heavySlide()), withRecord(referenceSlide())],
      'Pins A',
    );
    const b = await save([withRecord(heavySlide('heavy-live'), ['lyric'])], 'Pins B');
    const got = {
      plain: a.by.get('plain'),
      heavy: a.by.get('heavy'),
      reference: a.by.get('reference'),
      heavyLive: b.by.get('heavy-live'),
    };
    const actual = Object.fromEntries(
      Object.entries(got).map(([k, r]) => [k, { key: r?.key, standbyId: r?.standbyId }]),
    );
    // keep the printed values as the literals above
    expect(actual).toEqual(PINS);
    // hook H1: a live set is part of the key and the stand-by id
    expect(got.heavyLive!.key).not.toBe(got.heavy!.key);
    expect(got.heavyLive!.standbyId).not.toBe(got.heavy!.standbyId);
  });

  it('saving the same presentation again copies the rows and asks the pool for nothing (the sig is stable)', async () => {
    hub = await startHub();
    addHeavyMedia(hub);
    const { p, rows } = await save([withRecord(plainSlide()), withRecord(heavySlide())], 'Pins C');
    expect(rows).toHaveLength(2);
    const { pool, calls } = countingPool();
    const keys = new PrerenderKeys(hub.lib, hub.store, pool, { live: () => 'idle', log: hub.log });
    const again = await keys.keysFor(p);
    expect(calls()).toBe(0);
    expect(again.map((r) => [r.slideId, r.key, r.standbyId, r.sig]).sort()).toEqual(
      rows.map((r) => [r.slideId, r.key, r.standbyId, r.sig]).sort(),
    );
  });

  it('a changed object or a changed media file makes a different key and a different sig', async () => {
    hub = await startHub();
    addHeavyMedia(hub);
    const { p, rows } = await save([withRecord(heavySlide())], 'Pins D');
    const old = rows[0]!;
    const keys = (pool: ReturnType<typeof countingPool>) =>
      new PrerenderKeys(hub!.lib, hub!.store, pool.pool, { live: () => 'idle', log: hub!.log });

    // one object's x
    const moved = structuredClone(p);
    const slide = moved.sections[0]!.slides[0]!;
    const target = slide.objects.find((o) => o.id === 'r7')!;
    target.box = { ...target.box, x: target.box.x + 1 };
    const pool1 = countingPool();
    const [byObject] = await keys(pool1).keysFor(moved);
    expect(pool1.calls()).toBe(1);
    expect(byObject!.key).not.toBe(old.key);
    expect(byObject!.sig).not.toBe(old.sig);

    // one media file's hash
    addMedia(hub, 'm3', hashOf('pin-image-3-replaced'));
    const pool2 = countingPool();
    const [byMedia] = await keys(pool2).keysFor(p);
    expect(pool2.calls()).toBe(1);
    expect(byMedia!.key).not.toBe(old.key);
    expect(byMedia!.sig).not.toBe(old.sig);
    expect(byMedia!.key).not.toBe(byObject!.key);
  });
});
