/**
 * The Q54 data-safety items of the hub's store (store-2 step 3b, SU2-SU6): a slide file may now be a slide of up to
 * 20,000 objects (import-files writes one for a slide over 1,000 shapes), so what the head row, the record, the
 * collector, the keys job and the goLive manifest do with its many names must be right BEFORE one is written.
 * Synthetic slides only (no deck): a slide with 1,357 distinct shape files and one with 1,100 distinct pictures.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_LYRIC_STYLE, type Presentation, type Slide, stillFile } from '@ordo/domain';
import { canonicalJson } from '@ordo/domain/palette.ts';
import { pictureSource, prerenderKey, standbyId } from '@ordo/domain/prerender.ts';
import { PRERENDER_LIMITS } from '@ordo/domain/schemas.ts';
import { HEAD_USES_MAX, slideUsesAll } from '@ordo/domain/slidefile.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { cpuPool, type CpuPool } from '../src/pool.ts';
import { KEYS_PAGES_BYTES_MAX, PrerenderKeys } from '../src/prerenderkeys.ts';
import { goLiveExtras } from '../src/prerenders.ts';
import { SlideFiles } from '../src/slidefiles.ts';
import { slideFileTask } from '../src/slidetasks.ts';
import { EDIT_PIN, login, startHub, type TestHub } from './helpers.ts';
import {
  bigSlide,
  canonicalBytes,
  fullOf,
  pictureInputs,
  presentationOf,
  rect,
  textObject,
  uploadSlideFile,
} from './prerender-helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

const hex = (n: number) => n.toString(16).padStart(64, '0');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const box = { x: 0, y: 0, w: 10, h: 10, rotation: 0 };

/** A crowded slide naming `n` distinct shape files (one outline each). */
function shapeFileSlide(n: number, id = 'files'): Slide {
  const s = bigSlide(id, 0, 'f');
  for (let i = 0; i < n; i++) s.objects.push(rect(`o${i}`, box, { geom: { ref: hex(i + 1) } } as never));
  return s;
}
/** A crowded slide of `n` distinct pictures, each its own media item. */
function pictureSlide(n: number, id = 'pics'): Slide {
  const s = bigSlide(id, 0, 'p');
  for (let i = 0; i < n; i++)
    s.objects.push({
      id: `img${i}`,
      type: 'image',
      box,
      mediaId: `m${i}`,
      fit: 'contain',
      opacity: 1,
      radius: 0,
    } as never);
  return s;
}
const addMedia = (h: TestHub, id: string, file: string) =>
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

/** A hub with the slide's file uploaded and its presentation saved; the head's name is `f.name`. */
async function save(slide: Slide, files: Record<string, string> = {}) {
  hub = await startHub();
  for (const [id, file] of Object.entries(files)) addMedia(hub, id, file);
  const ed = await login(hub.url, EDIT_PIN);
  const f = fullOf(slide, pictureInputs(files));
  await uploadSlideFile(ed, f.pages);
  const p = await ed.json<Presentation>('/presentations', {
    method: 'POST',
    json: presentationOf([f.standIn]),
  });
  return { hub, ed, f, p };
}

describe('the head row keeps the full lists (SU2)', () => {
  it('records all 1,357 shape files of a slide that names them, not the first 1,000', async () => {
    const { hub: h, f } = await save(shapeFileSlide(1357));
    const row = h.lib.slideFiles.head(f.name)!;
    expect(row.uses.files).toHaveLength(1357);
    expect(new Set(row.uses.files).size).toBe(1357);
    // the same through the writer inside the hub (an import): another slide of the same size
    const g = fullOf(shapeFileSlide(1358, 'again'));
    await new SlideFiles(h.lib, h.store, () => cpuPool()).storeFile(g.pages);
    expect(h.lib.slideFiles.head(g.name)!.uses.files).toHaveLength(1358);
  });

  it('records every picture and every font family too', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1100; i++) files[`m${i}`] = sha(`img${i}`);
    const { hub: h, f } = await save(pictureSlide(1100), files);
    expect(h.lib.slideFiles.head(f.name)!.uses.media).toHaveLength(1100);
  });

  it('refuses a head that names more of anything than HEAD_USES_MAX, with a named reason, and never cuts', () => {
    // 2,100 text boxes, each in a family of its own: more families than the head row keeps (2,048)
    const s = bigSlide('fonts', 0, 'x');
    for (let i = 0; i < 2100; i++)
      s.objects.push(
        textObject(`t${i}`, 'x', undefined, { style: { ...DEFAULT_LYRIC_STYLE, fontFamily: `Family ${i}` } }),
      );
    expect(slideUsesAll(s).fonts.length).toBeGreaterThan(HEAD_USES_MAX.fonts);
    const f = fullOf(s);
    for (const p of f.pages.pages)
      expect(slideFileTask({ kind: 'page', name: p.name, body: p.page }).ok).toBe(true);
    const out = slideFileTask({
      kind: 'head',
      name: f.name,
      body: f.pages.head,
      pages: f.pages.pages.map((p) => canonicalBytes(p.page)),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(413);
      expect(out.code).toBe('slide_uses_too_many');
      expect(out.message).toMatch(/font/);
    }
  });
});

