import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import {
  ANNOUNCEMENT_TEXT,
  CHURCH,
  churchDeck,
  editorHub,
  editorState,
  importDeck,
  M4_PORT,
  openEditor,
  openSlide,
  type PresentationRec,
  type SlideRec,
  save,
  saveAndReload,
  selectRange,
  selectText,
  slidesOf,
  stored,
} from './editorhelpers.ts';
import { hubApi } from './linkhelpers.ts';
import { apiJson } from './pptxlive.ts';

/**
 * M4 item F's exit (design/27 §15 M4: "re-import a legacy picture deck and a made-editable deck as
 * editable, keeping slide ids, notes, arrangement and user objects as a new revision, with no doubled
 * content"; apps/operator/src/views/editor/M4.md). The church deck is imported as pictures, as before M3
 * (`renderer=libreoffice`); a volunteer had added notes, a box over a page and a second arrangement. In the
 * editor, 'Make editable' on the first page is rebuilt from the PowerPoint file (the hub reroutes it to the
 * re-import), then 'Re-import from PowerPoint…' in the Presentation panel rebuilds the other pages. A copy
 * made editable the way an older build did (text boxes over the page picture) is re-imported with one slide
 * kept as it is. Each ends with Save and a reload: the presentation JSON is identical. Port 8906.
 */
const PORT = M4_PORT + 6;
const OUT = 'test-results/editor-reimport';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

type Job = { id: string; state: string; log: string[]; error?: string; result?: Record<string, unknown> };

/** The deck through POST /import/document as pictures (LibreOffice), the way every deck was before M3. */
async function importPictures(a: APIRequestContext, file: string): Promise<PresentationRec> {
  const res = await a.post('import/document', {
    multipart: {
      file: { name: basename(file), mimeType: PPTX_MIME, buffer: readFileSync(file) },
      renderer: 'libreoffice',
    },
  });
  expect(res.status(), await res.text()).toBe(202);
  const id = ((await res.json()) as Job).id;
  const job = await waitJob(a, id, 240_000);
  return stored(a, String(job.result!.presentationId));
}

async function waitJob(a: APIRequestContext, id: string, timeout = 120_000): Promise<Job> {
  let job: Job | undefined;
  await expect
    .poll(
      async () => {
        job = (await (await a.get(`jobs/${id}`)).json()) as Job;
        return job.state;
      },
      { timeout },
    )
    .toMatch(/^(done|failed)$/);
  expect(job!.state, `${job!.error}\n${job!.log.join('\n')}`).toBe('done');
  return job!;
}

const texts = (s: SlideRec) => s.objects.filter((o) => o.type === 'text').map((o) => o.text);
const revisions = (a: APIRequestContext, id: string) =>
  apiJson<{ rev: number; savedBy?: string }[]>(a, `presentations/${id}/revisions`);

/** Wait until the editor has taken revision `rev` over and holds nothing unsaved. */
async function editorAt(page: Page, rev: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await editorState(page);
        return s.baseRev === rev && !s.dirty && s.draft?.rev === rev;
      },
      { timeout: 120_000 },
    )
    .toBe(true);
}

