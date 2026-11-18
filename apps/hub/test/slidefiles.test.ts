/**
 * Slide files on the hub (design/29 §1.3, A7): S1-S10. Pages and heads are PUT as canonical JSON, checked in the
 * CPU pool, stored as application/json files rows, and a presentation save that names a head the hub lacks
 * answers 409. The slides are made by the domain's own `withFullSlide`.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Presentation } from '@ordo/domain';
import { slideUses } from '@ordo/domain/prerender.ts';
import { SLIDE_FILE_LIMITS, slideFileName } from '@ordo/domain/slidefile.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpuPool } from '../src/pool.ts';
import { client, EDIT_PIN, login, OPERATE_PIN, startHub, type TestHub } from './helpers.ts';
import { phone, refusal } from './phones-helpers.ts';
import {
  bigSlide,
  canonicalBytes,
  fullOf,
  presentationOf,
  rect,
  textObject,
  uploadSlideFile,
} from './prerender-helpers.ts';
import { GIB } from '../src/diskfloor.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

const hex = (c: string) => c.repeat(64);

describe('PUT /files/slide/:hash, a page (S1, S2, S5)', () => {
  it('refuses a name that is not the hash of the canonical JSON, a page the schema refuses and a body over the limit (S1)', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const f = fullOf();
    const page = f.pages.pages[0]!;
    const wrong = await ed.fetch(`/files/slide/${hex('f')}`, { method: 'PUT', json: page.page });
    expect(wrong.status).toBe(400);
    expect((await refusal(wrong)).code).toBe('bad_name');
    // the schema: more than 500 objects, an unknown type, a page over 256 KiB of canonical JSON
    const many = { v: 1, objects: Array.from({ length: 501 }, (_, i) => rect(`o${i}`)) };
    const unknown = {
      v: 1,
      objects: [{ id: 'x', type: 'nope', box: { x: 0, y: 0, w: 1, h: 1, rotation: 0 } }],
    };
    const fat = {
      v: 1,
      objects: Array.from({ length: 400 }, (_, i) => textObject(`t${i}`, 'x'.repeat(700))),
    };
    for (const [what, body] of [
      ['501 objects', many],
      ['an unknown type', unknown],
      ['over 256 KiB', fat],
    ] as const) {
      const r = await ed.fetch(`/files/slide/${slideFileName(body as never)}`, { method: 'PUT', json: body });
      expect(r.status, what).toBe(400);
      expect((await refusal(r)).code, what).toBe('bad_page');
    }
    const huge = { v: 1, objects: [], pad: 'x'.repeat(300_000) };
    const r = await ed.fetch(`/files/slide/${hex('a')}`, { method: 'PUT', json: huge });
    expect(r.status).toBe(413);
  });

  it('stores a valid page as a files row of application/json, and the same page again writes nothing (S2)', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const page = fullOf().pages.pages[0]!;
    const first = await ed.fetch(`/files/slide/${page.name}`, { method: 'PUT', json: page.page });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ hash: page.name, bytes: page.bytes });
    const row = hub.lib.getFile(page.name)!;
    expect(row).toMatchObject({ hash: page.name, mime: 'application/json', bytes: page.bytes });
    expect(row.path).toBe(`media/${page.name.slice(0, 2)}/${page.name}.json`);
    const abs = join(hub.dir, row.path);
    expect(existsSync(abs)).toBe(true);
    const mtime = statSync(abs).mtimeMs;
    const files = (hub.db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n;
    const again = await ed.fetch(`/files/slide/${page.name}`, { method: 'PUT', json: page.page });
    expect(again.status).toBe(200);
    expect(statSync(abs).mtimeMs).toBe(mtime);
    expect((hub.db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n).toBe(files);
    // GET /files/<hash> serves it like any file
    const get = await ed.fetch(`/files/${page.name}`);
    expect(get.status).toBe(200);
    expect(Buffer.from(await get.arrayBuffer()).equals(canonicalBytes(page.page))).toBe(true);
  });

  it('does the check in the CPU pool: one completed task per check (S5)', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const f = fullOf();
    const before = cpuPool().stats().completed;
    await ed.fetch(`/files/slide/${f.pages.pages[0]!.name}`, { method: 'PUT', json: f.pages.pages[0]!.page });
    expect(cpuPool().stats().completed).toBe(before + 1);
    await ed.fetch(`/files/slide/${f.name}`, { method: 'PUT', json: f.pages.head });
    expect(cpuPool().stats().completed).toBe(before + 2);
  });
});

describe('PUT /files/slide/:hash, a head (S3, S4)', () => {
  it('answers 409 with the first 20 pages the hub lacks (S3)', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const head = {
      v: 1,
      pages: Array.from({ length: 25 }, (_, i) => i.toString(16).padStart(64, '0')),
      count: 100,
    };
    const r = await ed.fetch(`/files/slide/${slideFileName(head as never)}`, { method: 'PUT', json: head });
    expect(r.status).toBe(409);
    const err = await refusal(r);
    expect(err.code).toBe('pages_missing');
    expect(err.missing).toEqual(head.pages.slice(0, 20));
  });

  it('refuses pages out of order, a count that does not add up, and 16 MiB of pages (S3)', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const f = fullOf(bigSlide('two', 600));
    expect(f.pages.pages.length).toBeGreaterThanOrEqual(2);
    for (const p of f.pages.pages) await ed.fetch(`/files/slide/${p.name}`, { method: 'PUT', json: p.page });
    const swapped = { ...f.pages.head, pages: [...f.pages.head.pages].reverse() };
    const off = { ...f.pages.head, count: f.pages.head.count + 1 };
    for (const [what, head] of [
      ['out of order', swapped],
      ['count', off],
    ] as const) {
      const r = await ed.fetch(`/files/slide/${slideFileName(head as never)}`, { method: 'PUT', json: head });
      expect(r.status, what).toBe(400);
      expect((await refusal(r)).code, what).toBe('bad_head');
    }
    // 16 MiB: sixty files rows of 300,000 bytes (never read: the check sums their sizes first)
    const names = Array.from({ length: 60 }, (_, i) => `${(i + 1).toString(16).padStart(2, '0')}`.repeat(32));
    for (const h of names)
      hub.lib.addFile({
        hash: h,
        bytes: 300_000,
        mime: 'application/json',
        path: `media/${h.slice(0, 2)}/${h}.json`,
      });
    expect(60 * 300_000).toBeGreaterThan(SLIDE_FILE_LIMITS.bytes);
    const big = { v: 1, pages: names, count: 100 };
    const r = await ed.fetch(`/files/slide/${slideFileName(big as never)}`, { method: 'PUT', json: big });
    expect(r.status).toBe(413);
    expect((await refusal(r)).code).toBe('slide_too_large');
  });

  it('stores a valid head with its record: bytes of head and pages, objects, uses and the pages in order (S4)', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const slide = bigSlide('rich', 600);
    slide.objects.push(
      {
        id: 'photo',
        type: 'image',
        box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
        mediaId: 'media-photo',
        fit: 'contain',
        opacity: 1,
        radius: 0,
      } as never,
      textObject('serif', 'Hi', undefined, { style: { fontFamily: 'Carlito' } as never }),
    );
    const f = fullOf(slide);
    for (const p of f.pages.pages) await ed.fetch(`/files/slide/${p.name}`, { method: 'PUT', json: p.page });
    const r = await ed.fetch(`/files/slide/${f.name}`, { method: 'PUT', json: f.pages.head });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ hash: f.name, bytes: f.pages.bytes, count: f.pages.head.count });
    const row = hub.db.prepare(`SELECT bytes, objects, uses FROM slide_heads WHERE hash = ?`).get(f.name) as {
      bytes: number;
      objects: number;
      uses: string;
    };
    expect(row.bytes).toBe(f.pages.bytes);
    expect(row.objects).toBe(f.pages.head.count);
    expect(JSON.parse(row.uses)).toEqual(slideUses(f.full));
    expect(JSON.parse(row.uses).media).toContain('media-photo');
    const pages = hub.db
      .prepare(`SELECT page FROM slide_head_pages WHERE head = ? ORDER BY pos`)
      .all(f.name) as { page: string }[];
    expect(pages.map((p) => p.page)).toEqual(f.pages.head.pages);
    expect(hub.lib.getFile(f.name)).toMatchObject({ mime: 'application/json' });
    expect((await ed.fetch(`/files/slide/${f.name}`, { method: 'PUT', json: f.pages.head })).status).toBe(
      200,
    );
  });
});

describe('who may PUT a slide file (S6)', () => {
  it('refuses a phone and a view session 403 cap and no session 401; an edit session passes', async () => {
    hub = await startHub();
    const f = fullOf();
    const page = f.pages.pages[0]!;
    const put = (c: ReturnType<typeof client>, name: string, json: unknown) =>
      c.fetch(`/files/slide/${name}`, { method: 'PUT', json });
    for (const c of [await phone(hub.url), await phone(hub.url, EDIT_PIN, 'view')]) {
      for (const [name, body] of [
        [page.name, page.page],
        [f.name, f.pages.head],
      ] as const) {
        const r = await put(c, name, body);
        expect(r.status).toBe(403);
        expect((await refusal(r)).code).toBe('cap');
      }
    }
    expect((await put(client(hub.url), page.name, page.page)).status).toBe(401);
    expect((await put(await login(hub.url, EDIT_PIN), page.name, page.page)).status).toBe(201);
    expect((await put(await login(hub.url, OPERATE_PIN), page.name, page.page)).status).toBe(200);
  });

  it('is refused 507 below the floor, before the body is read', async () => {
    const free = { n: GIB };
    hub = await startHub({
      statfs: async () => ({
        bsize: 4096,
        bavail: Math.floor(free.n / 4096),
        blocks: Math.floor((100 * GIB) / 4096),
      }),
    });
    const ed = await login(hub.url, EDIT_PIN);
    const page = fullOf().pages.pages[0]!;
    const r = await ed.fetch(`/files/slide/${page.name}`, { method: 'PUT', json: page.page });
    expect(r.status).toBe(507);
    expect((await refusal(r)).reason).toBe('disk');
  });
});

describe('the save check (S7, S8, S9, S10)', () => {
  async function seeded() {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const f = fullOf();
    return { ed, f };
  }

  it('answers 409 slide_files_missing naming the first 20 refs, and saves once the head is there (S7)', async () => {
    const { ed, f } = await seeded();
    const stand = f.standIn;
    const p = presentationOf([stand]);
    const r = await ed.fetch('/presentations', { method: 'POST', json: p });
    expect(r.status).toBe(409);
    const err = await refusal(r);
    expect(err.code).toBe('slide_files_missing');
    expect(err.refs).toEqual([f.name]);
    // twenty-five slides, each its own missing head: the first 20 are named
    const many = Array.from({ length: 25 }, (_, i) => {
      const s = bigSlide(`m${i}`, 250, `n${i}`);
      return fullOf(s).standIn;
    });
    const r25 = await ed.fetch('/presentations', { method: 'POST', json: presentationOf(many) });
    expect(((await refusal(r25)).refs as string[]).length).toBe(20);
    // the head row without its files row does not count either
    await uploadSlideFile(ed, f.pages);
    hub!.lib.deleteFileRow(f.name);
    expect((await ed.fetch('/presentations', { method: 'POST', json: p })).status).toBe(409);
    await uploadSlideFile(ed, f.pages);
    const ok = await ed.fetch('/presentations', { method: 'POST', json: p });
    expect(ok.status).toBe(201);
  });

  it("rewrites the slide's uses and file.bytes from the hub's record, and saving again changes nothing but the rev (S7)", async () => {
    const { ed, f } = await seeded();
    await uploadSlideFile(ed, f.pages);
    const forged = {
      ...f.standIn,
      prerender: {
        ...f.standIn.prerender!,
        uses: { media: ['forged'], files: [], fonts: [] },
        file: { ref: f.name, bytes: 1 },
      },
    };
    const created = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([forged]),
    });
    const stored = created.sections[0]!.slides[0]!;
    expect(stored.prerender?.file).toEqual({ ref: f.name, bytes: f.pages.bytes });
    expect(stored.prerender?.uses).toEqual(slideUses(f.full));
    const again = await ed.json<Presentation>(`/presentations/${created.id}`, {
      method: 'PUT',
      json: created,
    });
    expect(again.rev).toBe(created.rev + 1);
    expect(again.sections).toEqual(created.sections);
    // the same on restore
    const restored = await ed.json<Presentation>(`/presentations/${created.id}/restore/${created.rev}`, {
      method: 'POST',
    });
    expect(restored.sections[0]!.slides[0]!.prerender?.uses).toEqual(slideUses(f.full));
    // and a restore of a revision whose head is gone refuses
    hub!.lib.deleteFileRow(f.name);
    const gone = await ed.fetch(`/presentations/${created.id}/restore/${created.rev}`, { method: 'POST' });
    expect(gone.status).toBe(409);
  });

  it('checks inside Library.savePresentation, so a writer that calls it directly is refused too (S8)', async () => {
    const { f } = await seeded();
    const p = presentationOf([f.standIn]);
    const save = () => hub!.lib.savePresentation({ ...p, rev: 1 }, { create: true });
    expect(save).toThrowError(expect.objectContaining({ status: 409, code: 'slide_files_missing' }));
    expect(hub!.lib.presentations.get(p.id)).toBeUndefined();
  });

  it("refuses a capped session a change of a slide's prerender record or Draw as, and lets the rest through (S9)", async () => {
    const { ed, f } = await seeded();
    await uploadSlideFile(ed, f.pages);
    const created = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([f.standIn]),
    });
    const ph = await phone(hub!.url);
    const put = (body: Presentation) =>
      ph.fetch(`/presentations/${created.id}`, { method: 'PUT', json: body });
    const slide = created.sections[0]!.slides[0]!;
    const swap = (s: typeof slide): Presentation => ({
      ...created,
      sections: [{ ...created.sections[0]!, slides: [s] }],
    });
    for (const [what, s] of [
      ['draw', { ...slide, draw: 'picture' as const }],
      ['live', { ...slide, prerender: { ...slide.prerender!, live: [...slide.prerender!.live, 'extra'] } }],
      ['record dropped', (({ prerender: _p, ...rest }) => rest)(slide)],
    ] as const) {
      const r = await put(swap(s as typeof slide));
      expect(r.status, what).toBe(403);
      const err = await refusal(r);
      expect(err, what).toMatchObject({ code: 'cap', field: 'prerender' });
    }
    const ok = await put({ ...created, title: 'Renamed by a phone' });
    expect(ok.status).toBe(200);
    // a phone adding a plain slide is not affected
    const plain = { id: 'plain1', objects: [] };
    const added = await ph.fetch(`/presentations/${((await ok.json()) as Presentation).id}`, {
      method: 'PUT',
      json: {
        ...(await ed.json<Presentation>(`/presentations/${created.id}`)),
        sections: [{ ...created.sections[0]!, slides: [slide, plain] }],
      },
    });
    expect(added.status).toBe(200);
  });

  it('pays nothing for a library with no pre-rendered slide: no slide_heads lookup runs (S10)', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const have = vi.spyOn(hub.lib.slideFiles, 'have');
    const exists = vi.spyOn(hub.lib.slideFiles, 'head');
    const p = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([bigSlide('plain', 5)]),
    });
    await ed.json(`/presentations/${p.id}`, { method: 'PUT', json: { ...p, title: 'edited' } });
    expect(have).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });
});
