import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCurrentLayout } from '../lib/layout.ts';
import { installDialogEscape, openerFor, registerModal, registerSheet } from './dialogEscape.ts';

export function Dialog(props: {
  title: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const { onClose } = props;
  // The compact layout (a phone) shows every dialog as a bottom sheet (design/28 §2.2 "Sheets"); the regular
  // layout's dialog below is unchanged (the live keys' focus rules of design/15 "Dialogs" depend on it).
  const sheet = useCurrentLayout() === 'compact';
  // The control the sheet opened from, read before this dialog takes focus (a sheet only).
  const [opener] = useState(() => (sheet ? openerFor() : null));
  const titleId = useId();
  // The latest callback, read on Escape: registering again on every render would reorder stacked dialogs.
  const close = useRef(onClose);
  close.current = onClose;
  const closable = !!onClose;
  useEffect(() => (closable ? installDialogEscape(() => close.current?.()) : undefined), [closable]);
  // Modal: no live key acts while it is open (dialogEscape.ts `modalOpen`), and a key pressed inside it is its
  // own (`data-keys="off"`): Space on its focused OK presses OK, never Next. Focus moves into it unless a
  // control of its own took it (autoFocus), so Space can never press the button that opened it.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = registerModal();
    const el = box.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return off;
  }, []);
  // A sheet: the page behind it is inert while it is open, and focus returns to its opener when it closes.
  useEffect(() => {
    if (!sheet) return;
    const off = registerSheet(document, closable ? () => close.current?.() : undefined);
    return () => {
      off();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [sheet, opener, closable]);
  if (sheet) {
    const content = (
      <div
        className="backdrop sheet-backdrop"
        data-keys="off"
        onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}
      >
        <div
          ref={box}
          className="dialog sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <header>
            <h3 id={titleId}>{props.title}</h3>
            {onClose && (
              <button type="button" className="ghost small" onClick={onClose} aria-label="Close">
                ✕
              </button>
            )}
          </header>
          <div className="body">{props.children}</div>
          {props.footer && <footer>{props.footer}</footer>}
        </div>
      </div>
    );
    // Portalled to body, outside #root, which turns inert behind it (rendered in place without a document).
    return typeof document === 'undefined' ? content : createPortal(content, document.body);
  }
  return (
    <div
      className="backdrop"
      data-keys="off"
      onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div
        ref={box}
        className="dialog"
        style={props.width ? { width: props.width } : undefined}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <header>
          <h3>{props.title}</h3>
          {onClose && (
            <button type="button" className="ghost small" onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </header>
        <div className="body">{props.children}</div>
        {props.footer && <footer>{props.footer}</footer>}
      </div>
    </div>
  );
}
