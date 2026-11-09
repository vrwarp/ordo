/**
 * M3 item G (design/27 §11 "Round trip and migration", §14.11): the legacy text repair, the aligned text
 * boxes of the 'Pictures (LibreOffice)' import, and the media delete that names the presentations it would
 * break. Decks are synthetic (`@ordo/pptx-scene` test-util).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expandCues, type Media, newId, type Playlist, type Presentation, type Slide } from '@ordo/domain';
import { body, buildDeck, para, run, sp } from '@ordo/pptx-scene/test-util.ts';
import type { Job } from '@ordo/protocol';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// The readers the repair is for: the operator's search and the stage display (pure modules).
import { presentationDoc } from '../../operator/src/lib/search.ts';
import { slideText } from '../../stage/src/model.ts';
import type { JobCtx } from '../src/jobs.ts';
import { PPTX_MIME } from '../src/imports.ts';
import type { PptxDeps, TextRepairPayload } from '../src/pptx/shared.ts';
import {
  AMBIGUOUS_PAGE,
  pagesOf,
  REPAIR_RETRY_MS,
  slideBoxes,
  storedPagesOf,
  TEXT_REPAIR_BY,
  type TextRepairResult,
  textRepairJob,
} from '../src/pptx/textRepair.ts';
import { fixtures } from './fixtures.ts';
import { type Client, EDIT_PIN, login, startHub, type TestHub, tempDir } from './helpers.ts';

const EMU = 914_400;
/** A 4:3 deck: the uniform contain mapping puts it 240 px from the left of the 1920x1080 frame. */
const SIZE_4X3 = { cx: 10 * EMU, cy: 7.5 * EMU };
const textBox = (id: number, text: string) =>
  sp({ id, x: 0, y: 0, cx: 5 * EMU, cy: EMU, txBox: true, txBody: body(para(run(text))) });

/** Three listed slides, the second hidden: LibreOffice prints two pages. */
async function hiddenSlideDeck(): Promise<Uint8Array> {
  const parts = buildDeck({
    size: SIZE_4X3,
    slides: [
      { shapes: textBox(2, 'Welcome home') },
      { shapes: textBox(2, 'Prayer requests'), hidden: true },
      { shapes: textBox(2, 'Offering') },
    ],
  });
  const zip = new JSZip();
  for (const [name, bytes] of parts) zip.file(name, bytes);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** A legacy picture import (before M3): boxes matched by list index, stretched to 1920x1080. */
function legacyDeck(title: string, fileId: string, texts: string[], renderer?: 'pptx-preview'): Presentation {
  const sid = newId();
  return {
    id: newId(),
    rev: 1,
    title,
    kind: 'slides',
    meta: { tags: [] },
    sections: [
      {
        id: sid,
        label: 'Slides',
        short: 'S',
        slides: texts.map(
          (text, i): Slide => ({
            id: newId(),
            objects: [],
            imported: {
              fileId,
              page: i + 1,
              imageMediaId: newId(),
              textBoxes: [{ text, box: { x: 0, y: 0, w: 960, h: 144, rotation: 0 }, fontSizePx: 36 }],
            },
          }),
        ),
      },
    ],
    arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid] }],
    source: { kind: 'pptx', fileId, ...(renderer ? { renderer } : {}) },
    archived: false,
  };
}

/** What a reader shows for each slide: cue label, stage text; and the presentation's search haystack. */
function readers(p: Presentation): { labels: string[]; stage: string[]; search: string } {
  const playlist: Playlist = {
    id: newId(),
    rev: 1,
    name: 'Sunday',
    items: [{ id: newId(), kind: 'presentation', presentationId: p.id }],
  };
  const cues = expandCues({ playlist, presentations: { [p.id]: p }, media: {} });
  return {
    labels: cues.map((c) => c.label),
    stage: p.sections.flatMap((s) => s.slides.map((sl) => slideText(sl))),
    search: presentationDoc(p).h,
  };
}

function fakeCtx(payload: TextRepairPayload): JobCtx<TextRepairPayload> & { lines: string[] } {
  const lines: string[] = [];
  const ctx = {
    id: 'job',
    payload,
    signal: new AbortController().signal,
    log: (m: string) => void lines.push(m),
    progress: () => undefined,
    setPayload: (p: TextRepairPayload) => {
      ctx.payload = p;
    },
    lines,
  };
  return ctx;
}

