import type { Look, Media, Presentation, Slide } from '@ordo/domain';
import { memo, useEffect, useState } from 'react';
import { useMediaLookup } from '../../hooks.ts';
import { LOOK_ROLE, lookBackgroundId, previewLooks, slideAndNext } from '../../lib/lookPreviews.ts';
import { slideImages, stillHash, thumbs } from '../../services/thumbs.ts';
import { useLibrary } from '../../state/library.ts';
import type { ThumbJob } from '../../workers/thumb.worker.ts';

/** Re-render on edits at most every `ms` (typing in the editor must not queue a render per key). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    if (v === value) return;
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, v, ms]);
  return v;
}

export function isKeyLook(look: Look): boolean {
  const c = look.clearColor;
  return look.kind === 'stream' || (c.g > 200 && c.r < 60 && c.b < 60);
}

/**
 * The thumbnail job of one look's preview of a slide: the slide as that look draws it on an output, with the
 * pictures the slide draws (`slideImages`, the outputs' rule of design/27 §5) and the look's background.
 */
export function lookPreviewJob(props: {
  look: Look;
  presentation: Presentation;
  slide: Slide;
  next?: Slide;
  media: (id: string) => Media | undefined;
  width: number;
  transparentClear?: boolean;
}): ThumbJob {
  const { look, presentation: p, slide, next, media, width, transparentClear } = props;
  const bgId = lookBackgroundId(look, p, slide);
  const nextShown = look.layers.slide.mode === 'lyricOnly' && look.layers.slide.nextSlide ? next : undefined;
  return {
    slide,
    look,
    isSong: p.kind === 'song',
    presentationKind: p.kind,
    bg: bgId ? stillHash(media(bgId)) : undefined,
    images: slideImages(slide, media),
    width,
    height: Math.round((width * 9) / 16),
    clear: transparentClear ? { r: 0, g: 0, b: 0, a: 0 } : look.clearColor,
    nextSlide: nextShown,
  };
}

