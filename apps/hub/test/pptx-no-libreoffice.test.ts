/**
 * A hub without LibreOffice (design/27 M9 "LibreOffice optional"; lo-dependencies §4.4-4.10): the native
 * import, the refusals, PowerPoint's own PDF as the reference pictures, a follow-up left from when LibreOffice
 * was there, the re-import, the capabilities and the OOXML family. The hub runs with `ORDO_LIBREOFFICE=off`, so
 * it behaves the same on any machine, and a soffice that only records it ran is first on the PATH: it must never
 * run. The PDF cases need poppler-utils (pdftoppm, pdfinfo) and skip without them.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DEFAULT_GENERAL,
  DEFAULT_LOOKS,
  localDigest,
  missingSlideReason,
  type Presentation,
  resolvePlaylist,
  type Slide,
} from '@ordo/domain';
import type { HubCapabilities, Job } from '@ordo/protocol';
import {
  body,
  buildDeck,
  CHART_CONTENT_TYPE,
  chartFrame,
  chartXml,
  imageRel,
  para,
  partText,
  pic,
  run,
  sp,
  withPart,
} from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type JobCtx, MAX_JOB_ATTEMPTS } from '../src/jobs.ts';
import { loJob, type PptxLoWithoutResult, releaseReferencePdf } from '../src/pptx/fallback.ts';
import { tooLarge } from '../src/store.ts';
import type { PptxLoPayload, PptxNativeResult } from '../src/pptx/shared.ts';
import { findOnPath } from '../src/tools.ts';
import { minimalPdf } from './fixtures.ts';
import { EDIT_PIN, login, startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, waitJob } from './pptx-helpers.ts';

const IN = 914_400;
const enc = new TextEncoder();
const PDF_TOOLS = !!findOnPath('pdftoppm') && !!findOnPath('pdfinfo');
const MAIN = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';

let hub: TestHub;
let dir: string;
let marker: string;
let path: string | undefined;

beforeAll(async () => {
  dir = tempDir('ordo-no-lo-');
  // A soffice that only records it ran, first on the PATH.
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  marker = join(dir, 'soffice-ran');
  for (const name of ['soffice', 'libreoffice']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" >> '${marker}'\necho 'LibreOffice 7.4.7.2'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  // ORDO_LIBREOFFICE=off; poppler-utils detected for real.
  hub = await startHub({ libreoffice: { mode: 'off', exe: '' }, toolProbe: undefined });
}, 60_000);
afterAll(async () => {
  await hub?.cleanup();
  process.env.PATH = path;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The fake soffice never ran. */
const neverRan = () => expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');

const textBox = (id: number, text: string, y = 1) =>
  sp({ id, x: IN, y: y * IN, cx: 6 * IN, cy: IN, txBody: body(para(run(text))) });

/** The start of an EMF (its header record): a metafile picture the hub cannot draw without LibreOffice. */
function emf(): Uint8Array {
  const b = Buffer.alloc(108);
  b.writeUInt32LE(1, 0);
  b.writeUInt32LE(108, 4);
  b.writeInt32LE(100, 16);
  b.writeInt32LE(50, 20);
  b.writeUInt32LE(0x464d4520, 40);
  b.writeUInt32LE(0x10000, 44);
  b.writeUInt32LE(108, 48);
  b.writeUInt32LE(1, 52);
  return b;
}

/**
 * Four slides, three shown: a title, a chart (residual: nothing draws it here), a hidden slide, and a
 * metafile picture with its caption.
 */
function serviceDeck(title = 'Welcome'): Map<string, Uint8Array> {
  const parts = buildDeck({
    slides: [
      { shapes: textBox(2, title) },
      {
        rels: [{ id: 'rId3', type: 'chart', target: '../charts/chart1.xml' }],
        shapes:
          textBox(2, 'Giving this year') +
          chartFrame({ id: 4, x: 5 * IN, y: 2 * IN, cx: 4 * IN, cy: 3 * IN, rId: 'rId3' }),
      },
      { hidden: true, shapes: textBox(2, 'For the team only') },
      {
        rels: [imageRel('rId2', 'logo.emf')],
        shapes:
          pic({ id: 3, x: IN, y: 2 * IN, cx: 4 * IN, cy: 2 * IN, rId: 'rId2' }) + textBox(4, 'Our logo', 5),
      },
    ],
    media: { 'ppt/media/logo.emf': emf() },
  });
  return withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE) as Map<string, Uint8Array>;
}

