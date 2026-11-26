import { formatDuration } from '@ordo/domain';
import { mediaPlayTarget, pendingSlideSound } from '@ordo/live-state';
import type { OutputHealthEntry } from '@ordo/protocol';
import { useMemo, useState } from 'react';
import { type ContextMenuEntry, openContextMenu } from '../../components/ContextMenu.tsx';
import { Kbd } from '../../components/fields.tsx';
import { Icon, type IconName } from '../../components/Icons.tsx';
import { Menu } from '../../components/Menu.tsx';
import { useHubNow } from '../../hooks.ts';
import { HoldGuard } from '../../lib/confirm.ts';
import { mediaTimes } from '../../lib/mediaTimes.ts';
import { controller, dispatch, MUTE_DB } from '../../services/controller.ts';
import { CLEAR_HOLD_MS, useSurfaces } from '../../services/surfaces.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import type { OperatorPlaylist } from './useOperatorPlaylist.ts';

function TallyKey(props: {
  label: string;
  icon: IconName;
  value?: string;
  on: boolean;
  onClear: () => void;
  keyHint?: string;
  extraMenu?: ContextMenuEntry[];
}) {
  return (
    <button
      type="button"
      className={`tally-key tactical-btn${props.on ? ' on' : ''}`}
      disabled={!props.on}
      onClick={props.onClear}
      title={
        props.on
          ? `Click to clear ${props.label.toLowerCase()}${props.keyHint ? ` (${props.keyHint})` : ''}`
          : `${props.label}: idle${props.keyHint ? ` (${props.keyHint})` : ''}`
      }
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
      <span className="tally-key-led" aria-hidden="true" />
      <Icon name={props.icon} size={13} />
      <span className="tally-key-meta">
        <span className="tally-key-lbl">{props.label}</span>
        <span className="tally-key-val ellipsis">{props.value ?? '—'}</span>
      </span>
      {props.keyHint && <Kbd>{props.keyHint}</Kbd>}
    </button>
  );
}

function masterHealth(
  h: Record<string, OutputHealthEntry>,
  masterId?: string,
): OutputHealthEntry | undefined {
  if (masterId && h[masterId]) return h[masterId];
  return Object.values(h).find((x) => x.meters?.length || x.mediaDurationMs !== undefined);
}

