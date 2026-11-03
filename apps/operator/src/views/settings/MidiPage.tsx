import { type ActionId, type MidiMapping, newId } from '@ordo/domain';
import { useState } from 'react';
import { Select } from '../../components/fields.tsx';
import { surfaces, useSurfaces } from '../../services/surfaces.ts';
import { toast } from '../../state/toasts.ts';
import { ACTION_OPTIONS, ACTIONS_WITH_ARG, parseArg } from './actions.ts';
import { SaveBar, useSettingsDraft } from './useSettingsDraft.tsx';

/** MIDI inputs and mappings with Learn (prd/07). */
export function MidiPage() {
  const { draft, setDraft, save, revert, saving, dirty } = useSettingsDraft('surfaces');
  const { midiReady, midiInputs } = useSurfaces();
  const [learning, setLearning] = useState<string | null>(null);
  const [newAction, setNewAction] = useState<ActionId>('next');
  const maps = draft.midi;
  const setMaps = (midi: MidiMapping[]) => setDraft({ ...draft, midi });
  const setMap = (id: string, patch: Partial<MidiMapping>) =>
    setMaps(maps.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  const learn = async (target: MidiMapping | null) => {
    const s = surfaces();
    if (!s) return;
    const action = target?.action ?? { id: newAction };
    setLearning(target?.id ?? '__new');
    toast('Learning: press the pedal, key or knob now (5 s).', 'info', 5000);
    const m = await s.midi.learn(action, 5000);
    setLearning(null);
    if (!m) {
      toast('Nothing received.', 'warn');
      return;
    }
    if (target)
      setMap(target.id, {
        deviceName: m.deviceName,
        kind: m.kind,
        number: m.number,
        channel: m.channel,
        threshold: m.threshold,
      });
    else setMaps([...maps, { ...m, id: m.id || newId(), action }]);
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      <h2>MIDI</h2>
      <div className="row">
        <span className={`dot ${midiReady ? 'green' : 'grey'}`} />
        <span>{midiReady ? 'Web MIDI ready' : 'Web MIDI not available or not permitted'}</span>
        <button type="button" className="small" onClick={() => surfaces()?.refreshMidi()}>
          Refresh inputs
        </button>
      </div>
      <div className="row wrap">
        {midiInputs.map((i) => (
          <span key={i.id} className="tag">
            {i.name}
          </span>
        ))}
        {!midiInputs.length && <span className="muted small">No MIDI inputs found.</span>}
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Device</th>
            <th>Kind</th>
            <th>Number</th>
            <th>Channel</th>
            <th>Threshold</th>
            <th>Action</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {maps.map((m) => (
            <tr key={m.id}>
              <td>
                <select
                  value={m.deviceName ?? ''}
                  onChange={(e) => setMap(m.id, { deviceName: e.target.value || undefined })}
                >
                  <option value="">Any device</option>
                  {[
                    ...new Set([...midiInputs.map((i) => i.name), ...(m.deviceName ? [m.deviceName] : [])]),
                  ].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <Select
                  value={m.kind}
                  options={['note', 'cc'] as const}
                  onChange={(kind) => setMap(m.id, { kind })}
                />
              </td>
              <td>
                <input
                  type="number"
                  min={0}
                  max={127}
                  style={{ width: 64 }}
                  value={m.number}
                  onChange={(e) =>
                    setMap(m.id, { number: Math.max(0, Math.min(127, Number(e.target.value))) })
                  }
                />
              </td>
              <td>
                <select
                  value={m.channel ?? ''}
                  onChange={(e) =>
                    setMap(m.id, { channel: e.target.value ? Number(e.target.value) : undefined })
                  }
                >
                  <option value="">Any</option>
                  {Array.from({ length: 16 }, (_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional list
                    <option key={i} value={i + 1}>
                      {i + 1}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="number"
                  min={0}
                  max={127}
                  style={{ width: 64 }}
                  value={m.threshold}
                  onChange={(e) =>
                    setMap(m.id, { threshold: Math.max(0, Math.min(127, Number(e.target.value))) })
                  }
                />
              </td>
              <td>
                <div className="row">
                  <Select
                    value={m.action.id}
                    options={ACTION_OPTIONS}
                    onChange={(id) => setMap(m.id, { action: { id } })}
                  />
                  {ACTIONS_WITH_ARG.has(m.action.id) && (
                    <input
                      style={{ width: 60 }}
                      defaultValue={m.action.arg ?? ''}
                      onBlur={(e) =>
                        setMap(m.id, {
                          action: { id: m.action.id, arg: parseArg(m.action.id, e.target.value) },
                        })
                      }
                    />
                  )}
                </div>
              </td>
              <td>
                <div className="row">
                  <button
                    type="button"
                    className={`small ${learning === m.id ? 'on' : ''}`}
                    disabled={!midiReady || learning !== null}
                    onClick={() => void learn(m)}
                  >
                    {learning === m.id ? 'Listening…' : 'Learn'}
                  </button>
                  <button
                    type="button"
                    className="small ghost"
                    onClick={() => setMaps(maps.filter((x) => x.id !== m.id))}
                  >
                    ✕
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <Select value={newAction} options={ACTION_OPTIONS} onChange={setNewAction} />
        <button
          type="button"
          className="primary"
          disabled={!midiReady || learning !== null}
          onClick={() => void learn(null)}
        >
          {learning === '__new' ? 'Listening…' : 'Learn new mapping'}
        </button>
        <button
          type="button"
          onClick={() =>
            setMaps([
              ...maps,
              { id: newId(), kind: 'note', number: 60, threshold: 1, action: { id: newAction } },
            ])
          }
        >
          Add manually
        </button>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onRevert={revert} />
    </div>
  );
}
