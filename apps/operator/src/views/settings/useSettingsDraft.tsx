import type { Settings } from '@ordo/protocol';
import { useEffect, useRef, useState } from 'react';
import { saveSettings, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';

/** Local draft of one settings document with explicit Save / Revert. Follows remote changes when clean. */
export function useSettingsDraft<K extends keyof Settings>(key: K) {
  const remote = useLibrary((s) => s.data.settings[key]);
  const [draft, setDraftState] = useState<Settings[K]>(remote);
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setDraftState(remote);
  }, [remote]);
  const setDraft = (v: Settings[K] | ((prev: Settings[K]) => Settings[K])) => {
    dirty.current = true;
    setDraftState(v);
  };
  const save = async (value?: Settings[K]): Promise<boolean> => {
    setSaving(true);
    try {
      await saveSettings(key, value ?? draft);
      dirty.current = false;
      toast('Saved.', 'ok', 2000);
      return true;
    } catch (e) {
      toast(`Could not save: ${errorText(e)}`, 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };
  const revert = () => {
    dirty.current = false;
    setDraftState(remote);
  };
  return { draft, setDraft, save, revert, saving, dirty: dirty.current };
}

export function SaveBar(props: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onRevert: () => void;
}) {
  return (
    <div
      className="row"
      style={{
        position: 'sticky',
        bottom: 0,
        padding: '10px 0',
        background: 'var(--bg)',
        borderTop: '1px solid var(--line)',
        marginTop: 16,
      }}
    >
      <button
        type="button"
        className="primary big"
        disabled={!props.dirty || props.saving}
        onClick={props.onSave}
      >
        {props.saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" disabled={!props.dirty || props.saving} onClick={props.onRevert}>
        Revert
      </button>
      {props.dirty && <span className="muted small">Unsaved changes</span>}
    </div>
  );
}
