/**
 * The import screen's PowerPoint choice, the import card and the editor's PowerPoint card (design/27 M3 item
 * H), rendered to markup: what each shows for the states a native import goes through.
 */
import type { Slide } from '@ordo/domain';
import { type HubCapabilities, type Job, LEGACY_CAPABILITIES } from '@ordo/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PPTX_CHOICE,
  documentAccept,
  documentFields,
  isPptxName,
  type NativeImportResult,
} from '../src/lib/pptxImport.ts';
import { PptxSlideCardView } from '../src/views/editor/PptxSlideCard.tsx';
import { PptxImportChoices } from '../src/views/library/ImportTab.tsx';
import { PptxImportCardView } from '../src/views/library/PptxImportCard.tsx';

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

describe('the PowerPoint choice on the import screen', () => {
  it('offers Editable (recommended), checked by default, and Pictures (LibreOffice)', () => {
    const html = renderToStaticMarkup(
      createElement(PptxImportChoices, {
        value: DEFAULT_PPTX_CHOICE,
        onChange: noop,
        caps: LEGACY_CAPABILITIES,
      }),
    );
    expect(html).toContain('<fieldset');
    expect(text(html)).toContain('PowerPoint slides');
    const radios = html.match(/<input type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(radios[0]).toContain('value="native"');
    expect(radios[0]).toContain('checked');
    expect(radios[1]).toContain('value="libreoffice"');
    expect(radios[1]).not.toContain('checked');
    expect(text(html)).toContain('Editable (recommended)');
    expect(text(html)).toContain('Pictures (LibreOffice)');
    expect(text(html)).toContain('Extend plain backgrounds to 16:9');
    // Each control is inside its label (design/15: the label is the hit area under a finger).
    expect(html.match(/<label class="check"/g)).toHaveLength(3);
    const box = html.match(/<input type="checkbox"[^>]*>/)![0];
    expect(box).toContain('checked');
    expect(box).not.toContain('disabled');
  });

  it('turns the background option off for pictures', () => {
    const html = renderToStaticMarkup(
      createElement(PptxImportChoices, {
        value: { mode: 'libreoffice', extendBackgrounds: true },
        onChange: noop,
        caps: LEGACY_CAPABILITIES,
      }),
    );
    expect(html.match(/<input type="radio"[^>]*>/g)![1]).toContain('checked');
    expect(html.match(/<input type="checkbox"[^>]*>/)![0]).toContain('disabled');
  });
});

const job = (o: Partial<Job> = {}): Job => ({
  id: 'j1',
  kind: 'pptx-native',
  state: 'done',
  progress: 1,
  log: ['10:00:00 version 1 saved'],
  createdAt: '',
  updatedAt: '',
  ...o,
});
const result = (o: Partial<NativeImportResult> = {}): NativeImportResult => ({
  presentationId: 'p1',
  slides: 17,
  native: 15,
  hybrid: 1,
  picture: 1,
  compact: 0,
  pending: 0,
  missingFonts: [],
  notes: [],
  ...o,
});
const card = (props: Partial<Parameters<typeof PptxImportCardView>[0]>) =>
  renderToStaticMarkup(
    createElement(PptxImportCardView, {
      title: 'Sunday.pptx',
      job: job(),
      showLog: false,
      onToggleLog: noop,
      onOpen: noop,
      ...props,
    }),
  );

describe('the import card', () => {
  it('shows the slides per class and opens the presentation', () => {
    const html = card({ result: result() });
    const t = text(html);
    expect(t).toContain('17 slides:');
    expect(t).toContain('15 editable');
    expect(t).toContain('1 partly a picture');
    expect(t).toContain('1 picture');
    expect(t).toContain('Partly pictures: what ordo cannot edit');
    expect(t).toContain('Open presentation');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('aria-label="Slides by kind"');
  });

  it('shows the pending LibreOffice work and how it ends', () => {
    const pending = result({ pending: 2, loJobId: 'lo1' });
    const waiting = text(
      card({ result: pending, lo: job({ id: 'lo1', state: 'queued', log: ['10:00:00 waiting: live'] }) }),
    );
    expect(waiting).toContain('LibreOffice will draw what ordo cannot on 2 slides.');
    expect(waiting).toContain('waiting: live');
    expect(
      text(card({ result: pending, lo: job({ id: 'lo1', state: 'running', progress: 0.25 }) })),
    ).toContain('(25%)');
    const failed = card({
      result: pending,
      lo: job({ id: 'lo1', state: 'failed', error: 'soffice crashed' }),
    });
    expect(failed).toContain('banner red');
    expect(text(failed)).toContain(
      'LibreOffice could not finish 2 slides: they show only their editable parts.',
    );
    expect(text(failed)).toContain('soffice crashed');
    expect(text(card({ result: result() }))).not.toContain('LibreOffice will');
  });

  it('names compact slides, missing fonts, approximations and notes', () => {
    const html = card({
      result: result({
        compact: 3,
        missingFonts: ['Century Gothic'],
        notes: ['External link to example.org kept as text'],
      }),
      presentation: {
        sections: [
          {
            id: 's',
            label: 'Slides',
            short: 'S',
            slides: [
              { id: 'a', objects: [] },
              {
                id: 'b',
                objects: [],
                hidden: true,
                pptx: { fileId: 'f', index: 1, class: 'native', version: 1, notes: ['reflection left out'] },
              },
            ],
          },
        ],
      },
    });
    const t = text(html);
    expect(t).toContain('3 slides became pictures to keep the presentation small enough');
    expect(t).toContain('Upload Century Gothic for exact line breaks.');
    expect(html).toContain('href="#/library/fonts"');
    expect(t).toContain('Approximated on 1 slide');
    expect(t).toContain('Slide 2 (hidden) : reflection left out');
    expect(t).toContain('Import notes (1)');
    expect(t).toContain('External link to example.org kept as text');
  });

  it('shows a failure and the fallback to pictures', () => {
    const failed = card({ job: job({ state: 'failed', error: 'The uploaded deck is missing' }) });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain('The uploaded deck is missing');
    expect(text(failed)).not.toContain('Open presentation');
    const fb = card({
      fallback: { jobId: 'd1', reason: 'the CPU pool cannot start' },
      fallbackJob: job({ id: 'd1', kind: 'document', state: 'done', result: { presentationId: 'p9' } }),
    });
    expect(text(fb)).toContain(
      'The slides could not be made editable here (the CPU pool cannot start): they are imported as pictures with LibreOffice instead (done).',
    );
    expect(text(fb)).toContain('Open presentation');
  });

  it('renders deck text as text', () => {
    const html = card({ result: result({ notes: ['<img src=x onerror=alert(1)>'] }) });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

const pptx = (o: Partial<NonNullable<Slide['pptx']>> = {}): NonNullable<Slide['pptx']> => ({
  fileId: 'deck',
  index: 0,
  shown: 0,
  class: 'native',
  version: 1,
  ...o,
});
const slideCard = (s: Slide, o: Partial<Parameters<typeof PptxSlideCardView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(PptxSlideCardView, {
      slide: s,
      readOnly: false,
      on: false,
      onToggle: noop,
      onShowObjects: noop,
      ...o,
    }),
  );
const toggle = (html: string) => html.match(/<input type="checkbox"[^>]*>/)?.[0];

describe('the PowerPoint card in the editor', () => {
  it('is not there for a slide that is not from a PowerPoint', () => {
    expect(slideCard({ id: 's', objects: [] })).toBe('');
  });

  it('shows the class, what was approximated and pending LibreOffice work', () => {
    const html = slideCard({
      id: 's',
      objects: [],
      pptx: pptx({ class: 'hybrid', pending: true, notes: ['inner shadow left out', 'kerning differs'] }),
    });
    const t = text(html);
    expect(html).toContain('aria-label="From PowerPoint"');
    expect(t).toContain('Partly a picture');
    expect(t).toContain('LibreOffice is still drawing part of this slide');
    expect(t).toContain('What was approximated');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(t).toContain('kerning differs');
  });

  it("offers 'Show original', drawing the pictures first when there are none", () => {
    const none = slideCard({ id: 's', objects: [], pptx: pptx() });
    expect(text(none)).toContain('Show original');
    expect(toggle(none)).not.toContain('checked');
    expect(toggle(none)).not.toContain('disabled');
    expect(text(none)).toContain('LibreOffice first draws every slide of the presentation');
    const drawing = slideCard(
      { id: 's', objects: [], pptx: pptx() },
      { on: true, job: { id: 'j', state: 'running', progress: 0.4 } },
    );
    expect(toggle(drawing)).toContain('checked');
    expect(text(drawing)).toContain('LibreOffice is drawing the PowerPoint pictures (40%).');
    expect(drawing).toContain('role="status"');
    const shown = slideCard({ id: 's', objects: [], pptx: pptx({ refMediaId: 'ref' }) }, { on: true });
    expect(toggle(shown)).toContain('checked');
    expect(text(shown)).toContain('The screens still show the slide as rebuilt.');
  });

  it('cannot draw a hidden slide, nor draw anything while the presentation is live', () => {
    const hidden = slideCard({ id: 's', objects: [], hidden: true, pptx: pptx({ shown: undefined }) });
    expect(toggle(hidden)).toContain('disabled');
    expect(text(hidden)).toContain('A hidden slide has no PowerPoint picture');
    const live = slideCard({ id: 's', objects: [], pptx: pptx() }, { readOnly: true });
    expect(toggle(live)).toContain('disabled');
    expect(text(live)).toContain('can be drawn after the service');
    // A picture already drawn can be looked at while live: it writes nothing.
    const liveRef = slideCard(
      { id: 's', objects: [], pptx: pptx({ refMediaId: 'ref' }) },
      { readOnly: true },
    );
    expect(toggle(liveRef)).not.toContain('disabled');
  });

  it('has no toggle on a picture slide, and says when a slide shows its picture on the screens', () => {
    const pic = slideCard({ id: 's', objects: [], pptx: pptx({ class: 'picture' }) });
    expect(toggle(pic)).toBeUndefined();
    expect(text(pic)).toContain('ordo could not rebuild this slide');
    const set = slideCard({ id: 's', objects: [], pptx: pptx({ refMediaId: 'ref', show: 'picture' }) });
    expect(text(set)).toContain('set to show its PowerPoint picture on the screens');
    expect(text(set)).toContain('Show the objects instead');
  });

  it('reports a failed drawing', () => {
    const html = slideCard(
      { id: 's', objects: [], pptx: pptx() },
      { job: { id: 'j', state: 'failed', progress: 0, error: 'soffice timed out' } },
    );
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain('LibreOffice could not draw the PowerPoint pictures: soffice timed out');
  });
});

/** A hub without LibreOffice (design/27 M9): the lite image, with poppler-utils. */
const LITE: HubCapabilities = {
  libreoffice: { state: 'absent' },
  pdf: true,
  documents: ['pptx', 'ppsx', 'potx', 'pptm', 'pdf'],
  pptx: { pictures: false, reference: false, referencePdf: true, art: false },
};

describe('without LibreOffice on the hub (design/27 M9)', () => {
  it('the Pictures (LibreOffice) choice is hidden', () => {
    const html = renderToStaticMarkup(
      createElement(PptxImportChoices, { value: DEFAULT_PPTX_CHOICE, onChange: noop, caps: LITE }),
    );
    const radios = html.match(/<input type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(1);
    expect(radios[0]).toContain('value="native"');
    expect(radios[0]).toContain('checked');
    const t = text(html);
    expect(t).not.toContain('LibreOffice');
    expect(t).toContain('anything it cannot draw is listed on the import card');
    expect(html.match(/<input type="checkbox"[^>]*>/)![0]).not.toContain('disabled');
    // Not known yet (no answer from the hub): nothing that needs LibreOffice is offered either.
    const unknown = renderToStaticMarkup(
      createElement(PptxImportChoices, { value: DEFAULT_PPTX_CHOICE, onChange: noop }),
    );
    expect(unknown.match(/<input type="radio"[^>]*>/g)).toHaveLength(1);
  });

  it('a stored libreoffice choice imports as editable and says so', () => {
    const stored = { mode: 'libreoffice' as const, extendBackgrounds: true };
    const html = renderToStaticMarkup(
      createElement(PptxImportChoices, { value: stored, onChange: noop, caps: LITE }),
    );
    expect(html.match(/<input type="radio"[^>]*>/g)![0]).toContain('checked');
    expect(text(html)).toContain(
      'This hub has no LibreOffice, so PowerPoint files are imported as editable slides.',
    );
    expect(html.match(/<input type="checkbox"[^>]*>/)![0]).not.toContain('disabled');
    expect(documentFields('Sunday.pptx', stored, LITE)).toEqual([
      ['renderer', 'native'],
      ['extendBackgrounds', '1'],
    ]);
    // A hub with LibreOffice gets the choice as made; so does one that has not answered yet (it refuses
    // pictures it cannot make, in words).
    expect(documentFields('Sunday.pptx', stored, LEGACY_CAPABILITIES)).toEqual([['renderer', 'libreoffice']]);
    expect(documentFields('Sunday.pptx', stored)).toEqual([['renderer', 'libreoffice']]);
    // The OOXML family carries the choice; a PDF never does.
    for (const name of ['Show.ppsx', 'Template.potx', 'Macros.pptm', 'DECK.PPTX'])
      expect(isPptxName(name)).toBe(true);
    expect(isPptxName('Old.ppt')).toBe(false);
    expect(documentFields('Notes.pdf', stored, LITE)).toEqual([]);
    expect(documentAccept(LITE)).toBe('.pptx,.ppsx,.potx,.pptm,.pdf');
    expect(documentAccept({ ...LITE, pdf: false, documents: ['pptx', 'ppsx', 'potx', 'pptm'] })).toBe(
      '.pptx,.ppsx,.potx,.pptm',
    );
    expect(documentAccept(undefined)).toBe('.pptx,.pdf');
  });

  it('the import card names what ordo cannot draw and says nothing of LibreOffice', () => {
    const slide = (id: string, index: number, missing?: string[]): Slide => ({
      id,
      objects: [],
      pptx: {
        fileId: 'f',
        index,
        class: missing ? 'hybrid' : 'native',
        version: 2,
        ...(missing ? { missing } : {}),
      },
    });
    const html = card({
      result: result({ native: 2, hybrid: 2, picture: 0, slides: 4, missing: 2, libreoffice: false }),
      presentation: {
        sections: [
          {
            id: 's',
            label: 'Slides',
            short: 'S',
            slides: [slide('a', 0), slide('b', 1, ['chart']), slide('c', 2), slide('d', 3, ['metafile'])],
          },
        ],
      },
    });
    const t = text(html);
    expect(t).toContain('2 partly drawn');
    expect(t).toContain(
      '2 slides have something ordo cannot draw: a chart, a vector picture. It is left out; open them in the editor to see what.',
    );
    expect(t).not.toContain('LibreOffice');
    expect(html).toContain('data-missing');
    // Without the presentation the result's count still says it.
    expect(text(card({ result: result({ missing: 1, libreoffice: false }) }))).toContain(
      '1 slide has something ordo cannot draw. It is left out; open it in the editor to see what.',
    );
  });

  it("the slide card lists what is not drawn and offers PowerPoint's PDF instead of LibreOffice", () => {
    const gap = { id: 's', objects: [], pptx: pptx({ class: 'hybrid', missing: ['chart', 'ole'] }) };
    const html = slideCard(gap, { caps: LITE, onAddPdf: noop });
    const t = text(html);
    expect(t).toContain('Partly drawn');
    expect(t).toContain('Not drawn: a chart, an embedded object.');
    expect(t).not.toContain('LibreOffice first draws');
    expect(toggle(html)).toContain('disabled');
    expect(t).toContain('Export the deck as PDF from PowerPoint to compare with the original.');
    expect(html).toContain('data-reference-pdf');
    expect(t).toContain("Add PowerPoint's pictures (PDF)…");
    expect(html).toMatch(/<input type="file" accept=".pdf,application\/pdf"/);
    // A slide that has its picture already: 'Show original' works without LibreOffice, and no PDF is asked.
    const has = slideCard(
      { ...gap, pptx: pptx({ class: 'hybrid', refMediaId: 'ref' }) },
      { caps: LITE, onAddPdf: noop },
    );
    expect(toggle(has)).not.toContain('disabled');
    expect(has).not.toContain('data-reference-pdf');
    // No LibreOffice and no poppler-utils: nothing to offer but the reason.
    const bare = slideCard(gap, {
      caps: { ...LITE, pdf: false, pptx: { ...LITE.pptx, referencePdf: false } },
      onAddPdf: noop,
    });
    expect(bare).not.toContain('data-reference-pdf');
    expect(text(bare)).toContain('This hub has no LibreOffice to draw the PowerPoint pictures.');
    // A slide nothing could rebuild on such a hub keeps only its text.
    const lost = slideCard(
      { id: 's', objects: [], pptx: pptx({ class: 'picture', missing: ['slide'] }) },
      { caps: LITE },
    );
    expect(text(lost)).toContain('Not drawn');
    expect(text(lost)).toContain('only its text is kept, for search');
    expect(text(lost)).toContain('Not drawn: the slide itself.');
  });
});
