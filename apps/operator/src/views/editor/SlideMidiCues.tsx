import { type MidiCue, type MidiCueType, newId } from '@ordo/domain';
import {
  clampQuickQCue,
  clampQuickQPlayback,
  decodeQuickQ,
  encodeQuickQ,
  formatMidiCueSummary,
  formatQuickQ,
  levelPctToVelocity,
  type QuickQAction,
  type QuickQCommand,
  validateQuickQCue,
  velocityToLevelPct,
} from '@ordo/surfaces';
import { useState } from 'react';
import { Select } from '../../components/fields.tsx';
import { surfaces, useSurfaces } from '../../services/surfaces.ts';
import { useLibrary } from '../../state/library.ts';
import { toast } from '../../state/toasts.ts';

const CUE_TYPES: { value: MidiCueType; label: string }[] = [
  { value: 'noteOn', label: 'Note On' },
  { value: 'noteOff', label: 'Note Off' },
  { value: 'cc', label: 'Control Change (CC)' },
  { value: 'programChange', label: 'Program Change' },
];

const QUICKQ_ACTIONS: { value: QuickQAction; label: string }[] = [
  { value: 'goToCue', label: 'Go to Cue' },
  { value: 'go', label: 'Go (next)' },
  { value: 'pause', label: 'Pause / Back' },
  { value: 'activate', label: 'Activate' },
  { value: 'release', label: 'Release' },
];

const QUICKQ_PLAYBACKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const MIDI_CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;

type CueMode = 'quickq' | 'raw';

function defaultQuickQCommand(action: QuickQAction, playback: number): QuickQCommand {
  const pb = clampQuickQPlayback(playback);
  switch (action) {
    case 'goToCue':
      return { action: 'goToCue', playback: pb, cue: 1 };
    case 'activate':
      return { action: 'activate', playback: pb, levelPct: 100 };
    case 'release':
      return { action: 'release', playback: pb };
    case 'go':
      return { action: 'go', playback: pb };
    case 'pause':
      return { action: 'pause', playback: pb };
  }
}

