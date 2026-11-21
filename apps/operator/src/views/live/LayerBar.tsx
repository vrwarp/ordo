import { formatDuration } from '@ordo/domain';
import { mediaPlayTarget, pendingSlideSound } from '@ordo/live-state';
import type { OutputHealthEntry } from '@ordo/protocol';
import { useMemo } from 'react';
import { type ContextMenuEntry, openContextMenu } from '../../components/ContextMenu.tsx';
import { Menu } from '../../components/Menu.tsx';
import { useHubNow } from '../../hooks.ts';
import { HoldGuard } from '../../lib/confirm.ts';
import { mediaTimes } from '../../lib/mediaTimes.ts';
import { controller, dispatch, MUTE_DB } from '../../services/controller.ts';
import { CLEAR_HOLD_MS, useSurfaces } from '../../services/surfaces.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import type { OperatorPlaylist } from './useOperatorPlaylist.ts';

function Chip(props: {
  label: string;
  value?: string;
  on: boolean;
  onClear: () => void;
  keyHint?: string;
  extraMenu?: ContextMenuEntry[];
}) {
  return (
    <div
      className={`chip ${props.on ? 'on' : ''}`}
      onContextMenu={(e) => {
        openContextMenu(
          e,
          [
            ...(props.extraMenu ?? []),
            ...(props.extraMenu?.length ? [{ kind: 'separator' as const }] : []),
            {
              label: `Clear ${props.label.toLowerCase()}`,
              shortcut: props.keyHint,
              disabled: !props.on,
              onSelect: props.onClear,
            },
          ],
          { ariaLabel: `${props.label} layer actions` },
        );
      }}
    >
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

export function LayerBar({ op }: { op: OperatorPlaylist }) {
  const now = useHubNow(250);
  const s = useLive((x) => x.state);
  const health = useLive((x) => x.health);
  const clearUntil = useLive((x) => x.clearAllUntil);
  const audio = useLibrary((x) => x.data.settings.audio);
  const outputs = useLibrary((x) => x.data.settings.outputs);
  const midiPresets = useLibrary((x) => x.data.settings.surfaces.midiPresets ?? []);
  const midiReady = useSurfaces((x) => x.midiReady);
  const ctl = controller();
  const L = s.layers;
  const slideCue = L.slide.content ? s.cues[L.slide.content.cueIndex] : undefined;
  const bgName = L.background.content ? op.media(L.background.content.mediaId)?.name : undefined;
  const mediaC = L.media.content;
  const audioC = s.audio.content;
  const mediaRec = mediaC ? op.media(mediaC.mediaId) : audioC ? op.media(audioC.mediaId) : undefined;
  const master = masterHealth(health, outputs.find((o) => o.audioMaster)?.id);
  const t = mediaTimes(s, now, mediaRec?.durationMs, master);
  // F8's target (design/27 §8): a slide's click-start sound waits for it, before a playing video.
  const target = mediaPlayTarget(s);
  const waiting = target === 'slideSound' ? pendingSlideSound(s) : undefined;
  const waitingName = waiting ? (op.media(waiting.sound.mediaId)?.name ?? 'slide sound') : undefined;
  const playing =
    target === 'video' ? mediaC?.state === 'playing' : target === 'audio' && audioC?.state === 'playing';
  const muted = audio.masterDb <= MUTE_DB + 1;
  const props: string[] = [];
  if (s.props.logo) props.push('Logo');
  if (s.props.countdownTimerId) props.push('Countdown');
  const pending = clearUntil !== undefined && clearUntil > Date.now();
  // Clear all (prd/02): press twice within 2 s, or hold for 1 s. The press arms the confirm; the hold
  // sends the confirming press itself.
  const hold = useMemo(() => new HoldGuard(CLEAR_HOLD_MS), []);
  const clearDown = () => {
    dispatch({ id: 'clearAll' });
    hold.down(() => {
      if (useLive.getState().clearAllUntil !== undefined) dispatch({ id: 'clearAll' });
    });
  };
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
        keyHint="Esc / F1"
      />
      <Chip
        label="Banner"
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
        extraMenu={[
          {
            label: playing ? 'Pause' : 'Play',
            shortcut: 'F8',
            disabled: !target,
            onSelect: () => dispatch({ id: 'mediaPlayPause' }),
          },
          {
            label: 'Restart from beginning',
            shortcut: 'Shift+F8',
            disabled: !mediaC && !audioC && !waiting,
            onSelect: () => dispatch({ id: 'mediaRestart' }),
          },
        ]}
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
            disabled={!target}
            onClick={() => dispatch({ id: 'mediaPlayPause' })}
            title={waitingName ? `F8: start ${waitingName}` : 'F8'}
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <button
            type="button"
            disabled={!mediaC && !audioC && !waiting}
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
          {waitingName && (
            <span className="small muted" title="This slide's sound starts on click">
              F8: {waitingName}
            </span>
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
      {midiReady && midiPresets.length > 0 && (
        <div className="chip" style={{ alignItems: 'center', gap: 6 }}>
          <span className="lbl">Lights</span>
          {midiPresets.length <= 4 ? (
            <div className="row wrap" style={{ gap: 4 }}>
              {midiPresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="small"
                  title={`Fire lighting preset: ${p.name}`}
                  style={{
                    borderLeft: p.color ? `3px solid ${p.color}` : undefined,
                  }}
                  onClick={() => dispatch({ id: 'midiPreset', arg: p.id })}
                >
                  {p.name}
                </button>
              ))}
            </div>
          ) : (
            <Menu
              label="💡 Lights"
              items={midiPresets.map((p) => ({
                label: p.name,
                onSelect: () => dispatch({ id: 'midiPreset', arg: p.id }),
              }))}
            />
          )}
        </div>
      )}
      <button
        type="button"
        className={`big danger clear-all ${pending ? 'pending' : ''}`}
        style={{ minWidth: 150, alignSelf: 'center', minHeight: 56 }}
        onPointerDown={(e) => {
          if (e.button === 0) clearDown();
        }}
        onPointerUp={() => hold.up()}
        onPointerLeave={() => hold.up()}
        onPointerCancel={() => hold.up()}
        onClick={(e) => {
          // Keyboard activation (Enter/Space on the focused button) has no pointer events.
          if (e.detail === 0) dispatch({ id: 'clearAll' });
        }}
        title="F2 twice within 2 seconds, or hold for 1 second"
      >
        {pending ? 'Press again or hold' : s.black ? 'All cleared' : 'Clear all (F2 ×2 or hold)'}
      </button>
    </div>
  );
}
