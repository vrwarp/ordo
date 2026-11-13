/**
 * Where the editor's shortcuts apply (`views/editor/editorKeys.ts`, design/15): a dialog keeps every key, a
 * field its own, a focused button or radio its Enter, Space, arrows and Delete; the canvas gets them all.
 * And the media picker's choosable items (`notChoosable`): 'Replace' and the background replace need a size.
 */
import { describe, expect, it } from 'vitest';
import { notChoosable } from '../src/views/editor/BackgroundPicker.tsx';
import {
  historyKey,
  isTypingTarget,
  keyPlace,
  slideNavKey,
  stepSlide,
} from '../src/views/editor/editorKeys.ts';

/**
 * Whether an element, described by the selectors it matches run together (e.g. '[role="dialog"][data-nonmodal]'),
 * matches a simple selector with at most one :not().
 */
function matches(d: string, sel: string): boolean {
  const m = /^(.*?)(?::not\((.*)\))?$/.exec(sel.trim());
  return !!m && d.includes(m[1] ?? '') && !(m[2] && d.includes(m[2]));
}
const anyMatch = (ds: string[], sel: string) => sel.split(',').some((s) => ds.some((d) => matches(d, s)));

/** A stand-in element: its tag, and the elements (as selectors) it sits inside. */
function el(tagName: string, inside: string[] = [], attrs: Record<string, string> = {}) {
  return {
    tagName,
    isContentEditable: attrs.contenteditable === 'true',
    closest: (sel: string) => (anyMatch(inside, sel) ? {} : null),
    hasAttribute: (n: string) => n in attrs,
  } as unknown as EventTarget;
}
/** A stand-in document with these elements (as selectors) open on it. */
const page = (...open: string[]) => ({
  querySelector: (s: string) => (anyMatch(open, s) ? {} : null),
});
/** The floating Find & replace card: a dialog that is not modal (FindReplaceDialog.tsx). */
const FIND = '[role="dialog"][data-nonmodal]';

describe('keyPlace', () => {
  it('the page itself (after a click on the canvas) gets every shortcut', () => {
    expect(keyPlace(el('BODY'), page())).toBe('canvas');
    expect(keyPlace(null, page())).toBe('canvas');
    expect(keyPlace(el('DIV', ['[data-editor-keys]']), page())).toBe('canvas');
  });

  it('a button, link, radio or menu item is a control: it keeps Enter, the arrows and Delete', () => {
    expect(keyPlace(el('BUTTON'), page())).toBe('control');
    expect(keyPlace(el('A'), page())).toBe('control');
    expect(keyPlace(el('BUTTON', ['[role="radiogroup"]']), page())).toBe('control');
    expect(keyPlace(el('DIV'), page())).toBe('control');
  });

  it('a field keeps its own keys', () => {
    for (const t of ['INPUT', 'TEXTAREA', 'SELECT']) expect(keyPlace(el(t), page())).toBe('field');
    expect(keyPlace(el('DIV', [], { contenteditable: 'true' }), page())).toBe('field');
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
  });

  it('inside a dialog, or with one open, nothing behind it reacts', () => {
    expect(keyPlace(el('BUTTON', ['[role="dialog"]']), page())).toBe('dialog');
    expect(keyPlace(el('INPUT', ['.backdrop']), page())).toBe('dialog');
    // The focus left on the page while a dialog is open: still the dialog's.
    expect(keyPlace(el('BODY'), page('.backdrop'))).toBe('dialog');
    expect(keyPlace(el('BODY'), page('[role="dialog"]'))).toBe('dialog');
  });

  it('a non-modal tool card (Find & replace) leaves the canvas its shortcuts', () => {
    // Open, with the focus left on the page (after Replace all, or a click on the canvas): every shortcut.
    expect(keyPlace(el('BODY'), page(FIND))).toBe('canvas');
    // Its own fields and buttons are fields and controls, as anywhere else.
    expect(keyPlace(el('INPUT', [FIND]), page(FIND))).toBe('field');
    expect(keyPlace(el('BUTTON', [FIND]), page(FIND))).toBe('control');
    // A modal opened over it (a colour popover, the revisions dialog) still keeps every key.
    expect(keyPlace(el('BODY'), page(FIND, '[role="dialog"]'))).toBe('dialog');
    expect(keyPlace(el('BUTTON', ['[role="dialog"]']), page(FIND, '[role="dialog"]'))).toBe('dialog');
  });
});

