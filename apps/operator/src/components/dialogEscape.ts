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

/**
 * Bottom sheets (design/28 §2.2 "Sheets", the compact layout only): while one is open the page behind it,
 * `#root`, is `inert` (sheets are portalled to `body`, outside it), so a tap, a screen reader or Tab never
 * reaches the frame under the sheet. Counted like the modals: the last sheet to close lifts it. The compact
 * sign-in over an ended session is a layer of its own (also outside `#root`) and holds it too.
 */
const sheets: { dismiss?: () => void }[] = [];

function setRootInert(doc: Document, on: boolean): void {
  const root = doc.getElementById('root');
  if (!root) return;
  if (on) root.setAttribute('inert', '');
  else root.removeAttribute('inert');
}

/**
 * Register an open sheet: `#root` turns inert; returns its removal (the last one lifts it). `dismiss` closes
 * it when every sheet must go (`dismissSheets`); a layer without one stays.
 */
export function registerSheet(doc: Document = document, dismiss?: () => void): () => void {
  const me = { dismiss };
  sheets.push(me);
  setRootInert(doc, true);
  return () => {
    const i = sheets.indexOf(me);
    if (i >= 0) sheets.splice(i, 1);
    if (!sheets.length) setRootInert(doc, false);
  };
}

/**
 * Close every open sheet that can be closed (the session ended under them: review of P0, the sign-in over an
 * ended session drawn above a sheet the page could no longer see, its keypad taps landing on the sheet). Each
 * closes through its own onClose, as a tap on its close button does.
 */
export function dismissSheets(): void {
  for (const s of [...sheets].reverse()) s.dismiss?.();
}

/** Sheets open (for tests). */
export function openSheetCount(): number {
  return sheets.length;
}

/**
 * The control a sheet opens from, to focus again when it closes. Safari does not focus a button it taps, so
 * the last control pressed (within a second, still in the document) stands in when nothing has focus.
 */
let lastPressed: { el: HTMLElement; at: number } | undefined;

const CONTROL = 'button, a[href], input, select, textarea, [role="button"], [tabindex]';

/** Record presses on the compact layout (CompactFrame installs it); returns the removal. */
export function trackPresses(doc: Document = document): () => void {
  const record = (e: Event) => {
    const t = e.target as Element | null;
    const el = t && typeof t.closest === 'function' ? t.closest<HTMLElement>(CONTROL) : null;
    if (el) lastPressed = { el, at: Date.now() };
  };
  doc.addEventListener('pointerdown', record, true);
  return () => {
    doc.removeEventListener('pointerdown', record, true);
    lastPressed = undefined;
  };
}

/** The element to focus when a sheet that opens now closes (null when none). */
export function openerFor(doc: Document | undefined = globalThis.document): HTMLElement | null {
  if (!doc) return null;
  const a = doc.activeElement as HTMLElement | null;
  if (a && a !== doc.body && a !== doc.documentElement) return a;
  if (lastPressed && lastPressed.el.isConnected && Date.now() - lastPressed.at < 1000) return lastPressed.el;
  return null;
}
