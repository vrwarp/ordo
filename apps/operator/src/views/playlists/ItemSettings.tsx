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
import { Check, Field, NumberField, Select, TextField, TransitionEditor } from '../../components/fields.tsx';
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

    // Subtle welcome-slide frame so corner vs center placement is immediately clear.
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
        width: 320,
        maxWidth: '100%',
        aspectRatio: '16 / 9',
        borderRadius: 6,
        border: '1px solid var(--line)',
      }}
    />
  );
}

/** Settings for one playlist item, by kind. */
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
    if (!p) return <div className="banner red">This presentation no longer exists.</div>;
    const current =
      p.arrangements.find((a) => a.id === it.arrangementId) ?? p.arrangements[0] ?? authoringArrangement(p);
    return (
      <div className="col">
        <h3>{p.title}</h3>
        <Field label="Arrangement">
          <div className="row wrap">
            <select
              value={it.arrangementId ?? ''}
              disabled={props.disabled}
              onChange={(e) => {
                const { sections: _s, ...rest } = it;
                props.onChange({ ...rest, arrangementId: e.target.value || undefined });
              }}
            >
              <option value="">
                {p.arrangements[0] ? `${p.arrangements[0].name} (default)` : 'Authoring order'}
              </option>
              {p.arrangements.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
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
                Clear custom order
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
                  title="A new arrangement saved on the song"
                >
                  New for this service
                </button>
              </>
            )}
          </div>
          {it.sections && (
            <span className="muted small">
              Using a custom section order for this service ({it.sections.length} sections).
            </span>
          )}
        </Field>
        {editing && (
          <div className="card col">
            <TextField
              label="Arrangement name"
              value={editing.name}
              onChange={(name) => setEditing({ ...editing, name })}
            />
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
            <span className="muted small">
              Arrangements are stored on the presentation; editing a section changes every arrangement using
              it.
            </span>
          </div>
        )}
        <Field label="Transition for this item">
          <TransitionEditor
            value={it.transition}
            allowInherit
            onChange={(transition) => props.onChange({ ...it, transition })}
          />
        </Field>
        <Field label="Background override">
          <BackgroundPicker
            value={it.backgroundMediaId}
            onChange={(backgroundMediaId) => props.onChange({ ...it, backgroundMediaId })}
            disabled={props.disabled}
          />
        </Field>
        <Check
          label="Continue previous background (medley / multi-deck)"
          value={it.keepBackground ?? false}
          disabled={props.disabled}
          onChange={(keepBackground) =>
            props.onChange({ ...it, keepBackground: keepBackground || undefined })
          }
        />
        {(() => {
          const effBgId = it.backgroundMediaId ?? p.backgroundMediaId;
          const effBg = effBgId ? lib.media.find((m) => m.id === effBgId) : undefined;
          const bgBadge = effBg?.midi
            ? midiTriggerBadge(effBg.midi, lib.settings.surfaces.midiPresets)
            : null;
          const inner = countPresentationMidi(p);
          const hasAny = Boolean(it.midi || bgBadge || inner.sections > 0 || inner.slides > 0);
          if (!shouldShowMidiUi(lib.settings.surfaces, hasAny)) return null;
          return (
            <Field label="Lighting / MIDI on start">
              <div className="col" style={{ gap: 6 }}>
                {bgBadge && effBg && (
                  <div className="row wrap small" style={{ gap: 6, alignItems: 'center' }}>
                    <span className="muted">From background:</span>
                    <span
                      className="tag"
                      title={bgBadge.title}
                      style={{
                        borderLeft: bgBadge.color ? `3px solid ${bgBadge.color}` : undefined,
                      }}
                    >
                      💡 {bgBadge.label}
                    </span>
                    <span className="muted">({effBg.name})</span>
                  </div>
                )}
                <MidiTriggerPicker
                  value={it.midi}
                  disabled={props.disabled}
                  onChange={(midi) => props.onChange({ ...it, midi })}
                  hint="Fires once when entering this item (this service only)."
                />
                {(inner.sections > 0 || inner.slides > 0) && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    Also includes{' '}
                    {[
                      inner.sections > 0
                        ? `${inner.sections} section lighting cue${inner.sections === 1 ? '' : 's'}`
                        : '',
                      inner.slides > 0
                        ? `${inner.slides} slide MIDI cue${inner.slides === 1 ? '' : 's'}`
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' and ')}{' '}
                    inside this presentation.
                  </span>
                )}
              </div>
            </Field>
          );
        })()}
        {p.kind === 'loop' && (
          <div className="card col" style={{ gap: 8, marginTop: 4 }}>
            <strong style={{ fontSize: 13 }}>Pre-Service Loop Automation</strong>
            <span className="muted small">
              Starting this loop can automatically start background music and an audience countdown. Leaving
              this item automatically fades out the music and clears the countdown.
            </span>
            <label className="field">
              <span>Background music</span>
              <select
                value={it.audioMediaId ?? ''}
                disabled={props.disabled}
                onChange={(e) => props.onChange({ ...it, audioMediaId: e.target.value || undefined })}
              >
                <option value="">No background music</option>
                {lib.media
                  .filter((m) => m.kind === 'audio')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>Countdown timer</span>
              <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  type="time"
                  value={it.countdownTimer?.kind === 'countdownTo' ? it.countdownTimer.timeOfDay : ''}
                  disabled={props.disabled}
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
                      placeholder="Label (e.g. Service starts in)"
                      value={it.countdownTimer.label ?? ''}
                      disabled={props.disabled}
                      style={{ minWidth: 150, flex: '1 1 150px' }}
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
                    <select
                      aria-label="Countdown style"
                      value={it.countdownTimer.preset ?? ''}
                      disabled={props.disabled}
                      onChange={(e) =>
                        props.onChange({
                          ...it,
                          countdownTimer: {
                            ...it.countdownTimer!,
                            kind: 'countdownTo',
                            timeOfDay:
                              it.countdownTimer!.kind === 'countdownTo'
                                ? it.countdownTimer!.timeOfDay
                                : '10:00',
                            preset: (e.target.value || undefined) as CountdownPreset | undefined,
                          },
                        })
                      }
                    >
                      <option value="">Look default</option>
                      {COUNTDOWN_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    {it.countdownTimer.preset !== 'centerHero' && (
                      <select
                        aria-label="Countdown corner"
                        value={it.countdownTimer.corner ?? ''}
                        disabled={props.disabled}
                        onChange={(e) =>
                          props.onChange({
                            ...it,
                            countdownTimer: {
                              ...it.countdownTimer!,
                              kind: 'countdownTo',
                              timeOfDay:
                                it.countdownTimer!.kind === 'countdownTo'
                                  ? it.countdownTimer!.timeOfDay
                                  : '10:00',
                              corner: (e.target.value || undefined) as CountdownCorner | undefined,
                            },
                          })
                        }
                      >
                        <option value="">Look corner</option>
                        {COUNTDOWN_CORNERS.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
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
            </label>
          </div>
        )}
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
          <Check
            label="Loop"
            value={it.loop ?? m.loop}
            disabled={props.disabled}
            onChange={(loop) => props.onChange({ ...it, loop })}
          />
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
              options={[
                { value: '', label: 'Media default' },
                ...pairs.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={(pairId) =>
                props.onChange({ ...it, audio: { ...it.audio, pairId: pairId || undefined } })
              }
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
        {shouldShowMidiUi(lib.settings.surfaces, Boolean(it.midi)) && (
          <Field label="Lighting / MIDI on start">
            <MidiTriggerPicker
              value={it.midi}
              disabled={props.disabled}
              onChange={(midi) => props.onChange({ ...it, midi })}
              hint="Fires once when this media item goes live."
            />
          </Field>
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
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div className="col grow" style={{ gap: 10, minWidth: 280 }}>
          <h3 style={{ margin: 0 }}>Timer</h3>
          <div className="grid2">
            <Select
              label="Kind"
              value={t.kind}
              disabled={props.disabled}
              options={[
                { value: 'countdownTo', label: 'Countdown to a time of day' },
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
            {t.kind === 'countdownTo' ? (
              <Field label="Time (venue time zone)">
                <input
                  type="time"
                  value={t.timeOfDay}
                  disabled={props.disabled}
                  onChange={(e) => props.onChange({ ...it, timer: { ...t, timeOfDay: e.target.value } })}
                />
              </Field>
            ) : (
              <div />
            )}
          </div>
          <TextField
            label="Label"
            value={t.label ?? ''}
            placeholder="e.g. Service starts in, Baptism, Intermission"
            disabled={props.disabled}
            onChange={(label) => props.onChange({ ...it, timer: { ...t, label: label || undefined } })}
          />
          {t.kind === 'countdownTo' && (
            <>
              <Field label="Audience style">
                <div className="ed-seg-bar">
                  <button
                    type="button"
                    className={`small ${t.preset === undefined ? 'on' : ''}`}
                    disabled={props.disabled}
                    onClick={() => props.onChange({ ...it, timer: { ...t, preset: undefined } })}
                  >
                    Look default
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
              </Field>
              {effectivePreset !== 'centerHero' && (
                <Field label="Corner">
                  <div className="ed-seg-bar">
                    <button
                      type="button"
                      className={`small ${t.corner === undefined ? 'on' : ''}`}
                      disabled={props.disabled}
                      onClick={() => props.onChange({ ...it, timer: { ...t, corner: undefined } })}
                    >
                      Look default
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
                </Field>
              )}
            </>
          )}
          {shouldShowMidiUi(lib.settings.surfaces, Boolean(it.midi)) && (
            <Field label="Lighting / MIDI on start">
              <MidiTriggerPicker
                value={it.midi}
                disabled={props.disabled}
                onChange={(midi) => props.onChange({ ...it, midi })}
                hint="Fires once when this timer goes live."
              />
            </Field>
          )}
        </div>
        {t.kind === 'countdownTo' && (
          <div className="col" style={{ gap: 4 }}>
            <span className="muted small">Audience preview</span>
            <TimerPreviewCanvas timer={t} baseLook={baseLook} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="col">
      <h3>Action</h3>
      <Select
        label="Action"
        value={it.action}
        disabled={props.disabled}
        options={ACTIONS}
        onChange={(action: ActionId) => props.onChange({ ...it, action })}
      />
    </div>
  );
}
