import {
  type KeyboardEvent as KeyEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { usePopupOf } from './popupOf.ts';

export type MenuItem = {
  label: ReactNode;
  /** Accessible name when the label is an icon plus text that reads badly. */
  name?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

const VIEWPORT_PAD = 8;

/**
 * A touch-friendly drop-down menu (design/15 "Touch"): a button that opens a list of 44 px items below it.
 * Portaled to `document.body` with viewport clamping so scrollable sidebars/toolbars never clip it.
 * A tap outside, Escape, or picking an item closes it; nothing depends on hover.
 *
 * The list is where its trigger is for the keys and the focus (`usePopupOf`): opened in a dialog it is the
 * dialog's, so the focus trap lets the focus into it and Enter and Space press its items. Since it is no longer
 * next to its trigger in the page, the keys that reached it by order reach it by hand: with it open, Tab, the
 * Down arrow or Home on the trigger moves to its first item, the Up arrow or End to its last; in it, the arrows
 * move between the items (wrapping; Home and End to the ends), Shift+Tab from the first item goes back to the
 * trigger, and Tab from the last closes it with the focus on the trigger, so the Tab goes on from there.
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
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  // Closing from the keyboard or by picking an item unmounts the focused item: focus goes back to the
  // trigger, as the menu pattern expects, and Escape stops here so the editor does not also deselect.
  const closeToTrigger = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  usePopupOf(listRef, trigger, open);
  /** The items that take the focus, in order. */
  const enabledItems = () =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
  const focusItem = (which: 'first' | 'last') => {
    const all = enabledItems();
    const el = which === 'first' ? all[0] : all[all.length - 1];
    el?.focus();
    return !!el;
  };
  const onTriggerKey = (e: KeyEvent<HTMLButtonElement>) => {
    if (!open) return;
    const into =
      (e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowDown' || e.key === 'Home'
        ? 'first'
        : e.key === 'ArrowUp' || e.key === 'End'
          ? 'last'
          : null;
    if (into && focusItem(into)) e.preventDefault();
  };
  const onListKey = (e: KeyEvent<HTMLDivElement>) => {
    const all = enabledItems();
    const i = all.indexOf(e.target as HTMLButtonElement);
    if (i < 0 || !all.length) return;
    const to =
      e.key === 'ArrowDown'
        ? (i + 1) % all.length
        : e.key === 'ArrowUp'
          ? (i - 1 + all.length) % all.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? all.length - 1
              : -1;
    if (to >= 0) {
      e.preventDefault();
      all[to]!.focus();
    } else if (e.key === 'Tab' && e.shiftKey && i === 0) {
      e.preventDefault();
      trigger.current?.focus();
    } else if (e.key === 'Tab' && !e.shiftKey && i === all.length - 1) {
      // Not prevented: the browser's Tab goes on from the trigger, and a dialog's trap wraps it if need be.
      closeToTrigger();
    }
  };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !listRef.current) return;
    const place = () => {
      if (!trigger.current || !listRef.current) return;
      const tr = trigger.current.getBoundingClientRect();
      const mr = listRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = align === 'right' ? tr.right - mr.width : tr.left;
      left = Math.max(VIEWPORT_PAD, Math.min(left, vw - mr.width - VIEWPORT_PAD));
      let top = tr.bottom + 4;
      if (top + mr.height > vh - VIEWPORT_PAD && tr.top - 4 - mr.height >= VIEWPORT_PAD) {
        top = tr.top - 4 - mr.height;
      } else {
        top = Math.max(VIEWPORT_PAD, Math.min(top, vh - mr.height - VIEWPORT_PAD));
      }
      setPos({ left: Math.round(left), top: Math.round(top) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: closeToTrigger only touches refs and the setter
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (!root.current?.contains(target) && !listRef.current?.contains(target)) {
        setOpen(false);
      }
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
  const menuList = open ? (
    <div
      ref={listRef}
      className={`menu-list ${align}`}
      role="menu"
      aria-label={label}
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
      onKeyDown={onListKey}
    >
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
  ) : null;
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
        onKeyDown={onTriggerKey}
      >
        {label} ▾
      </button>
      {menuList && (typeof document !== 'undefined' ? createPortal(menuList, document.body) : menuList)}
    </span>
  );
}
