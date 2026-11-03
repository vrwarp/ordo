import { type ActionId, DEFAULT_KEYMAP } from '@ordo/domain';
import { isModifierOnly, normalizeCombo } from '@ordo/surfaces';
import { useEffect, useState } from 'react';
import { Select } from '../../components/fields.tsx';
import { ACTION_OPTIONS, ACTIONS_WITH_ARG, parseArg } from './actions.ts';
import { SaveBar, useSettingsDraft } from './useSettingsDraft.tsx';

/** Key map editor with press-to-record (prd/07). */
export function KeymapPage() {
  const { draft, setDraft, save, revert, saving, dirty } = useSettingsDraft('keymap');
  const [recording, setRecording] = useState<string | null>(null);
  useEffect(() => {
    if (recording === null) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      if (isModifierOnly(e)) return;
      const combo = normalizeCombo(e);
      const next = { ...draft };
      const action = recording === '__new' ? { id: 'next' as ActionId } : next[recording];
      if (recording !== '__new') delete next[recording];
      if (action) next[combo] = action;
      setDraft(next);
      setRecording(null);
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [recording, draft, setDraft]);
  const entries = Object.entries(draft).sort(
    (a, b) => a[1].id.localeCompare(b[1].id) || a[0].localeCompare(b[0]),
  );
  return (
    <div className="col" style={{ gap: 12 }}>
      <h2>Keyboard</h2>
      <p className="muted" style={{ margin: 0 }}>
        Keys act while the operator window is focused (not while typing or in the editor). Click a key to
        re-record it.
      </p>
      <table className="list">
        <thead>
          <tr>
            <th>Key</th>
            <th>Action</th>
            <th>Argument</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entries.map(([combo, a]) => (
            <tr key={combo}>
              <td>
                <button
                  type="button"
                  className={`small ${recording === combo ? 'on' : ''}`}
                  onClick={() => setRecording(combo)}
                >
                  {recording === combo ? 'Press a key…' : <span className="kbd">{combo}</span>}
                </button>
              </td>
              <td>
                <Select
                  value={a.id}
                  options={ACTION_OPTIONS}
                  onChange={(id) => setDraft({ ...draft, [combo]: { id } })}
                />
              </td>
              <td>
                {ACTIONS_WITH_ARG.has(a.id) && (
                  <input
                    style={{ width: 90 }}
                    defaultValue={a.arg ?? ''}
                    onBlur={(e) =>
                      setDraft({ ...draft, [combo]: { id: a.id, arg: parseArg(a.id, e.target.value) } })
                    }
                  />
                )}
              </td>
              <td>
                <button
                  type="button"
                  className="small ghost"
                  onClick={() => {
                    const n = { ...draft };
                    delete n[combo];
                    setDraft(n);
                  }}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button
          type="button"
          className={recording === '__new' ? 'on' : ''}
          onClick={() => setRecording('__new')}
        >
          {recording === '__new' ? 'Press the new key…' : '+ Record a key'}
        </button>
        <button type="button" onClick={() => setDraft({ ...DEFAULT_KEYMAP })}>
          Reset to defaults
        </button>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onRevert={revert} />
    </div>
  );
}
