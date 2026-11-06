/**
 * 'Re-import from PowerPoint' (design/27 §11 "Round trip and migration", §14.11, §15 M4; M4 item F,
 * apps/operator/src/views/editor/M4.md): the plan and the merge as pure functions, then the `pptx-reimport`
 * job on the real pool through the routes: a legacy picture presentation and a made-editable slide become
 * native slides keeping their ids, notes, arrangement and the objects added in ordo, as one new revision
 * with no doubled content; edited native slides are kept unless reset; 'Make editable' on a legacy page is
 * rerouted to the job; nothing is written while the presentation is live. Decks are synthetic.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_THEME,
  type ImageObject,
  newId,
  type Playlist,
  type Presentation,
  type ShapeObject,
  Slide,
  type SlideObject,
  type TextObject,
} from '@ordo/domain';
import { digestOf } from '@ordo/pptx-scene/emit.ts';
import {
  body,
  buildDeck,
  imageRel,
  NS_A,
  NS_P,
  NS_R,
  para,
  pic,
  run,
  solid,
  sp,
} from '@ordo/pptx-scene/test-util.ts';
import type { Job, PptxReimportPlan, PptxReimportResult } from '@ordo/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deckIndexes,
  earlierWork,
  type FreshDeck,
  importOptionsOf,
  type MediaTags,
  mergeReimport,
  pageFromName,
  planReimport,
  queueReimport,
  REIMPORT_BY,
  reimportKinds,
  unedited,
} from '../src/pptx/reimport.ts';
import { PPTX_JOB_CLASS, PPTX_JOBS, type PptxLoSlide } from '../src/pptx/shared.ts';
import { ffmpeg } from './fixtures.ts';
import {
  type Client,
  EDIT_PIN,
  login,
  OPERATE_PIN,
  song,
  startHub,
  type TestHub,
  tempDir,
} from './helpers.ts';
import { slidesOf, storeDeck, waitJob, zipDeck } from './pptx-helpers.ts';

// ── Pure: the plan and the merge ────────────────────────────────────────────────────────────────────────

const DECK = 'deck-hash';
const FULL = { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 };
const BOX = { x: 100, y: 100, w: 800, h: 200, rotation: 0 };
const PPTX = { src: 'pptx' } as const;

const text = (id: string, t: string, extra: Partial<TextObject> = {}): TextObject => ({
  id,
  type: 'text',
  box: { ...BOX },
  text: t,
  style: { ...DEFAULT_THEME.textBoxDefaults },
  opacity: 1,
  ...extra,
});
const image = (id: string, mediaId: string, extra: Partial<ImageObject> = {}): ImageObject => ({
  id,
  type: 'image',
  box: { ...FULL },
  mediaId,
  fit: 'contain',
  opacity: 1,
  radius: 0,
  ...extra,
});
const shape = (id: string, extra: Partial<ShapeObject> = {}): ShapeObject => ({
  id,
  type: 'shape',
  box: { ...BOX },
  shape: 'rect',
  opacity: 1,
  radius: 0,
  ...extra,
});

/** A slide as the native import stores it: parsed, its digest over its objects. */
function native(
  index: number,
  objects: SlideObject[],
  extra: Partial<Slide> = {},
  pptx: Partial<NonNullable<Slide['pptx']>> = {},
): Slide {
  const sl = Slide.parse({
    id: newId(),
    objects,
    pptx: { fileId: DECK, index, shown: index, class: 'native', version: 1, ...pptx },
    ...extra,
  });
  sl.pptx!.digest = digestOf(sl.objects);
  return sl;
}

/** A legacy picture page (before M3). */
const page = (n: number, objects: SlideObject[] = [], extra: Partial<Slide> = {}): Slide =>
  Slide.parse({
    id: newId(),
    objects,
    imported: { fileId: DECK, page: n, imageMediaId: `page-${n}`, textAligned: true },
    ...extra,
  });

function presentation(slides: Slide[][], source: Partial<NonNullable<Presentation['source']>> = {}) {
  const sections = slides.map((list, i) => ({ id: newId(), label: `S${i}`, short: `${i}`, slides: list }));
  return {
    id: newId(),
    rev: 3,
    title: 'Sunday',
    kind: 'slides',
    meta: { tags: [] },
    sections,
    arrangements: [{ id: newId(), name: 'Default', sectionIds: sections.map((s) => s.id).reverse() }],
    source: { kind: 'pptx', fileId: DECK, ...source },
    archived: false,
  } as Presentation;
}

/** A fresh deck from slides by deck index (hidden ones have no `shown`). */
function fresh(
  slides: [number, SlideObject[], Partial<Slide>?][],
  extra: Partial<FreshDeck> = {},
): FreshDeck {
  let shown = 0;
  return {
    slides: slides.map(([index, objects, o]) => {
      const hidden = o?.hidden === true;
      const sl = native(index, objects.map(withOrigin), o ?? {}, hidden ? { shown: undefined } : { shown });
      if (hidden) delete sl.pptx!.shown;
      const s = hidden ? undefined : shown++;
      return { index, ...(s !== undefined ? { shown: s } : {}), slide: sl };
    }),
    ...extra,
  };
}
const withOrigin = <T extends SlideObject>(o: T): T => (o.origin ? o : { ...o, origin: { ...PPTX } });

