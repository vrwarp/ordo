import { DEFAULT_KEYMAP } from '@ordo/domain';
import { KeyboardDriver } from '@ordo/surfaces';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type FocusBox,
  type FocusControl,
  type FocusDoc,
  installDialogEscape,
  modalOpen,
  openDialogCount,
  registerModal,
  tabbables,
} from '../src/components/dialogEscape.ts';

type Fn = (e: Event) => void;

/** A window as far as keydown goes: every capture listener runs before any bubble listener, as in a browser. */
class FakeWindow {
  private ls: { fn: Fn; capture: boolean }[] = [];
  addEventListener(_t: string, fn: Fn, o?: boolean | AddEventListenerOptions): void {
    this.ls.push({ fn, capture: typeof o === 'boolean' ? o : !!o?.capture });
  }
  removeEventListener(_t: string, fn: Fn, o?: boolean | EventListenerOptions): void {
    const capture = typeof o === 'boolean' ? o : !!o?.capture;
    this.ls = this.ls.filter((l) => l.fn !== fn || l.capture !== capture);
  }
  /** `inner` runs between the phases, as a listener on the dialog's own elements would. */
  press(key: string, inner?: (e: KeyEv) => void, target: unknown = null): KeyEv {
    const e = new KeyEv(key, target);
    for (const l of this.ls.filter((x) => x.capture)) if (!e.stopped) l.fn(e as unknown as Event);
    inner?.(e);
    for (const l of this.ls.filter((x) => !x.capture)) if (!e.stopped) l.fn(e as unknown as Event);
    return e;
  }
}

class KeyEv {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey = false;
  readonly metaKey = false;
  readonly altKey = false;
  readonly shiftKey = false;
  readonly repeat = false;
  readonly isComposing = false;
  readonly target: unknown;
  defaultPrevented = false;
  stopped = false;
  constructor(key: string, target: unknown = null) {
    this.key = key;
    this.code = key;
    this.target = target;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.stopped = true;
  }
}

