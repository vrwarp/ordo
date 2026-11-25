import { DEMO } from '@ordo/client';
import type { Look, Media, Output, Presentation, Slide } from '@ordo/domain';
import type { OutputHealthEntry } from '@ordo/protocol';
import { useEffect, useRef, useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { Icon } from '../../components/Icons.tsx';
import { useMediaLookup } from '../../hooks.ts';
import { dotTitle, outputDot } from '../../lib/health.ts';
import { navigate } from '../../useRoute.ts';
import { lookPreviewJob } from '../editor/LookPreviews.tsx';
import { thumbs } from '../../services/thumbs.ts';
import { useProgram } from '../../services/programView.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { setUi } from '../../state/ui.ts';

function PvVideo({ stream }: { stream?: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== (stream ?? null)) v.srcObject = stream ?? null;
    if (stream) void v.play().catch(() => undefined);
  }, [stream]);
  return <video ref={ref} muted playsInline autoPlay width={320} height={180} />;
}

/** Rendered slide thumbnail when WebRTC stream is absent (e.g. browser demo mode or local fallback). */
function PvLiveThumb({
  look,
  presentation,
  slide,
  next,
  media,
}: {
  look?: Look;
  presentation: Presentation;
  slide: Slide;
  next?: Slide;
  media: (id: string) => Media | undefined;
}) {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    let alive = true;
    if (look) {
      const job = lookPreviewJob({ look, presentation, slide, next, media, width: 480 });
      void thumbs.get(job).then((u) => {
        if (alive && u) setUrl(u);
      });
    }
    return () => {
      alive = false;
    };
  }, [look, presentation, slide, next, media]);

  if (!url) return null;
  return (
    <img
      src={url}
      alt="Program preview"
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        display: 'block',
        position: 'absolute',
        inset: 0,
      }}
    />
  );
}

function masterMeters(health: Record<string, OutputHealthEntry>, outputs: readonly Output[]): number[] {
  const masterId = outputs.find((o) => o.audioMaster)?.id;
  const h = (masterId && health[masterId]) || Object.values(health).find((x) => x.meters?.length);
  return h?.meters?.length ? h.meters : [0, 0];
}

/**
 * Compact docked Program monitor: 1 primary 16:9 screen + live vertical VU meters on top,
 * and remaining enabled outputs in a 2-up horizontal grid below (design/30 §5.1).
 * Clicking any secondary monitor swaps it into the primary slot.
 */
export function ProgramView() {
  const outputs = useLibrary((s) => s.data.settings.outputs);
  const looks = useLibrary((s) => s.data.settings.looks);
  const media = useMediaLookup();
  const state = useLive((s) => s.state);
  const health = useLive((s) => s.health);
  const program = useProgram();
  const fallback = useLive((s) => s.authority === 'fallback');
  const list = outputs.filter((o) => o.enabled);
  const [pinnedId, setPinnedId] = useState<string | undefined>(undefined);

  const primary = list.find((o) => o.id === pinnedId) ?? list[0];
  const secondary = primary ? list.filter((o) => o.id !== primary.id) : [];
  const meters = masterMeters(health, outputs);

  const liveCue = state.live !== undefined ? state.cues[state.live] : undefined;
  const presentation =
    liveCue?.presentationId && state.resolved?.presentations
      ? state.resolved.presentations[liveCue.presentationId]
      : undefined;
  const slide =
    presentation && liveCue?.slideId
      ? presentation.sections.flatMap((s) => s.slides).find((s) => s.id === liveCue.slideId)
      : undefined;

  const nextCue = state.live !== undefined ? state.cues[state.live + 1] : undefined;
  const nextPresentation =
    nextCue?.presentationId && state.resolved?.presentations
      ? state.resolved.presentations[nextCue.presentationId]
      : undefined;
  const nextSlide =
    nextPresentation && nextCue?.slideId
      ? nextPresentation.sections.flatMap((s) => s.slides).find((s) => s.id === nextCue.slideId)
      : undefined;

  const renderMonitor = (o: Output, isPrimary: boolean) => {
    const h = health[o.id];
    const p = program[o.id];
    const look =
      state.resolved?.looks?.find((l) => l.id === o.lookId) ?? looks.find((l) => l.id === o.lookId);
    return (
      <div
        key={o.id}
        className={`pv${isPrimary ? ' is-primary' : ''}`}
        title={isPrimary ? dotTitle(h, o.name) : `${dotTitle(h, o.name)} — Click to promote to primary`}
        onClick={() => {
          if (!isPrimary) setPinnedId(o.id);
        }}
        onContextMenu={(e) => {
          openContextMenu(
            e,
            [
              { kind: 'label', label: `${o.name}${look ? ` · ${look.name}` : ''}` },
              ...(!isPrimary
                ? [{ label: 'Promote to primary monitor', onSelect: () => setPinnedId(o.id) }]
                : []),
              { label: 'Open diagnostics…', onSelect: () => setUi({ showDiagnostics: true }) },
              { kind: 'separator' },
              { label: 'Configure outputs…', onSelect: () => navigate('#/settings/outputs') },
              { label: 'Configure looks…', onSelect: () => navigate('#/settings/looks') },
            ],
            { ariaLabel: `${o.name} preview actions` },
          );
        }}
      >
        <PvVideo stream={p?.stream} />
        {!p?.stream &&
          (presentation && slide ? (
            <PvLiveThumb
              look={look}
              presentation={presentation}
              slide={slide}
              next={nextSlide}
              media={media}
            />
          ) : (
            <div className="pv-standby">
              <Icon name={h?.connected ? 'monitor' : 'monitorOff'} size={isPrimary ? 18 : 14} />
              <span>{h?.connected ? (state.live === undefined ? 'Standby' : 'Holding') : 'Offline'}</span>
            </div>
          ))}
        <div className="ov">
          <span className={`dot sm ${outputDot(h)}`} />
          <b className="ellipsis">{o.name}</b>
          <span className="spacer" />
          {isPrimary && h && (
            <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {h.fps !== undefined ? `${h.fps.toFixed(0)}fps · ` : ''}miss {h.missed}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="program-dock">
      <div className="prop-section-title" style={{ margin: 0 }}>
        <span>Program</span>
        {primary && (
          <span className="muted" style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>
            {primary.name}
          </span>
        )}
      </div>
      {fallback && !DEMO && (
        <span className="muted" style={{ fontSize: 10.5 }}>
          Program view paused while hub is unreachable.
        </span>
      )}
      {primary ? (
        <div className="program-primary-row">
          {renderMonitor(primary, true)}
          <div className="program-vu-rail" title="Master audio VU meters">
            {meters.map((v, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stereo meter channels
              <div key={i} className="meter">
                <i style={{ height: `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%` }} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <span className="muted small">No outputs configured.</span>
      )}
      {secondary.length > 0 && (
        <div className="program-secondary-grid">{secondary.map((o) => renderMonitor(o, false))}</div>
      )}
    </div>
  );
}
