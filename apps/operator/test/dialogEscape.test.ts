import { DEFAULT_KEYMAP } from '@ordo/domain';
import { KeyboardDriver } from '@ordo/surfaces';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDialogEscape, openDialogCount } from '../src/components/dialogEscape.ts';

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
  press(key: string, inner?: (e: KeyEv) => void): KeyEv {
    const e = new KeyEv(key);
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
  readonly target = null;
  defaultPrevented = false;
  stopped = false;
  constructor(key: string) {
    this.key = key;
    this.code = key;
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
    // Other live keys still work while a dialog is open, and Escape clears the slide again once it is closed.
    w.press('Space');
    expect(dispatch).toHaveBeenLastCalledWith({ id: 'next' }, 'keyboard');
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
});
