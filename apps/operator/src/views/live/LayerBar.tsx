import { formatDuration } from '@ordo/domain';
import { mediaPlayTarget, pendingSlideSound } from '@ordo/live-state';
import type { OutputHealthEntry } from '@ordo/protocol';
import { useMemo, useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { Kbd } from '../../components/fields.tsx';
import { Icon } from '../../components/Icons.tsx';
import { Menu } from '../../components/Menu.tsx';
import { useHubNow } from '../../hooks.ts';
import { HoldGuard } from '../../lib/confirm.ts';
import { mediaTimes } from '../../lib/mediaTimes.ts';
import { controller, dispatch, MUTE_DB } from '../../services/controller.ts';
import { CLEAR_HOLD_MS, useSurfaces } from '../../services/surfaces.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import type { OperatorPlaylist } from './useOperatorPlaylist.ts';

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
  const activeLayerCount =
    (L.background.content ? 1 : 0) +
    (L.lowerThird.content ? 1 : 0) +
    (mediaC || audioC ? 1 : 0) +
    (propsList.length > 0 ? 1 : 0);

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
      <Menu
        label={activeLayerCount > 0 ? `Layers (${activeLayerCount})` : 'Layers'}
        items={[
          {
            label: bgName ? `Clear background (${bgName})` : 'Clear background',
            name: 'Clear background',
            disabled: !L.background.content,
            onSelect: () => ctl?.clear('background'),
          },
          {
            label: L.lowerThird.content?.text
              ? `Clear banner (${L.lowerThird.content.text.slice(0, 28)}) — F3`
              : 'Clear banner — F3',
            name: 'Clear banner',
            disabled: !L.lowerThird.content,
            onSelect: () => dispatch({ id: 'clearLowerThird' }),
          },
          {
            label: mediaRec
              ? `Clear ${audioC && !mediaC ? 'audio' : 'media'} (${mediaRec.name})`
              : 'Clear media',
            name: 'Clear media',
            disabled: !mediaC && !audioC,
            onSelect: () => (mediaC ? ctl?.clear('media') : ctl?.clear('audio')),
          },
          {
            label: propsList.length ? `Clear props (${propsList.join(', ')}) — F4` : 'Clear props — F4',
            name: 'Clear props',
            disabled: propsList.length === 0,
            onSelect: () => dispatch({ id: 'clearProps' }),
          },
        ]}
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

      <button
        type="button"
        className={`small tactical-btn${s.blankText || canRestoreSlide ? ' on' : ''}`}
        disabled={!slideActiveOrRestorable}
        aria-pressed={Boolean(s.blankText || canRestoreSlide)}
        onClick={() => dispatch({ id: 'clearSlide' })}
        onContextMenu={(e) => {
          openContextMenu(
            e,
            [
              {
                label: 'Blank slide (next cue shows)',
                shortcut: 'F1',
                disabled: !L.slide.content,
                onSelect: () => ctl?.clear('slide'),
              },
              {
                label: s.blankText ? 'Release Hold blank (show slide)' : 'Hold blank across cues',
                shortcut: 'Shift+F1',
                disabled: s.mode !== 'live',
                onSelect: () => dispatch({ id: 'toggleBlankText' }),
              },
              ...(canRestoreSlide && !s.blankText && s.live !== undefined
                ? [
                    {
                      label: 'Show slide now',
                      onSelect: () => ctl?.go(s.live!),
                    },
                  ]
                : []),
            ],
            { ariaLabel: 'Blank slide actions' },
          );
        }}
        data-blank-slide
        data-blank-state={s.blankText ? 'held' : canRestoreSlide ? 'blank' : 'showing'}
        title={
          s.blankText
            ? 'Audience text is held blank across cues — click or press F1 to show the live slide'
            : canRestoreSlide
              ? 'Slide is blanked (next cue will show). Click again or press F1 to Hold blank across cues; right-click to Show slide.'
              : 'Blank slide text while keeping the background running (F1). Press again to Hold blank across cues.'
        }
        style={
          s.blankText
            ? {
                background: 'rgba(245, 158, 11, 0.22)',
                borderColor: 'var(--amber, #f59e0b)',
                color: '#fde68a',
                flexShrink: 0,
              }
            : canRestoreSlide
              ? {
                  borderColor: 'var(--amber, #f59e0b)',
                  color: 'var(--amber, #fbbf24)',
                  flexShrink: 0,
                }
              : { flexShrink: 0 }
        }
      >
        <span>{s.blankText ? 'Show slide' : canRestoreSlide ? 'Hold blank' : 'Blank slide'}</span>
        <Kbd>F1</Kbd>
      </button>

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
