import { api } from '@ordo/client';
import type { Theme } from '@ordo/domain';
import { create } from 'zustand';
import { same } from '../lib/jsonEqual.ts';
import { navigate } from '../useRoute.ts';
import { journalPut, journalRemove } from './draftJournal.ts';
import { upsertLocal, useLibrary } from './library.ts';
import { errorText, toast } from './toasts.ts';
import { removeUnsaved, upsertUnsaved } from './unsaved.ts';

export type ThemeDraftEntry = {
  id: string;
  base: Theme;
  draft: Theme;
  dirty: boolean;
  saving: boolean;
};

type ThemeDraftState = {
  editingId: string | null;
  entries: Record<string, ThemeDraftEntry>;
};

export const useThemeDrafts = create<ThemeDraftState>(() => ({
  editingId: null,
  entries: {},
}));

function themeContent(t: Theme): Omit<Theme, 'rev'> {
  const { rev: _rev, ...rest } = t;
  return rest;
}

export function sameThemeContent(a: Theme, b: Theme): boolean {
  return same(themeContent(a), themeContent(b));
}

function syncThemeRegistry(entry: ThemeDraftEntry | undefined, id: string, editing: boolean): void {
  const regKey = `theme:${id}`;
  if (!entry?.dirty) {
    removeUnsaved(regKey);
    journalRemove(regKey);
    return;
  }
  upsertUnsaved({
    key: regKey,
    kind: 'theme',
    id,
    label: `Theme: ${entry.draft.name || 'Untitled'}`,
    route: { name: 'library', tab: 'themes' },
    saving: entry.saving,
    save: () => saveThemeDraft(id),
    discard: () => discardThemeDraft(id),
  });
  journalPut(regKey, {
    kind: 'theme',
    id,
    base: entry.base,
    draft: entry.draft,
    editing,
    updatedAt: Date.now(),
  });
}

/** Open a theme in the designer, keeping any parked unsaved draft for it. */
export function openThemeEditor(theme: Theme): void {
  const st = useThemeDrafts.getState();
  const existing = st.entries[theme.id];
  if (existing?.dirty) {
    useThemeDrafts.setState({ editingId: theme.id });
    syncThemeRegistry(existing, theme.id, true);
    return;
  }
  const clean: ThemeDraftEntry = {
    id: theme.id,
    base: structuredClone(theme),
    draft: structuredClone(theme),
    dirty: false,
    saving: false,
  };
  useThemeDrafts.setState({
    editingId: theme.id,
    entries: { ...st.entries, [theme.id]: clean },
  });
}

/** Open a theme by id (used by the Nav unsaved popover's Open action). */
export function focusThemeDraft(id: string): void {
  const st = useThemeDrafts.getState();
  if (st.entries[id]) {
    useThemeDrafts.setState({ editingId: id });
  } else {
    const libT = useLibrary.getState().data.themes.find((t) => t.id === id);
    if (libT) openThemeEditor(libT);
  }
  navigate({ name: 'library', tab: 'themes' });
}

/** Leave the designer back to the Themes gallery; dirty drafts stay parked unless discarded. */
export function closeThemeEditor(): void {
  const st = useThemeDrafts.getState();
  const id = st.editingId;
  if (!id) return;
  const entry = st.entries[id];
  if (entry && !entry.dirty && !entry.saving) {
    const entries = { ...st.entries };
    delete entries[id];
    useThemeDrafts.setState({ editingId: null, entries });
    return;
  }
  useThemeDrafts.setState({ editingId: null });
  if (entry?.dirty) syncThemeRegistry(entry, id, false);
}

export function updateThemeDraft(id: string, next: Theme | ((prev: Theme) => Theme)): void {
  const st = useThemeDrafts.getState();
  const cur = st.entries[id];
  const remote = useLibrary.getState().data.themes.find((t) => t.id === id);
  const base = cur?.base ?? (remote ? structuredClone(remote) : undefined);
  const prevDraft = cur?.draft ?? base;
  if (!base || !prevDraft) return;
  const draft = typeof next === 'function' ? next(prevDraft) : next;
  const dirty = !sameThemeContent(draft, base);
  const entry: ThemeDraftEntry = {
    id,
    base,
    draft,
    dirty,
    saving: cur?.saving ?? false,
  };
  useThemeDrafts.setState({
    entries: { ...st.entries, [id]: entry },
  });
  syncThemeRegistry(entry, id, st.editingId === id);
}

