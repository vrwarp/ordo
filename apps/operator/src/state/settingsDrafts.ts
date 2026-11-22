import type { Settings } from '@ordo/protocol';
import { create } from 'zustand';
import { same } from '../lib/jsonEqual.ts';
import { journalPut, journalRemove } from './draftJournal.ts';
import { saveSettings, useLibrary } from './library.ts';
import { errorText, toast } from './toasts.ts';
import { removeUnsaved, upsertUnsaved } from './unsaved.ts';

export type SettingsEntry<K extends keyof Settings = keyof Settings> = {
  key: K;
  base: Settings[K];
  draft: Settings[K];
  dirty: boolean;
  saving: boolean;
  page: string;
};

type SettingsDraftState = {
  entries: Partial<{ [K in keyof Settings]: SettingsEntry<K> }>;
};

export const useSettingsDraftStore = create<SettingsDraftState>(() => ({ entries: {} }));

const DEFAULT_PAGE: Record<keyof Settings, string> = {
  outputs: 'outputs',
  looks: 'looks',
  audio: 'audio',
  keymap: 'keys',
  surfaces: 'messages',
  general: 'general',
  phones: 'pins',
};

const PAGE_LABELS: Record<string, string> = {
  outputs: 'Screens settings',
  looks: 'Looks settings',
  audio: 'Audio settings',
  keys: 'Keyboard settings',
  streamdeck: 'Stream Deck settings',
  midi: 'MIDI settings',
  messages: 'Stage messages settings',
  general: 'General settings',
  pins: 'PINs settings',
};

function labelFor(key: keyof Settings, page: string): string {
  return PAGE_LABELS[page] ?? PAGE_LABELS[DEFAULT_PAGE[key]] ?? `${key} settings`;
}

function syncRegistry<K extends keyof Settings>(entry: SettingsEntry<K> | undefined, key: K): void {
  const regKey = `settings:${key}`;
  if (!entry?.dirty) {
    removeUnsaved(regKey);
    journalRemove(regKey);
    return;
  }
  const page = entry.page || DEFAULT_PAGE[key];
  upsertUnsaved({
    key: regKey,
    kind: 'settings',
    id: key,
    label: labelFor(key, page),
    route: { name: 'settings', page },
    settingsPage: page,
    saving: entry.saving,
    save: () => saveSettingsDraft(key),
    discard: () => revertSettingsDraft(key),
  });
  journalPut(regKey, {
    kind: 'settings',
    key,
    base: entry.base,
    draft: entry.draft,
    page,
    updatedAt: Date.now(),
  });
}

export function setSettingsDraft<K extends keyof Settings>(
  key: K,
  next: Settings[K] | ((prev: Settings[K]) => Settings[K]),
  page?: string,
): void {
  const remote = useLibrary.getState().data.settings[key];
  const prevEntry = useSettingsDraftStore.getState().entries[key] as SettingsEntry<K> | undefined;
  const base = prevEntry?.dirty ? prevEntry.base : remote;
  const currentDraft = prevEntry ? prevEntry.draft : remote;
  const draft = typeof next === 'function' ? (next as (p: Settings[K]) => Settings[K])(currentDraft) : next;
  const dirty = !same(draft, remote);
  const resolvedPage = page ?? prevEntry?.page ?? DEFAULT_PAGE[key];
  if (!dirty) {
    useSettingsDraftStore.setState((s) => {
      if (!(key in s.entries)) return s;
      const entries = { ...s.entries };
      delete entries[key];
      return { entries };
    });
    syncRegistry(undefined, key);
    return;
  }
  const entry: SettingsEntry<K> = {
    key,
    base,
    draft,
    dirty: true,
    saving: prevEntry?.saving ?? false,
    page: resolvedPage,
  };
  useSettingsDraftStore.setState((s) => ({
    entries: { ...s.entries, [key]: entry },
  }));
  syncRegistry(entry, key);
}

