import { readFileSync } from 'node:fs';
import { copyFileSync, mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, type Playlist, type Presentation, slideContent, type TextObject } from '@ordo/domain';
import { readZip, remapMediaIds } from '@ordo/importers';
import type { Job } from '@ordo/protocol';
import JSZip from 'jszip';
import pptxgen from 'pptxgenjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { annotatePptx } from '@ordo/pptx-render';
import { annotatePptxInWorker, type Importers, MAX_INLINE_BYTES, type Pro7Result } from '../src/imports.ts';
import { fixtures } from './fixtures.ts';
import { type Client, EDIT_PIN, login, song, startHub, type TestHub, tempDir } from './helpers.ts';
import { findChromium } from '../../../tools/find-chromium.ts';

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
    // No browser here: a pptx-preview import must fall back to LibreOffice.
    chromium: { path: join(dir, 'no-such-chromium'), sandbox: false },
    importers: {
      importPro7: fakePro7,
      remapMediaIds,
      readZip,
      extractPptxText: (await import('@ordo/importers')).extractPptxText,
    },
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
    fd.append(
      'file',
      new Blob(['{title: Test}\n{c: Chorus}\n[G]Hallelujah [D]praise\nSing it out\n']),
      'song.cho',
    );
    const p = await ed.json<Presentation>('/import/songselect', { method: 'POST', body: fd });
    expect(p.title).toBe('Custom Title');
    expect(p.sections.length).toBeGreaterThan(0);
  });
  it('rejects empty text', async () => {
    expect((await ed.fetch('/import/songselect', { method: 'POST', json: { text: '   ' } })).status).toBe(
      400,
    );
  });
});