describe('the writer inside the hub refuses a head with too many names and writes nothing (SU2)', () => {
  it('storeFile answers 413 slide_uses_too_many before any file is written', async () => {
    hub = await startHub();
    const s = bigSlide('fonts', 0, 'x');
    for (let i = 0; i < 2100; i++)
      s.objects.push(
        textObject(`t${i}`, 'x', undefined, { style: { ...DEFAULT_LYRIC_STYLE, fontFamily: `Family ${i}` } }),
      );
    const f = fullOf(s);
    const files = (hub.db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n;
    await expect(
      new SlideFiles(hub.lib, hub.store, () => cpuPool()).storeFile(f.pages),
    ).rejects.toMatchObject({ status: 413, code: 'slide_uses_too_many' });
    expect((hub.db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n).toBe(files);
    expect(hub.lib.slideFiles.head(f.name)).toBeUndefined();
  });
});

describe('the record is sliced to PRERENDER_LIMITS (SU3)', () => {
  it('a saved presentation keeps its record when the head row names more than the record may', async () => {
    const { hub: h, f, p } = await save(shapeFileSlide(1357));
    expect(h.lib.slideFiles.head(f.name)!.uses.files).toHaveLength(1357);
    const back = h.lib.presentations.must(p.id) as Presentation;
    const rec = back.sections[0]!.slides[0]!.prerender;
    expect(rec, 'the record is not dropped').toBeDefined();
    expect(rec!.uses!.files).toHaveLength(PRERENDER_LIMITS.files);
    expect(rec!.uses!.files).toEqual(
      h.lib.slideFiles.head(f.name)!.uses.files.slice(0, PRERENDER_LIMITS.files),
    );
    expect(rec!.file!.ref).toBe(f.name);
  });
});

describe('the collector names every shape file of a big slide (SU4)', () => {
  it('referenced() is true for each of 1,357 shape files named only inside a file-form slide, so delete mode would keep all', async () => {
    const { hub: h, f } = await save(shapeFileSlide(1357));
    let named = 0;
    for (const ref of h.lib.slideFiles.head(f.name)!.uses.files) if (h.lib.refs.referenced(ref)) named++;
    expect(named).toBe(1357);
    // a name nothing holds is still unnamed
    expect(h.lib.refs.referenced(hex(9999999))).toBe(false);
  });
});

describe('the keys job reads the full lists and batches its pages (SU5)', () => {
  const inputsOf = (h: TestHub) => ({
    fonts: h.lib.listFonts().map((x) => ({ family: x.family, file: { hash: x.file.hash } })),
    mediaFile: (id: string) => {
      const m = h.lib.media.get(id);
      return m ? stillFile(m)?.hash : undefined;
    },
  });
  const expected = (h: TestHub, full: Slide, live: readonly string[]) => {
    const src = pictureSource(full, live, inputsOf(h));
    return { key: prerenderKey(src), standbyId: standbyId(src) };
  };

  it('a picture past the 1,000th is part of the key, and changing its file makes another key and sig', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1100; i++) files[`m${i}`] = sha(`img${i}`);
    const { hub: h, f, p } = await save(pictureSlide(1100), files);
    const row = h.lib.prerenderIndex.keysAt(p.id, p.rev)[0]!;
    const want = expected(h, f.full, f.standIn.prerender!.live);
    expect(row.key).toBe(want.key);
    expect(row.standbyId).toBe(want.standbyId);
    // the 1,050th picture's file changes: another key, another sig (a stale picture would otherwise be kept)
    addMedia(h, 'm1050', sha('img1050-replaced'));
    const keys = new PrerenderKeys(h.lib, h.store, () => cpuPool(), { live: () => 'idle', log: h.log });
    const [again] = await keys.keysFor(h.lib.presentations.must(p.id) as Presentation);
    expect(again!.key).not.toBe(row.key);
    expect(again!.sig).not.toBe(row.sig);
    expect(again!.key).toBe(expected(h, f.full, f.standIn.prerender!.live).key);
  });

  it('sends the pages of the changed slides to the pool in batches of at most KEYS_PAGES_BYTES_MAX, one slide at a time beyond it', async () => {
    expect(KEYS_PAGES_BYTES_MAX).toBe(32 * 1024 * 1024);
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const a = fullOf(bigSlide('a', 300, 'a'));
    const b = fullOf(bigSlide('b', 300, 'b'));
    await uploadSlideFile(ed, a.pages);
    await uploadSlideFile(ed, b.pages);
    const bytes = (f: typeof a) =>
      f.pages.pages.reduce((n, p) => n + Buffer.byteLength(canonicalJson(p.page)), 0) +
      Buffer.byteLength(canonicalJson(f.pages.head));
    const both = bytes(a) + bytes(b);
    const p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([a.standIn, b.standIn]),
    });
    hub.db.prepare(`DELETE FROM prerender_keys`).run();
    const count = () => {
      let n = 0;
      let slides = 0;
      const pool = (): Pick<CpuPool, 'run'> => ({
        run: ((task: string, input: { slides: unknown[] }) => {
          if (task === 'prerender-keys') {
            n++;
            slides += input.slides.length;
          }
          return cpuPool().run(task as never, input as never);
        }) as CpuPool['run'],
      });
      return { pool, tasks: () => n, slides: () => slides };
    };
    const whole = count();
    const one = await new PrerenderKeys(hub.lib, hub.store, whole.pool, {
      live: () => 'idle',
      log: hub.log,
    }).keysFor(hub.lib.presentations.must(p.id) as Presentation);
    expect([whole.tasks(), whole.slides(), one.length]).toEqual([1, 2, 2]);
    // a cap that two slides together pass but each alone does not: two tasks, both slides keyed, the same keys
    const split = count();
    const two = await new PrerenderKeys(hub.lib, hub.store, split.pool, {
      live: () => 'idle',
      log: hub.log,
      pagesBytesMax: Math.max(bytes(a), bytes(b)) + 1,
    }).keysFor(hub.lib.presentations.must(p.id) as Presentation);
    expect(both).toBeGreaterThan(Math.max(bytes(a), bytes(b)) + 1);
    expect([split.tasks(), split.slides(), two.length]).toEqual([2, 2, 2]);
    expect(two.map((r) => r.key).sort()).toEqual(one.map((r) => r.key).sort());
    expect(new Set(two.map((r) => r.key))).toEqual(new Set([a.key, b.key]));
  });
});

