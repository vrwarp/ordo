/**
 * The editor never changes a slide's stand-in beside its slide file (import-files step 2, C-IF5, E4, G4 item 3): a slide
 * kept as a file draws its simple copy until its picture exists, and the picture and the key come from the FILE, so a
 * stand-in edited beside it would show stale content on the screens. `change()` refuses such a change with the owner's
 * words and records nothing; `save()` refuses to send one (which covers undo, redo, adopting the hub's job saves and
 * merging theirs, all of which set the draft without `change()`); the slide's notes, timing and transition stay editable.
 * Against a fake hub (`fetch` stubbed) as mergeSave.test.ts does.
 */
import { DEFAULT_THEME, type Presentation, type Slide, type TextObject } from '@ordo/domain';
import { planRecord } from '@ordo/domain/prerender.ts';
import { staleStandIns } from '@ordo/domain/slidefile.ts';
import { API_PREFIX } from '@ordo/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptJobSaves,
  change,
  openPresentation,
  redo,
  save,
  undo,
  useEditor,
} from '../src/views/editor/editorStore.ts';
import { FILE_FORM_REFUSAL, fileFormGuard } from '../src/views/editor/fileForm.ts';
import {
  addObject,
  deleteObject,
  getSlide,
  newText,
  updateObject,
  updateSlide,
} from '../src/views/editor/ops.ts';
import { findReplace } from '../src/views/editor/ops/slides.ts';
import { useToasts } from '../src/state/toasts.ts';

// A spy on the one comparison, to show that an ordinary presentation never pays for it (EG10).
const compared = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@ordo/domain/slidefile.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('@ordo/domain/slidefile.ts')>();
  return {
    ...m,
    staleStandIns: (...a: Parameters<typeof m.staleStandIns>) => {
      compared.calls++;
      return m.staleStandIns(...a);
    },
  };
});

const REF = 'a'.repeat(64);
const REF2 = 'b'.repeat(64);
const box = { x: 100, y: 100, w: 800, h: 300, rotation: 0 };
const text = (id: string, t: string): TextObject => ({
  id,
  type: 'text',
  box,
  text: t,
  style: { ...DEFAULT_THEME.textBoxDefaults },
  opacity: 1,
});
const bigSlide = (ref = REF): Slide =>
  ({
    id: 'big',
    objects: [text('g1', 'Detailed words'), text('g2', 'More words'), text('g3', 'Last words')],
    prerender: { why: ['count'], file: { ref, bytes: 4000 }, live: [] },
  }) as Slide;
const refusedSlide = (): Slide =>
  ({
    id: 'refused',
    objects: [text('r1', 'Too large to keep whole')],
    pptx: { fileId: 'f'.repeat(8), index: 2, class: 'native', version: 3, missing: ['slide:too-large'] },
  }) as unknown as Slide;
const deck = (): Presentation => ({
  id: 'p1',
  rev: 4,
  title: 'Sunday',
  kind: 'slides',
  meta: { tags: [] },
  sections: [
    {
      id: 'sec',
      label: 'Main',
      short: 'M',
      slides: [
        { id: 'plain', objects: [text('t1', 'Detailed words in an ordinary slide')] },
        bigSlide(),
        refusedSlide(),
      ],
    },
  ],
  arrangements: [{ id: 'a', name: 'Default', sectionIds: ['sec'] }],
  archived: false,
});
const ordinaryDeck = (): Presentation => {
  const d = deck();
  return {
    ...d,
    sections: [{ ...d.sections[0]!, slides: [d.sections[0]!.slides[0]!, d.sections[0]!.slides[2]!] }],
  };
};

class FakeHub {
  stored: Presentation;
  puts: Presentation[] = [];
  savedBy: Record<number, string> = {};
  constructor(p: Presentation) {
    this.stored = JSON.parse(JSON.stringify(p));
  }
  saveOther(fn: (p: Presentation) => Presentation, by?: string): void {
    this.stored = JSON.parse(JSON.stringify({ ...fn(this.stored), rev: this.stored.rev + 1 }));
    if (by) this.savedBy[this.stored.rev] = by;
  }
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = url.slice(API_PREFIX.length);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/presentations/p1' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Presentation;
      this.puts.push(body);
      if (body.rev !== this.stored.rev)
        return json(409, {
          error: {
            code: 'conflict',
            message: 'Changed since you opened it',
            rev: this.stored.rev,
            current: this.stored,
          },
        });
      this.stored = { ...body, rev: body.rev + 1 };
      return json(200, this.stored);
    }
    if (path === '/presentations/p1') return json(200, this.stored);
    if (path === '/presentations/p1/revisions')
      return json(
        200,
        Array.from({ length: this.stored.rev }, (_, i) => ({
          rev: i + 1,
          savedAt: '2026-11-06T09:00:00Z',
          savedBy: this.savedBy[i + 1] ?? 'operator',
          title: 'Sunday',
        })),
      );
    return json(404, { error: { code: 'not_found', message: 'Not found' } });
  };
}

