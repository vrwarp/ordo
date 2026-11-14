import { type RefObject, useLayoutEffect, useRef } from 'react';
import { registerPopup } from './dialogEscape.ts';

/**
 * A popup that a control opened and the page renders elsewhere (portalled to the body so that no scrolling box
 * clips it: a Menu's list, the colour picker) belongs where its control, the anchor, is. While it is mounted:
 * - the dialogs' focus trap counts it as part of the dialog its anchor is in (`registerPopup`), so a click on an
 *   item, the arrows and Tab may move the focus into it;
 * - where the anchor's keys are a dialog's own (`data-keys="off"`, Dialog's backdrop), so are the popup's: the
 *   live KeyboardDriver, blocked while a modal is open, leaves Enter and Space on its items to press them.
 * Anywhere else it is outside both, as before (design/15 "Dialogs"). `close` (the latest one is called) closes it
 * when a dialog that is not its anchor's opens while it is open: it is drawn above the dialog's backdrop.
 */
export function usePopupOf(
  popup: RefObject<HTMLElement | null>,
  anchor: RefObject<HTMLElement | null> | HTMLElement | null | undefined,
  open = true,
  close?: () => void,
): void {
  const closeNow = useRef(close);
  closeNow.current = close;
  useLayoutEffect(() => {
    const el = popup.current;
    const at = anchor && 'current' in anchor ? anchor.current : anchor;
    if (!open || !el || !at) return;
    const keysOff = !!at.closest('[data-keys="off"]') && el.getAttribute('data-keys') !== 'off';
    if (keysOff) el.setAttribute('data-keys', 'off');
    const off = registerPopup(el, at, () => closeNow.current?.());
    return () => {
      off();
      if (keysOff) el.removeAttribute('data-keys');
    };
  }, [popup, anchor, open]);
}
