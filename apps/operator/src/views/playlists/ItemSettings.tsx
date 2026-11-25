import { api } from '@ordo/client';
import {
  type ActionId,
  type Arrangement,
  type CountdownCorner,
  type CountdownPreset,
  type LiveState,
  LOOK_MAIN,
  type Look,
  newId,
  type PlaylistItem,
  type Section,
  type TimerSpec,
} from '@ordo/domain';
import { effectiveCountdownPreset, propsModel, rasterProps } from '@ordo/renderer';
import { useEffect, useRef, useState } from 'react';
import { ArrangementEditor } from '../../components/ArrangementEditor.tsx';
import {
  Check,
  NumberField,
  PropertyRow,
  Select,
  TextField,
  TransitionEditor,
} from '../../components/fields.tsx';
import { Icon } from '../../components/Icons.tsx';
import {
  countPresentationMidi,
  midiTriggerBadge,
  MidiTriggerPicker,
  shouldShowMidiUi,
} from '../../components/MidiTriggerPicker.tsx';
import { authoringArrangement } from '../../lib/arrangement.ts';
import { upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { BackgroundPicker } from '../editor/BackgroundPicker.tsx';
import { ACTIONS } from './AddItemsPanel.tsx';

const COUNTDOWN_PRESETS: readonly { id: CountdownPreset; label: string }[] = [
  { id: 'cornerCircle', label: 'Corner Circle' },
  { id: 'cornerPill', label: 'Corner Pill' },
  { id: 'centerHero', label: 'Center Hero' },
];

const COUNTDOWN_CORNERS: readonly { id: CountdownCorner; label: string }[] = [
  { id: 'topLeft', label: 'Top Left' },
  { id: 'topRight', label: 'Top Right' },
  { id: 'bottomLeft', label: 'Bottom Left' },
  { id: 'bottomRight', label: 'Bottom Right' },
];

const PREVIEW_NOW = Date.UTC(2026, 10, 1, 9, 55, 0);

function TimerPreviewCanvas({ timer, baseLook }: { timer: TimerSpec; baseLook: Look }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;

    const g = ctx.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, '#1e3a8a');
    g.addColorStop(1, '#4c1d95');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(24, 22, c.width - 48, c.height - 44);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.font = '600 13px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Welcome Slide Content', c.width / 2, c.height / 2);
    ctx.restore();

    const spec: TimerSpec =
      timer.kind === 'countdownTo'
        ? { ...timer, timeOfDay: '10:00' }
        : { kind: 'countdownTo', timeOfDay: '10:00', label: timer.label };

    const state: LiveState = {
      seq: 1,
      mode: 'live',
      cues: [],
      audio: { content: null, seq: 0, at: 0 },
      layers: {
        background: { content: null, seq: 0, at: 0 },
        slide: { content: null, seq: 0, at: 0 },
        lowerThird: { content: null, seq: 0, at: 0 },
        media: { content: null, seq: 0, at: 0 },
      },
      black: false,
      props: { logo: false, countdownTimerId: 'preview', seq: 1, at: 0 },
      timers: {
        preview: {
          id: 'preview',
          spec,
          running: true,
          startedAt: PREVIEW_NOW - 5 * 60_000,
        },
      },
      messages: [],
    };

    const model = propsModel(state, baseLook, {
      now: PREVIEW_NOW,
      timeZone: 'UTC',
      clock24h: false,
    });
    rasterProps(ctx, model, c.width / 1920, () => undefined, baseLook.clearColor);
  }, [timer, baseLook]);

  return (
    <canvas
      ref={ref}
      width={320}
      height={180}
      style={{
        width: 240,
        maxWidth: '100%',
        aspectRatio: '16 / 9',
        borderRadius: 3,
        border: '1px solid var(--line)',
      }}
    />
  );
}

