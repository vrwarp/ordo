/**
 * M4 item F (design/27 §11 item 12, "Round trip and migration", §15 M4; apps/operator/src/views/editor/M4.md):
 * the editor's PowerPoint card ('Show the PowerPoint picture on the screens' guarded by the digest, 'Reset
 * slide from PowerPoint', the fonts to upload), the Presentation panel's import report and 'Re-import from
 * PowerPoint…' dialog, the readers they use, the slide op through the editor store, and a re-import job
 * followed and taken over. Components are rendered to markup, as `pptxImportUi.test.ts` does.
 */
import {
  DEFAULT_THEME,
  type Presentation,
  type ShapeObject,
  Slide,
  type SlideObject,
  type TextObject,
} from '@ordo/domain';
import type { Job, PptxReimportPlan } from '@ordo/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The hub's digest (the operator must compute the same one to tell an edited slide).
import { digestOf } from '../../../packages/pptx-scene/src/emit.ts';
import {
  approximatedSlides,
  importReport,
  treatAsSlides,
  isImportJob,
  missingSlideFonts,
  objectsDigest,
  onlyJobSaves,
  PPTX_JOB_SAVERS,
  showObjects,
  showPicture,
  slideEdited,
} from '../src/lib/pptxImport.ts';
import { planSummary, readReimportResult, reimportMessage } from '../src/lib/pptxReimport.ts';
import { useToasts } from '../src/state/toasts.ts';
import { setSlideShows } from '../src/views/editor/actions.ts';
import { openPresentation, undo, useEditor } from '../src/views/editor/editorStore.ts';
import { LoopDeckBanner, PptxReportView, ReimportDialogView } from '../src/views/editor/PptxReport.tsx';
import { PptxSlideCardView } from '../src/views/editor/PptxSlideCard.tsx';
import {
  followReimport,
  isJob,
  rebuildsFromPptx,
  reimportRunning,
  useReimport,
} from '../src/views/editor/pptxJobs.ts';

const noop = () => undefined;
/** Markup as text: tags removed, entities decoded, spaces collapsed. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const BOX = { x: 10, y: 10, w: 400, h: 100, rotation: 0 };
const PPTX = { src: 'pptx' } as const;
const textObj = (id: string, t: string, extra: Partial<TextObject> = {}): TextObject => ({
  id,
  type: 'text',
  box: { ...BOX },
  text: t,
  style: { ...DEFAULT_THEME.textBoxDefaults },
  opacity: 1,
  ...extra,
});
const shapeObj = (id: string, extra: Partial<ShapeObject> = {}): ShapeObject => ({
  id,
  type: 'shape',
  box: { ...BOX },
  shape: 'rect',
  opacity: 1,
  radius: 0,
  ...extra,
});

/** A slide as the hub stores a native import's: parsed, its digest over its objects. */
function imported(objects: SlideObject[], pptx: Record<string, unknown> = {}, extra: Partial<Slide> = {}) {
  const sl = Slide.parse({
    id: `s${Math.random().toString(36).slice(2, 8)}`,
    objects,
    pptx: { fileId: 'deck', index: 0, shown: 0, class: 'native', version: 1, ...pptx },
    ...extra,
  });
  sl.pptx!.digest = digestOf(sl.objects);
  return sl;
}

describe('telling an edited PowerPoint slide (the digest)', () => {
  it('computes the hub’s digest', () => {
    const objects = Slide.parse({
      id: 's',
      objects: [textObj('a', 'Welcome ✝ שלום', { origin: PPTX }), shapeObj('b', { origin: PPTX })],
    }).objects;
    expect(objectsDigest(objects)).toBe(digestOf(objects));
    expect(objectsDigest([])).toBe(digestOf([]));
  });

  it('counts edits of the imported objects, not objects added in ordo', () => {
    const sl = imported([textObj('a', 'Welcome', { origin: PPTX })]);
    expect(slideEdited(sl)).toBe(false);
    expect(slideEdited({ ...sl, objects: [...sl.objects, shapeObj('mine')] })).toBe(false);
    const typo = { ...sl, objects: [textObj('a', 'Welcme', { origin: PPTX })] };
    expect(slideEdited(Slide.parse(typo))).toBe(true);
    expect(slideEdited({ ...sl, pptx: { ...sl.pptx!, digest: undefined } })).toBe(true);
    expect(slideEdited({ id: 'x', objects: [] } as never)).toBe(false);
  });
});