const tagsOf =
  (map: Record<string, string[]>): MediaTags =>
  (id) =>
    map[id];
const noTags: MediaTags = () => undefined;
const slidesIn = (p: Presentation) => p.sections.flatMap((s) => s.slides);

describe('the plan (GET, nothing read but the presentation)', () => {
  it('tells native, legacy page, made-editable and other slides apart', () => {
    const tagged = tagsOf({ pg: ['document'], photo: [] });
    const p = presentation([
      [
        native(0, [text('a', 'Welcome', { origin: PPTX })]),
        page(2),
        Slide.parse({ id: 'me', objects: [image('bottom', 'pg'), text('t', 'Offering')] }),
        Slide.parse({ id: 'photo', objects: [image('bottom2', 'photo')] }),
        Slide.parse({ id: 'typed', objects: [text('x', 'Typed in ordo')] }),
        { ...native(1, []), pptx: { ...native(1, []).pptx!, fileId: 'another-deck' } },
      ],
    ]);
    expect(reimportKinds(p, tagged)).toEqual(['native', 'page', 'made-editable', 'other', 'other', 'other']);
    // Not a PowerPoint import: nothing is a candidate.
    expect(reimportKinds({ ...p, source: { kind: 'pdf', fileId: DECK } }, tagged)).toEqual(
      Array(6).fill('other'),
    );
  });

  it('regenerates unedited native slides, keeps edited ones, replaces legacy ones unless kept', () => {
    const tagged = tagsOf({ pg: ['document'] });
    const clean = native(0, [text('a', 'Welcome', { origin: PPTX })]);
    // Objects added in ordo (no origin) do not make a slide edited.
    const added = native(1, [text('b', 'Notices', { origin: PPTX })]);
    added.objects.push(shape('mine'));
    const edited = native(2, [text('c', 'Offering', { origin: PPTX })]);
    edited.objects[0] = { ...(edited.objects[0] as TextObject), text: 'Offering today' };
    const copy = { ...native(3, []), pptx: { ...native(3, []).pptx!, digest: undefined } };
    const legacy = page(1, [shape('over')]);
    const made = Slide.parse({
      id: newId(),
      objects: [image('bottom', 'pg'), text('t', 'Offering'), shape('s')],
    });
    const p = presentation([
      [clean, added, edited, copy],
      [legacy, made],
    ]);
    expect([clean, added, edited, copy].map(unedited)).toEqual([true, true, false, false]);
    const plan = planReimport(p, {}, tagged);
    expect(plan).toMatchObject({ presentationId: p.id, fileId: DECK });
    expect(plan.slides.map((s) => [s.number, s.kind, s.action, s.userObjects])).toEqual([
      [1, 'native', 'regenerate', 0],
      [2, 'native', 'regenerate', 1],
      [3, 'native', 'keep-edited', 0],
      [4, 'native', 'keep-edited', 0],
      [5, 'page', 'replace', 1],
      [6, 'made-editable', 'replace', 1],
    ]);
    const asked = planReimport(p, { reset: [edited.id], keep: [made.id] }, tagged);
    expect(asked.slides.map((s) => s.action)).toEqual([
      'regenerate',
      'regenerate',
      'regenerate',
      'keep-edited',
      'replace',
      'keep',
    ]);
    // One slide asked for ('Make editable', 'Reset slide'): the others are kept.
    const one = planReimport(p, { slideIds: [legacy.id] }, tagged);
    expect(one.slides.map((s) => s.action)).toEqual(['keep', 'keep', 'keep', 'keep', 'replace', 'keep']);
  });
});