/** A deck's zip; `store` names parts written uncompressed (STORE). */
async function zipOf(parts: Map<string, Uint8Array>, store: string[] = []): Promise<Buffer> {
  const z = new JSZip();
  for (const [k, v] of parts) z.file(k, v, store.includes(k) ? { compression: 'STORE' } : {});
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Upload through `POST /import/document`; the response. */
async function upload(file: Uint8Array, name: string, fields: Record<string, string> = {}) {
  const ed = await login(hub.url, EDIT_PIN);
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([new Uint8Array(file)]), name);
  return ed.fetch('/import/document', { method: 'POST', body: fd });
}

/** Import a deck through the route as the import screen sends it; the job, its result and the presentation. */
async function importDeck(
  parts: Map<string, Uint8Array>,
  name = 'Sunday.pptx',
): Promise<{ job: Job; result: PptxNativeResult; p: Presentation }> {
  const res = await upload(await zipOf(parts), name);
  expect(res.status, await res.clone().text()).toBe(202);
  const queued = (await res.json()) as Job;
  expect(queued.kind).toBe('pptx-native');
  const job = await waitJob(hub, queued.id, 120_000);
  expect(job.state, `${job.error}\n${job.log.join('\n')}`).toBe('done');
  const result = job.result as PptxNativeResult;
  return { job, result, p: hub.lib.presentations.must(result.presentationId) };
}

const followUps = (h: TestHub, presentationId?: string) =>
  (h.lib.db.prepare(`SELECT payload FROM jobs WHERE kind = 'pptx-lo'`).all() as { payload: string }[]).filter(
    (r) => !presentationId || (JSON.parse(r.payload) as PptxLoPayload).presentationId === presentationId,
  );

const uploadsLeft = () => readdirSync(join(hub.dir, 'uploads'));