/** Open the Presentation panel and re-import from PowerPoint, keeping the slides numbered in `keep`. */
async function reimportInEditor(page: Page, keep: number[] = []): Promise<void> {
  await page.getByRole('button', { name: 'Presentation', exact: true }).click();
  const report = page.getByRole('region', { name: 'Imported from PowerPoint' });
  await expect(report).toBeVisible();
  await report.getByRole('button', { name: 'Re-import from PowerPoint…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-plan]')).toBeVisible();
  for (const n of keep) await dialog.getByLabel(`Slide ${n}: keep as it is`).check();
  await dialog.getByRole('button', { name: 'Re-import', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** A small edit after the re-import (the exit check saves and reloads): the slide's notes. */
async function editNotes(page: Page, n: number, notes: string): Promise<void> {
  await openSlide(page, n);
  await page.getByRole('button', { name: 'Slide', exact: true }).click();
  const field = page.locator('label.field', { hasText: 'Notes' }).locator('textarea');
  await field.fill(notes);
  await expect.poll(async () => (await editorState(page)).dirty).toBe(true);
}

/** Every page picture (tagged 'document') a slide still draws: none once it is rebuilt. */
function pagePictures(s: SlideRec, pages: Set<string>): string[] {
  return [
    ...(s.objects.filter((o) => o.type === 'image' && pages.has(o.mediaId!)).map((o) => o.mediaId!) ?? []),
  ];
}

test('re-import a legacy picture deck and a made-editable deck as editable', async ({ page }) => {
  test.setTimeout(600_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = await churchDeck(join(OUT, 'deck'));
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const legacy = await importPictures(a, deck);
    const pages = slidesOf(legacy);
    // Five pages: LibreOffice prints the shown slides, the hidden sixth has none.
    expect(pages).toHaveLength(5);
    for (const s of pages) expect((s as SlideRec & { imported?: unknown }).imported).toBeDefined();
    const pageMedia = new Set(
      pages.map((s) => (s as unknown as { imported: { imageMediaId: string } }).imported.imageMediaId),
    );

    // ---- A legacy picture deck, as a volunteer left it: notes on slide 3, a box over page 4, an arrangement.
    const sid = legacy.sections[0]!.id;
    const over = {
      id: 'user-box-over-page-4',
      type: 'text',
      box: { x: 100, y: 900, w: 900, h: 120, rotation: 0 },
      text: 'Open house on Saturday',
      style: { fontFamily: 'Inter', fontSizePx: 48, color: { r: 255, g: 255, b: 255, a: 1 }, align: 'left' },
      opacity: 1,
    };
    const before = await apiJson<PresentationRec>(a, `presentations/${legacy.id}`, {
      put: {
        ...legacy,
        sections: [
          {
            ...legacy.sections[0]!,
            slides: pages.map((s, i) =>
              i === 2
                ? { ...s, notes: 'Read John 3 slowly, then pause.' }
                : i === 3
                  ? { ...s, objects: [...s.objects, over] }
                  : s,
            ),
          },
        ],
        arrangements: [
          ...legacy.arrangements,
          { id: 'second-service', name: 'Second service', sectionIds: [sid, sid] },
        ],
      },
    });

    await openEditor(page, PORT, before.id);
    // 'Make editable' on page 1: rebuilt from the PowerPoint file (rerouted to the re-import of that slide).
    await page.getByRole('button', { name: 'Make editable' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Make editable' }).click();
    await editorAt(page, before.rev + 1);
    const one = await stored(a, before.id);
    expect(slidesOf(one)[0]!.pptx).toMatchObject({ index: 0, class: 'native' });
    expect(slidesOf(one).slice(1)).toEqual(slidesOf(before).slice(1));

    // 'Re-import from PowerPoint…' for the rest.
    await reimportInEditor(page);
    await editorAt(page, before.rev + 2);
    const after = await stored(a, before.id);
    const revs = await revisions(a, before.id);
    expect(revs.find((r) => r.rev === after.rev)?.savedBy).toBe('pptx-reimport');
    expect(revs.find((r) => r.rev === before.rev + 1)?.savedBy).toBe('pptx-reimport');
    checkRebuilt(before, after, pageMedia);
    // The volunteer's notes, box and arrangement are kept; the other slides got the deck's notes.
    const s = slidesOf(after);
    expect(s[2]!.notes).toBe('Read John 3 slowly, then pause.');
    expect(s.map((x) => x.notes)).toEqual([
      CHURCH.welcome.notes,
      CHURCH.announcement.notes,
      'Read John 3 slowly, then pause.',
      CHURCH.photo.notes,
      CHURCH.pair.notes,
    ]);
    expect(s[3]!.objects.at(-1)).toEqual(slidesOf(before)[3]!.objects.at(-1));
    expect(after.arrangements).toEqual(before.arrangements);

    await editNotes(page, 1, 'Greet people at the door, then the welcome.');
    const saved = await saveAndReload(page, a, before.id);
    expect(slidesOf(saved)[0]!.notes).toBe('Greet people at the door, then the welcome.');

    // ---- A deck made editable by an older build: text boxes over each page picture, the page record gone.
    const copy = await madeEditableCopy(a, legacy);
    const made = slidesOf(copy);
    for (const m of made) {
      expect(pagePictures(m, pageMedia)).toHaveLength(1);
      expect(m.objects[0]!.type).toBe('image');
    }
    await openEditor(page, PORT, copy.id);
    await reimportInEditor(page, [4]);
    await editorAt(page, copy.rev + 1);
    const rebuilt = await stored(a, copy.id);
    expect((await revisions(a, copy.id)).find((r) => r.rev === rebuilt.rev)?.savedBy).toBe('pptx-reimport');
    const r = slidesOf(rebuilt);
    expect(r.map((x) => x.id)).toEqual(made.map((x) => x.id));
    // Slide 4 was kept as it is; the others are the deck's slides, the shape added on slide 1 on top.
    expect(r[3]).toEqual(made[3]);
    expect(r.filter((_, i) => i !== 3).map((x) => x.pptx?.index)).toEqual([0, 1, 2, 4]);
    for (const [i, x] of r.entries()) {
      if (i === 3) continue;
      expect(pagePictures(x, pageMedia), `slide ${i + 1}`).toEqual([]);
      for (const t of new Set(texts(x)))
        expect(
          texts(x).filter((y) => y === t),
          `slide ${i + 1}`,
        ).toHaveLength(1);
    }
    expect(r[0]!.objects.at(-1)).toEqual(made[0]!.objects.at(-1));
    expect(r[0]!.objects.at(-1)!.origin).toBeUndefined();
    expect(texts(r[1]!).filter((t) => t === ANNOUNCEMENT_TEXT)).toHaveLength(1);
    expect(rebuilt.arrangements).toEqual(copy.arrangements);

    await editNotes(page, 2, 'Mention the sign-up sheet by the door.');
    await saveAndReload(page, a, copy.id);
  } finally {
    hub.kill();
  }
});

test("'Reset slide from PowerPoint' brings back an edited slide, keeping what was added in ordo and its settings", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const deck = await churchDeck(join(OUT, 'deck-reset'));
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const imported = await importDeck(a, deck);
    // A shape added in ordo over the announcement (no origin): a reset keeps it on top.
    const mark = {
      id: 'user-star-slide-2',
      type: 'shape',
      box: { x: 1700, y: 60, w: 120, h: 120, rotation: 0 },
      shape: 'ellipse',
      fill: { r: 255, g: 200, b: 0, a: 1 },
      opacity: 1,
      radius: 0,
    };
    // Slide settings set in ordo: the Bottom-Third Stream text and an outgoing MIDI cue (the lights).
    const strap = 'Sign up at the welcome desk';
    const midiCue = { id: 'lights-up', channel: 1, type: 'noteOn', number: 64, value: 127 };
    const p = await apiJson<PresentationRec>(a, `presentations/${imported.id}`, {
      put: {
        ...imported,
        sections: imported.sections.map((sec) => ({
          ...sec,
          slides: sec.slides.map((sl, i) =>
            i === 1 && sec === imported.sections[0]
              ? { ...sl, objects: [...sl.objects, mark], bottomThirdText: strap, midiCues: [midiCue] }
              : sl,
          ),
        })),
      },
    });
    expect(slidesOf(p)[1]!.objects.at(-1)!.id).toBe(mark.id);
    const note = slidesOf(p)[1]!.objects.find((o) => o.type === 'text' && o.text === ANNOUNCEMENT_TEXT)!;
    await openEditor(page, PORT, p.id);
    await openSlide(page, 2);
    // A volunteer rewrites the date (an edit of the imported text) and saves.
    await selectText(page, note);
    const at = CHURCH.announcement.before.length;
    await selectRange(page, at, at + CHURCH.announcement.date.length);
    await page.keyboard.type('Sunday 26 May');
    await save(page);
    const edited = await stored(a, p.id);
    expect(texts(slidesOf(edited)[1]!)).toEqual([
      ANNOUNCEMENT_TEXT.replace('Sunday 12 May', 'Sunday 26 May'),
    ]);

    await page.getByRole('button', { name: 'Slide', exact: true }).click();
    const card = page.getByRole('region', { name: 'From PowerPoint' });
    await expect(card.getByText('Edited in ordo since the import.')).toBeVisible();
    await card.getByRole('button', { name: 'Reset slide from PowerPoint' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Reset slide' }).click();
    await editorAt(page, edited.rev + 1);
    const reset = await stored(a, p.id);
    const two = slidesOf(reset)[1]!;
    expect(two.id).toBe(slidesOf(p)[1]!.id);
    expect(texts(two)).toEqual([ANNOUNCEMENT_TEXT]);
    expect(two.objects.at(-1)).toEqual(slidesOf(p)[1]!.objects.at(-1));
    expect(two.notes).toBe(CHURCH.announcement.notes);
    const kept = two as SlideRec & { bottomThirdText?: string; midiCues?: unknown[] };
    expect(kept.bottomThirdText).toBe(strap);
    expect(kept.midiCues).toEqual([midiCue]);
    await expect(page.locator('label', { hasText: 'Bottom-third text' }).locator('textarea')).toHaveValue(
      strap,
    );
    // The other slides are as they were.
    for (const [i, x] of slidesOf(reset).entries()) if (i !== 1) expect(x).toEqual(slidesOf(edited)[i]);
    await expect(card.getByText('Nothing to reset: the slide is as it was imported.')).toBeVisible();

    await editNotes(page, 2, 'Mention the sign-up sheet and the date.');
    await saveAndReload(page, a, p.id);
  } finally {
    hub.kill();
  }
});

/**
 * The rebuilt legacy deck: the same slide ids in the same sections, a native slide for each page (deck
 * slides 1-5 in order, the hidden sixth not added), no page picture left and every deck text once, the
 * objects added over a page on top, and the presentation now a native import.
 */
function checkRebuilt(before: PresentationRec, after: PresentationRec, pageMedia: Set<string>): void {
  expect(after.sections.map((s) => s.id)).toEqual(before.sections.map((s) => s.id));
  const b = slidesOf(before);
  const s = slidesOf(after);
  expect(s.map((x) => x.id)).toEqual(b.map((x) => x.id));
  expect(s.map((x) => x.pptx?.index)).toEqual([0, 1, 2, 3, 4]);
  for (const [i, x] of s.entries()) {
    expect((x as SlideRec & { imported?: unknown }).imported, `slide ${i + 1}`).toBeUndefined();
    expect(pagePictures(x, pageMedia), `slide ${i + 1}`).toEqual([]);
    for (const t of new Set(texts(x)))
      expect(
        texts(x).filter((y) => y === t),
        `slide ${i + 1}`,
      ).toHaveLength(1);
    for (const o of x.objects.slice(0, x.objects.length - b[i]!.objects.length))
      expect(o.origin?.src, `slide ${i + 1}`).toBe('pptx');
  }
  expect(texts(s[0]!)).toContain(CHURCH.welcome.title);
  expect(texts(s[1]!)).toEqual([ANNOUNCEMENT_TEXT]);
  expect(texts(s[3]!)).toEqual([CHURCH.photo.caption, 'Open house on Saturday']);
  expect(texts(s[4]!)).toEqual([CHURCH.pair.text]);
  expect((after as { source?: { native?: { slides: number } } }).source?.native?.slides).toBe(5);
}

/**
 * A copy of the legacy import made editable the way builds before M4 did it: today's route still takes that
 * path for a page whose presentation is not a stored PowerPoint, so the copy is a 'pdf' while each page is
 * made editable, then set back to the PowerPoint file. A shape is added on slide 1.
 */
async function madeEditableCopy(a: APIRequestContext, legacy: PresentationRec): Promise<PresentationRec> {
  const sid = `copy-${legacy.sections[0]!.id}`.slice(0, 26);
  const source = legacy.source as Record<string, unknown>;
  let p = await apiJson<PresentationRec>(a, 'presentations', {
    post: {
      title: `${legacy.title} (made editable)`,
      kind: 'slides',
      meta: { tags: [] },
      sections: [
        {
          id: sid,
          label: 'Slides',
          short: 'S',
          slides: slidesOf(legacy).map((s, i) => ({ ...s, id: `copy-slide-${i + 1}` })),
        },
      ],
      arrangements: [{ id: 'copy-default', name: 'Default', sectionIds: [sid] }],
      source: { ...source, kind: 'pdf' },
    },
  });
  for (const s of slidesOf(p))
    p = await apiJson<PresentationRec>(a, `presentations/${p.id}/slides/${s.id}/make-editable`, { post: {} });
  const shape = {
    id: 'user-shape-slide-1',
    type: 'shape',
    box: { x: 40, y: 40, w: 160, h: 160, rotation: 0 },
    shape: 'ellipse',
    fill: { r: 255, g: 200, b: 0, a: 1 },
    opacity: 1,
    radius: 0,
  };
  const slides = slidesOf(p);
  return apiJson<PresentationRec>(a, `presentations/${p.id}`, {
    put: {
      ...p,
      source: { ...source, kind: 'pptx' },
      sections: [
        {
          ...p.sections[0]!,
          slides: slides.map((s, i) => (i === 0 ? { ...s, objects: [...s.objects, shape] } : s)),
        },
      ],
    },
  });
}
