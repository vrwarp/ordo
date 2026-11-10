import { DEMO } from '@ordo/client';
import type { Look, Media, Presentation, Slide } from '@ordo/domain';
import { useEffect, useRef, useState } from 'react';
import { useMediaLookup } from '../../hooks.ts';
import { dotTitle, outputDot } from '../../lib/health.ts';
import { lookPreviewJob } from '../editor/LookPreviews.tsx';
import { thumbs } from '../../services/thumbs.ts';
import { useProgram } from '../../services/programView.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';

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

/** Live pixels from every output over WebRTC or simulated rendered thumb with health overlay (prd/02 Program view). */
export function ProgramView() {
  const outputs = useLibrary((s) => s.data.settings.outputs);
  const looks = useLibrary((s) => s.data.settings.looks);
  const media = useMediaLookup();
  const state = useLive((s) => s.state);
  const health = useLive((s) => s.health);
  const program = useProgram();
  const fallback = useLive((s) => s.authority === 'fallback');
  const list = outputs.filter((o) => o.enabled);

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

  return (
    <div className="program">
      <h4 style={{ margin: 0 }}>Program</h4>
      {fallback && !DEMO && (
        <span className="muted small">Program view pauses while the hub is unreachable.</span>
      )}
      {list.map((o) => {
        const h = health[o.id];
        const p = program[o.id];
        const look =
          state.resolved?.looks?.find((l) => l.id === o.lookId) ?? looks.find((l) => l.id === o.lookId);
        return (
          <div key={o.id} className="pv" title={dotTitle(h, o.name)}>
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
                <div className="center muted small" style={{ position: 'absolute', inset: 0 }}>
                  {h?.connected
                    ? state.live === undefined
                      ? 'Idle (no slide on air)'
                      : 'Holding'
                    : 'Output not open'}
                </div>
              ))}
            <div className="ov">
              <span className={`dot sm ${outputDot(h)}`} />
              <b>{o.name}</b>
              <span className="spacer" />
              {h && (
                <span className="muted">
                  {h.fps !== undefined ? `${h.fps.toFixed(0)} fps · ` : ''}missed {h.missed}
                </span>
              )}
            </div>
          </div>
        );
      })}
      {list.length === 0 && <span className="muted small">No outputs configured.</span>}
    </div>
  );
}
