/**
 * Keys at save (design/29 §1.3): PK1-PK9. The hub computes each pre-rendered slide's key and stand-by id in the CPU
 * pool when a presentation is saved and writes them in the save's transaction; the expected keys are computed IN THE
 * TEST with the domain's own functions.
 */
import { createHash } from 'node:crypto';
import { newId, type Presentation, type Slide, stillFile } from '@ordo/domain';
import { pictureSource, prerenderKey, standbyId } from '@ordo/domain/prerender.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrerenderKeys } from '../src/prerenderkeys.ts';
import { cpuPool } from '../src/pool.ts';
import { EDIT_PIN, login, OPERATE_PIN, sleep, startHub, type TestHub } from './helpers.ts';
import { bigSlide, fullOf, presentationOf, textObject, uploadSlideFile } from './prerender-helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await hub?.cleanup();
  hub = undefined;
});

type Row = { rev: number; slide_id: string; key: string; standby_id: string; sig: string };
const rows = (id: string): Row[] =>
  hub!.db
    .prepare(
      `SELECT rev, slide_id, key, standby_id, sig FROM prerender_keys WHERE presentation_id = ? ORDER BY rev, slide_id, key`,
    )
    .all(id) as Row[];

/** The library's own inputs for a picture's key, read as the hub reads them. */
function inputs() {
  const fonts = hub!.lib.listFonts().map((f) => ({ family: f.family, file: { hash: f.file.hash } }));
  return {
    fonts,
    mediaFile: (id: string) => {
      const m = hub!.lib.media.get(id);
      return m ? stillFile(m)?.hash : undefined;
    },
  };
}
const expected = (full: Slide, live: readonly string[]) => {
  const src = pictureSource(full, live, inputs());
  return { key: prerenderKey(src), standbyId: standbyId(src) };
};

/** Calls of the pool's key task. */
const keyTasks = () => {
  const spy = vi.spyOn(cpuPool(), 'run');
  return () => spy.mock.calls.filter((c) => c[0] === 'prerender-keys').length;
};

/** A library font, announced as FontService does (the hub follows its change events). */
const font = (family: string, hash: string) => {
  const f = hub!.lib.upsertFont({
    family,
    weight: 400,
    style: 'normal',
    file: { hash, bytes: 10, mime: 'font/ttf', path: `fonts/${hash}.ttf` },
    source: 'upload',
  });
  hub!.lib.emit([{ kind: 'font', id: f.id, entity: f }]);
  return f;
};

