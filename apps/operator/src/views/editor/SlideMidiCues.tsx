import { type MidiCue, type MidiCueType, newId } from '@ordo/domain';
import { Select } from '../../components/fields.tsx';
import { surfaces, useSurfaces } from '../../services/surfaces.ts';
import { toast } from '../../state/toasts.ts';

const CUE_TYPES: { value: MidiCueType; label: string }[] = [
  { value: 'noteOn', label: 'Note On' },
  { value: 'noteOff', label: 'Note Off' },
  { value: 'cc', label: 'Control Change (CC)' },
  { value: 'programChange', label: 'Program Change' },
];

const MIDI_CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;

/** Slide-level outgoing MIDI cues (ProPresenter communication actions). */
export function SlideMidiCues({
  cues = [],
  onChange,
  readOnly,
}: {
  cues?: MidiCue[];
  onChange: (cues: MidiCue[] | undefined) => void;
  readOnly: boolean;
}) {
  const { midiOutputs, midiReady } = useSurfaces();

  const addCue = () => {
    const next: MidiCue = {
      id: newId(),
      type: 'noteOn',
      number: 60,
      value: 127,
      channel: 1,
    };
    onChange([...cues, next]);
  };

  const updateCue = (id: string, patch: Partial<MidiCue>) => {
    onChange(cues.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const removeCue = (id: string) => {
    const next = cues.filter((c) => c.id !== id);
    onChange(next.length ? next : undefined);
  };

  const testCue = (c: MidiCue) => {
    const s = surfaces();
    if (!s || !midiReady) {
      toast('Enable Web MIDI first to test cues.', 'warn');
      return;
    }
    s.midi.send(
      {
        type: c.type,
        channel: c.channel,
        number: c.number,
        value: c.value,
      },
      c.deviceName,
    );
    toast(`Sent MIDI ${c.type} #${c.number} (ch ${c.channel})`, 'ok', 2000);
  };

  return (
    <div className="card col small" style={{ gap: 8 }}>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <b>MIDI Cues (Show Control)</b>
        {!readOnly && (
          <button type="button" className="small" onClick={addCue}>
            + Add cue
          </button>
        )}
      </div>
      {cues.length === 0 && (
        <span className="muted">
          No MIDI cues on this slide. When added, they fire automatically when this slide goes live.
        </span>
      )}
      {cues.map((c) => (
        <div
          key={c.id}
          className="col"
          style={{
            gap: 6,
            padding: 8,
            border: '1px solid var(--border)',
            borderRadius: 4,
            background: 'var(--panel)',
          }}
        >
          <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
            <Select
              value={c.type}
              options={CUE_TYPES}
              disabled={readOnly}
              onChange={(type) => updateCue(c.id, { type })}
            />
            <label className="row" style={{ gap: 4, alignItems: 'center' }}>
              <span className="muted">Ch</span>
              <select
                value={c.channel}
                disabled={readOnly}
                onChange={(e) => updateCue(c.id, { channel: Number(e.target.value) })}
              >
                {MIDI_CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {ch}
                  </option>
                ))}
              </select>
            </label>
            <label className="row" style={{ gap: 4, alignItems: 'center' }}>
              <span className="muted">
                {c.type === 'programChange' ? 'Prog' : c.type === 'cc' ? 'CC' : 'Note'}
              </span>
              <input
                type="number"
                min={0}
                max={127}
                style={{ width: 50 }}
                value={c.number}
                disabled={readOnly}
                onChange={(e) =>
                  updateCue(c.id, { number: Math.max(0, Math.min(127, Number(e.target.value))) })
                }
              />
            </label>
            {c.type !== 'programChange' && (
              <label className="row" style={{ gap: 4, alignItems: 'center' }}>
                <span className="muted">Val</span>
                <input
                  type="number"
                  min={0}
                  max={127}
                  style={{ width: 50 }}
                  value={c.value}
                  disabled={readOnly}
                  onChange={(e) =>
                    updateCue(c.id, { value: Math.max(0, Math.min(127, Number(e.target.value))) })
                  }
                />
              </label>
            )}
          </div>
          <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
            <label className="row" style={{ gap: 4, alignItems: 'center', flex: 1 }}>
              <span className="muted">Output</span>
              <select
                value={c.deviceName ?? ''}
                disabled={readOnly}
                style={{ flex: 1 }}
                onChange={(e) => updateCue(c.id, { deviceName: e.target.value || undefined })}
              >
                <option value="">All outputs</option>
                {midiOutputs.map((o) => (
                  <option key={o.id} value={o.name}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="small" title="Test fire cue now" onClick={() => testCue(c)}>
              Test
            </button>
            {!readOnly && (
              <button
                type="button"
                className="small ghost danger"
                title="Remove cue"
                onClick={() => removeCue(c.id)}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
