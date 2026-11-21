import {
  type KeyboardEvent as KeyEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';

export type ContextMenuAction = {
  kind?: 'item';
  label: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

export type ContextMenuSeparator = {
  kind: 'separator';
};

export type ContextMenuLabel = {
  kind: 'label';
  label: string;
};

export type ContextMenuSubmenu = {
  kind: 'submenu';
  label: string;
  disabled?: boolean;
  items: ContextMenuEntry[];
};

export type ContextMenuEntry =
  | ContextMenuAction
  | ContextMenuSeparator
  | ContextMenuLabel
  | ContextMenuSubmenu;

export type OpenContextMenuOptions = {
  /** Accessible label for the menu surface. */
  ariaLabel?: string;
  /** Allow opening even when the event target is an input/textarea/contenteditable. */
  allowInField?: boolean;
};

type ContextMenuState = {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
  ariaLabel: string;
} | null;

const VIEWPORT_PAD = 8;

let currentState: ContextMenuState = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): ContextMenuState {
  return currentState;
}

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

/** Format a keyboard shortcut hint using the platform modifier (`⌘` on Mac/iPad, `Ctrl+` elsewhere). */
export function fmtShortcut(key: string, opts?: { shift?: boolean; alt?: boolean }): string {
  if (isMac) {
    return `${opts?.alt ? '⌥' : ''}${opts?.shift ? '⇧' : ''}⌘${key}`;
  }
  return `Ctrl+${opts?.alt ? 'Alt+' : ''}${opts?.shift ? 'Shift+' : ''}${key}`;
}

/** True when `target` is a native editable text control where browser spellcheck/paste menus should win. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown };
  const tag = el.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  if (typeof el.closest === 'function' && el.closest('[contenteditable="true"]')) return true;
  return false;
}

/**
 * Clean up conditional menu entry lists: drops empty submenus, removes leading/trailing/consecutive
 * separators, and returns a normalized list.
 */
export function normalizeContextMenuEntries(
  entries: readonly (ContextMenuEntry | false | null | undefined)[],
): ContextMenuEntry[] {
  const cleaned: ContextMenuEntry[] = [];
  for (const raw of entries) {
    if (!raw) continue;
    if (raw.kind === 'submenu') {
      const sub = normalizeContextMenuEntries(raw.items);
      if (!sub.length) continue;
      cleaned.push({ ...raw, items: sub });
      continue;
    }
    if (raw.kind === 'separator') {
      if (!cleaned.length || cleaned[cleaned.length - 1]?.kind === 'separator') continue;
      cleaned.push(raw);
      continue;
    }
    cleaned.push(raw);
  }
  while (cleaned.length && cleaned[cleaned.length - 1]?.kind === 'separator') {
    cleaned.pop();
  }
  return cleaned;
}

/** Close any open global context menu. */
export function closeContextMenu(): void {
  if (!currentState) return;
  currentState = null;
  notify();
}

/** Open the global context menu at viewport coordinates `(x, y)`. Returns true if opened. */
export function openContextMenuAt(
  x: number,
  y: number,
  rawEntries: readonly (ContextMenuEntry | false | null | undefined)[],
  ariaLabel = 'Context menu',
): boolean {
  const entries = normalizeContextMenuEntries(rawEntries);
  if (!entries.length) {
    closeContextMenu();
    return false;
  }
  currentState = { x, y, entries, ariaLabel };
  notify();
  return true;
}

/**
 * Handle a `contextmenu` event and open the global context menu at the pointer.
 * - Holding `Shift` always falls through to the browser's native context menu.
 * - Editable fields (`input`, `textarea`, `select`, `contenteditable`) fall through unless `allowInField` is set.
 * - Calls `preventDefault()` and `stopPropagation()` only when a non-empty menu opens.
 */
export function openContextMenu(
  e: ReactMouseEvent | MouseEvent,
  rawEntries: readonly (ContextMenuEntry | false | null | undefined)[],
  opts?: OpenContextMenuOptions,
): boolean {
  if (e.shiftKey) return false;
  if (!opts?.allowInField && isEditableTarget(e.target)) return false;
  const entries = normalizeContextMenuEntries(rawEntries);
  if (!entries.length) return false;
  e.preventDefault();
  e.stopPropagation();
  currentState = {
    x: e.clientX,
    y: e.clientY,
    entries,
    ariaLabel: opts?.ariaLabel ?? 'Context menu',
  };
  notify();
  return true;
}

function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  vw: number,
  vh: number,
): { left: number; top: number } {
  const left =
    x + width <= vw - VIEWPORT_PAD
      ? Math.max(VIEWPORT_PAD, x)
      : Math.max(VIEWPORT_PAD, Math.min(x - width, vw - width - VIEWPORT_PAD));
  const top =
    y + height <= vh - VIEWPORT_PAD
      ? Math.max(VIEWPORT_PAD, y)
      : Math.max(VIEWPORT_PAD, Math.min(y - height, vh - height - VIEWPORT_PAD));
  return { left: Math.round(left), top: Math.round(top) };
}

