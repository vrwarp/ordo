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
 * focused button presses that button), and a key pressed with focus elsewhere does nothing. The Stream Deck
 * and MIDI are not keys and keep working (design/15 "Dialogs", design/19).
 */
const modals: object[] = [];

/** Register a mounted modal dialog; returns its removal. */
export function registerModal(): () => void {
  const me = {};
  modals.push(me);
  return () => {
    const i = modals.indexOf(me);
    if (i >= 0) modals.splice(i, 1);
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
