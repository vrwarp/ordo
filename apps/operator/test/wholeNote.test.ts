/**
 * The one-line note under the Object panel for an object the editor draws as the lighter copy (design/15
 * "Canvas drawing", OQ-LE2: the owner approved the words). It shows for the selected object only, and only
 * while the editor keeps the simple copy of it on screen: the canvas's whole drawing publishes which candidates
 * are so (views/editor/wholeState.ts), the note reads it. The words, the markup and the panel's place for it are
 * pinned here; when the plan lists an object is wholeDraw.test.ts's. (Server-rendered with `createElement`:
 * vitest runs `*.test.ts` files only.)
 */
import { Presentation, type SlideObject } from '@ordo/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPresentation, useEditor } from '../src/views/editor/editorStore.ts';
import { ObjectPanel } from '../src/views/editor/ObjectPanel.tsx';
import { WHOLE_NOTE, WholeNote, WholeNoteView } from '../src/views/editor/WholeNote.tsx';
import {
  resetWholeStatus,
  setWholeLighter,
  subscribeWholeLighter,
  wholeKeepsLighter,
  wholeSlideKey,
} from '../src/views/editor/wholeState.ts';

const red = { r: 200, g: 40, b: 40, a: 1 };
const star = {
  id: 'star',
  type: 'shape',
  box: { x: 600, y: 100, w: 400, h: 300, rotation: 0 },
  shape: 'rect',
  fill: red,
  opacity: 1,
  radius: 0,
  shadow: { dx: 6, dy: 6, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.55 } },
} as SlideObject;
const plain = { ...star, id: 'plain', shadow: undefined } as SlideObject;

const deck = Presentation.parse({
  id: 'deck',
  title: 'Deck',
  kind: 'slides',
  sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 'sl', objects: [star, plain] }] }],
});

/** Server rendering reads a zustand store's initial state, so the panel test seeds it there too. */
function seed<T extends object>(
  store: { getInitialState: () => T; setState: (p: Partial<T>) => void },
  p: Partial<T>,
) {
  Object.assign(store.getInitialState(), p);
  store.setState(p);
}

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
/** React's `useId` values made equal: they name a component's place in the tree, not what the panel shows. */
const sameIds = (s: string) => s.replace(/_R_[0-9a-zA-Z]+_/g, '_R_');
/** The key the canvas publishes under: the presentation's id and the slide's. */
const KEY = wholeSlideKey('deck', 'sl');

beforeEach(() => {
  resetWholeStatus();
  openPresentation(deck);
  seed(useEditor, { id: 'deck', draft: useEditor.getState().draft!, slideId: 'sl', objectId: undefined });
});
afterEach(() => resetWholeStatus());

describe('the words and the markup (OQ-LE2)', () => {
  it('the words are the owner’s, as approved', () => {
    expect(WHOLE_NOTE).toBe('Too detailed to draw here while you edit; the screens draw it whole.');
  });

  it('shows as one muted small line, marked for the specs, and nothing at all when it is not shown', () => {
    expect(html(createElement(WholeNoteView, { shown: false }))).toBe('');
    const m = html(createElement(WholeNoteView, { shown: true }));
    expect(m).toContain(WHOLE_NOTE);
    expect(m).toContain('class="muted small"');
    expect(m).toContain('data-whole-note');
    // One line of text: no control in it (the touch-target audit counts none).
    expect(m).not.toMatch(/<(button|input|select|textarea|a)[ >]/);
  });
});

describe('what the note reads: the canvas’s published list', () => {
  it('says whether the editor keeps the lighter copy of an object of a slide, and tells its listeners only when that changed', () => {
    const seen = vi.fn();
    const off = subscribeWholeLighter(seen);
    expect(wholeKeepsLighter('sl', 'star')).toBe(false);
    setWholeLighter('sl', ['star', 'other']);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(wholeKeepsLighter('sl', 'star')).toBe(true);
    expect(wholeKeepsLighter('sl', 'plain')).toBe(false);
    // The same ids on another slide are not these (ids repeat across slides).
    expect(wholeKeepsLighter('other-slide', 'star')).toBe(false);
    // The same list again, in another order: nothing changed, nobody is told.
    setWholeLighter('sl', ['other', 'star']);
    expect(seen).toHaveBeenCalledTimes(1);
    setWholeLighter('sl', ['other']);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(wholeKeepsLighter('sl', 'star')).toBe(false);
    // Another slide with an empty list after a list: told once.
    setWholeLighter('next', []);
    expect(seen).toHaveBeenCalledTimes(3);
    off();
    setWholeLighter('sl', ['star']);
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it('is forgotten with the status (a test, and the editor closing)', () => {
    setWholeLighter('sl', ['star']);
    resetWholeStatus();
    expect(wholeKeepsLighter('sl', 'star')).toBe(false);
  });
});

describe('the note for the selected object', () => {
  const note = (o: SlideObject, slideId = 'sl') => html(createElement(WholeNote, { o, slideId }));

  it('shows for an object the editor keeps as the lighter copy, and for no other', () => {
    expect(note(star)).toBe('');
    setWholeLighter(KEY, ['star']);
    expect(note(star)).toContain(WHOLE_NOTE);
    expect(note(plain)).toBe('');
    expect(note(star, 'other-slide')).toBe('');
  });

  it('is gone once the whole drawing has replaced the simple one', () => {
    setWholeLighter(KEY, ['star']);
    expect(note(star)).toContain(WHOLE_NOTE);
    setWholeLighter(KEY, []);
    expect(note(star)).toBe('');
  });
});

describe('the Object panel', () => {
  const panel = (o: SlideObject) => html(createElement(ObjectPanel, { o, readOnly: false }));

  it('carries the note under the object’s name, once, for the selected object that keeps the copy', () => {
    const none = panel(star);
    expect(none).not.toContain('data-whole-note');
    setWholeLighter(KEY, ['star']);
    const shown = panel(star);
    expect(shown.split(WHOLE_NOTE)).toHaveLength(2);
    // Under the heading row, before the fields: the Box fields follow it.
    const at = shown.indexOf('data-whole-note');
    expect(at).toBeGreaterThan(shown.indexOf('Shape ('));
    expect(at).toBeLessThan(shown.indexOf('Opacity'));
    // Nothing else of the panel changed: with the note taken out it is the panel without one.
    expect(sameIds(shown.replace(/<div class="muted small" data-whole-note="true">[^<]*<\/div>/, ''))).toBe(
      sameIds(none),
    );
    // An object that is not listed has the panel it had.
    expect(panel(plain)).not.toContain('data-whole-note');
  });
});
