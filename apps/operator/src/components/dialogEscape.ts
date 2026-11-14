/**
 * Escape closes the topmost open dialog, and only that: the live keys never see it (design/15 "Dialogs").
 *
 * The live KeyboardDriver listens for keydown on `window` (bubble phase) and maps Escape to Clear slide; it
 * skips an event whose default is prevented. A dialog therefore marks Escape as handled in the capture phase
 * on `window`, which runs before any bubble listener whatever the order they were added in, and closes in
 * the bubble phase. A popover inside the dialog (a menu, the colour picker) that stops Escape's propagation
 * to close itself first keeps the dialog open, as before. With dialogs stacked (a Confirm over Diagnostics)
 * only the last one opened closes.
 */

type Target = Pick<Window, 'addEventListener' | 'removeEventListener'>;

const open: object[] = [];

/**
 * Every mounted Dialog, closable or not. While one is open no live key acts (`modalOpen`, the operator's
 * KeyboardDriver and its Clear all hold): a key pressed in a dialog is the dialog's (Space or Enter on its
 * focused button presses that button), and a key pressed with focus elsewhere does nothing, its browser
 * default included (the KeyboardDriver keeps Space, Enter and the arrows from a control behind the dialog).
 * The focus stays in the topmost dialog (`registerModal` with its box): Tab and Shift+Tab cycle over its own
 * controls, and focus that lands outside it comes back, unless it lands in a popup the dialog opened (a Menu's
 * list portalled to the body, `registerPopup`). The Stream Deck and MIDI are not keys and keep working
 * (design/15 "Dialogs", design/19).
 */
const modals: { box?: FocusBox }[] = [];

/** What the focus trap needs of a dialog's box (an HTMLElement; tests pass a fake). */
export interface FocusBox {
  contains(n: unknown): boolean;
  focus(o?: FocusOptions): void;
  querySelectorAll(selector: string): ArrayLike<unknown>;
}

/** What the focus trap needs of a popup portalled out of its anchor's place (an HTMLElement; tests pass a fake). */
export interface PopupBox {
  contains(n: unknown): boolean;
}

/** A control the focus can land on. */
export interface FocusControl {
  readonly tabIndex: number;
  readonly disabled?: boolean;
  focus(o?: FocusOptions): void;
  closest(selector: string): unknown;
}

/** What the focus trap needs of the document. */
export interface FocusDoc {
  readonly activeElement: unknown;
  addEventListener(type: 'focusin', fn: (e: FocusEvent) => void, o: { capture: boolean }): void;
  addEventListener(type: 'keydown', fn: (e: KeyboardEvent) => void, o: { capture: boolean }): void;
  removeEventListener(type: 'focusin', fn: (e: FocusEvent) => void, o: { capture: boolean }): void;
  removeEventListener(type: 'keydown', fn: (e: KeyboardEvent) => void, o: { capture: boolean }): void;
}

const TABBABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

/** The controls of `box` Tab moves over, in document order. */
export function tabbables(box: FocusBox): FocusControl[] {
  return (Array.from(box.querySelectorAll(TABBABLE)) as FocusControl[]).filter(
    (el) => el.tabIndex >= 0 && !el.disabled && !el.closest('[hidden], [inert]'),
  );
}

/** The open popups that a control opened and the page renders elsewhere, with that control (`registerPopup`). */
const popups: { popup: PopupBox; anchor: unknown }[] = [];

/**
 * Register an open popup that a control (`anchor`) opened and the page renders elsewhere: a Menu's list and the
 * colour picker, portalled to the body so that no scrolling box clips them. For the focus trap the popup is where
 * its anchor is: opened from the topmost dialog it is that dialog's, and the focus may move into it (a click on
 * an item, the arrows, Tab); opened from anywhere else it is outside, as before. Returns its removal.
 */
export function registerPopup(popup: PopupBox, anchor: unknown): () => void {
  const me = { popup, anchor };
  popups.push(me);
  return () => {
    const i = popups.indexOf(me);
    if (i >= 0) popups.splice(i, 1);
  };
}