export async function saveThemeDraft(id: string): Promise<boolean> {
  const st = useThemeDrafts.getState();
  const entry = st.entries[id];
  if (!entry || entry.saving) return false;
  const savingEntry: ThemeDraftEntry = { ...entry, saving: true };
  useThemeDrafts.setState({ entries: { ...st.entries, [id]: savingEntry } });
  if (entry.dirty) syncThemeRegistry(savingEntry, id, st.editingId === id);

  try {
    const sent = entry.draft;
    const updated = await api<Theme>(`/themes/${id}`, { method: 'PUT', json: sent });
    upsertLocal('themes', updated);
    const cur = useThemeDrafts.getState();
    const latestEntry = cur.entries[id];
    const changedWhileSaving =
      latestEntry &&
      !sameThemeContent(latestEntry.draft, sent) &&
      !sameThemeContent(latestEntry.draft, updated);
    if (changedWhileSaving && latestEntry) {
      const stillDirty: ThemeDraftEntry = {
        id,
        base: structuredClone(updated),
        draft: { ...latestEntry.draft, rev: updated.rev },
        dirty: true,
        saving: false,
      };
      useThemeDrafts.setState({ entries: { ...cur.entries, [id]: stillDirty } });
      syncThemeRegistry(stillDirty, id, cur.editingId === id);
    } else if (cur.editingId === id) {
      const clean: ThemeDraftEntry = {
        id,
        base: structuredClone(updated),
        draft: structuredClone(updated),
        dirty: false,
        saving: false,
      };
      useThemeDrafts.setState({ entries: { ...cur.entries, [id]: clean } });
      syncThemeRegistry(undefined, id, true);
    } else {
      const entries = { ...cur.entries };
      delete entries[id];
      useThemeDrafts.setState({ entries });
      syncThemeRegistry(undefined, id, false);
    }
    toast(`Theme saved (v${updated.rev ?? 1}).`, 'ok');
    return true;
  } catch (e) {
    const cur = useThemeDrafts.getState();
    const latestEntry = cur.entries[id];
    if (latestEntry) {
      const failed: ThemeDraftEntry = { ...latestEntry, saving: false };
      useThemeDrafts.setState({ entries: { ...cur.entries, [id]: failed } });
      if (failed.dirty) syncThemeRegistry(failed, id, cur.editingId === id);
    }
    toast(errorText(e), 'error');
    return false;
  }
}

/** Discard unsaved edits for theme `id`; if open in the designer, reset it to the library's saved version. */
export function discardThemeDraft(id: string): void {
  const st = useThemeDrafts.getState();
  const remote = useLibrary.getState().data.themes.find((t) => t.id === id);
  syncThemeRegistry(undefined, id, false);
  if (st.editingId === id && remote) {
    const clean: ThemeDraftEntry = {
      id,
      base: structuredClone(remote),
      draft: structuredClone(remote),
      dirty: false,
      saving: false,
    };
    useThemeDrafts.setState({ entries: { ...st.entries, [id]: clean } });
    return;
  }
  const entries = { ...st.entries };
  delete entries[id];
  useThemeDrafts.setState({
    editingId: st.editingId === id ? null : st.editingId,
    entries,
  });
}

export function replaceThemeBase(restored: Theme): void {
  const st = useThemeDrafts.getState();
  syncThemeRegistry(undefined, restored.id, false);
  if (st.editingId === restored.id) {
    useThemeDrafts.setState({
      entries: {
        ...st.entries,
        [restored.id]: {
          id: restored.id,
          base: structuredClone(restored),
          draft: structuredClone(restored),
          dirty: false,
          saving: false,
        },
      },
    });
  } else if (restored.id in st.entries) {
    const entries = { ...st.entries };
    delete entries[restored.id];
    useThemeDrafts.setState({ entries });
  }
}

export function restoreThemeDraftFromJournal(id: string, base: Theme, draft: Theme, editing = false): void {
  const remote = useLibrary.getState().data.themes.find((t) => t.id === id);
  if (!remote || sameThemeContent(draft, remote)) {
    journalRemove(`theme:${id}`);
    return;
  }
  const entry: ThemeDraftEntry = {
    id,
    base,
    draft,
    dirty: true,
    saving: false,
  };
  useThemeDrafts.setState((s) => ({
    editingId: editing && !s.editingId ? id : s.editingId,
    entries: { ...s.entries, [id]: entry },
  }));
  syncThemeRegistry(entry, id, editing);
}

export function resetThemeDraftsForTests(): void {
  for (const id of Object.keys(useThemeDrafts.getState().entries)) {
    removeUnsaved(`theme:${id}`);
    journalRemove(`theme:${id}`);
  }
  useThemeDrafts.setState({ editingId: null, entries: {} });
}

// Keep clean open themes synchronized with remote updates, and clear dirty drafts if saved identically elsewhere.
useLibrary.subscribe((st, prev) => {
  if (st.data.themes === prev.data.themes) return;
  const cur = useThemeDrafts.getState();
  for (const [id, entry] of Object.entries(cur.entries)) {
    if (entry.saving) continue;
    const remote = st.data.themes.find((t) => t.id === id);
    if (!remote) {
      discardThemeDraft(id);
      continue;
    }
    if (!entry.dirty) {
      if (remote.rev !== entry.base.rev) {
        useThemeDrafts.setState((s) => ({
          entries: {
            ...s.entries,
            [id]: {
              id,
              base: structuredClone(remote),
              draft: structuredClone(remote),
              dirty: false,
              saving: false,
            },
          },
        }));
      }
    } else if (sameThemeContent(entry.draft, remote)) {
      replaceThemeBase(remote);
    }
  }
});
