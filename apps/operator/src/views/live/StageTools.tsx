import {
  formatDuration,
  formatStageNotesPlain,
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
import { Kbd, PropertyRow, SegmentedControl, Select } from '../../components/fields.tsx';
import { Icon } from '../../components/Icons.tsx';
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

/** Live & Next Speaker Notes view (rendered inside the Notes tab of StageTools or standalone). */
export function LiveSpeakerNotesCard() {
  const state = useLive((s) => s.state);
  const liveSlide = cueSlide(state, state.live);
  const nextSlide = cueSlide(state, state.armed);
  const liveNotes = liveSlide?.notes?.trim() ?? '';
  const nextNotes = nextSlide?.notes?.trim() ?? '';

  const parsedLines = liveNotes
    ? liveNotes.split('\n').map((line) => ({ line, parsed: parseStageNoteLine(line) }))
    : [];
  const hasCue = parsedLines.some(({ parsed }) => parsed.tokens.some((t) => t.kind === 'cue'));

  return (
    <div className="col" data-live-speaker-notes style={{ gap: 6 }}>
      <div className="prop-section-title" style={{ margin: 0 }}>
        <span>Current Slide Notes</span>
        {hasCue && <span className="tag notes">Has Cue</span>}
      </div>
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
    </div>
  );
}

type StageTab = 'msg' | 'timers' | 'overlays' | 'notes';

/**
 * Flush tabbed Stage Tools dock for Live's right rail (design/30 §5.1):
 * Stage Msg | Timers | Banner | Notes — fits cleanly below ProgramView with zero outer scroll.
 */
export function StageTools() {
  const now = useHubNow(500);
  const ctl = controller();
  const state = useLive((s) => s.state);
  const general = useLibrary((s) => s.data.settings.general);
  const presets = useLibrary((s) => s.data.settings.surfaces.messagePresets);
  const { recentMessages, messageTtlMs } = useUi();
  const [tab, setTab] = useState<StageTab>('msg');
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
  const anyTimerRunning = Boolean(countdown?.running || elapsed?.running || others.some((t) => t.running));
  const anyOverlayActive = Boolean(state.layers.lowerThird.content || state.props.logo);
  const liveSlide = cueSlide(state, state.live);
  const hasNotes = Boolean(liveSlide?.notes?.trim());

  return (
    <div className="stage-dock">
      <div className="stage-dock-tabs">
        <SegmentedControl<StageTab>
          size="xs"
          ariaLabel="Stage tools"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'msg', label: 'Stage Msg', badge: active.length > 0 },
            { value: 'timers', label: 'Timers', badge: anyTimerRunning },
            { value: 'overlays', label: 'Banner', badge: anyOverlayActive },
            { value: 'notes', label: 'Notes', badge: hasNotes },
          ]}
        />
      </div>

      <div className="stage-dock-body">
        {tab === 'msg' && (
          <>
            <form
              className="row"
              style={{ gap: 5 }}
              onSubmit={(e) => {
                e.preventDefault();
                send(text);
              }}
            >
              <input
                className="grow"
                placeholder="Message to the platform…"
                maxLength={500}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <button type="submit" className="primary small" disabled={!text.trim()}>
                Send
              </button>
            </form>
            <PropertyRow label="Duration">
              <Select
                value={String(messageTtlMs)}
                options={TTLS}
                onChange={(v) => setUi({ messageTtlMs: Number(v) })}
              />
            </PropertyRow>
            {active.map((m) => (
              <div
                key={m.id}
                className="row"
                style={{
                  padding: '5px 8px',
                  borderRadius: 3,
                  background: 'var(--bg3)',
                  border: '1px solid var(--line-strong)',
                  alignItems: 'center',
                }}
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
                {m.expiresAt && <span className="muted mono small">{formatDuration(m.expiresAt - now)}</span>}
                <button
                  type="button"
                  className="ghost icon-btn"
                  onClick={() => ctl?.dismissMessage(m.id)}
                  title="Dismiss"
                  aria-label="Dismiss"
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
            {(recentMessages.length > 0 || presets.length > 0) && (
              <div className="col" style={{ gap: 4 }}>
                <span className="prop-section-title" style={{ margin: 0 }}>
                  Quick Presets
                </span>
                <div className="row wrap" style={{ gap: 4 }}>
                  {[...new Set([...recentMessages, ...presets])].slice(0, 10).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className="small"
                      onClick={() => send(m)}
                      title="Send now"
                      onContextMenu={(e) => {
                        openContextMenu(
                          e,
                          [
                            { label: 'Send now', onSelect: () => send(m) },
                            { label: 'Edit before sending', onSelect: () => setText(m) },
                            { kind: 'separator' },
                            { label: 'Copy text', onSelect: () => void navigator.clipboard?.writeText?.(m) },
                            {
                              label: 'Manage message presets…',
                              onSelect: () => navigate('#/settings/messages'),
                            },
                          ],
                          { ariaLabel: 'Message preset actions' },
                        );
                      }}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'timers' && (
          <>
            <div className="prop-section-title" style={{ margin: 0 }}>
              <span>Elapsed Sermon / Set</span>
              <b className="mono" style={{ color: 'var(--fg)', fontSize: 13 }}>
                {elapsed ? timerText(elapsed, now, general.timeZone) : '00:00'}
              </b>
            </div>
            <div className="row" style={{ gap: 6 }}>
              {elapsed?.running ? (
                <button
                  type="button"
                  className="small"
                  onClick={() => ctl?.timerStop(MANUAL_ELAPSED_TIMER_ID)}
                >
                  <Icon name="pause" size={11} /> Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="primary small"
                  onClick={() =>
                    ctl?.timerStart(MANUAL_ELAPSED_TIMER_ID, { kind: 'elapsed', label: 'Elapsed' })
                  }
                >
                  <Icon name="play" size={11} /> Start
                </button>
              )}
              <button
                type="button"
                className="small"
                onClick={() => ctl?.timerReset(MANUAL_ELAPSED_TIMER_ID)}
              >
                <Icon name="restart" size={11} /> Reset
              </button>
            </div>

            <div
              className="col"
              style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 8, marginTop: 2 }}
            >
              <div className="prop-section-title" style={{ margin: 0 }}>
                <span>Service Countdown</span>
                <b className="mono" style={{ color: 'var(--fg)', fontSize: 13 }}>
                  {countdown ? timerText(countdown, now, general.timeZone) : '--:--'}
                </b>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <input
                  type="time"
                  value={countTo}
                  onChange={(e) => setCountTo(e.target.value)}
                  style={{ width: 96 }}
                />
                <button
                  type="button"
                  className="primary small"
                  onClick={() =>
                    ctl?.timerStart(SERVICE_COUNTDOWN_TIMER_ID, {
                      kind: 'countdownTo',
                      timeOfDay: countTo,
                      label: 'Service starts in',
                    })
                  }
                >
                  Start
                </button>
                <button
                  type="button"
                  className="small"
                  disabled={!countdown?.running}
                  onClick={() => ctl?.timerStop(SERVICE_COUNTDOWN_TIMER_ID)}
                >
                  Stop
                </button>
              </div>
            </div>

            {others.length > 0 && (
              <div className="col" style={{ gap: 5, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                <span className="prop-section-title" style={{ margin: 0 }}>
                  Playlist Timers
                </span>
                {others.map((t) => (
                  <div key={t.id} className="row" style={{ gap: 6 }}>
                    <span className="grow ellipsis small">
                      {t.spec.label ??
                        (t.spec.kind === 'elapsed' ? 'Elapsed' : `Countdown ${t.spec.timeOfDay}`)}
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
            )}
          </>
        )}

        {tab === 'overlays' && (
          <>
            <span className="prop-section-title" style={{ margin: 0 }}>
              Lower-Third Banner
            </span>
            <form
              className="row"
              style={{ gap: 5 }}
              onSubmit={(e) => {
                e.preventDefault();
                ctl?.lowerThird(lower);
              }}
            >
              <input
                className="grow"
                placeholder="Name or title banner…"
                value={lower}
                onChange={(e) => setLower(e.target.value)}
              />
              <button type="submit" className="primary small" disabled={!lower.trim()}>
                Show
              </button>
            </form>
            {state.layers.lowerThird.content && (
              <div
                className="row"
                style={{
                  padding: '5px 8px',
                  borderRadius: 3,
                  background: '#10261a',
                  border: '1px solid #16a34a',
                  alignItems: 'center',
                }}
              >
                <span className="small ellipsis grow">{state.layers.lowerThird.content.text}</span>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => ctl?.dispatch({ id: 'clearLowerThird' })}
                >
                  Clear <Kbd>F3</Kbd>
                </button>
              </div>
            )}
            <div
              className="row"
              style={{
                justifyContent: 'space-between',
                borderTop: '1px solid var(--line)',
                paddingTop: 8,
                marginTop: 2,
              }}
            >
              <span className="small">Church Logo Slate</span>
              <button
                type="button"
                className={state.props.logo ? 'on small' : 'small'}
                onClick={() => ctl?.dispatch({ id: 'logo' })}
                title="Toggle Logo (F5)"
              >
                Logo {state.props.logo ? 'ON' : 'OFF'} <Kbd>F5</Kbd>
              </button>
            </div>
          </>
        )}

        {tab === 'notes' && <LiveSpeakerNotesCard />}
      </div>
    </div>
  );
}
