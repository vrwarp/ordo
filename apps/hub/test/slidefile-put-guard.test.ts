/**
 * The hub never accepts a change of a slide's stand-in beside its slide file (import-files step 2, C-IF5, G4 item 3): the
 * picture and the key come from the FILE, so a stand-in edited beside it would leave both as they were while the screens
 * drew something else. `PUT /presentations/:id` answers 409 `stand_in_stale`; the hub's own writers (the LibreOffice
 * follow-up, Make editable, the text repair) are pinned never to be doors: a slide kept as a file is returned as it was.
 * Synthetic slides only: a crowded slide made into its file by the domain's own `withFullSlide`.
 */
import { DEFAULT_THEME, type Presentation, type Slide, type TextObject } from '@ordo/domain';
import { drawnPart } from '@ordo/domain/prerender.ts';
import { slideFromFile } from '@ordo/domain/slidefile.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { patchSlide } from '../src/pptx/fallback.ts';
import type { PptxLoSlide } from '../src/pptx/shared.ts';
import { EDIT_PIN, login, startHub, type TestHub } from './helpers.ts';
import { bigSlide, fullOf, presentationOf, textObject, uploadSlideFile } from './prerender-helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

const STALE_WORDS =
  'The simple copy of a detailed slide was changed beside its full copy; reload the presentation. The shapes of a detailed slide cannot be edited, its notes and timing can.';

/** A hub holding a presentation whose first slide is kept as a file (its stand-in) and a second, ordinary slide. */
async function saved(extra: (s: Slide) => Slide = (s) => s) {
  hub = await startHub();
  const ed = await login(hub.url, EDIT_PIN);
  const f = fullOf(extra(bigSlide('big', 300, 'one')));
  await uploadSlideFile(ed, f.pages);
  const plain: Slide = { id: 'plain', objects: [textObject('pt', 'An ordinary slide')] };
  const p = await ed.json<Presentation>('/presentations', {
    method: 'POST',
    json: presentationOf([f.standIn, plain]),
  });
  return { hub, ed, f, p };
}
const put = (ed: Awaited<ReturnType<typeof saved>>['ed'], p: Presentation) =>
  ed.fetch(`/presentations/${p.id}`, { method: 'PUT', json: p });
const withSlide = (p: Presentation, id: string, fn: (s: Slide) => Slide): Presentation => ({
  ...p,
  sections: p.sections.map((sec) => ({ ...sec, slides: sec.slides.map((s) => (s.id === id ? fn(s) : s)) })),
});

describe('PUT /presentations/:id refuses a stand-in changed beside its file (PG1-PG5)', () => {
  it('PG1 a PUT that changes the objects of a file-form slide answers 409 stand_in_stale with the slide ids and saves nothing', async () => {
    const { hub: h, ed, p } = await saved();
    const bad = withSlide(p, 'big', (s) => ({
      ...s,
      objects: s.objects.map((o, i) => (i === 0 ? { ...o, box: { ...o.box, x: o.box.x + 40 } } : o)),
    }));
    const r = await put(ed, bad);
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: { code: string; message: string; slides: string[] } };
    expect(body.error.code).toBe('stand_in_stale');
    expect(body.error.message).toBe(STALE_WORDS);
    expect(body.error.slides).toEqual(['big']);
    const stored = h.lib.presentations.must(p.id) as Presentation;
    expect(stored.rev).toBe(p.rev);
    expect(stored.sections[0]!.slides[0]!.objects).toEqual(p.sections[0]!.slides[0]!.objects);
    // a delete and an added object are changes too
    for (const objects of [
      bad.sections[0]!.slides[0]!.objects.slice(1),
      [...p.sections[0]!.slides[0]!.objects, textObject('x', 'x')],
    ]) {
      const r2 = await put(
        ed,
        withSlide(p, 'big', (s) => ({ ...s, objects })),
      );
      expect(r2.status).toBe(409);
    }
  });

  it('PG1 names at most the first 20 slides', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const slides: Slide[] = [];
    for (let i = 0; i < 25; i++) {
      const f = fullOf(bigSlide(`s${i}`, 300, `v${i}`));
      await uploadSlideFile(ed, f.pages);
      slides.push(f.standIn);
    }
    const p = await ed.json<Presentation>('/presentations', { method: 'POST', json: presentationOf(slides) });
    const bad = {
      ...p,
      sections: p.sections.map((sec) => ({
        ...sec,
        slides: sec.slides.map((s) => ({ ...s, objects: s.objects.slice(1) })),
      })),
    };
    const r = await put(ed, bad);
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: { slides: string[] } };
    expect(body.error.slides).toHaveLength(20);
    expect(body.error.slides[0]).toBe('s0');
  });

  it('PG2 a PUT that changes only the notes, the timing and an ordinary slide saves', async () => {
    const { ed, p } = await saved();
    const next = withSlide(
      withSlide(p, 'big', (s) => ({ ...s, notes: 'Ask the band to start softly', durationMs: 9000 })),
      'plain',
      (s) => ({ ...s, objects: [textObject('pt', 'An ordinary slide, edited')] }),
    );
    const r = await put(ed, next);
    expect(r.status).toBe(200);
    const back = (await r.json()) as Presentation;
    expect(back.sections[0]!.slides[0]!.notes).toBe('Ask the band to start softly');
    expect(back.sections[0]!.slides[0]!.prerender?.file?.ref).toBe(
      p.sections[0]!.slides[0]!.prerender?.file?.ref,
    );
  });

  it('PG3 a PUT with a new file ref (its head stored first) and new objects saves', async () => {
    const { ed, p } = await saved();
    const g = fullOf(bigSlide('big', 320, 'two'));
    await uploadSlideFile(ed, g.pages);
    const next = withSlide(p, 'big', () => g.standIn);
    const r = await put(ed, next);
    expect(r.status).toBe(200);
    const back = (await r.json()) as Presentation;
    expect(back.sections[0]!.slides[0]!.prerender?.file?.ref).toBe(g.name);
  });

  it('PG4 a stale rev answers the rev 409 first, as it did', async () => {
    const { ed, p } = await saved();
    const bad = withSlide({ ...p, rev: p.rev - 1 }, 'big', (s) => ({ ...s, objects: s.objects.slice(1) }));
    const r = await put(ed, bad);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('conflict');
  });

  it('PG5 a presentation with no slide kept as a file is never read beside the save (the guard costs no parse)', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const ordinary = presentationOf([{ id: 'a', objects: [textObject('t', 'One')] }]);
    const p = await ed.json<Presentation>('/presentations', { method: 'POST', json: ordinary });
    const get = vi.spyOn(hub.lib.presentations, 'get');
    expect((await put(ed, { ...p, notes: undefined } as Presentation)).status).toBe(200);
    const ordinaryCalls = get.mock.calls.length;
    get.mockClear();
    // with a slide kept as a file the one added read is the guard's
    const f = fullOf(bigSlide('big', 300, 'one'));
    await uploadSlideFile(ed, f.pages);
    const q = await ed.json<Presentation>('/presentations', {
      method: 'POST',
      json: presentationOf([f.standIn]),
    });
    get.mockClear();
    expect(
      (
        await put(
          ed,
          withSlide(q, 'big', (s) => ({ ...s, notes: 'n' })),
        )
      ).status,
    ).toBe(200);
    expect(get.mock.calls.length).toBe(ordinaryCalls + 1);
  });
});