describe('ProPresenter 7 import', () => {
  it('imports a zip: uploads media, remaps ids, saves presentations and playlists, keeps the log', async () => {
    const zip = new JSZip();
    zip.file('Library/Imported Song.pro', new Uint8Array([1, 2, 3]));
    zip.file('Media/bg.png', readFileSync(fixtures.png(fx)));
    const buf = await zip.generateAsync({ type: 'uint8array' });
    const fd = new FormData();
    fd.append('file', new Blob([buf as Uint8Array<ArrayBuffer>]), 'library.zip');
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

  it('imports an individual .pro file upload', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'Single Song.pro');
    const res = await ed.fetch('/import/pro7', { method: 'POST', body: fd });
    expect(res.status).toBe(202);
    const job = (await res.json()) as Job;
    await hub.jobs.idle();
    const done = await ed.json<Job>(`/jobs/${job.id}`);
    expect(done.state).toBe('done');
    expect(done.result).toMatchObject({
      presentations: 1,
      playlists: 1,
      presentationId: expect.any(String),
      protoVersion: 'test',
    });
  });

  it('imports an individual .pro file from a NAS path with the media in its folder', async () => {
    const filePath = join(hub.dir, 'import', 'lib1', 'Song.pro');
    // Another document beside it is not imported; a dot folder is not looked into.
    writeFileSync(join(hub.dir, 'import', 'lib1', 'Other.pro'), new Uint8Array([2]));
    mkdirSync(join(hub.dir, 'import', 'lib1', '.cache'), { recursive: true });
    writeFileSync(join(hub.dir, 'import', 'lib1', '.cache', 'thumb.png'), new Uint8Array([3]));
    const job = await ed.json<Job>('/import/pro7', { method: 'POST', json: { path: filePath } });
    await hub.jobs.idle();
    const done = await ed.json<Job>(`/jobs/${job.id}`);
    expect(done.state).toBe('done');
    expect(done.result).toMatchObject({
      presentations: 1,
      presentationId: expect.any(String),
      // Media/bg.png, from the document's folder ("Media found alongside is uploaded").
      media: 1,
    });
    const log = done.log.join('\n');
    expect(log).toContain('files: Media/bg.png,Song.pro');
    expect(log).not.toMatch(/media Media\/bg\.png: file not in the import/);
  });

  it('takes only ProPresenter files from a NAS path, and a document only within the in-memory size', async () => {
    const dir = join(hub.dir, 'import', 'lib2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'not a ProPresenter file');
    const txt = await ed.fetch('/import/pro7', { method: 'POST', json: { path: join(dir, 'notes.txt') } });
    expect(txt.status).toBe(415);
    // A document past MAX_INLINE_BYTES (sparse: nothing is written) is refused before it is read.
    const big = join(dir, 'Huge.pro');
    writeFileSync(big, new Uint8Array([1]));
    truncateSync(big, MAX_INLINE_BYTES + 1);
    const res = await ed.fetch('/import/pro7', { method: 'POST', json: { path: big } });
    expect(res.status).toBe(413);
    expect(await res.text()).toMatch(/Huge\.pro is larger than 64 MB \(65 MB\)/);
  });

  it('refuses a single document past the in-memory size when its job runs (stat before readFile)', async () => {
    // A file that grew after it was queued (or an upload the route did not check): the job stats it first.
    const big = join(tempDir('ordo-pro7-big-'), 'Grown.pro');
    writeFileSync(big, new Uint8Array([1]));
    truncateSync(big, MAX_INLINE_BYTES + 1);
    const job = hub.imports.queuePro7FromUpload(big, 'Grown.pro');
    await hub.jobs.idle();
    const done = await ed.json<Job>(`/jobs/${job.id}`);
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/Grown\.pro is larger than 64 MB \(65 MB\)/);
  });

  it('refuses an uploaded document past the in-memory size before queueing it', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(MAX_INLINE_BYTES + 1)]), 'Huge Song.pro');
    const res = await ed.fetch('/import/pro7', { method: 'POST', body: fd });
    expect(res.status).toBe(413);
  });

  it('rejects unsupported file uploads', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['not a propresenter file']), 'notes.txt');
    const res = await ed.fetch('/import/pro7', { method: 'POST', body: fd });
    expect(res.status).toBe(415);
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
                  textBoxes: [
                    { text: 'Welcome', box: { x: 100, y: 80, w: 800, h: 120, rotation: 0 }, fontSizePx: 72 },
                  ],
                },
              },
            ],
          },
        ],
        arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid] }],
      },
      { create: true },
    );
    const out = await ed.json<Presentation>(`/presentations/${p.id}/slides/${slideId}/make-editable`, {
      method: 'POST',
    });
    const sl = out.sections[0]!.slides[0]!;
    expect(out.rev).toBe(2);
    expect(sl.imported).toBeUndefined();
    expect(sl.objects[0]).toMatchObject({
      type: 'image',
      mediaId: img.id,
      box: { x: 0, y: 0, w: 1920, h: 1080 },
    });
    const t = sl.objects[1] as TextObject;
    expect(t).toMatchObject({ type: 'text', text: 'Welcome', box: { x: 100, y: 80, w: 800, h: 120 } });
    expect(t.style.fontSizePx).toBe(72);
    expect(t.style.fontFamily).toBe(hub.lib.themes.get('theme-default')!.textBoxDefaults.fontFamily);
    // A second call has nothing to convert.
    expect(
      (await ed.fetch(`/presentations/${p.id}/slides/${slideId}/make-editable`, { method: 'POST' })).status,
    ).toBe(400);
    // Not a PowerPoint slide: the objects are the operator's (no origin).
    expect(sl.objects.every((o) => o.origin === undefined)).toBe(true);

    // A native PowerPoint picture-class slide: the objects are the import's, so 'Show PowerPoint picture'
    // leaves them out (design/27 §5) and a re-import can tell them from the operator's.
    const pptxSlideId = newId();
    const q = hub.lib.savePresentation(
      {
        ...song('Deck 2'),
        kind: 'slides',
        sections: [
          {
            id: sid,
            label: 'Slides',
            short: 'S',
            slides: [
              {
                id: pptxSlideId,
                objects: [],
                pptx: { fileId: 'f', index: 0, shown: 0, class: 'picture', version: 2 },
                imported: {
                  fileId: 'f',
                  page: 1,
                  imageMediaId: img.id,
                  textBoxes: [{ text: 'Hello', box: { x: 10, y: 10, w: 100, h: 50, rotation: 0 } }],
                },
              },
            ],
          },
        ],
        arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid] }],
      },
      { create: true },
    );
    const edited = await ed.json<Presentation>(`/presentations/${q.id}/slides/${pptxSlideId}/make-editable`, {
      method: 'POST',
    });
    const ps = edited.sections[0]!.slides[0]!;
    expect(ps.objects.map((o) => o.origin)).toEqual([
      { src: 'pptx', role: 'bg' },
      { src: 'pptx', role: 'text' },
    ]);
    const shown = slideContent({ ...ps, pptx: { ...ps.pptx!, refMediaId: img.id, show: 'picture' } });
    expect(shown.objects).toEqual([]);
  });

  it('converts a PPTX through LibreOffice and attaches extracted text', async () => {
    const pptx = fixtures.pptx(fx);
    if (!pptx) return; // python-pptx unavailable: nothing to generate a deck with
    const fd = new FormData();
    // 'Pictures (LibreOffice)': the route's default is the native import (design/27 §2).
    fd.append('renderer', 'libreoffice');
    fd.append('file', new Blob([readFileSync(pptx)]), 'Deck.pptx');
    const job = await ed.json<Job>('/import/document', { method: 'POST', body: fd });
    await hub.jobs.idle();
    const done = await ed.json<Job>(`/jobs/${job.id}`);
    expect(done.error).toBeUndefined();
    expect(done.state).toBe('done');
    const p = await ed.json<Presentation>(
      `/presentations/${(done.result as { presentationId: string }).presentationId}`,
    );
    expect(p.source?.kind).toBe('pptx');
    const slides = p.sections[0]!.slides;
    expect(slides.length).toBe(2);
    expect(slides[0]!.imported?.textBoxes?.[0]?.text).toBe('Welcome to church');
  }, 120_000);
});

