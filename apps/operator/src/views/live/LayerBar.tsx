import { formatDuration, type LiveState } from '@ordo/domain';
import type { OutputHealthEntry } from '@ordo/protocol';
import { useHubNow } from '../../hooks.ts';
import { controller, dispatch, MUTE_DB } from '../../services/controller.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import type { OperatorPlaylist } from './useOperatorPlaylist.ts';

function Chip(props: { label: string; value?: string; on: boolean; onClear: () => void; keyHint?: string }) {
  return (
    <div className={`chip ${props.on ? 'on' : ''}`}>
      <span className="lbl">{props.label}</span>
      <span className="val ellipsis">{props.value ?? '—'}</span>
      <button
        type="button"
        className="small"
        disabled={!props.on}
        onClick={props.onClear}
        title={props.keyHint}
      >
        Clear {props.keyHint ? <span className="muted">{props.keyHint}</span> : null}
      </button>
    </div>
  );
}

function masterHealth(
  h: Record<string, OutputHealthEntry>,
  masterId?: string,
): OutputHealthEntry | undefined {
  if (masterId && h[masterId]) return h[masterId];
  return Object.values(h).find((x) => x.meters?.length || x.mediaDurationMs !== undefined);
}

/** Media position and remaining time: from the audio master's health when it reports, else from state. */
export function mediaTimes(
  s: LiveState,
  now: number,
  durationMs: number | undefined,
  h?: OutputHealthEntry,
): { pos: number; dur?: number } | null {
  const m = s.layers.media.content ?? s.audio.content;
  if (!m) return null;
  if (h?.mediaPositionMs !== undefined && h.mediaDurationMs)
    return { pos: h.mediaPositionMs, dur: h.mediaDurationMs };
  const pos = m.state === 'playing' ? now - m.startedAt : m.positionMs;
  return { pos: Math.max(0, pos), dur: durationMs };
}

export function LayerBar({ op }: { op: OperatorPlaylist }) {
  const now = useHubNow(250);
  const s = useLive((x) => x.state);
  const health = useLive((x) => x.health);
  const clearUntil = useLive((x) => x.clearAllUntil);
  const audio = useLibrary((x) => x.data.settings.audio);
  const outputs = useLibrary((x) => x.data.settings.outputs);
  const ctl = controller();
  const L = s.layers;
  const slideCue = L.slide.content ? s.cues[L.slide.content.cueIndex] : undefined;
  const bgName = L.background.content ? op.media(L.background.content.mediaId)?.name : undefined;
  const mediaC = L.media.content;
  const audioC = s.audio.content;
  const mediaRec = mediaC ? op.media(mediaC.mediaId) : audioC ? op.media(audioC.mediaId) : undefined;
  const master = masterHealth(health, outputs.find((o) => o.audioMaster)?.id);
  const t = mediaTimes(s, now, mediaRec?.durationMs, master);
  const playing = mediaC?.state === 'playing' || (!mediaC && audioC?.state === 'playing');
  const muted = audio.masterDb <= MUTE_DB + 1;
  const props: string[] = [];
  if (s.props.logo) props.push('Logo');
  if (s.props.countdownTimerId) props.push('Countdown');
  const pending = clearUntil !== undefined && clearUntil > Date.now();
  return (
    <div className="layerbar">
      <Chip
        label="Background"
        value={bgName}
        on={!!L.background.content}
        onClear={() => ctl?.clear('background')}
      />
      <Chip
        label="Slide"
        value={slideCue?.label}
        on={!!L.slide.content}
        onClear={() => dispatch({ id: 'clearSlide' })}
        keyHint="F1"
      />
      <Chip
        label="Lower third"
        value={L.lowerThird.content?.text}
        on={!!L.lowerThird.content}
        onClear={() => dispatch({ id: 'clearLowerThird' })}
        keyHint="F3"
      />
      <Chip
        label={audioC && !mediaC ? 'Audio' : 'Media'}
        value={
          mediaRec
            ? `${mediaRec.name}${(mediaC ?? audioC)?.state === 'paused' ? ' (paused)' : (mediaC ?? audioC)?.state === 'ended' ? ' (ended)' : ''}`
            : undefined
        }
        on={!!mediaC || !!audioC}
        onClear={() => (mediaC ? ctl?.clear('media') : ctl?.clear('audio'))}
      />
      <Chip
        label="Props"
        value={props.join(', ') || undefined}
        on={props.length > 0}
        onClear={() => dispatch({ id: 'clearProps' })}
        keyHint="F4"
      />
      <div className="col" style={{ justifyContent: 'center', gap: 4 }}>
        <div className="row" style={{ gap: 4 }}>
          <button
            type="button"
            disabled={!mediaC && !audioC}
            onClick={() => dispatch({ id: 'mediaPlayPause' })}
            title="F8"
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <button
            type="button"
            disabled={!mediaC && !audioC}
            onClick={() => dispatch({ id: 'mediaRestart' })}
            title="Shift+F8"
          >
            ⟲
          </button>
          {audioC && (
            <button type="button" className="small" onClick={() => ctl?.clear('audio')}>
              Stop audio
            </button>
          )}
        </div>
        <span className="mono small" title="Elapsed / remaining">
          {t ? `${formatDuration(t.pos)}${t.dur ? ` / -${formatDuration(t.dur - t.pos)}` : ''}` : '--:--'}
        </span>
      </div>
      <span className="spacer" />
      <div className="row" style={{ gap: 6 }}>
        <div className="row" style={{ gap: 3 }} title="Audio meters from the audio master output">
          {(master?.meters?.length ? master.meters : [0, 0]).map((v, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional list
            <div key={i} className="meter">
              <i style={{ height: `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="col" style={{ gap: 4 }}>
          <span className="small">
            Master {muted ? <b style={{ color: 'var(--red)' }}>MUTED</b> : `${audio.masterDb.toFixed(0)} dB`}
            {master?.audio === 'lost' && (
              <span className="tag red" style={{ marginLeft: 6 }}>
                device lost
              </span>
            )}
          </span>
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className="small" onClick={() => dispatch({ id: 'audioMasterDown' })}>
              −
            </button>
            <button type="button" className="small" onClick={() => dispatch({ id: 'audioMasterUp' })}>
              +
            </button>
            <button
              type="button"
              className={`small ${muted ? 'danger' : ''}`}
              onClick={() => dispatch({ id: 'audioMute' })}
            >
              {muted ? 'Unmute' : 'Mute'}
            </button>
          </div>
        </div>
      </div>
      <button
        type="button"
        className={`big danger clear-all ${pending ? 'pending' : ''}`}
        style={{ minWidth: 150, alignSelf: 'center', minHeight: 56 }}
        onClick={() => dispatch({ id: 'clearAll' })}
        title="F2 twice within 2 seconds"
      >
        {pending ? 'Press again to clear' : s.black ? 'All cleared' : 'Clear all (F2 ×2)'}
      </button>
    </div>
  );
}