function clampSubmenuPosition(
  anchor: DOMRect,
  width: number,
  height: number,
  vw: number,
  vh: number,
): { left: number; top: number } {
  let left = anchor.right - 2;
  if (left + width > vw - VIEWPORT_PAD) {
    left = Math.max(VIEWPORT_PAD, anchor.left - width + 2);
  }
  const top = Math.max(VIEWPORT_PAD, Math.min(anchor.top - 4, vh - height - VIEWPORT_PAD));
  return { left: Math.round(left), top: Math.round(top) };
}

function ContextMenuPanel({
  entries,
  ariaLabel,
  x,
  y,
  anchorRect,
  onClose,
  onCloseSubmenu,
  autoFocus,
}: {
  entries: ContextMenuEntry[];
  ariaLabel: string;
  x?: number;
  y?: number;
  anchorRect?: DOMRect;
  onClose: () => void;
  onCloseSubmenu?: () => void;
  autoFocus?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  const [openSub, setOpenSub] = useState<{ index: number; rect: DOMRect; focusFirst: boolean } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure and clamp whenever menu entries change
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (anchorRect) {
      setPos(clampSubmenuPosition(anchorRect, rect.width, rect.height, vw, vh));
    } else {
      setPos(clampMenuPosition(x ?? 0, y ?? 0, rect.width, rect.height, vw, vh));
    }
  }, [x, y, anchorRect, entries]);

  useEffect(() => {
    if (!autoFocus) return;
    const first = panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    if (first) first.focus();
    else panelRef.current?.focus();
  }, [autoFocus]);

  const enabledButtons = () =>
    Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]:not(:disabled)') ??
        [],
    );

  const onKeyDown = (e: KeyEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'ArrowLeft' && onCloseSubmenu) {
      e.preventDefault();
      e.stopPropagation();
      onCloseSubmenu();
      return;
    }
    const btns = enabledButtons();
    if (!btns.length) return;
    const cur = btns.indexOf(e.target as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      btns[(cur + 1 + btns.length) % btns.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      btns[(cur - 1 + btns.length) % btns.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      btns[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      btns[btns.length - 1]?.focus();
    } else if (e.key === 'ArrowRight') {
      const btn = e.target as HTMLButtonElement;
      const idxAttr = btn.dataset.ctxIndex;
      if (idxAttr !== undefined) {
        const idx = Number(idxAttr);
        const entry = entries[idx];
        if (entry?.kind === 'submenu' && !entry.disabled) {
          e.preventDefault();
          e.stopPropagation();
          setOpenSub({ index: idx, rect: btn.getBoundingClientRect(), focusFirst: true });
        }
      }
    }
  };

  const openSubEntry = openSub ? entries[openSub.index] : undefined;

  return (
    <div
      ref={panelRef}
      className="menu-list ctx-menu"
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, idx) => {
        if (entry.kind === 'separator') {
          // biome-ignore lint/suspicious/noArrayIndexKey: static rendered menu snapshot
          return <div key={idx} className="ctx-sep" role="separator" />;
        }
        if (entry.kind === 'label') {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: static rendered menu snapshot
            <div key={idx} className="ctx-label" role="presentation">
              {entry.label}
            </div>
          );
        }
        if (entry.kind === 'submenu') {
          const isOpen = openSub?.index === idx;
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: static rendered menu snapshot
              key={idx}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              data-ctx-index={idx}
              className={`ctx-item${isOpen ? ' ctx-sub-open' : ''}`}
              disabled={entry.disabled}
              onMouseEnter={(e) => {
                if (!entry.disabled) {
                  setOpenSub({
                    index: idx,
                    rect: e.currentTarget.getBoundingClientRect(),
                    focusFirst: false,
                  });
                }
              }}
              onClick={(e) => {
                if (!entry.disabled) {
                  setOpenSub({ index: idx, rect: e.currentTarget.getBoundingClientRect(), focusFirst: true });
                }
              }}
            >
              <span className="ctx-check" aria-hidden="true" />
              <span className="ctx-text">{entry.label}</span>
              <span className="ctx-arrow" aria-hidden="true">
                ▸
              </span>
            </button>
          );
        }
        return (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: static rendered menu snapshot
            key={idx}
            type="button"
            role="menuitem"
            data-ctx-index={idx}
            className={`ctx-item${entry.danger ? ' danger-text' : ''}`}
            disabled={entry.disabled}
            onMouseEnter={() => {
              if (openSub) setOpenSub(null);
            }}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            <span className="ctx-check" aria-hidden="true">
              {entry.checked ? '✓' : ''}
            </span>
            <span className="ctx-text">{entry.label}</span>
            {entry.shortcut && <span className="ctx-shortcut">{entry.shortcut}</span>}
          </button>
        );
      })}
      {openSub && openSubEntry?.kind === 'submenu' && (
        <ContextMenuPanel
          entries={openSubEntry.items}
          ariaLabel={openSubEntry.label}
          anchorRect={openSub.rect}
          onClose={onClose}
          onCloseSubmenu={() => {
            const idx = openSub.index;
            setOpenSub(null);
            panelRef.current?.querySelector<HTMLButtonElement>(`[data-ctx-index="${idx}"]`)?.focus();
          }}
          autoFocus={openSub.focusFirst}
        />
      )}
    </div>
  );
}