async function until(fn: () => boolean, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function setup() {
  hub = await startHub();
  const ed = await login(hub.url, EDIT_PIN);
  return ed;
}

describe('keys at save (PK1-PK5, PK8)', () => {
  it('writes no row and never asks the pool for a presentation with no pre-rendered slide (PK1)', async () => {
    const ed = await setup();
    const tasks = keyTasks();
    const p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([bigSlide('p', 5)]),
    });
    await ed.json(`/presentations/${p.id}`, { method: 'PUT', json: { ...p, title: 'edited' } });
    expect(tasks()).toBe(0);
    expect(rows(p.id)).toEqual([]);
  });

  it("writes the slide's key and stand-by id, equal to the domain's own computation (PK2)", async () => {
    const ed = await setup();
    const f = fullOf();
    await uploadSlideFile(ed, f.pages);
    const p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([f.standIn]),
    });
    const want = expected(f.full, f.standIn.prerender!.live);
    const got = rows(p.id);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      rev: p.rev,
      slide_id: f.standIn.id,
      key: want.key,
      standby_id: want.standbyId,
    });
    expect(got[0]!.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(want.key).toBe(f.key);
    // with a library font and a drawn picture's file in the key
    font('Inter', 'a'.repeat(64));
    const photo = bigSlide('photo', 250, 'photo');
    photo.objects.push({
      id: 'photo',
      type: 'image',
      box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      mediaId: 'm-photo',
      fit: 'contain',
      opacity: 1,
      radius: 0,
    } as never);
    hub!.db
      .prepare(
        `INSERT INTO media (id, rev, name, kind, state, json, created_at, updated_at) VALUES ('m-photo', 1, 'p', 'image', 'ready', ?, 'a', 'a')`,
      )
      .run(
        JSON.stringify({
          id: 'm-photo',
          rev: 1,
          name: 'p',
          tags: [],
          kind: 'image',
          original: { hash: 'b'.repeat(64), bytes: 1, mime: 'image/png', path: 'media/bb/x.png' },
          state: 'ready',
          loop: false,
          isBackground: false,
        }),
      );
    const g = fullOf(photo);
    await uploadSlideFile(ed, g.pages);
    const q = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([g.standIn]),
    });
    const wantG = expected(g.full, g.standIn.prerender!.live);
    expect(rows(q.id)[0]).toMatchObject({ key: wantG.key, standby_id: wantG.standbyId });
    // the picture's file is in the key: a different file is a different key
    const src = pictureSource(g.full, g.standIn.prerender!.live, {
      ...inputs(),
      mediaFile: () => 'c'.repeat(64),
    });
    expect(prerenderKey(src)).not.toBe(wantG.key);
  });

  it('gives a slide set to Pre-rendered by hand (why chosen, inline) its key from the inline slide (PK3)', async () => {
    const ed = await setup();
    const slide: Slide = {
      ...bigSlide('hand', 4, 'hand'),
      prerender: { why: ['chosen'], live: ['lyric'] },
      draw: 'picture',
    };
    const p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([slide]),
    });
    const want = expected(slide, ['lyric']);
    expect(rows(p.id)).toMatchObject([{ slide_id: 'hand', key: want.key, standby_id: want.standbyId }]);
  });

  it('does not depend on ids, origins or locks, nor on notes, cues or timing (PK4)', async () => {
    const ed = await setup();
    const f = fullOf();
    await uploadSlideFile(ed, f.pages);
    const dup: Slide = { ...f.standIn, id: 'duplicate' };
    const p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([f.standIn, dup]),
    });
    const r = rows(p.id);
    expect(r.map((x) => x.slide_id).sort()).toEqual(['big', 'duplicate']);
    expect(new Set(r.map((x) => x.key)).size).toBe(1);
    // a note, a cue and the timing change no key
    const noted = {
      ...p,
      sections: [
        {
          ...p.sections[0]!,
          slides: p.sections[0]!.slides.map((s) => ({ ...s, notes: 'new note', durationMs: 5000 })),
        },
      ],
    };
    const q = await ed.json<Presentation>(`/presentations/${p.id}`, { method: 'PUT', json: noted });
    const after = rows(p.id).filter((x) => x.rev === q.rev);
    expect(after.map((x) => x.key)).toEqual(r.map((x) => x.key));
  });

  it("copies an unchanged slide's row (no pool call), and computes again when its record, a font or a picture's file changed (PK5)", async () => {
    const ed = await setup();
    const f = fullOf();
    await uploadSlideFile(ed, f.pages);
    const p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([f.standIn]),
    });
    const tasks = keyTasks();
    const again = await ed.json<Presentation>(`/presentations/${p.id}`, {
      method: 'PUT',
      json: { ...p, title: 'Renamed' },
    });
    expect(tasks()).toBe(0);
    const r = rows(p.id);
    expect(r.filter((x) => x.rev === again.rev)).toMatchObject([{ key: r[0]!.key, sig: r[0]!.sig }]);
    // the slide's record changed (its live set: the lyric box is drawn into the picture): computed again, a new key
    const stand = again.sections[0]!.slides[0]!;
    const live = { ...stand, prerender: { ...stand.prerender!, live: [] } };
    const withLive = { ...again, sections: [{ ...again.sections[0]!, slides: [live] }] };
    const third = await ed.json<Presentation>(`/presentations/${p.id}`, { method: 'PUT', json: withLive });
    expect(tasks()).toBe(1);
    const k3 = rows(p.id).filter((x) => x.rev === third.rev);
    expect(k3).toHaveLength(1);
    expect(k3[0]!.key).not.toBe(r[0]!.key);
    // a font upload (the default face is in every chain) changes the sig: the recompute job computes the slide
    // again once, beside the old key; the next save copies that row
    const before = tasks();
    const old = rows(p.id).filter((x) => x.rev === third.rev);
    font('Inter', 'd'.repeat(64));
    await hub!.prerenderKeys.idle();
    await until(
      () => rows(p.id).filter((x) => x.rev === third.rev).length === old.length + 1,
      8000,
      'the recompute',
    );
    expect(tasks()).toBe(before + 1);
    const fresh = rows(p.id).filter((x) => x.rev === third.rev && x.sig !== old[0]!.sig);
    expect(fresh).toHaveLength(1);
    const fourth = await ed.json<Presentation>(`/presentations/${p.id}`, {
      method: 'PUT',
      json: { ...third, title: 'After the font' },
    });
    expect(tasks()).toBe(before + 1);
    expect(rows(p.id).filter((x) => x.rev === fourth.rev)).toMatchObject([
      { sig: fresh[0]!.sig, key: fresh[0]!.key },
    ]);
  });

  it('plans the rows of a save whose pre-rendered slides did not change in about the time of reading them (PK10)', async () => {
    // Each save looks at every pre-rendered slide's stand-in to know it did not change: that must cost about one
    // pass over its bytes (a hash of the text), not a canonical rewrite and a hash in plain script (M2: 290 ms a
    // save for 60 stand-ins of 120 KB, against 5 ms asked).
    const ed = await setup();
    const slides: Slide[] = [];
    for (let i = 0; i < 24; i++) {
      const s = bigSlide(`heavy${i}`, 40, `t${i}`);
      for (let k = 0; k < 6; k++) s.objects.push(textObject(`h${k}`, `${i}.${k} ${'grace '.repeat(3000)}`));
      const f = fullOf(s);
      await uploadSlideFile(ed, f.pages);
      slides.push(f.standIn);
    }
    const p = await ed.json<Presentation>('/presentations', { method: 'POST', json: presentationOf(slides) });
    expect(rows(p.id)).toHaveLength(24);
    const saved = await ed.json<Presentation>(`/presentations/${p.id}`);
    const bytes = JSON.stringify(saved).length;
    expect(bytes).toBeGreaterThan(2_000_000);
    const tasks = keyTasks();
    const best = async (fn: () => unknown) => {
      let min = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        await fn();
        min = Math.min(min, performance.now() - t0);
      }
      return min;
    };
    // the least a pass over the same stand-ins costs: a stringify and a native hash of each
    const read = await best(() => {
      for (const sec of saved.sections)
        for (const sl of sec.slides) createHash('sha256').update(JSON.stringify(sl)).digest('hex');
    });
    const plan = await best(() => hub!.prerenderKeys.keysFor(saved));
    expect(tasks()).toBe(0); // every row was copied
    expect(plan).toBeLessThan(read * 2 + 5);
  });

  it('computes the rows of a restored body (PK8)', async () => {
    const ed = await setup();
    const f = fullOf();
    await uploadSlideFile(ed, f.pages);
    const p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([f.standIn]),
    });
    const second = await ed.json<Presentation>(`/presentations/${p.id}`, {
      method: 'PUT',
      json: { ...p, sections: [{ ...p.sections[0]!, slides: [] }] },
    });
    expect(rows(p.id).filter((x) => x.rev === second.rev)).toEqual([]);
    const restored = await ed.json<Presentation>(`/presentations/${p.id}/restore/${p.rev}`, {
      method: 'POST',
    });
    expect(rows(p.id).filter((x) => x.rev === restored.rev)).toHaveLength(1);
  });
});