describe('historyKey', () => {
  const k = (
    key: string,
    x: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>,
  ) => historyKey({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...x });
  it('Ctrl or Cmd+Z undoes; Ctrl+Y and Ctrl+Shift+Z redo; nothing else', () => {
    expect(k('z', { ctrlKey: true })).toBe('undo');
    expect(k('Z', { metaKey: true })).toBe('undo');
    expect(k('z', { ctrlKey: true, shiftKey: true })).toBe('redo');
    expect(k('y', { ctrlKey: true })).toBe('redo');
    expect(k('z', {})).toBeUndefined();
    expect(k('z', { ctrlKey: true, altKey: true })).toBeUndefined();
    expect(k('b', { ctrlKey: true })).toBeUndefined();
  });
});

describe('notChoosable', () => {
  it('a picture still being processed (no size yet) cannot be chosen where its size is needed', () => {
    expect(notChoosable({ state: 'uploaded' }, true)).toMatch(/Still being processed/);
    expect(notChoosable({ state: 'processing', width: 800 }, true)).toMatch(/Still being processed/);
    expect(notChoosable({ state: 'failed', width: 800, height: 600 }, true)).toMatch(
      /could not be processed/,
    );
    expect(notChoosable({ state: 'ready', width: 800, height: 600 }, true)).toBeUndefined();
    // A picture whose size the upload already gave can be chosen while its delivery file is made.
    expect(notChoosable({ state: 'processing', width: 800, height: 600 }, true)).toBeUndefined();
    // Elsewhere anything listed can be chosen, as before.
    expect(notChoosable({ state: 'uploaded' }, false)).toBeUndefined();
  });
});

describe('slideNavKey', () => {
  it('navigates with Up/Down and PageUp/PageDown when focus is on page/canvas', () => {
    expect(slideNavKey({ key: 'ArrowUp', target: el('BODY') })).toBe(-1);
    expect(slideNavKey({ key: 'PageUp', target: el('BODY') })).toBe(-1);
    expect(slideNavKey({ key: 'ArrowDown', target: el('BODY') })).toBe(1);
    expect(slideNavKey({ key: 'PageDown', target: el('BODY') })).toBe(1);
  });

  it('ignores keys when typing in a field or inside dialogs/menus/radiogroups', () => {
    expect(slideNavKey({ key: 'ArrowUp', target: el('INPUT') })).toBe(0);
    expect(slideNavKey({ key: 'ArrowDown', target: el('TEXTAREA') })).toBe(0);
    expect(slideNavKey({ key: 'ArrowDown', target: el('DIV', [], { contenteditable: 'true' }) })).toBe(0);
    expect(slideNavKey({ key: 'ArrowDown', target: el('BUTTON', ['[role="radiogroup"]']) })).toBe(0);
    expect(slideNavKey({ key: 'ArrowDown', target: el('DIV', ['[role="menu"]']) })).toBe(0);
    expect(slideNavKey({ key: 'ArrowDown', target: el('DIV', ['[role="dialog"]']) })).toBe(0);
  });

  it('ignores arrow keys with modifiers or default prevented', () => {
    expect(slideNavKey({ key: 'ArrowUp', ctrlKey: true, target: el('BODY') })).toBe(0);
    expect(slideNavKey({ key: 'ArrowDown', altKey: true, target: el('BODY') })).toBe(0);
    expect(slideNavKey({ key: 'ArrowDown', metaKey: true, target: el('BODY') })).toBe(0);
    expect(slideNavKey({ key: 'ArrowDown', defaultPrevented: true, target: el('BODY') })).toBe(0);
  });
});

describe('stepSlide', () => {
  const ids = ['s1', 's2', 's3'];

  it('moves forward and clamps at end', () => {
    expect(stepSlide(ids, 's1', 1)).toBe('s2');
    expect(stepSlide(ids, 's2', 1)).toBe('s3');
    expect(stepSlide(ids, 's3', 1)).toBe('s3');
    expect(stepSlide(ids, undefined, 1)).toBe('s1');
  });

  it('moves backward and clamps at start', () => {
    expect(stepSlide(ids, 's3', -1)).toBe('s2');
    expect(stepSlide(ids, 's2', -1)).toBe('s1');
    expect(stepSlide(ids, 's1', -1)).toBe('s1');
    expect(stepSlide(ids, undefined, -1)).toBe('s1');
  });

  it('handles empty slide list', () => {
    expect(stepSlide([], undefined, 1)).toBeUndefined();
    expect(stepSlide([], 's1', -1)).toBeUndefined();
  });
});