export async function saveSettingsDraft<K extends keyof Settings>(
  key: K,
  overrideValue?: Settings[K],
): Promise<boolean> {
  const st = useSettingsDraftStore.getState().entries[key] as SettingsEntry<K> | undefined;
  const remote = useLibrary.getState().data.settings[key];
  const value = overrideValue ?? st?.draft ?? remote;
  const page = st?.page ?? DEFAULT_PAGE[key];
  const savingEntry: SettingsEntry<K> = {
    key,
    base: st?.base ?? remote,
    draft: value,
    dirty: true,
    saving: true,
    page,
  };
  useSettingsDraftStore.setState((s) => ({
    entries: { ...s.entries, [key]: savingEntry },
  }));
  if (st?.dirty) syncRegistry(savingEntry, key);

  try {
    await saveSettings(key, value);
    // Check if further edits happened while the PUT was in flight.
    const cur = useSettingsDraftStore.getState().entries[key] as SettingsEntry<K> | undefined;
    const latestRemote = useLibrary.getState().data.settings[key];
    if (cur && !same(cur.draft, value) && !same(cur.draft, latestRemote)) {
      const kept: SettingsEntry<K> = {
        ...cur,
        base: latestRemote,
        dirty: true,
        saving: false,
      };
      useSettingsDraftStore.setState((s) => ({ entries: { ...s.entries, [key]: kept } }));
      syncRegistry(kept, key);
    } else {
      useSettingsDraftStore.setState((s) => {
        const entries = { ...s.entries };
        delete entries[key];
        return { entries };
      });
      syncRegistry(undefined, key);
    }
    toast('Saved.', 'ok', 2000);
    return true;
  } catch (e) {
    const cur = useSettingsDraftStore.getState().entries[key] as SettingsEntry<K> | undefined;
    if (cur) {
      const failed: SettingsEntry<K> = { ...cur, saving: false };
      useSettingsDraftStore.setState((s) => ({ entries: { ...s.entries, [key]: failed } }));
      if (failed.dirty) syncRegistry(failed, key);
    }
    toast(`Could not save: ${errorText(e)}`, 'error');
    return false;
  }
}

export function revertSettingsDraft<K extends keyof Settings>(key: K): void {
  useSettingsDraftStore.setState((s) => {
    if (!(key in s.entries)) return s;
    const entries = { ...s.entries };
    delete entries[key];
    return { entries };
  });
  syncRegistry(undefined, key);
}

export function restoreSettingsDraftFromJournal<K extends keyof Settings>(
  key: K,
  base: Settings[K],
  draft: Settings[K],
  page?: string,
): void {
  const remote = useLibrary.getState().data.settings[key];
  if (same(draft, remote)) {
    journalRemove(`settings:${key}`);
    return;
  }
  const entry: SettingsEntry<K> = {
    key,
    base,
    draft,
    dirty: true,
    saving: false,
    page: page ?? DEFAULT_PAGE[key],
  };
  useSettingsDraftStore.setState((s) => ({
    entries: { ...s.entries, [key]: entry },
  }));
  syncRegistry(entry, key);
}

export function resetSettingsDraftsForTests(): void {
  for (const k of Object.keys(useSettingsDraftStore.getState().entries) as (keyof Settings)[]) {
    removeUnsaved(`settings:${k}`);
    journalRemove(`settings:${k}`);
  }
  useSettingsDraftStore.setState({ entries: {} });
}

/** Which Settings sidebar tabs currently hold unsaved changes (accounting for shared `surfaces`). */
export function dirtySettingsPagesSnapshot(
  entries: SettingsDraftState['entries'] = useSettingsDraftStore.getState().entries,
  remote: Settings = useLibrary.getState().data.settings,
): Set<string> {
  const out = new Set<string>();
  for (const key of Object.keys(entries) as (keyof Settings)[]) {
    const e = entries[key];
    if (!e?.dirty) continue;
    if (key === 'surfaces') {
      const d = e.draft as Settings['surfaces'];
      const r = remote.surfaces;
      let matched = false;
      if (!same(d.messagePresets, r.messagePresets)) {
        out.add('messages');
        matched = true;
      }
      if (!same(d.streamDeckPages, r.streamDeckPages)) {
        out.add('streamdeck');
        matched = true;
      }
      const { messagePresets: _dm, streamDeckPages: _ds, ...dRest } = d;
      const { messagePresets: _rm, streamDeckPages: _rs, ...rRest } = r;
      if (!same(dRest, rRest)) {
        out.add('midi');
        matched = true;
      }
      if (!matched) out.add(e.page || 'messages');
    } else {
      out.add(e.page || DEFAULT_PAGE[key]);
    }
  }
  return out;
}

// Keep dirty entries reconciled when remote settings arrive (e.g. another tab saved the exact same setting).
useLibrary.subscribe((st, prev) => {
  if (st.data.settings === prev.data.settings) return;
  const entries = useSettingsDraftStore.getState().entries;
  for (const key of Object.keys(entries) as (keyof Settings)[]) {
    const e = entries[key];
    if (!e || e.saving) continue;
    if (same(e.draft, st.data.settings[key])) {
      revertSettingsDraft(key);
    }
  }
});