describe('the fonts a slide needs', () => {
  it('names families the hub lacks, unless a metric-compatible fallback it has keeps the line breaks', () => {
    const slide = (o: SlideObject[]) => ({ objects: o });
    const style = (fontFamily: string, fallbackFonts?: string[]) => ({
      ...DEFAULT_THEME.textBoxDefaults,
      fontFamily,
      ...(fallbackFonts ? { fallbackFonts } : {}),
    });
    const slides = [
      slide([
        textObj('a', 'x', { style: style('Century Gothic') }),
        textObj('b', 'y', { style: style('Calibri', ['Carlito']) }),
        textObj('c', 'z', {
          style: style('Inter'),
          runs: [{ start: 0, end: 1, fontFamily: 'Segoe Script' }],
        }),
      ]),
      slide([
        textObj('d', 'w', { style: style('century gothic') }),
        textObj('e', 'v', { style: style('serif') }),
      ]),
    ];
    expect(missingSlideFonts(slides, ['Inter', 'Carlito'])).toEqual(['Century Gothic', 'Segoe Script']);
    // Without the fallback in the box, Carlito does not stand in for Calibri.
    expect(missingSlideFonts([slide([textObj('b', 'y', { style: style('Calibri') })])], ['Carlito'])).toEqual(
      ['Calibri'],
    );
    expect(missingSlideFonts(slides, ['Inter', 'Carlito'], 1)).toEqual(['Century Gothic']);
  });
});

describe('showing the PowerPoint picture on the screens (a slide op)', () => {
  it('needs the picture, and keeps identity when nothing changes', () => {
    const none = imported([]);
    expect(showPicture(none)).toBe(none);
    const has = imported([], { refMediaId: 'ref' });
    const on = showPicture(has);
    expect(on.pptx!.show).toBe('picture');
    expect(showPicture(on)).toBe(on);
    expect(showObjects(on).pptx!.show).toBeUndefined();
  });

  it('is one undo step through the editor store, and nothing without a picture', () => {
    const with_ = imported([], { refMediaId: 'ref' });
    const without = imported([], { index: 1 });
    const p = {
      id: 'p1',
      rev: 2,
      title: 'Sunday',
      kind: 'slides',
      meta: { tags: [] },
      sections: [{ id: 'sec', label: 'S', short: 'S', slides: [with_, without] }],
      arrangements: [],
      source: { kind: 'pptx', fileId: 'deck' },
      archived: false,
    } as Presentation;
    openPresentation(p);
    setSlideShows(without.id, 'picture');
    expect(useEditor.getState().dirty).toBe(false);
    setSlideShows(with_.id, 'picture');
    const s = useEditor.getState();
    expect(s.dirty).toBe(true);
    expect(s.draft!.sections[0]!.slides[0]!.pptx!.show).toBe('picture');
    undo();
    expect(useEditor.getState().draft!.sections[0]!.slides[0]!.pptx!.show).toBeUndefined();
  });
});

