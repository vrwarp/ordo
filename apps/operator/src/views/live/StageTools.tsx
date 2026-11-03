import { formatDuration, MANUAL_ELAPSED_TIMER_ID, nextTimeOfDay, SERVICE_COUNTDOWN_TIMER_ID, type Timer } from '@ordo/domain';
import { useState } from 'react';
import { Select } from '../../components/fields.tsx';
import { useHubNow } from '../../hooks.ts';
import { controller } from '../../services/controller.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { setUi, useUi } from '../../state/ui.ts';

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
    <div className="stage-tools">
      <h4 style={{ margin: 0 }}>Stage message</h4>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <input className="grow" placeholder="Message to the stage screen" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="primary" disabled={!text.trim()}>
          Send
        </button>
      </form>
      <div className="row">
        <span className="muted small">Show</span>
        <Select value={String(messageTtlMs)} options={TTLS} onChange={(v) => setUi({ messageTtlMs: Number(v) })} />
      </div>
      {active.map((m) => (
        <div key={m.id} className="row card" style={{ padding: 8 }}>
          <span className="grow">{m.text}</span>
          {m.expiresAt && <span className="muted small">{formatDuration(m.expiresAt - now)}</span>}
          <button type="button" className="small" onClick={() => ctl?.dismissMessage(m.id)}>
            Dismiss
          </button>
        </div>
      ))}
      {(recentMessages.length > 0 || presets.length > 0) && (
        <div className="row wrap" style={{ gap: 6 }}>
          {[...new Set([...recentMessages, ...presets])].slice(0, 10).map((m) => (
            <button key={m} type="button" className="small" onClick={() => send(m)} title="Send again">
              {m}
            </button>
          ))}
        </div>
      )}

      <h4 style={{ margin: '8px 0 0' }}>Timers</h4>
      <div className="row">
        <span className="grow">
          Countdown to{' '}
          <input type="time" value={countTo} onChange={(e) => setCountTo(e.target.value)} style={{ width: 110 }} />
        </span>
        <b className="mono">{countdown ? timerText(countdown, now, general.timeZone) : '--:--'}</b>
      </div>
      <div className="row">
        <button
          type="button"
          className="small"
          onClick={() =>
            ctl?.timerStart(SERVICE_COUNTDOWN_TIMER_ID, { kind: 'countdownTo', timeOfDay: countTo, label: 'Service starts in' })
          }
        >
          Start countdown
        </button>
        <button type="button" className="small" disabled={!countdown?.running} onClick={() => ctl?.timerStop(SERVICE_COUNTDOWN_TIMER_ID)}>
          Stop
        </button>
      </div>
      <div className="row">
        <span className="grow">Elapsed</span>
        <b className="mono">{elapsed ? timerText(elapsed, now, general.timeZone) : '00:00'}</b>
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
        <div key={t.id} className="row">
          <span className="grow ellipsis">{t.spec.label ?? (t.spec.kind === 'elapsed' ? 'Elapsed' : `Countdown ${t.spec.timeOfDay}`)}</span>
          <b className="mono">{timerText(t, now, general.timeZone)}</b>
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

      <h4 style={{ margin: '8px 0 0' }}>Lower third</h4>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          ctl?.lowerThird(lower);
        }}
      >
        <input className="grow" placeholder="Name, title or announcement" value={lower} onChange={(e) => setLower(e.target.value)} />
        <button type="submit" disabled={!lower.trim()}>
          Show
        </button>
      </form>
      <div className="row">
        <button type="button" className={state.props.logo ? 'on' : ''} onClick={() => ctl?.dispatch({ id: 'logo' })} title="F5">
          Logo {state.props.logo ? 'on' : 'off'}
        </button>
      </div>
    </div>
  );
}