describe('the merge', () => {
  it('rebuilds unedited native slides keeping ids, settings and the objects added in ordo on top', () => {
    const user = shape('mine', { fill: { r: 255, g: 0, b: 0, a: 1 } });
    const s0 = native(0, [text('a', 'Welcome', { origin: PPTX })], {
      notes: 'My notes',
      durationMs: 5000,
      backgroundMediaId: 'bg-mine',
      transition: { kind: 'cut' },
    });
    s0.objects.push(user);
    const s1 = native(1, [text('b', 'Offering', { origin: PPTX })]);
    s1.objects[0] = { ...(s1.objects[0] as TextObject), text: 'Offering (edited)' };
    const typed = Slide.parse({ id: newId(), objects: [text('x', 'Typed')] });
    const p = presentation([[s0, s1], [typed]], {
      native: { version: 1, slides: 2, native: 2, hybrid: 0, picture: 0 },
      log: 'first import',
    });
    // A newer converter writes the first slide differently.
    const f = fresh(
      [
        [0, [text('A', 'Welcome!')], { notes: 'Deck notes', lyricObjectId: 'A' }],
        [1, [text('B', 'Offering')]],
      ],
      { whole: true, source: { kind: 'pptx', fileId: DECK, log: 'converted again' } },
    );
    const m = mergeReimport(p, f, {}, noTags);
    expect(m.counts).toEqual({ regenerated: 1, keptEdited: 1, replaced: 0, userObjects: 1 });
    const [a, b, c] = slidesIn(m.p);
    expect(a!.id).toBe(s0.id);
    expect(a!.objects.map((o) => o.id)).toEqual(['A', 'mine']);
    expect(a!.objects[1]).toEqual(user);
    expect(a).toMatchObject({
      notes: 'My notes',
      durationMs: 5000,
      backgroundMediaId: 'bg-mine',
      transition: { kind: 'cut' },
      lyricObjectId: 'A',
    });
    expect(a!.pptx!.digest).toBe(digestOf(a!.objects));
    expect(unedited(a!)).toBe(true);
    expect(b).toBe(s1);
    expect(c).toBe(typed);
    expect(m.p.arrangements).toEqual(p.arrangements);
    expect(m.p.sections.map((s) => s.id)).toEqual(p.sections.map((s) => s.id));
    expect(m.p.source!.log).toMatch(/^converted again\nre-imported from PowerPoint: 1 slide\(s\) rebuilt/);
    expect(m.p.source!.native).toMatchObject({ slides: 2, native: 2, hybrid: 0, picture: 0 });

    // Merging the same deck again changes nothing: the same object comes back (no revision is saved).
    const again = mergeReimport(m.p, f, {}, noTags);
    expect(again.p).toBe(m.p);
    expect(again.counts).toEqual({ regenerated: 0, keptEdited: 1, replaced: 0, userObjects: 0 });

    // 'Reset slide from PowerPoint': the edited slide is rebuilt.
    const reset = mergeReimport(m.p, { ...f, whole: false }, { slideIds: [s1.id], reset: [s1.id] }, noTags);
    expect(reset.counts).toEqual({ regenerated: 1, keptEdited: 0, replaced: 0, userObjects: 0 });
    const r = slidesIn(reset.p)[1]!;
    expect(r.id).toBe(s1.id);
    expect((r.objects[0] as TextObject).text).toBe('Offering');
    expect(slidesIn(reset.p)[0]).toBe(slidesIn(m.p)[0]);
    // A partial re-import appends to the import log.
    expect(reset.p.source!.log!.split('\n')).toHaveLength(3);
  });

  it('leaves a slide alone that the converter would write again as it is', () => {
    // Version 2 added the art; a fresh conversion is version 1 again, waiting for LibreOffice.
    const art = image('art', 'art-picture', { locked: true, origin: { src: 'pptx', role: 'art' } });
    const hybrid = native(0, [text('a', 'Chart', { origin: PPTX }), art], {}, { class: 'hybrid' });
    const p = presentation([[hybrid]]);
    const f = fresh([[0, [text('A', 'Chart')], {}]]);
    f.slides[0]!.slide.pptx = { ...f.slides[0]!.slide.pptx!, class: 'hybrid', pending: true };
    expect(mergeReimport(p, f, {}, noTags).p).toBe(p);
    // Unless it is reset, or LibreOffice failed on it: then it waits for LibreOffice again, with its plan.
    const plan: PptxLoSlide = {
      slideId: f.slides[0]!.slide.id,
      index: 0,
      shown: 0,
      class: 'hybrid',
      digest: 'v1',
      art: { elements: [], box: BOX, at: 1, replaces: [], text: '' } as never,
    };
    f.lo = [plan];
    const failed = presentation([[{ ...hybrid, pptx: { ...hybrid.pptx!, failed: true } }]]);
    const m = mergeReimport(failed, f, {}, noTags);
    expect(m.counts.regenerated).toBe(1);
    const sl = slidesIn(m.p)[0]!;
    expect(sl.pptx).toMatchObject({ pending: true, class: 'hybrid' });
    expect(sl.pptx!.failed).toBeUndefined();
    expect(m.lo).toEqual([{ ...plan, slideId: hybrid.id, digest: sl.pptx!.digest }]);
  });

  it('replaces legacy picture pages by their deck slides, by the shown-slide page rule', () => {
    const over = text('mine', 'Coffee after the service');
    const p = presentation([[page(1, [over], { notes: '' }), page(2, [], { notes: 'Pass the plate.' })]], {
      renderer: 'libreoffice',
    });
    // Deck slide 2 is hidden: LibreOffice printed slides 1 and 3 as pages 1 and 2.
    const f = fresh(
      [
        [0, [text('A', 'Welcome home')], { notes: 'Greet everyone' }],
        [1, [text('B', 'Prayer requests')], { hidden: true }],
        [2, [text('C', 'Offering')], { notes: 'Deck notes' }],
      ],
      { backgroundMediaId: 'deck-bg' },
    );
    const m = mergeReimport(p, f, {}, noTags);
    expect(m.counts).toEqual({ regenerated: 0, keptEdited: 0, replaced: 2, userObjects: 1 });
    const [one, two] = slidesIn(m.p);
    expect(one!.id).toBe(slidesIn(p)[0]!.id);
    expect(one!.imported).toBeUndefined();
    expect(one!.objects.map((o) => o.id)).toEqual(['A', 'mine']);
    expect(one).toMatchObject({ notes: 'Greet everyone', pptx: { index: 0, shown: 0, fileId: DECK } });
    expect(two!.objects.map((o) => (o as TextObject).text)).toEqual(['Offering']);
    expect(two).toMatchObject({ notes: 'Pass the plate.', pptx: { index: 2, shown: 1 } });
    // The deck's one background is the presentation's again: every slide came from the deck.
    expect(m.p.backgroundMediaId).toBe('deck-bg');
    expect(one!.backgroundMediaId).toBeUndefined();
    // It is a native import now (the follow-ups and the editor treat it as one).
    expect(m.p.source).toMatchObject({
      kind: 'pptx',
      renderer: 'libreoffice',
      native: { version: 1, slides: 2, native: 2, hybrid: 0, picture: 0 },
    });
  });

  it('keeps a legacy page whose deck slide is a picture again, and a page it cannot place', () => {
    const p = presentation([[page(1), page(7)]]);
    const f = fresh([[0, [], {}]]);
    f.slides[0]!.slide.pptx = { ...f.slides[0]!.slide.pptx!, class: 'picture', pending: true };
    const m = mergeReimport(p, f, {}, noTags);
    expect(m.p).toBe(p);
    expect(m.counts.replaced).toBe(0);
  });

  it('gives a background to the slides that took it when others stay as they are', () => {
    const p = presentation([[page(1), Slide.parse({ id: newId(), objects: [text('x', 'Typed')] })]]);
    const f = fresh([[0, [text('A', 'Welcome')]]], { backgroundMediaId: 'deck-bg' });
    const m = mergeReimport(p, f, {}, noTags);
    expect(m.p.backgroundMediaId).toBeUndefined();
    expect(slidesIn(m.p)[0]!.backgroundMediaId).toBe('deck-bg');
    expect(slidesIn(m.p)[1]!.backgroundMediaId).toBeUndefined();
  });

  it('replaces a made-editable slide’s page picture and the boxes that repeat the deck, keeping the rest', () => {
    const tagged = tagsOf({ pg: ['document'] });
    const made = Slide.parse({
      id: newId(),
      objects: [
        image('bottom', 'pg'),
        text('same', 'Offering'),
        text('spaced', ' Offering\n'),
        text('edited', 'Offering (second service)'),
        shape('logo'),
      ],
      notes: 'Pass the plate.',
    });
    const p = presentation([[page(1), made]]);
    const f = fresh([
      [0, [text('A', 'Welcome')]],
      [1, [text('C', 'Offering')]],
    ]);
    f.texts = [
      { index: 0, texts: ['Welcome'] },
      { index: 1, texts: ['Offering'] },
    ];
    // By its picture's name ('<title> – 2': page 2), else by the deck slide its boxes repeat.
    for (const names of [(id: string) => (id === 'pg' ? 'Sunday – 2' : undefined), undefined]) {
      const m = mergeReimport(p, f, {}, tagged, names);
      expect(m.counts).toEqual({ regenerated: 0, keptEdited: 0, replaced: 2, userObjects: 2 });
      const sl = slidesIn(m.p)[1]!;
      expect(sl.id).toBe(made.id);
      expect(sl.objects.map((o) => o.id)).toEqual(['C', 'edited', 'logo']);
      expect(sl.notes).toBe('Pass the plate.');
      expect(sl.pptx).toMatchObject({ index: 1 });
    }
    // 'Keep as it is' in the dialog.
    const kept = mergeReimport(p, f, { keep: [made.id] }, tagged);
    expect(slidesIn(kept.p)[1]).toBe(made);
    // A made-editable slide whose deck slide is unknown (no name, no matching text) stays.
    const lone = Slide.parse({ id: newId(), objects: [image('bottom', 'pg'), text('t', 'Elsewhere')] });
    const other = mergeReimport(presentation([[lone]]), f, {}, tagged);
    expect(other.counts.replaced).toBe(0);
  });

  it('places legacy pages and made-editable pictures on deck slides', () => {
    const tagged = tagsOf({ pg: ['document'] });
    const made = Slide.parse({ id: 'm', objects: [image('b', 'pg')] });
    const p = presentation([[page(1), page(2), made]], { renderer: 'libreoffice' });
    const listed = [
      { index: 0, hidden: false, shown: 0 },
      { index: 1, hidden: true },
      { index: 2, hidden: false, shown: 1 },
      { index: 3, hidden: false, shown: 2 },
    ];
    const at = deckIndexes(p, listed, tagged, (id) => (id === 'pg' ? 'Sunday – 3' : undefined));
    expect([...at.values()]).toEqual([0, 2, 3]);
    expect(pageFromName('Easter – 12')).toBe(12);
    expect(pageFromName('Easter - 3')).toBe(3);
    expect(pageFromName('Easter')).toBeUndefined();
    expect(pageFromName('Easter – 0')).toBeUndefined();
  });
});

