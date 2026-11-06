import type { Presentation, Slide } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import { describe, expect, it } from 'vitest';
import {
  approximatedSlides,
  canDrawOriginal,
  classCounts,
  DEFAULT_PPTX_CHOICE,
  documentFields,
  importJobTitle,
  isImportJob,
  lastLogLine,
  loStatus,
  PPTX_EXTEND_KEY,
  PPTX_IMPORT_KEY,
  readImportChoice,
  readNativeFallback,
  readNativeResult,
  showObjects,
  showsPicture,
  slideClassText,
  withReferences,
  writeImportChoice,
} from '../src/lib/pptxImport.ts';
import { followJob, referenceRunning } from '../src/views/editor/original.ts';

function memoryStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}
const broken = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
};

const pptx = (o: Partial<NonNullable<Slide['pptx']>> = {}): NonNullable<Slide['pptx']> => ({
  fileId: 'deck',
  index: 0,
  shown: 0,
  class: 'native',
  version: 1,
  ...o,
});
const slide = (id: string, o: Partial<Slide> = {}): Slide => ({ id, objects: [], ...o });
const pres = (slides: Slide[][], rev = 1): Presentation => ({
  id: 'p',
  rev,
  title: 'Sunday',
  kind: 'slides',
  meta: { tags: [] },
  sections: slides.map((s, i) => ({ id: `sec${i}`, label: `S${i}`, short: `S${i}`, slides: s })),
  arrangements: [],
  archived: false,
});

describe('the import choice', () => {
  it('defaults to editable slides with extended backgrounds', () => {
    expect(readImportChoice(memoryStore())).toEqual(DEFAULT_PPTX_CHOICE);
    expect(DEFAULT_PPTX_CHOICE).toEqual({ mode: 'native', extendBackgrounds: true });
    expect(readImportChoice(undefined)).toEqual(DEFAULT_PPTX_CHOICE);
    expect(readImportChoice(broken)).toEqual(DEFAULT_PPTX_CHOICE);
  });

  it('is remembered per device, and an old renderer choice is not carried over', () => {
    const s = memoryStore({ 'ordo.pptxRenderer': 'pptx-preview' });
    expect(readImportChoice(s).mode).toBe('native');
    writeImportChoice(s, { mode: 'libreoffice', extendBackgrounds: false });
    expect(s.m.get(PPTX_IMPORT_KEY)).toBe('libreoffice');
    expect(s.m.get(PPTX_EXTEND_KEY)).toBe('0');
    expect(readImportChoice(s)).toEqual({ mode: 'libreoffice', extendBackgrounds: false });
    expect(() => writeImportChoice(broken, DEFAULT_PPTX_CHOICE)).not.toThrow();
    // Anything else stored there reads as the default.
    expect(readImportChoice(memoryStore({ [PPTX_IMPORT_KEY]: 'pptx-preview' })).mode).toBe('native');
  });

  it('sends the PowerPoint choice with a .pptx only', () => {
    expect(documentFields('Sunday.PPTX', DEFAULT_PPTX_CHOICE)).toEqual([
      ['renderer', 'native'],
      ['extendBackgrounds', '1'],
    ]);
    expect(documentFields('a.pptx', { mode: 'native', extendBackgrounds: false })).toContainEqual([
      'extendBackgrounds',
      '0',
    ]);
    expect(documentFields('a.pptx', { mode: 'libreoffice', extendBackgrounds: true })).toEqual([
      ['renderer', 'libreoffice'],
    ]);
    expect(documentFields('Notices.pdf', DEFAULT_PPTX_CHOICE)).toEqual([]);
  });
});

describe('the import jobs list', () => {
  it('lists imports, not their follow-ups', () => {
    for (const k of ['pptx-native', 'document', 'pro7-import']) expect(isImportJob(k)).toBe(true);
    for (const k of ['pptx-lo', 'pptx-reference', 'pptx-text-repair', 'transcode', 'font-google'])
      expect(isImportJob(k)).toBe(false);
  });

  it('titles a job by what it imports', () => {
    const at = '2026-11-01T10:00:00.000Z';
    expect(importJobTitle({ kind: 'pptx-native', createdAt: at })).toMatch(/^PowerPoint · /);
    expect(importJobTitle({ kind: 'document', createdAt: at })).toMatch(/^PowerPoint or PDF \(pictures\) · /);
    expect(importJobTitle({ kind: 'pro7-import', createdAt: 'never' })).toBe('ProPresenter');
  });
});