describe('pagesOf', () => {
  const listed = [
    { index: 0, hidden: false, shown: 0 },
    { index: 1, hidden: true },
    { index: 2, hidden: false, shown: 1 },
  ];
  it('counts shown slides for LibreOffice (or no renderer recorded)', () => {
    expect(pagesOf('libreoffice', listed, 2)).toEqual([0, 2]);
    expect(pagesOf(undefined, listed, 2)).toEqual([0, 2]);
    // A page past the deck's shown slides shows nothing known.
    expect(pagesOf(undefined, listed, 3)).toEqual([0, 2, -1]);
  });
  it('counts shown slides for pptx-preview only when the page count is the shown count', () => {
    expect(pagesOf('pptx-preview', listed, 2)).toEqual([0, 2]);
    expect(pagesOf('pptx-preview', listed, 3)).toEqual([0, 1, 2]);
    expect(pagesOf('pptx-preview', listed, 4)).toEqual([0, 1, 2, -1]);
  });
  it('leaves the page of a repeated listing unknown, and bounds the page count', () => {
    // Slide 0 listed twice (shown 0 and 1): page 1 repeats it, which `listed` does not list again.
    const repeated = [
      { index: 0, hidden: false, shown: 0 },
      { index: 1, hidden: false, shown: 2 },
    ];
    expect(pagesOf(undefined, repeated, 3)).toEqual([0, -1, 1]);
    expect(pagesOf(undefined, listed, -5)).toEqual([]);
    expect(pagesOf(undefined, listed, Number.NaN)).toEqual([]);
    expect(pagesOf(undefined, [], 1e9)).toHaveLength(100_000);
  });
  it('does not guess a pptx-preview page when slides may have been deleted (the original count is unknown)', () => {
    // LibreOffice pages count shown slides whatever the count.
    expect(storedPagesOf('libreoffice', listed, 1)).toEqual([0]);
    // More pages left than shown slides: every listed slide was drawn.
    expect(storedPagesOf('pptx-preview', listed, 3)).toEqual([0, 1, 2]);
    // Two pages left: the shown slides, or every slide with the last page deleted. Page 1 is slide 0 either
    // way; page 2 is slide 2 or the hidden slide 1, so it is not trusted.
    expect(storedPagesOf('pptx-preview', listed, 2)).toEqual([0, AMBIGUOUS_PAGE]);
    expect(storedPagesOf('pptx-preview', listed, 1)).toEqual([0]);
    // Without hidden slides both readings agree.
    expect(storedPagesOf('pptx-preview', [listed[0]!, { index: 1, hidden: false, shown: 1 }], 2)).toEqual([
      0, 1,
    ]);
  });
});

describe('slideBoxes', () => {
  it('keeps valid text boxes, bounds sizes, and adds the text baked into art', () => {
    const box = { x: 10, y: 20, w: 300, h: 60, rotation: 0 };
    const style = { fontSizePx: 9000 } as never;
    const slide = {
      id: 's',
      objects: [
        { id: 'a', type: 'text', box, text: 'Title', style, opacity: 1 },
        { id: 'b', type: 'text', box, text: '   ', style, opacity: 1 },
        { id: 'c', type: 'text', box: { ...box, x: Number.NaN }, text: 'Broken', style, opacity: 1 },
        { id: 'd', type: 'shape', box },
      ],
    } as unknown as Slide;
    const out = slideBoxes({
      slide,
      art: { elements: [], box: { x: 0, y: 0, w: 100, h: 100 }, at: 0, replaces: [], text: 'Chart text' },
    });
    expect(out).toEqual([
      { text: 'Title', box, fontSizePx: 5000 },
      { text: 'Chart text', box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 } },
    ]);
  });
});