describe("the hub's own writers are not doors (PG6)", () => {
  it('PG6 patchSlide returns a slide kept as a file as it was, whatever LibreOffice made of it', async () => {
    const f = fullOf(bigSlide('big', 300, 'one'));
    const lo = {
      slideId: 'big',
      index: 0,
      class: 'hybrid',
      digest: 'not-the-digest',
      art: { replaces: [], at: 0 },
    } as unknown as PptxLoSlide;
    const work = { art: { mediaId: 'art-picture', box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 } } };
    const out = patchSlide(f.standIn, lo, work, 'f'.repeat(64));
    expect(out).toBe(f.standIn);
    // an ordinary slide is patched as before
    const plain = patchSlide(
      { id: 'p', objects: [textObject('t', 'x')] },
      { ...lo, slideId: 'p' },
      work,
      'f'.repeat(64),
    );
    expect(plain.objects.length).toBeGreaterThan(1);
  });

  it('PG6 Make editable answers 400 not_imported for a slide kept as a file, even one that has an imported page', async () => {
    const { ed, p } = await saved((s) => ({
      ...s,
      imported: {
        fileId: 'f'.repeat(8),
        page: 1,
        imageMediaId: 'page-picture',
        textBoxes: [{ text: 'Words of the page', box: { x: 10, y: 10, w: 400, h: 100, rotation: 0 } }],
        textAligned: true,
      },
    }));
    const r = await ed.fetch(`/presentations/${p.id}/slides/big/make-editable`, { method: 'POST' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('not_imported');
    const stored = hub!.lib.presentations.must(p.id) as Presentation;
    expect(stored.rev).toBe(p.rev);
    expect(stored.sections[0]!.slides[0]!.objects).toEqual(p.sections[0]!.slides[0]!.objects);
  });

  it("PG6 a text repair that changes the imported text boxes leaves the key's drawn part equal", () => {
    const f = fullOf(bigSlide('big', 300, 'one'));
    const pages = f.pages.pages.map((x) => x.page);
    const before = slideFromFile(f.standIn, f.pages.head, pages);
    // what `textRepair` does to a slide: only `imported.textBoxes` and `textAligned` change
    const repaired: Slide = {
      ...f.standIn,
      imported: {
        fileId: 'f'.repeat(8),
        page: 1,
        imageMediaId: 'page-picture',
        textBoxes: [{ text: 'Words of the page', box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 } }],
        textAligned: true,
      },
    };
    const after = slideFromFile(repaired, f.pages.head, pages);
    expect(drawnPart(after, [])).toEqual(drawnPart(before, []));
    expect(DEFAULT_THEME.textBoxDefaults).toBeDefined();
    expect((after.objects[0] as TextObject | undefined)?.id).toBe(before.objects[0]!.id);
  });
});