describe('Escape in a dialog (review 2026-11-13: it closed the dialog and cleared the live slide)', () => {
  const offs: (() => void)[] = [];
  afterEach(() => {
    for (const off of offs.splice(0)) off();
  });

  it('closes the dialog and never reaches the live keys, though they listened first', () => {
    const w = new FakeWindow();
    const dispatch = vi.fn();
    expect(DEFAULT_KEYMAP.Escape?.id).toBe('clearSlide');
    const keys = new KeyboardDriver(DEFAULT_KEYMAP, dispatch);
    keys.attach(w as unknown as Window);
    const close = vi.fn();
    offs.push(installDialogEscape(close, w));
    const e = w.press('Escape');
    expect(close).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    // Once it is closed, Escape clears the slide again.
    offs.pop()!();
    w.press('Escape');
    expect(dispatch).toHaveBeenLastCalledWith({ id: 'clearSlide' }, 'keyboard');
    expect(close).toHaveBeenCalledTimes(1);
    keys.detach(w as unknown as Window);
  });

  it('closes only the dialog opened last, then the one below it', () => {
    const w = new FakeWindow();
    const below = vi.fn();
    const top = vi.fn();
    offs.push(installDialogEscape(below, w));
    const offTop = installDialogEscape(top, w);
    expect(openDialogCount()).toBe(2);
    w.press('Escape');
    expect(top).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    offTop();
    w.press('Escape');
    expect(below).toHaveBeenCalledTimes(1);
  });

  it('leaves the dialog open when a popover inside it takes Escape to close itself', () => {
    const w = new FakeWindow();
    const dispatch = vi.fn();
    const keys = new KeyboardDriver(DEFAULT_KEYMAP, dispatch);
    keys.attach(w as unknown as Window);
    const close = vi.fn();
    offs.push(installDialogEscape(close, w));
    w.press('Escape', (e) => e.stopPropagation());
    expect(close).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    keys.detach(w as unknown as Window);
  });

  it('ignores other keys', () => {
    const w = new FakeWindow();
    const close = vi.fn();
    offs.push(installDialogEscape(close, w));
    const e = w.press('Enter');
    expect(close).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("no live key acts while a modal dialog is open, closable or not; Space stays the focused button's", () => {
    const w = new FakeWindow();
    const dispatch = vi.fn();
    // The operator's driver (services/surfaces.ts): blocked while a modal is open.
    const keys = new KeyboardDriver(DEFAULT_KEYMAP, dispatch, { blocked: modalOpen });
    keys.attach(w as unknown as Window);
    expect(modalOpen()).toBe(false);
    // A Confirm (closable) over Diagnostics (closable), then a dialog without a close button.
    const offDiag = registerModal();
    offs.push(installDialogEscape(vi.fn(), w));
    const offConfirm = registerModal();
    expect(modalOpen()).toBe(true);
    // The focus on the Confirm's autofocused OK, inside the dialog's `data-keys="off"` backdrop.
    const ok = {
      tagName: 'BUTTON',
      isContentEditable: false,
      closest: (s: string) => s === '[data-keys="off"]',
    };
    for (const key of ['Space', 'PageDown', 'ArrowRight', 'F1', 'Enter']) {
      const e = w.press(key, undefined, ok);
      // Left alone, default included: Space on the Confirm's autofocused OK presses OK.
      expect(e.defaultPrevented, key).toBe(false);
    }
    expect(dispatch).not.toHaveBeenCalled();
    // A key that reached the page behind it (the focus on Clear all) does nothing, its default included:
    // Space would press Clear all (review r2a: two Spaces blacked every Audience screen behind Diagnostics).
    const clearAll = { tagName: 'BUTTON', isContentEditable: false, closest: () => null };
    for (const key of ['Space', 'Enter', 'ArrowDown', 'F2'])
      expect(w.press(key, undefined, clearAll).defaultPrevented, key).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    offConfirm();
    expect(modalOpen()).toBe(true);
    w.press('Space');
    expect(dispatch).not.toHaveBeenCalled();
    offDiag();
    offs.pop()!();
    const offBare = registerModal();
    w.press('PageDown');
    expect(dispatch).not.toHaveBeenCalled();
    offBare();
    // Every dialog closed: the keys are live again.
    expect(modalOpen()).toBe(false);
    const e = w.press('Space');
    expect(dispatch).toHaveBeenLastCalledWith({ id: 'next' }, 'keyboard');
    expect(e.defaultPrevented).toBe(true);
    keys.detach(w as unknown as Window);
  });
});

/** A dialog box of fake controls, and a document whose focus they move. */
function fakeDialog(names: string[], doc: FakeDoc) {
  const box = new FakeBox(doc);
  for (const n of names) box.controls.push(new FakeControl(n, doc, box));
  return box;
}

class FakeDoc implements FocusDoc {
  activeElement: unknown = null;
  private ls: ((e: FocusEvent) => void)[] = [];
  addEventListener(_t: 'focusin', fn: (e: FocusEvent) => void): void {
    this.ls.push(fn);
  }
  removeEventListener(_t: 'focusin', fn: (e: FocusEvent) => void): void {
    this.ls = this.ls.filter((f) => f !== fn);
  }
  /** Focus moves to `el` (a browser's Tab, a click, a script): focusin, then the listeners may move it on. */
  move(el: unknown): void {
    this.activeElement = el;
    for (const fn of [...this.ls]) fn({ target: el } as unknown as FocusEvent);
  }
}

class FakeControl implements FocusControl {
  readonly tabIndex = 0;
  disabled = false;
  readonly name: string;
  private doc: FakeDoc;
  readonly box: FakeBox | null;
  constructor(name: string, doc: FakeDoc, box: FakeBox | null) {
    this.name = name;
    this.doc = doc;
    this.box = box;
  }
  focus(): void {
    this.doc.activeElement = this;
  }
  closest(): unknown {
    return null;
  }
}

class FakeBox implements FocusBox {
  readonly controls: FakeControl[] = [];
  private ls: ((e: KeyboardEvent) => void)[] = [];
  private doc: FakeDoc;
  constructor(doc: FakeDoc) {
    this.doc = doc;
  }
  contains(n: unknown): boolean {
    return n === this || this.controls.includes(n as FakeControl);
  }
  focus(): void {
    this.doc.activeElement = this;
  }
  querySelectorAll(): ArrayLike<unknown> {
    return this.controls;
  }
  addEventListener(_t: 'keydown', fn: (e: KeyboardEvent) => void): void {
    this.ls.push(fn);
  }
  removeEventListener(_t: 'keydown', fn: (e: KeyboardEvent) => void): void {
    this.ls = this.ls.filter((f) => f !== fn);
  }
  /** Tab pressed in the box: the trap may move the focus; else the browser moves it to the next control. */
  tab(shiftKey = false): void {
    let prevented = false;
    const e = { key: 'Tab', shiftKey, defaultPrevented: false, preventDefault: () => (prevented = true) };
    for (const fn of [...this.ls]) fn(e as unknown as KeyboardEvent);
    if (prevented) return;
    const i = this.controls.indexOf(this.doc.activeElement as FakeControl);
    const next = this.controls[shiftKey ? i - 1 : i + 1];
    // Past either end the browser leaves the box: onto the page behind it.
    this.doc.move(next ?? new FakeControl(shiftKey ? 'Clear all' : 'page after', this.doc, null));
  }
}

const focused = (doc: FakeDoc) => (doc.activeElement as { name?: string } | null)?.name ?? 'box';

describe('the focus stays in the topmost dialog (review r2a: Shift+Tab reached Clear all behind Diagnostics)', () => {
  it('Tab and Shift+Tab cycle over its own controls, from the box itself too', () => {
    const doc = new FakeDoc();
    const box = fakeDialog(['Close', 'Cancel', 'End service'], doc);
    const off = registerModal(box, doc);
    box.focus();
    box.tab(true);
    expect(focused(doc)).toBe('End service');
    box.tab(true);
    box.tab(true);
    expect(focused(doc)).toBe('Close');
    box.tab(true);
    expect(focused(doc)).toBe('End service');
    box.tab();
    expect(focused(doc)).toBe('Close');
    box.focus();
    box.tab();
    expect(focused(doc)).toBe('Close');
    // A disabled control is skipped; a dialog with none keeps the focus on its box.
    box.controls[0]!.disabled = true;
    expect(tabbables(box).map((c) => (c as FakeControl).name)).toEqual(['Cancel', 'End service']);
    for (const c of box.controls) c.disabled = true;
    box.tab();
    expect(focused(doc)).toBe('box');
    off();
  });

  it('focus that lands outside it comes back; a popover it opened keeps it', () => {
    const doc = new FakeDoc();
    const box = fakeDialog(['Close', 'Resync'], doc);
    const off = registerModal(box, doc);
    doc.move(new FakeControl('Clear all', doc, null));
    expect(focused(doc)).toBe('box');
    const popover = {
      closest: (s: string) => (s === '[role="dialog"]:not(.dialog)' ? {} : null),
      name: 'colour',
    };
    doc.move(popover);
    expect(focused(doc)).toBe('colour');
    off();
    // Closed: the page has the focus to itself again.
    doc.move(new FakeControl('Clear all', doc, null));
    expect(focused(doc)).toBe('Clear all');
  });

  it('only the topmost traps; when it closes the one below gets the focus back', () => {
    const doc = new FakeDoc();
    const diag = fakeDialog(['Close', 'Resync'], doc);
    const offDiag = registerModal(diag, doc);
    const confirm = fakeDialog(['Close', 'Cancel', 'OK'], doc);
    const offConfirm = registerModal(confirm, doc);
    confirm.controls[2]!.focus();
    // Focus pushed into Diagnostics while the Confirm is on top goes back to the Confirm.
    doc.move(diag.controls[1]);
    expect(doc.activeElement).toBe(confirm);
    offConfirm();
    expect(doc.activeElement).toBe(diag);
    diag.tab(true);
    expect(focused(doc)).toBe('Resync');
    offDiag();
    expect(modalOpen()).toBe(false);
  });
});
