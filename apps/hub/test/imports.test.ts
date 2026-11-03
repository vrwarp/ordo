import { readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, type Playlist, type Presentation, type TextObject } from '@ordo/domain';
import { readZip, remapMediaIds } from '@ordo/importers';
import type { Job } from '@ordo/protocol';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Importers, Pro7Result } from '../src/imports.ts';
import { fixtures } from './fixtures.ts';
import { type Client, EDIT_PIN, login, song, startHub, type TestHub, tempDir } from './helpers.ts';

const fx = tempDir('ordo-fx-');

const fakePro7: Importers['importPro7'] = (files) => {
  const sid = newId();
  const pres: Presentation = {
    ...song('Imported Song'),
    sections: [{ id: sid, label: 'Verse 1', short: 'V1', slides: [] }],
    arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid] }],
    backgroundMediaId: 'pro7media:Media/bg.png',
    source: { kind: 'pro7' },
  };
  const pl: Playlist = {
    id: newId(),
    rev: 1,
    name: 'Imported Sunday',
    items: [
      { id: newId(), kind: 'presentation', presentationId: pres.id },
      { id: newId(), kind: 'media', mediaId: 'pro7media:Media/bg.png' },
      { id: newId(), kind: 'media', mediaId: 'pro7media:Media/missing.mp4' },
    ],
  };
  const r: Pro7Result = {
    presentations: [pres],
    playlists: [pl],
    media: [
      { key: 'pro7media:Media/bg.png', path: 'Media/bg.png' },
      { key: 'pro7media:Media/missing.mp4', path: 'Media/missing.mp4' },
    ],
    log: [
      { level: 'info', message: `files: ${[...files.keys()].sort().join(',')}` },
      { level: 'warn', item: 'Imported Song.pro', message: 'builds and animations are not imported' },
    ],
    protoVersion: 'test',
  };
  return r;
};

let hub: TestHub;
let ed: Client;
beforeAll(async () => {
  const dir = tempDir();
  hub = await startHub({
    dataDir: dir,
    importers: { importPro7: fakePro7, remapMediaIds, readZip, extractPptxText: (await import('@ordo/importers')).extractPptxText },
  });
  ed = await login(hub.url, EDIT_PIN);
});
afterAll(async () => {
  await hub.cleanup();
});

describe('SongSelect import', () => {
  it('imports pasted text with the default lines per slide', async () => {
    const text = `Amazing Grace\n\nVerse 1\nAmazing grace how sweet the sound\nThat saved a wretch like me\nI once was lost but now am found\nWas blind but now I see\n\nCCLI Song # 4755360\n`;
    const p = await ed.json<Presentation>('/import/songselect', { method: 'POST', json: { text } });
    expect(p.kind).toBe('song');
    expect(p.title).toBe('Amazing Grace');
    expect(p.meta.ccli).toBe('4755360');
    expect(p.source?.kind).toBe('songselect');
    expect(p.sections[0]!.slides.length).toBe(2);
    expect(p.linesPerSlide).toBe(2);
  });
  it('imports an uploaded file', async () => {
    const fd = new FormData();
    fd.append('title', 'Custom Title');
    fd.append('file', new Blob(['{title: Test}\n{c: Chorus}\n[G]Hallelujah [D]praise\nSing it out\n']), 'song.cho');
    const p = await ed.json<Presentation>('/import/songselect', { method: 'POST', body: fd });
    expect(p.title).toBe('Custom Title');
    expect(p.sections.length).toBeGreaterThan(0);
  });
  it('rejects empty text', async () => {
    expect((await ed.fetch('/import/songselect', { method: 'POST', json: { text: '   ' } })).status).toBe(400);
  });
});

describe('ProPresenter 7 import', () => {
  it('imports a zip: uploads media, remaps ids, saves presentations and playlists, keeps the log', async () => {
    const zip = new JSZip();
    zip.file('Library/Imported Song.pro', new Uint8Array([1, 2, 3]));
    zip.file('Media/bg.png', readFileSync(fixtures.png(fx)));
    const buf = await zip.generateAsync({ type: 'uint8array' });
    const fd = new FormData();
    fd.append('file', new Blob([buf]), 'library.zip');
    const res = await ed.fetch('/import/pro7', { method: 'POST', body: fd });
    expect(res.status).toBe(202);
    const job = (await res.json()) as Job;
    await hub.jobs.idle();
    const done = await ed.json<Job>(`/jobs/${job.id}`);
    expect(done.state).toBe('done');
    expect(done.result).toMatchObject({ presentations: 1, playlists: 1, media: 1, protoVersion: 'test' });
    expect(done.log.join('\n')).toMatch(/\[warn\] Imported Song\.pro: builds and animations/);
    expect(done.log.join('\n')).toMatch(/media Media\/missing\.mp4: file not in the import/);
    const media = hub.lib.media.list().find((m) => m.tags.includes('pro7'))!;
    expect(media.state).toBe('ready');
    const pres = hub.lib.presentations.list().find((p) => p.title === 'Imported Song')!;
    expect(pres.backgroundMediaId).toBe(media.id);
    const pl = hub.lib.playlists.list().find((p) => p.name === 'Imported Sunday')!;
    expect(pl.items.length).toBe(2); // unresolved media item dropped by remapMediaIds
    expect(pl.items[0]).toMatchObject({ kind: 'presentation', presentationId: pres.id });
    expect(pl.items[1]).toMatchObject({ kind: 'media', mediaId: media.id });
  });

  it('imports from a NAS folder inside the import roots only', async () => {
    const root = join(hub.dir, 'import', 'lib1');
    mkdirSync(join(root, 'Media'), { recursive: true });
    writeFileSync(join(root, 'Song.pro'), new Uint8Array([1]));
    copyFileSync(fixtures.png(fx), join(root, 'Media', 'bg.png'));
    const job = await ed.json<Job>('/import/pro7', { method: 'POST', json: { path: root } });
    await hub.jobs.idle();
    const done = await ed.json<Job>(`/jobs/${job.id}`);
    expect(done.state).toBe('done');
    // The same image content is reused rather than duplicated.
    expect(hub.lib.media.list().filter((m) => m.tags.includes('pro7')).length).toBe(1);
    expect((await ed.fetch('/import/pro7', { method: 'POST', json: { path: '/etc' } })).status).toBe(403);
  });
});