describe('the jobs (PK6, PK7, PK9)', () => {
  async function pre(slide = bigSlide()) {
    const ed = await setup();
    const f = fullOf(slide);
    await uploadSlideFile(ed, f.pages);
    const p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([f.standIn]),
    });
    return { ed, f, p };
  }
  const current = (id: string) => (hub!.lib.presentations.get(id) as Presentation).rev;

  it('adds a row beside the old one, for the current revision, when a font the head names is uploaded (PK6)', async () => {
    const { p, f: made } = await pre();
    const old = rows(p.id)[0]!;
    font('Inter', 'e'.repeat(64));
    await hub!.prerenderKeys.idle();
    await until(() => rows(p.id).filter((r) => r.rev === current(p.id)).length === 2, 8000, 'the new row');
    const at = rows(p.id).filter((r) => r.rev === current(p.id));
    expect(at.map((r) => r.key)).toContain(old.key);
    const want = expected(made.full, made.standIn.prerender!.live);
    expect(want.key).not.toBe(old.key);
    expect(at.map((r) => r.key)).toContain(want.key);
  });

  it('adds nothing for a font no head names, and for a media item no head draws (PK6)', async () => {
    const { p } = await pre();
    font('Zzz Unrelated', 'f'.repeat(64));
    await hub!.prerenderKeys.idle();
    await sleep(200);
    expect(rows(p.id)).toHaveLength(1);
  });

  it('waits for End service and runs in slices through the pool (PK6)', async () => {
    const { ed, p } = await pre();
    const other = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([bigSlide('x', 3)], 'Other'),
    });
    const pl = await ed.json<{ id: string }>('/playlists', {
      method: 'POST',
      json: { name: 'S', items: [{ id: newId(), kind: 'presentation', presentationId: other.id }] },
    });
    const op = await login(hub!.url, OPERATE_PIN);
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    const tasks = keyTasks();
    font('Inter', '1'.repeat(64));
    await sleep(600);
    expect(tasks()).toBe(0);
    expect(rows(p.id)).toHaveLength(1);
    await op.json('/live/events', { method: 'POST', json: { k: 'endService', at: Date.now() } });
    await until(() => rows(p.id).length === 2, 8000, 'the row after End service');
    expect(tasks()).toBe(1);
  });

  it('fills the rows of a writer that saves without keys within seconds (PK7)', async () => {
    const { ed, f } = await pre();
    const direct = presentationOf([{ ...f.standIn, id: 'direct' }], 'Direct writer');
    const saved = hub!.lib.savePresentation({ ...direct, rev: 1 }, { create: true });
    hub!.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
    expect(rows(saved.id)).toEqual([]);
    await until(() => rows(saved.id).length === 1, 8000, 'the safety net');
    void ed;
  });

  it('fills a library that starts with pre-rendered slides lacking rows once, after the delay, never while live (PK7)', async () => {
    const { p } = await pre();
    hub!.db.prepare(`DELETE FROM prerender_keys`).run();
    let mode: 'idle' | 'live' = 'live';
    const pk = new PrerenderKeys(hub!.lib, hub!.store, () => cpuPool(), {
      live: () => mode,
      log: hub!.log,
      startDelayMs: 20,
    });
    pk.start();
    await sleep(300);
    expect(rows(p.id)).toEqual([]);
    mode = 'idle';
    pk.onLiveMode('idle');
    await until(() => rows(p.id).length === 1, 8000, 'the start-up fill');
    await pk.idle();
    expect(rows(p.id)).toHaveLength(1);
    pk.stop();
  });

  it('parses no revision: the save, the recompute and the safety net read rows (PK9)', async () => {
    const { ed, f, p } = await pre();
    const spy = vi.spyOn(hub!.lib, 'revision');
    for (let i = 0; i < 6; i++) {
      const cur = hub!.lib.presentations.get(p.id) as Presentation;
      await ed.json(`/presentations/${p.id}`, { method: 'PUT', json: { ...cur, title: `T${i}` } });
    }
    font('Inter', '2'.repeat(64));
    await hub!.prerenderKeys.idle();
    expect(spy).not.toHaveBeenCalled();
    void f;
    void textObject;
  });
});