describe('a hub without LibreOffice (design/27 M9)', () => {
  it('a native import queues no pptx-lo and leaves no slide pending', async () => {
    const { job, result, p } = await importDeck(serviceDeck());
    expect(result).toMatchObject({ slides: 4, pending: 0, libreoffice: false, missing: 2 });
    expect(result.loJobId).toBeUndefined();
    expect(followUps(hub)).toHaveLength(0);
    const slides = slidesOf(p);
    for (const s of slides) expect(s.pptx?.pending).toBeUndefined();
    expect(slides.map((s) => s.pptx?.class)).toEqual(['native', 'hybrid', 'native', 'hybrid']);
    expect(job.log.some((l) => /this hub has no LibreOffice/.test(l))).toBe(true);
    expect(job.log.some((l) => /waiting for LibreOffice/.test(l))).toBe(false);
    // The metafile is listed, never set aside for a conversion that will not come; its caption stays.
    const [, , , logo] = slides as [Slide, Slide, Slide, Slide];
    expect(logo.pptx!.missing).toEqual(['metafile']);
    expect(logo.objects.some((o) => o.type === 'text' && o.text === 'Our logo')).toBe(true);
    neverRan();
  }, 120_000);

  it('a residual slide is hybrid with missing kinds and goes live with the missing reason', async () => {
    const { p } = await importDeck(serviceDeck(), 'Giving.pptx');
    const [, chart, , logo] = slidesOf(p) as [Slide, Slide, Slide, Slide];
    // No art object: the chart is listed as missing, its slide keeps the rest.
    expect(chart.pptx).toMatchObject({ class: 'hybrid', missing: ['chart'] });
    expect(chart.pptx!.pending).toBeUndefined();
    expect(chart.objects.some((o) => o.type === 'image' && o.origin?.role === 'art')).toBe(false);
    expect(chart.objects.some((o) => o.type === 'text' && o.text === 'Giving this year')).toBe(true);
    // The note: the converter's own (told there is no LibreOffice), worded as the hub's for a converter that
    // still planned the art.
    expect(chart.pptx!.notes?.some((n) => /^not drawn: a chart$/.test(n))).toBe(true);
    const r = resolvePlaylist(
      {
        playlist: {
          id: 'pl',
          rev: 1,
          name: 'Sunday',
          items: [{ id: 'i', kind: 'presentation', presentationId: p.id }],
        },
        presentation: (id) => hub.lib.presentations.get(id),
        media: (id) => hub.lib.media.get(id),
        fonts: () => [],
        looks: DEFAULT_LOOKS,
        general: DEFAULT_GENERAL,
      },
      'pl',
      { digest: localDigest },
    );
    const reasons = (r.degraded ?? []).map((d) => d.reason);
    expect(reasons).toContain(missingSlideReason(['chart']));
    expect(reasons).toContain(missingSlideReason(['metafile']));
    expect(missingSlideReason(['chart'])).toBe(
      'PowerPoint slide with something ordo cannot draw (a chart): it is left out',
    );
    expect(logo.pptx!.class).toBe('hybrid');
    neverRan();
  }, 120_000);

  it('renderer=libreoffice is refused with 501 libreoffice_unavailable and the upload is removed', async () => {
    const bytes = await zipOf(serviceDeck('Pictures, please'));
    const res = await upload(bytes, 'Pictures.pptx', { renderer: 'libreoffice' });
    expect(res.status).toBe(501);
    const e = (await res.json()) as { error: { code: string; message: string } };
    expect(e.error.code).toBe('libreoffice_unavailable');
    expect(e.error.message).toMatch(/no LibreOffice, so PowerPoint files are imported as editable slides/);
    expect(uploadsLeft()).toEqual([]);
    expect(hub.lib.getFile(createHash('sha256').update(bytes).digest('hex'))).toBeUndefined();
    // A picture import queued before LibreOffice went away fails in words, never with a tool's output.
    const stored = await hub.store.putBytes(bytes, { ext: 'pptx', mime: 'application/zip' });
    const job = await waitJob(
      hub,
      hub.imports.queueDocument(stored.hash, 'Old.pptx', 'pptx', 'libreoffice').id,
    );
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/^This hub has no LibreOffice/);
    neverRan();
  });

  it('pptx-reference without a PDF is refused with 501', async () => {
    const { p } = await importDeck(serviceDeck(), 'Reference.pptx');
    const ed = await login(hub.url, EDIT_PIN);
    const res = await ed.fetch(`/presentations/${p.id}/pptx-reference`, {
      method: 'POST',
      json: { showPicture: [] },
    });
    expect(res.status).toBe(501);
    const e = (await res.json()) as { error: { code: string; message: string } };
    expect(e.error).toEqual({
      code: 'libreoffice_unavailable',
      message: 'This hub has no LibreOffice. Add a PDF exported from PowerPoint instead.',
    });
    // A reference job queued before LibreOffice went away fails with the same words.
    const job = await waitJob(hub, hub.imports.pptx.queueReference(p.id, p.source!.fileId!, 'test', []).id);
    expect(job.state).toBe('failed');
    expect(job.error).toBe('This hub has no LibreOffice. Add a PDF exported from PowerPoint instead.');
    neverRan();
  }, 120_000);

  /** Send `pdf` as the presentation's reference pictures; the job when it ends. */
  async function referencePdf(p: Presentation, pdf: Buffer, showPicture?: string[]): Promise<Job> {
    const ed = await login(hub.url, EDIT_PIN);
    const fd = new FormData();
    if (showPicture) fd.append('showPicture', JSON.stringify(showPicture));
    fd.append('file', new Blob([new Uint8Array(pdf)]), 'Deck.pdf');
    const res = await ed.fetch(`/presentations/${p.id}/pptx-reference`, { method: 'POST', body: fd });
    expect(res.status, await res.clone().text()).toBe(202);
    const queued = (await res.json()) as Job & { payload?: unknown };
    expect(queued.kind).toBe('pptx-reference');
    return waitJob(hub, queued.id, 120_000);
  }

  it.skipIf(!PDF_TOOLS)(
    'a PDF export of the deck becomes the reference pictures',
    async () => {
      const { p } = await importDeck(serviceDeck(), 'Exported.pptx');
      // PowerPoint's default export: one page per shown slide (3 of 4).
      const shownPdf = minimalPdf(3);
      const job = await referencePdf(p, shownPdf, []);
      expect(job.state, `${job.error}\n${job.log.join('\n')}`).toBe('done');
      expect(job.result).toMatchObject({ pictures: 3, slides: 0 });
      const after = slidesOf(hub.lib.presentations.must(p.id));
      const refs = after.map((s) => s.pptx?.refMediaId);
      expect(refs.filter(Boolean)).toHaveLength(3);
      expect(refs[2]).toBeUndefined();
      for (const s of after) expect(s.pptx?.show).toBeUndefined();
      const m = hub.lib.media.get(refs[0]!)!;
      expect(m).toMatchObject({ kind: 'image', state: 'ready', width: 3840, height: 2160, tags: ['pptx'] });
      // Each page is its slide: the first page under the first slide, the third under the fourth.
      expect(m.name).toMatch(/– 1 \(PowerPoint PDF\)$/);
      expect(hub.lib.media.get(refs[3]!)!.name).toMatch(/– 3 \(PowerPoint PDF\)$/);
      // The PDF itself is not kept.
      expect(hub.lib.getFile(createHash('sha256').update(shownPdf).digest('hex'))).toBeUndefined();
      expect(uploadsLeft()).toEqual([]);

      // 'Print hidden slides': one page per listed slide, so the hidden slide gets its picture too, and every
      // slide switches to it when no list is given.
      const { p: p2 } = await importDeck(serviceDeck(), 'Exported again.pptx');
      const all = await referencePdf(p2, minimalPdf(4));
      expect(all.state, all.error).toBe('done');
      const after2 = slidesOf(hub.lib.presentations.must(p2.id));
      expect(after2.every((s) => !!s.pptx?.refMediaId && s.pptx.show === 'picture')).toBe(true);
      neverRan();
    },
    180_000,
  );

  it.skipIf(!PDF_TOOLS)(
    'a PDF whose page count matches neither the shown nor the listed slides fails with both counts',
    async () => {
      const { p } = await importDeck(serviceDeck(), 'Mismatch.pptx');
      const five = minimalPdf(5);
      const job = await referencePdf(p, five, []);
      expect(job.state).toBe('failed');
      expect(job.error).toBe(
        'The PDF has 5 pages; the presentation shows 3 slides (4 with hidden ones). Export it from PowerPoint again.',
      );
      expect(hub.lib.getFile(createHash('sha256').update(five).digest('hex'))).toBeUndefined();
      // Pages not shaped like the slides (4:3 pages for a 16:9 deck: notes pages, handouts) fail too. The
      // MediaBox has the same length, so the PDF's offsets stay right.
      const narrow = Buffer.from(minimalPdf(3).toString('latin1').replaceAll('960 540', '720 540'), 'latin1');
      const bad = await referencePdf(p, narrow, []);
      expect(bad.state).toBe('failed');
      expect(bad.error).toMatch(/^Page 1 of the PDF is not shaped like the slides \(720 x 540 pt\)/);
      expect(slidesOf(hub.lib.presentations.must(p.id)).every((s) => !s.pptx?.refMediaId)).toBe(true);
      // Not a PDF at all: refused, nothing kept.
      const ed = await login(hub.url, EDIT_PIN);
      const fd = new FormData();
      fd.append('file', new Blob([new Uint8Array(enc.encode('hello'))]), 'Deck.pdf');
      const res = await ed.fetch(`/presentations/${p.id}/pptx-reference`, { method: 'POST', body: fd });
      expect(res.status).toBe(415);
      expect(uploadsLeft()).toEqual([]);
      neverRan();
    },
    180_000,
  );

  it.skipIf(!PDF_TOOLS)(
    'a PDF given to two presentations is kept until both reference jobs used it, then released (M9 wave 1 repair)',
    async () => {
      const { p: a } = await importDeck(serviceDeck(), 'Shared A.pptx');
      const { p: b } = await importDeck(serviceDeck('Hello'), 'Shared B.pptx');
      const pdf = minimalPdf(3);
      const hash = createHash('sha256').update(pdf).digest('hex');
      // Both queued at once: the second is queued while the first runs (one heavy job at a time).
      const [ja, jb] = await Promise.all([referencePdf(a, pdf, []), referencePdf(b, pdf, [])]);
      expect(ja.state, ja.error).toBe('done');
      expect(jb.state, jb.error).toBe('done');
      for (const p of [a, b])
        expect(slidesOf(hub.lib.presentations.must(p.id)).filter((s) => s.pptx?.refMediaId)).toHaveLength(3);
      // Released once the last job that names it is done.
      expect(hub.lib.getFile(hash)).toBeUndefined();
      expect(uploadsLeft()).toEqual([]);
      neverRan();
    },
    180_000,
  );

  it('a reference PDF is released by a job given up after repeated crashes, never while another job names it', async () => {
    const pdf = minimalPdf(2);
    const ref = await hub.store.putBytes(pdf, { ext: 'pdf', mime: 'application/pdf' });
    expect(hub.lib.getFile(ref.hash)).toBeDefined();
    const now = new Date().toISOString();
    const row = (id: string, state: string) =>
      hub.lib.db
        .prepare(
          `INSERT INTO jobs (id, kind, class, state, progress, payload, log, created_at, updated_at) VALUES (?, 'pptx-reference', 'heavy', ?, 0, ?, '[]', ?, ?)`,
        )
        .run(
          id,
          state,
          JSON.stringify({ presentationId: 'gone', hash: 'f'.repeat(64), pdf: ref.hash }),
          now,
          now,
        );
    // Another queued job names it: kept (the check runs before anything waits).
    const other = `other-${Math.random().toString(36).slice(2)}`;
    row(other, 'queued');
    await releaseReferencePdf(hub.imports.pptx.deps, ref.hash, 'self');
    expect(hub.lib.getFile(ref.hash)).toBeDefined();
    hub.lib.db.prepare(`UPDATE jobs SET state = 'failed' WHERE id = ?`).run(other);
    // A job left running by repeated crashes is given up at the next start: its PDF goes with it.
    const crashed = `crashed-${Math.random().toString(36).slice(2)}`;
    row(crashed, 'running');
    hub.lib.db
      .prepare('INSERT INTO job_attempts (job_id, attempts) VALUES (?, ?)')
      .run(crashed, MAX_JOB_ATTEMPTS);
    await hub.jobs.idle();
    hub.jobs.start(); // the sweep a restart runs
    expect(hub.jobs.get(crashed).state).toBe('failed');
    await expect.poll(() => hub.lib.getFile(ref.hash), { timeout: 5_000 }).toBeUndefined();
  }, 60_000);

  it("an upload past a route's own limit is refused in that limit's words", async () => {
    expect(tooLarge(256 * 1024 * 1024).message).toBe('File exceeds the 256 MB upload limit');
    expect(tooLarge().message).toBe('File exceeds the 4 GB upload limit');
    const e = await hub.store.receive(Readable.from([Buffer.alloc(3_000)]), 2_048).catch((x: unknown) => x);
    expect(e).toMatchObject({
      status: 413,
      code: 'too_large',
      message: 'File exceeds the 2 KB upload limit',
    });
    expect(uploadsLeft()).toEqual([]);
  });

  it('a pptx-lo job queued before LibreOffice went away clears pending and re-imports the unedited slides', async () => {
    // The same hub as when LibreOffice was there (its follow-ups held: no heavy job runs), then it goes.
    const fake = join(dir, 'bin', 'soffice');
    const h = await startHub({
      libreoffice: { mode: 'auto', exe: fake },
      toolProbe: () => ({ state: 'available' }),
      jobs: { heavy: 0, light: 2 },
    });
    try {
      const ed = await login(h.url, EDIT_PIN);
      const fd = new FormData();
      fd.append('file', new Blob([new Uint8Array(await zipOf(serviceDeck()))]), 'Before.pptx');
      const queued = await ed.json<Job>('/import/document', { method: 'POST', body: fd });
      const job = await waitJob(h, queued.id, 120_000);
      expect(job.state, job.error).toBe('done');
      const result = job.result as PptxNativeResult;
      expect(result).toMatchObject({ pending: 2, libreoffice: true, missing: 0 });
      const lo = h.jobs.get(result.loJobId!);
      expect(lo.state).toBe('queued');
      const payload = JSON.parse(
        (h.lib.db.prepare('SELECT payload FROM jobs WHERE id = ?').get(lo.id) as { payload: string }).payload,
      ) as PptxLoPayload;
      // The plan records what each slide lacks if LibreOffice never draws it.
      expect(payload.slides.map((s) => s.kinds)).toEqual([['chart'], ['metafile']]);
      // An edit of the metafile slide's caption meanwhile.
      const p0 = h.lib.presentations.must(result.presentationId);
      const edited: Presentation = {
        ...p0,
        sections: p0.sections.map((sec) => ({
          ...sec,
          slides: sec.slides.map((sl) =>
            sl.pptx?.index === 3
              ? {
                  ...sl,
                  objects: sl.objects.map((o) => (o.type === 'text' ? { ...o, text: 'Our new logo' } : o)),
                }
              : sl,
          ),
        })),
      };
      h.lib.savePresentation(edited, { expectedRev: p0.rev, by: 'editor' });
      // LibreOffice is gone (the lite image); the follow-up runs.
      h.imports.tools.markMissing('libreoffice', 'soffice: spawn soffice ENOENT');
      const deps = h.imports.pptx.deps;
      const logs: string[] = [];
      const ctx: JobCtx<PptxLoPayload> = {
        id: lo.id,
        payload,
        signal: new AbortController().signal,
        log: (m) => logs.push(m),
        progress: () => undefined,
        setPayload: (pl) => {
          ctx.payload = pl;
        },
      };
      const out = (await loJob(deps, {
        reimport: (id, hash, slideIds) => h.imports.pptx.queueReimport(id, hash, { slideIds }, 'pptx-lo'),
      })(ctx)) as PptxLoWithoutResult;
      expect(out).toMatchObject({ withoutLibreOffice: true, cleared: 2 });
      expect(logs.join('\n')).toMatch(/2 slide\(s\) no longer wait for it; ordo redraws the unedited ones/);
      const mid = slidesOf(h.lib.presentations.must(p0.id));
      for (const s of mid) expect(s.pptx?.pending).toBeUndefined();
      expect(mid[1]!.pptx!.missing).toEqual(['chart']);
      expect(mid[3]!.pptx!.missing).toEqual(['metafile']);
      // The re-import redraws the unedited chart slide with this converter; the edited one is kept.
      const re = await waitJob(h, out.reimportJobId!, 120_000);
      expect(re.state, re.error).toBe('done');
      expect(re.result).toMatchObject({ regenerated: 1, keptEdited: 1 });
      const after = slidesOf(h.lib.presentations.must(p0.id));
      expect(after[1]!.pptx).toMatchObject({ class: 'hybrid', missing: ['chart'] });
      expect(after[1]!.pptx!.pending).toBeUndefined();
      expect(after[3]!.objects.some((o) => o.type === 'text' && o.text === 'Our new logo')).toBe(true);
      expect(after[3]!.pptx!.missing).toEqual(['metafile']);
      expect(after.every((s) => !s.pptx?.pending)).toBe(true);
      // Nothing new waits for LibreOffice, and it never ran.
      expect(followUps(h, p0.id)).toHaveLength(1);
      neverRan();
    } finally {
      await h.cleanup();
    }
  }, 180_000);

  it("a follow-up without LibreOffice keeps a slide's first notes, and a slide that lacks nothing is native (M9 wave 1 repair)", async () => {
    const fake = join(dir, 'bin', 'soffice');
    const h = await startHub({
      libreoffice: { mode: 'auto', exe: fake },
      toolProbe: () => ({ state: 'available' }),
      jobs: { heavy: 0, light: 2 },
    });
    try {
      const ed = await login(h.url, EDIT_PIN);
      const fd = new FormData();
      fd.append('file', new Blob([new Uint8Array(await zipOf(serviceDeck()))]), 'Notes.pptx');
      const queued = await ed.json<Job>('/import/document', { method: 'POST', body: fd });
      const result = (await waitJob(h, queued.id, 120_000)).result as PptxNativeResult;
      const lo = h.jobs.get(result.loJobId!);
      const payload = JSON.parse(
        (h.lib.db.prepare('SELECT payload FROM jobs WHERE id = ?').get(lo.id) as { payload: string }).payload,
      ) as PptxLoPayload;
      // The chart slide already holds the schema's 16 notes; the metafile slide's plan recorded that it
      // lacks nothing without LibreOffice (an art that only improves on version 1: flat 3-D past the budget).
      const p0 = h.lib.presentations.must(result.presentationId);
      const notes = Array.from({ length: 16 }, (_, i) => `note ${i + 1}`);
      h.lib.savePresentation(
        {
          ...p0,
          sections: p0.sections.map((sec) => ({
            ...sec,
            slides: sec.slides.map((sl) =>
              sl.pptx?.index === 1 ? { ...sl, pptx: { ...sl.pptx, notes } } : sl,
            ),
          })),
        },
        { expectedRev: p0.rev, by: 'editor' },
      );
      const metafileSlide = payload.slides.find((x) => x.index === 3)!;
      metafileSlide.kinds = [];
      h.imports.tools.markMissing('libreoffice', 'soffice: spawn soffice ENOENT');
      const ctx: JobCtx<PptxLoPayload> = {
        id: lo.id,
        payload,
        signal: new AbortController().signal,
        log: () => undefined,
        progress: () => undefined,
        setPayload: (pl) => {
          ctx.payload = pl;
        },
      };
      const out = (await loJob(h.imports.pptx.deps)(ctx)) as PptxLoWithoutResult;
      expect(out.cleared).toBe(2);
      const after = slidesOf(h.lib.presentations.must(p0.id));
      // Within the cap and counted, never cut from the front: the first note stays.
      const kept = after[1]!.pptx!.notes!;
      expect(kept).toHaveLength(16);
      expect(kept[0]).toBe('note 1');
      expect(kept.at(-1)).toBe('and 2 more');
      expect(after[1]!.pptx!.missing).toEqual(['chart']);
      // Nothing missing: version 1 is the slide.
      expect(after[3]!.pptx!.pending).toBeUndefined();
      expect(after[3]!.pptx!.missing).toBeUndefined();
      expect(after[3]!.pptx!.class).toBe('native');
      neverRan();
    } finally {
      await h.cleanup();
    }
  }, 180_000);

  it('a re-import queues no follow-up', async () => {
    const { p } = await importDeck(serviceDeck(), 'Again.pptx');
    const chart = slidesOf(p)[1]!;
    // The chart slide's title edited, then reset from the deck.
    const edited: Presentation = {
      ...p,
      sections: p.sections.map((sec) => ({
        ...sec,
        slides: sec.slides.map((sl) =>
          sl.id === chart.id
            ? { ...sl, objects: sl.objects.map((o) => (o.type === 'text' ? { ...o, text: 'Giving' } : o)) }
            : sl,
        ),
      })),
    };
    hub.lib.savePresentation(edited, { expectedRev: p.rev, by: 'editor' });
    const ed = await login(hub.url, EDIT_PIN);
    const queued = await ed.json<Job>(`/presentations/${p.id}/pptx-reimport`, {
      method: 'POST',
      json: { slideIds: [chart.id], reset: [chart.id] },
    });
    const job = await waitJob(hub, queued.id, 120_000);
    expect(job.state, job.error).toBe('done');
    expect(job.result).toMatchObject({ regenerated: 1 });
    expect(job.log.some((l) => /LibreOffice follows|waiting: LibreOffice/.test(l))).toBe(false);
    expect(followUps(hub, p.id)).toHaveLength(0);
    const after = slidesOf(hub.lib.presentations.must(p.id))[1]!;
    expect(after.pptx).toMatchObject({ class: 'hybrid', missing: ['chart'] });
    expect(after.pptx!.pending).toBeUndefined();
    expect(after.objects.some((o) => o.type === 'text' && o.text === 'Giving this year')).toBe(true);
    neverRan();
  }, 120_000);

  it('GET /capabilities reports libreoffice absent', async () => {
    const ed = await login(hub.url, EDIT_PIN);
    const off = await ed.json<HubCapabilities>('/capabilities');
    expect(off).toMatchObject({
      libreoffice: { state: 'off' },
      pdf: PDF_TOOLS,
      pptx: { pictures: false, reference: false, referencePdf: PDF_TOOLS, art: false },
    });
    expect(off.documents.slice(0, 4)).toEqual(['pptx', 'ppsx', 'potx', 'pptm']);
    // Never to anyone signed out, and never in the public health.
    expect((await fetch(`${hub.url}/api/v1/capabilities`)).status).toBe(401);
    expect(JSON.stringify(await (await fetch(`${hub.url}/api/v1/health`)).json())).not.toMatch(
      /libreoffice/i,
    );
    // Auto with nothing installed by that name: absent.
    const h = await startHub({
      libreoffice: { mode: 'auto', exe: join(dir, 'nowhere', 'soffice') },
      toolProbe: undefined,
    });
    try {
      const c = await (await login(h.url, EDIT_PIN)).json<HubCapabilities>('/capabilities');
      expect(c.libreoffice).toEqual({ state: 'absent' });
      expect(c.pptx).toMatchObject({ pictures: false, reference: false, art: false });
    } finally {
      await h.cleanup();
    }
    neverRan();
  }, 60_000);

  /** `parts` as a deck of another OOXML kind: its main part's content type. */
  const asKind = (parts: Map<string, Uint8Array>, type: string) => {
    parts.set('[Content_Types].xml', enc.encode(partText(parts, '[Content_Types].xml').replace(MAIN, type)));
    return parts;
  };

  it('.ppsx, .potx and .pptm import natively; a .pptm macro part is never read', async () => {
    const kinds: [string, string][] = [
      ['Show.ppsx', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml'],
      ['Template.potx', 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml'],
    ];
    for (const [name, type] of kinds) {
      const { result, p } = await importDeck(asKind(serviceDeck(), type), name);
      expect(result.slides).toBe(4);
      expect(slidesOf(p)[0]!.objects.some((o) => o.type === 'text' && o.text === 'Welcome')).toBe(true);
    }
    // A macro-enabled deck whose macro part cannot even be inflated: read, it would fail the import.
    const macro = asKind(serviceDeck(), 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml');
    macro.set('ppt/vbaProject.bin', new Uint8Array(64).fill(0xff));
    const rels = partText(macro, 'ppt/_rels/presentation.xml.rels').replace(
      '</Relationships>',
      '<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
    );
    macro.set('ppt/_rels/presentation.xml.rels', enc.encode(rels));
    const zip = brokenEntry(await zipOf(macro, ['ppt/vbaProject.bin']), 'ppt/vbaProject.bin');
    const res = await upload(zip, 'Macros.pptm');
    expect(res.status).toBe(202);
    const job = await waitJob(hub, ((await res.json()) as Job).id, 120_000);
    expect(job.state, job.error).toBe('done');
    expect((job.result as PptxNativeResult).slides).toBe(4);
    // The same broken entry under a part the import does read fails it: the macro part was skipped unread.
    const control = serviceDeck();
    control.set('ppt/extra.xml', new Uint8Array(64).fill(0xff));
    const bad = await upload(
      brokenEntry(await zipOf(control, ['ppt/extra.xml']), 'ppt/extra.xml'),
      'Control.pptx',
    );
    const failed = await waitJob(hub, ((await bad.json()) as Job).id, 120_000);
    expect(failed.state).toBe('failed');
    neverRan();
  }, 180_000);

  it('.ppt and .odp are refused with the save-as hint', async () => {
    const cfb = new Uint8Array(1024);
    cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const odp = new JSZip();
    odp.file('mimetype', 'application/vnd.oasis.opendocument.presentation', { compression: 'STORE' });
    odp.file('content.xml', '<office:document-content/>');
    const odpBytes = await odp.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const cases: [Uint8Array, string, RegExp][] = [
      [cfb, 'Christmas 2009.ppt', /^PowerPoint 97-2003 files \(\.ppt, \.pps\) cannot be imported\./],
      [cfb, 'Renamed.pptx', /^PowerPoint 97-2003 files/],
      [cfb, 'Show.pps', /^PowerPoint 97-2003 files/],
      [odpBytes, 'Talk.odp', /^OpenDocument presentations \(\.odp\) cannot be imported\./],
      [odpBytes, 'Talk.pptx', /^OpenDocument presentations/],
      [await zipOf(serviceDeck()), 'Keynote.key', /^Keynote presentations \(\.key\) cannot be imported\./],
    ];
    for (const [bytes, name, want] of cases) {
      const res = await upload(bytes, name);
      expect(res.status, name).toBe(415);
      const e = (await res.json()) as { error: { code: string; message: string } };
      expect(e.error.code).toBe('unsupported');
      expect(e.error.message, name).toMatch(want);
      expect(e.error.message).toMatch(
        /Open it in PowerPoint, Keynote or LibreOffice Impress and save it as \.pptx, then import that file\.$/,
      );
    }
    expect(uploadsLeft()).toEqual([]);
    neverRan();
  });
});

/**
 * `zip` with the entry `name` (written uncompressed) marked deflated: its bytes (0xff…) are then no valid
 * deflate stream, so any reader that inflates it fails.
 */
function brokenEntry(zip: Buffer, name: string): Buffer {
  const out = Buffer.from(zip);
  const n = Buffer.from(name);
  let marked = 0;
  for (let i = 0; i + 46 < out.length; i++) {
    if (out.readUInt32LE(i) === 0x04034b50 && out.subarray(i + 30, i + 30 + n.length).equals(n)) {
      out.writeUInt16LE(8, i + 8);
      marked++;
    } else if (out.readUInt32LE(i) === 0x02014b50 && out.subarray(i + 46, i + 46 + n.length).equals(n)) {
      out.writeUInt16LE(8, i + 10);
      marked++;
    }
  }
  if (marked !== 2) throw new Error(`entry ${name} not found`);
  return out;
}