describe('the goLive manifest lists no slide pages while GOLIVE_SLIDE_PAGES is false (SU6)', () => {
  it('goLiveExtras lists the head and its shape files, names the pages in slideHeads, and lists the pages only when asked', async () => {
    const few = bigSlide('few', 260, 'f');
    for (let i = 0; i < 40; i++) few.objects.push(rect(`o${i}`, box, { geom: { ref: hex(i + 1) } } as never));
    const { hub: h, f, p } = await save(few);
    for (const hash of h.lib.slideFiles.head(f.name)!.uses.files)
      h.lib.addFile({
        hash,
        bytes: 10,
        mime: 'application/json',
        path: `media/${hash.slice(0, 2)}/${hash}.json`,
      });
    const pres = { [p.id]: h.lib.presentations.must(p.id) };
    const today = goLiveExtras(h.lib, pres);
    const pages = f.pages.head.pages;
    expect(Object.keys(today.files)).toContain(f.name);
    for (const page of pages) expect(Object.keys(today.files), page).not.toContain(page);
    for (const used of h.lib.slideFiles.head(f.name)!.uses.files)
      expect(Object.keys(today.files)).toContain(used);
    expect(today.slideHeads).toEqual({ [f.name]: { pages } });
    // the old behaviour, behind the option (the constant's other side)
    const old = goLiveExtras(h.lib, pres, { pages: true });
    for (const page of pages) expect(Object.keys(old.files), page).toContain(page);
  });
});