/** Slim 46px broadcast console switcher strip (design/30 §5.1). */
export function LayerBar({ op }: { op: OperatorPlaylist }) {
  const now = useHubNow(250);
  const s = useLive((x) => x.state);
  const health = useLive((x) => x.health);
  const clearUntil = useLive((x) => x.clearAllUntil);
  const audio = useLibrary((x) => x.data.settings.audio);
  const outputs = useLibrary((x) => x.data.settings.outputs);
  const midiPresets = useLibrary((x) => x.data.settings.surfaces.midiPresets ?? []);
  const midiReady = useSurfaces((x) => x.midiReady);
  const [holdingClear, setHoldingClear] = useState(false);
  const ctl = controller();
  const L = s.layers;
  const slideCue = L.slide.content ? s.cues[L.slide.content.cueIndex] : undefined;
  const liveCue = s.live !== undefined ? s.cues[s.live] : undefined;
  const canRestoreSlide = !s.black && !L.slide.content && liveCue?.kind === 'slide';
  const slideActiveOrRestorable = Boolean(L.slide.content || canRestoreSlide || s.blankText);
  const bgName = L.background.content ? op.media(L.background.content.mediaId)?.name : undefined;
  const mediaC = L.media.content;
  const audioC = s.audio.content;
  const mediaRec = mediaC ? op.media(mediaC.mediaId) : audioC ? op.media(audioC.mediaId) : undefined;
  const master = masterHealth(health, outputs.find((o) => o.audioMaster)?.id);
  const t = mediaTimes(s, now, mediaRec?.durationMs, master);
  const target = mediaPlayTarget(s);
  const waiting = target === 'slideSound' ? pendingSlideSound(s) : undefined;
  const waitingName = waiting ? (op.media(waiting.sound.mediaId)?.name ?? 'slide sound') : undefined;
  const playing =
    target === 'video' ? mediaC?.state === 'playing' : target === 'audio' && audioC?.state === 'playing';
  const muted = audio.masterDb <= MUTE_DB + 1;
  const propsList: string[] = [];
  if (s.props.logo) propsList.push('Logo');
  if (s.props.countdownTimerId) propsList.push('Countdown');
  const pending = clearUntil !== undefined && clearUntil > Date.now();

  const hold = useMemo(() => new HoldGuard(CLEAR_HOLD_MS), []);
  const clearDown = () => {
    setHoldingClear(true);
    dispatch({ id: 'clearAll' });
    hold.down(() => {
      setHoldingClear(false);
      if (useLive.getState().clearAllUntil !== undefined) dispatch({ id: 'clearAll' });
    });
  };
  const clearUp = () => {
    setHoldingClear(false);
    hold.cancel();
  };

  return (
    <div className="layerbar-console">
      <TallyKey
        label="BG"
        icon="bgLayer"
        value={bgName}
        on={!!L.background.content}
        onClear={() => ctl?.clear('background')}
      />
      <TallyKey
        label="Slide"
        icon="slideLayer"
        value={
          slideCue?.label ??
          (s.blankText
            ? '(blank held — click to show)'
            : canRestoreSlide
              ? '(blanked — click to show)'
              : undefined)
        }
        on={slideActiveOrRestorable}
        onClear={() => dispatch({ id: 'clearSlide' })}
        keyHint="Esc"
        extraMenu={[
          {
            label: s.blankText ? 'Turn off Hold Blank' : 'Hold Blank (keep text hidden across slides)',
            shortcut: 'Shift+F1',
            disabled: s.mode !== 'live',
            onSelect: () => dispatch({ id: 'toggleBlankText' }),
          },
        ]}
      />
      <TallyKey
        label="Banner"
        icon="bannerLayer"
        value={L.lowerThird.content?.text}
        on={!!L.lowerThird.content}
        onClear={() => dispatch({ id: 'clearLowerThird' })}
        keyHint="F3"
      />
      <TallyKey
        label={audioC && !mediaC ? 'Audio' : 'Media'}
        icon={audioC && !mediaC ? 'audio' : 'mediaLayer'}
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
      <TallyKey
        label="Props"
        icon="propsLayer"
        value={propsList.join(', ') || undefined}
        on={propsList.length > 0}
        onClear={() => dispatch({ id: 'clearProps' })}
        keyHint="F4"
      />

      <span className="console-sep" aria-hidden="true" />

      <div className="console-transport">
        <button
          type="button"
          className="icon-btn"
          disabled={!target}
          onClick={() => dispatch({ id: 'mediaPlayPause' })}
          title={waitingName ? `F8: start ${waitingName}` : 'Play / Pause (F8)'}
          aria-label={playing ? 'Pause media' : 'Play media'}
        >
          <Icon name={playing ? 'pause' : 'play'} size={12} />
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={!mediaC && !audioC && !waiting}
          onClick={() => dispatch({ id: 'mediaRestart' })}
          title="Restart media (Shift+F8)"
          aria-label="Restart media"
        >
          <Icon name="restart" size={12} />
        </button>
        <span className="console-time" title="Elapsed / remaining">
          {t ? `${formatDuration(t.pos)}${t.dur ? ` / -${formatDuration(t.dur - t.pos)}` : ''}` : '--:--'}
        </span>
        {audioC && (
          <button type="button" className="small" onClick={() => ctl?.clear('audio')}>
            Stop audio
          </button>
        )}
      </div>

      <span className="spacer" />

      {midiReady && midiPresets.length > 0 && (
        <>
          <div className="row" style={{ gap: 4, flexShrink: 0 }}>
            {midiPresets.length <= 4 ? (
              midiPresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="small"
                  title={`Fire lighting preset: ${p.name}`}
                  style={{ borderLeft: p.color ? `3px solid ${p.color}` : undefined }}
                  onClick={() => dispatch({ id: 'midiPreset', arg: p.id })}
                >
                  <Icon name="lights" size={11} />
                  {p.name}
                </button>
              ))
            ) : (
              <Menu
                label="Lights"
                items={midiPresets.map((p) => ({
                  label: p.name,
                  onSelect: () => dispatch({ id: 'midiPreset', arg: p.id }),
                }))}
              />
            )}
          </div>
          <span className="console-sep" aria-hidden="true" />
        </>
      )}

      <div className="console-audio">
        <button
          type="button"
          className="icon-btn"
          onClick={() => dispatch({ id: 'audioMasterDown' })}
          title="Master volume down"
          aria-label="Master volume down"
        >
          <Icon name="minus" size={11} />
        </button>
        <span
          className="mono small"
          style={{
            minWidth: 48,
            textAlign: 'center',
            color: muted ? 'var(--red)' : 'var(--fg)',
            fontWeight: muted ? 700 : 500,
          }}
        >
          {muted ? 'MUTED' : `${audio.masterDb.toFixed(0)} dB`}
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => dispatch({ id: 'audioMasterUp' })}
          title="Master volume up"
          aria-label="Master volume up"
        >
          <Icon name="plus" size={11} />
        </button>
        <button
          type="button"
          className={`small ${muted ? 'danger' : ''}`}
          onClick={() => dispatch({ id: 'audioMute' })}
          title="Mute / Unmute master audio"
        >
          <Icon name={muted ? 'volumeMute' : 'volume'} size={12} />
          {muted ? 'Unmute' : 'Mute'}
        </button>
        {master?.audio === 'lost' && <span className="tag red">device lost</span>}
      </div>

      <span className="console-sep" aria-hidden="true" />

      <div className="row" style={{ gap: 4, flexShrink: 0 }}>
        <button
          type="button"
          className={`small tactical-btn${canRestoreSlide && !s.blankText ? ' on' : ''}`}
          disabled={!slideActiveOrRestorable}
          onClick={() => dispatch({ id: 'clearSlide' })}
          data-blank-slide
          title={
            canRestoreSlide || s.blankText
              ? 'Restore live slide text over the running background (Esc / F1)'
              : 'Blank slide text temporarily while keeping the background running (Esc / F1)'
          }
          style={
            canRestoreSlide && !s.blankText
              ? { borderColor: 'var(--amber, #f59e0b)', color: 'var(--amber, #fbbf24)' }
              : undefined
          }
        >
          <span>{canRestoreSlide || s.blankText ? 'Show slide' : 'Blank slide'}</span>
          <Kbd>F1</Kbd>
        </button>
        <button
          type="button"
          className={`small tactical-btn${s.blankText ? ' on' : ''}`}
          disabled={s.mode !== 'live'}
          aria-pressed={Boolean(s.blankText)}
          onClick={() => dispatch({ id: 'toggleBlankText' })}
          data-hold-blank
          title="Hold blank text: pressing Space changes backgrounds and Stage Display while keeping audience text hidden until turned off (Shift+F1)"
          style={
            s.blankText
              ? {
                  background: 'rgba(245, 158, 11, 0.2)',
                  borderColor: 'var(--amber, #f59e0b)',
                  color: '#fde68a',
                }
              : undefined
          }
        >
          <span>{s.blankText ? 'Blank held' : 'Hold blank'}</span>
        </button>
      </div>

      <button
        type="button"
        className={`danger clear-all clear-all-console tactical-btn${pending ? ' pending' : ''}${holdingClear ? ' holding' : ''}`}
        onPointerDown={clearDown}
        onPointerUp={clearUp}
        onPointerLeave={clearUp}
        onPointerCancel={clearUp}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            dispatch({ id: 'clearAll' });
          }
        }}
        title="Press twice within 2 s, or hold for 1 s, to clear every layer to black"
      >
        <span className="hold-fill" aria-hidden="true" />
        <span>{pending ? 'Confirm Clear All' : 'Clear all'}</span>
        <Kbd>F2</Kbd>
      </button>
    </div>
  );
}
