import type { Settings } from '@ordo/protocol';
import { useCallback } from 'react';
import { useLibrary } from '../../state/library.ts';
import {
  revertSettingsDraft,
  type SettingsEntry,
  saveSettingsDraft,
  setSettingsDraft,
  useSettingsDraftStore,
} from '../../state/settingsDrafts.ts';

/**
 * Draft of one settings document with explicit Save / Revert, backed by `settingsDrafts` so switching
 * between Settings sub-tabs or top-nav routes preserves pending edits. Follows remote changes when clean.
 */
export function useSettingsDraft<K extends keyof Settings>(key: K, page?: string) {
  const remote = useLibrary((s) => s.data.settings[key]);
  const entry = useSettingsDraftStore((s) => s.entries[key] as SettingsEntry<K> | undefined);
  const draft = entry?.dirty ? entry.draft : remote;
  const dirty = Boolean(entry?.dirty);
  const saving = Boolean(entry?.saving);
  const setDraft = useCallback(
    (v: Settings[K] | ((prev: Settings[K]) => Settings[K])) => setSettingsDraft(key, v, page),
    [key, page],
  );
  const save = useCallback((value?: Settings[K]) => saveSettingsDraft(key, value), [key]);
  const revert = useCallback(() => revertSettingsDraft(key), [key]);
  return { draft, setDraft, save, revert, saving, dirty };
}

export function SaveBar(props: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onRevert: () => void;
}) {
  if (!props.dirty && !props.saving) return null;
  return (
    <div className="studio-savebar">
      <span className="row" style={{ gap: 6, fontSize: 12.5, color: 'var(--fg2)' }}>
        <span className="dot sm amber" aria-hidden="true" />
        Unsaved changes
      </span>
      <span className="spacer" />
      <button type="button" className="small ghost" disabled={props.saving} onClick={props.onRevert}>
        Revert
      </button>
      <button type="button" className="primary small" disabled={props.saving} onClick={props.onSave}>
        {props.saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
