/**
 * The goLive bundle, the in-process source and the live process serving slide files and pictures (design/29 §1.3,
 * §1.7): GL1-GL5. A bundle names a pre-rendered slide's head, pages, shape files and pictures, and the keys and
 * picture rows of each presentation; a bundle without them still prepares.
 */
import { type Presentation, type ResolvedPlaylist, degradedKind, newId } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareGoLive } from '../src/golive-worker.ts';
import { HEADER_INTERNAL } from '../src/http.ts';
import { EDIT_PIN, login, OPERATE_PIN, startHub, type TestHub } from './helpers.ts';
import { twoProcesses, type TwoProcesses } from './phones-helpers.ts';
import { bigSlide, fullOf, makePng, presentationOf, rect, uploadSlideFile } from './prerender-helpers.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const SHAPE_FILE = 'e'.repeat(64);

let hub: TestHub | undefined;
let tp: TwoProcesses | undefined;
afterEach(async () => {
  await hub?.cleanup();
  await tp?.close();
  hub = tp = undefined;
});

type Bundle = {
  files?: Record<string, { hash: string; bytes: number; mime: string; path: string }>;
  slideHeads?: Record<string, { pages: string[] }>;
  prerenderKeys?: Record<string, string[]>;
  prerenders?: Record<
    string,
    { slideId: string; key: string; size: number; file: { hash: string }; standby?: boolean }[]
  >;
  [k: string]: unknown;
};

/** A slide with a shape that names a geometry file, so the head's `uses.files` is not empty. */
function slideWithShapeFile() {
  const s = bigSlide('geo', 260, 'geo');
  s.objects.push(
    rect('outline', { x: 0, y: 0, w: 50, h: 50, rotation: 0 }, { geom: { ref: SHAPE_FILE } } as never),
  );
  return s;
}

type Api = Awaited<ReturnType<typeof login>>;
type Seeded = {
  ed: Api;
  p: Presentation;
  f: ReturnType<typeof fullOf>;
  key: string;
  playlistId: string;
  pictures: { 3840: string; 1920: string; 640: string };
};