describe('reimport.ts helpers', () => {
  it('queueReimport puts only the fields asked for in the payload', () => {
    const queued: unknown[] = [];
    const jobs = {
      enqueue: (kind: string, payload: unknown, cls: string) => {
        queued.push([kind, payload, cls]);
        return { id: 'j', kind } as Job;
      },
    };
    queueReimport({ jobs } as never, 'p1', 'h', { slideIds: ['s1'] }, 'edit');
    queueReimport({ jobs } as never, 'p2', 'h', {}, undefined, { extendBackgrounds: false });
    expect(queued).toEqual([
      ['pptx-reimport', { presentationId: 'p1', hash: 'h', by: 'edit', slideIds: ['s1'] }, 'light'],
      ['pptx-reimport', { presentationId: 'p2', hash: 'h', options: { extendBackgrounds: false } }, 'light'],
    ]);
    expect(PPTX_JOBS.reimport).toBe('pptx-reimport');
    expect(PPTX_JOB_CLASS['pptx-reimport']).toBe('light');
  });

  it('reads the first import’s options and the pictures earlier follow-ups stored', () => {
    const db = (rows: unknown[]) => ({ prepare: () => ({ get: () => rows[0], all: () => rows }) });
    const options = importOptionsOf(
      {
        lib: {
          db: db([{ payload: JSON.stringify({ options: { extendBackgrounds: false, x: 1 } }) }]),
        },
      } as never,
      'p',
      'h',
    );
    expect(options).toEqual({ extendBackgrounds: false });
    expect(importOptionsOf({ lib: { db: db([]) } } as never, 'p', 'h')).toBeUndefined();

    const elements = [{ shapeId: 4 }];
    const earlier = {
      payload: JSON.stringify({
        hash: 'h',
        slides: [
          { slideId: 's1', index: 0, shown: 0, class: 'hybrid', art: { elements } },
          { slideId: 's2', index: 1, shown: 1, class: 'picture' },
          { slideId: 's3', index: 2, shown: 2, class: 'hybrid', art: { elements: [{ shapeId: 9 }] } },
        ],
        done: [
          ['s1:art', 'art1'],
          ['s2:page', 'page2'],
          ['s3:art', 'art3'],
          ['mf:ppt/media/image1.emf', 'mf1'],
          ['mf:ppt/media/other.emf', 'mf2'],
          ['s1:gone', 'gone'],
        ],
        placed: [
          ['s1:art', BOX],
          ['s3:art', BOX],
        ],
      }),
    };
    const lib = { db: db([earlier]), media: { get: (id: string) => (id === 'gone' ? undefined : { id }) } };
    const plans: PptxLoSlide[] = [
      { slideId: 's1', index: 0, shown: 0, class: 'hybrid', digest: 'd', art: { elements } as never },
      { slideId: 's2', index: 1, shown: 1, class: 'picture', digest: 'd' },
      // The art of a slide whose elements changed is drawn again.
      { slideId: 's3', index: 2, shown: 2, class: 'hybrid', digest: 'd', art: { elements } as never },
      {
        slideId: 's4',
        index: 3,
        shown: 3,
        class: 'native',
        digest: 'd',
        metafiles: [['ppt/media/image1.emf', ['o']]],
      },
    ];
    expect(earlierWork({ lib } as never, 'p', 'h', plans)).toEqual({
      done: [
        ['s1:art', 'art1'],
        ['s2:page', 'page2'],
        ['mf:ppt/media/image1.emf', 'mf1'],
      ],
      placed: [['s1:art', BOX]],
    });
    expect(earlierWork({ lib } as never, 'p', 'another-deck', plans)).toEqual({});
  });
});