describe('the native import result', () => {
  const ok = {
    presentationId: 'p1',
    slides: 17,
    native: 15,
    hybrid: 1,
    picture: 1,
    compact: 0,
    pending: 2,
    loJobId: 'lo1',
    missingFonts: ['Century Gothic'],
    notes: ['Slide 4: reflection drawn without blur'],
  };

  it('reads what the hub reports', () => {
    expect(readNativeResult(ok)).toEqual(ok);
    expect(readNativeFallback(ok)).toBeUndefined();
  });

  it('reads defensively: wrong types become zero or nothing, text is bounded and single-line', () => {
    const r = readNativeResult({
      presentationId: 'p1',
      slides: 3,
      native: -4,
      hybrid: Number.NaN,
      picture: '2',
      compact: 1e9,
      loJobId: 42,
      missingFonts: ['Tahoma', 7, '', 'x'.repeat(500)],
      notes: [...Array.from({ length: 30 }, (_, i) => `note ${i}`), 'forged\n10:00:00 [error] line'],
    })!;
    expect(r).toMatchObject({ slides: 3, native: 0, hybrid: 0, picture: 0, compact: 100_000, pending: 0 });
    expect(r.loJobId).toBeUndefined();
    expect(r.missingFonts).toHaveLength(2);
    expect(r.missingFonts[1]!.length).toBe(100);
    expect(r.notes).toHaveLength(20);
    const forged = readNativeResult({ ...ok, notes: ['forged\n10:00:00 [error] line'] })!;
    expect(forged.notes).toEqual(['forged 10:00:00 [error] line']);
    for (const bad of [undefined, null, 'x', [], { slides: 2 }, { presentationId: 'p', slides: '2' }])
      expect(readNativeResult(bad)).toBeUndefined();
  });

  it('reads the fallback to the picture import', () => {
    expect(readNativeFallback({ fallback: 'libreoffice', jobId: 'd1', reason: 'no worker' })).toEqual({
      jobId: 'd1',
      reason: 'no worker',
    });
    expect(readNativeFallback({ fallback: 'libreoffice' })).toBeUndefined();
    expect(readNativeFallback({ fallback: 'other', jobId: 'd1' })).toBeUndefined();
  });

  it('counts the slides per class in words', () => {
    expect(classCounts({ native: 15, hybrid: 1, picture: 1 }).map((c) => c.text)).toEqual([
      '15 editable',
      '1 partly a picture',
      '1 picture',
    ]);
    expect(classCounts({ native: 0, hybrid: 2, picture: 3 }).map((c) => c.text)).toEqual([
      '0 editable',
      '2 partly pictures',
      '3 pictures',
    ]);
  });

  it('lists the approximated slides in the editor numbering', () => {
    const p = pres([
      [slide('a'), slide('b', { pptx: pptx({ notes: ['soft edge drawn hard'] }) })],
      [slide('c', { hidden: true, pptx: pptx({ notes: ['inner shadow left out', ''] }) }), slide('d')],
    ]);
    expect(approximatedSlides(p)).toEqual({
      slides: [
        { slideId: 'b', number: 2, hidden: false, notes: ['soft edge drawn hard'] },
        { slideId: 'c', number: 3, hidden: true, notes: ['inner shadow left out'] },
      ],
      more: 0,
    });
    expect(approximatedSlides(p, 1)).toMatchObject({ slides: [{ slideId: 'b' }], more: 1 });
  });

  it('says what LibreOffice is doing', () => {
    const job = (o: Partial<Job>) => ({ state: 'queued', progress: 0, log: [], ...o }) as Job;
    expect(loStatus(0, job({}))).toBeUndefined();
    expect(loStatus(2, undefined)?.text).toBe('LibreOffice will draw what ordo cannot on 2 slides.');
    const waiting = loStatus(1, job({ log: ['10:00:00 waiting: the presentation is live'] }));
    expect(waiting).toMatchObject({ tone: 'amber', detail: 'waiting: the presentation is live' });
    expect(loStatus(1, job({ state: 'running', progress: 0.5 }))?.text).toMatch(/1 slide \(50%\)/);
    expect(loStatus(3, job({ state: 'done' }))).toMatchObject({ tone: 'green' });
    expect(loStatus(3, job({ state: 'failed', error: 'soffice timed out' }))).toMatchObject({
      tone: 'red',
      detail: 'soffice timed out',
    });
    expect(loStatus(1, job({ state: 'failed' }))?.text).toBe(
      'LibreOffice could not finish 1 slide: it shows only its editable parts.',
    );
  });

  it('reads the newest log line without its time', () => {
    expect(lastLogLine({ log: ['10:00:00 one', '10:00:01 two'] })).toBe('two');
    expect(lastLogLine({ log: [] })).toBeUndefined();
    expect(lastLogLine(undefined)).toBeUndefined();
  });
});