describe('the PowerPoint card', () => {
  const card = (s: Slide, o: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(PptxSlideCardView, {
        slide: s,
        readOnly: false,
        on: false,
        onToggle: noop,
        onShowObjects: noop,
        onShowPicture: noop,
        onReset: noop,
        ...o,
      }),
    );
  const button = (html: string, label: string) =>
    html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];

  it('names the fonts to upload with a link to the Fonts tab', () => {
    const html = card(imported([]), { missingFonts: ['Century Gothic', 'Segoe Script'] });
    expect(text(html)).toContain('Fonts this hub does not have: Century Gothic, Segoe Script.');
    expect(html).toMatch(/<a class="btn small" href="#\/library\/fonts"[^>]*>Upload font<\/a>/);
    expect(card(imported([]))).not.toContain('data-missing-fonts');
  });

  it("offers 'Show the PowerPoint picture on the screens', warning when the slide was edited", () => {
    const fresh = card(imported([], { refMediaId: 'ref' }));
    expect(button(fresh, 'Show the PowerPoint picture on the screens')).not.toContain('disabled');
    expect(text(fresh)).toContain('the screens show the picture instead of its objects');
    const edited = card(imported([], { refMediaId: 'ref' }), { edited: true });
    expect(text(edited)).toContain('Edited in ordo since the import.');
    expect(text(edited)).toContain('without the changes made in ordo');
    // Without a picture yet it is offered too (LibreOffice draws it first), but not while live.
    expect(button(card(imported([])), 'Show the PowerPoint picture on the screens')).toBeDefined();
    expect(
      button(card(imported([]), { readOnly: true }), 'Show the PowerPoint picture on the screens'),
    ).toContain('disabled');
    // A picture slide is a picture already; a slide set to show it says so, with the warning when edited.
    expect(card(imported([], { class: 'picture' }))).not.toContain('data-show-picture');
    const shows = card(imported([], { refMediaId: 'ref', show: 'picture' }), { edited: true });
    expect(shows).not.toContain('data-show-picture');
    expect(text(shows)).toContain('The picture does not show the changes made in ordo since the import.');
    expect(text(shows)).toContain('Show the objects instead');
  });

  it("offers 'Reset slide from PowerPoint' for an edited slide or one LibreOffice failed on", () => {
    const clean = card(imported([]));
    expect(button(clean, 'Reset slide from PowerPoint')).toContain('disabled');
    expect(text(clean)).toContain('Nothing to reset: the slide is as it was imported.');
    const edited = card(imported([]), { edited: true });
    expect(button(edited, 'Reset slide from PowerPoint')).not.toContain('disabled');
    expect(text(edited)).toContain('Objects you added in ordo stay on top.');
    const failed = card(imported([], { failed: true }));
    expect(button(failed, 'Reset slide from PowerPoint')).not.toContain('disabled');
    expect(text(failed)).toContain('LibreOffice could not draw part of this slide');
    expect(
      button(card(imported([]), { edited: true, readOnly: true }), 'Reset slide from PowerPoint'),
    ).toContain('disabled');
  });

  it('shows a reset running and failing', () => {
    const s = imported([]);
    const running = card(s, {
      edited: true,
      reimport: { id: 'j', what: 'reset', slideId: s.id, state: 'running', progress: 0.5 },
    });
    expect(button(running, 'Reset slide from PowerPoint')).toContain('disabled');
    expect(running).toMatch(/role="status"[^>]*>Resetting the slide from the PowerPoint file \(50%\)/);
    // Another slide's re-import only disables the button.
    const other = card(s, {
      edited: true,
      reimport: { id: 'j', what: 'reimport', state: 'running', progress: 0.5 },
    });
    expect(text(other)).toContain('A re-import of this presentation is running.');
    const failed = card(s, {
      edited: true,
      reimport: { id: 'j', what: 'reset', slideId: s.id, state: 'failed', progress: 0, error: 'deck gone' },
    });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain('The slide could not be reset from PowerPoint: deck gone');
  });

  it('renders deck strings as text', () => {
    const html = card(imported([], { notes: ['<img src=x onerror=alert(1)>'] }), {
      missingFonts: ['<b>Font</b>'],
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>Font');
  });
});

describe('the import report', () => {
  const p = (slides: Slide[], source: Record<string, unknown>): Presentation =>
    ({
      id: 'p1',
      rev: 1,
      title: 'Sunday',
      kind: 'slides',
      meta: { tags: [] },
      sections: [{ id: 'sec', label: 'S', short: 'S', slides }],
      arrangements: [],
      source: { kind: 'pptx', fileId: 'deck', ...source },
      archived: false,
    }) as Presentation;
  const edited = Slide.parse({ ...imported([]), objects: [textObj('t', 'Typo', { origin: PPTX })] });
  const nativeP = p(
    [
      imported([], { notes: ['kerning differs'] }),
      imported([], { index: 1, pending: true, class: 'hybrid' }),
      imported([], { index: 2, failed: true }, { hidden: true }),
      edited,
    ],
    {
      native: { version: 1, slides: 4, native: 3, hybrid: 1, picture: 0 },
      log: 'line one\n[warn] slide 3: a picture could not be imported\n\nfont not available: Century Gothic',
    },
  );

  it('reads the counts and the log of a native import, and a legacy one', () => {
    const r = importReport(nativeP)!;
    expect(r).toMatchObject({
      native: { slides: 4, native: 3, hybrid: 1, picture: 0, version: 1 },
      pages: 0,
      pending: 1,
      failed: 1,
      hidden: 1,
      edited: 1,
      logMore: 0,
    });
    expect(r.log).toEqual([
      { text: 'line one', warn: false },
      { text: 'slide 3: a picture could not be imported', warn: true },
      { text: 'font not available: Century Gothic', warn: false },
    ]);
    const legacy = importReport(
      p(
        [
          Slide.parse({ id: 'a', objects: [], imported: { fileId: 'deck', page: 1, imageMediaId: 'm' } }),
          Slide.parse({ id: 'b', objects: [], imported: { fileId: 'deck', page: 2, imageMediaId: 'n' } }),
        ],
        { renderer: 'libreoffice' },
      ),
    )!;
    expect(legacy).toMatchObject({ pages: 2, renderer: 'libreoffice', log: [] });
    expect(legacy.native).toBeUndefined();
    expect(importReport({ ...nativeP, source: { kind: 'pro7' } })).toBeUndefined();
    const long = importReport(p([], { log: Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n') }))!;
    expect(long.log).toHaveLength(200);
    expect(long.log[0]!.text).toBe('line 50');
    expect(long.logMore).toBe(50);
  });

  const view = (o: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(PptxReportView, {
        report: importReport(nativeP)!,
        approx: approximatedSlides(nativeP),
        missingFonts: [],
        readOnly: false,
        onReimport: noop,
        onOpenSlide: noop,
        ...o,
      }),
    );

  it("a loop deck's line on the stage: what it does, Treat as slides (off while locked) and the report", () => {
    const line = (readOnly: boolean) =>
      renderToStaticMarkup(
        createElement(LoopDeckBanner, { readOnly, onTreatAsSlides: noop, onReport: noop, onKeep: noop }),
      );
    const t = text(line(false));
    expect(t).toContain('PowerPoint plays this deck as a loop');
    expect(t).toContain('the Stage and the Bottom-Third Stream show none of its words');
    expect(line(false)).toMatch(/<button[^>]*>Treat as slides<\/button>/);
    expect(line(false)).toMatch(/<button[^>]*>Import report<\/button>/);
    expect(line(false)).toMatch(/<button[^>]*>Keep as a loop<\/button>/);
    expect(line(true)).toMatch(/<button[^>]*disabled=""[^>]*>Treat as slides<\/button>/);
  });

  it('shows what the import made, what waits, what failed and the approximated slides', () => {
    const html = view({ missingFonts: ['Century Gothic'] });
    expect(html).toContain('aria-label="Imported from PowerPoint"');
    const t = text(html);
    expect(t).toContain('3 editable');
    expect(t).toContain('1 partly a picture');
    expect(t).toContain('1 hidden slide');
    expect(t).toContain('1 slide edited in ordo since the import: a re-import keeps it as it is.');
    expect(t).toContain('LibreOffice is still drawing part of 1 slide.');
    expect(t).toContain('LibreOffice could not draw 1 slide');
    expect(html).toMatch(/href="#\/library\/fonts"[^>]*>Upload fonts</);
    expect(html).toMatch(/<button type="button" class="small ghost">Slide 1<\/button>/);
    expect(t).toContain('Import log (3 lines)');
    expect(t).toContain('warning slide 3: a picture could not be imported');
    expect(html).toMatch(/<button[^>]*>Re-import from PowerPoint…<\/button>/);
  });

  it('says what an announcement loop does on the screens and treats it as slides in one tap', () => {
    const loopP = { ...nativeP, kind: 'loop', loop: { defaultSlideMs: 6000 } } as Presentation;
    expect(importReport(nativeP)!.loop).toBeUndefined();
    const r = importReport(loopP)!;
    expect(r.loop).toBe(true);
    const html = renderToStaticMarkup(
      createElement(PptxReportView, {
        report: r,
        approx: { slides: [], more: 0 },
        missingFonts: [],
        readOnly: false,
        onReimport: noop,
        onOpenSlide: noop,
        onTreatAsSlides: noop,
      }),
    );
    expect(html).toContain('data-loop');
    const t = text(html);
    expect(t).toContain('PowerPoint plays this deck as a loop');
    expect(t).toContain('the Stage shows “Service Starting Soon” and the Bottom-Third Stream shows nothing');
    expect(html).toMatch(/<button type="button" class="small"[^>]*>Treat as slides<\/button>/);
    expect(view()).not.toContain('data-loop');
    // Read-only (live): the button is there, disabled.
    const ro = renderToStaticMarkup(
      createElement(PptxReportView, {
        report: r,
        approx: { slides: [], more: 0 },
        missingFonts: [],
        readOnly: true,
        onReimport: noop,
        onOpenSlide: noop,
      }),
    );
    expect(ro).toMatch(/<button[^>]*disabled=""[^>]*>Treat as slides<\/button>/);
    // The switch: a slide deck, without the loop's settings, its slides (and their timings) as they were.
    const s = treatAsSlides(loopP);
    expect(s.kind).toBe('slides');
    expect(s).not.toHaveProperty('loop');
    expect(s.sections).toBe(loopP.sections);
    expect(treatAsSlides(nativeP)).toBe(nativeP);
  });

  it('says what a legacy import is and when the re-import cannot run', () => {
    const legacy = renderToStaticMarkup(
      createElement(PptxReportView, {
        report: { pages: 3, pending: 0, failed: 0, missing: 0, hidden: 0, edited: 0, log: [], logMore: 0 },
        approx: { slides: [], more: 0 },
        missingFonts: [],
        readOnly: true,
        onReimport: noop,
        onOpenSlide: noop,
      }),
    );
    expect(text(legacy)).toContain('Imported as pictures (LibreOffice): its text is not editable.');
    expect(legacy).toMatch(/<button[^>]*disabled=""[^>]*>Re-import from PowerPoint…/);
    expect(text(legacy)).toContain('can be re-imported after the service');
    const running = view({ run: { id: 'j', what: 'reimport', state: 'running', progress: 0.3 } });
    expect(running).toMatch(/<button[^>]*disabled=""[^>]*>Re-import from PowerPoint…/);
    expect(running).toContain('role="progressbar"');
    expect(text(running)).toContain('Re-importing from PowerPoint (30%).');
    const failed = view({
      run: { id: 'j', what: 'reimport', state: 'failed', progress: 0, error: 'no pool' },
    });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain('The re-import failed: no pool');
  });
});

describe("the 'Re-import from PowerPoint' dialog", () => {
  const plan: PptxReimportPlan = {
    presentationId: 'p1',
    fileId: 'deck',
    slides: [
      { slideId: 'a', number: 1, kind: 'native', action: 'regenerate', userObjects: 1 },
      { slideId: 'b', number: 2, kind: 'native', action: 'keep-edited', userObjects: 0 },
      { slideId: 'c', number: 3, kind: 'page', action: 'replace', userObjects: 2 },
      { slideId: 'd', number: 4, kind: 'made-editable', action: 'replace', userObjects: 1 },
      { slideId: 'e', number: 5, kind: 'other', action: 'keep', userObjects: 0 },
    ],
  };
  const dialog = (o: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(ReimportDialogView, {
        plan,
        keep: new Set<string>(),
        dirty: false,
        onKeep: noop,
        onConfirm: noop,
        onClose: noop,
        ...o,
      }),
    );

  it('summarises the plan', () => {
    expect(planSummary(plan)).toEqual({
      rebuild: 1,
      keptEdited: 1,
      pages: 1,
      madeEditable: [plan.slides[3]],
      other: 1,
      userObjects: 4,
    });
    const t = text(dialog({ dirty: true }));
    expect(t).toContain('1 slide not edited in ordo is rebuilt from it.');
    expect(t).toContain('1 picture slide becomes an editable slide.');
    expect(t).toContain('1 slide edited in ordo stays as it is');
    expect(t).toContain('1 other slide (not from this file) stays as it is.');
    expect(t).toContain('4 objects added in ordo stay on top');
    expect(t).toContain(
      'History can bring back the presentation as it is now. Your unsaved changes are saved first.',
    );
  });

  it("lists made-editable slides with 'Keep as it is'", () => {
    const html = dialog({ keep: new Set(['d']) });
    expect(html).toContain('<legend>Slides made editable before</legend>');
    expect(html).toMatch(/<input type="checkbox" checked=""\/><span>Slide 4: keep as it is<\/span>/);
    expect(html).toMatch(/<button type="button" class="primary"[^>]*>Re-import<\/button>/);
    expect(html).not.toMatch(/class="primary" disabled/);
  });

  it('waits for the plan, shows an error, and has nothing to do on a presentation without candidates', () => {
    expect(dialog({ plan: undefined })).toMatch(/role="status">Reading what a re-import would do/);
    const err = dialog({ plan: undefined, error: 'This presentation has no stored PowerPoint file' });
    expect(err).toContain('role="alert"');
    expect(err).toMatch(/class="primary" disabled=""/);
    const none = dialog({
      plan: { ...plan, slides: [plan.slides[1]!, plan.slides[4]!] },
    });
    expect(text(none)).toContain('Nothing to re-import');
    expect(none).toMatch(/class="primary" disabled=""/);
    // Every made-editable slide kept and nothing else to do: nothing to re-import either.
    const kept = dialog({ plan: { ...plan, slides: [plan.slides[3]!] }, keep: new Set(['d']) });
    expect(kept).toMatch(/class="primary" disabled=""/);
  });
});

describe('the re-import job in the editor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is taken over like a PowerPoint follow-up, and not listed as an import', () => {
    expect(PPTX_JOB_SAVERS.has('pptx-reimport')).toBe(true);
    expect(isImportJob('pptx-reimport')).toBe(false);
    expect(
      onlyJobSaves(
        [
          { rev: 3, savedBy: 'edit' },
          { rev: 4, savedBy: 'pptx-reimport' },
          { rev: 5, savedBy: 'pptx-lo' },
        ],
        3,
        5,
      ),
    ).toBe(true);
  });

  it('says what it did', () => {
    const r = (o: Record<string, unknown>) => readReimportResult({ presentationId: 'p1', ...o });
    expect(reimportMessage('reimport', r({ rev: 4, regenerated: 2, replaced: 3, keptEdited: 1 })).text).toBe(
      'Re-imported from PowerPoint: 2 slides rebuilt, 3 picture slides made editable, 1 edited slide kept as it is.',
    );
    expect(reimportMessage('reimport', r({ keptEdited: 2 })).text).toBe(
      'Nothing changed: every slide is as the PowerPoint file has it.',
    );
    expect(reimportMessage('reset', r({ rev: 4, regenerated: 1 })).text).toBe(
      'The slide is as the PowerPoint file has it again.',
    );
    expect(reimportMessage('make-editable', r({ rev: 4, replaced: 1 })).tone).toBe('ok');
    expect(reimportMessage('make-editable', r({})).text).toContain('it stays a picture');
    expect(reimportMessage('reimport', undefined).tone).toBe('warn');
  });

  it("tells which 'Make editable' rebuilds from the PowerPoint file, and a job from a presentation", () => {
    const src = { source: { kind: 'pptx' as const, fileId: 'deck' } };
    const page = { imported: { fileId: 'deck', page: 1, imageMediaId: 'm' } };
    expect(rebuildsFromPptx(src, page)).toBe(true);
    expect(rebuildsFromPptx(src, { ...page, pptx: { fileId: 'deck' } as never })).toBe(false);
    expect(rebuildsFromPptx({ source: { kind: 'pdf', fileId: 'deck' } }, page)).toBe(false);
    expect(rebuildsFromPptx(src, { imported: { ...page.imported, fileId: 'other' } })).toBe(false);
    expect(isJob({ id: 'j', kind: 'pptx-reimport', state: 'queued' })).toBe(true);
    expect(isJob({ id: 'p', kind: 'slides', title: 'x' })).toBe(false);
    expect(isJob(null)).toBe(false);
  });

  it('follows the job, takes its revision over and says so', async () => {
    const slide = imported([textObj('a', 'Welcome', { origin: PPTX })]);
    const base = {
      id: 'p9',
      rev: 3,
      title: 'Sunday',
      kind: 'slides',
      meta: { tags: [] },
      sections: [{ id: 'sec', label: 'S', short: 'S', slides: [slide] }],
      arrangements: [],
      source: { kind: 'pptx', fileId: 'deck' },
      archived: false,
    } as Presentation;
    const latest = { ...base, rev: 4, title: 'Sunday (re-imported)' };
    const job = { id: 'j1', kind: 'pptx-reimport', state: 'queued', progress: 0, log: [] } as unknown as Job;
    const done = {
      ...job,
      state: 'done',
      progress: 1,
      result: { presentationId: 'p9', rev: 4, replaced: 1 },
    };
    vi.stubGlobal('fetch', async (url: string) => {
      const json = (v: unknown) =>
        new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/jobs/j1')) return json(done);
      if (url.endsWith('/presentations/p9/revisions'))
        return json([
          { rev: 3, savedBy: 'edit' },
          { rev: 4, savedBy: 'pptx-reimport' },
        ]);
      if (url.endsWith('/presentations/p9')) return json(latest);
      return new Response('{}', { status: 404 });
    });
    openPresentation(base);
    useToasts.setState({ list: [] });
    const ended = await followReimport('p9', job, 'make-editable', slide.id);
    expect(ended?.state).toBe('done');
    expect(useEditor.getState().base?.rev).toBe(4);
    expect(useEditor.getState().draft?.title).toBe('Sunday (re-imported)');
    const run = useReimport.getState().runs.p9!;
    expect(run).toMatchObject({ id: 'j1', what: 'make-editable', slideId: slide.id, state: 'done' });
    expect(reimportRunning(run)).toBe(false);
    expect(useToasts.getState().list.at(-1)?.text).toContain('rebuilt from the PowerPoint file');
  });
});