// ── Through the hub: the job on the real pool ───────────────────────────────────────────────────────────

const EMU = 914_400;
const enc = new TextEncoder();
const NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
const WELCOME = 'Welcome home';
const PRAYER = 'Prayer requests';
const OFFERING = 'Offering';

let hub: TestHub;
let ed: Client;
let dir: string;
let hash: string;
let photo: Uint8Array;

const box = (id: number, t: string, y = 1) =>
  sp({ id, x: EMU, y: y * EMU, cx: 8 * EMU, cy: EMU, txBox: true, txBody: body(para(run(t))) });

/** Speaker notes for deck slide `n` (1-based). */
function withNotes(parts: Map<string, Uint8Array>, n: number, t: string): void {
  parts.set(
    `ppt/notesSlides/notesSlide${n}.xml`,
    enc.encode(
      `<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
        `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>` +
        `<p:txBody><a:bodyPr/>${para(run(t))}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    ),
  );
}

beforeAll(async () => {
  hub = await startHub();
  ed = await login(hub.url, EDIT_PIN);
  dir = tempDir('ordo-reimport-');
  mkdirSync(join(dir, 'media'), { recursive: true });
  photo = await readFile(
    ffmpeg(join(dir, 'media'), 'photo.png', ['-f', 'lavfi', '-i', 'color=c=red:s=320x180', '-frames:v', '1']),
  );
  // Three slides, the second hidden: LibreOffice printed slides 1 and 3 as pages 1 and 2.
  const parts = buildDeck({
    slides: [
      {
        shapes: box(2, WELCOME) + sp({ id: 3, x: 0, y: 5 * EMU, cx: EMU, cy: EMU, fill: solid('336699') }),
        rels: [{ id: 'rId8', type: 'notesSlide', target: '../notesSlides/notesSlide1.xml' }],
      },
      { shapes: box(2, PRAYER), hidden: true },
      {
        shapes:
          box(2, OFFERING) + pic({ id: 4, x: 5 * EMU, y: 2 * EMU, cx: 3 * EMU, cy: 2 * EMU, rId: 'rId2' }),
        rels: [imageRel('rId2', '../media/image1.png')],
      },
    ],
    media: { 'ppt/media/image1.png': photo },
  });
  withNotes(parts, 1, 'Greet everyone');
  hash = await storeDeck(hub, await zipDeck(parts, dir));
}, 60_000);
afterAll(async () => {
  await hub?.cleanup();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A page picture as the 'Pictures (LibreOffice)' import stored it: tagged 'document', '<title> – N'. */
async function pagePicture(n: number): Promise<string> {
  const file = ffmpeg(join(dir, 'media'), `page-${n}.png`, [
    '-f',
    'lavfi',
    '-i',
    `color=c=gray:s=192x108`,
    '-frames:v',
    '1',
  ]);
  const m = await hub.media.addReadyImage(file, `Sunday – ${n}`, {
    width: 1920,
    height: 1080,
    tags: ['document'],
  });
  return m.id;
}

/**
 * A presentation as an older build imported the deck as pictures: page 1 with a box added over it, page 2
 * made editable by the older 'Make editable' (the page picture at the bottom, the extracted text over it,
 * the page record gone) with a shape added, and a slide typed in ordo.
 */
async function legacy(): Promise<Presentation> {
  const sid = newId();
  const p: Presentation = {
    id: newId(),
    rev: 1,
    title: 'Sunday',
    kind: 'slides',
    meta: { tags: [] },
    sections: [
      {
        id: sid,
        label: 'Slides',
        short: 'S',
        slides: [
          Slide.parse({
            id: newId(),
            objects: [text(newId(), 'Coffee after the service')],
            imported: { fileId: hash, page: 1, imageMediaId: await pagePicture(1), textAligned: true },
          }),
          Slide.parse({
            id: newId(),
            objects: [image(newId(), await pagePicture(2)), text(newId(), OFFERING), shape(newId())],
            notes: 'Pass the plate.',
          }),
          Slide.parse({ id: newId(), objects: [text(newId(), 'Typed in ordo')] }),
        ],
      },
    ],
    arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid, sid] }],
    source: { kind: 'pptx', fileId: hash, renderer: 'libreoffice' },
    archived: false,
  };
  return hub.lib.savePresentation(p, { create: true, by: 'pptx-import' });
}

