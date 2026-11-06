/**
 * The editor's save on 409 (M4 item H; design/27 §11 item 17): the version that won is merged with the draft
 * and saved again, undo moves with it, a merge that cannot combine every change opens the conflict dialog
 * with what overlaps, and 'Save mine anyway' still saves over theirs. Against a fake hub (`fetch` stubbed)
 * that answers a stale save as the real one does (`library.ts` `update`: 409 with `rev` and `current`).
 */
import { DEFAULT_THEME, type Presentation, type TextObject } from '@ordo/domain';
import { API_PREFIX } from '@ordo/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictDialogView } from '../src/views/editor/ConflictDialog.tsx';
import {
  adoptJobSaves,
  change,
  openPresentation,
  redo,
  save,
  selectObject,
  selectSlide,
  undo,
  useEditor,
} from '../src/views/editor/editorStore.ts';
import { History } from '../src/views/editor/history.ts';
import type { MergeConflict } from '../src/views/editor/merge.ts';
import { deleteSlide, getSlide, updateObject } from '../src/views/editor/ops.ts';
import { useToasts } from '../src/state/toasts.ts';

const box = { x: 100, y: 100, w: 800, h: 300, rotation: 0 };
const text = (id: string, t: string): TextObject => ({
  id,
  type: 'text',
  box,
  text: t,
  style: { ...DEFAULT_THEME.textBoxDefaults },
  opacity: 1,
});
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
        { id: 's1', objects: [text('t1', 'Welcome')] },
        { id: 's2', objects: [text('date', 'Potluck on Sunday 12 May')] },
        { id: 's3', objects: [text('song', 'Amazing grace')] },
      ],
    },
  ],
  arrangements: [{ id: 'a', name: 'Default', sectionIds: ['sec'] }],
  archived: false,
});
const setText = (p: Presentation, slideId: string, objectId: string, t: string) =>
  updateObject(p, slideId, objectId, (o) => ({ ...o, text: t }) as TextObject);
const textOf = (p: Presentation | undefined, slideId: string) =>
  (getSlide(p!, slideId)?.objects[0] as TextObject | undefined)?.text;

