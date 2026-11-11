import type { Look, Media, Presentation, Slide } from '@ordo/domain';
import { memo, useEffect, useState } from 'react';
import { useMediaLookup } from '../../hooks.ts';
import { LOOK_ROLE, lookBackgroundId, previewLooks, slideAndNext } from '../../lib/lookPreviews.ts';
import { slideImages, stillHash, thumbs } from '../../services/thumbs.ts';
import type { ThumbJob } from '../../workers/thumb.worker.ts';
import { useLibrary } from '../../state/library.ts';

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
}): ThumbJob {
  const { look, presentation: p, slide, next, media, width } = props;
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
    clear: look.clearColor,
    nextSlide: nextShown,
  };
}

/** One look's rendering of a slide, from the thumbnail worker; keeps the previous image until the next arrives. */
const LookPreview = memo(function LookPreview(props: {
  look: Look;
  presentation: Presentation;
  slide: Slide;
  next?: Slide;
  media: (id: string) => Media | undefined;
  width: number;
}) {
  const { look } = props;
  const job = lookPreviewJob(props);
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
      className="look-preview"
      data-look-preview={look.kind}
      data-look-id={look.id}
      data-rendered={shown?.key === key ? 'current' : shown ? 'stale' : 'pending'}
    >
      <div className="look-preview-frame" style={{ background: `rgba(${c.r},${c.g},${c.b},${c.a})` }}>
        {shown && <img src={shown.url} alt={`${look.name} preview`} />}
      </div>
      <figcaption>
        <span className="look-preview-name">{look.name}</span>
        <span className="muted small">{LOOK_ROLE[look.kind]}</span>
      </figcaption>
    </figure>
  );
});

/**
 * The selected slide under every look in settings (main, lobby lower third, livestream key with its key
 * colour, stage with the next slide), drawn by the thumbnail worker with the shared rasterizer so the
 * fonts and wrapping match the outputs (design/15 "iPad editing"). Re-renders ~150 ms after an edit.
 */
export function LookPreviews(props: { presentation: Presentation; slideId?: string; compact?: boolean }) {
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
        />
      ))}
    </div>
  );
}