describe('documents', () => {
  it('renders a PDF into a slides presentation of 1920x1080 page images', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(fixtures.pdf(fx, 3))]), 'Notices.pdf');
    const res = await ed.fetch('/import/document', { method: 'POST', body: fd });
    expect(res.status).toBe(202);
    const job = (await res.json()) as Job;
    await hub.jobs.idle();
    const done = await ed.json<Job>(`/jobs/${job.id}`);
    expect(done.state).toBe('done');
    const pid = (done.result as { presentationId: string }).presentationId;
    const p = await ed.json<Presentation>(`/presentations/${pid}`);
    expect(p).toMatchObject({ kind: 'slides', title: 'Notices' });
    expect(p.source?.kind).toBe('pdf');
    const slides = p.sections[0]!.slides;
    expect(slides.length).toBe(3);
    expect(slides.map((s) => s.imported?.page)).toEqual([1, 2, 3]);
    const img = hub.lib.media.must(slides[0]!.imported!.imageMediaId);
    expect(img).toMatchObject({ kind: 'image', state: 'ready', width: 1920, height: 1080 });
    const { probe } = await import('../src/media/ffmpeg.ts');
    const info = await probe(hub.store.abs(img.original.path), 10_000);
    expect([info.video?.width, info.video?.height]).toEqual([1920, 1080]);
    expect((await ed.fetch(`/files/${p.source!.fileId}`)).status).toBe(200);
  });

  it('makes an imported slide editable from its text boxes', async () => {
    const img = hub.lib.media.list().find((m) => m.tags.includes('document'))!;
    const sid = newId();
    const slideId = newId();
    const p = hub.lib.savePresentation(
      {
        ...song('Deck'),
        kind: 'slides',
        sections: [
          {
            id: sid,
            label: 'Slides',
            short: 'S',
            slides: [
              {
                id: slideId,
                objects: [],
                imported: {
                  fileId: 'f',
                  page: 1,
                  imageMediaId: img.id,
                  textBoxes: [{ text: 'Welcome', box: { x: 100, y: 80, w: 800, h: 120, rotation: 0 }, fontSizePx: 72 }],
                },
              },
            ],
          },
        ],
        arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid] }],
      },
      { create: true },
    );
    const out = await ed.json<Presentation>(`/presentations/${p.id}/slides/${slideId}/make-editable`, { method: 'POST' });
    const sl = out.sections[0]!.slides[0]!;
    expect(out.rev).toBe(2);
    expect(sl.imported).toBeUndefined();
    expect(sl.objects[0]).toMatchObject({ type: 'image', mediaId: img.id, box: { x: 0, y: 0, w: 1920, h: 1080 } });
    const t = sl.objects[1] as TextObject;
    expect(t).toMatchObject({ type: 'text', text: 'Welcome', box: { x: 100, y: 80, w: 800, h: 120 } });
    expect(t.style.fontSizePx).toBe(72);
    expect(t.style.fontFamily).toBe(hub.lib.themes.get('theme-default')!.textBoxDefaults.fontFamily);
    // A second call has nothing to convert.
    expect((await ed.fetch(`/presentations/${p.id}/slides/${slideId}/make-editable`, { method: 'POST' })).status).toBe(400);
  });

  it(
    'converts a PPTX through LibreOffice and attaches extracted text',
    async () => {
      const pptx = fixtures.pptx(fx);
      if (!pptx) return; // python-pptx unavailable: nothing to generate a deck with
      const fd = new FormData();
      fd.append('file', new Blob([readFileSync(pptx)]), 'Deck.pptx');
      const job = await ed.json<Job>('/import/document', { method: 'POST', body: fd });
      await hub.jobs.idle();
      const done = await ed.json<Job>(`/jobs/${job.id}`);
      expect(done.error).toBeUndefined();
      expect(done.state).toBe('done');
      const p = await ed.json<Presentation>(`/presentations/${(done.result as { presentationId: string }).presentationId}`);
      expect(p.source?.kind).toBe('pptx');
      const slides = p.sections[0]!.slides;
      expect(slides.length).toBe(2);
      expect(slides[0]!.imported?.textBoxes?.[0]?.text).toBe('Welcome to church');
    },
    120_000,
  );
});