/**
 * Whether `t` is in the dialog `box`: inside it, or in an open popup whose anchor is (a popup opened from a popup
 * of the dialog too). Nothing else is: not another page element, not a `role="dialog"` card the dialog did not
 * open (the editor's non-modal Find & replace).
 */
export function inDialog(box: FocusBox, t: unknown, depth = 0): boolean {
  if (t === null || t === undefined) return false;
  if (box.contains(t)) return true;
  return depth < 8 && popups.some((p) => p.popup.contains(t) && inDialog(box, p.anchor, depth + 1));
}

/**
 * Register a mounted modal dialog; returns its removal. With its `box` and the document, the focus stays in it
 * while it is the topmost: Tab past its last control goes to its first and Shift+Tab before its first to its last
 * (from the box itself, or from outside it, to the first or the last), and focus that lands outside it (Tab from
 * the page, a script, a click on nothing) is put back on the box. A popup it opened (`registerPopup`) is inside
 * it: the focus may move there, and Tab there is the popup's own (a Menu takes it: past its last item it gives the
 * focus back to its trigger, and the Tab goes on from there). The Tab is handled on the document, after the
 * popup's own handler, since a popup's keys never pass through the box. When it closes, the dialog below it (if
 * any) gets the focus back.
 */
export function registerModal(box?: FocusBox, doc?: FocusDoc): () => void {
  const me: { box?: FocusBox } = box ? { box } : {};
  modals.push(me);
  const top = () => modals[modals.length - 1] === me;
  const onKey = (e: KeyboardEvent) => {
    if (!box || e.key !== 'Tab' || e.defaultPrevented || !top()) return;
    const active = doc?.activeElement;
    // In a popup the dialog opened (a Menu's list): the popup's own.
    if (!box.contains(active) && inDialog(box, active)) return;
    const all = tabbables(box);
    const i = all.indexOf(active as FocusControl);
    if (!all.length) {
      e.preventDefault();
      box.focus({ preventScroll: true });
      return;
    }
    if (e.shiftKey ? i <= 0 : i < 0 || i === all.length - 1) {
      e.preventDefault();
      (e.shiftKey ? all[all.length - 1]! : all[0]!).focus();
    }
  };
  const onFocus = (e: FocusEvent) => {
    if (!box || !top() || inDialog(box, e.target)) return;
    box.focus({ preventScroll: true });
  };
  if (box && doc) {
    doc.addEventListener('keydown', onKey, { capture: false });
    doc.addEventListener('focusin', onFocus, { capture: true });
  }
  return () => {
    if (box && doc) {
      doc.removeEventListener('keydown', onKey, { capture: false });
      doc.removeEventListener('focusin', onFocus, { capture: true });
    }
    const wasTop = top();
    const i = modals.indexOf(me);
    if (i >= 0) modals.splice(i, 1);
    const below = modals[modals.length - 1]?.box;
    if (wasTop && below && doc && !inDialog(below, doc.activeElement)) below.focus({ preventScroll: true });
  };
}

/** Whether a modal dialog is open: the live keys do nothing meanwhile. */
export function modalOpen(): boolean {
  return modals.length > 0;
}

/** Dialogs open with an Escape handler (for tests). */
export function openDialogCount(): number {
  return open.length;
}

/**
 * Register a dialog's Escape handler; returns its removal. `onClose` is read on every Escape, so a caller
 * may pass a getter for the latest callback without re-registering (which would change the stacking order).
 */
export function installDialogEscape(onClose: () => void, target: Target = window): () => void {
  const me = {};
  open.push(me);
  const capture = (e: Event) => {
    if ((e as KeyboardEvent).key === 'Escape') e.preventDefault();
  };
  const bubble = (e: Event) => {
    if ((e as KeyboardEvent).key !== 'Escape' || open[open.length - 1] !== me) return;
    onClose();
  };
  target.addEventListener('keydown', capture, { capture: true });
  target.addEventListener('keydown', bubble);
  return () => {
    target.removeEventListener('keydown', capture, { capture: true });
    target.removeEventListener('keydown', bubble);
    const i = open.indexOf(me);
    if (i >= 0) open.splice(i, 1);
  };
}
