import { type ReactNode, useEffect, useRef } from 'react';
import { installDialogEscape, registerModal } from './dialogEscape.ts';

export function Dialog(props: {
  title: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const { onClose } = props;
  // The latest callback, read on Escape: registering again on every render would reorder stacked dialogs.
  const close = useRef(onClose);
  close.current = onClose;
  const closable = !!onClose;
  useEffect(() => (closable ? installDialogEscape(() => close.current?.()) : undefined), [closable]);
  // Modal: no live key acts while it is open (dialogEscape.ts `modalOpen`), and a key pressed inside it is its
  // own (`data-keys="off"`): Space on its focused OK presses OK, never Next. Focus moves into it unless a
  // control of its own took it (autoFocus), so Space can never press the button that opened it, and stays in
  // it (`registerModal` with the box): Tab and Shift+Tab cycle over its own controls, never out to Clear all.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    const off = registerModal(el ?? undefined, document);
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return off;
  }, []);
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