async function reimport(id: string, req: Record<string, unknown> = {}): Promise<Job> {
  const res = await ed.fetch(`/presentations/${id}/pptx-reimport`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  expect(res.status, await res.clone().text()).toBe(202);
  const job = await waitJob(hub, ((await res.json()) as Job).id, 120_000);
  expect(job.state, `${job.error}\n${job.log.join('\n')}`).toBe('done');
  return job;
}

const textsOf = (s: Slide) => s.objects.filter((o) => o.type === 'text').map((o) => (o as TextObject).text);

describe("'Re-import from PowerPoint' through the hub", () => {
  it('makes a legacy picture deck and a made-editable slide editable, as one revision, nothing doubled', async () => {
    const before = await legacy();
    const [page1, made, typed] = slidesOf(before);
    const plan = await ed.json<PptxReimportPlan>(`/presentations/${before.id}/pptx-reimport`);
    expect(plan.slides.map((s) => [s.kind, s.action])).toEqual([
      ['page', 'replace'],
      ['made-editable', 'replace'],
      ['other', 'keep'],
    ]);

    const job = await reimport(before.id);
    const result = job.result as PptxReimportResult;
    expect(result).toEqual({
      presentationId: before.id,
      rev: before.rev + 1,
      regenerated: 0,
      keptEdited: 0,
      replaced: 2,
      userObjects: 2,
    });
    const after = hub.lib.presentations.must(before.id);
    expect(after.rev).toBe(before.rev + 1);
    expect(hub.lib.revisions(before.id).find((r) => r.rev === after.rev)?.savedBy).toBe(REIMPORT_BY);
    // Slide ids, sections and the arrangement are kept; the typed slide is untouched.
    expect(after.sections.map((s) => s.id)).toEqual(before.sections.map((s) => s.id));
    expect(after.arrangements).toEqual(before.arrangements);
    const [one, two, three] = slidesOf(after);
    expect([one!.id, two!.id, three!.id]).toEqual([page1!.id, made!.id, typed!.id]);
    expect(three).toEqual(typed);
    // Page 1 is deck slide 1, native, the box added over the page on top; its notes come from the deck.
    expect(one!.imported).toBeUndefined();
    expect(one!.pptx).toMatchObject({ fileId: hash, index: 0, shown: 0, class: 'native' });
    expect(one!.objects.at(-1)).toEqual(page1!.objects[0]);
    expect(textsOf(one!)).toEqual([WELCOME, 'Coffee after the service']);
    expect(one!.notes).toBe('Greet everyone');
    // Page 2 is deck slide 3 (slide 2 is hidden): the page picture and the repeated box are gone, the
    // shape stays on top, and its own notes are kept. Nothing is doubled.
    expect(two!.pptx).toMatchObject({ index: 2, shown: 1 });
    expect(textsOf(two!)).toEqual([OFFERING]);
    expect(
      two!.objects.some((o) => o.type === 'image' && o.mediaId === (made!.objects[0] as ImageObject).mediaId),
    ).toBe(false);
    expect(two!.objects.filter((o) => o.type === 'image')).toHaveLength(1);
    expect(two!.objects.at(-1)).toEqual(made!.objects[2]);
    expect(two!.notes).toBe('Pass the plate.');
    for (const s of [one!, two!]) {
      expect(unedited(s)).toBe(true);
      for (const o of s.objects.slice(0, -1)) expect(o.origin?.src).toBe('pptx');
    }
    expect(after.source).toMatchObject({ kind: 'pptx', fileId: hash, native: { slides: 2, native: 2 } });
    expect(after.source!.log).toContain('re-imported from PowerPoint: 0 slide(s) rebuilt, 2 legacy slide(s)');

    // Again: nothing to change, nothing saved.
    const again = (await reimport(before.id)).result as PptxReimportResult;
    expect(again.rev).toBeUndefined();
    expect(hub.lib.presentations.must(before.id).rev).toBe(after.rev);
  }, 180_000);

  it('keeps edited native slides unless reset, and the objects added in ordo on top', async () => {
    const queued = hub.imports.pptx.queueNative(hash, 'Sunday.pptx');
    const imp = await waitJob(hub, queued.id, 120_000);
    expect(imp.state, imp.log.join('\n')).toBe('done');
    const p0 = hub.lib.presentations.must((imp.result as { presentationId: string }).presentationId);
    const [s0, s1] = slidesOf(p0);
    const t0 = s0!.objects.findIndex((o) => o.type === 'text');
    const edited: Slide = {
      ...s0!,
      objects: s0!.objects.map((o, i) => (i === t0 ? { ...(o as TextObject), text: 'Welcome back' } : o)),
    };
    const added: Slide = { ...s1!, objects: [...s1!.objects, text(newId(), 'Added in ordo')] };
    const p1 = hub.lib.savePresentation(
      {
        ...p0,
        sections: p0.sections.map((sec) => ({ ...sec, slides: [edited, added, ...sec.slides.slice(2)] })),
      },
      { expectedRev: p0.rev, by: 'edit' },
    );
    // Nothing the converter would write differently: the edited slide is kept, nothing is saved.
    const r1 = (await reimport(p1.id)).result as PptxReimportResult;
    expect(r1).toMatchObject({ regenerated: 0, keptEdited: 1, replaced: 0 });
    expect(r1.rev).toBeUndefined();
    // 'Reset slide from PowerPoint' on the edited slide.
    const r2 = (await reimport(p1.id, { slideIds: [s0!.id], reset: [s0!.id] })).result as PptxReimportResult;
    expect(r2).toMatchObject({ regenerated: 1, keptEdited: 0, rev: p1.rev + 1 });
    const p2 = hub.lib.presentations.must(p1.id);
    const [r0, r1s] = slidesOf(p2);
    expect(r0!.id).toBe(s0!.id);
    expect(textsOf(r0!)).toEqual([WELCOME]);
    expect(r0!.notes).toBe('Greet everyone');
    expect(r1s).toEqual(slidesOf(p1)[1]);
    expect(textsOf(r1s!).at(-1)).toBe('Added in ordo');
  }, 180_000);

  it("reroutes 'Make editable' on a legacy page to the native re-import of that page", async () => {
    const p = await legacy();
    const [page1, made] = slidesOf(p);
    const res = await ed.fetch(`/presentations/${p.id}/slides/${page1!.id}/make-editable`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    const queued = (await res.json()) as Job;
    expect(queued.kind).toBe('pptx-reimport');
    const job = await waitJob(hub, queued.id, 120_000);
    expect(job.state, job.log.join('\n')).toBe('done');
    expect(job.result).toMatchObject({ replaced: 1, userObjects: 1 });
    const after = hub.lib.presentations.must(p.id);
    const [one, two] = slidesOf(after);
    expect(one!.pptx).toMatchObject({ index: 0 });
    expect(textsOf(one!)).toEqual([WELCOME, 'Coffee after the service']);
    // Only that page: the made-editable slide is as it was.
    expect(two).toEqual(made);
    // A page whose deck is not stored keeps today's 'Make editable' (text boxes over the picture).
    const pdf = hub.lib.savePresentation(
      {
        ...p,
        id: newId(),
        source: { kind: 'pdf', fileId: hash },
        sections: [
          {
            ...p.sections[0]!,
            slides: [
              Slide.parse({
                id: newId(),
                objects: [],
                imported: {
                  fileId: hash,
                  page: 1,
                  imageMediaId: page1!.imported!.imageMediaId,
                  textBoxes: [{ text: 'Page text', box: BOX }],
                },
              }),
            ],
          },
        ],
      },
      { create: true },
    );
    const slideId = pdf.sections[0]!.slides[0]!.id;
    const legacyRes = await ed.fetch(`/presentations/${pdf.id}/slides/${slideId}/make-editable`, {
      method: 'POST',
    });
    expect(legacyRes.status).toBe(200);
    const converted = (await legacyRes.json()) as Presentation;
    expect(textsOf(converted.sections[0]!.slides[0]!)).toEqual(['Page text']);
  }, 180_000);

  it('refuses without a stored deck, a bad body, and writes nothing while live', async () => {
    const plain = await ed.json<Presentation>('/presentations', { method: 'POST', json: song() });
    expect((await ed.fetch(`/presentations/${plain.id}/pptx-reimport`, { method: 'POST' })).status).toBe(400);
    expect((await ed.fetch(`/presentations/${plain.id}/pptx-reimport`)).status).toBe(400);
    const p = await legacy();
    const bad = await ed.fetch(`/presentations/${p.id}/pptx-reimport`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ everything: true }),
    });
    expect(bad.status).toBe(400);

    const op = await login(hub.url, OPERATE_PIN);
    const pl = await ed.json<Playlist>('/playlists', {
      method: 'POST',
      json: { name: 'Sunday', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
    });
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    try {
      expect((await ed.fetch(`/presentations/${p.id}/pptx-reimport`, { method: 'POST' })).status).toBe(423);
      // A job queued before the service began waits: it defers itself and writes nothing.
      const job = hub.imports.pptx.queueReimport(p.id, hash, {});
      const t0 = Date.now();
      while (!hub.jobs.get(job.id).log.some((l) => l.includes('waiting')) && Date.now() - t0 < 10_000)
        await new Promise((r) => setTimeout(r, 20));
      const waiting = hub.jobs.get(job.id);
      expect(waiting.state).toBe('queued');
      expect(waiting.log.join('\n')).toContain('the presentation is live');
      // The same request again joins it.
      expect(hub.imports.pptx.queueReimport(p.id, hash, {}).id).toBe(job.id);
      expect(hub.lib.presentations.must(p.id).rev).toBe(p.rev);
    } finally {
      await op.json('/live/events', { method: 'POST', json: { k: 'endService', at: Date.now() } });
    }
  }, 60_000);

  it("waits for the presentation's LibreOffice follow-up, whose plans name the slides as they are", async () => {
    const p = await legacy();
    const lo = newId();
    const now = new Date().toISOString();
    hub.lib.db
      .prepare(
        `INSERT INTO jobs (id, kind, class, state, progress, payload, log, result, created_at, updated_at)
         VALUES (?, 'pptx-lo', 'heavy', 'running', 0, ?, '[]', NULL, ?, ?)`,
      )
      .run(lo, JSON.stringify({ presentationId: p.id, hash, version: 1, slides: [] }), now, now);
    try {
      const job = hub.imports.pptx.queueReimport(p.id, hash, {});
      const t0 = Date.now();
      while (!hub.jobs.get(job.id).log.some((l) => l.includes('waiting')) && Date.now() - t0 < 10_000)
        await new Promise((r) => setTimeout(r, 20));
      const waiting = hub.jobs.get(job.id);
      expect(waiting.state).toBe('queued');
      expect(waiting.log.join('\n')).toContain('LibreOffice is still drawing part of this presentation');
      expect(hub.lib.presentations.must(p.id).rev).toBe(p.rev);
    } finally {
      hub.lib.db.prepare(`DELETE FROM jobs WHERE id = ?`).run(lo);
    }
  }, 60_000);
});