/** A hub holding one presentation: PUT with a stale rev is refused with 409 and the stored version. */
class FakeHub {
  stored: Presentation;
  puts: { rev: number; body: Presentation }[] = [];
  /** Run before each PUT is answered (someone else saving meanwhile). */
  beforePut?: (hub: FakeHub) => void;
  /** Who saved each revision (`RevisionInfo.savedBy`), 'operator' unless a job saved it. */
  savedBy: Record<number, string> = {};
  constructor(p: Presentation) {
    this.stored = JSON.parse(JSON.stringify(p));
  }
  /** Someone else saves: their change on top of what is stored, one revision more. */
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
      this.puts.push({ rev: body.rev, body });
      this.beforePut?.(this);
      if (body.rev !== this.stored.rev)
        return json(409, {
          error: {
            code: 'conflict',
            message: `Changed since you opened it (rev ${this.stored.rev}, yours ${body.rev})`,
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
beforeEach(() => {
  hub = new FakeHub(deck());
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => hub.fetch(url, init));
  openPresentation(deck());
  useToasts.setState({ list: [] });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('save on 409', () => {
  it('merges someone else’s save of another slide and saves both, once more', async () => {
    hub.saveOther((p) => setText(p, 's3', 'song', 'Amazing grace, how sweet'));
    change((p) => setText(p, 's2', 'date', 'Potluck on Sunday 19 May'));
    expect(await save()).toBe(true);
    expect(hub.puts.map((x) => x.rev)).toEqual([4, 5]);
    expect(hub.stored.rev).toBe(6);
    expect(textOf(hub.stored, 's2')).toBe('Potluck on Sunday 19 May');
    expect(textOf(hub.stored, 's3')).toBe('Amazing grace, how sweet');
    const ed = useEditor.getState();
    expect(ed).toMatchObject({ dirty: false, saving: false, conflict: false, mergeConflicts: [] });
    expect(ed.base?.rev).toBe(6);
    expect(ed.draft).toEqual(hub.stored);
    expect(useToasts.getState().list.map((t) => t.text)).toEqual([
      'Saved together with the changes someone else saved meanwhile.',
    ]);
  });

  it('moves undo onto their version: undo takes my edit out, never theirs', async () => {
    hub.saveOther((p) => setText(p, 's3', 'song', 'Amazing grace, how sweet'));
    change((p) => setText(p, 's1', 't1', 'Welcome!'));
    change((p) => setText(p, 's2', 'date', 'Potluck on Sunday 19 May'));
    expect(await save()).toBe(true);
    undo();
    let d = useEditor.getState().draft;
    expect([textOf(d, 's1'), textOf(d, 's2'), textOf(d, 's3')]).toEqual([
      'Welcome!',
      'Potluck on Sunday 12 May',
      'Amazing grace, how sweet',
    ]);
    undo();
    d = useEditor.getState().draft;
    expect([textOf(d, 's1'), textOf(d, 's3')]).toEqual(['Welcome', 'Amazing grace, how sweet']);
    expect(useEditor.getState().canUndo).toBe(false);
    redo();
    redo();
    expect(textOf(useEditor.getState().draft, 's2')).toBe('Potluck on Sunday 19 May');
  });

  it('keeps edits made while the save was in flight', async () => {
    hub.saveOther((p) => setText(p, 's3', 'song', 'Amazing grace, how sweet'));
    change((p) => setText(p, 's2', 'date', 'Potluck on Sunday 19 May'));
    hub.beforePut = (h) => {
      if (h.puts.length === 1) change((p) => setText(p, 's1', 't1', 'Welcome, friends'));
    };
    expect(await save()).toBe(true);
    expect([textOf(hub.stored, 's1'), textOf(hub.stored, 's2'), textOf(hub.stored, 's3')]).toEqual([
      'Welcome, friends',
      'Potluck on Sunday 19 May',
      'Amazing grace, how sweet',
    ]);
  });

  it('keeps the selection to what still exists after the merge', async () => {
    hub.saveOther((p) => deleteSlide(p, 's1'));
    selectSlide('s1');
    selectObject('t1');
    change((p) => setText(p, 's2', 'date', 'Potluck on Sunday 19 May'));
    expect(await save()).toBe(true);
    expect(useEditor.getState().slideId).toBe('s2');
    expect(useEditor.getState().objectIds).toEqual([]);
  });

  it('nothing left to save when theirs holds my change already', async () => {
    hub.saveOther((p) => setText(p, 's2', 'date', 'Potluck on Sunday 19 May'));
    change((p) => setText(p, 's2', 'date', 'Potluck on Sunday 19 May'));
    expect(await save()).toBe(true);
    expect(hub.puts).toHaveLength(1);
    expect(useEditor.getState()).toMatchObject({ dirty: false, conflict: false });
    expect(useEditor.getState().base?.rev).toBe(5);
  });

  it('a second 409 merges again; past three merges it asks', async () => {
    hub.saveOther((p) => setText(p, 's3', 'song', 'Grace 1'));
    let n = 1;
    hub.beforePut = (h) => {
      if (h.puts.length > 1) h.saveOther((p) => setText(p, 's3', 'song', `Grace ${++n}`));
    };
    change((p) => setText(p, 's2', 'date', 'Potluck on Sunday 19 May'));
    expect(await save()).toBe(false);
    expect(hub.puts).toHaveLength(4);
    expect(useEditor.getState()).toMatchObject({ conflict: true, mergeConflicts: [], dirty: true });
    // Each try carried the newest merge: my edit on their latest.
    expect(textOf(hub.puts[3]!.body, 's3')).toBe('Grace 3');
    expect(textOf(hub.puts[3]!.body, 's2')).toBe('Potluck on Sunday 19 May');
  });

  it('the same box changed on both sides opens the dialog with what overlaps; nothing is saved', async () => {
    hub.saveOther((p) => setText(p, 's2', 'date', 'Potluck on Saturday 18 May'));
    change((p) => setText(p, 's2', 'date', 'Potluck on Sunday 19 May'));
    expect(await save()).toBe(false);
    expect(hub.puts).toHaveLength(1);
    expect(hub.stored.rev).toBe(5);
    const ed = useEditor.getState();
    expect(ed).toMatchObject({ conflict: true, dirty: true });
    expect(ed.base?.rev).toBe(4);
    expect(ed.mergeConflicts.map((c) => c.what)).toEqual([
      'Slide 2: both changed the text box “Potluck on Sunday 12 May”',
    ]);
    // 'Save mine anyway' saves over theirs without merging.
    expect(await save(true)).toBe(true);
    expect(textOf(hub.stored, 's2')).toBe('Potluck on Sunday 19 May');
    expect(useEditor.getState()).toMatchObject({ conflict: false, mergeConflicts: [], dirty: false });
  });

  it('without a version in the answer it asks, as before', async () => {
    const plain = hub.fetch;
    hub.fetch = async (url, init) => {
      const r = await plain(url, init);
      if (r.status !== 409) return r;
      return new Response(JSON.stringify({ error: { code: 'conflict', message: 'Changed' } }), {
        status: 409,
      });
    };
    hub.saveOther((p) => setText(p, 's3', 'song', 'Amazing grace, how sweet'));
    change((p) => setText(p, 's2', 'date', 'Potluck on Sunday 19 May'));
    expect(await save()).toBe(false);
    expect(useEditor.getState()).toMatchObject({ conflict: true, mergeConflicts: [] });
  });

  it('opening a presentation clears what the last conflict said', () => {
    useEditor.setState({
      conflict: true,
      mergeConflicts: [{ level: 'presentation', key: 'title', what: 'Presentation: both changed the title' }],
    });
    openPresentation(deck());
    expect(useEditor.getState()).toMatchObject({ conflict: false, mergeConflicts: [] });
  });
});

describe('taking over a PowerPoint job’s revision with unsaved edits', () => {
  it('an undo after a re-import was taken over keeps the re-import, and so does the next save', async () => {
    change((p) => setText(p, 's1', 't1', 'Welcome!'));
    change((p) => setText(p, 's3', 'song', 'Amazing grace!!'));
    // The re-import saves revision 5: slide 2 rebuilt from PowerPoint.
    hub.saveOther((p) => setText(p, 's2', 'date', 'REBUILT FROM POWERPOINT'), 'pptx-reimport');
    expect(await adoptJobSaves()).toBe('adopted');
    let d = useEditor.getState().draft;
    expect([textOf(d, 's1'), textOf(d, 's2'), textOf(d, 's3')]).toEqual([
      'Welcome!',
      'REBUILT FROM POWERPOINT',
      'Amazing grace!!',
    ]);
    undo();
    d = useEditor.getState().draft;
    expect([textOf(d, 's1'), textOf(d, 's2'), textOf(d, 's3')]).toEqual([
      'Welcome!',
      'REBUILT FROM POWERPOINT',
      'Amazing grace',
    ]);
    expect(await save()).toBe(true);
    expect(hub.stored.rev).toBe(6);
    expect(textOf(hub.stored, 's2')).toBe('REBUILT FROM POWERPOINT');
    // Both undone: the job's revision as it was saved; redo brings the edits back on top of it.
    undo();
    d = useEditor.getState().draft;
    expect([textOf(d, 's1'), textOf(d, 's2')]).toEqual(['Welcome', 'REBUILT FROM POWERPOINT']);
    redo();
    expect(textOf(useEditor.getState().draft, 's1')).toBe('Welcome!');
  });

  it('a follow-up’s revision (LibreOffice) is taken slide by slide, and undo moves with it too', async () => {
    change((p) => setText(p, 's1', 't1', 'Welcome!'));
    hub.saveOther((p) => setText(p, 's2', 'date', 'ART FROM LIBREOFFICE'), 'pptx-lo');
    expect(await adoptJobSaves()).toBe('adopted');
    undo();
    const d = useEditor.getState().draft;
    expect([textOf(d, 's1'), textOf(d, 's2')]).toEqual(['Welcome', 'ART FROM LIBREOFFICE']);
    expect(d?.rev).toBe(5);
  });

  it('a slide the re-import rebuilt that the volunteer also changed is not dropped either way', async () => {
    change((p) => setText(p, 's2', 'date', 'Potluck on Sunday 19 May'));
    hub.saveOther((p) => setText(p, 's2', 'date', 'REBUILT FROM POWERPOINT'), 'pptx-reimport');
    // Not taken over silently: the editor keeps the volunteer's version, and the save asks.
    expect(await adoptJobSaves()).toBe('other');
    expect(textOf(useEditor.getState().draft, 's2')).toBe('Potluck on Sunday 19 May');
    expect(await save()).toBe(false);
    expect(useEditor.getState().mergeConflicts.map((c) => c.what)).toEqual([
      'Slide 2: both changed the text box “Potluck on Sunday 12 May”',
    ]);
    expect(textOf(hub.stored, 's2')).toBe('REBUILT FROM POWERPOINT');
  });
});

describe('History.rebase', () => {
  it('moves every step; a step that cannot move cuts off those past it', () => {
    const h = new History<number>(200, 0);
    for (const n of [1, 2, 3, 4]) h.push(n, undefined, n * 1000);
    expect(h.undo(5)).toBe(4);
    // past [1, 2, 3], future [5]
    h.rebase((n) => (n === 2 ? undefined : n * 10));
    expect(h.undo(40)).toBe(30);
    expect(h.undo(30)).toBeUndefined();
    expect(h.redo(30)).toBe(40);
    expect(h.redo(40)).toBe(50);
    expect(h.canRedo).toBe(false);
  });
});

describe('the conflict dialog', () => {
  const noop = () => undefined;
  const text = (html: string) =>
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  const conflict = (what: string, i = 0): MergeConflict => ({ level: 'object', key: `o${i}`, what });

  it('lists what could not be merged and keeps the two ways out, Cancel first and focused', () => {
    const html = renderToStaticMarkup(
      createElement(ConflictDialogView, {
        conflicts: [
          conflict('Slide 2: both changed the text box “Potluck on Sunday 12 May”'),
          conflict('Slide 5: both changed the notes', 1),
        ],
        onCancel: noop,
        onReload: noop,
        onSaveMine: noop,
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(text(html)).toContain('Changed by someone else');
    expect(text(html)).toContain('these changes overlap');
    const items = html.match(/<li>[^<]*<\/li>/g)!.map(text);
    expect(items).toEqual([
      'Slide 2: both changed the text box “Potluck on Sunday 12 May”',
      'Slide 5: both changed the notes',
    ]);
    expect(html).toContain('aria-labelledby="ordo-merge-conflicts"');
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => [m[0], text(m[1]!)]);
    expect(buttons.map((b) => b[1])).toEqual([
      '✕',
      'Cancel',
      'Reload theirs (discard mine)',
      'Save mine anyway',
    ]);
    expect(buttons[0]![0]).toContain('aria-label="Close"');
    expect(buttons[3]![0]).toContain('class="primary"');
  });

  it('names eight and counts the rest', () => {
    const many = Array.from({ length: 11 }, (_, i) => conflict(`Slide ${i + 1}: both changed the notes`, i));
    const html = renderToStaticMarkup(
      createElement(ConflictDialogView, {
        conflicts: many,
        onCancel: noop,
        onReload: noop,
        onSaveMine: noop,
      }),
    );
    const items = html.match(/<li>.*?<\/li>/g)!.map(text);
    expect(items).toHaveLength(9);
    expect(items[8]).toBe('and 3 more');
  });

  it('says what it always said when there was nothing to merge', () => {
    const html = renderToStaticMarkup(
      createElement(ConflictDialogView, { conflicts: [], onCancel: noop, onReload: noop, onSaveMine: noop }),
    );
    expect(html).not.toContain('<ul');
    expect(text(html)).toContain('Saving yours replaces theirs (their version stays in the history)');
  });
});