describe('legacy text repair (design/27 §11)', () => {
  let hub: TestHub;
  let deck: string;
  beforeAll(async () => {
    hub = await startHub();
    deck = (await hub.store.putBytes(await hiddenSlideDeck(), { ext: 'pptx', mime: PPTX_MIME })).hash;
  });
  afterAll(() => hub.cleanup());

  it('re-keys a LibreOffice and two pptx-preview imports so labels, stage and search match each page', async () => {
    const lo = hub.lib.savePresentation(
      // The legacy bug: page 2 shows "Offering" but holds the hidden slide's box.
      legacyDeck('Sermon (LibreOffice)', deck, ['Welcome home', 'Prayer requests']),
      { create: true },
    );
    const ppvShown = hub.lib.savePresentation(
      legacyDeck('Sermon (pptx-preview)', deck, ['Welcome home', 'Prayer requests'], 'pptx-preview'),
      { create: true },
    );
    // Its import job is still recorded: the page count (2) is the import's own, not a guess.
    const now = new Date().toISOString();
    hub.lib.db
      .prepare(
        `INSERT INTO jobs (id, kind, class, state, progress, payload, log, result, created_at, updated_at)
         VALUES (?, 'document', 'heavy', 'done', 1, '{}', '[]', ?, ?, ?)`,
      )
      .run(newId(), JSON.stringify({ presentationId: ppvShown.id, pages: 2 }), now, now);
    // The same import without its job, and an older one that drew every slide, each with its last page deleted:
    // two pages could be either; the second is left untrusted rather than given another slide's text.
    const ppvUnknown = hub.lib.savePresentation(
      legacyDeck(
        'Sermon (pptx-preview, job gone)',
        deck,
        ['Welcome home', 'Prayer requests'],
        'pptx-preview',
      ),
      { create: true },
    );
    // An older pptx-preview drew every listed slide, the hidden one too.
    const ppvListed = hub.lib.savePresentation(
      legacyDeck(
        'Sermon (pptx-preview, every slide)',
        deck,
        ['Welcome home', 'Prayer requests', 'Offering'],
        'pptx-preview',
      ),
      { create: true },
    );
    // Before the repair, nothing trusts the legacy boxes: no reader shows another slide's text.
    for (const p of [lo, ppvShown, ppvListed]) {
      const r = readers(p);
      expect(r.labels).toEqual(p.sections[0]!.slides.map((_, i) => `Slides ${i + 1}`));
      expect(r.stage.every((t) => t === '')).toBe(true);
      expect(r.search).not.toMatch(/welcome|prayer|offering/);
    }

    const job = hub.imports.pptx.queueTextRepair();
    expect(job?.kind).toBe('pptx-text-repair');
    // One repair at a time.
    expect(hub.imports.pptx.queueTextRepair()).toBeUndefined();
    await hub.jobs.idle();
    const done = hub.jobs.get(job!.id);
    expect(done.error).toBeUndefined();
    expect(done.result).toEqual({
      repaired: 4,
      skipped: 0,
      failed: 0,
      deferred: 0,
    } satisfies TextRepairResult);
    const unknown = hub.lib.presentations.must(ppvUnknown.id).sections[0]!.slides;
    expect(unknown.map((s) => s.imported?.textAligned)).toEqual([true, false]);
    expect(unknown[0]!.imported!.textBoxes!.map((b) => b.text)).toEqual(['Welcome home']);
    expect(readers(hub.lib.presentations.must(ppvUnknown.id)).stage).toEqual(['Welcome home', '']);

    const after = (p: Presentation) => hub.lib.presentations.must(p.id);
    const expected: [Presentation, string[]][] = [
      [lo, ['Welcome home', 'Offering']],
      [ppvShown, ['Welcome home', 'Offering']],
      [ppvListed, ['Welcome home', 'Prayer requests', 'Offering']],
    ];
    for (const [p, texts] of expected) {
      const q = after(p);
      expect(q.rev).toBe(2);
      expect(hub.lib.revisions(q.id)[0]).toMatchObject({ rev: 2, savedBy: TEXT_REPAIR_BY });
      const slides = q.sections[0]!.slides;
      expect(slides.map((s) => s.imported?.textAligned)).toEqual(texts.map(() => true));
      expect(slides.map((s) => s.imported?.textBoxes?.map((b) => b.text))).toEqual(texts.map((t) => [t]));
      // The uniform contain mapping: a 4:3 page sits 240 px from the frame's left edge, 1440 px wide.
      for (const s of slides) {
        const b = s.imported!.textBoxes![0]!.box;
        expect(b.x).toBeGreaterThanOrEqual(240);
        expect(b.x + b.w).toBeLessThanOrEqual(1680);
      }
      const r = readers(q);
      expect(r.labels).toEqual(texts);
      expect(r.stage).toEqual(texts);
      for (const t of texts) expect(r.search).toContain(t.toLowerCase());
    }
    // The hidden slide's text is on no LibreOffice page.
    expect(readers(after(lo)).search).not.toContain('prayer');
    // Once repaired, the start-up check finds nothing to do.
    expect(hub.imports.pptx.queueTextRepair()).toBeUndefined();
  });

  it('skips native presentations and decks that are gone; marks unreadable decks', async () => {
    const native = legacyDeck('Native', deck, ['Welcome home']);
    native.source = {
      kind: 'pptx',
      fileId: deck,
      native: { version: 1, slides: 1, native: 1, hybrid: 0, picture: 0 },
    };
    const savedNative = hub.lib.savePresentation(native, { create: true });
    const gone = hub.lib.savePresentation(legacyDeck('Gone', 'e'.repeat(64), ['Welcome home']), {
      create: true,
    });
    expect(hub.imports.pptx.queueTextRepair()).toBeUndefined();

    const junk = (
      await hub.store.putBytes(new TextEncoder().encode('not a zip'), { ext: 'pptx', mime: PPTX_MIME })
    ).hash;
    const bad = hub.lib.savePresentation(legacyDeck('Unreadable', junk, ['Old text']), { create: true });
    const job = hub.imports.pptx.queueTextRepair();
    await hub.jobs.idle();
    expect(hub.jobs.get(job!.id).result).toEqual({ repaired: 0, skipped: 0, failed: 1, deferred: 0 });
    expect(hub.jobs.get(job!.id).log.join('\n')).toMatch(
      /\[warn\] “Unreadable”: the PowerPoint file could not be read/,
    );
    const b = hub.lib.presentations.must(bad.id).sections[0]!.slides[0]!;
    // Checked and not aligned: readers ignore the boxes, 'Make editable' keeps them, no retry at every start.
    expect(b.imported).toMatchObject({ textAligned: false, textBoxes: [{ text: 'Old text' }] });
    expect(readers(hub.lib.presentations.must(bad.id)).stage).toEqual(['']);
    expect(hub.lib.presentations.must(savedNative.id).rev).toBe(1);
    expect(hub.lib.presentations.must(gone.id).rev).toBe(1);
    expect(hub.imports.pptx.queueTextRepair()).toBeUndefined();
  });

  it('defers a live-locked presentation and queues the repair again after End service', async () => {
    const p = hub.lib.savePresentation(legacyDeck('Live sermon', deck, ['Welcome home', 'Prayer requests']), {
      create: true,
    });
    const live = new Set([p.id]);
    const queued: [string, unknown, string][] = [];
    const deps: PptxDeps = {
      ...hub.imports.pptx.deps,
      locked: (id) => live.has(id),
      jobs: {
        enqueue: (kind: string, payload: unknown, cls: string) => {
          queued.push([kind, payload, cls]);
          return { id: 'next', kind } as Job;
        },
      } as unknown as PptxDeps['jobs'],
    };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const ctx = fakeCtx({ done: [] });
      expect(await textRepairJob(deps)(ctx)).toEqual({ repaired: 0, skipped: 0, failed: 0, deferred: 1 });
      expect(ctx.payload).toEqual({ done: [], deferred: [p.id] });
      expect(ctx.lines.join('\n')).toMatch(
        /1 presentation\(s\) are in the live service: repaired after End service/,
      );
      expect(hub.lib.presentations.must(p.id).rev).toBe(1);
      vi.advanceTimersByTime(REPAIR_RETRY_MS);
      expect(queued).toEqual([]);
      live.clear(); // End service
      vi.advanceTimersByTime(REPAIR_RETRY_MS);
      expect(queued).toEqual([['pptx-text-repair', { done: [] }, 'light']]);
      vi.advanceTimersByTime(3 * REPAIR_RETRY_MS);
      expect(queued).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    // The queued repair (here run by hand) then fixes it.
    const ctx = fakeCtx({ done: [] });
    expect(await textRepairJob({ ...deps, locked: () => false })(ctx)).toMatchObject({ repaired: 1 });
    expect(readers(hub.lib.presentations.must(p.id)).labels).toEqual(['Welcome home', 'Offering']);
  });

  it('skips what an interrupted run already handled', async () => {
    const p = hub.lib.savePresentation(legacyDeck('Resumed', deck, ['x']), { create: true });
    const ctx = fakeCtx({ done: [p.id] });
    expect(await textRepairJob(hub.imports.pptx.deps)(ctx)).toEqual({
      repaired: 0,
      skipped: 0,
      failed: 0,
      deferred: 0,
    });
    expect(ctx.lines[0]).toMatch(/resuming: 1 presentation/);
    expect(hub.lib.presentations.must(p.id).rev).toBe(1);
  });
});