/** Compact 2-column desktop inspector for one playlist item, by kind (design/30 §5.2). */
export function ItemSettings(props: {
  item: PlaylistItem;
  disabled: boolean;
  onChange: (it: PlaylistItem) => void;
  onSaveArrangement: (presentationId: string, a: Arrangement) => Promise<boolean>;
}) {
  const lib = useLibrary((s) => s.data);
  const it = props.item;
  const [prevId, setPrevId] = useState(it.id);
  const [editing, setEditing] = useState<Arrangement | null>(null);

  if (it.id !== prevId) {
    setPrevId(it.id);
    setEditing(null);
  }

  if (it.kind === 'presentation') {
    const p = lib.presentations.find((x) => x.id === it.presentationId);
    if (!p)
      return (
        <div className="prop-section">
          <div className="banner red">This presentation no longer exists.</div>
        </div>
      );
    const current =
      p.arrangements.find((a) => a.id === it.arrangementId) ?? p.arrangements[0] ?? authoringArrangement(p);
    const effBgId = it.backgroundMediaId ?? p.backgroundMediaId;
    const effBg = effBgId ? lib.media.find((m) => m.id === effBgId) : undefined;
    const bgBadge = effBg?.midi ? midiTriggerBadge(effBg.midi, lib.settings.surfaces.midiPresets) : null;
    const inner = countPresentationMidi(p);
    const hasAnyMidi = Boolean(it.midi || bgBadge || inner.sections > 0 || inner.slides > 0);
    const audioFiles = lib.media.filter((m) => m.kind === 'audio');

    return (
      <div className="col" style={{ gap: 0 }}>
        <div className="prop-section">
          <div className="prop-section-title">
            <span>Playback &amp; Visuals</span>
            {it.sections && (
              <span className="tag amber" style={{ textTransform: 'none' }}>
                Custom ({it.sections.length})
              </span>
            )}
          </div>
          <PropertyRow label="Arrangement">
            <Select
              value={it.arrangementId ?? ''}
              disabled={props.disabled}
              ariaLabel="Arrangement"
              options={[
                {
                  value: '',
                  label: p.arrangements[0] ? `${p.arrangements[0].name} (default)` : 'Authoring order',
                },
                ...p.arrangements.map((a) => ({ value: a.id, label: a.name })),
              ]}
              onChange={(v) => {
                const { sections: _s, ...rest } = it;
                props.onChange({ ...rest, arrangementId: v || undefined });
              }}
            />
            {it.sections && !props.disabled && (
              <button
                type="button"
                className="small"
                onClick={() => {
                  const { sections: _s, ...rest } = it;
                  props.onChange(rest);
                }}
                title="Clear per-service custom section order"
              >
                Clear custom
              </button>
            )}
            {!props.disabled && (
              <>
                <button type="button" className="small" onClick={() => setEditing({ ...current })}>
                  Edit
                </button>
                <button
                  type="button"
                  className="small"
                  onClick={() =>
                    setEditing({
                      ...current,
                      id: newId(),
                      name: `${lib.playlists.find((x) => x.items.some((y) => y.id === it.id))?.name ?? 'This service'}`,
                    })
                  }
                  title="Create a new arrangement saved on the song"
                >
                  New…
                </button>
              </>
            )}
          </PropertyRow>

          {editing && (
            <div
              className="col"
              style={{
                padding: 8,
                background: 'var(--bg)',
                border: '1px solid var(--line-strong)',
                borderRadius: 3,
                gap: 8,
              }}
            >
              <PropertyRow label="Name">
                <TextField
                  value={editing.name}
                  onChange={(name) => setEditing({ ...editing, name })}
                  style={{ flex: 1 }}
                />
              </PropertyRow>
              <ArrangementEditor
                presentation={p}
                value={editing}
                onChange={setEditing}
                onAddSection={async (sec: Section) => {
                  const updated = { ...p, sections: [...p.sections, sec] };
                  try {
                    const saved = await api<typeof p>(`/presentations/${p.id}`, {
                      method: 'PUT',
                      json: updated,
                    });
                    upsertLocal('presentations', saved);
                  } catch (e) {
                    toast(`Could not save custom section: ${errorText(e)}`, 'error');
                  }
                }}
              />
              <div className="row" style={{ gap: 6 }}>
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
            </div>
          )}

          <PropertyRow label="Transition">
            <TransitionEditor
              value={it.transition}
              allowInherit
              disabled={props.disabled}
              onChange={(transition) => props.onChange({ ...it, transition })}
            />
          </PropertyRow>

          <PropertyRow label="Background" align="start">
            <div className="col" style={{ gap: 4, flex: 1, minWidth: 0 }}>
              <BackgroundPicker
                value={it.backgroundMediaId}
                onChange={(backgroundMediaId) => props.onChange({ ...it, backgroundMediaId })}
                disabled={props.disabled}
              />
              <Check
                label="Keep previous background (medley)"
                value={it.keepBackground ?? false}
                disabled={props.disabled}
                onChange={(keepBackground) =>
                  props.onChange({ ...it, keepBackground: keepBackground || undefined })
                }
              />
            </div>
          </PropertyRow>

          {shouldShowMidiUi(lib.settings.surfaces, hasAnyMidi) && (
            <PropertyRow
              label="Lighting / MIDI"
              hint="Fires once when entering this item (this service only)."
              align="start"
            >
              <div className="col" style={{ gap: 5, flex: 1, minWidth: 0 }}>
                {bgBadge && effBg && (
                  <div className="row wrap small" style={{ gap: 5, alignItems: 'center' }}>
                    <span className="muted">From bg:</span>
                    <span
                      className="tag"
                      title={bgBadge.title}
                      style={{ borderLeft: bgBadge.color ? `3px solid ${bgBadge.color}` : undefined }}
                    >
                      <Icon name="lights" size={10} /> {bgBadge.label}
                    </span>
                  </div>
                )}
                <MidiTriggerPicker
                  value={it.midi}
                  disabled={props.disabled}
                  onChange={(midi) => props.onChange({ ...it, midi })}
                />
                {(inner.sections > 0 || inner.slides > 0) && (
                  <span className="muted" style={{ fontSize: 10.5 }}>
                    +{inner.sections > 0 ? `${inner.sections} section` : ''}
                    {inner.sections > 0 && inner.slides > 0 ? ', ' : ''}
                    {inner.slides > 0 ? `${inner.slides} slide` : ''} cues inside presentation.
                  </span>
                )}
              </div>
            </PropertyRow>
          )}
        </div>

        {p.kind === 'loop' && (
          <div className="prop-section">
            <div
              className="prop-section-title"
              title="Starting this loop can automatically start background music and an audience countdown. Leaving fades out the music and clears the countdown."
            >
              <span>Pre-Service Loop Automation</span>
            </div>
            <PropertyRow label="Background music">
              <Select
                value={it.audioMediaId ?? ''}
                disabled={props.disabled}
                ariaLabel="Background music"
                options={[
                  { value: '', label: 'None' },
                  ...audioFiles.map((m) => ({ value: m.id, label: m.name })),
                ]}
                onChange={(v) => props.onChange({ ...it, audioMediaId: v || undefined })}
              />
            </PropertyRow>
            <PropertyRow label="Countdown" align="start">
              <div className="row wrap" style={{ gap: 5, alignItems: 'center' }}>
                <input
                  type="time"
                  value={it.countdownTimer?.kind === 'countdownTo' ? it.countdownTimer.timeOfDay : ''}
                  disabled={props.disabled}
                  style={{ width: 96 }}
                  onChange={(e) => {
                    const val = e.target.value.slice(0, 5);
                    const prev = it.countdownTimer?.kind === 'countdownTo' ? it.countdownTimer : undefined;
                    props.onChange({
                      ...it,
                      countdownTimer: /^\d{2}:\d{2}$/.test(val)
                        ? {
                            kind: 'countdownTo',
                            timeOfDay: val,
                            label: prev?.label ?? 'Service starts in',
                            preset: prev?.preset,
                            corner: prev?.corner,
                          }
                        : undefined,
                    });
                  }}
                />
                {it.countdownTimer?.kind === 'countdownTo' && (
                  <>
                    <input
                      type="text"
                      placeholder="Label"
                      value={it.countdownTimer.label ?? ''}
                      disabled={props.disabled}
                      style={{ width: 140 }}
                      onChange={(e) =>
                        props.onChange({
                          ...it,
                          countdownTimer: {
                            ...it.countdownTimer!,
                            label: e.target.value || undefined,
                          },
                        })
                      }
                    />
                    <Select
                      ariaLabel="Countdown style"
                      value={it.countdownTimer.preset ?? ''}
                      disabled={props.disabled}
                      options={[
                        { value: '', label: 'Look default' },
                        ...COUNTDOWN_PRESETS.map((pr) => ({ value: pr.id, label: pr.label })),
                      ]}
                      onChange={(v) =>
                        props.onChange({
                          ...it,
                          countdownTimer: {
                            ...it.countdownTimer!,
                            kind: 'countdownTo',
                            timeOfDay:
                              it.countdownTimer!.kind === 'countdownTo'
                                ? it.countdownTimer!.timeOfDay
                                : '10:00',
                            preset: (v || undefined) as CountdownPreset | undefined,
                          },
                        })
                      }
                    />
                    {it.countdownTimer.preset !== 'centerHero' && (
                      <Select
                        ariaLabel="Countdown corner"
                        value={it.countdownTimer.corner ?? ''}
                        disabled={props.disabled}
                        options={[
                          { value: '', label: 'Look corner' },
                          ...COUNTDOWN_CORNERS.map((c) => ({ value: c.id, label: c.label })),
                        ]}
                        onChange={(v) =>
                          props.onChange({
                            ...it,
                            countdownTimer: {
                              ...it.countdownTimer!,
                              kind: 'countdownTo',
                              timeOfDay:
                                it.countdownTimer!.kind === 'countdownTo'
                                  ? it.countdownTimer!.timeOfDay
                                  : '10:00',
                              corner: (v || undefined) as CountdownCorner | undefined,
                            },
                          })
                        }
                      />
                    )}
                    <button
                      type="button"
                      className="small ghost"
                      disabled={props.disabled}
                      onClick={() => props.onChange({ ...it, countdownTimer: undefined })}
                    >
                      Clear
                    </button>
                  </>
                )}
              </div>
            </PropertyRow>
          </div>
        )}
      </div>
    );
  }

  if (it.kind === 'media') {
    const m = lib.media.find((x) => x.id === it.mediaId);
    const pairs = lib.settings.audio.pairs;
    return (
      <div className="prop-section">
        <div className="prop-section-title">Media Item · {m?.name ?? 'Missing media'}</div>
        {m && m.kind !== 'image' && (
          <PropertyRow label="Loop">
            <Check
              label="Loop playback"
              value={it.loop ?? m.loop}
              disabled={props.disabled}
              onChange={(loop) => props.onChange({ ...it, loop })}
            />
          </PropertyRow>
        )}
        {m?.kind === 'video' && (
          <PropertyRow label="At end">
            <Select
              value={it.onEnd ?? 'hold'}
              disabled={props.disabled}
              options={[
                { value: 'hold', label: 'Hold last frame' },
                { value: 'black', label: 'Go to black' },
                { value: 'advance', label: 'Advance to next' },
              ]}
              onChange={(onEnd) => props.onChange({ ...it, onEnd })}
            />
          </PropertyRow>
        )}
        {m && m.kind !== 'image' && (
          <>
            <PropertyRow label="Audio pair">
              <Select
                value={it.audio?.pairId ?? ''}
                disabled={props.disabled}
                options={[
                  { value: '', label: 'Media default' },
                  ...pairs.map((p) => ({ value: p.id, label: p.name })),
                ]}
                onChange={(pairId) =>
                  props.onChange({ ...it, audio: { ...it.audio, pairId: pairId || undefined } })
                }
              />
            </PropertyRow>
            <PropertyRow label="Gain">
              <NumberField
                value={it.audio?.gainDb ?? m.audio?.gainDb ?? 0}
                min={-40}
                max={20}
                disabled={props.disabled}
                suffix="dB"
                stepper
                width={58}
                onChange={(gainDb) => props.onChange({ ...it, audio: { ...it.audio, gainDb } })}
              />
            </PropertyRow>
          </>
        )}
        {shouldShowMidiUi(lib.settings.surfaces, Boolean(it.midi)) && (
          <PropertyRow
            label="Lighting / MIDI"
            hint="Fires once when this media item goes live."
            align="start"
          >
            <MidiTriggerPicker
              value={it.midi}
              disabled={props.disabled}
              onChange={(midi) => props.onChange({ ...it, midi })}
            />
          </PropertyRow>
        )}
      </div>
    );
  }

  if (it.kind === 'timer') {
    const t = it.timer;
    const baseLook = lib.settings.looks.find((l) => l.kind === 'main') ?? LOOK_MAIN;
    const effectivePreset =
      t.kind === 'countdownTo' ? (t.preset ?? effectiveCountdownPreset(baseLook)) : 'cornerCircle';
    return (
      <div className="prop-section">
        <div className="row wrap" style={{ alignItems: 'flex-start', gap: 12 }}>
          <div className="col grow" style={{ gap: 6, minWidth: 240 }}>
            <div className="prop-section-title">Timer Cue</div>
            <PropertyRow label="Kind">
              <Select
                value={t.kind}
                disabled={props.disabled}
                options={[
                  { value: 'countdownTo', label: 'Countdown to time of day' },
                  { value: 'elapsed', label: 'Elapsed (starts when live)' },
                ]}
                onChange={(k) =>
                  props.onChange({
                    ...it,
                    timer:
                      k === 'elapsed'
                        ? { kind: 'elapsed', label: t.label }
                        : { kind: 'countdownTo', timeOfDay: '10:00', label: t.label },
                  })
                }
              />
            </PropertyRow>
            {t.kind === 'countdownTo' && (
              <PropertyRow label="Target time" hint="Venue time zone">
                <input
                  type="time"
                  value={t.timeOfDay}
                  disabled={props.disabled}
                  style={{ width: 96 }}
                  onChange={(e) => props.onChange({ ...it, timer: { ...t, timeOfDay: e.target.value } })}
                />
              </PropertyRow>
            )}
            <PropertyRow label="Label">
              <TextField
                value={t.label ?? ''}
                placeholder="e.g. Service starts in"
                disabled={props.disabled}
                onChange={(label) => props.onChange({ ...it, timer: { ...t, label: label || undefined } })}
              />
            </PropertyRow>
            {t.kind === 'countdownTo' && (
              <>
                <PropertyRow label="Audience style">
                  <div className="row wrap" style={{ gap: 3 }}>
                    <button
                      type="button"
                      className={`small ${t.preset === undefined ? 'on' : ''}`}
                      disabled={props.disabled}
                      onClick={() => props.onChange({ ...it, timer: { ...t, preset: undefined } })}
                    >
                      Default
                    </button>
                    {COUNTDOWN_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`small ${t.preset === p.id ? 'on' : ''}`}
                        disabled={props.disabled}
                        onClick={() => props.onChange({ ...it, timer: { ...t, preset: p.id } })}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </PropertyRow>
                {effectivePreset !== 'centerHero' && (
                  <PropertyRow label="Corner">
                    <div className="row wrap" style={{ gap: 3 }}>
                      <button
                        type="button"
                        className={`small ${t.corner === undefined ? 'on' : ''}`}
                        disabled={props.disabled}
                        onClick={() => props.onChange({ ...it, timer: { ...t, corner: undefined } })}
                      >
                        Default
                      </button>
                      {COUNTDOWN_CORNERS.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className={`small ${t.corner === c.id ? 'on' : ''}`}
                          disabled={props.disabled}
                          onClick={() => props.onChange({ ...it, timer: { ...t, corner: c.id } })}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </PropertyRow>
                )}
              </>
            )}
            {shouldShowMidiUi(lib.settings.surfaces, Boolean(it.midi)) && (
              <PropertyRow label="Lighting / MIDI" hint="Fires once when this timer goes live." align="start">
                <MidiTriggerPicker
                  value={it.midi}
                  disabled={props.disabled}
                  onChange={(midi) => props.onChange({ ...it, midi })}
                />
              </PropertyRow>
            )}
          </div>
          {t.kind === 'countdownTo' && (
            <div className="col" style={{ gap: 4 }}>
              <span className="prop-section-title" style={{ margin: 0 }}>
                Preview
              </span>
              <TimerPreviewCanvas timer={t} baseLook={baseLook} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="prop-section">
      <div className="prop-section-title">Action Cue</div>
      <PropertyRow label="Action">
        <Select
          value={it.action}
          disabled={props.disabled}
          options={ACTIONS}
          onChange={(action: ActionId) => props.onChange({ ...it, action })}
        />
      </PropertyRow>
    </div>
  );
}
