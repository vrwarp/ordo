import { create } from 'zustand';
import type { Route } from '../lib/route.ts';

export type UnsavedKind = 'presentation' | 'theme' | 'settings' | 'playlist';

export type UnsavedItem = {
  /** Stable unique key (`pres:<id>`, `theme:<id>`, `settings:<key>`, `playlist:<id>`). */
  key: string;
  kind: UnsavedKind;
  /** Entity id or settings key. */
  id: string;
  /** Human-readable name shown in the Nav unsaved popover and boundary dialogs. */
  label: string;
  /** Route opened by the "Open" button in the Nav unsaved popover. */
  route: Route;
  /** Settings sub-page slug (`outputs`, `looks`, `messages`, `midi`, etc.) when `kind === 'settings'`. */
  settingsPage?: string;
  saving?: boolean;
  /** True when saving is blocked (e.g. presentation is locked by the live playlist). */
  locked?: boolean;
  /**
   * True while an auto-saved item (a playlist) is inside its normal 600 ms typing debounce:
   * hidden from the Nav pill so typing does not flicker, while still guarded by `beforeunload` and `Go live`.
   */
  debouncePending?: boolean;
  error?: string;
  save: () => Promise<boolean>;
  discard: () => void | Promise<void>;
};

type UnsavedState = {
  items: Record<string, UnsavedItem>;
};

export const useUnsaved = create<UnsavedState>(() => ({ items: {} }));

export function upsertUnsaved(item: UnsavedItem): void {
  useUnsaved.setState((s) => ({ items: { ...s.items, [item.key]: item } }));
}

export function removeUnsaved(key: string): void {
  useUnsaved.setState((s) => {
    if (!(key in s.items)) return s;
    const next = { ...s.items };
    delete next[key];
    return { items: next };
  });
}

export function clearUnsavedRegistryForTests(): void {
  useUnsaved.setState({ items: {} });
}

/** Items surfaced in the top Nav "● N unsaved" pill and Sign-out prompt (excludes quiet playlist debounces). */
export function visibleUnsavedItems(
  items: Record<string, UnsavedItem> = useUnsaved.getState().items,
): UnsavedItem[] {
  return Object.values(items).filter((it) => !it.debouncePending);
}

/** True when any draft is dirty or an auto-save is still queued/in-flight (used by global `beforeunload`). */
export function hasAnyPendingWork(items: Record<string, UnsavedItem> = useUnsaved.getState().items): boolean {
  return Object.keys(items).length > 0;
}

/** Flush any auto-saved playlist items that are still waiting on their debounce timer. */
export async function flushDebouncedItems(): Promise<boolean> {
  const debounced = Object.values(useUnsaved.getState().items).filter((it) => it.debouncePending);
  let allOk = true;
  for (const it of debounced) {
    if (!(await it.save())) allOk = false;
  }
  return allOk;
}

export function isPresentationDirty(id: string): boolean {
  return Boolean(useUnsaved.getState().items[`pres:${id}`]);
}

export function useIsPresentationDirty(id: string | undefined): boolean {
  return useUnsaved((s) => (id ? Boolean(s.items[`pres:${id}`]) : false));
}

export function useIsThemeDirty(id?: string): boolean {
  return useUnsaved((s) =>
    id ? Boolean(s.items[`theme:${id}`]) : Object.values(s.items).some((it) => it.kind === 'theme'),
  );
}

export function useAnyLibraryDraftDirty(): boolean {
  return useUnsaved((s) =>
    Object.values(s.items).some((it) => it.kind === 'presentation' || it.kind === 'theme'),
  );
}

export function useAnySettingsDirty(): boolean {
  return useUnsaved((s) => Object.values(s.items).some((it) => it.kind === 'settings'));
}

export function useDirtySettingsPages(): Set<string> {
  const key = useUnsaved((s) =>
    Object.values(s.items)
      .filter((it) => it.kind === 'settings')
      .map((it) => `${it.id}:${it.settingsPage ?? ''}`)
      .sort()
      .join(','),
  );
  const pages = new Set<string>();
  if (!key) return pages;
  for (const part of key.split(',')) {
    const [id, page] = part.split(':');
    if (page) pages.add(page);
    else if (id === 'keymap') pages.add('keys');
    else if (id) pages.add(id);
  }
  return pages;
}
