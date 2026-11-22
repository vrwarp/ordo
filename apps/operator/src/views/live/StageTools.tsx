import {
  formatDuration,
  formatStageNotesPlain,
  isHiddenCue,
  type LiveState,
  MANUAL_ELAPSED_TIMER_ID,
  nextTimeOfDay,
  parseStageNoteLine,
  SERVICE_COUNTDOWN_TIMER_ID,
  type Slide,
  type Timer,
} from '@ordo/domain';
import { Fragment, useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { Select } from '../../components/fields.tsx';
import { useHubNow } from '../../hooks.ts';
import { navigate } from '../../useRoute.ts';
import { controller } from '../../services/controller.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { setUi, useUi } from '../../state/ui.ts';

function cueSlide(state: LiveState, cueIndex: number | undefined): Slide | undefined {
  if (cueIndex === undefined) return undefined;
  const cue = state.cues[cueIndex];
  if (!cue?.presentationId || !cue.slideId) return undefined;
  const p = state.resolved?.presentations[cue.presentationId];
  if (!p) return undefined;
  for (const sec of p.sections) {
    for (const sl of sec.slides) {
      if (sl.id === cue.slideId) return sl;
    }
  }
  return undefined;
}

function nextVisibleCueIndex(state: LiveState): number | undefined {
  if (state.live === undefined) return undefined;
  for (let i = state.live + 1; i < state.cues.length; i++) {
    const c = state.cues[i];
    if (c && !isHiddenCue(c)) return i;
  }
  return undefined;
}

const TTLS = [
  { value: '0', label: 'Until dismissed' },
  { value: '30000', label: '30 s' },
  { value: '60000', label: '1 min' },
  { value: '300000', label: '5 min' },
];

export function timerText(t: Timer, now: number, timeZone: string): string {
  if (t.spec.kind === 'countdownTo') {
    if (!t.running) return '--:--';
    return formatDuration(nextTimeOfDay(t.spec.timeOfDay, timeZone, now) - now);
  }
  if (t.running && t.startedAt !== undefined) return formatDuration(now - t.startedAt);
  return formatDuration(t.elapsedMs ?? 0);
}

/** Live & Next Speaker Notes card for the booth operator's right rail. */
export function LiveSpeakerNotesCard() {
  const state = useLive((s) => s.state);
  const [collapsed, setCollapsed] = useState(false);
  const liveSlide = cueSlide(state, state.live);
  const nextIdx = nextVisibleCueIndex(state);
  const nextSlide = cueSlide(state, nextIdx);
  const liveNotes = liveSlide?.notes?.trim() ?? '';
  const nextNotes = nextSlide?.notes?.trim() ?? '';
  if (!liveNotes && !nextNotes) return null;

  const parsedLines = liveNotes
    ? liveNotes.split('\n').map((line) => ({ line, parsed: parseStageNoteLine(line) }))
    : [];
  const hasCue = parsedLines.some(({ parsed }) => parsed.tokens.some((t) => t.kind === 'cue'));

  return (
    <div
      className="card col live-notes-card"
      data-live-speaker-notes
      style={{ padding: 10, gap: 6, margin: '8px 8px 2px' }}
    >
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <button
          type="button"
          className="small ghost"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          style={{ padding: '1px 4px', marginLeft: -4, fontWeight: 700, fontSize: 12 }}
          title={collapsed ? 'Expand current slide notes' : 'Collapse current slide notes'}
        >
          {collapsed ? '▸' : '▾'} Current Slide Notes
        </button>
        {hasCue && (
          <span className="tag notes" style={{ fontSize: 10 }}>
            Has Cue
          </span>
        )}
      </div>
      {!collapsed && (
        <>
          {liveNotes ? (
            <div className="live-notes-body" dir="auto">
              {(() => {
                let linePos = 0;
                return parsedLines.map(({ line, parsed }) => {
                  const key = `ln-${linePos}`;
                  linePos += line.length + 1;
                  if (!line.trim()) return <div key={key} style={{ height: 4 }} />;
                  let tokPos = 0;
                  return (
                    <div key={key} className={parsed.bullet ? 'live-note-line bullet' : 'live-note-line'}>
                      {parsed.bullet && <span className="live-note-bullet">•</span>}
                      <span>
                        {parsed.tokens.map((r) => {
                          const tokKey = `tk-${tokPos}`;
                          tokPos += r.text.length + 1;
                          if (r.kind === 'highlight') {
                            return (
                              <mark key={tokKey} className="live-note-hl">
                                {r.text}
                              </mark>
                            );
                          }
                          if (r.kind === 'cue') {
                            return (
                              <span key={tokKey} className="live-note-cue">
                                {r.text}
                              </span>
                            );
                          }
                          return <Fragment key={tokKey}>{r.text}</Fragment>;
                        })}
                      </span>
                    </div>
                  );
                });
              })()}
            </div>
          ) : (
            <div className="muted small">No speaker notes on current live slide.</div>
          )}
          {nextNotes && (
            <div className="live-notes-next" dir="auto">
              <span className="live-notes-next-lbl">UP NEXT:</span>{' '}
              <span>{formatStageNotesPlain(nextNotes).replace(/\s+/g, ' ').slice(0, 140)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Messages, recent and preset messages, timers, lower third and logo (prd/02 Stage tools). */
export function StageTools() {
  const now = useHubNow(500);
  const ctl = controller();
  const state = useLive((s) => s.state);
  const general = useLibrary((s) => s.data.settings.general);
  const presets = useLibrary((s) => s.data.settings.surfaces.messagePresets);
  const { recentMessages, messageTtlMs } = useUi();
  const [text, setText] = useState('');
  const [countTo, setCountTo] = useState('10:00');
  const [lower, setLower] = useState('');
  const send = (t: string) => {
    ctl?.sendMessage(t, messageTtlMs || undefined);
    setText('');
  };
  const active = state.messages.filter((m) => !m.expiresAt || m.expiresAt > now);
  const countdown = state.timers[SERVICE_COUNTDOWN_TIMER_ID];
  const elapsed = state.timers[MANUAL_ELAPSED_TIMER_ID];
  const others = Object.values(state.timers).filter(
    (t) => t.id !== SERVICE_COUNTDOWN_TIMER_ID && t.id !== MANUAL_ELAPSED_TIMER_ID,
  );

  return (
    <div className="stage-tools col" style={{ gap: 10 }}>
      {/* 1. BACKSTAGE (Stage Screen Only) */}
      <div className="card col" style={{ padding: 10, gap: 8, background: 'var(--bg2)' }}>
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <h4 style={{ margin: 0 }}>Stage Message</h4>
          <span className="tag" style={{ fontSize: 10 }}>
            Stage Screen Only
          </span>
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <input
            className="grow"
            placeholder="Message to the platform"
            maxLength={500}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="primary small" disabled={!text.trim()}>
            Send
          </button>
        </form>
        <div className="row" style={{ alignItems: 'center' }}>
          <span className="muted small">Duration</span>
          <Select
            value={String(messageTtlMs)}
            options={TTLS}
            onChange={(v) => setUi({ messageTtlMs: Number(v) })}
          />
        </div>
        {active.map((m) => (
          <div
            key={m.id}
            className="row card"
            style={{ padding: 6, alignItems: 'center' }}
            onContextMenu={(e) => {
              openContextMenu(
                e,
                [
                  { label: 'Dismiss message', onSelect: () => ctl?.dismissMessage(m.id) },
                  { label: 'Re-send with current duration', onSelect: () => send(m.text) },
                  { kind: 'separator' },
                  {
                    label: 'Copy message text',
                    onSelect: () => void navigator.clipboard?.writeText?.(m.text),
                  },
                ],
                { ariaLabel: 'Active stage message actions' },
              );
            }}
          >
            <span className="grow small">{m.text}</span>
            {m.expiresAt && <span className="muted small">{formatDuration(m.expiresAt - now)}</span>}
            <button type="button" className="small ghost" onClick={() => ctl?.dismissMessage(m.id)}>
              Dismiss
            </button>
          </div>
        ))}
        {(recentMessages.length > 0 || presets.length > 0) && (
          <div className="row wrap" style={{ gap: 4 }}>
            {[...new Set([...recentMessages, ...presets])].slice(0, 10).map((m) => (
              <button
                key={m}
                type="button"
                className="small"
                onClick={() => send(m)}
                title="Send again"
                onContextMenu={(e) => {
                  openContextMenu(
                    e,
                    [
                      { label: 'Send now', onSelect: () => send(m) },
                      { label: 'Edit before sending', onSelect: () => setText(m) },
                      { kind: 'separator' },
                      { label: 'Copy text', onSelect: () => void navigator.clipboard?.writeText?.(m) },
                      { label: 'Manage message presets…', onSelect: () => navigate('#/settings/messages') },
                    ],
                    { ariaLabel: 'Message preset actions' },
                  );
                }}
              >
                {m}
              </button>
            ))}
          </div>
        )}

        <h4 style={{ margin: '6px 0 0' }}>Elapsed Sermon / Set Timer</h4>
        <div
          className="row"
          onContextMenu={(e) => {
            openContextMenu(
              e,
              [
                elapsed?.running
                  ? { label: 'Stop elapsed timer', onSelect: () => ctl?.timerStop(MANUAL_ELAPSED_TIMER_ID) }
                  : {
                      label: 'Start elapsed timer',
                      onSelect: () =>
                        ctl?.timerStart(MANUAL_ELAPSED_TIMER_ID, { kind: 'elapsed', label: 'Elapsed' }),
                    },
                { label: 'Reset elapsed timer', onSelect: () => ctl?.timerReset(MANUAL_ELAPSED_TIMER_ID) },
              ],
              { ariaLabel: 'Elapsed timer actions' },
            );
          }}
        >
          <span className="grow small">Elapsed</span>
          <b className="mono small">{elapsed ? timerText(elapsed, now, general.timeZone) : '00:00'}</b>
        </div>
        <div className="row">
          {elapsed?.running ? (
            <button type="button" className="small" onClick={() => ctl?.timerStop(MANUAL_ELAPSED_TIMER_ID)}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="small"
              onClick={() => ctl?.timerStart(MANUAL_ELAPSED_TIMER_ID, { kind: 'elapsed', label: 'Elapsed' })}
            >
              Start
            </button>
          )}
          <button type="button" className="small" onClick={() => ctl?.timerReset(MANUAL_ELAPSED_TIMER_ID)}>
            Reset
          </button>
        </div>
        {others.map((t) => (
          <div
            key={t.id}
            className="row"
            onContextMenu={(e) => {
              openContextMenu(
                e,
                [
                  t.running
                    ? { label: 'Stop timer', onSelect: () => ctl?.timerStop(t.id) }
                    : { label: 'Start timer', onSelect: () => ctl?.timerStart(t.id, t.spec) },
                  { label: 'Reset timer', onSelect: () => ctl?.timerReset(t.id) },
                ],
                { ariaLabel: 'Timer actions' },
              );
            }}
          >
            <span className="grow ellipsis small">
              {t.spec.label ?? (t.spec.kind === 'elapsed' ? 'Elapsed' : `Countdown ${t.spec.timeOfDay}`)}
            </span>
            <b className="mono small">{timerText(t, now, general.timeZone)}</b>
            {t.running ? (
              <button type="button" className="small" onClick={() => ctl?.timerStop(t.id)}>
                Stop
              </button>
            ) : (
              <button type="button" className="small" onClick={() => ctl?.timerStart(t.id, t.spec)}>
                Start
              </button>
            )}
          </div>
        ))}
      </div>

      {/* 2. ON-AIR OVERLAYS (Audience & Stream) */}
      <div className="card col" style={{ padding: 10, gap: 8, background: 'var(--bg2)' }}>
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <h4 style={{ margin: 0 }}>On-Air Overlays</h4>
          <span className="tag blue" style={{ fontSize: 10 }}>
            Audience &amp; Stream
          </span>
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            ctl?.lowerThird(lower);
          }}
        >
          <input
            className="grow"
            placeholder="Name or title banner"
            value={lower}
            onChange={(e) => setLower(e.target.value)}
          />
          <button type="submit" className="small" disabled={!lower.trim()}>
            Show
          </button>
        </form>
        {state.layers.lowerThird.content && (
          <div
            className="row card"
            style={{ padding: 6, alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span className="small ellipsis">
              <b>Active banner:</b> {state.layers.lowerThird.content.text}
            </span>
            <button
              type="button"
              className="small ghost"
              onClick={() => ctl?.dispatch({ id: 'clearLowerThird' })}
            >
              Clear
            </button>
          </div>
        )}
        <div className="col" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="small">
              Countdown to{' '}
              <input
                type="time"
                value={countTo}
                onChange={(e) => setCountTo(e.target.value)}
                style={{ width: 100 }}
              />
            </span>
            <b className="mono small">{countdown ? timerText(countdown, now, general.timeZone) : '--:--'}</b>
          </div>
          <div className="row" style={{ alignItems: 'center' }}>
            <button
              type="button"
              className="small"
              onClick={() =>
                ctl?.timerStart(SERVICE_COUNTDOWN_TIMER_ID, {
                  kind: 'countdownTo',
                  timeOfDay: countTo,
                  label: 'Service starts in',
                })
              }
            >
              Start countdown
            </button>
            <button
              type="button"
              className="small"
              disabled={!countdown?.running}
              onClick={() => ctl?.timerStop(SERVICE_COUNTDOWN_TIMER_ID)}
            >
              Stop
            </button>
            <span className="muted small" style={{ fontSize: 11 }}>
              Audience &amp; Stage
            </span>
          </div>
        </div>
        <div
          className="row"
          style={{
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '1px solid var(--line)',
            paddingTop: 8,
          }}
        >
          <span className="small">Church Logo Slate</span>
          <button
            type="button"
            className={state.props.logo ? 'on small' : 'small'}
            onClick={() => ctl?.dispatch({ id: 'logo' })}
            title="F5"
          >
            Logo {state.props.logo ? 'ON' : 'OFF'} (F5)
          </button>
        </div>
      </div>
    </div>
  );
}