/** A two-slide deck written by pptxgenjs (which also exercises the content-type repair). */
async function pptxgenDeck(dir: string): Promise<string> {
  const p = new pptxgen();
  p.layout = 'LAYOUT_16x9';
  p.addSlide().addText('Welcome to church', { x: 1, y: 1, w: 8, h: 1, fontSize: 40, fontFace: 'Tahoma' });
  p.addSlide().addText(
    [{ text: '18', options: { superscript: true } }, { text: ' For God so loved the world' }],
    {
      x: 1,
      y: 1,
      w: 8,
      h: 1,
      fontSize: 32,
    },
  );
  const out = join(dir, 'pptxgen.pptx');
  writeFileSync(out, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
  return out;
}

async function importDeck(c: Client, file: string, renderer?: string): Promise<Job> {
  const fd = new FormData();
  if (renderer) fd.append('renderer', renderer);
  fd.append('file', new Blob([readFileSync(file)]), 'Sermon.pptx');
  return c.json<Job>('/import/document', { method: 'POST', body: fd });
}

describe('PowerPoint renderers', () => {
  it('refuses an unknown renderer', async () => {
    const fd = new FormData();
    fd.append('renderer', 'keynote');
    fd.append('file', new Blob([readFileSync(await pptxgenDeck(tempDir()))]), 'x.pptx');
    expect((await ed.fetch('/import/document', { method: 'POST', body: fd })).status).toBe(400);
  });

  it('falls back to LibreOffice when pptx-preview cannot run, and says so', async () => {
    const job = await importDeck(ed, await pptxgenDeck(tempDir()), 'pptx-preview');
    await hub.jobs.idle();
    const done = await ed.json<Job>(`/jobs/${job.id}`);
    expect(done.error).toBeUndefined();
    expect(done.state).toBe('done');
    expect(done.log.join('\n')).toMatch(
      /pptx-preview failed \(Chromium not found.*\); rendering with LibreOffice instead/,
    );
    const p = await ed.json<Presentation>(
      `/presentations/${(done.result as { presentationId: string }).presentationId}`,
    );
    expect(p.source).toMatchObject({ kind: 'pptx', renderer: 'libreoffice' });
    expect(p.sections[0]!.slides).toHaveLength(2);
  }, 120_000);
});

describe('pptx-preview annotation on the CPU pool', () => {
  it('annotates a deck on a worker thread as it would on the main thread', async () => {
    const buf = new Uint8Array(readFileSync(await pptxgenDeck(tempDir())));
    const inline = await annotatePptx(buf);
    const pooled = await annotatePptxInWorker(buf);
    expect(inline.runs.length).toBeGreaterThanOrEqual(3);
    const { bytes: _a, ...rest } = pooled;
    const { bytes: _b, ...want } = inline;
    expect(rest).toEqual(want);
    // The repaired deck comes back too (pptxgenjs lists a slide master per slide).
    expect(pooled.notes.join('\n')).toMatch(/Content_Types.*removed/);
    expect(
      await (await JSZip.loadAsync(pooled.bytes)).file('ppt/slides/slide1.xml')!.async('string'),
    ).toContain('\u2064');
  });

  it('stops a cancelled annotation', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(annotatePptxInWorker(new Uint8Array(8), ctrl.signal)).rejects.toThrow('cancelled');
  });
});

const chromiumExe = await findChromium();

describe.skipIf(!chromiumExe)('pptx-preview import (headless Chromium)', () => {
  let h2: TestHub;
  let c2: Client;
  beforeAll(async () => {
    h2 = await startHub({ dataDir: tempDir(), chromium: { path: chromiumExe!, sandbox: false } });
    c2 = await login(h2.url, EDIT_PIN);
  });
  afterAll(() => h2.cleanup());

  it('draws each slide with pptx-preview into a 1920x1080 picture and records the renderer', async () => {
    const job = await importDeck(c2, await pptxgenDeck(tempDir()), 'pptx-preview');
    await h2.jobs.idle();
    const done = await c2.json<Job>(`/jobs/${job.id}`);
    expect(done.error).toBeUndefined();
    expect(done.state).toBe('done');
    expect(done.log.join('\n')).toMatch(/2 slide\(s\) drawn, \d+ text run\(s\) corrected/);
    const p = await c2.json<Presentation>(
      `/presentations/${(done.result as { presentationId: string }).presentationId}`,
    );
    expect(p.source).toMatchObject({ kind: 'pptx', renderer: 'pptx-preview' });
    const slides = p.sections[0]!.slides;
    expect(slides).toHaveLength(2);
    const img = h2.lib.media.must(slides[0]!.imported!.imageMediaId);
    expect(img).toMatchObject({ kind: 'image', state: 'ready', width: 1920, height: 1080 });
    // The text is still extracted for "make editable", whichever renderer drew the picture.
    expect(slides[0]!.imported?.textBoxes?.[0]?.text).toBe('Welcome to church');
  }, 120_000);
});
