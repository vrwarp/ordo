import { type Arrangement, type ActionId, newId, type PlaylistItem } from '@ordo/domain';
import { useState } from 'react';
import { ArrangementEditor } from '../../components/ArrangementEditor.tsx';
import { Check, Field, NumberField, Select, TextField, TransitionEditor } from '../../components/fields.tsx';
import { authoringArrangement } from '../../lib/arrangement.ts';
import { useLibrary } from '../../state/library.ts';
import { ACTIONS } from './AddItemsPanel.tsx';
import { BackgroundPicker } from '../editor/BackgroundPicker.tsx';

/** Settings for one playlist item, by kind. */
export function ItemSettings(props: {
  item: PlaylistItem;
  disabled: boolean;
  onChange: (it: PlaylistItem) => void;
  onSaveArrangement: (presentationId: string, a: Arrangement) => Promise<boolean>;
}) {
  const lib = useLibrary((s) => s.data);
  const it = props.item;
  const [editing, setEditing] = useState<Arrangement | null>(null);
  if (it.kind === 'presentation') {
    const p = lib.presentations.find((x) => x.id === it.presentationId);
    if (!p) return <div className="banner red">This presentation no longer exists.</div>;
    const current = p.arrangements.find((a) => a.id === it.arrangementId) ?? p.arrangements[0] ?? authoringArrangement(p);
    return (
      <div className="col">
        <h3>{p.title}</h3>
        <Field label="Arrangement">
          <div className="row">
            <select
              value={it.arrangementId ?? ''}
              disabled={props.disabled}
              onChange={(e) => props.onChange({ ...it, arrangementId: e.target.value || undefined })}
            >
              <option value="">{p.arrangements[0] ? `${p.arrangements[0].name} (default)` : 'Authoring order'}</option>
              {p.arrangements.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {!props.disabled && (
              <>
                <button type="button" className="small" onClick={() => setEditing({ ...current })}>
                  Edit
                </button>
                <button
                  type="button"
                  className="small"
                  onClick={() =>
                    setEditing({ ...current, id: newId(), name: `${lib.playlists.find((x) => x.items.some((y) => y.id === it.id))?.name ?? 'This service'}` })
                  }
                  title="A new arrangement for this service only"
                >
                  New for this service
                </button>
              </>
            )}
          </div>
        </Field>
        {editing && (
          <div className="card col">
            <TextField label="Arrangement name" value={editing.name} onChange={(name) => setEditing({ ...editing, name })} />
            <ArrangementEditor presentation={p} value={editing} onChange={setEditing} />
            <div className="row">
              <button
                type="button"
                className="primary small"
                onClick={async () => {
                  if (await props.onSaveArrangement(p.id, editing)) {
                    props.onChange({ ...it, arrangementId: editing.id });
                    setEditing(null);
                  }
                }}
              >
                Save arrangement
              </button>
              <button type="button" className="small" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
            <span className="muted small">Arrangements are stored on the presentation; editing a section changes every arrangement using it.</span>
          </div>
        )}
        <Field label="Transition for this item">
          <TransitionEditor value={it.transition} allowInherit onChange={(transition) => props.onChange({ ...it, transition })} />
        </Field>
        <Field label="Background override">
          <BackgroundPicker value={it.backgroundMediaId} onChange={(backgroundMediaId) => props.onChange({ ...it, backgroundMediaId })} disabled={props.disabled} />
        </Field>
      </div>
    );
  }
  if (it.kind === 'media') {
    const m = lib.media.find((x) => x.id === it.mediaId);
    const pairs = lib.settings.audio.pairs;
    return (
      <div className="col">
        <h3>{m?.name ?? 'Missing media'}</h3>
        {m && m.kind !== 'image' && (
          <Check label="Loop" value={it.loop ?? m.loop} disabled={props.disabled} onChange={(loop) => props.onChange({ ...it, loop })} />
        )}
        {m?.kind === 'video' && (
          <Select
            label="At the end"
            value={it.onEnd ?? 'hold'}
            disabled={props.disabled}
            options={[
              { value: 'hold', label: 'Hold the last frame' },
              { value: 'black', label: 'Go to black' },
              { value: 'advance', label: 'Advance to the next item' },
            ]}
            onChange={(onEnd) => props.onChange({ ...it, onEnd })}
          />
        )}
        {m && m.kind !== 'image' && (
          <div className="grid2">
            <Select
              label="Audio pair"
              value={it.audio?.pairId ?? ''}
              disabled={props.disabled}
              options={[{ value: '', label: 'Media default' }, ...pairs.map((p) => ({ value: p.id, label: p.name }))]}
              onChange={(pairId) => props.onChange({ ...it, audio: { ...it.audio, pairId: pairId || undefined } })}
            />
            <NumberField
              label="Gain (dB)"
              value={it.audio?.gainDb ?? m.audio?.gainDb ?? 0}
              min={-40}
              max={20}
              disabled={props.disabled}
              onChange={(gainDb) => props.onChange({ ...it, audio: { ...it.audio, gainDb } })}
            />
          </div>
        )}
      </div>
    );
  }
  if (it.kind === 'timer') {
    const t = it.timer;
    return (
      <div className="col">
        <h3>Timer</h3>
        <Select
          label="Kind"
          value={t.kind}
          disabled={props.disabled}
          options={[
            { value: 'countdownTo', label: 'Countdown to a time of day' },
            { value: 'elapsed', label: 'Elapsed (starts when this item goes live)' },
          ]}
          onChange={(k) =>
            props.onChange({
              ...it,
              timer: k === 'elapsed' ? { kind: 'elapsed', label: t.label } : { kind: 'countdownTo', timeOfDay: '10:00', label: t.label },
            })
          }
        />
        {t.kind === 'countdownTo' && (
          <Field label="Time (venue time zone)">
            <input type="time" value={t.timeOfDay} disabled={props.disabled} onChange={(e) => props.onChange({ ...it, timer: { ...t, timeOfDay: e.target.value } })} />
          </Field>
        )}
        <TextField label="Label" value={t.label ?? ''} disabled={props.disabled} onChange={(label) => props.onChange({ ...it, timer: { ...t, label: label || undefined } })} />
      </div>
    );
  }
  return (
    <div className="col">
      <h3>Action</h3>
      <Select label="Action" value={it.action} disabled={props.disabled} options={ACTIONS} onChange={(action: ActionId) => props.onChange({ ...it, action })} />
    </div>
  );
}