/** A presentation with a pre-rendered slide, its shape file, three pictures and a playlist, through any base. */
async function seed(base: string, addFile: (hash: string) => void): Promise<Seeded> {
  const ed = await login(base, EDIT_PIN);
  addFile(SHAPE_FILE);
  const f = fullOf(slideWithShapeFile());
  await uploadSlideFile(ed, f.pages);
  const p = await ed.json<Presentation>('/presentations', {
    method: 'POST',
    json: presentationOf([f.standIn]),
  });
  const put = async (size: 3840 | 1920 | 640, w: number, h: number) => {
    const body = makePng(w, h, { seed: size });
    const r = await ed.fetch(`/presentations/${p.id}/prerenders/${f.key}?size=${size}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array(body),
    });
    if (r.status !== 201) throw new Error(`picture ${size}: ${r.status} ${await r.text()}`);
    return ((await r.json()) as { hash: string }).hash;
  };
  const pictures = {
    3840: await put(3840, 3840, 2160),
    1920: await put(1920, 1920, 1080),
    640: await put(640, 640, 360),
  };
  const pl = await ed.json<{ id: string }>('/playlists', {
    method: 'POST',
    json: { name: 'Sunday', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
  });
  return { ed, p, f, key: f.key, playlistId: pl.id, pictures };
}

async function bundleOf(t: TwoProcesses, playlistId: string): Promise<Bundle> {
  const r = await fetch(`${t.lib.url}/internal/golive/${playlistId}`, {
    headers: { [HEADER_INTERNAL]: 'test-secret' },
  });
  expect(r.status).toBe(200);
  return (await r.json()) as Bundle;
}

describe('the library process bundle (GL1, GL2, GL3)', () => {
  it('lists the head, its pages, the shape file and the pictures, and the keys and rows of each presentation (GL1)', async () => {
    tp = await twoProcesses();
    const s = await seed(tp.base, (h) =>
      tp!.lib.lib.addFile({
        hash: h,
        bytes: 40,
        mime: 'application/json',
        path: `media/${h.slice(0, 2)}/${h}.json`,
      }),
    );
    const b = await bundleOf(tp, s.playlistId);
    const files = Object.keys(b.files ?? {});
    for (const h of [s.f.name, ...s.f.pages.head.pages, SHAPE_FILE, s.pictures[3840], s.pictures[1920]])
      expect(files, h).toContain(h);
    expect(files).not.toContain(s.pictures[640]);
    expect(b.files![s.f.name]).toMatchObject({ hash: s.f.name, mime: 'application/json' });
    expect(b.slideHeads).toEqual({ [s.f.name]: { pages: s.f.pages.head.pages } });
    expect(b.prerenderKeys).toEqual({ [s.p.id]: [s.key] });
    expect(b.prerenders![s.p.id]!.map((r) => [r.slideId, r.key, r.size, r.file.hash]).sort()).toEqual(
      [
        ['big', s.key, 1920, s.pictures[1920]],
        ['big', s.key, 3840, s.pictures[3840]],
      ].sort(),
    );
    // a presentation with no record adds nothing: the bundle has none of the new fields
    const ed = await login(tp.base, EDIT_PIN);
    const plain = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([bigSlide('p', 5)], 'Plain'),
    });
    const pl = await ed.json<{ id: string }>('/playlists', {
      method: 'POST',
      json: { name: 'Plain', items: [{ id: newId(), kind: 'presentation', presentationId: plain.id }] },
    });
    const none = await bundleOf(tp, pl.id);
    for (const k of ['slideHeads', 'prerenders', 'prerenderKeys'])
      expect(Object.keys(none), k).not.toContain(k);
  });

  it('prepares into a copy whose geoms list the head, pages and pictures, and says a missing page (GL2)', async () => {
    tp = await twoProcesses();
    const s = await seed(tp.base, (h) =>
      tp!.lib.lib.addFile({
        hash: h,
        bytes: 40,
        mime: 'application/json',
        path: `media/${h.slice(0, 2)}/${h}.json`,
      }),
    );
    const b = await bundleOf(tp, s.playlistId);
    const out = prepareGoLive({
      playlistId: s.playlistId,
      bundle: enc.encode(JSON.stringify(b)),
      takenAt: 1,
    });
    if (!out.ok) throw new Error(out.reason);
    const r = JSON.parse(dec.decode(out.buffer)) as ResolvedPlaylist;
    const listed = (r.geoms ?? []).map((g) => g.hash);
    for (const h of [s.f.name, ...s.f.pages.head.pages, s.pictures[3840], s.pictures[1920]])
      expect(listed, h).toContain(h);
    expect(r.prerenderKeys).toEqual([s.key]);
    expect(r.prerenders?.map((p) => [p.slideId, p.key, p.size, p.file]).sort()).toEqual(
      [
        ['big', s.key, 1920, s.pictures[1920]],
        ['big', s.key, 3840, s.pictures[3840]],
      ].sort(),
    );
    expect((r.degraded ?? []).filter((d) => degradedKind(d.reason) === 'slideFile')).toEqual([]);
    // a page the hub does not list: the slide's full copy is missing (the list, never the words)
    const damaged: Bundle = { ...b, files: { ...b.files } };
    delete damaged.files![s.f.pages.head.pages[0]!];
    const bad = prepareGoLive({
      playlistId: s.playlistId,
      bundle: enc.encode(JSON.stringify(damaged)),
      takenAt: 1,
    });
    if (!bad.ok) throw new Error(bad.reason);
    const br = JSON.parse(dec.decode(bad.buffer)) as ResolvedPlaylist;
    expect((br.degraded ?? []).some((d) => degradedKind(d.reason) === 'slideFile')).toBe(true);
  });

  it('marks a stand-by picture standby, lists none of an unrelated key, and keeps the newest per slide and size (GL3)', async () => {
    tp = await twoProcesses();
    const s = await seed(tp.base, (h) =>
      tp!.lib.lib.addFile({
        hash: h,
        bytes: 40,
        mime: 'application/json',
        path: `media/${h.slice(0, 2)}/${h}.json`,
      }),
    );
    const db = tp.lib.db;
    const cur = db.prepare(`SELECT standby_id FROM prerender_keys WHERE presentation_id = ?`).get(s.p.id) as {
      standby_id: string;
    };
    // the current key's pictures are removed, so the slide has none of its own: a stand-by serves
    db.prepare(`DELETE FROM prerenders WHERE presentation_id = ?`).run(s.p.id);
    const file = (n: string) => {
      const hash = n.repeat(64);
      tp!.lib.lib.addFile({ hash, bytes: 9, mime: 'image/png', path: `media/${n}${n}/${hash}.png` });
      return hash;
    };
    const ins = db.prepare(
      `INSERT INTO prerenders (presentation_id, key, size, slide_id, standby_id, version, kind, hash, mime, bytes, w, h, opaque, made_by, made_role, last_rev, created_at)
       VALUES (?, ?, ?, 'big', ?, 1, 'slide', ?, 'image/png', 9, 3840, 2160, 1, NULL, 'edit', 1, ?)`,
    );
    ins.run(s.p.id, '1'.repeat(64), 3840, cur.standby_id, file('1'), 100);
    ins.run(s.p.id, '2'.repeat(64), 3840, cur.standby_id, file('2'), 200); // newer stand-by of the same slide and size
    ins.run(s.p.id, '3'.repeat(64), 3840, 'f'.repeat(64), file('3'), 300); // neither current nor a stand-by
    const b = await bundleOf(tp, s.playlistId);
    expect(b.prerenders![s.p.id]).toMatchObject([
      { slideId: 'big', key: '2'.repeat(64), size: 3840, standby: true },
    ]);
    expect(Object.keys(b.files!)).toContain(file('2'));
    expect(Object.keys(b.files!)).not.toContain(file('3'));
    // the current key's own picture beats any stand-by
    ins.run(s.p.id, s.key, 3840, cur.standby_id, file('4'), 50);
    const c = await bundleOf(tp, s.playlistId);
    expect(c.prerenders![s.p.id]).toMatchObject([{ key: s.key, size: 3840 }]);
    expect(c.prerenders![s.p.id]![0]!.standby).toBeUndefined();
  });
});

describe('the in-process source (GL5)', () => {
  it('supplies the same three inputs from the library, so a test hub and the live process agree', async () => {
    hub = await startHub();
    const s = await seed(hub.url, (h) =>
      hub!.lib.addFile({
        hash: h,
        bytes: 40,
        mime: 'application/json',
        path: `media/${h.slice(0, 2)}/${h}.json`,
      }),
    );
    const op = await login(hub.url, OPERATE_PIN);
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: s.playlistId } });
    const st = await op.json<{ state: { resolved: ResolvedPlaylist } }>('/live');
    const r = st.state.resolved;
    const listed = (r.geoms ?? []).map((g) => g.hash);
    for (const h of [s.f.name, ...s.f.pages.head.pages, s.pictures[3840], s.pictures[1920]])
      expect(listed, h).toContain(h);
    expect(listed).not.toContain(s.pictures[640]);
    expect(r.prerenderKeys).toEqual([s.key]);
    expect(r.prerenders).toHaveLength(2);
  });
});