/** One look's rendering of a slide, from the thumbnail worker; composites stream key over simulated camera by default. */
const LookPreview = memo(function LookPreview(props: {
  look: Look;
  presentation: Presentation;
  slide: Slide;
  next?: Slide;
  media: (id: string) => Media | undefined;
  width: number;
  cameraSim?: boolean;
  onSelectLook?: (lookId: string) => void;
}) {
  const { look } = props;
  const isKey = isKeyLook(look);
  const [rawKey, setRawKey] = useState(!props.cameraSim);
  const job = lookPreviewJob({ ...props, transparentClear: isKey && !rawKey });
  const key = thumbs.keyOf(job);
  const [shown, setShown] = useState<{ key: string; url: string } | undefined>(() => {
    const hit = thumbs.peek(key);
    return hit ? { key, url: hit } : undefined;
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key captures the job
  useEffect(() => {
    let alive = true;
    void thumbs.get(job).then((url) => {
      if (alive && url) setShown({ key, url });
    });
    return () => {
      alive = false;
    };
  }, [key]);
  const c = look.clearColor;
  return (
    <figure
      className={`look-preview${props.onSelectLook ? ' interactive' : ''}`}
      data-look-preview={look.kind}
      data-look-id={look.id}
      data-rendered={shown?.key === key ? 'current' : shown ? 'stale' : 'pending'}
      onClick={props.onSelectLook ? () => props.onSelectLook?.(look.id) : undefined}
    >
      <figcaption className="look-preview-hdr">
        <span className="look-preview-name">{look.name}</span>
        {isKey ? (
          <button
            type="button"
            className="look-key-badge"
            title="Toggle simulated camera backdrop vs raw chroma key matte"
            onClick={(e) => {
              e.stopPropagation();
              setRawKey((v) => !v);
            }}
          >
            {rawKey ? 'RAW KEY' : 'CAM SIM'}
          </button>
        ) : (
          <span className="muted small">{LOOK_ROLE[look.kind]}</span>
        )}
      </figcaption>
      <div
        className={`look-preview-frame${isKey && !rawKey ? ' look-camera-sim' : ''}`}
        style={isKey && !rawKey ? undefined : { background: `rgba(${c.r},${c.g},${c.b},${c.a})` }}
      >
        {isKey && !rawKey && <div className="look-camera-badge">LIVE CAM SIM</div>}
        {shown && <img src={shown.url} alt={`${look.name} preview`} />}
      </div>
    </figure>
  );
});

/**
 * Full-size Stage Output Lens preview for Proposal B ("Canvas-First"):
 * Renders a chosen Look (`Main | Lobby | Stream Key | Stage`) at 1280px right on the main editor stage.
 */
export function SingleLookStagePreview(props: {
  look: Look;
  presentation: Presentation;
  slideId?: string;
  onBackToCanvas: () => void;
}) {
  const media = useMediaLookup();
  const p = useDebounced(props.presentation, 100);
  const { slide, next } = slideAndNext(p, props.slideId);
  const isKey = isKeyLook(props.look);
  const [rawKey, setRawKey] = useState(false);

  const job = slide
    ? lookPreviewJob({
        look: props.look,
        presentation: p,
        slide,
        next,
        media,
        width: 1280,
        transparentClear: isKey && !rawKey,
      })
    : undefined;
  const key = job ? thumbs.keyOf(job) : '';
  const [shown, setShown] = useState<{ key: string; url: string } | undefined>(() => {
    if (!key) return undefined;
    const hit = thumbs.peek(key);
    return hit ? { key, url: hit } : undefined;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: key captures job
  useEffect(() => {
    if (!job || !key) return;
    let alive = true;
    void thumbs.get(job).then((url) => {
      if (alive && url) setShown({ key, url });
    });
    return () => {
      alive = false;
    };
  }, [key]);

  if (!slide) return <div className="center muted">No slide to preview.</div>;
  const c = props.look.clearColor;

  return (
    <div className="ed-stage-lens" data-stage-lens={props.look.kind}>
      <div className="ed-stage-lens-bar">
        <span className="ed-scope-pill selection">
          Previewing {props.look.name} · {LOOK_ROLE[props.look.kind]}
        </span>
        {isKey && (
          <button
            type="button"
            className={`small${rawKey ? ' on' : ' ghost'}`}
            onClick={() => setRawKey((v) => !v)}
          >
            {rawKey ? 'Showing Raw Key Matte' : 'Simulated Camera Feed'}
          </button>
        )}
        <button type="button" className="small" onClick={props.onBackToCanvas}>
          ← Edit on Canvas
        </button>
      </div>
      <div
        className={`ed-stage-lens-frame${isKey && !rawKey ? ' look-camera-sim' : ''}`}
        style={isKey && !rawKey ? undefined : { background: `rgba(${c.r},${c.g},${c.b},${c.a})` }}
      >
        {isKey && !rawKey && <div className="look-camera-badge">SIMULATED CAMERA FEED</div>}
        {shown && <img src={shown.url} alt={`${props.look.name} output preview`} />}
      </div>
    </div>
  );
}

/**
 * The selected slide under every look in settings (main, lobby lower third, livestream key with simulated
 * camera feed, stage with the next slide), drawn by the thumbnail worker. Re-renders ~150 ms after an edit.
 */
export function LookPreviews(props: {
  presentation: Presentation;
  slideId?: string;
  compact?: boolean;
  cameraSim?: boolean;
  onSelectLook?: (lookId: string) => void;
}) {
  const looks = useLibrary((s) => s.data.settings.looks);
  const media = useMediaLookup();
  const p = useDebounced(props.presentation, 150);
  const { slide, next } = slideAndNext(p, props.slideId);
  const width = props.compact ? 480 : 960;
  if (!slide) return <div className="muted small">No slide to preview.</div>;
  return (
    <div className={`look-previews${props.compact ? ' compact' : ''}`} data-look-previews>
      {previewLooks(looks).map((look) => (
        <LookPreview
          key={look.id}
          look={look}
          presentation={p}
          slide={slide}
          next={next}
          media={media}
          width={width}
          cameraSim={props.cameraSim ?? !!props.compact}
          onSelectLook={props.onSelectLook}
        />
      ))}
    </div>
  );
}