/** Slide-level outgoing MIDI cues (QuickQ 20 + Raw MIDI show control). */
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
  const defaultOutput = useLibrary((st) => st.data.settings.surfaces.midiDefaultOutput);
  const [modeOverrides, setModeOverrides] = useState<Record<string, CueMode>>({});

  const modeOf = (c: MidiCue): CueMode => modeOverrides[c.id] ?? (decodeQuickQ(c) ? 'quickq' : 'raw');

  const setMode = (c: MidiCue, mode: CueMode) => {
    setModeOverrides((prev) => ({ ...prev, [c.id]: mode }));
    if (mode === 'quickq' && !decodeQuickQ(c)) {
      const encoded = encodeQuickQ({ action: 'goToCue', playback: 1, cue: 1 });
      updateCue(c.id, encoded);
    }
  };

  const addCue = () => {
    const id = newId();
    const next: MidiCue = {
      id,
      ...encodeQuickQ({ action: 'goToCue', playback: 1, cue: 1 }),
    };
    setModeOverrides((prev) => ({ ...prev, [id]: 'quickq' }));
    onChange([...cues, next]);
  };

  const updateCue = (id: string, patch: Partial<MidiCue>) => {
    onChange(cues.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const updateQuickQ = (id: string, cmd: QuickQCommand) => {
    updateCue(id, encodeQuickQ(cmd));
  };

  const removeCue = (id: string) => {
    const next = cues.filter((c) => c.id !== id);
    onChange(next.length ? next : undefined);
  };

  const testCue = (c: MidiCue) => {
    const s = surfaces();
    if (!s || !midiReady) {
      toast('Enable Web MIDI in Settings → MIDI first to test cues.', 'warn');
      return;
    }
    const ok = s.midi.send(
      {
        type: c.type,
        channel: c.channel,
        number: c.number,
        value: c.value,
      },
      c.deviceName,
      'Slide test',
    );
    if (ok) {
      toast(`Sent ${formatMidiCueSummary(c)}`, 'ok', 2000);
    } else {
      toast('Could not send MIDI cue — check output connection in Settings → MIDI.', 'warn');
    }
  };

  const outputNames = new Set(midiOutputs.map((o) => o.name));

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
      {cues.map((c) => {
        const mode = modeOf(c);
        const decoded = decodeQuickQ(c);
        const warnings = mode === 'raw' ? validateQuickQCue(c) : [];
        const disconnected = Boolean(c.deviceName && !outputNames.has(c.deviceName));
        return (
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
            <div
              className="row wrap"
              style={{ gap: 6, alignItems: 'center', justifyContent: 'space-between' }}
            >
              <div className="row" style={{ gap: 4 }}>
                <button
                  type="button"
                  className={`small ${mode === 'quickq' ? 'on' : 'ghost'}`}
                  disabled={readOnly}
                  onClick={() => setMode(c, 'quickq')}
                >
                  QuickQ 20
                </button>
                <button
                  type="button"
                  className={`small ${mode === 'raw' ? 'on' : 'ghost'}`}
                  disabled={readOnly}
                  onClick={() => setMode(c, 'raw')}
                >
                  Raw MIDI
                </button>
              </div>
              <span className="muted" style={{ fontSize: 11 }}>
                {c.type === 'noteOn'
                  ? `Ch ${c.channel} · Note On #${c.number} · Vel ${c.value}`
                  : c.type === 'noteOff'
                    ? `Ch ${c.channel} · Note Off #${c.number}`
                    : c.type === 'cc'
                      ? `Ch ${c.channel} · CC #${c.number} = ${c.value}`
                      : `Ch ${c.channel} · PC #${c.number}`}
              </span>
            </div>

            {mode === 'quickq' && decoded ? (
              <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                <label className="row" style={{ gap: 4, alignItems: 'center' }}>
                  <span className="muted">PB</span>
                  <select
                    value={decoded.playback}
                    disabled={readOnly}
                    onChange={(e) => {
                      const playback = clampQuickQPlayback(Number(e.target.value));
                      updateQuickQ(c.id, { ...decoded, playback } as QuickQCommand);
                    }}
                  >
                    {QUICKQ_PLAYBACKS.map((pb) => (
                      <option key={pb} value={pb}>
                        {pb}
                      </option>
                    ))}
                  </select>
                </label>
                <Select
                  value={decoded.action}
                  options={QUICKQ_ACTIONS}
                  disabled={readOnly}
                  onChange={(action) => updateQuickQ(c.id, defaultQuickQCommand(action, decoded.playback))}
                />
                {decoded.action === 'goToCue' && (
                  <label
                    className="row"
                    style={{ gap: 4, alignItems: 'center' }}
                    title="Whole cue numbers 1–127 only (QuickQ MIDI cannot address decimal cues or cues above 127)"
                  >
                    <span className="muted">Cue #</span>
                    <input
                      type="number"
                      min={1}
                      max={127}
                      style={{ width: 56 }}
                      value={decoded.cue}
                      disabled={readOnly}
                      onChange={(e) =>
                        updateQuickQ(c.id, {
                          action: 'goToCue',
                          playback: decoded.playback,
                          cue: clampQuickQCue(Number(e.target.value)),
                        })
                      }
                    />
                  </label>
                )}
                {decoded.action === 'activate' && (
                  <label className="row" style={{ gap: 4, alignItems: 'center' }}>
                    <span className="muted">Level %</span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      style={{ width: 56 }}
                      value={velocityToLevelPct(c.value)}
                      disabled={readOnly}
                      onChange={(e) => {
                        const pct = Math.max(1, Math.min(100, Number(e.target.value) || 1));
                        updateCue(c.id, {
                          ...encodeQuickQ({ action: 'activate', playback: decoded.playback, levelPct: pct }),
                          value: levelPctToVelocity(pct),
                        });
                      }}
                    />
                  </label>
                )}
              </div>
            ) : (
              <>
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
                {decoded && (
                  <span className="tag" style={{ alignSelf: 'flex-start', background: 'var(--panel-alt)' }}>
                    {formatQuickQ(c)}
                  </span>
                )}
                {!decoded && warnings.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--warn, #d97706)' }}>{warnings[0]}</span>
                )}
              </>
            )}

            <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
              <label className="row" style={{ gap: 4, alignItems: 'center', flex: 1 }}>
                <span className="muted">Output</span>
                <select
                  value={c.deviceName ?? ''}
                  disabled={readOnly}
                  style={{ flex: 1 }}
                  onChange={(e) => updateCue(c.id, { deviceName: e.target.value || undefined })}
                >
                  <option value="">{defaultOutput ? `Default (${defaultOutput})` : 'All outputs'}</option>
                  {midiOutputs.map((o) => (
                    <option key={o.id} value={o.name}>
                      {o.name}
                    </option>
                  ))}
                  {disconnected && c.deviceName && (
                    <option value={c.deviceName}>{c.deviceName} (disconnected)</option>
                  )}
                </select>
              </label>
              <label
                className="row"
                style={{ gap: 4, alignItems: 'center' }}
                title="Delay before firing after slide goes live (cancelled if another slide goes live first)"
              >
                <span className="muted">Delay ms</span>
                <input
                  type="number"
                  min={0}
                  max={60000}
                  step={50}
                  style={{ width: 64 }}
                  value={c.delayMs ?? 0}
                  disabled={readOnly}
                  onChange={(e) => {
                    const ms = Math.max(0, Math.min(60000, Math.round(Number(e.target.value) || 0)));
                    updateCue(c.id, { delayMs: ms > 0 ? ms : undefined });
                  }}
                />
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
        );
      })}
    </div>
  );
}