let hub: FakeHub;
/** The words of the first object of a slide. */
const firstWords = (p: Presentation | undefined, slideId: string) =>
  (getSlide(p!, slideId)?.objects[0] as TextObject | undefined)?.text;
const toasts = () => useToasts.getState().list.map((t) => t.text);
const setText = (p: Presentation, slideId: string, objectId: string, t: string) =>
  updateObject(p, slideId, objectId, (o) => ({ ...o, text: t }) as TextObject);

beforeEach(() => {
  hub = new FakeHub(deck());
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => hub.fetch(url, init));
  openPresentation(deck());
  useToasts.setState({ list: [] });
  compared.calls = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the editor and a slide kept as a slide file (EG1-EG10)', () => {
  it('EG1 change() refuses a move, a delete, an add, a text edit and a Find and Replace that reach the stand-in, with the owner words, and keeps the draft and the history', () => {
    const before = useEditor.getState().draft;
    const attempts: [string, (p: Presentation) => Presentation][] = [
      ['a move', (p) => updateObject(p, 'big', 'g1', (o) => ({ ...o, box: { ...o.box, x: 140 } }))],
      ['a delete', (p) => deleteObject(p, 'big', 'g2')],
      ['an add', (p) => addObject(p, 'big', newText(DEFAULT_THEME, 'New'))],
      ['a text edit', (p) => setText(p, 'big', 'g1', 'Changed')],
      ['a Find and Replace', (p) => findReplace(p, 'words', 'WORDS').p],
    ];
    for (const [what, fn] of attempts) {
      useToasts.setState({ list: [] });
      change(fn);
      const ed = useEditor.getState();
      expect(ed.draft, what).toBe(before);
      expect(ed.dirty, what).toBe(false);
      expect(ed.canUndo, what).toBe(false);
      expect(toasts()[0], what).toContain(FILE_FORM_REFUSAL);
    }
    // a change across slides is refused as a whole, and says to change the other slides one by one
    useToasts.setState({ list: [] });
    change((p) => findReplace(p, 'words', 'WORDS').p);
    expect(toasts()).toEqual([
      `${FILE_FORM_REFUSAL} Nothing was changed: change the other slides one by one.`,
    ]);
    expect(getSlide(useEditor.getState().draft!, 'plain')?.objects[0]).toEqual(
      getSlide(before!, 'plain')?.objects[0],
    );
  });

  it('EG2 the notes, timing, transition, hidden flag, MIDI cues and sound of the same slide stay editable', () => {
    const edits: Partial<Slide>[] = [
      { notes: 'Ask the band to start softly' },
      { durationMs: 8000 },
      { transition: { kind: 'fade', ms: 400 } as never },
      { hidden: true },
      { midiCues: [] },
      { audio: { mediaId: 'sound' } as never },
      { bottomThirdText: 'Welcome' },
    ];
    for (const e of edits) {
      useToasts.setState({ list: [] });
      change((p) => updateSlide(p, 'big', (s) => ({ ...s, ...e })));
      const slide = getSlide(useEditor.getState().draft!, 'big')!;
      expect(slide, JSON.stringify(e)).toMatchObject(e);
      expect(toasts(), JSON.stringify(e)).toEqual([]);
    }
    expect(useEditor.getState().dirty).toBe(true);
  });

  it('EG3 save() refuses to send a draft whose stand-in differs from its base: the hub is never called', async () => {
    // a door change() does not guard: the draft set directly
    const tampered = setText(useEditor.getState().draft!, 'big', 'g1', 'Changed beside the file');
    useEditor.setState({ draft: tampered, dirty: true });
    expect(await save()).toBe(false);
    expect(hub.puts).toHaveLength(0);
    expect(toasts().join(' ')).toContain(FILE_FORM_REFUSAL);
    expect(useEditor.getState().saving).toBe(false);
    // the same draft with the stand-in as it was saves
    useEditor.setState({
      draft: updateSlide(deck(), 'big', (s) => ({ ...s, notes: 'only a note' })),
      dirty: true,
    });
    expect(await save()).toBe(true);
    expect(hub.puts).toHaveLength(1);
  });

  it('EG4 undo and redo never produce a stale draft', () => {
    change((p) => updateSlide(p, 'big', (s) => ({ ...s, notes: 'one' })));
    change((p) => updateSlide(p, 'big', (s) => ({ ...s, notes: 'two' })));
    change((p) => setText(p, 'big', 'g1', 'refused'));
    const stale = () => staleStandIns(useEditor.getState().base, useEditor.getState().draft!);
    expect(stale()).toEqual([]);
    undo();
    expect(stale()).toEqual([]);
    undo();
    expect(stale()).toEqual([]);
    redo();
    redo();
    expect(stale()).toEqual([]);
    expect(getSlide(useEditor.getState().draft!, 'big')?.notes).toBe('two');
    // and what the refused edit would have done is nowhere in the history
    undo();
    undo();
    undo();
    expect(firstWords(useEditor.getState().draft, 'big')).toBe('Detailed words');
  });

  it("EG5 adoptJobSaves bringing a hub job's new file ref is accepted, and the editor saves after it", async () => {
    hub.saveOther(
      (p) =>
        updateSlide(p, 'big', () => ({ ...bigSlide(REF2), objects: [text('h1', 'Rebuilt by the job')] })),
      'pptx-reimport',
    );
    expect(await adoptJobSaves()).toBe('adopted');
    const draft = useEditor.getState().draft!;
    expect(getSlide(draft, 'big')?.prerender?.file?.ref).toBe(REF2);
    expect(staleStandIns(useEditor.getState().base, draft)).toEqual([]);
    change((p) => updateSlide(p, 'big', (s) => ({ ...s, notes: 'after the job' })));
    expect(await save()).toBe(true);
    expect(getSlide(hub.stored, 'big')?.notes).toBe('after the job');
  });

  it('EG6 a merge with their save keeps the stand-in the hub holds; a draft that differs from it is not sent', async () => {
    hub.saveOther((p) => updateSlide(p, 'plain', (s) => ({ ...s, notes: 'someone else' })));
    change((p) => updateSlide(p, 'big', (s) => ({ ...s, notes: 'mine' })));
    expect(await save()).toBe(true);
    expect(getSlide(hub.stored, 'big')?.notes).toBe('mine');
    expect(getSlide(hub.stored, 'plain')?.notes).toBe('someone else');
    // a draft whose stand-in differs from the base's under the same ref is refused, and one that does not is not
    const base = deck();
    const tampered = updateSlide(base, 'big', (s) => ({ ...s, objects: [text('x', 'Other')] }));
    expect(fileFormGuard(base, tampered)).toBe(FILE_FORM_REFUSAL);
    expect(fileFormGuard(base, base)).toBeUndefined();
  });

  it('EG7 an ordinary slide is not affected', () => {
    change((p) => setText(p, 'plain', 't1', 'Edited'));
    expect(toasts()).toEqual([]);
    expect(firstWords(useEditor.getState().draft, 'plain')).toBe('Edited');
    expect(useEditor.getState().canUndo).toBe(true);
  });

  it('EG8 a refused slide (the slide:too-large entry, no record) edits like any slide and a save never gives it a record', async () => {
    change((p) => setText(p, 'refused', 'r1', 'Edited by hand'));
    expect(toasts()).toEqual([]);
    expect(await save()).toBe(true);
    const saved = getSlide(hub.stored, 'refused')!;
    expect(saved.prerender).toBeUndefined();
    expect((saved.objects[0] as TextObject).text).toBe('Edited by hand');
    // and the one writer of records leaves it alone, whatever it plans
    expect(planRecord(saved)).toBe(saved);
  });

  it('EG9 the words are one constant, in plain words', () => {
    expect(FILE_FORM_REFUSAL).toBe(
      'This slide is too detailed to edit shape by shape: it is kept whole on the hub. Its notes, timing and transition can be changed; Reset slide builds it again from the PowerPoint file.',
    );
    for (const word of ['pre-render', 'slide file', 'stand-in', 'head'])
      expect(FILE_FORM_REFUSAL).not.toContain(word);
    change((p) => setText(p, 'big', 'g1', 'x'));
    expect(toasts()).toEqual([FILE_FORM_REFUSAL]);
  });

  it('EG10 the guard costs nothing on a presentation with no slide kept as a file: no comparison runs', async () => {
    openPresentation(ordinaryDeck());
    hub = new FakeHub(ordinaryDeck());
    compared.calls = 0;
    change((p) => setText(p, 'plain', 't1', 'Edited'));
    change((p) => updateSlide(p, 'plain', (s) => ({ ...s, notes: 'n' })));
    expect(await save()).toBe(true);
    expect(compared.calls).toBe(0);
    // a presentation that has one does compare
    openPresentation(deck());
    compared.calls = 0;
    change((p) => setText(p, 'plain', 't1', 'Edited again'));
    expect(compared.calls).toBeGreaterThan(0);
  });

  it("EG11 the hub's own refusal (409 stand_in_stale) shows the owner words and is not offered as a conflict with someone else", async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'stand_in_stale',
              message: 'The simple copy of a detailed slide was changed',
              slides: ['big'],
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    );
    change((p) => updateSlide(p, 'big', (s) => ({ ...s, notes: 'a note' })));
    expect(await save()).toBe(false);
    expect(toasts()).toEqual([`Could not save: ${FILE_FORM_REFUSAL}`]);
    expect(useEditor.getState()).toMatchObject({ conflict: false, saving: false, dirty: true });
  });
});