describe('the editor PowerPoint card', () => {
  it('names each slide class', () => {
    expect(slideClassText('native').label).toBe('Editable');
    expect(slideClassText('hybrid').label).toBe('Partly a picture');
    expect(slideClassText('picture').label).toBe('Picture');
  });

  it('draws originals of shown slides only', () => {
    expect(canDrawOriginal(slide('a', { pptx: pptx() }))).toBe(true);
    expect(canDrawOriginal(slide('a', { pptx: pptx({ shown: undefined }) }))).toBe(false);
    expect(canDrawOriginal(slide('a', { hidden: true, pptx: pptx() }))).toBe(false);
    expect(canDrawOriginal(slide('a'))).toBe(false);
  });

  it('knows when a slide is set to show its picture, and sets it back to its objects', () => {
    const s = slide('a', { pptx: pptx({ refMediaId: 'ref', show: 'picture' }) });
    expect(showsPicture(s)).toBe(true);
    expect(showsPicture(slide('a', { pptx: pptx({ show: 'picture' }) }))).toBe(false);
    const back = showObjects(s);
    expect(back.pptx).toEqual(pptx({ refMediaId: 'ref' }));
    expect(showsPicture(back)).toBe(false);
    const plain = slide('b', { pptx: pptx() });
    expect(showObjects(plain)).toBe(plain);
  });

  it('takes the reference pictures over into a draft with unsaved edits', () => {
    const base = pres([[slide('a', { pptx: pptx() }), slide('b', { pptx: pptx({ index: 1, shown: 1 }) })]]);
    const edited: Slide = { ...slide('a', { pptx: pptx() }), notes: 'my edit' };
    const draft: Presentation = {
      ...base,
      sections: [{ ...base.sections[0]!, slides: [edited, slide('new')] }],
    };
    const latest = pres(
      [
        [
          slide('a', { pptx: pptx({ refMediaId: 'r0' }) }),
          slide('b', { pptx: pptx({ index: 1, shown: 1, refMediaId: 'r1', show: 'picture' }) }),
        ],
      ],
      2,
    );
    const out = withReferences(draft, latest);
    expect(out.rev).toBe(2);
    const [a, n] = out.sections[0]!.slides;
    expect(a).toMatchObject({ notes: 'my edit', pptx: { refMediaId: 'r0' } });
    expect(a!.pptx!.show).toBeUndefined();
    expect(n).toEqual(slide('new'));
    // A slide of another deck keeps what it has.
    const other = withReferences(
      {
        ...draft,
        sections: [{ ...draft.sections[0]!, slides: [slide('a', { pptx: pptx({ fileId: 'x' }) })] }],
      },
      latest,
    );
    expect(other.sections[0]!.slides[0]!.pptx!.refMediaId).toBeUndefined();
  });
});

describe('following the reference job', () => {
  const job = (state: Job['state']): Job =>
    ({ id: 'j', kind: 'pptx-reference', state, progress: 0, log: [], createdAt: '', updatedAt: '' }) as Job;

  it('polls until the job ends, through failed requests, quickly at first', async () => {
    const answers: (Job | Error)[] = [job('queued'), new Error('offline'), job('running'), job('done')];
    const waits: number[] = [];
    const seen: string[] = [];
    let ended: Job | undefined;
    let t = 0;
    const out = await followJob('j', {
      getJob: async () => {
        const a = answers.shift()!;
        if (a instanceof Error) throw a;
        return a;
      },
      wait: async (ms) => {
        waits.push(ms);
        t += ms;
      },
      now: () => (waits.length >= 2 ? t + 200_000 : t),
      seen: (j) => seen.push(j.state),
      ended: (j) => {
        ended = j;
      },
    });
    expect(out?.state).toBe('done');
    expect(ended?.state).toBe('done');
    expect(seen).toEqual(['queued', 'running', 'done']);
    expect(waits).toEqual([1500, 1500, 5000]);
  });

  it('gives up after its time and reports nothing', async () => {
    let t = 0;
    let ended = false;
    const out = await followJob('j', {
      getJob: async () => job('queued'),
      wait: async (ms) => {
        t += ms;
      },
      now: () => t,
      maxMs: 4000,
      ended: () => {
        ended = true;
      },
    });
    expect(out).toBeUndefined();
    expect(ended).toBe(false);
  });

  it('knows a running job', () => {
    expect(referenceRunning(undefined)).toBe(false);
    expect(referenceRunning({ id: 'j', state: 'running', progress: 0 })).toBe(true);
    expect(referenceRunning({ id: 'j', state: 'failed', progress: 0 })).toBe(false);
  });
});
