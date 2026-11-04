import { type ReactNode, useEffect, useRef, useState } from 'react';

export type MenuItem = {
  label: ReactNode;
  /** Accessible name when the label is an icon plus text that reads badly. */
  name?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

/**
 * A touch-friendly drop-down menu (design/15 "Touch"): a button that opens a list of 44 px items below it.
 * A tap outside, Escape, or picking an item closes it; nothing depends on hover.
 */
export function Menu({
  label,
  items,
  disabled,
  align = 'left',
}: {
  label: string;
  items: MenuItem[];
  disabled?: boolean;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Closing from the keyboard or by picking an item unmounts the focused item: focus goes back to the
  // trigger, as the menu pattern expects, and Escape stops here so the editor does not also deselect.
  const closeToTrigger = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: closeToTrigger only touches refs and the setter
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeToTrigger();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <span className="menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className={open ? 'on' : ''}
        onClick={() => setOpen((o) => !o)}
      >
        {label} ▾
      </button>
      {open && (
        <div className={`menu-list ${align}`} role="menu" aria-label={label}>
          {items.map((it, i) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: a static list
              key={i}
              type="button"
              role="menuitem"
              aria-label={it.name}
              className={it.danger ? 'danger-text' : undefined}
              disabled={it.disabled}
              onClick={() => {
                closeToTrigger();
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
