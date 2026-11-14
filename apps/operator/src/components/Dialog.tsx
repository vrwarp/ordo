import { type ReactNode, useEffect, useRef } from 'react';
import { installDialogEscape } from './dialogEscape.ts';

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
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="dialog" style={props.width ? { width: props.width } : undefined} role="dialog">
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