describe('the one-shot trigger at start-up', () => {
  it('queues the repair when the library holds legacy pages, and nothing once they are repaired', async () => {
    const dir = tempDir();
    let hub = await startHub({ dataDir: dir });
    const deck = (await hub.store.putBytes(await hiddenSlideDeck(), { ext: 'pptx', mime: PPTX_MIME })).hash;
    const p = hub.lib.savePresentation(legacyDeck('Old import', deck, ['Welcome home', 'Prayer requests']), {
      create: true,
    });
    await hub.cleanup();
    hub = await startHub({ dataDir: dir });
    try {
      expect(hub.jobs.list().filter((j) => j.kind === 'pptx-text-repair')).toHaveLength(1);
      await hub.jobs.idle();
      expect(readers(hub.lib.presentations.must(p.id)).stage).toEqual(['Welcome home', 'Offering']);
    } finally {
      await hub.cleanup();
    }
    hub = await startHub({ dataDir: dir });
    try {
      // Only the finished run of the second start: nothing new is queued.
      expect(
        hub.jobs
          .list()
          .filter((j) => j.kind === 'pptx-text-repair')
          .map((j) => j.state),
      ).toEqual(['done']);
    } finally {
      await hub.cleanup();
    }
  });
});

function has(tool: string, flag: string): boolean {
  try {
    execFileSync(tool, [flag], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!has('soffice', '--version'))(
  "'Pictures (LibreOffice)' import: boxes keyed by the slide each page shows",
  () => {
    let hub: TestHub;
    let ed: Client;
    beforeAll(async () => {
      hub = await startHub();
      ed = await login(hub.url, EDIT_PIN);
    });
    afterAll(() => hub.cleanup());

    it('gives page 2 the third slide’s text after a hidden slide, in the page’s own frame', async () => {
      const fd = new FormData();
      fd.append('file', new Blob([(await hiddenSlideDeck()) as Uint8Array<ArrayBuffer>]), 'Hidden.pptx');
      // The picture import is a choice since editable slides became the default (item H).
      fd.append('renderer', 'libreoffice');
      const job = await ed.json<Job>('/import/document', { method: 'POST', body: fd });
      await hub.jobs.idle();
      const done = hub.jobs.get(job.id);
      expect(done.error).toBeUndefined();
      const p = hub.lib.presentations.must((done.result as { presentationId: string }).presentationId);
      const slides = p.sections[0]!.slides;
      expect(slides).toHaveLength(2);
      expect(slides.map((s) => s.imported?.textAligned)).toEqual([true, true]);
      expect(slides.map((s) => s.imported?.textBoxes?.map((b) => b.text))).toEqual([
        ['Welcome home'],
        ['Offering'],
      ]);
      expect(slides[1]!.imported!.textBoxes![0]!.box.x).toBeGreaterThanOrEqual(240);
      expect(readers(p).labels).toEqual(['Welcome home', 'Offering']);
      // Born aligned: the repair has nothing to do.
      expect(hub.imports.pptx.queueTextRepair()).toBeUndefined();
    }, 120_000);
  },
);

describe('deleting media that presentations use (design/27 §11 item 15)', () => {
  let hub: TestHub;
  let ed: Client;
  beforeAll(async () => {
    hub = await startHub();
    ed = await login(hub.url, EDIT_PIN);
  });
  afterAll(() => hub.cleanup());

  it('answers 409 naming the presentations, and deletes with force', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(fixtures.png(tempDir()))]), 'logo.png');
    const m = await ed.json<Media>('/media', { method: 'POST', body: fd });
    const p = legacyDeck('Harvest', 'f'.repeat(64), ['x']);
    p.sections[0]!.slides[0]!.imported!.imageMediaId = m.id;
    hub.lib.savePresentation(p, { create: true });
    const res = await ed.fetch(`/media/${m.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; message: string; presentations: { id: string; title: string }[] };
    };
    expect(body.error.code).toBe('media_in_use');
    expect(body.error.message).toMatch(/“logo” is used by the presentation “Harvest”/);
    expect(body.error.presentations).toEqual([{ id: p.id, title: 'Harvest' }]);
    expect(hub.lib.media.get(m.id)).toBeDefined();
    expect((await ed.fetch(`/media/${m.id}?force=1`, { method: 'DELETE' })).status).toBe(204);
    expect(hub.lib.media.get(m.id)).toBeUndefined();
  });
});
