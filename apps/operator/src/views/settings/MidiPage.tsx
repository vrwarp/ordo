import {
  type ActionId,
  type MidiMapping,
  type MidiParamSource,
  type MidiPreset,
  newId,
  PROPRESENTER_MIDI_MAPPINGS,
  QUICKQ_MIDI_MAPPINGS,
  QUICKQ_STARTER_MIDI_PRESETS,
} from '@ordo/domain';
import {
  clampQuickQCue,
  clampQuickQPlayback,
  encodeQuickQ,
  formatMidiCueSummary,
  formatQuickQ,
  formatQuickQCommand,
  formatQuickQMapping,
  type MidiActivityEvent,
  MidiDriver,
  type QuickQCommand,
} from '@ordo/surfaces';
import { useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { Select } from '../../components/fields.tsx';
import { clearMidiLog, surfaces, useSurfaces } from '../../services/surfaces.ts';
import { toast } from '../../state/toasts.ts';
import { SlideMidiCues } from '../editor/SlideMidiCues.tsx';
import { ACTION_OPTIONS, ACTIONS_WITH_ARG, parseArg } from './actions.ts';
import { SaveBar, useSettingsDraft } from './useSettingsDraft.tsx';

const PARAM_SOURCE_OPTIONS: { value: MidiParamSource; label: string }[] = [
  { value: 'static', label: 'Static (threshold)' },
  { value: 'velocity', label: 'Velocity as arg (QuickQ / ProP)' },
  { value: 'ccValue', label: 'CC value as arg' },
];

const MAPPING_KIND_OPTIONS: { value: MidiMapping['kind']; label: string }[] = [
  { value: 'note', label: 'Note On' },
  { value: 'noteOff', label: 'Note Off' },
  { value: 'cc', label: 'CC' },
  { value: 'programChange', label: 'Program Change' },
];

const QUICKQ_PLAYBACKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

const PRESET_COLORS = [
  { value: '#f59e0b', label: 'Warm Amber' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#14b8a6', label: 'Teal' },
  { value: '#a855f7', label: 'Purple' },
  { value: '#ec4899', label: 'Magenta / Pink' },
  { value: '#ef4444', label: 'Red' },
  { value: '#22c55e', label: 'Green' },
  { value: '#e5e7eb', label: 'White / Neutral' },
] as const;

type LogFilter = 'all' | 'in' | 'out' | 'dropped';

function formatTimeMs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatMessageRaw(m: MidiActivityEvent['message']): string {
  if (m.kind === 'programChange') return `Ch ${m.channel} PC #${m.number}`;
  if (m.kind === 'cc') return `Ch ${m.channel} CC #${m.number} = ${m.value}`;
  if (m.kind === 'noteOff') return `Ch ${m.channel} Note Off #${m.number}`;
  return `Ch ${m.channel} Note On #${m.number} vel ${m.value}`;
}

function formatLogLine(ev: MidiActivityEvent): string {
  const dir = ev.direction === 'in' ? 'IN ' : 'OUT';
  const raw = formatMessageRaw(ev.message);
  const text = ev.quickq ? `${ev.quickq} (${raw})` : raw;
  const extra = [ev.status, ev.detail, ev.loopWarning ? 'LOOP?' : ''].filter(Boolean).join(' · ');
  return `[${formatTimeMs(ev.time)}] ${dir} [${ev.device}] ${ev.hex} | ${text} | ${extra}`;
}

/** MIDI inputs, outputs, QuickQ 20 soundcheck, mappings, and live activity monitor (prd/07). */
export function MidiPage() {
  const { draft, setDraft, save, revert, saving, dirty } = useSettingsDraft('surfaces', 'midi');
  const { midiReady, midiError, midiInputs, midiOutputs, lastMidiMessage, midiLog } = useSurfaces();
  const [learning, setLearning] = useState<string | null>(null);
  const [newAction, setNewAction] = useState<ActionId>('next');
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);

  // Soundcheck strip state
  const [scPlayback, setScPlayback] = useState(1);
  const [scCue, setScCue] = useState(1);
  const [scLevel, setScLevel] = useState(100);

  // Activity monitor state
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [pausedLog, setPausedLog] = useState<MidiActivityEvent[] | null>(null);

  const maps = draft.midi;
  const setMaps = (midi: MidiMapping[]) => setDraft({ ...draft, midi });
  const setMap = (id: string, patch: Partial<MidiMapping>) =>
    setMaps(maps.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const presets: MidiPreset[] = draft.midiPresets ?? [];
  const setPresets = (midiPresets: MidiPreset[]) => setDraft({ ...draft, midiPresets });
  const updatePreset = (id: string, patch: Partial<MidiPreset>) =>
    setPresets(presets.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const inputNames = new Set(midiInputs.map((i) => i.name));
  const outputNames = new Set(midiOutputs.map((o) => o.name));
  const defaultOutDisconnected = Boolean(
    draft.midiDefaultOutput && !outputNames.has(draft.midiDefaultOutput),
  );

  const learn = async (target: MidiMapping | null) => {
    const s = surfaces();
    if (!s) return;
    const action = target?.action ?? { id: newAction };
    const acceptNoteOff = target?.kind === 'noteOff';
    setLearning(target?.id ?? '__new');
    toast('Learning: press the pedal, key, or QuickQ button now (5 s).', 'info', 5000);
    const m = await s.midi.learn(action, 5000, { acceptNoteOff });
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

  const sendSoundcheck = (cmd: QuickQCommand) => {
    const s = surfaces();
    if (!s || !midiReady) {
      toast('Enable Web MIDI first.', 'warn');
      return;
    }
    const msg = encodeQuickQ(cmd);
    const ok = s.midi.send(msg, draft.midiDefaultOutput, 'Soundcheck');
    if (ok) {
      toast(`Sent ${formatQuickQCommand(cmd)}`, 'ok', 2000);
    } else {
      toast('Soundcheck message was not sent — check Default MIDI Output.', 'warn');
    }
  };

  const lastQuickQ = lastMidiMessage
    ? formatQuickQ({
        type:
          lastMidiMessage.kind === 'noteOn'
            ? 'noteOn'
            : lastMidiMessage.kind === 'noteOff'
              ? 'noteOff'
              : lastMidiMessage.kind === 'cc'
                ? 'cc'
                : 'programChange',
        channel: lastMidiMessage.channel,
        number: lastMidiMessage.number,
        value: lastMidiMessage.value,
      })
    : null;

  const visibleLog = (pausedLog ?? midiLog).filter((ev) => {
    if (logFilter === 'in') return ev.direction === 'in';
    if (logFilter === 'out') return ev.direction === 'out';
    if (logFilter === 'dropped') return ev.status === 'dropped';
    return true;
  });

  const copyLog = async () => {
    const text = visibleLog.map(formatLogLine).join('\n');
    if (!text) {
      toast('MIDI activity log is empty.', 'info');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${visibleLog.length} MIDI log entries.`, 'ok', 2000);
    } catch {
      toast('Could not copy to clipboard.', 'warn');
    }
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <h2>MIDI</h2>

      {!MidiDriver.supported && (
        <div className="banner" style={{ margin: 0 }}>
          <b>Web MIDI is not supported in this browser.</b> Use a Chromium-based browser (Chrome, Edge, or
          Opera) over HTTPS or localhost to connect MIDI interfaces such as a ChamSys QuickQ 20.
        </div>
      )}

      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <span className={`dot ${midiReady ? 'green' : 'grey'}`} />
        <span>{midiReady ? 'Web MIDI active' : 'Web MIDI is disabled (permission not requested)'}</span>
        {!midiReady ? (
          <button
            type="button"
            className="primary small"
            disabled={!MidiDriver.supported}
            onClick={async () => {
              const ok = await surfaces()?.enableMidi();
              if (ok) toast('Web MIDI enabled and devices connected.', 'ok');
              else
                toast(
                  useSurfaces.getState().midiError?.message ?? 'Web MIDI could not be initialized.',
                  'warn',
                );
            }}
          >
            Enable Web MIDI
          </button>
        ) : (
          <>
            <button
              type="button"
              className="small"
              onClick={async () => {
                await surfaces()?.disableMidi();
                toast('MIDI disabled.', 'info');
              }}
            >
              Disable MIDI
            </button>
            <button type="button" className="small" onClick={() => surfaces()?.refreshMidi()}>
              Refresh devices
            </button>
          </>
        )}
        {lastMidiMessage && (
          <span className="tag" style={{ marginLeft: 'auto', background: 'var(--panel-alt)' }}>
            <b>MIDI In:</b> {lastQuickQ ? `${lastQuickQ} · ` : ''}Ch {lastMidiMessage.channel} ·{' '}
            {lastMidiMessage.kind} #{lastMidiMessage.number} · val {lastMidiMessage.value}
          </span>
        )}
      </div>

      {!midiReady && MidiDriver.supported && midiError && (
        <div className="banner warn" style={{ margin: 0 }}>
          <b>{midiError.message}</b> {midiError.hint}
        </div>
      )}

      {!midiReady && MidiDriver.supported && !midiError && (
        <div className="banner" style={{ margin: 0 }}>
          MIDI is turned off by default so ordo never requests permission unexpectedly. Click{' '}
          <b>Enable Web MIDI</b> above to connect your lighting console, pedals, or controllers.
        </div>
      )}

      {/* Setup & Default Output */}
      <div className="card col small" style={{ gap: 8 }}>
        <div className="row wrap" style={{ gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
          <label className="row" style={{ gap: 8, alignItems: 'center', flex: 1, minWidth: 260 }}>
            <b>Default MIDI Output:</b>
            <select
              value={draft.midiDefaultOutput ?? ''}
              style={{ flex: 1 }}
              onChange={(e) => setDraft({ ...draft, midiDefaultOutput: e.target.value || undefined })}
            >
              <option value="">All outputs (broadcast)</option>
              {midiOutputs.map((o) => (
                <option key={o.id} value={o.name}>
                  {o.name}
                </option>
              ))}
              {defaultOutDisconnected && draft.midiDefaultOutput && (
                <option value={draft.midiDefaultOutput}>{draft.midiDefaultOutput} (disconnected)</option>
              )}
            </select>
          </label>
          <span className="muted">Used by slide cues &amp; Soundcheck unless overridden per cue.</span>
        </div>

        <div className="row wrap" style={{ gap: 16 }}>
          <div className="col" style={{ gap: 4, flex: 1, minWidth: 220 }}>
            <span className="muted">
              <b>Inputs (QuickQ Out / DAW / Pedals):</b>
            </span>
            <div className="row wrap">
              {midiInputs.map((i) => (
                <span key={i.id} className="tag">
                  {i.name}
                </span>
              ))}
              {!midiInputs.length && <span className="muted">No MIDI inputs found.</span>}
            </div>
          </div>
          <div className="col" style={{ gap: 4, flex: 1, minWidth: 220 }}>
            <span className="muted">
              <b>Outputs (QuickQ In / Lighting / Switchers):</b>
            </span>
            <div className="row wrap">
              {midiOutputs.map((o) => (
                <span key={o.id} className="tag">
                  {o.name}
                </span>
              ))}
              {!midiOutputs.length && <span className="muted">No MIDI outputs found.</span>}
            </div>
          </div>
        </div>

        <div className="muted" style={{ fontSize: 11, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
          <b>ChamSys QuickQ 20 Notes:</b> Connect via a USB-to-5-pin-DIN MIDI interface (QuickQ 20 has 5-pin
          DIN In/Out, not USB-MIDI). QuickQ MIDI is fixed to <b>Channel 1</b>, <b>Playbacks 1–10</b> (Note On
          / Note Off only, notes 48–93; whole cue numbers 1–127). MIDI In is always active;{' '}
          <b>MIDI Out requires QuickQ v11.0+</b>.
        </div>
      </div>

      {/* QuickQ 20 Soundcheck Strip */}
      <div className="card col small" style={{ gap: 8 }}>
        <div className="row wrap" style={{ gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <b>QuickQ 20 Soundcheck</b>
          <span className="muted">Target: {draft.midiDefaultOutput || 'All outputs'} · Channel 1</span>
        </div>
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <label className="row" style={{ gap: 4, alignItems: 'center' }}>
            <span className="muted">Playback</span>
            <select
              value={scPlayback}
              onChange={(e) => setScPlayback(clampQuickQPlayback(Number(e.target.value)))}
            >
              {QUICKQ_PLAYBACKS.map((pb) => (
                <option key={pb} value={pb}>
                  PB {pb}
                </option>
              ))}
            </select>
          </label>
          <label className="row" style={{ gap: 4, alignItems: 'center' }}>
            <span className="muted">Cue #</span>
            <input
              type="number"
              min={1}
              max={127}
              style={{ width: 56 }}
              value={scCue}
              onChange={(e) => setScCue(clampQuickQCue(Number(e.target.value)))}
            />
          </label>
          <label className="row" style={{ gap: 4, alignItems: 'center' }}>
            <span className="muted">Level %</span>
            <input
              type="number"
              min={1}
              max={100}
              style={{ width: 56 }}
              value={scLevel}
              onChange={(e) => setScLevel(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
            />
          </label>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="small"
            disabled={!midiReady}
            onClick={() => sendSoundcheck({ action: 'activate', playback: scPlayback, levelPct: scLevel })}
          >
            Activate
          </button>
          <button
            type="button"
            className="small"
            disabled={!midiReady}
            onClick={() => sendSoundcheck({ action: 'go', playback: scPlayback })}
          >
            Go
          </button>
          <button
            type="button"
            className="small"
            disabled={!midiReady}
            onClick={() => sendSoundcheck({ action: 'pause', playback: scPlayback })}
          >
            Pause / Back
          </button>
          <button
            type="button"
            className="small"
            disabled={!midiReady}
            onClick={() => sendSoundcheck({ action: 'release', playback: scPlayback })}
          >
            Release
          </button>
          <button
            type="button"
            className="small primary"
            disabled={!midiReady}
            onClick={() => sendSoundcheck({ action: 'goToCue', playback: scPlayback, cue: scCue })}
          >
            Go to Cue {scCue}
          </button>
        </div>
      </div>

      {/* Venue Lighting / MIDI Presets */}
      <div className="card col small" style={{ gap: 8 }}>
        <div className="row wrap" style={{ gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <b>Lighting / MIDI Presets</b>
          <div className="row wrap" style={{ gap: 6 }}>
            {presets.length === 0 && (
              <button
                type="button"
                className="small"
                onClick={() => {
                  setPresets(
                    QUICKQ_STARTER_MIDI_PRESETS.map((p) => ({
                      ...p,
                      id: newId(),
                      cues: p.cues.map((c) => ({ ...c, id: newId() })),
                    })),
                  );
                  toast('Loaded QuickQ starter presets (Lights: Full & Lights: Half).', 'ok');
                }}
              >
                Load QuickQ Starter
              </button>
            )}
            <button
              type="button"
              className="small primary"
              onClick={() => {
                const id = newId();
                const next: MidiPreset = {
                  id,
                  name: `Lighting Preset ${presets.length + 1}`,
                  color: PRESET_COLORS[presets.length % PRESET_COLORS.length]!.value,
                  cues: [{ id: newId(), ...encodeQuickQ({ action: 'goToCue', playback: 1, cue: 1 }) }],
                };
                setPresets([...presets, next]);
                setEditingPresetId(id);
              }}
            >
              + Add Preset
            </button>
          </div>
        </div>

        {presets.length === 0 ? (
          <span className="muted">
            Create named lighting presets here (e.g. <b>Lights: Full</b>, <b>Lights: Half</b>,{' '}
            <b>Stage: Blue</b>) so worship leads can pick them by name in playlists, songs, and backgrounds.
          </span>
        ) : (
          <div className="col" style={{ gap: 6 }}>
            {presets.map((p) => {
              const isEditing = editingPresetId === p.id;
              return (
                <div
                  key={p.id}
                  className="col"
                  style={{
                    gap: 6,
                    padding: 8,
                    border: '1px solid var(--border)',
                    borderLeft: p.color ? `4px solid ${p.color}` : undefined,
                    borderRadius: 4,
                    background: 'var(--panel)',
                  }}
                >
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                    <input
                      type="text"
                      value={p.name}
                      style={{ width: 170, fontWeight: 600 }}
                      onChange={(e) => updatePreset(p.id, { name: e.target.value })}
                    />
                    <select
                      value={p.color ?? ''}
                      aria-label="Preset color"
                      title="Badge color"
                      onChange={(e) => updatePreset(p.id, { color: e.target.value || undefined })}
                    >
                      <option value="">No color</option>
                      {PRESET_COLORS.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <span className="muted grow ellipsis" style={{ fontSize: 11 }}>
                      {p.cues.map(formatMidiCueSummary).join(' + ')}
                    </span>
                    <button
                      type="button"
                      className="small"
                      disabled={!midiReady}
                      onClick={() => {
                        const s = surfaces();
                        if (!s || !midiReady) {
                          toast('Enable Web MIDI first.', 'warn');
                          return;
                        }
                        s.midi.sendCues(p.cues, `Preset test: ${p.name}`);
                        toast(`Sent ${p.name}`, 'ok', 2000);
                      }}
                    >
                      Test
                    </button>
                    <button
                      type="button"
                      className={`small ${isEditing ? 'on' : ''}`}
                      onClick={() => setEditingPresetId(isEditing ? null : p.id)}
                    >
                      {isEditing ? 'Done' : 'Edit cues'}
                    </button>
                    <button
                      type="button"
                      className="small ghost danger"
                      title="Delete preset"
                      onClick={() => {
                        setPresets(presets.filter((x) => x.id !== p.id));
                        if (isEditing) setEditingPresetId(null);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  {isEditing && (
                    <SlideMidiCues
                      cues={p.cues}
                      readOnly={false}
                      onChange={(nextCues) => {
                        if (nextCues?.length) updatePreset(p.id, { cues: nextCues });
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <span className="muted" style={{ fontSize: 11 }}>
          <b>Tip (2-playback QuickQ setup):</b> Using a separate playback for stage colors (e.g. PB 2)? Add a
          second cue to <b>Lights: Full</b> (such as Stage White or Release PB 2) so stage colors reset
          cleanly for Announcements and the Sermon.
        </span>
      </div>

      {/* Input Mappings Table */}
      <h3 style={{ margin: '4px 0 0' }}>Input Mappings (MIDI → Ordo)</h3>
      <table className="list">
        <thead>
          <tr>
            <th>Device</th>
            <th>Kind</th>
            <th>Number</th>
            <th>Channel</th>
            <th>Parameter</th>
            <th>Threshold</th>
            <th>Action</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {maps.map((m) => {
            const isDynamic = m.paramSource === 'velocity' || m.paramSource === 'ccValue';
            const quickQHint = formatQuickQMapping(m);
            const deviceMissing = Boolean(m.deviceName && !inputNames.has(m.deviceName));
            return (
              <tr
                key={m.id}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    {
                      label: 'Learn MIDI…',
                      disabled: !midiReady || learning !== null,
                      onSelect: () => void learn(m),
                    },
                    {
                      label: 'Duplicate mapping',
                      onSelect: () => {
                        const copy: MidiMapping = { ...structuredClone(m), id: newId() };
                        const idx = maps.findIndex((x) => x.id === m.id);
                        const next = [...maps];
                        next.splice(idx + 1, 0, copy);
                        setMaps(next);
                      },
                    },
                    { kind: 'separator' },
                    {
                      label: 'Delete mapping',
                      danger: true,
                      onSelect: () => setMaps(maps.filter((x) => x.id !== m.id)),
                    },
                  ])
                }
              >
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
                        {n === m.deviceName && deviceMissing ? `${n} (disconnected)` : n}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <Select
                    value={m.kind}
                    options={MAPPING_KIND_OPTIONS}
                    onChange={(kind) => setMap(m.id, { kind })}
                  />
                </td>
                <td>
                  <div className="col" style={{ gap: 2 }}>
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
                    {quickQHint && (
                      <span className="muted" style={{ fontSize: 10 }}>
                        {quickQHint}
                      </span>
                    )}
                  </div>
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
                  <Select
                    value={m.paramSource ?? 'static'}
                    options={PARAM_SOURCE_OPTIONS}
                    onChange={(paramSource) => setMap(m.id, { paramSource: paramSource as MidiParamSource })}
                  />
                </td>
                <td>
                  {isDynamic ? (
                    <span className="muted small">dyn (val)</span>
                  ) : m.kind === 'noteOff' ? (
                    <span className="muted small">n/a</span>
                  ) : (
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
                  )}
                </td>
                <td>
                  <div className="row">
                    <Select
                      value={m.action.id}
                      options={ACTION_OPTIONS}
                      onChange={(id) => setMap(m.id, { action: { id } })}
                    />
                    {ACTIONS_WITH_ARG.has(m.action.id) && !isDynamic && (
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
            );
          })}
        </tbody>
      </table>
      <div className="row wrap" style={{ gap: 8 }}>
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
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="small"
          onClick={() => {
            setMaps(QUICKQ_MIDI_MAPPINGS.map((p) => ({ ...p, id: newId() })));
            toast('Loaded QuickQ 20 PB 1 preset (Channel 1).', 'ok');
          }}
        >
          Load QuickQ 20 Preset
        </button>
        <button
          type="button"
          className="small"
          onClick={() => {
            setMaps(PROPRESENTER_MIDI_MAPPINGS.map((p) => ({ ...p, id: newId() })));
            toast('Loaded ProPresenter 7 standard layout.', 'ok');
          }}
        >
          Load ProPresenter Map
        </button>
        <button
          type="button"
          className="small"
          onClick={() => {
            setMaps([
              { id: newId(), kind: 'note', number: 60, threshold: 1, action: { id: 'next' } },
              { id: newId(), kind: 'note', number: 62, threshold: 1, action: { id: 'prev' } },
            ]);
            toast('Loaded pedal defaults (notes 60 & 62).', 'info');
          }}
        >
          Load Pedal Defaults
        </button>
      </div>

      {/* Bidirectional MIDI Activity Monitor */}
      <div className="card col small" style={{ gap: 8 }}>
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <b>MIDI Activity Monitor</b>
          <div className="row" style={{ gap: 4 }}>
            {(['all', 'in', 'out', 'dropped'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`small ${logFilter === f ? 'on' : 'ghost'}`}
                onClick={() => setLogFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'in' ? 'In' : f === 'out' ? 'Out' : 'Dropped'}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className={`small ${pausedLog !== null ? 'on' : ''}`}
            onClick={() => setPausedLog((cur) => (cur === null ? [...midiLog] : null))}
          >
            {pausedLog !== null ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="small" onClick={() => void copyLog()}>
            Copy log
          </button>
          <button
            type="button"
            className="small ghost"
            onClick={() => {
              clearMidiLog();
              if (pausedLog !== null) setPausedLog([]);
            }}
          >
            Clear
          </button>
        </div>

        {visibleLog.length === 0 ? (
          <span className="muted">
            No MIDI activity recorded yet. Fire a Soundcheck cue, switch a slide, or send MIDI from your
            console to inspect traffic.
          </span>
        ) : (
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            <table className="list" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Dir</th>
                  <th>Device</th>
                  <th>Hex</th>
                  <th>Message</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleLog.map((ev) => (
                  <tr key={ev.id}>
                    <td style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{formatTimeMs(ev.time)}</td>
                    <td>
                      <span
                        className="tag"
                        style={{
                          background:
                            ev.direction === 'out'
                              ? 'var(--accent-soft, var(--panel-alt))'
                              : 'var(--panel-alt)',
                        }}
                      >
                        {ev.direction === 'out' ? 'OUT' : 'IN'}
                      </span>
                    </td>
                    <td>{ev.device}</td>
                    <td style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{ev.hex}</td>
                    <td>
                      <div className="col" style={{ gap: 1 }}>
                        <span>{ev.quickq ?? formatMessageRaw(ev.message)}</span>
                        {ev.quickq && (
                          <span className="muted" style={{ fontSize: 10 }}>
                            {formatMessageRaw(ev.message)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="row wrap" style={{ gap: 4, alignItems: 'center' }}>
                        <span
                          className="tag"
                          style={{
                            color:
                              ev.status === 'dropped'
                                ? 'var(--danger, #dc2626)'
                                : ev.status === 'sent' || ev.status === 'matched'
                                  ? 'var(--ok, #16a34a)'
                                  : undefined,
                          }}
                        >
                          {ev.status}
                        </span>
                        {ev.loopWarning && (
                          <span
                            className="tag"
                            title="Same message received within 50 ms of being sent — possible MIDI thru/echo loop"
                            style={{ color: 'var(--warn, #d97706)' }}
                          >
                            Loop?
                          </span>
                        )}
                        {ev.detail && (
                          <span className="muted" style={{ fontSize: 11 }}>
                            {ev.detail}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onRevert={revert} />
    </div>
  );
}