/** Hold duration (ms) for a touch long-press to open a context menu on iPad / Android. */
export const LONG_PRESS_MENU_MS = 500;
/** Finger movement tolerance (px) before a touch press is treated as a scroll or drag instead of a long-press. */
export const LONG_PRESS_MOVE_PX = 10;

/**
 * Install a document-wide touch long-press recognizer that dispatches a bubbling `contextmenu`
 * event after holding still for `LONG_PRESS_MENU_MS`.
 * - Skips non-touch pointers, secondary touches, editable inputs, open menus, and `[data-sort-handle]`
 *   (so Sortable's 300 ms handle drag has zero conflict).
 * - Deduplicates against Android Chrome's native `contextmenu` event and swallows the trailing `click`
 *   when a custom menu actually opens.
 */
export function installTouchLongPress(doc: Document = document): () => void {
  const win = doc.defaultView;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeId: number | null = null;
  let startX = 0;
  let startY = 0;
  let target: EventTarget | null = null;
  let lastSyntheticAt = 0;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    activeId = null;
    target = null;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    if (!e.isPrimary) {
      cancel();
      return;
    }
    if (isEditableTarget(e.target)) return;
    const el = e.target as { closest?: (sel: string) => unknown } | null;
    if (typeof el?.closest === 'function' && (el.closest('[data-sort-handle]') || el.closest('.ctx-menu'))) {
      return;
    }
    cancel();
    activeId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    target = e.target;
    timer = setTimeout(() => {
      const t = target;
      const x = startX;
      const y = startY;
      cancel();
      if (!t || doc.body?.classList.contains('sorting')) return;
      lastSyntheticAt = Date.now();
      const ev = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        view: win ?? undefined,
      });
      t.dispatchEvent(ev);
      if (ev.defaultPrevented) {
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          navigator.vibrate(10);
        }
        const swallow = (clickEv: Event) => {
          clickEv.preventDefault();
          clickEv.stopPropagation();
        };
        doc.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => doc.removeEventListener('click', swallow, { capture: true }), 400);
      }
    }, LONG_PRESS_MENU_MS);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (activeId === null || e.pointerId !== activeId) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > LONG_PRESS_MOVE_PX) cancel();
  };

  const onPointerEnd = (e: PointerEvent) => {
    if (activeId !== null && e.pointerId === activeId) cancel();
  };

  const onScroll = () => cancel();

  const onNativeContextMenu = (e: MouseEvent) => {
    if (e.isTrusted && Date.now() - lastSyntheticAt < 400) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onContextKey = (e: KeyboardEvent) => {
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    const active = doc.activeElement as HTMLElement | null;
    if (!active || active === doc.body || isEditableTarget(active)) return;
    const rect = active.getBoundingClientRect();
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(rect.width / 2, 48),
      clientY: rect.top + Math.min(rect.height / 2, 24),
      view: win ?? undefined,
    });
    active.dispatchEvent(ev);
    if (ev.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  doc.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('pointermove', onPointerMove);
  doc.addEventListener('pointerup', onPointerEnd);
  doc.addEventListener('pointercancel', onPointerEnd);
  doc.addEventListener('scroll', onScroll, true);
  doc.addEventListener('contextmenu', onNativeContextMenu, true);
  doc.addEventListener('keydown', onContextKey);

  return () => {
    cancel();
    doc.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('pointermove', onPointerMove);
    doc.removeEventListener('pointerup', onPointerEnd);
    doc.removeEventListener('pointercancel', onPointerEnd);
    doc.removeEventListener('scroll', onScroll, true);
    doc.removeEventListener('contextmenu', onNativeContextMenu, true);
    doc.removeEventListener('keydown', onContextKey);
  };
}

/** Global host mounted once in RegularFrame; renders the active context menu in a body portal. */
export function ContextMenuHost() {
  const state = useSyncExternalStore(subscribe, getSnapshot, () => null);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    return installTouchLongPress(document);
  }, []);

  useEffect(() => {
    if (!state) return;
    const close = () => closeContextMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [state]);

  if (!state) return null;
  const panel = (
    <ContextMenuPanel
      key={`${state.x}:${state.y}:${state.ariaLabel}`}
      entries={state.entries}
      ariaLabel={state.ariaLabel}
      x={state.x}
      y={state.y}
      onClose={closeContextMenu}
      autoFocus
    />
  );
  return typeof document !== 'undefined' ? createPortal(panel, document.body) : panel;
}
